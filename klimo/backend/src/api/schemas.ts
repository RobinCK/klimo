import { isLocalDate } from '../engine/core/time';
import {
  any,
  arr,
  at,
  bool,
  entityId,
  hhmm,
  id,
  int,
  lit,
  nullable,
  num,
  obj,
  oneOf,
  opt,
  record,
  str,
  union,
  type Schema,
} from '../common/validate';
import {
  ADAPTER_TYPES,
  AGGREGATION_METHODS,
  CHANNEL_KINDS,
  CIRCUIT_MODES,
  CONSUMPTION_RANGES,
  EMITTER_KINDS,
  EMITTER_ROLES,
  EVENT_KINDS,
  GAS_PRICE_UNITS,
  HOUSE_CONTROL_MODES,
  HOUSE_DURATIONS,
  HOUSE_MODES,
  LOCK_DURATIONS,
  METER_KINDS,
  OUTDOOR_AGGREGATIONS,
  PRIORITY_DEFAULT,
  PRIORITY_LOCKED,
  PUMP_RULES,
  ROOM_CONTROL_CHOICES,
  ROOM_HEATING_KINDS,
  ROOM_TARGET_DURATIONS,
  SEASONS,
  SEVERITIES,
  SOURCE_KINDS,
  SOURCE_LINKABLE_FIELDS,
  TRV_STRATEGIES,
  WINDOW_REACTIONS,
} from '../shared/model';
import { MAX_OUTDOOR_SENSORS } from '../config/validators';
import type {
  AcControl,
  ActivationRuleConfig,
  ApiErrorIssue,
  BivalentMode,
  BoostRequest,
  ChainEntry,
  CircuitKind,
  CircuitMergeRequest,
  CircuitPatch,
  CircuitRoomRequest,
  ConditionNode,
  ConditionPreviewRequest,
  ConfirmSpec,
  ConsumptionQuery,
  ContactKind,
  CoolStrategyPatch,
  CopyDayRequest,
  CreateRoomRequest,
  CreateRoomStepKind,
  DayPlan,
  DeviceHealthPatch,
  DeviceMetaPatch,
  DeviceReplaceRequest,
  Dow,
  EmitterCreateRequest,
  EmitterDeviceCreateRequest,
  EmitterDeviceKind,
  EmitterDevicePatch,
  EmitterPatch,
  EnergyCarrier,
  EnergyPatch,
  EnergySetupRequest,
  EntityRolePreset,
  GeneralSettingsPatch,
  HeatStrategyPatch,
  HouseControlRequest,
  HouseModeRequest,
  HouseProfileRequest,
  HpModeSelection,
  HumidityMethod,
  IconName,
  IncidentAction,
  IncidentActionRequest,
  IncidentStatus,
  JournalCategory,
  Lang,
  LocalDate,
  ManifoldPatch,
  Mode,
  NotifySettingsPatch,
  NotifyTargetPatch,
  OrderRequest,
  PersonalPrefs,
  PriorityRequest,
  ProfileCreateRequest,
  ProfileDeleteRequest,
  ProfilePatch,
  ProfileTargetRequest,
  PumpGroupMode,
  PumpPatch,
  RoomBindingReplaceRequest,
  RoomControlRequest,
  RoomDeviceRequest,
  RoomHeatingRequest,
  RoomOffRequest,
  RoomPatch,
  RoomProfileRequest,
  RoutingBulkRequest,
  RuleEffect,
  RulePatch,
  SafetySettingsPatch,
  ScheduleCreateRequest,
  ScheduleDayRequest,
  ScheduleExceptionRequest,
  ScheduleSplitRequest,
  SeasonPatch,
  SensorCreateRequest,
  SensorOrderRequest,
  SensorPatch,
  SensorRole,
  ServiceCallSpec,
  SetTargetRequest,
  SimPresetId,
  SimulateRequest,
  SourceAdapter,
  SourceCreateRequest,
  SourceDemandPolicy,
  SourceDuplicateRequest,
  SourceLockRequest,
  SourceMeter,
  SourceMode,
  SourcePatch,
  SourceScope,
  SourceTestRequest,
  StatisticsQuery,
  TelegramMode,
  TestNotificationRequest,
  TriggerKind,
  TriggerPatch,
  TrvManualPolicy,
  UndoRequest,
  ValidateRoomRequest,
  WatchCondition,
  WatchRule,
  WatchRulePatch,
  WizardDeviceRole,
  Z2mInstanceCreateRequest,
} from '../shared/model';

/* =====================================================================================================
 * Request schemas of the REST API. They check the shape of every body and query (types, enums,
 * obvious bounds) and drop unknown keys, so nothing a client invents reaches the configuration. The
 * rules that need the whole house (unique names, references, limits inside limits, notification
 * invariants…) run in the configuration store on the resulting object, once, for every writer.
 *
 * Patches are deep: nested objects merge into the stored value, arrays and tagged unions (conditions,
 * confirmation, watchdog, plans) replace it whole, so those are always validated complete.
 * ===================================================================================================== */

/** A patch body: nested objects are optional at every level, arrays are replaced whole. */
export type DeepPartial<T> = T extends readonly unknown[] ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

type Shape = Record<string, Schema<unknown>>;

/* ── building blocks ─────────────────────────────────────────────────────────────────────────── */

/**
 * The exact value list of a union type: a value missing from the list is a compile error here, so a
 * new enum member cannot be silently rejected by the API.
 */
function values<T extends string | number>() {
  return <const A extends readonly T[]>(list: A & (Exclude<T, A[number]> extends never ? unknown : { missing: Exclude<T, A[number]> })): A => list;
}

function custom<T>(run: (v: unknown, path: string, issues: ApiErrorIssue[]) => T): Schema<T> {
  return { optional: false, run };
}

function lazy<T>(get: () => Schema<T>): Schema<T> {
  return custom((v, path, issues) => get().run(v, path, issues));
}

/** Partial object (patches). */
function patch<Sh extends Shape>(shape: Sh) {
  return obj(shape, { partial: true });
}

/** Cross-field checks after the shape passed: `add(field, code)` reports at `<path>.<field>`. */
function checked<T>(inner: Schema<T>, rules: (value: T, add: (field: string, code: string, params?: Record<string, string | number>) => void) => void): Schema<T> {
  return {
    optional: inner.optional,
    run: (v, path, issues) => {
      const before = issues.length;
      const value = inner.run(v, path, issues);
      if (issues.length === before && value !== undefined) {
        rules(value, (field, code, params) => issues.push(params ? { path: at(path, field), code, params } : { path: at(path, field), code }));
      }
      return value;
    },
  };
}

const MODES = values<Mode>()(['heat', 'cool']);
const SOURCE_MODES = values<SourceMode>()(['heat', 'cool', 'dry', 'fan']);
const LANGS = values<Lang>()(['uk', 'en']);
const DOWS = values<Dow>()([0, 1, 2, 3, 4, 5, 6]);
const SENSOR_ROLES = values<SensorRole>()(['temperature', 'humidity', 'contact', 'floor_probe', 'glass']);
const CONTACT_KINDS = values<ContactKind>()(['window', 'door']);
const HUMIDITY_METHODS = values<HumidityMethod>()(['average', 'median', 'max', 'min']);
const TRV_MANUAL_POLICIES = values<TrvManualPolicy>()(['slot', 'revert', 'save']);
const AC_CONTROLS = values<AcControl>()(['target', 'onoff', 'asis']);
const DEMAND_POLICIES = values<SourceDemandPolicy>()(['call', 'piggyback', 'never']);
const DEVICE_KINDS = values<EmitterDeviceKind>()(['trv', 'zone_valve', 'zone_switch']);
const SCOPES = values<SourceScope>()(['central', 'room']);
const CARRIERS = values<EnergyCarrier>()(['electric', 'gas', 'other']);
const CIRCUIT_KINDS = values<CircuitKind>()(['radiators', 'floor', 'fancoil', 'other']);
const PUMP_GROUP_MODES = values<PumpGroupMode>()(['all', 'duty_standby']);
const BIVALENT_MODES = values<BivalentMode>()(['alt', 'parallel', 'partial']);
const HP_MODE_SELECTIONS = values<HpModeSelection>()(['demand', 'weather']);
const TRIGGER_KINDS = values<TriggerKind>()(['entity_state', 'numeric', 'template', 'time', 'sun_weather', 'composite']);
const TELEGRAM_MODES = values<TelegramMode>()(['own', 'integration']);
const JOURNAL_CATEGORIES = values<JournalCategory>()(['src', 'rooms', 'dev', 'system']);
const INCIDENT_STATUSES = values<IncidentStatus | 'active'>()(['open', 'acknowledged', 'resolved', 'active']);
const SIM_PRESETS = values<SimPresetId>()(['now', 'frost', 'blackout_sun', 'shoulder', 'summer', 'custom']);
const STEP_KINDS = values<CreateRoomStepKind>()(['room_created', 'trv_target', 'external_sensor', 'child_lock', 'ha_entity', 'ac_mode']);
const INCIDENT_ACTIONS = values<IncidentAction>()([
  'ack', 'snooze', 'snooze_until_morning', 'unsnooze', 'dismiss', 'exclude_sensor', 'include_sensor', 'retry_trv', 'ignore_window',
  'airing', 'resume_schedule', 'open',
]);
const WIZARD_ROLES = values<WizardDeviceRole>()([
  'trv', 'temperature', 'humidity', 'temp_humidity', 'window', 'door', 'ac', 'heater', 'floor_zone', 'floor_probe', 'dehumidifier',
]);
const ROLE_PRESETS = values<EntityRolePreset>()([
  'trv', 'ac', 'climate_source', 'temperature', 'humidity', 'contact', 'switchable', 'pump', 'number', 'select', 'power', 'binary',
  'outdoor', 'person', 'calendar', 'weather', 'proximity', 'script', 'gas_meter', 'electricity_meter', 'heat_meter',
]);
const STAT_PERIODS = values<StatisticsQuery['period']>()(['5minute', 'hour', 'day', 'week']);
const STAT_TYPES = values<StatisticsQuery['types'][number]>()(['mean', 'min', 'max', 'state', 'sum', 'change']);

