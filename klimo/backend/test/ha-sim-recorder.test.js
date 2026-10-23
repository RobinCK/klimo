// The simulator's recorder and fake Home Assistant answer the recorder calls the way a real one does,
// so the room day chart meets in the simulator what it meets in a house.
const assert = require('node:assert/strict');
const test = require('node:test');
const { SimRecorder } = require('../dist/sim/sim-recorder');
const { fakeHa, EVENING } = require('./sim-harness');

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 22, 21, 0);

test('history like HA: the state at the start first (lu = start), then changes only for a minimal response', () => {
  const rec = new SimRecorder(() => 'Europe/Kyiv');
  const attrs = (battery) => ({ unit_of_measurement: '°C', device_class: 'temperature', battery });
  rec.record('sensor.office_temperature', '20.5', attrs(90), T0 - 30 * MIN);
  // a battery report changes only the attributes
  rec.record('sensor.office_temperature', '20.5', attrs(89), T0 + 10 * MIN);
  rec.record('sensor.office_temperature', '20.3', attrs(89), T0 + 20 * MIN + 412);
  rec.record('sensor.office_temperature', 'unavailable', null, T0 + 30 * MIN);
  rec.record('sensor.office_temperature', '20.1', attrs(89), T0 + 40 * MIN);

  const minimal = rec.history(['sensor.office_temperature'], T0, T0 + 60 * MIN, { minimal: true, noAttributes: true })['sensor.office_temperature'];
  assert.deepEqual(minimal, [
    { s: '20.5', lu: T0 / 1000 },
    { s: '20.3', lu: (T0 + 20 * MIN + 412) / 1000 },
    { s: 'unavailable', lu: (T0 + 30 * MIN) / 1000 },
    { s: '20.1', lu: (T0 + 40 * MIN) / 1000 },
  ]);
  assert.ok(minimal.every((r) => typeof r.s === 'string' && typeof r.lu === 'number'));

  const withAttrs = rec.history(['sensor.office_temperature'], T0, T0 + 60 * MIN, { minimal: true, noAttributes: false })['sensor.office_temperature'];
  assert.deepEqual(withAttrs[0].a, attrs(90), 'the first row carries the attributes');
  assert.ok(withAttrs.slice(1).every((r) => !('a' in r)), 'the rest do not');

  const full = rec.history(['sensor.office_temperature'], T0, T0 + 60 * MIN, { minimal: false, noAttributes: false })['sensor.office_temperature'];
  assert.equal(full.length, 5, 'without minimal_response every row, attribute changes too');
  assert.ok(full.every((r) => 'a' in r));
});

test('history like HA: a thermostat always comes with its attributes; nothing before the window → no start row', () => {
  const rec = new SimRecorder(() => 'Europe/Kyiv');
  rec.record('climate.office', 'heat', { current_temperature: 20.1, temperature: 20.5 }, T0 + 5 * MIN);
  rec.record('climate.office', 'heat', { current_temperature: 20.4, temperature: 20.5 }, T0 + 15 * MIN);
  const rows = rec.history(['climate.office'], T0, T0 + 60 * MIN, { minimal: true, noAttributes: false })['climate.office'];
  assert.deepEqual(rows.map((r) => [r.lu, r.a.current_temperature]), [[(T0 + 5 * MIN) / 1000, 20.1], [(T0 + 15 * MIN) / 1000, 20.4]]);
});

test('the fake HA answers no recorder call while disconnected, and none while its recorder is still starting', async () => {
  const sim = fakeHa({ connect: false });
  try {
    await assert.rejects(sim.ha.history(['sensor.outdoor_temperature'], EVENING - 60 * MIN, EVENING, { minimal: true, noAttributes: true }), /not connected/);
    await assert.rejects(sim.ha.statistics(['sensor.outdoor_temperature'], EVENING - 60 * MIN, EVENING, 'hour', ['mean']), /not connected/);
    sim.ha.connect();
    sim.ha.delayRecorder(60_000);
    await assert.rejects(sim.ha.history(['sensor.outdoor_temperature'], EVENING - 60 * MIN, EVENING, { minimal: true, noAttributes: true }), (e) => e.code === 'unknown_command');
    sim.ha.delayRecorder(0);
    const rows = await sim.ha.history(['sensor.outdoor_temperature'], EVENING - 60 * MIN, EVENING, { minimal: true, noAttributes: true });
    assert.ok(Array.isArray(rows['sensor.outdoor_temperature']));
  } finally {
    sim.dispose();
  }
});
