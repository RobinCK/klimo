import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { errorText, LogOnce } from '../common/logger';
import { Db } from '../db/database';
import { env, type Env } from '../env';
import type {
  ClockPort,
  Detection,
  EngineConfig,
  EpochMs,
  EventKind,
  ExposedEntityDto,
  HaPort,
  HaStateObj,
  HouseMode,
  IBus,
  IConfigStore,
  Id,
  IEngine,
  IHistory,
  IMqtt,
  ISupervisor,
  ITexts,
  MqttStatus,
  MqttTransport,
  Season,
  SeasonState,
  SparkDto,
} from '../shared/model';
import { BUS, CLOCK, CONFIG_STORE, HA_PORT, HISTORY, MQTT_TRANSPORT, SUPERVISOR } from '../tokens';
import { CommandsService } from './commands.service';
import { buildDiscovery, commandSubscriptions, deviceInfo, TOPIC, type DiscoveredEntity, type DeviceInfo } from './discovery';
import {
  circuitStateDoc,
  houseStateDoc,
  hubAttrs,
  hubState,
  ReplyRing,
  roomCardAttrs,
  roomStatePayload,
  sourceStateDoc,
  triggerStateDoc,
  ViewIndex,
  type PublishView,
} from './payloads';
import { MqttPorts, SILENT_TEXTS, type MqttPortAccess } from './ports';
import { isBrokerTransport, resolveBroker, STATUS_TOPIC } from './transport';
import { Z2mService } from './z2m.service';

/** Wall-clock pacing of broker traffic (the simulator's virtual clock must not throttle real I/O). */
export interface Timers {
  now(): number;
  setTimeout(cb: () => void, ms: number): { cancel(): void };
  setInterval(cb: () => void, ms: number): { cancel(): void };
}

export const REAL_TIMERS: Timers = {
  now: () => performance.now(),
  setTimeout: (cb, ms) => {
    const h = setTimeout(cb, Math.max(0, ms));
    h.unref?.();
    return { cancel: () => clearTimeout(h) };
  },
  setInterval: (cb, ms) => {
    const h = setInterval(cb, Math.max(1, ms));
    h.unref?.();
    return { cancel: () => clearInterval(h) };
  },
};

/** The two `kv` calls MQTT needs (the published set survives restarts). */
export interface KvStore {
  kvGet(key: string): Promise<string | null>;
  kvSet(key: string, value: string | null): Promise<void>;
}

/** One published discovery config and the topics it reads; persisted so a restart can still prune it. */
export interface PublishedEntry {
  id: string; // component:unique_id
  config: string;
  topics: string[];
}

export const PUBLISHED_KEY = 'mqtt.published';
/** Hub and room cards change often while devices sync; HA gets at most one update per topic per 2 s. */
const COALESCE_MS = 2_000;
/** Evaluations can come every second (faster in the simulator); one publish pass serves a burst. */
const PASS_DELAY_MS = 250;
/** Discovery waits for the first evaluation (season-dependent climate modes), but not forever. */
const READY_FALLBACK_MS = 20_000;
const HEARTBEAT_MS = 60_000;
const SPARKS_EVERY_MS = 5 * 60_000;
const SPARKS_MIN_REAL_MS = 5_000;
const OFFLINE_ALERT_MS = 5 * 60_000;
const DORMANT =
  'No MQTT broker found. Install the Mosquitto broker add-on and the MQTT integration, or set mqtt_host in the add-on options.';

interface PublishOpts {
  retain: boolean;
  qos: 0 | 1;
  /** Hub and card topics: at most one publish per COALESCE_MS, the latest value wins. */
  coalesce?: boolean;
  /** Bypasses coalescing (after a command, sync progress). */
  urgent?: boolean;
}

interface PassOpts {
  force?: boolean;
  urgentRooms?: Id[];
  /** After a command the hub goes out at once too: the house card reads it when the reply arrives. */
  urgentHub?: boolean;
}

interface Context {
  cfg: EngineConfig;
  engine: IEngine | null;
  season: SeasonState | null;
  device: DeviceInfo;
}

