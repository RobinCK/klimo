import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { errorText } from '../common/logger';
import { lazyRef } from '../common/refs';
import type {
  ActuatorRecord,
  CommandProgress,
  EngineConfig,
  EngineHealth,
  EntityId,
  EpochMs,
  EvaluateResult,
  HouseState,
  IBus,
  Id,
  IEvents,
  IIncidents,
  IReadModels,
  RoomState,
  RoomSyncState,
  SourceTestResult,
} from '../shared/model';
import { BUS, EVENTS, INCIDENTS, READ_MODELS } from '../tokens';

/* =====================================================================================================
 * The engine's live state as everybody else reads it: the house headline, rooms, the plant. After each
 * evaluation it is pushed to the browser (only what changed, the WebSocket throttles the rest) and
 * announced on the bus, where MQTT picks it up for the HA entities and the Lovelace cards.
 * ===================================================================================================== */

const SEC = 1000;
/** The house headline is re-sent at least this often even when nothing changed (clocks on the page). */
const HOUSE_REFRESH_MS = 60 * SEC;
/** A confirmed command still shows as «підтверджено» this long. */
const SYNC_DONE_MS = 60 * SEC;

export interface HouseInputs {
  now: EpochMs;
  tz: string;
  health: EngineHealth;
  haConnected: boolean;
  mqttConnected: boolean;
  lastTickAt: EpochMs;
  simulated: boolean;
  unitsOk: boolean;
}

/** Rooms that can heat or cool at all (control on, at least one enabled emitter with a role). */
function capableRooms(cfg: EngineConfig): number {
  return cfg.rooms.filter((r) => r.controlEnabled && (cfg.emittersByRoom[r.id] ?? []).some((e) => e.enabled && (e.roles.heat !== null || e.roles.cool !== null))).length;
}

/** The headline the overview, the house card and the phone header show. */
export function buildHouseState(cfg: EngineConfig, r: Pick<EvaluateResult, 'rooms' | 'plant' | 'season' | 'houseProfile'>, x: HouseInputs, counts: ReturnType<IIncidents['counts']> | null): HouseState {
  const active = r.rooms.filter((s) => s.hvacAction === 'heating' || s.hvacAction === 'cooling' || s.hvacAction === 'preheating' || s.hvacAction === 'drying').length;
  const attention = r.rooms.filter((s) => s.state === 'error' || s.issues.some((i) => i.tone === 'err')).length;
  const humid = r.rooms.map((s) => s.humidity.valuePct).filter((v): v is number => v !== null);
  const plant = r.plant;
  const verb = plant.coolDemand && !plant.heatDemand ? 'cool' : plant.heatDemand ? 'heat' : r.season.season === 'cooling' ? 'cool' : r.season.season === 'heating' ? 'heat' : 'none';
  return {
    now: x.now,
    tz: x.tz,
    engine: { health: x.health, haConnected: x.haConnected, mqttConnected: x.mqttConnected, lastTickAt: x.lastTickAt, simulated: x.simulated, unitsOk: x.unitsOk },
    houseName: cfg.settings.houseName,
    season: r.season,
    profile: r.houseProfile,
    counts: { total: cfg.rooms.length, capable: capableRooms(cfg), active, attention, monitorOnly: cfg.rooms.filter((x2) => !x2.controlEnabled).length },
    verb,
    leadSourceId: plant.lead.heat ?? plant.lead.cool,
    humidityAvgPct: humid.length ? Math.round(humid.reduce((a, b) => a + b, 0) / humid.length) : null,
    alertsCount: { critical: counts?.critical ?? 0, warning: counts?.warning ?? 0, total: counts?.total ?? 0 },
    deviceIssuesCount: counts?.deviceIssues ?? 0,
    inboxCount: counts?.inbox ?? 0,
  };
}

/** Sync progress of a room's heads and ACs right now («Надсилаю на 2 головки…»). */
export function roomSyncNow(entityIds: { trv: EntityId[]; ac: EntityId[] }, ledger: Record<string, ActuatorRecord>, valueC: number | null, maxAttempts: number, now: EpochMs): RoomSyncState {
  const rows = [...entityIds.trv.map((id) => ({ id, what: 'trv' as const })), ...entityIds.ac.map((id) => ({ id, what: 'ac' as const }))]
    .map((x) => ({ ...x, rec: ledger[x.id] }))
    .filter((x): x is { id: EntityId; what: 'trv' | 'ac'; rec: ActuatorRecord } => !!x.rec && x.rec.commandedAt !== null);
  const what: RoomSyncState['what'] = !rows.length ? 'none' : rows.every((x) => x.what === 'trv') ? 'trv' : rows.every((x) => x.what === 'ac') ? 'ac' : 'mixed';
  if (!rows.length) return { reqId: null, phase: 'idle', acked: 0, total: 0, attempt: 0, maxAttempts, valueC, what };
  const latest = Math.max(...rows.map((x) => x.rec.commandedAt as number));
  const batch = rows.filter((x) => (x.rec.commandedAt as number) >= latest - SYNC_DONE_MS);
  const pending = batch.filter((x) => x.rec.status === 'sending' || x.rec.status === 'queued' || x.rec.status === 'retrying');
  const acked = batch.filter((x) => x.rec.status === 'confirmed').length;
  let phase: RoomSyncState['phase'] = 'idle';
  if (batch.some((x) => x.rec.status === 'failed')) phase = 'failed';
  else if (batch.some((x) => x.rec.status === 'retrying')) phase = 'retry';
  else if (pending.length && acked) phase = 'partial';
  else if (pending.length) phase = 'sending';
  else if (batch.some((x) => x.rec.status === 'confirmed' && x.rec.confirmedAt !== null && now - x.rec.confirmedAt <= SYNC_DONE_MS)) phase = 'done';
  const reqId = batch.find((x) => x.rec.commandedAt === latest)?.rec.reqId ?? null;
  return { reqId, phase, acked, total: batch.length, attempt: Math.max(0, ...pending.map((x) => x.rec.attempts)), maxAttempts, valueC, what };
}

