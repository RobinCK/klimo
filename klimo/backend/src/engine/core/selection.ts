import type {
  BivalentMode,
  ChainEntry,
  Circuit,
  ConditionEval,
  ConditionMemory,
  Decision,
  Detection,
  Emitter,
  EmitterRole,
  EngineConfig,
  EpochMs,
  Id,
  InputSnapshot,
  Mode,
  ModeOrNone,
  OutdoorLimit,
  Override,
  PlantState,
  Pump,
  Reason,
  RoomConfig,
  RoomEval,
  RuleOverlay,
  SeasonState,
  SourceConditionItem,
  SourceConfig,
  SourceFaultCode,
  SourceMemory,
  SourceMode,
  SourceRole,
  TriggerState,
} from '../../shared/model';
import { defaultConditionMemory } from '../../shared/defaults';
import { numOf, runCondition, snapOf, type ConditionScratch, type PlantConditionCtx } from './conditions';
import { coolSupplySetpoint } from './curves';
import { commandEntity, type HealthResult } from './confirm';
import { nominalKw, type EnergyPhase } from './energy';

/* =====================================================================================================
 * Who heats and who cools, this tick. Rooms ask; every circuit with callers walks its strategy chain
 * and takes the first source that may run (season, cutoff, faults, outdoor limits, conditions, rules,
 * budget). A heat pump paired with a reserve follows the bivalence latches; the reserve joins in frost,
 * on lag or when the outdoor reading is lost. Room ACs and heaters serve their own room. When nothing
 * may run for a room in frost, the first available heat source is taken regardless of its gates.
 * ===================================================================================================== */

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;
/** Supply below dew + margin − this, for the hold time, trips the hard dew guard. */
const DEW_HARD_SLACK_C = 0.5;
const DEW_HARD_HOLD_MS = 2 * MIN_MS;

/* ── index ───────────────────────────────────────────────────────────────────────────────────────── */

export interface RoomView {
  id: Id;
  room: RoomConfig;
  ev: RoomEval;
  t: number | null;
  heatC: number | null;
  coolC: number | null;
  tol: RoomConfig['tolerance'];
  demand: ModeOrNone;
  canCall: boolean;
  frost: boolean;
  dry: boolean;
  rh: number | null;
  dewC: number | null;
  /** Window reaction (other than «лише сповістити») or airing. */
  paused: boolean;
  overheat: boolean;
  heatLatchOn: boolean;
  requests: Map<Id, RoomEval['emitterRequests'][number]>;
  emitters: Emitter[];
}

export interface Member {
  room: RoomView;
  emitter: Emitter;
}

export interface PlantIndex {
  cfg: EngineConfig;
  source: Map<Id, SourceConfig>;
  circuits: Circuit[];
  circuit: Map<Id, Circuit>;
  rooms: RoomView[];
  room: Map<Id, RoomView>;
  /** circuitId → rooms with an enabled emitter on it. */
  members: Map<Id, Member[]>;
  /** room-scope sourceId → its direct emitters. */
  direct: Map<Id, Member[]>;
  /** sourceId → circuits it can feed. */
  fedCircuits: Map<Id, Circuit[]>;
  /** circuitId → enabled pumps by order. */
  circuitPumps: Map<Id, Pump[]>;
  /** manifoldId → enabled primary pumps by order. */
  manifoldPumps: Map<Id, Pump[]>;
}

function roomView(room: RoomConfig, ev: RoomEval, cfg: EngineConfig): RoomView {
  const p = ev.partial;
  const reaction = p.window.reactionActive ? p.window.reaction : null;
  return {
    id: room.id,
    room,
    ev,
    t: p.tempC,
    heatC: p.target.heatC,
    coolC: p.target.coolC,
    tol: room.tolerance,
    demand: p.demand.frost ? 'heat' : p.demand.mode,
    canCall: p.demand.canCallSource,
    frost: p.demand.frost,
    dry: p.demand.dry,
    rh: p.humidity.valuePct,
    dewC: p.humidity.dewPointC,
    paused: (reaction !== null && reaction !== 'notify') || p.demand.block === 'airing',
    overheat: ev.memory.overheat.on,
    heatLatchOn: p.demand.latched.heat,
    requests: new Map(ev.emitterRequests.map((r) => [r.emitterId, r])),
    emitters: [...(cfg.emittersByRoom[room.id] ?? [])].filter((e) => e.enabled).sort((a, b) => a.order - b.order),
  };
}

export function indexPlant(cfg: EngineConfig, evals: readonly RoomEval[]): PlantIndex {
  const source = new Map(cfg.sources.map((s) => [s.id, s]));
  const circuits = [...cfg.circuits].sort((a, b) => a.order - b.order);
  const circuit = new Map(circuits.map((c) => [c.id, c]));
  const rooms: RoomView[] = [];
  for (const ev of evals) {
    const room = cfg.rooms.find((r) => r.id === ev.roomId);
    if (room) rooms.push(roomView(room, ev, cfg));
  }
  const members = new Map<Id, Member[]>(circuits.map((c) => [c.id, []]));
  const direct = new Map<Id, Member[]>();
  for (const r of rooms) {
    for (const e of r.emitters) {
      if (e.circuitId) members.get(e.circuitId)?.push({ room: r, emitter: e });
      else if (e.sourceId) {
        const list = direct.get(e.sourceId) ?? [];
        list.push({ room: r, emitter: e });
        direct.set(e.sourceId, list);
      }
    }
  }
  const fedCircuits = new Map<Id, Circuit[]>();
  for (const s of cfg.sources) fedCircuits.set(s.id, circuits.filter((c) => c.sourceIds.includes(s.id)));
  const byOrder = (a: Pump, b: Pump) => a.order - b.order;
  const circuitPumps = new Map<Id, Pump[]>();
  const manifoldPumps = new Map<Id, Pump[]>();
  for (const p of cfg.pumps) {
    if (!p.enabled) continue;
    if (p.circuitId) circuitPumps.set(p.circuitId, [...(circuitPumps.get(p.circuitId) ?? []), p].sort(byOrder));
    else if (p.manifoldId) manifoldPumps.set(p.manifoldId, [...(manifoldPumps.get(p.manifoldId) ?? []), p].sort(byOrder));
  }
  return { cfg, source, circuits, circuit, rooms, room: new Map(rooms.map((r) => [r.id, r])), members, direct, fedCircuits, circuitPumps, manifoldPumps };
}

