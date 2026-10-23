import type { HaRegistries } from '../shared/model';

/* =====================================================================================================
 * The demo house as Home Assistant sees it: areas, devices and entities with Zigbee2MQTT-style unique
 * ids, so area discovery, sibling detection, the Devices page and the Z2M listener all run on the same
 * code paths as in a real installation. Each device also says what it is in the simulated world
 * (`binding`): which room a thermometer hangs in, which radiator a head sits on, which pump a relay runs.
 * ===================================================================================================== */

export type RoomKey = 'living' | 'bedroom' | 'kids' | 'study' | 'kitchen' | 'bath' | 'hall';
export const ROOM_KEYS: readonly RoomKey[] = ['living', 'bedroom', 'kids', 'study', 'kitchen', 'bath', 'hall'];

export interface AreaSpec {
  id: string;
  name: string;
  room: RoomKey | null;
}

export const AREAS: readonly AreaSpec[] = [
  { id: 'vitalnia', name: 'Вітальня', room: 'living' },
  { id: 'spalnia', name: 'Спальня', room: 'bedroom' },
  { id: 'dytiacha', name: 'Дитяча', room: 'kids' },
  { id: 'kabinet', name: 'Кабінет', room: 'study' },
  { id: 'kukhnia', name: 'Кухня', room: 'kitchen' },
  { id: 'vanna', name: 'Ванна', room: 'bath' },
  { id: 'korydor', name: 'Коридор', room: 'hall' },
  { id: 'kotelnia', name: 'Котельня', room: null },
  { id: 'garazh', name: 'Гараж', room: null },
];

export function areaOfRoom(room: RoomKey): string {
  return AREAS.find((a) => a.room === room)?.id ?? '';
}

export type RelayTarget = 'pump_radiators' | 'pump_floor_a' | 'pump_floor_b' | 'pump_manifold' | 'convector' | 'dehumidifier' | 'garage_plug';

/** What a device is in the simulated world. */
export type Binding =
  | { kind: 'trv'; room: RoomKey; emitter: 'radiator' | 'towel'; hotOffsetC: number; gain: number; tuya: boolean }
  | { kind: 'thermo'; room: RoomKey; biasC: number; rhBias: number; radiatorBiasC: number }
  | { kind: 'contact'; room: RoomKey; contact: 'window' | 'door' }
  | { kind: 'relay'; target: RelayTarget; powerW: number }
  | { kind: 'boiler' }
  | { kind: 'heat_pump' }
  | { kind: 'ac'; room: RoomKey }
  | { kind: 'manifold' }
  | { kind: 'outdoor' }
  | { kind: 'sunny_wall' }
  | { kind: 'energy' }
  | { kind: 'gas_meter' }
  | { kind: 'bridge'; instance: 1 | 2 }
  | { kind: 'phone'; personId: string }
  | { kind: 'spare' };

/** The part of an entity the simulator updates (sensor reports, device telemetry). */
export type EntityRole =
  | 'climate' | 'temperature' | 'humidity' | 'battery' | 'linkquality' | 'contact' | 'switch' | 'power'
  | 'external_temp' | 'sensor_select' | 'calibration' | 'valve_opening' | 'valve_closing' | 'child_lock'
  | 'window_detection' | 'position' | 'countdown' | 'flame' | 'compressor' | 'defrost' | 'cop' | 'supply'
  | 'error' | 'mixing_valve' | 'manifold_supply' | 'manifold_return' | 'floor_supply' | 'grid_offline' | 'pv'
  | 'load' | 'soc' | 'bridge' | 'tracker' | 'outdoor_temp' | 'outdoor_humidity' | 'gas_meter' | 'energy_meter' | 'heat_meter';

export interface EntitySpec {
  entityId: string;
  /** Zigbee2MQTT property or integration key: the unique id is built from it. */
  key: string;
  /** Entity name in the registry (null = the device name alone). */
  name: string | null;
  category: 'diagnostic' | 'config' | null;
  role: EntityRole;
  state: string;
  attributes: Record<string, unknown>;
  /** Disabled in the entity registry (no state), as integrations leave their noisier diagnostics. */
  disabled?: boolean;
}

export interface ZigbeeSpec {
  instance: 1 | 2;
  ieee: string;
  lqi: number;
  mains: boolean;
  /** Battery at the scenario start (it drains slowly before and after). */
  batteryPct: number | null;
  drainPerDay: number;
  /** Link quality only in Zigbee2MQTT's own messages ('mqtt'), or nowhere ('none'); unset = also an HA entity. */
  link?: 'mqtt' | 'none';
}

