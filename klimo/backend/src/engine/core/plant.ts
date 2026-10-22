import type {
  ActuatorRecord,
  Circuit,
  CircuitState,
  ConditionMemory,
  Decision,
  DesiredActuator,
  Detection,
  EnergyState,
  EngineConfig,
  EngineMemory,
  EpochMs,
  EvaluateResult,
  Id,
  InputSnapshot,
  Mode,
  ModeOrNone,
  PlantMemory,
  PlantState,
  PlantStepFn,
  PumpState,
  Reason,
  RoomEval,
  RoomMemory,
  RoomServiceVerdict,
  SourceBinding,
  SourceConfig,
  SourceMemory,
  SourceMode,
  SourceRole,
  SourceState,
  SourceStateKind,
  SpanEvent,
  Tone,
  TriggerState,
  Urgency,
} from '../../shared/model';
import { defaultSourceMemory } from '../../shared/defaults';
import { acDesired } from './ac';
import { mixingDesired, pumpDesired, sourceDesired } from './actuation';
import { stepLag, stepPlantLatches, type LagCandidate } from './bivalence';
import { numOf, snapOf, type PlantConditionCtx } from './conditions';
import { deviceError, powerW, stepSourceHealth, type HealthResult } from './confirm';
import { flowFromCurve } from './curves';
import {
  countsInBudget,
  effectiveBudget,
  energyNote,
  energyPhase,
  exemptActive,
  isEmergency,
  kwOf,
  nominalKw,
  readEnergy,
  round2,
  runningKw,
  shedOrderOf,
  shedStep,
} from './energy';
import { blockTest, expiredLocks, finishTest, minOffUntil, minRunUntil, recentStarts, stepSource, stepStages, testPhase } from './guards';
import { stepPumps, type CircuitFlow, type PumpStepInput } from './pumps';
import {
  activeLock,
  eligibility,
  evalSourceConditions,
  firstTrigger,
  indexPlant,
  selectSources,
  sourceHasPumps,
  stepOutdoorLimit,
  type CircuitPlan,
  type ConditionItemResult,
  type PlantIndex,
  type RoomView,
  type Selection,
  type SelectionCtx,
  type SourceWant,
} from './selection';
import { fromLocal, hhmmToMinute, toLocal } from './time';
import { clamp } from './util';

/* =====================================================================================================
 * The plant step: from what every room asks to what every boiler, heat pump, AC, heater, pump and valve
 * should do this tick, and back to each room: who serves it, or why it waits. Pure — the same function
 * drives the house, the previews, «Що якщо» and the tests.
 * ===================================================================================================== */

const SEC = 1000;
const MIN_MS = 60_000;
/** Longest gap treated as one interval (runtime counters, paused timers). */
const MAX_DT_MS = 10 * MIN_MS;
/** A heating supply this cold for this long while a source runs means the water itself may freeze. */
const SUPPLY_FROST_HOLD_MS = 10 * MIN_MS;
const SUPPLY_FROST_KEY = (circuitId: Id) => `frost:${circuitId}`;
/** A disabled source or pump is told OFF this long after it stopped, then left to whoever uses it now. */
const DISABLED_OFF_MS = 5 * MIN_MS;

type Want = SourceWant;

/* ── small helpers ─────────────────────────────────────────────────────────────────────────────── */

const isHeatCool = (m: SourceMode | null): m is Mode => m === 'heat' || m === 'cool';

/** Global heat chain: a heat pump first and a single second source make a bivalent pair. */
function chainPair(cfg: EngineConfig, source: Map<Id, SourceConfig>): { hpId: Id; reserveId: Id } | null {
  const entries = cfg.heat.chain.filter((e) => e.enabled && e.sourceIds.length > 0);
  const e0 = entries[0];
  const e1 = entries[1];
  if (!e0 || !e1 || e0.sourceIds.length !== 1 || e1.sourceIds.length !== 1) return null;
  const hp = source.get(e0.sourceIds[0]);
  return hp && hp.kind === 'heat_pump' ? { hpId: hp.id, reserveId: e1.sourceIds[0] } : null;
}

/** Minutes a thing ran today (local day), carried from the previous tick. */
function runtimeToday(prevMin: number | undefined, on: boolean, prevTickAt: EpochMs, now: EpochMs, tz: string, dtMs: number): number {
  const sameDay = toLocal(prevTickAt, tz).date === toLocal(now, tz).date;
  const base = sameDay ? (prevMin ?? 0) : 0;
  // across midnight only the part after 00:00 counts for the new day
  const add = on ? (sameDay ? dtMs : Math.min(dtMs, toLocal(now, tz).minute * MIN_MS)) / MIN_MS : 0;
  return Math.round((base + add) * 10) / 10;
}

function toneOfState(state: SourceStateKind, mode: SourceMode | null): Tone {
  switch (state) {
    case 'heating':
      return 'heat';
    case 'cooling':
    case 'drying':
    case 'fan':
      return 'cool';
    case 'starting':
    case 'stopping':
      return mode === 'heat' ? 'heat' : 'cool';
    case 'defrost':
    case 'waiting_trigger':
    case 'waiting_guard':
    case 'testing':
      return 'wait';
    case 'paused':
    case 'disabled':
      return 'off';
    case 'fault':
    case 'unavailable':
      return 'err';
    default:
      return 'idle';
  }
}

/** A source blocker turned into the room's «чекає…» reason. */
function waitFrom(b: Reason, sourceId: Id, mode: Mode): Reason {
  const p = b.params ?? {};
  switch (b.code) {
    case 'source.blocked.min_off':
      return { code: 'wait.min_off', params: { sourceId, until: p.until ?? null } };
    case 'source.blocked.max_starts':
      return { code: 'wait.max_starts', params: { sourceId, until: p.until ?? null } };
    case 'source.blocked.budget':
      return { code: 'wait.budget', params: { sourceId, usedKw: p.usedKw ?? null, budgetKw: p.budgetKw ?? null } };
    case 'source.blocked.stagger':
      return { code: 'wait.stagger', params: { sourceId, until: p.until ?? null } };
    case 'source.blocked.prerun':
      return { code: 'wait.prerun', params: { sourceId, until: p.until ?? null } };
    case 'source.blocked.changeover':
      return { code: 'wait.changeover', params: { sourceId, until: p.until ?? null } };
    case 'source.blocked.lock':
      return { code: 'wait.lock', params: { sourceId, until: p.until ?? null } };
    case 'source.blocked.trigger':
      return { code: 'wait.trigger', params: { sourceId, triggerId: p.triggerId ?? null } };
    case 'source.blocked.condition':
      return { code: 'wait.condition', params: { sourceId, itemId: p.itemId ?? null } };
    case 'source.blocked.season':
    case 'source.blocked.cutoff':
      return { code: 'wait.season', params: { mode } };
    case 'source.blocked.fault':
    case 'source.blocked.unavailable':
    case 'source.blocked.conflict':
      return { code: 'wait.fault', params: { sourceId } };
    case 'source.blocked.disabled':
      return { code: 'wait.no_source', params: { mode } };
    default:
      return { code: 'wait.condition', params: { sourceId, itemId: null } };
  }
}

const BINDING_DOMAINS: Record<string, readonly string[]> = {
  command: ['switch', 'input_boolean', 'light', 'valve', 'fan'],
  climate: ['climate'],
  enable: ['switch', 'input_boolean'],
  flow: ['number', 'input_number'],
  watchdog: ['number', 'input_number'],
};

/** The source's HA bindings with their live state («на зв’язку» / «оберіть»). */
function bindingsOf(s: SourceConfig, inputs: InputSnapshot): SourceBinding[] {
  const rows: [string, string | null, boolean][] = [];
  const a = s.adapter;
  const confirmEntity = a.confirm.kind === 'entity_on' || a.confirm.kind === 'power_above' || a.confirm.kind === 'state_in' ? a.confirm.entityId || null : null;
  switch (a.type) {
    case 'relay':
      rows.push(['command', a.command, true]);
      a.stages.forEach((st, i) => rows.push([`stage${i + 2}`, st.entityId, true]));
      if (a.watchdog.kind === 'countdown_number') rows.push(['watchdog', a.watchdog.entityId, false]);
      if (a.flowSetpoint) rows.push(['flow', a.flowSetpoint.entityId, false]);
      break;
    case 'climate':
      rows.push(['climate', a.climate, true], ['defrost', a.defrostEntityId, false], ['error', a.errorEntityId, false], ['cop', a.copEntityId, false], ['supply', a.supplyTempEntityId, false]);
      break;
    case 'flow':
      rows.push(['enable', a.enable, true], ['flow', a.flowSetpoint, true], ['supply', a.actualFlow, true]);
      if (a.modeSelect) rows.push(['mode', a.modeSelect.entityId, false]);
      break;
    case 'script':
      for (const [mode, id] of Object.entries(a.on)) if (id) rows.push([`on_${mode}`, id, false]);
      rows.push(['off', a.off, true]);
      break;
    case 'custom':
      break;
  }
  if (confirmEntity !== null || (a.confirm.kind !== 'none' && a.confirm.kind !== 'readback' && a.confirm.kind !== 'hvac_action')) rows.push(['confirm', confirmEntity, true]);
  if (s.energy.powerEntityId) rows.push(['power', s.energy.powerEntityId, false]);
  return rows
    .filter(([, id, required]) => id !== null || required)
    .map(([role, entityId, required]) => {
      if (!entityId) return { role, entityId: null, required, live: null, status: 'unset' as const };
      const snap = inputs.entities[entityId];
      const domains = BINDING_DOMAINS[role];
      const wrong = !!domains && !domains.includes(entityId.split('.')[0]);
      const unit = snap?.attrs.unit_of_measurement;
      const live = snap ? `${snap.state}${typeof unit === 'string' && snap.available ? ` ${unit}` : ''}` : null;
      const status: SourceBinding['status'] = wrong ? 'wrong_domain' : !snap ? 'missing' : !snap.available ? 'unavailable' : 'ok';
      return { role, entityId, required, live, status };
    });
}

/* ── one tick, in phases ───────────────────────────────────────────────────────────────────────── */

