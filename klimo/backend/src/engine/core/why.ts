import type {
  EngineConfig,
  Mode,
  Override,
  PlantState,
  Reason,
  RoomConfig,
  RoomMemory,
  RoomServiceVerdict,
  RoomState,
  RoomStateKind,
  Season,
  SourceConfig,
  TrvState,
} from '../../shared/model';
import { idleDrift } from './eta';
import { feedingSources, sourceTriggerId } from './emitters';
import type { LatchPosition, ModeAvailability } from './hysteresis';
import { circuitById } from './hysteresis';

/* =====================================================================================================
 * «Чому гріє / не гріє»: the main sentence comes from the same latch and thresholds that made the
 * decision, so the explanation cannot disagree with the behaviour; the details name who serves the room,
 * the valves, offsets, pre-heat and the ETA.
 * ===================================================================================================== */

export interface WhyInput {
  cfg: EngineConfig;
  room: RoomConfig;
  state: Omit<RoomState, 'issues' | 'why' | 'sync' | 'hvacAction' | 'tone'> & { state: RoomStateKind };
  memory: RoomMemory;
  modes: ModeAvailability;
  latchPos: { heat: LatchPosition; cool: LatchPosition };
  season: Season;
  coldGuardOnly: boolean;
  frostT: number | null;
  off: 'room' | 'profile' | 'frost_only' | null;
  houseOff: boolean;
  overheat: boolean;
  floorLimit: boolean;
  airing: Override | null;
  heldByMinRequest: boolean;
  weatherShiftC: number;
  toutC: number | null;
  virtualDropC: number | null;
  verdict: RoomServiceVerdict;
  plant: PlantState;
  trvs: TrvState[];
  /** The room's cooling is blocked by the circuit's dew-point guard (from the plant). */
  dewBlocked: { dewC: number | null; maxSupplyC: number } | null;
}

function latchReason(mode: Mode, pos: LatchPosition, x: WhyInput): Reason | null {
  const s = x.state;
  const t = s.tempC;
  const th = s.thresholds;
  if (t === null) return null;
  if (mode === 'heat') {
    const T = s.target.heatC;
    if (T === null || th.heatOnC === null || th.heatOffC === null) return null;
    const latched = s.demand.latched.heat;
    if (latched && pos === 'on_threshold') return { code: 'why.heat.below_on', params: { t, on: th.heatOnC, T, b: x.room.tolerance.heat.below } };
    if (pos === 'off_threshold' && !latched) return { code: 'why.heat.above_off', params: { t, off: th.heatOffC } };
    return { code: latched ? 'why.heat.in_band_on' : 'why.heat.in_band_off', params: { t, on: th.heatOnC, off: th.heatOffC } };
  }
  const T = s.target.coolC;
  if (T === null || th.coolOnC === null || th.coolOffC === null) return null;
  const latched = s.demand.latched.cool;
  if (latched && pos === 'on_threshold') return { code: 'why.cool.above_on', params: { t, on: th.coolOnC, T, a: x.room.tolerance.cool.above } };
  if (pos === 'off_threshold' && !latched) return { code: 'why.cool.below_off', params: { t, off: th.coolOffC } };
  return { code: latched ? 'why.cool.in_band_on' : 'why.cool.in_band_off', params: { t, on: th.coolOnC, off: th.coolOffC } };
}

