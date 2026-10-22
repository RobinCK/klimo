import { isHeldOverride, round1 } from '../../shared/model';
import type {
  Actor,
  ControlSetBy,
  Decision,
  Detection,
  EffectiveTarget,
  EngineConfig,
  EpochMs,
  HouseControl,
  HouseProfileState,
  Id,
  InputSnapshot,
  Override,
  PriorityKey,
  Profile,
  ProfileRoomSetting,
  ResolveHouseProfileFn,
  RoomConfig,
  RoomContext,
  RoomControl,
  RoomControlMode,
  RoomMemory,
  SpanEvent,
  TargetAdjustment,
  TargetDisplayKind,
  TargetLayer,
  WindowReaction,
} from '../../shared/model';
import { ENGINE_DEFAULTS } from '../../shared/defaults';
import { DAY_MS, HOUR_MS, houseSchedule, roomSchedule, scheduleAt, scheduleChanges } from './schedule';
import { clamp, round5min } from './util';

/* =====================================================================================================
 * Who decides the target. The house profile comes from the first house-level layer of the priority chain
 * with an opinion (manual override › calendar › presence › house schedule › default profile). A room then
 * walks the same chain with its own manual override and its own schedule, turns the winning profile into
 * heat/cool values, and applies rule offsets, optimal start, the window reaction, limits and the dual gap.
 * ===================================================================================================== */

const MIN_MS = 60_000;

export type HouseLayer = HouseProfileState['layer'];

export interface HouseOpinion {
  profileId: Id;
  layer: HouseLayer;
  until: EpochMs | null;
  startedAt: EpochMs | null;
}

interface Candidate {
  profileId: Id;
  until: EpochMs | null;
  startedAt: EpochMs;
}

export function isActiveAt(o: Pick<Override, 'until'>, ts: EpochMs): boolean {
  return o.until === null || o.until > ts;
}

export function houseOverride(cfg: Pick<EngineConfig, 'overrides'>, ts: EpochMs): Override | null {
  return cfg.overrides.find((o) => o.scope === 'house' && o.kind === 'house_profile' && isActiveAt(o, ts)) ?? null;
}

export function controlSetBy(actor: Actor | null | undefined): ControlSetBy | null {
  switch (actor?.via) {
    case 'ui':
    case 'card':
    case 'event':
    case 'automation':
      return actor.via;
    case 'ha':
    case 'voice':
    case 'mqtt':
    case 'notification':
      return 'ha';
    default:
      return null;
  }
}

/**
 * The room's target override at `ts`. A temporary change that has just run out hands over to the held
 * change under it right away (the shell writes that row back after the tick), so a manual room never
 * follows the schedule for a tick in between.
 */
export function roomTargetOverride(overrides: readonly Override[], roomId: Id, ts: EpochMs): Override | null {
  let back: Override | null = null;
  for (const o of overrides) {
    if (o.scope !== 'room' || o.subjectId !== roomId || o.group !== 'target') continue;
    if (isActiveAt(o, ts)) return o;
    back = back ?? heldUnder(o);
  }
  return back;
}

/** The room's control mode from its target override (see RoomControlMode). */
export function roomControlOf(overrides: readonly Override[], roomId: Id, ts: EpochMs): RoomControl {
  const o = roomTargetOverride(overrides, roomId, ts);
  if (!o) return { mode: 'schedule', since: null, until: null, setBy: null };
  const held = isHeldOverride(o);
  const mode: RoomControlMode = held ? (o.kind === 'room_off' ? 'off' : 'manual') : 'temporary';
  return { mode, since: o.createdAt, until: held ? null : o.until, setBy: controlSetBy(o.by) };
}

/** House control: the house profile held with no end pauses the house schedule. */
export function houseControlOf(overrides: readonly Override[], ts: EpochMs): HouseControl {
  const o = houseOverride({ overrides: overrides as Override[] }, ts);
  return o && o.until === null ? { mode: 'manual', since: o.createdAt } : { mode: 'schedule', since: null };
}

/** The held change a temporary one replaced (kept one level down so a boost on a manual room ends in manual). */
export function heldUnder(o: Override): Override | null {
  const prev = o.previous?.override ?? null;
  if (prev && isHeldOverride(prev)) return prev;
  const deeper = prev?.previous?.override ?? null;
  return deeper && isHeldOverride(deeper) ? deeper : null;
}