type Doc = Record<string, unknown>;

/**
 * MQTT discovery and the Lovelace transport (zroshua's MqttService grown up): one HA device «Klimo»
 * with per-room climates and sensors, house selects, plant sensors and three rich sensors (hub, room
 * cards, replies) the cards render from. Everything is retained and published on change only; the
 * set of published configs is kept in the database so entities deleted while the add-on was down are
 * still removed from HA. Commands from HA entities and cards go to CommandsService, Zigbee2MQTT
 * traffic to Z2mService.
 */
@Injectable()
export class MqttService implements IMqtt, OnApplicationBootstrap, OnModuleDestroy {
  /** Replaced in tests. */
  timers: Timers = REAL_TIMERS;
  settings: { prefix: string; broker: Env['mqtt'] } = { prefix: env.mqtt.discoveryPrefix, broker: env.mqtt };

  private readonly log = new Logger('MQTT');
  private readonly once = new LogOnce(this.log);
  private started = false;
  private ready = false;
  private everConnected = false;
  private dormantDetail: string | null = 'starting';
  private disconnectedSince: EpochMs | null = null;
  private configTopicsSubscribed = false;

  private entities: DiscoveredEntity[] = [];
  private liveTopics = new Set<string>();
  private published = new Map<string, PublishedEntry>();

  private readonly latest = new Map<string, string>();
  private readonly sentAt = new Map<string, number>();
  private readonly pending = new Map<string, { payload: string; opts: PublishOpts }>();
  private readonly retained = new Map<string, { payload: string; at: EpochMs }>();
  private readonly lastSync = new Map<Id, string>();
  private readonly replies = new ReplyRing();

  private sparks: Record<Id, SparkDto> = {};
  private sparksAt = Number.NEGATIVE_INFINITY;
  private sparksReal = Number.NEGATIVE_INFINITY;
  private sparksRooms = '';
  private sparksLoading = false;

  private chain: Promise<void> = Promise.resolve();
  private passTimer: { cancel(): void } | null = null;
  private forceNext = false;
  private flushTimer: { cancel(): void } | null = null;
  private readonly handles: { cancel(): void }[] = [];
  private readonly offs: (() => void)[] = [];

  constructor(
    @Inject(MQTT_TRANSPORT) private readonly transport: MqttTransport,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(BUS) private readonly bus: IBus,
    @Inject(CONFIG_STORE) private readonly config: IConfigStore,
    @Inject(HA_PORT) private readonly ha: HaPort,
    @Inject(SUPERVISOR) private readonly supervisor: ISupervisor,
    @Inject(HISTORY) private readonly history: IHistory,
    @Inject(Db) private readonly kv: KvStore,
    @Inject(MqttPorts) private readonly ports: MqttPortAccess,
    @Inject(CommandsService) private readonly commands: CommandsService,
    @Inject(Z2mService) private readonly z2m: Z2mService,
  ) {
    transport.onConnect(() => void this.onConnected());
    transport.onClose(() => this.onDisconnected());
    transport.onMessage((topic, payload) => this.onMessage(topic, payload));
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.loadPublished();
    this.started = true;
    this.offs.push(
      this.bus.on('engine.tick', () => {
        this.markReady();
        this.schedulePass();
      }),
      this.bus.on('incident.changed', () => this.schedulePass()),
      this.bus.on('config.changed', (e) => {
        if (e.entity === 'z2m_instance' || e.op === 'imported') void this.z2m.syncSubscriptions().catch(() => undefined);
        if (e.entity === 'settings') void this.subscribeConfigTopics();
        this.schedulePass();
      }),
    );
    this.handles.push(
      this.timers.setInterval(() => this.schedulePass(), HEARTBEAT_MS),
      this.timers.setTimeout(() => this.markReady(), READY_FALLBACK_MS),
    );
    if (this.engineHasRun()) this.ready = true;

    if (isBrokerTransport(this.transport)) {
      void this.startBroker();
    } else {
      this.dormantDetail = null;
      if (this.transport.connected) void this.onConnected();
    }
  }

