import type {
  ActuatorRecord,
  Circuit,
  Decision,
  EngineConfig,
  EpochMs,
  Id,
  InputSnapshot,
  ModeOrNone,
  Pump,
  PumpMemory,
  PumpReason,
  PumpRule,
  PumpState,
  PumpStateKind,
  ReasonParams,
  RuleOverlay,
  SpanEvent,
} from '../../shared/model';
import { defaultPumpMemory } from '../../shared/defaults';
import { snapOf } from './conditions';
import type { EnergyPhase } from './energy';
import { fromLocal, hhmmToMinute, toLocal } from './time';

/* =====================================================================================================
 * Circulation pumps. Each pump follows its circuit's mode — follow_source (runs with a feeding source, the
 * old «насос з котлом» automation) or zoned (runs while a member room's zone is open) — and keeps running
 * for its run-on («вибіг») after that falls: floor 10 min, radiators 3 min. Safety forces a
 * pump on regardless: frost in a member room, flow through a running boiler or heat pump, a source held
 * by its minimum run, the pre-run before a start. Chilled water never reaches radiators.
 * ===================================================================================================== */

const SEC = 1000;
const MIN_MS = 60_000;
const DAY_MS = 86_400_000;
/** A duty pump unavailable this long hands over to the next one. */
const DUTY_FAILOVER_MS = 60 * SEC;
/** The weekly exercise may start within this window after its scheduled time (ticks may be missed). */
const EXERCISE_WINDOW_MS = 10 * MIN_MS;
/** Circulation kept after a dew-guard stop so the cold water warms up instead of standing in the floor. */
const DEW_RUN_ON_MS = 2 * MIN_MS;

/** What the circuit needs from its pumps this tick, decided by the sources and rooms. */
export interface CircuitFlow {
  circuit: Circuit;
  /** Loop mode: a feeding source runs in heat or cool (or frost heat). */
  mode: ModeOrNone;
  /** A member room has an emitter open for the loop mode. */
  openDemand: boolean;
  /** A feeding source runs in a mode the circuit supports. */
  feedingOn: boolean;
  /** Heat-only circuit while a feeding source cools: pumps off, zones closed. */
  heatOnlyBlocked: boolean;
  /** A member room is in frost protection. */
  frost: boolean;
  /** Forced flow for a source: flow safety, minimum-run hold, pre-run, check run (in priority order). */
  forced: { reason: Extract<PumpReason, 'flow_safety' | 'source_hold' | 'prerun' | 'test'>; sourceId: Id } | null;
  /** The hard dew guard stopped cooling on this tick: keep circulating to warm the water. */
  dewTripped: boolean;
  /** A feeding source runs in cool (no exercise of radiators or pumps meanwhile). */
  coolingFeed: boolean;
}

export interface PumpStepInput {
  cfg: EngineConfig;
  inputs: InputSnapshot;
  now: EpochMs;
  prevTickAt: EpochMs;
  memory: Record<Id, PumpMemory>;
  flows: Map<Id, CircuitFlow>;
  circuitPumps: Map<Id, Pump[]>;
  manifoldPumps: Map<Id, Pump[]>;
  /** manifoldId → a source feeding it (or one of its circuits) runs. */
  manifoldFeedOn: Map<Id, boolean>;
  /** manifoldId → its primary pump moves the water of a source that is about to start (pre-run). */
  manifoldForced?: Map<Id, NonNullable<CircuitFlow['forced']>>;
  phase: EnergyPhase;
  overlay: RuleOverlay;
  ledger: Record<string, ActuatorRecord>;
}

export interface PumpOutcome {
  pump: Pump;
  on: boolean;
  reason: PumpReason | null;
  state: PumpStateKind;
  mode: ModeOrNone;
}

export interface PumpStepResult {
  memory: Record<Id, PumpMemory>;
  outcomes: Map<Id, PumpOutcome>;
  states: Map<Id, PumpState>;
  decisions: Decision[];
  spans: SpanEvent[];
  edges: { type: 'pump'; id: Id; on: boolean }[];
  wakes: EpochMs[];
}

const FORCED: readonly PumpReason[] = ['frost', 'flow_safety', 'source_hold', 'prerun', 'dew_runon', 'test'];

function unavailableFor(inputs: InputSnapshot, entityId: string, now: EpochMs): number {
  const snap = snapOf(inputs, entityId);
  if (!snap) return Number.POSITIVE_INFINITY;
  if (snap.available) return 0;
  return now - snap.lastChanged;
}

