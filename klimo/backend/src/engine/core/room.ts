import { ROOM_STATE_STYLE } from '../../shared/model';
import type {
  ActuatorRecord,
  Decision,
  DesiredActuator,
  Detection,
  EmitterState,
  EngineConfig,
  EpochMs,
  EvaluateRoomFn,
  FinishRoomFn,
  Id,
  InputSnapshot,
  Latch,
  Mode,
  Override,
  PlantState,
  RoomConfig,
  RoomEval,
  RoomMemory,
  RoomState,
  RoomStateKind,
  RoomSyncState,
  Season,
  SourceConfig,
  SpanEvent,
  Tone,
  TrvState,
} from '../../shared/model';
import { defaultRoomMemory } from '../../shared/defaults';
import { aggregateRoom, trendOf, trvLocalTemp, type EmaMap, type TrvInput } from './aggregate';
import { etaOf } from './eta';
import { emitterRequests, feedingSources } from './emitters';
import { evaluateHumidity } from './humidity';
import {
  circuitById,
  demandBlock,
  modeAvailability,
  sourceById,
  stepDemand,
  stepLatch,
  thresholdsOf,
  weatherShift,
  type LatchPosition,
  type LatchStep,
  type ModeAvailability,
} from './hysteresis';
import { roomIssues } from './issues';
import { learnDrift, learnEpisode, learnOffsets, servedThroughout } from './learning';
import { frostProbe, safetyEvents, stepComfortAlerts, stepFloorLimit, stepFrost, stepOverheat, type ComfortAlerts } from './safety';
import { finalizeTarget, resolveRoomTarget, roomOverride, roomProfileValues, scheduledBaseAt } from './targets';
import { fromLocal, hhmmToMinute, toLocal } from './time';
import { trvActuation } from './trv';
import { clamp } from './util';
import { roomWhy } from './why';
import { evaluateWindows, windowOpenLong } from './windows';
import { dehumidifierActuation, zoneActuation } from './zones';

/* =====================================================================================================
 * One room per tick, in two halves around the plant step. `evaluateRoom` turns sensors, windows, the
 * priority chain and the latches into a request (what the room wants, which emitters it asks for);
 * `finishRoom` takes the plant's verdict (who serves it, which emitters are open) and produces the chip,
 * the radiator-head and zone values, the issues and the «Чому» sentence.
 * ===================================================================================================== */

const MIN_MS = 60_000;
/** Ticks further apart than this are not one continuous interval for integrators and learning. */
const MAX_DT_MS = 5 * MIN_MS;
/** Release of the AC dry latch below its humidity threshold. */
const DRY_RELEASE_PCT = 5;
/** Rooms are exercised one after another, this far apart. */
const EXERCISE_STAGGER_MS = 30_000;
/** A command confirmed this recently still shows as «підтверджено». */
const SYNC_DONE_MS = 60_000;

/** Context `evaluateRoom` hands to `finishRoom` for the same room in the same tick. */
interface RoomInternals {
  season: Season;
  coldGuardOnly: boolean;
  houseOff: boolean;
  modes: ModeAvailability;
  off: 'room' | 'profile' | 'frost_only' | null;
  windowPause: boolean;
  airing: Override | null;
  frostT: number | null;
  overheat: boolean;
  floorLimit: boolean;
  latchPos: { heat: LatchPosition; cool: LatchPosition };
  heldByMinRequest: boolean;
  weatherShiftC: number;
  toutC: number | null;
  virtualDropC: number | null;
  comfort: ComfortAlerts;
  prevUpdatedAt: EpochMs;
  reqId: string | null;
}

// Kept off the enumerable shape so the RoomEval stays exactly the contract type on the wire.
const INTERNALS = Symbol('roomInternals');
type RoomEvalInternal = RoomEval & { [INTERNALS]?: RoomInternals };

/* ── helpers ──────────────────────────────────────────────────────────────────────────────────────── */

function roomTrvs(cfg: EngineConfig, roomId: Id, inputs: InputSnapshot): TrvInput[] {
  const out: TrvInput[] = [];
  for (const e of cfg.emittersByRoom[roomId] ?? []) {
    if (!e.enabled) continue;
    for (const d of cfg.devicesByEmitter[e.id] ?? []) if (d.kind === 'trv') out.push({ device: d, snap: inputs.entities[d.entityId] });
  }
  return out;
}

/** Room-scope climate sources (ACs, climate-driven floors) serving the room. */
function roomClimateSources(cfg: EngineConfig, roomId: Id): SourceConfig[] {
  const out: SourceConfig[] = [];
  for (const e of cfg.emittersByRoom[roomId] ?? []) {
    if (!e.enabled || !e.sourceId) continue;
    const s = sourceById(cfg, e.sourceId);
    if (s && s.adapter.type === 'climate' && s.adapter.climate && !out.includes(s)) out.push(s);
  }
  return out;
}