type PlantCtx = Parameters<PlantStepFn>[2];

/** What every phase of one tick reads, and the events they all add to. */
interface Tick {
  cfg: EngineConfig;
  ctx: PlantCtx;
  inputs: InputSnapshot;
  memory: EngineMemory;
  ledger: Record<string, ActuatorRecord>;
  now: EpochMs;
  prevTickAt: EpochMs;
  dtMs: number;
  idx: PlantIndex;
  triggers: Record<Id, TriggerState>;
  /** Source memory as this tick changes it. */
  mem: Record<Id, SourceMemory>;
  plantMem: PlantMemory;
  health: Record<Id, HealthResult>;
  pair: { hpId: Id; reserveId: Id } | null;
  tout10: number | null;
  /** Outdoor value for the weather curve: the 10-minute mean, else the last known. */
  toutForCurve: number | null;
  outdoorUnknownLong: boolean;
  decisions: Decision[];
  detections: Detection[];
  spans: SpanEvent[];
  edges: EvaluateResult['edges'];
  desired: DesiredActuator[];
  wakes: EpochMs[];
}

interface EnergyCtx {
  readings: ReturnType<typeof readEnergy>;
  phase: ReturnType<typeof energyPhase>;
  budgeted: (s: SourceConfig) => boolean;
  /** Klimo's budgeted load, growing as starts are admitted this tick. */
  loadKw: number;
  budgetKw: number;
  fits: (s: SourceConfig) => Reason | null;
}

interface Plan {
  wants: Map<Id, Want>;
  safetyStops: Map<Id, string>;
  tests: Map<Id, ReturnType<typeof testPhase>>;
}

interface GuardOutcome {
  blockers: Map<Id, Reason[]>;
  held: Set<Id>;
  prerunning: Set<Id>;
}

interface CircuitFacts {
  mode: Map<Id, ModeOrNone>;
  heatOnlyBlocked: Map<Id, boolean>;
  emitterOpen: Record<Id, boolean>;
  emitterFeeding: Record<Id, Id[]>;
}

const runningIn = (t: Tick, id: Id, mode: Mode) => t.mem[id]?.on === true && t.mem[id]?.mode === mode;

/** Source memory rows, plant latches, and the health of every source (faults fail over this tick). */
function healthPhase(t: Tick): void {
  const { cfg, memory, now } = t;
  for (const s of cfg.sources) t.mem[s.id] = memory.sources[s.id] ?? defaultSourceMemory(s.id, now);
  for (const [id, m] of Object.entries(memory.sources)) {
    // a source deleted while running closes its run
    if (t.idx.source.has(id) || !m.on) continue;
    t.spans.push({ subject: 'source', subjectId: id, kind: 'run', mode: m.mode, edge: 'end', at: now, meta: { reason: 'deleted' } });
    t.edges.push({ type: 'source', id, on: false });
  }

  const latches = stepPlantLatches(cfg, memory.plant, t.inputs, t.pair ? { mode: cfg.heat.bivalence.mode, hpId: t.pair.hpId } : null);
  t.decisions.push(...latches.decisions);
  t.plantMem = latches.plant;
  t.tout10 = latches.tout10;
  t.toutForCurve = latches.tout10 ?? latches.plant.outdoorLast?.valueC ?? null;
  t.outdoorUnknownLong = latches.outdoorUnknownLong;

  for (const s of cfg.sources) {
    const h = stepSourceHealth(s, t.mem[s.id], { inputs: t.inputs, ledger: t.ledger, now, dtMs: t.dtMs, blind: t.inputs.blind });
    t.health[s.id] = h;
    t.decisions.push(...h.decisions);
    t.detections.push(...h.detections);
    t.spans.push(...h.spans);
    if (h.edgeOff) t.edges.push({ type: 'source', id: s.id, on: false });
    const lim = h.memory.outdoorBlocked;
    t.mem[s.id] = { ...h.memory, outdoorBlocked: { heat: stepOutdoorLimit(s.outdoorLimits.heat, lim.heat, t.tout10), cool: stepOutdoorLimit(s.outdoorLimits.cool, lim.cool, t.tout10) } };
  }
}

function energyCtx(t: Tick): EnergyCtx {
  const { cfg, ctx } = t;
  const readings = readEnergy(cfg, t.inputs);
  const exempt = exemptActive(cfg.energy, readings.soc);
  const economy = ctx.rules.some((r) => r.active && r.ruleId === 'economy') || ctx.overlay.disabledCarriers.includes('electric');
  const budgeted = (s: SourceConfig) => countsInBudget(s, cfg.energy, exempt);
  const loadKw = cfg.sources.reduce((sum, s) => sum + (budgeted(s) ? runningKw(s, t.mem[s.id], t.inputs) : 0), 0);
  const en: EnergyCtx = {
    readings,
    phase: energyPhase(ctx.energyActive, readings.soc, cfg.energy, economy),
    budgeted,
    loadKw,
    budgetKw: ctx.energyActive ? effectiveBudget(cfg.energy, ctx.overlay, readings.houseLoadKw, loadKw) : Number.POSITIVE_INFINITY,
    fits: (s) => {
      if (!ctx.energyActive || !budgeted(s)) return null;
      const need = nominalKw(s);
      return en.loadKw + need <= en.budgetKw + 1e-9 ? null : { code: 'source.blocked.budget', params: { usedKw: round2(en.loadKw), budgetKw: en.budgetKw, needKw: round2(need) } };
    },
  };
  return en;
}

/** «ТН не встигає»: rooms of the running heat pump's circuits that stay short of their target. */
function lagPhase(t: Tick): Record<Id, EpochMs | null> {
  const lagSince: Record<Id, EpochMs | null> = {};
  const { cfg, pair } = t;
  if (!pair) {
    if (t.plantMem.lagActive.on) t.plantMem = { ...t.plantMem, lagActive: { on: false, since: t.now } };
    return lagSince;
  }
  const hpMem = t.mem[pair.hpId];
  const candidates: LagCandidate[] = [];
  if (hpMem?.on && hpMem.mode === 'heat') {
    for (const c of t.idx.fedCircuits.get(pair.hpId) ?? []) {
      for (const { room } of t.idx.members.get(c.id) ?? []) {
        if (candidates.some((k) => k.roomId === room.id)) continue;
        if (room.demand !== 'heat' || room.paused || room.t === null || room.heatC === null) continue;
        candidates.push({ roomId: room.id, t: room.t, T: room.heatC, below: room.tol.heat.below, since: room.ev.memory.lagDeficitSince });
      }
    }
  }
  const lag = stepLag(cfg, { latch: t.plantMem.lagActive, hp: pair.hpId, reserve: pair.reserveId, hpMem: hpMem ?? null, defrost: t.health[pair.hpId]?.defrost ?? false, blind: t.inputs.blind, dtMs: t.dtMs, now: t.now, candidates });
  t.plantMem = { ...t.plantMem, lagActive: lag.latch };
  t.decisions.push(...lag.decisions);
  Object.assign(lagSince, lag.since);
  for (const since of Object.values(lag.since)) if (since !== null) t.wakes.push(since + cfg.heat.lag.forMin * MIN_MS);
  if (hpMem?.on && hpMem.onSince !== null) t.wakes.push(hpMem.onSince + cfg.heat.lag.graceAfterStartMin * MIN_MS);
  return lagSince;
}

/** Selection's wants plus forced sources and check runs; what must stop regardless of its minimum run. */
function planPhase(t: Tick, sel: Selection, en: EnergyCtx): Plan {
  const { cfg, now } = t;
  const wants = new Map<Id, Want>(sel.wants);
  const safetyStops = new Map<Id, string>(sel.safetyStops);
  const tests = new Map<Id, ReturnType<typeof testPhase>>();
  const fedIn = (id: Id, mode: SourceMode) => (t.idx.fedCircuits.get(id) ?? []).filter((c) => !isHeatCool(mode) || c.capabilities[mode]).map((c) => c.id);
  for (const s of cfg.sources) {
    const m = t.mem[s.id];
    const lock = activeLock(cfg, s.id, now);
    if (lock?.kind === 'source_force' && lock.value.kind === 'source_force' && s.enabled) {
      const mode = lock.value.mode;
      const cur = wants.get(s.id);
      if (!cur || cur.mode !== mode) {
        wants.set(s.id, { mode, why: 'force', roomIds: new Set(cur?.roomIds ?? []), circuitIds: new Set(fedIn(s.id, mode)), role: cur?.role ?? 'lead', roleReason: cur?.roleReason ?? { code: 'role.lead', params: {} }, emitterRole: null });
      }
    }
    const test = testPhase(m, now, t.prevTickAt);
    tests.set(s.id, test);
    if (test.active && test.mode) {
      if (t.health[s.id].unbound) t.mem[s.id] = blockTest(m, now, 'error');
      else {
        const cur = wants.get(s.id);
        wants.set(s.id, { mode: test.mode, why: 'test', roomIds: new Set(cur?.roomIds ?? []), circuitIds: new Set(fedIn(s.id, test.mode)), role: cur?.role ?? 'unused', roleReason: cur?.roleReason ?? { code: 'role.unused', params: {} }, emitterRole: cur?.emitterRole ?? null });
      }
    }
    if (test.ended && !sel.wants.has(s.id)) safetyStops.set(s.id, 'test_end');
    if (!s.enabled) {
      wants.delete(s.id);
      safetyStops.set(s.id, 'disabled');
    }
    if (en.phase === 'critical') {
      // a dying battery keeps only frost protection running
      const w = wants.get(s.id);
      if (!w || (w.why !== 'frost' && w.why !== 'frost_fallback')) {
        wants.delete(s.id);
        if (m.on) safetyStops.set(s.id, 'battery_critical');
      }
    }
  }
  if (en.phase === 'critical' && t.ctx.prevPlant?.energy.phase !== 'critical') t.decisions.push({ code: 'budget.critical', category: 'src', tone: 'err', params: { soc: en.readings.soc } });
  t.detections.push({ kind: 'energy_critical', dedupKey: 'energy_critical', active: en.phase === 'critical', facts: { soc: en.readings.soc } });
  return { wants, safetyStops, tests };
}