/** Start of this week's exercise slot, when today is its day. */
function exerciseSlot(cfg: EngineConfig, inputs: InputSnapshot): EpochMs | null {
  const ex = cfg.safety.pumpExercise;
  if (!ex.enabled) return null;
  const lt = toLocal(inputs.now, inputs.tz);
  if (lt.dow !== ex.dow) return null;
  try {
    return fromLocal(lt.date, hhmmToMinute(ex.time), inputs.tz);
  } catch {
    return null;
  }
}

function syncOf(rec: ActuatorRecord | undefined): PumpState['sync'] {
  return {
    status: rec?.status ?? 'idle',
    attempt: rec?.attempts ?? 0,
    maxAttempts: 3,
    commandId: rec?.commandId ?? null,
    reqId: rec?.reqId ?? null,
    sentAt: rec?.commandedAt ?? null,
    confirmedAt: rec?.confirmedAt ?? null,
  };
}

interface PumpPlan {
  cond: boolean;
  /** Runs while this holds, without a run-on of its own (a primary pump following its circuit pumps). */
  follow?: boolean;
  /** Forced reason (overrides the rule). */
  forced: PumpReason | null;
  /** Pump may run in its group (duty/standby) this tick. */
  inGroup: boolean;
  /** Forced off (chilled water at radiators, critical battery). */
  blockedOff: boolean;
  /** The weekly anti-seize run may happen (not while the loop carries chilled water). */
  exerciseAllowed: boolean;
  runOnMin: (mode: ModeOrNone) => number;
  mode: ModeOrNone;
  ruleReason: PumpReason;
}

