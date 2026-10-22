// Shared fakes for the Home Assistant tests: a hand-driven clock, a fake HaPort, a minimal config
// store, and a fake WebSocket server side for HaService.
const { Logger } = require('@nestjs/common');
const { Bus } = require('../dist/common/bus');
const { HaService } = require('../dist/ha/ha.service');
const { DEFAULT_ROOM, DEFAULT_SENSOR, defaultSettings, defaultSeason, defaultEnergy } = require('../dist/shared/defaults');

Logger.overrideLogger(false);

const MIN = 60_000;

/** A clock the test moves by hand; timers fire when `advance()` passes them. */
class FakeClock {
  constructor(now = Date.UTC(2026, 9, 21, 16, 0), tz = 'Europe/Kyiv') {
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
  setTimeZone(tz) {
    this.zone = tz;
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

const iso = (t) => new Date(t).toISOString();

function state(entityId, value, attributes = {}, at = Date.UTC(2026, 9, 21, 15, 55)) {
  return { entity_id: entityId, state: String(value), attributes, last_changed: iso(at), last_updated: iso(at), last_reported: iso(at), context: { id: 'c0', user_id: null, parent_id: null } };
}

/** In-memory HaPort: tests set states/registries and answer recorder calls with plain functions. */
class FakeHa {
  constructor() {
    this.connected = true;
    this.simulated = true;
    this.states = new Map();
    this.regs = { areas: [], devices: [], entities: [] };
    this.info = { time_zone: 'Europe/Kyiv', unit_system: { temperature: '°C' }, language: 'uk', version: '2026.10.0', latitude: 50.45, longitude: 30.52 };
    this.cbs = { connection: [], state: [], event: [], registries: [] };
    this.calls = [];
    this.historyCalls = [];
    this.statisticsCalls = [];
    this.historyFn = () => ({});
    this.statisticsFn = () => ({});
    this.serviceFn = () => null;
    this.templateSubs = [];
    this.users = [];
    this.subscribedEvents = [];
  }
  set(s) {
    const prev = this.states.get(s.entity_id) ?? null;
    this.states.set(s.entity_id, s);
    for (const cb of this.cbs.state) cb(s.entity_id, s, prev);
  }
  remove(id) {
    const prev = this.states.get(id) ?? null;
    this.states.delete(id);
    for (const cb of this.cbs.state) cb(id, null, prev);
  }
  setConnected(ok) {
    this.connected = ok;
    for (const cb of this.cbs.connection) cb(ok);
  }
  emitEvent(type, data, context) {
    for (const cb of this.cbs.event) cb(type, data, context);
  }
  onConnection(cb) {
    this.cbs.connection.push(cb);
  }
  onStateChanged(cb) {
    this.cbs.state.push(cb);
  }
  onEvent(cb) {
    this.cbs.event.push(cb);
  }
  onRegistriesUpdated(cb) {
    this.cbs.registries.push(cb);
  }
  getState(id) {
    return this.states.get(id);
  }
  allStates() {
    return [...this.states.values()];
  }
  async callService(domain, service, target, data, returnResponse) {
    this.calls.push({ domain, service, target, data, returnResponse });
    return { context: { id: `ctx${this.calls.length}` }, response: await this.serviceFn(domain, service, target, data) };
  }
  async fireEvent() {}
  async subscribeEvents(type) {
    this.subscribedEvents.push(type);
  }
  async subscribeTemplate(template, variables, cb) {
    const sub = { template, variables, cb, active: true };
    this.templateSubs.push(sub);
    return () => {
      sub.active = false;
    };
  }
  async history(ids, start, end, opts) {
    this.historyCalls.push({ ids, start, end, opts });
    return this.historyFn(ids, start, end, opts);
  }
  async statistics(ids, start, end, period, types) {
    this.statisticsCalls.push({ ids, start, end, period, types });
    return this.statisticsFn(ids, start, end, period, types);
  }
  registries() {
    return this.regs;
  }
  setRegistries(regs) {
    this.regs = regs;
    for (const cb of this.cbs.registries) cb();
  }
  config() {
    return this.info;
  }
  async authUsers() {
    return this.users;
  }
  async ensureLovelaceResource() {
    return 'exists';
  }
}

/** Just enough of IConfigStore for the HA services. */
class FakeConfig {
  constructor() {
    this.rooms = [];
    this.sensors = {};
    this.settings = defaultSettings('uk');
    this.season = defaultSeason();
    this.energy = defaultEnergy();
    this.schedules = [];
    this.activationRules = [];
    this.triggers = [];
    this.rules = [];
    this.sources = [];
    this.watchRules = [];
    this.z2m = [];
    this.uses = new Map(); // entityId → UsageRef[]
  }
  addRoom(id, name, slug, extra = {}) {
    const room = { ...DEFAULT_ROOM(), id, name, slug, ...extra };
    this.rooms.push(room);
    return room;
  }
  addSensor(roomId, entityId, role = 'temperature', extra = {}) {
    const s = { ...DEFAULT_SENSOR(), id: `rs_${entityId}`, roomId, entityId, role, ...extra };
    (this.sensors[roomId] ??= []).push(s);
    return s;
  }
  use(entityId, ref) {
    this.uses.set(entityId, [...(this.uses.get(entityId) ?? []), ref]);
  }
  engineConfig() {
    return {
      revision: 1,
      settings: this.settings,
      season: this.season,
      energy: this.energy,
      rooms: this.rooms,
      sensorsByRoom: this.sensors,
      schedules: this.schedules,
      activationRules: this.activationRules,
      triggers: this.triggers,
      rules: this.rules,
      sources: this.sources,
      watchRules: this.watchRules,
    };
  }
  room(idOrSlug) {
    return this.rooms.find((r) => r.id === idOrSlug || r.slug === idOrSlug);
  }
  list(c) {
    if (c === 'z2m') return this.z2m;
    if (c === 'rooms') return this.rooms;
    return [];
  }
  singleton(k) {
    return this[k];
  }
  usages(ref) {
    return ref.type === 'entity' ? this.uses.get(ref.id) ?? [] : [];
  }
  referencedEntities() {
    return [...this.uses.keys()];
  }
}

/** HaService with an in-process fake server instead of a socket. */
class TestHaService extends HaService {
  constructor(clock, bus = new Bus()) {
    super(clock, bus);
    this.server = null;
    this.sockets = 0;
  }
  openSocket(_url, handlers) {
    this.sockets++;
    const server = new FakeServer(handlers);
    this.server = server;
    // the socket connects asynchronously, like the real one
    setImmediate(() => server.hello());
    return { send: (text) => server.receive(JSON.parse(text)), close: () => server.drop() };
  }
}

/** Minimal Home Assistant WebSocket server: auth, the ready sequence, templates, ping. */
class FakeServer {
  constructor(handlers) {
    this.h = handlers;
    this.log = [];
    this.closed = false;
    this.token = 'secret';
    this.states = [];
    this.answer = {}; // type → result or (msg) => result
    this.silent = new Set(); // message types the server never answers
  }
  hello() {
    if (!this.closed) this.h.message(JSON.stringify({ type: 'auth_required', ha_version: '2026.10.0' }));
  }
  push(msg) {
    if (!this.closed) setImmediate(() => !this.closed && this.h.message(JSON.stringify(msg)));
  }
  receive(msg) {
    this.log.push(msg);
    if (msg.type === 'auth') {
      this.push(msg.access_token === this.token ? { type: 'auth_ok' } : { type: 'auth_invalid', message: 'Invalid access token' });
      return;
    }
    if (this.silent.has(msg.type)) return;
    if (msg.type === 'ping') {
      this.push({ id: msg.id, type: 'pong' });
      return;
    }
    const custom = this.answer[msg.type];
    let result = null;
    if (custom !== undefined) result = typeof custom === 'function' ? custom(msg) : custom;
    else if (msg.type === 'get_states') result = this.states;
    else if (msg.type === 'get_config') result = { time_zone: 'Europe/Kyiv', unit_system: { temperature: '°C' }, language: 'uk', version: '2026.10.0', latitude: 50.45, longitude: 30.52 };
    else if (/registry\/list$/.test(msg.type)) result = [];
    if (result && result.__error) {
      this.push({ id: msg.id, type: 'result', success: false, error: result.__error });
      return;
    }
    this.push({ id: msg.id, type: 'result', success: true, result });
  }
  sent(type) {
    return this.log.filter((m) => m.type === type);
  }
  event(subscriptionId, event) {
    this.push({ id: subscriptionId, type: 'event', event });
  }
  drop() {
    if (this.closed) return;
    this.closed = true;
    setImmediate(() => this.h.close());
  }
}

/** Resolves after pending immediates and microtasks (the fake server answers asynchronously). */
async function settle(rounds = 20) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

module.exports = { MIN, FakeClock, FakeHa, FakeConfig, TestHaService, FakeServer, Bus, state, iso, settle };
