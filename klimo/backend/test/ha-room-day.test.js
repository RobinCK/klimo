// The room day chart against recorder answers shaped exactly as Home Assistant sends them: the state at
// the start of the window first (lu = start), numbers as strings, float seconds, `lc` only when it
// differs, no `a` with no_attributes, `unavailable` rows while a device (or Klimo itself) was away.
const assert = require('node:assert/strict');
const test = require('node:test');
const { MIN, FakeClock, FakeHa, FakeConfig, TestHaService, Bus, state, settle } = require('./ha-harness');
const { HistoryService } = require('../dist/ha/history.service');

const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 9, 23, 16, 0); // 19:00 in Kyiv
const MIDNIGHT = Date.UTC(2026, 9, 22, 21, 0); // 2026-10-23 00:00 in Kyiv
const DATE = '2026-10-23';
const at = (h, m = 0) => MIDNIGHT + h * HOUR + m * MIN;
// HA's float seconds carry microseconds
const lu = (t, us = 0) => t / 1000 + us / 1e6;

const PLAN = {
  scheduleId: 'house',
  roomId: 'r_office',
  date: DATE,
  segments: [
    { start: 0, end: 420, profileId: 'night', heatC: 19, coolC: null, layer: 'house_schedule', exception: false },
    { start: 420, end: 1380, profileId: 'home', heatC: 21, coolC: null, layer: 'house_schedule', exception: false },
    { start: 1380, end: 1440, profileId: 'night', heatC: 19, coolC: null, layer: 'house_schedule', exception: false },
  ],
};

function registryEntry(entityId, uniqueId) {
  return { entity_id: entityId, device_id: 'mqtt_klimo', area_id: null, platform: 'mqtt', unique_id: uniqueId, disabled_by: null, hidden_by: null, original_name: null, name: null, entity_category: null };
}

/** «Office»: one temperature sensor, held by hand at 20.5° until 23:30. */
function office(config) {
  const room = config.addRoom('r_office', 'Office', 'office');
  room.temperature = { ...room.temperature, method: 'median' };
  config.addSensor('r_office', 'sensor.office_temperature');
  config.schedules = [{ id: 'house', scope: 'house', roomId: null, enabled: true, days: [] }];
  return room;
}

/**
 * The day of the report: the room sensor reported all day; Klimo was stopped for an update at 00:40
 * (its MQTT entities went unavailable) and has only just started again.
 */
const RAW_ROWS = [
  { s: '20.5', lu: lu(MIDNIGHT) },
  { s: '20.3', lu: lu(at(1, 10), 412311) },
  { s: '20.0', lu: lu(at(3), 98012) },
  { s: 'unavailable', lu: lu(at(5)) },
  { s: '20.1', lu: lu(at(5, 12), 5000), lc: lu(at(5, 12), 4000) },
  { s: '20.9', lu: lu(at(9, 30)) },
  { s: '21.2', lu: lu(at(15, 30), 731052) },
  { s: '20.6', lu: lu(at(17)) },
  { s: '20.4', lu: lu(at(18, 40)) },
];

function haAnswer(msg) {
  const ids = msg.entity_ids;
  const out = {};
  const minimalAttrs = (a) => (msg.no_attributes ? {} : { a });
  if (ids.includes('sensor.office_temperature')) out['sensor.office_temperature'] = RAW_ROWS;
  if (ids.includes('sensor.klimo_office_temperature')) {
    out['sensor.klimo_office_temperature'] = [
      { s: '20.5', ...minimalAttrs({ unit_of_measurement: '°C', device_class: 'temperature', friendly_name: 'Klimo Office температура' }), lu: lu(MIDNIGHT) },
      { s: 'unavailable', lu: lu(at(0, 40)) },
    ];
  }
  if (ids.includes('sensor.klimo_office_target')) {
    const a = { lo: null, hi: null, mode: 'heat', source: 'manual', until: at(23, 30), unit_of_measurement: '°C', device_class: 'temperature' };
    out['sensor.klimo_office_target'] = [
      { s: '20.5', ...(msg.no_attributes ? {} : { a }), lu: lu(MIDNIGHT) },
      { s: 'unavailable', ...(msg.no_attributes || msg.minimal_response ? {} : { a: { unit_of_measurement: '°C' } }), lu: lu(at(0, 40)) },
    ];
  }
  if (ids.includes('binary_sensor.klimo_office_heat_demand')) out['binary_sensor.klimo_office_heat_demand'] = [{ s: 'off', lu: lu(MIDNIGHT) }, { s: 'unavailable', lu: lu(at(0, 40)) }];
  return out;
}

