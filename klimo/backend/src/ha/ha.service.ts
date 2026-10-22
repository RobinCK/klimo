import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import WebSocket from 'ws';
import { isZonedClock } from '../common/clock';
import { errorText, LogOnce } from '../common/logger';
import { env } from '../env';
import type {
  ClockPort,
  EntityId,
  EpochMs,
  HaConfigInfo,
  HaPort,
  HaRegistries,
  HaServiceResult,
  HaStateObj,
  IBus,
} from '../shared/model';
import { BUS, CLOCK } from '../tokens';

/** Callbacks the socket reports to; the `ws` client in production, a fake in tests. */
export interface HaSocketHandlers {
  open(): void;
  message(text: string): void;
  close(): void;
  error(e: Error): void;
}

export interface HaSocket {
  send(text: string): void;
  close(): void;
}

type EventContext = { id: string | null; user_id: string | null; parent_id: string | null };
type StatRow = { start: number; mean?: number | null; min?: number | null; max?: number | null; state?: number | null; sum?: number | null };
type HistoryRow = { s: string; lu: number; a?: Record<string, unknown> };
export type AuthUser = { id: string; name: string; is_admin: boolean; system_generated: boolean };

/** An error result of a WebSocket command; `code` is HA's (`unknown_command`, `home_assistant_error`…). */
export class HaCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
  timer: { cancel(): void };
}

interface TemplateSub {
  template: string;
  variables: Record<string, unknown>;
  cb: (result: unknown, error: string | null) => void;
  /** Id of the live `render_template` subscription on the current connection. */
  subId: number | null;
}

/** Non-state events Klimo always listens to (registries, attribution, restarts, notification actions). */
const BASE_EVENTS = [
  'entity_registry_updated',
  'device_registry_updated',
  'area_registry_updated',
  'call_service',
  'homeassistant_started',
  'mobile_app_notification_action',
  'telegram_callback',
] as const;
const REGISTRY_EVENTS = new Set<string>(['entity_registry_updated', 'device_registry_updated', 'area_registry_updated']);

const REQUEST_TIMEOUT_MS = 15_000;
/** Recorder queries over weeks of data legitimately take longer than an ordinary command. */
const RECORDER_TIMEOUT_MS = 60_000;
const PING_EVERY_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const STABLE_AFTER_MS = 60_000;
const AUTH_RETRY_MS = 60_000;
const REGISTRY_DEBOUNCE_MS = 2_000;
const USERS_TTL_MS = 5 * 60_000;

