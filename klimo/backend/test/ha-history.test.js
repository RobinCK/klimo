const assert = require('node:assert/strict');
const test = require('node:test');
const { MIN, FakeClock, FakeHa, FakeConfig, Bus, state } = require('./ha-harness');
const { HistoryService } = require('../dist/ha/history.service');
const { downsample, timeWeightedMean, bucketize, combine } = require('../dist/ha/series');

const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 9, 21, 16, 0); // 19:00 in Kyiv
const MIDNIGHT = Date.UTC(2026, 9, 20, 21, 0); // 2026-10-21 00:00 in Kyiv
const sec = (t) => t / 1000;

function setup(opts = {}) {
  const clock = new FakeClock(NOW);
  const ha = new FakeHa();
  const config = new FakeConfig();
  const bus = new Bus();
  const spanRows = opts.spans ?? [];
  const spans = { range: async (from, to, subject, subjectId) => spanRows.filter((s) => s.subject === subject && s.subjectId === subjectId && s.startTs < to && (s.endTs === null || s.endTs > from)) };
  const readModels = opts.readModels ?? null;
  const moduleRef = { get: (token) => {
    if (token === 'READ_MODELS' && readModels) return readModels;
    throw new Error('not provided');
  } };
  const history = new HistoryService(ha, config, spans, clock, bus, moduleRef);
  history.onModuleInit();
  return { clock, ha, config, bus, history };
}

function livingRoom(config) {
  const room = config.addRoom('r_liv', 'Вітальня', 'vitalnia');
  room.temperature = { ...room.temperature, method: 'average', staleAfterMin: 90 };
  config.addSensor('r_liv', 'sensor.a');
  config.addSensor('r_liv', 'sensor.b');
  config.addSensor('r_liv', 'sensor.h', 'humidity');
  config.addSensor('r_liv', 'sensor.excluded', 'temperature', { included: false });
  return room;
}

test('series helpers: bucket means, time-weighted mean, method combine', () => {
  const pts = Array.from({ length: 1000 }, (_, i) => [i * 1000, i % 2 ? 21 : 20]);
  const ds = downsample(pts, 0, 1_000_000, 300);
  assert.ok(ds.length <= 300);
  assert.ok(ds.every(([, v]) => Math.abs(v - 20.5) < 0.6));
  assert.deepEqual(downsample([[0, null], [10, null], [20, 5]], 0, 30, 2), [[5, null], [20, 5]]);
  assert.equal(timeWeightedMean([[0, 10], [30, 20]], 0, 60), 15);
  assert.equal(timeWeightedMean([[0, 10], [30, null]], 0, 60), 10, 'gaps do not count');
  assert.deepEqual(bucketize([[0, 10], [30, 20]], 0, 60, 30).map((b) => b.mean), [10, 20]);
  assert.equal(combine([{ v: 19.7, w: 1 }, { v: 19.8, w: 1 }, { v: 20.9, w: 0.5 }], 'median'), 19.8);
  assert.equal(combine([{ v: 20, w: 1 }, { v: 21, w: 1 }, { v: 22, w: 1 }, { v: 23, w: 1 }], 'median'), 21.5);
  assert.equal(Math.round(combine([{ v: 19.7, w: 1 }, { v: 19.8, w: 1 }, { v: 20.9, w: 0.5 }], 'weighted') * 10) / 10, 20);
});