export interface DeviceSpec {
  /** HA device registry id. */
  id: string;
  /** Registry name; for Zigbee devices also the Zigbee2MQTT friendly name (topic). */
  name: string;
  /** The name the household gave it (`name_by_user`). */
  label: string;
  area: string | null;
  model: string;
  manufacturer: string;
  zigbee: ZigbeeSpec | null;
  /** HA integration of a non-Zigbee device. */
  integration: string | null;
  binding: Binding;
  entities: EntitySpec[];
}

/* ── builders ──────────────────────────────────────────────────────────────────────────────────── */

const C = '°C';
let ieeeSeq = 0;

function ieee(vendor: 'aqara' | 'sonoff' | 'tuya'): string {
  ieeeSeq++;
  const prefix = vendor === 'aqara' ? '0x00158d0004' : vendor === 'tuya' ? '0xa4c13800' : '0x0ceff6fffe';
  const width = 18 - prefix.length;
  return prefix + (0x3a10 + ieeeSeq * 0x1d7).toString(16).padStart(width, '0').slice(-width);
}

function ent(entityId: string, key: string, role: EntityRole, name: string | null, state: string, attributes: Record<string, unknown> = {}, category: EntitySpec['category'] = null): EntitySpec {
  return { entityId, key, role, name, state, attributes, category };
}

const measurement = (unit: string, deviceClass: string | null, extra: Record<string, unknown> = {}) => ({
  ...(deviceClass ? { device_class: deviceClass } : {}),
  unit_of_measurement: unit,
  state_class: 'measurement',
  ...extra,
});

/** A cumulative counter HA compiles into a growing sum (energy and gas meters). */
const counter = (unit: string, deviceClass: string) => ({ device_class: deviceClass, unit_of_measurement: unit, state_class: 'total_increasing' });

function linkEntities(base: string, battery: number | null): EntitySpec[] {
  const out: EntitySpec[] = [];
  if (battery !== null) out.push(ent(`sensor.${base}_battery`, 'battery', 'battery', 'Батарея', String(battery), measurement('%', 'battery'), 'diagnostic'));
  out.push(ent(`sensor.${base}_linkquality`, 'linkquality', 'linkquality', 'Якість зв’язку', '0', { unit_of_measurement: 'lqi', state_class: 'measurement', icon: 'mdi:signal' }, 'diagnostic'));
  return out;
}

interface TrvOpts {
  base: string;
  label: string;
  room: RoomKey;
  emitter?: 'radiator' | 'towel';
  instance: 1 | 2;
  lqi: number;
  battery: number;
  hotOffsetC?: number;
  gain?: number;
  tuya?: boolean;
}

function trv(o: TrvOpts): DeviceSpec {
  const climate = ent(`climate.${o.base}`, 'climate', 'climate', null, 'heat', {
    hvac_modes: ['off', 'heat'],
    min_temp: o.tuya ? 5 : 4,
    max_temp: 35,
    target_temp_step: 0.5,
    current_temperature: 20,
    temperature: 20,
    hvac_action: 'idle',
  });
  const siblings: EntitySpec[] = o.tuya
    ? [
        ent(`number.${o.base}_local_temperature_calibration`, 'local_temperature_calibration', 'calibration', 'Корекція температури', '0', { min: -9, max: 9, step: 1, mode: 'box', unit_of_measurement: C }, 'config'),
        ent(`sensor.${o.base}_position`, 'position', 'position', 'Відкриття клапана', '0', measurement('%', null, { icon: 'mdi:valve' })),
        ent(`switch.${o.base}_child_lock`, 'child_lock', 'child_lock', 'Блокування від дітей', 'on', {}, 'config'),
        ent(`switch.${o.base}_window_detection`, 'window_detection', 'window_detection', 'Відкрите вікно', 'off', {}, 'config'),
      ]
    : [
        ent(`number.${o.base}_external_temperature_input`, 'external_temperature_input', 'external_temp', 'Зовнішня температура', '20', { min: 0, max: 99.9, step: 0.1, mode: 'box', unit_of_measurement: C }, 'config'),
        ent(`select.${o.base}_temperature_sensor_select`, 'temperature_sensor_select', 'sensor_select', 'Вибір датчика', 'external', { options: ['internal', 'external', 'external_2', 'external_3'] }, 'config'),
        ent(`number.${o.base}_local_temperature_calibration`, 'local_temperature_calibration', 'calibration', 'Корекція температури', '0', { min: -7, max: 7, step: 0.2, mode: 'box', unit_of_measurement: C }, 'config'),
        ent(`number.${o.base}_valve_opening_degree`, 'valve_opening_degree', 'valve_opening', 'Відкриття клапана, макс.', '100', { min: 0, max: 100, step: 1, mode: 'box', unit_of_measurement: '%' }, 'config'),
        ent(`number.${o.base}_valve_closing_degree`, 'valve_closing_degree', 'valve_closing', 'Закриття клапана, мін.', '0', { min: 0, max: 100, step: 1, mode: 'box', unit_of_measurement: '%' }, 'config'),
        ent(`switch.${o.base}_child_lock`, 'child_lock', 'child_lock', 'Блокування від дітей', 'on', {}, 'config'),
        ent(`switch.${o.base}_open_window`, 'open_window', 'window_detection', 'Відкрите вікно', 'off', {}, 'config'),
      ];
  return {
    id: `dev_${o.base}`,
    name: o.base,
    label: o.label,
    area: areaOfRoom(o.room),
    model: o.tuya ? 'Tuya TS0601' : 'SONOFF TRVZB',
    manufacturer: o.tuya ? 'Tuya' : 'SONOFF',
    zigbee: { instance: o.instance, ieee: ieee(o.tuya ? 'tuya' : 'sonoff'), lqi: o.lqi, mains: false, batteryPct: o.battery, drainPerDay: 0.05 },
    integration: null,
    binding: { kind: 'trv', room: o.room, emitter: o.emitter ?? 'radiator', hotOffsetC: o.hotOffsetC ?? 2.4, gain: o.gain ?? 1, tuya: !!o.tuya },
    entities: [climate, ...siblings, ...linkEntities(o.base, o.battery)],
  };
}