/** HistoryService on the real HaService: the recorder answer goes through the WebSocket parsing too. */
async function realHa(opts = {}) {
  const clock = new FakeClock(NOW, 'UTC');
  const bus = new Bus();
  const ha = new TestHaService(clock, bus);
  ha.start('ws://ha.test/api/websocket', 'secret');
  ha.server.states = [state('sensor.office_temperature', '20.4', { unit_of_measurement: '°C', device_class: 'temperature' })];
  ha.server.answer['config/entity_registry/list'] = [
    registryEntry('sensor.klimo_office_temperature', 'klimo_r_office_temperature'),
    registryEntry('sensor.klimo_office_target', 'klimo_r_office_target'),
    registryEntry('binary_sensor.klimo_office_heat_demand', 'klimo_r_office_heat_demand'),
  ];
  ha.server.answer['history/history_during_period'] = opts.history ?? haAnswer;
  await settle();
  assert.equal(ha.connected, true);
  const config = new FakeConfig();
  office(config);
  const readModels = { resolvedDay: () => PLAN };
  const moduleRef = { get: (token) => {
    if (token === 'READ_MODELS') return readModels;
    throw new Error('not provided');
  } };
  const history = new HistoryService(ha, config, { range: async () => opts.spans ?? [] }, clock, bus, moduleRef);
  history.onModuleInit();
  return { clock, bus, ha, config, history };
}

function fakeSetup(opts = {}) {
  const clock = new FakeClock(NOW);
  const ha = new FakeHa();
  const config = new FakeConfig();
  const bus = new Bus();
  const readModels = opts.readModels ?? { resolvedDay: () => PLAN };
  const moduleRef = { get: (token) => {
    if (token === 'READ_MODELS') return readModels;
    throw new Error('not provided');
  } };
  const history = new HistoryService(ha, config, { range: async () => opts.spans ?? [] }, clock, bus, moduleRef);
  history.onModuleInit();
  return { clock, ha, config, bus, history };
}

const numeric = (series) => series.filter(([, v]) => v !== null);

