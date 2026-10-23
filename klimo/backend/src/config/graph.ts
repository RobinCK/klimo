import { EntityManager, EntityTarget, ObjectLiteral } from 'typeorm';
import {
  ATOMIC_KEYS,
  DEFAULT_ACTIVATION_RULE,
  circuitModeDefaults,
  DEFAULT_CIRCUIT,
  DEFAULT_EMITTER,
  DEFAULT_EMITTER_DEVICE,
  DEFAULT_MANIFOLD,
  DEFAULT_PUMP,
  DEFAULT_ROOM,
  DEFAULT_RULE,
  DEFAULT_SCHEDULE,
  DEFAULT_SENSOR,
  DEFAULT_TARGET,
  DEFAULT_TRIGGER,
  DEFAULT_TRV_CAPABILITIES,
  DEFAULT_TRV_SIBLINGS,
  DEFAULT_WATCH_RULE,
  DEFAULT_Z2M,
  deepClone,
  defaultCoolStrategy,
  defaultDeviceHealth,
  defaultEnergy,
  defaultHeatStrategy,
  defaultHouse,
  defaultNotifySettings,
  defaultSafety,
  defaultSeason,
  defaultSettings,
  defaultTariffs,
  sourceMergeBase,
  storedMeters,
  withDefaults,
} from '../shared/defaults';
import type {
  Circuit,
  ConfigCollectionName,
  ConfigCollections,
  ConfigEntityName,
  ConfigSingletonName,
  ConfigSingletons,
  DeviceMeta,
  EventParams,
  Id,
  Override,
  PersonalPrefs,
  ProfileRoomSetting,
  RoutingCell,
  SourceConfig,
} from '../shared/model';
import {
  ActivationRuleRow,
  CircuitRow,
  CircuitSourceRow,
  CoolStrategyRow,
  DeviceHealthSettingsRow,
  DeviceMetaRow,
  EmitterDeviceRow,
  EmitterRow,
  EnergyPolicyRow,
  EventParamsRow,
  HeatStrategyRow,
  HouseSettingsRow,
  ManifoldRow,
  NotifyRoutingRow,
  NotifySettingsRow,
  NotifyTargetRow,
  OverrideRow,
  PersonalPrefsRow,
  ProfileRoomRow,
  ProfileRow,
  PumpRow,
  RoomRow,
  RoomSensorRow,
  SafetySettingsRow,
  ScheduleExceptionRow,
  ScheduleRow,
  SeasonConfigRow,
  SettingsRow,
  SourceRow,
  TriggerRow,
  TriggerRuleRow,
  WatchRuleRow,
  Z2mInstanceRow,
} from '../db/entities';

/* =====================================================================================================
 * The configuration as one in-memory graph, and its mapping onto the database tables. Writes work on a
 * cloned draft of the graph; persisting diffs the draft's rows against the committed rows, so a single
 * edit, a cascade over ten tables or a whole import all become one transaction of row inserts, updates
 * and deletes.
 * ===================================================================================================== */

export type Collections = { [K in ConfigCollectionName]: Map<Id, ConfigCollections[K]> };

export interface ConfigGraph extends Collections, ConfigSingletons {
  /** key `${profileId}|${roomId}` */
  profileRooms: Map<string, ProfileRoomSetting>;
  /** Stored routing cells only (those that differ from the catalogue default); key `${kind}|${targetId}`. */
  routing: Map<string, RoutingCell>;
  /** Stored per-kind parameters only. */
  eventParams: Map<string, EventParams>;
  personal: Map<string, PersonalPrefs>;
  deviceMeta: Map<string, DeviceMeta>;
  /** Active overrides (owned by the override store; part of the draft so cascades stay transactional). */
  overrides: Map<Id, Override>;
}

