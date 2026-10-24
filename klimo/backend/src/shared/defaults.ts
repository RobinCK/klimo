import type {
  ActivationRule,
  AdapterType,
  AggregationMethod,
  Circuit,
  ConditionMemory,
  ConditionNode,
  CoolStrategy,
  DayPlan,
  DeviceHealthSettings,
  Emitter,
  EmitterDevice,
  EnergyPolicy,
  EnergyTariffs,
  EpochMs,
  EventCatalogueEntry,
  EventKind,
  GeneralSettings,
  HeatStrategy,
  HouseSettings,
  IconName,
  Id,
  IncidentAction,
  Lang,
  Latch,
  Manifold,
  NotifySettings,
  NotifyTarget,
  PersonalPrefs,
  PlantMemory,
  PriorityKey,
  Profile,
  Pump,
  PumpMemory,
  RoomConfig,
  RoomDefaults,
  RoomMemory,
  RoomSensor,
  SafetySettings,
  Schedule,
  Season,
  SeasonConfig,
  SeasonMemory,
  SourceAdapter,
  SourceConfig,
  SourceKind,
  SourceMemory,
  SourceMeter,
  SourceScope,
  SourceTemplate,
  Trigger,
  TriggerRule,
  TrvCapabilities,
  TrvSiblings,
  TrvStrategy,
  WatchRule,
  Z2mInstance,
} from './model';
import { EVENT_KINDS, EVENT_SEVERITY, METER_KINDS, OUTDOOR_AGGREGATIONS, outdoorSensorIds, PRIORITY_DEFAULT } from './model';

/* =====================================================================================================
 * Every default of Klimo in one place: configuration defaults, the first-boot seed, source templates,
 * the notification event catalogue, the profile palette, add-room wizard choices and fresh control
 * memory. Stored rows are read through `withDefaults(stored, base)`, so a field added in a later
 * version needs no database default and old rows gain the new keys on read.
 * ===================================================================================================== */

/* ── deep merge ─────────────────────────────────────────────────────────────────────────────────── */

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

export function deepClone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

function mergeInto(stored: Record<string, unknown>, base: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, d] of Object.entries(base)) {
    const s = stored[k];
    if (s === undefined) out[k] = deepClone(d);
    else if (isPlainObject(s) && isPlainObject(d)) out[k] = mergeInto(s, d);
    else out[k] = deepClone(s);
  }
  // keys the base does not know (records, variant fields of unions) are kept as stored
  for (const [k, s] of Object.entries(stored)) if (!(k in base) && s !== undefined) out[k] = deepClone(s);
  return out;
}

/**
 * Deep merge of a stored value onto its defaults. Missing keys take the default; an explicit nested
 * `null` stays null (it is a value: "no limits", "no dehumidifier"); arrays are taken as stored. A
 * missing or NULL top-level value yields the whole default.
 */
export function withDefaults<T>(stored: unknown, base: T): T {
  if (stored === undefined || stored === null) return deepClone(base);
  if (isPlainObject(stored) && isPlainObject(base)) return mergeInto(stored, base) as T;
  return deepClone(stored) as T;
}

/** Deep merge of a PATCH body: nested objects merge, arrays and `atomic` keys replace, `null` replaces. */
export function mergePatch<T>(current: T, patch: unknown, atomic: ReadonlySet<string> = ATOMIC_KEYS): T {
  if (!isPlainObject(patch) || !isPlainObject(current)) return (patch === undefined ? current : deepClone(patch)) as T;
  const out: Record<string, unknown> = { ...(current as Record<string, unknown>) };
  for (const [k, p] of Object.entries(patch)) {
    if (p === undefined) continue;
    const c = out[k];
    out[k] = !atomic.has(k) && isPlainObject(p) && isPlainObject(c) ? mergePatch(c, p, atomic) : deepClone(p);
  }
  return out as T;
}

/** Keys whose values are tagged unions or trees: a patch replaces them whole, never merges. */
export const ATOMIC_KEYS: ReadonlySet<string> = new Set([
  'condition', 'when', 'stopWhen', 'activeWhen', 'node', 'confirm', 'watchdog', 'transport', 'config', 'plan',
  'value', 'previous', 'modeChangedBy', 'ref', 'by',
]);

/* ── engine tunables that are not part of a configuration record ──────────────────────────────────── */

export const ENGINE_DEFAULTS = {
  tickMs: 10_000,
  eventDebounceMs: 500,
  minSpacingMs: 1_000,
  nextWakeCapMs: 10_000,
  overrides: { boostDeltaC: 1, boostMin: 30, airingMin: 10, windowIgnoreMin: 30, undoSec: 30, profileUpdatedBadgeH: 8 },
  outdoor: { holdMin: 30, bivalenceMeanMin: 10 },
  learning: { defaultRateCPerH: 1.0, alpha: 0.2, trvOffsetTauH: 6, minJointMin: 30 },
  alerts: { tooColdDeltaC: 2, tooHotDeltaC: 2, forMin: 60, resolveC: 1, flapGuardSec: 120, reopenWindowMin: 10, noDataMin: 10 },
  energy: { shedHysteresisKw: 0.2, shedHoldSec: 30, emergencyFactor: 1.25 },
  sources: { faultRetryMin: 15, preRunSec: 20, relayWatchdogMin: 15, relayRearmMin: 5 },
  pumps: { runOnRadiatorsMin: 3, runOnFloorMin: 10, runOnCoolMin: 0, minOnSec: 60, dewRunOnMin: 2 },
  cooling: { supplyC: 18, maxSupplyC: 22 },
  trv: { calibrationStepC: 0.3, calibrationEveryMin: 10, keepAliveMin: 30 },
  ac: { assistDeficitC: 1.5, heatMinOutdoorC: -5, maxStepC: 1, stepEveryMin: 5, maxOffsetC: 3 },
  windows: { virtualDropC: 1.0, virtualWindowMin: 5, virtualHoldMin: 30 },
  humidity: { warnPct: 65, holdMin: 15, glassMarginC: 3, glassK: 0.35, dehumOnPct: 62, dehumOffPct: 57, dehumMinOnMin: 10 },
} as const;

/* ── singletons ───────────────────────────────────────────────────────────────────────────────── */

export const DEFAULT_ROOM_DEFAULTS: RoomDefaults = {
  tolerance: { heat: { below: 0.2, above: 0.2 }, cool: { below: 0.3, above: 0.3 } },
  minRequestMin: 5,
  staleAfterMin: 90,
  smoothingMin: 5,
  outlierC: 1.5,
  windowReaction: 'pause',
  windowOpenDelaySec: 60,
  windowResumeDelaySec: 120,
  windowRemindAfterMin: 20,
};

export function defaultSettings(lang: Lang = 'en'): GeneralSettings {
  return {
    houseName: lang === 'uk' ? 'Дім' : 'Home',
    outdoor: { sensorEntityIds: [], aggregation: 'median', weatherEntityId: null, staleAfterMin: 30, holdMin: 30 },
    units: 'auto',
    notificationLanguage: lang,
    uiLanguage: 'auto',
    defaultProfileId: 'home',
    ecoProfileId: 'eco',
    targetLimits: { heatMinC: 5, heatMaxC: 30, coolMinC: 16, coolMaxC: 32, stepC: 0.5 },
    haTargetChangeDuration: 'slot',
    adminOnlyConfig: true,
    mqttConfigEntities: false,
    glassCoefficient: 0.35,
    presence: {
      enabled: false,
      personEntityIds: [],
      homeZoneEntityId: 'zone.home',
      awayDelayMin: 15,
      proximityEntityId: null,
      approachKm: 3,
    },
    defaults: deepClone(DEFAULT_ROOM_DEFAULTS),
    tariffs: defaultTariffs(),
    z2mIgnoredTopics: [],
    onboardingDismissed: false,
    updatedAt: 0,
  };
}

