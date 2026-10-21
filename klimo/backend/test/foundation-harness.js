// Shared set-up for the persistence tests: real stores on a throw-away SQLite file.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Logger } = require('@nestjs/common');
const { createDataSource, Db } = require('../dist/db/database');
const { Bus } = require('../dist/common/bus');
const { OverrideStore } = require('../dist/config/override.store');
const { ConfigStore } = require('../dist/config/config.store');
const { MemoryStore } = require('../dist/config/memory.store');
const { JournalService } = require('../dist/journal/journal.service');
const { SpanStore } = require('../dist/journal/span.store');

Logger.overrideLogger(false);

/** A clock the test moves by hand; timers fire when `advance()` passes them. */
class FakeClock {
  constructor(now = Date.UTC(2026, 9, 21, 16, 10), tz = 'Europe/Kyiv') {
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

const ACTOR = { via: 'ui', userId: 'u1', userName: 'Ігор', contextId: null };

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'klimo-test-'));
}

async function openStores(opts = {}) {
  const dir = opts.dir ?? tempDir();
  const clock = opts.clock ?? new FakeClock();
  const ds = await createDataSource({ db: { driver: 'sqlite' }, dataDir: dir, retries: 1 });
  const db = new Db(ds);
  const bus = new Bus();
  const sent = [];
  const busEvents = [];
  bus.on('config.changed', (e) => busEvents.push(e));
  const events = { send: (m) => sent.push(m), clientCount: () => 0 };
  const overrides = new OverrideStore(db, clock);
  await overrides.load();
  const config = new ConfigStore(db, clock, bus, events, overrides);
  await config.load();
  const memory = new MemoryStore(db, clock, config, bus);
  const journal = new JournalService(db, events, bus);
  const spans = new SpanStore(db, events);
  await spans.load();
  return {
    dir,
    clock,
    ds,
    db,
    bus,
    sent,
    busEvents,
    overrides,
    config,
    memory,
    journal,
    spans,
    async close({ keep = false } = {}) {
      await memory.onModuleDestroy();
      await db.destroy();
      if (!keep) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Runs `fn` and returns the ApiException it throws (fails the test when nothing is thrown). */
async function rejection(fn) {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected the call to be rejected');
}

module.exports = { FakeClock, ACTOR, openStores, tempDir, rejection };
