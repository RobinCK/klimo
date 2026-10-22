import {
  batteryLowCondition,
  blackoutCondition,
  DEFAULT_CIRCUIT,
  DEFAULT_EMITTER,
  DEFAULT_EMITTER_DEVICE,
  DEFAULT_MANIFOLD,
  DEFAULT_PUMP,
  DEFAULT_ROOM,
  DEFAULT_SENSOR,
  DEFAULT_TARGET,
  deepClone,
  economyRule,
  nightTariffCondition,
  newSourceConfig,
  preheatNightRule,
  solarCondition,
  storeHeatRule,
  type EnergyBindings,
} from '../shared/defaults';
import type {
  ActivationRule,
  Circuit,
  DayPlan,
  Emitter,
  EmitterDevice,
  EpochMs,
  ExportBundle,
  Id,
  Lang,
  Manifold,
  NotifyTarget,
  ProfileRoomSetting,
  Pump,
  RoomConfig,
  RoomSensor,
  Schedule,
  SourceConfig,
  TrvCapabilities,
  TrvSiblings,
  Z2mInstance,
} from '../shared/model';
import { DEVICES, entityOfRole, type DeviceSpec, type RoomKey } from './devices';
import { inSimLanguage } from './language';

/* =====================================================================================================
 * The demo house shown throughout the UI, as one configuration bundle imported into an empty database: seven
 * rooms with their sensors, heads and windows; a heat pump with a gas boiler in reserve on one manifold
 * with a radiator loop and a floor loop; three linked air conditioners and the study's convector that
 * waits for spare solar power; the blackout triggers and rules wired to the inverter; the household's
 * notification targets. Ids are fixed so scenarios, tests and screenshots can refer to them.
 * ===================================================================================================== */

export const ROOM_IDS: Record<RoomKey, Id> = {
  living: 'r_living',
  bedroom: 'r_bedroom',
  kids: 'r_kids',
  study: 'r_study',
  kitchen: 'r_kitchen',
  bath: 'r_bath',
  hall: 'r_hall',
};

export const SOURCE_IDS = {
  heatPump: 's_heatpump',
  boiler: 's_boiler',
  acLiving: 's_ac_living',
  acBedroom: 's_ac_bedroom',
  acKids: 's_ac_kids',
  convector: 's_convector',
} as const;

export const CIRCUIT_IDS = { radiators: 'c_radiators', floor: 'c_floor' } as const;
export const MANIFOLD_ID = 'm_main';
export const PUMP_IDS = { radiators: 'p_radiators', floorA: 'p_floor_a', floorB: 'p_floor_b', manifold: 'p_manifold' } as const;
export const Z2M_IDS = { 1: 'z2m1', 2: 'z2m2' } as const;

export const ENERGY_ENTITIES: EnergyBindings = {
  gridOffline: 'binary_sensor.grid_offline',
  pvPower: 'sensor.pv_power',
  houseLoad: 'sensor.house_load',
  batterySoc: 'sensor.battery_soc',
  tariff: null,
};

export const roomKeyOf = (roomId: Id): RoomKey | null => (Object.entries(ROOM_IDS).find(([, id]) => id === roomId)?.[0] as RoomKey | undefined) ?? null;

interface RoomPlan {
  key: RoomKey;
  slug: string;
  name: string;
  icon: RoomConfig['icon'];
  heat: [number, number];
  cool?: [number, number];
  patch?: (r: RoomConfig) => void;
}

