const assert = require('node:assert/strict');
const test = require('node:test');
const { aggregateRoom, trendOf } = require('../dist/engine/core/aggregate');
const { evaluateHumidity } = require('../dist/engine/core/humidity');
const h = require('./room-core-harness');

const NOW = h.WED_1910;
const learnedNone = () => h.d.defaultRoomMemory('r_living', NOW).learned;

function agg(values, opts = {}) {
  const room = h.makeRoom(opts.room);
  const sensors = values.map((_, i) => h.sensor(`s${i + 1}`, `sensor.t${i + 1}`, 'temperature', { order: i, weight: opts.weights?.[i] ?? 1 }));
  const entities = opts.entities ?? h.temps(NOW, values);
  const inputs = h.makeInputs(NOW, entities);
  return aggregateRoom(room, sensors, opts.trvs ?? [], inputs, opts.ema ?? {}, opts.learned ?? learnedNone());
}

test('six methods over 19.7 / 19.8 / 20.9 with weights 1 / 1 / 0.5', () => {
  const r = agg([19.7, 19.8, 20.9], { weights: [1, 1, 0.5] }).result;
  const v = r.values;
  assert.equal(Math.round(v.median * 10) / 10, 19.8);
  assert.equal(Math.round(v.average * 10) / 10, 20.1);
  assert.equal(Math.round(v.weighted * 10) / 10, 20.0);
  assert.equal(v.min, 19.7);
  assert.equal(v.max, 20.9);
  assert.equal(v.primary, 19.7);
  assert.equal(r.valueC, 19.8);
  assert.equal(r.fallback, 'none');
  assert.equal(r.activeCount, 3);
});

test('s3 deviates +1.1° from the others: flagged, kept', () => {
  const out = agg([19.7, 19.8, 20.9]);
  const s3 = out.readings.find((r) => r.sensorId === 's3');
  assert.equal(s3.status, 'ok');
  assert.equal(s3.deviationC, 1.1);
});

test('20.0 / 20.1 / 23.0: 23.0 is an outlier, median of the rest 20.05 → 20.1', () => {
  const out = agg([20.0, 20.1, 23.0]);
  assert.deepEqual(out.readings.map((r) => r.status), ['ok', 'ok', 'outlier']);
  assert.equal(out.result.valueC, 20.1);
  assert.deepEqual(out.result.usedSensorIds, ['s1', 's2']);
});

test('20.0 / 20.4 / 24.0: only one outlier (cap ⌊(3−1)/2⌋), value 20.2', () => {
  const out = agg([20.0, 20.4, 24.0]);
  assert.deepEqual(out.readings.map((r) => r.status), ['ok', 'ok', 'outlier']);
  assert.equal(out.result.valueC, 20.2);
});

test('20.0 / 20.1 / 23.0 / 23.2: at most one outlier (23.2), a majority remains', () => {
  const out = agg([20.0, 20.1, 23.0, 23.2]);
  assert.deepEqual(out.readings.map((r) => r.status), ['ok', 'ok', 'ok', 'outlier']);
  assert.equal(out.result.valueC, 20.1);
});

test('outlier rejection needs three live sensors and can be switched off', () => {
  const two = agg([20.0, 23.0]);
  assert.deepEqual(two.readings.map((r) => r.status), ['ok', 'ok']);
  const off = agg([20.0, 20.1, 23.0], { room: { temperature: { ...h.makeRoom().temperature, outlier: { enabled: false, thresholdC: 1.5 } } } });
  assert.ok(off.readings.every((r) => r.status === 'ok'));
});

test('stale, unavailable and excluded sensors drop out; primary falls to the next one', () => {
  const entities = {
    'sensor.t1': h.snap('sensor.t1', 19.0, { at: NOW - 91 * h.MIN }),
    'sensor.t2': h.snap('sensor.t2', 'unavailable'),
    'sensor.t3': h.snap('sensor.t3', 20.4, { at: NOW }),
  };
  const out = agg([0, 0, 0], { entities, room: { temperature: { ...h.makeRoom().temperature, method: 'primary' } } });
  assert.deepEqual(out.readings.map((r) => r.status), ['stale', 'unavailable', 'ok']);
  assert.equal(out.result.valueC, 20.4);
  assert.equal(out.result.activeCount, 1);
  assert.equal(out.result.totalCount, 3);
});

test('all sensors stale: TRV fallback with a learned offset (22.6 − 2.8 → 19.8)', () => {
  const entities = { 'sensor.t1': h.snap('sensor.t1', 21, { at: NOW - 3 * 60 * h.MIN }), 'climate.trv1': h.trvSnap('climate.trv1', NOW, 22.6) };
  const learned = { ...learnedNone(), trvOffsetC: { d_trv1: { value: 2.8, minutes: 40 } } };
  const cfg = h.makeCfg();
  const trvs = cfg.devicesByEmitter.e_rad.slice(0, 1).map((device) => ({ device, snap: entities[device.entityId] }));
  const out = agg([21], { entities, trvs, learned });
  assert.equal(out.result.fallback, 'trv');
  assert.equal(out.result.valueC, 19.8);
  assert.deepEqual(out.result.trvValues, [{ deviceId: 'd_trv1', rawC: 22.6, correctedC: 19.8 }]);
});