test('report: Klimo’s own sensor went unavailable after midnight — the day still comes from the room sensor, not one start-state dot', async () => {
  const { ha, history } = await realHa();
  const day = await history.roomDay('r_office', DATE);

  assert.equal(day.source, 'raw_sensors', 'the room sensor the live value comes from, not Klimo’s published copy');
  assert.ok(numeric(day.series).length >= 7, `a line, not a lone point: ${JSON.stringify(day.series)}`);
  assert.deepEqual(day.series[0], [MIDNIGHT, 20.5], 'the state at midnight (the start-state row)');
  assert.deepEqual(day.series.at(-1), [NOW, 20.4], 'the line reaches «now» with the current value');
  assert.ok(day.series.some(([t, v]) => t === at(5) && v === null), 'the sensor’s unavailable minutes are a gap');
  assert.deepEqual(day.stats.min, { c: 20, at: at(3, 0) + 98 }, 'minimum at its real time');
  assert.deepEqual(day.stats.max, { c: 21.2, at: at(15, 30) + 731 }, 'maximum at its real time');
  assert.equal(day.complete, true);
  assert.equal(day.asOf, NOW);

  // the elapsed part of the day has a target band with no hole where Klimo was down
  const past = day.targetSegments.filter((s) => !s.future);
  assert.equal(past[0].from, MIDNIGHT);
  assert.equal(past.at(-1).to, NOW);
  for (let i = 1; i < past.length; i++) assert.equal(past[i].from, past[i - 1].to, 'no gap in the past band');
  assert.deepEqual(past[0], { from: MIDNIGHT, to: at(0, 40), heatC: 20.5, coolC: null, future: false, kind: 'manual' }, 'recorded target while Klimo ran');
  assert.ok(day.targetSegments.some((s) => s.future), 'the plan ahead');

  // what was asked and found, for the add-on log
  const raw = day.diag.entities.find((e) => e.entityId === 'sensor.office_temperature');
  assert.deepEqual(raw, { entityId: 'sensor.office_temperature', role: 'temperature', rows: 9, numeric: 8 });
  assert.equal(day.diag.recorder, 'ok');
  assert.equal(day.diag.ha, true);
  const q = ha.server.sent('history/history_during_period');
  assert.ok(q.every((m) => m.significant_changes_only === false));
  assert.ok(q.some((m) => m.entity_ids.includes('sensor.office_temperature') && m.minimal_response === true && m.no_attributes === true));
  assert.ok(q.every((m) => m.start_time === new Date(MIDNIGHT).toISOString()), 'local midnight of the HA time zone');
  ha.stop();
});

test('HA not connected yet (the add-on just started): an incomplete answer, never cached — the next call reads the recorder', async () => {
  const { ha, config, history, bus } = fakeSetup();
  office(config);
  ha.historyFn = (ids) => haAnswer({ entity_ids: ids, no_attributes: true, minimal_response: true });
  ha.connected = false;
  // the engine ran once, blind
  bus.emit('engine.tick', { at: NOW - MIN, result: { rooms: [{ roomId: 'r_office', tempC: null, humidity: { valuePct: null }, target: { displayC: 20.5, heatC: 20.5, coolC: null, mode: 'heat', display: 'manual', until: null } }], memory: { rooms: {} } } });
  const early = await history.roomDay('r_office', DATE);
  assert.equal(early.complete, false);
  assert.equal(early.diag.ha, false);
  assert.equal(early.diag.recorder, 'skipped');
  assert.equal(numeric(early.series).length, 0, 'no made-up point');
  assert.equal(early.stats.min, null);
  assert.equal(early.stats.max, null);
  assert.equal(ha.historyCalls.length, 0);

  ha.connected = true;
  const ready = await history.roomDay('r_office', DATE);
  assert.equal(ready.complete, true, 'the same minute: not served from the cache');
  assert.equal(ready.source, 'raw_sensors');
  assert.ok(numeric(ready.series).length >= 7);
  const calls = ha.historyCalls.length;
  await history.roomDay('r_office', DATE);
  assert.equal(ha.historyCalls.length, calls, 'a complete answer is cached for the minute');
});

test('recorder not answering (HA still starting): incomplete, not cached, then the real day', async () => {
  const { ha, config, history } = fakeSetup();
  office(config);
  let fail = true;
  ha.historyFn = (ids) => {
    if (fail) throw new Error('unknown_command: Unknown command.');
    return haAnswer({ entity_ids: ids, no_attributes: true, minimal_response: true });
  };
  const early = await history.roomDay('r_office', DATE);
  assert.equal(early.complete, false);
  assert.equal(early.diag.recorder, 'error');
  assert.match(early.diag.error, /unknown_command/);
  assert.equal(numeric(early.series).length, 0);
  fail = false;
  const ready = await history.roomDay('r_office', DATE);
  assert.equal(ready.complete, true);
  assert.equal(ready.source, 'raw_sensors');
});

