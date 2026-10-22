import { BRAND } from '../common/brand';
import { sourceLabels } from '../config/source-labels';
import { HOUSE_MODES, ROOM_CONTROL_OPTIONS, ROOM_STATES, SEASONS } from '../shared/model';
import type {
  Emitter,
  EngineConfig,
  EntityId,
  ExposedEntityDto,
  HouseMode,
  Id,
  Lang,
  Mode,
  RoomClimateStatePayload,
  RoomConfig,
  Season,
} from '../shared/model';
import { STATUS_TOPIC } from './transport';

/* ── topics ──────────────────────────────────────────────────────────────────────────────────── */

export const TOPIC = {
  status: STATUS_TOPIC,
  command: 'klimo/command',
  events: 'klimo/events',
  hubState: 'klimo/hub/state',
  hubAttrs: 'klimo/hub/attrs',
  replyState: 'klimo/reply/state',
  replyAttrs: 'klimo/reply/attrs',
  house: 'klimo/house/state',
  resync: 'klimo/resync/press',
  room: (roomId: Id) => `klimo/room/${roomId}/state`,
  card: (roomId: Id) => `klimo/room/${roomId}/card`,
  roomSet: (roomId: Id, what: RoomSetTopic) => `klimo/room/${roomId}/${what}/set`,
  roomPress: (roomId: Id, what: RoomPressTopic) => `klimo/room/${roomId}/${what}/press`,
  houseSet: (what: 'profile' | 'season_mode' | 'schedule') => `klimo/house/${what}/set`,
  housePress: (what: 'resume') => `klimo/house/${what}/press`,
  source: (sourceId: Id) => `klimo/source/${sourceId}/state`,
  sourceAllowed: (sourceId: Id) => `klimo/source/${sourceId}/allowed/set`,
  circuit: (circuitId: Id) => `klimo/circuit/${circuitId}/state`,
  trigger: (triggerId: Id) => `klimo/trigger/${triggerId}/state`,
  rule: (ruleId: Id) => `klimo/rule/${ruleId}/state`,
  ruleSet: (ruleId: Id) => `klimo/rule/${ruleId}/set`,
  numberSet: (name: 'bivalent_point') => `klimo/number/${name}/set`,
} as const;

export type RoomSetTopic = 'mode' | 'temp' | 'temp_low' | 'temp_high' | 'preset' | 'control';
export type RoomPressTopic = 'resume' | 'boost';

/** Everything Klimo listens to (configuration-level topics only while those entities are published). */
export function commandSubscriptions(configEntities: boolean): string[] {
  const base = [
    TOPIC.command,
    'klimo/room/+/+/set',
    'klimo/room/+/+/press',
    'klimo/house/+/set',
    'klimo/house/+/press',
    TOPIC.resync,
  ];
  return configEntities ? [...base, 'klimo/source/+/allowed/set', 'klimo/rule/+/set', 'klimo/number/+/set'] : base;
}

/* ── entity model ───────────────────────────────────────────────────────────────────────────── */

export type Component = ExposedEntityDto['component'];

type Doc = Record<string, unknown>;

/** How Home Assistant derives the entity's state and attributes from Klimo's topics (mirrors the templates). */
export interface EntityRead {
  stateTopic: string | null;
  /** JSON field holding the state; null = the raw payload. */
  stateKey: string | null;
  attrsTopic: string | null;
  attrs: ((doc: Doc) => Doc) | null;
}

const asDoc = (v: unknown): Doc => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Doc) : {});
const whole = (d: Doc): Doc => d;
const field = (key: string) => (d: Doc): Doc => asDoc(d[key]);
const NO_READ: EntityRead = { stateTopic: null, stateKey: null, attrsTopic: null, attrs: null };

export interface DiscoveredEntity {
  component: Component;
  uniqueId: string;
  /** The documented entity id (`default_entity_id`); HA may have renamed it since. */
  entityId: EntityId;
  role: string;
  roomId: Id | null;
  configTopic: string;
  config: Record<string, unknown>;
  /** Topics the entity reads (state + attributes) — emptied when the entity goes away. */
  topics: string[];
  read: EntityRead;
}

