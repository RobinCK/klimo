import { BRAND } from '../common/brand';
import { sourceLabels } from '../config/source-labels';
import { sourceTemplate } from '../shared/defaults';
import { round1 } from '../shared/model';
import type {
  CardTextKey,
  Celsius,
  CommandReply,
  DurationOption,
  EngineConfig,
  EngineHealth,
  EpochMs,
  EventKind,
  HouseMode,
  HouseProfileState,
  HouseState,
  HubAttrs,
  Id,
  IncidentDto,
  IssueCode,
  ITexts,
  Lang,
  PlantState,
  ReasonParams,
  ReplyAttrs,
  RoomCardAttrs,
  RoomClimateStatePayload,
  RoomConfig,
  RoomIssue,
  RoomState,
  RoomSummary,
  Season,
  SeasonState,
  SourceMode,
  SourceKind,
  SourceRole,
  SourceState,
  SparkDto,
  ThermostatModel,
  Tone,
} from '../shared/model';
import { climateModes, roomCapabilities, type ClimateMode } from './discovery';

/* ── budgets ─────────────────────────────────────────────────────────────────────────────────── */

/** HA drops attributes above 16 KB; the hub aims at 8 KB for 12 rooms and never exceeds 14 KB. */
export const HUB_BUDGET = 8 * 1024;
export const HUB_HARD_CAP = 14 * 1024;
export const CARD_CAP = 4 * 1024;
export const CLIMATE_ATTRS_CAP = 300;
export const REPLY_RING = 8;

const SUB_TRIM = 40;
const HUB_ROOMS_KEEP = 24;
const SPARK_POINTS = 13;

export function byteSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/* ── view ────────────────────────────────────────────────────────────────────────────────────── */

/** Everything one publish pass reads: the engine's last evaluation plus configuration and texts. */
export interface PublishView {
  now: EpochMs;
  tz: string;
  lang: Lang;
  cfg: EngineConfig;
  texts: ITexts;
  health: EngineHealth;
  /** Klimo ↔ Home Assistant link healthy. */
  online: boolean;
  panel: string | null;
  house: HouseState;
  season: SeasonState;
  plant: PlantState;
  profile: HouseProfileState;
  rooms: RoomState[];
  summaries: RoomSummary[];
  thermostat: (roomId: Id) => ThermostatModel | null;
  sparks: Record<Id, SparkDto>;
  durations: DurationOption[];
  problems: { count: number; kinds: EventKind[] };
  alerts: number;
  /**
   * Open incidents, hidden ones included. They give the room card's issue its incident (the card's
   * «Ігнорувати 30 хв» / «Сховати») and keep an issue the user hid off the cards. Without them the
   * engine's own link on the issue is used and nothing is hidden.
   */
  incidents?: readonly IncidentLink[];
}

/** What a room card needs to know about an incident. */
export type IncidentLink = Pick<IncidentDto, 'id' | 'kind' | 'roomId' | 'sourceId' | 'entityId' | 'deviceKey' | 'hidden'>;

type OnOff = 'ON' | 'OFF';
const onOff = (b: boolean): OnOff => (b ? 'ON' : 'OFF');
const r1 = (x: number | null | undefined): number | null => (x === null || x === undefined || !Number.isFinite(x) ? null : round1(x));
const r0 = (x: number | null | undefined): number | null => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x));
const r2 = (x: number | null | undefined): number | null => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);

/** Renders card texts; a missing key or a failing renderer yields '' rather than breaking the payload. */
export function cardText(texts: ITexts, key: CardTextKey, vars: ReasonParams = {}): string {
  try {
    return texts.card(key, vars);
  } catch {
    return '';
  }
}

function issueText(texts: ITexts, issue: RoomIssue): string {
  try {
    return texts.issue(issue);
  } catch {
    return '';
  }
}

/** Lookups shared by every builder of one pass. */
export class ViewIndex {
  readonly roomById = new Map<Id, RoomConfig>();
  readonly stateById = new Map<Id, RoomState>();
  readonly summaryById = new Map<Id, RoomSummary>();
  private readonly lines = new Map<Id, Line>();
  private readonly entities = new Map<Id, Set<string>>();
  private readonly sourceLabels: Map<Id, string>;

  constructor(readonly view: PublishView) {
    this.sourceLabels = sourceLabels(view.cfg);
    for (const r of view.cfg.rooms) this.roomById.set(r.id, r);
    for (const s of view.rooms) this.stateById.set(s.roomId, s);
    for (const s of view.summaries) this.summaryById.set(s.id, s);
  }

  tx(key: CardTextKey, vars: ReasonParams = {}): string {
    return cardText(this.view.texts, key, vars);
  }

  profileName(id: Id | null | undefined): string | null {
    return id ? this.view.cfg.profiles.find((p) => p.id === id)?.name ?? null : null;
  }

  /**
   * Sources sharing a name read with their room («Кондиціонер · Вітальня»), except on that room's own
   * card, where the plain name (and its short word) says enough.
   */
  sourceName(id: Id | null | undefined, inRoom: Id | null = null): string | null {
    if (!id) return null;
    const s = this.view.cfg.sources.find((x) => x.id === id);
    if (!s) return null;
    return inRoom !== null && s.roomId === inRoom ? s.name : (this.sourceLabels.get(id) ?? s.name);
  }

  /** The texts shorten a source still called by its default name («від ТН»): they need its kind. */
  sourceKind(id: Id | null | undefined): SourceKind | null {
    return id ? this.view.cfg.sources.find((s) => s.id === id)?.kind ?? null : null;
  }