const ROOMS: RoomPlan[] = [
  {
    key: 'living',
    slug: 'vitalnia',
    name: 'Вітальня',
    icon: 'sofa',
    heat: [0.2, 0.2],
    patch: (r) => {
      r.humidity.dehumidifier = { entityId: 'switch.dehumidifier_living', onAbovePct: 62, offBelowPct: 57, minOnMin: 10 };
      r.humidity.airingHint = 'auto_pause';
      r.sunnySide = true;
    },
  },
  { key: 'bedroom', slug: 'spalnia', name: 'Спальня', icon: 'bed', heat: [0.3, 0.3] },
  { key: 'kids', slug: 'dytiacha', name: 'Дитяча', icon: 'kids', heat: [0.3, 0.2], patch: (r) => (r.trv.strategy = 'calibration') },
  { key: 'study', slug: 'kabinet', name: 'Кабінет', icon: 'desk', heat: [0.3, 0.3] },
  { key: 'kitchen', slug: 'kukhnia', name: 'Кухня', icon: 'kitchen', heat: [0.5, 0.3] },
  { key: 'bath', slug: 'vanna', name: 'Ванна', icon: 'bath', heat: [0.2, 0.2], patch: (r) => (r.windows.tempDrop.enabled = false) },
  { key: 'hall', slug: 'korydor', name: 'Коридор', icon: 'hall', heat: [0.5, 0.3] },
];

const block = (start: number, end: number, profileId: Id) => ({ start, end, profileId });

/** The kids go to bed at nine: the room switches to «Ніч» two hours before the rest of the house. */
function kidsDays(): DayPlan[] {
  const weekday = (): DayPlan => [block(0, 420, 'night'), block(420, 510, 'home'), block(510, 900, 'away'), block(900, 1260, 'home'), block(1260, 1440, 'night')];
  const weekend = (): DayPlan => [block(0, 510, 'night'), block(510, 1260, 'home'), block(1260, 1440, 'night')];
  return [weekday(), weekday(), weekday(), weekday(), weekday(), weekend(), weekend()];
}

const PROFILE_ROOMS: [Id, RoomKey, 'own' | 'off', number | null, number | null][] = [
  ['home', 'living', 'own', 20, null],
  ['home', 'bedroom', 'own', 19, 24],
  ['home', 'kids', 'own', 22, 24.5],
  ['home', 'kitchen', 'own', null, 26],
  ['home', 'bath', 'own', 24, 26],
  ['home', 'hall', 'own', 19, 26],
  ['away', 'study', 'off', null, null],
  ['away', 'bath', 'own', 20, null],
  ['night', 'living', 'own', 18, null],
  ['night', 'bedroom', 'own', 19, 24],
  ['guests', 'study', 'own', 21, null],
];

const zigbeeTransport = (d: DeviceSpec): EmitterDevice['transport'] =>
  d.zigbee ? { type: 'z2m', instanceId: Z2M_IDS[d.zigbee.instance], friendlyName: d.name, ieee: d.zigbee.ieee } : { type: 'ha', integration: d.integration, network: null };

function trvCapabilities(d: DeviceSpec): TrvCapabilities {
  const tuya = d.binding.kind === 'trv' && d.binding.tuya;
  return tuya
    ? { externalSensor: false, calibration: true, calibrationRange: [-9, 9], valveLimits: false, valvePosition: true, childLock: true, windowDetection: true, setpointRange: [5, 35], setpointStep: 0.5 }
    : { externalSensor: true, calibration: true, calibrationRange: [-7, 7], valveLimits: true, valvePosition: false, childLock: true, windowDetection: true, setpointRange: [4, 35], setpointStep: 0.5 };
}

function trvSiblings(d: DeviceSpec): TrvSiblings {
  const id = (role: Parameters<typeof entityOfRole>[1]) => entityOfRole(d, role)?.entityId ?? null;
  return {
    externalTemp: id('external_temp'),
    sensorSelect: id('sensor_select'),
    calibration: id('calibration'),
    valveOpening: id('valve_opening'),
    valveClosing: id('valve_closing'),
    childLock: id('child_lock'),
    windowDetection: id('window_detection'),
    battery: id('battery'),
    linkquality: id('linkquality'),
    valvePosition: id('position'),
  };
}

const roomDevices = (key: RoomKey, kind: DeviceSpec['binding']['kind']) => DEVICES.filter((d) => d.binding.kind === kind && 'room' in d.binding && d.binding.room === key);

/**
 * The demo house on top of the first-boot seed (profiles, house schedule, triggers, rules, defaults),
 * named in Ukrainian or, with `lang: 'en'`, in English.
 */
