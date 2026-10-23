import { meterUnit, METER_QUANTITIES } from '../shared/model';
import type { EntityRolePreset, HaEntityDetailDto, HaStateObj, MeterKind, TrvCapabilities, TrvSiblings, TrvStrategy, WizardDeviceRole, WizardRoleHint } from '../shared/model';
import { searchKey } from './search-text';
import { entityTempUnit, parseNumber, tempAttr, tempUnit, type TempUnit } from './units';

/* =====================================================================================================
 * Heuristics that turn raw HA entities into Klimo roles: which climate is a radiator head and which an
 * air conditioner, what a sibling entity on the same device is for (external temperature input,
 * calibration, child lock…), and what an entity in an area most likely is in the add-room wizard.
 * Matching runs on the entity's "property key": the Zigbee2MQTT property from a Z2M-style unique id
 * (`0x…_external_temperature_input_zigbee2mqtt`), else the object id, so renamed entities still match.
 * ===================================================================================================== */

export type SiblingRole = HaEntityDetailDto['siblings'][number]['role'];

/** What the classifier needs to know about one entity. */
export interface EntityFacts {
  entityId: string;
  domain: string;
  /** Z2M property or object id, lower case. */
  key: string;
  name: string;
  state: HaStateObj | undefined;
  deviceClass: string | null;
  unit: string | null;
  entityCategory: string | null;
  model: string | null;
  areaName: string | null;
}

const Z2M_UNIQUE_ID = /^0x[0-9a-f]+_(.+)_zigbee2mqtt$/i;

export function propertyKey(entityId: string, uniqueId: string | null): string {
  const m = uniqueId ? Z2M_UNIQUE_ID.exec(uniqueId) : null;
  if (m) return m[1].toLowerCase();
  return entityId.slice(entityId.indexOf('.') + 1).toLowerCase();
}

const has = (re: RegExp, ...texts: (string | null | undefined)[]) => texts.some((t) => !!t && re.test(t));

/* ── siblings ──────────────────────────────────────────────────────────────────────────────────── */

const SIBLING_RULES: { role: SiblingRole; domains: string[] | null; test: (f: EntityFacts) => boolean }[] = [
  { role: 'external_temp', domains: ['number', 'input_number'], test: (f) => has(/external_temp|ext_temp|external_sensor_temp|remote_temp/, f.key) },
  { role: 'sensor_select', domains: ['select', 'input_select'], test: (f) => has(/sensor_select|temperature_sensor|sensor_mode|sensor_type/, f.key) },
  { role: 'calibration', domains: ['number', 'input_number'], test: (f) => has(/calibration|temperature_offset|temp_offset|local_temperature_correction/, f.key) },
  { role: 'valve_opening', domains: ['number', 'input_number'], test: (f) => has(/valve_opening|opening_degree|max_valve|valve_max/, f.key) },
  { role: 'valve_closing', domains: ['number', 'input_number'], test: (f) => has(/valve_closing|closing_degree|min_valve|valve_min/, f.key) },
  { role: 'child_lock', domains: ['switch', 'lock', 'select'], test: (f) => has(/child_lock|childlock|keypad_lock|lock_ui|physical_control_lock/, f.key) || (f.domain === 'lock' && !has(/door/, f.key)) },
  { role: 'window_detection', domains: ['switch', 'select'], test: (f) => has(/window_detection|open_window|window_open|window_mode/, f.key) },
  { role: 'countdown', domains: ['number', 'input_number'], test: (f) => has(/countdown|auto_off|turn_off_after|inching|watchdog|off_delay/, f.key) },
  { role: 'battery', domains: ['sensor'], test: (f) => f.deviceClass === 'battery' || has(/(^|_)battery($|_)(?!low)/, f.key) },
  { role: 'linkquality', domains: ['sensor'], test: (f) => has(/linkquality|link_quality|(^|_)lqi($|_)/, f.key) },
  { role: 'power', domains: ['sensor'], test: (f) => f.deviceClass === 'power' || f.unit === 'W' || f.unit === 'kW' },
  { role: 'energy', domains: ['sensor'], test: (f) => f.deviceClass === 'energy' || f.unit === 'kWh' || f.unit === 'Wh' },
  { role: 'defrost', domains: ['binary_sensor', 'sensor'], test: (f) => has(/defrost/, f.key) },
  { role: 'flame', domains: ['binary_sensor', 'sensor'], test: (f) => has(/flame|burner/, f.key) },
  { role: 'cop', domains: ['sensor'], test: (f) => has(/(^|_)cop($|_)|coefficient_of_performance/, f.key) },
  { role: 'supply', domains: ['sensor'], test: (f) => has(/supply|flow_temp|outlet|leaving_water|water_out/, f.key) },
  { role: 'error', domains: ['sensor', 'binary_sensor'], test: (f) => f.deviceClass === 'problem' || has(/error|fault|alarm/, f.key) },
];