/** Every pump that moves water through a source's circuits (its circuits and their manifolds). */
export function sourceHasPumps(idx: PlantIndex, sourceId: Id): boolean {
  return (idx.fedCircuits.get(sourceId) ?? []).some((c) => (idx.circuitPumps.get(c.id)?.length ?? 0) > 0 || (!!c.manifoldId && (idx.manifoldPumps.get(c.manifoldId)?.length ?? 0) > 0));
}

/* ── per-source facts used by eligibility ───────────────────────────────────────────────────────── */

export interface ConditionItemResult {
  item: SourceConditionItem;
  value: boolean | null;
  eval: ConditionEval;
}

/** Evaluates every enabled condition item of a source once per tick (owner `source:<id>:<item>`). */
export function evalSourceConditions(
  s: SourceConfig,
  ctx: PlantConditionCtx,
  memory: Record<string, ConditionMemory>,
  out: Record<string, ConditionMemory>,
): ConditionItemResult[] {
  const now = ctx.inputs.now;
  const results: ConditionItemResult[] = [];
  for (const item of s.conditions.items) {
    const ownerKey = `source:${s.id}:${item.id}`;
    if (!item.enabled) continue;
    const prev = memory[ownerKey] ?? defaultConditionMemory(ownerKey, now);
    const into: ConditionScratch = { latches: {}, timers: {} };
    const r = runCondition(item.node, ownerKey, { ...ctx, sourceId: s.id }, prev, into);
    const active = r.value === true;
    out[ownerKey] = { ...prev, ownerKey, active, since: active !== prev.active ? now : prev.since, latches: into.latches, timers: into.timers, updatedAt: now };
    results.push({ item, value: r.value, eval: r.eval });
  }
  return results;
}

const condMode = (m: SourceMode): Mode => (m === 'heat' ? 'heat' : 'cool');

/** The source's own conditions for a mode (an unknown item counts as not met). */
export function conditionsMet(s: SourceConfig, items: readonly ConditionItemResult[], mode: SourceMode): { met: boolean; failed: ConditionItemResult | null } {
  const m = condMode(mode);
  const applicable = items.filter((i) => i.item.mode === null || i.item.mode === m);
  if (!applicable.length) return { met: true, failed: null };
  if (s.conditions.join === 'any') {
    const ok = applicable.some((i) => i.value === true);
    return { met: ok, failed: ok ? null : applicable[0] };
  }
  const failed = applicable.find((i) => i.value !== true) ?? null;
  return { met: failed === null, failed };
}

/** A source used only through trigger-role emitters (the convector that heats on solar surplus). */
export function triggerOnly(idx: PlantIndex, s: SourceConfig): boolean {
  const list = idx.direct.get(s.id) ?? [];
  return list.length > 0 && list.every((d) => d.emitter.roles.heat === 'trigger' || d.emitter.roles.heat === null) && list.some((d) => d.emitter.roles.heat === 'trigger');
}

export function activeLock(cfg: EngineConfig, sourceId: Id, now: EpochMs): Override | null {
  return cfg.overrides.find((o) => o.scope === 'source' && o.subjectId === sourceId && (o.kind === 'source_off' || o.kind === 'source_force') && (o.until === null || o.until > now)) ?? null;
}

/** Outdoor operating limit with hysteresis (AC heating below −5° is pointless); an unknown reading holds. */
export function stepOutdoorLimit(limit: OutdoorLimit | null, blocked: boolean, toutC: number | null): boolean {
  if (!limit) return false;
  if (toutC === null) return blocked;
  if (!blocked) return (limit.minC !== null && toutC < limit.minC) || (limit.maxC !== null && toutC > limit.maxC);
  const minOk = limit.minC === null || toutC >= limit.minC + limit.hysteresisC;
  const maxOk = limit.maxC === null || toutC <= limit.maxC - limit.hysteresisC;
  return !(minOk && maxOk);
}

export interface SelectionCtx {
  idx: PlantIndex;
  inputs: InputSnapshot;
  now: EpochMs;
  season: SeasonState;
  overlay: RuleOverlay;
  triggers: Record<Id, TriggerState>;
  energyActive: boolean;
  phase: EnergyPhase;
  soc: number | null;
  cutoff: boolean;
  tout10: number | null;
  outdoorUnknownLong: boolean;
  frostLatch: boolean;
  limitLatch: boolean;
  lagLatch: boolean;
  mem: Record<Id, SourceMemory>;
  health: Record<Id, HealthResult>;
  conditions: Record<Id, ConditionItemResult[]>;
  /** Budget fit of a start during restrictions (true outside them or for unbudgeted sources). */
  fits: (s: SourceConfig) => Reason | null;
  prevPlant: PlantState | null;
}

export interface Eligibility {
  ok: boolean;
  /** Unavailable but not yet faulted: a chain walk stops here instead of failing over. */
  hold: boolean;
  incapable: boolean;
  blockers: Reason[];
}

function capable(s: SourceConfig, mode: SourceMode): boolean {
  return s.capabilities[mode];
}

function ruleFor(cfg: EngineConfig, overlay: RuleOverlay, sourceId: Id, type: 'only_sources' | 'forbid_sources'): Id | null {
  for (const id of overlay.activeRuleIds) {
    const r = cfg.rules.find((x) => x.id === id);
    if (!r) continue;
    for (const e of r.effects) {
      if (type === 'only_sources' && e.type === 'only_sources' && !e.sourceIds.includes(sourceId)) return r.id;
      if (type === 'forbid_sources' && e.type === 'forbid_sources' && e.sourceIds.includes(sourceId)) return r.id;
    }
  }
  return null;
}

