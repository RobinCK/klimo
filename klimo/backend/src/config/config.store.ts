import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { AsyncLocalStorage } from 'async_hooks';
import { ApiException, notFound } from '../common/http';
import { ID_PREFIX, newId } from '../common/ids';
import { errorText } from '../common/logger';
import { lazyRef } from '../common/refs';
import { roundStep } from '../engine/core/util';
import { appVersion, env } from '../env';
import { Db } from '../db/database';
import { englishSeedNames, seedGraph, SEED_EN_KEY, SEED_HA_KEY } from '../db/seed';
import {
  adapterDefaults,
  autoInk,
  catalogueEntry,
  deepClone,
  defaultPersonalPrefs,
  defaultRouteOn,
  EVENT_CATALOGUE,
  frostCondition,
  isLockedCell,
  mergePatch,
  newSourceConfig,
  nextProfileLook,
  seedName,
  SOURCE_TEMPLATES,
} from '../shared/defaults';
import { slugify, uniqueSlug } from '../shared/translit';
import { SYSTEM_PROFILE_IDS } from '../shared/model';
import type {
  Actor,
  ApiErrorIssue,
  BusEvents,
  ChainEntry,
  ClockPort,
  ConfigCollectionName,
  ConfigCollections,
  ConfigEntityName,
  ConfigSingletonName,
  ConfigSingletons,
  DeviceMeta,
  DeviceMetaPatch,
  EngineConfig,
  EntityId,
  EventKind,
  EventParams,
  ExportBundle,
  HaPort,
  IBus,
  IConfigStore,
  Id,
  IEngine,
  IEvents,
  IHaInputs,
  ImportResult,
  Lang,
  Override,
  PersonalPrefs,
  ProfileRoomSetting,
  ProfileTargetRequest,
  RoutingCell,
  RuleEffect,
  SourceConfig,
  SourceTemplate,
  UsageRef,
} from '../shared/model';
import { BUS, CLOCK, ENGINE, EVENTS, HA_INPUTS, HA_PORT, OVERRIDE_STORE } from '../tokens';
import { buildExport, graphFromBundle } from './export-import.service';
import {
  cloneGraph,
  collectionBase,
  COLLECTION_ENTITY,
  COLLECTIONS,
  CONFIG_TABLES,
  diffRows,
  fromRow,
  loadGraph,
  OVERRIDE_TABLE,
  prKey,
  routeKey,
  SINGLETONS,
  snapshotRows,
  writeChanges,
  type ConfigGraph,
  type RowSnapshot,
  type TableChange,
  type TableDef,
} from './graph';
import { childrenOf, ownFieldsAfterChildEdit, propagateToChild, relinkAll, touchedLinkable } from './linked-sources';
import { conditionSites, conditionTriggers, dropRefs, ensureNodeIds, referencedEntities, usagesOf, walkCondition } from './refs';
import { normalizeDay, replaceProfileInPlan } from './schedule-ops';
import { OverrideStore } from './override.store';
import {
  graphIssues,
  notificationInvariantIssues,
  validateCollectionItem,
  validateDeviceMeta,
  validateEventParams,
  validatePersonal,
  validateProfileRoom,
  validateRoom,
  validateRoutingCell,
  validateSingleton,
  type Issues,
  type ValidationEnv,
} from './validators';

type Change = { entity: ConfigEntityName; id: Id | null; op: BusEvents['config.changed']['op'] };

/** One write in progress: a private copy of the graph that is validated and persisted as a whole. */
class Draft {
  actor: Actor | null = null;
  primary: { table: string; id: string } | null = null;
  op: 'reordered' | 'imported' | null = null;
  closed = false;
  constructor(
    readonly g: ConfigGraph,
    readonly overridesBefore: RowSnapshot,
  ) {}
}

const PREFIX: Partial<Record<ConfigCollectionName, string>> = {
  rooms: ID_PREFIX.room,
  sensors: ID_PREFIX.sensor,
  emitters: ID_PREFIX.emitter,
  emitterDevices: ID_PREFIX.device,
  profiles: ID_PREFIX.profile,
  activationRules: ID_PREFIX.activationRule,
  scheduleExceptions: ID_PREFIX.scheduleException,
  sources: ID_PREFIX.source,
  manifolds: ID_PREFIX.manifold,
  circuits: ID_PREFIX.circuit,
  pumps: ID_PREFIX.pump,
  triggers: ID_PREFIX.trigger,
  rules: ID_PREFIX.rule,
  targets: ID_PREFIX.target,
  watchRules: ID_PREFIX.watchRule,
  z2m: ID_PREFIX.z2m,
};

const SYSTEM_TRIGGER_EDITABLE = new Set(['enabled', 'name', 'icon', 'notifyOnActivate', 'order']);
const ROOM_SCOPE_ELECTRIC_FIRST: SourceConfig['kind'][] = ['electric_radiator', 'electric_floor', 'ir_panel'];

function hasOrder(v: unknown): v is { order: number } {
  return typeof v === 'object' && v !== null && 'order' in v;
}