/** The room's active override of one group (target / airing / window_ignore). */
export function roomOverride(cfg: Pick<EngineConfig, 'overrides'>, roomId: Id, group: Override['group'], ts: EpochMs): Override | null {
  return cfg.overrides.find((o) => o.scope === 'room' && o.subjectId === roomId && o.group === group && isActiveAt(o, ts)) ?? null;
}

export function profileById(cfg: Pick<EngineConfig, 'profiles'>, id: Id | null | undefined): Profile | null {
  return (id && cfg.profiles.find((p) => p.id === id)) || null;
}

function profileOrder(cfg: Pick<EngineConfig, 'profiles'>, id: Id): number {
  return profileById(cfg, id)?.order ?? Number.MAX_SAFE_INTEGER;
}

/** Most recently started opinion wins; ties go to the profile listed first. */
function pickLatest(cfg: Pick<EngineConfig, 'profiles'>, list: Candidate[]): Candidate | null {
  let best: Candidate | null = null;
  for (const c of list) {
    if (!profileById(cfg, c.profileId)) continue;
    if (!best || c.startedAt > best.startedAt || (c.startedAt === best.startedAt && profileOrder(cfg, c.profileId) < profileOrder(cfg, best.profileId))) best = c;
  }
  return best;
}

/* ── presence ───────────────────────────────────────────────────────────────────────────────────── */

export function presenceState(cfg: EngineConfig, inputs: InputSnapshot): HouseProfileState['presence'] {
  const p = cfg.settings.presence;
  const configured = p.enabled && p.personEntityIds.length > 0;
  if (!configured) return { configured: false, anyoneHome: null, awaySince: null, approaching: false };
  const zone = inputs.entities[p.homeZoneEntityId];
  const homeNames = new Set(['home', p.homeZoneEntityId.split('.')[1] ?? '']);
  const zoneName = zone?.attrs['friendly_name'];
  if (typeof zoneName === 'string') homeNames.add(zoneName);
  const persons = p.personEntityIds.map((id) => inputs.entities[id]).filter((s) => s && s.available);
  if (!persons.length) return { configured, anyoneHome: null, awaySince: null, approaching: false };
  const anyoneHome = persons.some((s) => homeNames.has(s.state));
  const awaySince = anyoneHome ? null : Math.max(...persons.map((s) => s.lastChanged));
  let approaching = false;
  if (!anyoneHome && p.proximityEntityId) {
    const prox = inputs.entities[p.proximityEntityId];
    if (prox && prox.available && prox.num !== null) {
      const unit = String(prox.attrs['unit_of_measurement'] ?? 'km').toLowerCase();
      const km = unit === 'm' ? prox.num / 1000 : unit === 'mi' ? prox.num * 1.609 : prox.num;
      approaching = km <= p.approachKm;
    }
  }
  return { configured, anyoneHome, awaySince, approaching };
}

function presenceCandidates(cfg: EngineConfig, inputs: InputSnapshot, scheduledProfileId: Id | null, scheduledUntil: EpochMs | null): Candidate[] {
  const now = inputs.now;
  const pres = presenceState(cfg, inputs);
  const rules = cfg.activationRules.filter((r) => r.enabled);
  const awayProfiles = new Set(rules.filter((r) => r.config.type === 'presence' && r.config.trigger === 'all_away').map((r) => r.profileId));
  const out: Candidate[] = [];
  let vacationActive = false;
  for (const r of rules) {
    const c = r.config;
    if (c.type === 'vacation') {
      if (c.from === null || c.from > now) continue;
      const end = c.until === null ? null : c.until - c.returnLeadH * HOUR_MS;
      if (end !== null && now >= end) continue;
      vacationActive = true;
      out.push({ profileId: r.profileId, until: end, startedAt: c.from });
    }
  }
  if (!pres.configured || pres.anyoneHome === null) return out;
  const persons = cfg.settings.presence.personEntityIds.map((id) => inputs.entities[id]).filter((s) => s && s.available);
  for (const r of rules) {
    const c = r.config;
    if (c.type !== 'presence') continue;
    if (c.trigger === 'all_away' && !pres.anyoneHome && pres.awaySince !== null && !vacationActive) {
      const at = pres.awaySince + cfg.settings.presence.awayDelayMin * MIN_MS;
      if (now >= at) out.push({ profileId: r.profileId, until: null, startedAt: at });
    } else if (c.trigger === 'approaching' && !pres.anyoneHome && pres.approaching) {
      out.push({ profileId: r.profileId, until: null, startedAt: now });
    } else if (c.trigger === 'someone_home' && pres.anyoneHome && scheduledProfileId !== null && awayProfiles.has(scheduledProfileId)) {
      // someone stayed home while the plan says «away»: hold the home profile until the next boundary
      const since = Math.max(...persons.filter((s) => s.state !== 'not_home').map((s) => s.lastChanged), 0);
      out.push({ profileId: r.profileId, until: scheduledUntil, startedAt: since });
    }
  }
  return out;
}