/** Upper bound of every timestamp (year 2100): rejects seconds-vs-milliseconds mix-ups early. */
const MAX_EPOCH = 4_102_444_800_000;

export const epoch = (coerce = false) => int(0, MAX_EPOCH, { coerce });
const name = (max = 40) => str(max, { min: 1, trim: true });
const label = (max = 80) => str(max, { trim: true });
const reqId = opt(str(80, { min: 1 }));
const dow = oneOf(DOWS);
const pct = num(0, 100);
const minutes = (max: number) => int(0, max);
/** Any temperature Klimo stores (°C); the configuration store checks the field's own range. */
const celsius = num(-50, 100);
const kw = num(0, 1000);
const nullableEntity = nullable(entityId());

export const icon: Schema<IconName> = custom((v, path, issues) => {
  if (typeof v !== 'string' || !/^[A-Za-z_]{1,24}$/.test(v)) issues.push({ path, code: 'pattern', params: { expected: 'icon' } });
  return v as IconName;
});

export const color = str(7, { pattern: /^#[0-9A-Fa-f]{6}$/ });

export const localDate: Schema<LocalDate> = custom((v, path, issues) => {
  if (!isLocalDate(v)) issues.push({ path, code: 'pattern', params: { expected: 'YYYY-MM-DD' } });
  return typeof v === 'string' ? v : '';
});

/** Path parameter `:dow` (0 = Monday … 6 = Sunday). */
export const dowParam: Schema<Dow> = custom((v, path, issues) => {
  const n = typeof v === 'string' && /^\d$/.test(v) ? Number(v) : v;
  if (!(DOWS as readonly unknown[]).includes(n)) issues.push({ path, code: 'enum', params: { values: DOWS.join('|') } });
  return n as Dow;
});

/** `0..n` path parameter (block index). */
export const indexParam = int(0, 1000, { coerce: true });

/** Entity id or a Zigbee2MQTT pseudo id (`z2m:<friendly name>/<property>`). */
const siblingEntity: Schema<string | null> = custom((v, path, issues) => {
  if (v === null) return null;
  if (typeof v === 'string' && v.startsWith('z2m:') && v.length <= 255 && v.length > 4) return v;
  return entityId().run(v, path, issues);
});

const numOrStr: Schema<number | string> = custom((v, path, issues) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.length <= 255) return v;
  issues.push({ path, code: 'type', params: { expected: 'number|string' } });
  return 0;
});

const pair = (of: Schema<number>): Schema<[number, number]> =>
  custom((v, path, issues) => {
    if (!Array.isArray(v) || v.length !== 2) {
      issues.push({ path, code: 'length', params: { min: 2, max: 2 } });
      return [0, 0];
    }
    return [of.run(v[0], at(path, 0), issues), of.run(v[1], at(path, 1), issues)];
  });

/**
 * Comma-separated query list (`ids=a,b`), also accepting a repeated parameter. Empty → undefined.
 */
export function csv<T>(of: Schema<T>, max: number): Schema<T[] | undefined> {
  return {
    optional: true,
    run: (v, path, issues) => {
      if (v === undefined || v === '') return undefined;
      const raw = Array.isArray(v) ? v.flatMap((x) => String(x).split(',')) : typeof v === 'string' ? v.split(',') : null;
      if (!raw) {
        issues.push({ path, code: 'type', params: { expected: 'list' } });
        return undefined;
      }
      const items = raw.map((s) => s.trim()).filter(Boolean);
      if (items.length > max) issues.push({ path, code: 'max_items', params: { max } });
      return items.slice(0, max).map((x, i) => of.run(x, at(path, i), issues));
    },
  };
}

const band = obj({ below: num(0.1, 1, 0.1), above: num(0.1, 1, 0.1) });
const bandPatch = patch({ below: num(0.1, 1, 0.1), above: num(0.1, 1, 0.1) });

/* ── conditions (one tree for triggers, rules, source conditions, energy and watch rules) ───────── */

/** Conditions nest a few levels in practice; the limit keeps a malicious body from exhausting the stack. */
const MAX_CONDITION_PATH = 120;
const nodeId = opt(str(64, { min: 1 }));
const forSec = opt(int(0, 7 * 86_400));
const numCmp = oneOf(['<', '<=', '>', '>='] as const);

const timeWindow = obj({ from: hhmm(), to: hhmm(), days: opt(arr(dow, { max: 7 })) });

const conditionRef: Schema<ConditionNode> = lazy(() => condition);

/** Seeded triggers wait unbound (`''`) until the energy setup binds them; the store accepts that while disabled. */
const condEntity = (domains?: string[]): Schema<string> =>
  custom((v, path, issues) => (v === '' ? '' : entityId(domains).run(v, path, issues)));

const roomIdsOrServed: Schema<string[] | 'served'> = custom((v, path, issues) => {
  if (v === 'served') return 'served';
  return arr(id(), { max: 100 }).run(v, path, issues);
});

export const condition: Schema<ConditionNode> = custom((v, path, issues) => {
  if (path.split('.').length > MAX_CONDITION_PATH) {
    issues.push({ path, code: 'depth' });
    return { op: 'const', value: false };
  }
  return conditionVariants.run(v, path, issues);
});

const groupShape = { items: arr(conditionRef, { max: 50 }), id: nodeId, forSec };
const conditionVariants = union('op', {
  all: obj(groupShape),
  any: obj(groupShape),
  not: obj({ item: conditionRef, id: nodeId }),
  state: obj({ entityId: condEntity(), attribute: opt(str(80, { min: 1 })), equals: arr(str(255), { min: 1, max: 50 }), id: nodeId, forSec }),
  numeric: obj({
    entityId: condEntity(),
    attribute: opt(str(80, { min: 1 })),
    minus: opt(condEntity()),
    cmp: numCmp,
    value: num(-1e9, 1e9),
    exitAt: opt(num(-1e9, 1e9)),
    id: nodeId,
    forSec,
  }),
  template: obj({ template: str(5000, { min: 1 }), id: nodeId, forSec }),
  time: obj({ windows: arr(timeWindow, { min: 1, max: 20 }), tariffEntityId: opt(condEntity()), tariffStates: opt(arr(str(80), { max: 20 })), id: nodeId }),
  sun: obj({ is: oneOf(['above_horizon', 'below_horizon', 'elevation_above', 'elevation_below'] as const), degrees: opt(num(-90, 90)), id: nodeId, forSec }),
  weather: obj({
    entityId: condEntity(['weather']),
    field: oneOf(['condition', 'temperature', 'cloud_coverage', 'forecast_high_today', 'forecast_low_today', 'forecast_high_tomorrow'] as const),
    cmp: oneOf(['<', '<=', '>', '>=', '==', '!='] as const),
    value: numOrStr,
    id: nodeId,
  }),
  trigger: obj({ triggerId: id(), id: nodeId }),
  outdoor: obj({ cmp: numCmp, value: num(-60, 60), exitAt: opt(num(-60, 60)), basis: opt(oneOf(['now', 'avg10m', 'avg3d'] as const)), id: nodeId, forSec }),
  room_deficit: obj({ roomIds: roomIdsOrServed, deficitC: num(0, 20), forMin: opt(int(0, 1440)), id: nodeId }),
  room_below_target: obj({ roomId: id(), plusC: num(-10, 10), id: nodeId }),
  source: obj({ sourceId: id(), is: oneOf(['running', 'fault', 'unavailable', 'available', 'lagging'] as const), id: nodeId }),
  season: obj({ in: arr(oneOf(SEASONS), { min: 1, max: 3 }), id: nodeId }),
  house_mode: obj({ in: arr(oneOf(HOUSE_MODES), { min: 1, max: 4 }), id: nodeId }),
  budget_fits: obj({ id: nodeId }),
  grid: obj({ is: oneOf(['present', 'absent'] as const), id: nodeId }),
  const: obj({ value: bool(), id: nodeId }),
});

