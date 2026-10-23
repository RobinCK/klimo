import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { addDays, dowOfDate, fromLocal, toLocal } from '../engine/core/time';
import { env } from '../env';
import type { DesiredValue, EntityId, EpochMs, HaConfigInfo, HaPort, HaRegistries, HaServiceResult, HaStateObj, IBus, MqttTransport, SimFaultRequest } from '../shared/model';
import { BUS, MQTT_TRANSPORT } from '../tokens';
import { DEVICES, demoRegistries, deviceOfEntity, entityOfRole, friendlyName, HOME, PERSONS, USERS, z2mBase, type DeviceSpec, type EntitySpec } from './devices';
import { evaluateTemplate, TemplateError, type TemplateHost } from './jinja-lite';
import { inSimLanguage, simText } from './language';
import { MqttDiscoveryBridge } from './mqtt-bridge';
import { stream, type Rng } from './random';
import { isMqttTap, type MqttTap } from './sim-mqtt';
import { SimClock } from './sim.clock';
import { SimRecorder } from './sim-recorder';

/* =====================================================================================================
 * Home Assistant without Home Assistant. Implements `HaPort` over an in-memory state machine of the
 * demo house: registries with Zigbee2MQTT-style ids, services with real latency and lost packets,
 * contexts that come back on the resulting state changes (so Klimo's own-change detection is exercised),
 * a recorder, templates, and the MQTT discovery bridge for Klimo's own entities.
 * ===================================================================================================== */

type Ctx = NonNullable<HaStateObj['context']>;
type Doc = Record<string, unknown>;

export interface OutboxEntry {
  at: EpochMs;
  domain: string;
  service: string;
  data: Doc;
}

interface DeviceRuntime {
  spec: DeviceSpec;
  lqiBase: number;
  batteryBase: number | null;
  batteryAt: EpochMs;
  unavailable: boolean;
  /** Stops reporting: the last value stays, `last_reported` freezes. */
  stale: boolean;
  /** Every write is dropped. */
  noAck: boolean;
  /** States before the device went unavailable (restored on `clear`). */
  stash: Map<EntityId, HaStateObj>;
  lastLqi: number;
}

interface TemplateSub {
  template: string;
  variables: Doc;
  cb: (result: unknown, error: string | null) => void;
  entities: Set<string>;
  all: boolean;
  last: string | undefined;
}

const DEFAULT_EVENTS = ['state_changed', 'entity_registry_updated', 'device_registry_updated', 'area_registry_updated', 'call_service', 'homeassistant_started', 'mobile_app_notification_action', 'telegram_callback'];
const OUTBOX_MAX = 60;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** Writes to Zigbee heads take this long to arrive (seeded uniform); everything else half a second. */
const TRV_DELAY: [number, number] = [1000, 4000];
const OTHER_DELAY = 500;
const WEAK_LQI = 60;
const LOSS_WHEN_WEAK = 0.3;

/** HA's friendly name of a demo entity, in the simulator's language. */
function simFriendlyName(d: DeviceSpec, e: EntitySpec): string {
  return friendlyName({ ...d, label: simText(d.label, env.sim.lang) }, { ...e, name: e.name && simText(e.name, env.sim.lang) });
}

function iso(t: EpochMs): string {
  return new Date(t).toISOString();
}

/** HA context ids are ULIDs: 48 bits of time, 80 random bits, Crockford base32. */
export function newContextId(t: EpochMs): string {
  let out = '';
  let ts = Math.max(0, Math.floor(t));
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[ts % 32] + out;
    ts = Math.floor(ts / 32);
  }
  for (const b of randomBytes(16)) out += CROCKFORD[b % 32];
  return out;
}

const sameAttrs = (a: Doc, b: Doc) => {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    const x = a[k];
    const y = b[k];
    if (x === y) continue;
    if (typeof x === 'object' && x !== null && JSON.stringify(x) === JSON.stringify(y)) continue;
    return false;
  }
  return true;
};

@Injectable()
export class FakeHaService implements HaPort, TemplateHost, OnModuleDestroy {
  private readonly log = new Logger('FakeHA');
  readonly simulated = true;
  readonly recorder: SimRecorder;
  private online = false;
  private states = new Map<EntityId, HaStateObj>();
  private reg: HaRegistries = inSimLanguage(demoRegistries(), env.sim.lang);
  private readonly connectionCbs: ((ok: boolean) => void)[] = [];
  private readonly stateCbs: ((id: EntityId, next: HaStateObj | null, prev: HaStateObj | null) => void)[] = [];
  private readonly eventCbs: ((type: string, data: Doc, ctx: { id: string | null; user_id: string | null; parent_id: string | null }) => void)[] = [];
  private readonly registryCbs: (() => void)[] = [];
  private readonly subscribed = new Set<string>(DEFAULT_EVENTS);
  private readonly templates = new Set<TemplateSub>();
  private readonly dirtyEntities = new Set<string>();
  private templateFlush: NodeJS.Immediate | null = null;
  private readonly outbox: OutboxEntry[] = [];
  private readonly lovelace = new Map<string, string>();
  private readonly runtime = new Map<string, DeviceRuntime>();
  private readonly bridgeOffline = new Set<1 | 2>();
  private readonly bridge: MqttDiscoveryBridge;
  private readonly tap: MqttTap | null;
  private readonly rng: Rng;
  private registryTimer: { cancel(): void } | null = null;
  private countdown = { remainingMs: 0, shown: 0, at: 0 };

  constructor(
    @Inject(SimClock) private readonly clock: SimClock,
    @Inject(MQTT_TRANSPORT) private readonly transport: MqttTransport,
    @Inject(BUS) private readonly bus: IBus,
  ) {
    this.recorder = new SimRecorder(() => this.clock.tz());
    this.rng = stream(env.sim.seed, 'fake-ha');
    this.tap = isMqttTap(transport) ? transport : null;
    this.bridge = new MqttDiscoveryBridge(this.bridgeHost(), (topic, payload) => void this.publishAsHa(topic, payload), env.mqtt.discoveryPrefix);
    if (this.tap) this.tap.tap((topic, payload) => this.bridge.onMessage(topic, payload));
    else {
      // an external broker shared with Klimo's own client: listen to discovery and state topics only, never
      // to the command topics Klimo subscribes itself (a broker may deliver overlapping matches twice)
      const prefix = env.mqtt.discoveryPrefix;
      const topics = [`${prefix}/+/+/config`, `${prefix}/+/+/+/config`, 'klimo/status', 'klimo/+/state', 'klimo/+/attrs', 'klimo/+/+/state', 'klimo/+/+/card'];
      transport.onMessage((topic, payload) => this.bridge.onMessage(topic, payload));
      transport.onConnect(() => void transport.subscribe(topics).catch(() => undefined));
    }
    this.resetStates(this.clock.now());
  }

