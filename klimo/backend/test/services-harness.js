// Shared set-up for the engine-services tests: real configuration, override, journal and span stores
// on a throw-away SQLite file; Home Assistant, the engine shell and the pure core are fakes the tests
// steer directly.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Logger } = require('@nestjs/common');
const { createDataSource, Db } = require('../dist/db/database');
const { Bus } = require('../dist/common/bus');
const { OverrideStore } = require('../dist/config/override.store');
const { ConfigStore } = require('../dist/config/config.store');
const { JournalService } = require('../dist/journal/journal.service');
const { SpanStore } = require('../dist/journal/span.store');
const { EngineAccess, UndoLedger, ActionSupport } = require('../dist/engine/services/support');
const { RoomActionsService } = require('../dist/engine/services/room-actions.service');
const { HouseActionsService } = require('../dist/engine/services/house-actions.service');
const { ReadModelsService } = require('../dist/engine/services/read-models.service');
const { RoomSetupService } = require('../dist/engine/services/room-setup.service');
const { RoomEditService } = require('../dist/engine/services/room-edit.service');
const { SystemPreviewService } = require('../dist/engine/services/system-preview.service');
const { DeviceHealthService } = require('../dist/engine/services/device-health.service');
const { emptyRoomState, emptySeasonState, emptyHouseProfileState, emptyPlantState } = require('../dist/engine/services/mappers');
const { seedInUkrainian } = require('./foundation-harness');

Logger.overrideLogger(false);

const MIN = 60_000;
const HOUR = 60 * MIN;
/** Wall time in Kyiv (EEST, UTC+3, until 2026-10-25). */
const kyiv = (y, mo, d, h, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h - 3, mi, s);
/** Wednesday 2026-10-21 19:10 local. */
const WED_1910 = kyiv(2026, 10, 21, 19, 10);
const ACTOR = { via: 'ui', userId: 'u1', userName: 'Ігор', contextId: null };

/** A clock the test moves by hand; timers fire when `advance()` passes them. */
class FakeClock {
  constructor(now = WED_1910, tz = 'Europe/Kyiv') {
    this.t = now;
    this.zone = tz;
    this.timers = [];
  }
  now() {
    return this.t;
  }
  tz() {
    return this.zone;
  }
  setTimeout(cb, ms) {
    const timer = { at: this.t + ms, cb, every: null };
    this.timers.push(timer);
    return { cancel: () => (this.timers = this.timers.filter((x) => x !== timer)) };
  }
  setInterval(cb, ms) {
    const timer = { at: this.t + ms, cb, every: ms };
    this.timers.push(timer);
    return { cancel: () => (this.timers = this.timers.filter((x) => x !== timer)) };
  }
  advance(ms) {
    const end = this.t + ms;
    for (;;) {
      const due = this.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.t = due.at;
      if (due.every) due.at += due.every;
      else this.timers = this.timers.filter((x) => x !== due);
      due.cb();
    }
    this.t = end;
  }
}

const iso = (ms) => new Date(ms).toISOString();

/** Just enough of HaPort: states, registries and recorded service calls. */
class FakeHa {
  constructor(clock) {
    this.clock = clock;
    this.connected = true;
    this.simulated = false;
    this.states = new Map();
    this.regs = { areas: [], devices: [], entities: [] };
    this.calls = [];
    this.stateCbs = [];
  }
  /** Sets a state; `opts.reportedAgoMs` / `changedAgoMs` age it relative to the clock. */
  set(entityId, state, attributes = {}, opts = {}) {
    const now = this.clock.now();
    const changed = now - (opts.changedAgoMs ?? opts.reportedAgoMs ?? 0);
    const reported = now - (opts.reportedAgoMs ?? 0);
    const prev = this.states.get(entityId) ?? null;
    const next = { entity_id: entityId, state: String(state), attributes, last_changed: iso(changed), last_updated: iso(reported), last_reported: iso(reported), context: { id: 'c', user_id: null, parent_id: null } };
    this.states.set(entityId, next);
    if (opts.deviceId && !this.regs.entities.some((e) => e.entity_id === entityId)) {
      this.regs.entities.push({ entity_id: entityId, device_id: opts.deviceId, area_id: null, platform: 'mqtt', unique_id: opts.uniqueId ?? entityId, disabled_by: null, hidden_by: null, original_name: null, name: null, entity_category: null });
    }
    for (const cb of this.stateCbs) cb(entityId, next, prev);
  }
  remove(entityId) {
    const prev = this.states.get(entityId) ?? null;
    this.states.delete(entityId);
    this.regs.entities = this.regs.entities.filter((e) => e.entity_id !== entityId);
    if (prev) for (const cb of this.stateCbs) cb(entityId, null, prev);
  }
  getState(id) {
    return this.states.get(id);
  }
  allStates() {
    return [...this.states.values()];
  }
  registries() {
    return this.regs;
  }
  async callService(domain, service, target, data) {
    this.calls.push({ domain, service, entityId: target?.entity_id ?? null, data: data ?? {} });
    return { context: { id: `ctx${this.calls.length}` }, response: null };
  }
  config() {
    return null;
  }
  onConnection() {}
  onStateChanged(cb) {
    this.stateCbs.push(cb);
  }
  onEvent() {}
  onRegistriesUpdated() {}
}