function roomSourceIds(cfg: EngineConfig, roomId: Id): Set<Id> {
  const out = new Set<Id>();
  for (const e of cfg.emittersByRoom[roomId] ?? []) if (e.enabled) for (const s of feedingSources(cfg, e)) out.add(s.id);
  return out;
}

function keepOff(prev: Latch, step: LatchStep): LatchStep {
  return { latch: prev, flipped: false, position: step.position };
}

/** AC «осушення замість охолодження»: humid air while the temperature is already inside the cooling band. */
function stepDry(cfg: EngineConfig, room: RoomConfig, prev: Latch, x: { t: number | null; rh: number | null; coolC: number | null; coolDemand: boolean; coolLocal: boolean; blocked: boolean }, now: EpochMs): Latch {
  const dryAc = (cfg.emittersByRoom[room.id] ?? []).some((e) => e.enabled && e.kind === 'direct' && e.roles.cool !== null && !!sourceById(cfg, e.sourceId)?.capabilities.dry);
  const allowed = dryAc && room.ac.dry.enabled && cfg.cool.dryInsteadOfCool.enabled && x.coolLocal && !x.coolDemand && !x.blocked;
  const tol = room.tolerance.cool;
  const inBand = x.t !== null && x.coolC !== null && x.t > x.coolC - tol.below && x.t < x.coolC + tol.above;
  const want = allowed && inBand && x.rh !== null;
  let on = prev.on;
  if (!want) on = false;
  else if (!prev.on && (x.rh as number) > room.ac.dry.abovePct) on = true;
  else if (prev.on && (x.rh as number) <= room.ac.dry.abovePct - DRY_RELEASE_PCT) on = false;
  return on === prev.on ? prev : { on, since: now };
}

/**
 * Did the room's target move by ≥ 0.5 since `since` (an episode spoiled by a target change)? A manual
 * change during the episode counts; otherwise the profile in force then and now are compared.
 */
function targetChangedSince(cfg: EngineConfig, room: RoomConfig, since: EpochMs, now: EpochMs, tz: string, mode: Mode): boolean {
  const own = roomOverride(cfg, room.id, 'target', now);
  if (own) return own.createdAt > since;
  const valueAt = (ts: EpochMs) => {
    const v = roomProfileValues(cfg, scheduledBaseAt(cfg, room.id, ts, tz).profileId, room.id);
    return mode === 'heat' ? v.heatC : v.coolC;
  };
  const then = valueAt(since);
  const current = valueAt(now);
  return then === null || current === null || Math.abs(then - current) >= 0.5;
}

function windowReactionOf(room: RoomConfig, reactionActive: boolean): RoomConfig['windows']['reaction'] | null {
  return reactionActive ? room.windows.reaction : null;
}

/* ── first half: the request ───────────────────────────────────────────────────────────────────────── */