interface ThermoOpts {
  base: string;
  label: string;
  room: RoomKey | null;
  model: 'SONOFF SNZB-02D' | 'Aqara WSDCGQ11LM' | 'SONOFF SNZB-02';
  instance: 1 | 2;
  lqi: number;
  battery: number;
  biasC?: number;
  rhBias?: number;
  radiatorBiasC?: number;
  drainPerDay?: number;
}

function thermo(o: ThermoOpts): DeviceSpec {
  const aqara = o.model.startsWith('Aqara');
  return {
    id: `dev_${o.base}`,
    name: o.base,
    label: o.label,
    area: o.room ? areaOfRoom(o.room) : 'garazh',
    model: o.model,
    manufacturer: aqara ? 'Aqara' : 'SONOFF',
    zigbee: { instance: o.instance, ieee: ieee(aqara ? 'aqara' : 'sonoff'), lqi: o.lqi, mains: false, batteryPct: o.battery, drainPerDay: o.drainPerDay ?? 0.03 },
    integration: null,
    binding: o.room ? { kind: 'thermo', room: o.room, biasC: o.biasC ?? 0, rhBias: o.rhBias ?? 0, radiatorBiasC: o.radiatorBiasC ?? 0 } : { kind: 'spare' },
    entities: [
      ent(`sensor.${o.base}_temperature`, 'temperature', 'temperature', 'Температура', '20', measurement(C, 'temperature')),
      ent(`sensor.${o.base}_humidity`, 'humidity', 'humidity', 'Вологість', '50', measurement('%', 'humidity')),
      ...linkEntities(o.base, o.battery),
    ],
  };
}

function contact(entityId: string, base: string, label: string, room: RoomKey, kind: 'window' | 'door', model: 'Aqara MCCGQ11LM' | 'SONOFF SNZB-04', instance: 1 | 2, lqi: number, battery: number): DeviceSpec {
  const aqara = model.startsWith('Aqara');
  return {
    id: `dev_${base}`,
    name: base,
    label,
    area: areaOfRoom(room),
    model,
    manufacturer: aqara ? 'Aqara' : 'SONOFF',
    zigbee: { instance, ieee: ieee(aqara ? 'aqara' : 'sonoff'), lqi, mains: false, batteryPct: battery, drainPerDay: 0.02 },
    integration: null,
    binding: { kind: 'contact', room, contact: kind },
    entities: [ent(entityId, 'contact', 'contact', null, 'off', { device_class: kind }), ...linkEntities(base, battery)],
  };
}