/** IEntitySearch with hand-written details and device-registry facts. */
class FakeSearch {
  constructor() {
    this.details = new Map();
    this.devices = new Map();
    this.areaList = [];
  }
  detail(entityId) {
    return this.details.get(entityId) ?? null;
  }
  deviceOf(entityId) {
    return this.devices.get(entityId) ?? null;
  }
  areas() {
    return this.areaList;
  }
  search() {
    return [];
  }
  discoverArea(areaId) {
    return { areaId, areaName: '', integrations: [], candidates: [] };
  }
  unassigned() {
    return [];
  }
  async notifyServices() {
    return [];
  }
  persons() {
    return [];
  }
  calendars() {
    return [];
  }
}

/** The engine shell as the services see it: states the test sets, recorded runs and dry runs. */
class FakeEngine {
  constructor(cfgOf, clock) {
    this.cfgOf = cfgOf;
    this.clock = clock;
    this.roomStates = new Map();
    this.seasonState = null;
    this.hp = null;
    this.plantState = null;
    this.ledgerData = {};
    this.memoryData = { rooms: {}, sources: {}, pumps: {}, conditions: {}, plant: null, season: null, ema: {} };
    this.inputs = null;
    this.runs = [];
    this.resent = [];
    this.dryRunImpl = null;
    this.dryRuns = [];
  }
  health() {
    return 'ok';
  }
  house() {
    return null;
  }
  room(id) {
    return this.roomStates.get(id);
  }
  rooms() {
    return [...this.roomStates.values()];
  }
  plant() {
    return this.plantState ?? emptyPlantState(this.cfgOf(), () => [], [], this.clock.now());
  }
  season() {
    return this.seasonState ?? { ...emptySeasonState(this.cfgOf(), this.clock.now()), season: 'heating' };
  }
  houseProfile() {
    return this.hp ?? emptyHouseProfileState(this.cfgOf());
  }
  last() {
    return null;
  }
  lastInputs() {
    return this.inputs;
  }
  memory() {
    return this.memoryData;
  }
  ledger() {
    return this.ledgerData;
  }
  requestRun(reason) {
    (this.requested ??= []).push(reason);
  }
  async runNow(reason) {
    this.runs.push(reason);
    return { rooms: this.rooms(), plant: this.plant(), season: this.season(), houseProfile: this.houseProfile(), memory: this.memoryData, desired: [], decisions: [], detections: [], spans: [], expiredOverrideIds: [], edges: [], nextWakeAt: null };
  }
  dryRun(mutate, opts) {
    this.dryRuns.push(opts);
    if (!this.dryRunImpl) throw new Error('no dry run prepared');
    return this.dryRunImpl(mutate, opts);
  }
  resend(filter) {
    this.resent.push(filter);
    return 1;
  }
  async releaseTrvs(roomId, deviceIds, opts) {
    (this.released ??= []).push({ roomId, deviceIds, timeoutMs: opts?.timeoutMs ?? null });
    const n = deviceIds === 'all' ? 0 : deviceIds.length;
    return { sent: n, confirmed: n };
  }
}

/** The pure core functions, reduced to what the services need and the tests can predict. */
function fakeCore(t) {
  return {
    durationUntil(cfg, roomId, duration, now, tz, until) {
      switch (duration) {
        case 'slot':
          return t.slotEnd ?? now + 3 * HOUR;
        case '1h':
          return now + HOUR;
        case '2h':
          return now + 2 * HOUR;
        case '3h':
          return now + 3 * HOUR;
        case '4h':
          return now + 4 * HOUR;
        case 'morning':
          return t.morning ?? now + 12 * HOUR;
        case 'until':
        case 'minutes':
          return until ?? null;
        default:
          return null;
      }
    },
    previewTarget(cfg, room, state, req) {
      return { unchanged: false, tone: 'heat', icon: 'flame', main: { code: 'preview.start_heat', params: { toC: req.value ?? null } }, eta: null, until: null, writesProfileId: null };
    },
    resolveHouseProfile(cfg) {
      return { state: t.resolved ? t.resolved(cfg) : emptyHouseProfileState(cfg), decisions: [], detections: [], spans: [] };
    },
    evalCondition(node) {
      return { eval: { id: node.id ?? 'root', met: true, status: 'ok' }, value: true, memory: null };
    },
    flowFromCurve() {
      return 40;
    },
    evaluate() {
      throw new Error('not used');
    },
  };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'klimo-services-'));
}

