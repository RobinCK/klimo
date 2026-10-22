import { ISSUE_STYLE } from '../../shared/model';
import type {
  ActuatorRecord,
  EngineConfig,
  EntitySnap,
  EpochMs,
  Id,
  IssueCode,
  PlantState,
  ReasonParams,
  RoomConfig,
  RoomIssue,
  RoomServiceVerdict,
  RoomState,
  Season,
  TrvState,
} from '../../shared/model';
import { feedingSources } from './emitters';
import type { ComfortAlerts } from './safety';

/* =====================================================================================================
 * Room issue chips (D.20), sorted by rank: the room card shows the first, «+N» for the rest. Device-level
 * problems that need history (weak signal medians, battery forecasts) come from device health instead.
 * ===================================================================================================== */

const MIN_MS = 60_000;
const BATTERY_LOW_PCT = 20;
/** Wait reasons worth a chip: the source is held back by time, not by design. */
const TIMED_WAITS = new Set(['wait.min_off', 'wait.max_starts', 'wait.stagger', 'wait.lock', 'wait.prerun', 'wait.changeover']);

export interface IssueInput {
  cfg: EngineConfig;
  room: RoomConfig;
  state: Omit<RoomState, 'issues' | 'why' | 'sync' | 'hvacAction' | 'state' | 'tone'>;
  noDataSince: EpochMs | null;
  overheat: boolean;
  comfort: ComfortAlerts;
  humidExcluded: boolean;
  season: Season;
  coolCentral: boolean;
  verdict: RoomServiceVerdict;
  plant: PlantState;
  ledger: Record<string, ActuatorRecord>;
  trvs: TrvState[];
  /** Zone valves/switches of the room (conflict detection). */
  zoneEntityIds: string[];
  prevIssues: RoomIssue[];
  /** Snapshot entities (an entity absent from it is missing in Home Assistant). */
  entities: Record<string, EntitySnap>;
  /** Only a connected, non-blind snapshot can tell that an entity is gone. */
  haConnected: boolean;
  toutC: number | null;
  now: EpochMs;
}