/** Whether a rule lets this source run in `mode` regardless of its own trigger conditions. */
export function allowedByRule(overlay: RuleOverlay, sourceId: Id, mode: SourceMode): boolean {
  return overlay.allowSources.some((a) => a.sourceId === sourceId && (a.mode === null || a.mode === mode));
}

/** Every reason the source may not take `mode` now (frost and the cold guard lift the season gates). */
export function eligibility(s: SourceConfig, mode: SourceMode, x: SelectionCtx, opts: { frost?: boolean; coldGuard?: boolean } = {}): Eligibility {
  const { cfg } = x.idx;
  const now = x.now;
  const m = x.mem[s.id];
  const h = x.health[s.id];
  const blockers: Reason[] = [];
  let hold = false;
  if (!capable(s, mode)) return { ok: false, hold: false, incapable: true, blockers: [] };
  if (!s.enabled || !h || h.unbound) blockers.push({ code: 'source.blocked.disabled', params: {} });

  const lock = activeLock(cfg, s.id, now);
  if (lock?.kind === 'source_off') blockers.push({ code: 'source.blocked.lock', params: { until: lock.until } });

  const heatLike = mode === 'heat';
  const central = s.scope === 'central';
  const gate = heatLike
    ? central
      ? x.season.heatAllowed.central
      : x.season.heatAllowed.local
    : central
      ? x.season.coolAllowed.central
      : x.season.coolAllowed.local;
  const policy = s.seasonPolicy[heatLike ? 'heat' : 'cool'];
  const bypass = heatLike && (!!opts.frost || !!opts.coldGuard);
  if (!(policy === 'always' || gate || bypass)) blockers.push({ code: 'source.blocked.season', params: { season: x.season.season, mode } });
  if (heatLike && central && x.cutoff && !bypass) {
    blockers.push({ code: 'source.blocked.cutoff', params: { cutoffC: cfg.heat.heatingCutoffOutdoorC, toutC: x.tout10 } });
  }

  if (m?.fault && m.fault.retryAt > now) blockers.push({ code: 'source.blocked.fault', params: { code: m.fault.code, retryAt: m.fault.retryAt } });
  else if (m?.fault?.code === 'unavailable' || (h && !h.available && !h.unbound)) {
    blockers.push({ code: 'source.blocked.unavailable', params: { entityId: commandEntity(s.adapter), since: m?.unavailableSince ?? null } });
    if (!m?.fault) hold = true;
  }

  const limitBlocked = m?.outdoorBlocked[heatLike ? 'heat' : 'cool'] ?? false;
  if (limitBlocked) {
    const lim = s.outdoorLimits[heatLike ? 'heat' : 'cool'];
    blockers.push({ code: 'source.blocked.outdoor_limit', params: { limitC: lim?.minC ?? lim?.maxC ?? null, toutC: x.tout10 } });
  }

  const cond = conditionsMet(s, x.conditions[s.id] ?? [], mode);
  if (!cond.met) {
    const lifted = triggerOnly(x.idx, s) && (allowedByRule(x.overlay, s.id, mode) || !!opts.frost);
    if (!lifted) {
      const node = cond.failed?.item.node;
      blockers.push(
        node && node.op === 'trigger'
          ? { code: 'source.blocked.trigger', params: { triggerId: node.triggerId } }
          : { code: 'source.blocked.condition', params: { itemId: cond.failed?.item.id ?? null } },
      );
    }
  }

  const o = x.overlay;
  if (o.onlySources !== null && !o.onlySources.includes(s.id)) blockers.push({ code: 'source.blocked.rule', params: { ruleId: ruleFor(cfg, o, s.id, 'only_sources') } });
  else if (o.forbidSources.includes(s.id)) blockers.push({ code: 'source.blocked.rule', params: { ruleId: ruleFor(cfg, o, s.id, 'forbid_sources') } });
  if (o.disabledCarriers.includes(s.energy.carrier)) blockers.push({ code: 'source.blocked.carrier', params: { carrier: s.energy.carrier } });
  for (const req of o.sourceRequires) {
    if (req.sourceId !== s.id) continue;
    if (!x.triggers[req.triggerId]?.active) blockers.push({ code: 'source.blocked.trigger', params: { triggerId: req.triggerId } });
  }

  if (x.energyActive) {
    const minBattery = s.energy.minBatteryPct;
    if (minBattery !== null && x.soc !== null && x.soc <= minBattery) {
      blockers.push({ code: 'source.blocked.budget', params: { usedKw: null, budgetKw: null, needKw: nominalKw(s) } });
    } else if (!m?.on) {
      const fit = x.fits(s);
      if (fit) blockers.push(fit);
    }
  }
  return { ok: blockers.length === 0, hold, incapable: false, blockers };
}

/* ── callers ─────────────────────────────────────────────────────────────────────────────────────── */

export interface Caller {
  room: RoomView;
  frost: boolean;
  coldGuard: boolean;
}

const CALLING_ROLES: readonly EmitterRole[] = ['primary', 'reserve', 'assist'];

/** The room has its own room-scope heat source that may run now (it then needs no central cold guard). */
function hasLocalHeat(x: SelectionCtx, room: RoomView): boolean {
  for (const e of room.emitters) {
    if (!e.sourceId || e.roles.heat === null) continue;
    const s = x.idx.source.get(e.sourceId);
    if (s && s.scope === 'room' && eligibility(s, 'heat', x).ok) return true;
  }
  return false;
}

/**
 * Rooms calling circuit `c` for heat. In the shoulder season (or above the cutoff) a room calls central
 * heat only once it is a full degree below its band and has no heater of its own; it then keeps calling
 * until its latch lets go.
 */
