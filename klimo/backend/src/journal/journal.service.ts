import { Inject, Injectable, Logger } from '@nestjs/common';
import { In, LessThan, MoreThan } from 'typeorm';
import { uuid } from '../common/ids';
import type { Rewindable } from '../common/rewind';
import { Db } from '../db/database';
import { JournalRow } from '../db/entities';
import type { Decision, EpochMs, IBus, IEvents, IJournal, JournalEntry, JournalPageDto, JournalQuery } from '../shared/model';
import { BUS, EVENTS } from '../tokens';

/** The same decision about the same subject within this window is one journal line, not sixty. */
const DEDUP_MS = 60_000;
const PAGE_DEFAULT = 50;
const PAGE_MAX = 200;

function toEntry(r: JournalRow): JournalEntry {
  return {
    id: r.id,
    ts: r.ts,
    category: r.category as JournalEntry['category'],
    tone: r.tone as JournalEntry['tone'],
    code: r.code as JournalEntry['code'],
    params: r.params ?? {},
    why: r.why ?? null,
    roomId: r.roomId,
    sourceId: r.sourceId,
    deviceKey: r.deviceKey,
    entityIds: r.entityIds ?? [],
    notified: r.notified ?? [],
  };
}

function subjectKey(d: Decision): string {
  return [d.code, d.roomId ?? '', d.sourceId ?? '', d.deviceKey ?? '', (d.entityIds ?? []).join(',')].join('|');
}

/**
 * «Журнал рішень»: what Klimo decided and why, as codes the UI and notifications render. Persists
 * engine decisions, drops repeats of the same decision within 60 s and pushes new lines to the UI.
 */
@Injectable()
export class JournalService implements IJournal, Rewindable {
  private readonly log = new Logger('Journal');
  private readonly lastSeen = new Map<string, EpochMs>();

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(EVENTS) private readonly events: IEvents,
    @Inject(BUS) private readonly bus: IBus,
  ) {}

  async add(d: Decision, ts: EpochMs, opts: { dedup?: boolean } = {}): Promise<JournalEntry | null> {
    const key = subjectKey(d);
    const last = this.lastSeen.get(key);
    if (opts.dedup !== false && last !== undefined && ts - last < DEDUP_MS && ts >= last) return null;
    this.lastSeen.set(key, ts);
    if (this.lastSeen.size > 5_000) this.prune(ts);

    const entry: JournalEntry = {
      id: uuid(),
      ts,
      category: d.category,
      tone: d.tone,
      code: d.code,
      params: d.params ?? {},
      why: d.why ?? null,
      roomId: d.roomId ?? null,
      sourceId: d.sourceId ?? null,
      deviceKey: d.deviceKey ?? null,
      entityIds: d.entityIds ?? [],
      notified: [],
    };
    await this.db.tx((em) => em.insert(JournalRow, { ...entry, params: entry.params as never, why: entry.why as never }));
    this.log.debug(`${entry.code} ${entry.roomId ?? entry.sourceId ?? entry.deviceKey ?? ''}`);
    this.events.send({ type: 'journal', payload: entry });
    this.bus.emit('journal.added', entry);
    return entry;
  }

  async page(q: JournalQuery): Promise<JournalPageDto> {
    const limit = Math.max(1, Math.min(PAGE_MAX, q.limit ?? PAGE_DEFAULT));
    const where: Record<string, unknown> = {};
    if (q.category) where.category = q.category;
    if (q.roomId) where.roomId = q.roomId;
    if (q.sourceId) where.sourceId = q.sourceId;
    if (q.deviceKey) where.deviceKey = q.deviceKey;
    if (q.codes?.length) where.code = In(q.codes);
    if (q.before !== undefined) where.ts = LessThan(q.before);
    const rows = await this.db.ds.getRepository(JournalRow).find({ where, order: { ts: 'DESC', id: 'DESC' }, take: limit });
    const items = rows.map(toEntry);
    return { items, nextBefore: items.length === limit ? items[items.length - 1].ts : null };
  }

  /** Journal lines mentioning an entity (device drawer history). */
  async forEntity(entityId: string, limit = 20): Promise<JournalEntry[]> {
    const rows = await this.db.ds
      .getRepository(JournalRow)
      .createQueryBuilder('j')
      .where('j.entityIds LIKE :p', { p: `%"${entityId}"%` })
      .orderBy('j.ts', 'DESC')
      .take(Math.min(PAGE_MAX, limit))
      .getMany();
    return rows.map(toEntry);
  }

  async forgetAfter(at: EpochMs): Promise<number> {
    for (const [k, ts] of this.lastSeen) if (ts > at) this.lastSeen.delete(k);
    const res = await this.db.tx((em) => em.delete(JournalRow, { ts: MoreThan(at) }));
    return res.affected ?? 0;
  }

  private prune(now: EpochMs): void {
    for (const [k, ts] of this.lastSeen) if (now - ts >= DEDUP_MS) this.lastSeen.delete(k);
  }
}