test('an offset learned for only 10 minutes is not trusted: no data', () => {
  const entities = { 'sensor.t1': h.snap('sensor.t1', 21, { at: NOW - 3 * 60 * h.MIN }), 'climate.trv1': h.trvSnap('climate.trv1', NOW, 22.6) };
  const learned = { ...learnedNone(), trvOffsetC: { d_trv1: { value: 2.8, minutes: 10 } } };
  const cfg = h.makeCfg();
  const trvs = cfg.devicesByEmitter.e_rad.slice(0, 1).map((device) => ({ device, snap: entities[device.entityId] }));
  const out = agg([21], { entities, trvs, learned });
  assert.equal(out.result.fallback, 'no_data');
  assert.equal(out.result.valueC, null);
});

test('EMA smooths a step: τ 5 min → 63 % after 5 minutes; a long gap restarts it', () => {
  const ema = { s1: { value: 20, at: NOW - 5 * h.MIN } };
  const smooth = { temperature: { ...h.makeRoom().temperature, smoothingMin: 5 } };
  const out = agg([21], { ema, room: smooth });
  assert.ok(Math.abs(out.ema.s1.value - (20 + (1 - Math.exp(-1)))) < 1e-9);
  assert.equal(out.result.valueC, 20.6);
  const stale = agg([21], { ema: { s1: { value: 20, at: NOW - 16 * h.MIN } }, room: smooth });
  assert.equal(stale.ema.s1.value, 21);
  const noSmoothing = agg([21], { ema, room: { temperature: { ...h.makeRoom().temperature, smoothingMin: 0 } } });
  assert.equal(noSmoothing.result.valueC, 21);
});

test('floor probe: the warmest available probe', () => {
  const room = h.makeRoom();
  const sensors = [h.sensor('s1', 'sensor.t1'), h.sensor('f1', 'sensor.f1', 'floor_probe'), h.sensor('f2', 'sensor.f2', 'floor_probe')];
  const inputs = h.makeInputs(NOW, { ...h.temps(NOW, [21]), 'sensor.f1': h.snap('sensor.f1', 26.4, { at: NOW }), 'sensor.f2': h.snap('sensor.f2', 27.1, { at: NOW }) });
  assert.equal(aggregateRoom(room, sensors, [], inputs, {}, learnedNone()).result.floorC, 27.1);
});

test('trend: least squares over 30 min, needs 5 points over 15 min', () => {
  const pts = [0, 5, 10, 15, 20, 25, 30].map((m) => [NOW - (30 - m) * h.MIN, 19 + m / 60]);
  assert.equal(trendOf(pts, NOW), 1);
  assert.equal(trendOf(pts.slice(-3), NOW), null);
});

test('humidity: 19.8 °C / 46 % → dew point 7.8°, 7.9 g/m³; glass estimate and warnings', () => {
  const room = h.makeRoom();
  const readings = [{ role: 'humidity', status: 'ok', humidityPct: 46 }];
  const inputs = h.makeInputs(NOW, {}, { outdoor: { nowC: 0, avg10C: 0, avgNC: 2, source: 'sensor' } });
  const out = evaluateHumidity(room, inputs, { readings, tempC: 19.8, season: 'heating', ventilating: false, dehumidifier: { on: false, since: NOW }, glassK: 0.7 });
  assert.equal(out.state.valuePct, 46);
  assert.equal(out.state.dewPointC, 7.8);
  assert.equal(out.state.absGm3, 7.9);
  assert.equal(out.state.glassC, 5.9); // 19.8 − 0.7·19.8
  assert.equal(out.state.glassMarginC, -1.9);
  assert.equal(out.state.condensationRisk, true);
  assert.equal(out.state.warn, false);
  const humid = evaluateHumidity(room, inputs, { readings: [{ role: 'humidity', status: 'ok', humidityPct: 67 }], tempC: 21.7, season: 'heating', ventilating: false, dehumidifier: { on: false, since: NOW }, glassK: 0.7 });
  assert.equal(humid.state.dewPointC, 15.3);
  assert.equal(humid.state.warn, true);
  assert.equal(humid.detections.find((x) => x.dedupKey === 'humidity_high:r_living').active, true);
});

test('dehumidifier: ON after 2 min above 62 %, OFF below 57 % only after 10 min ON, off while airing', () => {
  const room = h.makeRoom({ humidity: { ...h.makeRoom().humidity, dehumidifier: { entityId: 'switch.dehum', onAbovePct: 62, offBelowPct: 57, minOnMin: 10 } } });
  const run = (rh, at, latch, ventilating = false) =>
    evaluateHumidity(room, h.makeInputs(at), { readings: [{ role: 'humidity', status: 'ok', humidityPct: rh }], tempC: 21, season: 'heating', ventilating, dehumidifier: latch, glassK: 0.7 }).dehumidifier;
  let l = run(60, NOW, { on: false, since: NOW - h.MIN });
  assert.equal(l.on, false);
  l = run(64, NOW + h.MIN, l);
  assert.equal(l.on, false);
  l = run(64, NOW + 3 * h.MIN, l);
  assert.equal(l.on, true);
  const tooSoon = run(55, NOW + 8 * h.MIN, l);
  assert.equal(tooSoon.on, true);
  assert.equal(run(55, NOW + 14 * h.MIN, l).on, false);
  assert.equal(run(70, NOW + 4 * h.MIN, l, true).on, false);
});