function zigbeeRelay(base: string, label: string, area: string, target: RelayTarget, model: string, instance: 1 | 2, lqi: number, powerW: number, withPower: boolean): DeviceSpec {
  const entities = [ent(`switch.${base}`, 'switch', 'switch', null, 'off')];
  if (withPower) entities.push(ent(`sensor.${base}_power`, 'power', 'power', 'Потужність', '0', measurement('W', 'power')));
  return {
    id: `dev_${base}`,
    name: base,
    label,
    area,
    model,
    manufacturer: 'SONOFF',
    zigbee: { instance, ieee: ieee('sonoff'), lqi, mains: true, batteryPct: null, drainPerDay: 0 },
    integration: null,
    binding: { kind: 'relay', target, powerW },
    entities: [...entities, ...linkEntities(base, null)],
  };
}

function wifiRelay(base: string, label: string, area: string, target: RelayTarget, powerW: number, withPower: boolean): DeviceSpec {
  const entities = [ent(`switch.${base}`, 'switch', 'switch', null, 'off')];
  if (withPower) entities.push(ent(`sensor.${base}_power`, 'power', 'power', 'Потужність', '0', measurement('W', 'power')));
  return { id: `dev_${base}`, name: base, label, area, model: 'Shelly Plus 1PM', manufacturer: 'Shelly', zigbee: null, integration: 'shelly', binding: { kind: 'relay', target, powerW }, entities };
}

function ac(base: string, room: RoomKey, label: string): DeviceSpec {
  return {
    id: `dev_${base}`,
    name: base,
    label,
    area: areaOfRoom(room),
    model: 'спліт-система',
    manufacturer: 'Midea',
    zigbee: null,
    integration: 'midea_ac_lan',
    binding: { kind: 'ac', room },
    entities: [
      ent(`climate.${base}`, 'climate', 'climate', null, 'off', {
        hvac_modes: ['off', 'heat', 'cool', 'dry', 'fan_only'],
        fan_modes: ['auto', 'quiet', 'low', 'medium', 'high'],
        fan_mode: 'auto',
        min_temp: 16,
        max_temp: 30,
        target_temp_step: 0.5,
        current_temperature: 21,
        temperature: 24,
        hvac_action: 'off',
      }),
      ent(`sensor.${base}_power`, 'power', 'power', 'Потужність', '0', measurement('W', 'power')),
    ],
  };
}

/* ── the demo house ────────────────────────────────────────────────────────────────────────────── */

