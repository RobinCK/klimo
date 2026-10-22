// Shared set-up for the REST API tests: the real controllers, guard and user middleware in a small Nest
// app whose ports are in-memory fakes the tests inspect. No database, no Home Assistant.
const { Global, Logger, Module, RequestMethod } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');

const { env } = require('../dist/env');
// the simulator and the development flag make every caller an admin; these tests need real roles
Object.assign(env, { simulate: false, devAdmin: false });

const { ApiModule, API_CONTROLLERS } = require('../dist/api/api.module');
const { ApiExceptionFilter, ApiException } = require('../dist/common/http');
const { UserMiddleware } = require('../dist/common/user.middleware');
const defaults = require('../dist/shared/defaults');
const T = require('../dist/tokens');

Logger.overrideLogger(false);

/** Wednesday 2026-10-21 19:10 in Kyiv (UTC+3). */
const NOW = Date.UTC(2026, 9, 21, 16, 10);
const ADMIN = { 'X-Remote-User-Id': 'u_admin', 'X-Remote-User-Name': 'ihor' };
const MEMBER = { 'X-Remote-User-Id': 'u_olia', 'X-Remote-User-Name': 'olia' };

class FakeClock {
  constructor(now = NOW) {
    this.t = now;
  }
  now() {
    return this.t;
  }
  tz() {
    return 'Europe/Kyiv';
  }
  setTimeout() {
    return { cancel() {} };
  }
  setInterval() {
    return { cancel() {} };
  }
}

/** Every call a fake receives, by method name. */
class Calls {
  constructor() {
    this.list = [];
  }
  add(name, args) {
    this.list.push({ name, args });
  }
  of(name) {
    return this.list.filter((c) => c.name === name).map((c) => c.args);
  }
  count(name) {
    return this.of(name).length;
  }
}

const notFound = (what) => new ApiException(404, 'not_found', `${what} not found`);