test('a thermostat as the room sensor: the chart reads its current_temperature, never its setpoint', async () => {
  const { ha, config, history } = fakeSetup();
  const room = config.addRoom('r_office', 'Office', 'office');
  room.temperature = { ...room.temperature, method: 'median' };
  config.addSensor('r_office', 'climate.office');
  ha.set(state('climate.office', 'heat', { current_temperature: 20.4, temperature: 20.5 }));
  ha.historyFn = (ids, _s, _e, opts) => {
    const out = {};
    if (ids.includes('climate.office')) {
      // the climate domain always comes with attributes, carried in every row
      out['climate.office'] = [
        { s: 'heat', a: { current_temperature: 20.1, temperature: 20.5, hvac_action: 'idle' }, lu: lu(MIDNIGHT) },
        { s: 'heat', a: { current_temperature: 19.8, temperature: 20.5, hvac_action: 'heating' }, lu: lu(at(4)) },
        { s: 'heat', a: { current_temperature: 20.4, temperature: 20.5, hvac_action: 'idle' }, lu: lu(at(12)) },
      ];
      assert.equal(opts.noAttributes, false, 'attributes are asked for');
    }
    return out;
  };
  const day = await history.roomDay('r_office', DATE);
  assert.equal(day.source, 'raw_sensors');
  assert.deepEqual(day.stats.min, { c: 19.8, at: at(4) });
  assert.deepEqual(day.stats.max, { c: 20.4, at: at(12) });
  assert.ok(numeric(day.series).every(([, v]) => v !== 20.5), 'the setpoint is not a temperature');
});

test('no temperature history at all: no point and no min/max — never the target in its place', async () => {
  const { ha, config, history } = fakeSetup();
  office(config);
  ha.historyFn = (ids) => {
    const out = {};
    if (ids.includes('sensor.klimo_office_target')) out['sensor.klimo_office_target'] = [{ s: '20.5', a: { mode: 'heat', source: 'manual' }, lu: lu(MIDNIGHT) }];
    return out;
  };
  const day = await history.roomDay('r_office', DATE);
  assert.equal(day.source, 'none');
  assert.equal(numeric(day.series).length, 0);
  assert.equal(day.stats.min, null);
  assert.equal(day.stats.max, null);
  assert.equal(day.complete, true, 'the recorder answered: there is just nothing yet');
  assert.ok(day.targetSegments.some((s) => s.heatC === 20.5 && !s.future), 'the target stays in its band');
});

test('raw sensors not recorded (excluded from the recorder): Klimo’s own sensor, found by unique id under a suffixed entity id', async () => {
  const { ha, config, history } = fakeSetup();
  office(config);
  ha.regs.entities.push(registryEntry('sensor.klimo_office_temperature_2', 'klimo_r_office_temperature'));
  ha.historyFn = (ids) => {
    const out = {};
    if (ids.includes('sensor.klimo_office_temperature_2')) out['sensor.klimo_office_temperature_2'] = [{ s: '20.2', lu: lu(MIDNIGHT) }, { s: '20.6', lu: lu(at(6)) }];
    // an older, unrelated entity holds the plain id
    if (ids.includes('sensor.klimo_office_temperature')) out['sensor.klimo_office_temperature'] = [{ s: '30', lu: lu(MIDNIGHT) }];
    return out;
  };
  const day = await history.roomDay('r_office', DATE);
  assert.equal(day.source, 'klimo_entity');
  const v = (t) => day.series.filter(([x]) => x <= t).at(-1)[1];
  assert.equal(v(MIDNIGHT), 20.2);
  assert.equal(v(at(5, 55)), 20.2);
  assert.equal(v(at(6)), 20.6);
  assert.deepEqual(day.series.at(-1), [NOW, 20.6]);
  assert.deepEqual(day.stats.max, { c: 20.6, at: at(6) });
  assert.ok(day.diag.entities.some((e) => e.entityId === 'sensor.klimo_office_temperature_2' && e.role === 'klimo_temperature' && e.numeric === 2));
});

