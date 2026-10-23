import { deepClone, isPlainObject, normalizeOutdoor } from '../shared/defaults';
import type {
  ApiErrorIssue,
  ConfigCollectionName,
  ConfigCollections,
  ConfigSingletonName,
  DeviceMeta,
  EpochMs,
  EventParams,
  ExportBundle,
  Id,
  PersonalPrefs,
  ProfileRoomSetting,
  RoutingCell,
} from '../shared/model';
import { collectionFromRow, emptyGraph, legacyCircuitModes, prKey, routeKey, singletonFromRow, type ConfigGraph } from './graph';

/* =====================================================================================================
 * Backup bundle ↔ configuration graph. The bundle holds every configuration table and nothing else:
 * no runtime state, no secrets (the Telegram token and database passwords live in add-on options).
 * ===================================================================================================== */

const byOrder = <T extends { order?: number }>(xs: T[]) => xs.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
const values = <T>(m: Map<string, T>): T[] => [...m.values()].map((x) => deepClone(x));

export function buildExport(g: ConfigGraph, addonVersion: string, now: EpochMs): ExportBundle {
  return {
    app: 'klimo',
    version: 1,
    exportedAt: now,
    addonVersion,
    settings: deepClone(g.settings),
    safety: deepClone(g.safety),
    house: deepClone(g.house),
    rooms: byOrder(values(g.rooms)),
    sensors: byOrder(values(g.sensors)),
    emitters: byOrder(values(g.emitters)),
    emitterDevices: byOrder(values(g.emitterDevices)),
    profiles: byOrder(values(g.profiles)),
    profileRooms: values(g.profileRooms),
    activationRules: byOrder(values(g.activationRules)),
    schedules: values(g.schedules),
    scheduleExceptions: values(g.scheduleExceptions),
    sources: byOrder(values(g.sources)),
    manifolds: byOrder(values(g.manifolds)),
    circuits: byOrder(values(g.circuits)),
    pumps: byOrder(values(g.pumps)),
    heatStrategy: deepClone(g.heat),
    coolStrategy: deepClone(g.cool),
    season: deepClone(g.season),
    energy: deepClone(g.energy),
    triggers: byOrder(values(g.triggers)),
    rules: values(g.rules).sort((a, b) => a.priority - b.priority),
    notify: {
      settings: deepClone(g.notify),
      targets: byOrder(values(g.targets)),
      routing: values(g.routing),
      events: values(g.eventParams),
      watch: values(g.watchRules),
      personal: values(g.personal),
    },
    devices: { health: deepClone(g.deviceHealth), meta: values(g.deviceMeta), z2m: values(g.z2m) },
  };
}

/** `klimo-config-2026-10-21.json` */
export function exportFileName(date: string): string {
  return `klimo-config-${date}.json`;
}

export interface ParsedBundle {
  graph: ConfigGraph;
  counts: Record<string, number>;
  issues: ApiErrorIssue[];
}

/**
 * Rebuilds a graph from a bundle, filling fields a newer version added with their defaults. Only the
 * shape is checked here; the configuration rules run on the result like on any other write.
 */