/** Calorific value of natural gas, kWh per m³ (the usual billing value in Europe). */
export const DEFAULT_GAS_KWH_PER_M3 = 10.5;
/** Base of the heating degree-days on the consumption charts. */
export const HDD_BASE_C = 18;

export function defaultTariffs(): EnergyTariffs {
  return { currency: '', electricityPerKwh: null, gasPrice: null, gasPriceUnit: 'm³', gasKwhPerM3: DEFAULT_GAS_KWH_PER_M3 };
}

/**
 * Outdoor settings in the current shape. Databases and backups from before several outdoor sensors,
 * and a panel left open since then, name one `sensorEntityId`: it becomes the list unless a list is
 * given too. The old field is never written back.
 */
export function normalizeOutdoor(o: GeneralSettings['outdoor']): GeneralSettings['outdoor'] {
  const { sensorEntityId: _legacy, ...rest } = o;
  const ids = [...new Set(outdoorSensorIds(o))];
  const aggregation = (OUTDOOR_AGGREGATIONS as readonly string[]).includes(rest.aggregation) ? rest.aggregation : 'median';
  return { ...rest, sensorEntityIds: ids, aggregation };
}

export function defaultSafety(): SafetySettings {
  return {
    frostC: 7,
    frostReleaseC: 8,
    frostSupplyAlertC: 10,
    overheatC: 26,
    overheatReleaseC: 25.5,
    noDataTrvSetpointC: 17,
    sourceConfirmDefaultMin: 5,
    relayWatchdogMin: 15,
    relayRearmEveryMin: 5,
    reconcileOnRestart: true,
    haBlindAfterSec: 120,
    haDisconnectAlertMin: 10,
    startupDryRunSec: 20,
    trvHandbackOnStop: true,
    pumpExercise: { enabled: true, dow: 6, time: '10:00', durationSec: 60 },
    valveExercise: { enabled: true, dow: 6, time: '10:00', durationSec: 120, offSeasonOnly: true },
    commandRate: { globalPerSec: 5, burst: 10, zigbeeSpacingMs: 250, perEntityMinIntervalSec: 5 },
    conflict: { count: 2, windowMin: 30, backoffMin: 10 },
    updatedAt: 0,
  };
}

export function defaultHouse(): HouseSettings {
  return { mode: 'auto', modeChangedAt: 0, modeChangedBy: null, priority: [...PRIORITY_DEFAULT] as PriorityKey[] };
}

export function defaultHeatStrategy(): HeatStrategy {
  return {
    chain: [],
    bivalence: { mode: 'alt', pointC: -10, hysteresisC: 2, hpLimitC: -15 },
    lag: { enabled: true, deficitC: 1, forMin: 45, graceAfterStartMin: 30 },
    heatingCutoffOutdoorC: 15,
  };
}

export function defaultCoolStrategy(): CoolStrategy {
  return {
    chain: [],
    hpModeSelection: 'demand',
    dewMarginC: 2,
    changeoverMinH: 3,
    autoMinGapC: 2,
    dryInsteadOfCool: { enabled: true, abovePct: 60 },
    floorExcludeAbovePct: 65,
    solarPrecool: { enabled: true, leadMin: 30 },
    singleRoomCentralStart: false,
  };
}

const months = (on: number[]): boolean[] => Array.from({ length: 12 }, (_, i) => on.includes(i + 1));

export function defaultSeason(): SeasonConfig {
  return {
    avgDays: 3,
    heatBelowC: 15,
    coolAboveC: 22,
    hysteresisC: 1,
    minDwellH: 24,
    confirmH: 6,
    heatingMonths: months([1, 2, 3, 4, 5, 9, 10, 11, 12]),
    coolingMonths: months([5, 6, 7, 8, 9]),
    neutralColdGuardC: 1.0,
  };
}

export function defaultEnergy(): EnergyPolicy {
  return {
    budgetKw: 4.0,
    inverterMaxKw: null,
    staggerSec: 30,
    shedOrder: [],
    shedOrderCustom: false,
    exempt: { sourceIds: [], pumps: true, whileSocAbovePct: 20 },
    criticalSocPct: 20,
    entities: { gridOffline: null, pvPower: null, houseLoad: null, batterySoc: null, tariff: null },
    activeWhen: { op: 'trigger', triggerId: 'blackout', id: 'energy_blackout' },
  };
}

export function defaultNotifySettings(): NotifySettings {
  return {
    telegram: { mode: 'own', haService: null, botUsername: null },
    criticalBypassDnd: true,
    quietHours: { enabled: true, from: '23:00', to: '07:00', digest: true },
    grouping: { enabled: true, windowMin: 2 },
    repeatCritical: { enabled: true, everyMin: 30, maxTimes: 6 },
    escalation: { enabled: true, afterMin: 10, targetId: null },
    recoveryMessages: true,
    watchAllUsedEntities: true,
    reports: { daily: { time: '21:00' }, weekly: { dow: 6, time: '20:00' } },
    actionTtlH: 24,
    updatedAt: 0,
  };
}

export function defaultDeviceHealth(): DeviceHealthSettings {
  return {
    batteryLow: { enabled: true, pct: 20, reminderPct: 5 },
    offline: { enabled: true, batteryMin: 90, contactMin: 120, mainsMin: 10, integrationMin: 3 },
    trvUnconfirmed: { enabled: true, attempts: 3, ackTimeoutSec: 120 },
    weakSignal: { enabled: true, lqiBelow: 60, clearAt: 65, windowH: 6, minSamples: 3 },
    updatedAt: 0,
  };
}

/* ── rooms ────────────────────────────────────────────────────────────────────────────────────── */

/** Aggregation method chosen by the number of temperature sensors at creation (≥ 3 / 2 / 1). */
export function methodForSensorCount(n: number): AggregationMethod {
  if (n >= 3) return 'median';
  if (n === 2) return 'average';
  return n === 1 ? 'primary' : 'median';
}

/** A complete room with every default; identity fields are blank for the caller to fill. */
export function DEFAULT_ROOM(defaults: RoomDefaults = DEFAULT_ROOM_DEFAULTS, temperatureSensors = 0): RoomConfig {
  const d = withDefaults(defaults, DEFAULT_ROOM_DEFAULTS);
  return {
    id: '',
    slug: '',
    name: '',
    order: 0,
    icon: null,
    haAreaId: null,
    controlEnabled: true,
    tolerance: deepClone(d.tolerance),
    demand: { policy: 'call', minRequestMin: d.minRequestMin },
    limits: null,
    temperature: {
      method: methodForSensorCount(temperatureSensors),
      outlier: { enabled: true, thresholdC: d.outlierC },
      staleAfterMin: d.staleAfterMin,
      smoothingMin: d.smoothingMin,
      fallbackToTrvSensors: true,
    },
    humidity: {
      method: 'average',
      comfortPct: [40, 60],
      warnAbovePct: 65,
      warnForMin: 15,
      dewGlassMarginC: 3,
      dehumidifier: null,
      airingHint: 'notify',
    },
    windows: {
      reaction: d.windowReaction,
      lowerByC: 3,
      openDelaySec: d.windowOpenDelaySec,
      resumeDelaySec: d.windowResumeDelaySec,
      remindAfterMin: d.windowRemindAfterMin,
      notifyAfterMin: 10,
      tempDrop: { enabled: true, dropC: 1.0, windowMin: 5, holdMaxMin: 30 },
      disableTrvBuiltinDetection: true,
    },
    trv: {
      strategy: 'external',
      manualPolicy: 'slot',
      revertAfterSec: 60,
      onoffSetpoints: { openC: 30, closedC: 5 },
      valvePi: { kp: 30, tiMin: 30, minPct: 0, maxPct: 100, minStepPct: 5, everyMin: 5 },
      childLock: true,
      batterySaver: { enabled: true, minIntervalMin: 5, minDeltaC: 0.2, keepAliveMin: 30 },
      ack: { timeoutSec: 120, attempts: 3, backgroundRetryMin: 15, notifyOnFail: true },
      resendOnBridgeRestart: true,
      releaseSetpointC: 20,
    },
    ac: {
      control: 'target',
      onoffSetpoints: { heatC: 24, coolC: 22 },
      quietNight: { enabled: true, from: '23:00', to: '07:00', fanMode: null },
      dry: { enabled: true, abovePct: 60 },
      correction: { maxOffsetC: 3, maxStepC: 1, everyMin: 5 },
    },
    smart: {
      optimalStart: { enabled: true, maxLeadMin: 180 },
      overheat: { enabled: true },
      valveExercise: { enabled: true },
      weatherComp: { enabled: false, perFrostC: 5, shiftC: 0.1 },
      solarGain: { enabled: false, leadMin: 30 },
    },
    quick: { boostDeltaC: 1, boostMin: 30, airingMin: 10 },
    floor: { maxFloorC: 27, minFloorC: null },
    frostC: null,
    sunnySide: false,
    notify: { sensorStale: true, trvFailed: true, batteryLow: true, humidity: true, windowLeftOpen: true, tooCold: true, tooHot: false },
    createdAt: 0,
    updatedAt: 0,
  };
}

