import { Injectable, Logger } from '@nestjs/common';
import type { MqttTransport } from '../shared/model';

/** `+` matches one level, a trailing `#` the rest (including nothing), as in MQTT 3.1.1. */
export function topicMatches(filter: string, topic: string): boolean {
  if (filter === topic) return true;
  const f = filter.split('/');
  const t = topic.split('/');
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return i === f.length - 1;
    if (i >= t.length) return false;
    if (f[i] !== '+' && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

/** Who published a message on the in-process broker. */
export type MqttOrigin = 'klimo' | 'ha' | 'z2m';

/** Anything that can watch all broker traffic and publish as another client (the fake HA, Z2M). */
export interface MqttTap {
  tap(cb: (topic: string, payload: string, origin: MqttOrigin) => void): void;
  inject(topic: string, payload: string, opts: { retain: boolean; origin: MqttOrigin }): Promise<void>;
  retained(filter: string): { topic: string; payload: string }[];
}

export function isMqttTap(t: unknown): t is MqttTap {
  const c = t as Partial<MqttTap> | null;
  return !!c && typeof c.tap === 'function' && typeof c.inject === 'function' && typeof c.retained === 'function';
}

interface Delivery {
  topic: string;
  payload: string;
  origin: MqttOrigin;
}

/**
 * The simulator's in-process MQTT broker and Klimo's client on it in one: retained topics, wildcard
 * subscriptions, retained delivery on subscribe. The fake Home Assistant and the fake Zigbee2MQTT are the
 * other clients — they see all traffic through `tap` and publish with `inject`. Delivery is asynchronous
 * and ordered, like a network, so nobody re-enters a publisher.
 */
@Injectable()
export class SimMqtt implements MqttTransport, MqttTap {
  private readonly log = new Logger('SimMqtt');
  private online = true;
  private readonly retainedMap = new Map<string, string>();
  private readonly subscriptions = new Set<string>();
  private readonly messageCbs: ((topic: string, payload: string, retained?: boolean) => void)[] = [];
  private readonly connectCbs: (() => void)[] = [];
  private readonly closeCbs: (() => void)[] = [];
  private readonly taps: ((topic: string, payload: string, origin: MqttOrigin) => void)[] = [];
  private queue: Delivery[] = [];
  private draining = false;

  get connected(): boolean {
    return this.online;
  }

  async publish(topic: string, payload: string, opts: { retain: boolean; qos: 0 | 1 }): Promise<void> {
    if (!this.online) throw new Error('in-process broker is down');
    this.accept({ topic, payload, origin: 'klimo' }, opts.retain);
  }

  async subscribe(topics: string[]): Promise<void> {
    const fresh = topics.filter((t) => !this.subscriptions.has(t));
    for (const t of fresh) this.subscriptions.add(t);
    // a broker hands retained messages to a new subscription
    for (const [topic, payload] of this.retainedMap) {
      if (fresh.some((f) => topicMatches(f, topic))) this.enqueue({ topic, payload, origin: 'ha' }, 'klimo-only');
    }
  }

  onMessage(cb: (topic: string, payload: string, retained?: boolean) => void): void {
    this.messageCbs.push(cb);
  }

  onConnect(cb: () => void): void {
    this.connectCbs.push(cb);
  }

  onClose(cb: () => void): void {
    this.closeCbs.push(cb);
  }

  async end(): Promise<void> {
    if (!this.online) return;
    this.online = false;
    this.queue = [];
    for (const cb of this.closeCbs) cb();
  }

  /* ── other clients ───────────────────────────────────────────────────────────────────────────── */

  tap(cb: (topic: string, payload: string, origin: MqttOrigin) => void): void {
    this.taps.push(cb);
  }

  async inject(topic: string, payload: string, opts: { retain: boolean; origin: MqttOrigin }): Promise<void> {
    if (!this.online) return;
    this.accept({ topic, payload, origin: opts.origin }, opts.retain);
  }

  retained(filter: string): { topic: string; payload: string }[] {
    return [...this.retainedMap].filter(([t]) => topicMatches(filter, t)).map(([topic, payload]) => ({ topic, payload }));
  }

  /* ── delivery ──────────────────────────────────────────────────────────────────────────────── */

  private accept(d: Delivery, retain: boolean): void {
    if (retain) {
      // an empty retained message clears the topic
      if (d.payload === '') this.retainedMap.delete(d.topic);
      else this.retainedMap.set(d.topic, d.payload);
    }
    this.enqueue(d, 'all');
  }

  private readonly scope = new WeakMap<Delivery, 'all' | 'klimo-only'>();

  private enqueue(d: Delivery, scope: 'all' | 'klimo-only'): void {
    this.scope.set(d, scope);
    this.queue.push(d);
    if (this.draining) return;
    this.draining = true;
    setImmediate(() => this.drain());
  }

  private drain(): void {
    const batch = this.queue;
    this.queue = [];
    for (const d of batch) {
      const scope = this.scope.get(d) ?? 'all';
      if (scope === 'all') {
        for (const tap of this.taps) this.safely(() => tap(d.topic, d.payload, d.origin));
      }
      if ([...this.subscriptions].some((f) => topicMatches(f, d.topic))) {
        // a replay to a new subscription carries the retain flag, as a real broker sets it
        const retained = scope === 'klimo-only';
        for (const cb of this.messageCbs) this.safely(() => cb(d.topic, d.payload, retained));
      }
    }
    if (this.queue.length) setImmediate(() => this.drain());
    else this.draining = false;
  }

  private safely(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.log.warn(`message handler failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
