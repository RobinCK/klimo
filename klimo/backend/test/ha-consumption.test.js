const assert = require('node:assert/strict');
const test = require('node:test');
const { FakeClock, FakeHa, state } = require('./ha-harness');
const { ConsumptionService } = require('../dist/ha/consumption.service');
const { defaultSettings, newSourceConfig } = require('../dist/shared/defaults');
const { addDays, fromLocal, toLocal } = require('../dist/engine/core/time');

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const MIDNIGHT = Date.UTC(2026, 9, 20, 21, 0); // 2026-10-21 00:00 in Kyiv
const NOW = MIDNIGHT + 14.5 * HOUR; // 14:30
const FT3 = 0.028316846592;
const near = (a, b, eps = 1e-3) => assert.ok(a !== null && Math.abs(a - b) < eps, `${a} ≉ ${b}`);

/** A gas meter in ft³ read every 10 min: 10 ft³/h, 30 more during the boiler run 06:00–07:00, replaced (back to 0) at 05:20. */
function gasMeter() {
  const growth = (t) => {
    const h = (t - (MIDNIGHT - DAY)) / HOUR;
    const run = Math.min(Math.max(0, (t - (MIDNIGHT + 6 * HOUR)) / HOUR), 1);
    return 10 * h + 30 * run;
  };
  const replacedAt = MIDNIGHT + 5 * HOUR + 20 * MIN;
  const readings = [];
  for (let t = MIDNIGHT - DAY - 2 * HOUR; t < NOW; t += 10 * MIN) {
    const g = growth(t);
    readings.push({ t, g, state: t < replacedAt ? 1000 + g : g - growth(replacedAt) });
  }
  /** What HA's sum holds at an hour boundary: the last reading before it. */
  const before = (t) => readings.filter((r) => r.t < t).at(-1)?.g ?? null;
  const hour = (h) => before(h + HOUR) - before(h);
  return { readings, before, hour };
}

function setup({ meterUnit = 'ft³', failRecorder = false, extraSpans = [], installedAt = MIDNIGHT - 90 * DAY } = {}) {
  const clock = new FakeClock(NOW);
  const ha = new FakeHa();
  const meter = gasMeter();
  ha.set(state('sensor.gas', meter.readings.at(-1).state, { unit_of_measurement: meterUnit, state_class: 'total_increasing', device_class: 'gas', friendly_name: 'Газ' }));
  ha.set(state('sensor.out', 5, { unit_of_measurement: '°C', state_class: 'measurement' }));
  ha.statisticsFn = (ids, start, end, period, types) => {
    if (failRecorder) throw new Error('recorder timeout');
    const out = {};
    for (const id of ids) {
      const rows = [];
      // like HA: hours once complete
      for (let h = Math.floor(start / HOUR) * HOUR; h < end && h + HOUR <= NOW; h += HOUR) {
        if (id === 'sensor.gas' && types.includes('change') && meter.before(h) !== null) rows.push({ start: h, change: meter.hour(h) });
        if (id === 'sensor.out') rows.push({ start: h, mean: h < MIDNIGHT ? 10 : 5 });
      }
      if (rows.length) out[id] = rows;
    }
    return out;
  };
  ha.historyFn = (ids, start, end) => {
    const rows = meter.readings.filter((r) => r.t >= start && r.t <= end);
    const first = meter.readings.filter((r) => r.t < start).at(-1);
    const list = [...(first ? [{ ...first, t: start }] : []), ...rows].map((r) => ({ s: String(r.state), lu: r.t / 1000 }));
    return ids.includes('sensor.gas') ? { 'sensor.gas': list } : {};
  };

  const settings = defaultSettings('uk');
  settings.outdoor = { ...settings.outdoor, sensorEntityIds: ['sensor.out'] };
  settings.tariffs = { ...settings.tariffs, currency: '₴', gasPrice: 8, gasPriceUnit: 'm³' };
  const boiler = { ...newSourceConfig('gas_boiler', { id: 's_boiler', name: 'Котел', now: 0 }), meters: [{ kind: 'gas', entityId: 'sensor.gas', unit: 'ft³' }] };
  const config = {
    sources: [boiler],
    settings,
    get: (c, id) => (c === 'sources' ? config.sources.find((s) => s.id === id) : undefined),
    room: (idOrSlug) => (config.rooms ?? []).find((r) => r.id === idOrSlug || r.slug === idOrSlug),
    list: (c) => (c === 'sources' ? config.sources : []),
    singleton: (k) => config[k],
    revision: () => 1,
  };
  const spanList = [
    { id: 'a', subject: 'source', subjectId: 's_boiler', kind: 'run', mode: 'heat', startTs: MIDNIGHT + 6 * HOUR, endTs: MIDNIGHT + 7 * HOUR, meta: null },
    { id: 'b', subject: 'source', subjectId: 's_boiler', kind: 'run', mode: 'heat', startTs: MIDNIGHT + 14 * HOUR, endTs: null, meta: null },
    // the house profile has been active since the install
    { id: 'pr', subject: 'profile', subjectId: 'pr_home', kind: 'active', mode: null, startTs: installedAt, endTs: null, meta: { profileId: 'pr_home' } },
    ...extraSpans,
  ];
  const spans = {
    range: async (from, to, subject, id) => spanList.filter((s) => s.startTs < to && (s.endTs ?? NOW) > from && (!id || s.subjectId === id)),
    earliestStart: async () => Math.min(...spanList.map((s) => s.startTs)),
  };
  return { service: new ConsumptionService(ha, config, spans, clock), ha, config, meter };
}