export function siblingRole(f: EntityFacts): SiblingRole {
  for (const rule of SIBLING_RULES) if ((!rule.domains || rule.domains.includes(f.domain)) && rule.test(f)) return rule.role;
  return 'other';
}

/** A real valve-position feedback sensor (TrvSiblings.valvePosition; listed as 'other' among siblings). */
export function isValvePosition(f: EntityFacts): boolean {
  return f.domain === 'sensor' && has(/valve_position|(^|_)position$|pi_heating_demand|valve_state|valve_opening_percent/, f.key);
}

/* ── climate kinds ─────────────────────────────────────────────────────────────────────────────── */

/** Radiator heads known by their Zigbee model (device registry `model`). */
const TRV_MODEL = /\b(trv\w*|srts-a01|spzb0001|etrv\w*|tv0[12]\w*|me167|brt-100\w*|sea80[12]\w*|gs361\w*|ts0601_thermostat|thermostatic radiator valve|radiator valve|radiator thermostat|thermostatic valve)\b/i;
const TRV_ONLY_MODES = new Set(['heat', 'off', 'auto']);

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export function hvacModes(s: HaStateObj | undefined): string[] {
  return stringList(s?.attributes.hvac_modes);
}

export function fanModes(s: HaStateObj | undefined): string[] {
  return stringList(s?.attributes.fan_modes);
}

/**
 * A climate entity is a radiator head when its device exposes an external temperature input or a
 * calibration, its model is a known TRV, or it can only heat (hvac modes ⊆ heat/off/auto).
 */
export function looksLikeTrv(f: EntityFacts, siblingRoles: readonly SiblingRole[]): boolean {
  if (f.domain !== 'climate') return false;
  if (siblingRoles.includes('external_temp') || siblingRoles.includes('calibration')) return true;
  if (has(TRV_MODEL, f.model)) return true;
  const modes = hvacModes(f.state);
  return modes.length > 0 && modes.includes('heat') && modes.every((m) => TRV_ONLY_MODES.has(m));
}

/** An air conditioner can cool and has fan modes. */
export function looksLikeAc(f: EntityFacts): boolean {
  return f.domain === 'climate' && hvacModes(f.state).includes('cool') && fanModes(f.state).length > 0;
}

/** How strongly the evidence says "TRV" (model or siblings beat the hvac-modes guess). */
export function trvEvidence(f: EntityFacts, siblingRoles: readonly SiblingRole[]): number {
  if (siblingRoles.includes('external_temp') || siblingRoles.includes('calibration') || has(TRV_MODEL, f.model)) return 0.95;
  return 0.75;
}

/* ── TRV capabilities ──────────────────────────────────────────────────────────────────────────── */

export interface SiblingRef {
  role: SiblingRole;
  valvePosition: boolean;
  entityId: string;
  state: HaStateObj | undefined;
}

export function trvSiblings(siblings: readonly SiblingRef[]): TrvSiblings {
  const first = (role: SiblingRole) => siblings.find((s) => s.role === role)?.entityId ?? null;
  return {
    externalTemp: first('external_temp'),
    sensorSelect: first('sensor_select'),
    calibration: first('calibration'),
    valveOpening: first('valve_opening'),
    valveClosing: first('valve_closing'),
    childLock: first('child_lock'),
    windowDetection: first('window_detection'),
    battery: first('battery'),
    linkquality: first('linkquality'),
    valvePosition: siblings.find((s) => s.valvePosition)?.entityId ?? null,
  };
}

