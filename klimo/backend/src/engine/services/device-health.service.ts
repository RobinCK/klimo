import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { notFound, validationError } from '../../common/http';
import { errorText } from '../../common/logger';
import { DEFAULT_TRV_CAPABILITIES, DEFAULT_TRV_SIBLINGS, deepClone } from '../../shared/defaults';
import type {
  Actor,
  ClockPort,
  ConfigCollectionName,
  DeviceDetailDto,
  DeviceHealth,
  DeviceHealthSettings,
  DeviceKind,
  DeviceMeta,
  DeviceProblem,
  DeviceProblemType,
  DeviceReplaceRequest,
  DevicesDto,
  DevicesSummary,
  DeviceTransport,
  Detection,
  EngineConfig,
  EntityId,
  EpochMs,
  EventKind,
  HaPort,
  HaRegistries,
  HaStateObj,
  IBus,
  IConfigStore,
  Id,
  IDeviceHealth,
  IEntitySearch,
  IEvents,
  IHaInputs,
  IHistory,
  IJournal,
  IncidentDto,
  JournalEntry,
  Reason,
  SensorRole,
  SourceConfig,
  Tone,
  TrvSiblings,
} from '../../shared/model';
import { outdoorSensorIds } from '../../shared/model';
import { BUS, CLOCK, CONFIG_STORE, ENTITY_SEARCH, EVENTS, HA_INPUTS, HA_PORT, HISTORY, JOURNAL } from '../../tokens';
import { addDays, fromLocal, toLocal } from '../core/time';
import { median } from '../core/util';
import { domainOf } from './mappers';
import { EngineAccess } from './support';

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;
const INDEX_TTL_MS = 60_000;
const LQI_SAMPLE_EVERY_MS = 5 * MIN_MS;
const BATTERY_STALE_MS = 48 * HOUR_MS;
const MISSING_AFTER_MS = 5 * MIN_MS;
const Z2M_OFFLINE_AFTER_MS = MIN_MS;
/** A cleared problem keeps reporting «inactive» for a while so the incident's flap guard can run out. */
const CLEAR_REPEAT_MS = 10 * MIN_MS;
/** Problems that end when the device is on the air again. */
const OFFLINE_KINDS = new Set<EventKind>(['sensor_offline', 'entity_unavailable', 'entity_missing', 'z2m_offline']);
/** States that are not a report from the device. */
const DEAD_STATES = new Set(['unavailable', 'unknown']);
/** Entities whose time stamps come from the integration, not from the device speaking (firmware checks, presses). */
const QUIET_DOMAINS = new Set(['update', 'button', 'scene']);
const REGRESSION_DAYS = 21;
const REGRESSION_MIN_R2 = 0.6;

const KIND_ORDER: readonly DeviceKind[] = ['trv', 'sensor', 'window', 'relay', 'pump', 'source', 'entity'];
const KIND_RANK: Record<DeviceKind, number> = { trv: 0, source: 1, relay: 2, pump: 3, window: 4, sensor: 5, entity: 6 };
/** «зв’язок → підтвердження → батарея → сигнал», then the rest. */
const PROBLEM_ORDER: readonly DeviceProblemType[] = [
  'offline', 'z2m_offline', 'entity_missing', 'trv_failed', 'trv_unconfirmed', 'relay_mismatch', 'actuator_conflict', 'battery_low', 'weak_signal', 'manual_knob',
];
const INCIDENT_KINDS: Record<DeviceProblemType, EventKind[]> = {
  offline: ['sensor_offline', 'entity_unavailable'],
  z2m_offline: ['z2m_offline'],
  entity_missing: ['entity_missing'],
  trv_failed: ['trv_not_confirmed'],
  trv_unconfirmed: ['trv_not_confirmed'],
  relay_mismatch: ['relay_mismatch'],
  actuator_conflict: ['actuator_conflict'],
  battery_low: ['battery_low'],
  weak_signal: ['signal_weak'],
  manual_knob: [],
};
/** Bare entities only become «devices» when they are hardware-like (not persons, zones, calendars…). */
const DEVICE_DOMAINS = new Set(['sensor', 'binary_sensor', 'switch', 'input_boolean', 'number', 'input_number', 'select', 'climate', 'valve', 'fan', 'light', 'humidifier', 'water_heater', 'cover', 'lock']);
/** Battery types of common Zigbee models (the battery hint names the cell to buy). */
const BATTERY_TYPES: readonly [RegExp, string][] = [
  [/SNZB-02D/i, 'CR2450'],
  [/SNZB-02/i, 'CR2450'],
  [/SNZB-04/i, 'CR2032'],
  [/SNZB-03/i, 'CR2450'],
  [/WSDCGQ1[12]LM/i, 'CR2032'],
  [/MCCGQ1[14]LM/i, 'CR1632'],
  [/TRVZB/i, 'AA×2'],
  [/TS0601/i, 'AA×2'],
  [/SPZB0001/i, 'AA×2'],
];

type Role = 'sensor' | 'trv' | 'zone' | 'source' | 'source_aux' | 'pump' | 'circuit' | 'outdoor' | 'energy' | 'trigger' | 'dehumidifier';

interface Binding {
  entityId: EntityId;
  role: Role;
  kind: DeviceKind;
  roomId: Id | null;
  label: string;
  /** Its availability is the device's availability; aux entities only join a device found otherwise. */
  primary: boolean;
  sensorId?: Id;
  sensorRole?: SensorRole;
  included?: boolean;
  trvId?: Id;
  sourceId?: Id;
  pumpId?: Id;
  userLabel?: string | null;
}

interface Device {
  key: string;
  kind: DeviceKind;
  bindings: Binding[];
  primary: Binding;
  name: string;
  model: string | null;
  manufacturer: string | null;
  transport: DeviceTransport;
  battery: EntityId | null;
  linkquality: EntityId | null;
  entityIds: EntityId[];
  /** Every enabled entity of the HA device: a report from any of them means the device is on the air. */
  siblings: EntityId[];
}

/** What device health reads from the Zigbee2MQTT listener (only there when MQTT is). */
interface Z2mLink {
  lqi: number | null;
  lqiAt: EpochMs | null;
  batteryPct: number | null;
  batteryAt: EpochMs | null;
  lastSeenAt: EpochMs | null;
}
interface Z2mLinks {
  deviceLink(instanceId: Id, ieee: string | null, friendlyName: string): Z2mLink | null;
}

interface Live {
  available: boolean;
  offlineSince: EpochMs | null;
  lastSeenAt: EpochMs | null;
  batteryPct: number | null;
  batteryStale: boolean;
  lqi: number | null;
}

const ts = (s: string | undefined): number | null => {
  if (!s) return null;
  const v = Date.parse(s);
  return Number.isFinite(v) ? v : null;
};
const reportedAt = (st: HaStateObj): number | null => ts(st.last_reported) ?? ts(st.last_updated);
const numOf = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const isLive = (st: HaStateObj | null | undefined): st is HaStateObj => !!st && !DEAD_STATES.has(st.state);
const latest = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.max(a, b));

/**
 * When the device behind a state last spoke: HA's newest stamp, or Zigbee2MQTT's `last_seen` when it
 * comes as an attribute (legacy attributes) or as the state of its own `…_last_seen` entity.
 */
function seenAt(st: HaStateObj): number | null {
  let t = latest(latest(ts(st.last_reported), ts(st.last_updated)), ts(st.last_changed));
  const attr = st.attributes.last_seen;
  if (typeof attr === 'string') t = latest(t, ts(attr));
  else if (typeof attr === 'number' && Number.isFinite(attr)) t = latest(t, attr < 1e11 ? attr * 1000 : attr);
  if (st.attributes.device_class === 'timestamp' && /_last_seen$/.test(st.entity_id)) t = latest(t, ts(st.state));
  return t;
}