export function DEFAULT_SENSOR(): RoomSensor {
  return {
    id: '',
    roomId: '',
    entityId: '',
    role: 'temperature',
    contactKind: null,
    name: '',
    model: null,
    haDeviceId: null,
    weight: 1.0,
    included: true,
    excludedBy: null,
    order: 0,
  };
}

export function DEFAULT_EMITTER(): Emitter {
  return {
    id: '',
    roomId: '',
    kind: 'radiator',
    name: '',
    order: 0,
    enabled: true,
    circuitId: null,
    sourceId: null,
    roles: { heat: null, cool: null },
    assist: null,
    trigger: null,
    excludeFromCooling: false,
    ignoreSeason: false,
  };
}

export const DEFAULT_TRV_CAPABILITIES: TrvCapabilities = {
  externalSensor: false,
  calibration: false,
  calibrationRange: null,
  valveLimits: false,
  valvePosition: false,
  childLock: false,
  windowDetection: false,
  setpointRange: [5, 30],
  setpointStep: 0.5,
};

export const DEFAULT_TRV_SIBLINGS: TrvSiblings = {
  externalTemp: null,
  sensorSelect: null,
  calibration: null,
  valveOpening: null,
  valveClosing: null,
  childLock: null,
  windowDetection: null,
  battery: null,
  linkquality: null,
  valvePosition: null,
};

export function DEFAULT_EMITTER_DEVICE(): EmitterDevice {
  return {
    id: '',
    emitterId: '',
    roomId: '',
    kind: 'trv',
    entityId: '',
    name: '',
    label: null,
    haDeviceId: null,
    model: null,
    manufacturer: null,
    transport: { type: 'ha', integration: null, network: null },
    capabilities: null,
    siblings: null,
    order: 0,
  };
}

/** TRV strategy picked by what ALL of the room's heads support: external > calibration > onoff. */
export function trvStrategyFor(capabilities: readonly (TrvCapabilities | null)[]): TrvStrategy {
  const caps = capabilities.map((c) => c ?? DEFAULT_TRV_CAPABILITIES);
  if (caps.length && caps.every((c) => c.externalSensor)) return 'external';
  if (caps.length && caps.every((c) => c.calibration)) return 'calibration';
  return 'onoff';
}

/** Add-room wizard choices (what each «Чим гріти» option creates). */
export const WIZARD_DEFAULTS = {
  trv: { emitterKind: 'radiator', roles: { heat: 'primary', cool: null } },
  floor: { emitterKind: 'floor', roles: { heat: 'primary', cool: 'primary' }, maxFloorC: 27 },
  ac: { emitterKind: 'direct', roles: { heat: 'assist', cool: 'primary' }, assistDeficitC: 1.5, sourceKind: 'ac' },
  local: { emitterKind: 'direct', roles: { heat: 'primary', cool: null }, sourceKind: 'electric_radiator' },
  window: { reaction: 'pause' },
  storeAboveTargetC: 1.5,
} as const;

/** The roles of a room source's own emitter: an AC tops up a room that has other heating, otherwise it is the room's heating. */
export function roomSourceRoles(s: Pick<SourceConfig, 'kind' | 'capabilities'>, heatElsewhere: boolean): Emitter['roles'] {
  return {
    heat: s.capabilities.heat ? (s.kind === 'ac' && heatElsewhere ? WIZARD_DEFAULTS.ac.roles.heat : 'primary') : null,
    cool: s.capabilities.cool ? 'primary' : null,
  };
}

/* ── hydronics ────────────────────────────────────────────────────────────────────────────────── */

export function DEFAULT_MANIFOLD(): Manifold {
  return { id: '', name: '', supplySensorEntityId: null, returnSensorEntityId: null, sourceIds: [], order: 0 };
}

export function DEFAULT_CIRCUIT(): Circuit {
  return {
    id: '',
    name: '',
    shortName: '',
    kind: 'radiators',
    manifoldId: null,
    sourceIds: [],
    capabilities: { heat: true, cool: false },
    supply: { sensorEntityId: null, returnEntityId: null, coolC: 18, coolMaxC: 22 },
    mixingValve: null,
    dewMarginC: null,
    pumpGroupMode: 'all',
    flowSafety: false,
    mode: 'zoned',
    bypass: false,
    order: 0,
  };
}

/** Floor loops follow their source with a long run-on (screed stores heat); radiators follow the rooms. */
export function circuitModeDefaults(kind: Circuit['kind']): { mode: Circuit['mode']; runOnHeatMin: number } {
  return kind === 'floor' ? { mode: 'follow_source', runOnHeatMin: 10 } : { mode: 'zoned', runOnHeatMin: 3 };
}

/** The pump rule that says the same as a circuit mode (older readers of `Pump.rule`). */
export function pumpRuleFor(mode: Circuit['mode']): Pump['rule'] {
  return mode === 'follow_source' ? 'source' : 'rooms';
}

export function DEFAULT_PUMP(): Pump {
  return {
    id: '',
    name: '',
    circuitId: null,
    manifoldId: null,
    entityId: '',
    rule: 'rooms',
    runOnHeatMin: 3,
    runOnCoolMin: 0,
    minOnSec: 60,
    exercise: true,
    speed: null,
    meter: null,
    enabled: true,
    order: 0,
  };
}

/* ── sources ──────────────────────────────────────────────────────────────────────────────────── */

export function adapterDefaults(type: AdapterType): SourceAdapter {
  switch (type) {
    case 'relay':
      return { type, command: null, invert: false, stages: [], confirm: { kind: 'readback' }, watchdog: { kind: 'none' }, flowSetpoint: null };
    case 'climate':
      return {
        type,
        climate: null,
        modeMap: { off: 'off' },
        setpoint: 'room_target',
        fixedSetpoint: null,
        quietFanMode: null,
        confirm: { kind: 'hvac_action' },
        defrostEntityId: null,
        errorEntityId: null,
        errorOkValues: ['0', 'ok', 'none', ''],
        copEntityId: null,
        supplyTempEntityId: null,
      };
    case 'flow':
      return { type, enable: null, flowSetpoint: null, actualFlow: null, modeSelect: null, confirm: { kind: 'readback' } };
    case 'script':
      return { type, on: {}, off: null, confirm: { kind: 'none' } };
    case 'custom':
      return { type, on: {}, off: [], setpoint: null, confirm: { kind: 'none' } };
  }
}

type SourceDefaults = SourceTemplate['defaults'];