test('a day of a gas boiler: hours from statistics, the running hour from the history, runs from readings, in m³', async () => {
  const { service, meter } = setup();
  const d = await service.source('s_boiler', { range: 'day' });
  assert.equal(d.date, '2026-10-21');
  assert.equal(d.bucket, 'hour');
  assert.equal(d.buckets.length, 24);
  assert.deepEqual(d.units, { gas: 'm³', electricity: null, heat: null, currency: '₴' });
  assert.deepEqual(d.meters, [{ kind: 'gas', entityId: 'sensor.gas', name: 'Газ', unit: 'ft³', reading: 'meter', status: 'ok', statistics: true }]);
  assert.equal(d.recorder, 'ok');

  // the meter was replaced at 05:20: HA's change already continues, no negative or huge hour
  near(d.buckets[5].gas, 10 * FT3);
  // an hour holds the readings up to its end: the run's last 10 minutes count in the next one
  near(d.buckets[6].gas, 35 * FT3);
  near(d.buckets[7].gas, 15 * FT3);
  assert.ok(d.buckets.every((b) => b.gas === null || (b.gas >= 0 && b.gas < 2)));
  near(d.buckets[6].cost, 35 * FT3 * 8, 0.01);
  // 14:00–14:30 is not compiled yet: read from the states (14:00, 14:10, 14:20)
  const running = d.buckets[14];
  assert.equal(running.partial, true);
  near(running.gas, (meter.before(NOW) - meter.before(MIDNIGHT + 14 * HOUR)) * FT3);
  assert.equal(d.buckets[15].future, true);
  assert.equal(d.buckets[15].gas, null);
  near(d.totals.gas, (meter.before(NOW) - meter.before(MIDNIGHT)) * FT3);
  assert.equal(d.totals.runs, 2);
  assert.equal(d.totals.runtimeMin, 90);
  near(d.buckets[6].hdd, 13 / 24, 0.01);
  // degree-days of the compiled hours: 00:00–14:00
  near(d.totals.hdd, (13 * 14) / 24, 0.01);
  near(d.totals.gasPerHdd, d.totals.gas / d.totals.hdd, 0.002);

  // yesterday up to 14:30 is the comparison, with readings from its start
  assert.equal(d.previous.date, '2026-10-20');
  assert.equal(d.previous.to, NOW - DAY);
  assert.equal(d.previous.complete, true);
  near(d.previous.totals.gas, 10 * 14.5 * FT3, 0.01);

  assert.equal(d.runs.length, 2);
  near(d.runs[0].gas, 40 * FT3);
  assert.equal(d.runs[0].estimated, false);
  assert.equal(d.runs[0].minutes, 60);
  assert.equal(d.runs[1].end, null);
  near(d.runs[1].gas, (20 / 60) * 10 * FT3);
});

test('a month by days and a year by months come from the same statistics; runs only for day and week', async () => {
  const { service } = setup();
  const month = await service.source('s_boiler', { range: 'month', date: '2026-10-15' });
  assert.equal(month.date, '2026-10-01');
  assert.equal(month.bucket, 'day');
  assert.equal(month.buckets.length, 31);
  assert.equal(month.runs, null);
  near(month.buckets[19].gas, 10 * 24 * FT3, 0.01);
  near(month.buckets[18].gas, 10 * FT3, 0.01, 'the meter came in at 22:00');
  assert.equal(month.buckets[17].gas, null, 'no statistics before the meter existed');
  assert.equal(month.previous.complete, false);
  const week = await service.source('s_boiler', { range: 'week' });
  assert.equal(week.date, '2026-10-19');
  assert.equal(week.runs.length, 2);
});