  onModuleDestroy(): void {
    for (const h of this.handles) h.cancel();
    this.passTimer?.cancel();
    this.flushTimer?.cancel();
    for (const off of this.offs) off();
    this.started = false;
  }

  /* ── IMqtt ──────────────────────────────────────────────────────────────────────────────────── */

  status(): MqttStatus {
    const t = this.transport;
    const publishedEntities = t.connected ? this.entities.length : 0;
    if (!isBrokerTransport(t)) {
      return { configured: true, connected: t.connected, broker: 'in-process', source: 'simulator', detail: t.connected ? 'connected' : 'starting', publishedEntities };
    }
    const info = t.info();
    if (!info.started) {
      return { configured: false, connected: false, broker: null, source: 'none', detail: this.dormantDetail, publishedEntities: 0 };
    }
    const detail = t.connected
      ? 'connected'
      : info.lastError
        ? `error: ${info.lastError}`
        : this.everConnected
          ? 'disconnected, retrying…'
          : 'connecting…';
    return { configured: true, connected: t.connected, broker: info.broker, source: info.source, detail, publishedEntities };
  }

  publishNow(): void {
    void this.runPass({ force: true });
  }

  exposedEntities(): ExposedEntityDto[] {
    let entities = this.entities;
    if (!entities.length) {
      try {
        entities = this.discover(this.context());
      } catch {
        entities = [];
      }
    }
    const actual = this.registryIds();
    return entities.map((e) => ({
      entityId: actual.get(e.uniqueId) ?? e.entityId,
      component: e.component,
      role: e.role,
      roomId: e.roomId,
      uniqueId: e.uniqueId,
    }));
  }

  /** What HA would show for Klimo's entities, rebuilt from the retained topics (the card harness feeds on it). */
  asHaStates(): HaStateObj[] {
    const available = this.transport.connected;
    const read = (topic: string | null): { value: unknown; at: EpochMs } | null => {
      if (!topic) return null;
      const r = this.retained.get(topic);
      if (!r) return null;
      try {
        return { value: JSON.parse(r.payload) as unknown, at: r.at };
      } catch {
        return { value: r.payload, at: r.at };
      }
    };
    return this.entities.map((e) => {
      const cfg = e.config;
      const device = cfg.device as DeviceInfo;
      const attributes: Doc = { friendly_name: `${device.name} ${String(cfg.name)}` };
      for (const k of ['unit_of_measurement', 'device_class', 'state_class', 'icon', 'options'] as const) {
        if (cfg[k] !== undefined) attributes[k] = cfg[k];
      }
      let state = 'unknown';
      let at: EpochMs = 0;
      const s = read(e.read.stateTopic);
      if (s) {
        const raw = e.read.stateKey ? asDoc(s.value)[e.read.stateKey] : s.value;
        state = haState(raw, e.component);
        at = s.at;
      }
      if (e.read.attrs) {
        const a = read(e.read.attrsTopic);
        if (a) Object.assign(attributes, e.read.attrs(asDoc(a.value)));
      }
      if (e.component === 'climate') Object.assign(attributes, climateAttributes(cfg, s ? asDoc(s.value) : {}));
      if (e.component === 'number') Object.assign(attributes, { min: cfg.min, max: cfg.max, step: cfg.step, mode: cfg.mode });
      const iso = new Date(at).toISOString();
      return { entity_id: e.entityId, state: available ? state : 'unavailable', attributes, last_changed: iso, last_updated: iso };
    });
  }

  /* ── other areas (not on the IMqtt port) ────────────────────────────────────────────────────── */

  /** `mqtt_offline` after 5 min without the broker (only when MQTT is configured at all). */
  detect(now: EpochMs = this.clock.now()): Detection[] {
    const s = this.status();
    if (!s.configured || s.source === 'simulator') return [];
    const since = this.disconnectedSince;
    const active = !s.connected && since !== null && now - since >= OFFLINE_ALERT_MS;
    return [
      {
        kind: 'mqtt_offline',
        dedupKey: 'mqtt_offline',
        active,
        facts: { broker: s.broker, since: since ?? null, detail: s.detail },
      },
    ];
  }