  onModuleDestroy(): void {
    this.registryTimer?.cancel();
    if (this.templateFlush) clearImmediate(this.templateFlush);
    this.online = false;
  }

  /* ── HaPort ─────────────────────────────────────────────────────────────────────────────────── */

  get connected(): boolean {
    return this.online;
  }

  onConnection(cb: (ok: boolean) => void): void {
    this.connectionCbs.push(cb);
  }

  onStateChanged(cb: (entityId: EntityId, next: HaStateObj | null, prev: HaStateObj | null) => void): void {
    this.stateCbs.push(cb);
  }

  onEvent(cb: (eventType: string, data: Doc, context: { id: string | null; user_id: string | null; parent_id: string | null }) => void): void {
    this.eventCbs.push(cb);
  }

  getState(entityId: EntityId): HaStateObj | undefined {
    return this.states.get(entityId);
  }

  allStates(): HaStateObj[] {
    return [...this.states.values()];
  }

  async callService(domain: string, service: string, target?: { entity_id?: EntityId | EntityId[] }, data: Doc = {}, returnResponse = false): Promise<HaServiceResult> {
    return this.call(null, domain, service, target, data, returnResponse);
  }

  async fireEvent(eventType: string, data: Doc): Promise<void> {
    if (!this.online) throw new Error('Home Assistant is not connected');
    this.emitEvent(eventType, data, { id: newContextId(this.clock.now()), user_id: null, parent_id: null });
  }

  async subscribeEvents(eventType: string): Promise<void> {
    this.subscribed.add(eventType);
  }

  async subscribeTemplate(template: string, variables: Doc, cb: (result: unknown, error: string | null) => void): Promise<() => void> {
    const sub: TemplateSub = { template, variables, cb, entities: new Set(), all: false, last: undefined };
    this.templates.add(sub);
    setImmediate(() => this.renderSub(sub));
    return () => {
      this.templates.delete(sub);
    };
  }

  async history(entityIds: EntityId[], start: EpochMs, end: EpochMs, opts: { minimal: boolean; noAttributes: boolean }) {
    return this.recorder.history(entityIds, start, end, opts);
  }

  async statistics(statIds: string[], start: EpochMs, end: EpochMs, period: '5minute' | 'hour' | 'day' | 'week' | 'month', types: ('mean' | 'min' | 'max' | 'state' | 'sum' | 'change')[]) {
    return this.recorder.statistics(statIds, start, end, period, types, this.clock.now());
  }

  registries(): HaRegistries {
    return this.reg;
  }

  onRegistriesUpdated(cb: () => void): void {
    this.registryCbs.push(cb);
  }

  config(): HaConfigInfo | null {
    return { time_zone: this.clock.tz(), unit_system: { temperature: '°C' }, language: env.sim.lang, version: '2026.10.0', latitude: HOME.latitude, longitude: HOME.longitude };
  }

  async authUsers(): Promise<{ id: string; name: string; is_admin: boolean; system_generated: boolean }[]> {
    return USERS.map((u) => ({ ...u, name: simText(u.name, env.sim.lang) }));
  }

  async ensureLovelaceResource(url: string): Promise<'created' | 'updated' | 'exists' | 'unsupported'> {
    const path = url.split('?')[0];
    const prev = this.lovelace.get(path);
    this.lovelace.set(path, url);
    if (prev === undefined) return 'created';
    return prev === url ? 'exists' : 'updated';
  }

  /** `get_services` (the notify and Telegram pickers list what HA offers). */
  async services(): Promise<Record<string, Record<string, unknown>>> {
    const svc = (...names: string[]) => Object.fromEntries(names.map((n) => [n, {}]));
    return {
      homeassistant: svc('turn_on', 'turn_off', 'toggle', 'update_entity'),
      climate: svc('set_temperature', 'set_hvac_mode', 'set_fan_mode', 'set_preset_mode', 'turn_on', 'turn_off'),
      switch: svc('turn_on', 'turn_off', 'toggle'),
      input_boolean: svc('turn_on', 'turn_off', 'toggle'),
      light: svc('turn_on', 'turn_off', 'toggle'),
      fan: svc('turn_on', 'turn_off', 'set_percentage'),
      valve: svc('open_valve', 'close_valve', 'set_valve_position'),
      lock: svc('lock', 'unlock'),
      number: svc('set_value'),
      input_number: svc('set_value'),
      select: svc('select_option'),
      input_select: svc('select_option'),
      button: svc('press'),
      script: svc('turn_on', 'turn_off'),
      weather: svc('get_forecasts'),
      calendar: svc('get_events'),
      notify: svc('mobile_app_phone', 'mobile_app_kitchen_tablet', 'persistent_notification', 'send_message'),
      persistent_notification: svc('create', 'dismiss'),
      telegram_bot: svc('send_message', 'edit_message', 'answer_callback_query', 'delete_message'),
      mqtt: svc('publish'),
    };
  }

  /* ── TemplateHost ─────────────────────────────────────────────────────────────────────────────── */

  state(entityId: string): string | undefined {
    return this.states.get(entityId)?.state;
  }

  attributes(entityId: string): Record<string, unknown> | undefined {
    return this.states.get(entityId)?.attributes;
  }

  entityIds(): string[] {
    return [...this.states.keys()];
  }

  /* ── simulator surface ────────────────────────────────────────────────────────────────────────── */

  connect(): void {
    if (this.online) return;
    this.online = true;
    this.log.log(`connected: ${this.states.size} entities, ${this.reg.devices.length} devices`);
    for (const cb of this.connectionCbs) this.safely(() => cb(true));
    this.bus.emit('ha.connection', { connected: true });
    this.emitEvent('homeassistant_started', {}, { id: newContextId(this.clock.now()), user_id: null, parent_id: null });
    // HA's MQTT birth message: integrations republish their discovery when they see it
    void this.publishAsHa(`${env.mqtt.discoveryPrefix}/status`, 'online');
    for (const sub of this.templates) setImmediate(() => this.renderSub(sub));
  }

  disconnect(): void {
    if (!this.online) return;
    void this.publishAsHa(`${env.mqtt.discoveryPrefix}/status`, 'offline');
    this.online = false;
    for (const cb of this.connectionCbs) this.safely(() => cb(false));
    this.bus.emit('ha.connection', { connected: false });
  }

