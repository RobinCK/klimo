import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { performance } from 'perf_hooks';
import { EntityManager } from 'typeorm';
import { errorText } from '../common/logger';
import { Db } from '../db/database';
import {
  ActuatorStateRow,
  ConditionStateRow,
  PlantStateRow,
  PumpControlStateRow,
  RoomControlStateRow,
  SeasonStateRow,
  SourceControlStateRow,
} from '../db/entities';
import { toLocal } from '../engine/core/time';
import {
  deepClone,
  defaultConditionMemory,
  defaultPlantMemory,
  defaultPumpMemory,
  defaultRoomMemory,
  defaultSeasonMemory,
  defaultSourceMemory,
  withDefaults,
} from '../shared/defaults';
import type { ActuatorRecord, ClockPort, EngineMemory, EpochMs, IBus, IConfigStore, Id, IMemoryStore, SeasonMemory } from '../shared/model';
import { BUS, CLOCK, CONFIG_STORE } from '../tokens';

const FLUSH_EVERY_MS = 5_000;
/** `flushNow()` gives up waiting after this: losing a bookkeeping write is better than delaying a safety command. */
const FLUSH_NOW_TIMEOUT_MS = 3_000;
const BACKUP_PAUSE_MAX_MS = 10 * 60_000;

type Persisted = {
  rooms: Map<Id, string>;
  sources: Map<Id, string>;
  pumps: Map<Id, string>;
  conditions: Map<string, string>;
  plant: string | null;
  season: string | null;
  ledger: Map<string, string>;
};

const emptyPersisted = (): Persisted => ({ rooms: new Map(), sources: new Map(), pumps: new Map(), conditions: new Map(), plant: null, season: null, ledger: new Map() });

/** Owner of a condition latch: 'trigger:<id>' | 'rule:<id>' | 'source:<sourceId>:<itemId>' | 'energy' | 'watch:<id>'. */
function conditionOwnerExists(key: string, config: IConfigStore): boolean {
  const [kind, id, item] = key.split(':');
  switch (kind) {
    case 'trigger': return !!config.get('triggers', id);
    case 'rule': return !!config.get('rules', id);
    case 'source': {
      const s = config.get('sources', id);
      return !!s && (!item || s.conditions.items.some((x) => x.id === item));
    }
    case 'watch': return !!config.get('watchRules', key.slice('watch:'.length));
    case 'energy': return true;
    default: return true;
  }
}

/**
 * Control memory (latches, timers, run clocks, learned rates…) and the reconciler ledger. The engine
 * hands over its next memory every tick; changes are written behind every 5 s in one transaction,
 * and `flushNow()` is awaited before any source/pump is switched so a crash can lose a command but
 * never the knowledge that something was started. A failing write keeps everything in memory, marks
 * the store unhealthy (engine health «degraded») and is retried — it never blocks a command.
 */
