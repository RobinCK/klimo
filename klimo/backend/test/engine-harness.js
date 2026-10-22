// Fixtures for the engine shell tests: a small house (one radiator room with a head, a gas boiler on a
// relay with a countdown watchdog, a radiator circuit and its pump), a hand-driven clock, a Home
// Assistant stand-in whose devices obey (or not), and in-memory stores that log what happens in which
// order. The real snapshot, reconciler, command bus, runtime cache and engine service run on top.
const { Logger } = require('@nestjs/common');
const d = require('../dist/shared/defaults');
const { sourceEntities } = require('../dist/config/refs');
const { Bus } = require('../dist/common/bus');
const { EngineService } = require('../dist/engine/engine.service');
const { SnapshotService } = require('../dist/engine/snapshot.service');
const { ReconcilerService } = require('../dist/engine/reconciler.service');
const { CommandBus } = require('../dist/engine/command-bus');
const { RuntimeCache } = require('../dist/engine/runtime.cache');

Logger.overrideLogger(false);

const KYIV = 'Europe/Kyiv';
const SEC = 1000;
const MIN = 60_000;
/** Wall time in Kyiv while on summer time (EEST, UTC+3 — until 2026-10-25). */
const kyiv = (y, mo, day, h, mi = 0, s = 0) => Date.UTC(y, mo - 1, day, h - 3, mi, s);
/** Wednesday 2026-10-21 19:10 local: the seeded schedule has «Дома» until 23:00. */
const WED_1910 = kyiv(2026, 10, 21, 19, 10);

const clone = (v) => JSON.parse(JSON.stringify(v));
const iso = (ms) => new Date(ms).toISOString();
/** Lets queued promise chains (bus dispatch, journal writes) run. */
const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

/* ── clock ─────────────────────────────────────────────────────────────────────────────────────── */

class FakeClock {
  constructor(t) {
    this.t = t;
    this.timers = [];
    this.seq = 0;
  }
  now() {
    return this.t;
  }
  tz() {
    return KYIV;
  }
  setTimeout(cb, ms) {
    const timer = { at: this.t + Math.max(0, ms), cb, every: null, seq: this.seq++ };
    this.timers.push(timer);
    return { cancel: () => (this.timers = this.timers.filter((x) => x !== timer)) };
  }
  setInterval(cb, ms) {
    const timer = { at: this.t + ms, cb, every: ms, seq: this.seq++ };
    this.timers.push(timer);
    return { cancel: () => (this.timers = this.timers.filter((x) => x !== timer)) };
  }
  /** Runs every timer due until `this.t + ms`, in time order, letting async work settle in between. */
  async advance(ms) {
    const end = this.t + ms;
    for (;;) {
      const due = this.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!due) break;
      this.t = Math.max(this.t, due.at);
      if (due.every) due.at += due.every;
      else this.timers = this.timers.filter((x) => x !== due);
      due.cb();
      await flush();
    }
    this.t = end;
    await flush();
  }
}

/* ── Home Assistant ────────────────────────────────────────────────────────────────────────────── */