export const COLLECTIONS: readonly ConfigCollectionName[] = [
  'rooms', 'sensors', 'emitters', 'emitterDevices', 'profiles', 'activationRules', 'schedules', 'scheduleExceptions',
  'sources', 'manifolds', 'circuits', 'pumps', 'triggers', 'rules', 'targets', 'watchRules', 'z2m',
];

export const SINGLETONS: readonly ConfigSingletonName[] = ['settings', 'safety', 'house', 'heat', 'cool', 'season', 'energy', 'notify', 'deviceHealth'];

export const COLLECTION_ENTITY: Record<ConfigCollectionName, ConfigEntityName> = {
  rooms: 'room',
  sensors: 'sensor',
  emitters: 'emitter',
  emitterDevices: 'emitter_device',
  profiles: 'profile',
  activationRules: 'activation_rule',
  schedules: 'schedule',
  scheduleExceptions: 'schedule',
  sources: 'source',
  manifolds: 'manifold',
  circuits: 'circuit',
  pumps: 'pump',
  triggers: 'trigger',
  rules: 'rule',
  targets: 'notify_target',
  watchRules: 'watch_rule',
  z2m: 'z2m_instance',
};

export const SINGLETON_ENTITY: Record<ConfigSingletonName, ConfigEntityName> = {
  settings: 'settings',
  safety: 'safety',
  house: 'house',
  heat: 'strategy',
  cool: 'strategy',
  season: 'strategy',
  energy: 'energy',
  notify: 'notify_settings',
  deviceHealth: 'device_health',
};

export function singletonDefaults(): ConfigSingletons {
  return {
    settings: defaultSettings(),
    safety: defaultSafety(),
    house: defaultHouse(),
    heat: defaultHeatStrategy(),
    cool: defaultCoolStrategy(),
    season: defaultSeason(),
    energy: defaultEnergy(),
    notify: defaultNotifySettings(),
    deviceHealth: defaultDeviceHealth(),
  };
}

export function emptyGraph(): ConfigGraph {
  const g = { ...singletonDefaults() } as ConfigGraph;
  for (const c of COLLECTIONS) (g as unknown as Record<string, Map<Id, unknown>>)[c] = new Map();
  g.profileRooms = new Map();
  g.routing = new Map();
  g.eventParams = new Map();
  g.personal = new Map();
  g.deviceMeta = new Map();
  g.overrides = new Map();
  return g;
}

export function cloneGraph(g: ConfigGraph): ConfigGraph {
  return structuredClone(g);
}

export const prKey = (profileId: Id, roomId: Id) => `${profileId}|${roomId}`;
export const routeKey = (kind: string, targetId: Id) => `${kind}|${targetId}`;

/* ── row mapping ──────────────────────────────────────────────────────────────────────────────── */

type Row = Record<string, unknown>;

function omit(o: Row, keys: ReadonlySet<string>): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(o)) if (!keys.has(k)) out[k] = v;
  return out;
}

/**
 * A stored row → model: nested JSON is merged onto the defaults (later fields appear), union-valued
 * columns (conditions, adapters' variants, plans) are taken whole, NULL columns fall back to defaults.
 */
export function fromRow<T>(row: ObjectLiteral, base: T): T {
  const plain: Row = { ...row };
  const b = base as unknown as Row;
  const atomic = new Set(Object.keys(plain).filter((k) => ATOMIC_KEYS.has(k)));
  const merged = withDefaults(omit(plain, atomic), omit(b, atomic)) as Row;
  for (const k of atomic) merged[k] = plain[k] ?? deepClone(b[k]);
  return merged as T;
}

