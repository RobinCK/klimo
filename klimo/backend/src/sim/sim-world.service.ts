import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { uuid } from '../common/ids';
import { errorText } from '../common/logger';
import { lazyRef } from '../common/refs';
import { isRewindable } from '../common/rewind';
import { Db } from '../db/database';
import { SEED_HA_KEY } from '../db/seed';
import { houseProfileEdges } from '../engine/core/targets';
import { fromLocal, toLocal } from '../engine/core/time';
import { env } from '../env';
import { defaultPlantMemory, defaultPumpMemory, defaultRoomMemory, defaultSourceMemory } from '../shared/defaults';
import { absoluteHumidity } from '../engine/core/util';
import type {
  ActuatorRecord,
  Actor,
  DesiredActuator,
  EngineConfig,
  EngineMemory,
  EntityId,
  EpochMs,
  EvaluateFn,
  EvaluateResult,
  IConfigStore,
  Id,
  IEngine,
  IEvents,
  IJournal,
  IMemoryStore,
  IOverrideStore,
  InputSnapshot,
  ISimControl,
  ISpanStore,
  Override,
  RoomState,
  SimClockRequest,
  SimFaultRequest,
  SimScenarioId,
  SimStateDto,
} from '../shared/model';
import { CONFIG_STORE, ENGINE, EVALUATE, EVENTS, INCIDENTS, JOURNAL, MEMORY_STORE, OVERRIDE_STORE, SPAN_STORE } from '../tokens';
import { Autopilot, type Command } from './autopilot';
import { readOutdoorSensors } from '../ha/outdoor';
import { buildDemoHouse, ROOM_IDS, SUNNY_WALL_ENTITY } from './demo-house';
import { DEVICES, entityOfRole, entitySpec, ROOM_KEYS, type DeviceSpec, type RoomKey } from './devices';
import { simText } from './language';
import { FakeHaService, guestEvents } from './fake-ha.service';
import { stream, type Rng } from './random';
import { climateFor, SCENARIOS, scenarioStart, type Scenario } from './scenarios';
import { buildSnapshot } from './snapshot';
import { SimClock } from './sim.clock';
import { advanceWorld, Environment, newWorld, relativeHumidity, trvLocalTemp, type Actuation, type World } from './thermal-model';

/* =====================================================================================================
 * The simulated world around Klimo. At boot it seeds the demo house into an empty database, replays a
 * week of weather and heating into the recorder (the last day through the real engine core, so the
 * timeline, run spans and journal match what Klimo itself would have done), sets up the scenario's
 * moment, and then keeps the house alive: physics every virtual 10 s, sensors reporting like Zigbee
 * devices do, the boiler relay's countdown, Zigbee2MQTT device messages.
 * ===================================================================================================== */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const LIVE_STEP = 10_000;
const WARMUP_DAYS = 7;
const WARMUP_STEP = 5 * MIN;
const PREROLL_STEP = 2 * MIN;
const SENSOR_HEARTBEAT = 15 * MIN;
const CONTACT_HEARTBEAT = 50 * MIN;
const SIM_ACTOR: Actor = { via: 'system', userId: null, userName: null, contextId: null };
const DEMO_KEY = 'sim.demo';

interface ReportMemo {
  at: EpochMs;
  values: number[];
  action: string;
}

const round1 = (x: number) => Math.round(x * 10) / 10;

@Injectable()
export class SimWorldService implements ISimControl, OnModuleInit, OnApplicationBootstrap, OnModuleDestroy, OnApplicationShutdown {
  private readonly log = new Logger('Simulator');
  private readonly evaluate: () => EvaluateFn | null;
  private readonly engine: () => IEngine | null;
  private readonly incidents: () => unknown;
  /** Runs the house while no engine is there to do it (a broken or missing engine module). */
  private pilot: { autopilot: Autopilot; at: EpochMs } | null = null;
  private scenarioId: SimScenarioId = env.sim.scenario;
  private active: Scenario = SCENARIOS[env.sim.scenario];
  private env!: Environment;
  private world!: World;
  private rng: Rng = stream(env.sim.seed, 'sensors');
  private readonly reports = new Map<string, ReportMemo>();
  private outdoorSamples: [EpochMs, number][] = [];
  private outdoorHourly: [EpochMs, number][] = [];
  private rhHourly = Object.fromEntries(ROOM_KEYS.map((k) => [k, [] as [EpochMs, number][]])) as Record<RoomKey, [EpochMs, number][]>;
  private loop: { cancel(): void } | null = null;
  private wsTimer: NodeJS.Timeout | null = null;
  private globalsAt = 0;
  private compactedAt = 0;
  private resetting: Promise<SimStateDto> | null = null;

  constructor(
    @Inject(SimClock) private readonly simClock: SimClock,
    @Inject(FakeHaService) private readonly ha: FakeHaService,
    @Inject(CONFIG_STORE) private readonly config: IConfigStore,
    @Inject(MEMORY_STORE) private readonly memory: IMemoryStore,
    @Inject(OVERRIDE_STORE) private readonly overrides: IOverrideStore,
    @Inject(SPAN_STORE) private readonly spans: ISpanStore,
    @Inject(JOURNAL) private readonly journal: IJournal,
    @Inject(EVENTS) private readonly events: IEvents,
    @Inject(Db) private readonly db: Db,
    @Optional() moduleRef?: ModuleRef,
  ) {
    this.evaluate = lazyRef<EvaluateFn>(moduleRef, EVALUATE);
    this.engine = lazyRef<IEngine>(moduleRef, ENGINE);
    this.incidents = lazyRef<unknown>(moduleRef, INCIDENTS);
  }

  async onModuleInit(): Promise<void> {
    await this.seedDemoHouse();
    // a kept database may hold a later day of an earlier run: the scenario starts before it
    await this.forgetAfter(this.simClock.now());
    await this.prepare(this.scenarioId, this.simClock.now());
  }

