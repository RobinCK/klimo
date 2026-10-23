// The room day, its numbers, the trend seed and the sparklines against a recorder that answers the way
// Home Assistant's does: history/history_during_period (the state at the start first with lu = start,
// later rows only where the state changed for a minimal response, every row with its attributes for the
// climate domain, states as strings, float seconds, `lc` only when it differs, entities the recorder
// excludes simply missing) and recorder/statistics_during_period (5-min means of completed periods,
// start in ms, converted to the asked unit). Expected values come from the written states directly.
const assert = require('node:assert/strict');
const test = require('node:test');
const { MIN, FakeClock, Bus, TestHaService, state, settle } = require('./ha-harness');
const { FakeConfig } = require('./ha-harness');
const { HistoryService } = require('../dist/ha/history.service');

const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 9, 23, 16, 0); // 19:00 in Kyiv
const MIDNIGHT = Date.UTC(2026, 9, 22, 21, 0); // 2026-10-23 00:00 in Kyiv
const DATE = '2026-10-23';
const at = (h, m = 0, s = 0) => MIDNIGHT + h * HOUR + m * MIN + s * 1000;
const NEED_ATTRIBUTES = new Set(['climate', 'humidifier', 'input_datetime', 'thermostat', 'water_heater']);
const FIVE = 5 * MIN;

const PLAN = {
  scheduleId: 'house',
  roomId: null,
  date: DATE,
  segments: [
    { start: 0, end: 420, profileId: 'night', heatC: 19, coolC: null, layer: 'house_schedule', exception: false },
    { start: 420, end: 1380, profileId: 'home', heatC: 21, coolC: null, layer: 'house_schedule', exception: false },
    { start: 1380, end: 1440, profileId: 'night', heatC: 19, coolC: null, layer: 'house_schedule', exception: false },
  ],
};

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const fToC = (f) => Math.round(((f - 32) * 5 / 9) * 100) / 100;
const cToF = (c) => Math.round((c * 9 / 5 + 32) * 100) / 100;
const round1 = (x) => Math.round(x * 10) / 10;
const num = (s) => (s === 'unavailable' || s === 'unknown' || s === '' ? null : Number.isFinite(Number(s)) ? Number(s) : null);

/** Home Assistant's recorder in miniature: every state write kept, answered like HA 2024+ does. */
class Recorder {
  constructor() {
    this.rows = new Map();
    this.units = new Map();
  }
  /** One state write (the integration reported); `us` = the microseconds HA keeps. */
  write(entityId, t, value, attrs = {}, us = 0) {
    const list = this.rows.get(entityId) ?? [];
    const prev = list[list.length - 1];
    const s = String(value);
    const ts = t / 1000 + us / 1e6;
    list.push({ ts, s, a: attrs, lc: prev && prev.s === s ? prev.lc : ts });
    this.rows.set(entityId, list);
  }
  last(entityId) {
    return this.rows.get(entityId)?.at(-1) ?? null;
  }
  history(msg) {
    const start = Date.parse(msg.start_time) / 1000;
    const end = msg.end_time ? Date.parse(msg.end_time) / 1000 : Infinity;
    const minimal = msg.minimal_response ?? false;
    const noAttributes = msg.no_attributes ?? false;
    const significantOnly = msg.significant_changes_only ?? true;
    const includeStart = msg.include_start_time_state ?? true;
    const out = {};
    for (const id of msg.entity_ids) {
      const rows = this.rows.get(id);
      if (!rows) continue;
      const domain = id.split('.')[0];
      const picked = [];
      const before = rows.filter((r) => r.ts < start).at(-1);
      if (includeStart && before) picked.push({ ...before, start: true });
      for (const r of rows) {
        if (r.ts <= start || r.ts >= end) continue;
        if (significantOnly && !NEED_ATTRIBUTES.has(domain) && r.lc !== r.ts) continue;
        picked.push(r);
      }
      if (!picked.length) continue;
      const full = (r) => {
        const o = { s: r.s };
        if (!noAttributes) o.a = r.a;
        o.lu = r.start ? start : r.ts;
        if (!r.start && r.lc !== r.ts) o.lc = r.lc;
        return o;
      };
      if (!minimal || NEED_ATTRIBUTES.has(domain)) {
        out[id] = picked.map(full);
        continue;
      }
      const res = [full(picked[0])];
      let prev = picked[0].s;
      for (const r of picked.slice(1)) {
        if (r.s === prev) continue;
        prev = r.s;
        res.push({ s: r.s, lu: r.ts });
      }
      out[id] = res;
    }
    return out;
  }
  /** Time-weighted mean of the numeric states over [a, b) in seconds; null when none was known. */
  mean(entityId, a, b) {
    const rows = this.rows.get(entityId) ?? [];
    let sum = 0;
    let w = 0;
    for (let i = 0; i < rows.length; i++) {
      const v = num(rows[i].s);
      const x = Math.max(a, rows[i].ts);
      const y = Math.min(b, i + 1 < rows.length ? rows[i + 1].ts : Infinity);
      if (v === null || y <= x) continue;
      sum += v * (y - x);
      w += y - x;
    }
    return w ? sum / w : null;
  }
  /** 5-min statistics of measurement sensors: completed periods only (compiled 10 s after the period). */
  statistics(msg, now) {
    const start = Date.parse(msg.start_time);
    const end = msg.end_time ? Date.parse(msg.end_time) : now;
    const out = {};
    for (const id of msg.statistic_ids) {
      if (!this.rows.has(id) || id.startsWith('climate.')) continue;
      const unit = this.units.get(id) ?? null;
      const rows = [];
      for (let p = Math.ceil(start / FIVE) * FIVE; p < end && p + FIVE + 10_000 <= now; p += FIVE) {
        let m = this.mean(id, p / 1000, (p + FIVE) / 1000);
        if (m === null) continue;
        if (unit === '°F' && msg.units?.temperature === '°C') m = fToC(m);
        rows.push({ start: p, end: p + FIVE, mean: m });
      }
      if (rows.length) out[id] = rows;
    }
    return out;
  }
}