export interface DeviceInfo {
  identifiers: string[];
  name: string;
  manufacturer: string;
  model: string;
  sw_version: string;
  configuration_url?: string;
}

/** The one device all Klimo entities belong to. The ingress link needs the add-on slug from the panel path. */
export function deviceInfo(version: string, panelPath: string | null): DeviceInfo {
  const device: DeviceInfo = {
    identifiers: ['klimo'],
    name: BRAND.productName,
    manufacturer: BRAND.productName,
    model: 'Climate add-on',
    sw_version: version,
  };
  const slug = panelPath?.replace(/^\/+/, '').split(/[/?#]/)[0];
  if (slug) device.configuration_url = `homeassistant://hassio/ingress/${slug}`;
  return device;
}

/** Entity-id-safe form of an id: HA object ids are `[a-z0-9_]`. */
export function objectId(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9_]/g, '_');
}

/* ── names (settings.notificationLanguage) ───────────────────────────────────────────────────── */

const NAMES = {
  house_profile: ['House profile', 'Профіль будинку'],
  season_mode: ['Season mode', 'Режим сезону'],
  season: ['Season', 'Сезон'],
  outdoor_average: ['Outdoor average', 'Середня температура надворі'],
  active_source: ['Active source', 'Активне джерело'],
  heat_demand: ['Heat demand', 'Запит тепла'],
  cool_demand: ['Cool demand', 'Запит холоду'],
  problem: ['Problem', 'Проблема'],
  alerts: ['Alerts', 'Сповіщення'],
  power_used: ['Power used', 'Споживання'],
  resume_schedule: ['Resume schedule', 'Повернути розклад'],
  schedule: ['Follow schedule', 'За розкладом'],
  control: ['control', 'керування'],
  resync: ['Resend targets', 'Переслати цілі'],
  hub: ['Hub', 'Хаб'],
  reply: ['Reply', 'Відповідь'],
  bivalent_point: ['Bivalent point', 'Точка бівалентності'],
  pump: ['Pump', 'Насос'],
  allowed: ['allowed', 'дозволено'],
  temperature: ['temperature', 'температура'],
  target: ['target', 'ціль'],
  humidity: ['humidity', 'вологість'],
  dew_point: ['dew point', 'точка роси'],
  room_heat_demand: ['heat demand', 'запит тепла'],
  room_cool_demand: ['cool demand', 'запит холоду'],
  window: ['window', 'вікно'],
  state: ['state', 'стан'],
  room_resume: ['resume schedule', 'повернути розклад'],
  boost: ['boost', 'підсилення'],
  card: ['card', 'картка'],
} as const satisfies Record<string, readonly [string, string]>;

type NameKey = keyof typeof NAMES;

function label(key: NameKey, lang: Lang): string {
  return NAMES[key][lang === 'uk' ? 1 : 0];
}

/* ── capabilities and climate modes ──────────────────────────────────────────────────────────── */

function emitterCan(cfg: EngineConfig, e: Emitter, mode: Mode): boolean {
  if (e.roles[mode] === null) return false;
  if (e.kind === 'direct') return !!cfg.sources.find((s) => s.id === e.sourceId)?.capabilities[mode];
  if (mode === 'cool' && (e.kind === 'radiator' || e.kind === 'towel_rail' || e.excludeFromCooling)) return false;
  return !!cfg.circuits.find((c) => c.id === e.circuitId)?.capabilities[mode];
}

/** What a room is built to do, independent of the season (a monitor-only room does nothing). */
export function roomCapabilities(cfg: EngineConfig, room: RoomConfig): { heat: boolean; cool: boolean } {
  if (!room.controlEnabled) return { heat: false, cool: false };
  const emitters = (cfg.emittersByRoom[room.id] ?? []).filter((e) => e.enabled);
  return { heat: emitters.some((e) => emitterCan(cfg, e, 'heat')), cool: emitters.some((e) => emitterCan(cfg, e, 'cool')) };
}

export type ClimateMode = RoomClimateStatePayload['mode'];