const BASES: { [K in ConfigCollectionName]: (row: ObjectLiteral) => ConfigCollections[K] } = {
  rooms: () => DEFAULT_ROOM(),
  sensors: () => DEFAULT_SENSOR(),
  emitters: () => DEFAULT_EMITTER(),
  // a TRV's capability and sibling records gain keys added later; zone actuators keep null
  emitterDevices: (row) => ({
    ...DEFAULT_EMITTER_DEVICE(),
    capabilities: row.capabilities ? deepClone(DEFAULT_TRV_CAPABILITIES) : null,
    siblings: row.siblings ? deepClone(DEFAULT_TRV_SIBLINGS) : null,
  }),
  profiles: () => ({ id: '', name: '', kind: 'custom', color: '#9B87F5', ink: '#140F2E', icon: 'home', heatC: 21, coolC: 25, frostOnly: false, order: 0 }),
  activationRules: () => DEFAULT_ACTIVATION_RULE(),
  schedules: () => DEFAULT_SCHEDULE(),
  scheduleExceptions: () => ({ id: '', scheduleId: '', date: '', plan: [], note: null }),
  sources: (row) => sourceMergeBase(row.kind as SourceConfig['kind'], (row.adapter as SourceConfig['adapter'] | null)?.type),
  manifolds: () => DEFAULT_MANIFOLD(),
  circuits: () => DEFAULT_CIRCUIT(),
  pumps: () => DEFAULT_PUMP(),
  triggers: () => DEFAULT_TRIGGER(),
  rules: () => DEFAULT_RULE(),
  targets: () => DEFAULT_TARGET(),
  watchRules: () => DEFAULT_WATCH_RULE(),
  z2m: () => DEFAULT_Z2M(),
};

export function collectionFromRow<K extends ConfigCollectionName>(c: K, row: ObjectLiteral): ConfigCollections[K] {
  const value = fromRow(row, BASES[c](row));
  if (c === 'circuits') {
    // rows saved before circuits had a mode hold NULL there (the mode itself is read from the pumps on load)
    const circuit = value as Circuit;
    return { ...circuit, mode: circuit.mode ?? DEFAULT_CIRCUIT().mode, bypass: circuit.bypass ?? false } as ConfigCollections[K];
  }
  if (c !== 'sources') {
    return value;
  }

  // a row saved before meters existed has none: its power sensor becomes the electricity meter
  const source = value as SourceConfig;

  return { ...source, meters: storedMeters(row.meters, source.energy) } as ConfigCollections[K];
}

/** Defaults a new object of a collection starts from (the source base depends on its kind/adapter). */
export function collectionBase<K extends ConfigCollectionName>(c: K, value: ObjectLiteral): ConfigCollections[K] {
  return BASES[c](value);
}

export function singletonFromRow<K extends ConfigSingletonName>(k: K, row: ObjectLiteral | null): ConfigSingletons[K] {
  const base = singletonDefaults()[k];
  if (!row) return base;
  const { id: _id, ...rest } = row;
  const value = fromRow(rest, base);
  if (k !== 'settings') {
    return value;
  }

  // a settings row saved before tariffs existed holds NULL in that column
  const settings = value as ConfigSingletons['settings'];

  return { ...settings, tariffs: withDefaults(settings.tariffs, defaultTariffs()) } as ConfigSingletons[K];
}

/** One database table: how to compute its rows from the graph. */
export interface TableDef {
  name: string;
  /** The collection or singleton whose objects this table stores (none for derived tables). */
  collection?: ConfigCollectionName;
  singleton?: ConfigSingletonName;
  entity: EntityTarget<ObjectLiteral>;
  pk: readonly string[];
  event: ConfigEntityName;
  idOf: (row: Row) => Id | null;
  rows: (g: ConfigGraph, columns: readonly string[]) => Map<string, Row>;
}

function pick(model: object, columns: readonly string[]): Row {
  const m = model as Row;
  const out: Row = {};
  for (const c of columns) out[c] = m[c] === undefined ? null : m[c];
  return out;
}

function collectionTable(c: ConfigCollectionName, name: string, entity: EntityTarget<ObjectLiteral>): TableDef {
  return {
    name,
    collection: c,
    entity,
    pk: ['id'],
    event: COLLECTION_ENTITY[c],
    idOf: (r) => r.id as Id,
    rows: (g, cols) => {
      const out = new Map<string, Row>();
      for (const [id, m] of (g[c] as Map<Id, object>).entries()) out.set(id, pick(m, cols));
      return out;
    },
  };
}