export const evaluateRoom: EvaluateRoomFn = (cfg, room, inputs, memory, ctx) => {
  const now = inputs.now;
  const prev: RoomMemory = memory.rooms[room.id] ?? defaultRoomMemory(room.id, now);
  const dtMs = clamp(now - prev.updatedAt, 0, MAX_DT_MS);
  const sensors = cfg.sensorsByRoom[room.id] ?? [];
  const trvs = roomTrvs(cfg, room.id, inputs);
  const decisions: Decision[] = [];
  const detections: Detection[] = [];
  const spans: SpanEvent[] = [];

  // temperature
  const agg = aggregateRoom(room, sensors, trvs, inputs, memory.ema, prev.learned);
  const tempC = agg.result.valueC;
  const noData = tempC === null;
  const noDataSince = noData ? (prev.noDataSince ?? now) : null;
  const prevFallback = inputs.prev.rooms[room.id]?.aggregation.fallback ?? null;
  if (agg.result.fallback === 'trv' && prevFallback !== null && prevFallback !== 'trv') {
    decisions.push({ code: 'room.trv_fallback', category: 'rooms', tone: 'warn', params: { n: agg.result.trvValues.length }, roomId: room.id });
  }

  // a sensor that stopped reporting (or came back) is journalled once, on the edge
  const prevReadings = inputs.prev.rooms[room.id]?.sensors ?? [];
  for (const r of agg.readings) {
    const before = prevReadings.find((x) => x.sensorId === r.sensorId)?.status;
    if (!before || r.role === 'contact') continue;
    const s = sensors.find((x) => x.id === r.sensorId);
    const deviceKey = s?.haDeviceId ?? `entity:${r.entityId}`;
    const lost = r.status === 'stale' || r.status === 'unavailable';
    const wasLost = before === 'stale' || before === 'unavailable';
    if (lost && !wasLost) {
      const minutes = r.lastReportedAt === null ? 0 : Math.floor((now - r.lastReportedAt) / MIN_MS);
      decisions.push({ code: 'sensor.stale', category: 'dev', tone: 'warn', params: { minutes }, roomId: room.id, deviceKey, entityIds: [r.entityId] });
    } else if (!lost && wasLost && r.status !== 'excluded') {
      decisions.push({ code: 'sensor.back', category: 'dev', tone: 'ok', params: {}, roomId: room.id, deviceKey, entityIds: [r.entityId] });
    }
  }

  // windows (before humidity: the dehumidifier stops while airing)
  const ignore = roomOverride(cfg, room.id, 'window_ignore', now);
  const airing = roomOverride(cfg, room.id, 'airing', now);
  const win = evaluateWindows(room, inputs, prev.window, { contacts: sensors, rawC: agg.rawC, ignore, airing });
  decisions.push(...win.decisions);
  const reaction = windowReactionOf(room, win.state.reactionActive);
  const windowPause = reaction === 'pause';

  const hum = evaluateHumidity(room, inputs, {
    readings: agg.readings,
    tempC,
    season: ctx.season.season,
    ventilating: (reaction !== null && reaction !== 'notify') || airing !== null,
    dehumidifier: prev.dehumidifier,
    glassK: cfg.settings.glassCoefficient,
  });

  // target and what the room can do with it
  const tr = resolveRoomTarget(cfg, room, inputs, prev, ctx, {
    tempC,
    windowOpen: win.state.anyOpen || win.state.virtual,
    windowReaction: reaction,
    airing,
  });
  const modes = modeAvailability(cfg, room, tr.target, ctx.season, hum.state.valuePct, now);
  let target = finalizeTarget(tr.target, modes);
  const houseOff = ctx.season.houseMode === 'off';

  // safety latches
  const trvTemps = trvs.map((t) => trvLocalTemp(t.snap)).filter((v): v is number => v !== null);
  const frostT = frostProbe(tempC, trvTemps);
  const frost = room.controlEnabled
    ? stepFrost(prev.frost, frostT, target.frostFloorC, cfg.safety, now)
    : { latch: prev.frost.on ? { on: false, since: now } : prev.frost, flipped: prev.frost.on };
  const overheat = stepOverheat(prev.overheat, tempC, room.smart.overheat.enabled && room.controlEnabled, modes.heat, cfg.safety, now);
  const floorLimit = stepFloorLimit(prev.floorLimit, agg.result.floorC, room.floor.maxFloorC, now);

  // latches on the rounded temperature
  const toutC = inputs.outdoor.nowC ?? inputs.outdoor.avg10C;
  const shiftC = weatherShift(room, toutC);
  const thresholds = thresholdsOf(target, room.tolerance, shiftC);
  const off = tr.off;
  const commonBlock = windowPause || airing !== null || off !== null || !room.controlEnabled;
  let heat = stepLatch(prev.heat, 'heat', tempC, thresholds.heatOnC, thresholds.heatOffC, commonBlock || !modes.heat || overheat.latch.on, now);
  let cool = stepLatch(prev.cool, 'cool', tempC, thresholds.coolOnC, thresholds.coolOffC, commonBlock || !modes.cool, now);
  // with a sane gap both cannot be ON; after a config race the later flip is dropped
  if (heat.latch.on && cool.latch.on) {
    if (cool.flipped) cool = keepOff(prev.cool, cool);
    else heat = keepOff(prev.heat, heat);
  }

  const hardBlock = (m: Mode) => commonBlock || noData || houseOff || !modes[m] || (m === 'heat' && overheat.latch.on);
  const dem = stepDemand(prev.demandMode, prev.demandSince, { heatOn: heat.latch.on, coolOn: cool.latch.on, frost: frost.latch.on, hardBlock, minRequestMin: room.demand.minRequestMin }, now);
  // frost may always call a source, whatever the room's demand policy
  const canCallSource = frost.latch.on || (room.demand.policy === 'call' && dem.mode !== 'none' && !hardBlock(dem.mode));
  if (prev.demandMode !== dem.mode) {
    if (prev.demandMode !== 'none') spans.push({ subject: 'room', subjectId: room.id, kind: 'demand', mode: prev.demandMode, edge: 'end', at: now });
    if (dem.mode !== 'none') spans.push({ subject: 'room', subjectId: room.id, kind: 'demand', mode: dem.mode, edge: 'start', at: now });
  }

  if (frost.latch.on) target = { ...target, layer: 'frost', display: 'frost' };
  else if (noData && room.controlEnabled) target = { ...target, display: 'no_data' };

  const em = emitterRequests(
    cfg,
    room,
    {
      demand: dem.mode,
      frost: frost.latch.on,
      t: tempC,
      target,
      tolerance: room.tolerance,
      season: ctx.season,
      overlay: ctx.overlay,
      prevPlant: ctx.prevPlant,
      rh: hum.state.valuePct,
      floorLimit: floorLimit.latch.on,
      floorC: agg.result.floorC,
      blocked: commonBlock || overheat.latch.on,
      overheat: overheat.latch.on,
      assist: prev.assist,
      store: prev.store,
      heatingSeason: ctx.season.season === 'heating' || ctx.season.heatAllowed.central,
    },
    now,
  );
  const dry = stepDry(cfg, room, prev.dry, {
    t: tempC,
    rh: hum.state.valuePct,
    coolC: target.coolC,
    coolDemand: dem.mode === 'cool',
    coolLocal: ctx.season.coolAllowed.local,
    blocked: commonBlock,
  }, now);

  // alerts
  const conditioned = modes.heat || modes.cool;
  const comfort = stepComfortAlerts(
    prev,
    { watching: room.controlEnabled && !win.state.reactionActive && airing === null && !frost.latch.on, t: tempC, heatC: target.heatC, coolC: target.coolC, heatActive: modes.heat, coolActive: modes.cool },
    now,
  );
  const wol = windowOpenLong(room, win.state, win.memory, now, conditioned);
  if (wol.detection) detections.push(wol.detection);
  detections.push(...hum.detections);
  const sev = safetyEvents(
    room,
    {
      frost,
      frostT,
      floorC: target.frostFloorC,
      overheat,
      t: tempC,
      overheatC: cfg.safety.overheatC,
      noData,
      noDataSince,
      noDataBecame: noData && prev.noDataSince === null,
      dataBack: !noData && prev.noDataSince !== null,
      heatAllowed: ctx.season.heatAllowed.central || ctx.season.heatAllowed.local,
      outdoorC: toutC,
      comfort,
    },
    now,
  );
  decisions.push(...sev.decisions);
  detections.push(...sev.detections);

  // learning
  let learned = learnOffsets(prev.learned, {
    roomRawC: agg.result.fallback === 'none' ? agg.rawC : null,
    trvs,
    acs: roomClimateSources(cfg, room.id).map((s) => ({ sourceId: s.id, snap: inputs.entities[(s.adapter as { climate: string }).climate] })),
    dtMs,
  });
  const history = inputs.roomTempHistory[room.id];
  const served = (start: EpochMs) => servedThroughout(ctx.prevPlant, roomSourceIds(cfg, room.id), start, now);
  for (const [mode, step, before] of [['heat', heat, prev.heat], ['cool', cool, prev.cool]] as const) {
    if (step.flipped && before.on && !step.latch.on) {
      learned = learnEpisode(
        learned,
        {
          mode,
          prev: before,
          history,
          rawC: agg.rawC,
          windowSince: prev.window.reactionSince,
          targetChanged: targetChangedSince(cfg, room, before.since, now, inputs.tz, mode),
          served: served(before.since),
        },
        now,
      );
    }
  }
  if ((heat.flipped && heat.latch.on) || (cool.flipped && cool.latch.on)) {
    if (!prev.heat.on && !prev.cool.on) {
      learned = learnDrift(learned, { idleSince: Math.max(prev.heat.since, prev.cool.since), history, rawC: agg.rawC, windowSince: prev.window.reactionSince }, now);
    }
  }

  const eta = etaOf(dem.mode, tempC, target, room.tolerance, learned, now);
  const activeRuleIds = new Set<Id>();
  for (const a of target.adjustments) if (a.code === 'rule_offset' && a.ref) activeRuleIds.add(a.ref);
  const sources = roomSourceIds(cfg, room.id);
  for (const a of ctx.overlay.allowSources) if (sources.has(a.sourceId)) activeRuleIds.add(a.ruleId);

  const nextMemory: RoomMemory = {
    ...prev,
    heat: heat.latch,
    cool: cool.latch,
    frost: frost.latch,
    overheat: overheat.latch,
    assist: em.assist,
    dry,
    store: em.store,
    dehumidifier: hum.dehumidifier,
    floorLimit: floorLimit.latch,
    demandMode: dem.mode,
    demandSince: dem.since,
    preheat: tr.preheat,
    window: wol.memory,
    tooColdSince: comfort.tooColdSince,
    tooHotSince: comfort.tooHotSince,
    noDataSince,
    learned,
    updatedAt: now,
  };

  const ev: RoomEvalInternal = {
    roomId: room.id,
    memory: nextMemory,
    partial: {
      roomId: room.id,
      tempC,
      aggregation: agg.result,
      sensors: agg.readings,
      trendCPerH: trendOf(history, now),
      target,
      thresholds,
      activeModes: { heat: modes.heat, cool: modes.cool },
      demand: {
        mode: dem.mode,
        latched: { heat: heat.latch.on, cool: cool.latch.on },
        since: dem.since,
        minRequestUntil: dem.minRequestUntil,
        canCallSource,
        served: false,
        servingSourceIds: [],
        waitReason: null,
        block: demandBlock({
          controlEnabled: room.controlEnabled,
          noData,
          houseOff,
          targetOff: off !== null,
          windowPause,
          airing: airing !== null,
          overheat: overheat.latch.on,
          modes,
          policyNever: room.demand.policy === 'never',
        }),
        frost: frost.latch.on,
        assist: em.assist.on,
        dry: dry.on,
        store: em.store.on,
      },
      window: win.state,
      humidity: hum.state,
      eta,
      activeRuleIds: [...activeRuleIds],
      updatedAt: now,
    },
    emitterRequests: em.requests,
    decisions,
    detections,
    spans,
  };
  ev[INTERNALS] = {
    season: ctx.season.season,
    coldGuardOnly: ctx.season.heatAllowed.coldGuardOnly,
    houseOff,
    modes,
    off,
    windowPause,
    airing,
    frostT,
    overheat: overheat.latch.on,
    floorLimit: floorLimit.latch.on,
    latchPos: { heat: heat.position, cool: cool.position },
    heldByMinRequest: dem.heldByMinRequest,
    weatherShiftC: shiftC,
    toutC,
    virtualDropC: win.virtualDropC,
    comfort,
    prevUpdatedAt: prev.updatedAt,
    reqId: tr.targetOverride?.reqId ?? null,
  };
  return ev;
};