/** HA climate modes offered now: follow the season so the HA thermostat never offers what cannot run. */
export function climateModes(caps: { heat: boolean; cool: boolean }, season: Season, houseMode: HouseMode): ClimateMode[] {
  if (houseMode === 'off') return ['off', 'auto'];
  const effective: Season = houseMode === 'heat' ? 'heating' : houseMode === 'cool' ? 'cooling' : season;
  if (effective === 'heating') return caps.heat ? ['off', 'auto', 'heat'] : ['off', 'auto'];
  if (effective === 'cooling') return caps.cool ? ['off', 'auto', 'cool'] : ['off', 'auto'];
  if (caps.heat && caps.cool) return ['off', 'auto', 'heat_cool'];
  if (caps.heat) return ['off', 'auto', 'heat'];
  if (caps.cool) return ['off', 'auto', 'cool'];
  return ['off', 'auto'];
}

function roomLimits(cfg: EngineConfig, room: RoomConfig): { heatMinC: number; heatMaxC: number; coolMinC: number; coolMaxC: number } {
  return room.limits ?? cfg.settings.targetLimits;
}

function climateRange(cfg: EngineConfig, room: RoomConfig, modes: ClimateMode[], caps: { heat: boolean; cool: boolean }): [number, number] {
  const l = roomLimits(cfg, room);
  if (modes.includes('heat_cool')) return [l.heatMinC, l.coolMaxC];
  if (modes.includes('cool')) return [l.coolMinC, l.coolMaxC];
  if (modes.includes('heat') || caps.heat || !caps.cool) return [l.heatMinC, l.heatMaxC];
  return [l.coolMinC, l.coolMaxC];
}

/** Config-level entities exist only when the energy side is bound (grid, PV, load or battery). */
export function energyConfigured(cfg: EngineConfig): boolean {
  return Object.values(cfg.energy.entities).some((v) => !!v);
}

/* ── catalogue ───────────────────────────────────────────────────────────────────────────────── */

export interface DiscoveryInput {
  cfg: EngineConfig;
  season: Season;
  houseMode: HouseMode;
  lang: Lang;
  prefix: string;
  device: DeviceInfo;
}

const json = (field: string) => `{{ value_json.${field} }}`;
const jsonAttrs = (field: string) => `{{ value_json.${field} | tojson }}`;

class Catalogue {
  readonly out: DiscoveredEntity[] = [];

  constructor(private readonly input: DiscoveryInput) {}

  add(spec: {
    component: Component;
    uniqueId: string;
    object: string;
    role: string;
    roomId?: Id | null;
    name: string;
    node?: string;
    config: Record<string, unknown>;
    read: EntityRead;
  }): void {
    const { prefix, device } = this.input;
    const node = objectId(spec.node ?? spec.uniqueId);
    const config: Record<string, unknown> = {
      unique_id: spec.uniqueId,
      default_entity_id: `${spec.component}.${spec.object}`,
      has_entity_name: true,
      name: spec.name,
      device,
      availability_topic: TOPIC.status,
      ...spec.config,
    };
    const topics = new Set<string>();
    for (const [key, value] of Object.entries(spec.config)) {
      if (key.endsWith('_topic') && !key.includes('command') && typeof value === 'string') topics.add(value);
    }
    this.out.push({
      component: spec.component,
      uniqueId: spec.uniqueId,
      entityId: `${spec.component}.${spec.object}`,
      role: spec.role,
      roomId: spec.roomId ?? null,
      configTopic: `${prefix}/${spec.component}/${node}/config`,
      config,
      topics: [...topics],
      read: spec.read,
    });
  }
}

