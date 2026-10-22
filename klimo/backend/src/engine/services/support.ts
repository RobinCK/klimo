import { HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ApiException, notFound } from '../../common/http';
import { errorText } from '../../common/logger';
import { lazyRef } from '../../common/refs';
import type {
  Actor,
  ClockPort,
  Decision,
  EpochMs,
  EvaluateResult,
  ICardDeploy,
  IConfigStore,
  ICoreFns,
  Id,
  IEngine,
  IHaInputs,
  IIncidents,
  IJournal,
  IMqtt,
  MqttTransport,
  OverrideSnapshot,
  RoomConfig,
  RoomState,
} from '../../shared/model';
import { CARD_DEPLOY, CLOCK, CONFIG_STORE, CORE, ENGINE, HA_INPUTS, INCIDENTS, JOURNAL, MQTT, MQTT_TRANSPORT } from '../../tokens';

/** How long «Скасувати» stays possible after a change (the UI shows 8 s of it). */
export const UNDO_MS = 30_000;
/** A repeated request id within this window gets the first answer instead of a second change. */
export const IDEMPOTENCY_MS = 60_000;

/** Who changed something, as the journal shows it. */
export function actorName(actor: Actor | null | undefined): string {
  if (!actor) return 'system';
  return actor.userName ?? actor.via;
}

/**
 * Late-bound handles to the engine shell, the pure core and the notification/MQTT areas. They live in
 * modules that themselves consume these services (the engine asks device health for detections every
 * tick), so they are looked up on first use instead of being constructor dependencies.
 */
@Injectable()
export class EngineAccess {
  private readonly log = new Logger('EngineServices');
  private readonly engineRef: () => IEngine | null;
  private readonly coreRef: () => ICoreFns | null;
  private readonly incidentsRef: () => IIncidents | null;
  private readonly mqttRef: () => IMqtt | null;
  private readonly cardsRef: () => ICardDeploy | null;
  private readonly transportRef: () => MqttTransport | null;
  private readonly inputsRef: () => IHaInputs | null;

  constructor(@Optional() @Inject(ModuleRef) moduleRef?: Pick<ModuleRef, 'get'>) {
    const ref = moduleRef as ModuleRef | undefined;
    this.engineRef = lazyRef<IEngine>(ref, ENGINE);
    this.coreRef = lazyRef<ICoreFns>(ref, CORE);
    this.incidentsRef = lazyRef<IIncidents>(ref, INCIDENTS);
    this.mqttRef = lazyRef<IMqtt>(ref, MQTT);
    this.cardsRef = lazyRef<ICardDeploy>(ref, CARD_DEPLOY);
    this.transportRef = lazyRef<MqttTransport>(ref, MQTT_TRANSPORT);
    this.inputsRef = lazyRef<IHaInputs>(ref, HA_INPUTS);
  }

  /** Outdoor temperature, forecasts and other HA-derived inputs (null without the HA module). */
  inputs(): IHaInputs | null {
    return this.inputsRef();
  }

  engine(): IEngine | null {
    return this.engineRef();
  }

  core(): ICoreFns | null {
    return this.coreRef();
  }

  incidents(): IIncidents | null {
    return this.incidentsRef();
  }

  mqtt(): IMqtt | null {
    return this.mqttRef();
  }

  cards(): ICardDeploy | null {
    return this.cardsRef();
  }

  transport(): MqttTransport | null {
    return this.transportRef();
  }

  requireEngine(): IEngine {
    const e = this.engine();
    if (!e) throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, 'internal', 'The control engine is not running');
    return e;
  }

  requireCore(): ICoreFns {
    const c = this.core();
    if (!c) throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, 'internal', 'The control engine is not running');
    return c;
  }

  /**
   * Evaluates immediately after a user action so the answer already reflects it. A failed run is not
   * the action's failure: the override is stored and the next tick applies it.
   */
  async runNow(reason: string): Promise<EvaluateResult | null> {
    const e = this.engine();
    if (!e) return null;
    try {
      return await e.runNow(reason);
    } catch (err) {
      this.log.warn(`evaluation after ${reason} failed: ${errorText(err)}`);
      return null;
    }
  }

  /** The room's state after `result` (or the last tick when the run did not happen). */
  roomState(roomId: Id, result: EvaluateResult | null): RoomState | undefined {
    return result?.rooms.find((r) => r.roomId === roomId) ?? this.engine()?.room(roomId);
  }
}

/** Undo snapshots of changes that leave no override row behind (a value written into a profile,
 *  a manual house profile cleared by picking the scheduled one). Kept in memory: they matter for
 *  30 seconds only. */
export interface UndoEntry {
  token: string;
  scope: 'room' | 'house';
  subjectId: Id;
  snapshot: OverrideSnapshot;
  until: EpochMs;
}

@Injectable()
export class UndoLedger {
  private readonly entries = new Map<string, UndoEntry>();

  constructor(@Inject(CLOCK) private readonly clock: ClockPort) {}

  put(entry: UndoEntry): void {
    this.prune();
    this.entries.set(entry.token, entry);
  }

  /** Takes the entry out: an undo runs once. */
  take(token: string): UndoEntry | null {
    this.prune();
    const e = this.entries.get(token) ?? null;
    if (e) this.entries.delete(token);
    return e;
  }

  peek(token: string): UndoEntry | null {
    this.prune();
    return this.entries.get(token) ?? null;
  }

  private prune(): void {
    const now = this.clock.now();
    for (const [k, e] of this.entries) if (e.until < now) this.entries.delete(k);
  }
}

/** First answers to recent request ids (cards and the UI retry with the same `reqId`). */
export class RecentResults<T> {
  private readonly items = new Map<string, { at: EpochMs; value: T }>();

  get(key: string, now: EpochMs): T | undefined {
    const hit = this.items.get(key);
    if (!hit) return undefined;
    if (now - hit.at > IDEMPOTENCY_MS) {
      this.items.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: T, now: EpochMs): void {
    if (this.items.size > 500) for (const [k, v] of this.items) if (now - v.at > IDEMPOTENCY_MS) this.items.delete(k);
    this.items.set(key, { at: now, value });
  }
}

/** Shared lookups of the action services. */
@Injectable()
export class ActionSupport {
  private readonly log = new Logger('EngineServices');

  constructor(
    @Inject(CONFIG_STORE) private readonly config: IConfigStore,
    @Inject(JOURNAL) private readonly journal: IJournal,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  room(idOrSlug: string): RoomConfig {
    const r = this.config.room(idOrSlug);
    if (!r) throw notFound('Room');
    return r;
  }

  /** Journal lines of user actions never fail the action itself. */
  async record(d: Decision): Promise<void> {
    try {
      await this.journal.add(d, this.clock.now());
    } catch (e) {
      this.log.warn(`journal ${d.code} failed: ${errorText(e)}`);
    }
  }
}