async function openServices(opts = {}) {
  const dir = tempDir();
  const clock = opts.clock ?? new FakeClock();
  const ds = await createDataSource({ db: { driver: 'sqlite' }, dataDir: dir, retries: 1 });
  const db = new Db(ds);
  const bus = new Bus();
  const sent = [];
  const events = { send: (m) => sent.push(m), clientCount: () => 0 };
  const overrides = new OverrideStore(db, clock);
  await overrides.load();
  const config = new ConfigStore(db, clock, bus, events, overrides);
  await config.load();
  // names and texts are checked in Ukrainian
  await seedInUkrainian(config);
  sent.length = 0;
  const journal = new JournalService(db, events, bus);
  const spans = new SpanStore(db, events);
  await spans.load();

  const t = { slotEnd: null, morning: null, resolved: null };
  const ha = new FakeHa(clock);
  const search = new FakeSearch();
  const engine = new FakeEngine(() => config.engineConfig(), clock);
  const core = fakeCore(t);
  const incidents = { list: () => t.incidents ?? [], counts: () => ({ critical: 0, warning: 0, total: 0, deviceIssues: 0, inbox: 0 }), get: () => null, ingest() {}, act: async () => null };
  const mqtt = t.mqtt ?? null;
  const providers = { ENGINE: engine, CORE: core, INCIDENTS: incidents };
  const moduleRef = {
    get(token) {
      const p = token === 'MQTT' ? t.mqtt : providers[token];
      if (!p) throw new Error(`no provider for ${token}`);
      return p;
    },
  };
  const access = new EngineAccess(moduleRef);
  const undo = new UndoLedger(clock);
  const support = new ActionSupport(config, journal, clock);
  const roomActions = new RoomActionsService(config, overrides, clock, access, undo, support);
  const houseActions = new HouseActionsService(config, overrides, clock, access, undo, support);
  const readModels = new ReadModelsService(config, overrides, spans, clock, ha, access, roomActions, houseActions);
  const setup = new RoomSetupService(config, clock, ha, search, events, access, support, readModels);
  const edit = new RoomEditService(config, ha, search, readModels, access, support, setup);
  const preview = new SystemPreviewService(config, overrides, clock, ha, access);
  const history = { series: async (q) => (t.series ? t.series(q) : []), statistics: async () => [], roomDay: async () => null, sparks: async () => ({}), outdoor: async () => null };
  const inputs = { z2mBridges: () => t.bridges ?? {} };
  const devices = new DeviceHealthService(config, clock, ha, search, history, inputs, journal, access, events, bus);

  return {
    t,
    dir,
    clock,
    db,
    bus,
    sent,
    overrides,
    config,
    journal,
    spans,
    ha,
    search,
    engine,
    core,
    mqtt,
    roomActions,
    houseActions,
    readModels,
    setup,
    edit,
    preview,
    devices,
    /** A full RoomState for a room with the given fields on top of an empty one. */
    roomState(roomId, patch = {}) {
      const cfg = config.engineConfig();
      const room = cfg.rooms.find((r) => r.id === roomId);
      const base = emptyRoomState(cfg, room, clock.now());
      return {
        ...base,
        ...patch,
        target: { ...base.target, ...(patch.target ?? {}) },
        demand: { ...base.demand, ...(patch.demand ?? {}) },
        activeModes: patch.activeModes ?? { heat: true, cool: false },
        window: { ...base.window, ...(patch.window ?? {}) },
        humidity: { ...base.humidity, ...(patch.humidity ?? {}) },
        sync: { ...base.sync, ...(patch.sync ?? {}) },
      };
    },
    /** The services before the engine shell exists (boot, or a failed start); call before any use. */
    withoutEngine() {
      delete providers.ENGINE;
    },
    setRoom(roomId, patch) {
      const s = this.roomState(roomId, patch);
      engine.roomStates.set(roomId, s);
      return s;
    },
    async close() {
      setup.onModuleDestroy();
      devices.onModuleDestroy();
      await db.destroy();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A heating room whose target comes from the house schedule («Дома»). */
function heatingTarget(heatC, extra = {}) {
  return { heatC, coolC: null, mode: 'heat', displayC: heatC, layer: 'house_schedule', display: 'schedule', profileId: 'home', ...extra };
}

async function rejection(fn) {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected the call to be rejected');
}

module.exports = { ACTOR, FakeClock, HOUR, MIN, WED_1910, heatingTarget, kyiv, openServices, rejection };
