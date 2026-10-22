import type { EntityId, EpochMs, HaRegistries } from '../shared/model';
import { renderTemplate, TemplateError, type TemplateHost } from './jinja-lite';

/* =====================================================================================================
 * Home Assistant's MQTT integration, in miniature: discovery configs under `homeassistant/<component>/…
 * /config` become entities of the fake HA, state and attribute topics are rendered through their value
 * templates, and service calls on those entities are published to their command topics. With it the
 * whole Klimo ⇄ HA loop — `climate.klimo_*`, the hub and card sensors, the reply sensor — runs without
 * a broker or a Home Assistant.
 * ===================================================================================================== */

type Doc = Record<string, unknown>;

export type BridgedComponent = 'sensor' | 'binary_sensor' | 'climate' | 'select' | 'switch' | 'button' | 'number';
const COMPONENTS: readonly BridgedComponent[] = ['sensor', 'binary_sensor', 'climate', 'select', 'switch', 'button', 'number'];

export interface BridgeHost extends TemplateHost {
  now(): EpochMs;
  /** Creates or updates the registry entries of a discovered entity and its device. */
  register(entity: HaRegistries['entities'][number], device: HaRegistries['devices'][number] | null): void;
  unregister(entityId: EntityId): void;
  /** Sets the entity's state; HA semantics (last_changed, events, recorder) are the host's. */
  setState(entityId: EntityId, state: string, attributes: Doc): void;
  removeState(entityId: EntityId): void;
  entityExists(entityId: EntityId): boolean;
}

interface Bridged {
  configTopic: string;
  component: BridgedComponent;
  entityId: EntityId;
  uniqueId: string | null;
  config: Doc;
  topics: Set<string>;
  lastPressAt: EpochMs | null;
}

/** The abbreviations HA accepts in discovery payloads that matter here. */
const ABBREVIATIONS: Record<string, string> = {
  stat_t: 'state_topic',
  val_tpl: 'value_template',
  cmd_t: 'command_topic',
  json_attr_t: 'json_attributes_topic',
  json_attr_tpl: 'json_attributes_template',
  avty_t: 'availability_topic',
  uniq_id: 'unique_id',
  dev: 'device',
  dev_cla: 'device_class',
  unit_of_meas: 'unit_of_measurement',
  stat_cla: 'state_class',
  ent_cat: 'entity_category',
  pl_on: 'payload_on',
  pl_off: 'payload_off',
  pl_avail: 'payload_available',
  pl_not_avail: 'payload_not_available',
  pl_prs: 'payload_press',
  ops: 'options',
  def_ent_id: 'default_entity_id',
  obj_id: 'object_id',
  has_ent_name: 'has_entity_name',
};

const TOPIC_KEYS = [
  'state_topic',
  'json_attributes_topic',
  'availability_topic',
  'mode_state_topic',
  'current_temperature_topic',
  'current_humidity_topic',
  'temperature_state_topic',
  'temperature_low_state_topic',
  'temperature_high_state_topic',
  'action_topic',
  'preset_mode_state_topic',
  'fan_mode_state_topic',
];

const isDoc = (v: unknown): v is Doc => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

function expand(raw: Doc): Doc {
  const out: Doc = {};
  for (const [k, v] of Object.entries(raw)) out[ABBREVIATIONS[k] ?? k] = v;
  const base = str(out['~']);
  if (base) {
    for (const [k, v] of Object.entries(out)) {
      if (typeof v === 'string' && k.endsWith('_topic')) out[k] = v.startsWith('~') ? base + v.slice(1) : v.endsWith('~') ? v.slice(0, -1) + base : v;
    }
  }
  return out;
}

function slug(s: string): string {
  return s
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseJson(payload: string): unknown {
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return undefined;
  }
}

export class MqttDiscoveryBridge {
  private readonly byTopic = new Map<string, Bridged>();
  private readonly byEntity = new Map<EntityId, Bridged>();
  private readonly payloads = new Map<string, string>();

  constructor(
    private readonly host: BridgeHost,
    private readonly publish: (topic: string, payload: string) => void,
    private readonly prefix = 'homeassistant',
  ) {}