const guards = (minRunMin: number, minOffMin: number, maxStartsPerHour: number | null, startConfirmTimeoutMin: number, unavailableAfterMin: number, extra: Partial<SourceDefaults['guards']> = {}): SourceDefaults['guards'] => ({
  minRunMin,
  minOffMin,
  maxStartsPerHour,
  startConfirmTimeoutMin,
  unavailableAfterMin,
  faultRetryMin: 15,
  defrostIsNotFault: false,
  roomMaxC: null,
  stageUpAfterMin: 10,
  changeoverMinH: null,
  ...extra,
});

const electric = (maxPowerKw: number, nightTariffEligible = false): SourceDefaults['energy'] => ({
  carrier: 'electric',
  maxPowerKw,
  auxPowerKw: 0,
  powerEntityId: null,
  countsInBlackoutBudget: true,
  nightTariffEligible,
  minBatteryPct: null,
  staggerSec: null,
});

const caps = (heat: boolean, cool = false, dry = false, fan = false) => ({ heat, cool, dry, fan });
const HYDRONIC = { requiresFlow: true, preRunSec: 20 };
const NO_CONDITIONS = (): SourceDefaults['conditions'] => ({ join: 'all', items: [] });
const SEASONAL = (): SourceDefaults['seasonPolicy'] => ({ heat: 'season', cool: 'season' });

function relay(confirm: Extract<SourceAdapter, { type: 'relay' }>['confirm']): SourceAdapter {
  return { ...(adapterDefaults('relay') as Extract<SourceAdapter, { type: 'relay' }>), confirm };
}

function climate(modeMap: Extract<SourceAdapter, { type: 'climate' }>['modeMap'], setpoint: Extract<SourceAdapter, { type: 'climate' }>['setpoint']): SourceAdapter {
  return { ...(adapterDefaults('climate') as Extract<SourceAdapter, { type: 'climate' }>), modeMap, setpoint };
}

function template(kind: SourceKind, scope: SourceScope, icon: IconName, defaults: SourceDefaults): SourceTemplate {
  return {
    kind,
    scope,
    icon,
    defaultAdapter: defaults.adapter.type,
    canCode: `source.can.${kind}`,
    howCode: `source.how.${kind}`,
    hintCode: `source.hint.${kind}`,
    defaults,
  };
}

const base = (kind: SourceKind, scope: SourceScope, rest: Omit<SourceDefaults, 'kind' | 'scope' | 'subtype' | 'enabled' | 'conditions' | 'seasonPolicy' | 'meters'>): SourceDefaults => ({
  kind,
  subtype: '',
  scope,
  enabled: false,
  conditions: NO_CONDITIONS(),
  seasonPolicy: SEASONAL(),
  meters: [],
  ...rest,
});

/**
 * One template per source kind. A template only pre-fills a new source; binding (the add-source wizard)
 * upgrades confirmations when sibling entities exist (gas flame sensor → `entity_on`, a power meter →
 * `power_above`, a relay countdown → watchdog + `failsafe.onStop = 'leave'`).
 */
export const SOURCE_TEMPLATES: readonly SourceTemplate[] = [
  template('gas_boiler', 'central', 'boiler', base('gas_boiler', 'central', {
    capabilities: caps(true),
    energy: { carrier: 'gas', maxPowerKw: 24, auxPowerKw: 0.1, powerEntityId: null, countsInBlackoutBudget: false, nightTariffEligible: false, minBatteryPct: 20, staggerSec: null },
    adapter: relay({ kind: 'readback' }),
    curves: { heat: null, cool: null },
    outdoorLimits: { heat: null, cool: null },
    guards: guards(5, 5, 6, 3, 1),
    failsafe: { onStop: 'off', handback: null },
    hydronic: { ...HYDRONIC },
  })),
  template('electric_boiler', 'central', 'electricBoiler', base('electric_boiler', 'central', {
    capabilities: caps(true),
    energy: electric(3, true),
    adapter: relay({ kind: 'power_above', entityId: '', thresholdW: 50 }),
    curves: { heat: null, cool: null },
    outdoorLimits: { heat: null, cool: null },
    guards: guards(3, 3, 10, 2, 1, { stageUpAfterMin: 10 }),
    failsafe: { onStop: 'off', handback: null },
    hydronic: { ...HYDRONIC },
  })),
  template('heat_pump', 'central', 'heatPump', base('heat_pump', 'central', {
    capabilities: caps(true, true),
    energy: electric(3, true),
    adapter: climate({ heat: 'heat', cool: 'cool', off: 'off' }, 'flow_curve'),
    curves: {
      heat: { points: [{ outdoorC: -20, flowC: 52 }, { outdoorC: -10, flowC: 45 }, { outdoorC: 0, flowC: 40 }, { outdoorC: 15, flowC: 32 }], shiftC: 0, minFlowC: 25, maxFlowC: 55 },
      cool: { flowC: 18, maxFlowC: 22 },
    },
    outdoorLimits: { heat: null, cool: null },
    guards: guards(10, 5, null, 5, 3, { defrostIsNotFault: true }),
    failsafe: { onStop: 'leave', handback: null },
    hydronic: { ...HYDRONIC },
  })),
  template('ac', 'room', 'ac', base('ac', 'room', {
    capabilities: caps(true, true, true, true),
    energy: electric(0.8),
    adapter: climate({ heat: 'heat', cool: 'cool', dry: 'dry', fan: 'fan_only', off: 'off' }, 'room_target'),
    curves: { heat: null, cool: null },
    outdoorLimits: { heat: { minC: -5, maxC: null, hysteresisC: 1 }, cool: null },
    guards: guards(5, 3, null, 2, 10),
    failsafe: { onStop: 'leave', handback: null },
    hydronic: null,
  })),
  template('electric_radiator', 'room', 'convector', base('electric_radiator', 'room', {
    capabilities: caps(true),
    energy: electric(1.5),
    adapter: relay({ kind: 'readback' }),
    curves: { heat: null, cool: null },
    outdoorLimits: { heat: null, cool: null },
    guards: guards(2, 2, null, 1, 1, { roomMaxC: 26 }),
    failsafe: { onStop: 'off', handback: null },
    hydronic: null,
  })),
  template('electric_floor', 'room', 'floor', base('electric_floor', 'room', {
    capabilities: caps(true),
    energy: electric(1.0),
    adapter: relay({ kind: 'readback' }),
    curves: { heat: null, cool: null },
    outdoorLimits: { heat: null, cool: null },
    guards: guards(5, 5, null, 2, 1, { roomMaxC: 26 }),
    failsafe: { onStop: 'off', handback: null },
    hydronic: null,
  })),
  template('ir_panel', 'room', 'sun', base('ir_panel', 'room', {
    capabilities: caps(true),
    energy: electric(0.8),
    adapter: relay({ kind: 'readback' }),
    curves: { heat: null, cool: null },
    outdoorLimits: { heat: null, cool: null },
    guards: guards(2, 2, null, 1, 1, { roomMaxC: 26 }),
    failsafe: { onStop: 'off', handback: null },
    hydronic: null,
  })),
  template('custom', 'central', 'anyEntity', base('custom', 'central', {
    capabilities: caps(true),
    energy: { carrier: 'other', maxPowerKw: 0, auxPowerKw: 0, powerEntityId: null, countsInBlackoutBudget: false, nightTariffEligible: false, minBatteryPct: null, staggerSec: null },
    adapter: { ...(adapterDefaults('custom') as Extract<SourceAdapter, { type: 'custom' }>), confirm: { kind: 'state_in', entityId: '', values: ['on'] } },
    curves: { heat: null, cool: null },
    outdoorLimits: { heat: null, cool: null },
    guards: guards(5, 5, null, 5, 3),
    failsafe: { onStop: 'off', handback: null },
    hydronic: null,
  })),
];

export function sourceTemplate(kind: SourceKind): SourceTemplate {
  return SOURCE_TEMPLATES.find((t) => t.kind === kind) ?? SOURCE_TEMPLATES[SOURCE_TEMPLATES.length - 1];
}