class FakeHa {
  constructor(clock, log) {
    this.clock = clock;
    this.log = log;
    this.connected = true;
    this.simulated = false;
    this.states = new Map();
    this.calls = [];
    this.deaf = new Set();
    this.ctx = 0;
    this.connectionCbs = [];
    this.stateCbs = [];
    this.eventCbs = [];
  }
  set(entityId, state, attributes = {}, opts = {}) {
    const prev = this.states.get(entityId) ?? null;
    const at = this.clock.now();
    const context = opts.context ?? { id: `dev${++this.ctx}`, user_id: null, parent_id: null };
    const next = {
      entity_id: entityId,
      state: String(state),
      attributes: { ...(opts.replace ? {} : prev?.attributes ?? {}), ...attributes },
      last_changed: prev && prev.state === String(state) ? prev.last_changed : iso(opts.changedAt ?? at),
      last_updated: iso(at),
      last_reported: iso(at),
      context,
    };
    this.states.set(entityId, next);
    if (opts.silent) return next;
    for (const cb of this.stateCbs) cb(entityId, next, prev);
    return next;
  }
  /** A foreign change: an automation (`by: 'automation'`) or a person (`by: 'user'`). */
  foreign(entityId, state, attributes, by) {
    const context = { id: `foreign${++this.ctx}`, user_id: by === 'user' ? 'u_ihor' : null, parent_id: by === 'automation' ? 'auto_ctx' : null };
    return this.set(entityId, state, attributes, { context });
  }
  connect(ok) {
    this.connected = ok;
    for (const cb of this.connectionCbs) cb(ok);
  }
  onConnection(cb) {
    this.connectionCbs.push(cb);
  }
  onStateChanged(cb) {
    this.stateCbs.push(cb);
  }
  onEvent(cb) {
    this.eventCbs.push(cb);
  }
  getState(id) {
    return this.states.get(id);
  }
  allStates() {
    return [...this.states.values()];
  }
  async callService(domain, service, target, data = {}) {
    if (!this.connected) throw new Error('Home Assistant is not connected');
    const entityId = target?.entity_id ?? null;
    const id = `klimo${++this.ctx}`;
    this.calls.push({ domain, service, entityId, data, at: this.clock.now() });
    this.log.push(`call ${domain}.${service} ${entityId}`);
    if (entityId && !this.deaf.has(entityId)) this.apply(entityId, domain, service, data, { id, user_id: null, parent_id: null });
    return { context: { id }, response: null };
  }
  apply(entityId, domain, service, data, context) {
    const s = this.states.get(entityId);
    if (!s || s.state === 'unavailable') return;
    const set = (state, attrs = {}) => this.set(entityId, state, attrs, { context });
    if (service === 'turn_on') set('on');
    else if (service === 'turn_off') set('off');
    else if (service === 'set_value') set(String(data.value));
    else if (service === 'select_option') set(String(data.option));
    else if (service === 'set_hvac_mode') set(data.hvac_mode, { hvac_action: data.hvac_mode === 'off' ? 'off' : 'heating' });
    else if (service === 'set_temperature') set(data.hvac_mode ?? s.state, { temperature: data.temperature });
  }
  async fireEvent() {}
  async subscribeEvents() {}
  async subscribeTemplate() {
    return () => undefined;
  }
  async history() {
    return {};
  }
  async statistics() {
    return {};
  }
  registries() {
    return { areas: [], devices: [], entities: [] };
  }
  onRegistriesUpdated() {}
  config() {
    return { time_zone: KYIV, unit_system: { temperature: '°C' }, language: 'uk', version: '2026.10.0', latitude: 50.4, longitude: 30.5 };
  }
  async authUsers() {
    return [];
  }
  async ensureLovelaceResource() {
    return 'exists';
  }
}

/* ── stores ────────────────────────────────────────────────────────────────────────────────────── */

class FakeMemory {
  constructor(memory, log, clock) {
    this.mem = memory;
    this.led = {};
    this.log = log;
    this.clock = clock;
    this.flushes = 0;
    this.heartbeats = [];
  }
  async load() {
    return this.mem;
  }
  current() {
    return this.mem;
  }
  apply(next) {
    for (const [id, m] of Object.entries(next.sources)) if (m.on !== this.mem.sources[id]?.on) this.log.push(`memory ${id} ${m.on ? 'on' : 'off'}`);
    this.mem = next;
  }
  ledger() {
    return this.led;
  }
  putLedger(records) {
    if (!records.length) return;
    this.led = { ...this.led };
    for (const r of records) this.led[r.key] = r;
  }
  removeLedger(keys) {
    if (!keys.length) return;
    this.led = { ...this.led };
    for (const k of keys) delete this.led[k];
  }
  async flushNow() {
    this.flushes++;
    await new Promise((r) => setImmediate(r));
    this.log.push('flushNow');
  }
  async heartbeat(at) {
    this.heartbeats.push(at);
    this.mem = { ...this.mem, plant: { ...this.mem.plant, lastHeartbeatAt: at } };
  }
  healthy() {
    return true;
  }
}