export function heatCallers(c: Circuit, x: SelectionCtx): Caller[] {
  if (!c.capabilities.heat) return [];
  const out: Caller[] = [];
  const prevCallers = new Set(x.prevPlant?.circuits.find((p) => p.circuitId === c.id)?.requestingRoomIds ?? []);
  const comfortOpen = x.season.heatAllowed.central && !x.cutoff && x.phase !== 'critical';
  const guardOpen = (x.season.heatAllowed.coldGuardOnly || (x.season.heatAllowed.central && x.cutoff)) && x.phase !== 'critical';
  for (const { room, emitter } of x.idx.members.get(c.id) ?? []) {
    if (out.some((o) => o.room.id === room.id) || emitter.roles.heat === null) continue;
    const req = room.requests.get(emitter.id);
    if (room.frost) {
      if (req?.excluded !== 'disabled') out.push({ room, frost: true, coldGuard: false });
      continue;
    }
    if (room.demand !== 'heat' || !room.canCall || req?.mode !== 'heat' || !CALLING_ROLES.includes(emitter.roles.heat)) continue;
    if (comfortOpen) out.push({ room, frost: false, coldGuard: false });
    else if (guardOpen && room.t !== null && room.heatC !== null) {
      const guardC = room.heatC - room.tol.heat.below - x.idx.cfg.season.neutralColdGuardC;
      const kept = prevCallers.has(room.id) && room.heatLatchOn;
      if ((room.t <= guardC + 1e-9 || kept) && !hasLocalHeat(x, room)) out.push({ room, frost: false, coldGuard: true });
    }
  }
  return out;
}

/** Is the room's own AC ahead of the central sources of `c` in the cooling chain (it cools the room itself)? */
function localCoolFirst(x: SelectionCtx, room: RoomView, c: Circuit): boolean {
  const chain = x.idx.cfg.cool.chain.filter((e) => e.enabled);
  const centralAt = chain.findIndex((e) => e.sourceIds.some((id) => c.sourceIds.includes(id)));
  for (const e of room.emitters) {
    if (!e.sourceId || e.roles.cool === null) continue;
    const s = x.idx.source.get(e.sourceId);
    if (!s || s.scope !== 'room' || !eligibility(s, 'cool', x).ok) continue;
    const at = chain.findIndex((ce) => ce.sourceIds.includes(s.id));
    if (at < 0 || centralAt < 0 || at < centralAt) return true;
  }
  return false;
}

export function coolCallers(c: Circuit, x: SelectionCtx): { callers: RoomView[]; humid: RoomView[] } {
  const callers: RoomView[] = [];
  const humid: RoomView[] = [];
  if (!c.capabilities.cool || x.phase === 'critical') return { callers, humid };
  const cool = x.idx.cfg.cool;
  for (const { room, emitter } of x.idx.members.get(c.id) ?? []) {
    if (emitter.roles.cool === null || callers.includes(room) || humid.includes(room)) continue;
    const req = room.requests.get(emitter.id);
    if (room.demand !== 'cool' || !room.canCall || req?.mode !== 'cool' || emitter.excludeFromCooling) continue;
    if (cool.floorExcludeAbovePct !== null && room.rh !== null && room.rh > cool.floorExcludeAbovePct) {
      humid.push(room);
      continue;
    }
    if (!cool.singleRoomCentralStart && localCoolFirst(x, room, c)) continue;
    callers.push(room);
  }
  return { callers, humid };
}

/* ── chains ──────────────────────────────────────────────────────────────────────────────────────── */

interface Entry {
  id: Id;
  sourceIds: Id[];
}

/**
 * The circuit's slice of a strategy chain: enabled entries feeding it, then any feeding source the chain
 * does not mention at all (a chain never edited still works). A source forced on in this mode moves first.
 */
function circuitEntries(x: SelectionCtx, chain: readonly ChainEntry[], c: Circuit, mode: Mode): Entry[] {
  const mentioned = new Set(chain.flatMap((e) => e.sourceIds));
  const out: Entry[] = chain
    .filter((e) => e.enabled)
    .map((e) => ({ id: e.id, sourceIds: e.sourceIds.filter((id) => c.sourceIds.includes(id)) }))
    .filter((e) => e.sourceIds.length > 0);
  const implicit = c.sourceIds
    .map((id) => x.idx.source.get(id))
    .filter((s): s is SourceConfig => !!s && s.scope === 'central' && s.capabilities[mode] && !mentioned.has(s.id))
    .sort((a, b) => a.order - b.order);
  for (const s of implicit) out.push({ id: `implicit:${s.id}`, sourceIds: [s.id] });
  const forced = out.findIndex((e) =>
    e.sourceIds.some((id) => {
      const l = activeLock(x.idx.cfg, id, x.now);
      return l?.kind === 'source_force' && l.value.kind === 'source_force' && condMode(l.value.mode) === mode;
    }),
  );
  if (forced > 0) out.unshift(...out.splice(forced, 1));
  return out;
}

export type WantWhy = 'demand' | 'frost' | 'frost_fallback' | 'cold_guard' | 'storage' | 'dry' | 'force' | 'test' | 'asis';

export interface SourceWant {
  mode: SourceMode;
  why: WantWhy;
  roomIds: Set<Id>;
  circuitIds: Set<Id>;
  role: SourceRole;
  roleReason: Reason;
  /** Emitter role the room asked with (room-scope sources). */
  emitterRole: EmitterRole | null;
}

export interface CircuitPlan {
  circuit: Circuit;
  mode: Mode | null;
  heatCallers: Caller[];
  coolCallers: RoomView[];
  humidRooms: RoomView[];
  selected: Id[];
  lead: Id | null;
  /** The first source the walk could not take, with its reasons (rooms' wait reason). */
  blocked: { sourceId: Id; blockers: Reason[] } | null;
  failover: { from: Id; code: SourceFaultCode } | null;
  frostFallback: Id | null;
  bivalent: { applies: boolean; hp: Id | null; reserve: Id | null; hpPermitted: boolean; reserveJoins: boolean; mode: BivalentMode };
  dew: { maxDewC: number | null; supplySpC: number | null; blocked: boolean; tripped: boolean };
}

export interface HpDirection {
  want: ModeOrNone;
  /** null = either direction may be used this tick. */
  allowed: Mode | null;
  blocker: Reason | null;
}