/** Every entity Klimo publishes for this configuration and season: what Home Assistant sees of Klimo. */
export function buildDiscovery(input: DiscoveryInput): DiscoveredEntity[] {
  const { cfg, lang } = input;
  const c = new Catalogue(input);
  const house = TOPIC.house;
  const fromHouse = (stateKey: string, attrs: EntityRead['attrs'] = null): EntityRead => ({
    stateTopic: house,
    stateKey,
    attrsTopic: attrs ? house : null,
    attrs,
  });

  /* house */
  const profiles = [...cfg.profiles].sort((a, b) => a.order - b.order);
  c.add({
    component: 'select',
    uniqueId: 'klimo_house_profile',
    object: 'klimo_house_profile',
    role: 'house_profile',
    name: label('house_profile', lang),
    config: {
      icon: 'mdi:home-account',
      options: profiles.map((p) => p.name),
      state_topic: house,
      value_template: json('profile'),
      command_topic: TOPIC.houseSet('profile'),
      json_attributes_topic: house,
      json_attributes_template: jsonAttrs('profile_attrs'),
    },
    read: fromHouse('profile', field('profile_attrs')),
  });
  c.add({
    component: 'select',
    uniqueId: 'klimo_season_mode',
    object: 'klimo_season_mode',
    role: 'season_mode',
    name: label('season_mode', lang),
    config: {
      icon: 'mdi:sun-snowflake-variant',
      options: [...HOUSE_MODES],
      state_topic: house,
      value_template: json('season_mode'),
      command_topic: TOPIC.houseSet('season_mode'),
    },
    read: fromHouse('season_mode'),
  });
  c.add({
    component: 'sensor',
    uniqueId: 'klimo_season',
    object: 'klimo_season',
    role: 'season',
    name: label('season', lang),
    config: {
      device_class: 'enum',
      options: [...SEASONS],
      icon: 'mdi:calendar-range',
      state_topic: house,
      value_template: json('season'),
      json_attributes_topic: house,
      json_attributes_template: jsonAttrs('season_attrs'),
    },
    read: fromHouse('season', field('season_attrs')),
  });
  c.add({
    component: 'sensor',
    uniqueId: 'klimo_outdoor_average',
    object: 'klimo_outdoor_average',
    role: 'outdoor_average',
    name: label('outdoor_average', lang),
    config: {
      device_class: 'temperature',
      state_class: 'measurement',
      unit_of_measurement: '°C',
      suggested_display_precision: 1,
      state_topic: house,
      value_template: json('outdoor_avg'),
    },
    read: fromHouse('outdoor_avg'),
  });
  c.add({
    component: 'sensor',
    uniqueId: 'klimo_active_source',
    object: 'klimo_active_source',
    role: 'active_source',
    name: label('active_source', lang),
    config: {
      icon: 'mdi:fire',
      state_topic: house,
      value_template: json('active_source'),
      json_attributes_topic: house,
      json_attributes_template: jsonAttrs('active_source_attrs'),
    },
    read: fromHouse('active_source', field('active_source_attrs')),
  });
  for (const mode of ['heat', 'cool'] as const) {
    c.add({
      component: 'binary_sensor',
      uniqueId: `klimo_${mode}_demand`,
      object: `klimo_${mode}_demand`,
      role: `${mode}_demand`,
      name: label(mode === 'heat' ? 'heat_demand' : 'cool_demand', lang),
      config: {
        device_class: mode === 'heat' ? 'heat' : 'cold',
        state_topic: house,
        value_template: json(`${mode}_demand`),
        json_attributes_topic: house,
        json_attributes_template: `{{ {'rooms': value_json.${mode}_rooms} | tojson }}`,
      },
      read: fromHouse(`${mode}_demand`, (d) => ({ rooms: d[`${mode}_rooms`] ?? [] })),
    });
  }
  c.add({
    component: 'binary_sensor',
    uniqueId: 'klimo_problem',
    object: 'klimo_problem',
    role: 'problem',
    name: label('problem', lang),
    config: {
      device_class: 'problem',
      state_topic: house,
      value_template: json('problem'),
      json_attributes_topic: house,
      json_attributes_template: jsonAttrs('problem_attrs'),
    },
    read: fromHouse('problem', field('problem_attrs')),
  });
  c.add({
    component: 'sensor',
    uniqueId: 'klimo_alerts',
    object: 'klimo_alerts',
    role: 'alerts',
    name: label('alerts', lang),
    config: { icon: 'mdi:bell-alert', state_class: 'measurement', state_topic: house, value_template: json('alerts') },
    read: fromHouse('alerts'),
  });
  if (energyConfigured(cfg)) {
    c.add({
      component: 'sensor',
      uniqueId: 'klimo_power_used',
      object: 'klimo_power_used',
      role: 'power_used',
      name: label('power_used', lang),
      config: {
        device_class: 'power',
        state_class: 'measurement',
        unit_of_measurement: 'kW',
        suggested_display_precision: 2,
        state_topic: house,
        value_template: json('power_kw'),
      },
      read: fromHouse('power_kw'),
    });
  }
  // everyday control: never behind the configuration-entities opt-in
  c.add({
    component: 'switch',
    uniqueId: 'klimo_schedule',
    object: 'klimo_schedule',
    role: 'schedule',
    name: label('schedule', lang),
    config: {
      icon: 'mdi:calendar-clock',
      state_topic: house,
      value_template: json('schedule'),
      command_topic: TOPIC.houseSet('schedule'),
      json_attributes_topic: house,
      json_attributes_template: jsonAttrs('schedule_attrs'),
    },
    read: fromHouse('schedule', field('schedule_attrs')),
  });
  c.add({
    component: 'button',
    uniqueId: 'klimo_resume_schedule',
    object: 'klimo_resume_schedule',
    role: 'resume_schedule',
    name: label('resume_schedule', lang),
    config: { icon: 'mdi:calendar-sync', command_topic: TOPIC.housePress('resume') },
    read: NO_READ,
  });
  c.add({
    component: 'button',
    uniqueId: 'klimo_resync',
    object: 'klimo_resync',
    role: 'resync',
    name: label('resync', lang),
    config: { icon: 'mdi:sync', entity_category: 'diagnostic', command_topic: TOPIC.resync },
    read: NO_READ,
  });
  c.add({
    component: 'sensor',
    uniqueId: 'klimo_hub',
    object: 'klimo_hub',
    role: 'hub',
    name: label('hub', lang),
    config: {
      icon: 'mdi:home-thermometer',
      entity_category: 'diagnostic',
      state_topic: TOPIC.hubState,
      json_attributes_topic: TOPIC.hubAttrs,
    },
    read: { stateTopic: TOPIC.hubState, stateKey: null, attrsTopic: TOPIC.hubAttrs, attrs: whole },
  });
  c.add({
    component: 'sensor',
    uniqueId: 'klimo_reply',
    object: 'klimo_reply',
    role: 'reply',
    name: label('reply', lang),
    config: {
      icon: 'mdi:message-reply-text',
      entity_category: 'diagnostic',
      state_topic: TOPIC.replyState,
      json_attributes_topic: TOPIC.replyAttrs,
    },
    read: { stateTopic: TOPIC.replyState, stateKey: null, attrsTopic: TOPIC.replyAttrs, attrs: whole },
  });

  /* plant */
  const optIn = cfg.settings.mqttConfigEntities;
  const sourceName = sourceLabels(cfg);
  for (const s of [...cfg.sources].sort((a, b) => a.order - b.order)) {
    const topic = TOPIC.source(s.id);
    const name = sourceName.get(s.id) ?? s.name;
    c.add({
      component: 'binary_sensor',
      uniqueId: `klimo_src_${s.id}`,
      object: `klimo_source_${objectId(s.id)}`,
      role: 'source',
      name,
      config: {
        device_class: 'running',
        state_topic: topic,
        value_template: json('state'),
        json_attributes_topic: topic,
        json_attributes_template: jsonAttrs('attrs'),
      },
      read: { stateTopic: topic, stateKey: 'state', attrsTopic: topic, attrs: field('attrs') },
    });
    if (optIn) {
      c.add({
        component: 'switch',
        uniqueId: `klimo_src_${s.id}_allowed`,
        object: `klimo_source_${objectId(s.id)}_allowed`,
        role: 'source_allowed',
        name: `${name} ${label('allowed', lang)}`,
        config: {
          entity_category: 'config',
          icon: 'mdi:power-settings',
          state_topic: topic,
          value_template: json('allowed'),
          command_topic: TOPIC.sourceAllowed(s.id),
        },
        read: { stateTopic: topic, stateKey: 'allowed', attrsTopic: null, attrs: null },
      });
    }
  }
  for (const circuit of [...cfg.circuits].sort((a, b) => a.order - b.order)) {
    if (!cfg.pumps.some((p) => p.circuitId === circuit.id)) continue;
    const topic = TOPIC.circuit(circuit.id);
    const short = circuit.shortName || circuit.name;
    c.add({
      component: 'binary_sensor',
      uniqueId: `klimo_pump_${circuit.id}`,
      object: `klimo_pump_${objectId(circuit.id)}`,
      role: 'pump',
      name: `${label('pump', lang)} · ${short}`,
      config: {
        device_class: 'running',
        icon: 'mdi:pump',
        state_topic: topic,
        value_template: json('state'),
        json_attributes_topic: topic,
        json_attributes_template: jsonAttrs('attrs'),
      },
      read: { stateTopic: topic, stateKey: 'state', attrsTopic: topic, attrs: field('attrs') },
    });
  }
  for (const t of [...cfg.triggers].sort((a, b) => a.order - b.order)) {
    const topic = TOPIC.trigger(t.id);
    c.add({
      component: 'binary_sensor',
      uniqueId: `klimo_trigger_${t.id}`,
      object: `klimo_trigger_${objectId(t.id)}`,
      role: 'trigger',
      name: t.name,
      config: {
        icon: 'mdi:flash-triangle-outline',
        state_topic: topic,
        value_template: json('state'),
        json_attributes_topic: topic,
        json_attributes_template: jsonAttrs('attrs'),
      },
      read: { stateTopic: topic, stateKey: 'state', attrsTopic: topic, attrs: field('attrs') },
    });
  }
  if (optIn) {
    for (const r of [...cfg.rules].sort((a, b) => a.priority - b.priority)) {
      const topic = TOPIC.rule(r.id);
      c.add({
        component: 'switch',
        uniqueId: `klimo_rule_${r.id}`,
        object: `klimo_rule_${objectId(r.id)}`,
        role: 'rule',
        name: r.name,
        config: {
          entity_category: 'config',
          icon: 'mdi:script-text-outline',
          state_topic: topic,
          value_template: json('state'),
          command_topic: TOPIC.ruleSet(r.id),
        },
        read: { stateTopic: topic, stateKey: 'state', attrsTopic: null, attrs: null },
      });
    }
    c.add({
      component: 'number',
      uniqueId: 'klimo_bivalent_point',
      object: 'klimo_bivalent_point',
      role: 'bivalent_point',
      name: label('bivalent_point', lang),
      config: {
        entity_category: 'config',
        device_class: 'temperature',
        unit_of_measurement: '°C',
        min: -20,
        max: 5,
        step: 1,
        mode: 'box',
        state_topic: house,
        value_template: json('bivalent_point'),
        command_topic: TOPIC.numberSet('bivalent_point'),
      },
      read: fromHouse('bivalent_point'),
    });
  }

  /* rooms */
  for (const room of [...cfg.rooms].sort((a, b) => a.order - b.order)) addRoom(c, input, room);
  return c.out;
}