  /** The open incident behind a room issue: the engine's own link, else the same problem raised for this room or its devices. */
  incidentOf(roomId: Id, issue: RoomIssue): Pick<IncidentLink, 'id' | 'hidden'> | null {
    const list = this.view.incidents;
    if (!list) return issue.incidentId ? { id: issue.incidentId, hidden: false } : null;
    if (issue.incidentId) {
      const linked = list.find((i) => i.id === issue.incidentId);
      if (linked) return linked;
    }
    const kinds = ISSUE_EVENTS[issue.code];
    if (!kinds) return null;
    const p = issue.params;
    const entities = this.roomEntities(roomId);
    return (
      list.find(
        (i) =>
          kinds.includes(i.kind) &&
          (i.roomId === roomId ||
            (!!i.entityId && (entities.has(i.entityId) || i.entityId === p.entityId)) ||
            (!!i.deviceKey && i.deviceKey === p.deviceKey) ||
            (!!i.sourceId && i.sourceId === p.sourceId)),
      ) ?? null
    );
  }

  /** The room's issues the user has not hidden (snoozed or «Сховати»), most important first. */
  visibleIssues(roomId: Id): { issue: RoomIssue; incident: Pick<IncidentLink, 'id' | 'hidden'> | null }[] {
    const state = this.stateById.get(roomId);
    const summary = this.summaryById.get(roomId);
    const issues = state?.issues.length ? state.issues : summary?.issue ? [summary.issue] : [];
    return issues.map((issue) => ({ issue, incident: this.incidentOf(roomId, issue) })).filter((x) => !x.incident?.hidden);
  }

  private roomEntities(roomId: Id): Set<string> {
    let set = this.entities.get(roomId);
    if (!set) {
      const cfg = this.view.cfg;
      set = new Set<string>();
      for (const s of cfg.sensorsByRoom[roomId] ?? []) set.add(s.entityId);
      for (const e of cfg.emittersByRoom[roomId] ?? []) for (const d of cfg.devicesByEmitter[e.id] ?? []) set.add(d.entityId);
      this.entities.set(roomId, set);
    }
    return set;
  }

  roomName(id: Id): string {
    return this.roomById.get(id)?.name ?? id;
  }

  roomNames(ids: Id[]): string {
    return ids.map((id) => this.roomName(id)).join(', ');
  }

  /** The room's target-source line, computed once per pass (room card and hub row share it). */
  srcLine(roomId: Id): Line {
    let line = this.lines.get(roomId);
    if (!line) {
      line = targetLine(this, roomId);
      this.lines.set(roomId, line);
    }
    return line;
  }
}

interface Line {
  k: RoomCardAttrs['src']['k'];
  t: string;
  at: EpochMs | null;
}

/** Which alerts stand behind a room issue (hints and waits have none). */
const ISSUE_EVENTS: Partial<Record<IssueCode, readonly EventKind[]>> = {
  no_data: ['room_no_data'],
  sensor_offline: ['sensor_offline', 'entity_unavailable'],
  fallback_sensors: ['sensor_offline', 'entity_unavailable'],
  source_fault: ['source_failed', 'source_unavailable'],
  trv_failed: ['trv_not_confirmed'],
  trv_retry: ['trv_not_confirmed'],
  entity_missing: ['entity_missing'],
  too_cold: ['room_too_cold'],
  too_hot: ['room_too_hot'],
  overheat: ['overheat'],
  actuator_conflict: ['actuator_conflict'],
  condensation: ['condensation_risk'],
  humidity_high: ['humidity_high'],
  floor_humid: ['dew_point_guard'],
  battery_low: ['battery_low'],
  window_long: ['window_open_long'],
  signal_weak: ['signal_weak'],
};

/* ── house state document (select/sensor/binary entities of the house) ─────────────────────── */

export interface HouseStateDoc {
  profile: string | null;
  profile_attrs: { profile_id: Id; layer: HouseProfileState['layer']; until: EpochMs | null; next_profile_id: Id | null };
  season_mode: HouseMode;
  season: Season;
  season_attrs: { mode: HouseMode; avg_outdoor: Celsius | null; since: EpochMs; pending_to: Season | null; eligible_at: EpochMs | null };
  outdoor_avg: Celsius | null;
  active_source: string;
  active_source_attrs: { source_id: Id | null; mode: SourceMode | null; since: EpochMs | null; role: SourceRole | null };
  heat_demand: OnOff;
  heat_rooms: Id[];
  cool_demand: OnOff;
  cool_rooms: Id[];
  problem: OnOff;
  problem_attrs: { count: number; kinds: EventKind[] };
  alerts: number;
  power_kw: number | null;
  bivalent_point: Celsius;
}

/**
 * Until when the active house profile is known to hold: the end of a change by hand or of the schedule
 * block. A calendar or presence profile lasts as long as its reason, which the schedule's block end
 * does not tell.
 */
export function houseProfileUntil(p: HouseProfileState): EpochMs | null {
  if (p.layer === 'house_manual') return p.override?.until ?? null;
  return p.layer === 'house_schedule' ? p.scheduledUntil : null;
}

/** The source that «works» now: the season's lead when it runs, else the first running one. */
export function activeSource(plant: PlantState, season: Season): SourceState | null {
  const running = plant.sources.filter((s) => s.on);
  if (!running.length) return null;
  const leadId = season === 'cooling' ? plant.lead.cool ?? plant.lead.heat : plant.lead.heat ?? plant.lead.cool;
  return running.find((s) => s.sourceId === leadId) ?? running[0];
}

