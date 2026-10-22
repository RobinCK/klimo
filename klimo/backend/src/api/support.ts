import { HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ApiException, notFound } from '../common/http';
import { errorText } from '../common/logger';
import { lazyRef } from '../common/refs';
import { toLocal } from '../engine/core/time';
import { env } from '../env';
import type { Actor, ActorVia, ClockPort, EpochMs, HaPort, IBus, ICardDeploy, ICoreFns, IEngine, IMqtt, LocalDate, MqttStatus, SettingsBundle } from '../shared/model';
import { BUS, CARD_DEPLOY, CLOCK, CORE, ENGINE, MQTT } from '../tokens';

/** How long a repeated `reqId` returns the first answer instead of acting twice. */
export const REQ_ID_TTL_MS = 60_000;

/** The value, or 404 naming what was looked for. */
export function found<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw notFound(what);
  return value;
}

/** Today in the house's time zone (default date of day views). */
export function localToday(clock: ClockPort): LocalDate {
  return toLocal(clock.now(), clock.tz()).date;
}

/** 503 for actions that need a live Home Assistant call (config writes and control actions never do). */
export function requireHa(ha: HaPort): void {
  if (!ha.connected) throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, 'ha_unavailable');
}

/**
 * Handles to the areas the API reaches late: the engine shell and the pure core are wired after the
 * services that already serve most routes, and MQTT / the card deployment are optional (no broker,
 * detached start). A missing engine answers 503 instead of breaking the whole REST surface.
 */
@Injectable()
export class ApiRefs {
  private readonly log = new Logger('Api');
  private readonly engineRef: () => IEngine | null;
  private readonly coreRef: () => ICoreFns | null;
  private readonly mqttRef: () => IMqtt | null;
  private readonly cardsRef: () => ICardDeploy | null;

  constructor(@Optional() moduleRef?: ModuleRef) {
    this.engineRef = lazyRef<IEngine>(moduleRef, ENGINE);
    this.coreRef = lazyRef<ICoreFns>(moduleRef, CORE);
    this.mqttRef = lazyRef<IMqtt>(moduleRef, MQTT);
    this.cardsRef = lazyRef<ICardDeploy>(moduleRef, CARD_DEPLOY);
  }

  engine(): IEngine | null {
    return this.engineRef();
  }

  requireEngine(): IEngine {
    const e = this.engineRef();
    if (!e) throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, 'internal', 'The control engine is not running');
    return e;
  }

  requireCore(): ICoreFns {
    const c = this.coreRef();
    if (!c) throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, 'internal', 'The control engine is not running');
    return c;
  }

  mqtt(): IMqtt | null {
    return this.mqttRef();
  }

  mqttStatus(): MqttStatus {
    return (
      this.mqttRef()?.status() ?? {
        configured: false,
        connected: false,
        broker: null,
        source: env.simulate ? 'simulator' : 'none',
        detail: null,
        publishedEntities: 0,
      }
    );
  }

  lovelace(): SettingsBundle['lovelace'] {
    return this.cardsRef()?.status() ?? { deployed: false, resource: null, path: null };
  }

  cards(): ICardDeploy | null {
    return this.cardsRef();
  }

  /**
   * Evaluates right after a user action so the answer already shows its effect. A failed or missing
   * evaluation is not the action's failure: the change is stored and the next tick applies it.
   */
  async runNow(reason: string): Promise<void> {
    const engine = this.engineRef();
    if (!engine) return;
    try {
      await engine.runNow(reason);
    } catch (e) {
      this.log.warn(`evaluation after ${reason} failed: ${errorText(e)}`);
    }
  }
}

interface Entry {
  at: EpochMs;
  value: Promise<unknown>;
}

/**
 * Control actions carry a `reqId`; the cards and the UI retry with the same id after a timeout, and a
 * retry within 60 s must get the first answer instead of changing the target twice. A retry that
 * arrives while the first call is still running waits for it. Failures are forgotten, so a retry after
 * an error really retries. With `via`, the outcome is also announced as `command.result` (other tabs
 * and the cards follow a change someone made elsewhere).
 */
@Injectable()
export class ReqIdCache {
  private readonly entries = new Map<string, Entry>();

  constructor(
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(BUS) private readonly bus: IBus,
  ) {}

  run<T>(scope: string, reqId: string | null | undefined, fn: () => Promise<T>, via?: ActorVia): Promise<T> {
    if (!reqId) return fn();
    const now = this.clock.now();
    this.prune(now);
    const key = `${scope}|${reqId}`;
    const hit = this.entries.get(key);
    if (hit && now - hit.at <= REQ_ID_TTL_MS) return hit.value as Promise<T>;
    // a synchronous throw (no engine yet) is a failed attempt like any other
    const value = Promise.resolve().then(fn);
    this.entries.set(key, { at: now, value });
    value.then(
      () => {
        if (via) this.bus.emit('command.result', { reqId, ok: true, code: null, error: null, via });
      },
      (e: unknown) => {
        if (this.entries.get(key)?.value === value) this.entries.delete(key);
        if (via) this.bus.emit('command.result', { reqId, ok: false, code: e instanceof ApiException ? e.code : 'internal', error: null, via });
      },
    );
    return value;
  }

  private prune(now: EpochMs): void {
    if (this.entries.size < 256) return;
    for (const [k, e] of this.entries) if (now - e.at > REQ_ID_TTL_MS) this.entries.delete(k);
  }
}

/** Who changed something, as the journal shows it (`by`). */
export function actorLabel(actor: Actor): string {
  return actor.userName ?? actor.via;
}
