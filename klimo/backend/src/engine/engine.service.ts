import { HttpStatus, Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ApiException, notFound, validationError } from '../common/http';
import { uuid } from '../common/ids';
import { errorText, LogOnce } from '../common/logger';
import { lazyRef } from '../common/refs';
import { env } from '../env';
import { deepClone, defaultPumpMemory, defaultSourceMemory, ENGINE_DEFAULTS } from '../shared/defaults';
import { round1 } from '../shared/model';
import type {
  ActuatorRecord,
  Actor,
  ClockPort,
  Decision,
  DesiredActuator,
  DesiredValue,
  Detection,
  EngineConfig,
  EngineHealth,
  EngineMemory,
  EntityId,
  EntitySnap,
  EpochMs,
  EvaluateResult,
  HaPort,
  HaStateObj,
  HouseProfileState,
  HouseState,
  IAttribution,
  IBus,
  IConfigStore,
  IDeviceHealth,
  IEngine,
  IEntitySearch,
  Id,
  IHaInputs,
  IIncidents,
  IJournal,
  IMemoryStore,
  IMqtt,
  INotify,
  InputSnapshot,
  IOverrideStore,
  IRoomActions,
  ISpanStore,
  Override,
  PlantState,
  RoomState,
  SeasonState,
  SourceConfig,
  SourceMode,
  SourceTestRequest,
  SourceTestResult,
  SpanEvent,
} from '../shared/model';
import {
  ATTRIBUTION,
  BUS,
  CLOCK,
  CONFIG_STORE,
  DEVICE_HEALTH,
  ENTITY_SEARCH,
  HA_INPUTS,
  HA_PORT,
  INCIDENTS,
  JOURNAL,
  MEMORY_STORE,
  MQTT,
  NOTIFY,
  OVERRIDE_STORE,
  ROOM_ACTIONS,
  SPAN_STORE,
} from '../tokens';
import { CommandBus } from './command-bus';
import { evaluate } from './core/evaluate';
import { houseProfileEdges } from './core/targets';
import { trvReleaseDesired } from './core/trv';
import { interestSet, templateNodes } from './interest-set';
import { observedMatches, ReconcilerService, type ActuatorInfo, type ConflictEvent, type LedgerChange, type ManualChange, type ReconcileOutcome } from './reconciler.service';
import { progressOf, roomSyncNow, RuntimeCache } from './runtime.cache';
import { failsafeDesired } from './shutdown';
import { SnapshotService } from './snapshot.service';
import { observeFrom, warmStart } from './warm-start';

/* =====================================================================================================
 * The engine shell: when to evaluate, what to do with the answer. It evaluates every 10 s, half a second
 * after a watched entity changes, at the exact moment a timer flips, and at once after a user action or
 * a configuration write — one evaluation at a time. Each answer is stored (control memory flushed to the
 * database before any source or pump is switched, so a crash can lose a command but never the knowledge
 * of a start), handed to the reconciler, journalled, turned into incidents and pushed to the UI and MQTT.
 * While Home Assistant is away for more than two minutes Klimo keeps deciding for the UI but sends
 * nothing; right after a boot it first reads the house for 20 s and only keeps relay watchdogs alive.
 * ===================================================================================================== */

const SEC = 1000;
const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
/** A boot waits this long for Home Assistant, then runs detached (and blind) until it appears. */
const HA_WAIT_MS = 60 * SEC;
const HEARTBEAT_MS = 60 * SEC;
/** Devices report stale values right after a boot or a reconnect: no "hand on the knob" then. */
const MANUAL_QUIET_MS = 120 * SEC;
/** A clock that moves back by more than this is a jump (not the ordinary jitter of timers). */
const CLOCK_BACK_MS = 60 * SEC;
/** A graceful stop waits at most this long for its fail-safe commands. */
const STOP_WAIT_MS = 5 * SEC;
/** A source or pump removed from the configuration is told OFF for this long, then forgotten. */
const TOMBSTONE_MS = 5 * MIN_MS;
/** A head turned by hand gets this long to be taken over as the room's new target before Klimo resends. */
const MANUAL_HOLD_MS = 30 * SEC;
/** Automatic airing for a humid room at most this often. */
const AUTO_AIRING_COOLDOWN_MS = 6 * HOUR_MS;
const TEST_DEFAULT_SEC = 120;
const TEST_RANGE_SEC: [number, number] = [30, 600];
const RELEASE_TIMEOUT_MS = 30 * SEC;
const ENGINE_ACTOR: Actor = { via: 'engine', userId: null, userName: null, contextId: null };

type Phase = 'starting' | 'running' | 'stopping' | 'stopped';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const actorName = (a: Actor | null | undefined) => (a ? (a.userName ?? a.via) : 'system');

/** The state a device shows once it took a value (dry runs pretend every device obeys). */
function obeyed(snap: EntitySnap | undefined, entityId: EntityId, v: DesiredValue, at: EpochMs): EntitySnap | null {
  const base: EntitySnap = snap ?? { entityId, state: '', num: null, attrs: {}, available: true, lastChanged: at, lastReported: at, context: { id: null, userId: null, parentId: null } };
  if (!base.available) return null;
  const set = (state: string, attrs: Record<string, unknown> = {}, num: number | null = null): EntitySnap => ({
    ...base,
    state,
    num,
    attrs: { ...base.attrs, ...attrs },
    lastChanged: state !== base.state ? at : base.lastChanged,
    lastReported: at,
  });
  switch (v.kind) {
    case 'switch':
      return set(v.on ? 'on' : 'off');
    case 'valve':
      return set(v.open ? 'open' : 'closed', v.position !== null ? { current_position: v.position } : {});
    case 'fan':
      return set(v.on ? 'on' : 'off', v.percentage !== null ? { percentage: v.percentage } : {});
    case 'climate': {
      const action = v.hvacMode === 'off' ? 'off' : v.hvacMode === 'heat' ? 'heating' : v.hvacMode === 'cool' ? 'cooling' : v.hvacMode === 'dry' ? 'drying' : 'fan';
      const attrs: Record<string, unknown> = { hvac_action: action };
      if (v.temperature !== null) attrs.temperature = v.temperature;
      if (v.targetLow !== null) attrs.target_temp_low = v.targetLow;
      if (v.targetHigh !== null) attrs.target_temp_high = v.targetHigh;
      if (v.fanMode !== null) attrs.fan_mode = v.fanMode;
      return set(v.hvacMode, attrs);
    }
    case 'number':
      return set(String(v.value), {}, v.value);
    case 'select':
      return set(v.option);
    default:
      return null;
  }
}