export function houseStateDoc(ix: ViewIndex): HouseStateDoc {
  const { view } = ix;
  const { season, plant, profile, cfg } = view;
  const lead = activeSource(plant, season.season);
  return {
    profile: ix.profileName(profile.activeProfileId),
    profile_attrs: {
      profile_id: profile.activeProfileId,
      layer: profile.layer,
      until: houseProfileUntil(profile),
      next_profile_id: profile.nextProfileId,
    },
    season_mode: season.houseMode,
    season: season.season,
    season_attrs: {
      mode: season.houseMode,
      avg_outdoor: r1(season.avgC),
      since: season.since,
      pending_to: season.pending?.to ?? null,
      eligible_at: season.pending?.eligibleAt ?? null,
    },
    outdoor_avg: r1(season.avgC),
    active_source: lead ? ix.sourceName(lead.sourceId) ?? lead.sourceId : 'none',
    active_source_attrs: {
      source_id: lead?.sourceId ?? null,
      mode: lead?.mode ?? null,
      since: lead?.since ?? null,
      role: lead?.role ?? null,
    },
    heat_demand: onOff(plant.heatDemand),
    heat_rooms: view.rooms.filter((r) => r.demand.mode === 'heat').map((r) => r.roomId),
    cool_demand: onOff(plant.coolDemand),
    cool_rooms: view.rooms.filter((r) => r.demand.mode === 'cool').map((r) => r.roomId),
    problem: onOff(view.problems.count > 0),
    problem_attrs: { count: view.problems.count, kinds: view.problems.kinds },
    alerts: view.alerts,
    power_kw: r2(plant.energy.usedKw),
    bivalent_point: cfg.heat.bivalence.pointC,
  };
}

/* ── room climate state (every room entity reads it) ──────────────────────────────────────────── */

/** HA climate mode: off when the room is off, a concrete mode under a manual target, auto otherwise. */
export function reportedMode(state: RoomState, modes: ClimateMode[]): ClimateMode {
  const t = state.target;
  let mode: ClimateMode = 'auto';
  if (t.display === 'off' || t.layer === 'room_off') mode = 'off';
  else if (t.display === 'range' || (t.display === 'manual' && t.mode === 'dual')) mode = 'heat_cool';
  else if (t.display === 'manual' || t.display === 'boost') mode = t.mode === 'cool' ? 'cool' : t.mode === 'heat' ? 'heat' : 'auto';
  // a mode the entity does not offer right now would be rejected by HA: report the schedule instead
  return modes.includes(mode) ? mode : mode === 'off' ? 'off' : 'auto';
}

export function roomStatePayload(ix: ViewIndex, room: RoomConfig, state: RoomState): RoomClimateStatePayload {
  const { view } = ix;
  const modes = climateModes(roomCapabilities(view.cfg, room), view.season.season, view.season.houseMode);
  const t = state.target;
  const dual = t.mode === 'dual';
  const payload: RoomClimateStatePayload = {
    mode: reportedMode(state, modes),
    action: state.hvacAction,
    cur: r1(state.tempC),
    hum: r0(state.humidity.valuePct),
    t: dual ? null : r1(t.displayC),
    lo: dual ? r1(t.heatC) : null,
    hi: dual ? r1(t.coolC) : null,
    preset: ix.profileName(t.profileId),
    target: r1(t.displayC ?? t.heatC ?? t.coolC),
    target_mode: t.mode,
    dew: r1(state.humidity.dewPointC),
    heat: onOff(state.demand.mode === 'heat'),
    cool: onOff(state.demand.mode === 'cool'),
    window: onOff(state.window.anyOpen || state.window.virtual),
    state: state.state,
    attrs: {
      room_id: room.id,
      state: state.state,
      target_source: t.display,
      until: t.until,
      profile_id: t.profileId,
      next_profile_id: t.next?.profileId ?? null,
      serving_source_id: state.demand.servingSourceIds[0] ?? null,
    },
  };
  return payload;
}

/* ── plant state documents ────────────────────────────────────────────────────────────────────── */

export interface SourceStateDoc {
  state: OnOff;
  /** Opt-in switch: OFF while a «вимкнено» lock holds the source. */
  allowed: OnOff;
  attrs: {
    state: SourceState['state'];
    mode: SourceMode | null;
    role: SourceRole;
    since: EpochMs | null;
    power_kw: number | null;
    supply: Celsius | null;
    cop: number | null;
    fault: string | null;
  };
}

export function sourceStateDoc(s: SourceState): SourceStateDoc {
  return {
    state: onOff(s.on),
    allowed: onOff(s.lock?.kind !== 'source_off'),
    attrs: {
      state: s.state,
      mode: s.mode,
      role: s.role,
      since: s.since,
      power_kw: r2(s.telemetry.powerKw),
      supply: r1(s.telemetry.supplyC),
      cop: r1(s.telemetry.cop),
      fault: s.fault?.code ?? null,
    },
  };
}

export interface CircuitStateDoc {
  state: OnOff;
  attrs: { reason: string | null; run_on_until: EpochMs | null; mode: string; rooms: Id[] };
}

export function circuitStateDoc(c: PlantState['circuits'][number]): CircuitStateDoc {
  const running = c.pumps.find((p) => p.on);
  return {
    state: onOff(c.pumpOn),
    attrs: { reason: running?.reason ?? null, run_on_until: c.runOnUntil, mode: c.mode, rooms: c.requestingRoomIds },
  };
}

export interface TriggerStateDoc {
  state: OnOff;
  attrs: { since: EpochMs | null; status: string; value: number | string | null };
}

export function triggerStateDoc(t: PlantState['triggers'][number]): TriggerStateDoc {
  return { state: onOff(t.active), attrs: { since: t.since, status: t.status, value: typeof t.value === 'number' ? r1(t.value) : t.value } };
}

/* ── room card (sensor.klimo_<slug>_card attributes) ─────────────────────────────────────────── */