class FakeOverrides {
  constructor(cfg) {
    this.cfg = cfg;
    this.rows = [];
  }
  active() {
    return [...this.rows];
  }
  forSubject(scope, id) {
    return this.rows.filter((o) => o.scope === scope && o.subjectId === id);
  }
  byRevertToken() {
    return undefined;
  }
  async put(o) {
    this.rows = [...this.rows.filter((x) => !(x.scope === o.scope && x.subjectId === o.subjectId && x.group === o.group)), o];
    this.cfg.overrides = this.active();
    this.cfg.revision++;
    return o;
  }
  async remove(id) {
    this.rows = this.rows.filter((o) => o.id !== id);
    this.cfg.overrides = this.active();
  }
  async removeGroup() {
    return null;
  }
  async expire(now) {
    const due = this.rows.filter((o) => o.until !== null && o.until <= now);
    if (due.length) {
      this.rows = this.rows.filter((o) => !due.includes(o));
      this.cfg.overrides = this.active();
      this.cfg.revision++;
    }
    return due;
  }
}

class FakeJournal {
  constructor() {
    this.entries = [];
  }
  async add(decision, ts) {
    this.entries.push({ ...decision, ts });
    return null;
  }
  async page() {
    return { items: [], nextBefore: null };
  }
  codes() {
    return this.entries.map((e) => e.code);
  }
}

class FakeSpans {
  constructor() {
    this.events = [];
    this.openSpans = [];
    this.closed = [];
  }
  async apply(events) {
    this.events.push(...events);
    return [];
  }
  open() {
    return [...this.openSpans];
  }
  async range() {
    return [];
  }
  async closeDangling(at, stillOn) {
    const gone = this.openSpans.filter((s) => !stillOn(s));
    this.closed.push(...gone.map((s) => ({ ...s, endTs: at })));
    this.openSpans = this.openSpans.filter((s) => stillOn(s));
    return gone.length;
  }
}

/* ── the house ─────────────────────────────────────────────────────────────────────────────────── */

function boiler(over = {}) {
  const s = d.newSourceConfig('gas_boiler', { id: 's_boiler', name: 'Котел', now: 0 });
  return {
    ...s,
    enabled: true,
    adapter: { ...s.adapter, command: 'switch.boiler_relay', confirm: { kind: 'readback' }, watchdog: { kind: 'countdown_number', entityId: 'number.boiler_countdown', minutes: 15, rearmEveryMin: 5 }, ...(over.adapter ?? {}) },
    failsafe: { onStop: 'leave', handback: null },
    ...over.source,
  };
}