/** A climate's `target_temp_step` in °C. In a °F house the step is in °F too: 1 °F is 0.56 °C, not 1 °C. */
export function setpointStepC(climate: HaStateObj | undefined, haUnit: TempUnit): number | null {
  const step = parseNumber(climate?.attributes.target_temp_step);
  if (step === null || step <= 0) return null;
  const unit = climate ? entityTempUnit(climate, haUnit) : haUnit;
  return unit === '°F' ? Math.round(((step * 5) / 9) * 100) / 100 : step;
}

export function trvCapabilities(climate: HaStateObj | undefined, sib: TrvSiblings, siblings: readonly SiblingRef[], haUnit: TempUnit): TrvCapabilities {
  const calib = sib.calibration ? siblings.find((s) => s.entityId === sib.calibration)?.state : undefined;
  const lo = parseNumber(calib?.attributes.min);
  const hi = parseNumber(calib?.attributes.max);
  const minT = tempAttr(climate, 'min_temp', haUnit);
  const maxT = tempAttr(climate, 'max_temp', haUnit);
  return {
    externalSensor: !!sib.externalTemp,
    calibration: !!sib.calibration,
    calibrationRange: sib.calibration && lo !== null && hi !== null ? [lo, hi] : null,
    valveLimits: !!(sib.valveOpening || sib.valveClosing),
    valvePosition: !!sib.valvePosition,
    childLock: !!sib.childLock,
    windowDetection: !!sib.windowDetection,
    setpointRange: [minT ?? 5, maxT ?? 30],
    setpointStep: setpointStepC(climate, haUnit) ?? 0.5,
  };
}

/** Which TRV strategies this head supports, with a machine reason for the ones it does not. */
export function trvStrategies(caps: TrvCapabilities): { strategy: TrvStrategy; supported: boolean; reason: string | null }[] {
  return [
    { strategy: 'external', supported: caps.externalSensor, reason: caps.externalSensor ? null : 'no_external_input' },
    { strategy: 'calibration', supported: caps.calibration, reason: caps.calibration ? null : 'no_calibration' },
    { strategy: 'onoff', supported: true, reason: null },
    { strategy: 'valve', supported: caps.valveLimits, reason: caps.valveLimits ? null : 'no_valve_opening' },
  ];
}

/* ── picker role presets ───────────────────────────────────────────────────────────────────────── */

const CONTACT_CLASSES = new Set(['window', 'door', 'opening', 'garage_door']);
const SWITCHABLE = new Set(['switch', 'input_boolean', 'light', 'valve', 'fan']);
const OUTDOOR_HINT = /outdoor|outside|exterior|street|nadvor|zovn|vulyts|balcon|balkon|weather_station/;

/** The electronics' own temperature (plugs, relays, gateways) says nothing about the room. */
const INTERNAL_TEMP = /device_temp|internal_temp|chip_temp|cpu|processor|board_temp|module_temp|core_temp|esp_temp/;

export function isTemperatureSensor(f: EntityFacts): boolean {
  if (f.domain !== 'sensor' || f.entityCategory || INTERNAL_TEMP.test(f.key)) return false;
  return f.deviceClass === 'temperature' || (!f.deviceClass && tempUnit(f.unit) !== null);
}

export function isHumiditySensor(f: EntityFacts): boolean {
  return f.domain === 'sensor' && !f.entityCategory && (f.deviceClass === 'humidity' || (!f.deviceClass && f.unit === '%' && has(/humid/, f.key)));
}

export function isOutdoorSensor(f: EntityFacts): boolean {
  return isTemperatureSensor(f) && has(OUTDOOR_HINT, f.key, searchKey(f.name).replace(/ /g, '_'), searchKey(f.areaName).replace(/ /g, '_'));
}

export function isPowerSensor(f: EntityFacts): boolean {
  return f.domain === 'sensor' && (f.deviceClass === 'power' || f.unit === 'W' || f.unit === 'kW');
}

/**
 * A consumption meter of `kind`: a unit that fits it and a state class HA keeps long-term statistics
 * for — a counter (total, total_increasing), or for electricity also a power sensor, integrated.
 */
