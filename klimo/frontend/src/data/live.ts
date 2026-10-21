/**
 * The live store: one WebSocket per tab, topic subscriptions, and immutable slices that
 * components read through useSyncExternalStore. Unchanged slices keep their identity, so a
 * component re-renders only when the slice it selected changed.
 *
 * Connection policy: reconnect with a 1 → 10 s backoff, re-subscribe, re-fetch the overview
 * (and let open resources reload) after a reconnect, and poll the house state every 10 s while
 * the socket is down so the header can say how fresh the numbers are.
 */
import type {
  ConfigEntityName,
  CreateRoomReport,
  EngineHealth,
  EpochMs,
  HouseState,
  Id,
  IncidentDto,
  JournalEntry,
  PlantState,
  RoomState,
  RoomSummary,
  RunSpan,
  SentMessage,
  SimScenarioId,
  SourceTestResult,
  WsClientMessage,
  WsServerMessage,
  WsTopic,
} from '@api/model';
import { api } from '@api/endpoints';
import { setFormatContext } from '@i18n';

type Msg<T extends WsServerMessage['type']> = Extract<WsServerMessage, { type: T }>;

export type SyncSlice = Msg<'sync'>['payload'];
export type CommandResult = Msg<'command.result'>['payload'];
export type ConfigEvent = Msg<'config'>['payload'];
export type IncidentEvent = Msg<'incident'>['payload'];
export type Hello = Msg<'hello'>;
export interface SimClock {
  now: EpochMs;
  speed: number;
  paused: boolean;
  scenario: SimScenarioId;
  /** Browser time when `now` was received (for extrapolation). */
  receivedAt: number;
}

export type ConnectionStatus = 'connecting' | 'open' | 'closed';

export interface LiveState {
  status: ConnectionStatus;
  /** At least one socket has opened since the page loaded. */
  everConnected: boolean;
  /** Server time of the freshest house state (socket or polling). */
  lastUpdateAt: EpochMs | null;
  hello: Hello | null;
  house: HouseState | null;
  rooms: ReadonlyMap<Id, RoomSummary>;
  /** Rooms in their display order. */
  roomList: readonly RoomSummary[];
  roomsLoaded: boolean;
  plant: PlantState | null;
  room: Readonly<Record<Id, RoomState>>;
  /** Incidents seen on the socket (upserts), by id. */
  incidents: ReadonlyMap<Id, IncidentDto>;
  incidentTick: number;
  journalTick: number;
  lastJournal: JournalEntry | null;
  spanTick: number;
  configTick: Readonly<Partial<Record<ConfigEntityName, number>>>;
  configSeq: number;
  /** Sync progress of a room's devices, by room id ('_' for changes without a room). */
  sync: Readonly<Record<Id, SyncSlice>>;
  commandResults: Readonly<Record<string, CommandResult>>;
  ha: { connected: boolean; health: EngineHealth } | null;
  sim: SimClock | null;
  wizard: Readonly<Record<Id, CreateRoomReport>>;
  sourceTest: Readonly<Record<Id, SourceTestResult>>;
  lastNotify: SentMessage | null;
  /** Increments after every successful re-connection (not the first connection). */
  reconnectSeq: number;
}

const INITIAL: LiveState = {
  status: 'connecting',
  everConnected: false,
  lastUpdateAt: null,
  hello: null,
  house: null,
  rooms: new Map(),
  roomList: [],
  roomsLoaded: false,
  plant: null,
  room: {},
  incidents: new Map(),
  incidentTick: 0,
  journalTick: 0,
  lastJournal: null,
  spanTick: 0,
  configTick: {},
  configSeq: 0,
  sync: {},
  commandResults: {},
  ha: null,
  sim: null,
  wizard: {},
  sourceTest: {},
  lastNotify: null,
  reconnectSeq: 0,
};

export type LiveEvents = {
  journal: JournalEntry;
  span: RunSpan;
  config: ConfigEvent;
  incident: IncidentEvent;
  'command.result': CommandResult;
  'wizard.report': CreateRoomReport;
  'source.test': SourceTestResult;
  'notify.sent': SentMessage;
  sync: SyncSlice;
  reconnect: number;
};
export type LiveEventName = keyof LiveEvents;

const PING_MS = 25_000;
const POLL_MS = 10_000;
const MAX_BACKOFF_MS = 10_000;
const COMMAND_RESULTS_KEPT = 50;

const sortRooms = (m: ReadonlyMap<Id, RoomSummary>) => [...m.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));

export class LiveStore {
  private state: LiveState = INITIAL;
  private readonly listeners = new Set<() => void>();
  private readonly events = new Map<LiveEventName, Set<(payload: never) => void>>();
  private readonly topics = new Map<WsTopic, number>();
  private ws: WebSocket | null = null;
  private started = false;
  private backoff = 1000;
  private reconnectTimer: number | undefined;
  private pingTimer: number | undefined;
  private pollTimer: number | undefined;
  private roomsRefetchTimer: number | undefined;
  private clockOffset = 0;
  private bootstrapping: Promise<void> | null = null;
  private plantLoading = false;