test('several sensors: combined by the room method at every change, an outlier left out as the engine does', async () => {
  const { ha, config, history } = fakeSetup();
  const room = config.addRoom('r_liv', 'Living', 'living');
  room.temperature = { ...room.temperature, method: 'average', outlier: { enabled: true, thresholdC: 1.5 } };
  config.addSensor('r_liv', 'sensor.a', 'temperature', { order: 0 });
  config.addSensor('r_liv', 'sensor.b', 'temperature', { order: 1 });
  config.addSensor('r_liv', 'sensor.c', 'temperature', { order: 2 });
  config.addSensor('r_liv', 'sensor.h1', 'humidity');
  config.addSensor('r_liv', 'sensor.h2', 'humidity');
  room.humidity = { ...room.humidity, method: 'max' };
  ha.historyFn = (ids) => {
    const out = {};
    if (ids.includes('sensor.a')) out['sensor.a'] = [{ s: '20.0', lu: lu(MIDNIGHT) }, { s: '21.0', lu: lu(at(8)) }];
    if (ids.includes('sensor.b')) out['sensor.b'] = [{ s: '20.2', lu: lu(MIDNIGHT) }, { s: 'unknown', lu: lu(at(10)) }];
    // sun on it in the afternoon
    if (ids.includes('sensor.c')) out['sensor.c'] = [{ s: '20.4', lu: lu(MIDNIGHT) }, { s: '25.0', lu: lu(at(14)) }, { s: '20.6', lu: lu(at(16)) }];
    if (ids.includes('sensor.h1')) out['sensor.h1'] = [{ s: '41', lu: lu(MIDNIGHT) }, { s: '48', lu: lu(at(7)) }];
    if (ids.includes('sensor.h2')) out['sensor.h2'] = [{ s: '45', lu: lu(MIDNIGHT) }];
    return out;
  };
  const day = await history.roomDay('r_liv', DATE);
  const v = (t) => day.series.filter(([x]) => x <= t).at(-1)[1];
  assert.equal(v(MIDNIGHT), 20.2);
  assert.equal(v(at(9)), 20.5, '(21.0 + 20.2 + 20.4) / 3');
  assert.equal(v(at(11)), 20.7, 'b unknown: (21.0 + 20.4) / 2');
  assert.equal(v(at(15)), 23, 'two live sensors: no outlier test, the average');
  assert.equal(v(at(17)), 20.8);
  assert.equal(day.humidity[0][1], 45, 'max of the humidity sensors');
  assert.equal(day.humidity.find(([t]) => t >= at(7))[1], 48);
  assert.equal(day.diag.humiditySource, 'raw_sensors');
});

test('three live sensors: the outlier is dropped before the method', async () => {
  const { ha, config, history } = fakeSetup();
  const room = config.addRoom('r_liv', 'Living', 'living');
  room.temperature = { ...room.temperature, method: 'average', outlier: { enabled: true, thresholdC: 1.5 } };
  for (const [i, id] of ['sensor.a', 'sensor.b', 'sensor.c'].entries()) config.addSensor('r_liv', id, 'temperature', { order: i });
  ha.historyFn = () => ({
    'sensor.a': [{ s: '20.0', lu: lu(MIDNIGHT) }],
    'sensor.b': [{ s: '20.2', lu: lu(MIDNIGHT) }],
    'sensor.c': [{ s: '20.4', lu: lu(MIDNIGHT) }, { s: '25.0', lu: lu(at(14)) }],
  });
  const day = await history.roomDay('r_liv', DATE);
  assert.equal(day.series.filter(([t]) => t <= at(15)).at(-1)[1], 20.1, 'c at 25° is an outlier: (20.0 + 20.2) / 2');
  assert.equal(day.stats.max.c, 20.2);
});