function targetLine(ix: ViewIndex, roomId: Id): Line {
  const state = ix.stateById.get(roomId);
  const summary = ix.summaryById.get(roomId);
  if (!state || !summary) return { k: 'no_data', t: ix.tx('card.src.no_data'), at: null };
  const t = state.target;
  const k = summary.src.kind;
  const profile = ix.profileName(summary.src.profileId ?? t.profileId);
  const frost = t.frostFloorC;
  const value = r1(summary.src.valueC ?? t.displayC ?? t.heatC ?? t.coolC);
  const until = summary.src.until ?? t.until;
  // `at` goes into the vars too: a «до {t}» part without a clock to fill is dropped, not left dangling
  const line = (kind: Line['k'], key: CardTextKey, vars: ReasonParams, at: EpochMs | null): Line => ({ k: kind, t: ix.tx(key, { ...vars, at }), at });
  switch (k) {
    case 'schedule':
      return line(k, 'card.src.schedule', { profile, t: value }, until);
    case 'profile_updated':
      return line(k, 'card.src.profile_updated', { profile, t: value }, until);
    case 'manual':
      return line(k, 'card.src.manual', { t: value }, until);
    case 'range':
      return line(k, 'card.src.range', { lo: r1(summary.range?.lo ?? t.heatC), hi: r1(summary.range?.hi ?? t.coolC) }, until);
    case 'boost':
      return line(k, 'card.src.boost', { delta: r1(summary.src.deltaC), t: value }, until);
    case 'window':
      return state.window.reactionActive || !state.window.reactionAt
        ? line(k, 'card.src.window', {}, summary.src.since ?? state.window.openSince)
        : line(k, 'card.src.window_pending', {}, state.window.reactionAt);
    case 'airing':
      return line(k, 'card.src.airing', {}, until);
    case 'off': {
      if (t.layer === 'room_off') return line(k, 'card.src.off_room', { frost }, until);
      if (state.demand.block === 'house_off' || ix.view.season.houseMode === 'off') return line(k, 'card.src.off_house', { frost }, null);
      return line(k, 'card.src.off_profile', { profile, frost }, until);
    }
    case 'monitor': {
      const comfort = r1(summary.src.valueC ?? summary.targetC);
      if (comfort !== null) return line(k, 'card.src.monitor', { t: comfort }, null);
      return line(k, 'card.src.monitor_nothing', { mode: ix.view.season.season === 'cooling' ? 'cool' : 'heat' }, null);
    }
    case 'frost':
      return line(k, 'card.src.frost', { frost }, null);
    case 'presence':
      return line(k, 'card.src.presence', { profile }, until);
    case 'calendar':
      return line(k, 'card.src.calendar', { profile, t: value }, until);
    case 'room_profile':
      return line(k, 'card.src.room_profile', { profile }, until);
    case 'preheat':
      return line(k, 'card.src.preheat', { t: value, profile: ix.profileName(t.next?.profileId) ?? profile }, t.preheat?.forBlockAt ?? until);
    default:
      return { k: 'no_data', t: ix.tx('card.src.no_data'), at: null };
  }
}

function deviceLine(ix: ViewIndex, room: RoomConfig, state: RoomState, summary: RoomSummary): RoomCardAttrs['dev'] {
  const d = summary.device;
  // the texts shorten a source still called by its default name («від ТН») and need its kind for that
  const source = ix.sourceName(d.sourceId, room.id);
  const sourceKind = ix.sourceKind(d.sourceId);
  const syncing = (state.sync.phase === 'sending' || state.sync.phase === 'partial' || state.sync.phase === 'retry') && d.total > 0 && d.acked < d.total;
  switch (d.kind) {
    case 'trv': {
      if (syncing) return { k: d.kind, t: ix.tx('card.dev.trv_sync', { acked: d.acked, total: d.total }) };
      if (d.valvePct !== null) return { k: d.kind, t: ix.tx('card.dev.valve', { pct: r0(d.valvePct), source, sourceKind }) };
      const closed = state.trvs.length > 0 && state.trvs.every((x) => x.activity !== 'heating') && state.demand.mode !== 'heat';
      if (closed) return { k: d.kind, t: ix.tx('card.dev.trv_closed', { total: state.trvs.length }) };
      return { k: d.kind, t: ix.tx('card.dev.trv', { source, sourceKind, acked: d.acked, total: d.total }) };
    }
    case 'floor':
      return { k: d.kind, t: ix.tx('card.dev.floor', { source, sourceKind }) };
    case 'trvfloor': {
      if (syncing) return { k: d.kind, t: ix.tx('card.dev.trv_sync', { acked: d.acked, total: d.total }) };
      const extra = (ix.view.cfg.emittersByRoom[room.id] ?? []).filter((e) => e.enabled && e.kind !== 'floor').map((e) => e.name).join(', ');
      return { k: d.kind, t: ix.tx('card.dev.trvfloor', { extra, source, sourceKind }) };
    }
    case 'ac': {
      const running = state.emitters.some((e) => e.kind === 'direct' && e.open);
      return running ? { k: d.kind, t: ix.tx('card.dev.ac', { mode: state.demand.mode === 'none' ? null : state.demand.mode }) } : { k: d.kind, t: ix.tx('card.dev.ac_idle') };
    }
    case 'heater': {
      const on = state.emitters.some((e) => e.kind === 'direct' && e.open);
      return { k: d.kind, t: ix.tx(on ? 'card.dev.heater_on' : 'card.dev.heater_off') };
    }
    default:
      return { k: 'none', t: ix.tx('card.dev.none') };
  }
}

/** Clock reference of an issue text: an «until» (wait, retry) wins over the problem's start. */
function issueAt(issue: RoomIssue): EpochMs | null {
  const until = issue.params.until;
  if (typeof until === 'number') return until;
  const since = issue.params.since;
  if (typeof since === 'number') return since;
  return issue.since ?? null;
}

