import { planForDate } from '../../config/schedule-ops';
import { AGGREGATION_METHODS, ROOM_STATE_STYLE } from '../../shared/model';
import type {
  AggregationMethod,
  Celsius,
  Circuit,
  CircuitState,
  DayPlan,
  EffectiveTarget,
  Emitter,
  EmitterRole,
  EnergyState,
  EngineConfig,
  EntityId,
  EntitySnap,
  EpochMs,
  GeneralSettings,
  HaRegistries,
  HaStateObj,
  HouseProfileState,
  Id,
  LocalDate,
  MinuteOfDay,
  Mode,
  Override,
  PlantState,
  Profile,
  Pump,
  PumpState,
  RoomConfig,
  RoomDetailDto,
  RoomMemory,
  RoomState,
  RoomSummary,
  RoomTargetDuration,
  RuleState,
  Schedule,
  Season,
  SeasonState,
  SourceAdapter,
  SourceBinding,
  SourceConfig,
  SourceState,
  ThermostatModel,
  Tone,
  Trigger,
  TriggerRule,
  TriggerState,
} from '../../shared/model';
import { dowOfDate } from '../core/time';

/* =====================================================================================================
 * Pure mappings from configuration + live engine state to the DTOs the UI reads. Nothing here talks to
 * Home Assistant or the database; every function also works before the engine has evaluated anything
 * (a new room, the first seconds after boot), so pages render their configuration right away.
 * ===================================================================================================== */

/* ── targets, limits, profiles ───────────────────────────────────────────────────────────────── */

export type Limits = { heatMinC: Celsius; heatMaxC: Celsius; coolMinC: Celsius; coolMaxC: Celsius };

export function limitsOf(room: Pick<RoomConfig, 'limits'>, settings: Pick<GeneralSettings, 'targetLimits'>): Limits {
  const l = room.limits ?? settings.targetLimits;
  return { heatMinC: l.heatMinC, heatMaxC: l.heatMaxC, coolMinC: l.coolMinC, coolMaxC: l.coolMaxC };
}

export function profileOf(cfg: Pick<EngineConfig, 'profiles'>, id: Id | null | undefined): Profile | null {
  return id ? cfg.profiles.find((p) => p.id === id) ?? null : null;
}

/** A room's values in a profile; null = the room is off there (row 'off' or a frost-only profile). */
export function profileValues(cfg: Pick<EngineConfig, 'profiles' | 'profileRooms'>, profileId: Id, roomId: Id | null): { heatC: Celsius; coolC: Celsius } | null {
  const p = profileOf(cfg, profileId);
  if (!p || p.frostOnly) return null;
  const row = roomId ? cfg.profileRooms.find((r) => r.profileId === profileId && r.roomId === roomId) : undefined;
  if (row?.mode === 'off') return null;
  if (row?.mode === 'own') return { heatC: row.heatC ?? p.heatC, coolC: row.coolC ?? p.coolC };
  return { heatC: p.heatC, coolC: p.coolC };
}

/** The mode a season asks for («нічого» in between is treated as heating: frost and cold guards heat). */
export function seasonMode(season: Season | null | undefined): Mode {
  return season === 'cooling' ? 'cool' : 'heat';
}

/** The mode the room is working in now, for actions that need one (boost, a single target). */
export function activeModeOf(state: RoomState, season: Season | null | undefined): Mode | null {
  const t = state.target;
  if (t.mode === 'heat' || t.mode === 'cool') return t.mode;
  if (t.mode === 'dual') {
    if (state.demand.mode === 'heat' || state.demand.mode === 'cool') return state.demand.mode;
    return seasonMode(season);
  }
  if (state.activeModes.heat && !state.activeModes.cool) return 'heat';
  if (state.activeModes.cool && !state.activeModes.heat) return 'cool';
  return null;
}

export function isActiveAt(o: Pick<Override, 'until'>, now: EpochMs): boolean {
  return o.until === null || o.until > now;
}

/** The room's override in the target group (manual, boost, off, room profile), if any. */
export function targetOverrideOf(overrides: readonly Override[], roomId: Id, now: EpochMs): Override | null {
  return overrides.find((o) => o.scope === 'room' && o.subjectId === roomId && o.group === 'target' && isActiveAt(o, now)) ?? null;
}

/* ── schedules ──────────────────────────────────────────────────────────────────────────────── */

export function houseScheduleOf(cfg: Pick<EngineConfig, 'schedules'>): Schedule | null {
  return cfg.schedules.find((s) => s.scope === 'house') ?? null;
}