function mainReason(x: WhyInput): Reason {
  const s = x.state;
  const w = s.window;
  if (!x.room.controlEnabled) return { code: 'why.monitor.control_disabled' };
  if (s.demand.frost) return { code: 'why.frost', params: { t: x.frostT, frostC: s.target.frostFloorC } };
  if (s.tempC === null) return { code: 'why.no_data', params: { safeC: x.cfg.safety.noDataTrvSetpointC } };
  if (x.airing) return { code: 'why.airing', params: { until: x.airing.until } };
  if (w.reactionActive && w.reaction === 'pause') return { code: 'why.window.pause', params: { since: w.openSince ?? x.memory.window.reactionSince, resumeAt: w.resumeAt } };
  if (x.houseOff) return { code: 'why.off.house_mode' };
  if (x.off === 'room') return { code: 'why.off.room', params: { until: s.target.until } };
  if (x.off === 'frost_only') return { code: 'why.off.frost_only', params: { profileId: s.target.profileId, frostC: s.target.frostFloorC } };
  if (x.off === 'profile') return { code: 'why.off.profile', params: { profileId: s.target.profileId } };
  if (x.overheat && !s.demand.latched.cool) return { code: 'why.overheat', params: { t: s.tempC, maxC: x.cfg.safety.overheatC } };
  if (w.reactionActive && w.reaction === 'eco') return { code: 'why.window.eco', params: { profileId: x.cfg.settings.ecoProfileId } };
  if (w.reactionActive && w.reaction === 'lower') {
    const sign = s.target.mode === 'cool' ? 1 : -1;
    return { code: 'why.window.lower', params: { deltaC: sign * x.room.windows.lowerByC } };
  }
  if (!s.activeModes.heat && !s.activeModes.cool) {
    if (x.dewBlocked) return { code: 'why.monitor.dew_blocked', params: { dewC: x.dewBlocked.dewC, maxSupplyC: x.dewBlocked.maxSupplyC } };
    const m = x.modes;
    const seasonalMode: Mode | null =
      m.heatBlock === 'season' && (m.coolBlock !== 'season' || x.season !== 'heating') ? 'heat' : m.coolBlock === 'season' || m.coolBlock === 'humid' ? 'cool' : null;
    if (seasonalMode) return { code: 'why.season_blocks', params: { mode: seasonalMode, season: x.season } };
    return { code: 'why.monitor.no_emitter', params: { mode: x.season === 'cooling' ? 'cool' : 'heat' } };
  }
  const t = s.tempC;
  if (s.demand.latched.heat) return latchReason('heat', x.latchPos.heat, x) ?? { code: 'why.monitor.no_emitter', params: { mode: 'heat' } };
  if (s.demand.latched.cool) return latchReason('cool', x.latchPos.cool, x) ?? { code: 'why.monitor.no_emitter', params: { mode: 'cool' } };
  if (s.target.mode === 'dual') return { code: 'why.dual.in_band', params: { t, lo: s.thresholds.heatOnC, hi: s.thresholds.coolOnC } };
  if (s.target.mode === 'heat' || (s.demand.mode === 'heat' && s.activeModes.heat)) return latchReason('heat', x.latchPos.heat, x) ?? { code: 'why.monitor.no_emitter', params: { mode: 'heat' } };
  if (s.target.mode === 'cool' || s.activeModes.cool) return latchReason('cool', x.latchPos.cool, x) ?? { code: 'why.monitor.no_emitter', params: { mode: 'cool' } };
  return { code: 'why.monitor.no_emitter', params: { mode: 'heat' } };
}

function acSourcesOf(x: WhyInput): { source: SourceConfig; role: string | null }[] {
  const out: { source: SourceConfig; role: string | null }[] = [];
  for (const e of x.cfg.emittersByRoom[x.room.id] ?? []) {
    if (!e.enabled || e.kind !== 'direct') continue;
    for (const s of feedingSources(x.cfg, e)) if (s.kind === 'ac') out.push({ source: s, role: e.roles.heat });
  }
  return out;
}