test('a run across midnight is measured whole in both days, the days themselves stop at midnight', async () => {
  // 23:30–00:30 at the base rate of 10 ft³/h: yesterday read only its first half and showed 5 ft³ for 60 min
  const night = { id: 'n', subject: 'source', subjectId: 's_boiler', kind: 'run', mode: 'heat', startTs: MIDNIGHT - 30 * MIN, endTs: MIDNIGHT + 30 * MIN, meta: null };
  const { service, meter } = setup({ extraSpans: [night] });
  const yesterday = await service.source('s_boiler', { range: 'day', date: '2026-10-20' });
  const today = await service.source('s_boiler', { range: 'day' });
  for (const d of [yesterday, today]) {
    const run = d.runs.find((r) => r.start === night.startTs);
    assert.ok(run, `${d.date} lists the night run`);
    assert.equal(run.minutes, 60);
    near(run.gas, 10 * FT3);
  }
  near(yesterday.totals.gas, (meter.before(MIDNIGHT) - meter.before(MIDNIGHT - DAY)) * FT3);
  near(yesterday.buckets[23].gas, meter.hour(MIDNIGHT - HOUR) * FT3);
  assert.equal(yesterday.totals.runs, 1);
});

test('a recorder that does not answer leaves the amounts unknown, the runtime still counts', async () => {
  const { service } = setup({ failRecorder: true });
  const d = await service.source('s_boiler', { range: 'day' });
  assert.equal(d.recorder, 'unavailable');
  assert.equal(d.totals.gas, null);
  assert.equal(d.totals.cost, null);
  assert.equal(d.totals.runtimeMin, 90);
});

test('a meter in a unit that does not fit is reported, never read', async () => {
  const { service, ha } = setup();
  ha.set(state('sensor.gas', '21.5', { unit_of_measurement: '°C', friendly_name: 'Газ' }));
  const d = await service.source('s_boiler', { range: 'day' });
  assert.equal(d.meters[0].status, 'unsupported_unit');
  assert.equal(d.meters[0].statistics, false);
  assert.equal(d.totals.gas, null);
  assert.equal(d.units.gas, null);
});

test('the house today: a shared meter counts once, gas in kWh as soon as one meter counts energy', async () => {
  const { service, ha, config } = setup();
  ha.set(state('sensor.gas_kwh', '5000', { unit_of_measurement: 'kWh', state_class: 'total_increasing', device_class: 'gas' }));
  const second = { ...newSourceConfig('gas_boiler', { id: 's_boiler2', name: 'Котел 2', now: 0 }), meters: [{ kind: 'gas', entityId: 'sensor.gas', unit: 'ft³' }] };
  config.sources.push(second);
  let h = await service.house();
  assert.equal(h.configured, true);
  assert.equal(h.units.gas, 'm³');
  const gasToday = (10 * 14.5 + 30) * FT3;
  near(h.gas, gasToday, 0.01);
  assert.equal(h.sources.length, 2);
  near(h.sources[1].gas, gasToday, 0.01);
  near(h.cost, gasToday * 8, 0.05);
  near(h.unassigned.gas, gasToday, 0.01, 'the shared meter is shared out once, not per boiler');

  config.sources.push({ ...newSourceConfig('gas_boiler', { id: 's_boiler3', name: 'Котел 3', now: 1 }), meters: [{ kind: 'gas', entityId: 'sensor.gas_kwh', unit: 'kWh' }] });
  h = await service.house({ date: '2026-10-20' });
  assert.equal(h.units.gas, 'kWh');
  near(h.gas, 10 * 24 * FT3 * 10.5, 0.1);
  near(h.sources[0].gas, 10 * 24 * FT3 * 10.5, 0.1);
});