export function roomScheduleOf(cfg: Pick<EngineConfig, 'schedules'>, roomId: Id): Schedule | null {
  return cfg.schedules.find((s) => s.scope === 'room' && s.roomId === roomId) ?? null;
}

/** The schedule a room follows: its own when enabled, else the house schedule. */
export function governingSchedule(cfg: Pick<EngineConfig, 'schedules'>, roomId: Id | null): Schedule | null {
  const own = roomId ? roomScheduleOf(cfg, roomId) : null;
  if (own?.enabled) return own;
  const house = houseScheduleOf(cfg);
  return house?.enabled ? house : null;
}

/** The plan in force on a local date (a dated exception replaces the weekday plan). */
export function planOn(cfg: Pick<EngineConfig, 'scheduleExceptions'>, schedule: Schedule, date: LocalDate): { plan: DayPlan; exception: boolean } {
  const exception = cfg.scheduleExceptions.find((x) => x.scheduleId === schedule.id && x.date === date);
  return { plan: planForDate(schedule, dowOfDate(date), exception), exception: !!exception };
}

/** Today's profile blocks of a room ([startMin, endMin, profileId]) for the thermostat strip. */
export function stripFor(cfg: Pick<EngineConfig, 'schedules' | 'scheduleExceptions'>, roomId: Id | null, date: LocalDate): [MinuteOfDay, MinuteOfDay, Id][] {
  const s = governingSchedule(cfg, roomId);
  if (!s) return [];
  return planOn(cfg, s, date).plan.map((b) => [b.start, b.end, b.profileId]);
}

/* ── Home Assistant snapshots ─────────────────────────────────────────────────────────────────── */

const UNKNOWN_STATES = new Set(['unavailable', 'unknown', '']);

/** A frozen view of a live HA state, the way the engine captures it (no unit conversion). */
export function snapOf(s: HaStateObj): EntitySnap {
  const n = Number(s.state);
  const available = !UNKNOWN_STATES.has(s.state);
  const changed = Date.parse(s.last_changed);
  const updated = Date.parse(s.last_updated);
  const reported = s.last_reported ? Date.parse(s.last_reported) : updated;
  return {
    entityId: s.entity_id,
    state: s.state,
    num: available && s.state.trim() !== '' && Number.isFinite(n) ? n : null,
    attrs: { ...s.attributes },
    available,
    lastChanged: Number.isFinite(changed) ? changed : 0,
    lastReported: Number.isFinite(reported) ? reported : Number.isFinite(updated) ? updated : 0,
    context: { id: s.context?.id ?? null, userId: s.context?.user_id ?? null, parentId: s.context?.parent_id ?? null },
  };
}

export function domainOf(entityId: string): string {
  const i = entityId.indexOf('.');
  return i > 0 ? entityId.slice(0, i) : '';
}

/** «38.0 °C», «on», «heat» — what a binding row shows next to the entity. */
export function liveText(s: HaStateObj | undefined): string | null {
  if (!s) return null;
  if (domainOf(s.entity_id) === 'climate') {
    const action = typeof s.attributes.hvac_action === 'string' ? s.attributes.hvac_action : null;
    return action ? `${s.state} · ${action}` : s.state;
  }
  const unit = typeof s.attributes.unit_of_measurement === 'string' ? s.attributes.unit_of_measurement : '';
  return unit ? `${s.state} ${unit}` : s.state;
}

/* ── rooms ───────────────────────────────────────────────────────────────────────────────────── */

function enabledEmitters(cfg: EngineConfig, roomId: Id): Emitter[] {
  return (cfg.emittersByRoom[roomId] ?? []).filter((e) => e.enabled);
}

function sourceById(cfg: Pick<EngineConfig, 'sources'>, id: Id | null): SourceConfig | undefined {
  return id ? cfg.sources.find((s) => s.id === id) : undefined;
}

function circuitById(cfg: Pick<EngineConfig, 'circuits'>, id: Id | null): Circuit | undefined {
  return id ? cfg.circuits.find((c) => c.id === id) : undefined;
}

export function isAcSource(s: SourceConfig): boolean {
  return s.kind === 'ac' || (s.adapter.type === 'climate' && s.scope === 'room' && s.capabilities.cool);
}

/** Can an emitter physically carry this mode (circuit/source capability, radiators never cool)? */
export function emitterCan(cfg: EngineConfig, e: Emitter, mode: Mode): boolean {
  if (e.roles[mode] === null) return false;
  if (e.kind === 'direct') return !!sourceById(cfg, e.sourceId)?.capabilities[mode];
  if (mode === 'cool' && (e.kind === 'radiator' || e.kind === 'towel_rail' || e.excludeFromCooling)) return false;
  return !!circuitById(cfg, e.circuitId)?.capabilities[mode];
}

