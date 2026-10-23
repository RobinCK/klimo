import { Inject, Injectable, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { lazyRef } from '../common/refs';
import { conditionEntities } from '../config/refs';
import { sourceLabels } from '../config/source-labels';
import type {
  CardTextKey,
  ClockPort,
  Detection,
  EngineConfig,
  EpochMs,
  EventKind,
  HaPort,
  IConfigStore,
  IEngine,
  Incident,
  ITexts,
  JournalEntry,
  Lang,
  Reason,
  ReasonParams,
  RoomIssue,
  SourceAdapter,
  Trigger,
} from '../shared/model';
import { outdoorSensorIds } from '../shared/model';
import { CLOCK, CONFIG_STORE, ENGINE, HA_PORT } from '../tokens';
import {
  clock,
  duration,
  renderCard,
  renderIncident,
  renderIssue,
  renderJournal,
  renderReason,
  renderResolved,
  textContext,
} from './messages';
import type { IncidentText, NameResolver, TextContext, Vars } from './messages';

/** Config revision + names cached together; names change only with configuration. */
interface NameCache {
  rev: number;
  rooms: Map<string, string>;
  sources: Map<string, string>;
  profiles: Map<string, string>;
  triggers: Map<string, string>;
  rules: Map<string, string>;
  circuits: Map<string, string>;
  pumps: Map<string, string>;
  instances: Map<string, string>;
  devices: Map<string, string>;
  entities: Map<string, string>;
  /** Every entity Klimo is bound to: what it is called in Klimo, where it is and what it does. */
  bound: Map<string, Bound>;
  /** Labels given on the Devices page, by device key. */
  labels: Map<string, string>;
  triggerList: readonly Trigger[];
  safeC: number | null;
}

interface Bound {
  name: string;
  roomId: string | null;
  /** HA device id, or `entity:<id>` for a bare entity. */
  deviceKey: string;
  role: string;
  /** A room has radiator valves (they hold a safe setpoint while the room has no data). */
  roomHasTrv?: boolean;
}

/** Alerts about one device or entity: their facts carry what people call it. */
const SUBJECT_KINDS: ReadonlySet<EventKind> = new Set<EventKind>([
  'sensor_offline',
  'trv_not_confirmed',
  'battery_low',
  'signal_weak',
  'entity_unavailable',
  'entity_missing',
  'relay_mismatch',
  'actuator_conflict',
  'manual_override',
  'window_open_long',
]);

/** Alerts about one source failing: named by the source, with its entity when another source reads the same. */
const SOURCE_KINDS: ReadonlySet<EventKind> = new Set<EventKind>(['source_failed', 'source_unavailable']);

/** Words that name a kind of device rather than this device («Temperature», «Датчик», «Радіатор»). */
const GENERIC_WORDS = new Set([
  'sensor', 'датчик', 'temperature', 'temp', 'температура', 'температури', 'humidity', 'вологість', 'вологості', 'thermometer',
  'термометр', 'hygrometer', 'гігрометр', 'window', 'вікно', 'вікна', 'door', 'двері', 'contact', 'контакт', 'radiator', 'радіатор',
  'valve', 'головка', 'клапан', 'trv', 'thermostat', 'термостат', 'climate', 'relay', 'реле', 'switch', 'вимикач', 'plug', 'розетка',
  'battery', 'батарея', 'device', 'пристрій', 'zigbee', 'aqara', 'sonoff', 'xiaomi', 'tuya', 'lumi', 'moes', 'ikea', 'room', 'кімната',
  'the', 'a', 'of', 'in', 'and', 'у', 'в', 'і', 'й', 'та', 'на',
]);

const words = (s: string): string[] => s.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** A name that says only what the device is (or repeats its room) does not tell two devices apart. */
export function isGenericName(name: string, roomName: string | null): boolean {
  const room = new Set(roomName ? words(roomName) : []);
  return words(name).every((w) => room.has(w) || GENERIC_WORDS.has(w) || /^\d+$/.test(w));
}

const sameName = (a: string, b: string) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

/**
 * `ITexts`: notification, card and journal texts in the house's notification language. Ids are shown
 * as the names the user gave them in Klimo; an entity without a Klimo name falls back to its friendly
 * name in Home Assistant.
 */
@Injectable()
export class TextsService implements ITexts {
  private cache: NameCache | null = null;
  private readonly engine: () => IEngine | null;

  constructor(
    @Inject(CONFIG_STORE) private readonly config: IConfigStore,
    @Inject(CLOCK) private readonly clockPort: ClockPort,
    @Inject(HA_PORT) private readonly ha: HaPort,
    @Optional() moduleRef?: ModuleRef,
  ) {
    this.engine = lazyRef<IEngine>(moduleRef, ENGINE);
  }

  lang(): Lang {
    return this.config.singleton('settings').notificationLanguage === 'en' ? 'en' : 'uk';
  }

  /** A rendering context for `lang` at the current time (or `now`). */
  context(lang?: Lang, now?: EpochMs): TextContext {
    return textContext(lang ?? this.lang(), now ?? this.clockPort.now(), this.clockPort.tz(), this.names());
  }

  reason(r: Reason, lang?: Lang): string {
    return renderReason(r, this.context(lang));
  }

  journal(e: JournalEntry, lang?: Lang): string {
    return renderJournal(e, this.context(lang));
  }

  issue(i: RoomIssue, lang?: Lang): string {
    return renderIssue(i, this.context(lang));
  }

  incident(i: Incident, lang?: Lang): IncidentText {
    return renderIncident(i, this.context(lang), this.extras(i));
  }

  resolved(i: Incident, lang?: Lang): string {
    return renderResolved(i, this.context(lang), this.extras(i));
  }

  card(key: CardTextKey, vars: ReasonParams, lang?: Lang): string {
    return renderCard(key, vars, this.context(lang));
  }

  duration(min: number, lang?: Lang): string {
    return duration(min, lang ?? this.lang());
  }

  clock(ts: EpochMs, lang?: Lang): string {
    return clock(ts, { lang: lang ?? this.lang(), now: this.clockPort.now(), tz: this.clockPort.tz() });
  }

  /** Live values a template may mention: the room's temperature now (also in a recovery message). */
  extras(i: Pick<Incident, 'roomId'>): Vars {
    if (!i.roomId) return {};
    try {
      const t = this.engine()?.room(i.roomId)?.tempC;
      return typeof t === 'number' ? { roomTemp: t } : {};
    } catch {
      return {};
    }
  }

  names(): NameResolver {
    const c = this.nameCache();
    const friendly = (id: string): string | null => {
      const n = this.ha.getState(id)?.attributes.friendly_name;
      return typeof n === 'string' && n.trim() ? n.trim() : null;
    };
    return {
      room: (id) => c.rooms.get(id) ?? null,
      source: (id) => c.sources.get(id) ?? null,
      profile: (id) => c.profiles.get(id) ?? null,
      trigger: (id) => c.triggers.get(id) ?? null,
      rule: (id) => c.rules.get(id) ?? null,
      circuit: (id) => c.circuits.get(id) ?? null,
      pump: (id) => c.pumps.get(id) ?? null,
      instance: (id) => c.instances.get(id) ?? null,
      device: (key) => c.devices.get(key) ?? (key.startsWith('entity:') ? (c.entities.get(key.slice(7)) ?? friendly(key.slice(7))) : null),
      entity: (id) => c.entities.get(id) ?? friendly(id),
    };
  }

  private nameCache(): NameCache {
    const rev = this.config.revision();
    if (this.cache && this.cache.rev === rev) return this.cache;
    const cfg = this.config.engineConfig();
    const byId = <T extends { id: string; name: string }>(xs: readonly T[]) => new Map(xs.map((x) => [x.id, x.name]));
    const rooms = byId(cfg.rooms);
    const entities = new Map<string, string>();
    const devices = new Map<string, string>();
    for (const room of cfg.rooms) {
      for (const s of cfg.sensorsByRoom[room.id] ?? []) {
        if (s.name) entities.set(s.entityId, s.name);
        if (s.haDeviceId && s.name) devices.set(s.haDeviceId, `${room.name} · ${s.name}`);
      }
      for (const e of cfg.emittersByRoom[room.id] ?? []) {
        for (const d of cfg.devicesByEmitter[e.id] ?? []) {
          const name = d.label || d.name;
          if (name) entities.set(d.entityId, name);
          if (name) devices.set(d.id, name);
          if (d.haDeviceId && name) devices.set(d.haDeviceId, `${room.name} · ${name}`);
        }
      }
    }
    for (const p of cfg.pumps) entities.set(p.entityId, p.name);
    const sources = sourceLabels(cfg);
    for (const s of cfg.sources) {
      for (const id of commandEntities(s.adapter)) if (!entities.has(id)) entities.set(id, sources.get(s.id) ?? s.name);
    }
    const labels = new Map<string, string>();
    for (const m of this.config.deviceMeta()) {
      if (!m.label) continue;
      devices.set(m.key, m.label);
      labels.set(m.key, m.label);
    }
    const z2m = this.config.list('z2m');
    this.cache = {
      rev,
      rooms,
      sources,
      profiles: byId(cfg.profiles),
      triggers: byId(cfg.triggers),
      rules: byId(cfg.rules),
      circuits: byId(cfg.circuits),
      pumps: byId(cfg.pumps),
      instances: new Map(z2m.map((z) => [z.id, z.name])),
      devices,
      entities,
      bound: boundEntities(cfg, sources),
      labels,
      triggerList: cfg.triggers,
      safeC: cfg.safety.noDataTrvSetpointC,
    };
    return this.cache;
  }

  /* ── what an alert is about ─────────────────────────────────────────────────────────────────── */

  /**
   * Facts that name the device a detection is about, as the Devices page names it: `name`, `showEntity`
   * when that name alone does not tell it apart in its room (two «Температура» sensors, a name that only
   * says what it is), its `role`, and what Klimo does meanwhile when that depends on live state (where a
   * room takes its temperature from, the outdoor fallback, a trigger's rule for missing data).
   */
  subjectFacts(d: Pick<Detection, 'kind' | 'roomId' | 'entityId' | 'deviceKey' | 'facts' | 'sourceId'>): ReasonParams {
    if (d.sourceId && SOURCE_KINDS.has(d.kind)) return this.sourceFacts(d.sourceId);
    if (d.kind === 'z2m_offline') return this.bridgeFacts(d.facts ?? {});
    if (!SUBJECT_KINDS.has(d.kind)) return {};
    const f = d.facts ?? {};
    const entityId = (typeof f.entityId === 'string' && f.entityId) || d.entityId || null;
    if (!entityId && !d.deviceKey) return {};
    const c = this.nameCache();
    const bound = entityId ? c.bound.get(entityId) : undefined;
    const own = bound && !bound.deviceKey.startsWith('entity:') ? bound.deviceKey : null;
    const key = d.deviceKey ?? own ?? (entityId ? (this.registryDevice(entityId) ?? `entity:${entityId}`) : null);
    const given = typeof f.name === 'string' && f.name.trim() ? f.name.trim() : null;
    const name =
      (key ? c.labels.get(key) : undefined) ??
      (entityId ? c.labels.get(`entity:${entityId}`) : undefined) ??
      (bound?.name || given || this.haDeviceName(key) || (entityId ? this.friendly(entityId) : null) || entityId || key);
    if (!name) return {};
    const out: Record<string, string | number | boolean | null> = { name };
    const roomId = d.roomId ?? bound?.roomId ?? null;
    if (entityId && name !== entityId && this.ambiguous(c, name, entityId, key, roomId)) out.showEntity = true;
    const role = typeof f.role === 'string' ? f.role : bound?.role;
    if (role) out.role = role;
    if (entityId && d.kind === 'entity_unavailable' && f.triggerId === undefined) {
      // a trigger's input that is gone: the trigger's rule for missing data decides what happens
      const t = c.triggerList.find((x) => x.enabled && JSON.stringify(x.condition).includes(JSON.stringify(entityId)));
      if (t) {
        out.triggerId = t.id;
        out.unknownAs = t.whenUnknown;
      }
    }
    if (d.kind === 'sensor_offline' && roomId && role === 'temperature' && f.left === 0) {
      const fallback = this.roomFallback(roomId);
      if (fallback) out.tempFrom = fallback;
      if (fallback !== 'trv' && bound?.roomHasTrv && c.safeC !== null) out.safeC = c.safeC;
    }
    if (f.outdoor === true || role === 'outdoor') {
      try {
        const s = this.engine()?.season();
        if (s) {
          out.outdoorSource = s.outdoorSource;
          if (s.outdoorC !== null) out.outdoorC = s.outdoorC;
        }
      } catch {
        // no engine yet: the text says what usually happens
      }
    }
    if (d.kind === 'battery_low') out.reminderPct = this.config.singleton('deviceHealth').batteryLow.reminderPct;
    return out;
  }

  /** Two sources that still read the same with their room («Кондиціонер · Вітальня» twice): the entity id is added. */
  private sourceFacts(sourceId: string): ReasonParams {
    const c = this.nameCache();
    const label = c.sources.get(sourceId);
    if (!label) return {};
    for (const [id, other] of c.sources) if (id !== sourceId && sameName(other, label)) return { sourceShared: true };
    return {};
  }

  /** Two Zigbee2MQTT bridges with one name: their base topics tell them apart. */
  private bridgeFacts(f: ReasonParams): ReasonParams {
    const list = this.config.list('z2m');
    const z = list.find((x) => x.id === f.instanceId);
    if (!z) return {};
    return list.some((x) => x.id !== z.id && sameName(x.name, z.name)) ? { topic: z.baseTopic } : {};
  }

  /** Another device in the same place with the same name, or a name that only says what it is. */
  private ambiguous(c: NameCache, name: string, entityId: string, key: string | null, roomId: string | null): boolean {
    if (isGenericName(name, roomId ? (c.rooms.get(roomId) ?? null) : null)) return true;
    for (const [id, b] of c.bound) {
      if (id === entityId || b.deviceKey === key || b.roomId !== roomId) continue;
      const other = c.labels.get(b.deviceKey) ?? (b.name || this.friendly(id) || id);
      if (sameName(other, name)) return true;
    }
    return false;
  }

  private roomFallback(roomId: string): 'trv' | 'no_data' | null {
    try {
      const f = this.engine()?.room(roomId)?.aggregation.fallback;
      return f === 'trv' || f === 'no_data' ? f : null;
    } catch {
      return null;
    }
  }

  /** The HA device an entity belongs to (the Devices page groups by it). */
  private registryDevice(entityId: string): string | null {
    try {
      return this.ha.registries().entities.find((e) => e.entity_id === entityId)?.device_id ?? null;
    } catch {
      return null;
    }
  }

  private haDeviceName(key: string | null): string | null {
    if (!key || key.startsWith('entity:') || key.startsWith('z2m:')) return null;
    try {
      const d = this.ha.registries().devices.find((x) => x.id === key);
      const n = d?.name_by_user ?? d?.name;
      return n?.trim() || null;
    } catch {
      return null;
    }
  }

  private friendly(id: string): string | null {
    const n = this.ha.getState(id)?.attributes.friendly_name;
    return typeof n === 'string' && n.trim() ? n.trim() : null;
  }
}

/** Every entity bound in the configuration, by entity id; a room's own devices first. */
function boundEntities(cfg: EngineConfig, sourceNames: Map<string, string>): Map<string, Bound> {
  const out = new Map<string, Bound>();
  const add = (entityId: string | null | undefined, b: Omit<Bound, 'deviceKey'> & { deviceKey?: string | null }) => {
    if (!entityId || entityId.startsWith('z2m:') || out.has(entityId)) return;
    out.set(entityId, { ...b, deviceKey: b.deviceKey ?? `entity:${entityId}` });
  };
  for (const room of cfg.rooms) {
    const devices = (cfg.emittersByRoom[room.id] ?? []).flatMap((e) => cfg.devicesByEmitter[e.id] ?? []);
    const roomHasTrv = devices.some((d) => d.kind === 'trv');
    for (const s of cfg.sensorsByRoom[room.id] ?? []) add(s.entityId, { name: s.name, roomId: room.id, deviceKey: s.haDeviceId, role: s.role, roomHasTrv });
    for (const d of devices) {
      const b = { name: d.label || d.name, roomId: room.id, deviceKey: d.haDeviceId ?? `entity:${d.entityId}`, role: d.kind === 'trv' ? 'trv' : 'zone' };
      add(d.entityId, b);
      for (const sib of [d.siblings?.battery, d.siblings?.linkquality]) add(sib, b);
    }
    if (room.humidity.dehumidifier) add(room.humidity.dehumidifier.entityId, { name: '', roomId: room.id, role: 'dehumidifier' });
  }
  for (const s of cfg.sources) {
    const roomId = s.scope === 'room' ? s.roomId : null;
    for (const id of commandEntities(s.adapter)) add(id, { name: sourceNames.get(s.id) ?? s.name, roomId, role: 'source' });
  }
  for (const p of cfg.pumps) add(p.entityId, { name: p.name, roomId: null, role: 'pump' });
  for (const c of cfg.circuits) {
    for (const id of [c.supply.sensorEntityId, c.supply.returnEntityId, c.mixingValve?.entityId]) add(id, { name: c.name, roomId: null, role: 'circuit' });
  }
  for (const m of cfg.manifolds) for (const id of [m.supplySensorEntityId, m.returnSensorEntityId]) add(id, { name: m.name, roomId: null, role: 'circuit' });
  for (const id of Object.values(cfg.energy.entities)) add(id, { name: '', roomId: null, role: 'energy' });
  // outdoor sensors and trigger inputs share one place each: two «Temperature» sensors outside, two
  // «Voltage» inputs of a blackout trigger are told apart by their ids
  for (const id of outdoorSensorIds(cfg.settings.outdoor)) add(id, { name: '', roomId: null, role: 'outdoor' });
  for (const t of cfg.triggers) for (const id of conditionEntities(t.condition)) add(id, { name: '', roomId: null, role: 'trigger' });
  return out;
}

/** The entities that command a source (its «main» entity for names and watch rules). */
export function commandEntities(a: SourceAdapter): string[] {
  switch (a.type) {
    case 'relay':
      return [a.command, ...a.stages.map((s) => s.entityId)].filter((x): x is string => !!x);
    case 'climate':
      return a.climate ? [a.climate] : [];
    case 'flow':
      return [a.enable, a.flowSetpoint].filter((x): x is string => !!x);
    case 'script':
      return [...Object.values(a.on), a.off].filter((x): x is string => !!x);
    case 'custom':
      return [];
  }
}