  /** Every message on the broker passes here. */
  onMessage(topic: string, payload: string): void {
    if (topic.startsWith(`${this.prefix}/`) && topic.endsWith('/config')) {
      this.onConfig(topic, payload);
      return;
    }
    this.payloads.set(topic, payload);
    for (const b of this.byTopic.values()) if (b.topics.has(topic)) this.render(b);
  }

  entityIds(): EntityId[] {
    return [...this.byEntity.keys()];
  }

  isBridged(entityId: EntityId): boolean {
    return this.byEntity.has(entityId);
  }

  /** A service call on a discovered entity, turned into its command topic. False when not ours. */
  command(entityId: EntityId, service: string, data: Doc): boolean {
    const b = this.byEntity.get(entityId);
    if (!b) return false;
    const c = b.config;
    const send = (key: string, payload: unknown) => {
      const topic = str(c[key]);
      if (topic && payload !== undefined && payload !== null) this.publish(topic, typeof payload === 'number' ? String(payload) : String(payload));
    };
    switch (b.component) {
      case 'climate':
        if (service === 'set_temperature') {
          if (data.hvac_mode !== undefined) send('mode_command_topic', data.hvac_mode);
          if (data.temperature !== undefined) send('temperature_command_topic', Number(data.temperature));
          if (data.target_temp_low !== undefined) send('temperature_low_command_topic', Number(data.target_temp_low));
          if (data.target_temp_high !== undefined) send('temperature_high_command_topic', Number(data.target_temp_high));
        } else if (service === 'set_hvac_mode') send('mode_command_topic', data.hvac_mode);
        else if (service === 'set_preset_mode') send('preset_mode_command_topic', data.preset_mode);
        else if (service === 'set_fan_mode') send('fan_mode_command_topic', data.fan_mode);
        else if (service === 'turn_off') send('mode_command_topic', 'off');
        else if (service === 'turn_on') {
          const modes = Array.isArray(c.modes) ? (c.modes as string[]) : ['auto'];
          send('mode_command_topic', modes.includes('auto') ? 'auto' : modes.find((m) => m !== 'off'));
        } else return false;
        return true;
      case 'select':
        if (service !== 'select_option') return false;
        send('command_topic', data.option);
        return true;
      case 'number':
        if (service !== 'set_value') return false;
        send('command_topic', Number(data.value));
        return true;
      case 'button':
        if (service !== 'press') return false;
        send('command_topic', str(c.payload_press) ?? 'PRESS');
        b.lastPressAt = this.host.now();
        this.render(b);
        return true;
      case 'switch':
        if (service === 'turn_on') send('command_topic', str(c.payload_on) ?? 'ON');
        else if (service === 'turn_off') send('command_topic', str(c.payload_off) ?? 'OFF');
        else if (service === 'toggle') {
          const on = this.host.state(entityId) === 'on';
          send('command_topic', on ? str(c.payload_off) ?? 'OFF' : str(c.payload_on) ?? 'ON');
        } else return false;
        return true;
      default:
        return false;
    }
  }

  /* ── discovery ─────────────────────────────────────────────────────────────────────────────── */

  private onConfig(topic: string, payload: string): void {
    const parts = topic.split('/');
    const component = parts[1] as BridgedComponent;
    if (!COMPONENTS.includes(component)) return;
    const existing = this.byTopic.get(topic);
    if (payload.trim() === '') {
      if (existing) this.remove(existing);
      return;
    }
    const raw = parseJson(payload);
    if (!isDoc(raw)) return;
    const config = expand(raw);
    const uniqueId = str(config.unique_id);
    if (existing) {
      existing.config = config;
      existing.topics = this.topicsOf(config);
      this.registerEntity(existing);
      this.render(existing);
      return;
    }
    const entityId = this.entityIdFor(component, config, parts);
    const b: Bridged = { configTopic: topic, component, entityId, uniqueId, config, topics: this.topicsOf(config), lastPressAt: null };
    this.byTopic.set(topic, b);
    this.byEntity.set(entityId, b);
    this.registerEntity(b);
    this.render(b);
  }

  private topicsOf(c: Doc): Set<string> {
    const out = new Set<string>();
    for (const k of TOPIC_KEYS) {
      const t = str(c[k]);
      if (t) out.add(t);
    }
    if (Array.isArray(c.availability)) for (const a of c.availability) if (isDoc(a) && str(a.topic)) out.add(a.topic as string);
    return out;
  }