/** A new (disabled) source from its template; an adapter type other than the template's starts empty. */
export function newSourceConfig(
  kind: SourceKind,
  opts: { id: Id; name: string; now: EpochMs; scope?: SourceScope; roomId?: Id | null; adapterType?: AdapterType; order?: number },
): SourceConfig {
  const t = sourceTemplate(kind);
  const d = deepClone(t.defaults);
  const scope = opts.scope ?? t.scope;
  const adapter = opts.adapterType && opts.adapterType !== d.adapter.type ? adapterDefaults(opts.adapterType) : d.adapter;
  return {
    ...d,
    id: opts.id,
    name: opts.name,
    kind,
    scope,
    roomId: scope === 'room' ? opts.roomId ?? null : null,
    order: opts.order ?? 0,
    enabled: false,
    adapter,
    linkedTo: null,
    ownFields: [],
    createdAt: opts.now,
    updatedAt: opts.now,
  };
}

/** Merge base for a stored source row: the kind's template with an empty adapter of the stored type. */
export function sourceMergeBase(kind: SourceKind, adapterType: AdapterType | undefined): SourceConfig {
  const t = sourceTemplate(kind);
  const s = newSourceConfig(kind, { id: '', name: '', now: 0 });
  return { ...s, scope: t.scope, adapter: adapterDefaults(adapterType ?? t.defaults.adapter.type), curves: { heat: null, cool: null }, outdoorLimits: { heat: null, cool: null }, hydronic: null };
}

/**
 * The meters of a stored or imported source. A source saved before meters existed has no list: the
 * power sensor it had becomes its electricity meter, so its consumption shows without binding it
 * again. Malformed entries and a second meter of one kind are dropped.
 */
export function storedMeters(stored: unknown, energy: Pick<SourceConfig['energy'], 'powerEntityId'>): SourceMeter[] {
  if (!Array.isArray(stored)) {
    return energy.powerEntityId ? [{ kind: 'electricity', entityId: energy.powerEntityId, unit: null }] : [];
  }

  const kinds = new Set<string>();
  const out: SourceMeter[] = [];
  for (const m of stored) {
    if (!isPlainObject(m) || typeof m.entityId !== 'string' || !m.entityId) {
      continue;
    }

    const kind = METER_KINDS.find((k) => k === m.kind);
    if (!kind || kinds.has(kind)) {
      continue;
    }

    kinds.add(kind);
    out.push({ kind, entityId: m.entityId, unit: typeof m.unit === 'string' && m.unit.trim() ? m.unit : null });
  }

  return out;
}

/* ── profiles ─────────────────────────────────────────────────────────────────────────────────── */

/** 12 colour/ink pairs; ink is the foreground on the colour (≥ 4.5:1). */
export const PROFILE_PALETTE: readonly { color: string; ink: string }[] = [
  { color: '#9B87F5', ink: '#140F2E' },
  { color: '#7D8896', ink: '#0E1013' },
  { color: '#57C48B', ink: '#062012' },
  { color: '#4F5FD6', ink: '#FFFFFF' },
  { color: '#E87AB4', ink: '#2A0718' },
  { color: '#C9B56E', ink: '#231D05' },
  { color: '#3BB6B0', ink: '#04201F' },
  { color: '#F07C5A', ink: '#2A0B04' },
  { color: '#A6C94A', ink: '#172003' },
  { color: '#5AA9E6', ink: '#04172A' },
  { color: '#B57EDC', ink: '#1E0B2A' },
  { color: '#A39E93', ink: '#16140F' },
];

export const PROFILE_ICONS: readonly IconName[] = ['home', 'away', 'leaf', 'moon', 'users', 'suitcase', 'sun', 'sparkle', 'calendar', 'bolt'];

function luminance(hex: string): number {
  const v = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * v(1) + 0.7152 * v(3) + 0.0722 * v(5);
}

/** Foreground for a profile colour: the palette's ink, else white or near-black by contrast. */
export function autoInk(color: string): string {
  const hit = PROFILE_PALETTE.find((p) => p.color.toLowerCase() === color.toLowerCase());
  if (hit) return hit.ink;
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) return '#FFFFFF';
  const l = luminance(color);
  const onWhite = 1.05 / (l + 0.05);
  const onDark = (l + 0.05) / (luminance('#0E1013') + 0.05);
  return onWhite >= onDark ? '#FFFFFF' : '#0E1013';
}

/** «Новий профіль» takes the next unused palette colour and icon (cycling when all are taken). */
export function nextProfileLook(existing: readonly Pick<Profile, 'color' | 'icon'>[]): { color: string; ink: string; icon: IconName } {
  const used = new Set(existing.map((p) => p.color.toLowerCase()));
  const pal = PROFILE_PALETTE.find((p) => !used.has(p.color.toLowerCase())) ?? PROFILE_PALETTE[existing.length % PROFILE_PALETTE.length];
  const icons = new Set(existing.map((p) => p.icon));
  const icon = PROFILE_ICONS.find((i) => !icons.has(i)) ?? PROFILE_ICONS[existing.length % PROFILE_ICONS.length];
  return { color: pal.color, ink: pal.ink, icon };
}

/* ── triggers, rules, conditions ──────────────────────────────────────────────────────────────── */

/** «Мороз» follows the bivalent point: on below P (10-min mean), off again at P + H. */
export function frostCondition(bivalence: HeatStrategy['bivalence']): ConditionNode {
  return { op: 'outdoor', basis: 'avg10m', cmp: '<', value: bivalence.pointC, exitAt: bivalence.pointC + bivalence.hysteresisC, id: 'frost_outdoor' };
}

export function DEFAULT_TRIGGER(): Trigger {
  return {
    id: '',
    name: '',
    icon: 'bolt',
    kind: 'entity_state',
    condition: { op: 'const', value: false },
    enabled: true,
    system: null,
    whenUnknown: 'false',
    holdMaxMin: 30,
    notifyOnActivate: false,
    order: 0,
  };
}

export function DEFAULT_RULE(): TriggerRule {
  return { id: '', name: '', enabled: true, priority: 50, when: { op: 'const', value: false }, stopWhen: null, effects: [], notifyOnActivate: false };
}

/* ── notifications ────────────────────────────────────────────────────────────────────────────── */

type Route = EventCatalogueEntry['defaultRoute'];
const route = (P: 0 | 1, O: 0 | 1, M: 0 | 1, F: 0 | 1, H: 0 | 1, E: 0 | 1): Route => ({ P: !!P, O: !!O, M: !!M, F: !!F, H: !!H, E: !!E });

interface CatalogueRow {
  route: Route;
  locked: boolean;
  params: Record<string, number | string | boolean>;
  actions: IncidentAction[];
}

const OPEN_ACK: IncidentAction[] = ['ack', 'open'];

/**
 * Default routing (P primary phone, O other phones, M Telegram personal, F family/escalation, H HA panel, E event).
 * `room_no_data`, `room_too_cold` and `room_too_hot` carry no wait of their own: the engine raises them only
 * after its own 10 / 60 minutes, and a second wait here would double the delay before anyone hears of it.
 */