function addRoom(c: Catalogue, input: DiscoveryInput, room: RoomConfig): void {
  const { cfg, lang } = input;
  const rid = room.id;
  const slug = objectId(room.slug);
  const state = TOPIC.room(rid);
  const sensors = cfg.sensorsByRoom[rid] ?? [];
  const caps = roomCapabilities(cfg, room);
  const named = (key: NameKey) => `${room.name} ${label(key, lang)}`;
  const fromRoom = (stateKey: string, attrs: EntityRead['attrs'] = null): EntityRead => ({
    stateTopic: state,
    stateKey,
    attrsTopic: attrs ? state : null,
    attrs,
  });

  c.add({
    component: 'climate',
    uniqueId: `klimo_${rid}_climate`,
    object: `klimo_${slug}`,
    node: `klimo_${rid}`,
    role: 'climate',
    roomId: rid,
    name: room.name,
    config: climateConfig(cfg, room, caps, input),
    read: fromRoom('mode', field('attrs')),
  });
  c.add({
    component: 'sensor',
    uniqueId: `klimo_${rid}_temperature`,
    object: `klimo_${slug}_temperature`,
    role: 'temperature',
    roomId: rid,
    name: named('temperature'),
    config: {
      device_class: 'temperature',
      state_class: 'measurement',
      unit_of_measurement: '°C',
      suggested_display_precision: 1,
      state_topic: state,
      value_template: json('cur'),
    },
    read: fromRoom('cur'),
  });
  c.add({
    component: 'sensor',
    uniqueId: `klimo_${rid}_target`,
    object: `klimo_${slug}_target`,
    role: 'target',
    roomId: rid,
    name: named('target'),
    config: {
      device_class: 'temperature',
      state_class: 'measurement',
      unit_of_measurement: '°C',
      suggested_display_precision: 1,
      icon: 'mdi:thermostat',
      state_topic: state,
      value_template: json('target'),
      json_attributes_topic: state,
      // `mode` says which bound the state is (heat / cool / dual): the recorder history of this sensor
      // is how the room chart redraws past target bands
      json_attributes_template:
        "{{ {'lo': value_json.lo, 'hi': value_json.hi, 'mode': value_json.target_mode | default(none), 'source': value_json.attrs.target_source, 'until': value_json.attrs.until} | tojson }}",
    },
    read: fromRoom('target', (d) => ({
      lo: d.lo ?? null,
      hi: d.hi ?? null,
      mode: d.target_mode ?? null,
      source: asDoc(d.attrs).target_source ?? null,
      until: asDoc(d.attrs).until ?? null,
    })),
  });
  if (sensors.some((s) => s.role === 'humidity')) {
    c.add({
      component: 'sensor',
      uniqueId: `klimo_${rid}_humidity`,
      object: `klimo_${slug}_humidity`,
      role: 'humidity',
      roomId: rid,
      name: named('humidity'),
      config: {
        device_class: 'humidity',
        state_class: 'measurement',
        unit_of_measurement: '%',
        suggested_display_precision: 0,
        state_topic: state,
        value_template: json('hum'),
      },
      read: fromRoom('hum'),
    });
    c.add({
      component: 'sensor',
      uniqueId: `klimo_${rid}_dew_point`,
      object: `klimo_${slug}_dew_point`,
      role: 'dew_point',
      roomId: rid,
      name: named('dew_point'),
      config: {
        device_class: 'temperature',
        state_class: 'measurement',
        unit_of_measurement: '°C',
        suggested_display_precision: 1,
        entity_category: 'diagnostic',
        state_topic: state,
        value_template: json('dew'),
      },
      read: fromRoom('dew'),
    });
  }
  c.add({
    component: 'binary_sensor',
    uniqueId: `klimo_${rid}_heat_demand`,
    object: `klimo_${slug}_heat_demand`,
    role: 'heat_demand',
    roomId: rid,
    name: named('room_heat_demand'),
    config: { device_class: 'heat', state_topic: state, value_template: json('heat') },
    read: fromRoom('heat'),
  });
  if (caps.cool) {
    c.add({
      component: 'binary_sensor',
      uniqueId: `klimo_${rid}_cool_demand`,
      object: `klimo_${slug}_cool_demand`,
      role: 'cool_demand',
      roomId: rid,
      name: named('room_cool_demand'),
      config: { device_class: 'cold', state_topic: state, value_template: json('cool') },
      read: fromRoom('cool'),
    });
  }
  if (sensors.some((s) => s.role === 'contact') || room.windows.tempDrop.enabled) {
    c.add({
      component: 'binary_sensor',
      uniqueId: `klimo_${rid}_window`,
      object: `klimo_${slug}_window`,
      role: 'window',
      roomId: rid,
      name: named('window'),
      config: { device_class: 'window', state_topic: state, value_template: json('window') },
      read: fromRoom('window'),
    });
  }
  c.add({
    component: 'sensor',
    uniqueId: `klimo_${rid}_state`,
    object: `klimo_${slug}_state`,
    role: 'state',
    roomId: rid,
    name: named('state'),
    config: {
      device_class: 'enum',
      options: [...ROOM_STATES],
      entity_category: 'diagnostic',
      state_topic: state,
      value_template: json('state'),
    },
    read: fromRoom('state'),
  });
  c.add({
    component: 'select',
    uniqueId: `klimo_${rid}_control`,
    object: `klimo_${slug}_control`,
    role: 'control',
    roomId: rid,
    name: named('control'),
    config: {
      icon: 'mdi:hand-back-right-outline',
      options: [...ROOM_CONTROL_OPTIONS],
      state_topic: state,
      value_template: json('control'),
      command_topic: TOPIC.roomSet(rid, 'control'),
      json_attributes_topic: state,
      json_attributes_template: jsonAttrs('control_attrs'),
    },
    read: fromRoom('control', field('control_attrs')),
  });
  c.add({
    component: 'button',
    uniqueId: `klimo_${rid}_resume_schedule`,
    object: `klimo_${slug}_resume_schedule`,
    role: 'resume_schedule',
    roomId: rid,
    name: named('room_resume'),
    config: { icon: 'mdi:calendar-sync', command_topic: TOPIC.roomPress(rid, 'resume') },
    read: NO_READ,
  });
  c.add({
    component: 'button',
    uniqueId: `klimo_${rid}_boost`,
    object: `klimo_${slug}_boost`,
    role: 'boost',
    roomId: rid,
    name: named('boost'),
    config: { icon: 'mdi:rocket-launch-outline', command_topic: TOPIC.roomPress(rid, 'boost') },
    read: NO_READ,
  });
  c.add({
    component: 'sensor',
    uniqueId: `klimo_${rid}_card`,
    object: `klimo_${slug}_card`,
    role: 'card',
    roomId: rid,
    name: named('card'),
    config: {
      icon: 'mdi:card-text-outline',
      entity_category: 'diagnostic',
      state_topic: state,
      value_template: json('state'),
      json_attributes_topic: TOPIC.card(rid),
    },
    read: { stateTopic: state, stateKey: 'state', attrsTopic: TOPIC.card(rid), attrs: whole },
  });
}