function buildDevices(): DeviceSpec[] {
  ieeeSeq = 0;
  return [
    // radiator heads
    trv({ base: 'living_trv_window', label: 'Радіатор під вікном', room: 'living', instance: 1, lqi: 156, battery: 82, hotOffsetC: 2.8 }),
    trv({ base: 'living_trv_door', label: 'Радіатор біля дверей', room: 'living', instance: 1, lqi: 132, battery: 57, hotOffsetC: 2.0 }),
    trv({ base: 'bedroom_trv', label: 'Радіатор', room: 'bedroom', instance: 1, lqi: 98, battery: 74 }),
    trv({ base: 'kids_trv', label: 'Радіатор', room: 'kids', instance: 2, lqi: 71, battery: 63, tuya: true }),
    trv({ base: 'study_trv', label: 'Радіатор', room: 'study', instance: 1, lqi: 120, battery: 90 }),
    trv({ base: 'bathroom_towel_trv', label: 'Рушникосушка', room: 'bath', emitter: 'towel', instance: 2, lqi: 54, battery: 41, gain: 0.6, hotOffsetC: 3.2 }),
    // thermometers
    thermo({ base: 'living_sofa', label: 'Біля дивана', room: 'living', model: 'SONOFF SNZB-02D', instance: 1, lqi: 140, battery: 76, biasC: -0.1 }),
    thermo({ base: 'living_tv', label: 'Полиця біля ТВ', room: 'living', model: 'Aqara WSDCGQ11LM', instance: 1, lqi: 110, battery: 88, rhBias: -1 }),
    thermo({ base: 'living_window', label: 'Біля вікна, над радіатором', room: 'living', model: 'Aqara WSDCGQ11LM', instance: 1, lqi: 102, battery: 69, radiatorBiasC: 1.1, rhBias: 1 }),
    thermo({ base: 'bedroom_bed', label: 'Над ліжком', room: 'bedroom', model: 'SONOFF SNZB-02D', instance: 1, lqi: 115, battery: 81, biasC: -0.2, rhBias: 0.5 }),
    thermo({ base: 'bedroom_chest', label: 'Комод', room: 'bedroom', model: 'Aqara WSDCGQ11LM', instance: 1, lqi: 90, battery: 55, biasC: 0.2, rhBias: -0.5 }),
    thermo({ base: 'kids_desk', label: 'Стіл', room: 'kids', model: 'SONOFF SNZB-02D', instance: 2, lqi: 99, battery: 64 }),
    thermo({ base: 'study_desk', label: 'Стіл', room: 'study', model: 'Aqara WSDCGQ11LM', instance: 1, lqi: 118, battery: 72 }),
    thermo({ base: 'kitchen_shelf', label: 'Полиця', room: 'kitchen', model: 'Aqara WSDCGQ11LM', instance: 1, lqi: 63, battery: 33, biasC: 0.4 }),
    thermo({ base: 'kitchen_island', label: 'Острів', room: 'kitchen', model: 'SONOFF SNZB-02D', instance: 1, lqi: 132, battery: 85, rhBias: -0.5 }),
    thermo({ base: 'kitchen_window', label: 'Біля вікна', room: 'kitchen', model: 'Aqara WSDCGQ11LM', instance: 1, lqi: 101, battery: 77, biasC: -0.1, rhBias: 0.5 }),
    thermo({ base: 'bathroom', label: 'Стеля', room: 'bath', model: 'SONOFF SNZB-02D', instance: 2, lqi: 87, battery: 70 }),
    thermo({ base: 'hall', label: 'Вхід', room: 'hall', model: 'SONOFF SNZB-02', instance: 2, lqi: 92, battery: 12, drainPerDay: 0.8 }),
    // windows and doors
    contact('binary_sensor.living_window_left', 'living_window_left', 'Вікно ліве', 'living', 'window', 'Aqara MCCGQ11LM', 1, 128, 91),
    contact('binary_sensor.terrace_door', 'terrace_door', 'Двері на терасу', 'living', 'door', 'Aqara MCCGQ11LM', 1, 117, 86),
    contact('binary_sensor.bedroom_window', 'bedroom_window', 'Вікно', 'bedroom', 'window', 'SONOFF SNZB-04', 1, 104, 79),
    contact('binary_sensor.kids_window', 'kids_window', 'Вікно', 'kids', 'window', 'SONOFF SNZB-04', 2, 96, 83),
    // boiler room relays
    {
      id: 'dev_boiler_relay',
      name: 'boiler_relay',
      label: 'Реле котла · сухий контакт',
      area: 'kotelnia',
      model: 'Zigbee-реле',
      manufacturer: 'SONOFF',
      zigbee: { instance: 1, ieee: ieee('sonoff'), lqi: 141, mains: true, batteryPct: null, drainPerDay: 0 },
      integration: null,
      binding: { kind: 'boiler' },
      entities: [
        ent('switch.boiler_relay', 'switch', 'switch', null, 'off'),
        ent('number.boiler_relay_countdown', 'countdown', 'countdown', 'Вимкнути через', '0', { min: 0, max: 120, step: 1, mode: 'box', unit_of_measurement: 'min' }, 'config'),
        ent('binary_sensor.boiler_flame', 'flame', 'flame', 'Полум’я', 'off', { device_class: 'heat' }),
        ...linkEntities('boiler_relay', null),
      ],
    },
    zigbeeRelay('radiator_pump', 'Насос радіаторів', 'kotelnia', 'pump_radiators', 'Zigbee-реле', 1, 128, 45, false),
    zigbeeRelay('floor_heating_pump', 'Насос теплої підлоги', 'kotelnia', 'pump_floor_a', 'Zigbee-реле', 1, 137, 40, false),
    zigbeeRelay('study_heater', 'Конвектор · розетка', 'kabinet', 'convector', 'Zigbee-розетка 16 А', 1, 118, 1500, true),
    wifiRelay('floor_pump_b', 'Насос підлоги · резерв', 'kotelnia', 'pump_floor_b', 40, false),
    wifiRelay('manifold_pump', 'Насос колектора', 'kotelnia', 'pump_manifold', 60, false),
    wifiRelay('dehumidifier_living', 'Осушувач', 'vitalnia', 'dehumidifier', 250, true),
    // climate sources through HA integrations
    {
      id: 'dev_heat_pump',
      name: 'heat_pump',
      label: 'Тепловий насос',
      area: 'kotelnia',
      model: 'повітря — вода',
      manufacturer: 'Panasonic',
      zigbee: null,
      integration: 'modbus',
      binding: { kind: 'heat_pump' },
      entities: [
        ent('climate.heat_pump', 'climate', 'climate', null, 'off', {
          hvac_modes: ['off', 'heat', 'cool'],
          min_temp: 18,
          max_temp: 55,
          target_temp_step: 0.5,
          current_temperature: 25,
          temperature: 38,
          hvac_action: 'off',
        }),
        ent('binary_sensor.heat_pump_compressor', 'compressor', 'compressor', 'Компресор', 'off', { device_class: 'running' }),
        ent('binary_sensor.heat_pump_defrost', 'defrost', 'defrost', 'Відтавання', 'off', {}),
        ent('sensor.heat_pump_power', 'power', 'power', 'Потужність', '0', measurement('W', 'power')),
        ent('sensor.heat_pump_cop', 'cop', 'cop', 'COP', '0', { state_class: 'measurement', icon: 'mdi:gauge' }),
        ent('sensor.heat_pump_energy', 'energy', 'energy_meter', 'Спожита енергія', '0', counter('kWh', 'energy')),
        ent('sensor.heat_pump_heat_energy', 'heat_energy', 'heat_meter', 'Вироблене тепло', '0', counter('kWh', 'energy')),
        ent('sensor.heat_pump_supply', 'supply', 'supply', 'Подача', '25', measurement(C, 'temperature')),
        ent('sensor.heat_pump_error_code', 'error', 'error', 'Код помилки', '0', { icon: 'mdi:alert-circle-outline' }, 'diagnostic'),
      ],
    },
    // a pulse counter on the house gas meter: the boiler and the kitchen stove
    {
      id: 'dev_gas_meter',
      name: 'gas_meter',
      label: 'Лічильник газу',
      area: 'kotelnia',
      model: 'ESP32 · імпульсний лічильник',
      manufacturer: 'Espressif',
      zigbee: null,
      integration: 'esphome',
      binding: { kind: 'gas_meter' },
      entities: [
        ent('sensor.gas_meter', 'gas_consumption', 'gas_meter', null, '0', { ...counter('m³', 'gas'), icon: 'mdi:meter-gas' }),
        // the same count the way other installs report it: in cubic feet, as energy, and as a template
        // sensor without a state class (HA keeps no statistics for it)
        ent('sensor.gas_meter_ft3', 'gas_ft3', 'gas_meter', 'Газ, фут³', '0', { ...counter('ft³', 'gas'), icon: 'mdi:meter-gas' }),
        ent('sensor.gas_meter_energy', 'gas_energy', 'gas_meter', 'Енергія газу', '0', { ...counter('kWh', 'gas'), icon: 'mdi:meter-gas' }),
        ent('sensor.gas_meter_template', 'gas_template', 'gas_meter', 'Показник газу (шаблон)', '0', { device_class: 'gas', unit_of_measurement: 'm³', icon: 'mdi:meter-gas' }),
      ],
    },
    ac('living_ac', 'living', 'Кондиціонер у вітальні'),
    ac('bedroom_ac', 'bedroom', 'Кондиціонер у спальні'),
    ac('kids_ac', 'kids', 'Кондиціонер у дитячій'),
    {
      id: 'dev_manifold',
      name: 'manifold',
      label: 'Колектор',
      area: 'kotelnia',
      model: 'ESP32 · колектор',
      manufacturer: 'Espressif',
      zigbee: null,
      integration: 'esphome',
      binding: { kind: 'manifold' },
      entities: [
        ent('number.floor_mixing_valve', 'mixing_valve', 'mixing_valve', 'Змішувальний клапан підлоги', '35', { min: 20, max: 55, step: 0.5, mode: 'box', unit_of_measurement: C }),
        ent('sensor.manifold_supply_temperature', 'supply_temperature', 'manifold_supply', 'Подача', '25', measurement(C, 'temperature')),
        ent('sensor.manifold_return_temperature', 'return_temperature', 'manifold_return', 'Обратка', '24', measurement(C, 'temperature')),
        ent('sensor.floor_supply_temperature', 'floor_supply_temperature', 'floor_supply', 'Подача підлоги', '25', measurement(C, 'temperature')),
      ],
    },
    {
      id: 'dev_weather_station',
      name: 'weather_station',
      label: 'Метеостанція',
      area: null,
      model: 'ESP32 · метеостанція',
      manufacturer: 'Espressif',
      zigbee: null,
      integration: 'esphome',
      binding: { kind: 'outdoor' },
      entities: [
        ent('sensor.outdoor_temperature', 'outdoor_temperature', 'outdoor_temp', 'Температура надворі', '5', measurement(C, 'temperature')),
        ent('sensor.outdoor_humidity', 'outdoor_humidity', 'outdoor_humidity', 'Вологість надворі', '80', measurement('%', 'humidity')),
      ],
    },
    {
      id: 'dev_inverter',
      name: 'inverter',
      label: 'Інвертор',
      area: 'kotelnia',
      model: 'SUN-8K-SG04LP3',
      manufacturer: 'Deye',
      zigbee: null,
      integration: 'solarman',
      binding: { kind: 'energy' },
      entities: [
        ent('binary_sensor.grid_offline', 'grid_offline', 'grid_offline', 'Немає мережі', 'off', { device_class: 'problem' }),
        ent('sensor.pv_power', 'pv_power', 'pv', 'Сонячні панелі', '0', measurement('W', 'power')),
        ent('sensor.house_load', 'house_load', 'load', 'Споживання будинку', '0', measurement('W', 'power')),
        ent('sensor.battery_soc', 'battery_soc', 'soc', 'Заряд батареї', '80', measurement('%', 'battery')),
      ],
    },
    // Zigbee2MQTT bridges
    bridge(1),
    bridge(2),
    // phones (mobile_app)
    phone('phone', 'Phone', 'device_tracker.phone', 'person.ihor', 'Pixel 8'),
    phone('kitchen_tablet', 'Kitchen Tablet', 'device_tracker.kitchen_tablet', 'person.olia', 'Galaxy Tab A9'),
    // the garage: found, not used by Klimo yet
    {
      ...trv({ base: 'garage_trv', label: 'Головка в гаражі', room: 'study', instance: 1, lqi: 88, battery: 95 }),
      area: 'garazh',
      binding: { kind: 'spare' },
    },
    thermo({ base: 'garage', label: 'Датчик у гаражі', room: null, model: 'SONOFF SNZB-02', instance: 1, lqi: 76, battery: 64 }),
    zigbeeRelay('garage_plug', 'Розетка в гаражі', 'garazh', 'garage_plug', 'Zigbee-розетка 16 А', 2, 101, 0, true),
    // a thermostat paired but never put into an area: only its Zigbee2MQTT name finds it
    { ...trv({ base: 'zig_thermostat_office', label: 'zig_thermostat_office', room: 'study', instance: 2, lqi: 94, battery: 88, tuya: true }), area: null, binding: { kind: 'spare' } },
    // a second outdoor thermometer, on the south-west wall: the afternoon sun warms it
    { ...thermo({ base: 'south_wall', label: 'Південна стіна', room: null, model: 'SONOFF SNZB-02D', instance: 2, lqi: 83, battery: 78 }), area: null, binding: { kind: 'sunny_wall' } },
  ];
}