  onApplicationBootstrap(): void {
    this.ha.connect();
    void this.announceZigbee();
    this.simClock.start();
    this.startLoop();
    this.wsTimer = setInterval(() => {
      if (this.events.clientCount() > 0) this.events.send({ type: 'sim', payload: this.clockPayload() });
    }, 1000);
    this.wsTimer.unref();
  }

  onModuleDestroy(): void {
    this.loop?.cancel();
    if (this.wsTimer) clearInterval(this.wsTimer);
  }

  /** The virtual clock goes last: other modules may still use its timers while they shut down. */
  onApplicationShutdown(): void {
    this.simClock.dispose();
  }

  /* ── ISimControl ─────────────────────────────────────────────────────────────────────────────── */

  state(): SimStateDto {
    const w = this.world;
    return {
      now: this.simClock.now(),
      speed: this.simClock.speed,
      paused: this.simClock.paused,
      scenario: this.scenarioId,
      outdoorC: round1(w.outdoorC),
      rooms: ROOM_KEYS.filter((k) => this.config.get('rooms', ROOM_IDS[k])).map((k) => ({ roomId: ROOM_IDS[k], tempC: round1(w.rooms[k].t), humidityPct: Math.round(relativeHumidity(w.rooms[k].t, w.rooms[k].ah)) })),
      outbox: this.ha.outboxEntries(),
    };
  }

  clock(req: SimClockRequest): SimStateDto {
    if (req.jumpTo !== undefined) {
      this.tick();
      if (req.jumpTo < this.simClock.now()) void this.forgetAfter(req.jumpTo);
      this.simClock.jumpTo(req.jumpTo);
      // going back in time: the house stays as it is, only the calendar moves
      if (req.jumpTo < this.world.now) this.world.now = req.jumpTo;
      this.tick();
    }
    if (req.speed !== undefined) this.simClock.setSpeed(req.speed);
    if (req.paused !== undefined) this.simClock.setPaused(req.paused);
    this.events.send({ type: 'sim', payload: this.clockPayload() });
    return this.state();
  }

  scenario(id: SimScenarioId): Promise<SimStateDto> {
    this.resetting ??= this.reset(id).finally(() => {
      this.resetting = null;
    });
    return this.resetting;
  }

  fault(req: SimFaultRequest): SimStateDto {
    const now = this.simClock.now();
    this.ha.fault(req, now);
    // the device reports right away (a cleared sensor wakes up, a new battery level shows)
    const device = DEVICES.find((d) => d.entities.some((e) => e.entityId === req.entityId));
    if (device) this.reports.delete(device.id);
    this.syncHa(now, { exact: false, live: true });
    return this.state();
  }

  window(entityId: EntityId, open: boolean): SimStateDto {
    if (entitySpec(entityId)?.role !== 'contact') throw new Error(`${entityId} is not a window or door contact`);
    const now = this.simClock.now();
    this.ha.deviceSet(entityId, open ? 'on' : 'off', null, now);
    const d = DEVICES.find((x) => x.entities.some((e) => e.entityId === entityId));
    if (d) void this.ha.zigbeeMessage(d.id, { contact: !open }, now);
    return this.state();
  }

  outdoor(tempC: number): SimStateDto {
    const now = this.simClock.now();
    this.tick();
    this.env.setOutdoorNow(now, tempC);
    this.world.outdoorC = this.env.outdoor(now);
    this.ha.report('sensor.outdoor_temperature', round1(this.world.outdoorC).toFixed(1), null, now);
    this.ha.report(SUNNY_WALL_ENTITY, round1(this.env.sunnyWallC(now)).toFixed(1), null, now);
    return this.state();
  }

  /* ── boot: demo house, history, the scenario's moment ─────────────────────────────────────────── */

  private async seedDemoHouse(): Promise<void> {
    if (await this.db.kvGet(DEMO_KEY)) return;
    if (this.config.list('rooms').length || this.config.list('sources').length) {
      // a database somebody already furnished stays as it is
      await this.db.kvSet(DEMO_KEY, 'kept');
      return;
    }
    const bundle = buildDemoHouse(this.config.exportBundle(), this.simClock.now(), env.sim.lang);
    const result = await this.config.importBundle(bundle, { dryRun: false }, SIM_ACTOR);
    if (!result.ok) {
      this.log.error(`demo house rejected: ${result.issues.slice(0, 8).map((i) => `${i.path} ${i.code}`).join('; ')}`);
      return;
    }
    await this.db.kvSet(SEED_HA_KEY, null);
    await this.db.kvSet(DEMO_KEY, 'seeded');
    this.log.log(`demo house seeded: ${bundle.rooms.length} rooms, ${bundle.sources.length} sources, ${bundle.pumps.length} pumps`);
  }

  private async reset(id: SimScenarioId): Promise<SimStateDto> {
    const scenario = SCENARIOS[id];
    this.loop?.cancel();
    this.loop = null;
    // HA "restarts" while the world is rebuilt; the clock waits so the scenario begins at its moment
    this.ha.disconnect();
    const wasPaused = this.simClock.paused;
    this.simClock.setPaused(true);
    const start = scenarioStart(scenario);
    if (start < this.simClock.now()) await this.forgetAfter(start);
    this.simClock.jumpTo(start);
    for (const o of this.overrides.active()) await this.overrides.remove(o.id);
    await this.prepare(id, start);
    this.simClock.setPaused(wasPaused);
    this.ha.connect();
    void this.announceZigbee();
    this.startLoop();
    this.events.send({ type: 'sim', payload: this.clockPayload() });
    this.log.log(`scenario ${id} from ${new Date(start).toISOString()}`);
    return this.state();
  }

  /**
   * Going back to an earlier day: the journal lines, timelines, alerts and sent messages recorded after
   * it would otherwise sit «in the future», first in every list.
   */
  private async forgetAfter(at: EpochMs): Promise<void> {
    const stores = { journal: this.journal, spans: this.spans, incidents: this.incidents() };
    const removed: string[] = [];
    for (const [name, store] of Object.entries(stores)) {
      if (!isRewindable(store)) continue;
      try {
        const n = await store.forgetAfter(at);
        if (n) removed.push(`${n} ${name}`);
      } catch (e) {
        this.log.warn(`${name} after ${new Date(at).toISOString()} could not be removed: ${errorText(e)}`);
      }
    }
    if (removed.length) this.log.log(`back to ${new Date(at).toISOString()}: removed ${removed.join(', ')} from the later timeline`);
  }

