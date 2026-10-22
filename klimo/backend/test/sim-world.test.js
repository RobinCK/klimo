const assert = require('node:assert/strict');
const test = require('node:test');
const { EVENING, openWorld, settle } = require('./sim-harness');
const { ROOM_IDS } = require('../dist/sim/demo-house');

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const EVENING_ROOMS = { r_living: 19.8, r_bedroom: 17.6, r_kids: 21.7, r_study: 21.0, r_kitchen: 20.9, r_bath: 23.7, r_hall: 19.1 };

async function withWorld(opts, fn) {
  const w = await openWorld(opts);
  try {
    await fn(w);
  } finally {
    await w.close();
  }
}

test('the heating evening: rooms, the open bedroom window, the quiet kitchen sensor, the study override', () =>
  withWorld({ warmup: false }, async ({ world, ha, overrides, config }) => {
    const s = world.state();
    assert.equal(s.now, EVENING);
    assert.equal(s.scenario, 'heating_evening');
    assert.equal(s.outdoorC, 4.2);
    assert.deepEqual(Object.fromEntries(s.rooms.map((r) => [r.roomId, r.tempC])), EVENING_ROOMS);
    assert.equal(s.rooms.find((r) => r.roomId === ROOM_IDS.kids).humidityPct, 67);

    // what Klimo reads from HA matches the screens
    assert.equal(ha.getState('sensor.living_sofa_temperature').state, '19.7');
    assert.equal(ha.getState('sensor.living_tv_temperature').state, '19.8');
    assert.equal(ha.getState('sensor.outdoor_temperature').state, '4.2');
    const win = ha.getState('binary_sensor.bedroom_window');
    assert.equal(win.state, 'on');
    assert.equal(Date.parse(win.last_changed), EVENING - 12 * MIN);
    const shelf = ha.getState('sensor.kitchen_shelf_temperature');
    assert.ok(EVENING - Date.parse(shelf.last_reported) >= 100 * MIN, 'the shelf sensor has been quiet for 1 h 40 min');
    assert.equal(ha.getState('sensor.hall_battery').state, '12');
    const study = overrides.active().find((o) => o.subjectId === ROOM_IDS.study);
    assert.deepEqual(study.value, { kind: 'room_target', mode: 'heat', heatC: 20.5, coolC: null });
    assert.equal(new Date(study.until).toISOString(), '2026-10-21T17:30:00.000Z');
    assert.equal(config.list('rooms').length, 7);
  }));

test('simulator controls: windows, outdoor temperature, faults and the clock', () =>
  withWorld({ warmup: false }, async ({ world, ha, clock }) => {
    world.window('binary_sensor.living_window_left', true);
    assert.equal(ha.getState('binary_sensor.living_window_left').state, 'on');
    assert.throws(() => world.window('sensor.living_sofa_temperature', true), /not a window/);

    assert.equal(world.outdoor(-5).outdoorC, -5);
    assert.equal(ha.getState('sensor.outdoor_temperature').state, '-5.0');

    world.fault({ entityId: 'climate.heat_pump', kind: 'unavailable' });
    assert.equal(ha.getState('climate.heat_pump').state, 'unavailable');
    world.fault({ entityId: 'climate.heat_pump', kind: 'clear' });
    assert.notEqual(ha.getState('climate.heat_pump').state, 'unavailable');

    const living = () => world.state().rooms.find((r) => r.roomId === ROOM_IDS.living).tempC;
    const before = living();
    const s = world.clock({ jumpTo: EVENING + HOUR, speed: 0, paused: true });
    assert.equal(s.now, EVENING + HOUR);
    assert.deepEqual([s.speed, s.paused], [0, true]);
    assert.notEqual(living(), before, 'an hour of physics has passed');
    assert.equal(clock.now(), EVENING + HOUR);
  }));

