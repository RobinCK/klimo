const assert = require('node:assert/strict');
const test = require('node:test');
const { openWorld } = require('./sim-harness');
const { SimRecorder } = require('../dist/sim/sim-recorder');
const { ConsumptionService } = require('../dist/ha/consumption.service');

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 9, 20, 21, 0); // 2026-10-21 00:00 in Kyiv
const near = (a, b, eps = 1e-6) => assert.ok(a !== undefined && Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('the fake recorder compiles a meter like HA: a sum that goes on across a reset, days and months from the hours', () => {
  const rec = new SimRecorder(() => 'Europe/Kyiv');
  const attrs = { state_class: 'total_increasing', unit_of_measurement: 'm³' };
  // the long-term history before the first state, as imported (HA's sums start at zero)
  rec.importHours('sensor.gas', 'meter', [{ start: T0 - 2 * HOUR, state: 99, sum: 0 }, { start: T0 - HOUR, state: 99.5, sum: 0.5 }]);
  for (const [min, v] of [[10, 100], [70, 101], [130, 0.5], [190, 1.5]]) rec.record('sensor.gas', String(v), attrs, T0 + min * MIN);
  const now = T0 + 5 * HOUR;
  const hours = rec.statistics(['sensor.gas'], T0 - HOUR, T0 + 4 * HOUR, 'hour', ['state', 'sum', 'change'], now)['sensor.gas'];
  assert.deepEqual(hours.map((r) => [r.state, r.sum]), [[99.5, 0.5], [100, 1], [101, 2], [0.5, 2.5], [1.5, 3.5]]);
  assert.deepEqual(hours.map((r) => r.change), [0.5, 0.5, 1, 0.5, 1], 'the replaced meter counts from zero, never negative');

  const [day] = rec.statistics(['sensor.gas'], T0, T0 + DAY, 'day', ['sum', 'change'], now)['sensor.gas'];
  assert.equal(day.start, T0);
  near(day.change, 3, 1e-9);
  const [month] = rec.statistics(['sensor.gas'], T0, T0 + DAY, 'month', ['change'], now)['sensor.gas'];
  assert.equal(month.start, Date.UTC(2026, 8, 30, 21, 0), '1 October in Kyiv');
  near(month.change, 3.5, 1e-9);
  // hours are compiled only once they are over
  assert.equal(rec.statistics(['sensor.gas'], T0 + 5 * HOUR, T0 + 6 * HOUR, 'hour', ['change'], now)['sensor.gas'], undefined);

  // ten days later the states are gone, the hours stay
  rec.compact(T0 + 11 * DAY);
  assert.deepEqual(rec.history(['sensor.gas'], T0, T0 + 4 * HOUR, { minimal: true, noAttributes: true })['sensor.gas'].length, 1);
  const kept = rec.statistics(['sensor.gas'], T0 + 2 * HOUR, T0 + 3 * HOUR, 'hour', ['sum', 'change'], T0 + 11 * DAY)['sensor.gas'];
  assert.deepEqual(kept, [{ start: T0 + 2 * HOUR, sum: 2.5, change: 0.5 }]);
});

test('the demo house: months of meter statistics, more gas on colder days, the boiler burning on the live meter', async () => {
  const w = await openWorld({ scenario: 'frost_morning', warmup: false });
  try {
    const t0 = w.clock.now();
    const stats = await w.ha.statistics(['sensor.gas_meter', 'sensor.outdoor_temperature', 'sensor.heat_pump_energy'], t0 - 120 * DAY, t0, 'day', ['change', 'mean']);
    const gas = stats['sensor.gas_meter'];
    const outdoor = new Map(stats['sensor.outdoor_temperature'].map((r) => [r.start, r.mean]));
    assert.ok(gas.length >= 118, `${gas.length} days of gas`);
    assert.ok(stats['sensor.heat_pump_energy'].length >= 118);
    assert.ok(gas.every((r) => r.change >= 0));
    const avg = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
    const cold = gas.filter((r) => outdoor.get(r.start) < -3).map((r) => r.change);
    const mild = gas.filter((r) => outdoor.get(r.start) > 5).map((r) => r.change);
    assert.ok(cold.length >= 5 && mild.length >= 5, `${cold.length} cold and ${mild.length} mild days`);
    assert.ok(avg(cold) > 3 * avg(mild), `cold ${avg(cold)} m³ vs mild ${avg(mild)} m³ a day`);
    // the stove burns a little every day
    assert.ok(Math.min(...gas.slice(0, -1).map((r) => r.change)) > 0.1);

    // −14 °C: the boiler has the house to itself and the meter counts
    const meter = () => Number(w.ha.getState('sensor.gas_meter').state);
    assert.equal(w.ha.getState('sensor.gas_meter').attributes.state_class, 'total_increasing');
    const before = meter();
    w.world.clock({ jumpTo: t0 + 2 * HOUR });
    assert.equal(w.ha.getState('binary_sensor.boiler_flame').state, 'on');
    assert.ok(meter() - before > 1, `${meter() - before} m³ in two hours`);

    // the meter is replaced mid-morning: it counts from zero, the hours stay plausible
    w.world.fault({ entityId: 'sensor.gas_meter', kind: 'meter_reset' });
    assert.ok(meter() < 0.5);
    w.world.clock({ jumpTo: t0 + 4 * HOUR });
    const hourly = (await w.ha.statistics(['sensor.gas_meter'], t0 - HOUR, t0 + 4 * HOUR, 'hour', ['change']))['sensor.gas_meter'];
    assert.equal(hourly.length, 5);
    assert.ok(hourly.every((r) => r.change >= 0 && r.change < 5), JSON.stringify(hourly.map((r) => r.change)));
    assert.throws(() => w.world.fault({ entityId: 'sensor.outdoor_temperature', kind: 'meter_reset' }), /not a simulated meter/);

    // what the source page reads: every past day of the month known, December to compare with
    const service = new ConsumptionService(w.ha, w.config, w.spans, w.clock);
    const month = await service.source('s_boiler', { range: 'month' });
    assert.equal(month.date, '2026-01-01');
    const past = month.buckets.filter((b) => b.end <= t0);
    assert.equal(past.length, 14);
    assert.ok(past.every((b) => b.gas > 0 && b.outdoorAvgC !== null && b.hdd > 0));
    assert.equal(month.previous.complete, true);
    assert.ok(month.totals.cost > 0);
    const year = await service.source('s_heatpump', { range: 'year', date: '2025-06-15' });
    assert.ok(year.buckets.filter((b) => b.electricity > 0).length >= 3, 'the archive reaches back into 2025');
  } finally {
    await w.close();
  }
});