  /** Builds the world and its history up to `t0`, then the scenario's state at `t0`. */
  private async prepare(id: SimScenarioId, t0: EpochMs): Promise<void> {
    const started = performance.now();
    this.scenarioId = id;
    this.active = SCENARIOS[id];
    const sc = this.active;
    this.rng = stream(env.sim.seed, `sensors:${id}`);
    this.env = new Environment(climateFor(sc, t0, env.sim.seed), this.simClock.tz());
    this.reports.clear();
    this.outdoorSamples = [];
    this.outdoorHourly = [];
    this.rhHourly = Object.fromEntries(ROOM_KEYS.map((k) => [k, [] as [EpochMs, number][]])) as Record<RoomKey, [EpochMs, number][]>;
    this.globalsAt = 0;
    this.pilot = null;

    const overrides = this.scenarioOverrides(sc, t0);
    for (const o of overrides) await this.overrides.put(o);

    const history = env.sim.warmup;
    const from = history ? t0 - WARMUP_DAYS * DAY : t0 - 2 * HOUR;
    this.ha.recorder.clear();
    this.ha.resetStates(from);
    this.ha.setBatteryEpoch(t0);
    const initial = Object.fromEntries(ROOM_KEYS.map((k) => [k, history ? sc.initial[k] : sc.atStart[k] ?? sc.initial[k]])) as Record<RoomKey, { t: number; rh: number }>;
    this.world = newWorld(from, this.env, initial);
    this.compactedAt = t0;
    if (history) for (const k of ROOM_KEYS) if (sc.atStart[k]) this.world.rooms[k].calib = { at: t0, ...sc.atStart[k]! };
    this.world.energyCalib = { at: t0, socPct: sc.climate.socAtStartPct };
    // the first reports replace the catalogue's placeholder values
    this.syncHa(from, { exact: false, live: false });

    if (history) await this.replayHistory(sc, t0);
    else this.quickStart(sc, t0);

    // the moment itself: exact values, no sensor noise
    this.world.now = t0;
    this.syncHa(t0, { exact: true, live: false });
    this.ha.recorder.compact(t0);
    this.log.log(`${id}: ${history ? `${WARMUP_DAYS} days of history` : 'no history'} in ${Math.round(performance.now() - started)} ms (${this.ha.recorder.size()} samples)`);
  }

  private scenarioOverrides(sc: Scenario, t0: EpochMs): Override[] {
    const day = toLocal(t0, this.simClock.tz()).date;
    return sc.overrides.map((o) => ({
      id: uuid(),
      scope: o.scope,
      subjectId: o.subject,
      kind: o.kind,
      group: o.group,
      value: o.value,
      duration: o.duration,
      createdAt: t0 + o.createdMin * MIN,
      until: o.untilLocalMin === null ? null : fromLocal(day, o.untilLocalMin, this.simClock.tz()),
      by: { via: 'ui', userId: 'u_ihor', userName: simText('Ігор', env.sim.lang), contextId: null },
      previous: null,
      revertToken: null,
      revertUntil: null,
      reqId: null,
    }));
  }

  /** No history (fast tests): devices set once by the thermostat, the scenario's events back-dated. */
  private quickStart(sc: Scenario, t0: EpochMs): void {
    const cfg = this.config.engineConfig();
    const pilot = new Autopilot(this.simClock.tz(), sc.season);
    this.world.now = t0 - MIN;
    for (const e of sc.events) this.applyEvent(e, t0 + e.atMin * MIN);
    this.actuation();
    this.apply(pilot.decide(cfg, this.world, this.env.outdoor(t0)), t0 - MIN);
    advanceWorld(this.world, this.actuation(), this.env, t0, LIVE_STEP);
    for (const k of ROOM_KEYS) {
      const s = sc.atStart[k];
      if (!s) continue;
      this.world.rooms[k].t = s.t;
      this.world.rooms[k].ah = absoluteHumidity(s.t, s.rh);
    }
  }