/** What a room is built to do, regardless of the season (filters, «капабельні» counts). */
export function roomCapabilities(cfg: EngineConfig, room: RoomConfig): { heat: boolean; cool: boolean } {
  if (!room.controlEnabled) return { heat: false, cool: false };
  const emitters = enabledEmitters(cfg, room.id);
  return { heat: emitters.some((e) => emitterCan(cfg, e, 'heat')), cool: emitters.some((e) => emitterCan(cfg, e, 'cool')) };
}

/** «Чим гріти й охолоджувати»: one row per emitter and mode it serves. */
export function servedByRows(cfg: EngineConfig, room: RoomConfig): RoomDetailDto['servedBy'] {
  const rows: RoomDetailDto['servedBy'] = [];
  for (const e of enabledEmitters(cfg, room.id)) {
    for (const mode of ['heat', 'cool'] as const) {
      const role: EmitterRole | null = e.roles[mode];
      if (!role || !emitterCan(cfg, e, mode)) continue;
      const sourceIds =
        e.kind === 'direct'
          ? e.sourceId
            ? [e.sourceId]
            : []
          : (circuitById(cfg, e.circuitId)?.sourceIds ?? []).filter((id) => !!sourceById(cfg, id)?.capabilities[mode]);
      rows.push({ mode, emitterId: e.id, role, circuitId: e.circuitId, sourceIds });
    }
  }
  return rows;
}

/** Device counts of a room for the thermostat (which controls it has). */
export function roomDeviceCounts(cfg: EngineConfig, room: RoomConfig): ThermostatModel['devices'] {
  let trv = 0;
  let zone = 0;
  let ac = 0;
  let heater = 0;
  for (const e of enabledEmitters(cfg, room.id)) {
    for (const d of cfg.devicesByEmitter[e.id] ?? []) {
      if (d.kind === 'trv') trv++;
      else zone++;
    }
    if (e.kind === 'direct') {
      const s = sourceById(cfg, e.sourceId);
      if (s && isAcSource(s)) ac++;
      else if (s) heater++;
    }
  }
  return { trv, ac, heater, zone };
}

/** Which kind of control the room card names («радіатори від ТН», «кондиціонер працює»…). */
export function deviceKindOf(cfg: EngineConfig, room: RoomConfig, cooling: boolean): RoomSummary['device']['kind'] {
  const emitters = enabledEmitters(cfg, room.id);
  const hasTrv = emitters.some((e) => (cfg.devicesByEmitter[e.id] ?? []).some((d) => d.kind === 'trv'));
  const hasFloor = emitters.some((e) => e.kind === 'floor');
  const direct = emitters.filter((e) => e.kind === 'direct').map((e) => sourceById(cfg, e.sourceId)).filter((s): s is SourceConfig => !!s);
  const hasAc = direct.some(isAcSource);
  const hasHeater = direct.some((s) => !isAcSource(s));
  if (cooling) {
    if (hasAc) return 'ac';
    if (hasFloor) return 'floor';
  }
  if (hasTrv && hasFloor) return 'trvfloor';
  if (hasTrv) return 'trv';
  if (hasFloor) return 'floor';
  if (hasHeater) return 'heater';
  if (hasAc) return 'ac';
  return 'none';
}

const NO_METHOD_VALUES = (): Record<AggregationMethod, Celsius | null> =>
  Object.fromEntries(AGGREGATION_METHODS.map((m) => [m, null])) as Record<AggregationMethod, Celsius | null>;