function bridge(n: 1 | 2): DeviceSpec {
  const base = n === 1 ? 'zigbee2mqtt' : 'zigbee2mqtt_2';
  return {
    id: `dev_${base}_bridge`,
    name: `Zigbee2MQTT Bridge${n === 2 ? ' 2' : ''}`,
    label: `Z2M #${n}`,
    area: null,
    model: 'Bridge',
    manufacturer: 'Zigbee2MQTT',
    zigbee: null,
    integration: 'mqtt',
    binding: { kind: 'bridge', instance: n },
    entities: [ent(`binary_sensor.${base}_bridge_connection_state`, 'connection_state', 'bridge', 'Стан з’єднання', 'on', { device_class: 'connectivity' }, 'diagnostic')],
  };
}

function phone(base: string, name: string, tracker: string, personId: string, model: string): DeviceSpec {
  return {
    id: `dev_mobile_${base}`,
    name,
    label: name,
    area: null,
    model,
    manufacturer: 'Google',
    zigbee: null,
    integration: 'mobile_app',
    binding: { kind: 'phone', personId },
    entities: [ent(tracker, 'device_tracker', 'tracker', null, 'home', { source_type: 'gps' })],
  };
}

/**
 * Zigbee2MQTT ≥ 2.0 adds the link quality entity to HA disabled, and most people leave it so. These
 * devices do: Klimo learns their link quality from Zigbee2MQTT's MQTT messages, or — with the attribute
 * filtered out in Zigbee2MQTT — not at all.
 */
