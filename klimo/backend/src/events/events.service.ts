import { Inject, Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import type { IncomingMessage, Server } from 'http';
import { performance } from 'perf_hooks';
import { WebSocket, WebSocketServer } from 'ws';
import { appVersion, env } from '../env';
import type { ClockPort, IBus, IEvents, RoomSummary, WsClientMessage, WsServerMessage, WsTopic } from '../shared/model';
import { BUS, CLOCK } from '../tokens';

type MessageOf<T extends WsServerMessage['type']> = Extract<WsServerMessage, { type: T }>;

interface Client {
  ws: WebSocket;
  topics: Set<string>;
  alive: boolean;
}

/** Throttle slot: at most one message per `intervalMs`; the latest value wins. */
interface Slot {
  intervalMs: number;
  lastSentAt: number;
  pending: WsServerMessage | null;
  timer: NodeJS.Timeout | null;
}

const OPT_IN_PREFIXES = ['plant', 'room:', 'sim'];
const HEARTBEAT_MS = 30_000;

function isOptIn(topic: string): boolean {
  return OPT_IN_PREFIXES.some((p) => (p.endsWith(':') ? topic.startsWith(p) : topic === p));
}

/** Topic a message is filtered by; null = delivered to every client. */
function topicOf(msg: WsServerMessage): string | null {
  switch (msg.type) {
    case 'plant': return 'plant';
    case 'room': return `room:${msg.payload.roomId}`;
    case 'sim': return 'sim';
    default: return null;
  }
}

/** Throttle key and interval; null = sent immediately. */
function throttleOf(msg: WsServerMessage): { key: string; ms: number } | null {
  switch (msg.type) {
    case 'house': return { key: 'house', ms: 1000 };
    case 'rooms': return { key: 'rooms', ms: 1000 };
    case 'plant': return { key: 'plant', ms: 1000 };
    case 'room': return { key: `room:${msg.payload.roomId}`, ms: 500 };
    case 'source.test': return { key: `source.test:${msg.payload.sourceId}`, ms: 1000 };
    case 'sim': return { key: 'sim', ms: 1000 };
    default: return null;
  }
}

/** `rooms` carries only changed summaries, so pending batches are merged by room instead of replaced. */
function mergeRooms(prev: MessageOf<'rooms'>, next: MessageOf<'rooms'>): MessageOf<'rooms'> {
  const byId = new Map<string, RoomSummary>();
  for (const r of prev.payload) byId.set(r.id, r);
  for (const r of next.payload) byId.set(r.id, r);
  return { type: 'rooms', payload: [...byId.values()] };
}

function parseClientMessage(raw: string): WsClientMessage | null {
  try {
    const m: unknown = JSON.parse(raw);
    if (!m || typeof m !== 'object') return null;
    const type = (m as { type?: unknown }).type;
    if (type === 'ping') return { type, t: Number((m as { t?: unknown }).t) || 0 };
    if (type === 'subscribe' || type === 'unsubscribe') {
      const topics = (m as { topics?: unknown }).topics;
      if (!Array.isArray(topics)) return null;
      return { type, topics: topics.filter((t): t is WsTopic => typeof t === 'string' && t.length <= 80) };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The live channel to the SPA at `/api/ws`. Implicit topics (house, rooms, incidents, journal, config,
 * sync, command results, ha…) reach every client; `plant`, `room:<id>` and `sim` only clients that
 * subscribed. Chatty messages are throttled per key with the latest value winning, so a burst of
 * evaluations never floods a phone on a weak connection.
 */
@Injectable()
export class EventsService implements IEvents, OnModuleDestroy {
  private readonly log = new Logger('Events');
  private wss: WebSocketServer | null = null;
  private readonly clients = new Set<Client>();
  private readonly slots = new Map<string, Slot>();
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Optional() @Inject(BUS) bus?: IBus,
  ) {
    // REST and MQTT control actions report their outcome on the bus; the page that sent one (or another
    // tab) learns it here
    bus?.on('command.result', ({ reqId, ok, code, error }) => this.send({ type: 'command.result', payload: { reqId, ok, code, error } }));
  }

  attach(server: Server): void {
    if (this.wss) return;
    this.wss = new WebSocketServer({ server, path: '/api/ws' });
    this.wss.on('connection', (ws: WebSocket, _req: IncomingMessage) => this.onConnection(ws));
    this.wss.on('error', (e) => this.log.warn(`websocket server: ${e.message}`));
    // drop half-open sockets (phone went to sleep) so throttled fan-out does not pile up behind them
    this.heartbeat = setInterval(() => this.sweep(), HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  clientCount(): number {
    return this.clients.size;
  }

  send(msg: WsServerMessage): void {
    const t = throttleOf(msg);
    if (!t) {
      this.deliver(msg);
      return;
    }
    let slot = this.slots.get(t.key);
    if (!slot) {
      slot = { intervalMs: t.ms, lastSentAt: -Infinity, pending: null, timer: null };
      this.slots.set(t.key, slot);
    }
    const now = performance.now();
    if (!slot.timer && now - slot.lastSentAt >= slot.intervalMs) {
      slot.lastSentAt = now;
      this.deliver(msg);
      return;
    }
    slot.pending =
      slot.pending && slot.pending.type === 'rooms' && msg.type === 'rooms' ? mergeRooms(slot.pending, msg) : msg;
    if (!slot.timer) {
      const s = slot;
      s.timer = setTimeout(() => {
        s.timer = null;
        const pending = s.pending;
        s.pending = null;
        if (pending) {
          s.lastSentAt = performance.now();
          this.deliver(pending);
        }
      }, Math.max(0, s.lastSentAt + s.intervalMs - now));
    }
  }

  onModuleDestroy(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const s of this.slots.values()) if (s.timer) clearTimeout(s.timer);
    this.slots.clear();
    for (const c of this.clients) c.ws.terminate();
    this.clients.clear();
    this.wss?.close();
    this.wss = null;
  }

  private onConnection(ws: WebSocket): void {
    const client: Client = { ws, topics: new Set(), alive: true };
    this.clients.add(client);
    ws.on('pong', () => {
      client.alive = true;
    });
    ws.on('message', (data) => {
      client.alive = true;
      const msg = parseClientMessage(data.toString());
      if (msg) this.onClientMessage(client, msg);
    });
    ws.on('close', () => this.clients.delete(client));
    ws.on('error', () => this.clients.delete(client));
    this.write(client, {
      type: 'hello',
      v: 1,
      serverTime: this.clock.now(),
      tz: this.clock.tz(),
      simulated: env.simulate,
      version: appVersion(),
    });
  }

  private onClientMessage(client: Client, msg: WsClientMessage): void {
    switch (msg.type) {
      case 'ping':
        this.write(client, { type: 'pong', t: msg.t });
        return;
      case 'subscribe':
        for (const t of msg.topics) if (isOptIn(t)) client.topics.add(t);
        return;
      case 'unsubscribe':
        for (const t of msg.topics) client.topics.delete(t);
        return;
    }
  }

  private deliver(msg: WsServerMessage): void {
    if (!this.clients.size) return;
    const topic = topicOf(msg);
    const data = JSON.stringify(msg);
    for (const c of this.clients) {
      if (topic && !c.topics.has(topic)) continue;
      if (c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
    }
  }

  private write(client: Client, msg: WsServerMessage): void {
    if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(msg));
  }

  private sweep(): void {
    for (const c of this.clients) {
      if (!c.alive) {
        c.ws.terminate();
        this.clients.delete(c);
        continue;
      }
      c.alive = false;
      try {
        c.ws.ping();
      } catch {
        this.clients.delete(c);
      }
    }
  }
}