  /** Rebuilds every device and global entity at `at` (scenario start or warm-up start). */
  resetStates(at: EpochMs): void {
    const keep = new Map([...this.states].filter(([id]) => this.bridge.isBridged(id)));
    this.states = keep;
    this.runtime.clear();
    this.bridgeOffline.clear();
    this.countdown = { remainingMs: 0, shown: 0, at };
    const ctx = this.systemContext(at);
    for (const d of DEVICES) {
      this.runtime.set(d.id, {
        spec: d,
        lqiBase: d.zigbee?.lqi ?? 0,
        batteryBase: d.zigbee?.batteryPct ?? null,
        batteryAt: at,
        unavailable: false,
        stale: false,
        noAck: false,
        stash: new Map(),
        lastLqi: d.zigbee?.lqi ?? 0,
      });
      for (const e of d.entities) {
        if (e.disabled) continue;
        this.states.set(e.entityId, { entity_id: e.entityId, state: e.state, attributes: { ...e.attributes, friendly_name: simFriendlyName(d, e) }, last_changed: iso(at), last_updated: iso(at), last_reported: iso(at), context: ctx });
      }
    }
    for (const p of PERSONS) {
      this.states.set(p.entityId, { entity_id: p.entityId, state: 'home', attributes: { friendly_name: simText(p.name, env.sim.lang), user_id: p.userId, device_trackers: [p.tracker], id: p.entityId.slice(7) }, last_changed: iso(at), last_updated: iso(at), last_reported: iso(at), context: ctx });
    }
    this.states.set('zone.home', { entity_id: 'zone.home', state: String(PERSONS.length), attributes: { friendly_name: simText('Дім', env.sim.lang), latitude: HOME.latitude, longitude: HOME.longitude, radius: 100, passive: false, persons: PERSONS.map((p) => p.entityId) }, last_changed: iso(at), last_updated: iso(at), last_reported: iso(at), context: ctx });
    this.states.set('weather.home', { entity_id: 'weather.home', state: 'cloudy', attributes: { friendly_name: simText('Погода вдома', env.sim.lang), temperature: 5, temperature_unit: '°C', humidity: 80, cloud_coverage: 60, wind_speed: 12, wind_speed_unit: 'km/h', supported_features: 3 }, last_changed: iso(at), last_updated: iso(at), last_reported: iso(at), context: ctx });
    this.states.set('sun.sun', { entity_id: 'sun.sun', state: 'below_horizon', attributes: { friendly_name: simText('Сонце', env.sim.lang), elevation: -10, azimuth: 300, rising: false }, last_changed: iso(at), last_updated: iso(at), last_reported: iso(at), context: ctx });
    this.states.set('calendar.family', { entity_id: 'calendar.family', state: 'off', attributes: { friendly_name: simText('Сім’я', env.sim.lang), message: '', start_time: null, end_time: null }, last_changed: iso(at), last_updated: iso(at), last_reported: iso(at), context: ctx });
    for (const s of this.states.values()) this.recorder.record(s.entity_id, s.state, s.attributes, at);
  }

  /**
   * The boiler relay's own countdown (minutes): it runs while the relay is on and switches the relay
   * off at zero. Every written value restarts it — that is how Klimo keeps the boiler alive.
   */
  tickCountdown(at: EpochMs): void {
    const relay = this.states.get('switch.boiler_relay');
    const cd = this.states.get('number.boiler_relay_countdown');
    if (!relay || !cd || cd.state === 'unavailable') return;
    const shown = Number(cd.state);
    if (Number.isFinite(shown) && shown !== this.countdown.shown) this.countdown = { remainingMs: shown * 60_000, shown, at };
    const dt = Math.max(0, at - this.countdown.at);
    this.countdown.at = at;
    if (relay.state !== 'on' || this.countdown.remainingMs <= 0) return;
    this.countdown.remainingMs -= dt;
    if (this.countdown.remainingMs <= 0) {
      this.countdown = { remainingMs: 0, shown: 0, at };
      this.deviceSet('number.boiler_relay_countdown', '0', null, at);
      this.deviceSet('switch.boiler_relay', 'off', null, at);
      this.log.log('boiler relay switched itself off: its countdown ran out');
      return;
    }
    const next = Math.ceil(this.countdown.remainingMs / 60_000);
    if (next !== this.countdown.shown) {
      this.countdown.shown = next;
      this.deviceSet('number.boiler_relay_countdown', String(next), null, at);
    }
  }

  /** Battery levels of the catalogue are the levels at this moment (they drain before and after it). */
  setBatteryEpoch(at: EpochMs): void {
    for (const rt of this.runtime.values()) {
      rt.batteryBase = rt.spec.zigbee?.batteryPct ?? null;
      rt.batteryAt = at;
    }
  }

  /** A sensor report from the world (skipped while the device is unavailable or has gone quiet). */
  report(entityId: EntityId, state: string, attributes: Doc | null, at: EpochMs): boolean {
    const rt = this.runtimeOf(entityId);
    if (rt && (rt.unavailable || rt.stale || (rt.spec.zigbee && this.bridgeOffline.has(rt.spec.zigbee.instance)))) return false;
    this.put(entityId, state, attributes, at, this.systemContext(at));
    return true;
  }

  /** A change the device makes itself (countdown expiry, a knob turned): new context, no user. */
  deviceSet(entityId: EntityId, state: string, attributes: Doc | null, at: EpochMs, context?: Ctx): void {
    const rt = this.runtimeOf(entityId);
    if (rt?.unavailable) return;
    this.put(entityId, state, attributes, at, context ?? this.systemContext(at));
  }

  /** Entities that belong to no device (sun, weather, calendar). */
  setEntity(entityId: EntityId, state: string, attributes: Doc | null, at: EpochMs): void {
    this.put(entityId, state, attributes, at, this.systemContext(at));
  }