/** The load stays over the budget → the least important running source goes. */
function shedPhase(t: Tick, en: EnergyCtx, plan: Plan, shedOrder: readonly Id[]): Map<Id, Reason> {
  const shed = new Map<Id, Reason>();
  if (!t.ctx.energyActive || en.phase === 'critical') {
    if (t.plantMem.budgetOverSince !== null) t.plantMem = { ...t.plantMem, budgetOverSince: null };
    return shed;
  }
  const { cfg, now } = t;
  const running = cfg.sources.filter((s) => en.budgeted(s) && t.mem[s.id].on).map((s) => ({ id: s.id, minRunOk: (minRunUntil(s, t.mem[s.id]) ?? 0) <= now }));
  const r = shedStep(running, { loadKw: en.loadKw, budgetKw: en.budgetKw, overSince: t.plantMem.budgetOverSince, lastShedAt: t.plantMem.lastShedAt, now, staggerSec: cfg.energy.staggerSec, shedOrder });
  t.plantMem = { ...t.plantMem, budgetOverSince: r.overSince, lastShedAt: r.lastShedAt };
  if (r.overSince !== null) t.wakes.push(r.overSince + 30 * SEC);
  if (isEmergency(en.loadKw, en.budgetKw)) t.wakes.push(now + SEC);
  if (!r.shedId) return shed;
  const facts = { sourceId: r.shedId, usedKw: round2(en.loadKw), budgetKw: en.budgetKw };
  plan.wants.delete(r.shedId);
  if (r.emergency) plan.safetyStops.set(r.shedId, 'budget_emergency');
  shed.set(r.shedId, { code: 'source.blocked.budget', params: { usedKw: facts.usedKw, budgetKw: en.budgetKw, needKw: null } });
  t.decisions.push({ code: 'budget.shed', category: 'src', tone: 'warn', params: facts, sourceId: r.shedId });
  t.detections.push({ kind: 'budget_shed', dedupKey: `budget_shed:${r.shedId}:${now}`, active: true, sourceId: r.shedId, facts });
  return shed;
}

/** A pump of the source's circuits has run for its pre-run time (water moves through the boiler). */
function pumpReady(t: Tick, s: SourceConfig): boolean {
  const preMs = (s.hydronic?.preRunSec ?? 0) * SEC;
  const pumps = (t.idx.fedCircuits.get(s.id) ?? []).flatMap((c) => [...(t.idx.circuitPumps.get(c.id) ?? []), ...(c.manifoldId ? (t.idx.manifoldPumps.get(c.manifoldId) ?? []) : [])]);
  return pumps.some((p) => {
    const pm = t.memory.pumps[p.id];
    return !!pm && pm.on && pm.onSince !== null && t.now - pm.onSince >= preMs;
  });
}

/** Journal lines of a start: the source, a frost fallback, a failover, a heat-pump changeover. */
function startEvents(t: Tick, s: SourceConfig, want: Want, sel: Selection, changeover: { from: Mode; to: Mode } | null): void {
  const roomIds = [...want.roomIds];
  const roomId = roomIds[0] ?? null;
  const why: Reason =
    want.why === 'frost_fallback'
      ? { code: 'plant.frost_fallback', params: { sourceId: s.id, roomId } }
      : want.why === 'cold_guard'
        ? { code: 'plant.neutral_guard', params: { n: roomIds.length } }
        : { code: 'plant.lead', params: { sourceId: s.id, mode: want.mode, toutC: t.tout10 } };
  t.edges.push({ type: 'source', id: s.id, on: true });
  t.decisions.push({ code: 'source.start', category: 'src', tone: want.mode === 'heat' ? 'heat' : 'cool', params: { mode: want.mode, n: roomIds.length, roomId, toutC: t.tout10, reason: want.why }, why, sourceId: s.id, roomId });
  if (want.why === 'frost_fallback') t.decisions.push({ code: 'frost.fallback', category: 'src', tone: 'err', params: { sourceId: s.id, roomId }, sourceId: s.id, roomId });
  for (const plan of sel.plans.values()) {
    if (plan.lead !== s.id || !plan.failover) continue;
    const facts = { from: plan.failover.from, to: s.id, code: plan.failover.code };
    t.decisions.push({ code: 'source.failover', category: 'src', tone: 'warn', params: facts, sourceId: s.id });
    t.detections.push({ kind: 'source_fallback', dedupKey: `source_fallback:${plan.failover.from}:${t.now}`, active: true, sourceId: s.id, facts });
    break;
  }
  if (changeover) t.decisions.push({ code: 'source.changeover', category: 'src', tone: 'event', params: { from: changeover.from, to: changeover.to }, sourceId: s.id });
  if (want.why === 'test') t.spans.push({ subject: 'source', subjectId: s.id, kind: 'test', mode: want.mode, edge: 'start', at: t.now });
}

/** Start/stop guards per source, most important first so admissions follow the shed order. */
function guardPhase(t: Tick, en: EnergyCtx, plan: Plan, sel: Selection, shed: Map<Id, Reason>, shedOrder: readonly Id[]): GuardOutcome {
  const { cfg, now } = t;
  const out: GuardOutcome = { blockers: new Map(), held: new Set(), prerunning: new Set() };
  let lastAdmission = t.plantMem.lastAdmissionAt;
  // the last in the shed order is the most important; unbudgeted sources need no admission at all
  const importance = (s: SourceConfig) => (en.budgeted(s) ? shedOrder.indexOf(s.id) : Number.MAX_SAFE_INTEGER);
  for (const s of [...cfg.sources].sort((a, b) => importance(b) - importance(a))) {
    const want = plan.wants.get(s.id) ?? null;
    const flowNeeded = !!s.hydronic?.requiresFlow && (s.hydronic.preRunSec ?? 0) > 0 && sourceHasPumps(t.idx, s.id);
    const admit = (): Reason | null => {
      if (!t.ctx.energyActive || !en.budgeted(s)) return null;
      const kw = nominalKw(s);
      if (en.loadKw + kw > en.budgetKw + 1e-9) return { code: 'source.blocked.budget', params: { usedKw: round2(en.loadKw), budgetKw: en.budgetKw, needKw: round2(kw) } };
      const stagger = (s.energy.staggerSec ?? cfg.energy.staggerSec) * SEC;
      if (lastAdmission !== null && now - lastAdmission < stagger) {
        t.wakes.push(lastAdmission + stagger);
        return { code: 'source.blocked.stagger', params: { until: lastAdmission + stagger } };
      }
      en.loadKw += kw;
      lastAdmission = now;
      return null;
    };
    const r = stepSource(s, t.mem[s.id], {
      now,
      want: want ? { mode: want.mode } : null,
      safetyStop: plan.safetyStops.get(s.id) ?? null,
      changeover: null,
      admit,
      prerunPending: flowNeeded && !pumpReady(t, s),
      reason: want?.why ?? 'none',
    });
    let next = r.memory;
    t.spans.push(...r.spans);
    if (r.heldByMinRun) out.held.add(s.id);
    if (r.prerunning) {
      out.prerunning.add(s.id);
      if (next.prerunSince !== null) t.wakes.push(next.prerunSince + (s.hydronic?.preRunSec ?? 0) * SEC);
    }
    const blockers = [...r.blockers, ...(shed.has(s.id) ? [shed.get(s.id) as Reason] : [])];
    out.blockers.set(s.id, blockers);
    for (const b of blockers) if (typeof b.params?.until === 'number' && b.params.until > now) t.wakes.push(b.params.until);
    if (r.edge === 'on' && want) startEvents(t, s, want, sel, r.changeover);
    if (r.edge === 'off') {
      t.edges.push({ type: 'source', id: s.id, on: false });
      t.decisions.push({ code: 'source.stop', category: 'src', tone: 'idle', params: { reason: r.stopReason }, sourceId: s.id });
    }

    // a check run that cannot start reports it; one that ends is journalled once
    const test = plan.tests.get(s.id);
    if (test?.active && next.test && !next.on && r.blockers.some((b) => b.code === 'source.blocked.min_off' || b.code === 'source.blocked.max_starts')) next = blockTest(next, now, 'blocked');
    const after = testPhase(next, now, t.prevTickAt);
    if (after.ended && next.test) {
      next = finishTest(next, now);
      const tr = next.test as NonNullable<SourceMemory['test']>;
      t.decisions.push({ code: 'source.test', category: 'src', tone: tr.result === 'ok' ? 'ok' : 'warn', params: { result: tr.result, confirmAfterSec: tr.confirmAfterSec }, sourceId: s.id });
      t.spans.push({ subject: 'source', subjectId: s.id, kind: 'test', mode: tr.mode, edge: 'end', at: now });
    } else if (next.test && after.active) t.wakes.push(next.test.until);
    t.mem[s.id] = next;
  }
  t.plantMem = { ...t.plantMem, lastAdmissionAt: lastAdmission };
  for (const o of expiredLocks(cfg, now)) t.decisions.push({ code: 'source.lock_expired', category: 'src', tone: 'idle', params: {}, sourceId: o.subjectId });
  return out;
}

/** Electric boiler stages: up for a room that stays cold, down once everyone is comfortable. */
function stagePhase(t: Tick, en: EnergyCtx, plan: Plan): void {
  for (const s of t.cfg.sources) {
    if (s.adapter.type !== 'relay' || !s.adapter.stages.length || !t.mem[s.id].on) continue;
    const rooms = [...(plan.wants.get(s.id)?.roomIds ?? [])].map((id) => t.idx.room.get(id)).filter((r): r is RoomView => !!r);
    let belowSince: EpochMs | null = null;
    let allInBand = true;
    for (const r of rooms) {
      if (r.t === null || r.heatC === null || r.t > r.heatC - r.tol.heat.below + 1e-9) continue;
      allInBand = false;
      const since = r.ev.memory.heat.on ? r.ev.memory.heat.since : t.now;
      belowSince = belowSince === null ? since : Math.min(belowSince, since);
    }
    const m = t.mem[s.id];
    const counts = t.ctx.energyActive && en.budgeted(s);
    const delta = nominalKw(s, m.stage + 1) - nominalKw(s, m.stage);
    const st = stepStages(s, m, { now: t.now, belowSince, allInBand, admitsNext: !counts || en.loadKw + delta <= en.budgetKw + 1e-9, overBudget: counts && en.loadKw > en.budgetKw + 1e-9 });
    if (st.decision) {
      t.decisions.push(st.decision);
      if (counts) en.loadKw += nominalKw(s, st.memory.stage) - nominalKw(s, m.stage);
    }
    t.mem[s.id] = st.memory;
  }
}