const RELATIVE_DURATIONS: ReadonlySet<string> = new Set(['1h', '2h', '3h', 'until']);

/** «+1 h» ends move with every evaluation; cards compute them locally, so they never make the payload tick. */
export function stableThermostat(th: ThermostatModel): ThermostatModel {
  const untils: ThermostatModel['untils'] = {};
  for (const [k, v] of Object.entries(th.untils) as [keyof ThermostatModel['untils'], EpochMs | null][]) {
    if (!RELATIVE_DURATIONS.has(k)) untils[k] = v;
  }
  return { ...th, untils };
}

export function stableDurations(list: DurationOption[]): HubAttrs['durations'] {
  return list.filter((d) => d.id !== 'until').map((d) => ({ id: d.id as HubAttrs['durations'][number]['id'], u: RELATIVE_DURATIONS.has(d.id) ? null : d.until }));
}

function sparkline(spark: SparkDto | undefined): { sp: (number | null)[]; stg: (number | null)[] | null } {
  const sp = Array.from({ length: SPARK_POINTS }, (_, i) => r1(spark?.values[i] ?? null));
  const targets = spark?.targets && spark.targets.length === SPARK_POINTS ? spark.targets.map((v) => r1(v)) : null;
  return { sp, stg: targets };
}

export function roomCardAttrs(ix: ViewIndex, room: RoomConfig): RoomCardAttrs | null {
  const state = ix.stateById.get(room.id);
  const summary = ix.summaryById.get(room.id);
  const th = ix.view.thermostat(room.id);
  if (!state || !summary || !th) return null;
  const texts = ix.view.texts;
  const src = ix.srcLine(room.id);
  const w = summary.window;
  const issues = ix.visibleIssues(room.id);
  const first = issues[0];
  const next = state.target.next;
  const nextTemp = state.target.mode === 'cool' ? next?.coolC ?? next?.heatC : next?.heatC ?? next?.coolC;
  let why: string | null = null;
  if (state.why[0]) {
    try {
      why = texts.reason(state.why[0]);
    } catch {
      why = null;
    }
  }
  const { sp, stg } = sparkline(ix.view.sparks[room.id]);
  const card: RoomCardAttrs = {
    kv: 'klimo_room',
    v: 1,
    id: room.id,
    slug: room.slug,
    n: room.name,
    st: state.state,
    stText: ix.tx(`card.state.${state.state}` as CardTextKey),
    t: r1(state.tempC),
    tg: r1(summary.targetC),
    lo: r1(summary.range?.lo),
    hi: r1(summary.range?.hi),
    tol: [summary.tol.below, summary.tol.above],
    tr: r1(state.trendCPerH),
    h: r0(summary.humidityPct),
    hw: summary.humidityWarn,
    win: w
      ? w.open
        ? { o: true, t: ix.tx('card.win.open', { at: w.openSince }), at: w.openSince }
        : { o: false, t: w.total > 1 ? ix.tx('card.win.closed_n', { n: w.total }) : ix.tx('card.win.closed'), at: null }
      : null,
    dev: deviceLine(ix, room, state, summary),
    src: { k: src.k, t: src.t, at: src.at },
    iss: first
      ? {
          tone: first.issue.tone,
          i: first.issue.icon,
          t: issueText(texts, first.issue),
          at: issueAt(first.issue),
          more: issues.length - 1,
          id: first.incident?.id ?? null,
        }
      : null,
    sp,
    stg,
    next: next ? { t: ix.tx('card.next', { profile: ix.profileName(next.profileId), temp: r1(nextTemp ?? null), at: next.at }), at: next.at } : null,
    why,
    th: stableThermostat(th),
    sync: state.sync,
  };
  return fitCard(card);
}

/** Keeps a room card under 4 KB: the «Чому» sentence goes first, then the target band of the sparkline. */
export function fitCard(card: RoomCardAttrs, cap = CARD_CAP): RoomCardAttrs {
  let c = card;
  if (byteSize(c) <= cap) return c;
  c = { ...c, why: null };
  if (byteSize(c) <= cap) return c;
  c = { ...c, stg: null };
  if (byteSize(c) <= cap) return c;
  // pathological (very long names/texts): shorten the free texts, then the thermostat's day strip
  c = {
    ...c,
    src: { ...c.src, t: trim(c.src.t, 80) },
    dev: { ...c.dev, t: trim(c.dev.t, 60) },
    iss: c.iss ? { ...c.iss, t: trim(c.iss.t, 80) } : null,
    win: c.win ? { ...c.win, t: trim(c.win.t, 40) } : null,
    next: c.next ? { ...c.next, t: trim(c.next.t, 60) } : null,
  };
  if (byteSize(c) <= cap) return c;
  return { ...c, th: { ...c.th, strip: [] } };
}