function calendarCandidates(cfg: EngineConfig, inputs: InputSnapshot): Candidate[] {
  const out: Candidate[] = [];
  for (const r of cfg.activationRules) {
    const c = r.config;
    if (!r.enabled || c.type !== 'calendar') continue;
    const needle = c.match.contains.trim().toLowerCase();
    for (const ev of inputs.calendarEvents[c.calendarEntityId] ?? []) {
      const hay = String(ev[c.match.field] ?? '').toLowerCase();
      if (needle && !hay.includes(needle)) continue;
      if (ev.start - c.preheatMin * MIN_MS <= inputs.now && inputs.now < ev.end) out.push({ profileId: r.profileId, until: ev.end, startedAt: ev.start });
    }
  }
  return out;
}

/** Every house-level opinion of this tick, resolved through the priority chain. */
export function houseOpinion(cfg: EngineConfig, inputs: InputSnapshot): {
  winner: HouseOpinion;
  scheduled: { profileId: Id | null; until: EpochMs | null; nextProfileId: Id | null };
  override: Override | null;
} {
  const now = inputs.now;
  const tz = inputs.tz;
  const hs = houseSchedule(cfg);
  const sched = hs && hs.enabled ? scheduleAt(cfg, hs, now, tz) : null;
  const scheduledProfile = sched && profileById(cfg, sched.profileId) ? sched : null;
  let nextProfileId: Id | null = null;
  if (hs && hs.enabled) nextProfileId = scheduleChanges(cfg, hs, now, now + 7 * DAY_MS, tz)[0]?.profileId ?? null;
  const override = houseOverride(cfg, now);
  const scheduled = { profileId: scheduledProfile?.profileId ?? null, until: scheduledProfile?.until ?? null, nextProfileId };
  // house manual control (no end) holds against calendar and presence too, whatever the priority order
  const held = override !== null && override.until === null;

  for (const key of cfg.house.priority) {
    if ((key === 'manual' || held) && override && override.value.kind === 'house_profile' && profileById(cfg, override.value.profileId)) {
      return { winner: { profileId: override.value.profileId, layer: 'house_manual', until: override.until, startedAt: override.createdAt }, scheduled, override };
    }
    if (key === 'calendar') {
      const c = pickLatest(cfg, calendarCandidates(cfg, inputs));
      if (c) return { winner: { profileId: c.profileId, layer: 'calendar', until: c.until, startedAt: c.startedAt }, scheduled, override };
    }
    if (key === 'presence') {
      const c = pickLatest(cfg, presenceCandidates(cfg, inputs, scheduled.profileId, scheduled.until));
      if (c) return { winner: { profileId: c.profileId, layer: 'presence', until: c.until, startedAt: c.startedAt }, scheduled, override };
    }
    if (key === 'house_schedule' && scheduledProfile) {
      return { winner: { profileId: scheduledProfile.profileId, layer: 'house_schedule', until: scheduledProfile.until, startedAt: scheduledProfile.start }, scheduled, override };
    }
  }
  return { winner: { profileId: defaultProfileId(cfg), layer: 'default', until: null, startedAt: null }, scheduled, override };
}

export function defaultProfileId(cfg: Pick<EngineConfig, 'profiles' | 'settings'>): Id {
  return profileById(cfg, cfg.settings.defaultProfileId)?.id ?? [...cfg.profiles].sort((a, b) => a.order - b.order)[0]?.id ?? cfg.settings.defaultProfileId;
}

export const resolveHouseProfile: ResolveHouseProfileFn = (cfg, inputs) => {
  const { winner, scheduled, override } = houseOpinion(cfg, inputs);
  const state: HouseProfileState = {
    activeProfileId: winner.profileId,
    layer: winner.layer,
    scheduledProfileId: scheduled.profileId ?? defaultProfileId(cfg),
    scheduledUntil: scheduled.until,
    nextProfileId: scheduled.nextProfileId,
    override: winner.layer === 'house_manual' ? override : null,
    presence: presenceState(cfg, inputs),
  };
  // edges need the previous tick's state, which the shell keeps: see houseProfileEdges
  return { state, decisions: [], detections: [], spans: [] };
};

