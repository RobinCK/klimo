// Shared set-up for the notification tests: real configuration, journal and span stores on a
// throw-away SQLite file; Home Assistant, the engine, room actions, MQTT and the Telegram Bot API are
// fakes the tests steer and inspect.
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
const { DEFAULT_TARGET } = require('../dist/shared/defaults');
const { seedInUkrainian } = require('./foundation-harness');
const { TextsService } = require('../dist/notify/texts.service');
const { IncidentService } = require('../dist/notify/incidents.service');
const { ChannelHealth } = require('../dist/notify/channels/health');
const { HaMobileChannel } = require('../dist/notify/channels/ha-mobile.channel');
const { HaNotifyChannel } = require('../dist/notify/channels/ha-notify.channel');
const { HaPersistentChannel } = require('../dist/notify/channels/ha-persistent.channel');
const { HaEventChannel } = require('../dist/notify/channels/ha-event.channel');
const { TelegramChannel } = require('../dist/notify/channels/telegram.channel');
const { TelegramBotService } = require('../dist/notify/telegram-bot.service');
const { NotifyRouter } = require('../dist/notify/router.service');
const { WatchService } = require('../dist/notify/watch.service');
const { ReportsService } = require('../dist/notify/reports.service');
const { InboundService } = require('../dist/notify/inbound.service');
const { NotifyService } = require('../dist/notify/notify.service');

Logger.overrideLogger(false);

const SEC = 1000;
const MIN = 60 * SEC;
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

/** Just enough of HaPort: states, service calls (optionally failing), fired events and event listeners. */
class FakeHa {
  constructor(clock) {
    this.clock = clock;
    this.connected = true;
    this.simulated = false;
    this.states = new Map();
    this.calls = [];
    this.fired = [];
    this.failing = new Set(); // 'domain.service'
    this.eventCbs = [];
    this.subscribed = [];
    this.stats = {};
  }
  set(entityId, state, attributes = {}, opts = {}) {
    const now = this.clock.now();
    const changed = now - (opts.changedAgoMs ?? opts.reportedAgoMs ?? 0);
    const reported = now - (opts.reportedAgoMs ?? 0);
    this.states.set(entityId, { entity_id: entityId, state: String(state), attributes, last_changed: iso(changed), last_updated: iso(reported), last_reported: iso(reported), context: { id: 'c', user_id: null, parent_id: null } });
  }
  getState(id) {
    return this.states.get(id);
  }
  allStates() {
    return [...this.states.values()];
  }
  async callService(domain, service, target, data) {
    if (!this.connected) throw new Error('not connected');
    if (this.failing.has(`${domain}.${service}`)) throw new Error(`${domain}.${service} failed`);
    this.calls.push({ domain, service, target: target ?? null, data: data ?? {} });
    return { context: { id: `ctx${this.calls.length}` }, response: null };
  }
  async fireEvent(type, data) {
    if (!this.connected) throw new Error('not connected');
    this.fired.push({ type, data });
  }
  async subscribeEvents(type) {
    this.subscribed.push(type);
  }
  async statistics(ids) {
    const out = {};
    for (const id of ids) out[id] = this.stats[id] ?? [];
    return out;
  }
  registries() {
    return { areas: [], devices: [], entities: [] };
  }
  config() {
    return null;
  }
  onConnection() {}
  onStateChanged() {}
  onEvent(cb) {
    this.eventCbs.push(cb);
  }
  onRegistriesUpdated() {}
  emit(type, data, ctx = { id: 'ctx-in', user_id: null, parent_id: null }) {
    for (const cb of this.eventCbs) cb(type, data, ctx);
    return this.afterEmit ? this.afterEmit() : Promise.resolve();
  }
  callsOf(domain, service) {
    return this.calls.filter((c) => c.domain === domain && (!service || c.service === service));
  }
}

/** The Telegram Bot API: scripted replies per method, every request recorded. */
class FakeTelegram {
  constructor() {
    this.requests = [];
    this.replies = new Map(); // method → queue of {status, body}
    this.messageId = 100;
  }
  reply(method, status, body) {
    const list = this.replies.get(method) ?? [];
    list.push({ status, body });
    this.replies.set(method, list);
  }
  http = async (url, init) => {
    const method = url.split('/').pop();
    const body = JSON.parse(init.body);
    this.requests.push({ method, body });
    const list = this.replies.get(method);
    // each scripted reply answers one request; then the defaults below take over
    let r = list && list.length ? list.shift() : null;
    if (!r) {
      if (method === 'sendMessage') r = { status: 200, body: { ok: true, result: { message_id: ++this.messageId } } };
      else if (method === 'getMe') r = { status: 200, body: { ok: true, result: { id: 1, is_bot: true, username: 'klimo_home_bot' } } };
      else if (method === 'getWebhookInfo') r = { status: 200, body: { ok: true, result: { url: '' } } };
      else if (method === 'getUpdates') r = { status: 200, body: { ok: true, result: [] } };
      else r = { status: 200, body: { ok: true, result: true } };
    }
    return { status: r.status, json: async () => r.body };
  };
  of(method) {
    return this.requests.filter((r) => r.method === method);
  }
}

