const assert = require('node:assert/strict');
const test = require('node:test');
const { Environment } = require('../dist/sim/thermal-model');
const { DEVICES } = require('../dist/sim/devices');
const { SUNNY_WALL_ENTITY } = require('../dist/sim/demo-house');
const { HaInputsService } = require('../dist/ha/inputs.service');
const { EVENING, openWorld } = require('./sim-harness');

const HOUR = 3_600_000;

function climate(overrides = {}) {
  return { start: EVENING, outdoorNowC: 4.2, avg3dC: 6.8, outdoorRhPct: 85, pvAtStartW: null, loadAtStartW: 3400, gridOffline: null, socAtStartPct: 78, extraMoisture: {}, seed: 42, ...overrides };
}

test('the sunlit wall reads warmer in the afternoon and like the air at night and in the morning', () => {
  const env = new Environment(climate(), 'Europe/Kyiv');
  const day = EVENING - 19 * HOUR; // 2026-10-21 00:00 in Kyiv
  const excess = (h) => env.sunnyWallC(day + h * HOUR) - env.outdoor(day + h * HOUR);
  assert.ok(excess(15) > 1.5, `15:00: +${excess(15).toFixed(2)}°`);
  assert.ok(excess(15) > excess(11) + 1, 'the south-west wall gets the sun after noon');
  assert.ok(excess(9) < 0.3, `09:00: +${excess(9).toFixed(2)}°`);
  assert.equal(excess(3), 0);
});

test('the demo house has two outdoor sensors, combined by the colder one', async () => {
  assert.ok(DEVICES.some((d) => d.binding.kind === 'sunny_wall' && d.entities.some((e) => e.entityId === SUNNY_WALL_ENTITY)));
  const w = await openWorld({ warmup: false });
  try {
    const outdoor = w.config.singleton('settings').outdoor;
    assert.deepEqual(outdoor.sensorEntityIds, ['sensor.outdoor_temperature', SUNNY_WALL_ENTITY]);
    assert.equal(outdoor.aggregation, 'min');
    const south = Number(w.ha.getState(SUNNY_WALL_ENTITY).state);
    assert.ok(south >= 4.2, `the south wall keeps some of the day's sun: ${south}`);

    const inputs = new HaInputsService(w.ha, w.config, w.clock, w.bus);
    const r = inputs.outdoorReadout();
    assert.deepEqual(r.sensors.map((s) => [s.entityId, s.status]), [
      ['sensor.outdoor_temperature', 'ok'],
      [SUNNY_WALL_ENTITY, 'ok'],
    ]);
    assert.equal(r.nowC, 4.2, 'the colder, shaded sensor counts');
    assert.equal(r.source, 'sensor');

    // the simulator's outdoor control moves both
    w.world.outdoor(-5);
    assert.equal(inputs.outdoor().nowC, -5);
    assert.ok(Number(w.ha.getState(SUNNY_WALL_ENTITY).state) >= -5);
  } finally {
    await w.close();
  }
});