/* ── platform ─────────────────────────────────────────────────────────────────────────────────── */

const roomDefaultsPatch = patch({
  tolerance: patch({ heat: bandPatch, cool: bandPatch }),
  minRequestMin: minutes(30),
  staleAfterMin: minutes(240),
  smoothingMin: minutes(15),
  outlierC: num(0.5, 3),
  windowReaction: oneOf(WINDOW_REACTIONS),
  windowOpenDelaySec: int(0, 300),
  windowResumeDelaySec: int(0, 1800),
  windowRemindAfterMin: minutes(120),
});

export const generalSettingsPatch: Schema<DeepPartial<GeneralSettingsPatch>> = patch({
  houseName: name(40),
  outdoor: patch({
    sensorEntityIds: arr(entityId(), { max: MAX_OUTDOOR_SENSORS }),
    aggregation: oneOf(OUTDOOR_AGGREGATIONS),
    // a panel opened before several outdoor sensors still sends the single one
    sensorEntityId: nullableEntity,
    weatherEntityId: nullable(entityId(['weather'])),
    staleAfterMin: minutes(1440),
    holdMin: minutes(1440),
  }),
  units: oneOf(['auto', 'C', 'F'] as const),
  notificationLanguage: oneOf(LANGS),
  uiLanguage: oneOf(['auto', 'uk', 'en'] as const),
  defaultProfileId: id(),
  ecoProfileId: id(),
  targetLimits: patch({ heatMinC: celsius, heatMaxC: celsius, coolMinC: celsius, coolMaxC: celsius, stepC: num(0.1, 1) }),
  // 'until' needs a moment a thermostat cannot send (it reads as the slot); 'manual' makes the room manual
  haTargetChangeDuration: oneOf(ROOM_TARGET_DURATIONS),
  adminOnlyConfig: bool(),
  mqttConfigEntities: bool(),
  glassCoefficient: num(0, 1),
  presence: patch({
    enabled: bool(),
    personEntityIds: arr(entityId(['person']), { max: 30 }),
    homeZoneEntityId: entityId(['zone']),
    awayDelayMin: minutes(1440),
    proximityEntityId: nullableEntity,
    approachKm: num(0, 1000),
  }),
  defaults: roomDefaultsPatch,
  tariffs: patch({
    currency: str(8, { trim: true }),
    electricityPerKwh: nullable(num(0, 100)),
    gasPrice: nullable(num(0, 10_000)),
    gasPriceUnit: oneOf(GAS_PRICE_UNITS),
    gasKwhPerM3: num(5, 15),
  }),
  onboardingDismissed: bool(),
});

const exerciseShape = { enabled: bool(), dow, time: hhmm(), durationSec: int(0, 3600) };

export const safetySettingsPatch: Schema<DeepPartial<SafetySettingsPatch>> = patch({
  frostC: celsius,
  frostReleaseC: celsius,
  frostSupplyAlertC: celsius,
  overheatC: celsius,
  overheatReleaseC: celsius,
  noDataTrvSetpointC: celsius,
  sourceConfirmDefaultMin: minutes(120),
  relayWatchdogMin: minutes(120),
  relayRearmEveryMin: minutes(120),
  reconcileOnRestart: bool(),
  haBlindAfterSec: int(0, 3600),
  haDisconnectAlertMin: minutes(1440),
  startupDryRunSec: int(0, 600),
  trvHandbackOnStop: bool(),
  pumpExercise: patch(exerciseShape),
  valveExercise: patch({ ...exerciseShape, offSeasonOnly: bool() }),
  commandRate: patch({ globalPerSec: num(0.1, 100), burst: int(1, 1000), zigbeeSpacingMs: int(0, 10_000), perEntityMinIntervalSec: int(0, 3600) }),
  conflict: patch({ count: int(1, 100), windowMin: minutes(1440), backoffMin: minutes(1440) }),
});

export const deviceHealthPatch: Schema<DeepPartial<DeviceHealthPatch>> = patch({
  batteryLow: patch({ enabled: bool(), pct: pct, reminderPct: pct }),
  offline: patch({ enabled: bool(), batteryMin: minutes(10_080), contactMin: minutes(10_080), mainsMin: minutes(10_080), integrationMin: minutes(1440) }),
  trvUnconfirmed: patch({ enabled: bool(), attempts: int(1, 20), ackTimeoutSec: int(1, 3600) }),
  weakSignal: patch({ enabled: bool(), lqiBelow: int(0, 255), clearAt: int(0, 255), windowH: int(1, 168), minSamples: int(1, 1000) }),
});

/** Only the envelope is checked here; every table of the bundle is validated by the import itself. */
export const importBundle = obj({ app: lit('klimo'), version: lit(1) });
export const importQuery = obj({ dryRun: opt(bool({ coerce: true })) });

/* ── overview, journal ────────────────────────────────────────────────────────────────────────── */

export const dateQuery = obj({ date: opt(localDate) });

export const journalQuery = obj({
  category: opt(oneOf(JOURNAL_CATEGORIES)),
  roomId: opt(id()),
  sourceId: opt(id()),
  deviceKey: opt(str(255, { min: 1 })),
  before: opt(epoch(true)),
  limit: opt(int(1, 200, { coerce: true })),
});

/* ── rooms ────────────────────────────────────────────────────────────────────────────────────── */

export const orderRequest: Schema<OrderRequest> = obj({ ids: arr(id(), { max: 500 }) });