export function graphFromBundle(bundle: unknown): ParsedBundle {
  const g = emptyGraph();
  const issues: ApiErrorIssue[] = [];
  const counts: Record<string, number> = {};
  if (!isPlainObject(bundle)) return { graph: g, counts, issues: [{ path: '', code: 'type', params: { expected: 'object' } }] };
  if (bundle.app !== 'klimo') issues.push({ path: 'app', code: 'enum', params: { values: 'klimo' } });
  if (bundle.version !== 1) issues.push({ path: 'version', code: 'unsupported', params: { version: String(bundle.version) } });
  if (issues.length) return { graph: g, counts, issues };

  const one = <K extends ConfigSingletonName>(k: K, path: string, v: unknown) => {
    if (!isPlainObject(v)) return issues.push({ path, code: 'required' });
    (g as unknown as Record<string, unknown>)[k] = singletonFromRow(k, v);
  };
  const notify = isPlainObject(bundle.notify) ? bundle.notify : {};
  const devices = isPlainObject(bundle.devices) ? bundle.devices : {};
  one('settings', 'settings', bundle.settings);
  // backups from before several outdoor sensors name one `sensorEntityId`
  if (isPlainObject(g.settings.outdoor)) g.settings.outdoor = normalizeOutdoor(g.settings.outdoor);
  one('safety', 'safety', bundle.safety);
  one('house', 'house', bundle.house);
  one('heat', 'heatStrategy', bundle.heatStrategy);
  one('cool', 'coolStrategy', bundle.coolStrategy);
  one('season', 'season', bundle.season);
  one('energy', 'energy', bundle.energy);
  one('notify', 'notify.settings', notify.settings);
  one('deviceHealth', 'devices.health', devices.health);

  const list = (path: string, v: unknown): Record<string, unknown>[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) {
      issues.push({ path, code: 'type', params: { expected: 'array' } });
      return [];
    }
    counts[path] = v.length;
    return v.filter((x, i) => (isPlainObject(x) ? true : (issues.push({ path: `${path}.${i}`, code: 'type', params: { expected: 'object' } }), false))) as Record<string, unknown>[];
  };
  const many = <K extends ConfigCollectionName>(c: K, path: string, v: unknown) => {
    const map = g[c] as Map<Id, ConfigCollections[K]>;
    list(path, v).forEach((row, i) => {
      if (typeof row.id !== 'string' || !row.id) return issues.push({ path: `${path}.${i}.id`, code: 'required' });
      if (map.has(row.id)) return issues.push({ path: `${path}.${i}.id`, code: 'unique' });
      map.set(row.id, collectionFromRow(c, row));
    });
  };
  many('rooms', 'rooms', bundle.rooms);
  many('sensors', 'sensors', bundle.sensors);
  many('emitters', 'emitters', bundle.emitters);
  many('emitterDevices', 'emitterDevices', bundle.emitterDevices);
  many('profiles', 'profiles', bundle.profiles);
  many('activationRules', 'activationRules', bundle.activationRules);
  many('schedules', 'schedules', bundle.schedules);
  many('scheduleExceptions', 'scheduleExceptions', bundle.scheduleExceptions);
  many('sources', 'sources', bundle.sources);
  many('manifolds', 'manifolds', bundle.manifolds);
  many('circuits', 'circuits', bundle.circuits);
  many('pumps', 'pumps', bundle.pumps);
  many('triggers', 'triggers', bundle.triggers);
  many('rules', 'rules', bundle.rules);
  many('targets', 'notify.targets', notify.targets);
  many('watchRules', 'notify.watch', notify.watch);
  many('z2m', 'devices.z2m', devices.z2m);
  for (const c of g.circuits.values()) c.sourceIds = Array.isArray(c.sourceIds) ? [...new Set(c.sourceIds.filter((x) => typeof x === 'string'))] : [];
  // an export of 0.1.x has circuits without a mode: read from their pumps as on load
  const circuitRows = Array.isArray(bundle.circuits) ? (bundle.circuits as unknown[]).filter(isPlainObject) : [];
  legacyCircuitModes(g, circuitRows.filter((r) => typeof r.id === 'string' && !r.mode).map((r) => r.id as Id));

  for (const r of list('profileRooms', bundle.profileRooms) as unknown as ProfileRoomSetting[]) {
    g.profileRooms.set(prKey(r.profileId, r.roomId), { profileId: r.profileId, roomId: r.roomId, mode: r.mode, heatC: r.heatC ?? null, coolC: r.coolC ?? null, writtenAt: r.writtenAt ?? null });
  }
  for (const r of list('notify.routing', notify.routing) as unknown as RoutingCell[]) g.routing.set(routeKey(r.kind, r.targetId), { kind: r.kind, targetId: r.targetId, on: r.on });
  for (const e of list('notify.events', notify.events) as unknown as EventParams[]) g.eventParams.set(e.kind, { kind: e.kind, enabled: e.enabled ?? true, params: isPlainObject(e.params) ? (e.params as EventParams['params']) : {} });
  for (const p of list('notify.personal', notify.personal) as unknown as PersonalPrefs[]) {
    g.personal.set(p.userId, { userId: p.userId, targetIds: Array.isArray(p.targetIds) ? p.targetIds : [], levels: { critical: true, warning: p.levels?.warning ?? true, event: p.levels?.event ?? true, report: p.levels?.report ?? true }, quietHours: p.quietHours ?? true });
  }
  for (const m of list('devices.meta', devices.meta) as unknown as DeviceMeta[]) g.deviceMeta.set(m.key, { key: m.key, label: m.label ?? null, ignored: !!m.ignored, batteryType: m.batteryType ?? null });
  return { graph: g, counts, issues };
}