  /* ---------- store protocol ---------- */

  getState = (): LiveState => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.start();
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  private set(patch: Partial<LiveState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  on<K extends LiveEventName>(name: K, fn: (payload: LiveEvents[K]) => void): () => void {
    let set = this.events.get(name);
    if (!set) this.events.set(name, (set = new Set()));
    set.add(fn as (payload: never) => void);
    return () => set?.delete(fn as (payload: never) => void);
  }

  private emit<K extends LiveEventName>(name: K, payload: LiveEvents[K]): void {
    const set = this.events.get(name);
    if (set) for (const fn of [...set]) (fn as (p: LiveEvents[K]) => void)(payload);
  }

  /* ---------- clock ---------- */

  /** Server-aligned now; in the simulator the accelerated simulation clock. */
  now = (): EpochMs => {
    const sim = this.state.sim;
    if (sim) return sim.paused ? sim.now : Math.round(sim.now + (Date.now() - sim.receivedAt) * sim.speed);
    return Date.now() + this.clockOffset;
  };

  private syncClock(serverNow: EpochMs | undefined): void {
    if (typeof serverNow === 'number' && Number.isFinite(serverNow)) this.clockOffset = serverNow - Date.now();
  }

  /* ---------- topics ---------- */

  /** Reference-counted opt-in topic (plant, room:<id>, sim). Returns the release function. */
  retain(topic: WsTopic): () => void {
    this.start();
    const n = this.topics.get(topic) ?? 0;
    this.topics.set(topic, n + 1);
    if (n === 0) this.send({ type: 'subscribe', topics: [topic] });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.topics.get(topic) ?? 1) - 1;
      if (left <= 0) {
        this.topics.delete(topic);
        this.send({ type: 'unsubscribe', topics: [topic] });
      } else this.topics.set(topic, left);
    };
  }

  private send(msg: WsClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /* ---------- lifecycle ---------- */

  start(): void {
    if (this.started || typeof window === 'undefined') return;
    this.started = true;
    setFormatContext({ now: this.now });
    void this.bootstrap();
    this.connect();
    document.addEventListener('visibilitychange', this.onVisible);
  }

  private onVisible = (): void => {
    // a phone that slept may hold a dead socket; check right away instead of waiting for backoff
    if (document.visibilityState === 'visible' && this.state.status !== 'open') {
      window.clearTimeout(this.reconnectTimer);
      this.backoff = 1000;
      this.connect();
    }
  };

  private connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    let ws: WebSocket;
    try {
      const url = new URL('./api/ws', window.location.href);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.hash = '';
      ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    if (this.state.status !== 'connecting' && !this.state.everConnected) this.set({ status: 'connecting' });

    ws.onopen = () => {
      const reconnect = this.state.everConnected;
      this.backoff = 1000;
      this.stopPolling();
      this.set({ status: 'open', everConnected: true, reconnectSeq: reconnect ? this.state.reconnectSeq + 1 : this.state.reconnectSeq });
      if (this.topics.size) this.send({ type: 'subscribe', topics: [...this.topics.keys()] });
      window.clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.send({ type: 'ping', t: Date.now() }), PING_MS);
      if (reconnect) {
        void this.bootstrap(true);
        this.emit('reconnect', this.state.reconnectSeq);
      }
    };
    ws.onmessage = (ev) => {
      let msg: WsServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as WsServerMessage;
      } catch {
        return;
      }
      this.handle(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      window.clearInterval(this.pingTimer);
      this.set({ status: 'closed' });
      this.startPolling();
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose follows and handles the retry
    };
  }

  private scheduleReconnect(): void {
    window.clearTimeout(this.reconnectTimer);
    const delay = this.backoff;
    this.backoff = Math.min(MAX_BACKOFF_MS, this.backoff * 2);
    this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
  }

  private startPolling(): void {
    if (this.pollTimer !== undefined) return;
    const poll = async () => {
      // the add-on may have been starting when the page loaded; fetch the rest once it answers
      if (!this.state.roomsLoaded) void this.bootstrap();
      try {
        const house = await api.house.state();
        this.syncClock(house.now);
        this.set({ house, lastUpdateAt: house.now });
      } catch {
        /* still down — the banner shows how old the data is */
      }
    };
    this.pollTimer = window.setInterval(poll, POLL_MS);
  }

  private stopPolling(): void {
    window.clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  /** The overview in one call: house, rooms and plant. Also run after every reconnect. */
  bootstrap(force = false): Promise<void> {
    if (this.bootstrapping && !force) return this.bootstrapping;
    const run = (async () => {
      try {
        const o = await api.overview();
        this.syncClock(o.house.now);
        setFormatContext({ tz: o.house.tz });
        const rooms = new Map(o.rooms.map((r) => [r.id, r] as const));
        this.set({ house: o.house, lastUpdateAt: o.house.now, plant: o.plant, rooms, roomList: sortRooms(rooms), roomsLoaded: true });
      } catch {
        // the socket may still bring the state; a later reconnect retries the overview
      } finally {
        this.bootstrapping = null;
      }
    })();
    this.bootstrapping = run;
    return run;
  }

  /** Plant state for screens that subscribe to it (the socket only pushes changes). */
  async loadPlant(): Promise<void> {
    if (this.plantLoading) return;
    this.plantLoading = true;
    try {
      this.set({ plant: await api.plant() });
    } catch {
      /* retried on the next mount or reconnect */
    } finally {
      this.plantLoading = false;
    }
  }

  /** Re-read the room list (names and order change through config writes, not evaluations). */
  refetchRooms(): void {
    window.clearTimeout(this.roomsRefetchTimer);
    this.roomsRefetchTimer = window.setTimeout(async () => {
      try {
        const list = await api.rooms.list();
        const rooms = new Map(list.map((r) => [r.id, r] as const));
        this.set({ rooms, roomList: sortRooms(rooms), roomsLoaded: true });
      } catch {
        /* keep what we have */
      }
    }, 250);
  }

  /** A mutation that returns a fresh room state can publish it without waiting for the socket. */
  putRoomState(state: RoomState): void {
    this.set({ room: { ...this.state.room, [state.roomId]: state } });
  }

  putHouse(house: HouseState): void {
    this.syncClock(house.now);
    this.set({ house, lastUpdateAt: house.now });
  }

  /* ---------- messages ---------- */

  private handle(msg: WsServerMessage): void {
    switch (msg.type) {
      case 'hello':
        this.syncClock(msg.serverTime);
        setFormatContext({ tz: msg.tz });
        this.set({ hello: msg });
        return;
      case 'pong':
        return;
      case 'house':
        this.syncClock(msg.payload.now);
        setFormatContext({ tz: msg.payload.tz });
        this.set({ house: msg.payload, lastUpdateAt: msg.payload.now });
        return;
      case 'rooms': {
        if (!msg.payload.length) return;
        const rooms = new Map(this.state.rooms);
        for (const r of msg.payload) rooms.set(r.id, r);
        this.set({ rooms, roomList: sortRooms(rooms) });
        return;
      }
      case 'plant':
        this.set({ plant: msg.payload });
        return;
      case 'room':
        this.set({ room: { ...this.state.room, [msg.payload.roomId]: msg.payload } });
        return;
      case 'sync':
        this.set({ sync: { ...this.state.sync, [msg.payload.roomId ?? '_']: msg.payload } });
        this.emit('sync', msg.payload);
        return;
      case 'command.result': {
        const results = { ...this.state.commandResults, [msg.payload.reqId]: msg.payload };
        const keys = Object.keys(results);
        if (keys.length > COMMAND_RESULTS_KEPT) for (const k of keys.slice(0, keys.length - COMMAND_RESULTS_KEPT)) delete results[k];
        this.set({ commandResults: results });
        this.emit('command.result', msg.payload);
        return;
      }
      case 'incident': {
        const incidents = new Map(this.state.incidents);
        if (msg.payload.op === 'remove') incidents.delete(msg.payload.incident.id);
        else incidents.set(msg.payload.incident.id, msg.payload.incident);
        this.set({ incidents, incidentTick: this.state.incidentTick + 1 });
        this.emit('incident', msg.payload);
        return;
      }
      case 'journal':
        this.set({ journalTick: this.state.journalTick + 1, lastJournal: msg.payload });
        this.emit('journal', msg.payload);
        return;
      case 'span':
        this.set({ spanTick: this.state.spanTick + 1 });
        this.emit('span', msg.payload);
        return;
      case 'config': {
        const { entity, id, op } = msg.payload;
        const patch: Partial<LiveState> = {
          configTick: { ...this.state.configTick, [entity]: (this.state.configTick[entity] ?? 0) + 1 },
          configSeq: this.state.configSeq + 1,
        };
        if (entity === 'room' && op === 'deleted' && id) {
          const rooms = new Map(this.state.rooms);
          rooms.delete(id);
          const room = { ...this.state.room };
          delete room[id];
          Object.assign(patch, { rooms, roomList: sortRooms(rooms), room });
        }
        this.set(patch);
        if (entity === 'room' || op === 'imported') this.refetchRooms();
        this.emit('config', msg.payload);
        return;
      }
      case 'wizard.report':
        this.set({ wizard: { ...this.state.wizard, [msg.payload.reportId]: msg.payload } });
        this.emit('wizard.report', msg.payload);
        return;
      case 'source.test':
        this.set({ sourceTest: { ...this.state.sourceTest, [msg.payload.sourceId]: msg.payload } });
        this.emit('source.test', msg.payload);
        return;
      case 'notify.sent':
        this.set({ lastNotify: msg.payload });
        this.emit('notify.sent', msg.payload);
        return;
      case 'ha': {
        const house = this.state.house
          ? { ...this.state.house, engine: { ...this.state.house.engine, haConnected: msg.payload.connected, health: msg.payload.health } }
          : null;
        this.set({ ha: msg.payload, house });
        return;
      }
      case 'sim':
        this.set({ sim: { ...msg.payload, receivedAt: Date.now() } });
        return;
    }
  }
}

/** The one store of this tab. */
export const liveStore = new LiveStore();