test('a pump with the energy meter of its plug: its own row, the house electricity, a month by the day', async () => {
  const { service, ha, config } = setup({ extraSpans: [{ id: 'p', subject: 'pump', subjectId: 'p_floor', kind: 'run', mode: 'heat', startTs: MIDNIGHT + 2 * HOUR, endTs: MIDNIGHT + 4 * HOUR, meta: null }] });
  ha.set(state('sensor.floor_plug_energy', '12.3', { unit_of_measurement: 'kWh', state_class: 'total_increasing', device_class: 'energy', friendly_name: 'Розетка підлоги' }));
  const gasStats = ha.statisticsFn;
  ha.statisticsFn = (ids, start, end, period, types) => {
    const out = gasStats(ids, start, end, period, types);
    if (ids.includes('sensor.floor_plug_energy')) {
      const rows = [];
      for (let h = Math.floor(start / HOUR) * HOUR; h < end && h + HOUR <= NOW; h += HOUR) if (h >= MIDNIGHT - DAY) rows.push({ start: h, change: 0.05 });
      out['sensor.floor_plug_energy'] = rows;
    }
    return out;
  };
  config.settings.tariffs = { ...config.settings.tariffs, electricityPerKwh: 4 };
  config.pumps = [{ id: 'p_floor', name: 'Насос підлоги', meter: { kind: 'electricity', entityId: 'sensor.floor_plug_energy', unit: 'kWh' } }, { id: 'p_rad', name: 'Насос радіаторів', meter: null }];
  config.list = (c) => (c === 'sources' ? config.sources : c === 'pumps' ? config.pumps : []);

  const h = await service.house();
  assert.equal(h.range, 'day');
  assert.equal(h.bucket, 'hour');
  assert.equal(h.buckets.length, 24);
  assert.deepEqual(h.pumps.map((p) => p.pumpId), ['p_floor'], 'only pumps with a meter');
  const pump = h.pumps[0];
  near(pump.electricity, 14 * 0.05);
  near(pump.cost, 14 * 0.05 * 4, 0.01);
  assert.equal(pump.runtimeMin, 120);
  assert.equal(pump.meters[0].entityId, 'sensor.floor_plug_energy');
  assert.equal(h.sources[0].electricity, null, 'the boiler has no electricity meter of its own');
  near(h.electricity, 14 * 0.05);
  near(h.cost, (10 * 14.5 + 30) * FT3 * 8 + 14 * 0.05 * 4, 0.05);
  assert.equal(h.buckets[3].electricity, 0.05);
  assert.equal(h.buckets[20].future, true);

  const m = await service.house({ range: 'month' });
  assert.equal(m.bucket, 'day');
  assert.equal(m.date, '2026-10-01');
  assert.equal(m.previousDate, '2026-09-01');
  assert.equal(m.previousComplete, false, 'the meters reach back to 20 October only');
  assert.equal(m.buckets.length, 31);
  near(m.pumps[0].electricity, (24 + 14) * 0.05);
  await assert.rejects(() => service.house({ range: 'decade' }), (e) => e.status === 400);
});

test('the gas shared between rooms: each hour by how long each room asked while the boiler ran; the rest unassigned', async () => {
  const demand = (id, roomId, from, to) => ({ id, subject: 'room', subjectId: roomId, kind: 'demand', mode: 'heat', startTs: from, endTs: to, meta: null });
  const { service, config, meter } = setup({
    extraSpans: [
      demand('d1', 'r_a', MIDNIGHT + 6 * HOUR, MIDNIGHT + 7 * HOUR),
      demand('d2', 'r_b', MIDNIGHT + 6.5 * HOUR, MIDNIGHT + 7 * HOUR),
      demand('d3', 'r_b', MIDNIGHT + 14 * HOUR, null),
      // asked while the boiler was off: no share of the gas, still counted as asking
      demand('d4', 'r_c', MIDNIGHT + 9 * HOUR, MIDNIGHT + 10 * HOUR),
    ],
  });
  config.rooms = [{ id: 'r_a' }, { id: 'r_b' }, { id: 'r_c' }];
  config.circuits = [{ id: 'c_rad', sourceIds: ['s_boiler'] }];
  config.emitters = ['r_a', 'r_b', 'r_c'].map((roomId) => ({ id: `e_${roomId}`, roomId, enabled: true, sourceId: null, circuitId: 'c_rad' }));
  config.list = (c) => ({ sources: config.sources, rooms: config.rooms, circuits: config.circuits, emitters: config.emitters })[c] ?? [];

  const h = await service.house();
  const room = (id) => h.rooms.find((r) => r.roomId === id);
  // 06–07 the boiler ran: r_a asked all hour, r_b the second half → 2/3 and 1/3 of that hour's gas
  const six = meter.hour(MIDNIGHT + 6 * HOUR) * FT3;
  near(room('r_a').gas, (six * 2) / 3, 0.002);
  // since 14:00 it runs again and only r_b asks: the running hour is all r_b's
  near(room('r_b').gas, six / 3 + h.buckets[14].gas, 0.002);
  assert.equal(room('r_c').gas, 0, 'asked only while the boiler was off');
  assert.deepEqual(h.rooms.map((r) => [r.roomId, r.demandMin]), [['r_a', 60], ['r_b', 60], ['r_c', 60]]);
  near(room('r_a').gas + room('r_b').gas + h.unassigned.gas, h.gas, 0.002);
  assert.ok(h.unassigned.gas > room('r_a').gas, 'the hours nobody asked (the stove, the run tail) stay unassigned');
  near(room('r_a').cost, ((six * 2) / 3) * 8, 0.02);
});

