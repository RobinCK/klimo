import type {
  EnergyPolicy,
  EnergyState,
  EngineConfig,
  EntitySnap,
  EpochMs,
  Id,
  InputSnapshot,
  Reason,
  RuleOverlay,
  SourceConfig,
  SourceMemory,
  TriggerState,
} from '../../shared/model';
import { numOf, referencedTriggers, snapOf } from './conditions';

/* =====================================================================================================
 * Blackout budget. While the grid is down (the energy gate), every electric heat or cold source that
 * counts in the budget must fit into what the inverter and battery can give: starts are admitted one
 * at a time, 30 s apart, most important first; when the load grows over the budget the least important
 * source is shed. Below the critical battery level only frost protection may run.
 * ===================================================================================================== */

const SEC = 1000;
/** Load must exceed the budget by this much, for this long, before something is shed. */
const SHED_HYSTERESIS_KW = 0.2;
const SHED_AFTER_MS = 30 * SEC;
/** Over this multiple of the budget, shedding ignores the minimum run time. */
const EMERGENCY_FACTOR = 1.25;
/** «нічний тариф з 23:00» is shown when such a window opens within this horizon. */
const TARIFF_HORIZON_MS = 6 * 3_600_000;

export type EnergyPhase = EnergyState['phase'];

export interface EnergyReadings {
  configured: boolean;
  grid: EnergyState['grid'];
  pvKw: number | null;
  soc: number | null;
  houseLoadKw: number | null;
}

/** Power in kW from a sensor reporting W or kW. */
export function kwOf(snap: EntitySnap | null): number | null {
  const v = numOf(snap);
  if (v === null || !snap) return null;
  const unit = String(snap.attrs.unit_of_measurement ?? 'W').toLowerCase();
  if (unit === 'kw') return v;
  if (unit === 'mw') return v * 1000;
  return v / 1000;
}

export function readEnergy(cfg: EngineConfig, inputs: InputSnapshot): EnergyReadings {
  const e = cfg.energy.entities;
  const grid = snapOf(inputs, e.gridOffline);
  let gridState: EnergyState['grid'] = 'unknown';
  if (grid && grid.available) gridState = grid.state === 'on' ? 'absent' : grid.state === 'off' ? 'present' : 'unknown';
  return {
    configured: !!(e.gridOffline || e.batterySoc || e.pvPower),
    grid: gridState,
    pvKw: kwOf(snapOf(inputs, e.pvPower)),
    soc: numOf(snapOf(inputs, e.batterySoc)),
    houseLoadKw: kwOf(snapOf(inputs, e.houseLoad)),
  };
}

/** Nominal draw of a source with `stage` stages on (stage 1 = the source itself); gas counts its electronics only. */
export function nominalKw(s: SourceConfig, stage = 1): number {
  if (s.energy.carrier === 'gas') return s.energy.auxPowerKw;
  let kw = s.energy.maxPowerKw;
  if (s.adapter.type === 'relay') for (let i = 0; i < stage - 1 && i < s.adapter.stages.length; i++) kw += s.adapter.stages[i].powerKw;
  return kw;
}

/** What a running source draws now: its meter when it has one, else the nominal power of its stages. */
export function runningKw(s: SourceConfig, m: SourceMemory, inputs: InputSnapshot): number {
  if (!m.on) return 0;
  if (s.energy.carrier === 'gas') return s.energy.auxPowerKw;
  const measured = kwOf(snapOf(inputs, s.energy.powerEntityId));
  return measured ?? nominalKw(s, Math.max(1, m.stage));
}

/** Exempt sources (gas boilers) run outside the budget while the battery holds above the exempt level. */
export function exemptActive(policy: EnergyPolicy, soc: number | null): boolean {
  return soc === null || soc > policy.exempt.whileSocAbovePct;
}

export function countsInBudget(s: SourceConfig, policy: EnergyPolicy, exempt: boolean): boolean {
  if (!s.energy.countsInBlackoutBudget) return false;
  return !(exempt && policy.exempt.sourceIds.includes(s.id));
}

/** Shed order: the user's, then the default ranking for budgeted sources it does not name. */
export function shedOrderOf(cfg: EngineConfig): Id[] {
  const known = new Set(cfg.sources.map((s) => s.id));
  const out = cfg.energy.shedOrder.filter((id) => known.has(id));
  const rank = (s: SourceConfig) => {
    if (s.scope === 'room' && s.kind !== 'ac') return 0; // room electric heaters
    if (s.kind === 'ac') return 1;
    if (s.kind === 'heat_pump') return 2;
    if (s.kind === 'electric_boiler') return 3;
    return 4;
  };
  const rest = cfg.sources
    .filter((s) => !out.includes(s.id) && s.energy.countsInBlackoutBudget)
    .sort((a, b) => rank(a) - rank(b) || a.order - b.order);
  return [...out, ...rest.map((s) => s.id)];
}

export function energyPhase(active: boolean, soc: number | null, policy: EnergyPolicy, economy: boolean): EnergyPhase {
  if (!active) return 'normal';
  if (soc !== null && soc <= policy.criticalSocPct) return 'critical';
  return economy ? 'economy' : 'blackout';
}