const LINK_MODES: Readonly<Record<string, 'mqtt' | 'none'>> = {
  dev_living_window_left: 'mqtt',
  dev_terrace_door: 'mqtt',
  dev_bedroom_window: 'mqtt',
  dev_living_tv: 'mqtt',
  dev_kitchen_shelf: 'mqtt',
  dev_kids_window: 'none',
  dev_hall: 'none',
};

function withLinkMode(d: DeviceSpec): DeviceSpec {
  const link = LINK_MODES[d.id];
  if (!link || !d.zigbee) return d;
  return { ...d, zigbee: { ...d.zigbee, link }, entities: d.entities.map((e) => (e.role === 'linkquality' ? { ...e, disabled: true } : e)) };
}

export const DEVICES: readonly DeviceSpec[] = buildDevices().map(withLinkMode);

const byEntity = new Map<string, { device: DeviceSpec; entity: EntitySpec }>();
for (const d of DEVICES) for (const e of d.entities) byEntity.set(e.entityId, { device: d, entity: e });

export function deviceOfEntity(entityId: string): DeviceSpec | undefined {
  return byEntity.get(entityId)?.device;
}

export function entitySpec(entityId: string): EntitySpec | undefined {
  return byEntity.get(entityId)?.entity;
}

export function entityOfRole(device: DeviceSpec, role: EntityRole): EntitySpec | undefined {
  return device.entities.find((e) => e.role === role);
}