  /** A week world-only, then the last day through the engine core (or the thermostat without one). */
  private async replayHistory(sc: Scenario, t0: EpochMs): Promise<void> {
    const cfg = this.config.engineConfig();
    const pilot = new Autopilot(this.simClock.tz(), sc.season);
    const events = [...sc.events].sort((a, b) => a.atMin - b.atMin);
    let nextEvent = 0;
    const fireEvents = (upTo: EpochMs) => {
      while (nextEvent < events.length && t0 + events[nextEvent].atMin * MIN <= upTo) {
        const e = events[nextEvent++];
        this.applyEvent(e, t0 + e.atMin * MIN);
      }
    };

    const prerollFrom = t0 - DAY;
    for (let t = this.world.now; t < prerollFrom; t += WARMUP_STEP) {
      fireEvents(t);
      this.actuation();
      this.apply(pilot.decide(cfg, this.world, this.outdoorMean(t, 10 * MIN)), t);
      const act = this.actuation();
      for (let s = t; s < t + WARMUP_STEP; s += MIN) {
        advanceWorld(this.world, act, this.env, s + MIN, MIN);
        this.tickDevices(s + MIN);
      }
      this.syncHa(t + WARMUP_STEP, { exact: false, live: false });
    }

    const evaluate = this.evaluate();
    const stuck = sc.stuckHead;
    let memory: EngineMemory | null = evaluate ? this.prerollMemory(cfg, prerollFrom, sc) : null;
    let prev: InputSnapshot['prev'] = { rooms: {}, plant: null };
    let last: EvaluateResult | null = null;
    // the house profile's spans and journal lines come from the shell, not the core: replayed here too
    let prevHouse: EvaluateResult['houseProfile'] | null = null;
    const roomTemps: Record<Id, [EpochMs, number][]> = {};
    const writeLogs = evaluate ? (await this.spans.range(prerollFrom, t0)).length === 0 : false;
    let engineFailed = false;

    for (let t = prerollFrom; t < t0; t += PREROLL_STEP) {
      fireEvents(t);
      this.actuation();
      const live = cfg.overrides.filter((o) => o.createdAt <= t && (o.until === null || o.until > t));
      const cfgAt: EngineConfig = { ...cfg, overrides: live };
      if (evaluate && memory && !engineFailed) {
        try {
          const inputs = this.snapshotAt(cfgAt, t, roomTemps, prev);
          const result = evaluate(cfgAt, inputs, memory, {});
          memory = result.memory;
          last = result;
          prev = { rooms: Object.fromEntries(result.rooms.map((r) => [r.roomId, r])), plant: result.plant };
          for (const r of result.rooms) {
            if (r.tempC === null) continue;
            const ring = (roomTemps[r.roomId] ??= []);
            ring.push([t, r.tempC]);
            while (ring.length && ring[0][0] < t - HOUR) ring.shift();
          }
          for (const d of result.desired) {
            if (!d.entityId) continue;
            // the scenario's lost head: its last commands never arrived
            if (stuck && t >= t0 + stuck.fromMin * MIN && d.entityId === stuck.entityId) continue;
            this.ha.applyDesired(d.entityId, d.value, t);
          }
          if (writeLogs) {
            const edges = result.houseProfile?.activeProfileId ? houseProfileEdges(prevHouse, result.houseProfile, t) : null;
            for (const dec of [...result.decisions, ...(edges?.decisions ?? [])]) await this.journal.add(dec, t);
            const spans = [...result.spans, ...(edges?.spans ?? [])];
            if (spans.length) await this.spans.apply(spans);
          }
          if (result.houseProfile?.activeProfileId) prevHouse = result.houseProfile;
          this.recordKlimoSensors(cfgAt, result.rooms, t);
        } catch (e) {
          engineFailed = true;
          this.log.warn(`engine core failed during the warm-up (${errorText(e)}); the thermostat takes over`);
        }
      }
      if (!evaluate || engineFailed) this.apply(pilot.decide(cfgAt, this.world, this.outdoorMean(t, 10 * MIN)), t);
      const act = this.actuation();
      for (let s = t; s < t + PREROLL_STEP; s += 30_000) {
        advanceWorld(this.world, act, this.env, Math.min(t0, s + 30_000), LIVE_STEP);
        this.tickDevices(Math.min(t0, s + 30_000));
        this.syncHa(Math.min(t0, s + 30_000), { exact: false, live: false });
      }
    }
    fireEvents(t0);

    if (memory && last && !engineFailed) {
      this.memory.apply({ ...memory, plant: { ...memory.plant, lastHeartbeatAt: t0 } });
      await this.memory.heartbeat(t0);
      if (stuck) this.seedRetry(stuck, last.desired, t0);
      await this.memory.flushNow();
    }
  }

  /** Fresh control memory a day before the start (the season already decided by the scenario). */
  private prerollMemory(cfg: EngineConfig, at: EpochMs, sc: Scenario): EngineMemory {
    const m: EngineMemory = {
      rooms: Object.fromEntries(cfg.rooms.map((r) => [r.id, defaultRoomMemory(r.id, at)])),
      sources: Object.fromEntries(cfg.sources.map((s) => [s.id, defaultSourceMemory(s.id, at)])),
      pumps: Object.fromEntries(cfg.pumps.map((p) => [p.id, defaultPumpMemory(p.id, at)])),
      conditions: {},
      plant: defaultPlantMemory(at),
      season: { season: sc.season, since: at - 10 * DAY, avgC: sc.climate.avg3dC, avgComputedAt: at, pending: null, bootstrap: false },
      ema: {},
    };
    m.plant.bootCount = this.memory.current().plant.bootCount;
    return m;
  }

  /** «Повтор 2 з 3»: the lost head still shows an older setpoint and its command is mid-retry in the ledger. */
  private seedRetry(stuck: NonNullable<Scenario['stuckHead']>, desired: DesiredActuator[], t0: EpochMs): void {
    const d = desired.find((x) => x.entityId === stuck.entityId);
    if (!d || !d.entityId) return;
    const head = this.ha.getState(d.entityId);
    if (head && d.value.kind === 'climate' && d.value.temperature !== null && head.attributes.temperature === d.value.temperature) {
      this.ha.deviceSet(d.entityId, head.state, { temperature: d.value.temperature - 1 }, t0 + stuck.fromMin * MIN);
    }
    const sentAt = t0 - 50_000;
    const record: ActuatorRecord = {
      key: d.key,
      entityId: d.entityId,
      kind: d.value.kind,
      desired: d.value,
      commanded: d.value,
      commandId: uuid(),
      reqId: null,
      commandedAt: sentAt,
      attempts: stuck.attempt,
      status: 'retrying',
      confirmedAt: null,
      nextAttemptAt: sentAt + d.ackTimeoutSec * 1000,
      lastError: null,
      contextIds: [],
      conflicts: [],
      backoffUntil: null,
      updatedAt: sentAt,
    };
    this.memory.putLedger([record]);
  }