/** Effective budget: the policy, a rule's power cap, and what the inverter has left after the house's own load. */
export function effectiveBudget(policy: EnergyPolicy, overlay: RuleOverlay, houseLoadKw: number | null, klimoLoadKw: number): number {
  let budget = policy.budgetKw;
  if (overlay.powerCapKw !== null) budget = Math.min(budget, overlay.powerCapKw);
  if (policy.inverterMaxKw !== null) budget = Math.min(budget, policy.inverterMaxKw - Math.max(0, (houseLoadKw ?? 0) - klimoLoadKw));
  return Math.max(0, Math.round(budget * 100) / 100);
}

export interface Admission {
  admitted: Set<Id>;
  blocked: Map<Id, Reason>;
  lastAdmissionAt: EpochMs | null;
  loadKw: number;
}

/**
 * Admits pending starts of budgeted sources: the most important first (last in the shed order), each
 * only if it fits, at most one per stagger interval.
 */
export function admitStarts(
  pending: readonly { s: SourceConfig; kw: number }[],
  x: { loadKw: number; budgetKw: number; lastAdmissionAt: EpochMs | null; now: EpochMs; staggerSec: number; shedOrder: readonly Id[] },
): Admission {
  const admitted = new Set<Id>();
  const blocked = new Map<Id, Reason>();
  let last = x.lastAdmissionAt;
  let load = x.loadKw;
  const importance = (id: Id) => {
    const i = x.shedOrder.indexOf(id);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const ordered = [...pending].sort((a, b) => importance(b.s.id) - importance(a.s.id));
  for (const { s, kw } of ordered) {
    const stagger = (s.energy.staggerSec ?? x.staggerSec) * SEC;
    if (load + kw > x.budgetKw + 1e-9) {
      blocked.set(s.id, { code: 'source.blocked.budget', params: { usedKw: round2(load), budgetKw: x.budgetKw, needKw: round2(kw) } });
    } else if (last !== null && x.now - last < stagger) {
      blocked.set(s.id, { code: 'source.blocked.stagger', params: { until: last + stagger } });
    } else {
      admitted.add(s.id);
      load += kw;
      last = x.now;
    }
  }
  return { admitted, blocked, lastAdmissionAt: last, loadKw: load };
}

export interface ShedResult {
  shedId: Id | null;
  /** Over the emergency level: the shed ignores the minimum run time. */
  emergency: boolean;
  overSince: EpochMs | null;
  lastShedAt: EpochMs | null;
}

/** One shedding step: the first running source in the shed order goes when the load stays over budget. */
export function shedStep(
  running: readonly { id: Id; minRunOk: boolean }[],
  x: { loadKw: number; budgetKw: number; overSince: EpochMs | null; lastShedAt: EpochMs | null; now: EpochMs; staggerSec: number; shedOrder: readonly Id[] },
): ShedResult {
  const over = x.loadKw > x.budgetKw + SHED_HYSTERESIS_KW;
  const overSince = over ? (x.overSince ?? x.now) : null;
  const emergency = x.loadKw > EMERGENCY_FACTOR * x.budgetKw;
  if (!over || overSince === null || x.now - overSince < SHED_AFTER_MS) return { shedId: null, emergency: false, overSince, lastShedAt: x.lastShedAt };
  if (x.lastShedAt !== null && x.now - x.lastShedAt < x.staggerSec * SEC) return { shedId: null, emergency: false, overSince, lastShedAt: x.lastShedAt };
  for (const id of x.shedOrder) {
    const r = running.find((c) => c.id === id);
    if (r && (emergency || r.minRunOk)) return { shedId: id, emergency, overSince, lastShedAt: x.now };
  }
  return { shedId: null, emergency: false, overSince, lastShedAt: x.lastShedAt };
}

export function isEmergency(loadKw: number, budgetKw: number): boolean {
  return loadKw > EMERGENCY_FACTOR * budgetKw;
}

/** One line under the energy card: grid fine, budget use, economy, critical, solar diverted, tariff ahead. */
export function energyNote(
  cfg: EngineConfig,
  x: {
    readings: EnergyReadings;
    active: boolean;
    phase: EnergyPhase;
    usedKw: number;
    budgetKw: number | null;
    solarMode: 'heat' | 'cool' | null;
    triggers: readonly TriggerState[];
    now: EpochMs;
  },
): Reason {
  if (x.solarMode) return { code: x.solarMode === 'heat' ? 'energy.solar_to_heat' : 'energy.solar_to_cold', params: { pvKw: x.readings.pvKw } };
  if (x.active) {
    if (x.phase === 'critical') return { code: 'energy.critical', params: { soc: x.readings.soc } };
    if (x.phase === 'economy') return { code: 'energy.economy', params: { soc: x.readings.soc } };
    return { code: 'energy.budget_used', params: { usedKw: round2(x.usedKw), budgetKw: x.budgetKw } };
  }
  if (!x.readings.configured) return { code: 'energy.not_configured', params: {} };
  // a time trigger used by a rule that opens soon («нічний тариф з 23:00»)
  const ruleTriggers = new Set<Id>();
  for (const r of cfg.rules) if (r.enabled) for (const id of referencedTriggers(r.when)) ruleTriggers.add(id);
  let at: EpochMs | null = null;
  for (const t of x.triggers) {
    if (!ruleTriggers.has(t.triggerId) || t.active || t.nextChangeAt === null) continue;
    if (t.nextChangeAt - x.now <= TARIFF_HORIZON_MS && (at === null || t.nextChangeAt < at)) at = t.nextChangeAt;
  }
  if (at !== null) return { code: 'energy.night_tariff_at', params: { at } };
  return { code: 'energy.grid_ok', params: {} };
}

export function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