test('series: ≤ 300 points of bucket means, gaps kept, °F converted, non-numeric as states', async () => {
  const { ha, history } = setup();
  const from = NOW - 24 * HOUR;
  ha.set(state('sensor.t', '20', { device_class: 'temperature', unit_of_measurement: '°C' }));
  ha.set(state('sensor.f', '68', { device_class: 'temperature', unit_of_measurement: '°F' }));
  ha.set(state('binary_sensor.w', 'off', { device_class: 'window' }));
  ha.historyFn = (ids) => ({
    'sensor.t': Array.from({ length: 1440 }, (_, i) => ({ s: i >= 600 && i < 660 ? 'unavailable' : String(20 + (i % 2)), lu: sec(from + i * MIN) })),
    'sensor.f': [{ s: '68', lu: sec(from) }, { s: '77', lu: sec(from + HOUR) }],
    'binary_sensor.w': [{ s: 'off', lu: sec(from) }, { s: 'on', lu: sec(from + HOUR) }, { s: 'unavailable', lu: sec(from + 2 * HOUR) }],
    ...(ids.includes('sensor.none') ? {} : {}),
  });
  const [t, f, w] = await history.series({ ids: ['sensor.t', 'sensor.f', 'binary_sensor.w'], from, to: NOW });
  assert.ok(t.points.length <= 300 && t.points.length > 250);
  assert.equal(t.unit, '°C');
  assert.ok(t.points.some(([, v]) => v === null), 'an unavailable hour stays a gap');
  assert.ok(t.points.filter(([, v]) => v !== null).every(([, v]) => v >= 20 && v <= 21));
  assert.deepEqual(f.points, [[from, 20], [from + HOUR, 25]]);
  assert.equal(f.unit, '°C');
  assert.deepEqual(w.points, []);
  assert.deepEqual(w.states, [[from, 'off'], [from + HOUR, 'on']]);
  assert.deepEqual(ha.historyCalls[0].opts, { minimal: true, noAttributes: true });
});

test('series: attribute series read the attribute; cache 60 s; validation and HA down', async () => {
  const { ha, history, clock } = setup();
  const from = NOW - HOUR;
  ha.set(state('climate.trv', 'heat', { current_temperature: 20 }));
  ha.historyFn = () => ({ 'climate.trv': [{ s: 'heat', lu: sec(from), a: { current_temperature: 19.5, temperature: 21 } }, { s: 'heat', lu: sec(from + MIN) }, { s: 'heat', lu: sec(from + 2 * MIN), a: { current_temperature: 19.9 } }] });
  const [trv] = await history.series({ ids: ['climate.trv'], from, to: NOW, attribute: 'current_temperature' });
  assert.deepEqual(trv.points, [[from, 19.5], [from + MIN, 19.5], [from + 2 * MIN, 19.9]]);
  assert.deepEqual(ha.historyCalls[0].opts, { minimal: false, noAttributes: false });
  await history.series({ ids: ['climate.trv'], from, to: NOW, attribute: 'current_temperature' });
  assert.equal(ha.historyCalls.length, 1, 'cached');
  clock.advance(61_000);
  await history.series({ ids: ['climate.trv'], from, to: NOW, attribute: 'current_temperature' });
  assert.equal(ha.historyCalls.length, 2);

  const ids = Array.from({ length: 21 }, (_, i) => `sensor.s${i}`);
  await assert.rejects(history.series({ ids, from, to: NOW }), (e) => e.code === 'validation');
  await assert.rejects(history.series({ ids: ['sensor.t'], from: NOW - 32 * 24 * HOUR, to: NOW }), (e) => e.code === 'validation');
  ha.connected = false;
  await assert.rejects(history.series({ ids: ['sensor.t'], from, to: NOW }), (e) => e.code === 'ha_unavailable');
});

test('room day: Klimo’s own sensor when it has data', async () => {
  const { ha, config, history } = setup();
  livingRoom(config);
  // the entity was renamed in HA: found through its unique id
  ha.regs.entities.push({ entity_id: 'sensor.living_klimo_temp', device_id: null, area_id: null, platform: 'mqtt', unique_id: 'klimo_r_liv_temperature', disabled_by: null, hidden_by: null, original_name: null, name: null, entity_category: null });
  ha.historyFn = (ids) => {
    const out = {};
    if (ids.includes('sensor.living_klimo_temp')) out['sensor.living_klimo_temp'] = [{ s: '20.04', lu: sec(MIDNIGHT) }, { s: '20.46', lu: sec(MIDNIGHT + 6 * HOUR) }];
    return out;
  };
  const day = await history.roomDay('r_liv', '2026-10-21');
  assert.equal(day.source, 'klimo_entity');
  assert.deepEqual(day.series, [[MIDNIGHT, 20], [MIDNIGHT + 6 * HOUR, 20.5]]);
  assert.deepEqual(day.stats.min, { c: 20, at: MIDNIGHT });
  assert.deepEqual(day.stats.max, { c: 20.5, at: MIDNIGHT + 6 * HOUR });
  assert.ok(ha.historyCalls[0].ids.includes('sensor.living_klimo_temp'));
});