  /** HA ≥ 2025.10 honours `default_entity_id`; older configs fall back to object_id, then names. */
  private entityIdFor(component: BridgedComponent, c: Doc, parts: string[]): EntityId {
    const wanted = str(c.default_entity_id);
    let id: string;
    if (wanted && wanted.startsWith(`${component}.`)) id = wanted;
    else if (str(c.object_id)) id = `${component}.${slug(c.object_id as string)}`;
    else {
      const device = isDoc(c.device) ? str(c.device.name) : null;
      const name = str(c.name);
      id = `${component}.${slug([c.has_entity_name !== false ? device : null, name].filter(Boolean).join(' ') || parts[parts.length - 2])}`;
    }
    let n = 2;
    let candidate = id;
    while (this.host.entityExists(candidate) && !this.byEntity.has(candidate)) candidate = `${id}_${n++}`;
    return candidate;
  }

  private registerEntity(b: Bridged): void {
    const c = b.config;
    const d = isDoc(c.device) ? c.device : null;
    const identifiers = d ? (Array.isArray(d.identifiers) ? d.identifiers : [d.identifiers]).filter((x): x is string => typeof x === 'string') : [];
    const deviceId = identifiers.length ? `mqtt_${slug(identifiers[0])}` : null;
    const device: HaRegistries['devices'][number] | null =
      d && deviceId
        ? {
            id: deviceId,
            name: str(d.name),
            name_by_user: null,
            area_id: null,
            model: str(d.model),
            manufacturer: str(d.manufacturer),
            identifiers: identifiers.map((x) => ['mqtt', x] as [string, string]),
            via_device_id: null,
          }
        : null;
    this.host.register(
      {
        entity_id: b.entityId,
        device_id: deviceId,
        area_id: null,
        platform: 'mqtt',
        unique_id: b.uniqueId,
        disabled_by: null,
        hidden_by: null,
        original_name: str(c.name),
        name: null,
        entity_category: str(c.entity_category),
      },
      device,
    );
  }

  private remove(b: Bridged): void {
    this.byTopic.delete(b.configTopic);
    this.byEntity.delete(b.entityId);
    this.host.removeState(b.entityId);
    this.host.unregister(b.entityId);
  }

  /* ── state rendering ─────────────────────────────────────────────────────────────────────────── */

  /** undefined = no message yet or the template failed (HA keeps the previous state then). */
  private value(topicKey: string, templateKey: string, c: Doc): string | undefined {
    const topic = str(c[topicKey]);
    if (!topic) return undefined;
    const payload = this.payloads.get(topic);
    if (payload === undefined) return undefined;
    const tpl = str(c[templateKey]);
    if (!tpl) return payload;
    try {
      return renderTemplate(tpl, this.host, { value: payload, value_json: parseJson(payload) });
    } catch (e) {
      if (e instanceof TemplateError) return undefined;
      throw e;
    }
  }

  private num(topicKey: string, templateKey: string, c: Doc): number | null | undefined {
    const v = this.value(topicKey, templateKey, c);
    if (v === undefined) return undefined;
    const n = Number(v);
    return v.trim() !== '' && v !== 'None' && Number.isFinite(n) ? n : null;
  }

  private available(c: Doc): boolean {
    const checks: { topic: string; on: string; off: string }[] = [];
    if (str(c.availability_topic)) checks.push({ topic: c.availability_topic as string, on: str(c.payload_available) ?? 'online', off: str(c.payload_not_available) ?? 'offline' });
    if (Array.isArray(c.availability)) {
      for (const a of c.availability) {
        if (isDoc(a) && str(a.topic)) checks.push({ topic: a.topic as string, on: str(a.payload_available) ?? 'online', off: str(a.payload_not_available) ?? 'offline' });
      }
    }
    return checks.every((x) => this.payloads.get(x.topic) === x.on);
  }