/** Loop mode of every circuit and which emitters are open for it (heat-only loops never see chilled water). */
function circuitPhase(t: Tick, sel: Selection): CircuitFacts {
  const facts: CircuitFacts = { mode: new Map(), heatOnlyBlocked: new Map(), emitterOpen: {}, emitterFeeding: {} };
  for (const c of t.idx.circuits) {
    const heat = c.capabilities.heat && c.sourceIds.some((id) => runningIn(t, id, 'heat'));
    const cool = c.capabilities.cool && c.sourceIds.some((id) => runningIn(t, id, 'cool'));
    const mode: ModeOrNone = heat ? 'heat' : cool ? 'cool' : 'none';
    const blocked = !c.capabilities.cool && c.sourceIds.some((id) => runningIn(t, id, 'cool'));
    facts.mode.set(c.id, mode);
    facts.heatOnlyBlocked.set(c.id, blocked);
    const plan = sel.plans.get(c.id);
    for (const { room, emitter } of t.idx.members.get(c.id) ?? []) {
      const rm = room.requests.get(emitter.id)?.mode ?? null;
      let open = false;
      // open whenever the room asks and the loop may carry that mode — even while the source waits to start
      if (rm !== null && c.capabilities[rm] && (mode === 'none' || mode === rm)) {
        open = rm === 'heat' ? !blocked : !!plan && !plan.dew.blocked && !plan.dew.tripped && !plan.dew.hold && !plan.humidRooms.includes(room) && !plan.humidityUnknownRooms.includes(room);
      }
      facts.emitterOpen[emitter.id] = open;
      facts.emitterFeeding[emitter.id] = mode === 'none' ? [] : c.sourceIds.filter((id) => runningIn(t, id, mode));
    }
  }
  for (const [sourceId, list] of t.idx.direct) {
    const on = t.mem[sourceId]?.on === true;
    for (const { emitter } of list) {
      facts.emitterOpen[emitter.id] = on;
      facts.emitterFeeding[emitter.id] = on ? [sourceId] : [];
    }
  }
  return facts;
}

/** The circuit whose pumps move water through a source when nothing else does. */
function flowCircuitOf(t: Tick, s: SourceConfig): Circuit | null {
  const fed = (t.idx.fedCircuits.get(s.id) ?? []).filter((c) => (t.idx.circuitPumps.get(c.id)?.length ?? 0) > 0);
  return fed.find((c) => c.flowSafety) ?? fed[0] ?? null;
}

const FORCE_RANK = ['flow_safety', 'source_hold', 'prerun', 'test'];

/** Pumps: rules, run-on and forced flow; a second pass when a running source would otherwise dead-head. */
function pumpPhase(t: Tick, en: EnergyCtx, facts: CircuitFacts, sel: Selection, guards: GuardOutcome, plan: Plan): ReturnType<typeof stepPumps> {
  const { cfg, idx } = t;
  const flows = new Map<Id, CircuitFlow>();
  for (const c of idx.circuits) {
    const mode = facts.mode.get(c.id) ?? 'none';
    const members = idx.members.get(c.id) ?? [];
    // a floor resting after the dew guard stays closed while its heat pump still cools another loop
    const dewClosed = !!sel.plans.get(c.id)?.dew.hold && c.sourceIds.some((id) => runningIn(t, id, 'cool'));
    flows.set(c.id, {
      circuit: c,
      mode,
      openDemand: mode !== 'none' && members.some(({ emitter }) => facts.emitterOpen[emitter.id] && emitter.roles[mode as Mode] !== null),
      feedingOn: mode !== 'none',
      heatOnlyBlocked: (facts.heatOnlyBlocked.get(c.id) ?? false) || dewClosed,
      frost: c.capabilities.heat && members.some(({ room, emitter }) => room.frost && emitter.roles.heat !== null),
      forced: null,
      dewTripped: sel.dewTripped.has(c.id),
      coolingFeed: c.sourceIds.some((id) => runningIn(t, id, 'cool')),
    });
  }
  const force = (c: Circuit | null | undefined, reason: NonNullable<CircuitFlow['forced']>['reason'], sourceId: Id): boolean => {
    const f = c ? flows.get(c.id) : undefined;
    if (!c || !f || f.heatOnlyBlocked) return false;
    if (f.forced && FORCE_RANK.indexOf(reason) >= FORCE_RANK.indexOf(f.forced.reason)) return false;
    flows.set(c.id, { ...f, forced: { reason, sourceId } });
    return true;
  };
  for (const s of cfg.sources) {
    const m = t.mem[s.id];
    const fed = idx.fedCircuits.get(s.id) ?? [];
    if (guards.held.has(s.id) && m.on) for (const c of fed) if (!isHeatCool(m.mode) || c.capabilities[m.mode]) force(c, 'source_hold', s.id);
    if (guards.prerunning.has(s.id)) force(flowCircuitOf(t, s), 'prerun', s.id);
    const test = plan.tests.get(s.id);
    const testMode = m.mode ?? test?.mode ?? null;
    if (test?.active && (m.on || guards.prerunning.has(s.id))) for (const c of fed) if (!isHeatCool(testMode) || c.capabilities[testMode]) force(c, 'test', s.id);
  }
  const manifoldFeedOn = new Map<Id, boolean>();
  for (const c of idx.circuits) if (c.manifoldId) manifoldFeedOn.set(c.manifoldId, (manifoldFeedOn.get(c.manifoldId) ?? false) || c.sourceIds.some((id) => t.mem[id]?.on));

  const input: PumpStepInput = {
    cfg,
    inputs: t.inputs,
    now: t.now,
    prevTickAt: t.prevTickAt,
    memory: t.memory.pumps,
    flows,
    circuitPumps: idx.circuitPumps,
    manifoldPumps: idx.manifoldPumps,
    manifoldFeedOn,
    phase: en.phase,
    overlay: t.ctx.overlay,
    ledger: t.ledger,
  };
  let pumps = stepPumps(input);
  // flow safety: a running boiler or heat pump must always have a pump moving water through it
  let again = false;
  for (const s of cfg.sources) {
    if (!t.mem[s.id].on || !s.hydronic?.requiresFlow || !sourceHasPumps(idx, s.id)) continue;
    const flowing = (idx.fedCircuits.get(s.id) ?? []).some((c) => (idx.circuitPumps.get(c.id) ?? []).some((p) => pumps.outcomes.get(p.id)?.on));
    if (!flowing && force(flowCircuitOf(t, s), 'flow_safety', s.id)) again = true;
  }
  if (again) pumps = stepPumps({ ...input, flows });
  t.decisions.push(...pumps.decisions);
  t.spans.push(...pumps.spans);
  t.edges.push(...pumps.edges);
  t.wakes.push(...pumps.wakes);
  if (cfg.safety.pumpExercise.enabled) {
    // the exercise slot later today wakes the engine on time
    try {
      const lt = toLocal(t.now, t.inputs.tz);
      if (lt.dow === cfg.safety.pumpExercise.dow) t.wakes.push(fromLocal(lt.date, hhmmToMinute(cfg.safety.pumpExercise.time), t.inputs.tz));
    } catch {
      /* a malformed time simply has no wake */
    }
  }
  return pumps;
}

/** Who serves each room now, or why it waits. */
function verdictPhase(t: Tick, evals: readonly RoomEval[], facts: CircuitFacts, sel: Selection, guards: GuardOutcome): RoomServiceVerdict[] {
  return evals.map((ev) => {
    const r = t.idx.room.get(ev.roomId);
    if (!r) return { roomId: ev.roomId, served: false, servingSourceIds: [], waitReason: null, emitterOpen: {}, emitterFeeding: {}, heatOnlyBlocked: false };
    const open: Record<Id, boolean> = {};
    const feeding: Record<Id, Id[]> = {};
    const serving = new Set<Id>();
    let served = false;
    let heatOnly = false;
    const dm: ModeOrNone = r.demand;
    for (const e of r.emitters) {
      open[e.id] = facts.emitterOpen[e.id] ?? false;
      feeding[e.id] = facts.emitterFeeding[e.id] ?? [];
      if (e.circuitId && facts.heatOnlyBlocked.get(e.circuitId) && e.roles.heat !== null) heatOnly = true;
      if (!open[e.id]) continue;
      for (const id of feeding[e.id]) serving.add(id);
      if (dm === 'none') continue;
      const reqMode = r.requests.get(e.id)?.mode ?? null;
      if (e.circuitId) {
        if (reqMode === dm && feeding[e.id].some((id) => runningIn(t, id, dm))) served = true;
      } else if (e.sourceId && runningIn(t, e.sourceId, dm) && (reqMode === dm || r.frost)) served = true;
    }
    const waitReason = dm !== 'none' && !served ? waitFor(r, dm, sel, guards.blockers, t.mem, t.cfg) : null;
    return { roomId: r.id, served, servingSourceIds: [...serving], waitReason, emitterOpen: open, emitterFeeding: feeding, heatOnlyBlocked: heatOnly };
  });
}

/** Flow setpoint of a source: the weather curve heating, the dew-safe supply of its loops cooling. */
function flowSetpoint(t: Tick, sel: Selection, s: SourceConfig, mode: SourceMode | null): number | null {
  if (mode === 'heat') return s.curves.heat && t.toutForCurve !== null ? flowFromCurve(s.curves.heat, t.toutForCurve) : null;
  if (mode !== 'cool') return null;
  // never below any cooling circuit's requirement
  const sps = (t.idx.fedCircuits.get(s.id) ?? []).map((c) => sel.plans.get(c.id)?.dew.supplySpC ?? null).filter((v): v is number => v !== null);
  return sps.length ? Math.max(...sps, s.curves.cool?.flowC ?? -Infinity) : (s.curves.cool?.flowC ?? null);
}