@Injectable()
export class MemoryStore implements IMemoryStore, OnModuleDestroy {
  private readonly log = new Logger('Memory');
  private mem: EngineMemory;
  private led: Record<string, ActuatorRecord> = {};
  private persisted: Persisted = emptyPersisted();
  private ok = true;
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private again = false;
  private pausedUntil: number | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(CONFIG_STORE) private readonly config: IConfigStore,
    @Inject(BUS) private readonly bus: IBus,
  ) {}

  async load(): Promise<EngineMemory> {
    const now = this.clock.now();
    const repo = <T extends object>(e: new () => T) => this.db.ds.getRepository(e);
    const mem: EngineMemory = {
      rooms: {},
      sources: {},
      pumps: {},
      conditions: {},
      plant: defaultPlantMemory(now),
      season: this.defaultSeason(now),
      ema: {},
    };
    this.persisted = emptyPersisted();
    for (const r of await repo(RoomControlStateRow).find()) {
      mem.rooms[r.roomId] = withDefaults(r.state, defaultRoomMemory(r.roomId, now));
      this.persisted.rooms.set(r.roomId, JSON.stringify(mem.rooms[r.roomId]));
    }
    for (const r of await repo(SourceControlStateRow).find()) {
      mem.sources[r.sourceId] = withDefaults(r.state, defaultSourceMemory(r.sourceId, now));
      this.persisted.sources.set(r.sourceId, JSON.stringify(mem.sources[r.sourceId]));
    }
    for (const r of await repo(PumpControlStateRow).find()) {
      mem.pumps[r.pumpId] = withDefaults(r.state, defaultPumpMemory(r.pumpId, now));
      this.persisted.pumps.set(r.pumpId, JSON.stringify(mem.pumps[r.pumpId]));
    }
    for (const r of await repo(ConditionStateRow).find()) {
      mem.conditions[r.ownerKey] = withDefaults(r.state, defaultConditionMemory(r.ownerKey, now));
      this.persisted.conditions.set(r.ownerKey, JSON.stringify(mem.conditions[r.ownerKey]));
    }
    const plant = await repo(PlantStateRow).findOneBy({ id: 'main' });
    if (plant) {
      mem.plant = withDefaults(plant.state, defaultPlantMemory(now));
      mem.plant.lastHeartbeatAt = plant.lastHeartbeatAt ?? mem.plant.lastHeartbeatAt;
      this.persisted.plant = JSON.stringify(mem.plant);
    }
    const season = await repo(SeasonStateRow).findOneBy({ id: 'main' });
    if (season) {
      mem.season = {
        season: season.season as SeasonMemory['season'],
        since: season.since,
        avgC: season.avgC,
        avgComputedAt: season.avgComputedAt,
        pending: season.pending ?? null,
        bootstrap: season.bootstrap,
      };
      this.persisted.season = JSON.stringify(mem.season);
    }
    this.led = {};
    for (const r of await repo(ActuatorStateRow).find()) {
      if (!r.record) continue;
      this.led[r.key] = r.record;
      this.persisted.ledger.set(r.key, JSON.stringify(r.record));
    }
    mem.plant.bootCount += 1;
    this.mem = mem;
    this.reconcileSubjects();
    await this.flush();

    this.unsubscribe = this.bus.on('config.changed', (e) => {
      if (e.op === 'imported' || ((e.entity === 'room' || e.entity === 'source' || e.entity === 'pump' || e.entity === 'trigger' || e.entity === 'rule') && (e.op === 'created' || e.op === 'deleted'))) {
        this.reconcileSubjects();
      }
    });
    this.timer = setInterval(() => {
      if (this.pausedUntil !== null && performance.now() < this.pausedUntil) return;
      this.pausedUntil = null;
      void this.flush();
    }, FLUSH_EVERY_MS);
    this.timer.unref();
    this.log.log(`boot #${mem.plant.bootCount}: ${Object.keys(mem.rooms).length} room(s), ${Object.keys(mem.sources).length} source(s), ${Object.keys(this.led).length} ledger row(s)`);
    return this.current();
  }

  current(): EngineMemory {
    return this.mem;
  }

  apply(next: EngineMemory): void {
    // the heartbeat is written beside the engine; never let an older tick roll it back
    const heartbeat = Math.max(this.mem.plant.lastHeartbeatAt, next.plant.lastHeartbeatAt);
    this.mem = next;
    if (next.plant.lastHeartbeatAt !== heartbeat) this.mem = { ...next, plant: { ...next.plant, lastHeartbeatAt: heartbeat } };
  }

  ledger(): Record<string, ActuatorRecord> {
    return this.led;
  }

  putLedger(records: ActuatorRecord[]): void {
    if (!records.length) return;
    this.led = { ...this.led };
    for (const r of records) this.led[r.key] = r;
  }

  removeLedger(keys: string[]): void {
    if (!keys.length) return;
    this.led = { ...this.led };
    for (const k of keys) delete this.led[k];
  }

  async flushNow(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        this.log.warn(`flush still running after ${FLUSH_NOW_TIMEOUT_MS} ms; continuing without waiting`);
        resolve();
      }, FLUSH_NOW_TIMEOUT_MS);
    });
    try {
      await Promise.race([this.flush(), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async heartbeat(at: EpochMs): Promise<void> {
    this.mem = { ...this.mem, plant: { ...this.mem.plant, lastHeartbeatAt: at } };
    try {
      await this.db.tx(async (em) => {
        await em.update(PlantStateRow, { id: 'main' }, { lastHeartbeatAt: at });
      });
    } catch (e) {
      this.markFailed(e);
    }
  }

  healthy(): boolean {
    return this.ok;
  }

  /** Backup hook: everything on disk, then no write-behind until `resume()` (or 10 min at most). */
  async pauseForBackup(): Promise<void> {
    await this.flushNow();
    this.pausedUntil = performance.now() + BACKUP_PAUSE_MAX_MS;
  }

  resume(): void {
    this.pausedUntil = null;
    void this.flush();
  }

  isPaused(): boolean {
    return this.pausedUntil !== null && performance.now() < this.pausedUntil;
  }

  /** Memory of subjects that were deleted is dropped; new rooms/sources/pumps start with every latch off. */
  reconcileSubjects(): void {
    const now = this.clock.now();
    const next: EngineMemory = { ...this.mem, rooms: { ...this.mem.rooms }, sources: { ...this.mem.sources }, pumps: { ...this.mem.pumps }, conditions: { ...this.mem.conditions } };
    const rooms = new Set(this.config.list('rooms').map((r) => r.id));
    const sources = new Set(this.config.list('sources').map((s) => s.id));
    const pumps = new Set(this.config.list('pumps').map((p) => p.id));
    for (const id of rooms) next.rooms[id] ??= defaultRoomMemory(id, now);
    for (const id of sources) next.sources[id] ??= defaultSourceMemory(id, now);
    for (const id of pumps) next.pumps[id] ??= defaultPumpMemory(id, now);
    for (const id of Object.keys(next.rooms)) if (!rooms.has(id)) delete next.rooms[id];
    for (const id of Object.keys(next.sources)) if (!sources.has(id)) delete next.sources[id];
    for (const id of Object.keys(next.pumps)) if (!pumps.has(id)) delete next.pumps[id];
    for (const key of Object.keys(next.conditions)) if (!conditionOwnerExists(key, this.config)) delete next.conditions[key];
    this.mem = next;
  }

  /** Retention: latches of conditions whose owner is gone. */
  pruneOrphans(): number {
    const before = Object.keys(this.mem.conditions).length;
    this.reconcileSubjects();
    return before - Object.keys(this.mem.conditions).length;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
  }

  /* ── write-behind ─────────────────────────────────────────────────────────────────────────── */

  private defaultSeason(now: EpochMs): SeasonMemory {
    return defaultSeasonMemory(now, this.config.singleton('season'), toLocal(now, this.clock.tz()).month);
  }

  /** Writes what changed since the last flush; concurrent calls coalesce into one more round. */
  private flush(): Promise<void> {
    if (this.flushing) {
      this.again = true;
      return this.flushing;
    }
    this.flushing = (async () => {
      do {
        this.again = false;
        await this.flushOnce();
      } while (this.again);
    })().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async flushOnce(): Promise<void> {
    if (!this.mem) return;
    const mem = this.mem;
    const led = this.led;
    const now = this.clock.now();
    const next = emptyPersisted();
    const work: ((em: EntityManager) => Promise<unknown>)[] = [];

    const diff = <T>(cur: Record<string, T>, prev: Map<string, string>, store: Map<string, string>, save: (key: string, value: T) => (em: EntityManager) => Promise<unknown>, del: (keys: string[]) => (em: EntityManager) => Promise<unknown>) => {
      for (const [key, value] of Object.entries(cur)) {
        const json = JSON.stringify(value);
        store.set(key, json);
        if (prev.get(key) !== json) work.push(save(key, value));
      }
      const gone = [...prev.keys()].filter((k) => !(k in cur));
      if (gone.length) work.push(del(gone));
    };

    diff(mem.rooms, this.persisted.rooms, next.rooms, (roomId, state) => (em) =>
      em.upsert(RoomControlStateRow, { roomId, state, heatOn: state.heat.on, coolOn: state.cool.on, demandMode: state.demandMode, updatedAt: now }, ['roomId']),
    (ids) => (em) => em.delete(RoomControlStateRow, ids));
    diff(mem.sources, this.persisted.sources, next.sources, (sourceId, state) => (em) =>
      em.upsert(SourceControlStateRow, { sourceId, state, on: state.on, mode: state.mode, onSince: state.onSince, offSince: state.offSince, confirm: state.confirm, updatedAt: now }, ['sourceId']),
    (ids) => (em) => em.delete(SourceControlStateRow, ids));
    diff(mem.pumps, this.persisted.pumps, next.pumps, (pumpId, state) => (em) =>
      em.upsert(PumpControlStateRow, { pumpId, state, on: state.on, runOnUntil: state.runOnUntil, updatedAt: now }, ['pumpId']),
    (ids) => (em) => em.delete(PumpControlStateRow, ids));
    diff(mem.conditions, this.persisted.conditions, next.conditions, (ownerKey, state) => (em) =>
      em.upsert(ConditionStateRow, { ownerKey, state, active: state.active, since: state.since, updatedAt: now }, ['ownerKey']),
    (keys) => (em) => em.delete(ConditionStateRow, keys));
    diff(led, this.persisted.ledger, next.ledger, (key, record) => (em) =>
      em.upsert(ActuatorStateRow, { key, record: record as never, entityId: record.entityId, status: record.status, updatedAt: now }, ['key']),
    (keys) => (em) => em.delete(ActuatorStateRow, keys));

    next.plant = JSON.stringify(mem.plant);
    if (next.plant !== this.persisted.plant) {
      const plant = mem.plant;
      work.push((em) => em.upsert(PlantStateRow, { id: 'main', state: plant, lastHeartbeatAt: plant.lastHeartbeatAt, bootCount: plant.bootCount }, ['id']));
    }
    next.season = JSON.stringify(mem.season);
    if (next.season !== this.persisted.season) {
      const s = mem.season;
      work.push((em) => em.upsert(SeasonStateRow, { id: 'main', season: s.season, since: s.since, avgC: s.avgC, avgComputedAt: s.avgComputedAt, bootstrap: s.bootstrap, pending: s.pending }, ['id']));
    }
    if (!work.length) return;
    try {
      await this.db.tx(async (em) => {
        for (const w of work) await w(em);
      });
      this.persisted = next;
      if (!this.ok) this.log.log('control memory is being saved again');
      this.ok = true;
    } catch (e) {
      this.markFailed(e);
    }
  }

  private markFailed(e: unknown): void {
    if (this.ok) this.log.error(`saving control memory failed (kept in memory, retrying every 5 s): ${errorText(e)}`);
    this.ok = false;
  }

  /** Test seam: a copy of what is currently held in memory. */
  snapshot(): { memory: EngineMemory; ledger: Record<string, ActuatorRecord> } {
    return { memory: deepClone(this.mem), ledger: deepClone(this.led) };
  }
}
