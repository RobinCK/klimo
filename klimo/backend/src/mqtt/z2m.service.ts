import { Inject, Injectable, Logger } from '@nestjs/common';
import { errorText, LogOnce } from '../common/logger';
import type { Actor, ClockPort, EpochMs, HaPort, IBus, IConfigStore, Id, MqttTransport, Pct, TrvCapabilities, Z2mInstance } from '../shared/model';
import { BUS, CLOCK, CONFIG_STORE, HA_PORT, MQTT_TRANSPORT } from '../tokens';

const LQI_WINDOW_MS = 6 * 60 * 60_000;
/** One link-quality sample per device per minute is plenty for a 6-hour median. */
const LQI_SAMPLE_MS = 60_000;
const MAX_DEVICES = 2_000;
/** A device heard again after this long is news for device health (it may have been reported offline). */
const QUIET_MS = 5 * 60_000;
/** A `last_seen` this far ahead of our clock is a clock skew, not the future. */
const SKEW_MS = 60_000;

const SYSTEM: Actor = { via: 'system', userId: null, userName: null, contextId: null };

/** What Zigbee2MQTT tells about one device (from the retained `bridge/devices` list). */
export interface Z2mDeviceInfo {
  ieee: string | null;
  friendlyName: string;
  model: string | null;
  vendor: string | null;
  powerSource: string | null;
  /** Thermostatic valve capabilities, when the device exposes a heating setpoint. */
  trv: TrvCapabilities | null;
}

/** Live link data from the device's own messages. */
export interface Z2mDeviceLink {
  lqi: number | null;
  /** Median of the last 6 h (device health uses it for «слабкий сигнал»). */
  lqiMedian: number | null;
  lqiSamples: number;
  /** When the latest link quality was reported. */
  lqiAt: EpochMs | null;
  batteryPct: Pct | null;
  batteryAt: EpochMs | null;
  lastSeenAt: EpochMs | null;
  available: boolean | null;
}

interface Link {
  samples: [EpochMs, number][];
  lqiAt: EpochMs | null;
  battery: Pct | null;
  batteryAt: EpochMs | null;
  lastSeenAt: EpochMs | null;
  available: boolean | null;
}

interface Bridge {
  online: boolean | null;
  devices: Map<string, Z2mDeviceInfo>;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Zigbee2MQTT's `last_seen` in any of its formats: ISO 8601 (UTC or local offset) or epoch ms. */
export function parseLastSeen(v: unknown): EpochMs | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v < 1e11 ? v * 1000 : v;
  if (typeof v !== 'string' || !v.trim()) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** `online` / `offline`, plain (Z2M < 1.29) or `{"state": …}`. */
export function parseOnline(payload: string): boolean | null {
  const text = payload.trim();
  let value: unknown = text;
  if (text.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(text);
      value = isObj(parsed) ? parsed.state : null;
    } catch {
      return null;
    }
  }
  if (value === 'online') return true;
  if (value === 'offline') return false;
  return null;
}

interface Feature {
  name: string;
  type: string | null;
  min: number | null;
  max: number | null;
  step: number | null;
  writable: boolean;
}

function features(exposes: unknown): Feature[] {
  const out: Feature[] = [];
  const walk = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const e of list) {
      if (!isObj(e)) continue;
      const name = str(e.property) ?? str(e.name);
      const access = num(e.access);
      if (name) {
        out.push({ name, type: str(e.type), min: num(e.value_min), max: num(e.value_max), step: num(e.value_step), writable: access === null || (access & 2) !== 0 });
      }
      walk(e.features);
    }
  };
  walk(exposes);
  return out;
}

const EXTERNAL_SENSOR = ['external_temperature_input', 'external_measured_room_sensor', 'external_temperature', 'remote_temperature', 'external_sensor_temperature'];
const VALVE_POSITION = ['position', 'pi_heating_demand', 'valve_position', 'running_state_valve'];
const WINDOW_DETECTION = ['window_detection', 'window_open_feature', 'open_window', 'window_open_detection'];