export function stepPumps(x: PumpStepInput): PumpStepResult {
  const { cfg, inputs, now } = x;
  const memory: Record<Id, PumpMemory> = {};
  const outcomes = new Map<Id, PumpOutcome>();
  const states = new Map<Id, PumpState>();
  const decisions: Decision[] = [];
  const spans: SpanEvent[] = [];
  const edges: PumpStepResult['edges'] = [];
  const wakes: EpochMs[] = [];
  const slot = exerciseSlot(cfg, inputs);
  const quietPhase = x.phase === 'economy' || x.phase === 'critical' || x.overlay.pumpsDemandOnly;

  // memory as this step amends it before a pump is run (duty rotation, dew run-on)
  const base: Record<Id, PumpMemory> = { ...x.memory };
  const mem = (p: Pump): PumpMemory => base[p.id] ?? defaultPumpMemory(p.id, now);

  /** Run one pump through rule → run-on → forced → min-on, updating its memory. */
  const runPump = (p: Pump, plan: PumpPlan, circuitId: Id | null, manifoldId: Id | null) => {
    const prev = mem(p);
    let m: PumpMemory = { ...prev };

    // weekly anti-seize run for a pump that has stood still for a day
    if (p.exercise && slot !== null && !quietPhase && plan.exerciseAllowed && !plan.blockedOff && now >= slot && now < slot + EXERCISE_WINDOW_MS) {
      const idle = !prev.on && (prev.offSince === null || now - prev.offSince >= DAY_MS);
      if (idle && (prev.lastExerciseAt === null || prev.lastExerciseAt < slot)) {
        m = { ...m, lastExerciseAt: now, exerciseUntil: now + cfg.safety.pumpExercise.durationSec * SEC };
        decisions.push({ code: 'pump.exercise', category: 'src', tone: 'idle', params: { durationSec: cfg.safety.pumpExercise.durationSec }, entityIds: [p.entityId] });
      }
    }

    // run-on anchor: the moment the rule condition fell (re-arming clears it; run-on never stacks)
    if (plan.cond) m = { ...m, condSince: m.condSince ?? now, condFellAt: null, runOnMode: plan.mode !== 'none' ? plan.mode : m.runOnMode };
    else if (m.condSince !== null) m = { ...m, condSince: null, condFellAt: now };
    const runOnMin = m.condFellAt !== null ? plan.runOnMin(m.runOnMode) : 0;
    const runOnUntil = m.condFellAt !== null && runOnMin > 0 ? m.condFellAt + runOnMin * MIN_MS : null;
    m = { ...m, runOnUntil };
    if (m.dewRunOnUntil !== null && m.dewRunOnUntil <= now) m = { ...m, dewRunOnUntil: null };

    let reason: PumpReason | null = null;
    let state: PumpStateKind = 'off';
    if (plan.blockedOff) state = 'blocked';
    else if (plan.forced) {
      reason = plan.forced;
      state = 'forced';
    } else if (m.dewRunOnUntil !== null && now < m.dewRunOnUntil) {
      reason = 'dew_runon';
      state = 'forced';
    } else if (m.exerciseUntil !== null && now < m.exerciseUntil && !quietPhase) {
      reason = 'exercise';
      state = 'exercise';
    } else if ((plan.cond || plan.follow) && plan.inGroup) {
      reason = plan.ruleReason;
      state = 'running';
    } else if (runOnUntil !== null && now < runOnUntil && plan.inGroup && prev.on) {
      reason = 'run_on';
      state = 'run_on';
    } else if (prev.on && prev.onSince !== null && now - prev.onSince < p.minOnSec * SEC) {
      // a pump just switched on is not switched off again within its minimum on time
      reason = prev.reason;
      state = prev.reason === 'run_on' ? 'run_on' : 'running';
    }
    const on = reason !== null;
    if (m.exerciseUntil !== null && now >= m.exerciseUntil) m = { ...m, exerciseUntil: null };

    if (on !== prev.on) {
      edges.push({ type: 'pump', id: p.id, on });
      if (on) {
        m = { ...m, on: true, onSince: now };
        spans.push({ subject: 'pump', subjectId: p.id, kind: 'run', mode: plan.mode === 'none' ? null : plan.mode, edge: 'start', at: now, meta: { reason: reason ?? undefined } });
        const params: ReasonParams = reason === 'flow_safety' ? { sourceId: circuitId ? (x.flows.get(circuitId)?.forced?.sourceId ?? null) : null } : { reason };
        decisions.push({ code: reason === 'flow_safety' ? 'pump.flow_safety' : 'pump.on', category: 'src', tone: 'idle', params, entityIds: [p.entityId] });
      } else {
        m = { ...m, on: false, offSince: now };
        spans.push({ subject: 'pump', subjectId: p.id, kind: 'run', mode: null, edge: 'end', at: now });
        decisions.push({ code: 'pump.off', category: 'src', tone: 'idle', params: {}, entityIds: [p.entityId] });
      }
    }
    const wasRunOn = prev.on && prev.reason === 'run_on';
    const isRunOn = on && reason === 'run_on';
    if (isRunOn && !wasRunOn) {
      spans.push({ subject: 'pump', subjectId: p.id, kind: 'run_on', mode: null, edge: 'start', at: now });
      decisions.push({ code: 'pump.run_on', category: 'src', tone: 'idle', params: { until: runOnUntil }, entityIds: [p.entityId] });
    } else if (wasRunOn && !isRunOn) spans.push({ subject: 'pump', subjectId: p.id, kind: 'run_on', mode: null, edge: 'end', at: now });
    m = { ...m, reason: on ? reason : null, updatedAt: now };
    memory[p.id] = m;

    for (const t of [runOnUntil, m.dewRunOnUntil, m.exerciseUntil, on && m.onSince !== null ? m.onSince + p.minOnSec * SEC : null]) if (t !== null && t > now) wakes.push(t);
    const available = unavailableFor(inputs, p.entityId, now) === 0;
    outcomes.set(p.id, { pump: p, on, reason: on ? reason : null, state: available ? state : 'unavailable', mode: plan.mode });
    states.set(p.id, {
      pumpId: p.id,
      circuitId,
      manifoldId,
      state: available ? state : 'unavailable',
      on,
      reason: on ? reason : null,
      runOnUntil: state === 'run_on' ? runOnUntil : null,
      since: on ? m.onSince : m.offSince,
      available,
      todayRuntimeMin: 0,
      sync: syncOf(x.ledger[p.entityId]),
    });
  };

  /* circuit pumps */
  for (const [circuitId, pumps] of x.circuitPumps) {
    const flow = x.flows.get(circuitId);
    if (!flow || !pumps.length) continue;
    const c = flow.circuit;
    const lead = mem(pumps[0]);

    // duty/standby: one pump runs, rotated at the weekly exercise; an unavailable duty pump hands over
    let duty: Pump | null = null;
    if (c.pumpGroupMode === 'duty_standby') {
      let dutyIndex = lead.dutyIndex % pumps.length;
      if (slot !== null && x.prevTickAt < slot && slot <= now) dutyIndex = (dutyIndex + 1) % pumps.length;
      const nominal = pumps[dutyIndex];
      duty = nominal;
      if (unavailableFor(inputs, nominal.entityId, now) > DUTY_FAILOVER_MS) {
        for (let i = 1; i < pumps.length; i++) {
          const cand = pumps[(dutyIndex + i) % pumps.length];
          if (unavailableFor(inputs, cand.entityId, now) === 0) {
            duty = cand;
            if (!mem(cand).on) decisions.push({ code: 'pump.duty_switch', category: 'src', tone: 'warn', params: { from: nominal.id, to: cand.id }, entityIds: [nominal.entityId, cand.entityId] });
            break;
          }
        }
      }
      base[pumps[0].id] = { ...lead, dutyIndex };
    }

    const demandOnly = x.overlay.pumpsDemandOnly;
    // the circuit's mode decides; zoned pumps are shared by every open zone (on with the first, off after the last)
    const circuitRule: PumpRule = demandOnly || c.mode !== 'follow_source' ? 'rooms' : 'source';
    for (const p of pumps) {
      const rule = circuitRule;
      const sourceCond = flow.feedingOn;
      const roomsCond = flow.openDemand && (flow.feedingOn || flow.frost);
      const cond = rule === 'source' ? sourceCond : rule === 'rooms' ? roomsCond : sourceCond && roomsCond;
      const inGroup = duty === null || duty.id === p.id;
      let forced: PumpReason | null = null;
      if (flow.frost) forced = 'frost';
      else if (flow.forced && inGroup) forced = flow.forced.reason;
      if (flow.dewTripped && inGroup) base[p.id] = { ...mem(p), dewRunOnUntil: now + DEW_RUN_ON_MS };
      const critical = x.phase === 'critical';
      runPump(
        p,
        {
          cond: cond && !critical,
          forced: critical && forced !== 'frost' ? null : forced,
          inGroup,
          blockedOff: flow.heatOnlyBlocked && !flow.frost,
          exerciseAllowed: !flow.coolingFeed,
          runOnMin: (mode) => (demandOnly ? 0 : mode === 'cool' ? p.runOnCoolMin : p.runOnHeatMin),
          mode: flow.mode,
          ruleReason: rule,
        },
        circuitId,
        null,
      );
    }
  }

  /*
   * manifold primary pumps: on while any source feeding the manifold runs (then for its own run-on, or the
   * longest of its circuits' when that is longer), while any of its circuit pumps runs, and through a
   * feeding source's pre-run
   */
  for (const [manifoldId, pumps] of x.manifoldPumps) {
    const circuits = [...x.flows.values()].filter((f) => f.circuit.manifoldId === manifoldId);
    const circuitPumpOn = circuits.some((f) => (x.circuitPumps.get(f.circuit.id) ?? []).some((p) => outcomes.get(p.id)?.on));
    const feedOn = x.manifoldFeedOn.get(manifoldId) ?? false;
    const mode: ModeOrNone = circuits.find((f) => f.mode !== 'none')?.mode ?? 'none';
    const runOns = circuits.flatMap((f) => x.circuitPumps.get(f.circuit.id) ?? []);
    const frost = circuits.some((f) => f.frost);
    const forced = x.phase === 'critical' ? null : (x.manifoldForced?.get(manifoldId)?.reason ?? null);
    for (const p of pumps) {
      runPump(
        p,
        {
          cond: feedOn && (x.phase !== 'critical' || frost),
          follow: circuitPumpOn,
          forced,
          inGroup: true,
          blockedOff: false,
          exerciseAllowed: !circuits.some((f) => f.coolingFeed),
          runOnMin: (md) => Math.max(md === 'cool' ? p.runOnCoolMin : p.runOnHeatMin, ...runOns.map((cp) => (md === 'cool' ? cp.runOnCoolMin : cp.runOnHeatMin))),
          mode,
          ruleReason: 'manifold',
        },
        null,
        manifoldId,
      );
    }
  }

  // carry rows of pumps not stepped (disabled pumps keep their memory, switched off)
  for (const p of cfg.pumps) {
    if (memory[p.id]) continue;
    const prev = base[p.id];
    if (!prev) continue;
    if (prev.on) {
      edges.push({ type: 'pump', id: p.id, on: false });
      spans.push({ subject: 'pump', subjectId: p.id, kind: 'run', mode: null, edge: 'end', at: now });
    }
    memory[p.id] = { ...prev, on: false, reason: null, offSince: prev.on ? now : prev.offSince, updatedAt: now };
  }
  for (const [id, m] of Object.entries(base)) if (!memory[id] && cfg.pumps.some((p) => p.id === id)) memory[id] = m;

  return { memory, outcomes, states, decisions, spans, edges, wakes };
}

export const isForcedReason = (r: PumpReason | null): boolean => r !== null && FORCED.includes(r);