test('sparks: the room sensors first (by the room method), Klimo’s sensor only without them; HA down → incomplete, not cached', async () => {
  const { ha, config, history } = fakeSetup();
  office(config);
  const buckets = (value) => Array.from({ length: 84 }, (_, i) => ({ start: NOW - 7 * HOUR + i * 5 * MIN, mean: value }));
  ha.statisticsFn = () => ({
    'sensor.office_temperature': buckets(20.44),
    // Klimo was down: its own sensor's statistics stopped at the value it had
    'sensor.klimo_office_temperature': buckets(22),
    'sensor.klimo_office_target': buckets(20.5),
  });
  ha.connected = false;
  const early = await history.sparks();
  assert.equal(early.r_office.complete, false);
  assert.equal(ha.statisticsCalls.length, 0);
  ha.connected = true;
  const sparks = await history.sparks();
  assert.equal(sparks.r_office.complete, true, 'not served from the cache');
  assert.ok(sparks.r_office.values.every((v) => v === 20.4), JSON.stringify(sparks.r_office.values));
  assert.ok(sparks.r_office.targets.every((v) => v === 20.5));
});

test('the trend after a restart: the room sensors first, Klimo’s sensor for a room without recorded sensors', async () => {
  const { ha, config, history } = fakeSetup();
  office(config);
  const bed = config.addRoom('r_bed', 'Bedroom', 'bedroom');
  bed.temperature = { ...bed.temperature, method: 'median' };
  config.addSensor('r_bed', 'sensor.bed_temperature');
  const from = NOW - HOUR;
  ha.historyFn = (ids) => {
    const out = {};
    if (ids.includes('sensor.office_temperature')) out['sensor.office_temperature'] = [{ s: '20.0', lu: lu(from) }, { s: '20.3', lu: lu(from + 30 * MIN) }];
    // Klimo's sensor of the office still shows a stale value from before it stopped
    if (ids.includes('sensor.klimo_office_temperature')) out['sensor.klimo_office_temperature'] = [{ s: '22.0', lu: lu(from) }];
    if (ids.includes('sensor.klimo_bedroom_temperature')) out['sensor.klimo_bedroom_temperature'] = [{ s: '18.5', lu: lu(from) }];
    return out;
  };
  const got = await history.recentRoomTemps(config.engineConfig().rooms, from, NOW);
  assert.deepEqual(got.r_office.at(0), [from, 20]);
  assert.deepEqual(got.r_office.at(-1), [NOW, 20.3]);
  assert.equal(got.r_office.length, 61);
  assert.deepEqual(got.r_bed.at(-1), [NOW, 18.5], 'the bedroom sensor is not recorded: Klimo’s sensor');
});

test('a target held by hand until 23:30 is drawn ahead until then, the schedule after it', async () => {
  const { ha, config, history, bus } = fakeSetup();
  office(config);
  ha.historyFn = (ids) => haAnswer({ entity_ids: ids, no_attributes: ids.length > 1, minimal_response: ids.length > 1 });
  const target = { displayC: 20.5, heatC: 20.5, coolC: null, mode: 'heat', layer: 'manual', display: 'manual', until: at(23, 30) };
  bus.emit('engine.tick', { at: NOW - MIN, result: { rooms: [{ roomId: 'r_office', tempC: 20.4, humidity: { valuePct: null }, target }], memory: { rooms: {} } } });
  const day = await history.roomDay('r_office', DATE);
  const ahead = day.targetSegments.filter((s) => s.future);
  assert.deepEqual(ahead, [
    { from: NOW, to: at(23, 30), heatC: 20.5, coolC: null, future: true, kind: 'manual' },
    { from: at(23, 30), to: MIDNIGHT + 24 * HOUR, heatC: 19, coolC: null, future: true, kind: 'schedule' },
  ]);
  assert.equal(day.diag.targetSource, 'mixed', 'recorded until Klimo stopped, the plan for the gap');
});