export function roomIssues(x: IssueInput): RoomIssue[] {
  const out: RoomIssue[] = [];
  const s = x.state;
  const prevSince = (code: IssueCode) => x.prevIssues.find((i) => i.code === code)?.since ?? x.now;
  const add = (code: IssueCode, params: ReasonParams, since?: EpochMs | null) => {
    const style = ISSUE_STYLE[code];
    out.push({ code, tone: style.tone, icon: style.icon, rank: style.rank, params, incidentId: null, since: since ?? prevSince(code) });
  };

  if (s.tempC === null && x.room.controlEnabled) add('no_data', {}, x.noDataSince);
  const temps = s.sensors.filter((r) => r.role === 'temperature' && r.status !== 'excluded');
  const lost = temps.filter((r) => r.status === 'stale' || r.status === 'unavailable');
  if (lost.length) add('sensor_offline', { left: s.aggregation.activeCount, total: s.aggregation.totalCount });

  // a source that should serve this room is broken; name whoever took over
  const roomSources = new Set<Id>();
  for (const e of x.cfg.emittersByRoom[x.room.id] ?? []) if (e.enabled) for (const src of feedingSources(x.cfg, e)) roomSources.add(src.id);
  const faulted = x.plant.sources.find((p) => roomSources.has(p.sourceId) && p.state === 'fault');
  if (faulted) add('source_fault', { sourceId: faulted.sourceId, fallbackId: x.verdict.servingSourceIds.find((id) => id !== faulted.sourceId) ?? null }, faulted.fault?.since);

  for (const t of x.trvs) {
    if (t.sync.status === 'failed') add('trv_failed', { deviceId: t.deviceId });
  }
  const missing = !x.haConnected ? undefined : [...s.sensors.filter((r) => r.status !== 'excluded').map((r) => r.entityId), ...x.trvs.map((t) => t.entityId)].find(
    (id) => !(id in x.entities),
  );
  if (missing) add('entity_missing', { entityId: missing });

  if (x.comfort.tooCold.active) add('too_cold', { deltaC: x.comfort.tooCold.deltaC, minutes: x.comfort.tooCold.minutes }, x.comfort.tooColdSince);
  if (x.comfort.tooHot.active) add('too_hot', { deltaC: x.comfort.tooHot.deltaC, minutes: x.comfort.tooHot.minutes }, x.comfort.tooHotSince);

  const retrying = x.trvs.find((t) => t.sync.status === 'retrying');
  if (retrying) add('trv_retry', { attempt: retrying.sync.attempt, of: retrying.sync.maxAttempts });
  if (x.overheat) add('overheat', { t: s.tempC });

  const wait = x.verdict.waitReason;
  if (s.demand.mode !== 'none' && !x.verdict.served && wait && TIMED_WAITS.has(wait.code)) {
    add('source_wait', { sourceId: (wait.params?.['sourceId'] as string | undefined) ?? null, until: (wait.params?.['until'] as number | undefined) ?? null });
  }
  if (s.aggregation.fallback === 'trv') add('fallback_sensors', { n: s.aggregation.trvValues.length });

  const conflict = [...x.trvs.map((t) => t.entityId), ...x.zoneEntityIds].find((id) => x.ledger[id]?.status === 'backoff');
  if (conflict) add('actuator_conflict', { entityId: conflict });

  const rh = s.humidity.valuePct;
  if (s.humidity.condensationRisk) add('condensation', { rh, glassC: s.humidity.glassC, dewC: s.humidity.dewPointC });
  else if (s.humidity.warn) add('humidity_high', { rh });
  if (x.humidExcluded && x.coolCentral && hasCoolingFloor(x)) add('floor_humid', { rh });

  for (const r of s.sensors) {
    const pct = r.batteryPct;
    if (pct !== null && pct < BATTERY_LOW_PCT) {
      const sensor = (x.cfg.sensorsByRoom[x.room.id] ?? []).find((q) => q.id === r.sensorId);
      add('battery_low', { deviceKey: sensor?.haDeviceId ?? `entity:${r.entityId}`, pct });
      break;
    }
  }
  const lowTrv = x.trvs.find((t) => t.batteryPct !== null && t.batteryPct < BATTERY_LOW_PCT);
  if (lowTrv && !out.some((i) => i.code === 'battery_low')) {
    const dev = (x.cfg.devicesByEmitter[lowTrv.emitterId] ?? []).find((d) => d.id === lowTrv.deviceId);
    add('battery_low', { deviceKey: dev?.haDeviceId ?? `entity:${lowTrv.entityId}`, pct: lowTrv.batteryPct });
  }

  if (s.window.anyOpen && s.window.openSince !== null && x.now - s.window.openSince >= x.room.windows.remindAfterMin * MIN_MS) {
    add('window_long', { since: s.window.openSince }, s.window.openSince);
  }
  if (x.season === 'cooling' && rh !== null && rh > x.room.ac.dry.abovePct && roomHasDryAc(x)) add('humid_dry_hint', { rh });
  const tout = x.toutC;
  if (s.humidity.warn && x.season === 'heating' && tout !== null && s.tempC !== null && tout < s.tempC) add('airing_hint', { rh });

  return out.sort((a, b) => a.rank - b.rank);
}

function hasCoolingFloor(x: IssueInput): boolean {
  return (x.cfg.emittersByRoom[x.room.id] ?? []).some((e) => e.enabled && e.circuitId !== null && e.roles.cool !== null);
}

function roomHasDryAc(x: IssueInput): boolean {
  return (x.cfg.emittersByRoom[x.room.id] ?? []).some((e) => e.enabled && e.kind === 'direct' && feedingSources(x.cfg, e).some((s) => s.enabled && s.capabilities.dry));
}