/** A room the engine has not evaluated yet (just created, first seconds after boot). */
export function emptyRoomState(cfg: EngineConfig, room: RoomConfig, now: EpochMs): RoomState {
  const sensors = cfg.sensorsByRoom[room.id] ?? [];
  const contacts = sensors.filter((s) => s.role === 'contact');
  const kind = room.controlEnabled ? 'error' : 'monitor';
  const frostFloorC = Math.max(cfg.safety.frostC, room.frostC ?? cfg.safety.frostC);
  const target: EffectiveTarget = {
    heatC: null,
    coolC: null,
    mode: 'none',
    displayC: null,
    layer: room.controlEnabled ? 'default' : 'monitor',
    display: room.controlEnabled ? 'no_data' : 'monitor',
    profileId: null,
    overrideId: null,
    until: null,
    next: null,
    adjustments: [],
    profileUpdated: false,
    frostFloorC,
    preheat: null,
  };
  return {
    roomId: room.id,
    state: kind,
    tone: ROOM_STATE_STYLE[kind].tone,
    tempC: null,
    aggregation: {
      method: room.temperature.method,
      valueC: null,
      values: NO_METHOD_VALUES(),
      usedSensorIds: [],
      activeCount: 0,
      totalCount: sensors.filter((s) => s.role === 'temperature' && s.included).length,
      fallback: 'no_data',
      trvValues: [],
      floorC: null,
    },
    sensors: sensors.map((s) => ({
      sensorId: s.id,
      entityId: s.entityId,
      role: s.role,
      rawC: null,
      smoothedC: null,
      humidityPct: null,
      contactOpen: null,
      lastReportedAt: null,
      status: s.included ? 'unavailable' : 'excluded',
      deviationC: null,
      weight: s.weight,
      batteryPct: null,
      lqi: null,
    })),
    trendCPerH: null,
    target,
    thresholds: { heatOnC: null, heatOffC: null, coolOnC: null, coolOffC: null },
    activeModes: { heat: false, cool: false },
    demand: {
      mode: 'none',
      latched: { heat: false, cool: false },
      since: null,
      minRequestUntil: null,
      canCallSource: false,
      served: false,
      servingSourceIds: [],
      waitReason: null,
      block: room.controlEnabled ? 'no_data' : 'monitor',
      frost: false,
      assist: false,
      dry: false,
      store: false,
    },
    window: {
      hasSensors: contacts.length > 0,
      openCount: 0,
      total: contacts.length,
      anyOpen: false,
      openSince: null,
      reaction: room.windows.reaction,
      reactionActive: false,
      resumeAt: null,
      reactionAt: null,
      virtual: false,
      ignoredUntil: null,
      contacts: contacts.map((c) => ({ sensorId: c.id, entityId: c.entityId, kind: c.contactKind ?? 'window', open: null, available: false })),
    },
    humidity: {
      valuePct: null,
      method: room.humidity.method,
      maxPct: null,
      dewPointC: null,
      absGm3: null,
      glassC: null,
      glassMarginC: null,
      warn: false,
      condensationRisk: false,
      dehumidifierOn: null,
    },
    trvs: [],
    emitters: [],
    issues: [],
    eta: null,
    why: [room.controlEnabled ? { code: 'why.no_data', params: { safeC: cfg.safety.noDataTrvSetpointC } } : { code: 'why.monitor.control_disabled', params: {} }],
    sync: { reqId: null, phase: 'idle', acked: 0, total: 0, attempt: 0, maxAttempts: 0, valueC: null, what: 'none' },
    activeRuleIds: [],
    hvacAction: 'off',
    updatedAt: now,
  };
}

/** Card-sized summary of a room (Overview grid, rooms list, room tabs). */
export function toRoomSummary(cfg: EngineConfig, room: RoomConfig, state: RoomState, overrides: readonly Override[], season: Season | null): RoomSummary {
  const t = state.target;
  const cooling = t.mode === 'cool' || state.demand.mode === 'cool' || (t.mode !== 'heat' && season === 'cooling');
  const tol = t.mode === 'cool' ? room.tolerance.cool : room.tolerance.heat;
  const ov = t.overrideId ? overrides.find((o) => o.id === t.overrideId) ?? null : null;

  const trvs = state.trvs;
  const acked = state.sync.phase !== 'idle' ? state.sync.acked : trvs.filter((x) => x.sync.status === 'confirmed' || x.sync.status === 'idle').length;
  const total = state.sync.phase !== 'idle' ? state.sync.total : trvs.length;
  const valves = trvs.map((x) => x.valvePct).filter((v): v is number => typeof v === 'number');
  const feeding = state.demand.servingSourceIds[0] ?? state.emitters.find((e) => e.feedingSourceIds.length)?.feedingSourceIds[0] ?? null;

  let valueC = t.displayC;
  let deltaC: number | null = null;
  if (ov?.value.kind === 'room_boost') {
    valueC = ov.value.targetC;
    deltaC = ov.value.deltaC;
  } else if (t.display === 'window') {
    deltaC = t.adjustments.find((a) => a.code === 'window_lower')?.deltaC ?? null;
  }

  const caps = roomCapabilities(cfg, room);
  return {
    id: room.id,
    slug: room.slug,
    name: room.name,
    order: room.order,
    icon: room.icon,
    state: state.state,
    tone: state.tone,
    tempC: state.tempC,
    targetC: t.mode === 'dual' ? null : t.displayC,
    range: t.mode === 'dual' && t.heatC !== null && t.coolC !== null ? { lo: t.heatC, hi: t.coolC } : null,
    tol: { below: tol.below, above: tol.above },
    trendCPerH: state.trendCPerH,
    humidityPct: state.humidity.valuePct,
    humidityWarn: state.humidity.warn,
    window: state.window.hasSensors
      ? { open: state.window.anyOpen, openCount: state.window.openCount, total: state.window.total, openSince: state.window.openSince }
      : null,
    device: {
      kind: deviceKindOf(cfg, room, cooling),
      acked,
      total,
      valvePct: valves.length ? Math.round(valves.reduce((a, b) => a + b, 0) / valves.length) : null,
      sourceId: feeding,
    },
    src: {
      kind: t.display,
      profileId: t.profileId,
      until: t.until,
      valueC,
      deltaC,
      since: t.display === 'window' ? state.window.openSince : null,
    },
    issue: state.issues[0] ?? null,
    issuesCount: state.issues.length,
    canHeat: caps.heat,
    canCool: caps.cool,
  };
}