export const roomPatch: Schema<DeepPartial<RoomPatch>> = patch({
  name: name(40),
  slug: str(40, { min: 1, pattern: /^[a-z0-9_]{1,40}$/ }),
  icon: nullable(icon),
  haAreaId: nullable(str(255, { min: 1 })),
  controlEnabled: bool(),
  tolerance: patch({ heat: bandPatch, cool: bandPatch }),
  demand: patch({ policy: oneOf(DEMAND_POLICIES), minRequestMin: minutes(30) }),
  limits: nullable(obj({ heatMinC: celsius, heatMaxC: celsius, coolMinC: celsius, coolMaxC: celsius })),
  temperature: patch({
    method: oneOf(AGGREGATION_METHODS),
    outlier: patch({ enabled: bool(), thresholdC: num(0.5, 3) }),
    staleAfterMin: minutes(240),
    smoothingMin: oneOf([0, 2, 5, 10, 15] as const),
    fallbackToTrvSensors: bool(),
  }),
  humidity: patch({
    method: oneOf(HUMIDITY_METHODS),
    comfortPct: pair(pct),
    warnAbovePct: pct,
    warnForMin: minutes(1440),
    dewGlassMarginC: num(0, 20),
    dehumidifier: nullable(obj({ entityId: entityId(), onAbovePct: pct, offBelowPct: pct, minOnMin: minutes(1440) })),
    airingHint: oneOf(['notify', 'auto_pause'] as const),
  }),
  windows: patch({
    reaction: oneOf(WINDOW_REACTIONS),
    lowerByC: num(0, 10),
    openDelaySec: int(0, 300),
    resumeDelaySec: int(0, 1800),
    remindAfterMin: minutes(1440),
    notifyAfterMin: minutes(1440),
    tempDrop: patch({ enabled: bool(), dropC: num(0, 10), windowMin: minutes(120), holdMaxMin: minutes(1440) }),
    disableTrvBuiltinDetection: bool(),
  }),
  trv: patch({
    strategy: oneOf(TRV_STRATEGIES),
    manualPolicy: oneOf(TRV_MANUAL_POLICIES),
    revertAfterSec: int(0, 3600),
    onoffSetpoints: patch({ openC: celsius, closedC: celsius }),
    valvePi: patch({ kp: num(0, 1000), tiMin: num(0, 1440), minPct: pct, maxPct: pct, minStepPct: pct, everyMin: minutes(1440) }),
    childLock: bool(),
    batterySaver: patch({ enabled: bool(), minIntervalMin: minutes(1440), minDeltaC: num(0, 5), keepAliveMin: minutes(1440) }),
    ack: patch({ timeoutSec: int(1, 3600), attempts: int(1, 20), backgroundRetryMin: minutes(1440), notifyOnFail: bool() }),
    resendOnBridgeRestart: bool(),
    releaseSetpointC: celsius,
  }),
  ac: patch({
    control: oneOf(AC_CONTROLS),
    onoffSetpoints: patch({ heatC: celsius, coolC: celsius }),
    quietNight: patch({ enabled: bool(), from: hhmm(), to: hhmm(), fanMode: nullable(str(64, { min: 1 })) }),
    dry: patch({ enabled: bool(), abovePct: pct }),
    correction: patch({ maxOffsetC: num(0, 10), maxStepC: num(0, 10), everyMin: minutes(1440) }),
  }),
  smart: patch({
    optimalStart: patch({ enabled: bool(), maxLeadMin: minutes(1440) }),
    overheat: patch({ enabled: bool() }),
    valveExercise: patch({ enabled: bool() }),
    weatherComp: patch({ enabled: bool(), perFrostC: num(0.1, 50), shiftC: num(0, 5) }),
    solarGain: patch({ enabled: bool(), leadMin: minutes(1440) }),
  }),
  quick: patch({ boostDeltaC: num(0.5, 5), boostMin: int(10, 180), airingMin: int(5, 60) }),
  floor: patch({ maxFloorC: celsius, minFloorC: nullable(celsius) }),
  frostC: nullable(celsius),
  sunnySide: bool(),
  notify: patch({ sensorStale: bool(), trvFailed: bool(), batteryLow: bool(), humidity: bool(), windowLeftOpen: bool(), tooCold: bool(), tooHot: bool() }),
});

const wizardDevice = obj({ role: oneOf(WIZARD_ROLES), entityId: entityId(), name: opt(label(80)), move: opt(bool()) });
const newCircuit = obj({
  name: name(40),
  pumpEntityId: nullable(entityId()),
  sourceIds: arr(id(), { max: 20 }),
  mode: opt(oneOf(CIRCUIT_MODES)),
  runOnMin: opt(int(0, 30)),
  bypass: opt(bool()),
});
const heatingKinds = arr(oneOf(ROOM_HEATING_KINDS), { max: ROOM_HEATING_KINDS.length });
const createRoomShape = {
  name: name(40),
  haAreaId: nullable(str(255, { min: 1 })),
  icon: nullable(icon),
  emitterKinds: heatingKinds,
  demandPolicy: oneOf(DEMAND_POLICIES),
  devices: arr(wizardDevice, { max: 60 }),
  circuits: obj({
    radiatorCircuitId: nullable(id()),
    floorCircuitId: nullable(id()),
    newFloorCircuit: nullable(newCircuit),
    newRadiatorCircuit: opt(nullable(newCircuit)),
  }),
  method: nullable(oneOf(AGGREGATION_METHODS)),
  heatTolerance: band,
  coolTolerance: nullable(band),
  windowReaction: oneOf(WINDOW_REACTIONS),
  trvStrategy: nullable(oneOf(TRV_STRATEGIES)),
};

export const createRoomRequest: Schema<CreateRoomRequest> = obj(createRoomShape);

export const roomDeviceRequest: Schema<RoomDeviceRequest> = wizardDevice;
export const roomBindingReplaceRequest: Schema<RoomBindingReplaceRequest> = obj({ entityId: entityId(), name: opt(label(80)), move: opt(bool()) });
export const roomHeatingRequest: Schema<RoomHeatingRequest> = obj({
  kinds: heatingKinds,
  radiatorCircuitId: opt(nullable(id())),
  newRadiatorCircuit: opt(nullable(newCircuit)),
  floorCircuitId: opt(nullable(id())),
  newFloorCircuit: opt(nullable(newCircuit)),
  devices: opt(arr(wizardDevice, { max: 60 })),
});
export const circuitMergeRequest: Schema<CircuitMergeRequest> = obj({ intoId: id(), dropPumps: opt(bool()) });
export const circuitRoomRequest: Schema<CircuitRoomRequest> = obj({ roomId: id(), zoneEntityId: opt(nullable(entityId())) });

export const validateRoomRequest: Schema<ValidateRoomRequest> = obj({
  step: oneOf([1, 2, 3, 4] as const),
  draft: patch(createRoomShape),
});

export const stepParam = oneOf(STEP_KINDS);

export const sensorCreateRequest: Schema<SensorCreateRequest> = obj({
  entityId: entityId(),
  role: oneOf(SENSOR_ROLES),
  contactKind: opt(nullable(oneOf(CONTACT_KINDS))),
  name: opt(label(80)),
  weight: opt(num(0.1, 2, 0.1)),
});

export const sensorPatch: Schema<SensorPatch> = patch({
  name: label(80),
  weight: num(0.1, 2, 0.1),
  included: bool(),
  contactKind: nullable(oneOf(CONTACT_KINDS)),
});

export const sensorOrderRequest: Schema<SensorOrderRequest> = obj({ role: oneOf(SENSOR_ROLES), ids: arr(id(), { min: 1, max: 100 }) });

const emitterRoles = obj({ heat: nullable(oneOf(EMITTER_ROLES)), cool: nullable(oneOf(EMITTER_ROLES)) });

export const emitterCreateRequest: Schema<EmitterCreateRequest> = obj({
  kind: oneOf(EMITTER_KINDS),
  name: opt(label(80)),
  circuitId: opt(nullable(id())),
  sourceId: opt(nullable(id())),
  roles: emitterRoles,
});

export const emitterPatch: Schema<DeepPartial<EmitterPatch>> = patch({
  name: label(80),
  enabled: bool(),
  circuitId: nullable(id()),
  roles: patch({ heat: nullable(oneOf(EMITTER_ROLES)), cool: nullable(oneOf(EMITTER_ROLES)) }),
  assist: nullable(obj({ deficitC: num(0.1, 10) })),
  trigger: nullable(obj({ heatStoreAboveTargetC: num(0, 10) })),
  excludeFromCooling: bool(),
  ignoreSeason: bool(),
  order: int(0, 10_000),
});

export const emitterDeviceCreateRequest: Schema<EmitterDeviceCreateRequest> = obj({
  kind: oneOf(DEVICE_KINDS),
  entityId: entityId(['climate', 'switch', 'valve', 'input_boolean', 'light', 'fan']),
  name: opt(label(80)),
  label: opt(nullable(label(80))),
});

export const emitterDevicePatch: Schema<DeepPartial<EmitterDevicePatch>> = patch({
  name: label(80),
  label: nullable(label(80)),
  siblings: patch({
    externalTemp: siblingEntity,
    sensorSelect: siblingEntity,
    calibration: siblingEntity,
    valveOpening: siblingEntity,
    valveClosing: siblingEntity,
    childLock: siblingEntity,
    windowDetection: siblingEntity,
    battery: siblingEntity,
    linkquality: siblingEntity,
    valvePosition: siblingEntity,
  }),
  order: int(0, 10_000),
});

export const profileTargetRequest: Schema<ProfileTargetRequest> = checked(
  obj({ mode: oneOf(['inherit', 'own', 'off'] as const), heatC: opt(nullable(num(5, 30, 0.1))), coolC: opt(nullable(num(16, 32, 0.1))) }),
  (v, add) => {
    if (v.mode === 'own' && v.heatC == null && v.coolC == null) add('heatC', 'required');
  },
);