/** Least squares of percent over days; the slope and how well a line explains the points. */
export function batteryTrend(points: readonly [EpochMs, number][]): { slopePerDay: number; r2: number } | null {
  if (points.length < 3) return null;
  const t0 = points[0][0];
  const xs = points.map(([t]) => (t - t0) / DAY_MS);
  const ys = points.map(([, v]) => v);
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const r2 = syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  return { slopePerDay: slope, r2 };
}

/**
 * «Пристрої»: every HA device (or bare entity) Klimo is bound to, with its availability, battery,
 * Zigbee signal and the problems worth acting on, plus the detections that turn those problems into
 * incidents (offline per device class, low battery, weak signal, a missing entity, a Zigbee2MQTT
 * bridge offline). TRV acknowledgement problems are detected by the command reconciler.
 */
@Injectable()
export class DeviceHealthService implements IDeviceHealth, OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('DeviceHealth');
  private index: { at: EpochMs; revision: number; devices: Device[]; byEntity: Map<EntityId, Device> } | null = null;
  /** Per device: availability and problems as last announced to the Devices page. */
  private announced: Map<string, string> | null = null;
  private readonly lqiRing = new Map<string, [EpochMs, number][]>();
  private readonly lqiSampledAt = new Map<string, EpochMs>();
  private readonly batteryDays = new Map<string, number | null>();
  private readonly missingSince = new Map<EntityId, EpochMs>();
  private readonly z2mOfflineSince = new Map<Id, EpochMs>();
  private readonly batteryLow = new Set<string>();
  private readonly weak = new Set<string>();
  private active = new Map<string, Detection>();
  private readonly clearing = new Map<string, { det: Detection; since: EpochMs }>();
  private regressionTimer: { cancel(): void } | null = null;

  constructor(
    @Inject(CONFIG_STORE) private readonly config: IConfigStore,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(HA_PORT) private readonly ha: HaPort,
    @Inject(ENTITY_SEARCH) private readonly search: IEntitySearch,
    @Inject(HISTORY) private readonly history: IHistory,
    @Inject(HA_INPUTS) private readonly inputs: IHaInputs,
    @Inject(JOURNAL) private readonly journal: IJournal,
    @Inject(EngineAccess) private readonly access: EngineAccess,
    @Optional() @Inject(EVENTS) private readonly events?: IEvents,
    @Optional() @Inject(BUS) bus?: IBus,
  ) {
    ha.onStateChanged((id, next, prev) => this.onState(id, next, prev));
    // Zigbee2MQTT hears a device that HA may never report again (same value: no state change reaches us)
    bus?.on('z2m.device', () => {
      if (this.anyOffline()) this.recheck('z2m.device');
    });
  }

  onModuleInit(): void {
    // the first estimate waits for HA to connect and the recorder to answer
    this.scheduleRegression(2 * MIN_MS);
  }

  onModuleDestroy(): void {
    this.regressionTimer?.cancel();
    this.regressionTimer = null;
  }

  /* ── list and detail ─────────────────────────────────────────────────────────────────────── */

  list(filter?: string, q?: string): DevicesDto {
    const now = this.clock.now();
    const cfg = this.config.engineConfig();
    const meta = this.metaMap();
    const incidents = this.deviceIncidents();
    const settings = this.config.singleton('deviceHealth');
    const all = this.devices().map((d) => this.toDto(d, meta.get(d.key), incidents, settings, now));
    all.sort((a, b) => this.compare(cfg, a, b));
    const summary = this.summary(all);
    let devices = all;
    const f = filter?.trim() || 'all';
    if (f === 'problems' || f === 'problem' || f === 'attention') devices = devices.filter((d) => d.problems.length && !d.ignored);
    else if (f === 'battery') devices = devices.filter((d) => d.power.source === 'battery');
    else if (f === 'offline') devices = devices.filter((d) => !d.available);
    else if ((KIND_ORDER as readonly string[]).includes(f)) devices = devices.filter((d) => d.kind === f);
    else if (f !== 'all') throw validationError([{ path: 'filter', code: 'enum', params: { values: ['all', 'problems', 'battery', 'offline', ...KIND_ORDER].join('|') } }]);
    const needle = q?.trim().toLowerCase();
    if (needle) {
      const roomName = (id: Id | null) => (id ? cfg.rooms.find((r) => r.id === id)?.name ?? '' : '');
      devices = devices.filter((d) =>
        [d.name, d.label ?? '', d.model ?? '', d.manufacturer ?? '', roomName(d.roomId), ...d.entityIds].some((s) => s.toLowerCase().includes(needle)),
      );
    }
    return { summary, devices };
  }

  async detail(key: string): Promise<DeviceDetailDto | null> {
    const dev = this.devices().find((d) => d.key === key);
    if (!dev) return null;
    const now = this.clock.now();
    const device = this.toDto(dev, this.metaMap().get(dev.key), this.deviceIncidents(), this.config.singleton('deviceHealth'), now);
    const from = now - 7 * DAY_MS;
    const ids = [...new Set([dev.primary.entityId, dev.battery, dev.linkquality].filter((x): x is EntityId => !!x))];
    let series: Awaited<ReturnType<IHistory['series']>> = [];
    try {
      series = await this.history.series({ ids, from, to: now });
    } catch (e) {
      this.log.warn(`history of ${key} unavailable: ${errorText(e)}`);
    }
    const pointsOf = (id: EntityId | null) => (id ? series.find((s) => s.entityId === id)?.points ?? [] : []);
    let battery7d = pointsOf(dev.battery);
    if (!dev.battery && device.batteryPct !== null) {
      try {
        const attr = (await this.history.series({ ids: [dev.primary.entityId], from, to: now, attribute: 'battery' }))[0];
        battery7d = attr?.points ?? [];
      } catch {
        battery7d = [];
      }
    }
    const lqi7d: [EpochMs, number | null][] = dev.linkquality ? pointsOf(dev.linkquality) : (this.lqiRing.get(dev.key) ?? []).map(([t, v]) => [t, v]);
    return {
      device,
      battery7d,
      lqi7d,
      availability7d: this.outages(series.find((s) => s.entityId === dev.primary.entityId), from, now),
      trvLog: await this.deviceLog(dev),
    };
  }

  resend(key: string, _actor: Actor): number {
    const dev = this.devices().find((d) => d.key === key);
    if (!dev) throw notFound('Device');
    const engine = this.access.requireEngine();
    const sent = engine.resend({ deviceKey: key });
    if (sent) return sent;
    // the command ledger is keyed by entity: fall back to every entity the device is driven through
    let n = 0;
    for (const b of dev.bindings) if (b.primary) n += engine.resend({ entityId: b.entityId });
    return n;
  }

  /**
   * «Замінити сутність»: a re-paired device usually comes back under a new entity id. Every reference
   * of the old id in the configuration moves to the new one in one write; TRV capabilities are probed
   * again for the new head.
   */
  async replace(key: string, req: DeviceReplaceRequest, actor: Actor): Promise<DeviceHealth> {
    const dev = this.devices().find((d) => d.key === key);
    if (!dev) throw notFound('Device');
    const from = req?.oldEntityId;
    const to = req?.newEntityId;
    if (typeof from !== 'string' || !dev.entityIds.includes(from)) throw validationError([{ path: 'oldEntityId', code: 'not_found' }]);
    if (typeof to !== 'string' || !/^[a-z_]+\.[a-z0-9_]+$/.test(to)) throw validationError([{ path: 'newEntityId', code: 'pattern' }]);
    if (to === from) throw validationError([{ path: 'newEntityId', code: 'same' }]);
    if (domainOf(to) !== domainOf(from)) throw validationError([{ path: 'newEntityId', code: 'domain', params: { expected: domainOf(from) } }]);
    if (this.ha.connected && !this.exists(to)) throw validationError([{ path: 'newEntityId', code: 'not_found' }]);

    const collections: ConfigCollectionName[] = ['rooms', 'sensors', 'emitterDevices', 'sources', 'manifolds', 'circuits', 'pumps', 'triggers', 'rules', 'activationRules', 'watchRules', 'z2m'];
    const needle = JSON.stringify(from);
    await this.config.transaction(async (tx) => {
      for (const c of collections) {
        for (const item of tx.list(c) as unknown as Record<string, unknown>[]) {
          if (c === 'watchRules' && item.origin === 'auto') continue;
          if (!JSON.stringify(item).includes(needle)) continue;
          const next = replaceDeep(item, from, to) as Record<string, unknown>;
          if (c === 'emitterDevices' && item.entityId === from) Object.assign(next, this.reprobe(to, item.kind as string));
          if (c === 'sensors' && item.entityId === from) Object.assign(next, this.deviceFields(to));
          const { id, ...patch } = next;
          await tx.update(c, id as Id, patch as never, actor);
        }
      }
      for (const k of ['settings', 'energy'] as const) {
        const value = tx.singleton(k);
        if (JSON.stringify(value).includes(needle)) await tx.patchSingleton(k, replaceDeep(value, from, to) as never, actor);
      }
    });
    this.index = null;
    await this.access.runNow('device.replaced');
    const newKey = this.search.deviceOf(to)?.key ?? `entity:${to}`;
    const found = this.list().devices.find((d) => d.key === newKey || d.entityIds.includes(to));
    if (!found) throw notFound('Device');
    return found;
  }

  lastSeen(entityId: EntityId): EpochMs | null {
    const dev = this.deviceOf(entityId);
    return dev ? this.lastSeenOf(dev, true) : null;
  }

  /* ── live changes ────────────────────────────────────────────────────────────────────────── */

  /**
   * A device going between unavailable and a real state, or a device reported offline that speaks
   * again, is judged now (the engine evaluates within a second, its incidents resolve and open pages
   * hear of it) instead of on the next periodic pass.
   */
  private onState(entityId: EntityId, next: HaStateObj | null, prev: HaStateObj | null): void {
    try {
      const flipped = isLive(next) !== isLive(prev);
      if (!flipped && !this.anyOffline()) return;
      const dev = this.deviceOf(entityId);
      if (!dev) return;
      if (flipped || this.isOffline(dev.key)) this.recheck('device.state');
    } catch (e) {
      this.log.warn(`state change of ${entityId} not checked: ${errorText(e)}`);
    }
  }

  private recheck(reason: string): void {
    this.access.engine()?.requestRun(reason);
  }

  private anyOffline(): boolean {
    for (const d of this.active.values()) if (OFFLINE_KINDS.has(d.kind)) return true;
    return false;
  }

  private isOffline(key: string): boolean {
    for (const d of this.active.values()) if (d.deviceKey === key && OFFLINE_KINDS.has(d.kind)) return true;
    return false;
  }

  /* ── detections ──────────────────────────────────────────────────────────────────────────── */

  detect(now: EpochMs): Detection[] {
    // with HA away every state is stale: nothing new is concluded and nothing resolves
    if (!this.ha.connected) return [];
    const settings = this.config.singleton('deviceHealth');
    const cfg = this.config.engineConfig();
    const meta = this.metaMap();
    const params = this.eventParams();
    const next = new Map<string, Detection>();
    const add = (d: Detection) => next.set(d.dedupKey, d);
    const roomOf = (id: Id | null) => (id ? cfg.rooms.find((r) => r.id === id) : undefined);

    // first every offline entity, so a room's «N of M sensors left» is known before its detections
    const offline = new Map<EntityId, { dev: Device; b: Binding; minutes: number }>();
    const devices = this.devices().filter((dev) => !meta.get(dev.key)?.ignored);
    if (settings.offline.enabled) {
      for (const dev of devices) {
        for (const b of dev.bindings) {
          if (!b.primary || b.role === 'source') continue;
          const minutes = this.offlineMinutes(dev, b, now, settings);
          if (minutes !== null) offline.set(b.entityId, { dev, b, minutes });
        }
      }
    }
    // one problem per device and room: a temperature + humidity sensor that went quiet is one card and one
    // message (its temperature entity speaks for it)
    const isTemp = (id: EntityId) => Object.values(cfg.sensorsByRoom).some((list) => list.some((s) => s.entityId === id && s.role === 'temperature'));
    const reported = new Set<string>();
    for (const { dev, b, minutes } of [...offline.values()].sort((x, y) => Number(isTemp(y.b.entityId)) - Number(isTemp(x.b.entityId)))) {
      const room = roomOf(b.roomId);
      if (b.role === 'sensor' && room) {
        if (!room.notify.sensorStale) continue;
        if (reported.has(`${dev.key}:${room.id}`)) continue;
        reported.add(`${dev.key}:${room.id}`);
        const temps = (cfg.sensorsByRoom[room.id] ?? []).filter((s) => s.role === 'temperature' && s.included);
        const left = temps.filter((s) => !offline.has(s.entityId) && this.ha.getState(s.entityId)?.state !== 'unavailable' && !!this.ha.getState(s.entityId)).length;
        add({ kind: 'sensor_offline', dedupKey: `sensor_offline:${b.entityId}`, active: true, roomId: room.id, entityId: b.entityId, deviceKey: dev.key, facts: { entityId: b.entityId, name: b.label, minutes, left, total: temps.length } });
      } else {
        const facts = { entityId: b.entityId, name: b.label, minutes, ...(b.role === 'outdoor' ? { outdoor: true } : {}) };
        add({ kind: 'entity_unavailable', dedupKey: `entity_unavailable:${b.entityId}`, active: true, roomId: b.roomId, entityId: b.entityId, deviceKey: dev.key, sourceId: b.sourceId ?? null, facts });
      }
    }

    for (const dev of this.devices()) this.sampleLqi(dev, now, settings.weakSignal.windowH);
    const lives = new Map(this.devices().map((dev) => [dev.key, this.live(dev, now)] as const));
    for (const dev of devices) {
      const live = lives.get(dev.key) ?? this.live(dev, now);
      let problem = dev.bindings.some((b) => offline.has(b.entityId));

      for (const b of dev.bindings) {
        if (!b.primary || b.entityId.startsWith('z2m:')) continue;
        if (this.ha.getState(b.entityId) || this.inRegistry(b.entityId)) {
          this.missingSince.delete(b.entityId);
          continue;
        }
        const since = this.missingSince.get(b.entityId) ?? now;
        this.missingSince.set(b.entityId, since);
        if (now - since < MISSING_AFTER_MS) continue;
        problem = true;
        add({ kind: 'entity_missing', dedupKey: `entity_missing:${b.entityId}`, active: true, roomId: b.roomId, entityId: b.entityId, deviceKey: dev.key, sourceId: b.sourceId ?? null, facts: { entityId: b.entityId, name: b.label } });
      }

      const pct = live.batteryPct;
      if (settings.batteryLow.enabled && pct !== null) {
        const resolvePct = numOf(params.get('battery_low')?.resolvePct) ?? settings.batteryLow.pct + 5;
        const on = this.batteryLow.has(dev.key) ? pct < resolvePct : pct < settings.batteryLow.pct;
        if (on) this.batteryLow.add(dev.key);
        else this.batteryLow.delete(dev.key);
        const room = roomOf(dev.primary.roomId);
        if (on && (!room || room.notify.batteryLow)) {
          problem = true;
          add({
            kind: 'battery_low',
            dedupKey: `battery:${dev.key}`,
            active: true,
            roomId: room?.id ?? null,
            entityId: dev.battery ?? dev.primary.entityId,
            deviceKey: dev.key,
            facts: { pct, name: dev.name, deviceKey: dev.key, batteryType: this.batteryType(dev, meta.get(dev.key)), estDays: this.batteryDays.get(dev.key) ?? null },
          });
        }
      }

      const samples = this.lqiRing.get(dev.key) ?? [];
      if (settings.weakSignal.enabled && live.available && samples.length >= settings.weakSignal.minSamples) {
        const m = median(samples.map(([, v]) => v));
        const on = m !== null && (this.weak.has(dev.key) ? m < settings.weakSignal.clearAt : m < settings.weakSignal.lqiBelow);
        if (on) this.weak.add(dev.key);
        else this.weak.delete(dev.key);
        // a weak link is reported alone only; with another problem it is that problem's cause
        if (on && !problem && m !== null) add({ kind: 'signal_weak', dedupKey: `signal:${dev.key}`, active: true, roomId: dev.primary.roomId, entityId: dev.primary.entityId, deviceKey: dev.key, facts: { lqi: Math.round(m), name: dev.name } });
      }
    }

    const instances = this.config.list('z2m');
    const bridges = this.inputs.z2mBridges();
    for (const inst of instances) {
      if (bridges[inst.id] === false) {
        const since = this.z2mOfflineSince.get(inst.id) ?? now;
        this.z2mOfflineSince.set(inst.id, since);
        if (now - since >= Z2M_OFFLINE_AFTER_MS) {
          add({ kind: 'z2m_offline', dedupKey: `z2m_offline:${inst.id}`, active: true, entityId: inst.bridgeEntityId, facts: { instanceId: inst.id, name: inst.name, since } });
        }
      } else {
        this.z2mOfflineSince.delete(inst.id);
      }
    }
    this.announce(lives, offline, next, bridges);
    return this.withResolves(next, now, lives);
  }

  /**
   * Problems that ended report «inactive». A device verifiably back on the air (or a battery and a link
   * that read fine again) closes its incident at once; anything else waits for the flap guard.
   */
  private withResolves(next: Map<string, Detection>, now: EpochMs, lives: Map<string, Live>): Detection[] {
    for (const [key, det] of this.active) if (!next.has(key)) this.clearing.set(key, { det: { ...det, active: false }, since: now });
    for (const key of next.keys()) this.clearing.delete(key);
    for (const [key, c] of this.clearing) if (now - c.since > CLEAR_REPEAT_MS) this.clearing.delete(key);
    this.active = next;
    return [...next.values(), ...[...this.clearing.values()].map((c) => ({ ...c.det, recovered: this.isBack(c.det, lives) }))];
  }

  private isBack(det: Detection, lives: Map<string, Live>): boolean {
    const live = det.deviceKey ? lives.get(det.deviceKey) : undefined;
    switch (det.kind) {
      case 'sensor_offline':
      case 'entity_unavailable':
        return !!det.entityId && isLive(this.ha.getState(det.entityId));
      case 'entity_missing':
        return !!det.entityId && this.exists(det.entityId);
      case 'z2m_offline':
        return typeof det.facts.instanceId === 'string' && this.inputs.z2mBridges()[det.facts.instanceId] === true;
      case 'battery_low':
        return live?.batteryPct != null;
      case 'signal_weak':
        return !!live?.available && live.lqi !== null;
      default:
        return false;
    }
  }

  /**
   * Tells open Devices pages which devices changed availability or problems, so a sensor that is back
   * shows as back within seconds. The first pass after a start only takes the baseline.
   */
  private announce(lives: Map<string, Live>, offline: Map<EntityId, { dev: Device }>, next: Map<string, Detection>, bridges: Record<Id, boolean | null>): void {
    const kinds = new Map<string, string[]>();
    for (const d of next.values()) if (d.deviceKey) kinds.set(d.deviceKey, [...(kinds.get(d.deviceKey) ?? []), d.kind]);
    const silent = new Set([...offline.values()].map((o) => o.dev.key));
    const sigs = new Map<string, string>();
    for (const dev of this.devices()) {
      const bridge = dev.transport.type === 'z2m' ? String(bridges[dev.transport.instanceId] ?? '') : '';
      sigs.set(dev.key, [lives.get(dev.key)?.available ? 1 : 0, silent.has(dev.key) ? 1 : 0, (kinds.get(dev.key) ?? []).sort().join(','), bridge].join('|'));
    }
    const before = this.announced;
    this.announced = sigs;
    if (!before || !this.events) return;
    const changed = [...sigs].filter(([key, sig]) => before.get(key) !== sig).map(([key]) => key);
    for (const key of before.keys()) if (!sigs.has(key)) changed.push(key);
    if (changed.length) this.events.send({ type: 'devices', payload: { keys: changed } });
  }

  /** Minutes a primary entity has been offline beyond its class threshold, or null. */
  private offlineMinutes(dev: Device, b: Binding, now: EpochMs, s: DeviceHealthSettings): number | null {
    const st = this.ha.getState(b.entityId);
    if (!st) return null;
    const battery = !!dev.battery || numOf(st.attributes.battery) !== null;
    const zigbee = dev.transport.type === 'z2m' || dev.transport.type === 'zha';
    let since: number | null = null;
    let limitMin: number;
    if (battery) {
      // battery Zigbee devices report rarely: silence is what counts, not the state
      limitMin = b.sensorRole === 'contact' ? s.offline.contactMin : s.offline.batteryMin;
      // the device's freshest sign of life: a report that repeats a value moves no state Klimo sees
      since = st.state === 'unavailable' ? ts(st.last_changed) : (this.lastSeenOf(dev, true) ?? reportedAt(st));
    } else {
      limitMin = zigbee ? s.offline.mainsMin : s.offline.integrationMin;
      since = st.state === 'unavailable' ? ts(st.last_changed) : null;
    }
    if (since === null || now - since < limitMin * MIN_MS) return null;
    return Math.floor((now - since) / MIN_MS);
  }

  /* ── device index ────────────────────────────────────────────────────────────────────────── */

  private devices(): Device[] {
    const now = this.clock.now();
    const rev = this.config.revision();
    if (this.index && this.index.revision === rev && now - this.index.at < INDEX_TTL_MS) return this.index.devices;
    const devices = this.build(this.config.engineConfig());
    const byEntity = new Map<EntityId, Device>();
    for (const dev of devices) for (const id of [...dev.entityIds, ...dev.siblings]) if (!byEntity.has(id)) byEntity.set(id, dev);
    this.index = { at: now, revision: rev, devices, byEntity };
    return devices;
  }

  private deviceOf(entityId: EntityId): Device | undefined {
    this.devices();
    return this.index?.byEntity.get(entityId);
  }

  private bindings(cfg: EngineConfig): Binding[] {
    const out: Binding[] = [];
    const add = (b: Binding) => {
      if (b.entityId && !b.entityId.startsWith('z2m:')) out.push(b);
    };
    for (const room of cfg.rooms) {
      for (const s of cfg.sensorsByRoom[room.id] ?? []) {
        add({ entityId: s.entityId, role: 'sensor', kind: s.role === 'contact' ? 'window' : 'sensor', roomId: room.id, label: s.name, primary: true, sensorId: s.id, sensorRole: s.role, included: s.included });
      }
      for (const e of cfg.emittersByRoom[room.id] ?? []) {
        for (const d of cfg.devicesByEmitter[e.id] ?? []) {
          add({ entityId: d.entityId, role: d.kind === 'trv' ? 'trv' : 'zone', kind: d.kind === 'trv' ? 'trv' : 'relay', roomId: room.id, label: d.name, primary: true, trvId: d.id, userLabel: d.label });
          for (const sib of [d.siblings?.battery, d.siblings?.linkquality]) if (sib) add({ entityId: sib, role: 'trv', kind: 'trv', roomId: room.id, label: d.name, primary: false, trvId: d.id });
        }
      }
      if (room.humidity.dehumidifier) add({ entityId: room.humidity.dehumidifier.entityId, role: 'dehumidifier', kind: 'relay', roomId: room.id, label: '', primary: true });
    }
    for (const s of cfg.sources) {
      const roomId = s.scope === 'room' ? s.roomId : null;
      for (const b of sourceBindings(s)) add({ ...b, roomId, sourceId: s.id });
    }
    for (const p of cfg.pumps) add({ entityId: p.entityId, role: 'pump', kind: 'pump', roomId: null, label: p.name, primary: true, pumpId: p.id });
    for (const c of cfg.circuits) {
      for (const id of [c.supply.sensorEntityId, c.supply.returnEntityId]) if (id) add({ entityId: id, role: 'circuit', kind: 'sensor', roomId: null, label: c.name, primary: true });
      if (c.mixingValve) add({ entityId: c.mixingValve.entityId, role: 'circuit', kind: 'relay', roomId: null, label: c.name, primary: true });
    }
    for (const m of cfg.manifolds) for (const id of [m.supplySensorEntityId, m.returnSensorEntityId]) if (id) add({ entityId: id, role: 'circuit', kind: 'sensor', roomId: null, label: m.name, primary: true });
    for (const id of outdoorSensorIds(cfg.settings.outdoor)) add({ entityId: id, role: 'outdoor', kind: 'sensor', roomId: null, label: '', primary: true });
    for (const id of Object.values(cfg.energy.entities)) if (id) add({ entityId: id, role: 'energy', kind: 'entity', roomId: null, label: '', primary: true });
    for (const t of cfg.triggers) {
      if (!t.enabled) continue;
      // named from Home Assistant: two inputs of one trigger must not both read «Blackout» (its usage says which trigger)
      for (const id of conditionIds(t.condition)) add({ entityId: id, role: 'trigger', kind: 'entity', roomId: null, label: '', primary: true });
    }
    return out;
  }

  private build(cfg: EngineConfig): Device[] {
    const regs = this.registries();
    const byKey = new Map<string, Binding[]>();
    const keyOf = new Map<EntityId, string>();
    const resolve = (id: EntityId) => {
      let k = keyOf.get(id);
      if (!k) {
        k = this.search.deviceOf(id)?.key ?? `entity:${id}`;
        keyOf.set(id, k);
      }
      return k;
    };
    const bindings = this.bindings(cfg);
    for (const b of bindings) {
      if (!b.primary) continue;
      if (b.kind === 'entity' && !DEVICE_DOMAINS.has(domainOf(b.entityId))) continue;
      const k = resolve(b.entityId);
      const list = byKey.get(k) ?? [];
      if (!list.some((x) => x.entityId === b.entityId && x.role === b.role)) list.push(b);
      byKey.set(k, list);
    }
    for (const b of bindings) {
      if (b.primary) continue;
      const list = byKey.get(resolve(b.entityId));
      if (list && !list.some((x) => x.entityId === b.entityId)) list.push(b);
    }

    const out: Device[] = [];
    for (const [key, list] of byKey) {
      const primaries = list.filter((b) => b.primary).sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind]);
      const primary = primaries[0];
      if (!primary) continue;
      const info = this.search.deviceOf(primary.entityId);
      const siblings = regs && !key.startsWith('entity:') ? regs.entities.filter((e) => e.device_id === key && !e.disabled_by).map((e) => e.entity_id) : [];
      const battery = list.find((b) => !b.primary && /battery/.test(b.entityId))?.entityId ?? siblings.find((id) => this.ha.getState(id)?.attributes.device_class === 'battery' && domainOf(id) === 'sensor') ?? null;
      const linkquality = list.find((b) => !b.primary && /linkquality|lqi/.test(b.entityId))?.entityId ?? siblings.find((id) => /_(linkquality|lqi)$/.test(id)) ?? null;
      const named = primaries.find((b) => b.label) ?? null;
      out.push({
        key,
        kind: primary.kind,
        bindings: list,
        primary,
        name: named?.label || info?.name || this.friendly(primary.entityId),
        model: info?.model ?? null,
        manufacturer: info?.manufacturer ?? null,
        transport: info?.transport ?? { type: 'ha', integration: null, network: null },
        battery,
        linkquality,
        entityIds: [...new Set([...list.map((b) => b.entityId), ...(battery ? [battery] : []), ...(linkquality ? [linkquality] : [])])],
        siblings: siblings.filter((id) => !QUIET_DOMAINS.has(domainOf(id))),
      });
    }
    return out;
  }

  /* ── live readings ───────────────────────────────────────────────────────────────────────── */

  private live(dev: Device, now: EpochMs): Live {
    let available = true;
    let offlineSince: EpochMs | null = null;
    const lastSeenAt = this.lastSeenOf(dev);
    for (const b of dev.bindings) {
      if (!b.primary) continue;
      const st = this.ha.getState(b.entityId);
      if (!st || st.state === 'unavailable') {
        available = false;
        const since = st ? ts(st.last_changed) : null;
        if (since !== null && (offlineSince === null || since < offlineSince)) offlineSince = since;
      }
    }
    const batteryState = dev.battery ? this.ha.getState(dev.battery) : undefined;
    const primaryState = this.ha.getState(dev.primary.entityId);
    let batteryPct = batteryState ? numOf(batteryState.state) : null;
    let batteryAt = batteryState ? reportedAt(batteryState) : null;
    if (batteryPct === null && primaryState) {
      batteryPct = numOf(primaryState.attributes.battery) ?? numOf(primaryState.attributes.battery_level);
      batteryAt = reportedAt(primaryState);
    }
    if (batteryPct === null) {
      const link = this.z2mLink(dev);
      if (link?.batteryPct != null) {
        batteryPct = link.batteryPct;
        batteryAt = link.batteryAt;
      }
    }
    const samples = this.lqiRing.get(dev.key) ?? [];
    const lqi = available && samples.length ? median(samples.map(([, v]) => v)) : null;
    return {
      available,
      offlineSince,
      lastSeenAt,
      batteryPct: batteryPct === null ? null : Math.round(batteryPct),
      batteryStale: batteryPct !== null && (!available || batteryAt === null || now - batteryAt > BATTERY_STALE_MS),
      lqi: lqi === null ? null : Math.round(lqi),
    };
  }

  /** One LQI sample per device every few minutes, kept for the median window. */
  private sampleLqi(dev: Device, now: EpochMs, windowH: number): void {
    const last = this.lqiSampledAt.get(dev.key);
    if (last !== undefined && now - last < LQI_SAMPLE_EVERY_MS) return;
    const primary = this.ha.getState(dev.primary.entityId);
    if (!primary || primary.state === 'unavailable') return;
    const lqiState = dev.linkquality ? this.ha.getState(dev.linkquality) : undefined;
    const windowMs = windowH * HOUR_MS;
    let v = (lqiState && lqiState.state !== 'unavailable' ? numOf(lqiState.state) : null) ?? numOf(primary.attributes.linkquality);
    if (v === null) {
      // the link quality entity is disabled in HA by default; Zigbee2MQTT's own messages carry it —
      // taken only when it is news since the last sample, so a silent device adds no samples
      const link = this.z2mLink(dev);
      const at = link?.lqiAt ?? null;
      if (link?.lqi != null && at !== null && now - at <= windowMs && (last === undefined || at > last)) v = link.lqi;
    }
    if (v === null) return;
    this.lqiSampledAt.set(dev.key, now);
    const ring = (this.lqiRing.get(dev.key) ?? []).filter(([t]) => now - t <= windowMs);
    ring.push([now, v]);
    this.lqiRing.set(dev.key, ring);
  }

  /**
   * When the device last spoke: the freshest report of any of its entities (bound or not) and
   * Zigbee2MQTT's last seen. Without any live state it falls back to when HA last stamped one, unless
   * `liveOnly`.
   */
  private lastSeenOf(dev: Device, liveOnly = false): EpochMs | null {
    let seen: number | null = null;
    let quiet: number | null = null;
    for (const id of new Set([...dev.entityIds, ...dev.siblings])) {
      const st = this.ha.getState(id);
      if (!st) continue;
      if (isLive(st)) seen = latest(seen, seenAt(st));
      else quiet = latest(quiet, reportedAt(st));
    }
    seen = latest(seen, this.z2mLink(dev)?.lastSeenAt ?? null);
    return seen ?? (liveOnly ? null : quiet);
  }

  /** Link quality, battery and last seen straight from Zigbee2MQTT over MQTT; null without them. */
  private z2mLink(dev: Device): Z2mLink | null {
    const t = dev.transport;
    if (t.type !== 'z2m') return null;
    try {
      const zigbee = (this.access.mqtt() as { zigbee?: () => Z2mLinks } | null)?.zigbee?.();
      return zigbee?.deviceLink(t.instanceId, t.ieee, t.friendlyName) ?? null;
    } catch {
      return null;
    }
  }

  /* ── DTO ─────────────────────────────────────────────────────────────────────────────────── */

  private toDto(dev: Device, meta: DeviceMeta | undefined, incidents: IncidentDto[], settings: DeviceHealthSettings, now: EpochMs): DeviceHealth {
    const live = this.live(dev, now);
    const roomId = dev.bindings.find((b) => b.primary && b.roomId)?.roomId ?? null;
    const { state, tone } = this.stateOf(dev, live);
    const z2mUrl = this.z2mUrl(dev);
    const problems = meta?.ignored ? [] : this.problems(dev, live, meta, incidents, settings, now, z2mUrl !== null);
    return {
      key: dev.key,
      kind: dev.kind,
      name: dev.name,
      label: meta?.label ?? dev.primary.userLabel ?? null,
      roomId,
      location: roomId ? 'room' : dev.bindings.some((b) => b.role === 'outdoor') ? 'outdoor' : dev.bindings.some((b) => ['source', 'pump', 'circuit', 'zone'].includes(b.role)) ? 'plant_room' : 'none',
      primaryEntityId: dev.primary.entityId,
      entityIds: dev.entityIds,
      model: dev.model,
      manufacturer: dev.manufacturer,
      transport: dev.transport,
      power: live.batteryPct !== null || dev.battery ? { source: 'battery', batteryType: this.batteryType(dev, meta) } : { source: 'mains' },
      available: live.available,
      lastSeenAt: live.lastSeenAt,
      batteryPct: live.batteryPct,
      batteryStale: live.batteryStale,
      batteryEstDays: this.batteryDays.get(dev.key) ?? null,
      lqi: live.lqi,
      lqiQuality: live.lqi === null ? null : live.lqi >= 100 ? 'good' : live.lqi >= 50 ? 'medium' : 'weak',
      state,
      stateTone: meta?.ignored ? 'off' : tone,
      problems,
      usage: this.usage(dev),
      ignored: !!meta?.ignored,
      z2mUrl,
    };
  }

  /** «Відкрити в Zigbee2MQTT»: the device page of its instance's frontend, when one is configured. */
  private z2mUrl(dev: Device): string | null {
    const t = dev.transport;
    if (t.type !== 'z2m') return null;
    const base = this.config.list('z2m').find((z) => z.id === t.instanceId)?.frontendUrl;
    const id = t.ieee ?? t.friendlyName;
    return base && id ? `${base.replace(/\/+$/, '')}/#/device/${encodeURIComponent(id)}/info` : null;
  }

  private stateOf(dev: Device, live: Live): { state: Reason; tone: Tone } {
    if (!live.available) return { state: { code: 'dev.offline', params: { since: live.offlineSince ?? live.lastSeenAt } }, tone: 'err' };
    const engine = this.access.engine();
    const b = dev.primary;
    const st = this.ha.getState(b.entityId);
    switch (b.role) {
      case 'trv': {
        const trv = b.roomId ? engine?.room(b.roomId)?.trvs.find((t) => t.deviceId === b.trvId) : undefined;
        if (!trv) return { state: { code: 'dev.trv_idle' }, tone: 'ok' };
        if (trv.activity === 'heating' || trv.activity === 'frost' || trv.activity === 'exercise') {
          return trv.valvePct !== null ? { state: { code: 'dev.valve_pct', params: { pct: trv.valvePct } }, tone: 'heat' } : { state: { code: 'dev.trv_heating', params: { setpointC: trv.commandedSetpointC, valvePct: trv.valvePct } }, tone: 'heat' };
        }
        if (trv.activity === 'closed' || trv.activity === 'off') return { state: { code: 'dev.trv_closed', params: { setpointC: trv.commandedSetpointC } }, tone: 'ok' };
        return { state: { code: 'dev.trv_idle' }, tone: 'ok' };
      }
      case 'source': {
        const s = engine?.plant().sources.find((x) => x.sourceId === b.sourceId);
        if (s) return { state: { code: 'dev.source', params: { state: s.state } }, tone: s.state === 'fault' || s.state === 'unavailable' ? 'err' : s.tone };
        return { state: { code: 'dev.source', params: { state: 'idle' } }, tone: 'ok' };
      }
      case 'pump': {
        const p = engine?.plant().circuits.flatMap((c) => c.pumps).concat(engine.plant().manifoldPumps).find((x) => x.pumpId === b.pumpId);
        const on = p ? p.on : st?.state === 'on';
        return { state: { code: 'dev.pump', params: { state: p?.state ?? (on ? 'running' : 'off') } }, tone: on ? 'heat' : 'ok' };
      }
      case 'zone':
      case 'dehumidifier':
        return relayState(st);
      default:
        break;
    }
    if (b.sensorRole === 'contact') {
      const open = st?.state === 'on' || st?.state === 'open';
      return open ? { state: { code: 'dev.contact_open', params: { since: ts(st?.last_changed) } }, tone: 'warn' } : { state: { code: 'dev.contact_closed' }, tone: 'ok' };
    }
    if (dev.kind === 'relay') return relayState(st);
    const unit = typeof st?.attributes.unit_of_measurement === 'string' ? st.attributes.unit_of_measurement : '';
    const n = numOf(st?.state);
    const humid = b.roomId ? engine?.room(b.roomId)?.humidity.warn === true && b.sensorRole === 'humidity' : false;
    return { state: { code: 'dev.reading', params: { value: n ?? st?.state ?? null, unit } }, tone: humid ? 'warn' : 'ok' };
  }

  private problems(dev: Device, live: Live, meta: DeviceMeta | undefined, incidents: IncidentDto[], settings: DeviceHealthSettings, now: EpochMs, canOpenZ2m: boolean): DeviceProblem[] {
    const out: DeviceProblem[] = [];
    const zigbee = dev.transport.type === 'z2m' || dev.transport.type === 'zha';
    const incidentFor = (type: DeviceProblemType): IncidentDto | null =>
      incidents.find((i) => INCIDENT_KINDS[type].includes(i.kind) && (i.deviceKey === dev.key || (!!i.entityId && dev.entityIds.includes(i.entityId)))) ?? null;
    const push = (type: DeviceProblemType, severity: DeviceProblem['severity'], since: EpochMs | null, facts: DeviceProblem['facts'], hint: Reason, actions: DeviceProblem['actions']) => {
      const inc = incidentFor(type);
      // «Сховати» / «Нагадати пізніше» hides the problem on every screen until it comes back
      if (inc?.hidden) return;
      out.push({ type, severity, since: since ?? inc?.openedAt ?? now, incidentId: inc?.id ?? null, facts, hint, actions });
    };

    const sensor = dev.bindings.find((b) => b.primary && b.role === 'sensor' && b.sensorRole === 'temperature');
    const z2mInstance = dev.transport.type === 'z2m' ? dev.transport.instanceId : null;
    const bridges = this.inputs.z2mBridges();
    if (z2mInstance && bridges[z2mInstance] === false) {
      push('z2m_offline', 'err', this.z2mOfflineSince.get(z2mInstance) ?? now, { instanceId: z2mInstance }, { code: 'hint.check_z2m' }, canOpenZ2m ? ['open_z2m'] : []);
    } else {
      for (const b of dev.bindings) {
        if (!b.primary || b.role === 'source') continue;
        const minutes = this.offlineMinutes(dev, b, now, settings);
        if (minutes === null) continue;
        const aqara = /aqara|lumi|xiaomi/i.test(`${dev.manufacturer ?? ''} ${dev.model ?? ''}`);
        const hint: Reason = aqara ? { code: 'hint.aqara_rejoin' } : zigbee ? { code: 'hint.check_z2m' } : { code: 'hint.check_power' };
        const actions: DeviceProblem['actions'] = [];
        if (sensor) actions.push(sensor.included === false ? 'include_in_room' : 'exclude_from_room');
        if (canOpenZ2m) actions.push('open_z2m');
        actions.push('snooze');
        push('offline', 'err', now - minutes * MIN_MS, { minutes, entityId: b.entityId }, hint, actions);
        break;
      }
    }
    for (const b of dev.bindings) {
      if (!b.primary || !this.missingSince.has(b.entityId)) continue;
      const since = this.missingSince.get(b.entityId) as EpochMs;
      if (now - since >= MISSING_AFTER_MS) push('entity_missing', 'err', since, { entityId: b.entityId }, { code: 'hint.replace_entity' }, ['replace']);
    }

    const engine = this.access.engine();
    for (const b of dev.bindings.filter((x) => x.role === 'trv' && x.primary)) {
      const trv = b.roomId ? engine?.room(b.roomId)?.trvs.find((t) => t.deviceId === b.trvId) : undefined;
      if (!trv) continue;
      const sync = trv.sync;
      const weakLink = live.lqi !== null && live.lqi < settings.weakSignal.lqiBelow;
      const hint: Reason = weakLink ? { code: 'hint.add_router' } : { code: 'hint.check_trv' };
      const facts = { targetC: trv.commandedSetpointC, attempt: sync.attempt, of: sync.maxAttempts, lqi: live.lqi };
      const actions: DeviceProblem['actions'] = canOpenZ2m ? ['resend', 'open_z2m'] : ['resend'];
      if (sync.status === 'failed') push('trv_failed', 'err', sync.sentAt ?? now, facts, hint, actions);
      else if (sync.status === 'retrying') push('trv_unconfirmed', 'warn', sync.sentAt ?? now, facts, hint, actions);
    }
    for (const b of dev.bindings.filter((x) => x.role === 'source' && x.primary)) {
      const s = engine?.plant().sources.find((x) => x.sourceId === b.sourceId);
      if (s?.fault?.code === 'relay_mismatch') push('relay_mismatch', 'err', s.fault.since, { sourceId: s.sourceId }, { code: 'hint.check_power' }, ['resend']);
    }
    const ledger = engine?.ledger() ?? {};
    for (const id of dev.entityIds) {
      const rec = ledger[id];
      if (rec?.status === 'backoff') push('actuator_conflict', 'warn', rec.conflicts[0] ?? now, { entityId: id }, { code: 'hint.disable_automation', params: { entityId: id } }, ['dismiss']);
    }

    const pct = live.batteryPct;
    if (pct !== null && (pct < settings.batteryLow.pct || this.batteryLow.has(dev.key))) {
      const severity = pct <= settings.batteryLow.reminderPct ? 'err' : 'warn';
      push('battery_low', severity, null, { pct, estDays: this.batteryDays.get(dev.key) ?? null }, { code: 'hint.battery_type', params: { type: this.batteryType(dev, meta) } }, ['snooze', 'dismiss']);
    }
    if (!out.length && live.lqi !== null && this.weak.has(dev.key)) {
      push('weak_signal', 'warn', null, { lqi: live.lqi }, { code: 'hint.add_router' }, ['snooze', 'dismiss']);
    }
    return out;
  }

  private summary(devices: DeviceHealth[]): DevicesSummary {
    const byKind = Object.fromEntries(KIND_ORDER.map((k) => [k, 0])) as Record<DeviceKind, number>;
    for (const d of devices) byKind[d.kind]++;
    const attention = devices.filter((d) => !d.ignored && d.problems.length);
    const types = new Set(attention.flatMap((d) => d.problems.map((p) => p.type)));
    let weakest: DevicesSummary['weakest'] = null;
    let lowestBattery: DevicesSummary['lowestBattery'] = null;
    for (const d of devices) {
      if (d.ignored) continue;
      if (d.available && d.lqi !== null && (!weakest || d.lqi < weakest.lqi)) weakest = { lqi: d.lqi, deviceKey: d.key };
      if (d.batteryPct !== null && (!lowestBattery || d.batteryPct < lowestBattery.pct)) lowestBattery = { pct: d.batteryPct, deviceKey: d.key };
    }
    return {
      total: devices.length,
      byKind,
      attention: attention.length,
      attentionTypes: PROBLEM_ORDER.filter((t) => types.has(t)),
      weakest,
      lowestBattery,
    };
  }

  /** Problems first (errors before warnings), then by kind, room order and name. */
  private compare(cfg: EngineConfig, a: DeviceHealth, b: DeviceHealth): number {
    const weight = (d: DeviceHealth) => (d.ignored || !d.problems.length ? 2 : d.problems.some((p) => p.severity === 'err') ? 0 : 1);
    const roomOrder = (id: Id | null) => (id ? cfg.rooms.find((r) => r.id === id)?.order ?? 9_999 : 10_000);
    return (
      weight(a) - weight(b) ||
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      roomOrder(a.roomId) - roomOrder(b.roomId) ||
      a.name.localeCompare(b.name, 'uk')
    );
  }

  private usage(dev: Device): DeviceHealth['usage'] {
    const seen = new Set<string>();
    const out: DeviceHealth['usage'] = [];
    for (const id of dev.entityIds) {
      for (const u of this.config.usages({ type: 'entity', id })) {
        const k = `${u.type}|${u.id ?? ''}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(u);
      }
    }
    return out;
  }

  private batteryType(dev: Device, meta: DeviceMeta | undefined): string | null {
    if (meta?.batteryType) return meta.batteryType;
    const model = dev.model ?? '';
    return BATTERY_TYPES.find(([re]) => re.test(model))?.[1] ?? null;
  }

  /** Outage intervals from the primary entity's recorded history. */
  private outages(series: { points: [EpochMs, number | null][]; states?: [EpochMs, string][] } | undefined, from: EpochMs, now: EpochMs): { from: EpochMs; to: EpochMs }[] {
    if (!series) return [];
    const events: [EpochMs, boolean][] = [];
    for (const [t, s] of series.states ?? []) events.push([t, s === 'unavailable']);
    // numeric series keep only numbers; a gap there is a state that was not a number
    if (!series.states?.length) for (const [t, v] of series.points) events.push([t, v === null]);
    events.sort((a, b) => a[0] - b[0]);
    const out: { from: EpochMs; to: EpochMs }[] = [];
    let start: EpochMs | null = null;
    for (const [t, down] of events) {
      if (down && start === null) start = Math.max(t, from);
      else if (!down && start !== null) {
        out.push({ from: start, to: t });
        start = null;
      }
    }
    if (start !== null) out.push({ from: start, to: now });
    return out;
  }

  private async deviceLog(dev: Device): Promise<JournalEntry[]> {
    const keys = [dev.key, ...dev.bindings.map((b) => b.trvId).filter((x): x is Id => !!x)];
    const pages = await Promise.all(
      [...new Set(keys)].map((deviceKey) =>
        this.journal.page({ deviceKey, limit: 50 }).then(
          (p) => p.items,
          () => [] as JournalEntry[],
        ),
      ),
    );
    const seen = new Set<Id>();
    return pages
      .flat()
      .filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)))
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 50);
  }

  /* ── battery regression (daily) ──────────────────────────────────────────────────────────── */

  private scheduleRegression(delayMs: number): void {
    this.regressionTimer?.cancel();
    this.regressionTimer = this.clock.setTimeout(() => {
      void this.completeTrvSiblings();
      void this.refreshBatteryEstimates().finally(() => this.scheduleRegression(this.untilNextRun()));
    }, delayMs);
  }

  /**
   * Sibling entities a head has that were not recognised when it was set up (an Aqara E1's sensor switch
   * is called plainly «sensor»): filled in where empty, never replaced. Without that switch a head fed the
   * room temperature keeps regulating on its own sensor by the hot radiator and closes too early.
   */
  async completeTrvSiblings(): Promise<void> {
    if (!this.ha.connected) return;
    const actor: Actor = { via: 'system', userId: null, userName: null, contextId: null };
    for (const d of this.config.list('emitterDevices')) {
      if (d.kind !== 'trv' || !d.siblings) continue;
      const found = this.search.detail(d.entityId)?.trv?.siblings;
      if (!found) continue;
      const have = d.siblings;
      const missing = (Object.keys(found) as (keyof TrvSiblings)[]).filter((k) => have[k] == null && found[k] != null);
      if (!missing.length) continue;
      const siblings: TrvSiblings = { ...have };
      for (const k of missing) siblings[k] = found[k];
      try {
        await this.config.update('emitterDevices', d.id, { siblings }, actor);
        this.log.log(`${d.name}: found ${missing.join(', ')}`);
      } catch (e) {
        this.log.warn(`${d.name}: cannot add ${missing.join(', ')}: ${errorText(e)}`);
      }
    }
  }

  /** Next 04:00 local — after the night's discharge is recorded and before anyone looks. */
  private untilNextRun(): number {
    const tz = this.clock.tz();
    const now = this.clock.now();
    const local = toLocal(now, tz);
    let at = fromLocal(local.date, 240, tz);
    if (at <= now) at = fromLocal(addDays(local.date, 1), 240, tz);
    return at - now;
  }

  /** Days left per battery device from 21 days of recorder history (only when a line explains it well). */
  async refreshBatteryEstimates(): Promise<void> {
    if (!this.ha.connected) return;
    const now = this.clock.now();
    const devices = this.devices().filter((d) => d.battery);
    for (let i = 0; i < devices.length; i += 20) {
      const chunk = devices.slice(i, i + 20);
      let series: Awaited<ReturnType<IHistory['series']>>;
      try {
        series = await this.history.series({ ids: chunk.map((d) => d.battery as EntityId), from: now - REGRESSION_DAYS * DAY_MS, to: now });
      } catch (e) {
        this.log.warn(`battery history unavailable: ${errorText(e)}`);
        return;
      }
      for (const d of chunk) {
        const points = (series.find((s) => s.entityId === d.battery)?.points ?? []).filter((p): p is [EpochMs, number] => p[1] !== null);
        const trend = batteryTrend(points);
        const last = points[points.length - 1]?.[1] ?? null;
        const days = trend && last !== null && trend.r2 >= REGRESSION_MIN_R2 && trend.slopePerDay < -0.01 ? Math.min(3650, Math.round(last / -trend.slopePerDay)) : null;
        this.batteryDays.set(d.key, days);
      }
    }
  }

  /* ── small helpers ───────────────────────────────────────────────────────────────────────── */

  private metaMap(): Map<string, DeviceMeta> {
    return new Map(this.config.deviceMeta().map((m) => [m.key, m]));
  }

  private eventParams(): Map<EventKind, Record<string, number | string | boolean>> {
    return new Map(this.config.eventParams().map((e) => [e.kind, e.params]));
  }

  private deviceIncidents(): IncidentDto[] {
    try {
      return this.access.incidents()?.list({ scope: 'devices' }) ?? [];
    } catch {
      return [];
    }
  }

  private registries(): HaRegistries | null {
    try {
      return this.ha.registries();
    } catch {
      return null;
    }
  }

  private inRegistry(id: EntityId): boolean {
    return !!this.registries()?.entities.some((e) => e.entity_id === id);
  }

  private exists(id: EntityId): boolean {
    return !!this.ha.getState(id) || this.inRegistry(id);
  }

  private friendly(id: EntityId): string {
    const n = this.ha.getState(id)?.attributes.friendly_name;
    return typeof n === 'string' && n.trim() ? n.trim() : id;
  }

  private deviceFields(entityId: EntityId): { model: string | null; haDeviceId: string | null } {
    const d = this.search.deviceOf(entityId);
    return { model: d?.model ?? null, haDeviceId: d && !d.key.startsWith('entity:') ? d.key : null };
  }

  private reprobe(entityId: EntityId, kind: string): Record<string, unknown> {
    const d = this.search.deviceOf(entityId);
    const base = {
      haDeviceId: d && !d.key.startsWith('entity:') ? d.key : null,
      model: d?.model ?? null,
      manufacturer: d?.manufacturer ?? null,
      transport: d?.transport ?? { type: 'ha', integration: null, network: null },
    };
    if (kind !== 'trv') return base;
    const trv = this.search.detail(entityId)?.trv;
    return { ...base, capabilities: trv?.capabilities ?? deepClone(DEFAULT_TRV_CAPABILITIES), siblings: trv?.siblings ?? deepClone(DEFAULT_TRV_SIBLINGS) };
  }
}

function relayState(st: HaStateObj | undefined): { state: Reason; tone: Tone } {
  const on = st?.state === 'on' || st?.state === 'open';
  return on ? { state: { code: 'dev.relay_on', params: { since: ts(st?.last_changed) } }, tone: 'heat' } : { state: { code: 'dev.relay_off' }, tone: 'ok' };
}

/** The entities a source is driven through (primary) and the ones that only report on it (aux). */
function sourceBindings(s: SourceConfig): Omit<Binding, 'roomId' | 'sourceId'>[] {
  const out: Omit<Binding, 'roomId' | 'sourceId'>[] = [];
  const primary = (entityId: EntityId | null | undefined, kind: DeviceKind) => {
    if (entityId) out.push({ entityId, role: 'source', kind, label: s.name, primary: true });
  };
  const aux = (entityId: EntityId | null | undefined) => {
    if (entityId) out.push({ entityId, role: 'source_aux', kind: 'source', label: s.name, primary: false });
  };
  const a = s.adapter;
  switch (a.type) {
    case 'relay':
      primary(a.command, 'relay');
      for (const st of a.stages) primary(st.entityId, 'relay');
      aux(a.flowSetpoint?.entityId);
      if (a.watchdog.kind === 'countdown_number') aux(a.watchdog.entityId);
      break;
    case 'climate':
      primary(a.climate, 'source');
      aux(a.defrostEntityId);
      aux(a.errorEntityId);
      aux(a.copEntityId);
      aux(a.supplyTempEntityId);
      break;
    case 'flow':
      primary(a.enable, 'source');
      aux(a.flowSetpoint);
      aux(a.actualFlow);
      aux(a.modeSelect?.entityId);
      break;
    default:
      break;
  }
  const c = a.confirm;
  if (c.kind === 'entity_on' || c.kind === 'power_above' || c.kind === 'state_in') aux(c.entityId);
  aux(s.energy.powerEntityId);
  return out;
}

function conditionIds(node: unknown): EntityId[] {
  const out: EntityId[] = [];
  const walk = (n: unknown) => {
    if (!n || typeof n !== 'object') return;
    const o = n as Record<string, unknown>;
    for (const k of ['entityId', 'minus', 'tariffEntityId']) if (typeof o[k] === 'string' && o[k]) out.push(o[k] as string);
    if (Array.isArray(o.items)) o.items.forEach(walk);
    if (o.item) walk(o.item);
  };
  walk(node);
  return [...new Set(out)];
}

/** A deep copy with every string equal to `from` replaced by `to` (entity ids are whole strings). */
export function replaceDeep(value: unknown, from: string, to: string): unknown {
  if (value === from) return to;
  if (Array.isArray(value)) return value.map((v) => replaceDeep(v, from, to));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = replaceDeep(v, from, to);
    return out;
  }
  return value;
}