  private snapshotAt(cfg: EngineConfig, t: EpochMs, roomTemps: Record<Id, [EpochMs, number][]>, prev: InputSnapshot['prev']): InputSnapshot {
    const combined = readOutdoorSensors(cfg.settings.outdoor, (id) => this.ha.getState(id), t, '°C').valueC;
    const now = combined === null ? null : round1(combined);
    const calendars = cfg.activationRules.filter((r) => r.enabled && r.config.type === 'calendar').map((r) => (r.config.type === 'calendar' ? r.config.calendarEntityId : ''));
    const calendarEvents: InputSnapshot['calendarEvents'] = {};
    for (const c of new Set(calendars)) {
      calendarEvents[c] = c === 'calendar.family' ? guestEvents(t, t + 2 * DAY, this.simClock.tz()).map((e) => ({ ...e, summary: simText('Гості', env.sim.lang), description: simText('Друзі на вечерю', env.sim.lang), location: '' })) : [];
    }
    const mean = this.outdoorMean(t, DAY / 2);
    return buildSnapshot(cfg, {
      now: t,
      tz: this.simClock.tz(),
      states: this.ha.allStates(),
      host: this.ha,
      roomTempHistory: roomTemps,
      outdoor: { nowC: now, avg10C: this.outdoorMean(t, 10 * MIN), avgNC: this.outdoorAvgDays(t, cfg.season.avgDays), source: 'sensor' },
      humidHours24h: this.humidHours(t),
      calendarEvents,
      forecasts: { 'weather.home': { highToday: round1(mean + 3), lowToday: round1(mean - 3), highTomorrow: round1(mean + 2.5), condition: this.ha.getState('weather.home')?.state ?? null } },
      prev,
    });
  }

  /** Klimo's own temperature and target sensors would have been recorded by HA: fill their history. */
  private recordKlimoSensors(cfg: EngineConfig, rooms: RoomState[], t: EpochMs): void {
    for (const r of rooms) {
      const slug = cfg.rooms.find((x) => x.id === r.roomId)?.slug;
      if (!slug) continue;
      const rec = (id: string, v: number | null, unit: string, dc: string) => {
        if (v === null) return;
        this.ha.recorder.markMeasurement(id);
        this.ha.recorder.record(id, v.toFixed(1), { unit_of_measurement: unit, device_class: dc, state_class: 'measurement' }, t);
      };
      rec(`sensor.klimo_${slug}_temperature`, r.tempC, '°C', 'temperature');
      rec(`sensor.klimo_${slug}_target`, r.target.displayC ?? r.target.heatC ?? r.target.coolC, '°C', 'temperature');
      rec(`sensor.klimo_${slug}_humidity`, r.humidity.valuePct, '%', 'humidity');
      this.ha.recorder.record(`binary_sensor.klimo_${slug}_heat_demand`, r.demand.mode === 'heat' ? 'on' : 'off', null, t);
    }
  }

  private applyEvent(e: Scenario['events'][number], at: EpochMs): void {
    if (e.kind === 'window') this.ha.deviceSet(e.entityId, e.open ? 'on' : 'off', null, at);
    else this.ha.fault(e.fault, at);
  }

  private apply(commands: Command[], at: EpochMs): void {
    for (const c of commands) this.ha.applyDesired(c.entityId, c.value, at);
  }

  /* ── live ─────────────────────────────────────────────────────────────────────────────────────── */

  private startLoop(): void {
    this.loop?.cancel();
    this.loop = this.simClock.setInterval(() => this.tick(), LIVE_STEP);
  }

  private tick(): void {
    if (!this.world) return;
    const now = this.simClock.now();
    if (now <= this.world.now) return;
    if (!this.engine()) this.selfDrive(now);
    const act = this.actuation();
    // after a long jump the house is integrated coarsely; nobody watches those hours
    const gap = now - this.world.now;
    const step = gap > 6 * HOUR ? 5 * MIN : gap > HOUR ? MIN : LIVE_STEP;
    if (gap > 3 * DAY) this.world.now = now - 3 * DAY;
    advanceWorld(this.world, act, this.env, now, step);
    this.tickDevices(now);
    this.syncHa(now, { exact: false, live: true });
    if (now - this.compactedAt >= HOUR) {
      this.compactedAt = now;
      this.ha.recorder.compact(now);
    }
  }

  /** Bridges first, then one message per device: link quality, battery and last seen are known at once. */
  private async announceZigbee(): Promise<void> {
    await this.ha.announceZigbee();
    const now = this.simClock.now();
    for (const d of DEVICES) {
      if (!d.zigbee) continue;
      this.ha.lqi(d.id);
      const values: Record<string, unknown> = {};
      const t = entityOfRole(d, 'temperature');
      const h = entityOfRole(d, 'humidity');
      const contact = entityOfRole(d, 'contact');
      const sw = entityOfRole(d, 'switch');
      if (t) values.temperature = Number(this.ha.getState(t.entityId)?.state);
      if (h) values.humidity = Number(this.ha.getState(h.entityId)?.state);
      if (contact) values.contact = this.ha.getState(contact.entityId)?.state !== 'on';
      if (sw) values.state = this.ha.getState(sw.entityId)?.state === 'on' ? 'ON' : 'OFF';
      await this.ha.zigbeeMessage(d.id, values, now);
    }
  }

  /** Without an engine the house keeps a plain thermostat, so it does not freeze or overheat. */
  private selfDrive(now: EpochMs): void {
    if (!this.pilot) {
      this.pilot = { autopilot: new Autopilot(this.simClock.tz(), this.active.season), at: 0 };
      this.log.warn('no engine is running: the simulated house follows its own thermostat');
    }
    if (now - this.pilot.at < MIN) return;
    this.pilot.at = now;
    this.actuation();
    this.apply(this.pilot.autopilot.decide(this.config.engineConfig(), this.world, this.outdoorMean(now, 10 * MIN)), now);
  }

  private clockPayload(): { now: EpochMs; speed: number; paused: boolean; scenario: SimScenarioId } {
    return { now: this.simClock.now(), speed: this.simClock.speed, paused: this.simClock.paused, scenario: this.scenarioId };
  }

  /* ── devices → world ──────────────────────────────────────────────────────────────────────────── */