const CATALOGUE: Record<EventKind, CatalogueRow> = {
  source_failed: { route: route(1, 1, 1, 1, 1, 1), locked: true, params: { openAfterSec: 0 }, actions: OPEN_ACK },
  source_unavailable: { route: route(1, 1, 1, 1, 1, 1), locked: true, params: { openAfterSec: 0, resolveAfterSec: 60 }, actions: OPEN_ACK },
  frost_risk: { route: route(1, 1, 1, 1, 1, 1), locked: true, params: { openAfterSec: 0 }, actions: OPEN_ACK },
  z2m_offline: { route: route(1, 1, 1, 0, 1, 1), locked: true, params: { openAfterSec: 0, forMin: 1 }, actions: OPEN_ACK },
  room_no_data: { route: route(1, 0, 1, 0, 1, 1), locked: true, params: { openAfterSec: 0, criticalBelowOutdoorC: 10 }, actions: OPEN_ACK },
  ha_disconnected: { route: route(0, 0, 1, 1, 0, 0), locked: false, params: {}, actions: [] },
  energy_critical: { route: route(1, 1, 1, 1, 1, 1), locked: true, params: { openAfterSec: 0, resolveSocPct: 25 }, actions: OPEN_ACK },
  sensor_offline: { route: route(1, 0, 1, 0, 1, 1), locked: false, params: { openAfterSec: 0 }, actions: ['snooze_until_morning', 'exclude_sensor', 'open'] },
  trv_not_confirmed: { route: route(1, 0, 1, 0, 1, 1), locked: false, params: { openAfterSec: 0 }, actions: ['retry_trv', 'open'] },
  battery_low: { route: route(0, 0, 1, 0, 1, 1), locked: false, params: { openAfterSec: 0, resolvePct: 25 }, actions: ['snooze', 'dismiss', 'open'] },
  window_open_long: { route: route(1, 0, 0, 0, 0, 1), locked: false, params: { openAfterSec: 0 }, actions: ['ignore_window', 'snooze', 'open'] },
  humidity_high: { route: route(0, 0, 1, 0, 1, 1), locked: false, params: { openAfterSec: 0, moldHours: 6, cooldownH: 6, resolvePct: 62 }, actions: ['airing', 'snooze_until_morning', 'open'] },
  condensation_risk: { route: route(0, 0, 1, 0, 1, 1), locked: false, params: { openAfterSec: 0, resolveMarginC: 3.5 }, actions: ['airing', 'snooze_until_morning'] },
  dew_point_guard: { route: route(0, 0, 1, 0, 1, 1), locked: false, params: { openAfterSec: 0 }, actions: ['open'] },
  signal_weak: { route: route(0, 0, 0, 0, 1, 0), locked: false, params: { openAfterSec: 0 }, actions: ['snooze', 'dismiss', 'open'] },
  entity_unavailable: { route: route(1, 0, 1, 0, 1, 1), locked: false, params: { openAfterSec: 0, forMin: 5, pumpForMin: 10 }, actions: ['open'] },
  entity_missing: { route: route(1, 0, 1, 0, 1, 1), locked: false, params: { openAfterSec: 0, forMin: 5 }, actions: ['open'] },
  overheat: { route: route(0, 0, 1, 0, 1, 1), locked: false, params: { openAfterSec: 0 }, actions: ['open'] },
  relay_mismatch: { route: route(1, 0, 1, 0, 1, 1), locked: false, params: { openAfterSec: 0, attempts: 3, resolveMin: 10 }, actions: ['open'] },
  actuator_conflict: { route: route(1, 0, 1, 0, 1, 1), locked: false, params: { openAfterSec: 0, resolveMin: 30 }, actions: ['open'] },
  room_too_cold: { route: route(1, 0, 1, 0, 1, 1), locked: false, params: { openAfterSec: 0, deltaC: 2, resolveC: 1 }, actions: ['open'] },
  room_too_hot: { route: route(0, 0, 1, 0, 1, 1), locked: false, params: { openAfterSec: 0, deltaC: 2, resolveC: 1 }, actions: ['open'] },
  mqtt_offline: { route: route(0, 0, 1, 0, 1, 0), locked: false, params: { openAfterSec: 0, forMin: 5 }, actions: [] },
  channel_failed: { route: route(1, 0, 0, 0, 1, 0), locked: false, params: { openAfterSec: 0, failures: 3 }, actions: ['open'] },
  source_fallback: { route: route(1, 0, 1, 0, 0, 1), locked: false, params: {}, actions: ['open'] },
  // recovery goes to whoever got the original alert (the router resolves it), not by the matrix
  source_recovered: { route: route(0, 0, 0, 0, 0, 0), locked: false, params: {}, actions: [] },
  trigger_fired: { route: route(0, 0, 1, 0, 0, 1), locked: false, params: {}, actions: [] },
  rule_activated: { route: route(0, 0, 1, 0, 0, 1), locked: false, params: {}, actions: [] },
  house_profile_changed: { route: route(0, 0, 0, 0, 0, 1), locked: false, params: {}, actions: [] },
  house_mode_changed: { route: route(0, 0, 0, 0, 0, 1), locked: false, params: {}, actions: [] },
  season_changed: { route: route(0, 0, 1, 0, 0, 1), locked: false, params: {}, actions: [] },
  manual_override: { route: route(0, 0, 0, 0, 0, 1), locked: false, params: {}, actions: ['resume_schedule'] },
  budget_shed: { route: route(0, 0, 1, 0, 0, 1), locked: false, params: {}, actions: [] },
  report_daily: { route: route(0, 0, 1, 0, 0, 0), locked: false, params: {}, actions: [] },
  report_weekly: { route: route(0, 0, 1, 0, 0, 0), locked: false, params: {}, actions: [] },
};

export const EVENT_CATALOGUE: readonly EventCatalogueEntry[] = EVENT_KINDS.map((kind, order) => ({
  kind,
  severity: EVENT_SEVERITY[kind],
  order,
  defaultRoute: { ...CATALOGUE[kind].route },
  lockedOnPrimary: CATALOGUE[kind].locked,
  defaultParams: { ...CATALOGUE[kind].params },
  actions: [...CATALOGUE[kind].actions],
}));

export function catalogueEntry(kind: EventKind): EventCatalogueEntry {
  const e = EVENT_CATALOGUE.find((c) => c.kind === kind);
  if (!e) throw new Error(`unknown event kind ${kind}`);
  return e;
}

export type TargetPreset = keyof Route;

/** Which default column a target takes in the routing matrix. */
export function targetPreset(t: Pick<NotifyTarget, 'channel' | 'isPrimary' | 'isEscalation'>): TargetPreset {
  if (t.isPrimary) return 'P';
  switch (t.channel) {
    case 'ha_mobile':
    case 'ha_notify':
      return 'O';
    case 'telegram':
      return t.isEscalation ? 'F' : 'M';
    case 'ha_persistent':
      return 'H';
    case 'ha_event':
      return 'E';
  }
}

/**
 * Locked matrix cells: critical kinds always reach the primary target; `ha_disconnected` (HA is down,
 * only the own Telegram bot can talk) is locked on for personal Telegram chats.
 */
export function isLockedCell(kind: EventKind, t: Pick<NotifyTarget, 'channel' | 'isPrimary' | 'isEscalation'>): boolean {
  if (kind === 'ha_disconnected') return t.channel === 'telegram' && !t.isEscalation;
  return t.isPrimary && catalogueEntry(kind).lockedOnPrimary;
}

export function defaultRouteOn(kind: EventKind, t: Pick<NotifyTarget, 'channel' | 'isPrimary' | 'isEscalation'>): boolean {
  if (isLockedCell(kind, t)) return true;
  if (kind === 'ha_disconnected' && t.channel !== 'telegram') return false;
  return catalogueEntry(kind).defaultRoute[targetPreset(t)];
}

export function DEFAULT_TARGET(): NotifyTarget {
  return {
    id: '',
    channel: 'ha_mobile',
    name: '',
    shortName: null,
    icon: 'phone',
    enabled: true,
    order: 0,
    service: null,
    chatId: null,
    chatTitle: null,
    isPrimary: false,
    isEscalation: false,
    ownerUserId: null,
  };
}

export function defaultPersonalPrefs(userId: string, targetIds: Id[] = []): PersonalPrefs {
  return { userId, targetIds, levels: { critical: true, warning: true, event: true, report: true }, quietHours: true };
}