export interface ThermostatInputs {
  override: Override | null;
  untils: Partial<Record<RoomTargetDuration, EpochMs | null>>;
  strip: [MinuteOfDay, MinuteOfDay, Id][];
  learned: RoomMemory['learned'] | null;
  gapC: number;
  season: Season | null;
  now: EpochMs;
}

/** The dial/stepper model shared by the SPA and the thermostat card. */
export function toThermostat(cfg: EngineConfig, room: RoomConfig, state: RoomState, x: ThermostatInputs): ThermostatModel {
  const t = state.target;
  const lim = limitsOf(room, cfg.settings);
  const editMode = t.mode === 'none' ? seasonMode(x.season) : t.mode;
  const range =
    editMode === 'heat' ? [lim.heatMinC, lim.heatMaxC] : editMode === 'cool' ? [lim.coolMinC, lim.coolMaxC] : [lim.heatMinC, lim.coolMaxC];
  const learned = x.learned;
  const confident = editMode === 'cool' ? (learned?.coolSamples ?? 0) >= 3 : (learned?.heatSamples ?? 0) >= 3;
  const o = x.override;
  let override: ThermostatModel['override'] = null;
  if (o) {
    const v = o.value;
    const undoable = o.revertToken !== null && o.revertUntil !== null && o.revertUntil > x.now;
    override = {
      kind: o.kind,
      duration: o.duration,
      until: o.until,
      revertToken: undoable ? o.revertToken : null,
      revertUntil: undoable ? o.revertUntil : null,
      valueC: v.kind === 'room_target' && v.mode !== 'dual' ? (v.mode === 'heat' ? v.heatC : v.coolC) : v.kind === 'room_boost' ? v.targetC : null,
      lo: v.kind === 'room_target' && v.mode === 'dual' ? v.heatC : null,
      hi: v.kind === 'room_target' && v.mode === 'dual' ? v.coolC : null,
    };
  }
  return {
    roomId: room.id,
    mode: t.mode,
    curC: state.tempC,
    t: t.mode === 'dual' ? null : t.displayC,
    lo: t.mode === 'dual' ? t.heatC : null,
    hi: t.mode === 'dual' ? t.coolC : null,
    gapC: x.gapC,
    tol: { ...room.tolerance[t.mode === 'cool' ? 'cool' : 'heat'] },
    tolCool: { ...room.tolerance.cool },
    latches: { heat: state.demand.latched.heat, cool: state.demand.latched.cool },
    rate: { heat: learned?.heatRateCPerH ?? 1.0, cool: learned?.coolRateCPerH ?? 1.0, confident },
    min: range[0],
    max: range[1],
    step: cfg.settings.targetLimits.stepC,
    profileId: t.profileId,
    slotEnd: x.untils.slot ?? null,
    next: t.next,
    override,
    profileUpdated: t.profileUpdated,
    untils: x.untils,
    strip: x.strip,
    devices: roomDeviceCounts(cfg, room),
    quick: { ...room.quick },
    locked: !room.controlEnabled || state.state === 'monitor',
    state: state.state,
  };
}

const HA_ENTITY_ROLES: readonly [suffix: string, role: RoomDetailDto['haEntities'][number]['role']][] = [
  ['climate', 'climate'],
  ['temperature', 'temperature'],
  ['humidity', 'humidity'],
  ['target', 'target'],
  ['heat_demand', 'heat_demand'],
  ['cool_demand', 'cool_demand'],
  ['window', 'window'],
  ['card', 'card'],
];

/**
 * Klimo's own entities of a room. The registry is the truth (a renamed room keeps its old entity ids);
 * before discovery reached HA the documented default ids are shown.
 */