/** EMA entries for the next tick, rebuilt from this tick's sensor readings (the volatile smoothing state). */
export function nextEma(rooms: readonly { partial: Pick<RoomState, 'sensors'> }[] | readonly Pick<RoomState, 'sensors'>[], now: EpochMs): EmaMap {
  const out: EmaMap = {};
  for (const r of rooms) {
    const sensors = 'partial' in r ? r.partial.sensors : r.sensors;
    for (const s of sensors) if (s.role === 'temperature' && s.smoothedC !== null && (s.status === 'ok' || s.status === 'outlier')) out[s.sensorId] = { value: s.smoothedC, at: now };
  }
  return out;
}

/* ── second half: after the plant verdict ──────────────────────────────────────────────────────────── */

/** Reconstruction when a RoomEval did not come straight from `evaluateRoom` (e.g. it was cloned). */
function internalsOf(ev: RoomEvalInternal, cfg: EngineConfig, room: RoomConfig): RoomInternals {
  const own = ev[INTERNALS];
  if (own) return own;
  const p = ev.partial;
  const airing = roomOverride(cfg, room.id, 'airing', p.updatedAt);
  const modes: ModeAvailability = {
    heat: p.activeModes.heat,
    cool: p.activeModes.cool,
    heatBlock: p.activeModes.heat ? 'ok' : p.demand.block === 'season' ? 'season' : 'no_emitter',
    coolBlock: p.activeModes.cool ? 'ok' : p.demand.block === 'season' ? 'season' : 'no_emitter',
    humidExcluded: false,
  };
  return {
    season: cfg.house.mode === 'cool' ? 'cooling' : 'heating',
    coldGuardOnly: false,
    houseOff: cfg.house.mode === 'off',
    modes,
    off: p.demand.block === 'off' ? (p.target.layer === 'room_off' ? 'room' : 'profile') : null,
    windowPause: p.window.reactionActive && p.window.reaction === 'pause',
    airing,
    frostT: p.tempC,
    overheat: ev.memory.overheat.on,
    floorLimit: ev.memory.floorLimit.on,
    latchPos: { heat: p.demand.latched.heat ? 'in_band_on' : 'in_band_off', cool: p.demand.latched.cool ? 'in_band_on' : 'in_band_off' },
    heldByMinRequest: false,
    weatherShiftC: 0,
    toutC: null,
    virtualDropC: null,
    comfort: {
      tooColdSince: ev.memory.tooColdSince,
      tooHotSince: ev.memory.tooHotSince,
      tooCold: { active: false, deltaC: null, minutes: 0 },
      tooHot: { active: false, deltaC: null, minutes: 0 },
    },
    prevUpdatedAt: p.updatedAt - 10_000,
    reqId: null,
  };
}