/** One radiator room with a head, a boiler on the radiator circuit, the circuit's pump. */
function makeCfg(o = {}) {
  const room = { ...d.DEFAULT_ROOM(), id: 'r_living', slug: 'vitalnia', name: 'Вітальня', ...o.room };
  room.temperature = { ...room.temperature, smoothingMin: 0 };
  const sensors = [
    { ...d.DEFAULT_SENSOR(), id: 'rs_1', roomId: room.id, entityId: 'sensor.living_t1', role: 'temperature', name: 't1', order: 0 },
    { ...d.DEFAULT_SENSOR(), id: 'rs_2', roomId: room.id, entityId: 'sensor.living_t2', role: 'temperature', name: 't2', order: 1 },
  ];
  const emitter = { ...d.DEFAULT_EMITTER(), id: 'e_rad', roomId: room.id, kind: 'radiator', name: 'Радіатор', circuitId: 'c_rad', roles: { heat: 'primary', cool: null } };
  const trv = {
    ...d.DEFAULT_EMITTER_DEVICE(),
    id: 'd_trv',
    emitterId: 'e_rad',
    roomId: room.id,
    kind: 'trv',
    entityId: 'climate.living_trv',
    name: 'Головка',
    haDeviceId: 'dev_trv',
    capabilities: { ...d.DEFAULT_TRV_CAPABILITIES, externalSensor: true },
    siblings: { ...d.DEFAULT_TRV_SIBLINGS, externalTemp: 'number.living_trv_external', sensorSelect: 'select.living_trv_sensor' },
    order: 0,
  };
  const circuit = { ...d.DEFAULT_CIRCUIT(), id: 'c_rad', name: 'Радіатори', shortName: 'Радіатори', kind: 'radiators', sourceIds: ['s_boiler'], capabilities: { heat: true, cool: false } };
  const pump = { ...d.DEFAULT_PUMP(), id: 'p_rad', name: 'Насос радіаторів', circuitId: 'c_rad', entityId: 'switch.rad_pump', rule: 'source', ...o.pump };
  const b = boiler(o.boiler ?? {});
  const cfg = {
    revision: 1,
    settings: { ...d.defaultSettings('uk'), outdoor: { ...d.defaultSettings('uk').outdoor, sensorEntityIds: [] } },
    safety: { ...d.defaultSafety(), ...(o.safety ?? {}) },
    house: d.defaultHouse(),
    rooms: [room],
    sensorsByRoom: { [room.id]: sensors },
    emittersByRoom: { [room.id]: [emitter] },
    devicesByEmitter: { e_rad: [trv] },
    profiles: d.seedProfiles('uk'),
    profileRooms: [],
    activationRules: [],
    schedules: [{ id: 'house', scope: 'house', roomId: null, enabled: true, days: d.seedHouseDays(), updatedAt: 0 }],
    scheduleExceptions: [],
    sources: [b],
    manifolds: [],
    circuits: [circuit],
    pumps: [pump],
    heat: { ...d.defaultHeatStrategy(), chain: [{ id: 'ce_0', sourceIds: ['s_boiler'], label: null, enabled: true }] },
    cool: d.defaultCoolStrategy(),
    season: d.defaultSeason(),
    energy: d.defaultEnergy(),
    triggers: [],
    rules: [],
    watchRules: [],
    overrides: [],
  };
  return cfg;
}

function referenced(cfg) {
  const out = new Set();
  for (const list of Object.values(cfg.sensorsByRoom)) for (const s of list) out.add(s.entityId);
  for (const list of Object.values(cfg.devicesByEmitter)) {
    for (const dev of list) {
      out.add(dev.entityId);
      for (const v of Object.values(dev.siblings ?? {})) if (v) out.add(v);
    }
  }
  for (const s of cfg.sources) for (const e of sourceEntities(s)) out.add(e);
  for (const p of cfg.pumps) out.add(p.entityId);
  return [...out].sort();
}

class FakeConfig {
  constructor(cfg) {
    this.cfg = cfg;
  }
  revision() {
    return this.cfg.revision;
  }
  engineConfig() {
    return this.cfg;
  }
  referencedEntities() {
    return referenced(this.cfg);
  }
  get(c, id) {
    const list = { sources: this.cfg.sources, pumps: this.cfg.pumps, rooms: this.cfg.rooms, z2m: [] }[c] ?? [];
    return list.find((x) => x.id === id);
  }
  list(c) {
    return { sources: this.cfg.sources, pumps: this.cfg.pumps, rooms: this.cfg.rooms, z2m: [] }[c] ?? [];
  }
  room(id) {
    return this.cfg.rooms.find((r) => r.id === id || r.slug === id);
  }
  singleton(k) {
    return this.cfg[k];
  }
}

function makeMemory(cfg, now) {
  return {
    rooms: Object.fromEntries(cfg.rooms.map((r) => [r.id, d.defaultRoomMemory(r.id, now - 10 * SEC)])),
    sources: Object.fromEntries(cfg.sources.map((s) => [s.id, d.defaultSourceMemory(s.id, now - 10 * SEC)])),
    pumps: Object.fromEntries(cfg.pumps.map((p) => [p.id, d.defaultPumpMemory(p.id, now - 10 * SEC)])),
    conditions: {},
    plant: { ...d.defaultPlantMemory(now - 10 * SEC), lastHeartbeatAt: now - 30 * SEC, bootCount: 2 }, // the store counts a boot as it loads: this is a restart
    season: { season: 'heating', since: now - 10 * 24 * 3600 * SEC, avgC: 5, avgComputedAt: now, pending: null, bootstrap: false },
    ema: {},
  };
}

