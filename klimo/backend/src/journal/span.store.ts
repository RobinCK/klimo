import { Inject, Injectable, Logger } from '@nestjs/common';
import { Brackets, MoreThan } from 'typeorm';
import { uuid } from '../common/ids';
import type { Rewindable } from '../common/rewind';
import { Db } from '../db/database';
import { RunSpanRow } from '../db/entities';
import { deepClone } from '../shared/defaults';
import type { EpochMs, Id, IEvents, ISpanStore, RunSpan, SpanEvent, SpanSubject } from '../shared/model';
import { EVENTS } from '../tokens';

function toSpan(r: RunSpanRow): RunSpan {
  return {
    id: r.id,
    subject: r.subject as SpanSubject,
    subjectId: r.subjectId,
    kind: r.kind as RunSpan['kind'],
    mode: (r.mode as RunSpan['mode']) ?? null,
    startTs: r.startTs,
    endTs: r.endTs,
    meta: r.meta ?? null,
  };
}

const openKey = (s: Pick<RunSpan, 'subject' | 'subjectId' | 'kind'>) => `${s.subject}|${s.subjectId}|${s.kind}`;

/**
 * Run spans (a boiler run, a pump run-on, a room's heat demand, an active rule…) for the «Сьогодні»
 * timelines and runtime statistics. The engine emits start/end edges; open spans are kept in memory
 * so an end edge finds its start without a query.
 */
@Injectable()
export class SpanStore implements ISpanStore, Rewindable {
  private readonly log = new Logger('Spans');
  private readonly openSpans = new Map<string, RunSpan>();

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(EVENTS) private readonly events: IEvents,
  ) {}

  async load(): Promise<void> {
    this.openSpans.clear();
    const rows = await this.db.ds.getRepository(RunSpanRow).createQueryBuilder('s').where('s.endTs IS NULL').getMany();
    for (const r of rows) {
      const s = toSpan(r);
      const key = openKey(s);
      const existing = this.openSpans.get(key);
      // two open spans for one subject can only come from a crash mid-edge: keep the older one
      if (!existing || existing.startTs > s.startTs) this.openSpans.set(key, s);
    }
  }

  async apply(events: SpanEvent[]): Promise<RunSpan[]> {
    if (!events.length) return [];
    const inserts: RunSpan[] = [];
    const updates: RunSpan[] = [];
    const staged = new Map(this.openSpans);
    for (const e of [...events].sort((a, b) => a.at - b.at)) {
      const key = openKey(e);
      const open = staged.get(key);
      if (e.edge === 'start') {
        if (open) continue;
        const span: RunSpan = { id: uuid(), subject: e.subject, subjectId: e.subjectId, kind: e.kind, mode: e.mode, startTs: e.at, endTs: null, meta: e.meta ?? null };
        staged.set(key, span);
        inserts.push(span);
      } else {
        if (!open) continue;
        const closed: RunSpan = { ...open, endTs: Math.max(open.startTs, e.at), meta: e.meta ? { ...(open.meta ?? {}), ...e.meta } : open.meta };
        staged.delete(key);
        const pending = inserts.findIndex((x) => x.id === open.id);
        if (pending >= 0) inserts[pending] = closed;
        else updates.push(closed);
      }
    }
    if (!inserts.length && !updates.length) return [];
    await this.db.tx(async (em) => {
      if (inserts.length) await em.insert(RunSpanRow, inserts.map((s) => ({ ...s, meta: s.meta as never })));
      for (const s of updates) await em.update(RunSpanRow, { id: s.id }, { endTs: s.endTs, meta: s.meta as never });
    });
    this.openSpans.clear();
    for (const [k, s] of staged) this.openSpans.set(k, s);
    const changed = [...inserts, ...updates];
    for (const s of changed) this.events.send({ type: 'span', payload: s });
    return changed.map((s) => deepClone(s));
  }

  open(): RunSpan[] {
    return [...this.openSpans.values()].map((s) => deepClone(s));
  }

  /** Spans overlapping [from, to), oldest first. */
  async range(from: EpochMs, to: EpochMs, subject?: SpanSubject, subjectId?: Id): Promise<RunSpan[]> {
    const qb = this.db.ds
      .getRepository(RunSpanRow)
      .createQueryBuilder('s')
      .where('s.startTs < :to', { to })
      .andWhere(new Brackets((b) => b.where('s.endTs IS NULL').orWhere('s.endTs > :from', { from })));
    if (subject) qb.andWhere('s.subject = :subject', { subject });
    if (subjectId) qb.andWhere('s.subjectId = :subjectId', { subjectId });
    const rows = await qb.orderBy('s.startTs', 'ASC').getMany();
    return rows.map(toSpan);
  }

  /** One MIN over the indexed start column, however many spans there are. */
  async earliestStart(): Promise<EpochMs | null> {
    const row = await this.db.ds.getRepository(RunSpanRow).createQueryBuilder('s').select('MIN(s.startTs)', 'ts').getRawOne<{ ts: number | string | null }>();
    const ts = row?.ts ?? null;
    return ts === null ? null : Number(ts);
  }

  /** Spans that began after `at` go; one still running then ends there. */
  async forgetAfter(at: EpochMs): Promise<number> {
    const removed = await this.db.tx(async (em) => {
      const res = await em.delete(RunSpanRow, { startTs: MoreThan(at) });
      await em.update(RunSpanRow, { endTs: MoreThan(at) }, { endTs: at });
      return res.affected ?? 0;
    });
    for (const [key, s] of this.openSpans) if (s.startTs > at) this.openSpans.delete(key);
    return removed;
  }

  async closeDangling(at: EpochMs, stillOn: (s: RunSpan) => boolean): Promise<number> {
    const dangling = [...this.openSpans.entries()].filter(([, s]) => !stillOn(s));
    if (!dangling.length) return 0;
    const closed = dangling.map(([key, s]) => ({ key, span: { ...s, endTs: Math.max(s.startTs, at) } }));
    await this.db.tx(async (em) => {
      for (const { span } of closed) await em.update(RunSpanRow, { id: span.id }, { endTs: span.endTs });
    });
    for (const { key, span } of closed) {
      this.openSpans.delete(key);
      this.events.send({ type: 'span', payload: span });
    }
    this.log.log(`closed ${closed.length} span(s) left open by the previous run`);
    return closed.length;
  }
}