function singletonTable(k: ConfigSingletonName, name: string, entity: EntityTarget<ObjectLiteral>): TableDef {
  return {
    name,
    singleton: k,
    entity,
    pk: ['id'],
    event: SINGLETON_ENTITY[k],
    idOf: () => null,
    rows: (g, cols) => new Map([['main', { ...pick(g[k], cols), id: 'main' }]]),
  };
}

function mapTable<V extends object>(
  name: string,
  entity: EntityTarget<ObjectLiteral>,
  pk: readonly string[],
  event: ConfigEntityName,
  get: (g: ConfigGraph) => Map<string, V>,
  idOf: (r: Row) => Id | null,
): TableDef {
  return {
    name,
    entity,
    pk,
    event,
    idOf,
    rows: (g, cols) => {
      const out = new Map<string, Row>();
      for (const [k, v] of get(g).entries()) out.set(k, pick(v, cols));
      return out;
    },
  };
}

export const CONFIG_TABLES: readonly TableDef[] = [
  singletonTable('settings', 'settings', SettingsRow),
  singletonTable('safety', 'safety_settings', SafetySettingsRow),
  singletonTable('house', 'house_settings', HouseSettingsRow),
  singletonTable('heat', 'heat_strategy', HeatStrategyRow),
  singletonTable('cool', 'cool_strategy', CoolStrategyRow),
  singletonTable('season', 'season_config', SeasonConfigRow),
  singletonTable('energy', 'energy_policy', EnergyPolicyRow),
  singletonTable('notify', 'notify_settings', NotifySettingsRow),
  singletonTable('deviceHealth', 'device_health_settings', DeviceHealthSettingsRow),
  collectionTable('rooms', 'room', RoomRow),
  collectionTable('sensors', 'room_sensor', RoomSensorRow),
  collectionTable('emitters', 'emitter', EmitterRow),
  collectionTable('emitterDevices', 'emitter_device', EmitterDeviceRow),
  collectionTable('sources', 'source', SourceRow),
  collectionTable('manifolds', 'manifold', ManifoldRow),
  collectionTable('circuits', 'circuit', CircuitRow),
  {
    name: 'circuit_source',
    entity: CircuitSourceRow,
    pk: ['circuitId', 'sourceId'],
    event: 'circuit',
    idOf: (r) => r.circuitId as Id,
    rows: (g) => {
      const out = new Map<string, Row>();
      for (const c of g.circuits.values()) {
        c.sourceIds.forEach((sourceId, order) => out.set(`${c.id}|${sourceId}`, { circuitId: c.id, sourceId, order }));
      }
      return out;
    },
  },
  collectionTable('pumps', 'pump', PumpRow),
  collectionTable('profiles', 'profile', ProfileRow),
  mapTable('profile_room', ProfileRoomRow, ['profileId', 'roomId'], 'profile_room', (g) => g.profileRooms, (r) => r.roomId as Id),
  collectionTable('activationRules', 'activation_rule', ActivationRuleRow),
  collectionTable('schedules', 'schedule', ScheduleRow),
  collectionTable('scheduleExceptions', 'schedule_exception', ScheduleExceptionRow),
  collectionTable('triggers', 'trigger', TriggerRow),
  collectionTable('rules', 'trigger_rule', TriggerRuleRow),
  collectionTable('targets', 'notify_target', NotifyTargetRow),
  mapTable('notify_routing', NotifyRoutingRow, ['kind', 'targetId'], 'routing', (g) => g.routing, (r) => r.targetId as Id),
  mapTable('event_params', EventParamsRow, ['kind'], 'event_params', (g) => g.eventParams, (r) => r.kind as Id),
  collectionTable('watchRules', 'watch_rule', WatchRuleRow),
  mapTable('personal_prefs', PersonalPrefsRow, ['userId'], 'personal_prefs', (g) => g.personal, (r) => r.userId as Id),
  collectionTable('z2m', 'z2m_instance', Z2mInstanceRow),
  mapTable('device_meta', DeviceMetaRow, ['key'], 'device_meta', (g) => g.deviceMeta, (r) => r.key as Id),
];

