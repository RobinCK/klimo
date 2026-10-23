/**
 * Renderers for the codes the backend sends instead of sentences: reasons («чому гріє»,
 * previews, blockers), journal entries and room issues. Each table is exhaustive over its
 * code union, so a code added to the model without wording here fails to compile.
 * Ids inside params are resolved to names through the context (the live store provides one);
 * without a name the id itself is shown.
 */
import type {
  EpochMs,
  EventKind,
  HouseMode,
  Id,
  IssueCode,
  JournalCode,
  JournalEntry,
  Mode,
  OverrideKind,
  PumpReason,
  PumpStateKind,
  Reason,
  ReasonCode,
  ReasonParams,
  RoomIssue,
  Season,
  SourceFaultCode,
  SourceMode,
  SourceStateKind,
  TrvManualPolicy,
  WindowReaction,
  ConfigEntityName,
  EnergyCarrier,
} from '@api/model';
import { t } from './core';
import { fmtClock, fmtDelta, fmtDur, fmtDurSec, fmtIn, fmtKw, fmtKwh, fmtNum, fmtPct, fmtRate, fmtSince, fmtTemp, fmtUntil, nowMs } from './format';
import {
  actorViaLabel,
  configEntityLabel,
  energyCarrierLabel,
  eventKindLabel,
  houseModeLabel,
  modeLabel,
  overrideKindLabel,
  pumpReasonLabel,
  pumpStateLabel,
  seasonLabel,
  sourceFaultLabel,
  sourceModeLabel,
  sourceStateLabel,
  targetLayerLabel,
  trvManualPolicyLabel,
  windowReactionLabel,
} from './labels';

/** Name lookups for ids found in params; every function is optional. */
export interface CodeContext {
  room?: (id: Id) => string | undefined;
  source?: (id: Id) => string | undefined;
  profile?: (id: Id) => string | undefined;
  trigger?: (id: Id) => string | undefined;
  rule?: (id: Id) => string | undefined;
  circuit?: (id: Id) => string | undefined;
  pump?: (id: Id) => string | undefined;
  /** HA device key or emitter device id → a display name. */
  device?: (keyOrId: string) => string | undefined;
  /** Entity id → its friendly name. */
  entity?: (entityId: string) => string | undefined;
  /** Zigbee2MQTT instance id → its name. */
  instance?: (id: Id) => string | undefined;
  /** Server-aligned now, for «через 2 хв». */
  now?: EpochMs;
}

type P = ReasonParams;
type Ctx = CodeContext;