test('switching to the summer scenario rebuilds the world for that afternoon', () =>
  withWorld({ warmup: false }, async ({ world, ha }) => {
    const s = await world.scenario('summer');
    assert.equal(s.scenario, 'summer');
    assert.equal(s.outdoorC, 31.5);
    assert.equal(s.rooms.find((r) => r.roomId === ROOM_IDS.living).tempC, 25.6);
    assert.equal(s.rooms.find((r) => r.roomId === ROOM_IDS.bath).humidityPct, 63);
    assert.equal(ha.getState('binary_sensor.bedroom_window').state, 'on');
    assert.equal(ha.connected, true);
  }));

test('going back to an earlier day forgets the later journal lines and timelines', () =>
  withWorld({ warmup: false }, async ({ world, journal, spans, clock }) => {
    const line = (ts) => journal.add({ code: 'source.start', category: 'src', tone: 'heat', params: {}, sourceId: 's_heatpump' }, ts);
    const run = (subjectId, edge, at) => ({ subject: 'source', subjectId, kind: 'run', mode: 'heat', edge, at });
    await line(EVENING - HOUR);
    await spans.apply([run('s_heatpump', 'start', EVENING - 10 * MIN)]);
    world.clock({ jumpTo: EVENING + 2 * HOUR });
    await line(EVENING + HOUR);
    await spans.apply([run('s_heatpump', 'end', EVENING + 20 * MIN), run('s_boiler', 'start', EVENING + HOUR)]);

    // the clock goes back to the evening itself
    world.clock({ jumpTo: EVENING });
    await settle();
    const page = await journal.page({ limit: 50 });
    assert.deepEqual(page.items.map((x) => x.ts), [EVENING - HOUR]);
    const left = await spans.range(EVENING - DAY, EVENING + DAY);
    assert.deepEqual(left.map((x) => [x.subjectId, x.startTs, x.endTs]), [['s_heatpump', EVENING - 10 * MIN, EVENING]], 'a run going on then ends there');
    assert.deepEqual(spans.open(), []);

    // a scenario on an earlier date: everything after its moment goes
    await world.scenario('frost_morning');
    assert.deepEqual((await journal.page({ limit: 50 })).items, []);
    assert.deepEqual(await spans.range(0, EVENING + DAY), []);
    assert.ok(clock.now() < EVENING);
  }));

/** A stand-in engine core: heats with the heat pump while the living room is below 20 °C. */
function fakeCore() {
  const calls = [];
  const evaluate = (cfg, inputs, memory) => {
    calls.push(inputs);
    const living = inputs.entities['sensor.living_sofa_temperature']?.num ?? null;
    const heat = living !== null && living < 20;
    const was = memory.sources.s_heatpump.on;
    const next = { ...memory, sources: { ...memory.sources, s_heatpump: { ...memory.sources.s_heatpump, on: heat } }, marker: inputs.now };
    const climate = (hvacMode, temperature) => ({ kind: 'climate', hvacMode, temperature, targetLow: null, targetHigh: null, fanMode: null });
    const desired = [
      { key: 'climate.heat_pump', entityId: 'climate.heat_pump', value: climate(heat ? 'heat' : 'off', 38), ackTimeoutSec: 60 },
      { key: 'switch.radiator_pump', entityId: 'switch.radiator_pump', value: { kind: 'switch', on: heat }, ackTimeoutSec: 60 },
      { key: 'switch.manifold_pump', entityId: 'switch.manifold_pump', value: { kind: 'switch', on: heat }, ackTimeoutSec: 60 },
      { key: 'climate.bathroom_towel_trv', entityId: 'climate.bathroom_towel_trv', value: climate('heat', 24.5), ackTimeoutSec: 120 },
      ...['climate.living_trv_window', 'climate.living_trv_door'].map((id) => ({ key: id, entityId: id, value: climate('heat', heat ? 20.5 : 19.5), ackTimeoutSec: 120 })),
    ];
    const edge = heat !== was;
    const rooms = cfg.rooms.map((r) => ({
      roomId: r.id,
      tempC: r.id === 'r_living' ? living : 20,
      target: { displayC: 20, heatC: 20, coolC: null },
      humidity: { valuePct: 45 },
      demand: { mode: r.id === 'r_living' && heat ? 'heat' : 'none' },
    }));
    return {
      memory: next,
      rooms,
      plant: {},
      season: {},
      houseProfile: {},
      desired,
      decisions: edge ? [{ code: heat ? 'source.start' : 'source.stop', category: 'src', tone: heat ? 'heat' : 'idle', params: {}, sourceId: 's_heatpump' }] : [],
      detections: [],
      spans: edge ? [{ subject: 'source', subjectId: 's_heatpump', kind: 'run', mode: 'heat', edge: heat ? 'start' : 'end', at: inputs.now }] : [],
      expiredOverrideIds: [],
      edges: [],
      nextWakeAt: null,
    };
  };
  return { calls, evaluate };
}