export function isMeter(f: EntityFacts, kind: MeterKind): boolean {
  if (f.domain !== 'sensor') return false;
  const unit = meterUnit(f.unit);
  if (!unit || !METER_QUANTITIES[kind].includes(unit.quantity)) return false;
  // a gas meter counting energy says so by its device class; other kWh counters are electricity or heat
  if (kind === 'gas' && unit.quantity === 'energy' && f.deviceClass !== 'gas') return false;
  const stateClass = f.state?.attributes.state_class;
  return unit.quantity === 'power' || stateClass === 'total' || stateClass === 'total_increasing';
}

export function matchesRole(role: EntityRolePreset, f: EntityFacts, siblingRoles: readonly SiblingRole[]): boolean {
  switch (role) {
    case 'trv':
      return looksLikeTrv(f, siblingRoles);
    case 'ac':
      return looksLikeAc(f);
    case 'climate_source':
      return f.domain === 'climate';
    case 'temperature':
      return isTemperatureSensor(f);
    case 'humidity':
      return isHumiditySensor(f);
    case 'contact':
      return f.domain === 'binary_sensor' && !!f.deviceClass && CONTACT_CLASSES.has(f.deviceClass);
    case 'switchable':
    case 'pump':
      return SWITCHABLE.has(f.domain);
    case 'number':
      return f.domain === 'number' || f.domain === 'input_number';
    case 'select':
      return f.domain === 'select' || f.domain === 'input_select';
    case 'power':
      return isPowerSensor(f);
    case 'binary':
      return f.domain === 'binary_sensor';
    case 'outdoor':
      // any thermometer may hang outside (a south wall, the garden); the ones that say so rank first
      return isTemperatureSensor(f);
    case 'person':
      return f.domain === 'person';
    case 'calendar':
      return f.domain === 'calendar';
    case 'weather':
      return f.domain === 'weather';
    case 'proximity':
      return f.domain === 'proximity' || (f.domain === 'sensor' && (f.deviceClass === 'distance' || has(/proximity|nearest_distance/, f.key)));
    case 'script':
      return f.domain === 'script';
    case 'gas_meter':
      return isMeter(f, 'gas');
    case 'electricity_meter':
      return isMeter(f, 'electricity');
    case 'heat_meter':
      return isMeter(f, 'heat');
  }
}

/* ── add-room discovery ────────────────────────────────────────────────────────────────────────── */

const FLOOR_HINT = /underfloor|floor_heat|floor_temp|floor_probe|floor_sensor|floor_zone|warm_floor|heated_floor|pidloh|pidlog|(^|_)floor($|_)/;
// «floor» alone often means a storey (ground_floor_temperature); a probe has to say so
const FLOOR_PROBE_HINT = /underfloor|floor_temp|floor_probe|floor_sensor|warm_floor|heated_floor|pidloh|pidlog/;
const HEATER_HINT = /heater|obihriv|konvektor|convector|radiator|rushnyk|towel|infrared|ir_panel|(^|_)ik_|panel/;
const PLUG_HINT = /plug|socket|outlet|rozetk/;
const DOOR_HINT = /door|dver/;
const DEHUMIDIFIER_HINT = /dehumid|osush/;

export interface DiscoveryGuess {
  role: WizardDeviceRole;
  confidence: number;
}

export interface DeviceContext {
  /** Roles of the other entities on the same HA device. */
  siblingRoles: SiblingRole[];
  /** The device also has a climate entity (its sensors and switches belong to that head or AC). */
  hasClimate: boolean;
  hasTemperature: boolean;
  hasHumidity: boolean;
  /** The HA device's name (a relay is often called after what it drives). */
  deviceName?: string | null;
}

function hint(f: EntityFacts): string {
  return `${f.key} ${searchKey(f.name).replace(/ /g, '_')}`;
}

// «насос» folds to nasos, «циркуляційний» to tsyrkuliatsiinyi
const PUMP_HINT = /pump|nasos|(^|[_ ])circ|tsyrkul|tsirkul|cirkul/;

/** A relay whose id, name or device says it runs a pump: the plant's, not a room's heater or zone valve. */
export function looksLikePump(f: EntityFacts, deviceName?: string | null): boolean {
  if (f.domain !== 'switch' && f.domain !== 'input_boolean') return false;
  return PUMP_HINT.test(`${hint(f)} ${f.entityId.replace('.', '_')} ${searchKey(deviceName).replace(/ /g, '_')}`);
}