export const OVERRIDE_TABLE: TableDef = mapTable('override', OverrideRow, ['id'], 'override', (g) => g.overrides, (r) => r.subjectId as Id);

/* ── load and persist ─────────────────────────────────────────────────────────────────────────── */

/** Circuits saved before they had a mode: their pumps' rule said it (a pump running with the source = the whole loop). */
export function legacyCircuitModes(g: ConfigGraph, ids: readonly Id[]): void {
  for (const id of ids) {
    const c = g.circuits.get(id);
    if (!c) continue;
    const rules = [...g.pumps.values()].filter((p) => p.circuitId === c.id).map((p) => p.rule);
    c.mode = rules.length ? (rules.includes('source') ? 'follow_source' : 'zoned') : circuitModeDefaults(c.kind).mode;
  }
}

export async function loadGraph(em: EntityManager): Promise<{ graph: ConfigGraph; missingSingletons: ConfigSingletonName[] }> {
  const g = emptyGraph();
  const missingSingletons: ConfigSingletonName[] = [];
  const one = async <K extends ConfigSingletonName>(k: K, entity: EntityTarget<ObjectLiteral>) => {
    const row = await em.getRepository(entity).findOneBy({ id: 'main' });
    if (!row) missingSingletons.push(k);
    (g as ConfigSingletons)[k] = singletonFromRow(k, row);
  };
  await one('settings', SettingsRow);
  await one('safety', SafetySettingsRow);
  await one('house', HouseSettingsRow);
  await one('heat', HeatStrategyRow);
  await one('cool', CoolStrategyRow);
  await one('season', SeasonConfigRow);
  await one('energy', EnergyPolicyRow);
  await one('notify', NotifySettingsRow);
  await one('deviceHealth', DeviceHealthSettingsRow);

  const all = async <K extends ConfigCollectionName>(c: K, entity: EntityTarget<ObjectLiteral>) => {
    const map = g[c] as Map<Id, ConfigCollections[K]>;
    for (const row of await em.getRepository(entity).find()) map.set(row.id as Id, collectionFromRow(c, row));
  };
  await all('rooms', RoomRow);
  await all('sensors', RoomSensorRow);
  await all('emitters', EmitterRow);
  await all('emitterDevices', EmitterDeviceRow);
  await all('sources', SourceRow);
  await all('manifolds', ManifoldRow);
  await all('circuits', CircuitRow);
  await all('pumps', PumpRow);
  await all('profiles', ProfileRow);
  await all('activationRules', ActivationRuleRow);
  await all('schedules', ScheduleRow);
  await all('scheduleExceptions', ScheduleExceptionRow);
  await all('triggers', TriggerRow);
  await all('rules', TriggerRuleRow);
  await all('targets', NotifyTargetRow);
  await all('watchRules', WatchRuleRow);
  await all('z2m', Z2mInstanceRow);

  legacyCircuitModes(g, (await em.getRepository(CircuitRow).find()).filter((r) => !r.mode).map((r) => r.id as Id));

  const feeds = await em.getRepository(CircuitSourceRow).find({ order: { order: 'ASC' } });
  for (const f of feeds) g.circuits.get(f.circuitId)?.sourceIds.push(f.sourceId);
  for (const c of g.circuits.values()) c.sourceIds = [...new Set(c.sourceIds)];

  for (const r of await em.getRepository(ProfileRoomRow).find()) {
    g.profileRooms.set(prKey(r.profileId, r.roomId), { profileId: r.profileId, roomId: r.roomId, mode: r.mode as 'own' | 'off', heatC: r.heatC, coolC: r.coolC, writtenAt: r.writtenAt });
  }
  for (const r of await em.getRepository(NotifyRoutingRow).find()) {
    g.routing.set(routeKey(r.kind, r.targetId), { kind: r.kind as RoutingCell['kind'], targetId: r.targetId, on: r.on });
  }
  for (const r of await em.getRepository(EventParamsRow).find()) {
    g.eventParams.set(r.kind, { kind: r.kind as EventParams['kind'], enabled: r.enabled, params: r.params ?? {} });
  }
  for (const r of await em.getRepository(PersonalPrefsRow).find()) {
    g.personal.set(r.userId, fromRow(r, { userId: r.userId, targetIds: [], levels: { critical: true, warning: true, event: true, report: true }, quietHours: true } as PersonalPrefs));
  }
  for (const r of await em.getRepository(DeviceMetaRow).find()) {
    g.deviceMeta.set(r.key, { key: r.key, label: r.label, ignored: r.ignored, batteryType: r.batteryType });
  }
  return { graph: g, missingSingletons };
}