/** Desired values of sources, ACs, pumps and mixing valves; returns each source's setpoint and the room memory. */
function actuationPhase(
  t: Tick,
  sel: Selection,
  plan: Plan,
  facts: CircuitFacts,
  pumps: ReturnType<typeof stepPumps>,
  lagSince: Record<Id, EpochMs | null>,
  evals: readonly RoomEval[],
): { roomMem: Record<Id, RoomMemory>; setpoints: Map<Id, number | null> } {
  const { cfg, now, idx } = t;
  const roomMem: Record<Id, RoomMemory> = { ...t.memory.rooms };
  for (const ev of evals) roomMem[ev.roomId] = { ...ev.memory, lagDeficitSince: lagSince[ev.roomId] ?? null };
  const setpoints = new Map<Id, number | null>();

  for (const s of cfg.sources) {
    const m = t.mem[s.id];
    const h = t.health[s.id];
    // a disabled source is told OFF once, then left to whoever uses it now
    if (!s.enabled && !m.on && (m.offSince === null || now - m.offSince >= DISABLED_OFF_MS)) continue;
    const urgency: Urgency = m.fault || plan.safetyStops.has(s.id) || h.stillDrawing ? 'safety' : 'source';
    const want = plan.wants.get(s.id);
    const rooms = [...(want?.roomIds ?? [])].map((id) => idx.room.get(id)).filter((r): r is RoomView => !!r);
    const ownRoom = s.scope === 'room' ? (idx.direct.get(s.id)?.[0]?.room ?? (s.roomId ? (idx.room.get(s.roomId) ?? null) : null)) : null;

    if (s.scope === 'room' && s.adapter.type === 'climate' && s.adapter.climate && (s.kind === 'ac' || s.capabilities.cool)) {
      const applied = ownRoom ? (roomMem[ownRoom.id]?.acSetpoint[s.id] ?? null) : null;
      const target = ownRoom ? cfg.overrides.find((o) => o.scope === 'room' && o.subjectId === ownRoom.id && o.group === 'target' && (o.until === null || o.until > now)) : undefined;
      const out = acDesired(s, m, { inputs: t.inputs, now, room: ownRoom, emitterRole: want?.emitterRole ?? null, applied, urgency, reqId: target?.reqId ?? null });
      t.desired.push(out.desired);
      setpoints.set(s.id, out.setpointC);
      if (ownRoom && out.applied && roomMem[ownRoom.id]) {
        roomMem[ownRoom.id] = { ...roomMem[ownRoom.id], acSetpoint: { ...roomMem[ownRoom.id].acSetpoint, [s.id]: out.applied } };
        t.wakes.push(out.applied.at + ownRoom.room.ac.correction.everyMin * MIN_MS);
      }
      continue;
    }

    if (m.on && s.adapter.type === 'relay' && s.adapter.watchdog.kind !== 'none' && s.adapter.watchdog.kind !== 'device') {
      // the reconciler re-sends the keep-alive; memory notes when it was last due
      const every = s.adapter.watchdog.rearmEveryMin * MIN_MS;
      if (m.lastRearmAt === null || now - m.lastRearmAt >= every) t.mem[s.id] = { ...m, lastRearmAt: now };
    }
    const flowC = flowSetpoint(t, sel, s, m.on ? m.mode : null);
    const targets = (mode: SourceMode | null) => {
      const list = (rooms.length ? rooms : ownRoom ? [ownRoom] : []).map((r) => (mode === 'heat' ? r.heatC : r.coolC)).filter((v): v is number => v !== null);
      return list.length ? (mode === 'heat' ? Math.max(...list) : Math.min(...list)) : null;
    };
    let setpointC: number | null = flowC;
    if (s.adapter.type === 'climate') {
      const a = s.adapter;
      if (s.scope === 'room' || a.setpoint === 'room_target') setpointC = targets(m.mode);
      else if (a.setpoint === 'fixed') setpointC = a.fixedSetpoint ? (m.mode === 'heat' ? a.fixedSetpoint.heatC : a.fixedSetpoint.coolC) : null;
      else if (a.setpoint === 'none') setpointC = null;
    } else if ((s.adapter.type === 'custom' || s.adapter.type === 'script') && setpointC === null) setpointC = targets(m.mode);
    setpoints.set(s.id, m.on ? setpointC : null);
    t.desired.push(
      ...sourceDesired(s, m, {
        now,
        ledger: t.ledger,
        urgency,
        setpointC: m.on ? setpointC : null,
        flowC: m.on ? flowC : null,
        roomTempC: ownRoom?.t ?? rooms[0]?.t ?? null,
        roomTargetC: targets(m.mode),
        stillDrawing: h.stillDrawing,
      }),
    );
  }

  for (const out of pumps.outcomes.values()) {
    const p = out.pump;
    const blocked = !!p.circuitId && (facts.heatOnlyBlocked.get(p.circuitId) ?? false);
    t.desired.push(...pumpDesired(p, out.on, out.mode, blocked ? 'safety' : 'source'));
  }
  for (const p of cfg.pumps) {
    // a pump disabled while running is switched off, then left alone
    const pm = pumps.memory[p.id];
    if (!p.enabled && pm && pm.offSince !== null && now - pm.offSince < DISABLED_OFF_MS) t.desired.push(...pumpDesired(p, false, 'none', 'safety'));
  }
  for (const c of idx.circuits) {
    if (!c.mixingValve) continue;
    const mode = facts.mode.get(c.id);
    const sp = sel.plans.get(c.id)?.dew.supplySpC ?? c.supply.coolC;
    const value = mode === 'heat' ? c.mixingValve.heatC : mode === 'cool' ? Math.max(sp, c.mixingValve.coolC ?? sp) : null;
    const d = value === null ? null : mixingDesired(c, value);
    if (d) t.desired.push(d);
  }
  return { roomMem, setpoints };
}

/** The heating water itself near freezing while a source runs (supply below the alert for 10 minutes). */
function supplyFrostPhase(t: Tick, facts: CircuitFacts): void {
  const { cfg, now } = t;
  for (const c of t.idx.circuits) {
    if (!c.capabilities.heat || !c.supply.sensorEntityId) continue;
    const key = SUPPLY_FROST_KEY(c.id);
    const supplyC = numOf(snapOf(t.inputs, c.supply.sensorEntityId));
    const cold = facts.mode.get(c.id) === 'heat' && supplyC !== null && supplyC < cfg.safety.frostSupplyAlertC;
    const timers = { ...t.plantMem.dewGuardSince };
    if (cold) {
      timers[key] = timers[key] ?? now;
      t.wakes.push(timers[key] + SUPPLY_FROST_HOLD_MS);
    } else delete timers[key];
    t.plantMem = { ...t.plantMem, dewGuardSince: timers };
    t.detections.push({ kind: 'frost_risk', dedupKey: `frost_risk:supply:${c.id}`, active: cold && now - (timers[key] ?? now) >= SUPPLY_FROST_HOLD_MS, facts: { circuitId: c.id, supplyC, frostC: cfg.safety.frostSupplyAlertC } });
  }
}

function energyStateOf(t: Tick, en: EnergyCtx): EnergyState {
  const { cfg, ctx } = t;
  const usedKw = round2(cfg.sources.reduce((sum, s) => sum + (en.budgeted(s) ? runningKw(s, t.mem[s.id], t.inputs) : 0), 0));
  const perSourceKw: Record<Id, number> = {};
  for (const s of cfg.sources) if (t.mem[s.id].on) perSourceKw[s.id] = round2(runningKw(s, t.mem[s.id], t.inputs));
  // a rule letting sources run on solar surplus says where the surplus goes
  const allowed = ctx.energyActive ? ctx.overlay.allowSources : [];
  const solarMode = allowed.some((a) => runningIn(t, a.sourceId, 'heat')) ? 'heat' : allowed.some((a) => runningIn(t, a.sourceId, 'cool')) ? 'cool' : null;
  const budgetKw = ctx.energyActive ? en.budgetKw : null;
  return {
    configured: en.readings.configured,
    grid: en.readings.grid,
    pvKw: en.readings.pvKw,
    batteryPct: en.readings.soc,
    houseLoadKw: en.readings.houseLoadKw,
    restrictionsActive: ctx.energyActive,
    phase: en.phase,
    budgetKw,
    usedKw,
    perSourceKw,
    note: energyNote(cfg, { readings: en.readings, active: ctx.energyActive, phase: en.phase, usedKw, budgetKw, solarMode, triggers: ctx.triggers, now: t.now }),
  };
}