/** Weekly valve exercise window of this room (rooms staggered 30 s), when nothing needs the radiators. */
function exercising(cfg: EngineConfig, room: RoomConfig, inputs: InputSnapshot, x: { season: Season; idle: boolean; windowOpen: boolean; plant: PlantState }): boolean {
  const ex = cfg.safety.valveExercise;
  if (!ex.enabled || !room.smart.valveExercise.enabled || !room.controlEnabled) return false;
  if (ex.offSeasonOnly && x.season === 'heating') return false;
  if (!x.idle || x.windowOpen) return false;
  // chilled water must never be pushed through radiators
  const cooling = x.plant.sources.some((s) => s.on && s.mode === 'cool' && sourceById(cfg, s.sourceId)?.scope === 'central');
  if (cooling) return false;
  const lt = toLocal(inputs.now, inputs.tz);
  if (lt.dow !== ex.dow) return false;
  let minute: number;
  try {
    minute = hhmmToMinute(ex.time);
  } catch {
    return false;
  }
  const idx = [...cfg.rooms].sort((a, b) => a.order - b.order).findIndex((r) => r.id === room.id);
  const start = fromLocal(lt.date, minute, inputs.tz) + Math.max(0, idx) * EXERCISE_STAGGER_MS;
  return inputs.now >= start && inputs.now < start + ex.durationSec * 1000;
}