export const setTargetRequest: Schema<SetTargetRequest> = checked(
  obj({
    value: opt(num(5, 32)),
    lo: opt(num(5, 30)),
    hi: opt(num(16, 32)),
    which: opt(oneOf(['t', 'lo', 'hi'] as const)),
    duration: oneOf(ROOM_TARGET_DURATIONS),
    until: opt(epoch()),
    reqId,
  }),
  (v, add) => {
    if (v.value === undefined && v.lo === undefined && v.hi === undefined) add('value', 'required');
    if (v.duration === 'until' && v.until === undefined) add('until', 'required');
  },
);

export const undoRequest: Schema<UndoRequest> = obj({ revertToken: str(128, { min: 1 }) });

export const boostRequest: Schema<BoostRequest & { reqId?: string }> = obj({ deltaC: opt(num(-5, 5)), minutes: opt(int(10, 180)), reqId });
export const airingRequest = obj({ minutes: opt(int(5, 60)), reqId });
export const windowIgnoreRequest = obj({ minutes: opt(int(5, 240)), reqId });

const untilWhenNeeded = <T extends { duration: string; until?: number }>(s: Schema<T>) =>
  checked(s, (v, add) => {
    if (v.duration === 'until' && v.until === undefined) add('until', 'required');
  });

export const roomOffRequest: Schema<RoomOffRequest & { reqId?: string }> = untilWhenNeeded(obj({ duration: oneOf(LOCK_DURATIONS), until: opt(epoch()), reqId }));
export const roomProfileRequest: Schema<RoomProfileRequest & { reqId?: string }> = untilWhenNeeded(
  obj({ profileId: id(), duration: oneOf(LOCK_DURATIONS), until: opt(epoch()), reqId }),
);
/** Body-less control actions (DELETE) may still carry a `reqId`. */
export const reqIdOnly = obj({ reqId });

/** Room control mode; a value goes with 'manual' only (without one the room holds its current target). */
export const roomControlRequest: Schema<RoomControlRequest> = checked(
  obj({ mode: oneOf(ROOM_CONTROL_CHOICES), heatC: opt(num(5, 30)), coolC: opt(num(16, 32)), reqId }),
  (v, add) => {
    if (v.mode === 'manual') return;
    if (v.heatC !== undefined) add('heatC', 'not_allowed', { mode: v.mode });
    if (v.coolC !== undefined) add('coolC', 'not_allowed', { mode: v.mode });
  },
);

export const releaseQuery = obj({ releaseTrvs: opt(bool({ coerce: true })) });

/* ── Home Assistant lookups and history ───────────────────────────────────────────────────────── */

export const entityQuery = obj({
  q: opt(str(100)),
  domain: csv(str(40, { pattern: /^[a-z_]+$/ }), 20),
  deviceClass: csv(str(40), 20),
  areaId: opt(str(255, { min: 1 })),
  role: opt(oneOf(ROLE_PRESETS)),
  unassigned: opt(bool({ coerce: true })),
  nearRoomId: opt(id()),
  nearAreaId: opt(str(255, { min: 1 })),
  wizard: opt(oneOf([...WIZARD_ROLES, 'any'] as const)),
  limit: opt(int(1, 500, { coerce: true })),
});

export const renderTemplateRequest = obj({ template: str(5000, { min: 1 }) });

const MAX_HISTORY_MS = 31 * 86_400_000;
const rangeRules = <T extends { from?: number; to?: number }>(s: Schema<T>) =>
  checked(s, (v, add) => {
    if (v.from !== undefined && v.to !== undefined) {
      if (v.to <= v.from) add('to', 'order', { min: v.from });
      else if (v.to - v.from > MAX_HISTORY_MS) add('to', 'range', { maxDays: 31 });
    }
  });

export const historyQuery = rangeRules(
  obj({ ids: csv(entityId(), 20), from: opt(epoch(true)), to: opt(epoch(true)), attribute: opt(str(80, { min: 1 })) }),
);
export const statisticsQuery = rangeRules(
  obj({
    ids: csv(str(255, { min: 1 }), 20),
    from: opt(epoch(true)),
    to: opt(epoch(true)),
    period: opt(oneOf(STAT_PERIODS)),
    types: csv(oneOf(STAT_TYPES), 6),
  }),
);
export const outdoorHistoryQuery = obj({ days: opt(int(1, 31, { coerce: true })) });
export const consumptionQuery: Schema<Partial<ConsumptionQuery>> = obj({ range: opt(oneOf(CONSUMPTION_RANGES)), date: opt(localDate) });
export const houseConsumptionQuery = obj({ date: opt(localDate) });
export const rangeQuery = obj({ from: opt(epoch(true)), to: opt(epoch(true)) });

/* ── profiles, priority, house ────────────────────────────────────────────────────────────────── */

const profileShape = {
  name: name(24),
  color,
  ink: color,
  icon,
  heatC: num(5, 30, 0.5),
  coolC: num(16, 32, 0.5),
  frostOnly: bool(),
};

export const profileCreateRequest: Schema<ProfileCreateRequest> = patch({ ...profileShape, copyFrom: id() });
export const profilePatch: Schema<ProfilePatch> = patch({ ...profileShape, order: int(0, 10_000) });
export const profileDeleteRequest: Schema<ProfileDeleteRequest> = obj({ replaceWith: id() });

export const activationRuleConfig: Schema<ActivationRuleConfig> = union('type', {
  presence: obj({ trigger: oneOf(['all_away', 'someone_home', 'approaching'] as const), optimalStart: bool() }),
  calendar: obj({
    calendarEntityId: entityId(['calendar']),
    match: obj({ field: oneOf(['summary', 'description', 'location'] as const), contains: str(200) }),
    preheatMin: minutes(1440),
  }),
  vacation: obj({ from: nullable(epoch()), until: nullable(epoch()), returnProfileId: id(), returnLeadH: num(0, 72) }),
});

export const activationRulePatch = patch({ enabled: bool(), config: activationRuleConfig, order: int(0, 10_000) });

/** Frost and window protection always come first; the rest is the household's order. */
export const priorityRequest: Schema<PriorityRequest> = checked(obj({ order: arr(oneOf(PRIORITY_DEFAULT), { min: 7, max: 7 }) }), (v, add) => {
  if (new Set(v.order).size !== v.order.length) add('order', 'unique');
  PRIORITY_LOCKED.forEach((key, i) => {
    if (v.order[i] !== key) add(`order.${i}`, 'locked', { expected: key });
  });
});

export const houseProfileRequest: Schema<HouseProfileRequest> = untilWhenNeeded(
  obj({ profileId: id(), duration: oneOf(HOUSE_DURATIONS), until: opt(epoch()), reqId }),
);
export const houseModeRequest: Schema<HouseModeRequest & { reqId?: string }> = obj({ mode: oneOf(HOUSE_MODES), reqId });
export const houseControlRequest: Schema<HouseControlRequest> = obj({ mode: oneOf(HOUSE_CONTROL_MODES), reqId });

/* ── schedules ────────────────────────────────────────────────────────────────────────────────── */

const block = obj({ start: int(0, 1440), end: int(0, 1440), profileId: id() });
export const dayPlan: Schema<DayPlan> = arr(block, { min: 1, max: 48 });

/** «Розклад кімнати»: from the house plan, empty (the default profile all day), or another schedule. */
export const scheduleCreateRequest: Schema<ScheduleCreateRequest> = obj({ roomId: id(), copyFrom: id() });
export const scheduleEnabledPatch = obj({ enabled: bool() });
export const scheduleDayRequest: Schema<ScheduleDayRequest> = obj({ blocks: dayPlan, applyTo: opt(arr(dow, { max: 7 })) });
export const scheduleSplitRequest: Schema<ScheduleSplitRequest> = obj({ index: int(0, 47), at: opt(int(0, 1440)) });
export const copyDayRequest: Schema<CopyDayRequest> = obj({ from: dow, to: arr(dow, { min: 1, max: 7 }) });

const planOrLike: Schema<ScheduleExceptionRequest['plan']> = custom((v, path, issues) => {
  if (Array.isArray(v)) return dayPlan.run(v, path, issues);
  return obj({ likeDow: dow }).run(v, path, issues);
});
export const scheduleExceptionRequest: Schema<ScheduleExceptionRequest> = obj({ plan: planOrLike, note: opt(nullable(label(120))) });
export const resolvedQuery = obj({ date: opt(localDate), roomId: opt(id()) });

/* ── sources and hydronics ────────────────────────────────────────────────────────────────────── */