function circuitStateOf(t: Tick, c: Circuit, sel: Selection, facts: CircuitFacts, pumpStates: Map<Id, PumpState>): CircuitState {
  const plan = sel.plans.get(c.id) as CircuitPlan;
  const mode = facts.mode.get(c.id) ?? 'none';
  const members = t.idx.members.get(c.id) ?? [];
  const pumpsOf = (t.idx.circuitPumps.get(c.id) ?? []).map((p) => pumpStates.get(p.id)).filter((p): p is PumpState => !!p);
  const blocked = facts.heatOnlyBlocked.get(c.id) ?? false;
  const supplyC = numOf(snapOf(t.inputs, c.supply.sensorEntityId));
  const excluded: CircuitState['excludedRooms'] = [];
  for (const r of plan.humidRooms) excluded.push({ roomId: r.id, reason: 'humid' });
  for (const r of plan.humidityUnknownRooms) excluded.push({ roomId: r.id, reason: 'humidity_unknown' });
  if (plan.dew.blocked || plan.dew.hold) for (const r of plan.coolCallers) excluded.push({ roomId: r.id, reason: 'dew' });
  for (const { room, emitter } of members) {
    if (excluded.some((e) => e.roomId === room.id)) continue;
    if (blocked && emitter.roles.heat !== null && room.demand === 'heat') excluded.push({ roomId: room.id, reason: 'heat_only' });
    else if (emitter.excludeFromCooling && room.demand === 'cool') excluded.push({ roomId: room.id, reason: 'excluded' });
  }
  const runOn = pumpsOf.filter((p) => p.state === 'run_on' && p.runOnUntil !== null).map((p) => p.runOnUntil as number);
  const lead = plan.lead ? t.idx.source.get(plan.lead) : undefined;
  const heatSp = lead && mode === 'heat' ? (c.mixingValve ? c.mixingValve.heatC : lead.curves.heat && t.toutForCurve !== null ? flowFromCurve(lead.curves.heat, t.toutForCurve) : null) : null;
  let state: Reason;
  let tone: Tone;
  const hold = plan.dew.hold;
  if (blocked) [state, tone] = [{ code: 'circuit.heat_only_blocked', params: {} }, 'off'];
  else if (hold && mode !== 'heat') {
    [state, tone] = [hold.kind === 'lockout' ? { code: 'circuit.dew_lockout', params: { until: hold.until, trips: hold.trips } } : { code: 'circuit.dew_hold', params: { until: hold.until } }, 'warn'];
  } else if (plan.dew.blocked || plan.dew.tripped) [state, tone] = [{ code: 'circuit.dew_blocked', params: { dewC: plan.dew.maxDewC } }, 'warn'];
  else if (mode === 'heat') [state, tone] = [{ code: 'circuit.heating', params: { supplyC, sourceId: plan.lead ?? c.sourceIds.find((id) => runningIn(t, id, 'heat')) ?? null } }, 'heat'];
  else if (mode === 'cool') [state, tone] = [{ code: 'circuit.cooling', params: { supplyC, dewC: plan.dew.maxDewC } }, 'cool'];
  else if (runOn.length) [state, tone] = [{ code: 'circuit.run_on', params: { until: Math.max(...runOn) } }, 'idle'];
  else if (plan.heatCallers.length || plan.coolCallers.length) [state, tone] = [{ code: 'circuit.no_source', params: {} }, 'wait'];
  else if (t.ctx.season.season === 'cooling' && !c.capabilities.cool) [state, tone] = [{ code: 'circuit.summer', params: {} }, 'off'];
  else [state, tone] = [{ code: 'circuit.idle', params: {} }, 'idle'];
  const unique = (ids: Id[]) => ids.filter((id, i, a) => a.indexOf(id) === i);
  return {
    circuitId: c.id,
    mode,
    tone,
    state,
    requestingRoomIds: unique([...plan.heatCallers.map((k) => k.room.id), ...plan.coolCallers.map((r) => r.id)]),
    memberRoomIds: unique(members.map((mm) => mm.room.id)),
    excludedRooms: excluded,
    feedingSourceIds: mode === 'none' ? [] : c.sourceIds.filter((id) => runningIn(t, id, mode)),
    supplyC,
    returnC: numOf(snapOf(t.inputs, c.supply.returnEntityId)),
    supplySetpointC: mode === 'cool' ? plan.dew.supplySpC : heatSp,
    dewPointMaxC: plan.dew.maxDewC,
    dewHold: hold ? { ...hold } : null,
    pumpOn: pumpsOf.some((p) => p.on),
    runOnUntil: runOn.length ? Math.max(...runOn) : null,
    pumps: pumpsOf,
  };
}

/** Every timer of the plant that flips before the next periodic tick. */
function sourceWakes(t: Tick, plan: Plan, guards: GuardOutcome): void {
  for (const s of t.cfg.sources) {
    const m = t.mem[s.id];
    const add = (at: EpochMs | null | undefined) => {
      if (at !== null && at !== undefined && at > t.now) t.wakes.push(at);
    };
    add(m.confirmDeadline);
    add(m.fault?.retryAt);
    if (m.unavailableSince !== null) add(m.unavailableSince + s.guards.unavailableAfterMin * MIN_MS);
    if (plan.wants.has(s.id) && !m.on) add(minOffUntil(s, m));
    if (guards.held.has(s.id)) add(minRunUntil(s, m));
    if (m.stillDrawingSince !== null && m.offSince !== null) add(m.offSince + 2 * MIN_MS);
    add(activeLock(t.cfg, s.id, t.now)?.until);
    const starts = recentStarts(m, t.now);
    if (starts.length) add(Math.min(...starts) + 60 * MIN_MS);
  }
}

export const plantStep: PlantStepFn = (cfg, evals, ctx, inputs, memory, ledger) => {
  const now = inputs.now;
  const tz = inputs.tz;
  const prevTickAt = memory.plant.updatedAt;
  const idx = indexPlant(cfg, evals);
  const t: Tick = {
    cfg,
    ctx,
    inputs,
    memory,
    ledger,
    now,
    prevTickAt,
    dtMs: clamp(now - prevTickAt, 0, MAX_DT_MS),
    idx,
    triggers: Object.fromEntries(ctx.triggers.map((tr) => [tr.triggerId, tr])),
    mem: {},
    plantMem: memory.plant,
    health: {},
    pair: chainPair(cfg, idx.source),
    tout10: null,
    toutForCurve: null,
    outdoorUnknownLong: false,
    decisions: [],
    detections: [],
    spans: [],
    edges: [],
    desired: [],
    wakes: [],
  };

  healthPhase(t);
  const en = energyCtx(t);

  const condOut: Record<string, ConditionMemory> = {};
  const condCtx: PlantConditionCtx = {
    cfg,
    inputs,
    rooms: Object.fromEntries(evals.map((e) => [e.roomId, e])),
    prevPlant: ctx.prevPlant,
    triggers: t.triggers,
    sourceId: null,
    budgetFits: (sid) => {
      const s = idx.source.get(sid);
      return !s || en.fits(s) === null;
    },
    season: ctx.season.season,
  };
  const conditions: Record<Id, ConditionItemResult[]> = {};
  for (const s of cfg.sources) conditions[s.id] = evalSourceConditions(s, condCtx, memory.conditions, condOut);
  const lagSince = lagPhase(t);

  const selCtx: SelectionCtx = {
    idx,
    inputs,
    now,
    season: ctx.season,
    overlay: ctx.overlay,
    triggers: t.triggers,
    energyActive: ctx.energyActive,
    phase: en.phase,
    soc: en.readings.soc,
    cutoff: t.plantMem.cutoff.on,
    tout10: t.tout10,
    outdoorUnknownLong: t.outdoorUnknownLong,
    frostLatch: t.plantMem.bivalentFrost.on,
    limitLatch: t.plantMem.bivalentLimit.on,
    lagLatch: t.plantMem.lagActive.on,
    mem: t.mem,
    health: t.health,
    conditions,
    fits: en.fits,
    prevPlant: ctx.prevPlant,
  };
  const sel = selectSources(selCtx, { since: t.plantMem.dewGuardSince, trips: t.plantMem.dewTrips ?? {}, lockout: t.plantMem.dewLockout ?? {} });
  t.plantMem = { ...t.plantMem, dewGuardSince: sel.dew.since, dewTrips: sel.dew.trips, dewLockout: sel.dew.lockout };
  t.decisions.push(...sel.decisions);
  t.detections.push(...sel.detections);
  for (const since of Object.values(sel.dew.since)) t.wakes.push(since + 2 * MIN_MS);
  for (const p of sel.plans.values()) if (p.dew.hold) t.wakes.push(p.dew.hold.until);

  const plan = planPhase(t, sel, en);
  const shedOrder = shedOrderOf(cfg);
  const shed = shedPhase(t, en, plan, shedOrder);
  const guards = guardPhase(t, en, plan, sel, shed, shedOrder);
  stagePhase(t, en, plan);
  const facts = circuitPhase(t, sel);
  const pumps = pumpPhase(t, en, facts, sel, guards, plan);
  const verdicts = verdictPhase(t, evals, facts, sel, guards);
  const { roomMem, setpoints } = actuationPhase(t, sel, plan, facts, pumps, lagSince, evals);
  supplyFrostPhase(t, facts);

  /* states */
  const prevPlant = ctx.prevPlant;
  const pumpStates = new Map<Id, PumpState>();
  const prevPumps = prevPlant ? [...prevPlant.circuits.flatMap((c) => c.pumps), ...prevPlant.manifoldPumps] : [];
  for (const [id, st] of pumps.states) {
    pumpStates.set(id, { ...st, todayRuntimeMin: runtimeToday(prevPumps.find((p) => p.pumpId === id)?.todayRuntimeMin, st.on, prevTickAt, now, tz, t.dtMs) });
  }
  const sources: SourceState[] = cfg.sources.map((s) =>
    sourceStateOf(s, {
      m: t.mem[s.id],
      h: t.health[s.id],
      want: plan.wants.get(s.id) ?? null,
      held: guards.held.has(s.id),
      guard: guards.blockers.get(s.id) ?? [],
      sel,
      selCtx,
      idx,
      inputs,
      tout10: t.tout10,
      setpointC: setpoints.get(s.id) ?? null,
      energyActive: ctx.energyActive,
      counts: en.budgeted(s),
      runtime: runtimeToday(prevPlant?.sources.find((p) => p.sourceId === s.id)?.todayRuntimeMin, t.mem[s.id].on, prevTickAt, now, tz, t.dtMs),
      conditions: conditions[s.id] ?? [],
      emitterOpen: facts.emitterOpen,
    }),
  );
  const plans = idx.circuits.map((c) => sel.plans.get(c.id) as CircuitPlan);
  const plant: PlantState = {
    sources,
    circuits: idx.circuits.map((c) => circuitStateOf(t, c, sel, facts, pumpStates)),
    manifoldPumps: [...idx.manifoldPumps.values()].flat().map((p) => pumpStates.get(p.id)).filter((p): p is PumpState => !!p),
    manifolds: cfg.manifolds.map((mf) => {
      const modes = idx.circuits.filter((c) => c.manifoldId === mf.id).map((c) => facts.mode.get(c.id));
      const tone: Tone = modes.includes('heat') ? 'heat' : modes.includes('cool') ? 'cool' : 'idle';
      return { manifoldId: mf.id, supplyC: numOf(snapOf(inputs, mf.supplySensorEntityId)), returnC: numOf(snapOf(inputs, mf.returnSensorEntityId)), tone };
    }),
    lead: {
      heat: plans.find((p) => p.mode === 'heat' && p.lead && runningIn(t, p.lead, 'heat'))?.lead ?? null,
      cool: plans.find((p) => p.mode === 'cool' && p.lead && runningIn(t, p.lead, 'cool'))?.lead ?? null,
    },
    bivalent: {
      frostActive: t.plantMem.bivalentFrost.on,
      limitActive: t.plantMem.bivalentLimit.on,
      lagActive: t.plantMem.lagActive.on,
      mode: cfg.heat.bivalence.mode,
      applies: !!t.pair || plans.some((p) => p.bivalent.applies),
    },
    heatDemand: idx.rooms.some((r) => r.demand === 'heat'),
    coolDemand: idx.rooms.some((r) => r.demand === 'cool'),
    energy: energyStateOf(t, en),
    triggers: ctx.triggers,
    rules: ctx.rules,
    why: [],
  };
  plant.why = plantWhy(cfg, plant, { sel, pair: t.pair, ctx, tout10: t.tout10, toutForCurve: t.toutForCurve, mem: t.mem, idx, blind: inputs.blind, cutoff: t.plantMem.cutoff.on });

  /* memory and the next moment something flips */
  sourceWakes(t, plan, guards);
  const future = t.wakes.filter((w) => Number.isFinite(w) && w > now);
  const conditionsOut: Record<string, ConditionMemory> = {};
  for (const [k, v] of Object.entries(memory.conditions)) if (!k.startsWith('source:')) conditionsOut[k] = v;
  Object.assign(conditionsOut, condOut);
  const sourcesOut: Record<Id, SourceMemory> = {};
  for (const s of cfg.sources) sourcesOut[s.id] = { ...t.mem[s.id], updatedAt: now };
  return {
    plant,
    verdicts,
    desired: t.desired,
    memory: { ...memory, rooms: roomMem, sources: sourcesOut, pumps: pumps.memory, conditions: conditionsOut, plant: { ...t.plantMem, updatedAt: now } },
    decisions: t.decisions,
    detections: t.detections,
    spans: t.spans,
    edges: t.edges,
    nextWakeAt: future.length ? Math.min(...future) : null,
  };
};