/** Value of an entity at t straight from the writes (°C), the expected side of every comparison. */
function written(rec, entityId, t) {
  const rows = rec.rows.get(entityId) ?? [];
  let v = null;
  for (const r of rows) {
    if (Math.round(r.ts * 1000) > t) break;
    v = num(r.s);
  }
  if (v === null) return null;
  return rec.units.get(entityId) === '°F' ? fToC(v) : v;
}

function expectedAt(rec, ids, method, t) {
  const vs = ids.map((id) => written(rec, id, t)).filter((v) => v !== null);
  if (!vs.length) return null;
  if (method === 'median') {
    const s = [...vs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  return vs.reduce((a, b) => a + b, 0) / vs.length;
}

/** The chart grid (every 5 min, then «now») and the extremes at every written change. */
function expectedDay(rec, ids, method) {
  const series = [];
  for (let t = MIDNIGHT; t < NOW; t += FIVE) series.push([t, roundOrNull(expectedAt(rec, ids, method, t))]);
  series.push([NOW, roundOrNull(expectedAt(rec, ids, method, NOW))]);
  const times = new Set([MIDNIGHT]);
  for (const id of ids) for (const r of rec.rows.get(id) ?? []) {
    const t = Math.round(r.ts * 1000);
    if (t > MIDNIGHT && t <= NOW) times.add(t);
  }
  let min = null;
  let max = null;
  for (const t of [...times].sort((a, b) => a - b)) {
    const v = expectedAt(rec, ids, method, t);
    if (v === null) continue;
    const c = round1(v);
    if (!min || c < min.c) min = { c, at: t };
    if (!max || c > max.c) max = { c, at: t };
  }
  return { series, min, max };
}

const roundOrNull = (v) => (v === null ? null : round1(v));

function expectedSparks(rec, ids, method, now) {
  const last = Math.floor(now / FIVE) * FIVE;
  const from = last - 12 * 30 * MIN;
  const out = [];
  for (let i = 0; i < 13; i++) {
    const t = from + i * 30 * MIN;
    const vs = [];
    for (const id of ids) {
      let best = null;
      for (let p = t - 3 * FIVE; p < t; p += FIVE) {
        if (p + FIVE + 10_000 > now) continue;
        let m = rec.mean(id, p / 1000, (p + FIVE) / 1000);
        if (m !== null && rec.units.get(id) === '°F') m = fToC(m);
        if (m !== null) best = m;
      }
      if (best !== null) vs.push(best);
    }
    if (!vs.length) out.push(null);
    else if (method === 'median') {
      const s = [...vs].sort((a, b) => a - b);
      const m = s.length >> 1;
      out.push(round1(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2));
    } else out.push(round1(vs.reduce((a, b) => a + b, 0) / vs.length));
  }
  return out;
}

/** A room sensor reporting every 20–90 s (as a Zigbee sensor does), from before midnight until just before now. */
function wavySensor(rec, entityId, { seed, base, amp = 1.2, from = MIDNIGHT - 20 * MIN, to = NOW - 20_000, unit = '°C', gaps = [], decimals = 2 } = {}) {
  const r = rng(seed);
  rec.units.set(entityId, unit);
  const attrs = { unit_of_measurement: unit, device_class: 'temperature', state_class: 'measurement', friendly_name: entityId };
  let t = from;
  let unavailable = false;
  while (t < to) {
    const gap = gaps.find(([a, b]) => t >= a && t < b);
    if (gap) {
      if (!unavailable) rec.write(entityId, gap[0], 'unavailable', { friendly_name: entityId, unit_of_measurement: unit, device_class: 'temperature' });
      unavailable = true;
      t = gap[1];
      continue;
    }
    unavailable = false;
    const c = base + amp * Math.sin(((t - MIDNIGHT) / (24 * HOUR)) * 2 * Math.PI * 2) + (r() - 0.5) * 0.3;
    const v = unit === '°F' ? cToF(c) : c;
    rec.write(entityId, t, v.toFixed(decimals), attrs, Math.floor(r() * 1000));
    t += 20_000 + Math.floor(r() * 70_000);
  }
}

/** What Klimo publishes for a room while it runs (HA records its MQTT sensors; unit by HA's unit system). */
function klimoSensors(rec, slug, { tempFrom = null, haUnit = '°C', from = MIDNIGHT - 2 * HOUR, downFrom = null, downTo = null, temps = null } = {}) {
  const tId = `sensor.klimo_${slug}_temperature`;
  const gId = `sensor.klimo_${slug}_target`;
  const dId = `binary_sensor.klimo_${slug}_heat_demand`;
  rec.units.set(tId, haUnit);
  rec.units.set(gId, haUnit);
  const conv = (c) => (haUnit === '°F' ? cToF(c) : c);
  const tAttrs = { unit_of_measurement: haUnit, device_class: 'temperature', state_class: 'measurement' };
  const running = (t) => downFrom === null || t < downFrom || t >= downTo;
  let wasDown = false;
  // a pass every minute, a little after the evaluation
  for (let t = from; t < NOW; t += MIN) {
    const w = t + 250;
    if (!running(t)) {
      if (!wasDown) for (const id of [tId, gId, dId]) rec.write(id, w, 'unavailable', id === gId ? { unit_of_measurement: haUnit } : {});
      wasDown = true;
      continue;
    }
    wasDown = false;
    const target = t < at(7) ? 19 : 21;
    rec.write(gId, w, conv(target).toFixed(1), { ...tAttrs, lo: null, hi: null, mode: 'heat', source: 'schedule', until: null });
    const c = temps ? temps(t) : tempFrom ? written(rec, tempFrom, t) : null;
    if (c !== null) rec.write(tId, w, conv(round1(c)).toFixed(1), tAttrs);
    const heating = (t >= at(6, 30) && t < at(7, 20)) || (t >= at(17) && t < at(17, 45));
    rec.write(dId, w, heating ? 'on' : 'off', { device_class: 'heat' });
  }
}

function registryEntry(entityId, uniqueId) {
  return { entity_id: entityId, device_id: 'mqtt_klimo', area_id: null, platform: 'mqtt', unique_id: uniqueId, disabled_by: null, hidden_by: null, original_name: null, name: null, entity_category: null };
}

/**
 * HistoryService on the real HaService, against the recorder above. `rooms`: [{ id, slug, method,
 * sensors: [entityId…], klimo: true|false }].
 */
async function open(rec, rooms, { haUnit = '°C', excluded = [] } = {}) {
  const clock = new FakeClock(NOW, 'UTC');
  const bus = new Bus();
  const ha = new TestHaService(clock, bus);
  ha.start('ws://ha.test/api/websocket', 'secret');
  const states = [];
  for (const [id, rows] of rec.rows) {
    const last = rows.at(-1);
    states.push(state(id, last.s, last.a?.unit_of_measurement || !rec.units.get(id) ? last.a : { ...last.a, unit_of_measurement: rec.units.get(id) }, Math.round(last.ts * 1000)));
  }
  ha.server.states = states;
  ha.server.answer['get_config'] = { time_zone: 'Europe/Kyiv', unit_system: { temperature: haUnit }, language: 'uk', version: '2026.10.0', latitude: 50.45, longitude: 30.52 };
  const regs = [];
  for (const r of rooms) {
    if (r.klimo === false) continue;
    for (const kind of ['temperature', 'target', 'humidity']) regs.push(registryEntry(`sensor.klimo_${r.slug}_${kind}`, `klimo_${r.id}_${kind}`));
    regs.push(registryEntry(`binary_sensor.klimo_${r.slug}_heat_demand`, `klimo_${r.id}_heat_demand`));
    regs.push(registryEntry(`binary_sensor.klimo_${r.slug}_cool_demand`, `klimo_${r.id}_cool_demand`));
  }
  ha.server.answer['config/entity_registry/list'] = regs;
  const hidden = new Set(excluded);
  const visible = (answer) => Object.fromEntries(Object.entries(answer).filter(([id]) => !hidden.has(id)));
  ha.server.answer['history/history_during_period'] = (msg) => visible(rec.history(msg));
  ha.server.answer['recorder/statistics_during_period'] = (msg) => visible(rec.statistics(msg, clock.now()));
  await settle();
  assert.equal(ha.connected, true);
  const config = new FakeConfig();
  config.schedules = [{ id: 'house', scope: 'house', roomId: null, enabled: true, days: [] }];
  for (const r of rooms) {
    const room = config.addRoom(r.id, r.name ?? r.id, r.slug);
    room.temperature = { ...room.temperature, method: r.method ?? 'median' };
    r.sensors.forEach((id, i) => config.addSensor(r.id, id, 'temperature', { order: i }));
  }
  const moduleRef = { get: (token) => {
    if (token === 'READ_MODELS') return { resolvedDay: () => PLAN };
    throw new Error('not provided');
  } };
  const history = new HistoryService(ha, config, { range: async () => [] }, clock, bus, moduleRef);
  history.onModuleInit();
  return { ha, history, config, clock, bus };
}

function sameSeries(actual, expected, what) {
  assert.equal(actual.length, expected.length, `${what}: ${actual.length} points, expected ${expected.length}`);
  for (let i = 0; i < expected.length; i++) {
    assert.equal(actual[i][0], expected[i][0], `${what}: time of point ${i}`);
    assert.equal(actual[i][1], expected[i][1], `${what}: value at ${new Date(expected[i][0]).toISOString()}`);
  }
}

function pastBandCovers(day, from, to) {
  const past = day.targetSegments.filter((s) => !s.future).sort((a, b) => a.from - b.from);
  assert.equal(past[0].from, from, 'the past band starts at midnight');
  assert.equal(past.at(-1).to, to, 'and reaches now');
  for (let i = 1; i < past.length; i++) assert.equal(past[i].from, past[i - 1].to, 'without holes');
  return past;
}

const heatAt = (day, t) => day.targetSegments.find((s) => s.from <= t && s.to > t && !s.future)?.heatC;

async function trendMatches(history, config, rec, room, ids, method) {
  const got = await history.recentRoomTemps(config.engineConfig().rooms.filter((r) => r.id === room), NOW - HOUR, NOW);
  const expected = [];
  for (let t = NOW - HOUR; t <= NOW; t += MIN) {
    const v = expectedAt(rec, ids, method, t);
    if (v !== null) expected.push([t, v]);
  }
  assert.equal(got[room].length, expected.length, 'trend: one value a minute');
  for (let i = 0; i < expected.length; i++) {
    assert.equal(got[room][i][0], expected[i][0]);
    assert.ok(Math.abs(got[room][i][1] - expected[i][1]) < 1e-9, `trend at ${new Date(expected[i][0]).toISOString()}: ${got[room][i][1]} vs ${expected[i][1]}`);
  }
}

test('one sensor with frequent changes: the grid, min/max at their real moments, trend, sparklines, band', async () => {
  const rec = new Recorder();
  wavySensor(rec, 'sensor.office_t', { seed: 1, base: 20.4 });
  klimoSensors(rec, 'office', { tempFrom: 'sensor.office_t' });
  const { ha, history, config } = await open(rec, [{ id: 'r_office', slug: 'office', sensors: ['sensor.office_t'] }]);
  const started = Date.now();
  const day = await history.roomDay('r_office', DATE);
  assert.ok(Date.now() - started < 2000, 'a day of 30-s readings reads quickly');
  const exp = expectedDay(rec, ['sensor.office_t'], 'median');
  assert.equal(day.source, 'raw_sensors');
  assert.equal(day.complete, true);
  sameSeries(day.series, exp.series, 'series');
  assert.deepEqual(day.stats.min, exp.min);
  assert.deepEqual(day.stats.max, exp.max);
  assert.equal(day.stats.heatedMin, 50 + 45, 'from the recorded demand sensor');
  assert.ok(!day.diag.entities.some((e) => e.role === 'klimo_temperature'), 'Klimo’s copy is not needed');
  const past = pastBandCovers(day, MIDNIGHT, NOW);
  assert.equal(heatAt(day, at(3)), 19);
  assert.equal(heatAt(day, at(12)), 21);
  assert.ok(past.every((s) => s.kind === 'schedule'));
  assert.equal(day.diag.targetSource, 'klimo_target');
  await trendMatches(history, config, rec, 'r_office', ['sensor.office_t'], 'median');
  const sparks = await history.sparks();
  assert.deepEqual(sparks.r_office.values, expectedSparks(rec, ['sensor.office_t'], 'median', NOW));
  assert.equal(sparks.r_office.complete, true);
  ha.stop();
});

test('two sensors by median: the middle of the two at every change of either', async () => {
  const rec = new Recorder();
  wavySensor(rec, 'sensor.liv_a', { seed: 2, base: 20.1 });
  wavySensor(rec, 'sensor.liv_b', { seed: 3, base: 21.0, amp: 0.8, decimals: 1 });
  klimoSensors(rec, 'living', { temps: () => 25 });
  const ids = ['sensor.liv_a', 'sensor.liv_b'];
  const { ha, history, config } = await open(rec, [{ id: 'r_liv', slug: 'living', sensors: ids, method: 'median' }]);
  const day = await history.roomDay('r_liv', DATE);
  const exp = expectedDay(rec, ids, 'median');
  assert.equal(day.source, 'raw_sensors');
  sameSeries(day.series, exp.series, 'series');
  assert.deepEqual(day.stats.min, exp.min);
  assert.deepEqual(day.stats.max, exp.max);
  assert.ok(day.series.every(([, v]) => v !== 25), 'never Klimo’s (here deliberately wrong) published copy');
  await trendMatches(history, config, rec, 'r_liv', ids, 'median');
  const sparks = await history.sparks();
  assert.deepEqual(sparks.r_liv.values, expectedSparks(rec, ids, 'median', NOW));
  ha.stop();
});

test('a sensor unavailable for an hour: a gap in the line, extremes and sparklines without it; a second sensor carries on alone', async () => {
  const rec = new Recorder();
  const gap = [at(15, 30), at(16, 30)];
  wavySensor(rec, 'sensor.bed_t', { seed: 4, base: 19.5, gaps: [gap] });
  wavySensor(rec, 'sensor.kid_a', { seed: 5, base: 20.0, gaps: [gap] });
  wavySensor(rec, 'sensor.kid_b', { seed: 6, base: 20.6 });
  klimoSensors(rec, 'bedroom', { tempFrom: 'sensor.bed_t' });
  klimoSensors(rec, 'kids', { tempFrom: 'sensor.kid_b' });
  const { ha, history } = await open(rec, [
    { id: 'r_bed', slug: 'bedroom', sensors: ['sensor.bed_t'] },
    { id: 'r_kids', slug: 'kids', sensors: ['sensor.kid_a', 'sensor.kid_b'], method: 'median' },
  ]);
  const bed = await history.roomDay('r_bed', DATE);
  const exp = expectedDay(rec, ['sensor.bed_t'], 'median');
  sameSeries(bed.series, exp.series, 'bedroom');
  const inGap = bed.series.filter(([t]) => t >= gap[0] && t < gap[1]);
  assert.equal(inGap.length, 12);
  assert.ok(inGap.every(([, v]) => v === null), 'the hour is a gap, not a held value');
  assert.ok(bed.series.some(([t, v]) => t >= gap[1] && v !== null), 'and the line comes back');
  assert.deepEqual(bed.stats.min, exp.min);
  assert.deepEqual(bed.stats.max, exp.max);

  const kids = await history.roomDay('r_kids', DATE);
  const expKids = expectedDay(rec, ['sensor.kid_a', 'sensor.kid_b'], 'median');
  sameSeries(kids.series, expKids.series, 'kids');
  assert.ok(kids.series.filter(([t]) => t >= gap[0] && t < gap[1]).every(([, v]) => v !== null), 'the other sensor alone');

  const sparks = await history.sparks();
  const expBed = expectedSparks(rec, ['sensor.bed_t'], 'median', NOW);
  assert.deepEqual(sparks.r_bed.values, expBed);
  assert.ok(expBed.includes(null), 'the gap reaches the sparkline (16:00 and 16:30)');
  assert.deepEqual(sparks.r_kids.values, expectedSparks(rec, ['sensor.kid_a', 'sensor.kid_b'], 'median', NOW));
  ha.stop();
});

test('a sensor reporting in °F: everything in °C (day, extremes, trend, sparklines)', async () => {
  const rec = new Recorder();
  wavySensor(rec, 'sensor.study_f', { seed: 7, base: 20.8, unit: '°F', decimals: 1 });
  klimoSensors(rec, 'study', { tempFrom: 'sensor.study_f' });
  const { ha, history, config } = await open(rec, [{ id: 'r_study', slug: 'study', sensors: ['sensor.study_f'] }]);
  const day = await history.roomDay('r_study', DATE);
  const exp = expectedDay(rec, ['sensor.study_f'], 'median');
  sameSeries(day.series, exp.series, 'series');
  assert.ok(day.series.every(([, v]) => v === null || (v > 15 && v < 26)), 'degrees Celsius');
  assert.deepEqual(day.stats.min, exp.min);
  assert.deepEqual(day.stats.max, exp.max);
  await trendMatches(history, config, rec, 'r_study', ['sensor.study_f'], 'median');
  const sparks = await history.sparks();
  assert.deepEqual(sparks.r_study.values, expectedSparks(rec, ['sensor.study_f'], 'median', NOW));
  ha.stop();
});

test('Home Assistant in °F: Klimo’s own sensors are recorded in °F — its temperature stand-in and the past band read back in °C', async () => {
  const rec = new Recorder();
  // the room sensor is kept out of the recorder: the day comes from Klimo's sensor
  wavySensor(rec, 'sensor.attic_t', { seed: 8, base: 20.2, unit: '°F', decimals: 1 });
  klimoSensors(rec, 'attic', { tempFrom: 'sensor.attic_t', haUnit: '°F' });
  const { ha, history, config } = await open(rec, [{ id: 'r_attic', slug: 'attic', sensors: ['sensor.attic_t'] }], { haUnit: '°F', excluded: ['sensor.attic_t'] });
  const day = await history.roomDay('r_attic', DATE);
  assert.equal(day.source, 'klimo_entity');
  const values = day.series.filter(([, v]) => v !== null).map(([, v]) => v);
  assert.ok(values.length > 200);
  assert.ok(values.every((v) => v > 15 && v < 26), `°C, not °F: ${values.slice(0, 5)}`);
  assert.ok(day.stats.min.c > 15 && day.stats.max.c < 26, JSON.stringify(day.stats));
  assert.equal(heatAt(day, at(3)), 19, 'the recorded target in °C');
  assert.equal(heatAt(day, at(12)), 21);
  assert.equal(day.diag.targetSource, 'klimo_target');
  const trend = await history.recentRoomTemps(config.engineConfig().rooms, NOW - HOUR, NOW);
  assert.ok(trend.r_attic.every(([, v]) => v > 15 && v < 26), 'the trend seed in °C');
  const sparks = await history.sparks();
  assert.ok(sparks.r_attic.values.every((v) => v === null || (v > 15 && v < 26)), 'sparklines in °C (HA converts statistics)');
  assert.ok(sparks.r_attic.targets.every((v) => v === 19 || v === 21));
  ha.stop();
});

test('a room created today: the line starts with its new sensor, the extremes after it, the band from its own records', async () => {
  const rec = new Recorder();
  const created = at(13, 2);
  wavySensor(rec, 'sensor.new_t', { seed: 9, base: 20.0, from: created });
  klimoSensors(rec, 'guest', { tempFrom: 'sensor.new_t', from: at(13) });
  const { ha, history } = await open(rec, [{ id: 'r_guest', slug: 'guest', sensors: ['sensor.new_t'] }]);
  const day = await history.roomDay('r_guest', DATE);
  const exp = expectedDay(rec, ['sensor.new_t'], 'median');
  sameSeries(day.series, exp.series, 'series');
  assert.ok(day.series.filter(([t]) => t < created).every(([, v]) => v === null), 'nothing before the sensor existed');
  assert.ok(day.stats.min.at >= created && day.stats.max.at >= created);
  pastBandCovers(day, MIDNIGHT, NOW);
  assert.equal(heatAt(day, at(14)), 21, 'recorded since 13:00');
  assert.equal(day.complete, true);
  ha.stop();
});

test('Klimo’s own sensors present, absent or kept out of the recorder', async (t) => {
  await t.test('present, the room sensor recorded: the room sensor; Klimo’s copy not even asked for', async () => {
    const rec = new Recorder();
    wavySensor(rec, 'sensor.a_t', { seed: 10, base: 20.3 });
    klimoSensors(rec, 'a', { temps: () => 22.2 });
    const { ha, history } = await open(rec, [{ id: 'r_a', slug: 'a', sensors: ['sensor.a_t'] }]);
    const day = await history.roomDay('r_a', DATE);
    assert.equal(day.source, 'raw_sensors');
    sameSeries(day.series, expectedDay(rec, ['sensor.a_t'], 'median').series, 'series');
    const asked = ha.server.sent('history/history_during_period').flatMap((m) => m.entity_ids);
    assert.ok(!asked.includes('sensor.klimo_a_temperature'));
    ha.stop();
  });
  await t.test('room sensor kept out of the recorder: Klimo’s copy', async () => {
    const rec = new Recorder();
    wavySensor(rec, 'sensor.b_t', { seed: 11, base: 20.3 });
    klimoSensors(rec, 'b', { tempFrom: 'sensor.b_t', downFrom: at(0, 40), downTo: at(18, 58) });
    const { ha, history } = await open(rec, [{ id: 'r_b', slug: 'b', sensors: ['sensor.b_t'] }], { excluded: ['sensor.b_t'] });
    const day = await history.roomDay('r_b', DATE);
    assert.equal(day.source, 'klimo_entity');
    const expected = (t) => roundOrNull(written(rec, 'sensor.klimo_b_temperature', t));
    for (const [t, v] of day.series) assert.equal(v, expected(t), `at ${new Date(t).toISOString()}`);
    assert.ok(day.series.filter(([t]) => t >= at(0, 45) && t < at(18, 55)).every(([, v]) => v === null), 'Klimo was stopped');
    assert.notEqual(day.series.at(-1)[1], null, 'and is back');
    // Klimo was down most of the day: the band of that time is the plan
    pastBandCovers(day, MIDNIGHT, NOW);
    assert.equal(day.diag.targetSource, 'mixed');
    ha.stop();
  });
  await t.test('no Klimo entities at all (MQTT off): the room sensor, the band from the plan', async () => {
    const rec = new Recorder();
    wavySensor(rec, 'sensor.c_t', { seed: 12, base: 20.3 });
    const { ha, history } = await open(rec, [{ id: 'r_c', slug: 'c', sensors: ['sensor.c_t'], klimo: false }]);
    const day = await history.roomDay('r_c', DATE);
    assert.equal(day.source, 'raw_sensors');
    sameSeries(day.series, expectedDay(rec, ['sensor.c_t'], 'median').series, 'series');
    pastBandCovers(day, MIDNIGHT, NOW);
    assert.equal(day.diag.targetSource, 'plan');
    assert.equal(heatAt(day, at(3)), 19);
    assert.equal(heatAt(day, at(12)), 21);
    ha.stop();
  });
  await t.test('everything kept out of the recorder: no line, no extremes, the plan — and a complete answer', async () => {
    const rec = new Recorder();
    wavySensor(rec, 'sensor.d_t', { seed: 13, base: 20.3 });
    klimoSensors(rec, 'd', { tempFrom: 'sensor.d_t' });
    const all = [...rec.rows.keys()];
    const { ha, history } = await open(rec, [{ id: 'r_d', slug: 'd', sensors: ['sensor.d_t'] }], { excluded: all });
    const day = await history.roomDay('r_d', DATE);
    assert.equal(day.source, 'none');
    assert.ok(day.series.every(([, v]) => v === null));
    assert.equal(day.stats.min, null);
    assert.equal(day.complete, true);
    assert.equal(day.diag.targetSource, 'plan');
    pastBandCovers(day, MIDNIGHT, NOW);
    ha.stop();
  });
});