/**
 * The room thermostat: season-dependent modes. The `heat_cool` variant adds the dual bounds next to the
 * single target: a room with one target in the neutral season still shows it (lo/hi are then None, and
 * HA draws whichever of the two is set).
 */
function climateConfig(cfg: EngineConfig, room: RoomConfig, caps: { heat: boolean; cool: boolean }, input: DiscoveryInput): Record<string, unknown> {
  const state = TOPIC.room(room.id);
  const modes = climateModes(caps, input.season, input.houseMode);
  const [min, max] = climateRange(cfg, room, modes, caps);
  const config: Record<string, unknown> = {
    modes,
    mode_state_topic: state,
    mode_state_template: json('mode'),
    mode_command_topic: TOPIC.roomSet(room.id, 'mode'),
    current_temperature_topic: state,
    current_temperature_template: json('cur'),
    current_humidity_topic: state,
    current_humidity_template: json('hum'),
    temperature_state_topic: state,
    temperature_state_template: json('t'),
    temperature_command_topic: TOPIC.roomSet(room.id, 'temp'),
  };
  if (modes.includes('heat_cool')) {
    Object.assign(config, {
      temperature_low_state_topic: state,
      temperature_low_state_template: json('lo'),
      temperature_low_command_topic: TOPIC.roomSet(room.id, 'temp_low'),
      temperature_high_state_topic: state,
      temperature_high_state_template: json('hi'),
      temperature_high_command_topic: TOPIC.roomSet(room.id, 'temp_high'),
    });
  }
  Object.assign(config, {
    action_topic: state,
    action_template: json('action'),
    preset_modes: [...cfg.profiles].sort((a, b) => a.order - b.order).map((p) => p.name),
    preset_mode_state_topic: state,
    preset_mode_value_template: json('preset'),
    preset_mode_command_topic: TOPIC.roomSet(room.id, 'preset'),
    min_temp: min,
    max_temp: max,
    temp_step: cfg.settings.targetLimits.stepC,
    precision: 0.1,
    temperature_unit: 'C',
    optimistic: false,
    json_attributes_topic: state,
    json_attributes_template: jsonAttrs('attrs'),
  });
  return config;
}
