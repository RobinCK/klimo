import { Inject, Injectable, Logger } from '@nestjs/common';
import { Db } from '../db/database';
import { OverrideRow } from '../db/entities';
import { deepClone } from '../shared/defaults';
import { isHeldOverride, overrideGroupOf } from '../shared/model';
import type { ClockPort, EpochMs, Id, IOverrideStore, Override, OverrideGroup } from '../shared/model';
import { CLOCK } from '../tokens';

export interface OverrideChange {
  op: 'created' | 'updated' | 'deleted';
  override: Override;
}

const COLUMNS: (keyof Override)[] = [
  'id', 'scope', 'subjectId', 'kind', 'group', 'value', 'duration', 'createdAt', 'until', 'by', 'previous', 'revertToken', 'revertUntil', 'reqId',
];

function toRow(o: Override): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const c of COLUMNS) row[c] = o[c] === undefined ? null : o[c];
  return row;
}

function fromRow(r: OverrideRow): Override {
  return {
    id: r.id,
    scope: r.scope as Override['scope'],
    subjectId: r.subjectId,
    kind: r.kind as Override['kind'],
    group: r.group as OverrideGroup,
    value: r.value,
    duration: r.duration as Override['duration'],
    createdAt: r.createdAt,
    until: r.until,
    by: r.by ?? { via: 'system', userId: null, userName: null, contextId: null },
    previous: r.previous,
    revertToken: r.revertToken,
    revertUntil: r.revertUntil,
    reqId: r.reqId,
  };
}

/**
 * Every time-boxed intent (manual target, boost, airing, room off, profile overrides, source locks).
 * At most one row per subject and group: a new override replaces the active one and keeps it in
 * `previous`, which is what «Скасувати» restores. Rows are mirrored in memory; the engine sees them
 * through `IConfigStore.engineConfig()`.
 */
@Injectable()
export class OverrideStore implements IOverrideStore {
  private readonly log = new Logger('Overrides');
  private readonly rows = new Map<Id, Override>();
  private readonly listeners = new Set<(changes: OverrideChange[]) => void>();

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async load(): Promise<void> {
    this.rows.clear();
    for (const r of await this.db.ds.getRepository(OverrideRow).find()) this.rows.set(r.id, fromRow(r));
    this.log.log(`${this.rows.size} active override(s)`);
  }

  /** Change notifications (the config store bumps its revision and pushes `config` to the UI). */
  onChange(cb: (changes: OverrideChange[]) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  active(): Override[] {
    return [...this.rows.values()].sort((a, b) => a.createdAt - b.createdAt).map((o) => deepClone(o));
  }

  forSubject(scope: Override['scope'], subjectId: Id): Override[] {
    return this.active().filter((o) => o.scope === scope && o.subjectId === subjectId);
  }

  byRevertToken(token: string): Override | undefined {
    for (const o of this.rows.values()) if (o.revertToken === token) return deepClone(o);
    return undefined;
  }

  async put(input: Override): Promise<Override> {
    const o: Override = { ...deepClone(input), group: overrideGroupOf(input.kind) };
    const replaced = [...this.rows.values()].filter((x) => x.scope === o.scope && x.subjectId === o.subjectId && x.group === o.group && x.id !== o.id);
    if (replaced.length && !o.previous?.override) {
      // keep one level of history: undo restores the override this one replaced, not the whole chain —
      // except a held change (manual control, room off) under it, which the room goes back to when the
      // temporary change ends
      const prev = replaced.sort((a, b) => b.createdAt - a.createdAt)[0];
      const under = prev.previous?.override ?? null;
      const keep = !isHeldOverride(prev) && under && isHeldOverride(under) ? { override: { ...deepClone(under), previous: null }, profileRow: null } : null;
      o.previous = { override: { ...deepClone(prev), previous: keep }, profileRow: o.previous?.profileRow ?? null };
    }
    const existed = this.rows.has(o.id);
    await this.db.tx(async (em) => {
      if (replaced.length) await em.delete(OverrideRow, replaced.map((x) => x.id));
      if (existed) await em.update(OverrideRow, { id: o.id }, toRow(o));
      else await em.insert(OverrideRow, toRow(o));
    });
    for (const x of replaced) this.rows.delete(x.id);
    this.rows.set(o.id, o);
    this.notify([...replaced.map((x) => ({ op: 'deleted' as const, override: x })), { op: existed ? 'updated' : 'created', override: o }]);
    return deepClone(o);
  }

  async remove(id: Id): Promise<void> {
    const o = this.rows.get(id);
    if (!o) return;
    await this.db.tx((em) => em.delete(OverrideRow, { id }).then(() => undefined));
    this.rows.delete(id);
    this.notify([{ op: 'deleted', override: o }]);
  }

  async removeGroup(scope: Override['scope'], subjectId: Id, group: OverrideGroup): Promise<Override | null> {
    const hits = [...this.rows.values()].filter((o) => o.scope === scope && o.subjectId === subjectId && o.group === group);
    if (!hits.length) return null;
    await this.db.tx((em) => em.delete(OverrideRow, hits.map((o) => o.id)).then(() => undefined));
    for (const o of hits) this.rows.delete(o.id);
    this.notify(hits.map((o) => ({ op: 'deleted' as const, override: o })));
    return deepClone(hits.sort((a, b) => b.createdAt - a.createdAt)[0]);
  }

  async expire(now: EpochMs = this.clock.now()): Promise<Override[]> {
    const due = [...this.rows.values()].filter((o) => o.until !== null && o.until <= now);
    if (!due.length) return [];
    await this.db.tx((em) => em.delete(OverrideRow, due.map((o) => o.id)).then(() => undefined));
    for (const o of due) this.rows.delete(o.id);
    this.notify(due.map((o) => ({ op: 'deleted' as const, override: o })));
    return due.map((o) => deepClone(o));
  }

  /* used by the config store, whose cascades write override rows inside its own transaction */

  snapshot(): Map<Id, Override> {
    return new Map([...this.rows].map(([id, o]) => [id, deepClone(o)]));
  }

  /** Mirrors rows the config store already wrote and announced (no change notification). */
  applyCommitted(upserts: Override[], deletes: Id[]): void {
    for (const id of deletes) this.rows.delete(id);
    for (const o of upserts) this.rows.set(o.id, deepClone(o));
  }

  private notify(changes: OverrideChange[]): void {
    for (const cb of this.listeners) {
      try {
        cb(changes);
      } catch (e) {
        this.log.error(`override listener failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}