class FakeEngine {
  constructor() {
    this.resent = [];
    this.runs = [];
    this.rooms = new Map();
    this.ledgerData = {};
    this.plantData = { sources: [], lead: { heat: null, cool: null } };
    this.memoryData = { conditions: {} };
  }
  room(id) {
    return this.rooms.get(id);
  }
  resend(filter) {
    this.resent.push(filter);
    return 1;
  }
  requestRun(reason) {
    this.runs.push(reason);
  }
  ledger() {
    return this.ledgerData;
  }
  plant() {
    return this.plantData;
  }
  memory() {
    return this.memoryData;
  }
}

class FakeRoomActions {
  constructor() {
    this.calls = [];
  }
  async ignoreWindow(roomId, req, actor) {
    this.calls.push({ op: 'ignoreWindow', roomId, req, actor });
    return null;
  }
  async airing(roomId, req, actor) {
    this.calls.push({ op: 'airing', roomId, req, actor });
    return null;
  }
  async resume(roomId, actor) {
    this.calls.push({ op: 'resume', roomId, actor });
    return null;
  }
}

class FakeMqtt {
  constructor() {
    this.connected = true;
    this.published = [];
  }
  async publish(topic, payload, opts) {
    this.published.push({ topic, payload: JSON.parse(payload), opts });
  }
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'klimo-notify-'));
}

/** Every notification service wired by hand, the way the Nest module does it. */
async function openNotify(opts = {}) {
  const dir = opts.dir ?? tempDir();
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
  // the notification texts are checked in Ukrainian
  await seedInUkrainian(config);
  sent.length = 0;
  const journal = new JournalService(db, events, bus);
  const spans = new SpanStore(db, events);
  await spans.load();

  const ha = opts.ha ?? new FakeHa(clock);
  const engine = new FakeEngine();
  const roomActions = new FakeRoomActions();
  const mqtt = new FakeMqtt();
  const tg = new FakeTelegram();
  const supervisor = { panelPath: () => '/a0d7b954_klimo', addonVersion: () => '0.1.0', mqttService: async () => null };
  const providers = { ENGINE: engine, ROOM_ACTIONS: roomActions, MQTT_TRANSPORT: mqtt, ATTRIBUTION: { userName: (id) => (id === 'u1' ? 'Ігор' : null) } };
  const moduleRef = {
    get(token) {
      const p = providers[token];
      if (!p) throw new Error(`no provider for ${token}`);
      return p;
    },
  };

  const texts = new TextsService(config, clock, ha, moduleRef);
  const incidents = new IncidentService(db, config, clock, bus, events, ha, journal, moduleRef, texts);
  await incidents.load();
  const health = new ChannelHealth(incidents, config, clock);
  const mobile = new HaMobileChannel(ha, supervisor);
  const notifyCh = new HaNotifyChannel(ha);
  const persistent = new HaPersistentChannel(ha, db);
  await persistent.onModuleInit();
  const automation = new HaEventChannel(ha, moduleRef);
  const bot = new TelegramBotService(config, clock, db, bus, health, texts);
  bot.http = tg.http;
  bot.token = opts.token ?? '';
  const telegram = new TelegramChannel(ha, config, bot);
  const router = new NotifyRouter(db, config, clock, events, ha, incidents, texts, health, mobile, notifyCh, persistent, telegram, automation);
  await router.onApplicationBootstrap();
  const watch = new WatchService(config, clock, ha, moduleRef);
  const reports = new ReportsService(config, clock, spans, ha, db, bus, router, incidents, texts);
  const inbound = new InboundService(ha, config, clock, incidents, bot, texts, persistent, moduleRef);
  inbound.onModuleInit();
  if (ha instanceof FakeHa) ha.afterEmit = () => inbound.idle();
  const notify = new NotifyService(config, clock, router, watch, bot, health, persistent, texts);

  const h = {
    dir,
    clock,
    db,
    bus,
    sent,
    config,
    journal,
    spans,
    ha,
    engine,
    roomActions,
    mqtt,
    tg,
    texts,
    incidents,
    health,
    persistent,
    bot,
    router,
    watch,
    reports,
    inbound,
    notify,
    /** Adds a notification target (defaults: an enabled phone). */
    async target(patch) {
      const { id: _id, ...base } = DEFAULT_TARGET();
      return config.create('targets', { ...base, name: 'Target', icon: 'phone', ...patch }, ACTOR);
    },
    async settings(patch) {
      return config.patchSingleton('notify', patch, ACTOR);
    },
    /** One engine tick's worth of detections, then every notification step it caused. */
    async tick(detections, advanceMs = 0) {
      if (advanceMs) clock.advance(advanceMs);
      incidents.ingest(detections, clock.now());
      await router.idle();
      await incidents.flush();
    },
    async advance(ms) {
      clock.advance(ms);
      await router.idle();
      await incidents.flush();
    },
    /** Sent-message rows in the log, oldest first. */
    async log() {
      return (await router.logPage({ limit: 200 })).reverse();
    },
    async close() {
      await bot.stop();
      await router.onModuleDestroy();
      reports.onModuleDestroy();
      await incidents.flush();
      await db.destroy();
      if (!opts.keepDir) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return h;
}

/** A detection with defaults. */
function det(kind, key, patch = {}) {
  return { kind, dedupKey: key, active: true, facts: {}, ...patch };
}

async function rejection(fn) {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected the call to be rejected');
}

module.exports = { ACTOR, FakeClock, FakeHa, HOUR, MIN, SEC, WED_1910, det, kyiv, openNotify, rejection, tempDir };