const serviceName = str(64, { min: 1, pattern: /^[a-z0-9_]+$/ });
const entityIdOrList: Schema<string | string[]> = custom((v, path, issues) =>
  Array.isArray(v) ? arr(entityId(), { max: 50 }).run(v, path, issues) : entityId().run(v, path, issues),
);

export const serviceCall: Schema<ServiceCallSpec> = obj({
  domain: serviceName,
  service: serviceName,
  target: opt(obj({ entity_id: opt(entityIdOrList), device_id: opt(str(255, { min: 1 })), area_id: opt(str(255, { min: 1 })) })),
  data: opt(record(any(), { maxKeys: 50 })),
});
const serviceCalls = arr(serviceCall, { max: 20 });

export const confirmSpec: Schema<ConfirmSpec> = union('kind', {
  none: obj({}),
  readback: obj({}),
  entity_on: obj({ entityId: entityId() }),
  power_above: obj({ entityId: entityId(), thresholdW: num(0, 1_000_000) }),
  hvac_action: obj({ values: opt(arr(str(32, { min: 1 }), { max: 10 })) }),
  state_in: obj({ entityId: entityId(), values: arr(str(64), { min: 1, max: 20 }) }),
});

const watchdogSpec = union('kind', {
  none: obj({}),
  countdown_number: obj({ entityId: entityId(), minutes: num(1, 240), rearmEveryMin: num(1, 120) }),
  service: obj({ call: serviceCall, rearmEveryMin: num(1, 120) }),
  device: obj({ minutes: num(1, 240) }),
});

const modeEntities = (domains?: string[]) =>
  obj({ heat: opt(entityId(domains)), cool: opt(entityId(domains)), dry: opt(entityId(domains)), fan: opt(entityId(domains)) });

const adapterShapes = {
  relay: {
    command: nullableEntity,
    invert: bool(),
    stages: arr(obj({ entityId: entityId(), powerKw: kw }), { max: 6 }),
    confirm: confirmSpec,
    watchdog: watchdogSpec,
    flowSetpoint: nullable(obj({ entityId: entityId(), useCurve: bool() })),
  },
  climate: {
    climate: nullable(entityId(['climate'])),
    modeMap: obj({ heat: opt(str(32, { min: 1 })), cool: opt(str(32, { min: 1 })), dry: opt(str(32, { min: 1 })), fan: opt(str(32, { min: 1 })), off: str(32, { min: 1 }) }),
    setpoint: oneOf(['flow_curve', 'room_target', 'fixed', 'none'] as const),
    fixedSetpoint: nullable(obj({ heatC: celsius, coolC: celsius })),
    quietFanMode: nullable(str(64, { min: 1 })),
    confirm: confirmSpec,
    defrostEntityId: nullableEntity,
    errorEntityId: nullableEntity,
    errorOkValues: arr(str(64), { max: 20 }),
    copEntityId: nullableEntity,
    supplyTempEntityId: nullableEntity,
  },
  flow: {
    enable: nullableEntity,
    flowSetpoint: nullableEntity,
    actualFlow: nullableEntity,
    modeSelect: nullable(obj({ entityId: entityId(), heat: str(64, { min: 1 }), cool: str(64, { min: 1 }) })),
    confirm: confirmSpec,
  },
  script: { on: modeEntities(['script']), off: nullable(entityId(['script'])), confirm: confirmSpec },
  custom: {
    on: obj({ heat: opt(serviceCalls), cool: opt(serviceCalls), dry: opt(serviceCalls), fan: opt(serviceCalls) }),
    off: serviceCalls,
    setpoint: nullable(serviceCalls),
    confirm: confirmSpec,
  },
};

/** A complete adapter (binding validation). */
export const sourceAdapter: Schema<SourceAdapter> = union('type', {
  relay: obj(adapterShapes.relay),
  climate: obj(adapterShapes.climate),
  flow: obj(adapterShapes.flow),
  script: obj(adapterShapes.script),
  custom: obj(adapterShapes.custom),
});

/** An adapter patch: `type` + the bindings that change (a new type starts from that adapter's defaults). */
const sourceAdapterPatch = union('type', {
  relay: patch(adapterShapes.relay),
  climate: patch(adapterShapes.climate),
  flow: patch(adapterShapes.flow),
  script: patch(adapterShapes.script),
  custom: patch(adapterShapes.custom),
});

const capabilities = obj({ heat: bool(), cool: bool(), dry: bool(), fan: bool() });
const weatherCurve = obj({
  points: arr(obj({ outdoorC: num(-50, 50), flowC: num(0, 100) }), { min: 2, max: 4 }),
  shiftC: num(-20, 20),
  minFlowC: num(0, 100),
  maxFlowC: num(0, 100),
});
const outdoorLimit = obj({ minC: nullable(num(-50, 50)), maxC: nullable(num(-50, 50)), hysteresisC: num(0, 10) });
/** Items and chain entries without an id get one from the configuration store. */
function withId<T extends { id?: string }>(inner: Schema<T>): Schema<T & { id: string }> {
  return custom((v, path, issues) => {
    const value = inner.run(v, path, issues);
    return { ...value, id: value.id ?? '' };
  });
}

const conditionItem = withId(obj({ id: opt(id()), mode: nullable(oneOf(MODES)), node: condition, enabled: bool() }));

export const sourceCreateRequest: Schema<SourceCreateRequest> = obj({
  kind: oneOf(SOURCE_KINDS),
  name: opt(name(40)),
  scope: opt(oneOf(SCOPES)),
  roomId: opt(nullable(id())),
  adapterType: opt(oneOf(ADAPTER_TYPES)),
});

const sourceMeter: Schema<SourceMeter> = obj({
  kind: oneOf(METER_KINDS),
  entityId: entityId(['sensor', 'input_number', 'number']),
  unit: nullable(str(16, { min: 1, trim: true })),
});

export const sourcePatch: Schema<DeepPartial<SourcePatch>> = patch({
  name: name(40),
  kind: oneOf(SOURCE_KINDS),
  subtype: label(80),
  scope: oneOf(SCOPES),
  roomId: nullable(id()),
  order: int(0, 10_000),
  enabled: bool(),
  capabilities: patch({ heat: bool(), cool: bool(), dry: bool(), fan: bool() }),
  energy: patch({
    carrier: oneOf(CARRIERS),
    maxPowerKw: kw,
    auxPowerKw: kw,
    powerEntityId: nullableEntity,
    countsInBlackoutBudget: bool(),
    nightTariffEligible: bool(),
    minBatteryPct: nullable(pct),
    staggerSec: nullable(int(0, 600)),
  }),
  meters: arr(sourceMeter, { max: METER_KINDS.length }),
  adapter: sourceAdapterPatch,
  curves: patch({ heat: nullable(weatherCurve), cool: nullable(obj({ flowC: num(0, 40), maxFlowC: num(0, 40) })) }),
  outdoorLimits: patch({ heat: nullable(outdoorLimit), cool: nullable(outdoorLimit) }),
  guards: patch({
    minRunMin: minutes(240),
    minOffMin: minutes(240),
    maxStartsPerHour: nullable(int(1, 60)),
    startConfirmTimeoutMin: minutes(240),
    unavailableAfterMin: minutes(240),
    faultRetryMin: minutes(1440),
    defrostIsNotFault: bool(),
    roomMaxC: nullable(celsius),
    stageUpAfterMin: minutes(240),
    changeoverMinH: nullable(num(0, 48)),
  }),
  conditions: patch({ join: oneOf(['all', 'any', 'perMode'] as const), items: arr(conditionItem, { max: 20 }) }),
  seasonPolicy: patch({ heat: oneOf(['season', 'always'] as const), cool: oneOf(['season', 'always'] as const) }),
  failsafe: patch({ onStop: oneOf(['off', 'leave', 'handback'] as const), handback: nullable(obj({ hvacMode: str(32, { min: 1 }), setpointC: celsius })) }),
  hydronic: nullable(obj({ requiresFlow: bool(), preRunSec: int(0, 600) })),
  linkedTo: nullable(id()),
  ownFields: arr(oneOf(SOURCE_LINKABLE_FIELDS), { max: SOURCE_LINKABLE_FIELDS.length }),
});

export const sourceDuplicateRequest: Schema<SourceDuplicateRequest> = obj({ linked: bool(), name: opt(name(40)), roomId: opt(nullable(id())) });

