import type {
  Decision,
  Detection,
  EngineConfig,
  EngineMemory,
  EpochMs,
  EvaluateFn,
  EvaluateResult,
  Id,
  RoomContext,
  RoomEval,
  RoomServiceVerdict,
  RoomState,
  SpanEvent,
} from '../../shared/model';
import type { EmaMap } from './aggregate';
import { plantStep } from './plant';
import { evaluateRoom, finishRoom, nextEma } from './room';
import { evaluateTriggers } from './rules';
import { stepSeason } from './season';
import { resolveHouseProfile } from './targets';

/* =====================================================================================================
 * One evaluation of the whole house, from inputs to the desired value of every actuator. Season first
 * (it gates everything), then triggers and rules (they adjust targets and pick sources), the house
 * profile, every room's request, the plant's answer to all of them, and finally each room's chip,
 * radiator heads and explanation from that answer. Pure: live control, previews, «Що якщо», the
 * simulator's pre-roll and the tests all call this same function.
 * ===================================================================================================== */

const MIN_MS = 60_000;
/** Smoothing state of a sensor that stopped reporting is dropped after this (it restarts fresh anyway). */
const EMA_KEEP_MS = 60 * MIN_MS;

/** What a room gets when the plant has nothing to say about it (no emitters on any circuit or source). */
function idleVerdict(roomId: Id): RoomServiceVerdict {
  return { roomId, served: false, servingSourceIds: [], waitReason: null, emitterOpen: {}, emitterFeeding: {}, heatOnlyBlocked: false };
}

/** This tick's smoothing state on top of the previous one; entries of silent sensors age out. */
function mergeEma(prev: EmaMap, next: EmaMap, now: EpochMs): EmaMap {
  const out: EmaMap = {};
  for (const [id, e] of Object.entries(prev)) if (now - e.at < EMA_KEEP_MS && e.at <= now) out[id] = e;
  return Object.assign(out, next);
}

/**
 * The earliest moment something flips without new input: a window reaction or resume, a minimum request
 * running out, a target or override ending, a schedule block boundary, a time trigger, a plant timer.
 */
function nextWake(cfg: EngineConfig, rooms: readonly RoomState[], result: Pick<EvaluateResult, 'houseProfile' | 'plant'>, plantWake: EpochMs | null, now: EpochMs): EpochMs | null {
  let best = plantWake !== null && plantWake > now ? plantWake : null;
  const add = (t: EpochMs | null | undefined) => {
    if (typeof t === 'number' && Number.isFinite(t) && t > now && (best === null || t < best)) best = t;
  };
  for (const r of rooms) {
    add(r.window.reactionAt);
    add(r.window.resumeAt);
    add(r.window.ignoredUntil);
    add(r.demand.minRequestUntil);
    add(r.target.until);
    add(r.target.next?.at);
  }
  for (const o of cfg.overrides) add(o.until);
  add(result.houseProfile.scheduledUntil);
  for (const t of result.plant.triggers) add(t.nextChangeAt);
  return best;
}

export const evaluate: EvaluateFn = (cfg, inputs, memory, ledger) => {
  const now = inputs.now;
  const prevPlant = inputs.prev.plant;

  // 1. the season and its gates
  const season = stepSeason(cfg, inputs, memory.season);
  const afterSeason: EngineMemory = { ...memory, season: season.memory };

  // 2. triggers and rules, on the previous tick's rooms and plant (conditions see a settled house)
  const trig = evaluateTriggers(cfg, inputs, afterSeason, prevPlant, inputs.prev.rooms);
  const afterTriggers: EngineMemory = { ...afterSeason, conditions: trig.conditions };

  // 3. the house profile
  const house = resolveHouseProfile(cfg, inputs, afterTriggers);

  // 4. what every room asks for
  const ctx: RoomContext = { season: season.state, house: house.state, overlay: trig.overlay, prevPlant };
  const evals: RoomEval[] = cfg.rooms.map((room) => evaluateRoom(cfg, room, inputs, afterTriggers, ctx));

  // 5. the plant's answer: sources, pumps, mixing valves and a verdict per room
  const plantOut = plantStep(
    cfg,
    evals,
    { season: season.state, overlay: trig.overlay, triggers: trig.triggers, rules: trig.rules, energyActive: trig.energyActive, prevPlant },
    inputs,
    afterTriggers,
    ledger,
  );

  // 6. each room from the verdict; the plant's room memory carries the heat-pump lag and AC correction
  const verdicts = new Map(plantOut.verdicts.map((v) => [v.roomId, v]));
  const roomMemory = { ...plantOut.memory.rooms };
  const rooms: RoomState[] = [];
  const desired = [...plantOut.desired];
  const roomDecisions: Decision[] = [];
  const roomDetections: Detection[] = [];
  const roomSpans: SpanEvent[] = [];
  for (const ev of evals) {
    roomDecisions.push(...ev.decisions);
    roomDetections.push(...ev.detections);
    roomSpans.push(...ev.spans);
    // spread keeps the evaluation's own (symbol-keyed) context the second half reads
    const withPlantMemory: RoomEval = { ...ev, memory: plantOut.memory.rooms[ev.roomId] ?? ev.memory };
    const fin = finishRoom(cfg, withPlantMemory, verdicts.get(ev.roomId) ?? idleVerdict(ev.roomId), plantOut.plant, inputs, ledger);
    rooms.push(fin.state);
    roomMemory[ev.roomId] = fin.memory;
    desired.push(...fin.desired);
    roomDecisions.push(...fin.decisions);
    roomDetections.push(...fin.detections);
  }

  // 7. one result
  const nextMemory: EngineMemory = { ...plantOut.memory, rooms: roomMemory, ema: mergeEma(memory.ema, nextEma(evals, now), now) };
  const partial = { houseProfile: house.state, plant: plantOut.plant };
  return {
    memory: nextMemory,
    rooms,
    plant: plantOut.plant,
    season: season.state,
    houseProfile: house.state,
    desired,
    decisions: [...season.decisions, ...trig.decisions, ...house.decisions, ...roomDecisions, ...plantOut.decisions],
    detections: [...season.detections, ...trig.detections, ...house.detections, ...roomDetections, ...plantOut.detections],
    spans: [...trig.spans, ...house.spans, ...roomSpans, ...plantOut.spans],
    expiredOverrideIds: cfg.overrides.filter((o) => o.until !== null && o.until <= now).map((o) => o.id),
    edges: plantOut.edges,
    nextWakeAt: nextWake(cfg, rooms, partial, plantOut.nextWakeAt, now),
  };
};