/**
 * Journal entry, event and `profile` span for a change of the house profile between two ticks. The shell
 * holds the previous HouseProfileState (the pure resolver has no memory of its own); null = boot.
 */
export function houseProfileEdges(
  prev: HouseProfileState | null,
  next: HouseProfileState,
  now: EpochMs,
): { decisions: Decision[]; detections: Detection[]; spans: SpanEvent[] } {
  const decisions: Decision[] = [];
  const detections: Detection[] = [];
  const spans: SpanEvent[] = [];
  if (prev && prev.activeProfileId === next.activeProfileId) return { decisions, detections, spans };
  if (prev) spans.push({ subject: 'profile', subjectId: prev.activeProfileId, kind: 'active', mode: null, edge: 'end', at: now });
  spans.push({ subject: 'profile', subjectId: next.activeProfileId, kind: 'active', mode: null, edge: 'start', at: now, meta: { profileId: next.activeProfileId } });
  if (!prev) return { decisions, detections, spans };
  const by = next.layer === 'house_manual' ? (next.override?.by.userName ?? next.override?.by.via ?? null) : next.layer;
  const until = next.layer === 'house_manual' ? (next.override?.until ?? null) : next.layer === 'house_schedule' ? next.scheduledUntil : null;
  decisions.push({ code: 'house_profile.changed', category: 'system', tone: 'event', params: { profileId: next.activeProfileId, until, by, layer: next.layer } });
  detections.push({ kind: 'house_profile_changed', dedupKey: `house_profile_changed:${now}`, active: true, facts: { profileId: next.activeProfileId, from: prev.activeProfileId, layer: next.layer } });
  return { decisions, detections, spans };
}

/* ── profiles → room values ───────────────────────────────────────────────────────────────────────── */

export interface ProfileValues {
  profileId: Id;
  heatC: number | null;
  coolC: number | null;
  /** Room switched off in this profile (row 'off' or a frost-only profile). */
  off: 'profile' | 'frost_only' | null;
  row: ProfileRoomSetting | null;
}

/** Room values of a profile: own row (half-null → profile default), «off», frost-only, or inherit. */
export function roomProfileValues(cfg: Pick<EngineConfig, 'profiles' | 'profileRooms'>, profileId: Id, roomId: Id): ProfileValues {
  const p = profileById(cfg, profileId);
  const row = cfg.profileRooms.find((r) => r.profileId === profileId && r.roomId === roomId) ?? null;
  if (!p) return { profileId, heatC: null, coolC: null, off: 'profile', row };
  if (p.frostOnly) return { profileId, heatC: null, coolC: null, off: 'frost_only', row };
  if (row?.mode === 'off') return { profileId, heatC: null, coolC: null, off: 'profile', row };
  if (row?.mode === 'own') return { profileId, heatC: row.heatC ?? p.heatC, coolC: row.coolC ?? p.coolC, off: null, row };
  return { profileId, heatC: p.heatC, coolC: p.coolC, off: null, row };
}

/* ── the room's base profile (everything except its own target override) ────────────────────────────── */

export interface BaseOpinion {
  profileId: Id;
  layer: Extract<TargetLayer, 'house_manual' | 'calendar' | 'presence' | 'room_schedule' | 'house_schedule' | 'default'>;
  display: TargetDisplayKind;
  until: EpochMs | null;
}

const LAYER_KEY: Record<BaseOpinion['layer'], PriorityKey> = {
  house_manual: 'manual',
  calendar: 'calendar',
  presence: 'presence',
  room_schedule: 'room_schedule',
  house_schedule: 'house_schedule',
  default: 'house_schedule',
};

export function priorityIndex(cfg: Pick<EngineConfig, 'house'>, key: PriorityKey): number {
  const i = cfg.house.priority.indexOf(key);
  return i < 0 ? Number.MAX_SAFE_INTEGER : i;
}