export function progressOf(rec: ActuatorRecord | undefined, maxAttempts: number): CommandProgress {
  if (!rec) return { status: 'idle', attempt: 0, maxAttempts, commandId: null, reqId: null, sentAt: null, confirmedAt: null };
  return { status: rec.status, attempt: rec.attempts, maxAttempts, commandId: rec.commandId, reqId: rec.reqId, sentAt: rec.commandedAt, confirmedAt: rec.confirmedAt };
}

@Injectable()
export class RuntimeCache {
  private readonly log = new Logger('Engine');
  private readonly readModels: () => IReadModels | null;
  private readonly incidents: () => IIncidents | null;
  private houseState: HouseState | null = null;
  private houseSentAt = 0;
  private houseKey = '';
  private plantKey = '';
  private readonly roomKeys = new Map<Id, string>();
  private readonly summaryKeys = new Map<Id, string>();
  private haKey = '';

  constructor(
    @Inject(EVENTS) private readonly events: IEvents,
    @Inject(BUS) private readonly bus: IBus,
    @Optional() @Inject(ModuleRef) moduleRef?: ModuleRef,
  ) {
    this.readModels = lazyRef<IReadModels>(moduleRef ?? null, READ_MODELS);
    this.incidents = lazyRef<IIncidents>(moduleRef ?? null, INCIDENTS);
  }

  house(): HouseState | null {
    return this.houseState;
  }

  /** Builds the headline from a result (also used for the preview before the engine runs). */
  setHouse(cfg: EngineConfig, r: Pick<EvaluateResult, 'rooms' | 'plant' | 'season' | 'houseProfile'>, x: HouseInputs): HouseState {
    let counts: ReturnType<IIncidents['counts']> | null = null;
    try {
      counts = this.incidents()?.counts() ?? null;
    } catch (e) {
      this.log.debug(`incident counts unavailable: ${errorText(e)}`);
    }
    this.houseState = buildHouseState(cfg, r, x, counts);
    return this.houseState;
  }

  /** Pushes what changed since the last evaluation and announces the tick (`live`: a real evaluation). */
  publish(result: EvaluateResult, house: HouseState, live: boolean): void {
    const now = house.now;
    const { now: _n, engine, ...rest } = house;
    const key = JSON.stringify({ ...rest, engine: { ...engine, lastTickAt: 0 } });
    if (key !== this.houseKey || now - this.houseSentAt >= HOUSE_REFRESH_MS || now < this.houseSentAt) {
      this.houseKey = key;
      this.houseSentAt = now;
      this.events.send({ type: 'house', payload: house });
    }
    this.publishRooms();
    if (this.events.clientCount() > 0) {
      const plantKey = JSON.stringify(result.plant);
      if (plantKey !== this.plantKey) {
        this.plantKey = plantKey;
        this.events.send({ type: 'plant', payload: result.plant });
      }
      for (const r of result.rooms) this.publishRoom(r);
    }
    if (live) this.bus.emit('engine.tick', { at: now, result });
  }

  /** Changed room cards (the summary also reflects overrides and incidents, so it is rebuilt each time). */
  publishRooms(): void {
    const rm = this.readModels();
    if (!rm) return;
    let summaries;
    try {
      summaries = rm.roomSummaries();
    } catch (e) {
      this.log.debug(`room summaries unavailable: ${errorText(e)}`);
      return;
    }
    const changed = summaries.filter((s) => {
      const k = JSON.stringify(s);
      if (this.summaryKeys.get(s.id) === k) return false;
      this.summaryKeys.set(s.id, k);
      return true;
    });
    const live = new Set(summaries.map((s) => s.id));
    for (const id of [...this.summaryKeys.keys()]) if (!live.has(id)) this.summaryKeys.delete(id);
    if (changed.length) this.events.send({ type: 'rooms', payload: changed });
  }

  private publishRoom(r: RoomState): void {
    const { updatedAt: _u, ...rest } = r;
    const k = JSON.stringify(rest);
    if (this.roomKeys.get(r.roomId) === k) return;
    this.roomKeys.set(r.roomId, k);
    this.events.send({ type: 'room', payload: r });
  }

  sync(roomId: Id | null, sync: RoomSyncState, devices: { entityId: EntityId; progress: CommandProgress }[]): void {
    this.events.send({ type: 'sync', payload: { roomId, reqId: sync.reqId, sync, devices } });
  }

  sourceTest(result: SourceTestResult): void {
    this.events.send({ type: 'source.test', payload: result });
  }

  /** HA connection / engine health for the banner (sent on change only). */
  ha(connected: boolean, health: EngineHealth): void {
    const k = `${connected}|${health}`;
    if (k === this.haKey) return;
    this.haKey = k;
    this.events.send({ type: 'ha', payload: { connected, health } });
  }
}