/* ── room wait reasons ─────────────────────────────────────────────────────────────────────────── */

function waitFor(r: RoomView, dm: Mode, sel: Selection, guard: Map<Id, Reason[]>, mem: Record<Id, SourceMemory>, cfg: EngineConfig): Reason {
  if (!r.canCall && !r.frost) return { code: 'wait.piggyback', params: {} };
  for (const e of r.emitters) {
    const req = r.requests.get(e.id);
    if (req?.mode !== dm) continue;
    if (e.circuitId) {
      const plan = sel.plans.get(e.circuitId);
      if (!plan) continue;
      const calling = dm === 'heat' ? plan.heatCallers.some((k) => k.room.id === r.id) : plan.coolCallers.some((x) => x.id === r.id);
      if (!calling) {
        if (dm === 'heat' && !plan.heatCallers.length) return { code: 'wait.season', params: { mode: dm } };
        continue;
      }
      const waiting = plan.selected.find((id) => !(mem[id]?.on && mem[id]?.mode === dm));
      if (waiting) {
        const b = guard.get(waiting)?.[0];
        if (b) return waitFrom(b, waiting, dm);
        if (mem[waiting]?.on) return { code: 'wait.starting', params: { sourceId: waiting } };
      }
      if (plan.blocked && plan.blocked.blockers[0]) return waitFrom(plan.blocked.blockers[0], plan.blocked.sourceId, dm);
      return { code: 'wait.no_source', params: { mode: dm } };
    }
    if (e.sourceId) {
      const b = guard.get(e.sourceId)?.[0] ?? sel.roomBlocked.get(r.id)?.find((x) => x.sourceId === e.sourceId)?.blockers[0];
      if (b) return waitFrom(b, e.sourceId, dm);
      if (mem[e.sourceId]?.on) return { code: 'wait.starting', params: { sourceId: e.sourceId } };
    }
  }
  if (dm === 'heat' && cfg.house.mode === 'off') return { code: 'wait.season', params: { mode: dm } };
  return { code: 'wait.no_source', params: { mode: dm } };
}

/* ── source state ──────────────────────────────────────────────────────────────────────────────── */

interface SourceStateInput {
  m: SourceMemory;
  h: HealthResult;
  want: SourceWant | null;
  held: boolean;
  guard: Reason[];
  sel: Selection;
  selCtx: SelectionCtx;
  idx: PlantIndex;
  inputs: InputSnapshot;
  tout10: number | null;
  setpointC: number | null;
  energyActive: boolean;
  counts: boolean;
  runtime: number;
  conditions: ConditionItemResult[];
  emitterOpen: Record<Id, boolean>;
}

/** The mode a source would serve now when idle (for its blockers): the season's mode it can do. */
function idleMode(s: SourceConfig, season: SelectionCtx['season']): SourceMode {
  const prefersCool = season.season === 'cooling';
  if (prefersCool && s.capabilities.cool) return 'cool';
  if (s.capabilities.heat) return 'heat';
  if (s.capabilities.cool) return 'cool';
  return s.capabilities.dry ? 'dry' : 'fan';
}

function roleOf(s: SourceConfig, x: SourceStateInput): { role: SourceRole; reason: Reason } {
  if (x.want && x.m.on) return { role: x.want.role, reason: x.want.roleReason };
  const cfg = x.idx.cfg;
  if (s.scope === 'room') {
    const d = x.idx.direct.get(s.id)?.[0];
    if (!d) return { role: 'unused', reason: { code: 'role.unused', params: {} } };
    const mode: Mode = x.selCtx.season.season === 'cooling' && d.emitter.roles.cool !== null ? 'cool' : d.emitter.roles.heat !== null ? 'heat' : 'cool';
    const role = d.emitter.roles[mode];
    if (role === 'trigger') return { role: 'trigger_only', reason: { code: 'role.trigger_only', params: { triggerId: firstTrigger(s) } } };
    if (role === 'assist') return { role: 'assist', reason: { code: 'role.assist', params: {} } };
    return { role: 'room_primary', reason: { code: 'role.room_primary', params: { roomId: d.room.id } } };
  }
  // central: the chain decides; below the bivalence point the reserve takes the heat pump's place
  for (const plan of x.sel.plans.values()) {
    const b = plan.bivalent;
    if (!b.applies) continue;
    if (b.hp === s.id && !b.hpPermitted) {
      const pointC = b.mode === 'partial' ? cfg.heat.bivalence.hpLimitC : cfg.heat.bivalence.pointC;
      return { role: 'reserve', reason: { code: 'source.blocked.bivalence', params: { pointC, toutC: x.tout10 } } };
    }
    if (b.reserve === s.id) {
      if (!b.hpPermitted) return { role: 'lead', reason: { code: 'role.lead', params: {} } };
      if (b.mode === 'alt') return { role: 'reserve', reason: { code: 'role.reserve_below', params: { pointC: cfg.heat.bivalence.pointC } } };
      return { role: 'reserve', reason: { code: 'role.reserve', params: {} } };
    }
  }
  const chain = [...cfg.heat.chain, ...cfg.cool.chain].filter((e) => e.enabled);
  const at = chain.findIndex((e) => e.sourceIds.includes(s.id));
  const inAny = cfg.heat.chain.some((e) => e.sourceIds.includes(s.id)) || cfg.cool.chain.some((e) => e.sourceIds.includes(s.id));
  if (!inAny && !(x.idx.fedCircuits.get(s.id)?.length ?? 0)) return { role: 'unused', reason: { code: 'role.unused', params: {} } };
  const heatFirst = cfg.heat.chain.find((e) => e.enabled)?.sourceIds.includes(s.id) ?? false;
  const coolFirst = cfg.cool.chain.find((e) => e.enabled && e.sourceIds.some((id) => x.idx.source.get(id)?.scope === 'central'))?.sourceIds.includes(s.id) ?? false;
  if (heatFirst || coolFirst || at < 0) return { role: 'lead', reason: { code: 'role.lead', params: {} } };
  return { role: 'reserve', reason: { code: 'role.reserve', params: {} } };
}