  zigbee(): Z2mService {
    return this.z2m;
  }

  /* ── connection ─────────────────────────────────────────────────────────────────────────────── */

  private async startBroker(): Promise<void> {
    const t = this.transport;
    if (!isBrokerTransport(t)) return;
    const broker = await resolveBroker(this.settings.broker, this.supervisor);
    if (!broker) {
      this.dormantDetail = DORMANT;
      this.log.log(`MQTT dormant — ${DORMANT}`);
      return;
    }
    this.dormantDetail = null;
    t.start(broker);
  }

  private async onConnected(): Promise<void> {
    if (!this.started) return;
    this.everConnected = true;
    this.disconnectedSince = null;
    this.bus.emit('mqtt.connection', { connected: true });
    // a fresh broker session may have lost retained topics: everything goes out again
    this.resetSent();
    try {
      await this.transport.publish(STATUS_TOPIC, 'online', { retain: true, qos: 1 });
      const configEntities = this.settingsSafe()?.mqttConfigEntities ?? false;
      this.configTopicsSubscribed = configEntities;
      await this.transport.subscribe([...commandSubscriptions(configEntities), `${this.settings.prefix}/status`]);
      await this.z2m.subscribe();
    } catch (e) {
      this.log.warn(`Subscribing failed: ${errorText(e)}`);
    }
    await this.publishReplies(true);
    await this.runPass({ force: true });
  }

  private onDisconnected(): void {
    this.disconnectedSince ??= this.clock.now();
    this.flushTimer?.cancel();
    this.flushTimer = null;
    this.pending.clear();
    this.bus.emit('mqtt.connection', { connected: false });
  }

  /** The opt-in configuration topics are subscribed when the setting is switched on at runtime. */
  private async subscribeConfigTopics(): Promise<void> {
    if (this.configTopicsSubscribed || !this.transport.connected || !this.settingsSafe()?.mqttConfigEntities) return;
    this.configTopicsSubscribed = true;
    await this.transport.subscribe(commandSubscriptions(true).slice(-3)).catch((e: unknown) => {
      this.configTopicsSubscribed = false;
      this.log.warn(`Subscribing failed: ${errorText(e)}`);
    });
  }

  private onMessage(topic: string, payload: string): void {
    if (topic === `${this.settings.prefix}/status`) {
      if (payload.trim() === 'online') {
        // Home Assistant restarted: announce everything again
        this.log.log('Home Assistant came online — republishing discovery and states');
        this.resetSent();
        this.schedulePass(0, true);
      }
      return;
    }
    if (CommandsService.isCommandTopic(topic)) {
      void this.command(topic, payload);
      return;
    }
    if (this.z2m.handles(topic)) this.z2m.onMessage(topic, payload);
  }

  private async command(topic: string, payload: string): Promise<void> {
    const receivedAt = this.clock.now();
    let outcome;
    try {
      outcome = await this.commands.handle(topic, payload, receivedAt);
    } catch (e) {
      this.log.error(`Command ${topic} failed: ${errorText(e)}`);
      return;
    }
    if (!outcome) return;
    if (outcome.changed) await this.freshEvaluation(receivedAt);
    // a preview changes nothing; anything else goes out before the reply, the room card first-hand
    if (outcome.changed || outcome.roomId) await this.runPass({ urgentRooms: outcome.roomId ? [outcome.roomId] : [], urgentHub: outcome.changed });
    const reply = outcome.reply;
    if (reply) {
      this.replies.push(reply);
      await this.publishReplies(false);
      this.bus.emit('command.result', { reqId: reply.reqId, ok: reply.ok, code: reply.code, error: null, via: outcome.via });
    }
  }

  /** The action services evaluate after a change; evaluate here only when they did not. */
  private async freshEvaluation(receivedAt: EpochMs): Promise<void> {
    const engine = this.ports.engine();
    if (!engine) return;
    try {
      if (engine.house().engine.lastTickAt < receivedAt) await engine.runNow('mqtt.command');
    } catch (e) {
      this.once.warn('run', `Evaluation after an MQTT command failed: ${errorText(e)}`);
    }
  }