test('room day: no Klimo data → rebuilt from the raw sensors with the room method', async () => {
  const { ha, config, history } = setup();
  livingRoom(config);
  ha.historyFn = (ids) => {
    const out = {};
    if (ids.includes('sensor.a')) out['sensor.a'] = [{ s: '20', lu: sec(MIDNIGHT - HOUR) }, { s: '20.4', lu: sec(MIDNIGHT + 10 * HOUR) }];
    if (ids.includes('sensor.b')) out['sensor.b'] = [{ s: '21', lu: sec(MIDNIGHT - HOUR) }];
    if (ids.includes('sensor.h')) out['sensor.h'] = [{ s: '46.4', lu: sec(MIDNIGHT) }];
    return out;
  };
  const day = await history.roomDay('r_liv', '2026-10-21');
  assert.equal(day.source, 'raw_sensors');
  assert.ok(day.series.length > 200 && day.series.length <= 300);
  assert.equal(day.series[0][1], 20.5, 'average of 20 and 21');
  const late = day.series.find(([t]) => t >= MIDNIGHT + 10 * HOUR);
  assert.equal(late[1], 20.7, 'a quiet sensor keeps its last value (the recorder stores changes only)');
  assert.equal(day.humidity[0][1], 46);
  const rawCall = ha.historyCalls.find((c) => c.ids.includes('sensor.a'));
  assert.deepEqual(rawCall.ids.sort(), ['sensor.a', 'sensor.b', 'sensor.h'], 'excluded sensors stay out');
});

test('the last hour for the trend after a restart: Klimo’s own sensor, else the raw sensors when it went quiet', async () => {
  const { ha, config, history } = setup();
  livingRoom(config);
  const bed = config.addRoom('r_bed', 'Спальня', 'spalnia');
  bed.temperature = { ...bed.temperature, method: 'average' };
  config.addSensor('r_bed', 'sensor.c');
  config.addRoom('r_empty', 'Комора', 'komora');
  const from = NOW - HOUR;
  ha.historyFn = (ids) => {
    const out = {};
    // the living room's own sensor ran until a minute ago, warming 0.1° every 10 min
    if (ids.includes('sensor.klimo_vitalnia_temperature')) {
      out['sensor.klimo_vitalnia_temperature'] = [...Array.from({ length: 6 }, (_, i) => ({ s: (20 + i / 10).toFixed(1), lu: sec(from + i * 10 * MIN) })), { s: 'unavailable', lu: sec(NOW - MIN) }];
    }
    // the bedroom's stopped 40 min ago (Klimo was down): its raw sensor carries on
    if (ids.includes('sensor.klimo_spalnia_temperature')) out['sensor.klimo_spalnia_temperature'] = [{ s: '18.0', lu: sec(from) }, { s: 'unavailable', lu: sec(from + 20 * MIN) }];
    if (ids.includes('sensor.c')) out['sensor.c'] = [{ s: '18.0', lu: sec(from) }, { s: '18.6', lu: sec(from + 30 * MIN) }];
    return out;
  };
  const got = await history.recentRoomTemps(config.engineConfig().rooms, from, NOW);
  assert.deepEqual(Object.keys(got).sort(), ['r_bed', 'r_liv'], 'a room without any data is left out');
  const liv = got.r_liv;
  assert.equal(liv.length, 59, 'one point a minute while the sensor reported');
  assert.deepEqual(liv[0], [from, 20]);
  assert.deepEqual(liv.at(-1), [NOW - 2 * MIN, 20.5]);
  const bedPts = got.r_bed;
  assert.equal(bedPts.length, 61);
  assert.deepEqual(bedPts.at(-1), [NOW, 18.6]);
  assert.equal(ha.historyCalls.length, 2);
  assert.deepEqual(ha.historyCalls[1].ids, ['sensor.c']);
});