/** The room's base profile now, from the house state of this tick and the room's own schedule. */
export function roomBaseNow(cfg: EngineConfig, room: RoomConfig, inputs: InputSnapshot, house: HouseProfileState): BaseOpinion {
  const now = inputs.now;
  const rs = roomSchedule(cfg, room.id);
  const own = rs ? scheduleAt(cfg, rs, now, inputs.tz) : null;
  let houseUntil: EpochMs | null = null;
  if (house.layer === 'house_manual') houseUntil = house.override?.until ?? null;
  else if (house.layer === 'house_schedule') houseUntil = house.scheduledUntil;
  else if (house.layer === 'calendar' || house.layer === 'presence') {
    const w = houseOpinion(cfg, inputs).winner;
    houseUntil = w.profileId === house.activeProfileId && w.layer === house.layer ? w.until : null;
  }
  const fromHouse = (layer: BaseOpinion['layer']): BaseOpinion => ({
    profileId: house.activeProfileId,
    layer,
    display: layer === 'calendar' ? 'calendar' : layer === 'presence' ? 'presence' : 'schedule',
    until: houseUntil,
  });
  for (const key of cfg.house.priority) {
    if (key === 'manual' && house.layer === 'house_manual') return fromHouse('house_manual');
    if (key === 'calendar' && house.layer === 'calendar') return fromHouse('calendar');
    if (key === 'presence' && house.layer === 'presence') return fromHouse('presence');
    if (key === 'room_schedule' && own && profileById(cfg, own.profileId)) {
      return { profileId: own.profileId, layer: 'room_schedule', display: 'schedule', until: own.until };
    }
    if (key === 'house_schedule') return fromHouse(house.layer === 'default' ? 'default' : house.layer);
  }
  return fromHouse(house.layer === 'default' ? 'default' : house.layer);
}

/**
 * The base profile at any instant from the layers that can be predicted: a time-limited house override,
 * the room schedule and the house schedule. Calendar and presence opinions are not foreseeable and are
 * left out; durations and look-aheads use this.
 */
export function scheduledBaseAt(cfg: EngineConfig, roomId: Id | null, ts: EpochMs, tz: string): BaseOpinion {
  const ho = houseOverride(cfg, ts);
  const rs = roomId ? roomSchedule(cfg, roomId) : null;
  const hs = houseSchedule(cfg);
  for (const key of cfg.house.priority) {
    if ((key === 'manual' || ho?.until === null) && ho && ho.value.kind === 'house_profile' && profileById(cfg, ho.value.profileId)) {
      return { profileId: ho.value.profileId, layer: 'house_manual', display: 'schedule', until: ho.until };
    }
    if (key === 'room_schedule' && rs) {
      const o = scheduleAt(cfg, rs, ts, tz);
      if (o && profileById(cfg, o.profileId)) return { profileId: o.profileId, layer: 'room_schedule', display: 'schedule', until: o.until };
    }
    if (key === 'house_schedule' && hs && hs.enabled) {
      const o = scheduleAt(cfg, hs, ts, tz);
      if (o && profileById(cfg, o.profileId)) return { profileId: o.profileId, layer: 'house_schedule', display: 'schedule', until: o.until };
    }
  }
  return { profileId: defaultProfileId(cfg), layer: 'default', display: 'schedule', until: null };
}

/** Instants in (from, to] where the predictable base profile of a room (or of the house) may change. */
export function baseChangeCandidates(cfg: EngineConfig, roomId: Id | null, from: EpochMs, to: EpochMs, tz: string): EpochMs[] {
  const set = new Set<EpochMs>();
  const hs = houseSchedule(cfg);
  if (hs && hs.enabled) for (const c of scheduleChanges(cfg, hs, from, to, tz)) set.add(c.at);
  const rs = roomId ? roomSchedule(cfg, roomId) : null;
  if (rs) for (const c of scheduleChanges(cfg, rs, from, to, tz)) set.add(c.at);
  const ho = houseOverride(cfg, from);
  if (ho && ho.until !== null && ho.until > from && ho.until <= to) set.add(ho.until);
  return [...set].sort((a, b) => a - b);
}

/** First instant in (from, to] where the predictable base profile differs from the one at `from`. */
export function nextBaseChange(cfg: EngineConfig, roomId: Id | null, from: EpochMs, to: EpochMs, tz: string): { at: EpochMs; base: BaseOpinion } | null {
  const current = scheduledBaseAt(cfg, roomId, from, tz).profileId;
  for (const at of baseChangeCandidates(cfg, roomId, from, to, tz)) {
    const base = scheduledBaseAt(cfg, roomId, at, tz);
    if (base.profileId !== current) return { at, base };
  }
  return null;
}

/* ── the room target ─────────────────────────────────────────────────────────────────────────────── */