  /* ── passes ─────────────────────────────────────────────────────────────────────────────────── */

  private markReady(): void {
    if (this.ready) return;
    this.ready = true;
    this.schedulePass(0, true);
  }

  private schedulePass(delay = PASS_DELAY_MS, force = false): void {
    if (force) this.forceNext = true;
    if (this.passTimer || !this.started) return;
    this.passTimer = this.timers.setTimeout(() => {
      this.passTimer = null;
      const f = this.forceNext;
      this.forceNext = false;
      void this.runPass({ force: f });
    }, delay);
  }

  /** Passes run one after another, so a command's card always goes out before its reply. */
  private runPass(opts: PassOpts): Promise<void> {
    const run = this.chain.then(() => this.pass(opts));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async pass(opts: PassOpts): Promise<void> {
    if (!this.started || !this.transport.connected) return;
    if (opts.force) this.resetSent();
    if (!this.ready) return;
    try {
      const ctx = this.context();
      await this.publishDiscovery(ctx);
      const view = this.view(ctx);
      if (view) await this.publishStates(view, new Set(opts.urgentRooms ?? []), !!opts.urgentHub);
      this.refreshSparks(ctx.cfg);
      this.once.reset('pass');
    } catch (e) {
      this.once.error('pass', `Publishing failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    }
  }

  private context(): Context {
    const cfg = this.config.engineConfig();
    const engine = this.ports.engine();
    let season: SeasonState | null = null;
    try {
      season = engine?.last() ? engine.season() : null;
    } catch {
      season = null;
    }
    return { cfg, engine, season, device: deviceInfo(this.supervisor.addonVersion(), this.supervisor.panelPath()) };
  }

  private discover(ctx: Context): DiscoveredEntity[] {
    const houseMode: HouseMode = ctx.season?.houseMode ?? ctx.cfg.house.mode;
    return buildDiscovery({
      cfg: ctx.cfg,
      season: ctx.season?.season ?? fallbackSeason(houseMode),
      houseMode,
      lang: ctx.cfg.settings.notificationLanguage,
      prefix: this.settings.prefix,
      device: ctx.device,
    });
  }

  /** Publishes every config, then removes what is gone — including what vanished while Klimo was down. */
  private async publishDiscovery(ctx: Context): Promise<void> {
    const entities = this.discover(ctx);
    this.entities = entities;
    const live = new Set<string>([TOPIC.replyState, TOPIC.replyAttrs]);
    for (const e of entities) for (const t of e.topics) live.add(t);
    this.liveTopics = live;

    for (const e of entities) await this.offer(e.configTopic, JSON.stringify(e.config), { retain: true, qos: 1 });

    const next = new Map<string, PublishedEntry>(
      entities.map((e) => [`${e.component}:${e.uniqueId}`, { id: `${e.component}:${e.uniqueId}`, config: e.configTopic, topics: e.topics }]),
    );
    const liveConfigs = new Set(entities.map((e) => e.configTopic));
    const staleTopics = new Set<string>();
    for (const old of this.published.values()) {
      if (!liveConfigs.has(old.config)) {
        await this.clear(old.config);
        if (!next.has(old.id)) this.log.log(`Removed ${old.id.replace(':', '.')} from Home Assistant`);
      }
      for (const t of old.topics) if (!live.has(t)) staleTopics.add(t);
    }
    for (const t of staleTopics) await this.clear(t);
    if (!sameEntries(this.published, next)) {
      this.published = next;
      await this.savePublished();
    }
  }

  private view(ctx: Context): PublishView | null {
    const engine = ctx.engine;
    if (!engine || !engine.last() || !ctx.season) return null;
    const readModels = this.ports.readModels();
    const incidents = this.ports.incidents();
    const texts: ITexts = this.ports.texts() ?? SILENT_TEXTS;
    const house = engine.house();

    let problems: { count: number; kinds: EventKind[] } = { count: house.alertsCount.critical + house.alertsCount.warning, kinds: [] };
    let alerts = house.alertsCount.total;
    let open: PublishView['incidents'];
    if (incidents) {
      try {
        // hidden ones too: they keep an issue the user hid off the room card
        const all = incidents.list({ scope: 'all', status: 'active', limit: 200 });
        open = all.map((i) => ({ id: i.id, kind: i.kind, roomId: i.roomId, sourceId: i.sourceId, entityId: i.entityId, deviceKey: i.deviceKey, hidden: i.hidden }));
        const active = all.filter((i) => i.severity === 'critical' || i.severity === 'warning');
        problems = { count: active.length, kinds: [...new Set(active.map((i) => i.kind))] };
        alerts = incidents.counts().total;
      } catch (e) {
        this.once.warn('incidents', `Incident counts unavailable: ${errorText(e)}`);
      }
    }
    let durations: PublishView['durations'] = [];
    try {
      durations = this.ports.houseActions()?.durations() ?? [];
    } catch {
      durations = [];
    }
    let summaries: PublishView['summaries'] = [];
    try {
      summaries = readModels?.roomSummaries() ?? [];
    } catch (e) {
      this.once.warn('summaries', `Room summaries unavailable: ${errorText(e)}`);
    }
    return {
      now: this.clock.now(),
      tz: this.clock.tz(),
      lang: ctx.cfg.settings.notificationLanguage,
      cfg: ctx.cfg,
      texts,
      health: engine.health(),
      online: this.ha.connected && engine.health() !== 'blind',
      panel: this.supervisor.panelPath(),
      house,
      season: ctx.season,
      plant: engine.plant(),
      profile: engine.houseProfile(),
      rooms: engine.rooms(),
      summaries,
      thermostat: (roomId) => {
        try {
          return readModels?.thermostat(roomId) ?? null;
        } catch {
          return null;
        }
      },
      sparks: this.sparks,
      durations,
      problems,
      alerts,
      incidents: open,
    };
  }

  private async publishStates(view: PublishView, urgentRooms: Set<Id>, urgentHub: boolean): Promise<void> {
    const ix = new ViewIndex(view);
    const doc = (v: unknown) => JSON.stringify(v);
    await this.offerState(TOPIC.house, () => doc(houseStateDoc(ix)));

    for (const room of [...view.cfg.rooms].sort((a, b) => a.order - b.order)) {
      const state = ix.stateById.get(room.id);
      if (!state) continue;
      await this.offerState(TOPIC.room(room.id), () => doc(roomStatePayload(ix, room, state)));
      await this.offerState(
        TOPIC.card(room.id),
        () => {
          const card = roomCardAttrs(ix, room);
          return card ? doc(card) : null;
        },
        (payload) => {
          // device sync progress is what the thermostat watches after a change: never hold it back
          const sync = JSON.stringify(state.sync);
          const changed = this.lastSync.get(room.id) !== sync;
          this.lastSync.set(room.id, sync);
          return { retain: true, qos: 0, coalesce: true, urgent: urgentRooms.has(room.id) || (changed && payload !== null) };
        },
      );
    }
    for (const s of view.plant.sources) await this.offerState(TOPIC.source(s.sourceId), () => doc(sourceStateDoc(s)));
    for (const c of view.plant.circuits) await this.offerState(TOPIC.circuit(c.circuitId), () => doc(circuitStateDoc(c)));
    for (const t of view.plant.triggers) await this.offerState(TOPIC.trigger(t.triggerId), () => doc(triggerStateDoc(t)));
    for (const r of view.cfg.rules) await this.offerState(TOPIC.rule(r.id), () => doc({ state: r.enabled ? 'ON' : 'OFF' }));
    const hubOpts = (): PublishOpts => ({ retain: true, qos: 0, coalesce: true, urgent: urgentHub });
    await this.offerState(TOPIC.hubState, () => hubState(view), hubOpts);
    await this.offerState(TOPIC.hubAttrs, () => doc(hubAttrs(ix)), hubOpts);
  }

  /** Builds and offers one state topic; a topic no current entity reads is never published (it could not be pruned). */
  private async offerState(topic: string, build: () => string | null, opts?: (payload: string | null) => PublishOpts): Promise<void> {
    if (!this.liveTopics.has(topic)) return;
    let payload: string | null;
    try {
      payload = build();
      this.once.reset(`build:${topic}`);
    } catch (e) {
      this.once.error(`build:${topic}`, `Cannot build ${topic}: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
      return;
    }
    const o = opts ? opts(payload) : { retain: true, qos: 0 as const };
    if (payload !== null) await this.offer(topic, payload, o);
  }

  private async publishReplies(force: boolean): Promise<void> {
    if (force) {
      this.latest.delete(TOPIC.replyAttrs);
      this.latest.delete(TOPIC.replyState);
    }
    await this.offer(TOPIC.replyAttrs, JSON.stringify(this.replies.attrs()), { retain: true, qos: 0 });
    await this.offer(TOPIC.replyState, this.replies.state(), { retain: true, qos: 0 });
  }

  /* ── change-only publishing with coalescing ─────────────────────────────────────────────────── */

  private async offer(topic: string, payload: string, opts: PublishOpts): Promise<void> {
    if (this.latest.get(topic) === payload && !(opts.urgent && this.pending.has(topic))) return;
    this.latest.set(topic, payload);
    if (opts.coalesce && !opts.urgent) {
      const last = this.sentAt.get(topic);
      const now = this.timers.now();
      if (last !== undefined && now - last < COALESCE_MS) {
        this.pending.set(topic, { payload, opts });
        this.scheduleFlush(last + COALESCE_MS - now);
        return;
      }
    }
    this.pending.delete(topic);
    await this.send(topic, payload, opts);
  }

  private scheduleFlush(ms: number): void {
    if (this.flushTimer) return;
    this.flushTimer = this.timers.setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, ms);
  }

  private async flush(): Promise<void> {
    const now = this.timers.now();
    let wait = Number.POSITIVE_INFINITY;
    for (const [topic, { payload, opts }] of [...this.pending]) {
      const last = this.sentAt.get(topic) ?? Number.NEGATIVE_INFINITY;
      if (now - last >= COALESCE_MS) {
        this.pending.delete(topic);
        await this.send(topic, payload, opts);
      } else {
        wait = Math.min(wait, last + COALESCE_MS - now);
      }
    }
    if (this.pending.size && Number.isFinite(wait)) this.scheduleFlush(wait);
  }

  private async send(topic: string, payload: string, opts: PublishOpts): Promise<void> {
    if (!this.transport.connected) {
      this.latest.delete(topic);
      return;
    }
    try {
      await this.transport.publish(topic, payload, { retain: opts.retain, qos: opts.qos });
      this.sentAt.set(topic, this.timers.now());
      if (!topic.startsWith(`${this.settings.prefix}/`)) {
        const prev = this.retained.get(topic);
        if (payload === '') this.retained.delete(topic);
        else if (prev?.payload !== payload) this.retained.set(topic, { payload, at: this.clock.now() });
      }
      this.once.reset(`send:${topic}`);
    } catch (e) {
      // forget it so the next pass tries again
      this.latest.delete(topic);
      this.once.warn(`send:${topic}`, `Publishing ${topic} failed: ${errorText(e)}`);
    }
  }

  /** An empty retained message deletes a discovery config (and the entity) or a stale state topic. */
  private async clear(topic: string): Promise<void> {
    this.pending.delete(topic);
    this.latest.delete(topic);
    await this.send(topic, '', { retain: true, qos: 1 });
    this.latest.delete(topic);
  }

  private resetSent(): void {
    this.latest.clear();
    this.sentAt.clear();
    this.pending.clear();
    this.lastSync.clear();
    this.flushTimer?.cancel();
    this.flushTimer = null;
  }

  /* ── persistence, sparklines, helpers ───────────────────────────────────────────────────────── */

  private async loadPublished(): Promise<void> {
    try {
      const raw = await this.kv.kvGet(PUBLISHED_KEY);
      this.published = parsePublished(raw);
    } catch (e) {
      this.log.warn(`Cannot read the published entity list: ${errorText(e)}`);
    }
  }

  private async savePublished(): Promise<void> {
    try {
      await this.kv.kvSet(PUBLISHED_KEY, JSON.stringify([...this.published.values()]));
    } catch (e) {
      this.once.warn('kv', `Cannot store the published entity list: ${errorText(e)}`);
    }
  }

  /** Sparklines come from the recorder (30-min points): refreshed every 5 min, or at once for a new room. */
  private refreshSparks(cfg: EngineConfig): void {
    if (this.sparksLoading) return;
    const rooms = cfg.rooms
      .map((r) => r.id)
      .sort()
      .join(',');
    const due = rooms !== this.sparksRooms || this.clock.now() - this.sparksAt >= SPARKS_EVERY_MS;
    if (!due || this.timers.now() - this.sparksReal < SPARKS_MIN_REAL_MS) return;
    this.sparksLoading = true;
    this.sparksReal = this.timers.now();
    this.history
      .sparks()
      .then((s) => {
        this.sparks = s;
        this.sparksAt = this.clock.now();
        this.sparksRooms = rooms;
        this.schedulePass();
      })
      .catch((e: unknown) => this.once.warn('sparks', `Sparklines unavailable: ${errorText(e)}`))
      .finally(() => {
        this.sparksLoading = false;
      });
  }

  private engineHasRun(): boolean {
    try {
      return !!this.ports.engine()?.last();
    } catch {
      return false;
    }
  }

  private settingsSafe(): EngineConfig['settings'] | null {
    try {
      return this.config.engineConfig().settings;
    } catch {
      return null;
    }
  }

  private registryIds(): Map<string, string> {
    const out = new Map<string, string>();
    try {
      for (const e of this.ha.registries().entities) if (e.platform === 'mqtt' && e.unique_id) out.set(e.unique_id, e.entity_id);
    } catch {
      // registries not loaded yet: the documented ids stand in
    }
    return out;
  }
}

/** Before the first evaluation the season is unknown; the house mode is the best guess. */
function fallbackSeason(mode: HouseMode): Season {
  if (mode === 'heat') return 'heating';
  if (mode === 'cool') return 'cooling';
  return 'neutral';
}

export function parsePublished(raw: string | null): Map<string, PublishedEntry> {
  const out = new Map<string, PublishedEntry>();
  if (!raw) return out;
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!Array.isArray(list)) return out;
  for (const x of list) {
    const e = asDoc(x);
    if (typeof e.id !== 'string' || typeof e.config !== 'string') continue;
    const topics = Array.isArray(e.topics) ? e.topics.filter((t): t is string => typeof t === 'string') : [];
    out.set(e.id, { id: e.id, config: e.config, topics });
  }
  return out;
}