export function haEntitiesOf(cfg: EngineConfig, room: RoomConfig, registries: HaRegistries | null): RoomDetailDto['haEntities'] {
  const prefix = `klimo_${room.id}_`;
  const found = new Map<string, EntityId>();
  for (const e of registries?.entities ?? []) {
    if (!e.unique_id?.startsWith(prefix)) continue;
    found.set(e.unique_id.slice(prefix.length), e.entity_id);
  }
  if (found.size) {
    return HA_ENTITY_ROLES.filter(([suffix]) => found.has(suffix)).map(([suffix, role]) => ({ entityId: found.get(suffix) as EntityId, role }));
  }
  const sensors = cfg.sensorsByRoom[room.id] ?? [];
  const s = room.slug;
  const out: RoomDetailDto['haEntities'] = [
    { entityId: `climate.klimo_${s}`, role: 'climate' },
    { entityId: `sensor.klimo_${s}_temperature`, role: 'temperature' },
    { entityId: `sensor.klimo_${s}_target`, role: 'target' },
  ];
  if (sensors.some((x) => x.role === 'humidity')) out.push({ entityId: `sensor.klimo_${s}_humidity`, role: 'humidity' });
  out.push({ entityId: `binary_sensor.klimo_${s}_heat_demand`, role: 'heat_demand' });
  if (roomCapabilities(cfg, room).cool) out.push({ entityId: `binary_sensor.klimo_${s}_cool_demand`, role: 'cool_demand' });
  if (sensors.some((x) => x.role === 'contact') || room.windows.tempDrop.enabled) out.push({ entityId: `binary_sensor.klimo_${s}_window`, role: 'window' });
  out.push({ entityId: `sensor.klimo_${s}_card`, role: 'card' });
  return out;
}

/* ── plant ───────────────────────────────────────────────────────────────────────────────────── */

/** What a source feeds per mode (circuits it is wired to, rooms it serves directly). */
export function sourceFeeds(cfg: EngineConfig, s: SourceConfig): { heat: { type: 'circuit' | 'room'; id: Id }[]; cool: { type: 'circuit' | 'room'; id: Id }[] } {
  const feeds = { heat: [] as { type: 'circuit' | 'room'; id: Id }[], cool: [] as { type: 'circuit' | 'room'; id: Id }[] };
  for (const mode of ['heat', 'cool'] as const) {
    if (!s.capabilities[mode]) continue;
    for (const c of cfg.circuits) if (c.sourceIds.includes(s.id) && c.capabilities[mode]) feeds[mode].push({ type: 'circuit', id: c.id });
    for (const [roomId, emitters] of Object.entries(cfg.emittersByRoom)) {
      if (emitters.some((e) => e.sourceId === s.id && e.roles[mode] !== null)) feeds[mode].push({ type: 'room', id: roomId });
    }
  }
  return feeds;
}

/** Rooms with an emitter on a circuit. */
export function circuitMembers(cfg: EngineConfig, circuitId: Id): Id[] {
  const out: Id[] = [];
  for (const room of cfg.rooms) if ((cfg.emittersByRoom[room.id] ?? []).some((e) => e.circuitId === circuitId)) out.push(room.id);
  return out;
}

const RUNNING: ReadonlySet<SourceState['state']> = new Set(['heating', 'cooling', 'drying', 'fan', 'defrost', 'starting', 'testing']);

export function isRunningState(s: SourceState['state']): boolean {
  return RUNNING.has(s);
}

/** A source before the engine has looked at it. */
export function emptySourceState(s: SourceConfig, bindings: SourceBinding[], overrides: readonly Override[], now: EpochMs): SourceState {
  const lock = overrides.find((o) => o.scope === 'source' && o.subjectId === s.id && o.group === 'source_lock' && isActiveAt(o, now)) ?? null;
  return {
    sourceId: s.id,
    state: s.enabled ? (lock?.kind === 'source_off' ? 'paused' : 'idle') : 'disabled',
    tone: s.enabled ? 'idle' : 'off',
    role: 'unused',
    roleReason: { code: 'role.unused' },
    detail: s.enabled ? { code: 'source.detail.idle' } : { code: 'source.blocked.disabled' },
    on: false,
    mode: null,
    since: null,
    confirm: 'none',
    available: !bindings.some((b) => b.required && b.status === 'unavailable'),
    blockers: [],
    conditions: [],
    telemetry: { supplyC: null, flowSetpointC: null, powerKw: null, cop: null, defrost: null, errorCode: null, stage: null },
    bindings,
    servingCircuitIds: [],
    servingRoomIds: [],
    todayRuntimeMin: 0,
    startsLastHour: 0,
    admittedKw: null,
    fault: null,
    test: null,
    lock: lock
      ? { kind: lock.kind === 'source_force' ? 'source_force' : 'source_off', until: lock.until, mode: lock.value.kind === 'source_force' ? lock.value.mode : null, by: lock.by }
      : null,
  };
}