export interface RoomTargetInput {
  /** Aggregated room temperature (optimal start lead). */
  tempC: number | null;
  windowOpen: boolean;
  windowReaction: WindowReaction | null; // active reaction (after the open delay), null when none
  airing: Override | null;
}

export interface RoomTargetResult {
  /** Target before mode availability; `finalizeTarget` sets `mode` / `displayC` and drops inactive halves. */
  target: EffectiveTarget;
  /** Values before the window reaction («17.6 → 19.0» while paused). */
  beforeWindow: { heatC: number | null; coolC: number | null };
  base: BaseOpinion;
  /** Room switched off by an override or its profile. */
  off: 'room' | 'profile' | 'frost_only' | null;
  targetOverride: Override | null;
  /** The room's manual value wins (rule offsets and optimal start do not apply). */
  manual: boolean;
  /** Next value of the room's optimal-start latch. */
  preheat: RoomMemory['preheat'];
}

export function frostFloorOf(cfg: Pick<EngineConfig, 'safety'>, room: RoomConfig): number {
  return Math.max(cfg.safety.frostC, room.frostC ?? Number.NEGATIVE_INFINITY);
}

export function limitsOf(cfg: Pick<EngineConfig, 'settings'>, room: RoomConfig): { heatMinC: number; heatMaxC: number; coolMinC: number; coolMaxC: number } {
  return room.limits ?? cfg.settings.targetLimits;
}

function sourcesOfRoom(cfg: EngineConfig, roomId: Id): Set<Id> {
  const out = new Set<Id>();
  for (const e of cfg.emittersByRoom[roomId] ?? []) {
    if (!e.enabled) continue;
    if (e.sourceId) out.add(e.sourceId);
    if (e.circuitId) for (const s of cfg.circuits.find((c) => c.id === e.circuitId)?.sourceIds ?? []) out.add(s);
  }
  return out;
}

interface Preheat {
  at: EpochMs;
  profileId: Id;
  heatC: number;
  leadMin: number;
}

/** Optimal start: the first upcoming rise of the heat target, started early by the learned heating rate. */
function findPreheat(
  cfg: EngineConfig,
  room: RoomConfig,
  inputs: InputSnapshot,
  memory: RoomMemory,
  heatNow: number,
  tempC: number,
  offsetC: number,
  horizonMin: number,
  capLead: boolean,
  baseUntil: EpochMs | null,
  /** Presence and calendar opinions hold through schedule boundaries: only their own end matters. */
  onlyLayerEnd: boolean,
): Preheat | null {
  const now = inputs.now;
  const to = now + horizonMin * MIN_MS;
  const candidates = new Set(onlyLayerEnd ? [] : baseChangeCandidates(cfg, room.id, now, to, inputs.tz));
  if (baseUntil !== null && baseUntil > now && baseUntil <= to) candidates.add(baseUntil);
  const rate = memory.learned.heatRateCPerH ?? ENGINE_DEFAULTS.learning.defaultRateCPerH;
  for (const at of [...candidates].sort((a, b) => a - b)) {
    const base = scheduledBaseAt(cfg, room.id, at, inputs.tz);
    const v = roomProfileValues(cfg, base.profileId, room.id);
    if (v.heatC === null) continue;
    const next = round1(v.heatC + offsetC);
    if (next <= heatNow) continue;
    const raw = round5min(((next - tempC) / Math.max(rate, 0.05)) * 60);
    const lead = capLead ? clamp(raw, 5, horizonMin) : Math.max(5, raw);
    return { at, profileId: base.profileId, heatC: next, leadMin: lead };
  }
  return null;
}