function sameEntries(a: Map<string, PublishedEntry>, b: Map<string, PublishedEntry>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const w = b.get(k);
    if (!w || w.config !== v.config || w.topics.join('|') !== v.topics.join('|')) return false;
  }
  return true;
}

function asDoc(v: unknown): Doc {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Doc) : {};
}

function haState(raw: unknown, component: DiscoveredEntity['component']): string {
  if (raw === null || raw === undefined || raw === '' || raw === 'None') return 'unknown';
  if (component === 'binary_sensor' || component === 'switch') return raw === 'ON' ? 'on' : raw === 'OFF' ? 'off' : 'unknown';
  return typeof raw === 'string' ? raw : JSON.stringify(raw);
}

function climateAttributes(cfg: Doc, d: Doc): Doc {
  const out: Doc = {
    hvac_modes: cfg.modes,
    min_temp: cfg.min_temp,
    max_temp: cfg.max_temp,
    target_temp_step: cfg.temp_step,
    current_temperature: d.cur ?? null,
    current_humidity: d.hum ?? null,
    hvac_action: d.action ?? null,
    preset_mode: d.preset ?? null,
    preset_modes: cfg.preset_modes,
    temperature: d.t ?? null,
  };
  if (cfg.temperature_low_command_topic) {
    out.target_temp_low = d.lo ?? null;
    out.target_temp_high = d.hi ?? null;
  }
  return { ...out, ...asDoc(d.attrs) };
}