export type RowSnapshot = Map<string, Map<string, string>>;

export interface TableChange {
  table: TableDef;
  op: 'created' | 'updated' | 'deleted';
  key: string;
  row: Row;
}

/** Stable JSON of every row of every table (the "committed" side of a diff). */
export function snapshotRows(g: ConfigGraph, columnsOf: (t: TableDef) => readonly string[], tables: readonly TableDef[] = CONFIG_TABLES): RowSnapshot {
  const snap: RowSnapshot = new Map();
  for (const t of tables) {
    const m = new Map<string, string>();
    for (const [k, r] of t.rows(g, columnsOf(t))) m.set(k, JSON.stringify(r));
    snap.set(t.name, m);
  }
  return snap;
}

export function diffRows(base: RowSnapshot, g: ConfigGraph, columnsOf: (t: TableDef) => readonly string[], tables: readonly TableDef[] = CONFIG_TABLES): TableChange[] {
  const changes: TableChange[] = [];
  for (const t of tables) {
    const before = base.get(t.name) ?? new Map<string, string>();
    const after = t.rows(g, columnsOf(t));
    for (const [k, r] of after) {
      const prev = before.get(k);
      if (prev === undefined) changes.push({ table: t, op: 'created', key: k, row: r });
      else if (prev !== JSON.stringify(r)) changes.push({ table: t, op: 'updated', key: k, row: r });
    }
    for (const [k, json] of before) if (!after.has(k)) changes.push({ table: t, op: 'deleted', key: k, row: JSON.parse(json) as Row });
  }
  return changes;
}

const CHUNK = 40;

/** Writes the changes (deletes first, so a unique value can move between rows in one commit). */
export async function writeChanges(em: EntityManager, changes: readonly TableChange[]): Promise<void> {
  for (const ch of changes) {
    if (ch.op !== 'deleted') continue;
    await em.delete(ch.table.entity, Object.fromEntries(ch.table.pk.map((k) => [k, ch.row[k]])));
  }
  for (const ch of changes) {
    if (ch.op !== 'updated') continue;
    const criteria = Object.fromEntries(ch.table.pk.map((k) => [k, ch.row[k]]));
    const values = omit(ch.row, new Set(ch.table.pk));
    if (Object.keys(values).length) await em.update(ch.table.entity, criteria, values);
  }
  const inserts = new Map<TableDef, Row[]>();
  for (const ch of changes) {
    if (ch.op !== 'created') continue;
    const list = inserts.get(ch.table) ?? [];
    list.push(ch.row);
    inserts.set(ch.table, list);
  }
  for (const [t, rows] of inserts) {
    for (let i = 0; i < rows.length; i += CHUNK) await em.insert(t.entity, rows.slice(i, i + CHUNK));
  }
}
