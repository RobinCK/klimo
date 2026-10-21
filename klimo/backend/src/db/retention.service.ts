import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { EntityManager, In, LessThan, ObjectLiteral, EntityTarget } from 'typeorm';
import { errorText } from '../common/logger';
import { MemoryStore } from '../config/memory.store';
import { addDays, fromLocal, toLocal } from '../engine/core/time';
import type { ClockPort, EpochMs } from '../shared/model';
import { CLOCK } from '../tokens';
import { Db } from './database';
import { IncidentRow, JournalRow, RunSpanRow, SentMessageRow } from './entities';

const DAY = 86_400_000;
const RUN_AT_MINUTE = 3 * 60 + 30; // 03:30 local, when nothing interesting happens

export const RETENTION = {
  journalDays: 30,
  journalMaxRows: 20_000,
  /** Source, pump and profile spans feed year-over-year runtime statistics. */
  longSpanDays: 400,
  shortSpanDays: 30,
  resolvedIncidentDays: 90,
  sentMessageDays: 30,
  sentMessageMaxRows: 2_000,
} as const;

export interface RetentionReport {
  journal: number;
  spans: number;
  incidents: number;
  sentMessages: number;
  conditionStates: number;
}

/** Deletes rows older than the newest `keep` of a table (by `tsColumn`). */
async function capRows(em: EntityManager, entity: EntityTarget<ObjectLiteral>, alias: string, tsColumn: string, keep: number): Promise<number> {
  const edge = await em
    .getRepository(entity)
    .createQueryBuilder(alias)
    .select(`${alias}.${tsColumn}`, 'ts')
    .orderBy(`${alias}.${tsColumn}`, 'DESC')
    .offset(keep)
    .limit(1)
    .getRawOne<{ ts: number | string }>();
  if (!edge) return 0;
  const res = await em.delete(entity, { [tsColumn]: LessThan(Number(edge.ts) + 1) });
  return res.affected ?? 0;
}

/** Daily clean-up of logs that would otherwise grow without bound (journal, spans, incidents, messages). */
@Injectable()
export class RetentionService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('Retention');
  private timer: { cancel(): void } | null = null;

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(MemoryStore) private readonly memory: MemoryStore,
  ) {}

  onApplicationBootstrap(): void {
    this.schedule();
  }

  onModuleDestroy(): void {
    this.timer?.cancel();
    this.timer = null;
  }

  /** Next 03:30 in the HA time zone (re-evaluated every day, so a zone change is picked up). */
  nextRunAt(now: EpochMs = this.clock.now()): EpochMs {
    const tz = this.clock.tz();
    const today = toLocal(now, tz).date;
    const at = fromLocal(today, RUN_AT_MINUTE, tz);
    return at > now ? at : fromLocal(addDays(today, 1), RUN_AT_MINUTE, tz);
  }

  private schedule(): void {
    const now = this.clock.now();
    this.timer = this.clock.setTimeout(() => {
      void this.run().finally(() => this.schedule());
    }, this.nextRunAt(now) - now);
  }

  async run(now: EpochMs = this.clock.now()): Promise<RetentionReport> {
    const report: RetentionReport = { journal: 0, spans: 0, incidents: 0, sentMessages: 0, conditionStates: 0 };
    try {
      await this.db.tx(async (em) => {
        report.journal += (await em.delete(JournalRow, { ts: LessThan(now - RETENTION.journalDays * DAY) })).affected ?? 0;
        report.journal += await capRows(em, JournalRow, 'j', 'ts', RETENTION.journalMaxRows);

        // only closed spans (NULL never compares lower): an open span is a run in progress, however old
        const closedBefore = (subjects: string[], days: number) => em.delete(RunSpanRow, { subject: In(subjects), endTs: LessThan(now - days * DAY) });
        report.spans += (await closedBefore(['source', 'pump', 'profile'], RETENTION.longSpanDays)).affected ?? 0;
        report.spans += (await closedBefore(['room', 'rule', 'trigger'], RETENTION.shortSpanDays)).affected ?? 0;

        report.incidents +=
          (await em.delete(IncidentRow, { status: 'resolved', resolvedAt: LessThan(now - RETENTION.resolvedIncidentDays * DAY) })).affected ?? 0;

        report.sentMessages += (await em.delete(SentMessageRow, { at: LessThan(now - RETENTION.sentMessageDays * DAY) })).affected ?? 0;
        report.sentMessages += await capRows(em, SentMessageRow, 'm', 'at', RETENTION.sentMessageMaxRows);
      });
      report.conditionStates = this.memory.pruneOrphans();
      this.log.log(
        `removed ${report.journal} journal, ${report.spans} span, ${report.incidents} incident, ${report.sentMessages} message row(s)` +
          (report.conditionStates ? `, ${report.conditionStates} orphan latch(es)` : ''),
      );
    } catch (e) {
      this.log.error(`clean-up failed: ${errorText(e)}`);
    }
    return report;
  }
}
