const assert = require('node:assert/strict');
const test = require('node:test');
const { MIN, FakeClock, FakeHa, FakeConfig, Bus, state } = require('./ha-harness');
const { HaInputsService } = require('../dist/ha/inputs.service');
const { HistoryService } = require('../dist/ha/history.service');

const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 9, 21, 13, 0); // 16:00 in Kyiv: the sun is on the south wall

function setup(outdoor = {}) {
  const clock = new FakeClock(NOW);
  const ha = new FakeHa();
  const config = new FakeConfig();
  config.settings.outdoor = {
    sensorEntityIds: ['sensor.north', 'sensor.south'],
    aggregation: 'median',
    weatherEntityId: 'weather.home',
    staleAfterMin: 30,
    holdMin: 30,
    ...outdoor,
  };
  const inputs = new HaInputsService(ha, config, clock, new Bus());
  return { clock, ha, config, inputs };
}

const temp = (id, v, at = NOW, unit = '°C', name = null) =>
  state(id, v, { device_class: 'temperature', unit_of_measurement: unit, ...(name ? { friendly_name: name } : {}) }, at);

test('outdoor sensors: combined by the chosen method, each reading shown', () => {
  const { ha, config, inputs } = setup();
  ha.set(temp('sensor.north', '4.0', NOW, '°C', 'North wall'));
  ha.set(temp('sensor.south', '9.0', NOW, '°C', 'South wall'));
  const expected = { median: 6.5, average: 6.5, min: 4, max: 9, primary: 4 };
  for (const [method, value] of Object.entries(expected)) {
    config.settings.outdoor.aggregation = method;
    assert.equal(inputs.outdoor().nowC, value, method);
    assert.equal(inputs.outdoor().source, 'sensor');
  }
  const r = inputs.outdoorReadout();
  assert.equal(r.method, 'primary');
  assert.equal(r.nowC, 4);
  assert.deepEqual(r.sensors, [
    { entityId: 'sensor.north', name: 'North wall', valueC: 4, lastReportedAt: NOW, status: 'ok' },
    { entityId: 'sensor.south', name: 'South wall', valueC: 9, lastReportedAt: NOW, status: 'ok' },
  ]);
});

test('outdoor sensors: a stale or unavailable one is left out, the others carry on', () => {
  const { ha, config, inputs } = setup({ aggregation: 'max' });
  ha.set(temp('sensor.north', '4.0'));
  ha.set(temp('sensor.south', '9.0', NOW - 31 * MIN));
  ha.set(state('weather.home', 'sunny', { temperature: 12, temperature_unit: '°C' }));
  let o = inputs.outdoorReadout();
  assert.equal(o.nowC, 4, 'the silent south sensor does not count');
  assert.equal(o.source, 'sensor', 'one usable sensor is enough: no weather fallback');
  assert.deepEqual(o.sensors.map((s) => [s.entityId, s.status, s.valueC]), [
    ['sensor.north', 'ok', 4],
    ['sensor.south', 'stale', 9],
  ]);

  ha.set(temp('sensor.south', '8.0'));
  ha.set(temp('sensor.north', 'unavailable'));
  o = inputs.outdoorReadout();
  assert.equal(o.nowC, 8);
  assert.deepEqual(o.sensors.map((s) => [s.status, s.valueC]), [['unavailable', null], ['ok', 8]]);

  // 'primary' is the first usable sensor in the list
  config.settings.outdoor.aggregation = 'primary';
  assert.equal(inputs.outdoor().nowC, 8);
});

test('outdoor sensors: none usable → the combined value is held, then the weather entity', () => {
  const { clock, ha, config, inputs } = setup({ aggregation: 'min' });
  ha.set(temp('sensor.north', '4.0'));
  ha.set(temp('sensor.south', '6.0'));
  ha.set(state('weather.home', 'cloudy', { temperature: 41, temperature_unit: '°F' }));
  inputs.onApplicationBootstrap();
  assert.equal(inputs.outdoor().nowC, 4);

  clock.advance(30_000);
  ha.set(temp('sensor.north', 'unavailable', clock.now()));
  ha.set(temp('sensor.south', 'unavailable', clock.now()));
  let o = inputs.outdoor();
  assert.deepEqual([o.source, o.nowC], ['hold', 4]);
  clock.advance(29 * MIN);
  assert.equal(inputs.outdoor().source, 'hold');
  clock.advance(MIN);
  o = inputs.outdoor();
  assert.deepEqual([o.source, o.nowC], ['weather', 5], 'held 30 min from the last good reading, then 41 °F');

  // a changed sensor list does not hold a value that came from other sensors
  ha.set(temp('sensor.north', '3.0', clock.now()));
  inputs.outdoor();
  ha.set(temp('sensor.north', 'unavailable', clock.now()));
  config.settings.outdoor.sensorEntityIds = ['sensor.south'];
  assert.equal(inputs.outdoor().source, 'weather');
  inputs.onModuleDestroy();
});