export function buildDemoHouse(base: ExportBundle, now: EpochMs, lang: Lang = 'uk'): ExportBundle {
  const b = deepClone(base);
  b.exportedAt = now;

  b.settings = {
    ...b.settings,
    houseName: 'Дім',
    notificationLanguage: lang,
    outdoor: { ...b.settings.outdoor, sensorEntityId: 'sensor.outdoor_temperature', weatherEntityId: 'weather.home' },
    presence: { ...b.settings.presence, personEntityIds: ['person.ihor', 'person.olia'] },
    onboardingDismissed: true,
    updatedAt: now,
  };

  /* rooms, sensors, emitters, heads */
  const rooms: RoomConfig[] = [];
  const sensors: RoomSensor[] = [];
  const emitters: Emitter[] = [];
  const heads: EmitterDevice[] = [];
  ROOMS.forEach((plan, order) => {
    const id = ROOM_IDS[plan.key];
    const thermos = roomDevices(plan.key, 'thermo');
    const r: RoomConfig = {
      ...DEFAULT_ROOM(undefined, thermos.length),
      id,
      slug: plan.slug,
      name: plan.name,
      order,
      icon: plan.icon,
      haAreaId: DEVICES.find((d) => 'room' in d.binding && d.binding.room === plan.key)?.area ?? null,
      createdAt: now,
      updatedAt: now,
    };
    r.tolerance.heat = { below: plan.heat[0], above: plan.heat[1] };
    if (plan.cool) r.tolerance.cool = { below: plan.cool[0], above: plan.cool[1] };
    plan.patch?.(r);
    rooms.push(r);

    let so = 0;
    for (const d of thermos) {
      const weight = d.binding.kind === 'thermo' && d.binding.radiatorBiasC > 0 ? 0.5 : 1.0;
      for (const role of ['temperature', 'humidity'] as const) {
        sensors.push({ ...DEFAULT_SENSOR(), id: `rs_${d.name}_${role === 'temperature' ? 't' : 'h'}`, roomId: id, entityId: entityOfRole(d, role)!.entityId, role, name: d.label, model: d.model, haDeviceId: d.id, weight: role === 'temperature' ? weight : 1, order: so++ });
      }
    }
    for (const d of roomDevices(plan.key, 'contact')) {
      const contact = d.binding.kind === 'contact' ? d.binding.contact : 'window';
      sensors.push({ ...DEFAULT_SENSOR(), id: `rs_${d.name}`, roomId: id, entityId: entityOfRole(d, 'contact')!.entityId, role: 'contact', contactKind: contact, name: d.label, model: d.model, haDeviceId: d.id, order: so++ });
    }

    let eo = 0;
    const trvs = roomDevices(plan.key, 'trv');
    const radiators = trvs.filter((d) => d.binding.kind === 'trv' && d.binding.emitter === 'radiator');
    const towel = trvs.filter((d) => d.binding.kind === 'trv' && d.binding.emitter === 'towel');
    const addHydronic = (kind: Emitter['kind'], name: string, circuitId: Id, roles: Emitter['roles'], devs: DeviceSpec[], extra: Partial<Emitter> = {}) => {
      const e: Emitter = { ...DEFAULT_EMITTER(), id: `e_${plan.key}_${kind}`, roomId: id, kind, name, order: eo++, circuitId, roles, ...extra };
      emitters.push(e);
      devs.forEach((d, i) =>
        heads.push({
          ...DEFAULT_EMITTER_DEVICE(),
          id: `d_${d.name}`,
          emitterId: e.id,
          roomId: id,
          kind: 'trv',
          entityId: entityOfRole(d, 'climate')!.entityId,
          name: d.label,
          label: kind === 'towel_rail' ? 'рушникосушка' : null,
          haDeviceId: d.id,
          model: d.model,
          manufacturer: d.manufacturer,
          transport: zigbeeTransport(d),
          capabilities: trvCapabilities(d),
          siblings: trvSiblings(d),
          order: i,
        }),
      );
    };
    if (radiators.length) {
      const n = radiators.length;
      addHydronic('radiator', n > 1 ? `Радіатори · ${n} головки` : 'Радіатор', CIRCUIT_IDS.radiators, { heat: 'primary', cool: null }, radiators);
    }
    if (towel.length) addHydronic('towel_rail', 'Рушникосушка', CIRCUIT_IDS.radiators, { heat: 'primary', cool: null }, towel);
    if (plan.key === 'kitchen' || plan.key === 'hall') addHydronic('floor', 'Тепла підлога', CIRCUIT_IDS.floor, { heat: 'primary', cool: 'primary' }, []);
    // the bathroom floor only heats: chilled water under a wet floor would sweat
    if (plan.key === 'bath') addHydronic('floor', 'Тепла підлога', CIRCUIT_IDS.floor, { heat: 'primary', cool: null }, [], { excludeFromCooling: true });

    const acSource = plan.key === 'living' ? SOURCE_IDS.acLiving : plan.key === 'bedroom' ? SOURCE_IDS.acBedroom : plan.key === 'kids' ? SOURCE_IDS.acKids : null;
    if (acSource) {
      emitters.push({ ...DEFAULT_EMITTER(), id: `e_${plan.key}_ac`, roomId: id, kind: 'direct', name: 'Кондиціонер', order: eo++, sourceId: acSource, roles: { heat: 'assist', cool: 'primary' }, assist: { deficitC: 1.5 } });
    }
    if (plan.key === 'study') {
      emitters.push({ ...DEFAULT_EMITTER(), id: 'e_study_convector', roomId: id, kind: 'direct', name: 'Електроконвектор', order: eo++, sourceId: SOURCE_IDS.convector, roles: { heat: 'trigger', cool: null }, trigger: { heatStoreAboveTargetC: 1.5 } });
    }
  });
  b.rooms = rooms;
  b.sensors = sensors;
  b.emitters = emitters;
  b.emitterDevices = heads;

  b.profileRooms = PROFILE_ROOMS.map(([profileId, key, mode, heatC, coolC]): ProfileRoomSetting => ({ profileId, roomId: ROOM_IDS[key], mode, heatC, coolC, writtenAt: null }));
  const kids: Schedule = { id: `room_${ROOM_IDS.kids}`, scope: 'room', roomId: ROOM_IDS.kids, enabled: true, days: kidsDays(), updatedAt: now };
  b.schedules = [...b.schedules.filter((s) => s.scope === 'house'), kids];

  const guests: ActivationRule = {
    id: 'ar_guests_calendar',
    profileId: 'guests',
    enabled: true,
    order: 1,
    config: { type: 'calendar', calendarEntityId: 'calendar.family', match: { field: 'summary', contains: 'Гості' }, preheatMin: 60 },
  };
  b.activationRules = [...b.activationRules.filter((a) => a.id !== guests.id), guests];

  /* sources */
  b.sources = demoSources(now);

  /* hydronics */
  const manifold: Manifold = { ...DEFAULT_MANIFOLD(), id: MANIFOLD_ID, name: 'Колектор', supplySensorEntityId: 'sensor.manifold_supply_temperature', returnSensorEntityId: 'sensor.manifold_return_temperature', order: 0 };
  const radiatorLoop: Circuit = {
    ...DEFAULT_CIRCUIT(),
    id: CIRCUIT_IDS.radiators,
    name: 'Контур радіаторів',
    shortName: 'Радіатори',
    kind: 'radiators',
    manifoldId: MANIFOLD_ID,
    sourceIds: [SOURCE_IDS.heatPump, SOURCE_IDS.boiler],
    capabilities: { heat: true, cool: false },
    supply: { sensorEntityId: 'sensor.manifold_supply_temperature', returnEntityId: 'sensor.manifold_return_temperature', coolC: 18, coolMaxC: 22 },
    flowSafety: true,
    order: 0,
  };
  const floorLoop: Circuit = {
    ...DEFAULT_CIRCUIT(),
    id: CIRCUIT_IDS.floor,
    name: 'Контур теплої підлоги',
    shortName: 'Тепла підлога',
    kind: 'floor',
    manifoldId: MANIFOLD_ID,
    sourceIds: [SOURCE_IDS.heatPump, SOURCE_IDS.boiler],
    capabilities: { heat: true, cool: true },
    supply: { sensorEntityId: 'sensor.floor_supply_temperature', returnEntityId: 'sensor.manifold_return_temperature', coolC: 18, coolMaxC: 22 },
    mixingValve: { entityId: 'number.floor_mixing_valve', heatC: 35, coolC: null },
    // two pumps take turns: one runs, the other waits as a standby (rotated weekly)
    pumpGroupMode: 'duty_standby',
    order: 1,
  };
  b.manifolds = [manifold];
  b.circuits = [radiatorLoop, floorLoop];
  const pump = (id: Id, name: string, entityId: string, patch: Partial<Pump>, order: number): Pump => ({ ...DEFAULT_PUMP(), id, name, entityId, order, ...patch });
  b.pumps = [
    pump(PUMP_IDS.radiators, 'Насос радіаторів', 'switch.radiator_pump', { circuitId: CIRCUIT_IDS.radiators, rule: 'rooms', runOnHeatMin: 3 }, 0),
    pump(PUMP_IDS.floorA, 'Насос теплої підлоги', 'switch.floor_heating_pump', { circuitId: CIRCUIT_IDS.floor, rule: 'source', runOnHeatMin: 10 }, 1),
    pump(PUMP_IDS.floorB, 'Насос підлоги · резерв', 'switch.floor_pump_b', { circuitId: CIRCUIT_IDS.floor, rule: 'source', runOnHeatMin: 10 }, 2),
    pump(PUMP_IDS.manifold, 'Насос колектора', 'switch.manifold_pump', { manifoldId: MANIFOLD_ID, rule: 'source', runOnHeatMin: 3, exercise: true }, 3),
  ];

  /* strategy */
  b.heatStrategy = {
    ...b.heatStrategy,
    chain: [
      { id: 'ce_heatpump', sourceIds: [SOURCE_IDS.heatPump], label: null, enabled: true },
      { id: 'ce_boiler', sourceIds: [SOURCE_IDS.boiler], label: null, enabled: true },
    ],
    bivalence: { mode: 'alt', pointC: -10, hysteresisC: 2, hpLimitC: -15 },
    lag: { enabled: true, deficitC: 1, forMin: 45, graceAfterStartMin: 30 },
    heatingCutoffOutdoorC: 15,
  };
  b.coolStrategy = {
    ...b.coolStrategy,
    chain: [
      { id: 'ce_acs', sourceIds: [SOURCE_IDS.acLiving, SOURCE_IDS.acBedroom, SOURCE_IDS.acKids], label: 'Кондиціонери', enabled: true },
      { id: 'ce_heatpump_cool', sourceIds: [SOURCE_IDS.heatPump], label: null, enabled: true },
    ],
  };

  /* energy, triggers and rules */
  b.energy = {
    ...b.energy,
    budgetKw: 4.0,
    shedOrder: [SOURCE_IDS.convector, SOURCE_IDS.acLiving, SOURCE_IDS.acBedroom, SOURCE_IDS.acKids, SOURCE_IDS.heatPump],
    shedOrderCustom: false,
    exempt: { sourceIds: [SOURCE_IDS.boiler], pumps: true, whileSocAbovePct: 20 },
    entities: { ...ENERGY_ENTITIES },
    activeWhen: { op: 'trigger', triggerId: 'blackout', id: 'energy_blackout' },
  };
  const conditions: Record<string, ExportBundle['triggers'][number]['condition']> = {
    blackout: blackoutCondition(ENERGY_ENTITIES),
    solar: solarCondition(ENERGY_ENTITIES),
    battery_low: batteryLowCondition(ENERGY_ENTITIES),
    night_tariff: nightTariffCondition(ENERGY_ENTITIES),
  };
  b.triggers = b.triggers.map((t) => (conditions[t.id] ? { ...t, condition: conditions[t.id], enabled: true } : t));
  const sets = {
    gasBoilers: [SOURCE_IDS.boiler],
    heatPumps: [SOURCE_IDS.heatPump],
    electricHeat: [SOURCE_IDS.heatPump, SOURCE_IDS.convector, SOURCE_IDS.acLiving, SOURCE_IDS.acBedroom, SOURCE_IDS.acKids],
  };
  const store = storeHeatRule('uk', sets, ENERGY_ENTITIES.batterySoc);
  store.effects = store.effects.map((e) => {
    if (e.type === 'target_offset') return { ...e, roomIds: [ROOM_IDS.living, ROOM_IDS.study, ROOM_IDS.kids] };
    if (e.type === 'allow_sources') return { ...e, modes: { [SOURCE_IDS.acLiving]: 'heat', [SOURCE_IDS.acBedroom]: 'heat', [SOURCE_IDS.acKids]: 'heat' } };
    return e;
  });
  b.rules = [economyRule('uk', sets, true), store, preheatNightRule('uk', sets, true)];

  /* notifications */
  const target = (id: Id, patch: Partial<NotifyTarget>, order: number): NotifyTarget => ({ ...DEFAULT_TARGET(), id, order, ...patch });
  const targets = [
    target('nt_phone', { channel: 'ha_mobile', name: 'Мій телефон', shortName: 'Телефон', icon: 'phone', service: 'notify.mobile_app_phone', isPrimary: true, ownerUserId: 'u_ihor' }, 0),
    target('nt_tablet', { channel: 'ha_mobile', name: 'Планшет на кухні', shortName: 'Планшет', icon: 'tablet', service: 'notify.mobile_app_kitchen_tablet', ownerUserId: 'u_olia' }, 1),
    target('nt_tg_me', { channel: 'telegram', name: 'Telegram · я', shortName: 'Telegram · я', icon: 'send', chatId: '384920117', chatTitle: 'Ігор', ownerUserId: 'u_ihor' }, 2),
    target('nt_tg_family', { channel: 'telegram', name: 'Telegram · сім’я', shortName: 'Telegram · сім’я', icon: 'users', chatId: '-1001872345678', chatTitle: 'Сім’я', isEscalation: true }, 3),
    target('nt_panel', { channel: 'ha_persistent', name: 'Панель HA', shortName: 'Панель', icon: 'bell' }, 4),
    target('nt_event', { channel: 'ha_event', name: 'Подія', shortName: 'Подія', icon: 'sparkle' }, 5),
  ];
  b.notify = {
    settings: {
      ...b.notify.settings,
      telegram: { mode: 'integration', haService: 'telegram_bot.send_message', botUsername: null },
      escalation: { ...b.notify.settings.escalation, enabled: true, targetId: 'nt_tg_family' },
      updatedAt: now,
    },
    targets,
    routing: [],
    events: [],
    watch: [],
    personal: [
      { userId: 'u_ihor', targetIds: ['nt_phone', 'nt_tg_me'], levels: { critical: true, warning: true, event: true, report: true }, quietHours: true },
      { userId: 'u_olia', targetIds: ['nt_tablet'], levels: { critical: true, warning: true, event: false, report: false }, quietHours: true },
    ],
  };

  const z2m = (n: 1 | 2): Z2mInstance => ({
    id: Z2M_IDS[n],
    name: `Z2M #${n}`,
    baseTopic: n === 1 ? 'zigbee2mqtt' : 'zigbee2mqtt_2',
    frontendUrl: n === 1 ? 'http://homeassistant.local:8080' : 'http://homeassistant.local:8081',
    bridgeEntityId: n === 1 ? 'binary_sensor.zigbee2mqtt_bridge_connection_state' : 'binary_sensor.zigbee2mqtt_2_bridge_connection_state',
    resendOnRestart: true,
  });
  b.devices = { ...b.devices, meta: [], z2m: [z2m(1), z2m(2)] };
  return inSimLanguage(b, lang);
}