export const bindingValidationRequest = obj({ sourceId: opt(id()), adapter: sourceAdapter, capabilities });

export const sourceTestRequest: Schema<SourceTestRequest & { reqId?: string }> = obj({ mode: opt(oneOf(SOURCE_MODES)), durationSec: opt(int(30, 600)), reqId });

export const sourceLockRequest: Schema<SourceLockRequest & { reqId?: string }> = checked(
  obj({
    kind: oneOf(['source_off', 'source_force'] as const),
    mode: opt(oneOf(SOURCE_MODES)),
    duration: oneOf(LOCK_DURATIONS),
    until: opt(epoch()),
    reason: opt(label(200)),
    reqId,
  }),
  (v, add) => {
    if (v.kind === 'source_force' && !v.mode) add('mode', 'required');
    if (v.duration === 'until' && v.until === undefined) add('until', 'required');
  },
);

export const forceQuery = obj({ force: opt(bool({ coerce: true })) });

const supplyShape = { sensorEntityId: nullableEntity, returnEntityId: nullableEntity, coolC: num(5, 30), coolMaxC: num(5, 30) };
const circuitShape = {
  name: name(40),
  shortName: label(24),
  kind: oneOf(CIRCUIT_KINDS),
  manifoldId: nullable(id()),
  sourceIds: arr(id(), { max: 20 }),
  capabilities: patch({ heat: bool(), cool: bool() }),
  supply: patch(supplyShape),
  mixingValve: nullable(obj({ entityId: entityId(), heatC: celsius, coolC: nullable(celsius) })),
  dewMarginC: nullable(num(0.5, 10)),
  pumpGroupMode: oneOf(PUMP_GROUP_MODES),
  flowSafety: bool(),
  mode: oneOf(CIRCUIT_MODES),
  bypass: bool(),
};

/** New circuit: name and kind are required, the rest takes the defaults of a circuit of that kind. */
export const circuitCreateRequest = checked(patch(circuitShape), (v, add) => {
  if (v.name === undefined) add('name', 'required');
  if (v.kind === undefined) add('kind', 'required');
});
export const circuitPatch: Schema<DeepPartial<CircuitPatch>> = patch({ ...circuitShape, order: int(0, 10_000) });

const pumpShape = {
  name: name(40),
  circuitId: nullable(id()),
  manifoldId: nullable(id()),
  entityId: entityId(),
  rule: oneOf(PUMP_RULES),
  runOnHeatMin: int(0, 30),
  runOnCoolMin: int(0, 30),
  minOnSec: int(0, 3600),
  exercise: bool(),
  speed: nullable(obj({ entityId: entityId(), heat: numOrStr, cool: numOrStr })),
  enabled: bool(),
};

export const pumpCreateRequest = checked(patch(pumpShape), (v, add) => {
  if (v.name === undefined) add('name', 'required');
  if (v.entityId === undefined) add('entityId', 'required');
});
export const pumpPatch: Schema<DeepPartial<PumpPatch>> = patch({ ...pumpShape, order: int(0, 10_000) });

const manifoldShape = { name: name(40), supplySensorEntityId: nullableEntity, returnSensorEntityId: nullableEntity };
export const manifoldCreateRequest = checked(patch(manifoldShape), (v, add) => {
  if (v.name === undefined) add('name', 'required');
});
export const manifoldPatch: Schema<ManifoldPatch> = patch({ ...manifoldShape, order: int(0, 10_000) });

/* ── system, strategy, triggers, rules, energy ────────────────────────────────────────────────── */

export const simulateRequest: Schema<SimulateRequest> = patch({
  preset: oneOf(SIM_PRESETS),
  conditions: patch({
    at: epoch(),
    outdoorC: num(-50, 50),
    gridPresent: bool(),
    pvKw: kw,
    batteryPct: pct,
    houseLoadKw: kw,
    houseMode: oneOf(HOUSE_MODES),
    roomTempOffsetC: num(-10, 10),
  }),
});

export const heatStrategyPatch: Schema<DeepPartial<HeatStrategyPatch>> = patch({
  bivalence: patch({ mode: oneOf(BIVALENT_MODES), pointC: num(-30, 15), hysteresisC: num(0, 10), hpLimitC: num(-40, 15) }),
  lag: patch({ enabled: bool(), deficitC: num(0, 10), forMin: minutes(1440), graceAfterStartMin: minutes(1440) }),
  heatingCutoffOutdoorC: nullable(num(-10, 40)),
});

const chainEntry: Schema<ChainEntry> = withId(obj({ id: opt(id()), sourceIds: arr(id(), { min: 1, max: 20 }), label: nullable(label(40)), enabled: bool() }));
export const chainRequest = obj({ chain: arr(chainEntry, { max: 30 }) });

export const coolStrategyPatch: Schema<DeepPartial<CoolStrategyPatch>> = patch({
  hpModeSelection: oneOf(HP_MODE_SELECTIONS),
  dewMarginC: num(0, 10),
  changeoverMinH: num(0, 48),
  autoMinGapC: num(0, 10),
  dryInsteadOfCool: patch({ enabled: bool(), abovePct: pct }),
  floorExcludeAbovePct: nullable(pct),
  solarPrecool: patch({ enabled: bool(), leadMin: minutes(1440) }),
  singleRoomCentralStart: bool(),
});

export const seasonPatch: Schema<SeasonPatch> = patch({
  avgDays: int(1, 14),
  heatBelowC: num(-20, 40),
  coolAboveC: num(-20, 40),
  hysteresisC: num(0, 10),
  minDwellH: num(0, 240),
  confirmH: num(0, 72),
  heatingMonths: arr(bool(), { min: 12, max: 12 }),
  coolingMonths: arr(bool(), { min: 12, max: 12 }),
  neutralColdGuardC: num(0, 10),
});

const energyEntities = {
  gridOffline: nullableEntity,
  pvPower: nullableEntity,
  houseLoad: nullableEntity,
  batterySoc: nullableEntity,
  tariff: nullableEntity,
};

export const energyPatch: Schema<DeepPartial<EnergyPatch>> = patch({
  budgetKw: num(0, 100),
  inverterMaxKw: nullable(num(0, 100)),
  staggerSec: int(0, 600),
  shedOrder: arr(id(), { max: 100 }),
  shedOrderCustom: bool(),
  exempt: patch({ sourceIds: arr(id(), { max: 100 }), pumps: bool(), whileSocAbovePct: pct }),
  criticalSocPct: pct,
  entities: patch(energyEntities),
  activeWhen: condition,
});

/** Unbound roles may be left out (null). */
export const energySetupRequest: Schema<EnergySetupRequest> = custom((v, path, issues) => {
  const parsed = obj({ entities: patch(energyEntities) }).run(v, path, issues);
  const e = parsed.entities ?? {};
  return {
    entities: {
      gridOffline: e.gridOffline ?? null,
      pvPower: e.pvPower ?? null,
      houseLoad: e.houseLoad ?? null,
      batterySoc: e.batterySoc ?? null,
      tariff: e.tariff ?? null,
    },
  };
});

const triggerShape = {
  name: name(40),
  icon,
  kind: oneOf(TRIGGER_KINDS),
  condition,
  enabled: bool(),
  whenUnknown: oneOf(['false', 'true', 'hold_false', 'hold_true'] as const),
  holdMaxMin: minutes(1440),
  notifyOnActivate: bool(),
};

/** New trigger: name, kind and condition are required; the rest has defaults. */
export const triggerCreateRequest = checked(patch(triggerShape), (v, add) => {
  for (const k of ['name', 'kind', 'condition'] as const) if (v[k] === undefined) add(k, 'required');
});
export const triggerPatch: Schema<TriggerPatch> = patch({ ...triggerShape, order: int(0, 10_000) });

export const conditionPreviewRequest: Schema<ConditionPreviewRequest> = obj({ node: condition, sourceId: opt(id()) });

const roomIdsTarget: Schema<string[] | 'all' | 'trigger_rooms'> = custom((v, path, issues) => {
  if (v === 'all' || v === 'trigger_rooms') return v;
  return arr(id(), { min: 1, max: 100 }).run(v, path, issues);
});
const powerKwOrBudget: Schema<number | 'budget'> = custom((v, path, issues) => (v === 'budget' ? 'budget' : num(0, 100).run(v, path, issues)));
const sourceIds = arr(id(), { max: 50 });