export function DEFAULT_WATCH_RULE(): WatchRule {
  return {
    id: '',
    origin: 'manual',
    entityId: '',
    name: '',
    role: 'manual',
    ref: null,
    condition: { type: 'unavailable', forMin: 5 },
    severity: 'warning',
    eventKind: 'entity_unavailable',
    muted: false,
  };
}

export function DEFAULT_Z2M(): Z2mInstance {
  return { id: '', name: '', baseTopic: 'zigbee2mqtt', frontendUrl: null, bridgeEntityId: null, resendOnRestart: true };
}

export function DEFAULT_ACTIVATION_RULE(): ActivationRule {
  return { id: '', profileId: 'home', enabled: false, order: 0, config: { type: 'presence', trigger: 'someone_home', optimalStart: false } };
}

export function DEFAULT_SCHEDULE(): Schedule {
  return { id: '', scope: 'room', roomId: null, enabled: true, days: [], updatedAt: 0 };
}

/* ── everything above as one read-only lookup (merge bases: `withDefaults(stored, DEFAULTS.room)`) ── */

function freeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) freeze(v);
  }
  return o;
}

export const DEFAULTS = freeze({
  settings: defaultSettings(),
  safety: defaultSafety(),
  house: defaultHouse(),
  heat: defaultHeatStrategy(),
  cool: defaultCoolStrategy(),
  season: defaultSeason(),
  energy: defaultEnergy(),
  notify: defaultNotifySettings(),
  deviceHealth: defaultDeviceHealth(),
  roomDefaults: deepClone(DEFAULT_ROOM_DEFAULTS),
  room: DEFAULT_ROOM(),
  sensor: DEFAULT_SENSOR(),
  emitter: DEFAULT_EMITTER(),
  emitterDevice: DEFAULT_EMITTER_DEVICE(),
  trvCapabilities: deepClone(DEFAULT_TRV_CAPABILITIES),
  trvSiblings: deepClone(DEFAULT_TRV_SIBLINGS),
  manifold: DEFAULT_MANIFOLD(),
  circuit: DEFAULT_CIRCUIT(),
  pump: DEFAULT_PUMP(),
  trigger: DEFAULT_TRIGGER(),
  rule: DEFAULT_RULE(),
  target: DEFAULT_TARGET(),
  watchRule: DEFAULT_WATCH_RULE(),
  z2m: DEFAULT_Z2M(),
  engine: ENGINE_DEFAULTS,
  wizard: WIZARD_DEFAULTS,
});

/* ── first-boot seed ──────────────────────────────────────────────────────────────────────────── */

// A fresh install is named in English whatever Home Assistant speaks; the Ukrainian names stay for
// the simulator's demo house and to recognise rows an older version seeded in Ukrainian.

const SEED_PROFILE_ROWS: readonly (Omit<Profile, 'name' | 'order'> & { uk: string; en: string })[] = [
  { id: 'home', uk: 'Дома', en: 'Home', kind: 'system', color: '#9B87F5', ink: '#140F2E', icon: 'home', heatC: 21.0, coolC: 25.0, frostOnly: false },
  { id: 'away', uk: 'Поза домом', en: 'Away', kind: 'system', color: '#7D8896', ink: '#0E1013', icon: 'away', heatC: 18.0, coolC: 28.0, frostOnly: false },
  { id: 'eco', uk: 'Еко', en: 'Eco', kind: 'system', color: '#57C48B', ink: '#062012', icon: 'leaf', heatC: 19.0, coolC: 27.0, frostOnly: false },
  { id: 'night', uk: 'Ніч', en: 'Night', kind: 'custom', color: '#4F5FD6', ink: '#FFFFFF', icon: 'moon', heatC: 19.5, coolC: 26.0, frostOnly: false },
  { id: 'guests', uk: 'Гості', en: 'Guests', kind: 'custom', color: '#E87AB4', ink: '#2A0718', icon: 'users', heatC: 22.0, coolC: 24.5, frostOnly: false },
  { id: 'vacation', uk: 'Відпустка', en: 'Vacation', kind: 'custom', color: '#C9B56E', ink: '#231D05', icon: 'suitcase', heatC: 12.0, coolC: 30.0, frostOnly: true },
];

export function seedProfiles(lang: Lang): Profile[] {
  return SEED_PROFILE_ROWS.map(({ uk, en, ...p }, order) => ({ ...p, name: lang === 'uk' ? uk : en, order }));
}

const block = (start: number, end: number, profileId: Id) => ({ start, end, profileId });

/** Weekly house plan: weekdays at work, a Friday evening with guests, lazy weekends. */
export function seedHouseDays(): DayPlan[] {
  const weekday = (): DayPlan => [block(0, 390, 'night'), block(390, 510, 'home'), block(510, 1050, 'away'), block(1050, 1380, 'home'), block(1380, 1440, 'night')];
  const friday: DayPlan = [block(0, 390, 'night'), block(390, 510, 'home'), block(510, 1050, 'away'), block(1050, 1140, 'home'), block(1140, 1410, 'guests'), block(1410, 1440, 'night')];
  const weekend = (): DayPlan => [block(0, 480, 'night'), block(480, 1410, 'home'), block(1410, 1440, 'night')];
  return [weekday(), weekday(), weekday(), weekday(), friday, weekend(), weekend()];
}

const NAMES = {
  blackout: { uk: 'Блекаут', en: 'Blackout' },
  solar: { uk: 'Сонце при блекауті', en: 'Sun during blackout' },
  night_tariff: { uk: 'Нічний тариф', en: 'Night tariff' },
  frost: { uk: 'Мороз', en: 'Frost' },
  battery_low: { uk: 'Батарея низька', en: 'Battery low' },
  economy: { uk: 'Економити', en: 'Save energy' },
  store_heat: { uk: 'Накопичити тепло', en: 'Store heat' },
  preheat_night: { uk: 'Передгрів електрикою', en: 'Electric pre-heat' },
  panel: { uk: 'Панель HA', en: 'HA panel' },
  automations: { uk: 'Автоматизації', en: 'Automations' },
  acGroup: { uk: 'Кондиціонери', en: 'Air conditioners' },
} as const;

export function seedName(key: keyof typeof NAMES, lang: Lang): string {
  return NAMES[key][lang];
}

/** Energy entities the seeded triggers bind to (empty until the energy setup binds them). */
export interface EnergyBindings {
  gridOffline: string | null;
  pvPower: string | null;
  houseLoad: string | null;
  batterySoc: string | null;
  tariff: string | null;
}

export function blackoutCondition(e: EnergyBindings): ConditionNode {
  return { op: 'state', entityId: e.gridOffline ?? '', equals: ['on'], id: 'grid_offline' };
}

export function solarCondition(e: EnergyBindings): ConditionNode {
  return {
    op: 'all',
    id: 'solar',
    items: [
      { op: 'trigger', triggerId: 'blackout', id: 'solar_blackout' },
      { op: 'numeric', entityId: e.pvPower ?? '', minus: e.houseLoad ?? undefined, cmp: '>', value: 1500, exitAt: 1000, forSec: 300, id: 'solar_surplus' },
      { op: 'numeric', entityId: e.batterySoc ?? '', cmp: '>=', value: 95, exitAt: 90, id: 'solar_soc' },
    ],
  };
}

export function batteryLowCondition(e: EnergyBindings): ConditionNode {
  return {
    op: 'all',
    id: 'battery_low',
    items: [
      { op: 'trigger', triggerId: 'blackout', id: 'battery_blackout' },
      { op: 'numeric', entityId: e.batterySoc ?? '', cmp: '<', value: 40, exitAt: 45, id: 'battery_soc' },
    ],
  };
}

export function nightTariffCondition(e: EnergyBindings): ConditionNode {
  const node: ConditionNode = { op: 'time', windows: [{ from: '23:00', to: '07:00' }], id: 'night_window' };
  return e.tariff ? { ...node, tariffEntityId: e.tariff } : node;
}