@Injectable()
export class EngineService implements IEngine, OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('Engine');
  private readonly once = new LogOnce(this.log);
  private readonly incidents: () => IIncidents | null;
  private readonly notify: () => INotify | null;
  private readonly deviceHealth: () => IDeviceHealth | null;
  private readonly mqtt: () => IMqtt | null;
  private readonly roomActions: () => IRoomActions | null;
  private readonly entitySearch: () => IEntitySearch | null;
  private readonly attribution: () => IAttribution | null;

  private phase: Phase = 'starting';
  /** A warm start is under way (HA may announce itself twice meanwhile). */
  private warming = false;
  private result: EvaluateResult | null = null;
  private inputs: InputSnapshot | null = null;
  private lastTickAt = 0;
  private dryRunUntil = 0;
  /** When Home Assistant was lost (or the boot when it never came); null while connected. */
  private haDownSince: EpochMs | null = null;
  /** Until HA has answered once Klimo has never seen the house: blind from the start. */
  private everConnected = false;
  private unsupported = new Set<EntityId>();
  private readonly unsupportedJournalled = new Set<EntityId>();
  private interest = new Set<EntityId>();
  private interestRev = -1;
  private templatesRev = -1;
  private prevHouse: HouseProfileState | null = null;
  /** Profile spans the previous run left open end here unless the profile is still active. */
  private profileCloseAt: EpochMs | null = null;

  private inflight: Promise<EvaluateResult> | null = null;
  private pending: Deferred<EvaluateResult> | null = null;
  private lastRunAt = 0;
  private debounceTimer: { cancel(): void } | null = null;
  private wakeTimer: { cancel(): void; at: EpochMs } | null = null;
  private readonly timers: { cancel(): void }[] = [];
  private haWaitTimer: { cancel(): void } | null = null;
  private dryRunTimer: { cancel(): void } | null = null;
  private readonly offs: (() => void)[] = [];

  /** Values the engine adds to the core's: heads being handed back, removed sources told OFF. */
  private readonly releases = new Map<string, { desired: DesiredActuator; until: EpochMs; deviceId: Id }>();
  private readonly tombstones = new Map<string, { desired: DesiredActuator; until: EpochMs }>();
  private prevSubjects: { sources: Map<Id, SourceConfig>; pumps: Set<Id> } = { sources: new Map(), pumps: new Set() };
  private prevOwnerDesired = new Map<string, DesiredActuator[]>();
  private readonly describeCache = new Map<string, { rev: number; info: ActuatorInfo }>();
  /** One-shot detections raised between ticks (a hand on a head). */
  private readonly pendingDetections: Detection[] = [];
  private readonly pendingDecisions: Decision[] = [];
  private readonly autoAiringAt = new Map<Id, EpochMs>();
  private readonly testsReported = new Map<Id, string>();
  private readonly bridgeOnline = new Map<Id, boolean>();
  private mqttWasDown = false;

  constructor(
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(HA_PORT) private readonly ha: HaPort,
    @Inject(CONFIG_STORE) private readonly config: IConfigStore,
    @Inject(MEMORY_STORE) private readonly memoryStore: IMemoryStore,
    @Inject(OVERRIDE_STORE) private readonly overrides: IOverrideStore,
    @Inject(JOURNAL) private readonly journal: IJournal,
    @Inject(SPAN_STORE) private readonly spans: ISpanStore,
    @Inject(HA_INPUTS) private readonly haInputs: IHaInputs,
    @Inject(BUS) private readonly bus: IBus,
    @Inject(SnapshotService) private readonly snapshot: SnapshotService,
    @Inject(ReconcilerService) private readonly reconciler: ReconcilerService,
    @Inject(CommandBus) private readonly commands: CommandBus,
    @Inject(RuntimeCache) private readonly cache: RuntimeCache,
    @Optional() @Inject(ModuleRef) moduleRef?: ModuleRef,
  ) {
    // these areas sit "above" the engine (they ask it for state); found on first use, never cyclic
    const ref = moduleRef ?? null;
    this.incidents = lazyRef<IIncidents>(ref, INCIDENTS);
    this.notify = lazyRef<INotify>(ref, NOTIFY);
    this.deviceHealth = lazyRef<IDeviceHealth>(ref, DEVICE_HEALTH);
    this.mqtt = lazyRef<IMqtt>(ref, MQTT);
    this.roomActions = lazyRef<IRoomActions>(ref, ROOM_ACTIONS);
    this.entitySearch = lazyRef<IEntitySearch>(ref, ENTITY_SEARCH);
    this.attribution = lazyRef<IAttribution>(ref, ATTRIBUTION);
  }

  /* ── lifecycle ──────────────────────────────────────────────────────────────────────────────── */

  onApplicationBootstrap(): void {
    this.start();
  }

  /** Starts listening and evaluating (the boot waits for HA before it actuates anything). */
  start(): void {
    const now = this.clock.now();
    this.everConnected = this.ha.connected;
    this.haDownSince = this.ha.connected ? null : now;
    this.ha.onConnection((ok) => this.onConnection(ok));
    this.ha.onStateChanged((id, next) => this.onStateChanged(id, next));
    this.ha.onEvent((type) => {
      if (type === 'homeassistant_started') this.resyncAll('ha_started');
    });
    void this.ha.subscribeEvents('homeassistant_started').catch((e: unknown) => this.log.debug(`cannot subscribe to HA restarts: ${errorText(e)}`));
    this.offs.push(
      this.bus.on('config.changed', (e) => this.onConfigChanged(e)),
      this.bus.on('z2m.bridge', ({ instanceId, online }) => this.onBridge(instanceId, online)),
      this.bus.on('mqtt.connection', ({ connected }) => this.onMqtt(connected)),
    );
    this.reconciler.onTransition((changes) => this.onLedgerChanges(changes));
    this.reconciler.onManualChange((m) => this.onManual(m));
    this.reconciler.onConflict((c) => this.onConflict(c));
    this.reconciler.setExercising((entityId) => !!this.result?.rooms.some((r) => r.trvs.some((t) => t.entityId === entityId && t.activity === 'exercise')));

    // the UI has something to show from the first request on, even before HA answers
    this.preview(now);
    this.timers.push(
      this.clock.setInterval(() => void this.tickSafely('tick'), ENGINE_DEFAULTS.tickMs),
      this.clock.setInterval(() => void this.heartbeat(), HEARTBEAT_MS),
    );
    if (this.ha.connected) void this.warmStart();
    else if (!env.simulate && !env.supervisorToken) {
      // no token: there is no Home Assistant to wait for
      this.log.warn('no connection to Home Assistant is configured: running detached, nothing is controlled');
      void this.warmStart();
    } else {
      this.log.log('waiting for Home Assistant before taking control');
      this.haWaitTimer = this.clock.setTimeout(() => {
        this.haWaitTimer = null;
        if (this.phase === 'starting') {
          this.log.warn(`Home Assistant did not answer within ${HA_WAIT_MS / SEC} s: running detached, nothing is sent until it does`);
          void this.warmStart();
        }
      }, HA_WAIT_MS);
    }
  }

  /**
   * Shutdown starts here: modules are torn down in import order and the engine comes before MQTT, while
   * the HA connection closes only in the very last phase — so the fail-safe still reaches the devices.
   */
  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  private stopTimers(): void {
    for (const t of this.timers) t.cancel();
    this.timers.length = 0;
    this.debounceTimer?.cancel();
    this.debounceTimer = null;
    this.wakeTimer?.cancel();
    this.wakeTimer = null;
    this.haWaitTimer?.cancel();
    this.haWaitTimer = null;
    this.dryRunTimer?.cancel();
    this.dryRunTimer = null;
    for (const off of this.offs.splice(0)) off();
  }

  /**
   * Graceful stop: no more evaluations, each running source gets its fail-safe, radiator heads go back
   * to their own sensor, and the memory is flushed. Bounded: an unreachable device does not hold up
   * the add-on's shutdown.
   */
  async stop(): Promise<void> {
    if (this.phase === 'stopping' || this.phase === 'stopped') return;
    const wasRunning = this.phase === 'running';
    this.phase = 'stopping';
    this.stopTimers();
    try {
      await this.inflight;
    } catch {
      // the last evaluation's failure is already logged
    }
    if (wasRunning && this.ha.connected) {
      const now = this.clock.now();
      const cfg = this.config.engineConfig();
      const desired = failsafeDesired(cfg, this.memoryStore.current(), this.result?.rooms ?? [], this.memoryStore.ledger(), now);
      if (desired.length) {
        const sends = Promise.allSettled(
          desired.map(async (d) => {
            const res = await this.commands.sendNow({ key: d.key, entityId: d.entityId, value: d.value, urgency: 'safety', zigbee: null });
            if (res.ok) this.markCommanded(d, res.contextIds, now);
          }),
        );
        let timer: NodeJS.Timeout | undefined;
        const giveUp = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, STOP_WAIT_MS);
        });
        await Promise.race([sends, giveUp]);
        clearTimeout(timer);
        const handedBack = new Set(desired.filter((d) => d.owner.type === 'trv' && d.owner.roomId).map((d) => d.owner.roomId as Id));
        for (const roomId of handedBack) await this.record({ code: 'trv.handback', category: 'dev', tone: 'event', params: {}, roomId }, now);
        this.log.log(`stopping: ${desired.length} fail-safe command(s) sent`);
      }
    }
    try {
      await this.memoryStore.flushNow();
    } catch (e) {
      this.log.warn(`final memory flush failed: ${errorText(e)}`);
    }
    this.phase = 'stopped';
  }

  /** The value a fail-safe or release sent, recorded so the next boot knows what the device was told. */
  private markCommanded(d: DesiredActuator, contextIds: string[], now: EpochMs): void {
    const rec = this.memoryStore.ledger()[d.key];
    const base: ActuatorRecord = rec ?? {
      key: d.key,
      entityId: d.entityId,
      kind: d.value.kind,
      desired: d.value,
      commanded: null,
      commandId: null,
      reqId: null,
      commandedAt: null,
      attempts: 0,
      status: 'idle',
      confirmedAt: null,
      nextAttemptAt: null,
      lastError: null,
      contextIds: [],
      conflicts: [],
      backoffUntil: null,
      updatedAt: now,
    };
    this.memoryStore.putLedger([{ ...base, desired: d.value, commanded: d.value, commandId: uuid(), commandedAt: now, attempts: 1, status: 'sending', contextIds: [...base.contextIds, ...contextIds].slice(-5), updatedAt: now }]);
  }

  /* ── boot ───────────────────────────────────────────────────────────────────────────────────── */

  /**
   * Restart safety: adopt what the house really does, close what stopped meanwhile, then a read-only
   * window before anything is sent. `late`: HA answered only after a detached boot — the house is looked
   * at for the first time now.
   */
  private async warmStart(late = false): Promise<void> {
    if (this.warming || (late ? this.phase !== 'running' : this.phase !== 'starting')) return;
    this.warming = true;
    try {
      await this.takeOver(late);
    } finally {
      this.warming = false;
    }
  }

  private async takeOver(late: boolean): Promise<void> {
    this.haWaitTimer?.cancel();
    this.haWaitTimer = null;
    const now = this.clock.now();
    const cfg = this.config.engineConfig();
    this.refreshInterest(cfg);
    const connected = this.ha.connected;
    const capture = this.snapshot.capture(cfg, { now, tz: this.clock.tz(), blind: !connected, dryRun: true, simulated: false, prev: this.prev(), interest: this.interest });
    const observe = connected ? observeFrom(capture.inputs) : { source: () => null, pump: () => null, contactOpenSince: () => null };
    const ws = warmStart(cfg, this.memoryStore.current(), observe, now);
    this.memoryStore.apply(ws.memory);
    try {
      await this.memoryStore.flushNow();
    } catch (e) {
      this.log.warn(`memory flush at boot failed: ${errorText(e)}`);
    }
    for (const d of ws.decisions) if (!late || d.code !== 'restart.boot') await this.record(d, now);
    try {
      await this.spans.closeDangling(ws.closeAt, ws.keepOpen);
      if (ws.spans.length) await this.spans.apply(ws.spans);
    } catch (e) {
      this.log.warn(`closing the spans of the previous run failed: ${errorText(e)}`);
    }
    if (!late) this.profileCloseAt = ws.closeAt;
    await this.expireOverrides(now);

    const dryRunMs = cfg.safety.startupDryRunSec * SEC;
    this.dryRunUntil = now + dryRunMs;
    this.reconciler.quietManualDetection(now + MANUAL_QUIET_MS);
    this.phase = 'running';
    const adopted = ws.decisions.filter((d) => d.code === 'restart.adopted').length;
    const dropped = ws.decisions.filter((d) => d.code === 'restart.source_off').length;
    const what = late ? 'Home Assistant answered' : `warm start (boot #${ws.memory.plant.bootCount}${connected ? '' : ', detached'})`;
    this.log.log(`${what}: ${adopted} source(s) adopted, ${dropped} found off; reading the house for ${cfg.safety.startupDryRunSec} s`);
    // after the read-only window every actuator is compared once more and whatever differs is sent
    this.dryRunTimer?.cancel();
    this.dryRunTimer = this.clock.setTimeout(() => {
      this.dryRunTimer = null;
      if (this.phase !== 'running') return;
      if (cfg.safety.reconcileOnRestart) this.reconciler.requestResync(null, 'boot', true);
      void this.runNow('boot.dry_run_end').catch(() => undefined);
    }, dryRunMs + 50);
    await this.runNow(late ? 'ha.first_contact' : 'boot');
  }

  /* ── IEngine: state ─────────────────────────────────────────────────────────────────────────── */

  health(): EngineHealth {
    if (this.phase === 'starting') return 'starting';
    const now = this.clock.now();
    if (this.isBlind(now)) return 'blind';
    if (now < this.dryRunUntil) return 'dry_run';
    if (!this.memoryStore.healthy()) return 'degraded';
    return 'ok';
  }

  house(): HouseState {
    return this.cache.house() ?? this.preview(this.clock.now()).house;
  }

  plant(): PlantState {
    return this.current().plant;
  }

  rooms(): RoomState[] {
    return this.current().rooms;
  }

  room(id: Id): RoomState | undefined {
    return this.current().rooms.find((r) => r.roomId === id);
  }

  season(): SeasonState {
    return this.current().season;
  }

  houseProfile(): HouseProfileState {
    return this.current().houseProfile;
  }

  last(): EvaluateResult | null {
    return this.result;
  }

  lastInputs(): InputSnapshot | null {
    return this.inputs;
  }

  memory(): EngineMemory {
    return this.memoryStore.current();
  }

  ledger(): Record<string, ActuatorRecord> {
    return this.memoryStore.ledger();
  }

  private current(): EvaluateResult {
    return this.result ?? this.preview(this.clock.now()).result;
  }

  /* ── IEngine: evaluation ────────────────────────────────────────────────────────────────────── */

  requestRun(reason: string): void {
    if (this.phase === 'stopping' || this.phase === 'stopped' || this.debounceTimer) return;
    const now = this.clock.now();
    const delay = Math.max(ENGINE_DEFAULTS.eventDebounceMs, this.lastRunAt + ENGINE_DEFAULTS.minSpacingMs - now);
    this.debounceTimer = this.clock.setTimeout(() => {
      this.debounceTimer = null;
      void this.tickSafely(reason);
    }, delay);
  }

  runNow(reason: string): Promise<EvaluateResult> {
    if (this.phase === 'stopping' || this.phase === 'stopped') return Promise.resolve(this.current());
    if (!this.inflight) return this.startRun(reason);
    // one more evaluation after the running one, shared by everybody who asks meanwhile
    this.pending ??= deferred<EvaluateResult>();
    return this.pending.promise;
  }

  private startRun(reason: string): Promise<EvaluateResult> {
    const run = this.evaluateOnce(reason);
    this.inflight = run;
    void run
      .catch(() => undefined)
      .finally(() => {
        this.inflight = null;
        const next = this.pending;
        this.pending = null;
        if (next && this.phase !== 'stopping' && this.phase !== 'stopped') this.startRun('coalesced').then(next.resolve, next.reject);
        else if (next) next.resolve(this.current());
      });
    return run;
  }

  /** Periodic and debounced evaluations: never two at once, a failure is logged, not thrown. */
  private async tickSafely(reason: string): Promise<void> {
    if (this.phase === 'stopping' || this.phase === 'stopped') return;
    try {
      if (this.inflight) {
        if (reason !== 'tick') await this.runNow(reason);
        return;
      }
      await this.runNow(reason);
    } catch (e) {
      this.log.error(`evaluation failed (${reason}): ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    }
  }

  /** Evaluation for the UI before the warm start: nothing stored, nothing sent. */
  private preview(now: EpochMs): { result: EvaluateResult; house: HouseState } {
    const cfg = this.config.engineConfig();
    this.refreshInterest(cfg);
    const { inputs } = this.snapshot.capture(cfg, { now, tz: this.clock.tz(), blind: !this.ha.connected, dryRun: true, simulated: true, prev: this.prev(), interest: this.interest });
    const result = evaluate(cfg, inputs, this.memoryStore.current(), this.memoryStore.ledger());
    this.result = result;
    this.inputs = inputs;
    const house = this.cache.setHouse(cfg, result, this.houseInputs(now));
    return { result, house };
  }

  private prev(): InputSnapshot['prev'] {
    const r = this.result;
    return r ? { rooms: Object.fromEntries(r.rooms.map((x) => [x.roomId, x])), plant: r.plant } : { rooms: {}, plant: null };
  }

  private isBlind(now: EpochMs): boolean {
    if (this.phase === 'starting' || !this.everConnected) return !this.ha.connected;
    const after = this.config.engineConfig().safety.haBlindAfterSec * SEC;
    return this.haDownSince !== null && now - this.haDownSince > after;
  }

  private houseInputs(now: EpochMs) {
    let mqttConnected = false;
    try {
      mqttConnected = this.mqtt()?.status().connected ?? false;
    } catch {
      mqttConnected = false;
    }
    return {
      now,
      tz: this.clock.tz(),
      health: this.health(),
      haConnected: this.ha.connected,
      mqttConnected,
      lastTickAt: this.lastTickAt,
      simulated: this.ha.simulated,
      unitsOk: this.unsupported.size === 0,
    };
  }

  private refreshInterest(cfg: EngineConfig): void {
    if (cfg.revision !== this.interestRev) {
      this.interestRev = cfg.revision;
      this.interest = interestSet(cfg, this.config.referencedEntities());
      this.describeCache.clear();
    }
    if (cfg.revision !== this.templatesRev && this.phase !== 'stopping') {
      this.templatesRev = cfg.revision;
      try {
        this.haInputs.syncTemplates(templateNodes(cfg));
      } catch (e) {
        this.once.warn('templates', `template conditions could not be subscribed: ${errorText(e)}`);
      }
    }
  }

  /** One evaluation and everything that follows from it. */
  private async evaluateOnce(reason: string): Promise<EvaluateResult> {
    if (this.phase === 'starting') return this.preview(this.clock.now()).result;
    const now = this.clock.now();
    this.rebaseAfterClockJump(now);
    this.lastRunAt = now;
    const cfg = this.config.engineConfig();
    this.refreshInterest(cfg);
    const blind = this.isBlind(now);
    const dryRun = now < this.dryRunUntil;
    const capture = this.snapshot.capture(cfg, { now, tz: this.clock.tz(), blind, dryRun, simulated: false, prev: this.prev(), interest: this.interest });
    const inputs = capture.inputs;
    const shellDecisions: Decision[] = this.pendingDecisions.splice(0);
    this.updateUnits(capture.unsupported, shellDecisions);

    const result = evaluate(cfg, inputs, this.memoryStore.current(), this.memoryStore.ledger());
    this.memoryStore.apply(result.memory);
    // write before act: the knowledge of a start or stop is on disk before the command leaves
    if (result.edges.length) await this.memoryStore.flushNow();

    const extra = this.extraDesired(cfg, result, now, shellDecisions);
    const shellSpans = extra.spans;
    let rec: ReconcileOutcome | null = null;
    if (!blind && this.ha.connected) {
      // a head being handed back is no longer the room's: its own values give way
      const own = result.desired.filter((d) => !this.releases.has(d.key));
      rec = this.reconciler.reconcile([...own, ...extra.desired], {
        now,
        dryRun,
        unsupported: this.unsupported,
        conflict: cfg.safety.conflict,
        describe: (d) => this.describe(cfg, d),
      });
      if (rec.resynced) {
        shellDecisions.push({ code: 'restart.reconciled', category: 'system', tone: 'event', params: { sent: rec.resynced.sent, matched: rec.resynced.matched } });
        this.log.log(`re-sync after ${rec.resynced.reason}: ${rec.resynced.sent} sent, ${rec.resynced.matched} already right`);
      }
    }

    const edges = houseProfileEdges(this.prevHouse, result.houseProfile, now);
    if (this.prevHouse === null && this.profileCloseAt !== null) {
      // profiles the previous run left open end where that run ended, unless still the active one
      for (const s of this.spans.open()) {
        if (s.subject === 'profile' && s.subjectId !== result.houseProfile.activeProfileId) shellSpans.push({ subject: 'profile', subjectId: s.subjectId, kind: s.kind, mode: null, edge: 'end', at: Math.min(this.profileCloseAt, now) });
      }
      this.profileCloseAt = null;
    }
    this.prevHouse = result.houseProfile;

    this.result = result;
    this.inputs = inputs;
    this.lastTickAt = now;
    this.snapshot.record(result.rooms, now);

    await this.expireOverrides(now);
    for (const d of [...result.decisions, ...edges.decisions, ...(rec?.decisions ?? []), ...shellDecisions]) await this.record(d, now);
    try {
      await this.spans.apply([...result.spans, ...edges.spans, ...shellSpans]);
    } catch (e) {
      this.once.warn('spans', `run spans could not be saved: ${errorText(e)}`);
    }
    this.ingest(cfg, [...result.detections, ...edges.detections, ...(rec?.detections ?? [])], now, blind);
    await this.autoAiring(cfg, result, now);

    const house = this.cache.setHouse(cfg, result, this.houseInputs(now));
    this.cache.publish(result, house, true);
    this.cache.ha(this.ha.connected, house.engine.health);
    this.publishTests(result, now);
    this.scheduleWake(result.nextWakeAt, rec?.nextAt ?? null, now);
    if (reason !== 'tick') this.log.debug(`evaluated (${reason})`);
    return result;
  }

  /**
   * The clock moved back (a corrected system clock, the simulator switching to an earlier day): the
   * read-only window and the command ledger were timed by the old clock and would keep every command
   * back until it is "later" again. They start over from now, followed by a full comparison.
   */
  private rebaseAfterClockJump(now: EpochMs): void {
    const last = Math.max(this.lastTickAt, this.lastRunAt);
    if (last === 0 || now >= last - CLOCK_BACK_MS) return;
    this.log.warn(`the clock moved back by ${Math.round((last - now) / SEC)} s: timers and the command ledger start over from now`);
    if (this.dryRunUntil > now) {
      this.dryRunTimer?.cancel();
      this.dryRunTimer = null;
      this.dryRunUntil = now;
    }
    this.reconciler.rebase(now);
    // like a reconnect: what the heads show now is read and compared, not taken for hands on the knobs
    this.reconciler.quietManualDetection(now + MANUAL_QUIET_MS);
    this.reconciler.requestResync(null, 'the clock change', true);
    this.lastTickAt = now;
  }

  private updateUnits(found: { entityId: EntityId; unit: string }[], decisions: Decision[]): void {
    this.unsupported = new Set(found.map((f) => f.entityId));
    for (const f of found) {
      if (this.unsupportedJournalled.has(f.entityId)) continue;
      this.unsupportedJournalled.add(f.entityId);
      this.log.warn(`${f.entityId} reports temperatures in "${f.unit}", which Klimo cannot convert: it is never written`);
      decisions.push({ code: 'unsupported_units', category: 'system', tone: 'warn', params: { entityId: f.entityId, unit: f.unit }, entityIds: [f.entityId] });
    }
    for (const id of [...this.unsupportedJournalled]) if (!this.unsupported.has(id)) this.unsupportedJournalled.delete(id);
  }

  /**
   * What the engine adds to the core's desired values: heads being handed back (they override the room's
   * own values until the room or head is gone) and sources/pumps removed from the configuration while
   * running, which are told OFF — the core no longer knows them.
   */
  private extraDesired(cfg: EngineConfig, result: EvaluateResult, now: EpochMs, decisions: Decision[]): { desired: DesiredActuator[]; spans: SpanEvent[] } {
    const spans: SpanEvent[] = [];
    const sources = new Map(cfg.sources.map((s) => [s.id, s]));
    const pumps = new Set(cfg.pumps.map((p) => p.id));
    const mem = this.memoryStore.current();
    for (const [id, s] of this.prevSubjects.sources) {
      if (sources.has(id)) continue;
      const wasOn = (this.prevOwnerDesired.get(`source:${id}`) ?? []).length > 0;
      for (const d of this.prevOwnerDesired.get(`source:${id}`) ?? []) {
        const off = this.offValue(d.value, s);
        if (off) this.tombstones.set(d.key, { desired: { ...d, value: off, urgency: 'safety', refreshEverySec: null, minIntervalSec: 0, deadband: 0 }, until: now + TOMBSTONE_MS });
      }
      if (wasOn) {
        spans.push({ subject: 'source', subjectId: id, kind: 'run', mode: null, edge: 'end', at: now, meta: { reason: 'deleted' } });
        decisions.push({ code: 'source.stop', category: 'src', tone: 'idle', params: { reason: 'deleted' }, sourceId: id });
      }
    }
    for (const id of this.prevSubjects.pumps) {
      if (pumps.has(id)) continue;
      for (const d of this.prevOwnerDesired.get(`pump:${id}`) ?? []) {
        const off = this.offValue(d.value, null);
        if (off) this.tombstones.set(d.key, { desired: { ...d, value: off, urgency: 'safety' }, until: now + TOMBSTONE_MS });
      }
      spans.push({ subject: 'pump', subjectId: id, kind: 'run', mode: null, edge: 'end', at: now, meta: { reason: 'deleted' } });
    }
    this.prevSubjects = { sources, pumps };
    const owners = new Map<string, DesiredActuator[]>();
    for (const d of result.desired) {
      if (d.owner.type !== 'source' && d.owner.type !== 'pump' && d.owner.type !== 'watchdog') continue;
      const key = `${d.owner.type === 'watchdog' ? 'source' : d.owner.type}:${d.owner.id}`;
      // only what keeps a running source or pump on needs undoing when it disappears
      const on = d.value.kind === 'switch' ? d.value.on : d.value.kind === 'climate' ? d.value.hvacMode !== 'off' : d.value.kind === 'valve' ? d.value.open : d.value.kind === 'fan' ? d.value.on : false;
      if (on && (d.owner.type === 'pump' || mem.sources[d.owner.id]?.on)) owners.set(key, [...(owners.get(key) ?? []), d]);
    }
    this.prevOwnerDesired = owners;

    const coreKeys = new Set(result.desired.map((d) => d.key));
    const out: DesiredActuator[] = [];
    for (const [key, t] of this.tombstones) {
      const rec = this.memoryStore.ledger()[key];
      const done = rec?.status === 'confirmed' && JSON.stringify(rec.commanded) === JSON.stringify(t.desired.value);
      // a removed source whose entity now belongs to something else: the new owner decides
      if (now >= t.until || done || coreKeys.has(key)) this.tombstones.delete(key);
      else out.push(t.desired);
    }
    const devices = new Set(Object.values(cfg.devicesByEmitter).flat().map((d) => d.id));
    for (const [key, r] of this.releases) {
      if (now >= r.until || !devices.has(r.deviceId)) this.releases.delete(key);
      else out.push(r.desired);
    }
    return { desired: out, spans };
  }

  private offValue(v: DesiredValue, s: SourceConfig | null): DesiredValue | null {
    switch (v.kind) {
      case 'switch':
        return { kind: 'switch', on: false };
      case 'valve':
        return { kind: 'valve', open: false, position: null };
      case 'fan':
        return { kind: 'fan', on: false, percentage: null };
      case 'climate':
        return { ...v, hvacMode: s?.adapter.type === 'climate' ? s.adapter.modeMap.off : 'off', temperature: null, targetLow: null, targetHigh: null, fanMode: null };
      default:
        return null;
    }
  }

  /** HA device key and Zigbee network of an actuator (journal, devices page, command spacing). */
  private describe(cfg: EngineConfig, d: DesiredActuator): ActuatorInfo {
    const hit = this.describeCache.get(d.key);
    if (hit && hit.rev === cfg.revision) return hit.info;
    let info: ActuatorInfo = { deviceKey: d.entityId ? `entity:${d.entityId}` : null, zigbee: null };
    if (d.owner.type === 'trv' || d.owner.type === 'zone') {
      const dev = Object.values(cfg.devicesByEmitter).flat().find((x) => x.id === d.owner.id);
      if (dev) info = { deviceKey: dev.haDeviceId ?? `entity:${dev.entityId}`, zigbee: dev.transport.type === 'z2m' ? dev.transport.instanceId : null };
    } else if (d.entityId) {
      try {
        const dev = this.entitySearch()?.deviceOf(d.entityId);
        if (dev) info = { deviceKey: dev.key, zigbee: dev.transport.type === 'z2m' ? dev.transport.instanceId : null };
      } catch (e) {
        this.once.warn('describe', `device lookup failed: ${errorText(e)}`);
      }
    }
    if (d.value.kind === 'z2m' && !info.zigbee) {
      const topic = d.value.topic;
      info = { ...info, zigbee: (this.config.list('z2m').find((z) => topic.startsWith(`${z.baseTopic}/`))?.id) ?? null };
    }
    this.describeCache.set(d.key, { rev: cfg.revision, info });
    return info;
  }

  private async expireOverrides(now: EpochMs): Promise<void> {
    let expired: Override[] = [];
    try {
      expired = await this.overrides.expire(now);
    } catch (e) {
      this.once.warn('expire', `expired overrides could not be removed: ${errorText(e)}`);
      return;
    }
    for (const o of expired) {
      if (o.scope === 'room') await this.record({ code: 'room.override_expired', category: 'rooms', tone: 'idle', params: { kind: o.kind }, roomId: o.subjectId }, now);
      else if (o.scope === 'house') await this.record({ code: 'house_profile.expired', category: 'system', tone: 'idle', params: {} }, now);
      // a source lock's end is journalled by the plant on the tick it runs out
    }
  }

  private async record(d: Decision, now: EpochMs): Promise<void> {
    try {
      await this.journal.add(d, now);
    } catch (e) {
      this.once.warn('journal', `journal entries could not be saved: ${errorText(e)}`);
    }
  }

  /** Engine, device health, watch rules and connection problems → incidents, every tick. */
  private ingest(cfg: EngineConfig, engine: Detection[], now: EpochMs, blind: boolean): void {
    const inc = this.incidents();
    if (!inc) return;
    const all: Detection[] = [];
    // a blind engine decides on frozen data: its room and plant findings are not news
    if (!blind) all.push(...engine);
    const down = this.haDownSince;
    const alertMs = cfg.safety.haDisconnectAlertMin * MIN_MS;
    if (down !== null && now - down >= alertMs) {
      all.push({ kind: 'ha_disconnected', dedupKey: 'ha_disconnected', active: true, facts: { since: down, minutes: Math.floor((now - down) / MIN_MS) } });
    }
    const collect = (what: string, fn: () => Detection[] | undefined) => {
      try {
        all.push(...(fn() ?? []));
      } catch (e) {
        this.once.warn(`detect:${what}`, `${what} detections failed: ${errorText(e)}`);
      }
    };
    if (!blind) {
      collect('device health', () => this.deviceHealth()?.detect(now));
      collect('watch rule', () => this.notify()?.watchDetections(now));
    }
    collect('MQTT', () => {
      const m = this.mqtt() as (IMqtt & { detect?: (at: EpochMs) => Detection[] }) | null;
      return typeof m?.detect === 'function' ? m.detect(now) : [];
    });
    all.push(...this.pendingDetections.splice(0));
    try {
      inc.ingest(all, now);
    } catch (e) {
      this.once.warn('ingest', `incidents could not be updated: ${errorText(e)}`);
    }
  }

  /** «Провітрити» set to act by itself: a humid room gets a 10-minute airing pause when the hint appears. */
  private async autoAiring(cfg: EngineConfig, result: EvaluateResult, now: EpochMs): Promise<void> {
    for (const state of result.rooms) {
      const room = cfg.rooms.find((r) => r.id === state.roomId);
      if (!room || room.humidity.airingHint !== 'auto_pause' || !state.issues.some((i) => i.code === 'airing_hint')) continue;
      if (now - (this.autoAiringAt.get(room.id) ?? -Infinity) < AUTO_AIRING_COOLDOWN_MS) continue;
      if (this.overrides.forSubject('room', room.id).some((o) => o.group === 'airing' && (o.until === null || o.until > now))) continue;
      this.autoAiringAt.set(room.id, now);
      const until = now + ENGINE_DEFAULTS.overrides.airingMin * MIN_MS;
      const o: Override = {
        id: uuid(),
        scope: 'room',
        subjectId: room.id,
        kind: 'room_airing',
        group: 'airing',
        value: { kind: 'room_airing' },
        duration: 'minutes',
        createdAt: now,
        until,
        by: ENGINE_ACTOR,
        previous: null,
        revertToken: null,
        revertUntil: null,
        reqId: null,
      };
      try {
        await this.overrides.put(o);
        await this.record({ code: 'room.override', category: 'rooms', tone: 'event', params: { kind: 'room_airing', valueC: null, lo: null, hi: null, profileId: null, until, by: 'engine' }, roomId: room.id }, now);
        this.requestRun('auto airing');
      } catch (e) {
        this.log.warn(`${room.name}: automatic airing could not start: ${errorText(e)}`);
      }
    }
  }

  private scheduleWake(coreAt: EpochMs | null, reconcilerAt: EpochMs | null, now: EpochMs): void {
    const candidates = [coreAt, reconcilerAt].filter((t): t is EpochMs => t !== null && t > now);
    if (!candidates.length) return;
    const at = Math.min(...candidates) + 50;
    // beyond the next periodic tick the tick itself will be in time
    if (at - now > ENGINE_DEFAULTS.nextWakeCapMs) return;
    if (this.wakeTimer && this.wakeTimer.at <= at) return;
    this.wakeTimer?.cancel();
    const t = this.clock.setTimeout(() => {
      this.wakeTimer = null;
      void this.tickSafely('timer');
    }, at - now);
    this.wakeTimer = { cancel: () => t.cancel(), at };
  }

  private async heartbeat(): Promise<void> {
    if (this.phase !== 'running') return;
    try {
      await this.memoryStore.heartbeat(this.clock.now());
    } catch (e) {
      this.once.warn('heartbeat', `heartbeat could not be saved: ${errorText(e)}`);
    }
  }

  /* ── IEngine: what-if ───────────────────────────────────────────────────────────────────────── */

  dryRun(mutate: (cfg: EngineConfig, inputs: InputSnapshot, memory: EngineMemory) => void, opts: { steps?: number; stepSec?: number } = {}): EvaluateResult {
    const steps = Math.max(1, Math.min(50, Math.round(opts.steps ?? 1)));
    const stepMs = Math.max(1, opts.stepSec ?? ENGINE_DEFAULTS.tickMs / SEC) * SEC;
    const cfg = deepClone(this.config.engineConfig());
    if (!this.inputs) this.preview(this.clock.now());
    const inputs = deepClone(this.inputs as InputSnapshot);
    inputs.prev = deepClone(this.prev());
    const memory = deepClone(this.memoryStore.current());
    let ledger = deepClone(this.memoryStore.ledger());
    mutate(cfg, inputs, memory);
    let mem = memory;
    let prev = inputs.prev;
    let entities = inputs.entities;
    let result: EvaluateResult | null = null;
    for (let i = 0; i < steps; i++) {
      const at = inputs.now + i * stepMs;
      result = evaluate(cfg, { ...inputs, now: at, entities, prev, simulated: true, dryRun: false }, mem, ledger);
      mem = result.memory;
      prev = { rooms: Object.fromEntries(result.rooms.map((r) => [r.roomId, r])), plant: result.plant };
      // in a "what if" every device does what it is told
      entities = { ...entities };
      ledger = { ...ledger };
      for (const d of result.desired) {
        if (d.entityId) {
          const next = obeyed(entities[d.entityId], d.entityId, d.value, at);
          if (next) entities[d.entityId] = next;
        }
        const rec = ledger[d.key];
        ledger[d.key] = {
          key: d.key,
          entityId: d.entityId,
          kind: d.value.kind,
          desired: d.value,
          commanded: d.value,
          commandId: rec?.commandId ?? null,
          reqId: d.reqId,
          commandedAt: rec && JSON.stringify(rec.commanded) === JSON.stringify(d.value) ? rec.commandedAt : at,
          attempts: 1,
          status: 'confirmed',
          confirmedAt: at,
          nextAttemptAt: null,
          lastError: null,
          contextIds: [],
          conflicts: [],
          backoffUntil: null,
          updatedAt: at,
        };
      }
    }
    return result as EvaluateResult;
  }

  /* ── IEngine: actions ───────────────────────────────────────────────────────────────────────── */

  resend(filter: { roomId?: Id; entityId?: EntityId; deviceKey?: string; z2mInstanceId?: Id; all?: boolean }): number {
    const cfg = this.config.engineConfig();
    const keys = this.reconciler.keys().filter((k) => {
      const d = this.reconciler.desiredOf(k);
      if (!d) return false;
      if (filter.all) return true;
      if (filter.roomId !== undefined && d.owner.roomId === filter.roomId) return true;
      if (filter.entityId !== undefined && (d.entityId === filter.entityId || d.key === filter.entityId)) return true;
      const info = this.describe(cfg, d);
      if (filter.deviceKey !== undefined && (info.deviceKey === filter.deviceKey || (d.entityId !== null && filter.deviceKey === `entity:${d.entityId}`))) return true;
      return filter.z2mInstanceId !== undefined && info.zigbee === filter.z2mInstanceId;
    });
    const n = this.reconciler.force(keys);
    if (n) this.requestRun('resend');
    return n;
  }

  async startSourceTest(sourceId: Id, req: SourceTestRequest, actor: Actor): Promise<SourceTestResult> {
    const s = this.config.get('sources', sourceId);
    if (!s) throw notFound('Source');
    this.requireRunning();
    const modes: SourceMode[] = ['heat', 'cool', 'dry', 'fan'];
    const mode = req.mode ?? modes.find((m) => s.capabilities[m]);
    if (!mode || !s.capabilities[mode]) throw validationError([{ path: 'mode', code: 'enum', params: { values: modes.filter((m) => s.capabilities[m]).join('|') } }]);
    const durationSec = Math.round(Math.min(TEST_RANGE_SEC[1], Math.max(TEST_RANGE_SEC[0], req.durationSec ?? TEST_DEFAULT_SEC)));
    const now = this.clock.now();
    const mem = this.memoryStore.current();
    const m = mem.sources[sourceId] ?? defaultSourceMemory(sourceId, now);
    if (m.test && m.test.result === 'running' && now < m.test.until) return this.testResult(sourceId);
    this.memoryStore.apply({ ...mem, sources: { ...mem.sources, [sourceId]: { ...m, test: { mode, startedAt: now, until: now + durationSec * SEC, result: 'running', confirmAfterSec: null } } } });
    this.testsReported.delete(sourceId);
    this.log.log(`${s.name}: check run in ${mode} for ${durationSec} s (${actorName(actor)})`);
    await this.runNow('source.test');
    return this.testResult(sourceId);
  }

  async stopSourceTest(sourceId: Id, actor: Actor): Promise<SourceTestResult | null> {
    const s = this.config.get('sources', sourceId);
    if (!s) throw notFound('Source');
    const now = this.clock.now();
    const mem = this.memoryStore.current();
    const m = mem.sources[sourceId];
    if (!m?.test || now >= m.test.until) return null;
    this.memoryStore.apply({ ...mem, sources: { ...mem.sources, [sourceId]: { ...m, test: { ...m.test, until: now } } } });
    this.log.log(`${s.name}: check run stopped (${actorName(actor)})`);
    await this.runNow('source.test_stop');
    return this.testResult(sourceId);
  }

  private testResult(sourceId: Id): SourceTestResult {
    const m = this.memoryStore.current().sources[sourceId];
    const st = this.result?.plant.sources.find((x) => x.sourceId === sourceId);
    const t = m?.test;
    const now = this.clock.now();
    const status: SourceTestResult['status'] = !t || t.result === null || t.result === 'running' ? (t && now < t.until ? 'running' : 'no_confirm') : t.result;
    const readings: SourceTestResult['readings'] = {};
    for (const b of st?.bindings ?? []) readings[b.role] = b.live;
    if (st?.telemetry.supplyC !== undefined && st.telemetry.supplyC !== null) readings.supplyC = st.telemetry.supplyC;
    if (st?.telemetry.powerKw !== undefined && st.telemetry.powerKw !== null) readings.powerKw = st.telemetry.powerKw;
    return {
      sourceId,
      status,
      startedAt: t?.startedAt ?? now,
      until: t?.until ?? now,
      confirmAfterSec: t?.confirmAfterSec ?? null,
      blockedBy: status === 'blocked' ? (st?.blockers[0] ?? null) : null,
      readings,
    };
  }

  /** Check runs in progress (and the one that just ended) are pushed once a second. */
  private publishTests(result: EvaluateResult, now: EpochMs): void {
    for (const [id, m] of Object.entries(result.memory.sources)) {
      if (!m.test) continue;
      const live = m.test.result === 'running' && now < m.test.until;
      const key = `${m.test.startedAt}|${m.test.result}|${m.test.until}`;
      if (!live && this.testsReported.get(id) === key) continue;
      if (!live && now - m.test.until > 5 * MIN_MS) continue;
      this.testsReported.set(id, key);
      this.cache.sourceTest(this.testResult(id));
    }
  }

  async exercisePump(pumpId: Id, actor: Actor): Promise<void> {
    const p = this.config.get('pumps', pumpId);
    if (!p) throw notFound('Pump');
    this.requireRunning();
    const now = this.clock.now();
    const cfg = this.config.engineConfig();
    const durationSec = cfg.safety.pumpExercise.durationSec;
    const mem = this.memoryStore.current();
    const pm = mem.pumps[pumpId] ?? defaultPumpMemory(pumpId, now);
    this.memoryStore.apply({ ...mem, pumps: { ...mem.pumps, [pumpId]: { ...pm, lastExerciseAt: now, exerciseUntil: now + durationSec * SEC } } });
    await this.record({ code: 'pump.exercise', category: 'src', tone: 'idle', params: { durationSec, by: actorName(actor) }, entityIds: [p.entityId] }, now);
    await this.runNow('pump.exercise');
  }

  async releaseTrvs(roomId: Id, deviceIds: Id[] | 'all', opts: { timeoutMs?: number } = {}): Promise<{ sent: number; confirmed: number }> {
    const cfg = this.config.engineConfig();
    const room = cfg.rooms.find((r) => r.id === roomId);
    if (!room) throw notFound('Room');
    const devices = (cfg.emittersByRoom[room.id] ?? [])
      .flatMap((e) => cfg.devicesByEmitter[e.id] ?? [])
      .filter((d) => d.kind === 'trv' && (deviceIds === 'all' || deviceIds.includes(d.id)));
    if (!devices.length || !this.ha.connected || this.phase !== 'running') return { sent: 0, confirmed: 0 };
    const timeoutMs = Math.max(1000, opts.timeoutMs ?? RELEASE_TIMEOUT_MS);
    const now = this.clock.now();
    const keys: string[] = [];
    for (const dev of devices) {
      for (const d of trvReleaseDesired(dev, room)) {
        this.releases.set(d.key, { desired: d, until: now + timeoutMs + MIN_MS, deviceId: dev.id });
        keys.push(d.key);
      }
    }
    await this.runNow('trv.release');
    // wait until the heads show the release values; a dead head must not hold the delete up
    const shows = (key: string) => {
      const d = this.releases.get(key)?.desired;
      return !d || d.confirm.kind === 'none' || observedMatches(d.value, d.confirm, this.reconciler.observe(d.entityId));
    };
    const started = performance.now();
    while (!keys.every(shows) && performance.now() - started < timeoutMs) await new Promise<void>((resolve) => setTimeout(resolve, 250));
    return { sent: keys.length, confirmed: keys.filter(shows).length };
  }

  private requireRunning(): void {
    if (this.phase !== 'running') throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, 'ha_unavailable', 'The engine is still starting');
  }

  /* ── events from outside ────────────────────────────────────────────────────────────────────── */

  private onConnection(ok: boolean): void {
    const now = this.clock.now();
    if (ok) {
      const down = this.haDownSince;
      const first = !this.everConnected;
      this.haDownSince = null;
      this.everConnected = true;
      if (this.phase === 'starting' || (first && this.phase === 'running')) {
        void this.warmStart(this.phase === 'running');
        this.cache.ha(ok, this.health());
        return;
      }
      if (this.phase !== 'running') return;
      const downSec = down !== null ? Math.max(0, Math.round((now - down) / SEC)) : 0;
      this.pendingDecisions.push({ code: 'ha.reconnected', category: 'system', tone: 'ok', params: { downSec } });
      this.reconciler.quietManualDetection(now + MANUAL_QUIET_MS);
      if (this.config.engineConfig().safety.reconcileOnRestart) this.reconciler.requestResync(null, 'ha_reconnected');
      this.log.log(`Home Assistant is back after ${downSec} s`);
      void this.runNow('ha.reconnected').catch(() => undefined);
    } else {
      if (this.haDownSince === null) this.haDownSince = now;
      if (this.phase !== 'running') return;
      this.pendingDecisions.push({ code: 'ha.disconnected', category: 'system', tone: 'err', params: {} });
      this.requestRun('ha.disconnected');
    }
    this.cache.ha(ok, this.health());
  }

  private onStateChanged(entityId: EntityId, next: HaStateObj | null): void {
    if (this.phase !== 'running') return;
    try {
      this.reconciler.onStateChanged(entityId, next, this.config.engineConfig().safety.conflict);
    } catch (e) {
      this.once.warn('state', `state change of ${entityId} could not be checked: ${errorText(e)}`);
    }
    if (this.interest.has(entityId)) this.requestRun('state');
  }

  private resyncAll(reason: string): void {
    if (this.phase !== 'running' || !this.config.engineConfig().safety.reconcileOnRestart) return;
    this.reconciler.quietManualDetection(this.clock.now() + MANUAL_QUIET_MS);
    this.reconciler.requestResync(null, reason);
    this.requestRun(reason);
  }

  private onConfigChanged(e: { entity: string; id: Id | null; op: string; actor: Actor | null }): void {
    if (e.op === 'imported') this.pendingDecisions.push({ code: 'config.imported', category: 'system', tone: 'event', params: { by: actorName(e.actor) } });
    else if (['source', 'circuit', 'strategy', 'trigger', 'rule'].includes(e.entity) && e.actor && e.actor.via !== 'engine' && e.actor.via !== 'system') {
      this.pendingDecisions.push({ code: 'config.changed', category: 'system', tone: 'event', params: { entity: e.entity, id: e.id, by: actorName(e.actor) }, sourceId: e.entity === 'source' ? e.id : null });
    }
    this.describeCache.clear();
    // the new configuration applies at once
    void this.runNow(`config.${e.entity}`).catch(() => undefined);
  }

  private onBridge(instanceId: Id, online: boolean): void {
    const before = this.bridgeOnline.get(instanceId);
    this.bridgeOnline.set(instanceId, online);
    if (before === undefined || before === online || this.phase !== 'running') return;
    if (!online) {
      this.pendingDecisions.push({ code: 'z2m.offline', category: 'dev', tone: 'err', params: { instanceId } });
      return;
    }
    this.pendingDecisions.push({ code: 'z2m.restart', category: 'dev', tone: 'event', params: { instanceId } });
    const z = this.config.get('z2m', instanceId);
    if (z && !z.resendOnRestart) return;
    const cfg = this.config.engineConfig();
    const keys = this.reconciler.keys().filter((k) => {
      const d = this.reconciler.desiredOf(k);
      return !!d && this.describe(cfg, d).zigbee === instanceId;
    });
    this.reconciler.quietManualDetection(this.clock.now() + MANUAL_QUIET_MS);
    this.reconciler.requestResync(keys, `the ${z?.name ?? 'Zigbee2MQTT'} restart`);
    this.requestRun('z2m.online');
  }

  private onMqtt(connected: boolean): void {
    if (!connected) {
      this.mqttWasDown = true;
      this.pendingDecisions.push({ code: 'mqtt.disconnected', category: 'system', tone: 'warn', params: {} });
    } else if (this.mqttWasDown) {
      this.mqttWasDown = false;
      this.pendingDecisions.push({ code: 'mqtt.connected', category: 'system', tone: 'ok', params: {} });
    }
  }

  /** Command transitions of a room's heads and ACs → «Надсилаю…» progress on the page and the card. */
  private onLedgerChanges(changes: LedgerChange[]): void {
    const result = this.result;
    if (!result) return;
    const cfg = this.config.engineConfig();
    const ledger = this.memoryStore.ledger();
    const rooms = new Set(changes.map((c) => c.roomId).filter((x): x is Id => !!x));
    for (const roomId of rooms) {
      const state = result.rooms.find((r) => r.roomId === roomId);
      const room = cfg.rooms.find((r) => r.id === roomId);
      if (!state || !room) continue;
      const ac = cfg.sources.filter((s) => s.scope === 'room' && s.roomId === roomId && s.adapter.type === 'climate' && s.adapter.climate).map((s) => (s.adapter as { climate: EntityId }).climate);
      const trv = state.trvs.map((t) => t.entityId);
      const sync = roomSyncNow({ trv, ac }, ledger, state.target.displayC ?? state.target.heatC ?? state.target.coolC, room.trv.ack.attempts, this.clock.now());
      const devices = [...trv, ...ac].map((entityId) => ({ entityId, progress: progressOf(ledger[entityId], room.trv.ack.attempts) }));
      this.cache.sync(roomId, sync, devices);
    }
  }

  /** A head or an AC turned by hand: the room takes the value as its target (or Klimo puts its own back). */
  private onManual(m: ManualChange): void {
    if (!m.roomId) return;
    const cfg = this.config.engineConfig();
    const room = cfg.rooms.find((r) => r.id === m.roomId);
    if (!room) return;
    const now = m.at;
    const policy = room.trv.manualPolicy;
    const state = this.result?.rooms.find((r) => r.roomId === room.id);
    const current = state?.target.displayC ?? state?.target.heatC ?? null;
    // heads in on/off or valve mode and ACs in on/off show fixed setpoints: the hand's number is the target
    const absolute = current === null || (m.ownerType === 'trv' && (room.trv.strategy === 'onoff' || room.trv.strategy === 'valve')) || (m.ownerType === 'source' && room.ac.control !== 'target');
    const valueC = round1(Math.min(32, Math.max(5, absolute ? m.valueC : current + (m.valueC - m.commandedC))));
    let userName: string | null = null;
    try {
      userName = m.userId ? (this.attribution()?.userName(m.userId) ?? null) : null;
    } catch {
      userName = null;
    }
    const actor: Actor = { via: 'trv', userId: m.userId, userName, contextId: m.contextId };
    const by = actorName(actor);
    const deviceKey = this.reconciler.infoOf(m.key)?.deviceKey ?? null;
    this.pendingDecisions.push({ code: 'trv.manual', category: 'dev', tone: 'event', params: { valueC, policy, by }, roomId: room.id, deviceKey, entityIds: [m.entityId] });
    this.pendingDetections.push({ kind: 'manual_override', dedupKey: `manual_override:${room.id}:${now}`, active: true, roomId: room.id, entityId: m.entityId, deviceKey, facts: { valueC, by, policy } });
    this.log.log(`${room.name}: ${m.entityId} turned to ${m.valueC}° by hand (${policy})`);
    if (policy === 'revert') {
      this.reconciler.suppress(m.key, now + room.trv.revertAfterSec * SEC, true);
      this.requestRun('trv.manual');
      return;
    }
    this.reconciler.suppress(m.key, now + MANUAL_HOLD_MS, false);
    const actions = this.roomActions();
    if (!actions) return;
    actions.setTarget(room.id, { value: valueC, duration: policy === 'save' ? 'forever' : 'slot' }, actor).catch((e: unknown) => {
      this.log.warn(`${room.name}: the value turned by hand could not be applied: ${errorText(e)}`);
    });
  }

  private onConflict(c: ConflictEvent): void {
    if (c.backoffUntil === null) {
      this.requestRun('conflict');
      return;
    }
    const d = this.reconciler.desiredOf(c.key);
    this.pendingDecisions.push({
      code: 'actuator.conflict',
      category: 'dev',
      tone: 'warn',
      params: { by: c.by },
      roomId: d?.owner.roomId ?? null,
      sourceId: d?.owner.type === 'source' ? d.owner.id : null,
      deviceKey: this.reconciler.infoOf(c.key)?.deviceKey ?? null,
      entityIds: [c.entityId],
    });
    this.requestRun('conflict');
  }
}