/** Aggregate sync state of the room's head and AC commands for the card «Надсилаю на 2 головки…». */
function roomSync(trvEntityIds: string[], acEntityIds: string[], ledger: Record<string, ActuatorRecord>, valueC: number | null, maxAttempts: number, now: EpochMs): RoomSyncState {
  const rows = [...trvEntityIds.map((id) => ({ id, what: 'trv' as const })), ...acEntityIds.map((id) => ({ id, what: 'ac' as const }))]
    .map((r) => ({ ...r, rec: ledger[r.id] }))
    .filter((r): r is { id: string; what: 'trv' | 'ac'; rec: ActuatorRecord } => !!r.rec && r.rec.commandedAt !== null);
  const what: RoomSyncState['what'] = rows.length === 0 ? 'none' : rows.every((r) => r.what === 'trv') ? 'trv' : rows.every((r) => r.what === 'ac') ? 'ac' : 'mixed';
  if (!rows.length) return { reqId: null, phase: 'idle', acked: 0, total: 0, attempt: 0, maxAttempts, valueC, what };
  // the latest change and every command that went out with it
  const latest = Math.max(...rows.map((r) => r.rec.commandedAt as number));
  const batch = rows.filter((r) => (r.rec.commandedAt as number) >= latest - SYNC_DONE_MS);
  const pending = batch.filter((r) => r.rec.status === 'sending' || r.rec.status === 'queued' || r.rec.status === 'retrying');
  const acked = batch.filter((r) => r.rec.status === 'confirmed').length;
  const failed = batch.some((r) => r.rec.status === 'failed');
  const retrying = batch.some((r) => r.rec.status === 'retrying');
  const recentDone = batch.some((r) => r.rec.status === 'confirmed' && r.rec.confirmedAt !== null && now - r.rec.confirmedAt <= SYNC_DONE_MS);
  let phase: RoomSyncState['phase'] = 'idle';
  if (failed) phase = 'failed';
  else if (retrying) phase = 'retry';
  else if (pending.length && acked) phase = 'partial';
  else if (pending.length) phase = 'sending';
  else if (recentDone) phase = 'done';
  const reqId = batch.find((r) => r.rec.commandedAt === latest)?.rec.reqId ?? null;
  return { reqId, phase, acked, total: batch.length, attempt: Math.max(0, ...pending.map((r) => r.rec.attempts)), maxAttempts, valueC, what };
}

function chipOf(room: RoomConfig, p: RoomEval['partial'], i: RoomInternals, served: boolean, dewBlocked: boolean): RoomStateKind {
  if (!room.controlEnabled) return p.tempC === null ? 'error' : 'monitor';
  if (p.demand.frost) return 'frost';
  if (p.tempC === null) return 'error';
  const r = p.window.reactionActive ? p.window.reaction : null;
  if ((r !== null && r !== 'notify') || i.airing) return 'window';
  if (i.off !== null || i.houseOff) return 'off';
  if ((!p.activeModes.heat && !p.activeModes.cool) || dewBlocked) return 'monitor';
  if (p.demand.mode !== 'none' && !served) return 'wait';
  if (p.demand.mode === 'heat') return 'heat';
  if (p.demand.mode === 'cool') return 'cool';
  return 'hold';
}