test('a floor that runs with the boiler takes its share while its pump runs (with no pump, while the boiler runs)', async () => {
  const { service, config, meter } = setup({
    extraSpans: [{ id: 'p', subject: 'pump', subjectId: 'p_floor', kind: 'run', mode: 'heat', startTs: MIDNIGHT + 6 * HOUR, endTs: MIDNIGHT + 7 * HOUR + 10 * MIN, meta: null }],
  });
  config.rooms = [{ id: 'r_f' }, { id: 'r_g' }];
  config.circuits = [
    { id: 'c_floor', mode: 'follow_source', manifoldId: null, sourceIds: ['s_boiler'] },
    { id: 'c_bare', mode: 'follow_source', manifoldId: null, sourceIds: ['s_boiler'] },
  ];
  config.emitters = [
    { id: 'e_f', roomId: 'r_f', enabled: true, sourceId: null, circuitId: 'c_floor' },
    { id: 'e_g', roomId: 'r_g', enabled: true, sourceId: null, circuitId: 'c_bare' },
  ];
  config.pumps = [{ id: 'p_floor', circuitId: 'c_floor', manifoldId: null, enabled: true }];
  config.list = (c) => ({ sources: config.sources, rooms: config.rooms, circuits: config.circuits, emitters: config.emitters, pumps: config.pumps })[c] ?? [];

  const h = await service.house();
  const room = (id) => h.rooms.find((r) => r.roomId === id);
  const six = meter.hour(MIDNIGHT + 6 * HOUR) * FT3;
  // 06–07 both floors took the boiler's heat; since 14:00 only the one without a pump (its pump did not run)
  near(room('r_f').gas, six / 2, 0.002);
  near(room('r_g').gas, six / 2 + h.buckets[14].gas, 0.002);
  assert.equal(room('r_f').demandMin, 70);
  assert.equal(room('r_g').demandMin, 90);
});

const demandSpan = (id, roomId, from, to) => ({ id, subject: 'room', subjectId: roomId, kind: 'demand', mode: 'heat', startTs: from, endTs: to, meta: null });
const runSpan = (id, sourceId, from, to) => ({ id, subject: 'source', subjectId: sourceId, kind: 'run', mode: 'heat', startTs: from, endTs: to, meta: null });
const shareOf = (d) => ({ roomId: d.roomId, gas: d.gas, electricity: d.electricity, cost: d.cost, demandMin: d.demandMin });

/** Three rooms on the boiler's radiators: today as in the house's split above, and yesterday 08:00–09:00 and 15:00–16:00. */
function roomsSetup(opts = {}) {
  const y = MIDNIGHT - DAY;
  const fixture = setup({
    ...opts,
    extraSpans: [
      demandSpan('d1', 'r_a', MIDNIGHT + 6 * HOUR, MIDNIGHT + 7 * HOUR),
      demandSpan('d2', 'r_b', MIDNIGHT + 6.5 * HOUR, MIDNIGHT + 7 * HOUR),
      demandSpan('d3', 'r_b', MIDNIGHT + 14 * HOUR, null),
      runSpan('y1', 's_boiler', y + 8 * HOUR, y + 9 * HOUR),
      demandSpan('y2', 'r_a', y + 8 * HOUR, y + 9 * HOUR),
      demandSpan('y3', 'r_b', y + 8 * HOUR, y + 8.5 * HOUR),
      // after this time of day: the whole of yesterday has it, «so far» does not
      runSpan('y4', 's_boiler', y + 15 * HOUR, y + 16 * HOUR),
      demandSpan('y5', 'r_b', y + 15 * HOUR, y + 16 * HOUR),
    ],
  });
  const { config } = fixture;
  config.rooms = [
    { id: 'r_a', slug: 'vitalnia' },
    { id: 'r_b', slug: 'spalnia' },
    { id: 'r_c', slug: 'kukhnia' },
  ];
  config.circuits = [{ id: 'c_rad', sourceIds: ['s_boiler'] }];
  config.emitters = ['r_a', 'r_b', 'r_c'].map((roomId) => ({ id: `e_${roomId}`, roomId, enabled: true, sourceId: null, circuitId: 'c_rad' }));
  config.list = (c) => ({ sources: config.sources, rooms: config.rooms, circuits: config.circuits, emitters: config.emitters })[c] ?? [];
  return { ...fixture, y };
}