test('outdoor sensors: each sensor in its own unit; the 10-min mean runs over the combined value', () => {
  const { clock, ha, inputs } = setup({ aggregation: 'average' });
  ha.set(temp('sensor.north', '39.2', NOW, '°F')); // 4 °C
  ha.set(temp('sensor.south', '6.0'));
  inputs.onApplicationBootstrap();
  assert.equal(inputs.outdoor().nowC, 5);
  for (let i = 1; i <= 10; i++) {
    ha.set(temp('sensor.south', String(6 + 2 * i), clock.now() + MIN));
    clock.advance(MIN); // combined: 5 + i
  }
  const o = inputs.outdoor();
  assert.equal(o.nowC, 15);
  // window [0, 10] min: combined 5…14 one minute each → 9.5
  assert.equal(o.avg10C, 9.5);
  inputs.onModuleDestroy();
});

test('outdoor sensors: the N-day mean combines the sensors hour by hour', async () => {
  const { ha, config, inputs } = setup({ aggregation: 'min' });
  config.season = { ...config.season, avgDays: 3 };
  const hours = (fn) => Array.from({ length: 72 }, (_, i) => ({ start: NOW - (72 - i) * HOUR, mean: fn(i) }));
  // the south sensor reads 6° more for 8 sunny hours a day; the north one has a 12-hour gap
  ha.statisticsFn = (ids) => {
    assert.deepEqual(ids, ['sensor.north', 'sensor.south']);
    return {
      'sensor.north': hours(() => 5).filter((_, i) => i < 30 || i >= 42),
      'sensor.south': hours((i) => (i % 24 >= 10 && i % 24 < 18 ? 11 : 5.5)),
    };
  };
  await inputs.refreshAverage();
  // min per hour: 5 while the north sensor reports; its 12 missing hours (06:00…17:00 UTC of the
  // second day) fall to the south one, 8 of them sunny
  assert.equal(inputs.outdoor().avgNC, 5.7, '(60 × 5 + 8 × 11 + 4 × 5.5) / 72');

  config.settings.outdoor.aggregation = 'max';
  await inputs.refreshAverage();
  const sunny = 24; // 8 hours × 3 days at 11°
  assert.equal(inputs.outdoor().avgNC, Math.round(((72 - sunny) * 5.5 + sunny * 11) / 72 * 10) / 10);

  // too few hours in statistics: the raw history, bucketed per hour and combined the same way
  ha.statisticsFn = () => ({ 'sensor.south': hours(() => 9).slice(0, 10) });
  ha.historyFn = (ids) => {
    assert.deepEqual(ids, ['sensor.north', 'sensor.south']);
    return {
      'sensor.north': [{ s: '2', lu: (NOW - 72 * HOUR) / 1000 }],
      'sensor.south': [{ s: '6', lu: (NOW - 72 * HOUR) / 1000 }, { s: '10', lu: (NOW - 36 * HOUR) / 1000 }],
    };
  };
  config.settings.outdoor.aggregation = 'average';
  await inputs.refreshAverage();
  assert.equal(inputs.outdoor().avgNC, 5, '(2+6)/2 for 36 h, (2+10)/2 for 36 h');
});

test('outdoor history for the season card: hourly points combined across the sensors', async () => {
  const clock = new FakeClock(NOW);
  const ha = new FakeHa();
  const config = new FakeConfig();
  config.settings.outdoor = { sensorEntityIds: ['sensor.north', 'sensor.south'], aggregation: 'min', weatherEntityId: null, staleAfterMin: 30, holdMin: 30 };
  ha.set(temp('sensor.north', '4'));
  ha.set(temp('sensor.south', '6'));
  const end = Math.floor(NOW / HOUR) * HOUR + HOUR;
  const from = end - 24 * HOUR;
  ha.statisticsFn = () => ({
    'sensor.north': [{ start: from, mean: 3, min: 2, max: 4 }, { start: from + HOUR, mean: 4, min: 3, max: 5 }],
    'sensor.south': [{ start: from, mean: 5, min: 1, max: 9 }, { start: from + 2 * HOUR, mean: 7, min: 6, max: 8 }],
  });
  const spans = { range: async () => [] };
  const history = new HistoryService(ha, config, spans, clock, new Bus(), { get: () => { throw new Error('not provided'); } });
  history.onModuleInit();
  const dto = await history.outdoor(1);
  assert.deepEqual(dto.series.map((p) => [p.start - from, p.mean, p.min, p.max]), [
    [0, 3, 1, 4],
    [HOUR, 4, 3, 5],
    [2 * HOUR, 7, 6, 8],
  ]);
  assert.equal(dto.avgC, 4.7);
});