function trim(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1).trimEnd()}…`;
}

/* ── hub (sensor.klimo_hub) ───────────────────────────────────────────────────────────────────── */

function seasonTone(season: SeasonState): Tone {
  if (season.houseMode === 'off') return 'off';
  if (season.season === 'heating') return 'heat';
  if (season.season === 'cooling') return 'cool';
  return 'hold';
}

function modeTone(mode: SourceMode | string | null | undefined): Tone {
  if (mode === 'heat') return 'heat';
  if (mode === 'cool' || mode === 'dry' || mode === 'fan') return 'cool';
  return 'hold';
}

/** Short state of the whole house for `sensor.klimo_hub`. */
export function hubState(view: PublishView): 'heating' | 'cooling' | 'idle' | 'off' {
  if (view.season.houseMode === 'off') return 'off';
  const running = view.plant.sources.filter((s) => s.on);
  if (running.some((s) => s.mode === 'heat')) return 'heating';
  if (running.some((s) => s.mode === 'cool' || s.mode === 'dry')) return 'cooling';
  return 'idle';
}

function sourceAt(s: SourceState): EpochMs | null {
  if (s.fault) return s.fault.retryAt;
  if (s.on) return s.since;
  const until = s.blockers.find((b) => typeof b.params?.until === 'number')?.params?.until;
  return typeof until === 'number' ? until : null;
}

/** A reason in words; a code the texts cannot render is better left out than shown raw. */
function reasonText(ix: ViewIndex, r: Parameters<ITexts['reason']>[0] | undefined): string | null {
  if (!r) return null;
  try {
    return ix.view.texts.reason(r) || null;
  } catch {
    return null;
  }
}

/** The state chip of a source row («Гріє», «Пауза · ще {d}», «Аварія»). */
function sourceLine(ix: ViewIndex, s: SourceState): string {
  return ix.tx('card.source.line', {
    state: s.state,
    role: s.role,
    mode: s.mode,
    on: s.on,
    fault: s.fault?.code ?? null,
    blocker: s.blockers[0]?.code ?? null,
    at: sourceAt(s),
  });
}

/**
 * The line under a source: telemetry while it runs («з {t} · подача 38° · 2.1 кВт · COP 3.1»), the
 * fault and its retry, else why it is not running — the first blocker, or its role in the strategy.
 * Supply is rounded to whole degrees so the hub does not republish on every tenth.
 */
function sourceSub(ix: ViewIndex, s: SourceState): string {
  const waiting = s.on ? null : reasonText(ix, s.blockers[0]) ?? (s.role === 'unused' ? null : reasonText(ix, s.roleReason));
  return ix.tx('card.source.sub', {
    state: s.state,
    on: s.on,
    mode: s.mode,
    supply: r0(s.telemetry.supplyC),
    power: r1(s.telemetry.powerKw),
    cop: r1(s.telemetry.cop),
    fault: s.fault?.code ?? null,
    text: s.on ? reasonText(ix, s.roleReason) : waiting,
    at: sourceAt(s),
  });
}

function houseTiles(ix: ViewIndex): HubAttrs['house']['tiles'] {
  const { view } = ix;
  const { plant, season, house, lang } = view;
  const L = TILE_LABELS[lang === 'uk' ? 'uk' : 'en'];
  const running = plant.sources.filter((s) => s.on);
  const lead = activeSource(plant, season.season);
  const pumpsOn = plant.circuits.filter((c) => c.pumpOn);
  const pumpCount = plant.circuits.reduce((n, c) => n + c.pumps.filter((p) => p.on).length, 0) + plant.manifoldPumps.filter((p) => p.on).length;
  const hum = r0(house.humidityAvgPct);
  return [
    {
      key: 'source',
      label: running.length > 1 ? L.sources : L.source,
      value: ix.tx('card.tile.source', {
        name: running.length ? running.map((s) => ix.sourceName(s.sourceId) ?? s.sourceId).join(', ') : null,
        state: lead?.state ?? 'idle',
        mode: lead?.mode ?? null,
        n: running.length,
      }),
      sub: lead ? sourceSub(ix, lead) : '',
      tone: lead ? modeTone(lead.mode) : 'hold',
      at: lead ? sourceAt(lead) : null,
      wide: running.length > 1,
    },
    {
      key: 'pumps',
      label: L.pumps,
      value: ix.tx('card.tile.pumps', { n: pumpCount, state: pumpsOn.length ? 'running' : 'off' }),
      sub: listText(pumpsOn.map((c) => lowerFirst(circuitName(ix, c.circuitId))), lang),
      tone: pumpsOn.length ? modeTone(pumpsOn[0].mode) : 'hold',
      at: null,
      wide: false,
    },
    {
      key: 'humidity',
      label: L.humidity,
      value: ix.tx('card.tile.humidity', { rh: hum }),
      sub: L.humidityAvg,
      tone: hum !== null && hum >= 60 ? 'warn' : 'hold',
      at: null,
      wide: false,
    },
    {
      key: 'outdoor',
      label: L.outdoor,
      value: ix.tx('card.tile.outdoor', { t: r1(season.outdoorC), avg: r1(season.avgC), days: season.rule.avgDays }),
      sub: '',
      tone: 'hold',
      at: null,
      wide: false,
    },
  ];
}

const TILE_LABELS = {
  en: { source: 'Source', sources: 'Sources', pumps: 'Pumps', humidity: 'Humidity', humidityAvg: 'house average', outdoor: 'Outdoor' },
  uk: { source: 'Джерело', sources: 'Джерела', pumps: 'Насоси', humidity: 'Вологість', humidityAvg: 'середня по дому', outdoor: 'Надворі' },
} as const;

/** «Радіатори» reads as «радіатори» inside a sentence; an abbreviation («ТП-1») keeps its case. */
function lowerFirst(name: string): string {
  const [a, b] = name;
  return a && b && b === b.toLocaleLowerCase() && b !== b.toLocaleUpperCase() ? a.toLocaleLowerCase() + name.slice(1) : name;
}

/** «радіатори й підлога», «a, b і c» (Ukrainian «й» after a vowel, «і» after a consonant); "a and b". */
function listText(items: string[], lang: Lang): string {
  if (items.length < 2) return items.join('');
  const head = items.slice(0, -1).join(', ');
  const tail = items[items.length - 1];
  if (lang !== 'uk') return `${head} and ${tail}`;
  return `${head} ${/[аеєиіїоуюяАЕЄИІЇОУЮЯ]$/.test(head) ? 'й' : 'і'} ${tail}`;
}

function circuitName(ix: ViewIndex, id: Id): string {
  const c = ix.view.cfg.circuits.find((x) => x.id === id);
  return c ? c.shortName || c.name : id;
}

function houseHeadline(ix: ViewIndex): string {
  const { season, house } = ix.view;
  const { active, capable, total } = house.counts;
  if (season.houseMode === 'off') return ix.tx('card.house.off');
  if (active > 0) return ix.tx('card.house.head', { verb: house.verb, act: active, cap: capable });
  if (season.season === 'neutral') return ix.tx('card.house.neutral');
  return ix.tx('card.house.all_ok', { n: capable || total });
}

export function hubAttrs(ix: ViewIndex): HubAttrs {
  const { view } = ix;
  const { cfg, season, plant, house, profile } = view;
  const lead = activeSource(plant, season.season);
  const leadName = lead ? ix.sourceName(lead.sourceId) : null;
  const until = houseProfileUntil(profile);
  const profiles = [...cfg.profiles].sort((a, b) => a.order - b.order);
  const sourceOrder = new Map(cfg.sources.map((s) => [s.id, s.order]));
  const circuitOrder = new Map(cfg.circuits.map((c) => [c.id, c.order]));
  const triggerById = new Map(cfg.triggers.map((t) => [t.id, t]));

  const rooms: HubAttrs['rooms'] = [...view.summaries]
    .sort((a, b) => a.order - b.order)
    .map((s) => {
      const line = ix.srcLine(s.id);
      const stText = ix.tx(`card.state.${s.state}` as CardTextKey);
      const issue = ix.visibleIssues(s.id)[0]?.issue ?? null;
      return {
        id: s.id,
        s: s.slug,
        n: s.name,
        st: s.state,
        t: r1(s.tempC),
        tg: r1(s.targetC),
        it: issue?.tone ?? null,
        iss: issue ? issueText(view.texts, issue) : null,
        sub: ix.tx('card.room.sub', { state: stText, src: line.t }),
        at: line.at,
        attn: !!issue || s.state === 'window',
        ord: s.order,
      };
    });

  const hub: HubAttrs = {
    kv: 'klimo',
    v: 1,
    online: view.online,
    health: view.health,
    lang: view.lang,
    tz: view.tz,
    panel: view.panel,
    brand: { name: BRAND.productName, cold: BRAND.colors.cold, warm: BRAND.colors.warm, dot: BRAND.colors.dot },
    season: {
      mode: season.houseMode,
      cur: season.season,
      avg: r1(season.avgC),
      out: r1(season.outdoorC),
      tone: seasonTone(season),
      t: ix.tx('card.season', { season: season.season, avg: r1(season.avgC), mode: season.houseMode, days: season.rule.avgDays }),
    },
    house: {
      verb: house.verb,
      act: house.counts.active,
      cap: house.counts.capable,
      tot: house.counts.total,
      att: house.counts.attention,
      head: houseHeadline(ix),
      sub: lead ? ix.tx('card.house.sub', { source: leadName, sourceKind: ix.sourceKind(lead.sourceId), state: lead.state, mode: lead.mode, at: lead.since }) : '',
      at: lead?.since ?? null,
      attText: house.counts.attention > 0 ? ix.tx('card.house.attention', { n: house.counts.attention }) : null,
      hum: r0(house.humidityAvgPct),
      profile: {
        id: profile.activeProfileId,
        layer: profile.layer,
        until,
        next: profile.nextProfileId,
        // how the profile was chosen: by schedule (until the block ends, then the next one), by hand,
        // by the calendar, by presence or the default
        t:
          until !== null
            ? ix.tx('card.house.profile_until', { profile: ix.profileName(profile.nextProfileId), layer: profile.layer, at: until })
            : ix.tx('card.house.profile', { profile: null, layer: profile.layer }),
      },
      tiles: houseTiles(ix),
    },
    profiles: profiles.map((p) => ({ id: p.id, n: p.name, c: p.color, k: p.ink, i: p.icon, h: p.heatC, cl: p.coolC, frost: p.frostOnly })),
    durations: stableDurations(view.durations),
    sources: [...plant.sources]
      .sort((a, b) => (sourceOrder.get(a.sourceId) ?? 0) - (sourceOrder.get(b.sourceId) ?? 0))
      .map((s) => {
        const cfgSource = cfg.sources.find((x) => x.id === s.sourceId);
        return {
          id: s.sourceId,
          n: ix.sourceName(s.sourceId) ?? s.sourceId,
          i: cfgSource ? sourceTemplate(cfgSource.kind).icon : 'anyEntity',
          st: s.state,
          tone: s.tone,
          on: s.on,
          role: s.role,
          t: sourceLine(ix, s),
          sub: sourceSub(ix, s),
          at: sourceAt(s),
        };
      }),
    circuits: [...plant.circuits]
      .sort((a, b) => (circuitOrder.get(a.circuitId) ?? 0) - (circuitOrder.get(b.circuitId) ?? 0))
      .map((c) => {
        const pump = c.pumps.find((p) => p.on) ?? c.pumps[0];
        // the line and sub-line texts read a pump state (or 'summer') and either the asking rooms or
        // the source the pump follows, with its run-on
        const pumpCfg = cfg.pumps.filter((p) => p.circuitId === c.circuitId && p.enabled);
        const followsSource = pumpCfg.some((p) => p.rule === 'source') || (!c.requestingRoomIds.length && pumpCfg.some((p) => p.rule === 'both'));
        const runOnMin = pumpCfg.reduce((m, p) => Math.max(m, c.mode === 'cool' ? p.runOnCoolMin : p.runOnHeatMin), 0);
        const lineState =
          c.state.code === 'circuit.summer' ? 'summer' : c.runOnUntil !== null ? 'run_on' : pump?.state ?? (c.pumpOn ? 'running' : 'off');
        const feeding = followsSource ? c.feedingSourceIds : [];
        const vars: ReasonParams = {
          state: lineState,
          rooms: !followsSource && c.requestingRoomIds.length ? ix.roomNames(c.requestingRoomIds) : null,
          source: feeding.length ? feeding.map((id) => ix.sourceName(id) ?? id).join(', ') : null,
          // one source the pump follows reads by its short word when it still has its default name
          sourceKind: feeding.length === 1 ? ix.sourceKind(feeding[0]) : null,
          runOnMin: runOnMin > 0 ? runOnMin : null,
          stateCode: c.state.code,
          mode: c.mode,
          on: c.pumpOn,
          runOn: c.runOnUntil !== null,
          reason: pump?.reason ?? null,
          requesting: ix.roomNames(c.requestingRoomIds),
          members: ix.roomNames(c.memberRoomIds),
          excluded: ix.roomNames(c.excludedRooms.map((x) => x.roomId)),
          sources: c.feedingSourceIds.map((id) => ix.sourceName(id) ?? id).join(', '),
          supply: r0(c.supplyC),
          at: c.runOnUntil,
        };
        return {
          id: c.circuitId,
          n: circuitName(ix, c.circuitId),
          tone: c.tone,
          on: c.pumpOn,
          t: ix.tx('card.circuit.line', vars),
          sub: ix.tx('card.circuit.sub', vars),
          at: c.runOnUntil,
        };
      }),
    energy: plant.energy.configured
      ? {
          g: plant.energy.grid,
          pv: r1(plant.energy.pvKw),
          bat: r0(plant.energy.batteryPct),
          load: r1(plant.energy.houseLoadKw),
          t: ix.tx('card.energy.line', {
            grid: plant.energy.grid,
            soc: r0(plant.energy.batteryPct),
            phase: plant.energy.phase,
            pv: r1(plant.energy.pvKw),
            bat: r0(plant.energy.batteryPct),
            load: r1(plant.energy.houseLoadKw),
          }),
          tone: plant.energy.grid === 'absent' || plant.energy.phase === 'critical' ? 'err' : plant.energy.restrictionsActive ? 'warn' : 'ok',
        }
      : null,
    triggers: plant.triggers
      .filter((t) => t.enabled)
      .map((t) => ({
        id: t.triggerId,
        n: triggerById.get(t.triggerId)?.name ?? t.triggerId,
        on: t.active,
        // an idle trigger without a scheduled change has no line of its own: the card shows its name
        t: !t.active && t.nextChangeAt === null ? '' : ix.tx('card.trigger.line', {
          name: triggerById.get(t.triggerId)?.name ?? t.triggerId,
          state: t.active ? 'active' : 'next',
          status: t.status,
          active: t.active,
          value: typeof t.value === 'number' ? r1(t.value) : t.value,
          live: t.live.code,
          at: t.active ? t.since : t.nextChangeAt,
        }),
        at: t.active ? t.since : t.nextChangeAt,
      })),
    rooms,
  };
  return fitHub(hub);
}

/**
 * Keeps the hub under the hard cap. In order: drop the duration list, trim the compact sub-lines,
 * keep the 24 rooms that need attention first; a house far beyond any real size keeps shedding rooms
 * (attention first) and finally the plant lists, so the payload always stays valid JSON below the cap.
 */
export function fitHub(hub: HubAttrs, cap = HUB_HARD_CAP): HubAttrs {
  let h = hub;
  if (byteSize(h) <= cap) return h;
  h = { ...h, durations: [] };
  if (byteSize(h) <= cap) return h;
  h = { ...h, rooms: h.rooms.map((r) => ({ ...r, sub: trim(r.sub, SUB_TRIM) })) };
  if (byteSize(h) <= cap) return h;
  const ranked = [...h.rooms].sort((a, b) => Number(b.attn) - Number(a.attn) || a.ord - b.ord);
  let keep = Math.min(HUB_ROOMS_KEEP, ranked.length);
  const keepRooms = (n: number) => ranked.slice(0, n).sort((a, b) => a.ord - b.ord);
  h = { ...h, rooms: keepRooms(keep) };
  if (byteSize(h) <= cap) return h;
  const shortIssues = (rooms: HubAttrs['rooms']) => rooms.map((r) => ({ ...r, iss: r.iss === null ? null : trim(r.iss, SUB_TRIM) }));
  h = { ...h, rooms: shortIssues(h.rooms) };
  while (byteSize(h) > cap && keep > 0) {
    keep -= 1;
    h = { ...h, rooms: shortIssues(keepRooms(keep)) };
  }
  if (byteSize(h) <= cap) return h;
  h = { ...h, triggers: [], circuits: h.circuits.map((c) => ({ ...c, sub: trim(c.sub, SUB_TRIM) })) };
  while (byteSize(h) > cap && h.sources.length > 0) h = { ...h, sources: h.sources.slice(0, -1) };
  while (byteSize(h) > cap && h.profiles.length > 0) h = { ...h, profiles: h.profiles.slice(0, -1) };
  return h;
}

/* ── replies (sensor.klimo_reply) ─────────────────────────────────────────────────────────────── */

/** The last 8 command replies; cards wait for their own `reqId` here. */
export class ReplyRing {
  private items: CommandReply[] = [];

  constructor(private readonly size = REPLY_RING) {}

  push(reply: CommandReply): void {
    this.items = [...this.items.filter((r) => r.reqId !== reply.reqId), reply].slice(-this.size);
  }

  attrs(): ReplyAttrs {
    return { kv: 'klimo_reply', v: 1, replies: [...this.items] };
  }

  /** Sensor state: the newest reqId (HA renders "None" before the first reply). */
  state(): string {
    return this.items.length ? this.items[this.items.length - 1].reqId : 'None';
  }
}