/** The plant keeps this room out of floor cooling for the dew point on every cooling path it has. */
function dewBlockOf(cfg: EngineConfig, room: RoomConfig, p: RoomEval['partial'], plant: PlantState): { dewC: number | null; maxSupplyC: number } | null {
  if (p.activeModes.heat || !p.activeModes.cool) return null;
  const coolEmitters = (cfg.emittersByRoom[room.id] ?? []).filter((e) => e.enabled && e.roles.cool !== null && !e.excludeFromCooling);
  if (!coolEmitters.length || coolEmitters.some((e) => !e.circuitId)) return null;
  let found: { dewC: number | null; maxSupplyC: number } | null = null;
  for (const e of coolEmitters) {
    const cs = plant.circuits.find((c) => c.circuitId === e.circuitId);
    const ex = cs?.excludedRooms.find((x) => x.roomId === room.id);
    if (!cs || !ex || ex.reason !== 'dew') return null;
    found = { dewC: cs.dewPointMaxC, maxSupplyC: circuitById(cfg, e.circuitId)?.supply.coolMaxC ?? cfg.cool.dewMarginC };
  }
  return found;
}

export const finishRoom: FinishRoomFn = (cfg, evIn, verdict, plant, inputs, ledger) => {
  const ev = evIn as RoomEvalInternal;
  const now = inputs.now;
  const room = cfg.rooms.find((r) => r.id === ev.roomId);
  const p = ev.partial;
  const memory: RoomMemory = { ...ev.memory, valveIntegral: { ...ev.memory.valveIntegral }, updatedAt: now };
  const desired: DesiredActuator[] = [];
  const decisions: Decision[] = [];
  const detections: Detection[] = [];
  const demand = {
    ...p.demand,
    served: verdict.served,
    servingSourceIds: [...verdict.servingSourceIds],
    waitReason: p.demand.mode === 'none' || verdict.served ? null : verdict.waitReason,
  };

  if (!room) {
    // deleted while the tick ran: report it idle, actuate nothing
    const state: RoomState = {
      ...p,
      demand,
      state: 'monitor',
      tone: ROOM_STATE_STYLE.monitor.tone,
      trvs: [],
      emitters: [],
      issues: [],
      why: [{ code: 'why.monitor.control_disabled' }],
      sync: { reqId: null, phase: 'idle', acked: 0, total: 0, attempt: 0, maxAttempts: 3, valueC: null, what: 'none' },
      hvacAction: 'idle',
    };
    return { state, memory, desired, decisions, detections };
  }

  const i = internalsOf(ev, cfg, room);
  const emitters = [...(cfg.emittersByRoom[room.id] ?? [])].sort((a, b) => a.order - b.order);
  const dtMin = clamp(now - i.prevUpdatedAt, 0, MAX_DT_MS) / MIN_MS;
  const exercise = exercising(cfg, room, inputs, {
    season: i.season,
    idle: p.demand.mode === 'none' && !p.demand.latched.heat && !p.demand.frost,
    windowOpen: p.window.anyOpen || p.window.virtual,
    plant,
  });
  const blocked = i.windowPause || i.airing !== null || i.off !== null || i.overheat;

  const trvStates: TrvState[] = [];
  const zoneIds: string[] = [];
  const emitterStates: EmitterState[] = [];
  for (const e of emitters) {
    const req = ev.emitterRequests.find((r) => r.emitterId === e.id);
    const circuit = circuitById(cfg, e.circuitId);
    const heatOnly = !!circuit && !circuit.capabilities.cool;
    const requested = req?.mode ?? null;
    let open = verdict.emitterOpen[e.id] ?? requested !== null;
    if (heatOnly && verdict.heatOnlyBlocked) open = false;
    const feeding = verdict.emitterFeeding[e.id] ?? [];
    let sync: EmitterState['sync'] = null;

    for (const d of cfg.devicesByEmitter[e.id] ?? []) {
      if (!e.enabled) continue;
      if (d.kind === 'trv') {
        const out = trvActuation(d, open && requested === 'heat', inputs.entities, ledger, {
          room,
          safety: cfg.safety,
          now,
          t: p.tempC,
          fallbackTrv: p.aggregation.fallback === 'trv',
          heatC: p.target.heatC,
          heatAllowed: p.activeModes.heat && !(heatOnly && verdict.heatOnlyBlocked),
          frost: p.demand.frost && !(heatOnly && verdict.heatOnlyBlocked),
          frostFloorC: p.target.frostFloorC,
          blocked,
          overheat: i.overheat,
          exercise: exercise && !(heatOnly && verdict.heatOnlyBlocked),
          offsetOf: (id) => ev.memory.learned.trvOffsetC[id]?.value ?? null,
          valveIntegral: memory.valveIntegral,
          dtMin,
          reqId: i.reqId,
        });
        desired.push(...out.desired);
        trvStates.push(out.state);
        if (out.valveIntegral !== null) memory.valveIntegral[d.id] = out.valveIntegral;
      } else {
        const z = zoneActuation(d, { room, emitter: e, circuit, open, frost: p.demand.frost, heatOnlyBlocked: verdict.heatOnlyBlocked, floorLimit: i.floorLimit }, ledger);
        desired.push(z.desired);
        zoneIds.push(d.entityId);
        sync = z.sync;
      }
    }
    if (!sync && e.sourceId) {
      const s = sourceById(cfg, e.sourceId);
      const entity = s?.adapter.type === 'climate' ? s.adapter.climate : s?.adapter.type === 'relay' ? s.adapter.command : null;
      if (entity && ledger[entity]) {
        const rec = ledger[entity];
        sync = { status: rec.status, attempt: rec.attempts, maxAttempts: 3, commandId: rec.commandId, reqId: rec.reqId, sentAt: rec.commandedAt, confirmedAt: rec.confirmedAt };
      }
    }
    if (e.roles.heat === null && e.roles.cool === null) continue;
    emitterStates.push({
      emitterId: e.id,
      kind: e.kind,
      requested,
      open,
      pathActive: feeding.length > 0,
      feedingSourceIds: [...feeding],
      excluded: heatOnly && verdict.heatOnlyBlocked ? 'heat_only' : (req?.excluded ?? (e.enabled ? null : 'disabled')),
      sync,
    });
  }
  const dehum = dehumidifierActuation(room, memory.dehumidifier.on);
  if (dehum) desired.push(dehum);

  const dewBlocked = dewBlockOf(cfg, room, p, plant);
  const chip = chipOf(room, p, i, verdict.served, dewBlocked !== null);
  const tone: Tone = chip === 'wait' ? (p.demand.mode === 'cool' ? 'cool' : 'heat') : ROOM_STATE_STYLE[chip].tone;
  const base = { ...p, demand, trvs: trvStates, emitters: emitterStates };
  const issues = roomIssues({
    cfg,
    room,
    state: base,
    noDataSince: ev.memory.noDataSince,
    overheat: i.overheat,
    comfort: i.comfort,
    humidExcluded: i.modes.humidExcluded,
    season: i.season,
    coolCentral: plant.circuits.some((c) => c.mode === 'cool') || i.season === 'cooling',
    verdict,
    plant,
    ledger,
    trvs: trvStates,
    zoneEntityIds: zoneIds,
    prevIssues: inputs.prev.rooms[room.id]?.issues ?? [],
    entities: inputs.entities,
    haConnected: inputs.haConnected && !inputs.blind,
    toutC: i.toutC,
    now,
  });
  const why = roomWhy({
    cfg,
    room,
    state: { ...base, state: chip },
    memory,
    modes: i.modes,
    latchPos: i.latchPos,
    season: i.season,
    coldGuardOnly: i.coldGuardOnly,
    frostT: i.frostT,
    off: i.off,
    houseOff: i.houseOff,
    overheat: i.overheat,
    floorLimit: i.floorLimit,
    airing: i.airing,
    heldByMinRequest: i.heldByMinRequest,
    weatherShiftC: i.weatherShiftC,
    toutC: i.toutC,
    virtualDropC: i.virtualDropC,
    verdict,
    plant,
    trvs: trvStates,
    dewBlocked,
  });

  const acEntities = roomClimateSources(cfg, room.id).map((s) => (s.adapter as { climate: string }).climate);
  const sync = roomSync(
    trvStates.map((t) => t.entityId),
    acEntities,
    ledger,
    p.target.displayC ?? p.target.heatC ?? p.target.coolC,
    room.trv.ack.attempts,
    now,
  );

  const dryRunning = plant.sources.some((s) => s.on && s.mode === 'dry' && verdict.servingSourceIds.includes(s.sourceId));
  let hvacAction: RoomState['hvacAction'] = 'idle';
  if (room.controlEnabled) {
    if ((i.off !== null || i.houseOff) && !p.demand.frost) hvacAction = 'off';
    else if (verdict.served && (p.demand.mode === 'heat' || p.demand.frost)) hvacAction = p.target.display === 'preheat' ? 'preheating' : 'heating';
    else if (verdict.served && p.demand.mode === 'cool') hvacAction = 'cooling';
    else if (dryRunning) hvacAction = 'drying';
  }

  const state: RoomState = { ...base, state: chip, tone, issues, why, sync, hvacAction };
  return { state, memory, desired, decisions, detections };
};