  /** What the devices are doing now, read from their HA states. */
  private actuation(): Actuation {
    const st = (id: string) => this.ha.getState(id);
    const on = (id: string) => st(id)?.state === 'on';
    const num = (id: string, fallback: number) => {
      const n = Number(st(id)?.state);
      return Number.isFinite(n) ? n : fallback;
    };
    const attr = (id: string, key: string) => {
      const v = st(id)?.attributes[key];
      return typeof v === 'number' ? v : null;
    };
    const windows = Object.fromEntries(ROOM_KEYS.map((k) => [k, false])) as Record<RoomKey, boolean>;
    const a: Actuation = {
      trvs: [],
      acs: [],
      hp: { available: false, mode: 'off', setpointC: null, error: false },
      boilerRelay: false,
      pumps: { radiators: false, floor: false, primary: false, watts: 0 },
      convector: false,
      dehumidifier: false,
      mixingValveC: num('number.floor_mixing_valve', 35),
      windows,
    };
    for (const d of DEVICES) {
      const b = d.binding;
      switch (b.kind) {
        case 'trv': {
          const c = entityOfRole(d, 'climate')!.entityId;
          const s = st(c);
          const sel = entityOfRole(d, 'sensor_select');
          const ext = entityOfRole(d, 'external_temp');
          const cal = entityOfRole(d, 'calibration');
          const opening = entityOfRole(d, 'valve_opening');
          const externalC = ext ? num(ext.entityId, NaN) : NaN;
          a.trvs.push({
            id: d.id,
            room: b.room,
            gain: b.gain,
            hotOffsetC: b.hotOffsetC,
            available: !!s && s.state !== 'unavailable',
            heating: s?.state === 'heat',
            setpointC: attr(c, 'temperature') ?? 20,
            external: sel ? st(sel.entityId)?.state === 'external' : false,
            externalC: Number.isFinite(externalC) ? externalC : null,
            calibrationC: cal ? num(cal.entityId, 0) : 0,
            maxOpening: opening ? Math.max(0, Math.min(1, num(opening.entityId, 100) / 100)) : 1,
          });
          break;
        }
        case 'contact':
          if (on(entityOfRole(d, 'contact')!.entityId)) windows[b.room] = true;
          break;
        case 'ac': {
          const c = entityOfRole(d, 'climate')!.entityId;
          const s = st(c);
          const mode = s?.state;
          a.acs.push({
            room: b.room,
            available: !!s && mode !== 'unavailable',
            mode: mode === 'heat' || mode === 'cool' || mode === 'dry' || mode === 'fan_only' ? mode : 'off',
            setpointC: attr(c, 'temperature') ?? 24,
          });
          break;
        }
        case 'heat_pump': {
          const s = st('climate.heat_pump');
          const mode = s?.state;
          const err = st('sensor.heat_pump_error_code')?.state ?? '0';
          a.hp = {
            available: !!s && mode !== 'unavailable',
            mode: mode === 'heat' || mode === 'cool' ? mode : 'off',
            setpointC: attr('climate.heat_pump', 'temperature'),
            error: !['0', 'ok', 'none', '', 'unknown', 'unavailable'].includes(err.toLowerCase()),
          };
          break;
        }
        case 'boiler':
          a.boilerRelay = on('switch.boiler_relay');
          break;
        case 'relay': {
          const sw = on(entityOfRole(d, 'switch')!.entityId);
          if (!sw) break;
          if (b.target === 'pump_radiators') a.pumps.radiators = true;
          else if (b.target === 'pump_floor_a' || b.target === 'pump_floor_b') a.pumps.floor = true;
          else if (b.target === 'pump_manifold') a.pumps.primary = true;
          else if (b.target === 'convector') a.convector = true;
          else if (b.target === 'dehumidifier') a.dehumidifier = true;
          if (b.target.startsWith('pump_')) a.pumps.watts += b.powerW;
          break;
        }
        default:
          break;
      }
    }
    for (const k of ROOM_KEYS) this.world.rooms[k].windowOpen = windows[k];
    return a;
  }

  /** Device logic that is not physics: the boiler relay's countdown. */
  private tickDevices(at: EpochMs): void {
    this.ha.tickCountdown(at);
  }

  /* ── world → HA ─────────────────────────────────────────────────────────────────────────────── */