/** TRV capabilities read from Zigbee2MQTT `exposes`; null for anything that is not a heating valve. */
export function trvCapabilities(exposes: unknown): TrvCapabilities | null {
  const fs = features(exposes);
  const has = (names: string[]) => fs.some((f) => names.includes(f.name));
  const setpoint = fs.find((f) => f.name === 'occupied_heating_setpoint' || f.name === 'current_heating_setpoint');
  if (!setpoint) return null;
  const calibration = fs.find((f) => f.name === 'local_temperature_calibration');
  return {
    externalSensor: fs.some((f) => EXTERNAL_SENSOR.includes(f.name) && f.writable),
    calibration: !!calibration,
    calibrationRange: calibration && calibration.min !== null && calibration.max !== null ? [calibration.min, calibration.max] : null,
    valveLimits: has(['valve_opening_degree']) && has(['valve_closing_degree']),
    valvePosition: has(VALVE_POSITION),
    childLock: has(['child_lock']),
    windowDetection: has(WINDOW_DETECTION),
    setpointRange: [setpoint.min ?? 5, setpoint.max ?? 30],
    setpointStep: setpoint.step ?? 0.5,
  };
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Zigbee2MQTT side channel. Instances announce themselves with a retained `<base>/bridge/state`
 * (an unknown base topic becomes a «Z2M #n» instance); the bridge's device list gives model, power
 * source and TRV capabilities; device messages give link quality, battery and last seen. Writes still
 * go through HA entities — except `z2m:` pseudo siblings, which the command bus publishes itself.
 */
@Injectable()
export class Z2mService {
  private readonly log = new Logger('Z2M');
  private readonly once = new LogOnce(this.log);
  private readonly bridges = new Map<Id, Bridge>();
  private readonly links = new Map<string, Link>();
  private readonly creating = new Set<string>();
  private readonly subscribed = new Set<string>();

  constructor(
    @Inject(CONFIG_STORE) private readonly config: IConfigStore,
    @Inject(BUS) private readonly bus: IBus,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(HA_PORT) private readonly ha: HaPort,
    @Inject(MQTT_TRANSPORT) private readonly transport: MqttTransport,
  ) {}

  /** Bridge announcements of any instance plus every configured instance's own topics. */
  subscriptions(): string[] {
    return ['+/bridge/state', ...this.instances().map((i) => `${i.baseTopic}/#`)];
  }

  /** Re-subscribes after a (re)connect, and subscribes instances added since. */
  async subscribe(): Promise<void> {
    this.subscribed.clear();
    await this.transport.subscribe(this.subscriptions());
    for (const i of this.instances()) this.subscribed.add(i.baseTopic);
  }

  handles(topic: string): boolean {
    return /^[^/]+\/bridge\/state$/.test(topic) || !!this.instanceOf(topic);
  }

  onMessage(topic: string, payload: string, retained = false): void {
    try {
      this.route(topic, payload, retained);
    } catch (e) {
      this.once.warn(`msg:${topic}`, `cannot read ${topic}: ${errorText(e)}`);
    }
  }

  /** Bridge online state per instance (null until the bridge has said anything). */
  bridgeStates(): Record<Id, boolean | null> {
    const out: Record<Id, boolean | null> = {};
    for (const i of this.instances()) out[i.id] = this.bridges.get(i.id)?.online ?? null;
    return out;
  }

  devices(instanceId: Id): Z2mDeviceInfo[] {
    return [...(this.bridges.get(instanceId)?.devices.values() ?? [])];
  }

  device(instanceId: Id, friendlyName: string): (Z2mDeviceInfo & Z2mDeviceLink) | null {
    const info = this.bridges.get(instanceId)?.devices.get(friendlyName) ?? null;
    const link = this.link(instanceId, friendlyName);
    if (!info && !link) return null;
    return {
      ...(info ?? { ieee: null, friendlyName, model: null, vendor: null, powerSource: null, trv: null }),
      ...(link ?? { lqi: null, lqiMedian: null, lqiSamples: 0, lqiAt: null, batteryPct: null, batteryAt: null, lastSeenAt: null, available: null }),
    };
  }

  link(instanceId: Id, friendlyName: string): Z2mDeviceLink | null {
    const l = this.links.get(key(instanceId, friendlyName));
    if (!l) return null;
    const recent = l.samples.filter(([at]) => at >= this.clock.now() - LQI_WINDOW_MS).map(([, v]) => v);
    const last = l.samples[l.samples.length - 1];
    return {
      lqi: last ? last[1] : null,
      lqiMedian: median(recent),
      lqiSamples: recent.length,
      lqiAt: l.lqiAt,
      batteryPct: l.battery,
      batteryAt: l.batteryAt,
      lastSeenAt: l.lastSeenAt,
      available: l.available,
    };
  }

  /**
   * Link data of a device as Home Assistant names it: by IEEE address through the bridge's device list
   * (a device renamed in Zigbee2MQTT keeps it), else by friendly name.
   */
  deviceLink(instanceId: Id, ieee: string | null, friendlyName: string): Z2mDeviceLink | null {
    const want = ieee?.toLowerCase();
    const byIeee = want ? [...(this.bridges.get(instanceId)?.devices.values() ?? [])].find((d) => d.ieee?.toLowerCase() === want) : undefined;
    return (byIeee ? this.link(instanceId, byIeee.friendlyName) : null) ?? this.link(instanceId, friendlyName);
  }

  /* ── routing ────────────────────────────────────────────────────────────────────────────────── */

  private route(topic: string, payload: string, retained: boolean): void {
    const instance = this.instanceOf(topic);
    if (!instance) {
      const m = /^([^/]+)\/bridge\/state$/.exec(topic);
      if (m && parseOnline(payload) !== null) void this.adopt(m[1], parseOnline(payload));
      return;
    }
    const rest = topic.slice(instance.baseTopic.length + 1);
    if (rest === 'bridge/state') return this.bridgeState(instance, parseOnline(payload));
    if (rest === 'bridge/devices') return this.bridgeDevices(instance, payload);
    if (rest.startsWith('bridge/')) return;
    if (/\/(set|get)(\/.*)?$/.test(rest)) return;
    if (rest.endsWith('/availability')) return this.availability(instance, rest.slice(0, -'/availability'.length), parseOnline(payload));
    this.deviceMessage(instance, rest, payload, retained);
  }

  private bridgeState(instance: Z2mInstance, online: boolean | null): void {
    if (online === null) return;
    const bridge = this.bridge(instance.id);
    if (bridge.online === online) return;
    bridge.online = online;
    this.log.log(`${instance.name} (${instance.baseTopic}) is ${online ? 'online' : 'offline'}`);
    this.bus.emit('z2m.bridge', { instanceId: instance.id, online });
  }

  private bridgeDevices(instance: Z2mInstance, payload: string): void {
    const list: unknown = JSON.parse(payload);
    if (!Array.isArray(list)) return;
    const devices = new Map<string, Z2mDeviceInfo>();
    for (const d of list) {
      if (!isObj(d) || d.type === 'Coordinator') continue;
      const friendlyName = str(d.friendly_name);
      if (!friendlyName) continue;
      const def = isObj(d.definition) ? d.definition : {};
      devices.set(friendlyName, {
        ieee: str(d.ieee_address),
        friendlyName,
        model: str(def.model) ?? str(d.model_id),
        vendor: str(def.vendor) ?? str(d.manufacturer),
        powerSource: str(d.power_source),
        trv: trvCapabilities(def.exposes),
      });
    }
    this.bridge(instance.id).devices = devices;
    this.log.debug(`${instance.name}: ${devices.size} device(s)`);
  }

  private availability(instance: Z2mInstance, friendlyName: string, online: boolean | null): void {
    if (online === null || !friendlyName) return;
    const l = this.linkOf(instance.id, friendlyName);
    if (l) l.available = online;
  }

  private deviceMessage(instance: Z2mInstance, friendlyName: string, payload: string, retained: boolean): void {
    if (!payload.trim().startsWith('{')) return;
    const msg: unknown = JSON.parse(payload);
    if (!isObj(msg)) return;
    const now = this.clock.now();
    // `last_seen` (when enabled in Zigbee2MQTT) says when the device really spoke; without it only a live
    // message is news — a retained one replayed on subscribe may be days old
    const stamped = parseLastSeen(msg.last_seen);
    const at = stamped !== null ? Math.min(stamped, now + SKEW_MS) : retained ? null : now;
    if (at === null) return;
    const l = this.linkOf(instance.id, friendlyName);
    if (!l) return;
    const before = l.lastSeenAt;
    if (before === null || at > before) l.lastSeenAt = at;
    l.available ??= true;
    const battery = num(msg.battery);
    if (battery !== null && (l.batteryAt === null || at >= l.batteryAt)) {
      l.battery = battery;
      l.batteryAt = at;
    }
    const lqi = num(msg.linkquality);
    const last = l.samples[l.samples.length - 1];
    if (lqi !== null && (!last || at >= last[0])) {
      if (last && at - last[0] < LQI_SAMPLE_MS) last[1] = lqi;
      else l.samples.push([at, lqi]);
      l.lqiAt = at;
      while (l.samples.length && l.samples[0][0] < now - LQI_WINDOW_MS) l.samples.shift();
    }
    // back after a silence: device health re-checks now instead of on its next pass
    if ((before === null || at - before >= QUIET_MS) && now - at < QUIET_MS) this.bus.emit('z2m.device', { instanceId: instance.id, friendlyName, at });
  }

  /** A bridge on a base topic Klimo does not know yet: remember it as a Zigbee2MQTT instance. */
  private async adopt(baseTopic: string, online: boolean | null): Promise<void> {
    if (this.creating.has(baseTopic) || this.instances().some((i) => i.baseTopic === baseTopic)) return;
    // an instance removed by hand stays removed, however often its bridge announces itself
    if (this.ignoredTopics().includes(baseTopic)) return;
    this.creating.add(baseTopic);
    try {
      const taken = new Set(this.instances().map((i) => i.id));
      let n = 1;
      while (taken.has(`z2m${n}`)) n++;
      const bridgeEntity = `binary_sensor.${baseTopic.toLowerCase().replace(/[^a-z0-9_]/g, '_')}_bridge_connection_state`;
      const instance = await this.config.create(
        'z2m',
        {
          id: `z2m${n}`,
          name: `Z2M #${n}`,
          baseTopic,
          frontendUrl: null,
          bridgeEntityId: this.ha.getState(bridgeEntity) ? bridgeEntity : null,
          resendOnRestart: true,
        },
        SYSTEM,
      );
      this.log.log(`Found Zigbee2MQTT on «${baseTopic}» → ${instance.name}`);
      await this.transport.subscribe([`${baseTopic}/#`]).catch(() => undefined);
      this.subscribed.add(baseTopic);
      if (online !== null) this.bridgeState(instance, online);
    } catch (e) {
      this.once.warn(`adopt:${baseTopic}`, `cannot add the Zigbee2MQTT instance «${baseTopic}»: ${errorText(e)}`);
    } finally {
      this.creating.delete(baseTopic);
    }
  }

  /** Instances configured while connected (UI, import) get their topics on the next message or pass. */
  async syncSubscriptions(): Promise<void> {
    if (!this.transport.connected) return;
    const missing = this.instances().filter((i) => !this.subscribed.has(i.baseTopic));
    if (!missing.length) return;
    await this.transport.subscribe(missing.map((i) => `${i.baseTopic}/#`));
    for (const i of missing) this.subscribed.add(i.baseTopic);
  }

  /* ── helpers ────────────────────────────────────────────────────────────────────────────────── */

  private instances(): Z2mInstance[] {
    try {
      return this.config.list('z2m');
    } catch {
      return [];
    }
  }

  private ignoredTopics(): string[] {
    try {
      return this.config.singleton('settings').z2mIgnoredTopics ?? [];
    } catch {
      return [];
    }
  }

  /** The configured instance owning a topic (longest base topic wins: bases may nest). */
  private instanceOf(topic: string): Z2mInstance | null {
    let best: Z2mInstance | null = null;
    for (const i of this.instances()) {
      if (topic.startsWith(`${i.baseTopic}/`) && (!best || i.baseTopic.length > best.baseTopic.length)) best = i;
    }
    return best;
  }

  private bridge(instanceId: Id): Bridge {
    let b = this.bridges.get(instanceId);
    if (!b) {
      b = { online: null, devices: new Map() };
      this.bridges.set(instanceId, b);
    }
    return b;
  }

  private linkOf(instanceId: Id, friendlyName: string): Link | null {
    const k = key(instanceId, friendlyName);
    let l = this.links.get(k);
    if (!l) {
      if (this.links.size >= MAX_DEVICES) return null;
      l = { samples: [], lqiAt: null, battery: null, batteryAt: null, lastSeenAt: null, available: null };
      this.links.set(k, l);
    }
    return l;
  }
}

function key(instanceId: Id, friendlyName: string): string {
  return `${instanceId}|${friendlyName}`;
}