test('one room in detail: the same share as in the house list, hour by hour, meter by meter, from one reading', async () => {
  const { service, ha, meter } = roomsSetup();
  const h = await service.house();
  const reads = ha.statisticsCalls.length;
  const histories = ha.historyCalls.length;
  for (const r of h.rooms) {
    assert.deepEqual(shareOf(await service.room(r.roomId)), r);
  }
  // the house's reading is shared out once: the rooms only ask for the outdoor means, once
  assert.equal(ha.statisticsCalls.length, reads + 1);
  assert.equal(ha.historyCalls.length, histories);

  const d = await service.room('spalnia');
  assert.equal(d.roomId, 'r_b');
  assert.equal(d.date, '2026-10-21');
  assert.equal(d.bucket, 'hour');
  assert.equal(d.buckets.length, 24);
  assert.deepEqual(d.units, h.units);
  assert.equal(d.configured, true);
  assert.equal(d.recorder, 'ok');
  // 06–07: the second half of the hour of the three r_a and r_b asked; since 14:00 it is all r_b's
  const six = meter.hour(MIDNIGHT + 6 * HOUR) * FT3;
  near(d.buckets[6].gas, six / 3, 0.002);
  assert.equal(d.buckets[6].demandMin, 30);
  near(d.buckets[14].gas, h.buckets[14].gas, 0.002);
  assert.equal(d.buckets[14].partial, true);
  assert.equal(d.buckets[14].demandMin, 30);
  assert.equal(d.buckets[3].gas, 0, 'the meter counted, the room took none of it');
  assert.equal(d.buckets[15].future, true);
  assert.equal(d.buckets[15].gas, null);
  assert.equal(d.buckets[15].outdoorAvgC, null);
  near(d.buckets.reduce((s, b) => s + (b.gas ?? 0), 0), d.gas, 0.003);
  near(d.buckets.reduce((s, b) => s + (b.cost ?? 0), 0), d.cost, 0.05);
  assert.equal(d.buckets.reduce((s, b) => s + b.demandMin, 0), d.demandMin);
  // the outdoor means of the compiled hours
  assert.equal(d.buckets[3].outdoorAvgC, 5);
  assert.equal(d.buckets[14].outdoorAvgC, null);
  assert.equal(d.outdoorAvgC, 5);

  assert.equal(d.meters.length, 1);
  const [gas] = d.meters;
  assert.deepEqual([gas.sourceIds, gas.kind, gas.entityId, gas.own], [['s_boiler'], 'gas', 'sensor.gas', false]);
  assert.equal(gas.amount, d.gas);
  assert.equal(gas.cost, d.cost);
  near(gas.meterTotal, h.gas, 0.002);
  assert.equal(gas.minutes, 60, '06:30–07:00 and 14:00–14:30 while the boiler ran');
  assert.deepEqual(d.unmetered, []);
  near(d.sourcesTotal.gas, h.gas, 0.002);
  near(d.sourcesTotal.gas, h.rooms.reduce((s, r) => s + r.gas, 0) + h.unassigned.gas, 0.003);
  near(d.sourcesTotal.cost, h.cost, 0.02);
});

test('a room against the period before: yesterday up to this time, shared out the same way', async () => {
  const { service, meter, y } = roomsSetup();
  const eight = meter.hour(y + 8 * HOUR) * FT3;
  const b = await service.room('r_b');
  assert.equal(b.previousDate, '2026-10-20');
  assert.equal(b.previousComplete, true);
  // 08:00–09:00 r_a asked all hour, r_b half of it; 15:00–16:00 is past 14:30
  near(b.previous.gas, eight / 3, 0.002);
  near(b.previous.cost, (eight / 3) * 8, 0.02);
  assert.equal(b.previous.demandMin, 30);
  const a = await service.room('r_a');
  near(a.previous.gas, (eight * 2) / 3, 0.002);
  assert.equal(a.previous.demandMin, 60);
  assert.equal((await service.room('r_c')).previous.gas, 0);

  // the whole of yesterday has 15:00 too, and its own outdoor means
  const whole = await service.room('r_b', { date: '2026-10-20' });
  near(whole.gas, eight / 3 + meter.hour(y + 15 * HOUR) * FT3, 0.002);
  assert.equal(whole.demandMin, 90);
  assert.equal(whole.outdoorAvgC, 10);
  assert.equal(whole.previous.gas, 0, 'the meter came in at 22:00 the day before, nobody asked');
  assert.equal(whole.previousComplete, false);

  // every range adds up the house's numbers
  for (const range of ['day', 'week', 'month', 'year']) {
    const h = await service.house({ range });
    for (const r of h.rooms) {
      const d = await service.room(r.roomId, { range });
      assert.deepEqual(shareOf(d), r, `${range} ${r.roomId}`);
      assert.equal(d.buckets.length, h.buckets.length);
    }
  }

  const month = await service.room('r_b', { range: 'month' });
  assert.equal(month.bucket, 'day');
  assert.equal(month.previousDate, '2026-09-01');
  near(month.buckets[20].gas, b.gas, 0.002, 'today in the month is today');
  near(month.buckets[19].gas, whole.gas, 0.002);
  assert.equal(month.buckets[19].demandMin, 90);
  assert.equal(month.buckets[17].gas, null, 'no readings yet');
});

test('a room against a period before the install: the meters reach back, who asked and what ran then is not known', async () => {
  const { service, y } = roomsSetup({ installedAt: MIDNIGHT - DAY + 7 * HOUR });
  const b = await service.room('r_b');
  assert.equal(b.previousComplete, false, 'Klimo has been recording since 07:00 yesterday');
  assert.equal((await service.house()).previousComplete, true, 'the house compares its meters alone');

  // installed within the first hour of yesterday: as complete as the meters
  const early = roomsSetup({ installedAt: y + 30 * MIN });
  assert.equal((await early.service.room('r_b')).previousComplete, true);
});