  private render(b: Bridged): void {
    const c = b.config;
    const prev = this.host.attributes(b.entityId);
    const deviceName = isDoc(c.device) ? str(c.device.name) : null;
    const name = str(c.name);
    const friendly = c.has_entity_name !== false && deviceName ? (name ? `${deviceName} ${name}` : deviceName) : name ?? deviceName ?? b.entityId;
    const attrs: Doc = {};
    for (const k of ['unit_of_measurement', 'device_class', 'state_class', 'icon'] as const) if (c[k] !== undefined) attrs[k] = c[k];
    let state = this.host.state(b.entityId) ?? 'unknown';

    switch (b.component) {
      case 'sensor':
      case 'select':
      case 'number': {
        const v = this.value('state_topic', 'value_template', c);
        if (v !== undefined) state = v === '' || v === 'None' ? 'unknown' : v;
        if (b.component === 'select' || c.device_class === 'enum') attrs.options = c.options;
        if (b.component === 'number') for (const k of ['min', 'max', 'step', 'mode'] as const) if (c[k] !== undefined) attrs[k] = c[k];
        break;
      }
      case 'binary_sensor':
      case 'switch': {
        const v = this.value('state_topic', 'value_template', c);
        if (v !== undefined) {
          const on = str(c.state_on) ?? str(c.payload_on) ?? 'ON';
          const off = str(c.state_off) ?? str(c.payload_off) ?? 'OFF';
          state = v === on ? 'on' : v === off ? 'off' : 'unknown';
        }
        break;
      }
      case 'button':
        state = b.lastPressAt !== null ? new Date(b.lastPressAt).toISOString() : 'unknown';
        break;
      case 'climate': {
        const mode = this.value('mode_state_topic', 'mode_state_template', c);
        if (mode !== undefined) state = mode === '' || mode === 'None' ? 'unknown' : mode;
        const keep = (key: string, v: number | null | undefined) => {
          attrs[key] = v === undefined ? prev?.[key] ?? null : v;
        };
        attrs.hvac_modes = Array.isArray(c.modes) ? c.modes : ['auto', 'off', 'cool', 'heat', 'dry', 'fan_only'];
        attrs.min_temp = c.min_temp ?? 7;
        attrs.max_temp = c.max_temp ?? 35;
        attrs.target_temp_step = c.temp_step ?? 0.5;
        keep('current_temperature', this.num('current_temperature_topic', 'current_temperature_template', c));
        if (str(c.current_humidity_topic)) keep('current_humidity', this.num('current_humidity_topic', 'current_humidity_template', c));
        if (str(c.temperature_low_command_topic) || str(c.temperature_low_state_topic)) {
          keep('target_temp_low', this.num('temperature_low_state_topic', 'temperature_low_state_template', c));
          keep('target_temp_high', this.num('temperature_high_state_topic', 'temperature_high_state_template', c));
        }
        if (str(c.temperature_command_topic) || str(c.temperature_state_topic)) keep('temperature', this.num('temperature_state_topic', 'temperature_state_template', c));
        const action = this.value('action_topic', 'action_template', c);
        attrs.hvac_action = action === undefined ? prev?.hvac_action ?? null : action === '' || action === 'None' ? null : action;
        if (Array.isArray(c.preset_modes)) {
          attrs.preset_modes = c.preset_modes;
          const preset = this.value('preset_mode_state_topic', 'preset_mode_value_template', c);
          attrs.preset_mode = preset === undefined ? prev?.preset_mode ?? null : preset === '' || preset === 'None' ? null : preset;
        }
        if (Array.isArray(c.fan_modes)) attrs.fan_modes = c.fan_modes;
        break;
      }
    }

    const jsonTopic = str(c.json_attributes_topic);
    if (jsonTopic) {
      const raw = this.value('json_attributes_topic', 'json_attributes_template', c);
      const parsed = raw === undefined ? undefined : parseJson(raw);
      if (isDoc(parsed)) {
        for (const [k, v] of Object.entries(parsed)) if (!(k in attrs) || b.component !== 'climate') attrs[k] = v;
      } else if (prev) {
        // keep the last good attributes when the topic has nothing new
        for (const [k, v] of Object.entries(prev)) if (!(k in attrs) && k !== 'friendly_name') attrs[k] = v;
      }
    }
    attrs.friendly_name = friendly;
    if (!this.available(c)) state = 'unavailable';
    this.host.setState(b.entityId, state, attrs);
  }
}