test('room day: recorder down → the last hours from memory', async () => {
  const { ha, config, history, bus } = setup();
  livingRoom(config);
  const roomState = (t) => ({ roomId: 'r_liv', tempC: t, humidity: { valuePct: 45 }, target: { displayC: 21, heatC: 21, coolC: null, mode: 'heat' } });
  const memory = { rooms: { r_liv: { learned: { heatRateCPerH: 1.2, coolRateCPerH: null } } } };
  for (let i = 0; i < 5; i++) bus.emit('engine.tick', { at: NOW - (5 - i) * MIN, result: { rooms: [roomState(20 + i / 10)], memory } });
  ha.historyFn = () => {
    throw new Error('recorder is not running');
  };
  const day = await history.roomDay('r_liv', '2026-10-21');
  assert.equal(day.source, 'memory');
  assert.equal(day.series.length, 5);
  assert.deepEqual(day.series.at(-1), [NOW - MIN, 20.4]);
  assert.equal(day.stats.rateCPerH, 1.2);
});

test('room day: target segments past from the target sensor, future from the schedule; demand spans', async () => {
  const resolved = { scheduleId: 'house', roomId: 'r_liv', date: '2026-10-21', segments: [
    { start: 0, end: 1380, profileId: 'home', heatC: 21, coolC: null, layer: 'house_schedule', exception: false },
    { start: 1380, end: 1440, profileId: 'night', heatC: 19, coolC: null, layer: 'house_schedule', exception: false },
  ] };
  const calls = [];
  const readModels = { resolvedDay: (...args) => (calls.push(args), resolved) };
  const spans = [
    { subject: 'room', subjectId: 'r_liv', kind: 'demand', mode: 'heat', startTs: MIDNIGHT + HOUR, endTs: MIDNIGHT + 2 * HOUR },
    { subject: 'room', subjectId: 'r_liv', kind: 'demand', mode: 'heat', startTs: NOW - 30 * MIN, endTs: null },
  ];
  const { ha, config, history } = setup({ readModels, spans });
  livingRoom(config);
  config.schedules = [{ id: 'house', scope: 'house', roomId: null, enabled: true, days: [] }];
  ha.historyFn = (ids) =>
    ids.includes('sensor.klimo_vitalnia_target')
      ? { 'sensor.klimo_vitalnia_target': [
          { s: '21', lu: sec(MIDNIGHT - HOUR), a: { source: 'schedule' } },
          { s: '18', lu: sec(MIDNIGHT + 8 * HOUR), a: { source: 'manual', until: 0 } },
        ] }
      : { 'sensor.klimo_vitalnia_temperature': [{ s: '20', lu: sec(MIDNIGHT) }] };
  const day = await history.roomDay('r_liv', '2026-10-21');
  const at23 = MIDNIGHT + 23 * HOUR;
  assert.deepEqual(day.targetSegments, [
    { from: MIDNIGHT, to: MIDNIGHT + 8 * HOUR, heatC: 21, coolC: null, future: false, kind: 'schedule' },
    { from: MIDNIGHT + 8 * HOUR, to: NOW, heatC: 18, coolC: null, future: false, kind: 'manual' },
    { from: NOW, to: at23, heatC: 21, coolC: null, future: true, kind: 'schedule' },
    { from: at23, to: MIDNIGHT + 24 * HOUR, heatC: 19, coolC: null, future: true, kind: 'schedule' },
  ]);
  assert.deepEqual(calls[0], ['house', '2026-10-21', 'r_liv']);
  assert.deepEqual(day.demandSpans, [
    { from: MIDNIGHT + HOUR, to: MIDNIGHT + 2 * HOUR, mode: 'heat' },
    { from: NOW - 30 * MIN, to: null, mode: 'heat' },
  ]);
  assert.equal(day.stats.heatedMin, 90);
  assert.equal(day.stats.cooledMin, 0);
});

test('room day: without a recorded target the plan covers the past too; unknown room and bad date', async () => {
  const readModels = { resolvedDay: () => ({ segments: [{ start: 0, end: 1440, profileId: 'home', heatC: 21, coolC: 25, layer: 'house_schedule', exception: false }] }) };
  const { ha, config, history } = setup({ readModels });
  livingRoom(config);
  ha.historyFn = () => ({});
  const day = await history.roomDay('r_liv', '2026-10-21');
  assert.deepEqual(day.targetSegments.map((s) => [s.from, s.to, s.future]), [[MIDNIGHT, NOW, false], [NOW, MIDNIGHT + 24 * HOUR, true]]);
  await assert.rejects(history.roomDay('nope', '2026-10-21'), (e) => e.code === 'not_found');
  await assert.rejects(history.roomDay('r_liv', '21.10.2026'), (e) => e.code === 'validation');
});