test('a year against the one before: Klimo keeps its spans 400 days, so the year before is not complete however far the meters reach', async () => {
  const { service, ha } = roomsSetup({ installedAt: Date.UTC(2024, 0, 1) });
  const tz = 'Europe/Kyiv';
  // the gas meter has statistics since 2024: a row per local day once it is over, hours up to the last compiled one
  ha.statisticsFn = (ids, start, end, period) => {
    const rows = [];
    if (period === 'day') {
      for (let d = toLocal(start, tz).date; fromLocal(addDays(d, 1), 0, tz) <= Math.min(end, NOW); d = addDays(d, 1)) rows.push({ start: fromLocal(d, 0, tz), change: 1 });
    } else {
      for (let h = Math.floor(start / HOUR) * HOUR; h < end && h + HOUR <= NOW; h += HOUR) rows.push({ start: h, change: 0.04 });
    }
    return ids.includes('sensor.gas') ? { 'sensor.gas': rows } : {};
  };

  const year = await service.room('r_b', { range: 'year' });
  assert.equal(year.previousDate, '2025-01-01');
  assert.equal((await service.house({ range: 'year' })).previousComplete, true, 'the meters reach back to 2025');
  assert.equal(year.previousComplete, false, 'the spans of early 2025 are cleaned up');
  // a day more than 400 days ago: the same
  assert.equal((await service.house({ date: '2025-08-01' })).previousComplete, true);
  assert.equal((await service.room('r_b', { date: '2025-08-01' })).previousComplete, false);
  // the month before is well within them
  assert.equal((await service.room('r_b', { range: 'month' })).previousComplete, true);
});

test('two dates of the same period share one reading of the house', async () => {
  const { service, ha } = roomsSetup();
  const h = await service.house({ range: 'month', date: '2026-10-15' });
  const reads = ha.statisticsCalls.length;
  const histories = ha.historyCalls.length;
  assert.deepEqual(await service.house({ range: 'month', date: '2026-10-03' }), h);
  assert.equal(ha.statisticsCalls.length, reads);
  const d = await service.room('r_b', { range: 'month', date: '2026-10-02' });
  assert.deepEqual(await service.room('r_b', { range: 'month', date: '2026-10-31' }), d);
  assert.deepEqual(shareOf(d), h.rooms.find((r) => r.roomId === 'r_b'));
  // the rooms only ask for the outdoor means, once for the month
  assert.equal(ha.statisticsCalls.length, reads + 1);
  assert.equal(ha.historyCalls.length, histories);
});

test('a meter only the own AC of a room has is all that room has, standby included', async () => {
  const { service, ha, config } = setup({
    extraSpans: [
      { ...runSpan('ac', 's_ac', MIDNIGHT + 10 * HOUR, MIDNIGHT + 11 * HOUR), mode: 'cool' },
      demandSpan('d1', 'r_a', MIDNIGHT + 10 * HOUR, MIDNIGHT + 10.5 * HOUR),
      demandSpan('d2', 'r_a', MIDNIGHT + 6 * HOUR, MIDNIGHT + 7 * HOUR),
    ],
  });
  ha.set(state('sensor.ac_energy', '321.5', { unit_of_measurement: 'kWh', state_class: 'total_increasing', device_class: 'energy' }));
  const gasStats = ha.statisticsFn;
  ha.statisticsFn = (ids, start, end, period, types) => {
    const out = gasStats(ids, start, end, period, types);
    if (ids.includes('sensor.ac_energy')) {
      const rows = [];
      for (let h = Math.floor(start / HOUR) * HOUR; h < end && h + HOUR <= NOW; h += HOUR) if (h >= MIDNIGHT - DAY) rows.push({ start: h, change: h === MIDNIGHT + 10 * HOUR ? 0.8 : 0.01 });
      out['sensor.ac_energy'] = rows;
    }
    return out;
  };
  config.settings.tariffs = { ...config.settings.tariffs, electricityPerKwh: 4 };
  config.sources.push(
    { ...newSourceConfig('ac', { id: 's_ac', name: 'Кондиціонер', now: 1, scope: 'room', roomId: 'r_a' }), meters: [{ kind: 'electricity', entityId: 'sensor.ac_energy', unit: 'kWh' }] },
    { ...newSourceConfig('electric_radiator', { id: 's_conv', name: 'Конвектор', now: 2, scope: 'room', roomId: 'r_a' }), enabled: true, meters: [] },
    { ...newSourceConfig('electric_radiator', { id: 's_old', name: 'Старий конвектор', now: 3, scope: 'room', roomId: 'r_a' }), enabled: false, meters: [] },
  );
  config.rooms = [{ id: 'r_a' }, { id: 'r_b' }];
  config.circuits = [{ id: 'c_rad', sourceIds: ['s_boiler'] }];
  config.emitters = [
    ...['r_a', 'r_b'].map((roomId) => ({ id: `e_${roomId}`, roomId, enabled: true, sourceId: null, circuitId: 'c_rad' })),
    { id: 'e_ac', roomId: 'r_a', enabled: true, sourceId: 's_ac', circuitId: null },
  ];
  config.list = (c) => ({ sources: config.sources, rooms: config.rooms, circuits: config.circuits, emitters: config.emitters })[c] ?? [];

  const h = await service.house();
  const a = h.rooms.find((r) => r.roomId === 'r_a');
  // 14 compiled hours: 0.8 kWh while it cooled, 0.01 of standby in each of the other 13
  near(a.electricity, 0.8 + 13 * 0.01);
  assert.equal(h.unassigned.electricity, 0, 'nothing of an own meter is left over');
  assert.equal(h.rooms.find((r) => r.roomId === 'r_b').electricity, null, 'no meter of r_b counts electricity');

  const d = await service.room('r_a');
  assert.deepEqual(shareOf(d), a);
  assert.deepEqual(
    d.meters.map((m) => [m.kind, m.entityId, m.own]),
    [
      ['gas', 'sensor.gas', false],
      ['electricity', 'sensor.ac_energy', true],
    ],
  );
  const ac = d.meters[1];
  assert.deepEqual(ac.sourceIds, ['s_ac']);
  near(ac.amount, 0.8 + 13 * 0.01);
  assert.equal(ac.meterTotal, ac.amount);
  near(ac.cost, ac.amount * 4, 0.01);
  assert.equal(ac.minutes, 30, 'asked 10:00–10:30 while the AC ran');
  assert.equal(d.meters[0].minutes, 60);
  near(d.buckets[3].electricity, 0.01, 1e-6, 'standby while it did not ask');
  near(d.buckets[10].electricity, 0.8);
  assert.deepEqual(d.unmetered, ['s_conv'], 'a convector without a meter: not counted; a disabled one is not listed');
  near(d.sourcesTotal.electricity, ac.meterTotal);

  const b = await service.room('r_b');
  assert.deepEqual(b.meters.map((m) => m.entityId), ['sensor.gas']);
  assert.equal(b.electricity, null);
  assert.deepEqual(b.unmetered, []);
});