export function emptyPumpState(p: Pump): PumpState {
  return {
    pumpId: p.id,
    circuitId: p.circuitId,
    manifoldId: p.manifoldId,
    state: 'off',
    on: false,
    reason: null,
    runOnUntil: null,
    since: null,
    available: true,
    todayRuntimeMin: 0,
    sync: { status: 'idle', attempt: 0, maxAttempts: 0, commandId: null, reqId: null, sentAt: null, confirmedAt: null },
  };
}

export function emptyCircuitState(cfg: EngineConfig, c: Circuit): CircuitState {
  return {
    circuitId: c.id,
    mode: 'none',
    tone: 'idle',
    state: { code: c.sourceIds.length ? 'circuit.idle' : 'circuit.no_source' },
    requestingRoomIds: [],
    memberRoomIds: circuitMembers(cfg, c.id),
    excludedRooms: [],
    feedingSourceIds: [],
    supplyC: null,
    returnC: null,
    supplySetpointC: null,
    dewPointMaxC: null,
    dewHold: null,
    pumpOn: false,
    runOnUntil: null,
    pumps: cfg.pumps.filter((p) => p.circuitId === c.id).map(emptyPumpState),
  };
}

export function emptySeasonState(cfg: EngineConfig, now: EpochMs): SeasonState {
  const mode = cfg.house.mode;
  const season: Season = mode === 'heat' ? 'heating' : mode === 'cool' ? 'cooling' : 'neutral';
  return {
    houseMode: mode,
    season,
    derived: season,
    auto: mode === 'auto',
    since: now,
    avgC: null,
    outdoorC: null,
    outdoor10C: null,
    outdoorSource: 'none',
    rule: { heatBelowC: cfg.season.heatBelowC, coolAboveC: cfg.season.coolAboveC, hysteresisC: cfg.season.hysteresisC, avgDays: cfg.season.avgDays },
    pending: null,
    heatAllowed: { central: false, local: false, coldGuardOnly: false },
    coolAllowed: { central: false, local: false },
    reason: { code: 'season.no_data' },
  };
}

export function energyConfigured(cfg: EngineConfig): boolean {
  return Object.values(cfg.energy.entities).some((e) => !!e);
}

export function emptyEnergyState(cfg: EngineConfig): EnergyState {
  const configured = energyConfigured(cfg);
  return {
    configured,
    grid: 'unknown',
    pvKw: null,
    batteryPct: null,
    houseLoadKw: null,
    restrictionsActive: false,
    phase: 'normal',
    budgetKw: null,
    usedKw: 0,
    perSourceKw: {},
    note: configured ? null : { code: 'energy.not_configured' },
  };
}

export function emptyTriggerState(t: Trigger): TriggerState {
  return {
    triggerId: t.id,
    active: false,
    enabled: t.enabled,
    since: null,
    status: t.enabled ? 'unknown' : 'disabled',
    value: null,
    live: { code: t.enabled ? 'trigger.live.inactive' : 'trigger.live.disabled' },
    nextChangeAt: null,
    eval: { id: t.condition.id ?? 'root', met: false, status: 'unknown' },
    usedBy: [],
  };
}

export function emptyRuleState(r: TriggerRule): RuleState {
  return { ruleId: r.id, active: false, stopped: false, since: null, lastRun: null };
}

/** House profile before the first evaluation: the default profile, nothing scheduled yet. */
export function emptyHouseProfileState(cfg: EngineConfig): HouseProfileState {
  const id = cfg.settings.defaultProfileId;
  return {
    activeProfileId: id,
    layer: 'default',
    scheduledProfileId: id,
    scheduledUntil: null,
    nextProfileId: null,
    override: null,
    presence: { configured: cfg.settings.presence.enabled, anyoneHome: null, awaySince: null, approaching: false },
  };
}

/* ── source bindings ─────────────────────────────────────────────────────────────────────────── */

const SWITCHABLE = ['switch', 'input_boolean', 'light', 'valve', 'fan'];
const NUMBER = ['number', 'input_number'];

interface BindingSpec {
  role: string;
  entityId: EntityId | null;
  required: boolean;
  domains: readonly string[] | null;
}