const NO_ENERGY: EnergyBindings = { gridOffline: null, pvPower: null, houseLoad: null, batterySoc: null, tariff: null };

export function seedTriggers(lang: Lang, heat: HeatStrategy = defaultHeatStrategy()): Trigger[] {
  const t = (id: string, rest: Partial<Trigger>, order: number): Trigger => ({
    ...DEFAULT_TRIGGER(),
    id,
    name: seedName(id as keyof typeof NAMES, lang),
    order,
    ...rest,
  });
  return [
    t('blackout', { icon: 'grid_power', kind: 'entity_state', condition: blackoutCondition(NO_ENERGY), enabled: false, whenUnknown: 'true' }, 0),
    t('solar', { icon: 'solar', kind: 'composite', condition: solarCondition(NO_ENERGY), enabled: false, whenUnknown: 'false' }, 1),
    t('night_tariff', { icon: 'moon', kind: 'time', condition: nightTariffCondition(NO_ENERGY), enabled: false, whenUnknown: 'false' }, 2),
    t('frost', { icon: 'snow', kind: 'numeric', condition: frostCondition(heat.bivalence), enabled: true, system: { boundTo: 'heat.bivalence' }, whenUnknown: 'hold_false' }, 3),
    t('battery_low', { icon: 'battery', kind: 'composite', condition: batteryLowCondition(NO_ENERGY), enabled: false, whenUnknown: 'hold_true' }, 4),
  ];
}

/** Source ids by role for the seeded rules (recomputed by the energy setup). */
export interface RuleSourceSets {
  gasBoilers: Id[];
  heatPumps: Id[];
  electricHeat: Id[];
}

export function economyRule(lang: Lang, s: RuleSourceSets, enabled: boolean): TriggerRule {
  return {
    ...DEFAULT_RULE(),
    id: 'economy',
    name: seedName('economy', lang),
    enabled,
    priority: 10,
    when: { op: 'trigger', triggerId: 'battery_low', id: 'economy_when' },
    effects: [
      { type: 'only_sources', sourceIds: [...s.gasBoilers] },
      { type: 'disable_carrier', carrier: 'electric' },
      { type: 'pumps_demand_only' },
      { type: 'target_offset', roomIds: 'all', deltaC: -1, mode: 'both' },
    ],
  };
}

export function storeHeatRule(lang: Lang, s: RuleSourceSets, socEntity: string | null): TriggerRule {
  return {
    ...DEFAULT_RULE(),
    id: 'store_heat',
    name: seedName('store_heat', lang),
    enabled: true,
    priority: 20,
    when: { op: 'trigger', triggerId: 'solar', id: 'store_when' },
    stopWhen: socEntity ? { op: 'numeric', entityId: socEntity, cmp: '<', value: 90, id: 'store_stop_soc' } : null,
    effects: [
      { type: 'allow_sources', sourceIds: [...s.electricHeat] },
      { type: 'target_offset', roomIds: 'trigger_rooms', deltaC: 1.5, mode: 'heat' },
      { type: 'power_cap', kw: 'budget' },
    ],
  };
}

export function preheatNightRule(lang: Lang, s: RuleSourceSets, enabled = false): TriggerRule {
  return {
    ...DEFAULT_RULE(),
    id: 'preheat_night',
    name: seedName('preheat_night', lang),
    enabled,
    priority: 30,
    when: { op: 'trigger', triggerId: 'night_tariff', id: 'preheat_when' },
    effects: [
      { type: 'preheat_to_next_slot', sourceIds: [...s.heatPumps] },
      ...s.gasBoilers.map((sourceId) => ({ type: 'source_requires' as const, sourceId, triggerId: 'frost' })),
    ],
  };
}

export function seedRules(lang: Lang): TriggerRule[] {
  const none: RuleSourceSets = { gasBoilers: [], heatPumps: [], electricHeat: [] };
  return [economyRule(lang, none, false), storeHeatRule(lang, none, null), preheatNightRule(lang, none)];
}

/* ── control memory (fresh rows: every latch off since now) ───────────────────────────────────── */

export const offLatch = (now: EpochMs): Latch => ({ on: false, since: now });

export function defaultRoomMemory(roomId: Id, now: EpochMs): RoomMemory {
  return {
    roomId,
    heat: offLatch(now),
    cool: offLatch(now),
    frost: offLatch(now),
    overheat: offLatch(now),
    assist: offLatch(now),
    dry: offLatch(now),
    store: offLatch(now),
    dehumidifier: offLatch(now),
    floorLimit: offLatch(now),
    humidityUnknown: { on: false, since: now, pendingSince: null },
    demandMode: 'none',
    demandSince: null,
    preheat: null,
    window: {
      contactOpenSince: null,
      allClosedSince: null,
      reactionActive: false,
      reactionSince: null,
      virtualOpenSince: null,
      virtualMinC: null,
      remindedAt: null,
      notifiedAt: null,
    },
    lagDeficitSince: null,
    tooColdSince: null,
    tooHotSince: null,
    noDataSince: null,
    learned: { heatRateCPerH: null, coolRateCPerH: null, driftCPerH: null, heatSamples: 0, coolSamples: 0, trvOffsetC: {}, acOffsetC: {} },
    valveIntegral: {},
    acSetpoint: {},
    updatedAt: now,
  };
}

export function defaultSourceMemory(sourceId: Id, now: EpochMs): SourceMemory {
  return {
    sourceId,
    on: false,
    mode: null,
    onSince: null,
    offSince: null,
    starts: [],
    confirm: 'none',
    confirmDeadline: null,
    confirmedAt: null,
    fault: null,
    unavailableSince: null,
    lastRearmAt: null,
    stage: 0,
    stageSince: null,
    admittedAt: null,
    prerunSince: null,
    test: null,
    hpMode: 'none',
    lastChangeoverAt: null,
    outdoorBlocked: { heat: false, cool: false },
    stillDrawingSince: null,
    updatedAt: now,
  };
}

export function defaultPumpMemory(pumpId: Id, now: EpochMs): PumpMemory {
  return {
    pumpId,
    on: false,
    reason: null,
    onSince: null,
    offSince: null,
    condSince: null,
    condFellAt: null,
    runOnMode: 'none',
    runOnUntil: null,
    dewRunOnUntil: null,
    lastExerciseAt: null,
    exerciseUntil: null,
    dutyIndex: 0,
    updatedAt: now,
  };
}

export function defaultConditionMemory(ownerKey: string, now: EpochMs): ConditionMemory {
  return { ownerKey, active: false, since: null, latches: {}, timers: {}, lastKnownValue: null, unknownSince: null, stopped: false, updatedAt: now };
}

export function defaultPlantMemory(now: EpochMs): PlantMemory {
  return {
    bivalentFrost: offLatch(now),
    bivalentLimit: offLatch(now),
    lagActive: offLatch(now),
    cutoff: offLatch(now),
    outdoorLast: null,
    outdoorUnknownSince: null,
    lastAdmissionAt: null,
    budgetOverSince: null,
    lastShedAt: null,
    dewGuardSince: {},
    dewTrips: {},
    dewLockout: {},
    lastHeartbeatAt: now,
    bootCount: 0,
    updatedAt: now,
  };
}

/** Season by the month gates alone (first boot without outdoor statistics): one gate open → that season. */
export function seasonByMonth(cfg: SeasonConfig, month: number): Season {
  const heat = !!cfg.heatingMonths[month - 1];
  const cool = !!cfg.coolingMonths[month - 1];
  if (heat && !cool) return 'heating';
  if (cool && !heat) return 'cooling';
  return 'neutral';
}

export function defaultSeasonMemory(now: EpochMs, cfg: SeasonConfig, month: number): SeasonMemory {
  return { season: seasonByMonth(cfg, month), since: now, avgC: null, avgComputedAt: null, pending: null, bootstrap: true };
}