/** Which way a shared heat/cool heat pump may run now. Changeovers are at least `changeoverMinH` apart. */
export function hpDirection(s: SourceConfig, x: SelectionCtx, heat: readonly Caller[], cool: readonly RoomView[]): HpDirection {
  const cfg = x.idx.cfg;
  const m = x.mem[s.id];
  const current: ModeOrNone = m?.on && (m.mode === 'heat' || m.mode === 'cool') ? m.mode : (m?.hpMode ?? 'none');
  let want: ModeOrNone;
  const houseMode = cfg.house.mode;
  // frost protection needs heat, whatever the house mode or the stored direction
  if (heat.some((c) => c.frost)) want = 'heat';
  else if (houseMode === 'heat') want = 'heat';
  else if (houseMode === 'cool') want = 'cool';
  else if (houseMode === 'off') want = 'none';
  else if (cfg.cool.hpModeSelection === 'weather') want = x.season.season === 'heating' ? 'heat' : x.season.season === 'cooling' ? 'cool' : 'none';
  else {
    // the larger total deficit wins; rooms with their own AC for that mode do not vote
    const ownAc = (r: RoomView, mode: Mode) =>
      r.emitters.some((e) => {
        const src = e.sourceId ? x.idx.source.get(e.sourceId) : undefined;
        return !!src && src.scope === 'room' && e.roles[mode] !== null && eligibility(src, mode, x).ok;
      });
    let wH = 0;
    let wC = 0;
    for (const c of heat) if (!c.frost && c.room.t !== null && c.room.heatC !== null && !ownAc(c.room, 'heat')) wH += Math.max(0, c.room.heatC - c.room.t);
    for (const r of cool) if (r.t !== null && r.coolC !== null && !ownAc(r, 'cool')) wC += Math.max(0, r.t - r.coolC);
    want = wH > wC ? 'heat' : wC > wH ? 'cool' : current;
  }
  if (want === 'none') return { want, allowed: current === 'none' ? null : current, blocker: null };
  if (current === 'none' || current === want) return { want, allowed: want, blocker: null };
  const minH = s.guards.changeoverMinH ?? cfg.cool.changeoverMinH;
  const last = m?.lastChangeoverAt ?? null;
  const timeOk = last === null || x.now - last >= minH * HOUR_MS;
  const outside = want === 'heat' ? heat.length > 0 : cool.length > 0;
  if ((timeOk && outside) || heat.some((c) => c.frost)) return { want, allowed: want, blocker: null };
  return { want, allowed: current, blocker: timeOk ? null : { code: 'source.blocked.changeover', params: { until: (last ?? x.now) + minH * HOUR_MS } } };
}

function setWant(wants: Map<Id, SourceWant>, id: Id, w: Omit<SourceWant, 'roomIds' | 'circuitIds'> & { roomIds?: Iterable<Id>; circuitIds?: Iterable<Id> }): SourceWant {
  const cur = wants.get(id);
  if (cur && cur.mode === w.mode) {
    for (const r of w.roomIds ?? []) cur.roomIds.add(r);
    for (const c of w.circuitIds ?? []) cur.circuitIds.add(c);
    // frost outranks comfort, a lead outranks a member
    if (w.why === 'frost' || w.why === 'frost_fallback') cur.why = w.why;
    if (w.role === 'lead') {
      cur.role = 'lead';
      cur.roleReason = w.roleReason;
    }
    return cur;
  }
  if (cur && (cur.why === 'frost' || cur.why === 'frost_fallback') && w.mode !== 'heat') return cur;
  const next: SourceWant = { ...w, roomIds: new Set(w.roomIds ?? []), circuitIds: new Set(w.circuitIds ?? []) };
  wants.set(id, next);
  return next;
}

/** Available heat sources for frost, ignoring conditions, rules, budget, outdoor limits and the cutoff. */
function frostCandidates(x: SelectionCtx, ids: readonly Id[]): SourceConfig[] {
  const usable: SourceConfig[] = [];
  const locked: SourceConfig[] = [];
  for (const id of ids) {
    const s = x.idx.source.get(id);
    if (!s || !s.enabled || !s.capabilities.heat || usable.includes(s) || locked.includes(s)) continue;
    const h = x.health[id];
    const m = x.mem[id];
    if (!h || h.unbound || !h.available) continue;
    if (m?.fault && m.fault.retryAt > x.now) continue;
    (activeLock(x.idx.cfg, id, x.now)?.kind === 'source_off' ? locked : usable).push(s);
  }
  let out = usable.length ? usable : locked;
  if (x.phase === 'critical') {
    // on a dying battery: gas first, then the smallest electric source
    out = [...out].sort((a, b) => (a.energy.carrier === 'gas' ? 0 : 1) - (b.energy.carrier === 'gas' ? 0 : 1) || nominalKw(a) - nominalKw(b));
  }
  return out;
}

export interface Selection {
  wants: Map<Id, SourceWant>;
  plans: Map<Id, CircuitPlan>;
  hp: Map<Id, HpDirection>;
  /** Sources that must stop now regardless of their minimum run (dew guard, overheat, room limit). */
  safetyStops: Map<Id, string>;
  /** Room-scope sources: the room's reason they cannot run. */
  roomBlocked: Map<Id, { sourceId: Id; blockers: Reason[] }[]>;
  eligibilityCache: Map<string, Eligibility>;
  dewGuardSince: Record<Id, EpochMs>;
  dewTripped: Set<Id>;
  decisions: Decision[];
  detections: Detection[];
}