  /** Applies a desired actuator value at once — the warm-up drives devices directly, without the bus. */
  applyDesired(entityId: EntityId, value: DesiredValue, at: EpochMs): void {
    const s = this.states.get(entityId);
    if (!s || s.state === 'unavailable') return;
    const domain = entityId.split('.')[0];
    const ctx = this.systemContext(at);
    // a value the device refuses is simply not applied, as a real device would ignore it
    const svc = (service: string, data: Doc = {}) => {
      try {
        this.applyService(entityId, domain, service, data, ctx, at);
      } catch (e) {
        this.log.debug(`${entityId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    switch (value.kind) {
      case 'switch':
        svc(value.on ? 'turn_on' : 'turn_off');
        break;
      case 'climate':
        svc('set_hvac_mode', { hvac_mode: value.hvacMode });
        if (value.temperature !== null) svc('set_temperature', { temperature: value.temperature });
        if (value.targetLow !== null && value.targetHigh !== null) svc('set_temperature', { target_temp_low: value.targetLow, target_temp_high: value.targetHigh });
        if (value.fanMode !== null) svc('set_fan_mode', { fan_mode: value.fanMode });
        break;
      case 'number':
        svc('set_value', { value: value.value });
        break;
      case 'select':
        svc('select_option', { option: value.option });
        break;
      case 'valve':
        if (value.position !== null) svc('set_valve_position', { position: value.position });
        else svc(value.open ? 'open_valve' : 'close_valve');
        break;
      case 'fan':
        svc(value.on ? 'turn_on' : 'turn_off', value.percentage !== null ? { percentage: value.percentage } : {});
        break;
      default:
        break;
    }
  }

  /** A service call made by a given HA user (the card harness acts as «Ігор»). */
  async callServiceAs(userId: string | null, domain: string, service: string, data: Doc = {}): Promise<HaServiceResult> {
    const { entity_id, ...rest } = data;
    const target = entity_id === undefined ? undefined : { entity_id: entity_id as EntityId | EntityId[] };
    return this.call(userId, domain, service, target, rest, false);
  }

  /**
   * An event fired on the HA bus as a script or an automation would (`event` action): a script run from
   * the dashboard carries its user, an automation only a parent context.
   */
  async fireEventAs(userId: string | null, eventType: string, data: Doc = {}, fromAutomation = false): Promise<{ contextId: string }> {
    if (!this.online) throw new Error('Home Assistant is not connected');
    const at = this.clock.now();
    const ctx: Ctx = { id: newContextId(at), user_id: fromAutomation ? null : userId, parent_id: fromAutomation ? newContextId(at) : null };
    this.emitEvent(eventType, data, ctx);
    return { contextId: ctx.id as string };
  }

  outboxEntries(): OutboxEntry[] {
    return [...this.outbox];
  }

  /* ── link quality, battery, Zigbee2MQTT ──────────────────────────────────────────────────────── */

  batteryPct(deviceId: string, at: EpochMs): number | null {
    const rt = this.runtime.get(deviceId);
    if (!rt || rt.batteryBase === null) return null;
    const drain = rt.spec.zigbee?.drainPerDay ?? 0;
    return Math.max(1, Math.min(100, Math.round(rt.batteryBase + (drain * (rt.batteryAt - at)) / 86_400_000)));
  }

  lqi(deviceId: string): number {
    const rt = this.runtime.get(deviceId);
    if (!rt) return 0;
    rt.lastLqi = Math.round(Math.max(0, Math.min(255, rt.lqiBase + this.rng.jitter(6))));
    return rt.lastLqi;
  }

  /** Retained bridge state and device list of both Zigbee2MQTT instances. */
  async announceZigbee(): Promise<void> {
    for (const n of [1, 2] as const) {
      const base = z2mBase(n);
      await this.publishAsZigbee(`${base}/bridge/state`, JSON.stringify({ state: this.bridgeOffline.has(n) ? 'offline' : 'online' }), true);
      const devices = DEVICES.filter((d) => d.zigbee?.instance === n).map((d) => zigbeeDevice(d));
      devices.unshift({ ieee_address: n === 1 ? '0x00124b0029f1a2b3' : '0x00124b0031c4d5e6', type: 'Coordinator', friendly_name: 'Coordinator', definition: null, power_source: null, interview_completed: true, supported: true, disabled: false });
      await this.publishAsZigbee(`${base}/bridge/devices`, JSON.stringify(devices), true);
      for (const d of DEVICES) if (d.zigbee?.instance === n) await this.publishAvailability(d, !this.runtime.get(d.id)?.unavailable);
    }
  }

  /** Zigbee2MQTT's per-device availability (`<base>/<friendly_name>/availability`, retained). */
  private async publishAvailability(d: DeviceSpec, online: boolean): Promise<void> {
    if (!d.zigbee) return;
    await this.publishAsZigbee(`${z2mBase(d.zigbee.instance)}/${d.name}/availability`, JSON.stringify({ state: online ? 'online' : 'offline' }), true);
  }

  /** A device's own message on `<base>/<friendly_name>` (link quality, battery, last seen + values). */
  async zigbeeMessage(deviceId: string, values: Doc, at: EpochMs): Promise<void> {
    const rt = this.runtime.get(deviceId);
    const z = rt?.spec.zigbee;
    if (!rt || !z || !this.online || rt.unavailable || rt.stale || this.bridgeOffline.has(z.instance)) return;
    const msg: Doc = { ...values };
    if (z.link !== 'none') msg.linkquality = rt.lastLqi;
    // «last_seen» is a Zigbee2MQTT-wide option: the first instance has it on, the second leaves it off
    if (z.instance === 1) msg.last_seen = iso(at);
    const battery = this.batteryPct(deviceId, at);
    if (battery !== null) msg.battery = battery;
    // retained, as Zigbee2MQTT does with `retain: true`: a listener that subscribes later still learns the link state
    await this.publishAsZigbee(`${z2mBase(z.instance)}/${rt.spec.name}`, JSON.stringify(msg), true);
  }

  /* ── faults ─────────────────────────────────────────────────────────────────────────────────── */

  /** Fault injection on the device behind `entityId`. Throws for entities the simulator does not own. */
  fault(req: SimFaultRequest, at: EpochMs): void {
    const rt = this.runtimeOf(req.entityId);
    if (!rt) throw new Error(`no simulated device behind ${req.entityId}`);
    const d = rt.spec;
    switch (req.kind) {
      case 'unavailable':
        if (d.binding.kind === 'bridge') {
          this.setBridgeOnline(d.binding.instance, false, at);
          // «перезапуск Z2M»: the bridge comes back by itself
          if (req.value === 'restart') {
            const n = d.binding.instance;
            this.clock.setTimeout(() => this.setBridgeOnline(n, true, this.clock.now()), 30_000);
          }
          return;
        }
        this.setUnavailable(rt, true, at);
        return;
      case 'stale':
        rt.stale = true;
        return;
      case 'no_ack':
        rt.noAck = true;
        return;
      case 'weak':
        rt.lqiBase = typeof req.value === 'number' ? req.value : 40;
        return;
      case 'battery':
        rt.batteryBase = typeof req.value === 'number' ? Math.max(0, Math.min(100, req.value)) : 10;
        rt.batteryAt = at;
        this.refreshBattery(rt, at);
        return;
      case 'knob': {
        const climate = entityOfRole(d, 'climate');
        const s = climate ? this.states.get(climate.entityId) : undefined;
        if (!climate || !s) throw new Error(`${req.entityId} has no thermostat to turn`);
        const current = typeof s.attributes.temperature === 'number' ? s.attributes.temperature : 20;
        const next = typeof req.value === 'number' ? req.value : current + 2;
        // turned by hand: a context without a user and without a parent
        this.deviceSet(climate.entityId, s.state === 'off' ? 'heat' : s.state, { temperature: next }, at, { id: newContextId(at), user_id: null, parent_id: null });
        return;
      }
      case 'error_code': {
        const err = entityOfRole(d, 'error');
        if (!err) throw new Error(`${req.entityId} reports no error code`);
        this.deviceSet(err.entityId, typeof req.value === 'string' ? req.value : 'E3', null, at);
        return;
      }
      case 'clear': {
        if (d.binding.kind === 'bridge') this.setBridgeOnline(d.binding.instance, true, at);
        rt.stale = false;
        rt.noAck = false;
        rt.lqiBase = d.zigbee?.lqi ?? 0;
        if (rt.unavailable) this.setUnavailable(rt, false, at);
        const err = entityOfRole(d, 'error');
        if (err && this.states.get(err.entityId)?.state !== '0') this.deviceSet(err.entityId, '0', null, at);
        return;
      }
    }
  }

  /* ── internals: service calls ─────────────────────────────────────────────────────────────────── */

  private async call(userId: string | null, domain: string, service: string, target: { entity_id?: EntityId | EntityId[] } | undefined, data: Doc, returnResponse: boolean): Promise<HaServiceResult> {
    if (!this.online) throw new Error('Home Assistant is not connected');
    const at = this.clock.now();
    const ctx: Ctx = { id: newContextId(at), user_id: userId, parent_id: null };
    const ids = target?.entity_id === undefined ? [] : Array.isArray(target.entity_id) ? target.entity_id : [target.entity_id];
    const serviceData: Doc = ids.length ? { ...data, entity_id: target?.entity_id } : { ...data };
    this.emitEvent('call_service', { domain, service, service_data: serviceData }, ctx);

    let response: unknown = null;
    if (domain === 'weather' && service === 'get_forecasts') response = this.forecasts(ids, String(data.type ?? 'daily'));
    else if (domain === 'calendar' && service === 'get_events') response = this.calendarEvents(ids, data);
    else if (domain === 'notify' || domain === 'persistent_notification' || domain === 'telegram_bot') this.record(domain, service, serviceData, at);
    else if (domain === 'mqtt' && service === 'publish') {
      const topic = typeof data.topic === 'string' ? data.topic : null;
      if (!topic) throw new Error('mqtt.publish requires a topic');
      await this.publishAsHa(topic, typeof data.payload === 'string' ? data.payload : JSON.stringify(data.payload ?? ''), !!data.retain);
    } else {
      if (!ids.length) throw new Error(`${domain}.${service} needs a target entity`);
      for (const id of ids) this.dispatchWrite(id, domain, service, data, ctx, at);
    }
    return { context: { id: ctx.id }, response: returnResponse ? response : null };
  }

  private record(domain: string, service: string, data: Doc, at: EpochMs): void {
    this.outbox.push({ at, domain, service, data });
    if (this.outbox.length > OUTBOX_MAX) this.outbox.shift();
  }

  /** Routes a write to Klimo's MQTT entities or to a device, with the device's latency and losses. */
  private dispatchWrite(entityId: EntityId, domain: string, service: string, data: Doc, ctx: Ctx, at: EpochMs): void {
    const entityDomain = entityId.split('.')[0];
    const effective = domain === 'homeassistant' ? entityDomain : domain;
    if (this.bridge.isBridged(entityId)) {
      if (!this.bridge.command(entityId, service, data)) throw new Error(`${effective}.${service} is not supported by ${entityId}`);
      return;
    }
    const s = this.states.get(entityId);
    if (!s) throw new Error(`Entity ${entityId} not found`);
    if (effective !== entityDomain) throw new Error(`${domain}.${service} cannot act on ${entityId}`);
    const rt = this.runtimeOf(entityId);
    if (!rt) {
      this.applyService(entityId, effective, service, data, ctx, at);
      return;
    }
    // HA validates the call before it is sent to the device
    this.serviceResult(s, effective, service, data, at);
    const z = rt.spec.zigbee;
    if (rt.unavailable || rt.noAck || (z && this.bridgeOffline.has(z.instance))) return;
    // a weak Zigbee link loses some commands: retries become visible
    if (z && rt.lqiBase < WEAK_LQI && this.rng.chance(LOSS_WHEN_WEAK)) return;
    const delay = rt.spec.binding.kind === 'trv' ? this.rng.range(TRV_DELAY[0], TRV_DELAY[1]) : OTHER_DELAY;
    this.clock.setTimeout(() => {
      if (rt.unavailable || rt.noAck) return;
      this.applyService(entityId, effective, service, data, ctx, this.clock.now());
    }, delay);
  }

  /** What a service does to an entity's state (HA + device semantics). */
  private applyService(entityId: EntityId, domain: string, service: string, data: Doc, ctx: Ctx, at: EpochMs): void {
    const s = this.states.get(entityId);
    if (!s || s.state === 'unavailable') return;
    const next = this.serviceResult(s, domain, service, data, at);
    if (domain === 'script' && next.state === 'on') this.clock.setTimeout(() => this.put(entityId, 'off', null, this.clock.now(), ctx), 1000);
    this.put(entityId, next.state, Object.keys(next.attrs).length ? next.attrs : null, at, ctx);
  }

  /** The state a service would produce; throws like HA's service validation does. */
  private serviceResult(s: HaStateObj, domain: string, service: string, data: Doc, at: EpochMs): { state: string; attrs: Doc } {
    const entityId = s.entity_id;
    const attrs: Doc = {};
    let state = s.state;
    const num = (v: unknown) => (typeof v === 'number' ? v : Number(v));
    switch (domain) {
      case 'climate': {
        const modes = Array.isArray(s.attributes.hvac_modes) ? (s.attributes.hvac_modes as string[]) : [];
        if (service === 'set_temperature' || service === 'set_hvac_mode') {
          const mode = typeof data.hvac_mode === 'string' ? data.hvac_mode : null;
          if (mode !== null) {
            if (!modes.includes(mode)) throw new Error(`hvac mode ${mode} not supported by ${entityId}`);
            state = mode;
          }
          if (data.temperature !== undefined) attrs.temperature = this.clampTo(s, num(data.temperature));
          if (data.target_temp_low !== undefined) attrs.target_temp_low = this.clampTo(s, num(data.target_temp_low));
          if (data.target_temp_high !== undefined) attrs.target_temp_high = this.clampTo(s, num(data.target_temp_high));
        } else if (service === 'set_fan_mode') attrs.fan_mode = String(data.fan_mode);
        else if (service === 'set_preset_mode') attrs.preset_mode = String(data.preset_mode);
        else if (service === 'turn_off') state = 'off';
        else if (service === 'turn_on') state = s.state === 'off' ? modes.find((m) => m !== 'off') ?? s.state : s.state;
        else throw new Error(`Service climate.${service} not found`);
        break;
      }
      case 'switch':
      case 'input_boolean':
      case 'light':
      case 'fan':
      case 'humidifier':
        if (service === 'turn_on') state = 'on';
        else if (service === 'turn_off') state = 'off';
        else if (service === 'toggle') state = s.state === 'on' ? 'off' : 'on';
        else if (service === 'set_percentage' && domain === 'fan') {
          attrs.percentage = num(data.percentage);
          state = num(data.percentage) > 0 ? 'on' : 'off';
        } else throw new Error(`Service ${domain}.${service} not found`);
        if (domain === 'fan' && data.percentage !== undefined) attrs.percentage = num(data.percentage);
        break;
      case 'number':
      case 'input_number': {
        if (service !== 'set_value') throw new Error(`Service ${domain}.${service} not found`);
        const v = num(data.value);
        if (!Number.isFinite(v)) throw new Error(`invalid value for ${entityId}`);
        const min = typeof s.attributes.min === 'number' ? s.attributes.min : -Infinity;
        const max = typeof s.attributes.max === 'number' ? s.attributes.max : Infinity;
        if (v < min || v > max) throw new Error(`Value ${v} for ${entityId} is outside valid range ${min} - ${max}`);
        state = String(Math.round(v * 100) / 100);
        break;
      }
      case 'select':
      case 'input_select': {
        if (service !== 'select_option') throw new Error(`Service ${domain}.${service} not found`);
        const options = Array.isArray(s.attributes.options) ? (s.attributes.options as string[]) : [];
        const option = String(data.option);
        if (!options.includes(option)) throw new Error(`Option ${option} is not valid for ${entityId}`);
        state = option;
        break;
      }
      case 'valve':
        if (service === 'open_valve') state = 'open';
        else if (service === 'close_valve') state = 'closed';
        else if (service === 'set_valve_position') {
          attrs.current_position = num(data.position);
          state = num(data.position) > 0 ? 'open' : 'closed';
        } else throw new Error(`Service valve.${service} not found`);
        break;
      case 'lock':
        if (service === 'lock') state = 'locked';
        else if (service === 'unlock') state = 'unlocked';
        else throw new Error(`Service lock.${service} not found`);
        break;
      case 'script':
        state = service === 'turn_off' ? 'off' : 'on';
        break;
      case 'button':
        state = iso(at);
        break;
      default:
        throw new Error(`Service ${domain}.${service} not found`);
    }
    return { state, attrs };
  }

  private clampTo(s: HaStateObj, v: number): number {
    const min = typeof s.attributes.min_temp === 'number' ? s.attributes.min_temp : -Infinity;
    const max = typeof s.attributes.max_temp === 'number' ? s.attributes.max_temp : Infinity;
    return Math.min(max, Math.max(min, v));
  }

  /* ── internals: state machine ─────────────────────────────────────────────────────────────────── */

  /** Sets a state with HA semantics: last_changed / last_updated / last_reported, recorder, events. */
  private put(entityId: EntityId, state: string, attributes: Doc | null, at: EpochMs, context: Ctx, replace = false): void {
    const prev = this.states.get(entityId) ?? null;
    const attrs = replace && attributes ? attributes : attributes ? { ...(prev?.attributes ?? {}), ...attributes } : prev?.attributes ?? {};
    const stateChanged = !prev || prev.state !== state;
    const attrsChanged = !prev || !sameAttrs(prev.attributes, attrs);
    const t = iso(at);
    if (!stateChanged && !attrsChanged && prev) {
      // a report with nothing new only moves last_reported (HA ≥ 2024.3)
      this.states.set(entityId, { ...prev, last_reported: t });
      return;
    }
    const next: HaStateObj = {
      entity_id: entityId,
      state,
      attributes: attrs,
      last_changed: stateChanged ? t : prev?.last_changed ?? t,
      last_updated: t,
      last_reported: t,
      context,
    };
    this.states.set(entityId, next);
    this.recorder.record(entityId, state, attrs, at);
    if (!this.online) return;
    for (const cb of this.stateCbs) this.safely(() => cb(entityId, next, prev));
    this.markTemplates(entityId);
  }

  private remove(entityId: EntityId): void {
    const prev = this.states.get(entityId);
    if (!prev) return;
    this.states.delete(entityId);
    if (!this.online) return;
    for (const cb of this.stateCbs) this.safely(() => cb(entityId, null, prev));
    this.markTemplates(entityId);
  }

  /** Non-state events of subscribed types (state changes reach their listeners through onStateChanged). */
  private emitEvent(type: string, data: Doc, ctx: { id: string | null; user_id: string | null; parent_id: string | null }): void {
    if (!this.online || !this.subscribed.has(type)) return;
    for (const cb of this.eventCbs) this.safely(() => cb(type, data, ctx));
  }

  private systemContext(at: EpochMs): Ctx {
    return { id: newContextId(at), user_id: null, parent_id: null };
  }

  private runtimeOf(entityId: EntityId): DeviceRuntime | undefined {
    const d = deviceOfEntity(entityId);
    return d ? this.runtime.get(d.id) : undefined;
  }

  private setUnavailable(rt: DeviceRuntime, off: boolean, at: EpochMs): void {
    const ctx = this.systemContext(at);
    void this.publishAvailability(rt.spec, !off);
    if (off) {
      rt.unavailable = true;
      for (const e of rt.spec.entities) {
        const s = this.states.get(e.entityId);
        if (!s) continue;
        if (s.state !== 'unavailable') rt.stash.set(e.entityId, s);
        this.put(e.entityId, 'unavailable', null, at, ctx);
      }
    } else {
      rt.unavailable = false;
      for (const e of rt.spec.entities) {
        const before = rt.stash.get(e.entityId);
        this.put(e.entityId, before?.state ?? e.state, before?.attributes ?? null, at, ctx);
      }
      rt.stash.clear();
    }
  }

  private setBridgeOnline(n: 1 | 2, online: boolean, at: EpochMs): void {
    const was = !this.bridgeOffline.has(n);
    if (was === online) return;
    if (online) this.bridgeOffline.delete(n);
    else this.bridgeOffline.add(n);
    const bridge = DEVICES.find((d) => d.binding.kind === 'bridge' && d.binding.instance === n);
    if (bridge) this.put(bridge.entities[0].entityId, online ? 'on' : 'off', null, at, this.systemContext(at));
    for (const d of DEVICES) {
      const rt = this.runtime.get(d.id);
      if (!rt || d.zigbee?.instance !== n || rt.unavailable) continue;
      for (const e of d.entities) {
        const s = this.states.get(e.entityId);
        if (!s) continue;
        if (!online) {
          if (s.state !== 'unavailable') rt.stash.set(e.entityId, s);
          this.put(e.entityId, 'unavailable', null, at, this.systemContext(at));
        } else {
          const before = rt.stash.get(e.entityId);
          this.put(e.entityId, before?.state ?? e.state, before?.attributes ?? null, at, this.systemContext(at));
        }
      }
      if (online) rt.stash.clear();
    }
    void this.publishAsZigbee(`${z2mBase(n)}/bridge/state`, JSON.stringify({ state: online ? 'online' : 'offline' }), true);
    this.log.log(`Z2M #${n} ${online ? 'online' : 'offline'}`);
  }

  private refreshBattery(rt: DeviceRuntime, at: EpochMs): void {
    const battery = entityOfRole(rt.spec, 'battery');
    const pct = this.batteryPct(rt.spec.id, at);
    if (battery && pct !== null) this.report(battery.entityId, String(pct), null, at);
  }

  /* ── internals: templates ──────────────────────────────────────────────────────────────────────── */

  private markTemplates(entityId: EntityId): void {
    if (!this.templates.size) return;
    this.dirtyEntities.add(entityId);
    if (this.templateFlush) return;
    this.templateFlush = setImmediate(() => {
      this.templateFlush = null;
      const changed = new Set(this.dirtyEntities);
      this.dirtyEntities.clear();
      for (const sub of this.templates) if (sub.all || [...sub.entities].some((e) => changed.has(e))) this.renderSub(sub);
    });
  }

  private renderSub(sub: TemplateSub): void {
    if (!this.online || !this.templates.has(sub)) return;
    let key: string;
    let result: unknown = null;
    let error: string | null = null;
    try {
      const r = evaluateTemplate(sub.template, this, sub.variables);
      sub.entities = r.info.entities;
      sub.all = r.info.all;
      result = r.value;
      key = `ok:${JSON.stringify(result)}`;
    } catch (e) {
      error = e instanceof TemplateError ? e.message : `TemplateError: ${e instanceof Error ? e.message : String(e)}`;
      key = `err:${error}`;
    }
    if (key === sub.last) return;
    sub.last = key;
    this.safely(() => sub.cb(result, error));
  }

  /* ── internals: forecasts, calendar ─────────────────────────────────────────────────────────── */

  private forecasts(ids: EntityId[], type: string): Doc {
    const out: Doc = {};
    const now = this.clock.now();
    for (const id of ids) {
      const s = this.states.get(id);
      if (!s) continue;
      const t = typeof s.attributes.temperature === 'number' ? s.attributes.temperature : 10;
      const list: Doc[] = [];
      if (type === 'hourly') {
        for (let i = 0; i < 24; i++) {
          const at = Math.floor(now / 3_600_000) * 3_600_000 + i * 3_600_000;
          list.push({ datetime: iso(at), temperature: Math.round((t + 2.5 * Math.sin(((at / 3_600_000) % 24 - 9) * (Math.PI / 12))) * 10) / 10, condition: s.state });
        }
      } else {
        for (let i = 0; i < 5; i++) {
          const at = now + i * 86_400_000;
          list.push({ datetime: iso(at), temperature: Math.round((t + 2.5 - i * 0.4) * 10) / 10, templow: Math.round((t - 3.5 - i * 0.4) * 10) / 10, condition: i === 0 ? s.state : 'partlycloudy' });
        }
      }
      out[id] = { forecast: list };
    }
    return out;
  }

  /** «Гості» every Friday 19:00–23:30 on the family calendar. */
  private calendarEvents(ids: EntityId[], data: Doc): Doc {
    const out: Doc = {};
    const from = typeof data.start_date_time === 'string' ? Date.parse(data.start_date_time) : this.clock.now();
    const to = typeof data.end_date_time === 'string' ? Date.parse(data.end_date_time) : from + 2 * 86_400_000;
    for (const id of ids) {
      if (id !== 'calendar.family') {
        out[id] = { events: [] };
        continue;
      }
      out[id] = { events: guestEvents(from, to, this.clock.tz()).map((e) => ({ start: iso(e.start), end: iso(e.end), summary: simText('Гості', env.sim.lang), description: simText('Друзі на вечерю', env.sim.lang), location: '' })) };
    }
    return out;
  }

  /* ── internals: MQTT ────────────────────────────────────────────────────────────────────────── */

  private async publishAsHa(topic: string, payload: string, retain = false): Promise<void> {
    try {
      if (this.tap) await this.tap.inject(topic, payload, { retain, origin: 'ha' });
      else if (this.transport.connected) await this.transport.publish(topic, payload, { retain, qos: 0 });
    } catch (e) {
      this.log.warn(`publish ${topic} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async publishAsZigbee(topic: string, payload: string, retain: boolean): Promise<void> {
    try {
      if (this.tap) await this.tap.inject(topic, payload, { retain, origin: 'z2m' });
      else if (this.transport.connected) await this.transport.publish(topic, payload, { retain, qos: 0 });
    } catch (e) {
      this.log.warn(`publish ${topic} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private bridgeHost() {
    const self = this;
    return {
      now: () => self.clock.now(),
      state: (id: string) => self.state(id),
      attributes: (id: string) => self.attributes(id),
      entityIds: () => self.entityIds(),
      entityExists: (id: EntityId) => self.states.has(id) || self.reg.entities.some((e) => e.entity_id === id),
      // a discovered entity's attributes are replaced as a whole, not merged
      setState: (id: EntityId, state: string, attributes: Doc) => self.put(id, state, attributes, self.clock.now(), self.systemContext(self.clock.now()), true),
      removeState: (id: EntityId) => self.remove(id),
      register: (entity: HaRegistries['entities'][number], device: HaRegistries['devices'][number] | null) => {
        const created = !self.reg.entities.some((e) => e.entity_id === entity.entity_id);
        self.reg = {
          ...self.reg,
          entities: [...self.reg.entities.filter((e) => e.entity_id !== entity.entity_id), entity],
          devices: device ? [...self.reg.devices.filter((d) => d.id !== device.id), device] : self.reg.devices,
        };
        if (entity.unique_id && self.isMeasurementCandidate(entity.entity_id)) self.recorder.markMeasurement(entity.entity_id);
        self.registryChanged(created ? 'create' : 'update', entity.entity_id);
      },
      unregister: (id: EntityId) => {
        const entity = self.reg.entities.find((e) => e.entity_id === id);
        const entities = self.reg.entities.filter((e) => e.entity_id !== id);
        const devices = entity?.device_id && !entities.some((e) => e.device_id === entity.device_id) ? self.reg.devices.filter((d) => d.id !== entity.device_id) : self.reg.devices;
        self.reg = { ...self.reg, entities, devices };
        self.registryChanged('remove', id);
      },
    };
  }

  private isMeasurementCandidate(entityId: EntityId): boolean {
    return /^sensor\.klimo_.*_(temperature|target|humidity|dew_point)$/.test(entityId) || entityId === 'sensor.klimo_outdoor_average';
  }

  private registryChanged(action: 'create' | 'update' | 'remove', entityId: EntityId): void {
    this.emitEvent('entity_registry_updated', { action, entity_id: entityId }, this.systemContext(this.clock.now()));
    if (this.registryTimer) return;
    this.registryTimer = this.clock.setTimeout(() => {
      this.registryTimer = null;
      for (const cb of this.registryCbs) this.safely(() => cb());
    }, 1000);
  }

  private safely(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.log.warn(`listener failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    }
  }
}

/** Zigbee2MQTT `bridge/devices` entry with the exposes Klimo reads (heads: setpoint, external sensor…). */
function zigbeeDevice(d: DeviceSpec): Doc {
  const z = d.zigbee!;
  const numeric = (property: string, min: number, max: number, step: number, unit?: string) => ({ type: 'numeric', name: property, property, access: 7, value_min: min, value_max: max, value_step: step, ...(unit ? { unit } : {}) });
  const binary = (property: string) => ({ type: 'binary', name: property, property, access: 7, value_on: 'LOCK', value_off: 'UNLOCK' });
  let exposes: Doc[] = [];
  if (d.binding.kind === 'trv' || (d.binding.kind === 'spare' && d.entities.some((e) => e.role === 'climate'))) {
    const tuya = d.binding.kind === 'trv' && d.binding.tuya;
    exposes = [
      {
        type: 'climate',
        features: [
          numeric('occupied_heating_setpoint', tuya ? 5 : 4, 35, 0.5, '°C'),
          { type: 'numeric', name: 'local_temperature', property: 'local_temperature', access: 5, unit: '°C' },
          numeric('local_temperature_calibration', tuya ? -9 : -7, tuya ? 9 : 7, tuya ? 1 : 0.2, '°C'),
          { type: 'enum', name: 'system_mode', property: 'system_mode', access: 7, values: ['off', 'heat'] },
          { type: 'enum', name: 'running_state', property: 'running_state', access: 5, values: ['idle', 'heat'] },
        ],
      },
      binary('child_lock'),
      { type: 'binary', name: tuya ? 'window_detection' : 'open_window', property: tuya ? 'window_detection' : 'open_window', access: 7, value_on: 'ON', value_off: 'OFF' },
      { type: 'numeric', name: 'battery', property: 'battery', access: 1, unit: '%' },
      { type: 'numeric', name: 'linkquality', property: 'linkquality', access: 1, unit: 'lqi' },
    ];
    if (tuya) exposes.push({ type: 'numeric', name: 'position', property: 'position', access: 1, unit: '%' });
    else
      exposes.push(
        numeric('external_temperature_input', 0, 99.9, 0.1, '°C'),
        { type: 'enum', name: 'temperature_sensor_select', property: 'temperature_sensor_select', access: 7, values: ['internal', 'external', 'external_2', 'external_3'] },
        numeric('valve_opening_degree', 0, 100, 1, '%'),
        numeric('valve_closing_degree', 0, 100, 1, '%'),
      );
  } else if (d.binding.kind === 'thermo' || d.entities.some((e) => e.role === 'temperature')) {
    exposes = [
      { type: 'numeric', name: 'temperature', property: 'temperature', access: 1, unit: '°C' },
      { type: 'numeric', name: 'humidity', property: 'humidity', access: 1, unit: '%' },
      { type: 'numeric', name: 'battery', property: 'battery', access: 1, unit: '%' },
    ];
  } else if (d.binding.kind === 'contact') {
    exposes = [
      { type: 'binary', name: 'contact', property: 'contact', access: 1, value_on: false, value_off: true },
      { type: 'numeric', name: 'battery', property: 'battery', access: 1, unit: '%' },
    ];
  } else {
    exposes = [{ type: 'switch', features: [{ type: 'binary', name: 'state', property: 'state', access: 7, value_on: 'ON', value_off: 'OFF' }] }];
    if (d.binding.kind === 'boiler') exposes.push(numeric('countdown', 0, 120, 1, 'min'));
    if (d.entities.some((e) => e.role === 'power')) exposes.push({ type: 'numeric', name: 'power', property: 'power', access: 5, unit: 'W' });
  }
  const [vendor, ...model] = d.model.split(' ');
  return {
    ieee_address: z.ieee,
    type: z.mains ? 'Router' : 'EndDevice',
    network_address: parseInt(z.ieee.slice(-4), 16),
    friendly_name: d.name,
    power_source: z.mains ? 'Mains (single phase)' : 'Battery',
    model_id: model.join(' ') || d.model,
    manufacturer: d.manufacturer,
    interview_completed: true,
    supported: true,
    disabled: false,
    definition: { model: model.join(' ') || d.model, vendor: model.length ? vendor : d.manufacturer, description: simText(d.label, env.sim.lang), exposes, options: [] },
  };
}

/** Friday-evening guest events overlapping [from, to). */
export function guestEvents(from: EpochMs, to: EpochMs, tz: string): { start: EpochMs; end: EpochMs }[] {
  const out: { start: EpochMs; end: EpochMs }[] = [];
  let date = toLocal(from - 86_400_000, tz).date;
  const last = toLocal(to + 86_400_000, tz).date;
  for (let guard = 0; date <= last && guard < 400; guard++) {
    if (dowOfDate(date) === 4) {
      const start = fromLocal(date, 19 * 60, tz);
      const end = fromLocal(date, 23 * 60 + 30, tz);
      if (end > from && start < to) out.push({ start, end });
    }
    date = addDays(date, 1);
  }
  return out;
}