/** A configuration store over plain maps: enough behaviour for routing, ids and merges. */
class FakeConfig {
  constructor(calls) {
    this.calls = calls;
    this.rev = 1;
    this.single = {
      settings: defaults.defaultSettings('uk'),
      safety: defaults.defaultSafety(),
      house: defaults.defaultHouse(),
      heat: defaults.defaultHeatStrategy(),
      cool: defaults.defaultCoolStrategy(),
      season: defaults.defaultSeason(),
      energy: defaults.defaultEnergy(),
      notify: defaults.defaultNotifySettings(),
      deviceHealth: defaults.defaultDeviceHealth(),
    };
    this.c = {};
    for (const k of ['rooms', 'sensors', 'emitters', 'emitterDevices', 'profiles', 'activationRules', 'schedules', 'scheduleExceptions', 'sources', 'manifolds', 'circuits', 'pumps', 'triggers', 'rules', 'targets', 'watchRules', 'z2m']) {
      this.c[k] = new Map();
    }
    this.prRows = [];
    this.prefs = new Map();
    this.seq = 0;
  }
  put(c, item) {
    this.c[c].set(item.id, defaults.deepClone(item));
    return item;
  }
  revision() {
    return this.rev;
  }
  engineConfig() {
    return { revision: this.rev, settings: this.single.settings, schedules: this.list('schedules'), overrides: [] };
  }
  list(c) {
    return [...this.c[c].values()].map((x) => defaults.deepClone(x)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }
  get(c, id) {
    const x = this.c[c].get(id);
    return x ? defaults.deepClone(x) : undefined;
  }
  room(idOrSlug) {
    const r = this.c.rooms.get(idOrSlug) ?? [...this.c.rooms.values()].find((x) => x.slug === idOrSlug);
    return r ? defaults.deepClone(r) : undefined;
  }
  async create(c, value, actor) {
    this.calls.add('create', [c, defaults.deepClone(value), actor]);
    const id = value.id ?? `${c}_${++this.seq}`;
    const item = { order: this.c[c].size, ...defaults.deepClone(value), id };
    this.c[c].set(id, item);
    this.rev++;
    return defaults.deepClone(item);
  }
  async update(c, id, patch, actor) {
    this.calls.add('update', [c, id, defaults.deepClone(patch), actor]);
    const cur = this.c[c].get(id);
    if (!cur) throw notFound(c);
    const next = defaults.mergePatch(cur, patch);
    this.c[c].set(id, next);
    this.rev++;
    return defaults.deepClone(next);
  }
  async remove(c, id, actor, opts) {
    this.calls.add('remove', [c, id, actor, opts]);
    if (!this.c[c].has(id)) throw notFound(c);
    this.c[c].delete(id);
    this.rev++;
  }
  async reorder(c, ids, actor) {
    this.calls.add('reorder', [c, ids, actor]);
    ids.forEach((id, i) => {
      const x = this.c[c].get(id);
      if (x) x.order = i;
    });
  }
  singleton(k) {
    return defaults.deepClone(this.single[k]);
  }
  async patchSingleton(k, patch, actor) {
    this.calls.add('patchSingleton', [k, defaults.deepClone(patch), actor]);
    this.single[k] = defaults.mergePatch(this.single[k], patch);
    return defaults.deepClone(this.single[k]);
  }
  profileRooms() {
    return defaults.deepClone(this.prRows);
  }
  async setProfileRoom(profileId, roomId, req, actor) {
    this.calls.add('setProfileRoom', [profileId, roomId, req, actor]);
    this.prRows = this.prRows.filter((r) => !(r.profileId === profileId && r.roomId === roomId));
    if (req.mode === 'inherit') return null;
    const row = { profileId, roomId, mode: req.mode, heatC: req.heatC ?? null, coolC: req.coolC ?? null, writtenAt: null };
    this.prRows.push(row);
    return row;
  }
  routing() {
    return [];
  }
  async setRoute(kind, targetId, on, actor) {
    this.calls.add('setRoute', [kind, targetId, on, actor]);
  }
  eventParams() {
    return [];
  }
  async setEventParams(kind, patch, actor) {
    this.calls.add('setEventParams', [kind, patch, actor]);
    return { kind, enabled: patch.enabled ?? true, params: patch.params ?? {} };
  }
  personalPrefs(userId) {
    return this.prefs.get(userId) ?? defaults.defaultPersonalPrefs(userId);
  }
  async setPersonalPrefs(userId, patch) {
    this.calls.add('setPersonalPrefs', [userId, patch]);
    const next = { ...defaults.mergePatch(this.personalPrefs(userId), patch), userId };
    this.prefs.set(userId, next);
    return next;
  }
  deviceMeta() {
    return [];
  }
  async setDeviceMeta(key, patch, actor) {
    this.calls.add('setDeviceMeta', [key, patch, actor]);
    return { key, label: null, ignored: false, batteryType: null, ...patch };
  }
  usages() {
    return [];
  }
  referencedEntities() {
    return [];
  }
  sourceTemplates() {
    return defaults.deepClone([...defaults.SOURCE_TEMPLATES]);
  }
  async transaction(fn) {
    return fn(this);
  }
  exportBundle() {
    return { app: 'klimo', version: 1, exportedAt: NOW, addonVersion: '0.1.0', rooms: this.list('rooms') };
  }
  async importBundle(bundle, opts, actor) {
    this.calls.add('importBundle', [bundle, opts, actor]);
    return { ok: true, dryRun: opts.dryRun, counts: { rooms: (bundle.rooms ?? []).length }, issues: [] };
  }
}

/** A plain object whose listed methods record their arguments and answer with `impl(...)`. */
function recorder(calls, prefix, impls) {
  const out = {};
  for (const [name, impl] of Object.entries(impls)) {
    out[name] = (...args) => {
      calls.add(`${prefix}.${name}`, args);
      return impl(...args);
    };
  }
  return out;
}

function makeFakes(opts = {}) {
  const calls = new Calls();
  const clock = new FakeClock();
  const config = new FakeConfig(calls);
  const roomState = (roomId) => ({ roomId, state: 'hold' });
  const ha = {
    connected: opts.haConnected ?? true,
    simulated: false,
    states: new Map(),
    onConnection() {},
    onStateChanged() {},
    onEvent() {},
    getState(id) {
      return this.states.get(id);
    },
    allStates() {
      return [...this.states.values()];
    },
    config: () => ({ time_zone: 'Europe/Kyiv', unit_system: { temperature: '°C' }, language: 'uk', version: '2025.10.1', latitude: 50.45, longitude: 30.52 }),
    authUsers: async () => [
      { id: 'u_admin', name: 'Ihor', is_admin: true, system_generated: false },
      { id: 'u_olia', name: 'Olia', is_admin: false, system_generated: false },
    ],
    registries: () => ({ areas: [], devices: [], entities: [] }),
    callService: async () => ({ context: null, response: null }),
  };
  const readModels = recorder(calls, 'readModels', {
    overview: async () => ({ rooms: [] }),
    roomSummaries: () => config.list('rooms').map((r) => ({ id: r.id, slug: r.slug, name: r.name })),
    roomDetail: (id) => {
      const r = config.room(id);
      return r ? { config: r, sensors: config.list('sensors').filter((s) => s.roomId === r.id) } : null;
    },
    thermostat: () => null,
    today: async (date) => ({ date: date ?? '2026-10-21', tracks: [] }),
    profiles: () => config.list('profiles').map((p) => ({ ...p, live: false, roomTargets: [], rules: [], ownCount: 0, usages: [] })),
    sources: () => config.list('sources').map((s) => ({ config: s })),
    source: (id) => {
      const s = config.get('sources', id);
      return s ? { config: s } : null;
    },
    circuits: () => config.list('circuits').map((c) => ({ config: c, pumps: [], memberRoomIds: [] })),
    strategy: () => ({ heat: config.singleton('heat'), cool: config.singleton('cool'), season: config.singleton('season') }),
    energy: () => ({ policy: config.singleton('energy') }),
    triggers: () => config.list('triggers').map((t) => ({ config: t })),
    rules: () => config.list('rules').map((r) => ({ config: r })),
    resolvedDay: (scheduleId, date, roomId) => ({ scheduleId, date, roomId, segments: [] }),
    onboarding: () => null,
  });
  const roomActions = recorder(calls, 'roomActions', {
    setTarget: async (roomId, req) => ({ override: null, profileWritten: null, until: null, revertToken: 'tok', revertUntil: NOW + 30_000, reqId: req.reqId ?? null, state: roomState(roomId), n: calls.count('roomActions.setTarget') }),
    preview: (roomId) => ({ unchanged: false, tone: 'heat', icon: 'flame', main: { code: 'preview.start_heat' }, eta: null, until: null, writesProfileId: null, roomId }),
    undo: async (roomId) => ({ override: null, state: roomState(roomId) }),
    resume: async (roomId) => roomState(roomId),
    boost: async (roomId) => roomState(roomId),
    cancelBoost: async (roomId) => roomState(roomId),
    airing: async (roomId) => roomState(roomId),
    cancelAiring: async (roomId) => roomState(roomId),
    ignoreWindow: async (roomId) => roomState(roomId),
    cancelIgnoreWindow: async (roomId) => roomState(roomId),
    off: async (roomId) => roomState(roomId),
    on: async (roomId) => roomState(roomId),
    setRoomProfile: async (roomId) => roomState(roomId),
    clearRoomProfile: async (roomId) => roomState(roomId),
    durations: () => [{ id: 'slot', until: NOW + 3_600_000 }],
    applyClimateCommand: async (roomId) => roomState(roomId),
  });
  const houseActions = recorder(calls, 'houseActions', {
    profile: () => ({ state: { activeProfileId: 'home' }, durations: [], revertToken: null, revertUntil: null }),
    preview: (req) => ({ profileId: req.profileId, same: false }),
    setProfile: async (req) => ({ state: { activeProfileId: req.profileId }, durations: [], revertToken: 't', revertUntil: NOW + 30_000 }),
    clearProfile: async () => ({ state: { activeProfileId: 'home' }, durations: [], revertToken: null, revertUntil: null }),
    undo: async () => ({ state: { activeProfileId: 'home' }, durations: [], revertToken: null, revertUntil: null }),
    setMode: async (mode) => ({ mode, season: 'heating' }),
    previewMode: (mode) => ({ mode, changesNow: true }),
    durations: () => [],
    activationRuleTest: () => ({ wouldActivate: true, reason: null }),
  });
  const setup = recorder(calls, 'setup', {
    validate: () => ({ ok: true, issues: [] }),
    create: async (req) => ({ reportId: 'rep1', roomId: 'r_new', slug: 'new', climateEntityId: 'climate.klimo_new', activeProfileId: 'home', steps: [], done: true, name: req.name }),
    report: (id) => (id === 'rep1' ? { reportId: 'rep1', steps: [], done: true } : null),
    retry: async (id, step) => ({ reportId: id, step }),
    remove: async () => undefined,
    addEmitterDevice: async (roomId) => readModels.roomDetail(roomId),
    removeEmitterDevice: async (roomId) => readModels.roomDetail(roomId),
  });
  const search = recorder(calls, 'search', {
    search: (q) => [{ entityId: 'sensor.a', q }],
    detail: (id) => (id.startsWith('sensor.') ? { entity: { entityId: id, name: 'Датчик' }, attributes: {}, siblings: [], trv: null, climate: null } : null),
    areas: () => [{ areaId: 'living', name: 'Вітальня', deviceCount: 3 }],
    discoverArea: (areaId) => ({ areaId, areaName: 'Вітальня', integrations: [], candidates: [] }),
    unassigned: () => [],
    notifyServices: async () => [],
    persons: () => [],
    calendars: () => [],
    deviceOf: (id) => ({ key: `dev_${id}`, name: 'Device', model: 'WSDCGQ11LM', manufacturer: 'Aqara', areaId: null, transport: { type: 'ha', integration: null, network: null } }),
  });
  const history = recorder(calls, 'history', {
    series: async (q) => q.ids.map((entityId) => ({ entityId, unit: '°C', points: [] })),
    statistics: async (q) => q.ids.map((statisticId) => ({ statisticId, points: [] })),
    roomDay: async (roomId, date) => ({ roomId, date }),
    sparks: async () => ({}),
    outdoor: async (days) => ({ series: [], avgC: null, days }),
  });
  const inputs = recorder(calls, 'inputs', {
    renderTemplate: async (template) => ({ result: template.length, error: null }),
    z2mBridges: () => ({ z1: true }),
    outdoor: () => ({ nowC: null, avg10C: null, avgNC: null, source: 'none' }),
  });
  const overrides = recorder(calls, 'overrides', {
    active: () => [],
    forSubject: () => [],
    byRevertToken: () => undefined,
    put: async (o) => o,
    remove: async () => undefined,
    removeGroup: async () => null,
    expire: async () => [],
  });
  const journal = recorder(calls, 'journal', {
    add: async () => null,
    page: async (q) => ({ items: [], nextBefore: null, q }),
  });
  const spans = recorder(calls, 'spans', {
    apply: async () => [],
    open: () => [],
    range: async () => [],
    closeDangling: async () => 0,
  });
  const preview = recorder(calls, 'preview', {
    schema: () => ({ nodes: [], edges: [] }),
    presets: () => [],
    simulate: (req) => ({ simulated: true, preset: req.preset ?? 'custom' }),
    conditionPreview: () => ({ eval: { id: 'n', met: true, status: 'ok' }, entities: [] }),
    bindingValidation: () => ({ ok: true, rows: [], issues: [] }),
  });
  const deviceHealth = recorder(calls, 'deviceHealth', {
    list: () => ({ summary: { total: 1 }, devices: [{ key: 'dev1', transport: { type: 'z2m', instanceId: 'z1', friendlyName: 'x', ieee: null } }] }),
    detail: async (key) => (key === 'dev1' ? { device: { key }, battery7d: [], lqi7d: [], availability7d: [], trvLog: [] } : null),
    resend: () => 1,
    replace: async (key) => ({ key }),
    detect: () => [],
  });
  const incidents = recorder(calls, 'incidents', {
    ingest: () => undefined,
    list: (q) => [{ id: 'i1', scope: q.scope }],
    get: () => null,
    act: async (id, req) => ({ id, action: req.action }),
    counts: () => ({ critical: 0, warning: 1, total: 1, deviceIssues: 0, inbox: 1 }),
  });
  const notify = recorder(calls, 'notify', {
    settings: () => ({ settings: config.singleton('notify'), targets: config.list('targets') }),
    test: async () => ({ results: [] }),
    preview: (kind) => ({ kind }),
    log: async () => [],
    telegramVerify: async () => ({ ok: true, botUsername: 'klimo_bot', error: null }),
    telegramPair: async () => ({ code: 'ABC123', deepLink: null, expiresAt: NOW + 600_000 }),
    telegramPairStatus: () => ({ status: 'pending', target: null }),
    watchRules: () => [...config.list('watchRules'), { id: 'auto:sensor.derived', origin: 'auto', entityId: 'sensor.derived', name: 'Derived', role: 'room.sensor', ref: null, condition: { type: 'unavailable', forMin: 30 }, severity: 'warning', eventKind: 'sensor_offline', muted: false }].map((w) => ({ ...w, status: { tone: 'ok', text: null, since: null, lastOutageAt: null, lastOutageMin: null } })),
    watchDetections: () => [],
  });
  const supervisor = { panelPath: () => '/a0d7b954_klimo', addonVersion: () => '0.1.0', mqttService: async () => null };

  const bus = { emit: (event, payload) => calls.add('bus.emit', [event, payload]), on: () => () => undefined };

  const byToken = {
    [T.CLOCK]: clock,
    [T.BUS]: bus,
    [T.CONFIG_STORE]: config,
    [T.OVERRIDE_STORE]: overrides,
    [T.JOURNAL]: journal,
    [T.SPAN_STORE]: spans,
    [T.HA_PORT]: ha,
    [T.ENTITY_SEARCH]: search,
    [T.HISTORY]: history,
    [T.HA_INPUTS]: inputs,
    [T.SUPERVISOR]: supervisor,
    [T.READ_MODELS]: readModels,
    [T.ROOM_ACTIONS]: roomActions,
    [T.HOUSE_ACTIONS]: houseActions,
    [T.ROOM_SETUP]: setup,
    [T.SYSTEM_PREVIEW]: preview,
    [T.DEVICE_HEALTH]: deviceHealth,
    [T.INCIDENTS]: incidents,
    [T.NOTIFY]: notify,
  };
  if (opts.engine) {
    byToken[T.ENGINE] = recorder(calls, 'engine', {
      house: () => ({ season: 'heating' }),
      plant: () => ({ sources: [] }),
      season: () => ({ season: 'heating', mode: 'auto' }),
      resend: () => 2,
      runNow: async () => null,
      startSourceTest: async (id, req) => ({ sourceId: id, status: 'running', mode: req.mode ?? null }),
      stopSourceTest: async () => null,
      exercisePump: async () => undefined,
    });
    byToken[T.CORE] = recorder(calls, 'core', { durationUntil: (_cfg, _room, duration, now) => (duration === 'none' ? null : now + 3_600_000) });
  }
  return { calls, clock, config, ha, byToken };
}

/** The API controllers on a random port with the given fakes. */
async function startApi(opts = {}) {
  const fakes = makeFakes(opts);
  const providers = Object.entries(fakes.byToken).map(([provide, useValue]) => ({ provide, useValue }));

  class FakePorts {}
  Global()(FakePorts);
  Module({ providers, exports: providers.map((p) => p.provide) })(FakePorts);

  class TestApp {
    configure(consumer) {
      consumer.apply(UserMiddleware).forRoutes('*');
    }
  }
  Module({ imports: [FakePorts, ApiModule], providers: [UserMiddleware] })(TestApp);

  const app = await NestFactory.create(TestApp, { logger: false });
  app.useGlobalFilters(new ApiExceptionFilter());
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}`;

  async function request(method, path, { body, headers } = {}) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(headers ?? {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, body: json, headers: res.headers };
  }

  return { app, base, request, ...fakes, close: () => app.close() };
}

/** `METHOD /path` of every route the controllers declare. */
function routeTable() {
  const methods = { [RequestMethod.GET]: 'GET', [RequestMethod.POST]: 'POST', [RequestMethod.PUT]: 'PUT', [RequestMethod.DELETE]: 'DELETE', [RequestMethod.PATCH]: 'PATCH' };
  const join = (...parts) => `/${parts.flatMap((p) => String(p).split('/')).filter(Boolean).join('/')}`;
  const out = [];
  for (const ctrl of API_CONTROLLERS) {
    const prefix = Reflect.getMetadata('path', ctrl) ?? '';
    for (const name of Object.getOwnPropertyNames(ctrl.prototype)) {
      if (name === 'constructor') continue;
      const handler = ctrl.prototype[name];
      if (typeof handler !== 'function') continue;
      const path = Reflect.getMetadata('path', handler);
      const method = Reflect.getMetadata('method', handler);
      if (path === undefined || method === undefined) continue;
      const guards = Reflect.getMetadata('__guards__', handler) ?? [];
      out.push({ route: `${methods[method]} ${join(prefix, path)}`, controller: ctrl.name, handler: name, admin: guards.some((g) => g.name === 'AdminGuard') });
    }
  }
  return out;
}

module.exports = { NOW, ADMIN, MEMBER, startApi, makeFakes, routeTable };
