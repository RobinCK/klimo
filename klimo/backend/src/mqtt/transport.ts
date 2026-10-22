import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { connect, type IClientOptions, type MqttClient } from 'mqtt';
import type { Env } from '../env';
import { errorText, LogOnce } from '../common/logger';
import type { ISupervisor, MqttStatus, MqttTransport } from '../shared/model';

/** Availability of every Klimo entity: `online` while connected, `offline` as the broker's last will. */
export const STATUS_TOPIC = 'klimo/status';

const RECONNECT_MS = 5_000;
const CONNECT_TIMEOUT_MS = 10_000;
const END_TIMEOUT_MS = 2_000;

export interface BrokerSettings {
  host: string;
  port: number;
  username: string | null;
  password: string | null;
  source: 'options' | 'supervisor';
}

export interface TransportInfo {
  started: boolean;
  broker: string | null;
  source: MqttStatus['source'];
  lastError: string | null;
}

/** A transport that connects to a broker found at runtime (the real client; the simulator's runs in-process). */
export interface BrokerTransport extends MqttTransport {
  start(broker: BrokerSettings): void;
  info(): TransportInfo;
}

export function isBrokerTransport(t: MqttTransport): t is BrokerTransport {
  const c = t as Partial<BrokerTransport>;
  return typeof c.start === 'function' && typeof c.info === 'function';
}

/** Broker from the add-on options or `KLIMO_MQTT_*` (both land in `env.mqtt`). */
export function brokerFromOptions(mqtt: Env['mqtt']): BrokerSettings | null {
  if (!mqtt.host) return null;
  return { host: mqtt.host, port: mqtt.port ?? 1883, username: mqtt.user ?? null, password: mqtt.password ?? null, source: 'options' };
}

/**
 * Where the broker is: explicit options win (an external broker), then the Supervisor's MQTT service
 * (the Mosquitto add-on, `services: mqtt:want`). Null leaves MQTT dormant.
 */
export async function resolveBroker(mqtt: Env['mqtt'], supervisor: Pick<ISupervisor, 'mqttService'> | null): Promise<BrokerSettings | null> {
  const explicit = brokerFromOptions(mqtt);
  if (explicit) return explicit;
  const service = supervisor ? await supervisor.mqttService().catch(() => null) : null;
  if (!service?.host) return null;
  return { host: service.host, port: service.port || 1883, username: service.username, password: service.password, source: 'supervisor' };
}

/** `klimo-` + 6 random hex characters: two add-on instances on one broker never kick each other off. */
export function newClientId(): string {
  return `klimo-${randomBytes(3).toString('hex')}`;
}

/**
 * mqtt.js client behind the `MqttTransport` seam. Stays idle until `start()` with a broker; then it
 * keeps reconnecting every 5 s. The broker publishes the retained `offline` will when the add-on dies;
 * a clean shutdown publishes it itself before disconnecting.
 */
@Injectable()
export class MqttJsTransport implements BrokerTransport, OnModuleDestroy {
  private readonly log = new Logger('MQTT');
  private readonly once = new LogOnce(this.log);
  private client: MqttClient | null = null;
  private broker: BrokerSettings | null = null;
  private lastError: string | null = null;
  private wasConnected = false;
  private readonly messageCbs: ((topic: string, payload: string) => void)[] = [];
  private readonly connectCbs: (() => void)[] = [];
  private readonly closeCbs: (() => void)[] = [];

  get connected(): boolean {
    return !!this.client?.connected;
  }

  info(): TransportInfo {
    return {
      started: !!this.client,
      broker: this.broker ? `${this.broker.host}:${this.broker.port}` : null,
      source: this.broker?.source ?? 'none',
      lastError: this.lastError,
    };
  }

  start(broker: BrokerSettings): void {
    if (this.client) return;
    this.broker = broker;
    const options: IClientOptions = {
      clientId: newClientId(),
      username: broker.username ?? undefined,
      password: broker.password ?? undefined,
      reconnectPeriod: RECONNECT_MS,
      connectTimeout: CONNECT_TIMEOUT_MS,
      clean: true,
      will: { topic: STATUS_TOPIC, payload: Buffer.from('offline'), retain: true, qos: 1 },
    };
    const url = `mqtt://${broker.host}:${broker.port}`;
    this.log.log(`Connecting to ${url} (${broker.source})`);
    const client = connect(url, options);
    this.client = client;

    client.on('connect', () => {
      this.wasConnected = true;
      this.lastError = null;
      this.once.reset('error');
      this.log.log(`Connected to ${url}`);
      client.publish(STATUS_TOPIC, 'online', { retain: true, qos: 1 });
      for (const cb of this.connectCbs) this.safe(() => cb());
    });
    client.on('message', (topic, payload) => {
      const text = payload.toString('utf8');
      for (const cb of this.messageCbs) this.safe(() => cb(topic, text));
    });
    // 'close' also fires for every failed reconnect attempt and for our own stop; listeners only hear
    // the loss of a live link
    client.on('close', () => {
      if (!this.wasConnected || this.client !== client) return;
      this.wasConnected = false;
      this.log.warn('Disconnected from the broker, retrying every 5 s');
      for (const cb of this.closeCbs) this.safe(() => cb());
    });
    client.on('error', (e) => {
      this.lastError = e.message;
      this.once.warn('error', `MQTT error: ${e.message}`);
    });
  }

  publish(topic: string, payload: string, opts: { retain: boolean; qos: 0 | 1 }): Promise<void> {
    const client = this.client;
    if (!client?.connected) return Promise.reject(new Error('MQTT is not connected'));
    return new Promise((resolve, reject) => {
      client.publish(topic, payload, { retain: opts.retain, qos: opts.qos }, (err) => (err ? reject(err) : resolve()));
    });
  }

  subscribe(topics: string[]): Promise<void> {
    const client = this.client;
    if (!client?.connected || !topics.length) return Promise.resolve();
    return new Promise((resolve, reject) => {
      client.subscribe(topics, { qos: 0 }, (err) => (err ? reject(err) : resolve()));
    });
  }

  onMessage(cb: (topic: string, payload: string) => void): void {
    this.messageCbs.push(cb);
  }

  onConnect(cb: () => void): void {
    this.connectCbs.push(cb);
  }

  onClose(cb: () => void): void {
    this.closeCbs.push(cb);
  }

  async end(): Promise<void> {
    const client = this.client;
    if (!client) return;
    this.client = null;
    if (client.connected) {
      // the will only fires on an unclean disconnect, so a clean stop announces itself
      await withTimeout(
        new Promise<void>((resolve) => client.publish(STATUS_TOPIC, 'offline', { retain: true, qos: 1 }, () => resolve())),
        END_TIMEOUT_MS,
      );
    }
    await withTimeout(new Promise<void>((resolve) => client.end(false, {}, () => resolve())), END_TIMEOUT_MS);
  }

  async onModuleDestroy(): Promise<void> {
    await this.end().catch((e: unknown) => this.log.warn(`MQTT shutdown: ${errorText(e)}`));
  }

  private safe(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.log.error(`MQTT listener failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    }
  }
}

function withTimeout(p: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    p.then(
      () => {
        clearTimeout(t);
        resolve();
      },
      () => {
        clearTimeout(t);
        resolve();
      },
    );
  });
}