/** The most likely wizard role of an entity found in an area, with a confidence 0..1 (null = not offered). */
export function discoveryGuess(f: EntityFacts, ctx: DeviceContext): DiscoveryGuess | null {
  if (f.entityCategory) return null;
  const text = hint(f);
  switch (f.domain) {
    case 'climate': {
      // a floor thermostat drives its own mat or actuator: a zone valve is a switch, never a climate
      if (FLOOR_HINT.test(text) && !looksLikeAc(f)) return { role: 'heater', confidence: 0.6 };
      if (looksLikeTrv(f, ctx.siblingRoles)) return { role: 'trv', confidence: trvEvidence(f, ctx.siblingRoles) };
      if (looksLikeAc(f)) return { role: 'ac', confidence: 0.9 };
      if (hvacModes(f.state).includes('cool')) return { role: 'ac', confidence: 0.7 };
      return { role: 'heater', confidence: 0.6 };
    }
    case 'sensor': {
      if (ctx.hasClimate || isOutdoorSensor(f)) return null;
      if (isTemperatureSensor(f)) {
        if (FLOOR_PROBE_HINT.test(text)) return { role: 'floor_probe', confidence: 0.75 };
        return ctx.hasHumidity ? { role: 'temp_humidity', confidence: 0.95 } : { role: 'temperature', confidence: 0.9 };
      }
      // a combined sensor is offered once, through its temperature entity
      if (isHumiditySensor(f)) return ctx.hasTemperature ? null : { role: 'humidity', confidence: 0.9 };
      return null;
    }
    case 'binary_sensor': {
      const dc = f.deviceClass;
      if (dc === 'window') return { role: 'window', confidence: 0.95 };
      if (dc === 'door' || dc === 'garage_door') return { role: 'door', confidence: 0.9 };
      if (dc === 'opening') return DOOR_HINT.test(text) ? { role: 'door', confidence: 0.85 } : { role: 'window', confidence: 0.8 };
      return null;
    }
    case 'humidifier':
      if (f.deviceClass === 'dehumidifier') return { role: 'dehumidifier', confidence: 0.9 };
      return DEHUMIDIFIER_HINT.test(text) ? { role: 'dehumidifier', confidence: 0.8 } : null;
    case 'switch':
    case 'input_boolean':
    case 'fan': {
      if (ctx.hasClimate) return null; // child lock, window detection… of a head or an AC
      if (looksLikePump(f, ctx.deviceName)) return null;
      if (DEHUMIDIFIER_HINT.test(text)) return { role: 'dehumidifier', confidence: 0.75 };
      if (f.domain === 'fan') return null;
      if (FLOOR_HINT.test(text)) return { role: 'floor_zone', confidence: 0.7 };
      if (HEATER_HINT.test(text)) return { role: 'heater', confidence: 0.75 };
      if (PLUG_HINT.test(text)) return { role: 'heater', confidence: 0.5 };
      return { role: 'heater', confidence: f.domain === 'switch' ? 0.4 : 0.3 };
    }
    default:
      return null;
  }
}

/* ── add-room wizard: what any entity can be ───────────────────────────────────────────────────── */

const COOL_MODES = new Set(['cool', 'heat_cool', 'dry', 'fan_only']);
const CONTACT_HINT = /window|vikn|door|dver|contact|kontakt/;
const VALVE_HINT = /valve|klapan|position|opening|actuator|pryvid/;

function roleHint(suggested: WizardDeviceRole[], ...more: WizardDeviceRole[]): WizardRoleHint {
  return { suggested, possible: [...new Set([...suggested, ...more])] };
}

/**
 * The wizard roles of an entity the user searched for: `suggested` holds one role when the evidence is
 * clear and two (likeliest first) when it could be either — a heat-and-cool climate, a bare relay —
 * so the UI asks instead of guessing; `possible` is every role it may be switched to. Null when a room
 * has no use for it (a head's own settings, diagnostics, an outdoor sensor).
 */
