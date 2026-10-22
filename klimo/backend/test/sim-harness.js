// Shared set-up for the simulator tests: a fake Home Assistant on an in-process broker, and the
// whole simulated world on throw-away SQLite stores.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Logger } = require('@nestjs/common');
const { env } = require('../dist/env');
const { Bus } = require('../dist/common/bus');
const { createDataSource, Db } = require('../dist/db/database');
const { OverrideStore } = require('../dist/config/override.store');
const { ConfigStore } = require('../dist/config/config.store');
const { MemoryStore } = require('../dist/config/memory.store');
const { JournalService } = require('../dist/journal/journal.service');
const { SpanStore } = require('../dist/journal/span.store');
const { SimClock } = require('../dist/sim/sim.clock');
const { SimMqtt } = require('../dist/sim/sim-mqtt');
const { FakeHaService } = require('../dist/sim/fake-ha.service');
const { SimWorldService } = require('../dist/sim/sim-world.service');
const { SCENARIOS, scenarioStart } = require('../dist/sim/scenarios');

Logger.overrideLogger(false);

/** Wed 2026-10-21 19:10 in Kyiv — the demo's heating evening. */
const EVENING = scenarioStart(SCENARIOS.heating_evening);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Lets due timers, queued MQTT deliveries and template renders run. */
async function settle(rounds = 4) {
  for (let i = 0; i < rounds; i++) {
    await sleep(2);
    await new Promise((r) => setImmediate(r));
  }
}

/** Moves virtual time forward and lets everything that fell due run. */
async function advance(clock, ms) {
  clock.jumpTo(clock.now() + ms);
  await settle();
}

function fakeHa({ start = EVENING, connect = true } = {}) {
  const clock = new SimClock(start, 1);
  const mqtt = new SimMqtt();
  const bus = new Bus();
  const ha = new FakeHaService(clock, mqtt, bus);
  if (connect) ha.connect();
  return {
    clock,
    mqtt,
    bus,
    ha,
    dispose() {
      ha.onModuleDestroy();
      clock.dispose();
    },
  };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'klimo-sim-test-'));
}

/** Real persistence on a temp SQLite database (what the simulator seeds and warms up). */
async function openStores(clock, dir = tempDir()) {
  const ds = await createDataSource({ db: { driver: 'sqlite' }, dataDir: dir, retries: 1 });
  const db = new Db(ds);
  const bus = new Bus();
  const sent = [];
  const events = { send: (m) => sent.push(m), clientCount: () => 1 };
  const overrides = new OverrideStore(db, clock);
  await overrides.load();
  const config = new ConfigStore(db, clock, bus, events, overrides);
  await config.load();
  const memory = new MemoryStore(db, clock, config, bus);
  await memory.load();
  const journal = new JournalService(db, events, bus);
  const spans = new SpanStore(db, events);
  await spans.load();
  return { dir, ds, db, bus, sent, events, overrides, config, memory, journal, spans };
}

/**
 * The simulated world as the add-on runs it, minus Nest: seeded demo house, history (optional),
 * scenario state. `evaluate` stands in for the engine core during the warm-up.
 */
async function openWorld({ scenario = 'heating_evening', warmup = false, evaluate = null } = {}) {
  env.sim.warmup = warmup;
  env.sim.scenario = scenario;
  const clock = new SimClock(scenarioStart(SCENARIOS[scenario]), 1);
  const mqtt = new SimMqtt();
  const stores = await openStores(clock);
  const ha = new FakeHaService(clock, mqtt, stores.bus);
  const moduleRef = {
    get(token) {
      if (token === 'EVALUATE' && evaluate) return evaluate;
      throw new Error(`no provider for ${token}`);
    },
  };
  const world = new SimWorldService(clock, ha, stores.config, stores.memory, stores.overrides, stores.spans, stores.journal, stores.events, stores.db, moduleRef);
  await world.onModuleInit();
  ha.connect();
  return {
    clock,
    mqtt,
    ha,
    world,
    ...stores,
    async close() {
      world.onModuleDestroy();
      ha.onModuleDestroy();
      await stores.memory.onModuleDestroy();
      await stores.db.destroy();
      fs.rmSync(stores.dir, { recursive: true, force: true });
      env.sim.warmup = true;
      env.sim.scenario = 'heating_evening';
    },
  };
}

module.exports = { EVENING, sleep, settle, advance, fakeHa, openStores, openWorld, tempDir };