const num = (p: P, k: string): number | null => {
  const v = p[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
};
const str = (p: P, k: string): string | null => {
  const v = p[k];
  return v == null || v === '' ? null : String(v);
};

const temp = (p: P, k: string) => fmtTemp(num(p, k));
const delta = (p: P, k: string) => fmtDelta(num(p, k));
const signed = (p: P, k: string) => fmtDelta(num(p, k), { sign: true });
const clock = (p: P, k: string, c: Ctx) => fmtClock(num(p, k), c.now ?? nowMs());
const until = (p: P, k: string, c: Ctx) => fmtUntil(num(p, k), c.now ?? nowMs());
const inn = (p: P, k: string, c: Ctx) => fmtIn(num(p, k), c.now ?? nowMs());
const pct = (p: P, k: string) => fmtPct(num(p, k));
const kw = (p: P, k: string) => fmtKw(num(p, k));

function lookup(fn: ((id: string) => string | undefined) | undefined, id: string | null): string {
  if (!id) return '—';
  return fn?.(id) ?? id;
}
const room = (p: P, c: Ctx, k = 'roomId') => lookup(c.room, str(p, k));
const source = (p: P, c: Ctx, k = 'sourceId') => lookup(c.source, str(p, k));
const profile = (p: P, c: Ctx, k = 'profileId') => lookup(c.profile, str(p, k));
const trigger = (p: P, c: Ctx, k = 'triggerId') => lookup(c.trigger, str(p, k));
const rule = (p: P, c: Ctx, k = 'ruleId') => lookup(c.rule, str(p, k));
const circuit = (p: P, c: Ctx, k = 'circuitId') => lookup(c.circuit, str(p, k));
const entity = (p: P, c: Ctx, k = 'entityId') => lookup(c.entity, str(p, k));

const isMode = (v: string | null): v is Mode => v === 'heat' || v === 'cool';
const sourceMode = (p: P, k = 'mode') => {
  const m = str(p, k);
  return m && ['heat', 'cool', 'dry', 'fan'].includes(m) ? sourceModeLabel(m as SourceMode) : (m ?? '—');
};
const season = (p: P, k = 'season') => {
  const s = str(p, k);
  return s && ['heating', 'neutral', 'cooling'].includes(s) ? seasonLabel(s as Season) : (s ?? '—');
};
const fault = (p: P, k = 'code') => {
  const f = str(p, k);
  return f && ['no_confirm', 'unavailable', 'device_error', 'relay_mismatch', 'not_turned_off'].includes(f)
    ? sourceFaultLabel(f as SourceFaultCode)
    : (f ?? '—');
};

/* ======================================== reasons ======================================== */

const REASONS: Record<ReasonCode, (p: P, c: Ctx) => string> = {
  // room why: latch
  'why.heat.below_on': (p) =>
    t('{t} ≤ {on} (target {T} − {b}) — the room asks for heat.', { t: temp(p, 't'), on: temp(p, 'on'), T: temp(p, 'T'), b: delta(p, 'b') }),
  'why.heat.in_band_on': (p) => t('{t} is within {on}–{off}: heating until it reaches {off}.', { t: temp(p, 't'), on: temp(p, 'on'), off: temp(p, 'off') }),
  'why.heat.in_band_off': (p) => t('{t} is within {on}–{off}: heating starts again at {on}.', { t: temp(p, 't'), on: temp(p, 'on'), off: temp(p, 'off') }),
  'why.heat.above_off': (p) => t('{t} ≥ {off} — warm enough.', { t: temp(p, 't'), off: temp(p, 'off') }),
  'why.cool.above_on': (p) =>
    t('{t} ≥ {on} (target {T} + {a}) — the room asks for cooling.', { t: temp(p, 't'), on: temp(p, 'on'), T: temp(p, 'T'), a: delta(p, 'a') }),
  'why.cool.in_band_on': (p) => t('{t} is within {off}–{on}: cooling until it reaches {off}.', { t: temp(p, 't'), on: temp(p, 'on'), off: temp(p, 'off') }),
  'why.cool.in_band_off': (p) => t('{t} is within {off}–{on}: cooling starts again at {on}.', { t: temp(p, 't'), on: temp(p, 'on'), off: temp(p, 'off') }),
  'why.cool.below_off': (p) => t('{t} ≤ {off} — cool enough.', { t: temp(p, 't'), off: temp(p, 'off') }),
  'why.dual.in_band': (p) => t('{t} is between {lo} and {hi} — nothing needs to run.', { t: temp(p, 't'), lo: temp(p, 'lo'), hi: temp(p, 'hi') }),
  'why.cold_guard': (p) => t('Between seasons, but {t} is below {guard} — heating anyway.', { t: temp(p, 't'), guard: temp(p, 'guardC') }),
  // room why: states
  'why.no_data': (p) => t('No temperature data — the radiator valves hold a safe {safe}.', { safe: temp(p, 'safeC') }),
  'why.fallback_trv': (p) => t('All room sensors are offline — using the radiator valves’ own readings ({n}).', { n: num(p, 'n') ?? 0 }),
  'why.window.pause': (p, c) =>
    num(p, 'resumeAt') != null
      ? t('Window open since {since} — paused, resuming at {at}.', { since: clock(p, 'since', c), at: clock(p, 'resumeAt', c) })
      : t('Window open since {since} — heating and cooling paused.', { since: clock(p, 'since', c) }),
  'why.window.eco': (p, c) => t('Window open — using the «{profile}» target.', { profile: profile(p, c) }),
  'why.window.lower': (p) =>
    (num(p, 'deltaC') ?? 0) > 0
      ? t('Window open — target raised by {delta}.', { delta: delta(p, 'deltaC') })
      : t('Window open — target lowered by {delta}.', { delta: delta(p, 'deltaC') }),
  'why.window.notify': (p, c) => t('Window open since {since} — only a reminder will be sent.', { since: clock(p, 'since', c) }),
  'why.window.delay': (p, c) => t('Window open — pausing at {at} if it stays open.', { at: clock(p, 'at', c) }),
  'why.window.resuming': (p, c) => t('Windows closed — resuming at {at}.', { at: clock(p, 'at', c) }),
  'why.window.ignored': (p, c) => t('The window is ignored {until}.', { until: until(p, 'until', c) }),
  'why.window.virtual': (p) => t('The temperature dropped {drop} within minutes — treated as an open window.', { drop: delta(p, 'dropC') }),
  'why.airing': (p, c) => t('Airing — paused {until}.', { until: until(p, 'until', c) }),
  'why.off.room': (p, c) => t('The room is switched off {until}.', { until: until(p, 'until', c) }),
  'why.off.profile': (p, c) => t('Off in «{profile}».', { profile: profile(p, c) }),
  'why.off.house_mode': () => t('The house is switched off — only frost protection works.'),
  'why.off.frost_only': (p, c) => t('«{profile}»: frost protection only ({frost}).', { profile: profile(p, c), frost: temp(p, 'frostC') }),
  'why.frost': (p) => t('{t} is below the frost limit {frost} — heating to protect the room.', { t: temp(p, 't'), frost: temp(p, 'frostC') }),
  'why.overheat': (p) => t('{t} is above {max} — heating in the room is closed.', { t: temp(p, 't'), max: temp(p, 'maxC') }),
  'why.monitor.control_disabled': () => t('Monitoring only — control is switched off for this room.'),
  'why.monitor.no_emitter': (p) => (str(p, 'mode') === 'cool' ? t('Nothing in this room can cool.') : t('Nothing in this room can heat.')),
  'why.monitor.dew_blocked': (p) =>
    t('Floor cooling is blocked — at the dew point {dew} the water would have to be warmer than {max}.', {
      dew: temp(p, 'dewC'),
      max: temp(p, 'maxSupplyC'),
    }),
  'why.monitor.too_humid': (p) =>
    t('Floor cooling is off — humidity {rh} is above {max}, the floor could sweat.', { rh: pct(p, 'rh'), max: pct(p, 'maxPct') }),
  'why.monitor.humidity_unknown': (p, c) =>
    num(p, 'since') != null
      ? t('Floor cooling is off — no humidity reading since {since}, so the dew point is unknown.', { since: clock(p, 'since', c) })
      : t('Floor cooling is off — no humidity reading, so the dew point is unknown.'),
  'why.monitor.dew_hold': (p, c) => t('Floor cooling rests {until} after the dew point guard stopped it.', { until: until(p, 'until', c) }),
  'why.monitor.dew_lockout': (p, c) =>
    t('Floor cooling is locked {until} or until a reset: the dew point guard stopped it {n} times within 2 h.', { until: until(p, 'until', c), n: num(p, 'trips') ?? 0 }),
  'why.season_blocks': (p) =>
    str(p, 'mode') === 'cool'
      ? t('Cooling is not allowed now ({season}).', { season: season(p) })
      : t('Heating is not allowed now ({season}).', { season: season(p) }),
  // room why: details
  'why.min_request': (p, c) => t('Keeps asking at least {until}.', { until: until(p, 'until', c) }),
  'why.served': (p, c) =>
    num(p, 'since') != null
      ? t('{source} is working since {since}.', { source: source(p, c), since: clock(p, 'since', c) })
      : t('{source} is working.', { source: source(p, c) }),
  'why.trvs_open': (p) => t('Radiator valves open: {n} of {total}.', { n: num(p, 'n') ?? 0, total: num(p, 'total') ?? 0 }),
  'why.rooms_asking': (p) => t('Rooms asking for heat: {n} of {total}.', { n: num(p, 'n') ?? 0, total: num(p, 'total') ?? 0 }),
  'why.trvs_closed': (p) => t('Radiator valves closed ({n}).', { n: num(p, 'n') ?? 0 }),
  'why.ac_running': (p, c) => t('{source} is running: {mode}.', { source: source(p, c), mode: sourceMode(p) }),
  'why.ac_assist': (p, c) => t('{source} helps: the room is {deficit} from its target.', { source: source(p, c), deficit: delta(p, 'deficitC') }),
  'why.ac_dry': (p, c) => t('{source} dries the air — humidity {rh}.', { source: source(p, c), rh: pct(p, 'rh') }),
  'why.trigger_heat': (p, c) => t('{source} heats because «{trigger}» is active.', { source: source(p, c), trigger: trigger(p, c) }),
  'why.preheat': (p, c) => t('Preheating for «{profile}» at {at} ({T}).', { profile: profile(p, c), at: clock(p, 'at', c), T: temp(p, 'T') }),
  'why.rule_offset': (p, c) => t('Rule «{rule}» shifts the target by {delta}.', { rule: rule(p, c), delta: signed(p, 'deltaC') }),
  'why.weather_comp': (p) => t('Outdoor {tout}: the target is corrected by {shift}.', { tout: temp(p, 'toutC'), shift: signed(p, 'shiftC') }),
  'why.floor_limit': (p) => t('The floor is {floor} — at its limit {max}.', { floor: temp(p, 'floorC'), max: temp(p, 'maxC') }),
  'why.eta.reach': (p, c) => {
    const text = t('≈ {dur} to {to} (around {at}).', { dur: fmtDur(num(p, 'minutes')), to: temp(p, 'toC'), at: clock(p, 'at', c) });
    return p.confident === false ? `${text} ${t('A rough estimate for now.')}` : text;
  },
  'why.eta.cooling_down': (p) => t('Cooling down by about {rate}.', { rate: fmtRate(Math.abs(num(p, 'rate') ?? 0), { sign: false }) }),
  'why.eta.warming_up': (p) => t('Warming up by about {rate}.', { rate: fmtRate(Math.abs(num(p, 'rate') ?? 0), { sign: false }) }),
  // waiting for a source
  'wait.min_off': (p, c) => t('{source} is on a pause · starts {in}', { source: source(p, c), in: inn(p, 'until', c) }),
  'wait.max_starts': (p, c) => t('{source} has used its starts for this hour · next {in}', { source: source(p, c), in: inn(p, 'until', c) }),
  'wait.trigger': (p, c) => t('{source} waits for «{trigger}»', { source: source(p, c), trigger: trigger(p, c) }),
  'wait.condition': (p, c) => t('{source} waits for its run condition', { source: source(p, c) }),
  'wait.budget': (p, c) => t('{source} waits for power: {used} of {budget} in use', { source: source(p, c), used: kw(p, 'usedKw'), budget: kw(p, 'budgetKw') }),
  'wait.stagger': (p, c) => t('{source} starts {in} (one after another)', { source: source(p, c), in: inn(p, 'until', c) }),
  'wait.starting': (p, c) => t('{source} is starting', { source: source(p, c) }),
  'wait.prerun': (p, c) => t('The pump runs first · {source} starts {in}', { source: source(p, c), in: inn(p, 'until', c) }),
  'wait.changeover': (p, c) => t('{source} is switching between heating and cooling · {in}', { source: source(p, c), in: inn(p, 'until', c) }),
  'wait.piggyback': () => t('Waits until another room starts a source'),
  'wait.no_source': (p) => (str(p, 'mode') === 'cool' ? t('Nothing can cool right now') : t('Nothing can heat right now')),
  'wait.fault': (p, c) => t('{source} has a fault', { source: source(p, c) }),
  'wait.season': (p) => (str(p, 'mode') === 'cool' ? t('Cooling is off for the season') : t('Heating is off for the season')),
  'wait.lock': (p, c) => t('{source} is switched off {until}', { source: source(p, c), until: until(p, 'until', c) }),
  // target change previews
  'preview.same': () => t('Same target — nothing will be sent'),
  'preview.start_heat': (p, c) =>
    t('Starts heating · ≈ {dur} to {to}, around {at}', { dur: fmtDur(num(p, 'etaMin')), to: temp(p, 'toC'), at: clock(p, 'at', c) }),
  'preview.keep_heat': (p, c) =>
    t('Keeps heating · ≈ {dur} to {to}, around {at}', { dur: fmtDur(num(p, 'etaMin')), to: temp(p, 'toC'), at: clock(p, 'at', c) }),
  'preview.heat_to_band': (p) => t('Will heat to {off}, then hold', { off: temp(p, 'offC') }),
  'preview.stop_heat': (p) => t('Heating will stop · already {t}', { t: temp(p, 't') }),
  'preview.no_heat_needed': (p) => t('No heating needed · already {t}', { t: temp(p, 't') }),
  'preview.no_change_band': (p) => t('No change · within {lo}–{hi}', { lo: temp(p, 'lo'), hi: temp(p, 'hi') }),
  'preview.start_cool': (p, c) =>
    t('Starts cooling · ≈ {dur} to {to}, around {at}', { dur: fmtDur(num(p, 'etaMin')), to: temp(p, 'toC'), at: clock(p, 'at', c) }),
  'preview.keep_cool': (p, c) =>
    t('Keeps cooling · ≈ {dur} to {to}, around {at}', { dur: fmtDur(num(p, 'etaMin')), to: temp(p, 'toC'), at: clock(p, 'at', c) }),
  'preview.cool_to_band': (p) => t('Will cool to {off}, then hold', { off: temp(p, 'offC') }),
  'preview.stop_cool': (p) => t('Cooling will stop · already {t}', { t: temp(p, 't') }),
  'preview.no_cool_needed': (p) => t('No cooling needed · already {t}', { t: temp(p, 't') }),
  'preview.gap_too_small': (p) => t('The bounds must be at least {gap} apart', { gap: delta(p, 'gapC') }),
  'preview.writes_profile': (p, c) => t('Becomes the «{profile}» target', { profile: profile(p, c) }),
  'preview.room_off': (p, c) => t('The room is off in «{profile}»', { profile: profile(p, c) }),
  'preview.window_applies_later': () => t('A window is open — the new target applies once it is closed'),
  // house profile and house mode previews
  'house.preview.same': (p, c) => t('«{profile}» is already active', { profile: profile(p, c) }),
  'house.preview.will_heat': (p, c) => withSource(t('{count} rooms will start heating', { count: num(p, 'n') ?? 0 }), p, c),
  'house.preview.heating_stops': (p) => t('{count} rooms will stop heating', { count: num(p, 'n') ?? 0 }),
  'house.preview.will_cool': (p, c) => withSource(t('{count} rooms will start cooling', { count: num(p, 'n') ?? 0 }), p, c),
  'house.preview.cooling_stops': (p) => t('{count} rooms will stop cooling', { count: num(p, 'n') ?? 0 }),
  'house.preview.no_change': () => t('Nothing changes right now'),
  'house.chip.up': (p) => t('↑ target: {count} rooms', { count: num(p, 'n') ?? 0 }),
  'house.chip.down': (p) => t('↓ target: {count} rooms', { count: num(p, 'n') ?? 0 }),
  'house.chip.frost_stays': (p) => t('frost protection {frost} stays', { frost: temp(p, 'frostC') }),
  'house.chip.off': (p) => t('{count} rooms off', { count: num(p, 'n') ?? 0 }),
  'mode.preview.stops': (p, c) => t('{source} stops · affects {count} rooms', { source: source(p, c), count: num(p, 'n') ?? 0 }),
  'mode.preview.starts': (p, c) => t('{source} starts · affects {count} rooms', { source: source(p, c), count: num(p, 'n') ?? 0 }),
  'mode.preview.no_change': () => t('Nothing changes right now'),
  'mode.preview.frost_only': () => t('Only frost protection will work'),
  // why a source cannot run
  'source.blocked.min_off': (p, c) => t('Minimum pause — can start {in}', { in: inn(p, 'until', c) }),
  'source.blocked.min_run': (p, c) => t('Minimum run time — can stop {in}', { in: inn(p, 'until', c) }),
  'source.blocked.max_starts': (p, c) => t('{count} starts this hour — next {in}', { count: num(p, 'n') ?? 0, in: inn(p, 'until', c) }),
  'source.blocked.budget': (p) =>
    t('Power budget: {used} of {budget} in use, needs {need}', { used: kw(p, 'usedKw'), budget: kw(p, 'budgetKw'), need: kw(p, 'needKw') }),
  'source.blocked.stagger': (p, c) => t('Starts one after another — {in}', { in: inn(p, 'until', c) }),
  'source.blocked.condition': () => t('Its run condition is not met'),
  'source.blocked.trigger': (p, c) => t('Runs only with «{trigger}»', { trigger: trigger(p, c) }),
  'source.blocked.season': (p) => t('Not allowed: {season}', { season: season(p) }),
  'source.blocked.outdoor_limit': (p) => t('Outdoor {tout} is beyond its limit {limit}', { tout: temp(p, 'toutC'), limit: temp(p, 'limitC') }),
  'source.blocked.bivalence': (p) => t('Below the bivalence point {point} (outdoor {tout})', { point: temp(p, 'pointC'), tout: temp(p, 'toutC') }),
  'source.blocked.cutoff': (p) => t('Warm outside ({tout} above {cutoff}) — heating not needed', { tout: temp(p, 'toutC'), cutoff: temp(p, 'cutoffC') }),
  'source.blocked.changeover': (p, c) => t('Pause between heating and cooling — {in}', { in: inn(p, 'until', c) }),
  'source.blocked.lock': (p, c) => t('Switched off {until}', { until: until(p, 'until', c) }),
  'source.blocked.fault': (p, c) => t('Fault: {fault} — retry {in}', { fault: fault(p), in: inn(p, 'retryAt', c) }),
  'source.blocked.unavailable': (p, c) => t('{entity} unavailable since {since}', { entity: entity(p, c), since: clock(p, 'since', c) }),
  'source.blocked.rule': (p, c) => t('Blocked by the rule «{rule}»', { rule: rule(p, c) }),
  'source.blocked.carrier': (p) => {
    const carrier = str(p, 'carrier');
    const label = carrier && ['electric', 'gas', 'other'].includes(carrier) ? energyCarrierLabel(carrier as EnergyCarrier) : (carrier ?? '—');
    return t('Energy rule: {carrier} is not allowed', { carrier: label });
  },
  'source.blocked.prerun': (p, c) => t('The pump runs first — {in}', { in: inn(p, 'until', c) }),
  'source.blocked.disabled': () => t('Disabled in its settings'),
  'source.blocked.conflict': (p, c) => t('Something else keeps changing it — retry {in}', { in: inn(p, 'until', c) }),
  // source state details
  'source.detail.running': (p, c) => {
    const base = num(p, 'since') != null ? t('{mode} since {since}', { mode: cap(sourceMode(p)), since: clock(p, 'since', c) }) : cap(sourceMode(p));
    return num(p, 'flowC') != null ? `${base} · ${t('flow {flow}', { flow: temp(p, 'flowC') })}` : base;
  },
  'source.detail.confirming': (p, c) => t('Starting — waiting for confirmation until {at}', { at: clock(p, 'deadline', c) }),
  'source.detail.defrost': (p, c) => t('Defrosting since {since}', { since: clock(p, 'since', c) }),
  'source.detail.idle': () => t('Not running'),
  'source.detail.test': (p, c) => t('Test run {until}', { until: until(p, 'until', c) }),
  'source.detail.forced': (p, c) => t('Forced on: {mode} {until}', { mode: sourceMode(p), until: until(p, 'until', c) }),
  'source.detail.stage': (p) => t('Stage {stage} of {of}', { stage: num(p, 'stage') ?? 0, of: num(p, 'of') ?? 0 }),
  'role.lead': () => t('Main'),
  'role.together': () => t('Together with the main one'),
  'role.reserve': () => t('Reserve'),
  'role.reserve_below': (p) => t('Reserve below {point}', { point: temp(p, 'pointC') }),
  'role.lag_join': () => t('Joins when the main one is not keeping up'),
  'role.assist': () => t('Helps'),
  'role.trigger_only': (p, c) => t('Only with «{trigger}»', { trigger: trigger(p, c) }),
  'role.room_primary': (p, c) => t('Main for {room}', { room: room(p, c) }),
  'role.unused': () => t('Not used'),
  // plant: why it runs this way
  'plant.season': (p) => t('Season: {season} (average outdoor {avg})', { season: season(p), avg: temp(p, 'avgC') }),
  'plant.lead': (p, c) => t('{source} leads ({mode}) at {tout} outdoors', { source: source(p, c), mode: sourceMode(p), tout: temp(p, 'toutC') }),
  'plant.bivalent_hp': (p) => t('Outdoor {tout} is above {point} — the heat pump copes alone', { tout: temp(p, 'toutC'), point: temp(p, 'pointC') }),
  'plant.bivalent_reserve': (p, c) => t('Below {point} — {source} takes over', { point: temp(p, 'pointC'), source: source(p, c) }),
  'plant.lag': (p, c) => t('{source} joined: rooms stayed short of their target for {dur}', { source: source(p, c), dur: fmtDur(num(p, 'minutes')) }),
  'plant.failover': (p, c) =>
    t('{from} failed ({fault}) — switched to {to}', { from: source(p, c, 'from'), to: source(p, c, 'to'), fault: fault(p) }),
  'plant.budget': (p) => t('Power budget: {used} of {budget}', { used: kw(p, 'usedKw'), budget: kw(p, 'budgetKw') }),
  'plant.rule_active': (p, c) => t('Rule «{rule}» is active', { rule: rule(p, c) }),
  'plant.trigger_active': (p, c) => t('Trigger «{trigger}» is active', { trigger: trigger(p, c) }),
  'plant.no_demand': () => t('No room is asking for heat or cooling'),
  'plant.dew_guard': (p, c) =>
    t('{circuit}: supply {supply} kept above the dew point {dew}', { circuit: circuit(p, c), supply: temp(p, 'supplyC'), dew: temp(p, 'dewC') }),
  'plant.summer_idle': () => t('Summer: central heating rests'),
  'plant.neutral_guard': (p) => t('Between seasons: heating {count} cold rooms', { count: num(p, 'n') ?? 0 }),
  'plant.frost_fallback': (p, c) => t('Frost protection: {source} heats {room}', { source: source(p, c), room: room(p, c) }),
  'plant.flow_curve': (p) => t('Weather curve: outdoor {tout} → flow {flow}', { tout: temp(p, 'toutC'), flow: temp(p, 'flowC') }),
  'plant.cutoff': (p) => t('Outdoor {tout} is above {cutoff} — central heating not needed', { tout: temp(p, 'toutC'), cutoff: temp(p, 'cutoffC') }),
  'plant.house_off': () => t('The house is switched off'),
  'plant.blind': (p, c) => t('No connection to Home Assistant since {since} — nothing is switched', { since: clock(p, 'since', c) }),
  'plant.cool_by_ac': (p) => t('Air conditioners cool {count} rooms', { count: num(p, 'n') ?? 0 }),
  'plant.dew_hold': (p, c) => t('{circuit}: floor cooling rests {until} after the dew point guard', { circuit: circuit(p, c), until: until(p, 'until', c) }),
  'plant.dew_lockout': (p, c) =>
    t('{circuit}: floor cooling locked {until} after {n} dew point stops', { circuit: circuit(p, c), until: until(p, 'until', c), n: num(p, 'trips') ?? 0 }),
  // circuits
  'circuit.heating': (p, c) => {
    const parts = [t('Heating')];
    if (num(p, 'supplyC') != null) parts.push(t('supply {supply}', { supply: temp(p, 'supplyC') }));
    if (str(p, 'sourceId')) parts.push(source(p, c));
    return parts.join(' · ');
  },
  'circuit.cooling': (p) => {
    const parts = [t('Cooling')];
    if (num(p, 'supplyC') != null) parts.push(t('supply {supply}', { supply: temp(p, 'supplyC') }));
    if (num(p, 'dewC') != null) parts.push(t('dew point {dew}', { dew: temp(p, 'dewC') }));
    return parts.join(' · ');
  },
  'circuit.run_on': (p, c) => t('Run-on {until}', { until: until(p, 'until', c) }),
  'circuit.idle': () => t('Not running'),
  'circuit.summer': () => t('Summer pause'),
  'circuit.dew_blocked': (p) => t('Blocked by the dew point {dew}', { dew: temp(p, 'dewC') }),
  'circuit.no_source': () => t('No source available'),
  'circuit.heat_only_blocked': () => t('Heating only — closed while cooling'),
  'circuit.dew_hold': (p, c) => t('Paused by the dew point guard {until}', { until: until(p, 'until', c) }),
  'circuit.dew_lockout': (p, c) => t('Locked by the dew point guard {until}', { until: until(p, 'until', c) }),
  // energy
  'energy.grid_ok': () => t('Grid power is on'),
  'energy.budget_used': (p) => t('Blackout: {used} of {budget}', { used: kw(p, 'usedKw'), budget: kw(p, 'budgetKw') }),
  'energy.economy': (p) => t('Economy: battery {soc}', { soc: pct(p, 'soc') }),
  'energy.critical': (p) => t('Battery critically low ({soc}) — frost protection only', { soc: pct(p, 'soc') }),
  'energy.night_tariff_at': (p, c) => t('Night tariff from {at}', { at: clock(p, 'at', c) }),
  'energy.solar_to_heat': (p) => t('Solar surplus {pv} → heat', { pv: kw(p, 'pvKw') }),
  'energy.solar_to_cold': (p) => t('Solar surplus {pv} → cooling', { pv: kw(p, 'pvKw') }),
  'energy.not_configured': () => t('Energy is not set up'),
  // trigger live texts
  'trigger.live.value': (p) => t('Now {value}', { value: valueWithUnit(p) }),
  'trigger.live.since': (p, c) => t('Active since {since}', { since: clock(p, 'since', c) }),
  'trigger.live.next_change': (p, c) => t('Next change at {at}', { at: clock(p, 'at', c) }),
  'trigger.live.unknown': (p, c) => t('{entity} is unavailable', { entity: entity(p, c) }),
  'trigger.live.disabled': () => t('Trigger disabled'),
  'trigger.live.error': (p) => t('Error: {error}', { error: str(p, 'error') ?? '—' }),
  'trigger.live.inactive': () => t('Inactive'),
  // device states and hints
  'dev.trv_heating': (p) =>
    num(p, 'valvePct') != null
      ? t('Open · target {sp} · valve {pct}', { sp: temp(p, 'setpointC'), pct: pct(p, 'valvePct') })
      : t('Open · target {sp}', { sp: temp(p, 'setpointC') }),
  'dev.trv_closed': (p) => t('Closed · target {sp}', { sp: temp(p, 'setpointC') }),
  'dev.trv_idle': () => t('Waiting'),
  'dev.reading': (p) => valueWithUnit(p),
  'dev.contact_open': (p, c) => t('Open for {dur}', { dur: fmtSince(num(p, 'since'), c.now ?? nowMs()) }),
  'dev.contact_closed': () => t('Closed'),
  'dev.relay_on': (p, c) => (num(p, 'since') != null ? t('On since {since}', { since: clock(p, 'since', c) }) : t('On')),
  'dev.relay_off': () => t('Off'),
  'dev.source': (p) => {
    const s = str(p, 'state');
    return s && s in SOURCE_STATES ? sourceStateLabel(s as SourceStateKind) : (s ?? '—');
  },
  'dev.offline': (p, c) => t('Offline since {since}', { since: clock(p, 'since', c) }),
  'dev.valve_pct': (p) => t('Valve {pct}', { pct: pct(p, 'pct') }),
  'dev.pump': (p) => {
    const s = str(p, 'state');
    return s && s in PUMP_STATES ? pumpStateLabel(s as PumpStateKind) : (s ?? '—');
  },
  'hint.aqara_rejoin': () => t('Aqara devices sometimes drop off — press the button on the device so it rejoins.'),
  'hint.add_router': () => t('Weak signal — add a Zigbee router (a mains-powered plug) nearby.'),
  'hint.battery_type': (p) => (str(p, 'type') ? t('Replace the battery ({type}).', { type: str(p, 'type') }) : t('Replace the battery.')),
  'hint.check_power': () => t('Check the power supply of the device.'),
  'hint.check_z2m': () => t('Check that Zigbee2MQTT is running.'),
  'hint.replace_entity': () => t('The entity is gone from Home Assistant — pick its replacement.'),
  'hint.disable_automation': (p, c) => t('Something else keeps changing {entity} — disable that automation.', { entity: entity(p, c) }),
  'hint.check_trv': () => t('Check the radiator valve: batteries, mounting, child lock.'),
  // season
  'season.auto': (p) => t('Auto: {season} · average {avg}', { season: season(p), avg: temp(p, 'avgC') }),
  'season.forced': (p) => {
    const m = str(p, 'mode');
    return t('Set by hand: {mode}', { mode: m && ['auto', 'heat', 'cool', 'off'].includes(m) ? houseModeLabel(m as HouseMode) : (m ?? '—') });
  },
  'season.pending': (p, c) => t('Switches to {season} at {at}', { season: season(p, 'to'), at: clock(p, 'eligibleAt', c) }),
  'season.months_gate': (p) => t('{season}: not allowed this month', { season: cap(season(p)) }),
  'season.no_data': () => t('No outdoor data — the season follows the calendar'),
};

const SOURCE_STATES: Record<SourceStateKind, true> = {
  heating: true, cooling: true, drying: true, fan: true, defrost: true, starting: true, stopping: true, standby: true,
  idle: true, waiting_trigger: true, waiting_season: true, waiting_guard: true, paused: true, disabled: true,
  testing: true, fault: true, unavailable: true,
};
const PUMP_STATES: Record<PumpStateKind, true> = { running: true, run_on: true, off: true, exercise: true, forced: true, blocked: true, unavailable: true };

function cap(s: string): string {
  return s ? s.charAt(0).toLocaleUpperCase() + s.slice(1) : s;
}

function valueWithUnit(p: P): string {
  const v = p.value;
  const unit = str(p, 'unit');
  const text = typeof v === 'number' ? fmtNum(v, Number.isInteger(v) ? 0 : 1) : v == null ? '—' : String(v);
  if (!unit) return text;
  if (unit === '°C' && typeof v === 'number') return fmtTemp(v);
  return unit === '%' ? `${text}%` : `${text} ${unit}`;
}

function withSource(main: string, p: P, c: Ctx): string {
  return str(p, 'sourceId') ? `${main} · ${source(p, c)}` : main;
}

/** Renders a reason; an unknown code (newer server) falls back to the code itself. */
export function renderReason(r: Reason | null | undefined, ctx: CodeContext = {}): string {
  if (!r) return '';
  const fn = REASONS[r.code];
  return fn ? fn(r.params ?? {}, ctx) : r.code;
}

/** Several reasons as sentences («чому гріє»: main first, details after). */
export function renderReasons(rs: readonly Reason[] | null | undefined, ctx: CodeContext = {}): string[] {
  return (rs ?? []).map((r) => renderReason(r, ctx)).filter(Boolean);
}

/* ======================================== journal ======================================== */

/** Wizard device roles in journal lines («додано датчик температури»). */
function deviceRoleLabel(role: string | null): string {
  switch (role) {
    case 'trv':
      return t('radiator head');
    case 'temperature':
      return t('temperature sensor');
    case 'humidity':
      return t('humidity sensor');
    case 'window':
      return t('window contact');
    case 'door':
      return t('door contact');
    case 'ac':
      return t('air conditioner');
    case 'heater':
      return t('heater');
    case 'floor_zone':
      return t('floor zone valve');
    case 'floor_probe':
      return t('floor probe');
    case 'dehumidifier':
      return t('dehumidifier');
    default:
      return t('sensor');
  }
}

function heatingKindLabel(kind: string): string {
  switch (kind) {
    case 'trv':
      return t('radiators with smart heads');
    case 'radiator_plain':
      return t('radiators with ordinary valves');
    case 'floor':
      return t('underfloor heating');
    case 'ac':
      return t('air conditioner');
    case 'local':
      return t('own heater');
    default:
      return kind;
  }
}

/** What happened to a device removed from a room. */
function releaseLabel(release: string | null): string | null {
  switch (release) {
    case 'trv_handback':
      return t('the head got its own setpoint back');
    case 'switch_off':
      return t('switched off');
    case 'zone_open':
      return t('the zone was left open');
    case 'zone_close':
      return t('the zone was closed');
    default:
      return null;
  }
}

type JRender = (p: P, c: Ctx, e: JournalEntry) => string;

const subjectSource = (e: JournalEntry, c: Ctx) => lookup(c.source, e.sourceId);
const subjectRoom = (e: JournalEntry, c: Ctx) => lookup(c.room, e.roomId);
const subjectDevice = (e: JournalEntry, c: Ctx) =>
  (e.deviceKey ? c.device?.(e.deviceKey) : undefined) ??
  (e.entityIds[0] ? (c.entity?.(e.entityIds[0]) ?? e.entityIds[0]) : (e.deviceKey ?? t('Device')));
const subjectPump = (p: P, c: Ctx, e: JournalEntry) =>
  (str(p, 'pumpId') ? c.pump?.(str(p, 'pumpId') as string) : undefined) ??
  (e.entityIds[0] ? (c.entity?.(e.entityIds[0]) ?? e.entityIds[0]) : t('Pump'));

function byWhom(p: P): string {
  const by = str(p, 'by');
  if (!by) return '';
  // a house profile chosen by a layer names the layer («Розклад будинку», «Календар»)
  const label = ['ui', 'card', 'ha', 'voice', 'automation', 'mqtt', 'trv', 'engine', 'rule', 'schedule', 'notification', 'telegram', 'import', 'system', 'event'].includes(by)
    ? actorViaLabel(by as never)
    : ['house_schedule', 'calendar', 'presence', 'default', 'house_manual'].includes(by)
      ? targetLayerLabel(by as never)
      : by;
  return ` · ${label}`;
}

/** Which of Klimo's own HA entities carried a change («· Вітальня керування»). */
function viaEntity(p: P, c: Ctx): string {
  const id = str(p, 'entityId');
  return id ? ` · ${c.entity?.(id) ?? id}` : '';
}

function roomControlText(p: P, c: Ctx, e: JournalEntry): string {
  const room = subjectRoom(e, c);
  const mode = str(p, 'mode');
  let main: string;
  if (mode === 'manual') {
    if (num(p, 'lo') != null && num(p, 'hi') != null) main = t('{room}: manual control, {lo}–{hi}', { room, lo: temp(p, 'lo'), hi: temp(p, 'hi') });
    else if (num(p, 'valueC') != null) main = t('{room}: manual control at {value}', { room, value: temp(p, 'valueC') });
    else main = t('{room}: manual control', { room });
  } else if (mode === 'off') main = t('{room}: off until the schedule is resumed', { room });
  else main = t('{room}: back to schedule', { room });
  return main + byWhom(p) + viaEntity(p, c);
}

function houseControlText(p: P, c: Ctx): string {
  if (str(p, 'mode') === 'manual') return t('House under manual control: the schedule is paused on «{profile}»', { profile: profile(p, c) }) + byWhom(p) + viaEntity(p, c);
  const parts = [t('House back to schedule')];
  if (num(p, 'rooms') != null) parts.push(t('rooms resumed: {n}', { n: num(p, 'rooms') ?? 0 }));
  if (num(p, 'off') != null) parts.push(t('rooms left off: {n}', { n: num(p, 'off') ?? 0 }));
  return parts.join(' · ') + byWhom(p) + viaEntity(p, c);
}

function rejectedCommandText(p: P): string {
  const reasons: Record<string, string> = {
    unknown_command: t('unknown command'),
    room_required: t('the command needs a room'),
    room_not_found: t('no such room'),
    target_required: t('the command needs a target temperature'),
    invalid: t('invalid data'),
    failed: t('not applied'),
  };
  const reason = reasons[str(p, 'reason') ?? ''] ?? reasons.invalid;
  const room = str(p, 'room');
  const detail = str(p, 'detail');
  return t('Home Assistant command «{command}» rejected: {reason}', { command: str(p, 'command') ?? '—', reason }) + (room ? ` · «${room}»` : '') + (detail ? ` (${detail})` : '') + byWhom(p);
}

function overrideText(p: P, c: Ctx, e: JournalEntry): string {
  const r = subjectRoom(e, c);
  const u = until(p, 'until', c);
  const kind = str(p, 'kind') as OverrideKind | null;
  switch (kind) {
    case 'room_target':
      return num(p, 'lo') != null && num(p, 'hi') != null
        ? t('{room}: range {lo}–{hi} {until}', { room: r, lo: temp(p, 'lo'), hi: temp(p, 'hi'), until: u })
        : t('{room}: target {value} {until}', { room: r, value: temp(p, 'valueC'), until: u });
    case 'room_boost':
      return t('{room}: boost to {value} {until}', { room: r, value: temp(p, 'valueC'), until: u });
    case 'room_airing':
      return t('{room}: airing {until}', { room: r, until: u });
    case 'room_off':
      return t('{room}: switched off {until}', { room: r, until: u });
    case 'room_profile':
      return t('{room}: «{profile}» {until}', { room: r, profile: profile(p, c), until: u });
    case 'room_window_ignore':
      return t('{room}: window ignored {until}', { room: r, until: u });
    default:
      return t('{room}: {change} {until}', { room: r, change: kind ? overrideKindLabel(kind) : '—', until: u });
  }
}

const JOURNAL: Record<JournalCode, JRender> = {
  // sources and plant
  'source.start': (p, c, e) => {
    const parts = [t('{source} started: {mode}', { source: subjectSource(e, c), mode: sourceMode(p) })];
    if (num(p, 'n') != null) parts.push(t('rooms: {n}', { n: num(p, 'n') ?? 0 }));
    if (num(p, 'toutC') != null) parts.push(t('outdoor {tout}', { tout: temp(p, 'toutC') }));
    return parts.join(' · ');
  },
  'source.stop': (_p, c, e) => t('{source} stopped', { source: subjectSource(e, c) }),
  'source.confirmed': (p, c, e) => t('{source} confirmed running in {dur}', { source: subjectSource(e, c), dur: fmtDurSec(num(p, 'afterSec')) }),
  'source.fault': (p, c, e) => t('{source}: fault — {fault}', { source: subjectSource(e, c), fault: fault(p) }),
  'source.failover': (p, c) => t('Switched over: {from} → {to} ({fault})', { from: source(p, c, 'from'), to: source(p, c, 'to'), fault: fault(p) }),
  'source.recovered': (_p, c, e) => t('{source} works again', { source: subjectSource(e, c) }),
  'source.test': (p, c, e) => {
    const result = str(p, 'result');
    const text =
      result === 'ok'
        ? t('confirmed in {dur}', { dur: fmtDurSec(num(p, 'confirmAfterSec')) })
        : result === 'no_confirm'
          ? t('no confirmation')
          : result === 'blocked'
            ? t('blocked')
            : result === 'running'
              ? t('running')
              : t('error');
    return t('{source} test: {result}', { source: subjectSource(e, c), result: text });
  },
  'source.lock': (p, c, e) =>
    (str(p, 'kind') === 'source_force'
      ? t('{source} forced on {until}', { source: subjectSource(e, c), until: until(p, 'until', c) })
      : t('{source} switched off {until}', { source: subjectSource(e, c), until: until(p, 'until', c) })) + byWhom(p),
  'source.lock_expired': (_p, c, e) => t('{source}: the manual lock ended', { source: subjectSource(e, c) }),
  'source.stage_up': (p, c, e) => t('{source}: stage {stage} on', { source: subjectSource(e, c), stage: num(p, 'stage') ?? 0 }),
  'source.stage_down': (p, c, e) => t('{source}: down to stage {stage}', { source: subjectSource(e, c), stage: num(p, 'stage') ?? 0 }),
  'source.changeover': (p, c, e) =>
    t('{source} switched from {from} to {to}', { source: subjectSource(e, c), from: sourceMode(p, 'from'), to: sourceMode(p, 'to') }),
  'source.changeover_blocked': (p, c, e) => t('{source}: the changeover waits {until}', { source: subjectSource(e, c), until: until(p, 'until', c) }),
  'bivalent.hp_off': (p) => t('Outdoor {tout} is below {point} — the heat pump stops, the reserve heats', { tout: temp(p, 'toutC'), point: temp(p, 'pointC') }),
  'bivalent.hp_on': (p) => t('Outdoor {tout} — the heat pump is back', { tout: temp(p, 'toutC') }),
  'lag.join': (p, c) => t('{source} joined: rooms stayed short of their target for {dur}', { source: source(p, c), dur: fmtDur(num(p, 'minutes')) }),
  'lag.leave': () => t('The helping source left — the main one copes'),
  'pump.on': (p, c, e) => {
    const reason = str(p, 'reason');
    const label = reason && reason in PUMP_REASONS ? pumpReasonLabel(reason as PumpReason) : reason;
    return label ? t('{pump} on: {reason}', { pump: subjectPump(p, c, e), reason: label }) : t('{pump} on', { pump: subjectPump(p, c, e) });
  },
  'pump.run_on': (p, c, e) => t('{pump}: run-on {until}', { pump: subjectPump(p, c, e), until: until(p, 'until', c) }),
  'pump.off': (p, c, e) => t('{pump} off', { pump: subjectPump(p, c, e) }),
  'pump.exercise': (p, c, e) => t('{pump}: anti-seize run for {dur}', { pump: subjectPump(p, c, e), dur: fmtDurSec(num(p, 'durationSec')) }),
  'pump.flow_safety': (p, c, e) => t('{pump} forced on — {source} needs circulation', { pump: subjectPump(p, c, e), source: source(p, c) }),
  'circuit.merged': (p) => t('«{from}» merged into «{to}»: rooms moved — {n}', { from: str(p, 'from') ?? '', to: str(p, 'to') ?? '', n: num(p, 'n') ?? 0 }) + byWhom(p),
  'pump.duty_switch': (p, c) =>
    t('Duty pump: {from} → {to}', { from: lookup(c.pump, str(p, 'from')), to: lookup(c.pump, str(p, 'to')) }),
  'frost.fallback': (p, c) => t('Frost protection: {source} heats {room}', { source: source(p, c), room: room(p, c) }),
  'dew.guard': (p, c) =>
    t('{circuit}: supply {supply} near the dew point {dew} — cooling limited', { circuit: circuit(p, c), supply: temp(p, 'supplyC'), dew: temp(p, 'dewC') }),
  'dew.lockout': (p, c) =>
    t('{circuit}: the dew point guard stopped floor cooling {n} times in 2 h — locked {until}', { circuit: circuit(p, c), n: num(p, 'trips') ?? 0, until: until(p, 'until', c) }),
  'dew.lockout_end': (p, c) => t('{circuit}: floor cooling allowed again', { circuit: circuit(p, c) }),
  'dew.lockout_reset': (p, c) => t('{circuit}: floor cooling lock reset', { circuit: circuit(p, c) }) + byWhom(p),
  'budget.shed': (p, c) => t('{source} shed by the power budget: {used} of {budget}', { source: source(p, c), used: kw(p, 'usedKw'), budget: kw(p, 'budgetKw') }),
  'budget.critical': (p) => t('Battery {soc} — frost protection only', { soc: pct(p, 'soc') }),
  'cutoff.on': (p) => t('Outdoor {tout} — central heating not needed', { tout: temp(p, 'toutC') }),
  'cutoff.off': (p) => t('Outdoor {tout} — central heating allowed again', { tout: temp(p, 'toutC') }),
  // rooms
  'room.window_reaction': (p, c, e) => {
    const r = str(p, 'reaction');
    const label = r && ['pause', 'eco', 'lower', 'notify'].includes(r) ? windowReactionLabel(r as WindowReaction).toLocaleLowerCase() : (r ?? '—');
    return t('{room}: window open — {reaction}', { room: subjectRoom(e, c), reaction: label });
  },
  'room.window_resume': (_p, c, e) => t('{room}: windows closed — back to normal', { room: subjectRoom(e, c) }),
  'room.window_virtual': (p, c, e) => t('{room}: the temperature dropped {drop} — treated as an open window', { room: subjectRoom(e, c), drop: delta(p, 'dropC') }),
  'room.override': (p, c, e) => overrideText(p, c, e) + byWhom(p),
  'room.override_cleared': (p, c, e) => t('{room}: back to schedule', { room: subjectRoom(e, c) }) + byWhom(p),
  'room.override_expired': (p, c, e) =>
    str(p, 'back') === 'manual'
      ? t('{room}: the temporary change ended — back to manual control', { room: subjectRoom(e, c) })
      : str(p, 'back') === 'off'
        ? t('{room}: the temporary change ended — the room is off again', { room: subjectRoom(e, c) })
        : t('{room}: the manual change ended', { room: subjectRoom(e, c) }),
  'room.control': roomControlText,
  'room.frost_on': (p, c, e) => t('{room}: frost protection on at {t}', { room: subjectRoom(e, c), t: temp(p, 't') }),
  'room.frost_off': (p, c, e) => t('{room}: frost protection off at {t}', { room: subjectRoom(e, c), t: temp(p, 't') }),
  'room.overheat_on': (p, c, e) => t('{room}: overheating {t} — heating closed', { room: subjectRoom(e, c), t: temp(p, 't') }),
  'room.overheat_off': (p, c, e) => t('{room}: the temperature is back to normal ({t})', { room: subjectRoom(e, c), t: temp(p, 't') }),
  'room.no_data': (_p, c, e) => t('{room}: no temperature data', { room: subjectRoom(e, c) }),
  'room.data_back': (p, c, e) => t('{room}: data is back ({t})', { room: subjectRoom(e, c), t: temp(p, 't') }),
  'room.humidity_unknown': (p, c, e) => t('{room}: no humidity reading for {dur} — the floor is not cooled', { room: subjectRoom(e, c), dur: fmtDur(num(p, 'minutes')) }),
  'room.humidity_back': (_p, c, e) => t('{room}: humidity reading is back — floor cooling allowed', { room: subjectRoom(e, c) }),
  'room.trv_fallback': (p, c, e) => t('{room}: using the radiator valves’ readings ({n})', { room: subjectRoom(e, c), n: num(p, 'n') ?? 0 }),
  'room.profile_written': (p, c, e) => {
    const targets = [num(p, 'heatC') != null ? temp(p, 'heatC') : null, num(p, 'coolC') != null ? temp(p, 'coolC') : null].filter(Boolean).join(' / ');
    return t('{room}: new «{profile}» target {targets}', { room: subjectRoom(e, c), profile: profile(p, c), targets }) + byWhom(p);
  },
  'room.created': (p, c, e) => t('{room}: room added', { room: subjectRoom(e, c) }) + byWhom(p),
  'room.deleted': (p, c, e) => t('Room deleted: {room}', { room: subjectRoom(e, c) }) + byWhom(p),
  'room.device_added': (p, c, e) => t('{room}: {what} added — {name}', { room: subjectRoom(e, c), what: deviceRoleLabel(str(p, 'role')), name: str(p, 'name') ?? '' }) + byWhom(p),
  'room.device_removed': (p, c, e) => {
    const release = releaseLabel(str(p, 'release'));
    const text = t('{room}: {what} removed — {name}', { room: subjectRoom(e, c), what: deviceRoleLabel(str(p, 'role')), name: str(p, 'name') ?? '' });
    return (release ? `${text}, ${release}` : text) + byWhom(p);
  },
  'room.device_replaced': (p, c, e) =>
    t('{room}: {what} {from} replaced by {to}', { room: subjectRoom(e, c), what: deviceRoleLabel(str(p, 'role')), from: str(p, 'from') ?? '', to: str(p, 'to') ?? '' }) + byWhom(p),
  'room.heating_changed': (p, c, e) => {
    const kinds = (str(p, 'to') ?? '').split(',').filter(Boolean).map(heatingKindLabel).join(', ');
    const none = t('nothing');
    return t('{room}: heated by {kinds}', { room: subjectRoom(e, c), kinds: kinds || none }) + byWhom(p);
  },
  'room.circuit_joined': (p, c, e) => {
    const id = str(p, 'circuitId');
    const circuit = (id ? c.circuit?.(id) : undefined) ?? str(p, 'circuitName') ?? '';
    return t('{room}: joined «{circuit}»', { room: subjectRoom(e, c), circuit }) + byWhom(p);
  },
  'room.circuit_left': (p, c, e) =>
    t('{room}: left «{circuit}» — its pump no longer runs for this room', { room: subjectRoom(e, c), circuit: str(p, 'circuitName') ?? '' }) + byWhom(p),
  'room.renamed': (p) => t('Room «{from}» renamed to «{to}»', { from: str(p, 'from') ?? '', to: str(p, 'to') ?? '' }) + byWhom(p),
  'room.area_changed': (p, c, e) => {
    const none = t('none');
    return t('{room}: Home Assistant area — {area}', { room: subjectRoom(e, c), area: str(p, 'area') ?? none }) + byWhom(p);
  },
  // devices
  'trv.retry': (p, c, e) => t('{device}: retry {attempt}/{of}', { device: subjectDevice(e, c), attempt: num(p, 'attempt') ?? 0, of: num(p, 'of') ?? 0 }),
  'trv.failed': (p, c, e) => t('{device} did not confirm after {count} attempts', { device: subjectDevice(e, c), count: num(p, 'attempts') ?? 0 }),
  'trv.confirmed': (p, c, e) => t('{device} confirmed in {dur}', { device: subjectDevice(e, c), dur: fmtDurSec(num(p, 'afterSec')) }),
  'trv.manual': (p, c, e) => {
    const policy = str(p, 'policy');
    const text = t('{device}: turned by hand to {value}', { device: subjectDevice(e, c), value: temp(p, 'valueC') });
    return policy && ['slot', 'revert', 'save'].includes(policy) ? `${text} · ${trvManualPolicyLabel(policy as TrvManualPolicy).toLocaleLowerCase()}` : text;
  },
  'trv.manual_reverted': (p, c, e) => t('{device}: the manual {from} was reverted to {to}', { device: subjectDevice(e, c), from: temp(p, 'from'), to: temp(p, 'to') }),
  'trv.handback': (_p, c, e) => t('{device}: switched to its own sensor', { device: subjectDevice(e, c) }),
  'sensor.stale': (p, c, e) => t('{device}: no data for {dur}', { device: subjectDevice(e, c), dur: fmtDur(num(p, 'minutes')) }),
  'sensor.back': (_p, c, e) => t('{device}: data is back', { device: subjectDevice(e, c) }),
  'sensor.excluded': (p, c, e) => t('{device}: excluded from the calculation', { device: subjectDevice(e, c) }) + byWhom(p),
  'sensor.included': (p, c, e) => t('{device}: included in the calculation', { device: subjectDevice(e, c) }) + byWhom(p),
  'sensor.suggest_weight': (p, c, e) =>
    t('{device} differs from the others by {dev} — consider a lower weight', { device: subjectDevice(e, c), dev: delta(p, 'deviationC') }),
  'battery.low': (p, c, e) => t('{device}: battery {pct}', { device: subjectDevice(e, c), pct: pct(p, 'pct') }),
  'relay.mismatch': (_p, c, e) => t('{device}: the relay does not follow the command', { device: subjectDevice(e, c) }),
  'actuator.conflict': (p, c, e) => t('{device} is being changed by something else', { device: subjectDevice(e, c) }) + byWhom(p),
  'entity.unavailable': (p, c, e) => t('{device}: unavailable for {dur}', { device: subjectDevice(e, c), dur: fmtDur(num(p, 'minutes')) }),
  'entity.missing': (_p, c, e) => t('{device}: missing in Home Assistant', { device: subjectDevice(e, c) }),
  'z2m.restart': (p, c) => t('Zigbee2MQTT restarted ({instance})', { instance: lookup(c.instance, str(p, 'instanceId')) }),
  'z2m.offline': (p, c) => t('Zigbee2MQTT is offline ({instance})', { instance: lookup(c.instance, str(p, 'instanceId')) }),
  // system
  'season.changed': (p) => t('Season: {from} → {to} (average {avg})', { from: season(p, 'from'), to: season(p, 'to'), avg: temp(p, 'avgC') }),
  'house_mode.changed': (p) => {
    const m = (k: string) => {
      const v = str(p, k);
      return v && ['auto', 'heat', 'cool', 'off'].includes(v) ? houseModeLabel(v as HouseMode) : (v ?? '—');
    };
    return t('House mode: {from} → {to}', { from: m('from'), to: m('to') }) + byWhom(p);
  },
  'house_profile.changed': (p, c) => t('House profile «{profile}» {until}', { profile: profile(p, c), until: until(p, 'until', c) }) + byWhom(p),
  'house_profile.cleared': (p) => t('House profile back to schedule') + byWhom(p),
  'house_profile.expired': () => t('The house profile change ended'),
  'house.control': (p, c) => houseControlText(p, c),
  'ha.command_rejected': (p) => rejectedCommandText(p),
  'trigger.on': (p, c) => t('Trigger «{trigger}» fired', { trigger: trigger(p, c) }),
  'trigger.off': (p, c) => t('Trigger «{trigger}» is off', { trigger: trigger(p, c) }),
  'rule.on': (p, c) => t('Rule «{rule}» is active', { rule: rule(p, c) }),
  'rule.off': (p, c) =>
    num(p, 'energyKwh') != null
      ? t('Rule «{rule}» ended · {kwh}', { rule: rule(p, c), kwh: fmtKwh(num(p, 'energyKwh')) })
      : t('Rule «{rule}» ended', { rule: rule(p, c) }),
  'restart.boot': (p) =>
    num(p, 'gapSec') != null ? t('Started after a break of {dur}', { dur: fmtDurSec(num(p, 'gapSec')) }) : t('Started'),
  'restart.adopted': (p, c) => t('{source} was already running — taken over', { source: source(p, c) }),
  'restart.source_off': (p, c) => t('{source} switched off after the restart', { source: source(p, c) }),
  'restart.reconciled': (p) => t('After the restart: {sent} commands sent, {matched} already right', { sent: num(p, 'sent') ?? 0, matched: num(p, 'matched') ?? 0 }),
  'ha.disconnected': () => t('Lost the connection to Home Assistant'),
  'ha.reconnected': (p) => t('Home Assistant is back after {dur}', { dur: fmtDurSec(num(p, 'downSec')) }),
  'mqtt.disconnected': () => t('The MQTT broker disconnected'),
  'mqtt.connected': () => t('The MQTT broker connected'),
  'config.changed': (p) => {
    const ent = str(p, 'entity');
    const what = ent && ent in CONFIG_ENTITIES ? configEntityLabel(ent as ConfigEntityName) : (ent ?? '—');
    return t('Settings changed: {what}', { what }) + byWhom(p);
  },
  'config.imported': (p) => t('Configuration imported') + byWhom(p),
  unsupported_units: (p, c) => t('{entity} reports in {unit} — not supported, control paused', { entity: entity(p, c), unit: str(p, 'unit') ?? '—' }),
};

const PUMP_REASONS: Record<PumpReason, true> = {
  rooms: true, source: true, both: true, run_on: true, frost: true, flow_safety: true, source_hold: true, prerun: true,
  dew_runon: true, exercise: true, test: true, manifold: true,
};
const CONFIG_ENTITIES: Record<ConfigEntityName, true> = {
  settings: true, safety: true, house: true, room: true, sensor: true, emitter: true, emitter_device: true, profile: true,
  profile_room: true, activation_rule: true, schedule: true, source: true, manifold: true, circuit: true, pump: true,
  strategy: true, energy: true, trigger: true, rule: true, notify_settings: true, notify_target: true, routing: true,
  event_params: true, watch_rule: true, personal_prefs: true, z2m_instance: true, device_meta: true, device_health: true,
  override: true,
};

/** One journal line («Журнал рішень»); render `e.why` separately with renderReason. */
export function renderJournal(e: JournalEntry, ctx: CodeContext = {}): string {
  const fn = JOURNAL[e.code];
  return fn ? fn(e.params ?? {}, ctx, e) : e.code;
}

/* ======================================== issues ======================================== */

const ISSUES: Record<IssueCode, (p: P, c: Ctx) => string> = {
  no_data: () => t('No temperature data'),
  sensor_offline: (p, c) => {
    const total = num(p, 'total') ?? 0;
    const left = num(p, 'left') ?? 0;
    const off = Math.max(0, total - left);
    // the chip names the silent sensor; the count says how many of the room's are left
    if (!str(p, 'entityId')) return t('{off} of {total} sensors offline', { off, total });
    return t('{device}: offline · {off} of {total}', { device: withMore(entity(p, c), p), off, total });
  },
  source_fault: (p, c) =>
    str(p, 'fallbackId')
      ? t('{source} failed — {fallback} took over', { source: source(p, c), fallback: source(p, c, 'fallbackId') })
      : t('{source} failed', { source: source(p, c) }),
  trv_failed: (p, c) => {
    const name = deviceName(p, c);
    return name ? t('{device}: target not confirmed', { device: name }) : t('A radiator valve did not confirm the target');
  },
  entity_missing: (p, c) => t('{entity} is missing in Home Assistant', { entity: entity(p, c) }),
  too_cold: (p) =>
    num(p, 'minutes') != null
      ? t('{delta} colder than the target for {dur}', { delta: delta(p, 'deltaC'), dur: fmtDur(num(p, 'minutes')) })
      : t('Colder than the target'),
  too_hot: (p) =>
    num(p, 'deltaC') != null && num(p, 'minutes') != null
      ? t('{delta} warmer than the target for {dur}', { delta: delta(p, 'deltaC'), dur: fmtDur(num(p, 'minutes')) })
      : t('Warmer than the target'),
  trv_retry: (p, c) => {
    const name = deviceName(p, c);
    const n = { attempt: num(p, 'attempt') ?? 0, of: num(p, 'of') ?? 0 };
    return name ? t('{device}: target not confirmed · retry {attempt}/{of}', { device: name, ...n }) : t('A radiator valve did not confirm · retry {attempt}/{of}', n);
  },
  overheat: (p) => t('Overheating: {t}', { t: temp(p, 't') }),
  source_wait: (p, c) => t('{source} is on a pause · starts {in}', { source: source(p, c), in: inn(p, 'until', c) }),
  fallback_sensors: () => t('Using backup sensors'),
  actuator_conflict: (p, c) => t('Something else keeps changing {entity}', { entity: entity(p, c) }),
  condensation: (p) => t('Humidity {rh} · condensation risk', { rh: pct(p, 'rh') }),
  humidity_high: (p) => t('Humidity {rh}', { rh: pct(p, 'rh') }),
  floor_humid: (p) => t('Humid ({rh}) — no floor cooling', { rh: pct(p, 'rh') }),
  humidity_unknown: () => t('Humidity unknown — no floor cooling'),
  battery_low: (p, c) => {
    const key = str(p, 'deviceKey');
    const id = str(p, 'entityId');
    const name = (id ? c.entity?.(id) : undefined) ?? (key ? c.device?.(key) : undefined) ?? id;
    return t('{device}: battery {pct}', { device: name ?? t('Sensor'), pct: pct(p, 'pct') });
  },
  window_long: (p, c) =>
    str(p, 'entityId')
      ? t('{window}: open for {dur}', { window: withMore(entity(p, c), p), dur: fmtSince(num(p, 'since'), c.now ?? nowMs()) })
      : t('Window open for {dur}', { dur: fmtSince(num(p, 'since'), c.now ?? nowMs()) }),
  signal_weak: (p) => t('Weak signal (LQI {lqi})', { lqi: num(p, 'lqi') ?? '—' }),
  humid_dry_hint: (p) => t('Humidity {rh} — drying would help', { rh: pct(p, 'rh') }),
  airing_hint: (p) => t('Humidity {rh} — time to air the room', { rh: pct(p, 'rh') }),
};

/** A room device by its emitter device id, else by its entity. */
function deviceName(p: P, c: Ctx): string | null {
  const id = str(p, 'deviceId');
  const entityId = str(p, 'entityId');
  return (id ? c.device?.(id) : undefined) ?? (entityId ? (c.entity?.(entityId) ?? entityId) : null);
}

/** «Полиця і ще 1» when more devices than the named one are affected. */
function withMore(name: string, p: P): string {
  const more = num(p, 'more') ?? 0;
  return more > 0 ? t('{name} and {count} more', { name, count: more }) : name;
}

export function renderIssue(i: RoomIssue, ctx: CodeContext = {}): string {
  const fn = ISSUES[i.code];
  return fn ? fn(i.params ?? {}, ctx) : i.code;
}

/** Label of an alert kind, for places that only have the kind. */
export function renderEventKind(kind: EventKind): string {
  return eventKindLabel(kind);
}

/** «heating» / «cooling» for a mode param. */
export function renderMode(m: string | null | undefined): string {
  return isMode(m ?? null) ? modeLabel(m as Mode) : (m ?? '—');
}