test('sparks: one statistics call for all rooms; Klimo sensor, else raw sensors; 13 points 30 min apart', async () => {
  const { ha, config, history } = setup();
  livingRoom(config);
  config.addRoom('r_bed', 'Спальня', 'spalnia');
  config.addSensor('r_bed', 'sensor.bed');
  const buckets = (value) => Array.from({ length: 84 }, (_, i) => ({ start: NOW - 7 * HOUR + i * 5 * MIN, mean: value }));
  ha.statisticsFn = () => ({
    'sensor.klimo_vitalnia_temperature': buckets(20.04),
    'sensor.klimo_vitalnia_target': buckets(21),
    'sensor.bed': buckets(18.25),
  });
  const sparks = await history.sparks();
  assert.equal(ha.statisticsCalls.length, 1);
  assert.equal(ha.statisticsCalls[0].period, '5minute');
  const liv = sparks.r_liv;
  assert.equal(liv.values.length, 13);
  assert.equal(liv.stepMin, 30);
  assert.equal(liv.from, NOW - 6 * HOUR);
  assert.ok(liv.values.every((v) => v === 20));
  assert.ok(liv.targets.every((v) => v === 21));
  assert.ok(sparks.r_bed.values.every((v) => v === 18.3));
  assert.equal(sparks.r_bed.targets, null);
  await history.sparks();
  assert.equal(ha.statisticsCalls.length, 1, 'cached 60 s');
});

test('outdoor: hourly statistics and the N-day mean', async () => {
  const { ha, config, history } = setup();
  config.settings.outdoor = { ...config.settings.outdoor, sensorEntityIds: ['sensor.outdoor'], weatherEntityId: 'weather.home' };
  ha.statisticsFn = (ids, start) => ({ 'sensor.outdoor': Array.from({ length: 72 }, (_, i) => ({ start: start + i * HOUR, mean: i < 36 ? 4 : 6, min: 3, max: 7 })) });
  const o = await history.outdoor(3);
  assert.equal(o.days, 3);
  assert.equal(o.series.length, 72);
  assert.equal(o.avgC, 5);
  assert.equal(ha.statisticsCalls[0].period, 'hour');
});

test('outdoor: no statistics → hourly means from the weather entity history', async () => {
  const { ha, config, history } = setup();
  config.settings.outdoor = { ...config.settings.outdoor, sensorEntityIds: [], weatherEntityId: 'weather.home' };
  ha.set(state('weather.home', 'cloudy', { temperature: 41, temperature_unit: '°F' }));
  ha.historyFn = () => ({ 'weather.home': [{ s: 'cloudy', lu: sec(NOW - 30 * HOUR), a: { temperature: 41, temperature_unit: '°F' } }] });
  const o = await history.outdoor(1);
  assert.equal(o.avgC, 5);
  assert.ok(o.series.length >= 24);
});

test('cache: a clock set back (the simulator travelling to another season) never serves the answers of the later time', async () => {
  const { ha, history, clock } = setup();
  const from = Date.UTC(2026, 0, 15, 19, 0);
  const q = { ids: ['sensor.gas_meter'], from, to: from + 3 * HOUR, period: 'hour', types: ['sum'] };
  let world = 'october';
  ha.statisticsFn = () => ({ 'sensor.gas_meter': [{ start: from + 2 * HOUR, sum: world === 'october' ? 320.55 : 1059.63 }] });
  assert.equal((await history.statistics(q))[0].points[0].sum, 320.55);
  // a scenario in January replaces the recorder: the same question must reach it again
  clock.t = Date.UTC(2026, 0, 15, 5, 20);
  world = 'january';
  assert.equal((await history.statistics(q))[0].points[0].sum, 1059.63);
  assert.equal(ha.statisticsCalls.length, 2);
  await history.statistics(q);
  assert.equal(ha.statisticsCalls.length, 2, 'cached again from then on');
});