export function wizardRoles(f: EntityFacts, ctx: DeviceContext): WizardRoleHint | null {
  if (f.entityCategory) return null;
  const text = hint(f);
  switch (f.domain) {
    case 'climate': {
      const modes = hvacModes(f.state);
      const cools = modes.some((m) => COOL_MODES.has(m)) || fanModes(f.state).length > 0;
      const heats = !modes.length || modes.some((m) => m === 'heat' || m === 'heat_cool' || m === 'auto');
      const ac: WizardDeviceRole[] = cools ? ['ac'] : [];
      if (ctx.siblingRoles.includes('external_temp') || ctx.siblingRoles.includes('calibration') || has(TRV_MODEL, f.model)) return roleHint(['trv'], 'heater', ...ac);
      if (FLOOR_HINT.test(text) && !looksLikeAc(f)) return roleHint(['heater', 'trv'], ...ac);
      if (looksLikeAc(f)) return roleHint(['ac'], 'trv', 'heater');
      if (cools) return roleHint(heats ? ['ac', 'trv'] : ['ac'], 'heater');
      if (!modes.length) return roleHint(['trv', 'ac'], 'heater');
      return roleHint(['trv'], 'heater');
    }
    case 'sensor': {
      if (isOutdoorSensor(f)) return null;
      if (isTemperatureSensor(f)) {
        if (FLOOR_PROBE_HINT.test(text)) return roleHint(['floor_probe'], 'temperature');
        return ctx.hasHumidity ? roleHint(['temp_humidity'], 'temperature', 'floor_probe') : roleHint(['temperature'], 'floor_probe');
      }
      if (isHumiditySensor(f)) {
        if (has(OUTDOOR_HINT, f.key, searchKey(f.name).replace(/ /g, '_'), searchKey(f.areaName).replace(/ /g, '_'))) return null;
        // a combined sensor is offered through its temperature entity; its humidity alone is a humidity sensor
        return roleHint(['humidity'], ...(ctx.hasTemperature ? (['temp_humidity'] as WizardDeviceRole[]) : []));
      }
      return null;
    }
    case 'binary_sensor': {
      const dc = f.deviceClass;
      const door = dc === 'door' || dc === 'garage_door' || (DOOR_HINT.test(text) && (dc === 'opening' || !dc));
      if (door) return roleHint(['door'], 'window');
      if (dc === 'window' || dc === 'opening' || (!dc && CONTACT_HINT.test(text))) return roleHint(['window'], 'door');
      return null;
    }
    case 'humidifier':
      return f.deviceClass === 'dehumidifier' || DEHUMIDIFIER_HINT.test(text) ? roleHint(['dehumidifier']) : null;
    case 'fan':
      return !ctx.hasClimate && DEHUMIDIFIER_HINT.test(text) ? roleHint(['dehumidifier']) : null;
    case 'switch':
    case 'input_boolean':
    case 'light': {
      if (ctx.hasClimate) return null; // child lock, window detection… of a head or an AC
      const light = f.domain === 'light';
      const extra: WizardDeviceRole[] = f.domain === 'input_boolean' ? ['window', 'door'] : [];
      const dehum: WizardDeviceRole[] = light ? [] : ['dehumidifier'];
      // a circulation pump is nothing a room takes by itself; picked on purpose it can still be one
      if (looksLikePump(f, ctx.deviceName)) return roleHint([], 'heater', 'floor_zone', ...dehum, ...extra);
      if (!light && DEHUMIDIFIER_HINT.test(text)) return roleHint(['dehumidifier'], 'heater', 'floor_zone', ...extra);
      if (FLOOR_HINT.test(text)) return roleHint(['floor_zone'], 'heater', ...dehum, ...extra);
      if (HEATER_HINT.test(text)) return roleHint(['heater'], 'floor_zone', ...dehum, ...extra);
      // a lamp is a lamp unless it says otherwise; a plug or a bare relay could drive either
      return light ? null : roleHint(['heater', 'floor_zone'], ...dehum, ...extra);
    }
    case 'valve':
      return roleHint(['floor_zone']);
    case 'number':
    case 'input_number':
      // a head's opening limits belong to the head: it is the head that is added
      if (ctx.hasClimate) return null;
      if (VALVE_HINT.test(text)) return roleHint(['floor_zone']);
      return tempUnit(f.unit) !== null ? roleHint(['temperature'], 'floor_probe') : null;
    default:
      return null;
  }
}

export const DISCOVERY_ROLE_ORDER: readonly WizardDeviceRole[] = [
  'trv', 'temp_humidity', 'temperature', 'humidity', 'window', 'door', 'ac', 'heater', 'floor_zone', 'floor_probe', 'dehumidifier',
];