function sourceStateOf(s: SourceConfig, x: SourceStateInput): SourceState {
  const { m, h, inputs } = x;
  const now = inputs.now;
  const cfg = x.idx.cfg;
  const lock = activeLock(cfg, s.id, now);
  const mode = m.on ? m.mode : idleMode(s, x.selCtx.season);
  const el = mode ? eligibility(s, mode, x.selCtx) : { ok: true, hold: false, incapable: true, blockers: [] as Reason[] };
  const dir = x.sel.hp.get(s.id)?.blocker ?? null;
  // a heat pump held off below the bivalent point says so (the selection keeps that reason per circuit)
  const biv = [...x.sel.plans.values()].find((p) => p.bivalent.applies && p.bivalent.hp === s.id && !p.bivalent.hpPermitted);
  const bivPointC = biv?.bivalent.mode === 'partial' ? cfg.heat.bivalence.hpLimitC : cfg.heat.bivalence.pointC;
  const bivBlocker: Reason[] = biv && !m.on ? [{ code: 'source.blocked.bivalence', params: { pointC: bivPointC, toutC: x.tout10 } }] : [];
  const seen = new Set<string>();
  const blockers = [...x.guard, ...(dir ? [dir] : []), ...(m.on ? [] : el.blockers), ...bivBlocker].filter((b) => {
    if (seen.has(b.code)) return false;
    seen.add(b.code);
    return true;
  });
  const testing = !!m.test && (m.test.result === 'running' || m.test.result === 'ok') && now < m.test.until;
  const room = s.scope === 'room' ? x.idx.direct.get(s.id)?.[0]?.room : undefined;

  let state: SourceStateKind;
  if (!s.enabled || h.unbound) state = 'disabled';
  else if (lock?.kind === 'source_off' && !m.on) state = 'disabled';
  else if (testing) state = 'testing';
  else if (m.fault) state = m.fault.code === 'unavailable' ? 'unavailable' : 'fault';
  else if (!h.available) state = 'unavailable';
  else if (m.on) {
    if (h.defrost) state = 'defrost';
    else if (m.confirm === 'pending') state = 'starting';
    else if (x.held && !x.want) state = 'stopping';
    else state = m.mode === 'cool' ? 'cooling' : m.mode === 'dry' ? 'drying' : m.mode === 'fan' ? 'fan' : 'heating';
  } else if (x.want) state = 'waiting_guard';
  else if (room?.paused) state = 'paused';
  else if (blockers.some((b) => b.code === 'source.blocked.trigger' || b.code === 'source.blocked.condition')) state = 'waiting_trigger';
  else if (blockers.some((b) => b.code === 'source.blocked.season' || b.code === 'source.blocked.cutoff' || b.code === 'source.blocked.bivalence')) state = 'waiting_season';
  else state = 'idle';

  const { role, reason: roleReason } = roleOf(s, x);
  if (state === 'idle' && role === 'reserve') state = 'standby';

  let detail: Reason;
  if (testing && m.test) detail = { code: 'source.detail.test', params: { until: m.test.until } };
  else if (lock?.kind === 'source_force' && lock.value.kind === 'source_force') detail = { code: 'source.detail.forced', params: { mode: lock.value.mode, until: lock.until } };
  else if (m.on && h.defrost) detail = { code: 'source.detail.defrost', params: { since: m.onSince } };
  else if (m.on && m.confirm === 'pending') detail = { code: 'source.detail.confirming', params: { mode: m.mode, deadline: m.confirmDeadline } };
  else if (m.on && s.adapter.type === 'relay' && s.adapter.stages.length) detail = { code: 'source.detail.stage', params: { stage: m.stage, of: s.adapter.stages.length + 1 } };
  else if (m.on) detail = { code: 'source.detail.running', params: { mode: m.mode, since: m.onSince, flowC: x.setpointC } };
  else detail = blockers[0] ?? { code: 'source.detail.idle', params: {} };

  const climate = s.adapter.type === 'climate' ? s.adapter : null;
  const fedSupply = (x.idx.fedCircuits.get(s.id) ?? []).map((c) => numOf(snapOf(inputs, c.supply.sensorEntityId))).find((v) => v !== null) ?? null;
  const measuredKw = kwOf(snapOf(inputs, s.energy.powerEntityId));
  const confirmPower = s.adapter.confirm.kind === 'power_above' ? powerW(snapOf(inputs, s.adapter.confirm.entityId)) : null;
  const powerKw = m.on ? runningKw(s, m, inputs) : measuredKw ?? (confirmPower !== null ? round2(confirmPower / 1000) : null);
  const servingRooms = new Set<Id>(m.on ? (x.want?.roomIds ?? []) : []);
  if (m.on) for (const d of x.idx.direct.get(s.id) ?? []) servingRooms.add(d.room.id);
  if (m.on && isHeatCool(m.mode)) {
    for (const c of x.idx.fedCircuits.get(s.id) ?? []) for (const { room, emitter } of x.idx.members.get(c.id) ?? []) if (x.emitterOpen[emitter.id]) servingRooms.add(room.id);
  }
  const fault = m.fault ? { ...m.fault } : null;
  return {
    sourceId: s.id,
    state,
    tone: toneOfState(state, m.mode),
    role,
    roleReason,
    detail,
    on: m.on,
    mode: m.mode,
    since: m.on ? m.onSince : m.offSince,
    confirm: m.confirm,
    available: h.available,
    blockers,
    conditions: x.conditions.map((c) => ({ itemId: c.item.id, mode: c.item.mode, eval: c.eval })),
    telemetry: {
      supplyC: climate ? (numOf(snapOf(inputs, climate.supplyTempEntityId)) ?? fedSupply) : fedSupply,
      flowSetpointC: m.on ? x.setpointC : null,
      powerKw: powerKw === null ? null : round2(powerKw),
      cop: climate ? numOf(snapOf(inputs, climate.copEntityId)) : null,
      defrost: climate ? h.defrost : null,
      errorCode: deviceError(s, inputs),
      stage: s.adapter.type === 'relay' && s.adapter.stages.length ? m.stage : null,
    },
    bindings: bindingsOf(s, inputs),
    servingCircuitIds: m.on ? [...(x.want?.circuitIds ?? [])] : [],
    servingRoomIds: [...servingRooms],
    todayRuntimeMin: x.runtime,
    startsLastHour: recentStarts(m, now).length,
    admittedKw: x.energyActive && x.counts && m.on ? round2(runningKw(s, m, inputs)) : null,
    fault,
    test: m.test,
    lock: lock && (lock.value.kind === 'source_off' || lock.value.kind === 'source_force') ? { kind: lock.value.kind, until: lock.until, mode: lock.value.kind === 'source_force' ? lock.value.mode : null, by: lock.by } : null,
  };
}

/* ── «Чому саме так» ──────────────────────────────────────────────────────────────────────────── */

function plantWhy(
  cfg: EngineConfig,
  plant: PlantState,
  x: { sel: Selection; pair: { hpId: Id; reserveId: Id } | null; ctx: Parameters<PlantStepFn>[2]; tout10: number | null; toutForCurve: number | null; mem: Record<Id, SourceMemory>; idx: PlantIndex; blind: boolean; cutoff: boolean },
): Reason[] {
  const out: Reason[] = [];
  const season = x.ctx.season;
  if (x.blind) out.push({ code: 'plant.blind', params: { since: null } });
  if (season.houseMode === 'off') out.push({ code: 'plant.house_off', params: {} });
  else out.push({ code: 'plant.season', params: { season: season.season, avgC: season.avgC } });
  const plans = [...x.sel.plans.values()];
  for (const p of plans) if (p.frostFallback) out.push({ code: 'plant.frost_fallback', params: { sourceId: p.frostFallback, roomId: p.heatCallers.find((k) => k.frost)?.room.id ?? null } });
  for (const p of plans) {
    if (p.failover && p.lead && x.mem[p.lead]?.on) {
      out.push({ code: 'plant.failover', params: { from: p.failover.from, to: p.lead, code: p.failover.code } });
      break;
    }
  }
  if (plant.lead.heat) {
    out.push({ code: 'plant.lead', params: { sourceId: plant.lead.heat, mode: 'heat', toutC: x.tout10 } });
    const lead = x.idx.source.get(plant.lead.heat);
    if (lead?.adapter.type === 'climate' && lead.adapter.setpoint === 'flow_curve' && lead.curves.heat && x.toutForCurve !== null) {
      out.push({ code: 'plant.flow_curve', params: { toutC: x.toutForCurve, flowC: flowFromCurve(lead.curves.heat, x.toutForCurve) } });
    }
  }
  const bp = plans.find((p) => p.bivalent.applies);
  if (bp && plant.heatDemand) {
    const pointC = cfg.heat.bivalence.mode === 'partial' ? cfg.heat.bivalence.hpLimitC : cfg.heat.bivalence.pointC;
    // below the point the reserve takes over; above it the heat pump copes alone
    if (!bp.bivalent.hpPermitted && bp.bivalent.reserve) out.push({ code: 'plant.bivalent_reserve', params: { sourceId: bp.bivalent.reserve, pointC } });
    else if (bp.bivalent.hpPermitted && !bp.bivalent.reserveJoins) out.push({ code: 'plant.bivalent_hp', params: { pointC, toutC: x.tout10 } });
  }
  if (plant.bivalent.lagActive && x.pair) out.push({ code: 'plant.lag', params: { sourceId: x.pair.reserveId, minutes: cfg.heat.lag.forMin } });
  if (plant.lead.cool) out.push({ code: 'plant.lead', params: { sourceId: plant.lead.cool, mode: 'cool', toutC: x.tout10 } });
  for (const p of plans) {
    const hold = p.dew.hold;
    if (hold) {
      out.push(hold.kind === 'lockout' ? { code: 'plant.dew_lockout', params: { circuitId: p.circuit.id, until: hold.until, trips: hold.trips } } : { code: 'plant.dew_hold', params: { circuitId: p.circuit.id, until: hold.until } });
      break;
    }
    if (p.dew.blocked || p.dew.tripped) {
      out.push({ code: 'plant.dew_guard', params: { circuitId: p.circuit.id, dewC: p.dew.maxDewC, supplyC: p.dew.supplySpC } });
      break;
    }
  }
  if (x.cutoff && plant.heatDemand) out.push({ code: 'plant.cutoff', params: { toutC: x.tout10, cutoffC: cfg.heat.heatingCutoffOutdoorC } });
  if (x.ctx.energyActive) out.push({ code: 'plant.budget', params: { usedKw: plant.energy.usedKw, budgetKw: plant.energy.budgetKw } });
  const rule = x.ctx.overlay.activeRuleIds[0];
  if (rule) out.push({ code: 'plant.rule_active', params: { ruleId: rule } });
  const guardRooms = plans.flatMap((p) => p.heatCallers.filter((k) => k.coldGuard).map((k) => k.room.id)).filter((id, i, a) => a.indexOf(id) === i);
  if (guardRooms.length) out.push({ code: 'plant.neutral_guard', params: { n: guardRooms.length } });
  const acCooling = cfg.sources.filter((s) => s.scope === 'room' && x.mem[s.id]?.on && x.mem[s.id]?.mode === 'cool').length;
  if (acCooling) out.push({ code: 'plant.cool_by_ac', params: { n: acCooling } });
  const trig = plant.triggers.find((t) => t.active && t.triggerId !== 'frost');
  if (trig) out.push({ code: 'plant.trigger_active', params: { triggerId: trig.triggerId } });
  const anyOn = plant.sources.some((s) => s.on);
  if (!anyOn && !plant.heatDemand && !plant.coolDemand) out.push(season.season === 'cooling' ? { code: 'plant.summer_idle', params: {} } : { code: 'plant.no_demand', params: {} });
  return out.slice(0, 6);
}