/** Plans every circuit and room-scope source for this tick. */
export function selectSources(x: SelectionCtx, prevDewGuardSince: Record<Id, EpochMs>): Selection {
  const { idx, now } = x;
  const cfg = idx.cfg;
  const wants = new Map<Id, SourceWant>();
  const plans = new Map<Id, CircuitPlan>();
  const safetyStops = new Map<Id, string>();
  const roomBlocked = new Map<Id, { sourceId: Id; blockers: Reason[] }[]>();
  const cache = new Map<string, Eligibility>();
  const decisions: Decision[] = [];
  const detections: Detection[] = [];
  const dewGuardSince: Record<Id, EpochMs> = {};
  const dewTripped = new Set<Id>();
  for (const [k, v] of Object.entries(prevDewGuardSince)) if (!idx.circuit.has(k)) dewGuardSince[k] = v; // other timers kept

  const elig = (s: SourceConfig, mode: SourceMode, opts: { frost?: boolean; coldGuard?: boolean } = {}) => {
    const key = `${s.id}:${mode}:${opts.frost ? 1 : 0}${opts.coldGuard ? 1 : 0}`;
    let e = cache.get(key);
    if (!e) {
      e = eligibility(s, mode, x, opts);
      cache.set(key, e);
    }
    return e;
  };

  /* callers and heat-pump directions */
  const heatBy = new Map<Id, Caller[]>();
  const coolBy = new Map<Id, { callers: RoomView[]; humid: RoomView[] }>();
  for (const c of idx.circuits) {
    heatBy.set(c.id, heatCallers(c, x));
    coolBy.set(c.id, coolCallers(c, x));
  }
  const hp = new Map<Id, HpDirection>();
  for (const s of cfg.sources) {
    if (s.scope !== 'central' || !s.capabilities.heat || !s.capabilities.cool) continue;
    const fed = idx.fedCircuits.get(s.id) ?? [];
    hp.set(s.id, hpDirection(s, x, fed.flatMap((c) => heatBy.get(c.id) ?? []), fed.flatMap((c) => coolBy.get(c.id)?.callers ?? [])));
  }
  const directionBlocks = (s: SourceConfig, mode: Mode): Reason | null => {
    const d = hp.get(s.id);
    if (!d || d.allowed === null || d.allowed === mode) return null;
    return d.blocker ?? { code: 'source.blocked.changeover', params: { until: null } };
  };

  /* central heating, per circuit */
  const heatChain = cfg.heat.chain;
  const biv = cfg.heat.bivalence;
  for (const c of idx.circuits) {
    const callers = heatBy.get(c.id) ?? [];
    const { humid } = coolBy.get(c.id) ?? { callers: [], humid: [] };
    const plan: CircuitPlan = {
      circuit: c,
      mode: null,
      heatCallers: callers,
      coolCallers: [],
      humidRooms: humid,
      selected: [],
      lead: null,
      blocked: null,
      failover: null,
      frostFallback: null,
      bivalent: { applies: false, hp: null, reserve: null, hpPermitted: true, reserveJoins: false, mode: biv.mode },
      dew: { maxDewC: null, supplySpC: null, blocked: false, tripped: false },
    };
    plans.set(c.id, plan);
    const entries = circuitEntries(x, heatChain, c, 'heat');
    const e0 = entries[0];
    const e1 = entries[1];
    const s0 = e0 && e0.sourceIds.length === 1 ? idx.source.get(e0.sourceIds[0]) : undefined;
    const pair = !!s0 && s0.kind === 'heat_pump' && !!e1 && e1.sourceIds.length === 1;
    const hpPermitted = biv.mode === 'alt' ? !x.frostLatch : biv.mode === 'partial' ? !x.limitLatch : true;
    const joinReasons: string[] = [];
    if (pair) {
      if (x.frostLatch && (biv.mode === 'parallel' || biv.mode === 'partial')) joinReasons.push('frost');
      if (x.lagLatch) joinReasons.push('lag');
      if (x.outdoorUnknownLong) joinReasons.push('outdoor_unknown');
    }
    plan.bivalent = { applies: pair, hp: pair ? s0!.id : null, reserve: pair ? e1!.sourceIds[0] : null, hpPermitted, reserveJoins: joinReasons.length > 0, mode: biv.mode };
    if (!callers.length) continue;

    const frost = callers.some((k) => k.frost);
    const coldGuard = callers.some((k) => k.coldGuard);
    const critical = x.phase === 'critical';
    const selected: Id[] = [];
    if (!critical) {
      for (const e of entries) {
        const isHp = pair && e === e0;
        const isReserve = pair && e === e1;
        if (isHp && !hpPermitted) {
          plan.blocked ??= { sourceId: s0!.id, blockers: [{ code: 'source.blocked.bivalence', params: { pointC: biv.mode === 'partial' ? biv.hpLimitC : biv.pointC, toutC: x.tout10 } }] };
          continue;
        }
        if (isReserve && pair && selected.includes(s0!.id) && joinReasons.length === 0) continue;
        let stop = false;
        const cand: Id[] = [];
        for (const id of e.sourceIds) {
          const s = idx.source.get(id);
          if (!s) continue;
          const el = elig(s, 'heat', { frost, coldGuard });
          const dir = directionBlocks(s, 'heat');
          const running = x.mem[id]?.on && x.mem[id]?.mode === 'heat';
          if (el.ok && !dir) cand.push(id);
          else if (el.hold && running && !dir) cand.push(id); // a short blip: keeps running logically
          else {
            if (el.hold) stop = true;
            const blockers = dir ? [dir, ...el.blockers] : el.blockers;
            if (!plan.blocked && blockers.length) plan.blocked = { sourceId: id, blockers };
            const f = x.mem[id]?.fault;
            if (!plan.failover && f && f.retryAt > now) plan.failover = { from: id, code: f.code };
          }
        }
        if (stop && !cand.length) break;
        if (!cand.length) continue;
        selected.push(...cand);
        if (!(isHp && joinReasons.length > 0)) break;
      }
    }

    if (!selected.length && frost) {
      // frost: the first heat source that can physically run, ignoring the comfort gates
      const pool = [...entries.flatMap((e) => e.sourceIds), ...c.sourceIds];
      // (on a critical battery this is the only way heat is made: gas first, then the smallest heater)
      const pick = frostCandidates(x, pool).find((s) => !directionBlocks(s, 'heat'));
      if (pick) {
        selected.push(pick.id);
        plan.frostFallback = critical ? null : pick.id;
      }
    }
    if (!selected.length) {
      if (plan.failover && callers.length) {
        detections.push({ kind: 'source_failed', dedupKey: `source_failed:none_eligible:heat:${c.id}`, active: true, facts: { reason: 'none_eligible', circuitId: c.id, mode: 'heat' } });
      }
      continue;
    }
    plan.mode = 'heat';
    plan.selected = selected;
    plan.lead = selected[0];
    const roomIds = callers.map((k) => k.room.id);
    selected.forEach((id, i) => {
      const s = idx.source.get(id)!;
      const isReserve = pair && id === plan.bivalent.reserve && selected.includes(plan.bivalent.hp ?? '');
      const why: WantWhy = plan.frostFallback === id ? 'frost_fallback' : frost && !callers.some((k) => !k.frost) ? 'frost' : coldGuard && !callers.some((k) => !k.coldGuard && !k.frost) ? 'cold_guard' : 'demand';
      const role: SourceRole = i === 0 ? 'lead' : 'together';
      const roleReason: Reason = isReserve && x.lagLatch ? { code: 'role.lag_join', params: {} } : { code: i === 0 ? 'role.lead' : 'role.together', params: {} };
      setWant(wants, s.id, { mode: 'heat', why, roomIds, circuitIds: [c.id], role, roleReason, emitterRole: null });
    });
    if (plan.frostFallback) {
      const roomId = callers.find((k) => k.frost)?.room.id ?? null;
      detections.push({ kind: 'frost_risk', dedupKey: `frost_risk:fallback:${plan.frostFallback}`, active: true, roomId, sourceId: plan.frostFallback, facts: { sourceId: plan.frostFallback, roomId } });
    }
  }

  /* central cooling, per circuit (first eligible wins; the dew point limits the supply) */
  const coolChain = cfg.cool.chain;
  const margin = (c: Circuit) => c.dewMarginC ?? cfg.cool.dewMarginC;
  for (const c of idx.circuits) {
    const plan = plans.get(c.id)!;
    const { callers } = coolBy.get(c.id) ?? { callers: [] };
    // the dew points of every member that would get cold water (also for the hard guard)
    const members = (idx.members.get(c.id) ?? []).filter((mm) => mm.emitter.roles.cool !== null && !mm.emitter.excludeFromCooling && !plan.humidRooms.includes(mm.room));
    const dewOf = (rooms: readonly RoomView[]) => {
      const dews = rooms.map((r) => r.dewC).filter((d): d is number => d !== null);
      return dews.length ? Math.max(...dews) : null;
    };
    const maxDew = dewOf(callers);
    const supplySp = coolSupplySetpoint(c.supply.coolC, maxDew, margin(c));
    plan.dew = { maxDewC: maxDew, supplySpC: callers.length ? supplySp : null, blocked: false, tripped: false };

    // hard guard: the measured supply runs too close to the dew point while the circuit cools
    const coolingNow = c.sourceIds.some((id) => x.mem[id]?.on && x.mem[id]?.mode === 'cool');
    const supplyC = numOf(snapOf(x.inputs, c.supply.sensorEntityId));
    const memberDew = dewOf(members.map((mm) => mm.room));
    if (coolingNow && supplyC !== null && memberDew !== null && supplyC < memberDew + margin(c) - DEW_HARD_SLACK_C) {
      const since = prevDewGuardSince[c.id] ?? now;
      dewGuardSince[c.id] = since;
      if (now - since >= DEW_HARD_HOLD_MS) {
        plan.dew.tripped = true;
        dewTripped.add(c.id);
        delete dewGuardSince[c.id];
        for (const id of c.sourceIds) if (x.mem[id]?.on && x.mem[id]?.mode === 'cool') safetyStops.set(id, 'dew_guard');
        decisions.push({ code: 'dew.guard', category: 'src', tone: 'warn', params: { circuitId: c.id, supplyC, dewC: memberDew }, entityIds: c.supply.sensorEntityId ? [c.supply.sensorEntityId] : [] });
      }
    }

    if (!callers.length || plan.mode === 'heat') {
      plan.coolCallers = plan.mode === 'heat' ? [] : callers;
      detections.push({ kind: 'dew_point_guard', dedupKey: `dew_point_guard:${c.id}`, active: plan.dew.tripped, facts: { circuitId: c.id, dewC: memberDew, supplyC } });
      continue;
    }
    plan.coolCallers = callers;
    if (supplySp > c.supply.coolMaxC) {
      // the floor would have to run warmer than is useful: cooling through it is pointless
      plan.dew.blocked = true;
      detections.push({ kind: 'dew_point_guard', dedupKey: `dew_point_guard:${c.id}`, active: true, facts: { circuitId: c.id, dewC: maxDew, supplyC: supplySp, maxSupplyC: c.supply.coolMaxC } });
      continue;
    }
    detections.push({ kind: 'dew_point_guard', dedupKey: `dew_point_guard:${c.id}`, active: plan.dew.tripped, facts: { circuitId: c.id, dewC: memberDew, supplyC } });
    if (plan.dew.tripped) continue;

    const selected: Id[] = [];
    for (const e of circuitEntries(x, coolChain, c, 'cool')) {
      let stop = false;
      for (const id of e.sourceIds) {
        const s = idx.source.get(id);
        if (!s) continue;
        const el = elig(s, 'cool');
        const dir = directionBlocks(s, 'cool');
        const running = x.mem[id]?.on && x.mem[id]?.mode === 'cool';
        if ((el.ok || (el.hold && running)) && !dir) selected.push(id);
        else {
          if (el.hold) stop = true;
          const blockers = dir ? [dir, ...el.blockers] : el.blockers;
          if (!plan.blocked && blockers.length) plan.blocked = { sourceId: id, blockers };
          const f = x.mem[id]?.fault;
          if (!plan.failover && f && f.retryAt > now) plan.failover = { from: id, code: f.code };
        }
      }
      if (selected.length || stop) break;
    }
    if (!selected.length) {
      if (plan.failover) detections.push({ kind: 'source_failed', dedupKey: `source_failed:none_eligible:cool:${c.id}`, active: true, facts: { reason: 'none_eligible', circuitId: c.id, mode: 'cool' } });
      continue;
    }
    plan.mode = 'cool';
    plan.selected = selected;
    plan.lead = selected[0];
    selected.forEach((id, i) =>
      setWant(wants, id, {
        mode: 'cool',
        why: 'demand',
        roomIds: callers.map((r) => r.id),
        circuitIds: [c.id],
        role: i === 0 ? 'lead' : 'together',
        roleReason: { code: i === 0 ? 'role.lead' : 'role.together', params: {} },
        emitterRole: null,
      }),
    );
  }

  /* room-scope sources: each serves its own room on the room's request */
  for (const s of cfg.sources) {
    if (s.scope !== 'room') continue;
    const list = idx.direct.get(s.id) ?? [];
    let best: { mode: SourceMode; room: RoomView; role: EmitterRole; frost: boolean } | null = null;
    for (const { room, emitter } of list) {
      const req = room.requests.get(emitter.id);
      let mode: SourceMode | null = req?.mode ?? null;
      let role: EmitterRole | null = mode ? (emitter.roles[mode] ?? req?.role ?? null) : null;
      if (!mode && room.dry && emitter.roles.cool !== null && s.capabilities.dry && room.demand !== 'cool') {
        mode = 'dry';
        role = emitter.roles.cool;
      }
      if (!mode && room.room.ac.control === 'asis' && s.adapter.type === 'climate' && !room.paused) {
        // «як є»: the AC regulates itself whenever the room's mode allows it, not by Klimo's latch
        const am = room.ev.partial.activeModes;
        const was = x.mem[s.id]?.mode;
        const pick: Mode | null = am.heat && am.cool ? (room.demand !== 'none' ? room.demand : was === 'heat' || was === 'cool' ? was : null) : am.heat ? 'heat' : am.cool ? 'cool' : null;
        if (pick && emitter.roles[pick] !== null) {
          mode = pick;
          role = emitter.roles[pick];
        }
      }
      if (!mode || !role) continue;
      const frost = room.frost && mode === 'heat';
      if (!best || (frost && !best.frost)) best = { mode, room, role, frost };
    }
    if (!best) continue;
    const { room, mode, role, frost } = best;
    if (x.phase === 'critical' && !frost) continue;

    // the room is too warm for a heater: switch it off now, whatever its minimum run
    if (mode === 'heat' && !frost) {
      if (room.overheat) {
        safetyStops.set(s.id, 'overheat');
        continue;
      }
      if (s.guards.roomMaxC !== null && room.t !== null && room.t >= s.guards.roomMaxC) {
        safetyStops.set(s.id, 'room_max');
        continue;
      }
    }
    const el = elig(s, mode, { frost });
    const sourceRole: SourceRole = role === 'assist' ? 'assist' : role === 'trigger' ? 'trigger_only' : 'room_primary';
    const roleReason: Reason =
      sourceRole === 'assist'
        ? { code: 'role.assist', params: {} }
        : sourceRole === 'trigger_only'
          ? { code: 'role.trigger_only', params: { triggerId: firstTrigger(s) } }
          : { code: 'role.room_primary', params: { roomId: room.id } };
    const why: WantWhy = frost ? 'frost' : role === 'trigger' ? 'storage' : mode === 'dry' ? 'dry' : room.room.ac.control === 'asis' && s.adapter.type === 'climate' ? 'asis' : 'demand';
    if (el.ok || (el.hold && x.mem[s.id]?.on)) {
      setWant(wants, s.id, { mode, why, roomIds: [room.id], circuitIds: [], role: sourceRole, roleReason, emitterRole: role });
      continue;
    }
    const list2 = roomBlocked.get(room.id) ?? [];
    list2.push({ sourceId: s.id, blockers: el.blockers });
    roomBlocked.set(room.id, list2);
    if (frost) {
      // frost in a room heated only by its own source: take it anyway when it can physically run
      const pick = frostCandidates(x, [s.id])[0];
      if (pick) {
        setWant(wants, s.id, { mode: 'heat', why: 'frost_fallback', roomIds: [room.id], circuitIds: [], role: sourceRole, roleReason, emitterRole: role });
        detections.push({ kind: 'frost_risk', dedupKey: `frost_risk:fallback:${s.id}`, active: true, roomId: room.id, sourceId: s.id, facts: { sourceId: s.id, roomId: room.id } });
      }
    }
  }

  /* frost rooms no circuit or own source could serve: any room-scope heat source of theirs */
  for (const r of idx.rooms) {
    if (!r.frost) continue;
    const served = [...wants.values()].some((w) => w.roomIds.has(r.id) && w.mode === 'heat');
    if (served) continue;
    const own = r.emitters.filter((e) => e.sourceId && e.roles.heat !== null).map((e) => e.sourceId as Id);
    const pick = frostCandidates(x, own).find((s) => !wants.has(s.id) || wants.get(s.id)!.mode === 'heat');
    if (!pick) continue;
    setWant(wants, pick.id, { mode: 'heat', why: 'frost_fallback', roomIds: [r.id], circuitIds: [], role: 'room_primary', roleReason: { code: 'role.room_primary', params: { roomId: r.id } }, emitterRole: null });
    detections.push({ kind: 'frost_risk', dedupKey: `frost_risk:fallback:${pick.id}`, active: true, roomId: r.id, sourceId: pick.id, facts: { sourceId: pick.id, roomId: r.id } });
  }

  /* direction changes that had to wait */
  for (const [id, d] of hp) {
    if (!d.blocker) continue;
    const before = x.prevPlant?.sources.find((p) => p.sourceId === id)?.blockers.some((b) => b.code === 'source.blocked.changeover');
    if (!before) decisions.push({ code: 'source.changeover_blocked', category: 'src', tone: 'warn', params: { until: d.blocker.params?.until ?? null }, sourceId: id });
  }

  return { wants, plans, hp, safetyStops, roomBlocked, eligibilityCache: cache, dewGuardSince, dewTripped, decisions, detections };
}

/** The trigger that gates a source (its first trigger condition item). */
export function firstTrigger(s: SourceConfig): Id | null {
  for (const item of s.conditions.items) if (item.enabled && item.node.op === 'trigger') return item.node.triggerId;
  return null;
}