/** Room target: priority walk, profile values, offsets, optimal start, window, limits, dual gap. */
export function resolveRoomTarget(cfg: EngineConfig, room: RoomConfig, inputs: InputSnapshot, memory: RoomMemory, ctx: RoomContext, input: RoomTargetInput): RoomTargetResult {
  const now = inputs.now;
  const frostFloorC = frostFloorOf(cfg, room);
  const adjustments: TargetAdjustment[] = [];
  const base = roomBaseNow(cfg, room, inputs, ctx.house);
  const targetOverride = roomTargetOverride(cfg.overrides, room.id, now);

  const empty = (layer: TargetLayer, display: TargetDisplayKind): RoomTargetResult => ({
    target: {
      heatC: null,
      coolC: null,
      mode: 'none',
      displayC: null,
      layer,
      display,
      profileId: null,
      overrideId: null,
      until: null,
      next: null,
      adjustments,
      profileUpdated: false,
      frostFloorC,
      preheat: null,
    },
    beforeWindow: { heatC: null, coolC: null },
    base,
    off: null,
    targetOverride,
    manual: false,
    preheat: null,
  });
  if (!room.controlEnabled) return empty('monitor', 'monitor');

  // does the room's own override beat the layer the base profile came from? A held one always does:
  // manual control means no profile layer moves the room until the schedule is resumed
  const manualWins =
    targetOverride !== null && (isHeldOverride(targetOverride) || priorityIndex(cfg, 'manual') <= priorityIndex(cfg, LAYER_KEY[base.layer]));
  let profileId = base.profileId;
  let layer: TargetLayer = base.layer;
  let display: TargetDisplayKind = base.display;
  let until = base.until;
  let overrideId: Id | null = null;
  let off: RoomTargetResult['off'] = null;
  let manual = false;
  const ov = manualWins ? targetOverride : null;
  if (ov && ov.value.kind === 'room_profile' && profileById(cfg, ov.value.profileId)) {
    profileId = ov.value.profileId;
    layer = 'room_profile';
    display = 'room_profile';
    until = ov.until;
    overrideId = ov.id;
  }
  const pv = roomProfileValues(cfg, profileId, room.id);
  let heat = pv.heatC;
  let cool = pv.coolC;
  if (pv.off) off = pv.off;

  if (ov && ov.value.kind !== 'room_profile') {
    overrideId = ov.id;
    until = ov.until;
    const v = ov.value;
    if (v.kind === 'room_off') {
      heat = null;
      cool = null;
      off = 'room';
      layer = 'room_off';
      display = 'off';
    } else if (v.kind === 'room_target') {
      manual = true;
      off = null;
      layer = 'manual';
      if (v.mode === 'dual') {
        heat = v.heatC;
        cool = v.coolC;
        display = 'range';
      } else {
        if (v.mode === 'heat') heat = v.heatC;
        else cool = v.coolC;
        display = 'manual';
      }
    } else if (v.kind === 'room_boost') {
      manual = true;
      off = null;
      layer = 'manual';
      display = 'boost';
      if (v.mode === 'heat') heat = v.targetC;
      else cool = v.targetC;
    }
  }
  if (off === 'profile' || off === 'frost_only') display = 'off';

  const profileUpdated =
    !manual && off === null && pv.row?.writtenAt != null && now - pv.row.writtenAt <= ENGINE_DEFAULTS.overrides.profileUpdatedBadgeH * HOUR_MS;
  if (profileUpdated && display === 'schedule') display = 'profile_updated';

  // rule offsets never move a value the user set by hand
  const offsets = ctx.overlay.targetOffsets[room.id];
  let heatOffset = 0;
  if (!manual && offsets) {
    if (heat !== null && offsets.heat) {
      heat += offsets.heat.deltaC;
      heatOffset = offsets.heat.deltaC;
      adjustments.push({ code: 'rule_offset', deltaC: offsets.heat.deltaC, ref: offsets.heat.ruleId });
    }
    if (cool !== null && offsets.cool) {
      cool += offsets.cool.deltaC;
      adjustments.push({ code: 'rule_offset', deltaC: offsets.cool.deltaC, ref: offsets.cool.ruleId });
    }
  }

  let preheat: EffectiveTarget['preheat'] = null;
  let preheatLatch: RoomMemory['preheat'] = null;
  const scheduleLike = layer === 'room_schedule' || layer === 'house_schedule' || layer === 'presence' || layer === 'default';
  if (heat !== null && input.tempC !== null && !input.windowOpen && input.windowReaction === null && !input.airing && (scheduleLike || layer === 'calendar')) {
    let found: Preheat | null = null;
    if (scheduleLike && room.smart.optimalStart.enabled) {
      found = findPreheat(cfg, room, inputs, memory, heat, input.tempC, heatOffset, room.smart.optimalStart.maxLeadMin, true, until, layer === 'presence');
    }
    // a rule may pre-heat with cheap energy further ahead, without the optimal-start cap
    const viaRule = ctx.overlay.preheatSourceIds.some((id) => sourcesOfRoom(cfg, room.id).has(id));
    if (!found && viaRule) found = findPreheat(cfg, room, inputs, memory, heat, input.tempC, heatOffset, 24 * 60, false, until, !scheduleLike || layer === 'presence');
    // once started, pre-heat holds until the block begins: the lead shrinks as the room warms, and
    // re-deciding it every tick switches the heating on and off every few minutes
    if (found) {
      const held = memory.preheat?.forBlockAt === found.at && memory.preheat.profileId === found.profileId ? memory.preheat : null;
      const reached = held !== null && input.tempC >= round1(found.heatC + room.tolerance.heat.above);
      const due = input.tempC < found.heatC && now >= found.at - found.leadMin * MIN_MS;
      if (!reached && (held || due)) {
        adjustments.push({ code: 'optimal_start', deltaC: round1(found.heatC - heat), ref: found.profileId });
        heat = found.heatC;
        display = 'preheat';
        preheatLatch = held ? { ...held, heatC: found.heatC } : { forBlockAt: found.at, profileId: found.profileId, heatC: found.heatC, leadMin: found.leadMin, since: now };
        preheat = { forBlockAt: found.at, leadMin: preheatLatch.leadMin };
      }
    }
  }

  const beforeWindow = { heatC: heat === null ? null : round1(heat), coolC: cool === null ? null : round1(cool) };
  if (input.airing) {
    layer = 'airing';
    display = 'airing';
  } else if (input.windowReaction && input.windowReaction !== 'notify') {
    layer = 'window';
    display = 'window';
    if (input.windowReaction === 'eco') {
      const eco = roomProfileValues(cfg, cfg.settings.ecoProfileId, room.id);
      heat = heat === null ? null : eco.heatC;
      cool = cool === null ? null : eco.coolC;
      adjustments.push({ code: 'window_eco', deltaC: null, ref: cfg.settings.ecoProfileId });
    } else if (input.windowReaction === 'lower') {
      if (heat !== null) heat -= room.windows.lowerByC;
      if (cool !== null) cool += room.windows.lowerByC;
      adjustments.push({ code: 'window_lower', deltaC: -room.windows.lowerByC, ref: null });
    }
  }

  const lim = limitsOf(cfg, room);
  if (heat !== null) {
    const c = clamp(round1(heat), lim.heatMinC, lim.heatMaxC);
    if (c !== round1(heat)) adjustments.push({ code: 'clamped', deltaC: round1(c - heat), ref: null });
    heat = c;
  }
  if (cool !== null) {
    const c = clamp(round1(cool), lim.coolMinC, lim.coolMaxC);
    if (c !== round1(cool)) adjustments.push({ code: 'clamped', deltaC: round1(c - cool), ref: null });
    cool = c;
  }
  const gap = cfg.cool.autoMinGapC;
  if (heat !== null && cool !== null && round1(cool - heat) < gap) {
    const pushed = round1(heat + gap);
    adjustments.push({ code: 'dual_gap', deltaC: round1(pushed - cool), ref: null });
    cool = pushed;
  }

  let next: EffectiveTarget['next'] = null;
  if (until !== null && until > now && until <= now + 48 * HOUR_MS) {
    const b = scheduledBaseAt(cfg, room.id, until, inputs.tz);
    const v = roomProfileValues(cfg, b.profileId, room.id);
    next = { at: until, profileId: b.profileId, heatC: v.heatC, coolC: v.coolC };
  }

  return {
    target: {
      heatC: heat,
      coolC: cool,
      mode: 'none',
      displayC: null,
      layer,
      display,
      profileId,
      overrideId,
      until,
      next,
      adjustments,
      profileUpdated,
      frostFloorC,
      preheat,
    },
    beforeWindow,
    base,
    off,
    targetOverride,
    manual,
    preheat: preheatLatch,
  };
}

/** Sets the controlling mode and drops the halves the room cannot use now (season, no emitter, house off). */
export function finalizeTarget(t: EffectiveTarget, active: { heat: boolean; cool: boolean }): EffectiveTarget {
  const heatC = active.heat ? t.heatC : null;
  const coolC = active.cool ? t.coolC : null;
  const mode: EffectiveTarget['mode'] = heatC !== null && coolC !== null ? 'dual' : heatC !== null ? 'heat' : coolC !== null ? 'cool' : 'none';
  const next = t.next ? { ...t.next, heatC: active.heat ? t.next.heatC : null, coolC: active.cool ? t.next.coolC : null } : null;
  return { ...t, heatC, coolC, mode, displayC: mode === 'heat' ? heatC : mode === 'cool' ? coolC : null, next };
}