test('a room nobody heats has no meter; a recorder that does not answer leaves a share unknown, the minutes still count', async () => {
  const { service, config } = setup({ failRecorder: true, extraSpans: [demandSpan('d1', 'r_a', MIDNIGHT + 6 * HOUR, MIDNIGHT + 7 * HOUR)] });
  config.rooms = [{ id: 'r_a' }, { id: 'r_x' }];
  config.circuits = [{ id: 'c_rad', sourceIds: ['s_boiler'] }];
  config.emitters = [{ id: 'e_a', roomId: 'r_a', enabled: true, sourceId: null, circuitId: 'c_rad' }];
  config.list = (c) => ({ sources: config.sources, rooms: config.rooms, circuits: config.circuits, emitters: config.emitters })[c] ?? [];
  const d = await service.room('r_a');
  assert.equal(d.recorder, 'unavailable');
  assert.equal(d.gas, null);
  assert.equal(d.meters[0].amount, null);
  assert.equal(d.meters[0].meterTotal, null);
  assert.equal(d.demandMin, 60);
  assert.equal(d.meters[0].minutes, 60);
  assert.equal(d.outdoorAvgC, null);
  const x = await service.room('r_x');
  assert.equal(x.configured, false);
  assert.deepEqual(x.meters, []);
  assert.equal(x.gas, null);
});

test('unknown sources and ranges are refused', async () => {
  const { service } = setup();
  await assert.rejects(() => service.source('nope', { range: 'day' }), (e) => e.status === 404);
  await assert.rejects(() => service.source('s_boiler', { range: 'decade' }), (e) => e.status === 400);
  // a date the period arithmetic cannot step past is refused, not a server error
  for (const date of ['9999-12-31', '0001-01-01']) {
    await assert.rejects(() => service.house({ range: 'month', date }), (e) => e.status === 400);
    await assert.rejects(() => service.source('s_boiler', { range: 'day', date }), (e) => e.status === 400);
  }
});

test('unknown rooms and ranges are refused; a room is found by its slug too', async () => {
  const { service, config } = setup();
  config.rooms = [{ id: 'r_a', slug: 'vitalnia' }];
  await assert.rejects(() => service.room('nope'), (e) => e.status === 404);
  await assert.rejects(() => service.room('r_a', { range: 'decade' }), (e) => e.status === 400);
  await assert.rejects(() => service.room('r_a', { date: '21.10.2026' }), (e) => e.status === 400);
  const d = await service.room('vitalnia', { range: 'week' });
  assert.equal(d.roomId, 'r_a');
  assert.equal(d.range, 'week');
  assert.equal(d.date, '2026-10-19');
});