export const ruleEffect: Schema<RuleEffect> = union('type', {
  target_offset: obj({ roomIds: roomIdsTarget, deltaC: num(-5, 5), mode: oneOf(['heat', 'cool', 'both'] as const) }),
  allow_sources: obj({ sourceIds, modes: opt(record(oneOf(SOURCE_MODES), { maxKeys: 50 })) }),
  only_sources: obj({ sourceIds }),
  forbid_sources: obj({ sourceIds }),
  disable_carrier: obj({ carrier: oneOf(CARRIERS) }),
  power_cap: obj({ kw: powerKwOrBudget }),
  preheat_to_next_slot: obj({ sourceIds }),
  source_requires: obj({ sourceId: id(), triggerId: id() }),
  pumps_demand_only: obj({}),
});

const ruleShape = {
  name: name(40),
  enabled: bool(),
  priority: int(0, 10_000),
  when: condition,
  stopWhen: nullable(condition),
  effects: arr(ruleEffect, { max: 20 }),
  notifyOnActivate: bool(),
};

/** New rule: name, condition and effects are required. */
export const ruleCreateRequest = checked(patch(ruleShape), (v, add) => {
  for (const k of ['name', 'when', 'effects'] as const) if (v[k] === undefined) add(k, 'required');
});
export const rulePatch: Schema<RulePatch> = patch(ruleShape);

/* ── incidents and notifications ──────────────────────────────────────────────────────────────── */

const incidentScope = str(80, { pattern: /^(attention|devices|inbox|all|room:[A-Za-z0-9_.:-]+|source:[A-Za-z0-9_.:-]+)$/ });

export const incidentQuery = obj({
  scope: opt(incidentScope),
  status: opt(oneOf(INCIDENT_STATUSES)),
  before: opt(epoch(true)),
  limit: opt(int(1, 500, { coerce: true })),
});

export const incidentActionRequest: Schema<IncidentActionRequest & { reqId?: string }> = obj({
  action: oneOf(INCIDENT_ACTIONS),
  minutes: opt(int(1, 10_080)),
  until: opt(epoch()),
  reqId,
});

export const notifySettingsPatch: Schema<DeepPartial<NotifySettingsPatch>> = patch({
  telegram: patch({ mode: oneOf(TELEGRAM_MODES), haService: nullable(str(120, { min: 1 })), botUsername: nullable(str(64, { min: 1 })) }),
  criticalBypassDnd: bool(),
  quietHours: patch({ enabled: bool(), from: hhmm(), to: hhmm(), digest: bool() }),
  grouping: patch({ enabled: bool(), windowMin: minutes(60) }),
  repeatCritical: patch({ enabled: bool(), everyMin: int(1, 1440), maxTimes: int(0, 100) }),
  escalation: patch({ enabled: bool(), afterMin: int(1, 1440), targetId: nullable(id()) }),
  recoveryMessages: bool(),
  watchAllUsedEntities: bool(),
  reports: patch({ daily: patch({ time: hhmm() }), weekly: patch({ dow, time: hhmm() }) }),
  actionTtlH: int(1, 168),
});

const notifyService = str(120, { pattern: /^notify\.[a-z0-9_]+$/ });
const chatId = str(24, { pattern: /^-?\d{1,20}$/ });

const targetShape = {
  channel: oneOf(CHANNEL_KINDS),
  name: name(40),
  shortName: nullable(label(24)),
  icon,
  enabled: bool(),
  service: nullable(notifyService),
  chatId: nullable(chatId),
  chatTitle: nullable(label(80)),
  isPrimary: bool(),
  isEscalation: bool(),
  ownerUserId: nullable(str(64, { min: 1 })),
};

/** New target: the channel and a name; the column gets its preset routing. */
export const notifyTargetCreateRequest = checked(patch(targetShape), (v, add) => {
  if (v.channel === undefined) add('channel', 'required');
  if (v.name === undefined) add('name', 'required');
});
export const notifyTargetPatch: Schema<NotifyTargetPatch> = patch({ ...targetShape, order: int(0, 10_000) });

export const routeRequest = obj({ on: bool() });
export const eventKindParam = oneOf(EVENT_KINDS);

export const routingBulkRequest: Schema<RoutingBulkRequest> = checked(
  obj({ kinds: opt(arr(oneOf(EVENT_KINDS), { max: EVENT_KINDS.length })), severity: opt(oneOf(SEVERITIES)), targetIds: arr(id(), { min: 1, max: 50 }), on: bool() }),
  (v, add) => {
    if (!v.kinds && !v.severity) add('kinds', 'required');
  },
);

export const eventParamsPatch = patch({ enabled: bool(), params: record(custom<number | string | boolean>((v, path, issues) => {
  if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 200)) return v;
  issues.push({ path, code: 'type', params: { expected: 'number|string|boolean' } });
  return false;
}), { maxKeys: 30 }) });

export const testNotificationRequest: Schema<TestNotificationRequest> = checked(
  patch({ targetId: id(), channel: oneOf(CHANNEL_KINDS), all: bool() }),
  (v, add) => {
    if (!v.targetId && !v.channel && !v.all) add('targetId', 'required');
  },
);

export const watchQuery = obj({ filter: opt(oneOf(['all', 'problems', 'manual'] as const)), q: opt(str(100)) });

export const watchCondition: Schema<WatchCondition> = union('type', {
  unavailable: obj({ forMin: int(0, 10_080) }),
  stale: obj({ noUpdateMin: int(1, 10_080) }),
  offline: obj({ forMin: int(0, 10_080) }),
  not_confirmed: obj({ attempts: int(1, 20) }),
  no_confirmation_after_demand: obj({ forMin: int(1, 1440) }),
  custom: obj({ node: condition }),
});

const watchRef = obj({ sourceId: opt(id()), roomId: opt(id()), deviceKey: opt(str(255, { min: 1 })), triggerId: opt(id()), pumpId: opt(id()) });

const watchShape = {
  entityId: entityId(),
  name: label(255),
  role: str(40, { min: 1 }),
  ref: nullable(watchRef),
  condition: watchCondition,
  severity: oneOf(['critical', 'warning'] as const),
  eventKind: oneOf(EVENT_KINDS),
  muted: bool(),
};

/** New manual rule: what to watch and how; it raises `entity_unavailable` warnings unless told otherwise. */
export const watchRuleCreateRequest: Schema<Partial<Omit<WatchRule, 'id' | 'origin'>>> = checked(patch(watchShape), (v, add) => {
  if (v.entityId === undefined) add('entityId', 'required');
  if (v.condition === undefined) add('condition', 'required');
});
export const watchRulePatch: Schema<WatchRulePatch> = patch({
  condition: watchCondition,
  severity: oneOf(['critical', 'warning'] as const),
  muted: bool(),
  name: label(255),
  eventKind: oneOf(EVENT_KINDS),
});

export const sentLogQuery = obj({
  before: opt(epoch(true)),
  limit: opt(int(1, 500, { coerce: true })),
  kind: opt(oneOf(EVENT_KINDS)),
  severity: opt(oneOf(SEVERITIES)),
});

export const personalPrefsPatch: Schema<DeepPartial<Omit<PersonalPrefs, 'userId'>>> = patch({
  targetIds: arr(id(), { max: 20 }),
  levels: patch({ critical: lit(true), warning: bool(), event: bool(), report: bool() }),
  quietHours: bool(),
});

/* ── devices and Zigbee2MQTT ──────────────────────────────────────────────────────────────────── */

export const devicesQuery = obj({ filter: opt(str(40)), q: opt(str(100)) });

export const deviceMetaPatch: Schema<DeviceMetaPatch> = patch({ label: nullable(label(80)), ignored: bool(), batteryType: nullable(label(24)) });

export const deviceReplaceRequest: Schema<DeviceReplaceRequest> = obj({ oldEntityId: entityId(), newEntityId: entityId() });

const z2mShape = {
  name: name(40),
  baseTopic: str(120, { min: 1, pattern: /^[^#+\s]+$/ }),
  frontendUrl: nullable(str(300, { pattern: /^https?:\/\/\S+$/ })),
  bridgeEntityId: nullableEntity,
  resendOnRestart: bool(),
};
export const z2mCreateRequest = checked(patch(z2mShape), (v, add) => {
  if (v.name === undefined) add('name', 'required');
  if (v.baseTopic === undefined) add('baseTopic', 'required');
});
export const z2mPatch: Schema<Partial<Z2mInstanceCreateRequest>> = patch(z2mShape);