function demoSources(now: EpochMs): SourceConfig[] {
  const hp = newSourceConfig('heat_pump', { id: SOURCE_IDS.heatPump, name: 'Тепловий насос', now, order: 0 });
  hp.enabled = true;
  hp.subtype = 'Повітря — вода';
  hp.energy = { ...hp.energy, powerEntityId: 'sensor.heat_pump_power' };
  if (hp.adapter.type === 'climate') {
    hp.adapter = {
      ...hp.adapter,
      climate: 'climate.heat_pump',
      modeMap: { heat: 'heat', cool: 'cool', off: 'off' },
      setpoint: 'flow_curve',
      confirm: { kind: 'hvac_action' },
      defrostEntityId: 'binary_sensor.heat_pump_defrost',
      errorEntityId: 'sensor.heat_pump_error_code',
      copEntityId: 'sensor.heat_pump_cop',
      supplyTempEntityId: 'sensor.heat_pump_supply',
    };
  }

  const boiler = newSourceConfig('gas_boiler', { id: SOURCE_IDS.boiler, name: 'Газовий котел', now, order: 1 });
  boiler.enabled = true;
  boiler.subtype = 'Сухий контакт';
  if (boiler.adapter.type === 'relay') {
    boiler.adapter = {
      ...boiler.adapter,
      command: 'switch.boiler_relay',
      confirm: { kind: 'entity_on', entityId: 'binary_sensor.boiler_flame' },
      watchdog: { kind: 'countdown_number', entityId: 'number.boiler_relay_countdown', minutes: 15, rearmEveryMin: 5 },
    };
  }
  // the relay drops by itself 15 min after Klimo stops re-arming it, so a clean stop may leave it on
  boiler.failsafe = { onStop: 'leave', handback: null };

  const ac = (id: Id, room: RoomKey, climate: string, order: number, linkedTo: Id | null): SourceConfig => {
    const s = newSourceConfig('ac', { id, name: 'Кондиціонер', now, roomId: ROOM_IDS[room], order });
    s.enabled = true;
    s.subtype = 'Спліт-система';
    s.energy = { ...s.energy, powerEntityId: `sensor.${climate.slice('climate.'.length)}_power` };
    if (s.adapter.type === 'climate') {
      s.adapter = { ...s.adapter, climate, modeMap: { heat: 'heat', cool: 'cool', dry: 'dry', fan: 'fan_only', off: 'off' }, setpoint: 'room_target', quietFanMode: 'quiet', confirm: { kind: 'hvac_action' } };
    }
    s.linkedTo = linkedTo;
    s.ownFields = [];
    return s;
  };

  const conv = newSourceConfig('electric_radiator', { id: SOURCE_IDS.convector, name: 'Електроконвектор', now, roomId: ROOM_IDS.study, order: 5 });
  conv.enabled = true;
  conv.subtype = 'Розетка 16 А';
  conv.energy = { ...conv.energy, powerEntityId: 'sensor.study_heater_power' };
  if (conv.adapter.type === 'relay') conv.adapter = { ...conv.adapter, command: 'switch.study_heater', confirm: { kind: 'power_above', entityId: 'sensor.study_heater_power', thresholdW: 50 } };
  // only spare solar power during a blackout may run it
  conv.conditions = { join: 'all', items: [{ id: 'ci_conv_solar', mode: null, node: { op: 'trigger', triggerId: 'solar', id: 'conv_solar' }, enabled: true }] };

  return [
    hp,
    boiler,
    ac(SOURCE_IDS.acLiving, 'living', 'climate.living_ac', 2, null),
    ac(SOURCE_IDS.acBedroom, 'bedroom', 'climate.bedroom_ac', 3, SOURCE_IDS.acLiving),
    ac(SOURCE_IDS.acKids, 'kids', 'climate.kids_ac', 4, SOURCE_IDS.acLiving),
    conv,
  ];
}