export function devicesOfRoom(room: RoomKey): DeviceSpec[] {
  return DEVICES.filter((d) => 'room' in d.binding && d.binding.room === room);
}

export function z2mBase(instance: 1 | 2): string {
  return instance === 1 ? 'zigbee2mqtt' : 'zigbee2mqtt_2';
}

/** Persons, users and the other entities that belong to no device. */
export const USERS = [
  { id: 'u_ihor', name: 'Ігор', is_admin: true, system_generated: false },
  { id: 'u_olia', name: 'Оля', is_admin: false, system_generated: false },
  { id: 'u_supervisor', name: 'Supervisor', is_admin: true, system_generated: true },
] as const;

export const PERSONS = [
  { entityId: 'person.ihor', name: 'Ігор', userId: 'u_ihor', tracker: 'device_tracker.phone' },
  { entityId: 'person.olia', name: 'Оля', userId: 'u_olia', tracker: 'device_tracker.kitchen_tablet' },
] as const;

export const HOME = { latitude: 50.4501, longitude: 30.5234, elevation: 179 };

/** Z2M unique id convention: `0x<ieee>_<property>_zigbee2mqtt`. */
export function uniqueId(d: DeviceSpec, e: EntitySpec): string {
  if (d.zigbee) return `${d.zigbee.ieee}_${e.key}_zigbee2mqtt`;
  return `${d.integration ?? 'sim'}_${d.name}_${e.key}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
}

/** Device and entity registries of the demo house (Klimo's own MQTT entities are added by discovery). */
export function demoRegistries(): HaRegistries {
  const bridgeIds = new Map<1 | 2, string>(DEVICES.filter((d) => d.binding.kind === 'bridge').map((d) => [(d.binding as { instance: 1 | 2 }).instance, d.id]));
  const devices: HaRegistries['devices'] = DEVICES.map((d) => ({
    id: d.id,
    name: d.name,
    name_by_user: d.label !== d.name ? d.label : null,
    area_id: d.area,
    model: d.model,
    manufacturer: d.manufacturer,
    identifiers: d.zigbee
      ? [['mqtt', `zigbee2mqtt_${d.zigbee.ieee}`]]
      : d.binding.kind === 'bridge'
        ? [['mqtt', `zigbee2mqtt_bridge_${d.binding.instance === 1 ? '0x00124b0029f1a2b3' : '0x00124b0031c4d5e6'}`]]
        : [[d.integration ?? 'sim', d.name]],
    via_device_id: d.zigbee ? bridgeIds.get(d.zigbee.instance) ?? null : null,
  }));
  const entities: HaRegistries['entities'] = [];
  for (const d of DEVICES) {
    for (const e of d.entities) {
      entities.push({
        entity_id: e.entityId,
        device_id: d.id,
        area_id: null,
        platform: d.zigbee || d.binding.kind === 'bridge' ? 'mqtt' : d.integration ?? 'sim',
        unique_id: uniqueId(d, e),
        disabled_by: e.disabled ? 'integration' : null,
        hidden_by: null,
        original_name: e.name,
        name: null,
        entity_category: e.category,
      });
    }
  }
  return {
    areas: AREAS.map((a) => ({ area_id: a.id, name: a.name })),
    devices,
    entities,
  };
}

/** Friendly name the way HA composes it: device (user) name + entity name. */
export function friendlyName(d: DeviceSpec, e: EntitySpec): string {
  return e.name ? `${d.label} ${e.name}` : d.label;
}