  /**
   * Publishes the world into HA the way devices report: thermometers on a change of 0.1 ° (or 1 %)
   * or every 15 min, heads with their own warm sensor, the heat pump's telemetry, the inverter.
   * `exact` drops the sensor noise (the scenario's own moment, shown to the tenth of a degree).
   */
  private syncHa(at: EpochMs, opts: { exact: boolean; live: boolean }): void {
    const w = this.world;
    const noise = (amp: number) => (opts.exact ? 0 : this.rng.jitter(amp));
    const due = (key: string, values: number[], action: string, threshold: number[], heartbeat = SENSOR_HEARTBEAT): boolean => {
      const m = this.reports.get(key);
      if (opts.exact || !m || at - m.at >= heartbeat || m.action !== action || values.some((v, i) => Math.abs(v - (m.values[i] ?? NaN)) >= threshold[i] || !Number.isFinite(m.values[i]))) {
        this.reports.set(key, { at, values, action });
        return true;
      }
      return false;
    };
    const link = (d: DeviceSpec) => {
      const battery = entityOfRole(d, 'battery');
      const lqi = entityOfRole(d, 'linkquality');
      if (lqi) this.ha.report(lqi.entityId, String(this.ha.lqi(d.id)), null, at);
      const pct = this.ha.batteryPct(d.id, at);
      if (battery && pct !== null) this.ha.report(battery.entityId, String(pct), null, at);
    };
    const zigbee = (d: DeviceSpec, values: Record<string, unknown>) => {
      if (opts.live) void this.ha.zigbeeMessage(d.id, values, at);
    };

    for (const d of DEVICES) {
      const b = d.binding;
      switch (b.kind) {
        case 'thermo': {
          const r = w.rooms[b.room];
          const t = round1(r.t + b.biasC + b.radiatorBiasC * r.radWarm + noise(0.05));
          const rh = Math.round(relativeHumidity(r.t, r.ah) + b.rhBias + noise(0.4));
          if (!due(d.id, [t, rh], '', [0.1, 1])) break;
          if (this.ha.report(entityOfRole(d, 'temperature')!.entityId, t.toFixed(1), null, at)) {
            this.ha.report(entityOfRole(d, 'humidity')!.entityId, String(rh), null, at);
            link(d);
            zigbee(d, { temperature: t, humidity: rh });
          }
          break;
        }
        case 'trv': {
          const r = w.rooms[b.room];
          const c = entityOfRole(d, 'climate')!.entityId;
          const s = this.ha.getState(c);
          if (!s || s.state === 'unavailable') break;
          const cal = entityOfRole(d, 'calibration');
          const calibrationC = cal ? Number(this.ha.getState(cal.entityId)?.state) || 0 : 0;
          const local = round1(trvLocalTemp({ hotOffsetC: b.hotOffsetC, calibrationC }, r.t, r.radWarm) + noise(0.05));
          const v = w.trvOpen[d.id] ?? 0;
          const action = s.state === 'off' ? 'off' : v > 0.02 ? 'heating' : 'idle';
          const pos = Math.round(v * 100);
          if (!due(d.id, [local, b.tuya ? pos : 0], action, [0.1, 5])) break;
          if (this.ha.report(c, s.state, { current_temperature: local, hvac_action: action, running_state: action === 'heating' ? 'heat' : 'idle' }, at)) {
            const position = entityOfRole(d, 'position');
            if (position) this.ha.report(position.entityId, String(pos), null, at);
            link(d);
            zigbee(d, { local_temperature: local, occupied_heating_setpoint: s.attributes.temperature, running_state: action === 'heating' ? 'heat' : 'idle', ...(b.tuya ? { position: pos } : {}) });
          }
          break;
        }
        case 'contact':
          if (due(d.id, [], '', [], CONTACT_HEARTBEAT)) {
            const c = entityOfRole(d, 'contact')!.entityId;
            const s = this.ha.getState(c);
            if (s && this.ha.report(c, s.state, null, at)) {
              link(d);
              zigbee(d, { contact: s.state !== 'on' });
            }
          }
          break;
        case 'relay': {
          const sw = entityOfRole(d, 'switch')!.entityId;
          const on = this.ha.getState(sw)?.state === 'on';
          const power = entityOfRole(d, 'power');
          const watts = on ? Math.round(b.powerW * (1 + noise(0.02))) : 0;
          if (!due(d.id, [watts], on ? 'on' : 'off', [Math.max(5, b.powerW * 0.05)], 5 * MIN)) break;
          if (power) this.ha.report(power.entityId, String(watts), null, at);
          if (d.zigbee) link(d);
          zigbee(d, { state: on ? 'ON' : 'OFF', ...(power ? { power: watts } : {}) });
          break;
        }
        case 'boiler': {
          const flame = w.boiler.flame ? 'on' : 'off';
          if (this.ha.getState('binary_sensor.boiler_flame')?.state !== flame) this.ha.deviceSet('binary_sensor.boiler_flame', flame, null, at);
          if (due(d.id, [], this.ha.getState('switch.boiler_relay')?.state ?? '', [], 5 * MIN)) {
            link(d);
            zigbee(d, { state: this.ha.getState('switch.boiler_relay')?.state === 'on' ? 'ON' : 'OFF', countdown: Number(this.ha.getState('number.boiler_relay_countdown')?.state) || 0 });
          }
          break;
        }
        case 'heat_pump': {
          const s = this.ha.getState('climate.heat_pump');
          if (!s || s.state === 'unavailable') break;
          const defrost = w.hp.defrostUntil !== null && at < w.hp.defrostUntil;
          const action = s.state === 'off' ? 'off' : defrost ? 'defrosting' : w.hp.compressor ? (w.hp.mode === 'cool' ? 'cooling' : 'heating') : 'idle';
          const supply = round1(w.supplyC);
          const power = Math.round(w.hp.electricKw * 1000);
          if (!due(d.id, [supply, power], action, [0.2, 50], 5 * MIN)) break;
          this.ha.report('climate.heat_pump', s.state, { current_temperature: supply, hvac_action: action }, at);
          this.ha.report('binary_sensor.heat_pump_compressor', w.hp.compressor && !defrost ? 'on' : 'off', null, at);
          this.ha.report('binary_sensor.heat_pump_defrost', defrost ? 'on' : 'off', null, at);
          this.ha.report('sensor.heat_pump_power', String(power), null, at);
          this.ha.report('sensor.heat_pump_cop', w.hp.compressor && !defrost ? w.hp.cop.toFixed(1) : '0', null, at);
          this.ha.report('sensor.heat_pump_supply', supply.toFixed(1), null, at);
          break;
        }
        case 'ac': {
          const r = w.rooms[b.room];
          const c = entityOfRole(d, 'climate')!.entityId;
          const s = this.ha.getState(c);
          if (!s || s.state === 'unavailable') break;
          const internal = round1(r.t + 1.0 + noise(0.05));
          const action = s.state === 'off' ? 'off' : r.acAction === 'off' ? 'idle' : r.acAction;
          if (!due(d.id, [internal, r.acPowerW], action, [0.5, 50], 5 * MIN)) break;
          this.ha.report(c, s.state, { current_temperature: internal, hvac_action: action }, at);
          this.ha.report(entityOfRole(d, 'power')!.entityId, String(r.acPowerW), null, at);
          break;
        }
        case 'manifold': {
          const values = [round1(w.supplyC), round1(w.returnC), round1(w.floorSupplyC)];
          if (!due(d.id, values, '', [0.2, 0.2, 0.2], 5 * MIN)) break;
          this.ha.report('sensor.manifold_supply_temperature', values[0].toFixed(1), null, at);
          this.ha.report('sensor.manifold_return_temperature', values[1].toFixed(1), null, at);
          this.ha.report('sensor.floor_supply_temperature', values[2].toFixed(1), null, at);
          break;
        }
        case 'outdoor': {
          const t = round1(w.outdoorC);
          const rh = Math.round(this.env.outdoorRh(at));
          // the means the warm-up decides by follow the configured outdoor sensors, combined
          const combined = this.combinedOutdoor(at) ?? w.outdoorC;
          this.outdoorSamples.push([at, combined]);
          while (this.outdoorSamples.length && this.outdoorSamples[0][0] < at - HOUR) this.outdoorSamples.shift();
          const lastHour = this.outdoorHourly[this.outdoorHourly.length - 1];
          if (!lastHour || at - lastHour[0] >= HOUR) {
            this.outdoorHourly.push([at, combined]);
            while (this.outdoorHourly.length && this.outdoorHourly[0][0] < at - 10 * DAY) this.outdoorHourly.shift();
            for (const k of ROOM_KEYS) {
              const ring = this.rhHourly[k];
              ring.push([at, relativeHumidity(w.rooms[k].t, w.rooms[k].ah)]);
              while (ring.length && ring[0][0] < at - DAY - HOUR) ring.shift();
            }
          }
          if (!due(d.id, [t, rh], '', [0.1, 2], 10 * MIN)) break;
          this.ha.report('sensor.outdoor_temperature', t.toFixed(1), null, at);
          this.ha.report('sensor.outdoor_humidity', String(rh), null, at);
          break;
        }
        case 'sunny_wall': {
          const t = round1(this.env.sunnyWallC(at) + noise(0.05));
          const rh = Math.round(this.env.outdoorRh(at) - 6 + noise(0.4));
          if (!due(d.id, [t, rh], '', [0.1, 2], 10 * MIN)) break;
          if (this.ha.report(entityOfRole(d, 'temperature')!.entityId, t.toFixed(1), null, at)) {
            this.ha.report(entityOfRole(d, 'humidity')!.entityId, String(rh), null, at);
            link(d);
            zigbee(d, { temperature: t, humidity: rh });
          }
          break;
        }
        case 'energy': {
          const e = w.energy;
          const values = [Math.round(e.pvW / 10) * 10, Math.round(e.loadW / 10) * 10, Math.round(e.socPct)];
          if (!due(d.id, values, e.gridOnline ? 'grid' : 'offgrid', [50, 50, 1], 5 * MIN)) break;
          this.ha.report('binary_sensor.grid_offline', e.gridOnline ? 'off' : 'on', null, at);
          this.ha.report('sensor.pv_power', String(values[0]), null, at);
          this.ha.report('sensor.house_load', String(values[1]), null, at);
          this.ha.report('sensor.battery_soc', String(values[2]), null, at);
          break;
        }
        case 'spare':
          if (entityOfRole(d, 'temperature') && due(d.id, [], '', [], 30 * MIN)) {
            const t = round1(w.outdoorC * 0.4 + 7 + noise(0.05));
            this.ha.report(entityOfRole(d, 'temperature')!.entityId, t.toFixed(1), null, at);
            this.ha.report(entityOfRole(d, 'humidity')!.entityId, String(Math.round(this.env.outdoorRh(at) - 10)), null, at);
            link(d);
          }
          break;
        default:
          break;
      }
    }
    if (opts.exact || at - this.globalsAt >= 5 * MIN) {
      this.globalsAt = at;
      this.syncGlobals(at);
    }
  }