/** The house in HA: sensors at `t`, the head, its siblings, the relay, the pump and the countdown. */
function seedStates(ha, o = {}) {
  const t = o.t ?? 19.6;
  ha.set('sensor.living_t1', String(t), { unit_of_measurement: '°C', device_class: 'temperature' }, { silent: true });
  ha.set('sensor.living_t2', String(t), { unit_of_measurement: '°C', device_class: 'temperature' }, { silent: true });
  ha.set('climate.living_trv', 'heat', { hvac_modes: ['off', 'heat'], temperature: o.trvC ?? 21.5, current_temperature: t + 1, min_temp: 4, max_temp: 35, target_temp_step: 0.5 }, { silent: true });
  ha.set('number.living_trv_external', String(t), { min: -10, max: 50 }, { silent: true });
  ha.set('select.living_trv_sensor', 'external', { options: ['internal', 'external'] }, { silent: true });
  ha.set('switch.boiler_relay', o.relay ?? 'off', {}, { silent: true });
  ha.set('number.boiler_countdown', '0', { min: 0, max: 60 }, { silent: true });
  ha.set('switch.rad_pump', o.pump ?? 'off', {}, { silent: true });
}

/** A complete engine on fakes. `o.memory(cfg, now)` adjusts the memory before the boot. */
function makeEngine(o = {}) {
  const now = o.now ?? WED_1910;
  const clock = new FakeClock(now);
  const log = [];
  const cfg = o.cfg ?? makeCfg(o);
  const ha = new FakeHa(clock, log);
  seedStates(ha, o.states ?? {});
  const memory = new FakeMemory(o.memoryOf ? o.memoryOf(cfg, now) : makeMemory(cfg, now), log, clock);
  const config = new FakeConfig(cfg);
  const overrides = new FakeOverrides(cfg);
  const journal = new FakeJournal();
  const spans = new FakeSpans();
  const bus = new Bus();
  const sent = [];
  const events = { send: (m) => sent.push(m), clientCount: () => 1 };
  const ingested = [];
  const incidents = { ingest: (dets, at) => ingested.push({ at, dets }), counts: () => ({ critical: 0, warning: 0, total: 0, deviceIssues: 0, inbox: 0 }), list: () => [], get: () => null };
  const roomActionsCalls = [];
  const roomActions = { setTarget: async (roomId, req, actor) => roomActionsCalls.push({ roomId, req, actor }) };
  const providers = { INCIDENTS: incidents, ROOM_ACTIONS: roomActions, ...(o.providers ?? {}) };
  const moduleRef = { get: (token) => { if (token in providers) return providers[token]; throw new Error(`no ${token}`); } };
  const haInputs = {
    outdoor: () => ({ nowC: 4.2, avg10C: 4.2, avgNC: 6, source: 'sensor' }),
    forecasts: () => ({}),
    calendarEvents: () => ({}),
    templateResults: () => ({}),
    syncTemplates: () => undefined,
    renderTemplate: async () => ({ result: null, error: null }),
    humidHours24h: () => ({}),
    z2mBridges: () => ({}),
  };
  const snapshot = new SnapshotService(ha, haInputs);
  const commands = new CommandBus(ha, config, moduleRef);
  const reconciler = new ReconcilerService(ha, memory, clock, commands);
  const cache = new RuntimeCache(events, bus, moduleRef);
  const engine = new EngineService(clock, ha, config, memory, overrides, journal, spans, haInputs, bus, snapshot, reconciler, commands, cache, moduleRef);
  return {
    engine,
    clock,
    ha,
    memory,
    config,
    cfg,
    overrides,
    journal,
    spans,
    bus,
    sent,
    ingested,
    roomActionsCalls,
    reconciler,
    commands,
    log,
    /** Starts the engine and lets the warm start finish. */
    async boot() {
      engine.start();
      await flush(12);
    },
    advance: (ms) => clock.advance(ms),
    callsTo: (entityId) => ha.calls.filter((c) => c.entityId === entityId),
  };
}

module.exports = { d, KYIV, SEC, MIN, kyiv, WED_1910, clone, flush, FakeClock, FakeHa, FakeMemory, makeCfg, makeMemory, makeEngine, seedStates, referenced };