function byOrder<T>(items: T[], c: ConfigCollectionName): T[] {
  if (c === 'rules') return items.sort((a, b) => (a as { priority: number }).priority - (b as { priority: number }).priority);
  return items.sort((a, b) => (hasOrder(a) && hasOrder(b) ? a.order - b.order : 0));
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

/**
 * The configuration of the house: loaded once into memory, read synchronously everywhere, written
 * only through this store. Every write is a draft → validators → one DB transaction → swap → revision
 * bump → `config.changed` on the bus + WS `config` → engine re-run. Cascades (deleting a room, a
 * source, a profile…) happen in the same draft, so they commit or fail together.
 */
@Injectable()
export class ConfigStore implements IConfigStore {
  private readonly log = new Logger('Config');
  private graph: ConfigGraph;
  private committed: RowSnapshot = new Map();
  private rev = 1;
  private cache: EngineConfig | null = null;
  private refsCache: { rev: number; ids: EntityId[] } | null = null;
  private readonly txAls = new AsyncLocalStorage<Draft>();
  private readonly columns = new Map<string, readonly string[]>();
  private readonly engine: () => IEngine | null;
  private readonly ha: () => HaPort | null;
  private readonly inputs: () => IHaInputs | null;

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(BUS) private readonly bus: IBus,
    @Inject(EVENTS) private readonly events: IEvents,
    @Inject(OVERRIDE_STORE) private readonly overrides: OverrideStore,
    @Optional() moduleRef?: ModuleRef,
  ) {
    this.engine = lazyRef<IEngine>(moduleRef, ENGINE);
    this.ha = lazyRef<HaPort>(moduleRef, HA_PORT);
    this.inputs = lazyRef<IHaInputs>(moduleRef, HA_INPUTS);
    this.overrides.onChange((changes) => {
      this.rev++;
      this.cache = null;
      for (const c of changes) this.announce([{ entity: 'override', id: c.override.subjectId, op: c.op }], null);
    });
  }

  /* ── boot ─────────────────────────────────────────────────────────────────────────────────── */

  /** Loads the graph; an empty database gets the first-boot seed. */
  async load(): Promise<void> {
    await this.db.exclusive(async () => {
      const { graph, missingSingletons } = await loadGraph(this.db.manager);
      const fresh = missingSingletons.includes('settings');
      this.graph = fresh ? seedGraph(this.clock.now()) : graph;
      // a fresh install writes the whole seed; otherwise only singletons without a row yet (new in this version)
      const base: RowSnapshot = fresh ? new Map() : snapshotRows(graph, (t) => this.cols(t));
      if (!fresh) for (const t of CONFIG_TABLES) if (t.singleton && missingSingletons.includes(t.singleton)) base.delete(t.name);
      // once per database: names 0.1.0 seeded in Ukrainian become English (the demo house keeps its language)
      const namesChecked = (await this.db.kvGet(SEED_EN_KEY)) !== null;
      const renamed = !fresh && !namesChecked && !env.simulate ? englishSeedNames(this.graph, this.clock.now()) : 0;
      const changes = diffRows(base, this.graph, (t) => this.cols(t));
      if (changes.length) await this.db.ds.transaction((em) => writeChanges(em, changes));
      if (fresh) await this.db.kvSet(SEED_HA_KEY, 'pending');
      if (!namesChecked) await this.db.kvSet(SEED_EN_KEY, 'done');
      if (renamed) this.log.log(`${renamed} seeded name(s) moved to English`);
      this.committed = snapshotRows(this.graph, (t) => this.cols(t));
      this.log.log(
        fresh
          ? 'first boot: default profiles, schedule, triggers and rules created'
          : `${this.graph.rooms.size} room(s), ${this.graph.sources.size} source(s), ${this.graph.profiles.size} profile(s)`,
      );
    });
  }

  /* ── reads ─────────────────────────────────────────────────────────────────────────────────── */

  /** The graph a read should see: the open transaction's draft, else the committed graph. */
  private view(): ConfigGraph {
    const d = this.txAls.getStore();
    return d && !d.closed ? d.g : this.graph;
  }

  revision(): number {
    return this.rev;
  }

  engineConfig(): EngineConfig {
    if (this.cache && this.cache.revision === this.rev) return this.cache;
    const g = this.graph;
    const group = <T extends { order: number }>(items: Iterable<T>, key: (x: T) => Id): Record<Id, T[]> => {
      const out: Record<Id, T[]> = {};
      for (const x of items) (out[key(x)] ??= []).push(deepClone(x));
      for (const list of Object.values(out)) list.sort((a, b) => a.order - b.order);
      return out;
    };
    const cfg: EngineConfig = {
      revision: this.rev,
      settings: deepClone(g.settings),
      safety: deepClone(g.safety),
      house: deepClone(g.house),
      rooms: this.sorted('rooms', g),
      sensorsByRoom: group(g.sensors.values(), (s) => s.roomId),
      emittersByRoom: group(g.emitters.values(), (e) => e.roomId),
      devicesByEmitter: group(g.emitterDevices.values(), (d) => d.emitterId),
      profiles: this.sorted('profiles', g),
      profileRooms: [...g.profileRooms.values()].map((r) => deepClone(r)),
      activationRules: this.sorted('activationRules', g),
      schedules: this.sorted('schedules', g),
      scheduleExceptions: this.sorted('scheduleExceptions', g),
      sources: this.sorted('sources', g),
      manifolds: this.sorted('manifolds', g),
      circuits: this.sorted('circuits', g),
      pumps: this.sorted('pumps', g),
      heat: deepClone(g.heat),
      cool: deepClone(g.cool),
      season: deepClone(g.season),
      energy: deepClone(g.energy),
      triggers: this.sorted('triggers', g),
      rules: this.sorted('rules', g),
      watchRules: this.sorted('watchRules', g),
      overrides: this.overrides.active(),
    };
    // the engine core is pure; a frozen config turns an accidental mutation into an immediate error
    this.cache = deepFreeze(cfg);
    return this.cache;
  }

  private sorted<K extends ConfigCollectionName>(c: K, g: ConfigGraph): ConfigCollections[K][] {
    return byOrder([...(g[c] as Map<Id, ConfigCollections[K]>).values()].map((x) => deepClone(x)), c);
  }

  list<K extends ConfigCollectionName>(c: K): ConfigCollections[K][] {
    return this.sorted(c, this.view());
  }

  get<K extends ConfigCollectionName>(c: K, id: Id): ConfigCollections[K] | undefined {
    const x = (this.view()[c] as Map<Id, ConfigCollections[K]>).get(id);
    return x ? deepClone(x) : undefined;
  }

  room(idOrSlug: string): ConfigCollections['rooms'] | undefined {
    const g = this.view();
    const r = g.rooms.get(idOrSlug) ?? [...g.rooms.values()].find((x) => x.slug === idOrSlug);
    return r ? deepClone(r) : undefined;
  }

  singleton<K extends ConfigSingletonName>(k: K): ConfigSingletons[K] {
    return deepClone(this.view()[k]);
  }

  profileRooms(): ProfileRoomSetting[] {
    return [...this.view().profileRooms.values()].map((r) => deepClone(r));
  }

  routing(): RoutingCell[] {
    const g = this.view();
    const targets = this.sorted('targets', g);
    const out: RoutingCell[] = [];
    for (const e of EVENT_CATALOGUE) {
      for (const t of targets) {
        const stored = g.routing.get(routeKey(e.kind, t.id));
        const on = isLockedCell(e.kind, t) || (stored ? stored.on : defaultRouteOn(e.kind, t));
        out.push({ kind: e.kind, targetId: t.id, on });
      }
    }
    return out;
  }

  eventParams(): EventParams[] {
    const g = this.view();
    return EVENT_CATALOGUE.map((e) => {
      const stored = g.eventParams.get(e.kind);
      return { kind: e.kind, enabled: stored?.enabled ?? true, params: { ...e.defaultParams, ...(stored?.params ?? {}) } };
    });
  }

  personalPrefs(userId: string): PersonalPrefs {
    const g = this.view();
    const stored = g.personal.get(userId);
    if (stored) return deepClone(stored);
    const own = [...g.targets.values()].filter((t) => t.ownerUserId === userId).map((t) => t.id);
    return defaultPersonalPrefs(userId, own);
  }

  deviceMeta(): DeviceMeta[] {
    return [...this.view().deviceMeta.values()].map((m) => deepClone(m));
  }

  usages(ref: Parameters<IConfigStore['usages']>[0]): UsageRef[] {
    return usagesOf(this.view(), ref);
  }

  referencedEntities(): EntityId[] {
    if (this.refsCache && this.refsCache.rev === this.rev && !this.txAls.getStore()) return [...this.refsCache.ids];
    const ids = referencedEntities(this.view());
    if (!this.txAls.getStore()) this.refsCache = { rev: this.rev, ids };
    return [...ids];
  }

  sourceTemplates(): SourceTemplate[] {
    return deepClone([...SOURCE_TEMPLATES]);
  }

  exportBundle(): ExportBundle {
    return buildExport(this.graph, appVersion(), this.clock.now());
  }

  /* ── writes ────────────────────────────────────────────────────────────────────────────────── */

  async create<K extends ConfigCollectionName>(c: K, value: Omit<ConfigCollections[K], 'id'> & { id?: Id }, actor: Actor): Promise<ConfigCollections[K]> {
    await this.precheckTemplates(value);
    return this.write(actor, (d) => this.doCreate(d, c, value as Record<string, unknown>));
  }

  async update<K extends ConfigCollectionName>(c: K, id: Id, patch: Partial<ConfigCollections[K]>, actor: Actor): Promise<ConfigCollections[K]> {
    await this.precheckTemplates(patch);
    return this.write(actor, (d) => this.doUpdate(d, c, id, patch as Record<string, unknown>));
  }

  async remove<K extends ConfigCollectionName>(c: K, id: Id, actor: Actor, opts: { force?: boolean; replaceWith?: Id } = {}): Promise<void> {
    await this.write(actor, (d) => this.doRemove(d, c, id, opts));
  }

  async reorder<K extends ConfigCollectionName>(c: K, ids: Id[], actor: Actor): Promise<void> {
    await this.write(actor, (d) => {
      d.op = 'reordered';
      const map = d.g[c] as unknown as Map<Id, Record<string, unknown>>;
      const listed = ids.filter((id) => map.has(id));
      const rest = byOrder([...map.values()], c).filter((x) => !listed.includes(x.id as Id)).map((x) => x.id as Id);
      [...listed, ...rest].forEach((id, i) => {
        const item = map.get(id);
        if (!item) return;
        if (c === 'rules') item.priority = (i + 1) * 10;
        else if ('order' in item) item.order = i;
      });
    });
  }

  async patchSingleton<K extends ConfigSingletonName>(k: K, patch: Partial<ConfigSingletons[K]>, actor: Actor): Promise<ConfigSingletons[K]> {
    if (k === 'energy') await this.precheckTemplates(patch);
    return this.write(actor, (d) => this.doPatchSingleton(d, k, patch, actor));
  }

  async setProfileRoom(profileId: Id, roomId: Id, req: ProfileTargetRequest, actor: Actor, opts: { writtenAt?: number } = {}): Promise<ProfileRoomSetting | null> {
    return this.write(actor, (d) => {
      if (!d.g.profiles.has(profileId)) throw notFound('Profile');
      if (!d.g.rooms.has(roomId)) throw notFound('Room');
      const key = prKey(profileId, roomId);
      d.primary = { table: 'profile_room', id: key };
      if (req.mode === 'inherit') {
        d.g.profileRooms.delete(key);
        return null;
      }
      const row: ProfileRoomSetting = {
        profileId,
        roomId,
        mode: req.mode,
        heatC: req.mode === 'own' ? req.heatC ?? null : null,
        coolC: req.mode === 'own' ? req.coolC ?? null : null,
        writtenAt: opts.writtenAt ?? null,
      };
      d.g.profileRooms.set(key, row);
      return deepClone(row);
    });
  }

  async setRoute(kind: EventKind, targetId: Id, on: boolean, actor: Actor): Promise<void> {
    await this.write(actor, (d) => {
      const t = d.g.targets.get(targetId);
      if (!t) throw notFound('Notification target');
      catalogueEntry(kind);
      if (!on && isLockedCell(kind, t)) throw new ApiException(409, 'locked_cell', 'Critical alerts always reach this target');
      const key = routeKey(kind, targetId);
      d.primary = { table: 'notify_routing', id: key };
      if (on === defaultRouteOn(kind, t)) d.g.routing.delete(key);
      else d.g.routing.set(key, { kind, targetId, on });
    });
  }

  async setEventParams(kind: EventKind, patch: Partial<Omit<EventParams, 'kind'>>, actor: Actor): Promise<EventParams> {
    return this.write(actor, (d) => {
      const entry = catalogueEntry(kind);
      const stored = d.g.eventParams.get(kind);
      const next: EventParams = {
        kind,
        enabled: patch.enabled ?? stored?.enabled ?? true,
        params: { ...entry.defaultParams, ...(stored?.params ?? {}), ...(patch.params ?? {}) },
      };
      d.primary = { table: 'event_params', id: kind };
      const isDefault = next.enabled && JSON.stringify(next.params) === JSON.stringify({ ...entry.defaultParams });
      if (isDefault) d.g.eventParams.delete(kind);
      else d.g.eventParams.set(kind, next);
      return deepClone(next);
    });
  }

  async setPersonalPrefs(userId: string, patch: Partial<Omit<PersonalPrefs, 'userId'>>): Promise<PersonalPrefs> {
    return this.write(null, (d) => {
      const cur = d.g.personal.get(userId) ?? this.defaultPrefs(d.g, userId);
      const next = mergePatch(cur, patch) as PersonalPrefs;
      next.userId = userId;
      next.levels = { ...next.levels, critical: true };
      d.primary = { table: 'personal_prefs', id: userId };
      d.g.personal.set(userId, next);
      return deepClone(next);
    });
  }

  async setDeviceMeta(key: string, patch: DeviceMetaPatch, actor: Actor): Promise<DeviceMeta> {
    return this.write(actor, (d) => {
      const cur = d.g.deviceMeta.get(key) ?? { key, label: null, ignored: false, batteryType: null };
      const next: DeviceMeta = { ...cur, ...patch, key };
      d.primary = { table: 'device_meta', id: key };
      if (next.label === null && !next.ignored && next.batteryType === null) d.g.deviceMeta.delete(key);
      else d.g.deviceMeta.set(key, next);
      return deepClone(next);
    });
  }

  async transaction<T>(fn: (tx: IConfigStore) => Promise<T>): Promise<T> {
    const active = this.txAls.getStore();
    if (active && !active.closed) return fn(this);
    return this.write(null, (d) => this.txAls.run(d, () => fn(this)));
  }

  async importBundle(bundle: ExportBundle, opts: { dryRun: boolean }, actor: Actor): Promise<ImportResult> {
    const parsed = graphFromBundle(bundle);
    const counts = parsed.counts;
    if (parsed.issues.length) return { ok: false, dryRun: opts.dryRun, counts, issues: parsed.issues };
    const g = parsed.graph;
    const issues = this.validateAll(g);
    if (issues.length || opts.dryRun) return { ok: issues.length === 0, dryRun: opts.dryRun, counts, issues };
    await this.write(actor, (d) => {
      d.op = 'imported';
      for (const k of SINGLETONS) (d.g as unknown as Record<string, unknown>)[k] = g[k];
      for (const c of COLLECTIONS) (d.g as unknown as Record<string, unknown>)[c] = g[c];
      d.g.profileRooms = g.profileRooms;
      d.g.routing = g.routing;
      d.g.eventParams = g.eventParams;
      d.g.personal = g.personal;
      d.g.deviceMeta = g.deviceMeta;
      // overrides of rooms, sources or profiles that no longer exist cannot apply any more
      for (const [id, o] of d.g.overrides) {
        const subjectGone = (o.scope === 'room' && !g.rooms.has(o.subjectId)) || (o.scope === 'source' && !g.sources.has(o.subjectId));
        const profileGone = (o.value.kind === 'room_profile' || o.value.kind === 'house_profile') && !g.profiles.has(o.value.profileId);
        if (subjectGone || profileGone) d.g.overrides.delete(id);
      }
    }, { skipValidation: true });
    return { ok: true, dryRun: false, counts, issues: [] };
  }

  /** Every rule over a whole graph (import, tests). */
  validateAll(g: ConfigGraph): ApiErrorIssue[] {
    const issues: ApiErrorIssue[] = [];
    const prefixed = (prefix: string, list: Issues) => list.map((i) => ({ ...i, path: i.path ? `${prefix}.${i.path}` : prefix }));
    for (const k of SINGLETONS) issues.push(...prefixed(k, validateSingleton(k, g)));
    for (const c of COLLECTIONS) {
      for (const [id, item] of (g[c] as Map<Id, unknown>).entries()) issues.push(...prefixed(`${c}.${id}`, validateCollectionItem(c, item, g)));
    }
    for (const [key, r] of g.profileRooms) issues.push(...prefixed(`profileRooms.${key}`, validateProfileRoom(r, g)));
    for (const [key, r] of g.routing) issues.push(...prefixed(`routing.${key}`, validateRoutingCell(r, g)));
    for (const [key, e] of g.eventParams) issues.push(...prefixed(`events.${key}`, validateEventParams(e)));
    for (const [key, p] of g.personal) issues.push(...prefixed(`personal.${key}`, validatePersonal(p, g)));
    for (const [key, m] of g.deviceMeta) issues.push(...prefixed(`deviceMeta.${key}`, validateDeviceMeta(m)));
    issues.push(...notificationInvariantIssues(g), ...graphIssues(g));
    return issues;
  }

  /* ── the write pipeline ────────────────────────────────────────────────────────────────────── */

  private cols(t: TableDef): readonly string[] {
    let c = this.columns.get(t.name);
    if (!c) {
      c = this.db.ds.getMetadata(t.entity).columns.map((col) => col.propertyName);
      this.columns.set(t.name, c);
    }
    return c;
  }

  private async write<T>(actor: Actor | null, mutate: (d: Draft) => T | Promise<T>, opts: { skipValidation?: boolean } = {}): Promise<T> {
    const active = this.txAls.getStore();
    if (active && !active.closed) {
      active.actor ??= actor;
      return mutate(active);
    }
    const outcome = await this.db.exclusive(async () => {
      const g = cloneGraph(this.graph);
      g.overrides = this.overrides.snapshot();
      const d = new Draft(g, snapshotRows(g, (t) => this.cols(t), [OVERRIDE_TABLE]));
      d.actor = actor;
      try {
        const value = await mutate(d);
        const changes = diffRows(this.committed, d.g, (t) => this.cols(t));
        const overrideChanges = diffRows(d.overridesBefore, d.g, (t) => this.cols(t), [OVERRIDE_TABLE]);
        if (!changes.length && !overrideChanges.length) return { value, events: [] as Change[], actor: d.actor };
        if (!opts.skipValidation) this.validateDraft(d, changes);
        await this.db.ds.transaction((em) => writeChanges(em, [...changes, ...overrideChanges]));

        this.graph = { ...d.g, overrides: new Map() };
        this.committed = snapshotRows(this.graph, (t) => this.cols(t));
        this.overrides.applyCommitted(
          overrideChanges.filter((c) => c.op !== 'deleted').map((c) => d.g.overrides.get(c.key)).filter((o): o is Override => !!o),
          overrideChanges.filter((c) => c.op === 'deleted').map((c) => c.key),
        );
        this.rev++;
        this.cache = null;
        return { value, events: this.changeEvents(d, [...changes, ...overrideChanges]), actor: d.actor };
      } finally {
        d.closed = true;
      }
    });
    this.announce(outcome.events, outcome.actor);
    return outcome.value;
  }

  private changeEvents(d: Draft, changes: TableChange[]): Change[] {
    if (d.op === 'imported') return [{ entity: 'settings', id: null, op: 'imported' }];
    const seen = new Set<string>();
    const out: Change[] = [];
    for (const ch of changes) {
      const id = ch.table.idOf(ch.row);
      const op: Change['op'] = d.op === 'reordered' && ch.op === 'updated' ? 'reordered' : ch.table.singleton ? 'updated' : ch.op;
      const ev: Change = op === 'reordered' ? { entity: ch.table.event, id: null, op } : { entity: ch.table.event, id, op };
      const key = `${ev.entity}|${ev.id}|${ev.op}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(ev);
    }
    return out;
  }

  private announce(changes: Change[], actor: Actor | null): void {
    if (!changes.length) return;
    for (const c of changes) {
      this.bus.emit('config.changed', { ...c, actor, revision: this.rev });
      this.events.send({ type: 'config', payload: c });
    }
    try {
      this.engine()?.requestRun('config');
    } catch (e) {
      this.log.warn(`engine re-run request failed: ${errorText(e)}`);
    }
  }

  private validationEnv(): ValidationEnv {
    const ha = this.ha();
    if (!ha?.connected) return {};
    return { entityExists: (id) => (ha.getState(id) ? true : ha.registries().entities.some((e) => e.entity_id === id)) };
  }

  /** Validates every object the write touched; paths of the edited object stay relative. */
  private validateDraft(d: Draft, changes: TableChange[]): void {
    const g = d.g;
    const env = this.validationEnv();
    const issues: ApiErrorIssue[] = [];
    const add = (table: string, id: string, list: Issues) => {
      const isPrimary = d.primary && d.primary.table === table && d.primary.id === id;
      for (const i of list) issues.push(isPrimary ? i : { ...i, path: i.path ? `${table}.${id}.${i.path}` : `${table}.${id}` });
    };
    const touchedRooms = new Set<Id>();
    let notifyTouched = false;
    for (const ch of changes) {
      if (ch.op === 'deleted') {
        if (ch.table.name === 'emitter_device' || ch.table.name === 'room_sensor') touchedRooms.add(ch.row.roomId as Id);
        if (ch.table.name === 'notify_target') notifyTouched = true;
        continue;
      }
      const t = ch.table;
      if (t.collection) {
        const item = (g[t.collection] as Map<Id, unknown>).get(ch.key);
        // HA is asked about entities only for the object being edited: a cascade or an unrelated edit
        // must not fail because some other entity is briefly missing while an integration reloads
        const own = !!d.primary && d.primary.table === t.collection && d.primary.id === ch.key;
        if (item) add(t.collection, ch.key, validateCollectionItem(t.collection, item, g, own ? env : {}));
        if (t.collection === 'emitterDevices' || t.collection === 'sensors') touchedRooms.add((item as { roomId: Id }).roomId);
        if (t.collection === 'rooms') touchedRooms.delete(ch.key);
        if (t.collection === 'targets') notifyTouched = true;
      } else if (t.singleton) {
        add(t.singleton, 'main', validateSingleton(t.singleton, g, d.primary?.table === t.singleton ? env : {}));
        if (t.singleton === 'notify') notifyTouched = true;
        if (t.singleton === 'settings') {
          // room limits must stay inside the house limits
          for (const r of g.rooms.values()) if (r.limits) touchedRooms.add(r.id);
        }
      } else if (t.name === 'profile_room') {
        const r = g.profileRooms.get(ch.key);
        if (r) add('profileRooms', ch.key, validateProfileRoom(r, g));
      } else if (t.name === 'notify_routing') {
        notifyTouched = true;
        const r = g.routing.get(ch.key);
        if (r) add('routing', ch.key, validateRoutingCell(r, g));
      } else if (t.name === 'event_params') {
        const e = g.eventParams.get(ch.key);
        if (e) add('events', ch.key, validateEventParams(e));
      } else if (t.name === 'personal_prefs') {
        const p = g.personal.get(ch.key);
        if (p) add('personal', ch.key, validatePersonal(p, g));
      } else if (t.name === 'device_meta') {
        const m = g.deviceMeta.get(ch.key);
        if (m) add('deviceMeta', ch.key, validateDeviceMeta(m));
      }
    }
    for (const roomId of touchedRooms) {
      const r = g.rooms.get(roomId);
      if (r) add('rooms', roomId, validateRoom(r, g));
    }
    issues.push(...graphIssues(g));

    if (issues.some((i) => i.code === 'bound_elsewhere')) {
      throw new ApiException(409, 'conflict', 'The entity is already used by another room in the same role', issues);
    }
    if (issues.length) throw new ApiException(400, 'validation', 'Validation failed', issues);
    if (notifyTouched) {
      const inv = notificationInvariantIssues(g);
      if (inv.some((i) => i.code === 'locked_cell')) throw new ApiException(409, 'locked_cell', 'Critical alerts always reach the primary target', inv);
      if (inv.length) throw new ApiException(409, 'critical_invariant', 'Critical alerts must keep reaching exactly one primary target', inv);
    }
  }

  /** Template conditions must render in HA; checked before the write lock (HA can take seconds). */
  private async precheckTemplates(value: unknown): Promise<void> {
    if (this.txAls.getStore()) return;
    const inputs = this.inputs();
    if (!inputs || !this.ha()?.connected || !value || typeof value !== 'object') return;
    const templates: { path: string; template: string }[] = [];
    const scan = (node: unknown, path: string) => {
      if (!node || typeof node !== 'object') return;
      walkCondition(node as Parameters<typeof walkCondition>[0], (n) => {
        if (n.op === 'template' && typeof n.template === 'string') templates.push({ path, template: n.template });
      });
    };
    const v = value as Record<string, unknown>;
    for (const key of ['condition', 'when', 'stopWhen', 'activeWhen']) scan(v[key], key);
    const items = (v.conditions as { items?: { node?: unknown }[] } | undefined)?.items;
    items?.forEach((item, i) => scan(item?.node, `conditions.items.${i}.node`));
    const issues: ApiErrorIssue[] = [];
    for (const t of templates) {
      try {
        const r = await inputs.renderTemplate(t.template);
        if (r.error) issues.push({ path: t.path, code: 'template', params: { error: r.error.slice(0, 200) } });
      } catch {
        // HA went away mid-check: templates are re-checked on the next edit
      }
    }
    if (issues.length) throw new ApiException(400, 'validation', 'Template does not render', issues);
  }

  /* ── create ────────────────────────────────────────────────────────────────────────────────── */

  private newIdFor(c: ConfigCollectionName, v: Record<string, unknown>): Id {
    if (c === 'schedules') return v.scope === 'house' ? 'house' : `room_${String(v.roomId)}`;
    if (c === 'watchRules' && v.origin === 'auto') return `auto:${String(v.entityId)}`;
    return newId(PREFIX[c] ?? 'x_');
  }

  private nextOrder(map: Map<Id, unknown>): number {
    let max = -1;
    for (const x of map.values()) if (hasOrder(x)) max = Math.max(max, x.order);
    return max + 1;
  }

  private doCreate<K extends ConfigCollectionName>(d: Draft, c: K, value: Record<string, unknown>): ConfigCollections[K] {
    const map = d.g[c] as Map<Id, ConfigCollections[K]>;
    const now = this.clock.now();
    const id = (typeof value.id === 'string' && value.id) || this.newIdFor(c, value);
    if (map.has(id)) throw new ApiException(409, 'conflict', `${c} ${id} already exists`);
    const base =
      c === 'sources'
        ? (newSourceConfig((value.kind as SourceConfig['kind']) ?? 'custom', {
            id,
            name: String(value.name ?? ''),
            now,
            scope: value.scope as SourceConfig['scope'] | undefined,
            roomId: value.roomId as Id | null | undefined,
            adapterType: (value.adapter as SourceConfig['adapter'] | undefined)?.type,
          }) as unknown as ConfigCollections[K])
        : collectionBase(c, value);
    const item = fromRow({ ...value, id }, base) as unknown as Record<string, unknown>;
    if (c === 'profiles') {
      // «Новий профіль» takes the next free palette colour; a chosen colour gets a readable ink
      if (value.color === undefined) {
        const look = nextProfileLook([...d.g.profiles.values()]);
        item.color = look.color;
        item.ink = look.ink;
        if (value.icon === undefined) item.icon = look.icon;
      } else if (value.ink === undefined) item.ink = autoInk(String(value.color));
    }
    if ('createdAt' in item) item.createdAt = now;
    if ('updatedAt' in item) item.updatedAt = now;
    if ('order' in item && typeof value.order !== 'number') item.order = this.nextOrder(map);
    d.primary = { table: c, id };
    this.prepare(d, c, item, null);
    map.set(id, item as unknown as ConfigCollections[K]);
    this.afterWrite(d, c, id, null);
    return deepClone(map.get(id) as ConfigCollections[K]);
  }

  /** Normalisation shared by create and update (ids of condition nodes, slugs, merged day plans…). */
  private prepare(d: Draft, c: ConfigCollectionName, item: Record<string, unknown>, before: Record<string, unknown> | null): void {
    const g = d.g;
    switch (c) {
      case 'rooms': {
        item.name = String(item.name ?? '').trim();
        if (!item.slug) item.slug = uniqueSlug(slugify(String(item.name)), (s) => [...g.rooms.values()].some((r) => r.slug === s && r.id !== item.id));
        break;
      }
      case 'schedules':
        item.days = (item.days as ConfigCollections['schedules']['days']).map((day) => normalizeDay(day));
        break;
      case 'scheduleExceptions':
        if (Array.isArray(item.plan)) item.plan = normalizeDay(item.plan);
        break;
      case 'triggers':
        item.condition = ensureNodeIds(item.condition as ConfigCollections['triggers']['condition']);
        break;
      case 'rules':
        item.when = ensureNodeIds(item.when as ConfigCollections['rules']['when']);
        if (item.stopWhen) item.stopWhen = ensureNodeIds(item.stopWhen as ConfigCollections['rules']['when']);
        break;
      case 'sources': {
        const s = item as unknown as SourceConfig;
        s.conditions.items = s.conditions.items.map((it) => ({ ...it, id: it.id || newId(ID_PREFIX.conditionItem), node: ensureNodeIds(it.node) }));
        if (s.scope === 'central') s.roomId = null;
        break;
      }
      case 'watchRules': {
        const cond = item.condition as ConfigCollections['watchRules']['condition'];
        if (cond?.type === 'custom') item.condition = { type: 'custom', node: ensureNodeIds(cond.node) };
        break;
      }
      case 'circuits':
        item.sourceIds = [...new Set(item.sourceIds as Id[])];
        break;
      default:
        break;
    }
  }

  /** Consequences of an object changing: linked sources, chains, shed order, notification targets. */
  private afterWrite(d: Draft, c: ConfigCollectionName, id: Id, before: Record<string, unknown> | null): void {
    const g = d.g;
    if (c === 'sources') {
      const s = g.sources.get(id);
      if (!s) return;
      if (!before) {
        if (s.linkedTo) {
          const t = g.sources.get(s.linkedTo);
          if (t) g.sources.set(id, relinkAll(t, s));
        }
        this.placeInChains(d, s);
        this.recomputeShedOrder(g);
      } else {
        const prev = before as unknown as SourceConfig;
        for (const child of childrenOf(g.sources.values(), id)) g.sources.set(child.id, propagateToChild(prev, s, child));
        if (prev.capabilities.heat !== s.capabilities.heat || prev.capabilities.cool !== s.capabilities.cool || prev.scope !== s.scope) {
          this.dropFromChains(g, id);
          this.placeInChains(d, s);
        }
        if (prev.energy.countsInBlackoutBudget !== s.energy.countsInBlackoutBudget || prev.kind !== s.kind) this.recomputeShedOrder(g);
      }
    }
    if (c === 'targets') this.normalizeTargets(g, id);
  }

  /** New sources join the chains: heat pumps first, then boilers, then others; room ACs as one group. */
  private placeInChains(d: Draft, s: SourceConfig): void {
    const g = d.g;
    const lang = g.settings.notificationLanguage;
    if (s.capabilities.heat && s.scope === 'central') {
      const rank = (k: SourceConfig['kind']) => (k === 'heat_pump' ? 0 : k === 'gas_boiler' || k === 'electric_boiler' ? 1 : 2);
      const entry: ChainEntry = { id: newId(ID_PREFIX.chainEntry), sourceIds: [s.id], label: null, enabled: true };
      const chain = g.heat.chain;
      let at = chain.length;
      for (let i = 0; i < chain.length; i++) {
        const lead = g.sources.get(chain[i].sourceIds[0]);
        if (lead && rank(lead.kind) > rank(s.kind)) {
          at = i;
          break;
        }
      }
      chain.splice(at, 0, entry);
    }
    if (s.capabilities.cool) {
      const chain = g.cool.chain;
      if (s.scope === 'room' && s.kind === 'ac') {
        const group = chain.find((e) => e.sourceIds.length && e.sourceIds.every((x) => g.sources.get(x)?.kind === 'ac' && g.sources.get(x)?.scope === 'room'));
        if (group) group.sourceIds.push(s.id);
        else chain.unshift({ id: newId(ID_PREFIX.chainEntry), sourceIds: [s.id], label: seedName('acGroup', lang as Lang), enabled: true });
      } else if (s.scope === 'central') {
        chain.push({ id: newId(ID_PREFIX.chainEntry), sourceIds: [s.id], label: null, enabled: true });
      }
    }
  }

  private dropFromChains(g: ConfigGraph, sourceId: Id): void {
    for (const chain of [g.heat.chain, g.cool.chain]) {
      for (const e of chain) e.sourceIds = e.sourceIds.filter((x) => x !== sourceId);
      const kept = chain.filter((e) => e.sourceIds.length);
      chain.splice(0, chain.length, ...kept);
    }
  }

  /** Default blackout shed order: room electric heaters → ACs → heat pumps → electric boilers. */
  private recomputeShedOrder(g: ConfigGraph): void {
    if (g.energy.shedOrderCustom) return;
    const rank = (s: SourceConfig) =>
      s.scope === 'room' && ROOM_SCOPE_ELECTRIC_FIRST.includes(s.kind) ? 0 : s.kind === 'ac' ? 1 : s.kind === 'heat_pump' ? 2 : s.kind === 'electric_boiler' ? 3 : 4;
    g.energy.shedOrder = [...g.sources.values()]
      .filter((s) => s.energy.carrier === 'electric' && s.energy.countsInBlackoutBudget)
      .sort((a, b) => rank(a) - rank(b) || a.order - b.order)
      .map((s) => s.id);
    // gas boilers keep heating through a blackout while the battery lasts
    const gas = [...g.sources.values()].filter((s) => s.kind === 'gas_boiler').map((s) => s.id);
    g.energy.exempt.sourceIds = [...new Set([...g.energy.exempt.sourceIds.filter((id) => g.sources.has(id)), ...gas])];
  }

  /**
   * Exactly one primary target (a phone when any phone exists, else a Telegram chat) and at most one
   * escalation target. `changedId` wins when it was just made primary/escalation.
   */
  private normalizeTargets(g: ConfigGraph, changedId: Id | null): void {
    const targets = [...g.targets.values()].sort((a, b) => a.order - b.order);
    const changed = changedId ? g.targets.get(changedId) : undefined;
    const eligible = (t: (typeof targets)[number]) => t.channel === 'ha_mobile' || t.channel === 'telegram';
    for (const t of targets) if (t.isPrimary && !eligible(t)) t.isPrimary = false;
    const phones = targets.filter((t) => t.channel === 'ha_mobile');
    const pool = phones.length ? phones : targets.filter((t) => t.channel === 'telegram');
    let primary = changed?.isPrimary && pool.includes(changed) ? changed : pool.find((t) => t.isPrimary);
    if (!primary && pool.length) primary = pool[0];
    for (const t of targets) t.isPrimary = t === primary;

    const esc = changed?.isEscalation ? changed : targets.find((t) => t.isEscalation);
    for (const t of targets) t.isEscalation = t === esc && t.channel !== 'ha_event';
    g.notify.escalation.targetId = esc && esc.isEscalation ? esc.id : g.notify.escalation.targetId && g.targets.get(g.notify.escalation.targetId)?.isEscalation ? g.notify.escalation.targetId : null;
  }

  /* ── update ────────────────────────────────────────────────────────────────────────────────── */

  private doUpdate<K extends ConfigCollectionName>(d: Draft, c: K, id: Id, patch: Record<string, unknown>): ConfigCollections[K] {
    const map = d.g[c] as Map<Id, ConfigCollections[K]>;
    const current = map.get(id);
    if (!current) throw notFound(COLLECTION_ENTITY[c]);
    const before = deepClone(current) as unknown as Record<string, unknown>;
    const { id: _ignored, ...rest } = patch;
    let next = mergePatch(before, rest) as Record<string, unknown>;

    if (c === 'triggers' && (before as unknown as ConfigCollections['triggers']).system) {
      const locked = Object.keys(rest).filter((k) => !SYSTEM_TRIGGER_EDITABLE.has(k) && JSON.stringify(rest[k]) !== JSON.stringify(before[k]));
      if (locked.length) throw new ApiException(400, 'validation', 'A system trigger is edited through the setting it is bound to', locked.map((k) => ({ path: k, code: 'locked' })));
    }
    if (c === 'sources') next = this.sourcePatch(d, before as unknown as SourceConfig, next as unknown as SourceConfig, rest) as unknown as Record<string, unknown>;
    if (c === 'profiles') this.profilePatch(d.g, next, rest);
    if (c === 'schedules') {
      // a schedule cannot change what it belongs to
      next.scope = before.scope;
      next.roomId = before.roomId;
    }
    if ('updatedAt' in next) next.updatedAt = this.clock.now();
    d.primary = { table: c, id };
    this.prepare(d, c, next, before);
    map.set(id, next as unknown as ConfigCollections[K]);
    this.afterWrite(d, c, id, before);
    return deepClone(map.get(id) as ConfigCollections[K]);
  }

  private sourcePatch(d: Draft, before: SourceConfig, next: SourceConfig, patch: Record<string, unknown>): SourceConfig {
    const adapterPatch = patch.adapter as Partial<SourceConfig['adapter']> | undefined;
    if (adapterPatch?.type && adapterPatch.type !== before.adapter.type) {
      // another adapter type means other bindings: start that adapter empty
      next.adapter = mergePatch(adapterDefaults(adapterPatch.type), adapterPatch) as SourceConfig['adapter'];
      if (patch.enabled === undefined) next.enabled = false;
    }
    if (next.linkedTo) {
      const t = d.g.sources.get(next.linkedTo);
      if (t) {
        if (Array.isArray(patch.ownFields) && patch.ownFields.length === 0) return relinkAll(t, next);
        if (patch.linkedTo !== undefined && patch.linkedTo !== before.linkedTo) return relinkAll(t, next);
        next.ownFields = ownFieldsAfterChildEdit(next, t, touchedLinkable(patch));
      }
    } else {
      next.ownFields = [];
    }
    return next;
  }

  private profilePatch(g: ConfigGraph, next: Record<string, unknown>, patch: Record<string, unknown>): void {
    // a new colour gets a readable ink unless the ink was chosen too
    if (patch.color !== undefined && patch.ink === undefined && typeof next.color === 'string') next.ink = autoInk(next.color);
    // keep cooling at least the auto gap above heating: the edited bound pushes the other one
    const gap = g.cool.autoMinGapC;
    const heat = next.heatC as number;
    const cool = next.coolC as number;
    if (typeof heat === 'number' && typeof cool === 'number' && cool - heat < gap) {
      const step = g.settings.targetLimits.stepC;
      if (patch.heatC !== undefined && patch.coolC === undefined) next.coolC = Math.min(32, roundStep(heat + gap, step, 'ceil'));
      else if (patch.coolC !== undefined && patch.heatC === undefined) next.heatC = Math.max(5, roundStep(cool - gap, step, 'floor'));
    }
  }

  /* ── remove ────────────────────────────────────────────────────────────────────────────────── */

  private doRemove(d: Draft, c: ConfigCollectionName, id: Id, opts: { force?: boolean; replaceWith?: Id }): void {
    const g = d.g;
    const map = g[c] as Map<Id, unknown>;
    if (!map.has(id)) throw notFound(COLLECTION_ENTITY[c]);
    d.primary = { table: c, id };
    switch (c) {
      case 'rooms':
        return this.removeRoom(g, id);
      case 'sources':
        return this.removeSource(g, id, !!opts.force);
      case 'triggers':
        return this.removeTrigger(g, id, !!opts.force);
      case 'profiles':
        return this.removeProfile(g, id, opts.replaceWith);
      case 'circuits':
        return this.removeCircuit(g, id, !!opts.force);
      case 'emitters':
        g.emitters.delete(id);
        for (const [devId, dev] of g.emitterDevices) if (dev.emitterId === id) g.emitterDevices.delete(devId);
        return;
      case 'sensors': {
        const s = g.sensors.get(id);
        g.sensors.delete(id);
        const room = s ? g.rooms.get(s.roomId) : undefined;
        // «Основний» needs a sensor; with none left the room falls back to the median of what remains
        if (room && room.temperature.method === 'primary' && ![...g.sensors.values()].some((x) => x.roomId === room.id && x.role === 'temperature')) {
          room.temperature.method = 'median';
        }
        return;
      }
      case 'manifolds':
        g.manifolds.delete(id);
        for (const circuit of g.circuits.values()) if (circuit.manifoldId === id) circuit.manifoldId = null;
        for (const [pid, p] of g.pumps) if (p.manifoldId === id) g.pumps.delete(pid);
        return;
      case 'pumps':
        g.pumps.delete(id);
        for (const [wid, w] of g.watchRules) if (w.ref?.pumpId === id) g.watchRules.delete(wid);
        return;
      case 'schedules': {
        const s = g.schedules.get(id);
        if (s?.scope === 'house') throw new ApiException(409, 'conflict', 'The house schedule cannot be deleted');
        g.schedules.delete(id);
        for (const [xid, x] of g.scheduleExceptions) if (x.scheduleId === id) g.scheduleExceptions.delete(xid);
        return;
      }
      case 'targets':
        return this.removeTarget(g, id);
      case 'z2m':
        g.z2m.delete(id);
        return;
      default:
        map.delete(id);
    }
  }

  private removeRoom(g: ConfigGraph, roomId: Id): void {
    const roomSources = [...g.sources.values()].filter((s) => s.scope === 'room' && s.roomId === roomId).map((s) => s.id);
    for (const sid of roomSources) this.removeSource(g, sid, true);
    const entities = new Set<EntityId>();
    for (const [id, s] of g.sensors) if (s.roomId === roomId) { entities.add(s.entityId); g.sensors.delete(id); }
    for (const [id, e] of g.emitters) if (e.roomId === roomId) g.emitters.delete(id);
    for (const [id, dev] of g.emitterDevices) if (dev.roomId === roomId) { entities.add(dev.entityId); g.emitterDevices.delete(id); }
    for (const [key, r] of g.profileRooms) if (r.roomId === roomId) g.profileRooms.delete(key);
    for (const [id, s] of g.schedules) {
      if (s.roomId !== roomId) continue;
      g.schedules.delete(id);
      for (const [xid, x] of g.scheduleExceptions) if (x.scheduleId === id) g.scheduleExceptions.delete(xid);
    }
    for (const [id, o] of g.overrides) if (o.scope === 'room' && o.subjectId === roomId) g.overrides.delete(id);
    // auto watch rules of the room's own sensors and devices go with it
    for (const [id, w] of g.watchRules) if (w.ref?.roomId === roomId || (w.origin === 'auto' && entities.has(w.entityId))) g.watchRules.delete(id);
    for (const site of conditionSites(g)) site.set(dropRefs(site.node, { roomId }));
    for (const r of g.rules.values()) {
      r.effects = r.effects.flatMap((e) => {
        if (e.type !== 'target_offset' || !Array.isArray(e.roomIds) || !e.roomIds.includes(roomId)) return [e];
        const roomIds = e.roomIds.filter((x) => x !== roomId);
        return roomIds.length ? [{ ...e, roomIds }] : [];
      });
    }
    g.rooms.delete(roomId);
  }

  private removeSource(g: ConfigGraph, sourceId: Id, force: boolean): void {
    if (!force) {
      const usages = usagesOf(g, { type: 'source', id: sourceId });
      if (usages.length) throw new ApiException(409, 'in_use', 'The source is still in use', undefined, usages);
    }
    this.dropFromChains(g, sourceId);
    for (const r of g.rules.values()) {
      r.effects = r.effects.flatMap((e): RuleEffect[] => {
        if (e.type === 'only_sources' || e.type === 'forbid_sources' || e.type === 'allow_sources' || e.type === 'preheat_to_next_slot') {
          return [{ ...e, sourceIds: e.sourceIds.filter((x) => x !== sourceId) }];
        }
        return e.type === 'source_requires' && e.sourceId === sourceId ? [] : [e];
      });
    }
    for (const site of conditionSites(g)) site.set(dropRefs(site.node, { sourceId }));
    g.energy.shedOrder = g.energy.shedOrder.filter((x) => x !== sourceId);
    g.energy.exempt.sourceIds = g.energy.exempt.sourceIds.filter((x) => x !== sourceId);
    for (const [id, e] of g.emitters) if (e.sourceId === sourceId) g.emitters.delete(id);
    for (const c of g.circuits.values()) c.sourceIds = c.sourceIds.filter((x) => x !== sourceId);
    // children keep the values they copied and simply stop following
    for (const s of g.sources.values()) if (s.linkedTo === sourceId) { s.linkedTo = null; s.ownFields = []; }
    for (const [id, o] of g.overrides) if (o.scope === 'source' && o.subjectId === sourceId) g.overrides.delete(id);
    for (const [id, w] of g.watchRules) if (w.ref?.sourceId === sourceId) g.watchRules.delete(id);
    g.sources.delete(sourceId);
    this.recomputeShedOrder(g);
  }

  private removeTrigger(g: ConfigGraph, triggerId: Id, force: boolean): void {
    const t = g.triggers.get(triggerId);
    if (t?.system) throw new ApiException(409, 'conflict', 'A system trigger cannot be deleted');
    if (!force) {
      const usages = usagesOf(g, { type: 'trigger', id: triggerId });
      if (usages.length) throw new ApiException(409, 'in_use', 'The trigger is still in use', undefined, usages);
    }
    g.triggers.delete(triggerId);
    for (const site of conditionSites(g)) if (conditionTriggers(site.node).includes(triggerId)) site.set(dropRefs(site.node, { triggerId }));
    for (const r of g.rules.values()) r.effects = r.effects.filter((e) => !(e.type === 'source_requires' && e.triggerId === triggerId));
    for (const [id, w] of g.watchRules) if (w.ref?.triggerId === triggerId) g.watchRules.delete(id);
  }

  private removeProfile(g: ConfigGraph, profileId: Id, replaceWith: Id | undefined): void {
    if ((SYSTEM_PROFILE_IDS as readonly string[]).includes(profileId)) throw new ApiException(409, 'conflict', 'A system profile cannot be deleted');
    if (!replaceWith) throw new ApiException(400, 'validation', 'Choose a profile to replace it with', [{ path: 'replaceWith', code: 'required' }]);
    if (replaceWith === profileId || !g.profiles.has(replaceWith)) {
      throw new ApiException(400, 'validation', 'Unknown replacement profile', [{ path: 'replaceWith', code: 'not_found' }]);
    }
    for (const s of g.schedules.values()) s.days = s.days.map((day) => replaceProfileInPlan(day, profileId, replaceWith));
    for (const x of g.scheduleExceptions.values()) if (Array.isArray(x.plan)) x.plan = replaceProfileInPlan(x.plan, profileId, replaceWith);
    for (const a of g.activationRules.values()) {
      if (a.profileId === profileId) a.profileId = replaceWith;
      if (a.config.type === 'vacation' && a.config.returnProfileId === profileId) a.config.returnProfileId = replaceWith;
    }
    if (g.settings.defaultProfileId === profileId) g.settings.defaultProfileId = replaceWith;
    if (g.settings.ecoProfileId === profileId) g.settings.ecoProfileId = replaceWith;
    for (const o of g.overrides.values()) {
      if ((o.value.kind === 'room_profile' || o.value.kind === 'house_profile') && o.value.profileId === profileId) o.value = { ...o.value, profileId: replaceWith };
    }
    for (const [key, r] of g.profileRooms) if (r.profileId === profileId) g.profileRooms.delete(key);
    g.profiles.delete(profileId);
  }

  private removeCircuit(g: ConfigGraph, circuitId: Id, force: boolean): void {
    const emitters = [...g.emitters.values()].filter((e) => e.circuitId === circuitId);
    const pumps = [...g.pumps.values()].filter((p) => p.circuitId === circuitId);
    if ((emitters.length || pumps.length) && !force) {
      throw new ApiException(409, 'in_use', 'The circuit still has emitters or pumps', undefined, usagesOf(g, { type: 'circuit', id: circuitId }));
    }
    for (const e of emitters) {
      e.circuitId = null;
      e.enabled = false;
    }
    for (const p of pumps) g.pumps.delete(p.id);
    g.circuits.delete(circuitId);
  }

  private removeTarget(g: ConfigGraph, targetId: Id): void {
    const t = g.targets.get(targetId);
    if (t?.isPrimary) {
      const pool = [...g.targets.values()].filter((x) => x.id !== targetId && (x.channel === 'ha_mobile' || x.channel === 'telegram'));
      // critical alerts need somewhere to go: the next phone (or chat) takes over, else refuse
      if (!pool.length) throw new ApiException(409, 'critical_invariant', 'The primary target cannot be removed while it is the only one that receives critical alerts');
    }
    g.targets.delete(targetId);
    for (const [key, cell] of g.routing) if (cell.targetId === targetId) g.routing.delete(key);
    for (const p of g.personal.values()) p.targetIds = p.targetIds.filter((x) => x !== targetId);
    if (g.notify.escalation.targetId === targetId) g.notify.escalation.targetId = null;
    this.normalizeTargets(g, null);
  }

  /* ── singletons ────────────────────────────────────────────────────────────────────────────── */

  private doPatchSingleton<K extends ConfigSingletonName>(d: Draft, k: K, patch: Partial<ConfigSingletons[K]>, actor: Actor): ConfigSingletons[K] {
    const g = d.g;
    const before = deepClone(g[k]);
    const next = mergePatch(before, patch) as ConfigSingletons[K];
    d.primary = { table: k, id: 'main' };
    const now = this.clock.now();
    if ('updatedAt' in (next as object)) (next as { updatedAt: number }).updatedAt = now;
    (g as ConfigSingletons)[k] = next;

    if (k === 'house') {
      const h = g.house;
      if (h.mode !== (before as ConfigSingletons['house']).mode) {
        h.modeChangedAt = now;
        h.modeChangedBy = actor;
      }
    }
    if (k === 'heat' || k === 'cool') {
      const chain = (k === 'heat' ? g.heat : g.cool).chain;
      for (const e of chain) if (!e.id) e.id = newId(ID_PREFIX.chainEntry);
    }
    if (k === 'heat') {
      const b = g.heat.bivalence;
      // the heat pump's hard limit sits at least one degree below the bivalent point
      if (b.hpLimitC > b.pointC - 1) b.hpLimitC = b.pointC - 1;
      const prev = (before as ConfigSingletons['heat']).bivalence;
      const frost = g.triggers.get('frost');
      if (frost?.system && (prev.pointC !== b.pointC || prev.hysteresisC !== b.hysteresisC)) frost.condition = frostCondition(b);
    }
    if (k === 'energy') {
      const p = patch as Partial<ConfigSingletons['energy']>;
      if (p.shedOrder !== undefined && p.shedOrderCustom === undefined) g.energy.shedOrderCustom = true;
      if (p.shedOrderCustom === false) this.recomputeShedOrder(g);
      g.energy.activeWhen = ensureNodeIds(g.energy.activeWhen);
    }
    if (k === 'notify') {
      const esc = g.notify.escalation.targetId;
      if (esc !== (before as ConfigSingletons['notify']).escalation.targetId) {
        for (const t of g.targets.values()) t.isEscalation = t.id === esc;
      }
    }
    return deepClone(g[k]);
  }

  private defaultPrefs(g: ConfigGraph, userId: string): PersonalPrefs {
    return defaultPersonalPrefs(userId, [...g.targets.values()].filter((t) => t.ownerUserId === userId).map((t) => t.id));
  }
}