test('a week of history, the last day through the engine core', { timeout: 60_000 }, async () => {
  const core = fakeCore();
  await withWorld({ warmup: true, evaluate: core.evaluate }, async ({ world, ha, memory, journal, spans, clock }) => {
    // one evaluation every two minutes over the last 24 hours
    assert.equal(core.calls.length, 720);
    assert.equal(core.calls[0].now, EVENING - 24 * HOUR);
    assert.equal(core.calls[1].now - core.calls[0].now, 2 * MIN);
    const last = core.calls.at(-1);
    assert.ok(last.outdoor.nowC !== null && Math.abs(last.outdoor.avgNC - 6.8) < 0.6, `N-day mean ${last.outdoor.avgNC}`);
    assert.equal(last.entities['binary_sensor.bedroom_window'].state, 'on');
    assert.ok(last.roomTempHistory.r_living.length > 20);

    // its decisions are the house's history: journal, run spans, control memory
    const page = await journal.page({ limit: 200 });
    assert.ok(page.items.some((e) => e.code === 'source.start'));
    const runs = await spans.range(EVENING - 24 * HOUR, EVENING, 'source', 's_heatpump');
    assert.ok(runs.length > 0);
    assert.equal(memory.current().marker, last.now);
    assert.equal(memory.current().plant.lastHeartbeatAt, EVENING);

    // the bathroom head lost its last commands: the ledger shows the retry
    const rec = memory.ledger()['climate.bathroom_towel_trv'];
    assert.equal(rec.attempts, 2);
    assert.equal(rec.status, 'retrying');
    assert.notEqual(ha.getState('climate.bathroom_towel_trv').attributes.temperature, 24.5);

    // the recorder holds the week: outdoor statistics, battery trend, Klimo's own sensors
    const stats = await ha.statistics(['sensor.outdoor_temperature'], EVENING - 7 * 24 * HOUR, EVENING, 'hour', ['mean']);
    assert.ok(stats['sensor.outdoor_temperature'].length > 150);
    const battery = (await ha.history(['sensor.hall_battery'], EVENING - 7 * 24 * HOUR, EVENING, { minimal: true, noAttributes: true }))['sensor.hall_battery'];
    assert.ok(Number(battery[0].s) >= 17 && Number(battery.at(-1).s) === 12, `${battery[0].s} → ${battery.at(-1).s}`);
    const klimo = await ha.statistics(['sensor.klimo_vitalnia_temperature'], EVENING - 6 * HOUR, EVENING, '5minute', ['mean']);
    assert.ok(klimo['sensor.klimo_vitalnia_temperature'].length > 60);

    // and still the scenario's moment, to the tenth of a degree
    assert.deepEqual(Object.fromEntries(world.state().rooms.map((r) => [r.roomId, r.tempC])), EVENING_ROOMS);
    assert.equal(clock.now(), EVENING);
    await settle();
  });
});
