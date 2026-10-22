const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const { Global, Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { createDataSource, Db } = require('../dist/db/database');
const { Bus } = require('../dist/common/bus');
const { OverrideStore } = require('../dist/config/override.store');
const { ConfigStore } = require('../dist/config/config.store');
const { JournalService } = require('../dist/journal/journal.service');
const { SpanStore } = require('../dist/journal/span.store');
const { NotifyModule } = require('../dist/notify/notify.module');
const T = require('../dist/tokens');
const { FakeClock, FakeHa, det, tempDir } = require('./notify-harness');
const { seedInUkrainian } = require('./foundation-harness');

test('the notification module wires up through Nest and serves its three ports', async () => {
  const dir = tempDir();
  const clock = new FakeClock();
  const ds = await createDataSource({ db: { driver: 'sqlite' }, dataDir: dir, retries: 1 });
  const db = new Db(ds);
  const bus = new Bus();
  const sent = [];
  const events = { send: (m) => sent.push(m), clientCount: () => 0 };
  const overrides = new OverrideStore(db, clock);
  await overrides.load();
  const config = new ConfigStore(db, clock, bus, events, overrides);
  await config.load();
  await seedInUkrainian(config);
  const ha = new FakeHa(clock);
  const supervisor = { panelPath: () => null, addonVersion: () => '0.1.0', mqttService: async () => null };

  const values = [
    [Db, db],
    [T.DATA_SOURCE, ds],
    [T.CLOCK, clock],
    [T.BUS, bus],
    [T.EVENTS, events],
    [T.CONFIG_STORE, config],
    [T.JOURNAL, new JournalService(db, events, bus)],
    [T.SPAN_STORE, new SpanStore(db, events)],
    [T.HA_PORT, ha],
    [T.SUPERVISOR, supervisor],
  ];
  class Platform {}
  Global()(Platform);
  Module({ providers: values.map(([provide, useValue]) => ({ provide, useValue })), exports: values.map(([t]) => t) })(Platform);
  class Root {}
  Module({ imports: [Platform, NotifyModule] })(Root);

  const app = await NestFactory.createApplicationContext(Root, { logger: false });
  try {
    const incidents = app.get(T.INCIDENTS);
    const notify = app.get(T.NOTIFY);
    const texts = app.get(T.TEXTS);
    incidents.ingest([det('mqtt_offline', 'mqtt_offline', { facts: { minutes: 6 } })], clock.now());
    const [inc] = incidents.list({ scope: 'attention' });
    assert.equal(texts.incident(inc).title, 'MQTT не на зв’язку');
    assert.equal(texts.duration(100), '1 год 40 хв');
    assert.equal(texts.card('card.state.heat', {}), 'Гріє');
    assert.equal(notify.settings().catalogue.length, 35);
    assert.ok(ha.subscribed.includes('telegram_command'));
    assert.ok(sent.some((m) => m.type === 'incident'));
  } finally {
    await app.close();
    await db.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