  private syncGlobals(at: EpochMs): void {
    const sun = this.env.sun(at);
    const next = (rising: boolean): string | null => {
      for (let t = at + 10 * MIN; t < at + 36 * HOUR; t += 10 * MIN) {
        const up = this.env.sun(t).elevation > -0.83;
        if (up === rising) return new Date(t).toISOString();
      }
      return null;
    };
    const up = sun.elevation > -0.83;
    this.ha.setEntity('sun.sun', up ? 'above_horizon' : 'below_horizon', { elevation: round1(sun.elevation), azimuth: round1(sun.azimuth), rising: sun.azimuth < 180, next_rising: next(true), next_setting: next(false) }, at);
    const cloud = this.env.cloudFactor();
    const condition = cloud < 0.35 ? (up ? 'sunny' : 'clear-night') : cloud < 0.85 ? 'partlycloudy' : 'cloudy';
    this.ha.setEntity('weather.home', condition, { temperature: round1(this.world.outdoorC), humidity: Math.round(this.env.outdoorRh(at)), cloud_coverage: Math.round(100 * Math.max(0, 1 - Math.min(1, cloud))) }, at);
    const ev = guestEvents(at - DAY, at + DAY, this.simClock.tz()).find((e) => e.start <= at && at < e.end);
    const upcoming = guestEvents(at, at + 7 * DAY, this.simClock.tz())[0];
    const shown = ev ?? upcoming;
    this.ha.setEntity('calendar.family', ev ? 'on' : 'off', { message: shown ? simText('Гості', env.sim.lang) : '', start_time: shown ? new Date(shown.start).toISOString() : null, end_time: shown ? new Date(shown.end).toISOString() : null }, at);
  }

  /** The configured outdoor sensors combined as Klimo reads them (null when none reports). */
  private combinedOutdoor(at: EpochMs): number | null {
    return readOutdoorSensors(this.config.engineConfig().settings.outdoor, (id) => this.ha.getState(id), at, '°C').valueC;
  }

  /** Mean of the outdoor sensor over the last `span` (the 10-min mean the plant decides by). */
  private outdoorMean(at: EpochMs, span: number): number {
    const xs = this.outdoorSamples.filter(([t]) => t > at - span && t <= at).map(([, v]) => v);
    return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : this.env.outdoor(at);
  }

  /** Hours with a mean relative humidity above 70 % during the last day, per room (mould warning). */
  private humidHours(at: EpochMs): InputSnapshot['humidHours24h'] {
    const out: InputSnapshot['humidHours24h'] = {};
    for (const k of ROOM_KEYS) out[ROOM_IDS[k]] = this.rhHourly[k].filter(([t, rh]) => t > at - DAY && t <= at && rh > 70).length;
    return out;
  }

  private outdoorAvgDays(at: EpochMs, days: number): number | null {
    const xs = this.outdoorHourly.filter(([t]) => t > at - days * DAY && t <= at).map(([, v]) => v);
    if (xs.length < days * 12) return this.active.climate.avg3dC;
    return round1(xs.reduce((s, v) => s + v, 0) / xs.length);
  }
}
