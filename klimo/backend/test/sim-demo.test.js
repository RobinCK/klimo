const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const { buildDemoHouse, ROOM_IDS, SOURCE_IDS } = require('../dist/sim/demo-house');
const { DEVICES } = require('../dist/sim/devices');
const { SCENARIOS, SCENARIO_IDS, scenarioStart } = require('../dist/sim/scenarios');
const { toLocal } = require('../dist/engine/core/time');
const { SimClock } = require('../dist/sim/sim.clock');
const { EVENING, openStores } = require('./sim-harness');

const ACTOR = { via: 'system', userId: null, userName: null, contextId: null };

async function withStores(fn) {
  const clock = new SimClock(EVENING, 1);
  const s = await openStores(clock);
  try {
    await fn(s);
  } finally {
    await s.memory.onModuleDestroy();
    await s.db.destroy();
    fs.rmSync(s.dir, { recursive: true, force: true });
    clock.dispose();
  }
}

test('the demo house passes every configuration rule and imports', () =>
  withStores(async ({ config }) => {
    const bundle = buildDemoHouse(config.exportBundle(), EVENING);
    const dry = await config.importBundle(bundle, { dryRun: true }, ACTOR);
    assert.deepEqual(dry.issues, []);
    assert.equal(dry.ok, true);
    const res = await config.importBundle(bundle, { dryRun: false }, ACTOR);
    assert.equal(res.ok, true);

    assert.deepEqual(config.list('rooms').map((r) => [r.name, r.slug]), [
      ['Вітальня', 'vitalnia'],
      ['Спальня', 'spalnia'],
      ['Дитяча', 'dytiacha'],
      ['Кабінет', 'kabinet'],
      ['Кухня', 'kukhnia'],
      ['Ванна', 'vanna'],
      ['Коридор', 'korydor'],
    ]);
    const living = config.room('vitalnia');
    assert.equal(living.temperature.method, 'median');
    assert.deepEqual(config.list('sensors').filter((s) => s.roomId === living.id && s.role === 'temperature').map((s) => s.weight), [1, 1, 0.5]);
    assert.deepEqual(config.room('kukhnia').tolerance.heat, { below: 0.5, above: 0.3 });
    assert.equal(config.room('dytiacha').trv.strategy, 'calibration');

    const sources = config.list('sources');
    assert.deepEqual(sources.map((s) => s.kind), ['heat_pump', 'gas_boiler', 'ac', 'ac', 'ac', 'electric_radiator']);
    assert.ok(sources.every((s) => s.enabled));
    const boiler = config.get('sources', SOURCE_IDS.boiler);
    assert.deepEqual(boiler.adapter.watchdog, { kind: 'countdown_number', entityId: 'number.boiler_relay_countdown', minutes: 15, rearmEveryMin: 5 });
    assert.equal(config.get('sources', SOURCE_IDS.acKids).linkedTo, SOURCE_IDS.acLiving);
    assert.deepEqual(config.singleton('heat').chain.map((c) => c.sourceIds), [[SOURCE_IDS.heatPump], [SOURCE_IDS.boiler]]);
    assert.deepEqual(config.list('circuits').map((c) => [c.shortName, c.sourceIds.length, c.capabilities.cool]), [['Радіатори', 2, false], ['Тепла підлога', 2, true]]);
    const pumps = config.list('pumps');
    assert.deepEqual(pumps.map((p) => [p.entityId, p.rule, p.runOnHeatMin]), [
      ['switch.radiator_pump', 'rooms', 3],
      ['switch.floor_heating_pump', 'source', 10],
      ['switch.floor_pump_b', 'source', 10],
      ['switch.manifold_pump', 'source', 3],
    ]);
    assert.ok(config.list('triggers').every((t) => t.enabled));
    assert.deepEqual(config.list('rules').map((r) => [r.id, r.enabled]), [['economy', true], ['store_heat', true], ['preheat_night', true]]);
    assert.deepEqual(config.list('targets').map((t) => t.name), ['Мій телефон', 'Планшет на кухні', 'Telegram · я', 'Telegram · сім’я', 'Панель HA', 'Подія']);
    assert.equal(config.singleton('notify').escalation.targetId, 'nt_tg_family');
    assert.deepEqual(config.list('z2m').map((z) => z.baseTopic), ['zigbee2mqtt', 'zigbee2mqtt_2']);
    assert.equal(config.singleton('energy').entities.gridOffline, 'binary_sensor.grid_offline');
  }));

test('every entity the demo configuration uses exists in the fake Home Assistant', () =>
  withStores(async ({ config }) => {
    await config.importBundle(buildDemoHouse(config.exportBundle(), EVENING), { dryRun: false }, ACTOR);
    const known = new Set(DEVICES.flatMap((d) => d.entities.map((e) => e.entityId)));
    for (const extra of ['weather.home', 'sun.sun', 'calendar.family', 'person.ihor', 'person.olia', 'zone.home']) known.add(extra);
    const missing = config.referencedEntities().filter((e) => !known.has(e));
    assert.deepEqual(missing, []);
  }));

test('the scenarios start on their own days and times', () => {
  const at = (id) => toLocal(scenarioStart(SCENARIOS[id]), 'Europe/Kyiv');
  assert.deepEqual(SCENARIO_IDS, ['heating_evening', 'frost_morning', 'blackout_sun', 'shoulder', 'summer']);
  assert.deepEqual([at('heating_evening').date, at('heating_evening').minute, at('heating_evening').dow], ['2026-10-21', 19 * 60 + 10, 2]);
  assert.deepEqual([at('summer').date, at('summer').minute, at('summer').dow], ['2026-07-18', 15 * 60 + 40, 5]);
  assert.deepEqual([at('frost_morning').date, at('blackout_sun').date, at('shoulder').date], ['2026-01-15', '2026-03-16', '2026-04-16']);
  assert.equal(scenarioStart(SCENARIOS.heating_evening), Date.UTC(2026, 9, 21, 16, 10));
  for (const id of SCENARIO_IDS) for (const k of Object.keys(SCENARIOS[id].atStart)) assert.ok(ROOM_IDS[k], k);
});