function details(x: WhyInput, main: Reason): Reason[] {
  const s = x.state;
  const out: Reason[] = [];
  const w = s.window;
  if (s.state === 'wait' && x.verdict.waitReason) out.push(x.verdict.waitReason);
  if (x.heldByMinRequest && s.demand.minRequestUntil !== null) out.push({ code: 'why.min_request', params: { until: s.demand.minRequestUntil } });

  if (x.verdict.served && x.verdict.servingSourceIds.length) {
    const id = x.verdict.servingSourceIds[0];
    out.push({ code: 'why.served', params: { sourceId: id, since: x.plant.sources.find((p) => p.sourceId === id)?.since ?? null } });
  }
  if (x.trvs.length) {
    const open = x.trvs.filter((t) => t.activity === 'heating' || t.activity === 'frost').length;
    if (s.demand.mode === 'heat' || open) out.push({ code: 'why.trvs_open', params: { n: open, total: x.trvs.length } });
    else if (s.state === 'window' || s.state === 'off') out.push({ code: 'why.trvs_closed', params: { n: x.trvs.length } });
  }
  for (const { source, role } of acSourcesOf(x)) {
    const st = x.plant.sources.find((p) => p.sourceId === source.id);
    if (!st || !st.on) continue;
    if (st.mode === 'dry') out.push({ code: 'why.ac_dry', params: { sourceId: source.id, rh: s.humidity.valuePct } });
    else if (role === 'assist' && s.demand.assist && s.target.heatC !== null && s.tempC !== null) {
      out.push({ code: 'why.ac_assist', params: { sourceId: source.id, deficitC: Math.round((s.target.heatC - s.tempC) * 10) / 10 } });
    } else out.push({ code: 'why.ac_running', params: { sourceId: source.id, mode: st.mode } });
  }
  for (const e of x.cfg.emittersByRoom[x.room.id] ?? []) {
    if (e.roles.heat !== 'trigger' || !x.verdict.emitterOpen[e.id]) continue;
    const src = feedingSources(x.cfg, e)[0] ?? null;
    if (src) out.push({ code: 'why.trigger_heat', params: { sourceId: src.id, triggerId: sourceTriggerId(src) } });
  }
  if (s.target.preheat) out.push({ code: 'why.preheat', params: { at: s.target.preheat.forBlockAt, profileId: s.target.adjustments.find((a) => a.code === 'optimal_start')?.ref ?? null, T: s.target.heatC } });
  for (const a of s.target.adjustments) if (a.code === 'rule_offset') out.push({ code: 'why.rule_offset', params: { ruleId: a.ref, deltaC: a.deltaC } });
  if (x.weatherShiftC > 0) out.push({ code: 'why.weather_comp', params: { shiftC: x.weatherShiftC, toutC: x.toutC } });
  if (x.floorLimit) out.push({ code: 'why.floor_limit', params: { floorC: s.aggregation.floorC, maxC: x.room.floor.maxFloorC } });
  if (s.aggregation.fallback === 'trv') out.push({ code: 'why.fallback_trv', params: { n: s.aggregation.trvValues.length } });
  if (x.coldGuardOnly && s.demand.mode === 'heat' && s.tempC !== null && s.target.heatC !== null) {
    const guardC = Math.round((s.target.heatC - x.room.tolerance.heat.below - x.cfg.season.neutralColdGuardC) * 10) / 10;
    const central = (x.cfg.emittersByRoom[x.room.id] ?? []).some((e) => e.enabled && e.circuitId && e.roles.heat !== null && circuitById(x.cfg, e.circuitId));
    if (central && s.tempC <= guardC) out.push({ code: 'why.cold_guard', params: { t: s.tempC, guardC } });
  }

  if (w.virtual && main.code !== 'why.window.pause') out.push({ code: 'why.window.virtual', params: { dropC: x.virtualDropC ?? x.room.windows.tempDrop.dropC } });
  if (w.ignoredUntil !== null || (w.anyOpen && x.cfg.overrides.some((o) => o.scope === 'room' && o.subjectId === x.room.id && o.kind === 'room_window_ignore'))) {
    out.push({ code: 'why.window.ignored', params: { until: w.ignoredUntil } });
  } else if (w.reactionAt !== null) out.push({ code: 'why.window.delay', params: { at: w.reactionAt } });
  else if (w.resumeAt !== null && main.code !== 'why.window.pause') out.push({ code: 'why.window.resuming', params: { at: w.resumeAt } });
  if (w.reactionActive && w.reaction === 'notify') out.push({ code: 'why.window.notify', params: { since: w.openSince } });

  if (s.eta) out.push({ code: 'why.eta.reach', params: { minutes: s.eta.minutes, at: s.eta.at, toC: s.eta.toC, confident: s.eta.confident } });
  else if (s.demand.mode === 'none' && s.tempC !== null && x.room.controlEnabled) {
    const drift = idleDrift(x.memory.learned);
    if (drift) out.push(drift);
  }
  return out;
}

/** RoomState.why: the main sentence first, then the details. */
export function roomWhy(x: WhyInput): Reason[] {
  const main = mainReason(x);
  return [main, ...details(x, main)];
}