function record(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function iso(ts: EpochMs): string {
  return new Date(ts).toISOString();
}

function contextOf(v: unknown): EventContext {
  const c = record(v);
  return { id: str(c.id), user_id: str(c.user_id), parent_id: str(c.parent_id) };
}

/**
 * The one WebSocket to Home Assistant Core (through the Supervisor proxy, or a dev URL with a long-lived
 * token). It keeps a state cache and the registries in memory, re-subscribes everything after a
 * reconnect (events, templates), and exposes service calls, the recorder, users and Lovelace resources.
 *
 * Ready sequence: subscribe `state_changed` first, then `get_states` — a change that happens between
 * the two is either in the snapshot or arrives after it, never lost.
 */
@Injectable()
export class HaService implements HaPort, OnModuleInit, OnApplicationShutdown {
  readonly simulated = false;

  private readonly log = new Logger('HA');
  private readonly once = new LogOnce(this.log);
  private url = '';
  private token = '';
  private socket: HaSocket | null = null;
  /** Bumped on every new socket; callbacks of an older socket are ignored. */
  private generation = 0;
  private authed = false;
  private ready = false;
  private stopped = true;
  private authRejected = false;
  private attempt = 0;
  private nextId = 0;

  private readonly pending = new Map<number, Pending>();
  private readonly states = new Map<EntityId, HaStateObj>();
  private regs: HaRegistries = { areas: [], devices: [], entities: [] };
  private info: HaConfigInfo | null = null;
  private readonly eventTypes = new Set<string>(BASE_EVENTS);
  private readonly subscribedTypes = new Set<string>();
  private readonly templates = new Set<TemplateSub>();
  private readonly templateBySubId = new Map<number, TemplateSub>();
  private users: { at: EpochMs; list: AuthUser[] } | null = null;
  private usersInflight: Promise<AuthUser[]> | null = null;

  private reconnectTimer: { cancel(): void } | null = null;
  private heartbeatTimer: { cancel(): void } | null = null;
  private pongTimer: { cancel(): void } | null = null;
  private pingId: number | null = null;
  private stableTimer: { cancel(): void } | null = null;
  private registryTimer: { cancel(): void } | null = null;

  private readonly connectionCbs: ((ok: boolean) => void)[] = [];
  private readonly stateCbs: ((id: EntityId, next: HaStateObj | null, prev: HaStateObj | null) => void)[] = [];
  private readonly eventCbs: ((type: string, data: Record<string, unknown>, ctx: EventContext) => void)[] = [];
  private readonly registryCbs: (() => void)[] = [];

  constructor(
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(BUS) private readonly bus: IBus,
  ) {}

  onModuleInit(): void {
    if (!env.supervisorToken) {
      this.log.warn('SUPERVISOR_TOKEN is not set — running detached from Home Assistant (nothing is controlled)');
      return;
    }
    this.start(env.haWsUrl, env.supervisorToken);
  }

  onApplicationShutdown(): void {
    // the last thing to go: the engine's fail-safe calls run in earlier shutdown phases
    this.stop();
  }

  get connected(): boolean {
    return this.ready;
  }

  /** Opens the connection (and keeps it open until `stop`). */
  start(url: string, token: string): void {
    this.url = url;
    this.token = token;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.reconnectTimer?.cancel();
    this.reconnectTimer = null;
    const s = this.socket;
    if (s) {
      this.onSocketClosed(this.generation);
      s.close();
    }
  }

  /** Overridden in tests to hand in a fake socket. */
  protected openSocket(url: string, h: HaSocketHandlers): HaSocket {
    const ws = new WebSocket(url, { handshakeTimeout: 10_000 });
    ws.on('open', () => h.open());
    ws.on('message', (data) => h.message(data.toString()));
    ws.on('close', () => h.close());
    ws.on('error', (e) => h.error(e));
    return {
      send: (text) => ws.send(text),
      close: () => ws.terminate(),
    };
  }

  /* ── connection lifecycle ──────────────────────────────────────────────────────────────────── */

  private connect(): void {
    this.reconnectTimer = null;
    if (this.stopped) return;
    const gen = ++this.generation;
    try {
      this.socket = this.openSocket(this.url, {
        open: () => {
          if (gen === this.generation) this.log.debug('WebSocket open, waiting for auth');
        },
        message: (text) => {
          if (gen === this.generation) this.onMessage(text, gen);
        },
        close: () => this.onSocketClosed(gen),
        error: (e) => {
          if (gen === this.generation) this.once.warn('socket', `WebSocket error: ${e.message}`);
        },
      });
    } catch (e) {
      this.once.warn('socket', `cannot open the Home Assistant WebSocket: ${errorText(e)}`);
      this.socket = null;
      this.scheduleReconnect();
    }
  }

  private onSocketClosed(gen: number): void {
    if (gen !== this.generation || !this.socket) return;
    this.generation++;
    this.socket = null;
    this.authed = false;
    const wasReady = this.ready;
    this.ready = false;
    for (const t of [this.heartbeatTimer, this.pongTimer, this.stableTimer, this.registryTimer]) t?.cancel();
    this.heartbeatTimer = this.pongTimer = this.stableTimer = this.registryTimer = null;
    this.pingId = null;
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) {
      p.timer.cancel();
      p.reject(new Error('Home Assistant connection closed'));
    }
    this.subscribedTypes.clear();
    this.templateBySubId.clear();
    for (const t of this.templates) t.subId = null;
    if (wasReady) {
      if (!this.stopped) this.log.warn('Home Assistant connection lost');
      this.setConnected(false);
    }
    if (!this.stopped) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.authRejected ? AUTH_RETRY_MS : BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt++;
    this.reconnectTimer = this.clock.setTimeout(() => this.connect(), delay);
  }

  private setConnected(ok: boolean): void {
    for (const cb of [...this.connectionCbs]) {
      try {
        cb(ok);
      } catch (e) {
        this.log.error(`connection listener failed: ${errorText(e)}`);
      }
    }
    this.bus.emit('ha.connection', { connected: ok });
  }

  /* ── messages ──────────────────────────────────────────────────────────────────────────────── */

  private onMessage(text: string, gen: number): void {
    let msg: Record<string, unknown>;
    try {
      msg = record(JSON.parse(text));
    } catch {
      this.log.warn('ignoring a non-JSON message from Home Assistant');
      return;
    }
    switch (msg.type) {
      case 'auth_required':
        this.socket?.send(JSON.stringify({ type: 'auth', access_token: this.token }));
        return;
      case 'auth_ok':
        this.authed = true;
        this.authRejected = false;
        this.once.reset('auth');
        void this.onAuthenticated(gen);
        return;
      case 'auth_invalid':
        this.authRejected = true;
        this.once.error('auth', `Home Assistant rejected the access token (${str(msg.message) ?? 'auth_invalid'}); retrying every 60 s`);
        this.socket?.close();
        return;
      case 'result':
        this.onResult(msg);
        return;
      case 'event':
        this.onEventMessage(msg);
        return;
      case 'pong':
        if (num(msg.id) === this.pingId) {
          this.pongTimer?.cancel();
          this.pongTimer = null;
          this.pingId = null;
        }
        return;
      default:
        return;
    }
  }

  private onResult(msg: Record<string, unknown>): void {
    const id = num(msg.id);
    const p = id === null ? undefined : this.pending.get(id);
    if (!p || id === null) return;
    this.pending.delete(id);
    p.timer.cancel();
    if (msg.success === true) {
      p.resolve(msg.result);
      return;
    }
    const err = record(msg.error);
    p.reject(new HaCommandError(str(err.code) ?? 'error', str(err.message) ?? 'request failed'));
  }

  private onEventMessage(msg: Record<string, unknown>): void {
    const id = num(msg.id);
    const event = record(msg.event);
    const tpl = id === null ? undefined : this.templateBySubId.get(id);
    if (tpl) {
      this.onTemplateEvent(tpl, event);
      return;
    }
    const type = str(event.event_type);
    if (!type) return;
    const data = record(event.data);
    if (type === 'state_changed') {
      this.applyStateChange(data);
      return;
    }
    if (REGISTRY_EVENTS.has(type)) this.scheduleRegistryRefresh();
    const ctx = contextOf(event.context);
    for (const cb of [...this.eventCbs]) {
      try {
        cb(type, data, ctx);
      } catch (e) {
        this.log.error(`listener of ${type} failed: ${errorText(e)}`);
      }
    }
  }

  private applyStateChange(data: Record<string, unknown>): void {
    const entityId = str(data.entity_id);
    if (!entityId) return;
    const next = data.new_state ? (data.new_state as HaStateObj) : null;
    const prev = this.states.get(entityId) ?? (data.old_state ? (data.old_state as HaStateObj) : null);
    if (next) this.states.set(entityId, next);
    else this.states.delete(entityId);
    for (const cb of [...this.stateCbs]) {
      try {
        cb(entityId, next, prev);
      } catch (e) {
        this.log.error(`state listener failed for ${entityId}: ${errorText(e)}`);
      }
    }
  }

  private onTemplateEvent(sub: TemplateSub, event: Record<string, unknown>): void {
    if ('result' in event) {
      this.deliverTemplate(sub, event.result, null);
      return;
    }
    const error = str(event.error);
    // warnings (undefined variables in non-strict mode) do not stop the template from rendering
    if (error && str(event.level) !== 'WARNING') this.deliverTemplate(sub, null, error);
  }

  private deliverTemplate(sub: TemplateSub, result: unknown, error: string | null): void {
    try {
      sub.cb(result, error);
    } catch (e) {
      this.log.error(`template listener failed: ${errorText(e)}`);
    }
  }

  /* ── ready sequence ────────────────────────────────────────────────────────────────────────── */

  private async onAuthenticated(gen: number): Promise<void> {
    try {
      await this.subscribeOn('state_changed', gen);
      const states = await this.request<unknown[]>({ type: 'get_states' });
      if (gen !== this.generation) return;
      this.states.clear();
      for (const s of Array.isArray(states) ? states : []) {
        const st = s as HaStateObj;
        if (st && typeof st.entity_id === 'string') this.states.set(st.entity_id, st);
      }

      const rawConfig = await this.request<unknown>({ type: 'get_config' });
      if (gen !== this.generation) return;
      this.info = toConfigInfo(rawConfig);
      // schedules, slots and "morning" follow the house's clock, not the container's
      const tz = str(record(rawConfig).time_zone);
      if (tz && isZonedClock(this.clock)) this.clock.setTimeZone(tz);

      await this.fetchRegistries();
      if (gen !== this.generation) return;

      for (const type of this.eventTypes) {
        if (type === 'state_changed' || this.subscribedTypes.has(type)) continue;
        try {
          await this.subscribeOn(type, gen);
        } catch (e) {
          if (gen !== this.generation) return;
          this.log.warn(`cannot subscribe to ${type}: ${errorText(e)}`);
        }
      }
      for (const t of this.templates) if (t.subId === null) await this.startTemplate(t, gen);
      if (gen !== this.generation) return;

      this.ready = true;
      this.once.reset('socket');
      this.log.log(`connected to Home Assistant ${this.info.version}: ${this.states.size} states, ${this.regs.entities.length} registry entries`);
      this.startHeartbeat(gen);
      this.stableTimer = this.clock.setTimeout(() => {
        if (gen === this.generation) this.attempt = 0;
      }, STABLE_AFTER_MS);
      this.setConnected(true);
    } catch (e) {
      if (gen !== this.generation) return;
      this.log.warn(`Home Assistant setup failed, reconnecting: ${errorText(e)}`);
      const s = this.socket;
      this.onSocketClosed(gen);
      s?.close();
    }
  }

  private async subscribeOn(type: string, gen: number): Promise<void> {
    if (gen !== this.generation || this.subscribedTypes.has(type)) return;
    this.subscribedTypes.add(type);
    try {
      await this.request({ type: 'subscribe_events', event_type: type });
    } catch (e) {
      if (gen === this.generation) this.subscribedTypes.delete(type);
      throw e;
    }
  }

  private async startTemplate(sub: TemplateSub, gen: number): Promise<void> {
    if (gen !== this.generation || sub.subId !== null || !this.templates.has(sub)) return;
    const id = ++this.nextId;
    sub.subId = id;
    this.templateBySubId.set(id, sub);
    try {
      await this.requestWithId(id, { type: 'render_template', template: sub.template, variables: sub.variables, report_errors: true, strict: false }, REQUEST_TIMEOUT_MS);
    } catch (e) {
      if (gen !== this.generation) return;
      this.templateBySubId.delete(id);
      sub.subId = null;
      // a template that does not compile stays registered: it is retried after the next reconnect
      this.deliverTemplate(sub, null, errorText(e).replace(/^template_error: /, ''));
    }
  }

  private startHeartbeat(gen: number): void {
    this.heartbeatTimer = this.clock.setInterval(() => {
      if (gen !== this.generation || !this.socket || this.pingId !== null) return;
      const id = ++this.nextId;
      this.pingId = id;
      this.socket.send(JSON.stringify({ id, type: 'ping' }));
      this.pongTimer = this.clock.setTimeout(() => {
        if (gen !== this.generation || this.pingId !== id) return;
        // a half-open TCP connection never errors by itself
        this.log.warn('no pong from Home Assistant within 10 s, reconnecting');
        const s = this.socket;
        this.onSocketClosed(gen);
        s?.close();
      }, PONG_TIMEOUT_MS);
    }, PING_EVERY_MS);
  }

  /* ── registries ────────────────────────────────────────────────────────────────────────────── */

  private async fetchRegistries(): Promise<void> {
    const [entities, devices, areas] = await Promise.all([
      this.request<unknown[]>({ type: 'config/entity_registry/list' }),
      this.request<unknown[]>({ type: 'config/device_registry/list' }),
      this.request<unknown[]>({ type: 'config/area_registry/list' }),
    ]);
    this.regs = {
      areas: (Array.isArray(areas) ? areas : []).map(record).filter((a) => str(a.area_id)).map((a) => ({ area_id: String(a.area_id), name: str(a.name) ?? String(a.area_id) })),
      devices: (Array.isArray(devices) ? devices : []).map(record).filter((d) => str(d.id)).map((d) => ({
        id: String(d.id),
        name: str(d.name),
        name_by_user: str(d.name_by_user),
        area_id: str(d.area_id),
        model: str(d.model),
        manufacturer: str(d.manufacturer),
        identifiers: (Array.isArray(d.identifiers) ? d.identifiers : [])
          .filter((i): i is unknown[] => Array.isArray(i) && i.length >= 2)
          .map((i) => [String(i[0]), String(i[1])] as [string, string]),
        via_device_id: str(d.via_device_id),
      })),
      entities: (Array.isArray(entities) ? entities : []).map(record).filter((e) => str(e.entity_id)).map((e) => ({
        entity_id: String(e.entity_id),
        device_id: str(e.device_id),
        area_id: str(e.area_id),
        platform: str(e.platform) ?? '',
        unique_id: e.unique_id === undefined || e.unique_id === null ? null : String(e.unique_id),
        disabled_by: str(e.disabled_by),
        hidden_by: str(e.hidden_by),
        original_name: str(e.original_name),
        name: str(e.name),
        entity_category: str(e.entity_category),
      })),
    };
  }

  private scheduleRegistryRefresh(): void {
    this.registryTimer?.cancel();
    const gen = this.generation;
    this.registryTimer = this.clock.setTimeout(() => {
      this.registryTimer = null;
      if (gen !== this.generation || !this.authed) return;
      this.fetchRegistries()
        .then(() => {
          if (gen !== this.generation) return;
          for (const cb of [...this.registryCbs]) {
            try {
              cb();
            } catch (e) {
              this.log.error(`registry listener failed: ${errorText(e)}`);
            }
          }
        })
        .catch((e) => this.log.warn(`registry refresh failed: ${errorText(e)}`));
    }, REGISTRY_DEBOUNCE_MS);
  }

  /* ── requests ──────────────────────────────────────────────────────────────────────────────── */

  /** A raw WebSocket command; resolves with `result`, rejects on an error result, close or timeout. */
  request<T = unknown>(payload: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    return this.requestWithId(++this.nextId, payload, timeoutMs) as Promise<T>;
  }

  private requestWithId(id: number, payload: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const socket = this.socket;
      if (!socket || !this.authed) {
        reject(new Error('Home Assistant is not connected'));
        return;
      }
      const timer = this.clock.setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`Home Assistant did not answer ${String(payload.type)} within ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ id, ...payload }));
      } catch (e) {
        this.pending.delete(id);
        timer.cancel();
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /* ── HaPort ────────────────────────────────────────────────────────────────────────────────── */

  onConnection(cb: (ok: boolean) => void): void {
    this.connectionCbs.push(cb);
  }

  onStateChanged(cb: (entityId: EntityId, next: HaStateObj | null, prev: HaStateObj | null) => void): void {
    this.stateCbs.push(cb);
  }

  onEvent(cb: (eventType: string, data: Record<string, unknown>, context: EventContext) => void): void {
    this.eventCbs.push(cb);
  }

  onRegistriesUpdated(cb: () => void): void {
    this.registryCbs.push(cb);
  }

  getState(entityId: EntityId): HaStateObj | undefined {
    return this.states.get(entityId);
  }

  allStates(): HaStateObj[] {
    return [...this.states.values()];
  }

  registries(): HaRegistries {
    return this.regs;
  }

  config(): HaConfigInfo | null {
    return this.info;
  }

  async callService(
    domain: string,
    service: string,
    target?: { entity_id?: EntityId | EntityId[] },
    data?: Record<string, unknown>,
    returnResponse = false,
  ): Promise<HaServiceResult> {
    const msg: Record<string, unknown> = { type: 'call_service', domain, service };
    if (target && Object.keys(target).length) msg.target = target;
    if (data && Object.keys(data).length) msg.service_data = data;
    if (returnResponse) msg.return_response = true;
    const res = record(await this.request(msg));
    const ctxId = str(record(res.context).id);
    return { context: ctxId ? { id: ctxId } : null, response: res.response ?? null };
  }

  async fireEvent(eventType: string, data: Record<string, unknown>): Promise<void> {
    await this.request({ type: 'fire_event', event_type: eventType, event_data: data });
  }

  /** Adds an event type to the subscription set (kept across reconnects). */
  async subscribeEvents(eventType: string): Promise<void> {
    this.eventTypes.add(eventType);
    if (this.authed) await this.subscribeOn(eventType, this.generation);
  }

  async subscribeTemplate(template: string, variables: Record<string, unknown>, cb: (result: unknown, error: string | null) => void): Promise<() => void> {
    const sub: TemplateSub = { template, variables, cb, subId: null };
    this.templates.add(sub);
    if (this.authed) await this.startTemplate(sub, this.generation);
    return () => this.stopTemplate(sub);
  }

  private stopTemplate(sub: TemplateSub): void {
    if (!this.templates.delete(sub)) return;
    const subId = sub.subId;
    sub.subId = null;
    if (subId === null) return;
    this.templateBySubId.delete(subId);
    if (this.authed) this.request({ type: 'unsubscribe_events', subscription: subId }).catch(() => undefined);
  }

  async history(
    entityIds: EntityId[],
    start: EpochMs,
    end: EpochMs,
    opts: { minimal: boolean; noAttributes: boolean },
  ): Promise<Record<EntityId, HistoryRow[]>> {
    if (!entityIds.length) return {};
    const raw = record(
      await this.request(
        {
          type: 'history/history_during_period',
          start_time: iso(start),
          end_time: iso(end),
          entity_ids: entityIds,
          minimal_response: opts.minimal,
          no_attributes: opts.noAttributes,
          significant_changes_only: false,
        },
        RECORDER_TIMEOUT_MS,
      ),
    );
    const out: Record<EntityId, HistoryRow[]> = {};
    for (const [id, rows] of Object.entries(raw)) {
      if (!Array.isArray(rows)) continue;
      out[id] = rows.map(record).map((r) => {
        const row: HistoryRow = { s: r.s === undefined || r.s === null ? 'unknown' : String(r.s), lu: num(r.lu) ?? num(r.lc) ?? 0 };
        if (r.a && typeof r.a === 'object') row.a = record(r.a);
        return row;
      });
    }
    return out;
  }

  async statistics(
    statIds: string[],
    start: EpochMs,
    end: EpochMs,
    period: '5minute' | 'hour' | 'day' | 'week',
    types: ('mean' | 'min' | 'max' | 'state' | 'sum' | 'change')[],
  ): Promise<Record<string, StatRow[]>> {
    if (!statIds.length) return {};
    const raw = record(
      await this.request(
        {
          type: 'recorder/statistics_during_period',
          start_time: iso(start),
          end_time: iso(end),
          statistic_ids: statIds,
          period,
          types,
          units: { temperature: '°C' },
        },
        RECORDER_TIMEOUT_MS,
      ),
    );
    const out: Record<string, StatRow[]> = {};
    for (const [id, rows] of Object.entries(raw)) {
      if (!Array.isArray(rows)) continue;
      out[id] = rows.map(record).flatMap((r) => {
        // HA ≥ 2023.3 sends epoch ms; older versions ISO strings
        const start = num(r.start) ?? (typeof r.start === 'string' ? Date.parse(r.start) : NaN);
        if (!Number.isFinite(start)) return [];
        return [{ start, mean: num(r.mean), min: num(r.min), max: num(r.max), state: num(r.state), sum: num(r.sum) }];
      });
    }
    return out;
  }

  /** HA users for the admin flag and display names (cached 5 min). */
  async authUsers(): Promise<AuthUser[]> {
    if (this.users && this.clock.now() - this.users.at < USERS_TTL_MS) return this.users.list;
    if (!this.ready) {
      if (this.users) return this.users.list;
      throw new Error('Home Assistant is not connected');
    }
    this.usersInflight ??= this.request<unknown[]>({ type: 'config/auth/list' })
      .then((rows) => {
        const list = (Array.isArray(rows) ? rows : []).map(record).filter((u) => str(u.id)).map((u) => {
          const groups = Array.isArray(u.group_ids) ? u.group_ids : [];
          return {
            id: String(u.id),
            name: str(u.name) ?? str(u.username) ?? String(u.id),
            // older HA versions report only the group; the owner is always an admin
            is_admin: u.is_admin === true || u.is_owner === true || groups.includes('system-admin'),
            system_generated: u.system_generated === true,
          };
        });
        this.users = { at: this.clock.now(), list };
        return list;
      })
      .finally(() => {
        this.usersInflight = null;
      });
    return this.usersInflight;
  }

  /**
   * Registers (or updates) a Lovelace module resource. A resource with the same base URL but another
   * query (version) is updated, so a new card version is not masked by the browser cache. YAML-mode
   * dashboards have no resource commands (`unknown_command`) → 'unsupported'; a timeout or a lost
   * connection is an error, retried on the next connect.
   */
  async ensureLovelaceResource(url: string): Promise<'created' | 'updated' | 'exists' | 'unsupported'> {
    if (!this.ready) throw new Error('Home Assistant is not connected');
    try {
      const base = url.split('?')[0];
      const list = await this.request<unknown[]>({ type: 'lovelace/resources' });
      const existing = (Array.isArray(list) ? list : []).map(record).find((r) => (str(r.url) ?? '').split('?')[0] === base);
      if (existing) {
        if (existing.url === url) return 'exists';
        await this.request({ type: 'lovelace/resources/update', resource_id: existing.id, res_type: 'module', url });
        return 'updated';
      }
      await this.request({ type: 'lovelace/resources/create', res_type: 'module', url });
      return 'created';
    } catch (e) {
      if (e instanceof HaCommandError && e.code === 'unknown_command') return 'unsupported';
      throw e;
    }
  }

  /** Service registry (`get_services`): domain → service → description. */
  async services(): Promise<Record<string, Record<string, unknown>>> {
    const raw = record(await this.request({ type: 'get_services' }));
    const out: Record<string, Record<string, unknown>> = {};
    for (const [domain, services] of Object.entries(raw)) out[domain] = record(services);
    return out;
  }
}

function toConfigInfo(v: unknown): HaConfigInfo {
  const c = record(v);
  const units = record(c.unit_system);
  return {
    time_zone: str(c.time_zone) ?? 'UTC',
    unit_system: { temperature: str(units.temperature) ?? '°C' },
    language: str(c.language) ?? 'en',
    version: str(c.version) ?? 'unknown',
    latitude: num(c.latitude) ?? 0,
    longitude: num(c.longitude) ?? 0,
  };
}