function adapterBindings(a: SourceAdapter, caps: SourceConfig['capabilities']): BindingSpec[] {
  const out: BindingSpec[] = [];
  const add = (role: string, entityId: EntityId | null | undefined, required: boolean, domains: readonly string[] | null) =>
    out.push({ role, entityId: entityId || null, required, domains });
  switch (a.type) {
    case 'relay':
      add('command', a.command, true, SWITCHABLE);
      a.stages.forEach((s, i) => add(`stage${i + 2}`, s.entityId, true, SWITCHABLE));
      if (a.flowSetpoint) add('flow', a.flowSetpoint.entityId, true, NUMBER);
      if (a.watchdog.kind === 'countdown_number') add('watchdog', a.watchdog.entityId, true, [...NUMBER, 'timer']);
      break;
    case 'climate':
      add('climate', a.climate, true, ['climate']);
      add('defrost', a.defrostEntityId, false, null);
      add('error', a.errorEntityId, false, null);
      add('cop', a.copEntityId, false, null);
      add('supply', a.supplyTempEntityId, false, null);
      break;
    case 'flow':
      add('enable', a.enable, true, SWITCHABLE);
      add('flow', a.flowSetpoint, true, NUMBER);
      add('actual_flow', a.actualFlow, false, null);
      if (a.modeSelect) add('mode_select', a.modeSelect.entityId, true, ['select', 'input_select']);
      break;
    case 'script':
      for (const mode of ['heat', 'cool', 'dry', 'fan'] as const) if (caps[mode] || a.on[mode]) add(`on_${mode}`, a.on[mode], caps[mode], ['script']);
      add('off', a.off, true, ['script']);
      break;
    case 'custom':
      break;
  }
  const c = a.confirm;
  if (c.kind === 'entity_on' || c.kind === 'state_in') add('confirm', c.entityId, true, null);
  if (c.kind === 'power_above') add('confirm', c.entityId, true, ['sensor', ...NUMBER]);
  return out;
}

/** The binding rows of a source with the live state of each entity («оберіть» / «гаразд»). */
export function bindingRows(
  adapter: SourceAdapter,
  capabilities: SourceConfig['capabilities'],
  powerEntityId: EntityId | null,
  getState: (id: EntityId) => HaStateObj | undefined,
  known: (id: EntityId) => boolean,
): SourceBinding[] {
  const specs = adapterBindings(adapter, capabilities);
  if (powerEntityId && !specs.some((s) => s.entityId === powerEntityId)) specs.push({ role: 'power', entityId: powerEntityId, required: false, domains: ['sensor', ...NUMBER] });
  return specs.map((b) => {
    if (!b.entityId) return { role: b.role, entityId: null, required: b.required, live: null, status: 'unset' };
    if (b.domains && !b.domains.includes(domainOf(b.entityId))) return { role: b.role, entityId: b.entityId, required: b.required, live: null, status: 'wrong_domain' };
    const st = getState(b.entityId);
    if (!st && !known(b.entityId)) return { role: b.role, entityId: b.entityId, required: b.required, live: null, status: 'missing' };
    const unavailable = !st || st.state === 'unavailable';
    return { role: b.role, entityId: b.entityId, required: b.required, live: liveText(st), status: unavailable ? 'unavailable' : 'ok' };
  });
}

/* ── timelines ───────────────────────────────────────────────────────────────────────────────── */

export function spanTone(subject: string, kind: string, mode: string | null): Tone {
  if (kind === 'run_on' || kind === 'exercise') return 'idle';
  if (kind === 'test') return 'warn';
  if (subject === 'profile') return 'hold';
  if (subject === 'rule') return 'event';
  if (subject === 'trigger') return 'wait';
  if (mode === 'cool' || mode === 'dry') return 'cool';
  if (mode === 'fan') return 'idle';
  return 'heat';
}

/** The plant before the engine's first evaluation: everything idle, bindings as configured. */
export function emptyPlantState(cfg: EngineConfig, bindingsOf: (s: SourceConfig) => SourceBinding[], overrides: readonly Override[], now: EpochMs): PlantState {
  return {
    sources: cfg.sources.map((s) => emptySourceState(s, bindingsOf(s), overrides, now)),
    circuits: cfg.circuits.map((c) => emptyCircuitState(cfg, c)),
    manifoldPumps: cfg.pumps.filter((p) => p.manifoldId !== null).map(emptyPumpState),
    manifolds: cfg.manifolds.map((m) => ({ manifoldId: m.id, supplyC: null, returnC: null, tone: 'idle' as Tone })),
    lead: { heat: null, cool: null },
    bivalent: { frostActive: false, limitActive: false, lagActive: false, mode: cfg.heat.bivalence.mode, applies: false },
    heatDemand: false,
    coolDemand: false,
    energy: emptyEnergyState(cfg),
    triggers: cfg.triggers.map(emptyTriggerState),
    rules: cfg.rules.map(emptyRuleState),
    why: [],
  };
}
