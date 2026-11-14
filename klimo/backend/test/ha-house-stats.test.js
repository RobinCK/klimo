const assert = require('node:assert/strict');
const test = require('node:test');
const { FakeClock, FakeHa, state } = require('./ha-harness');
const { HouseStatsService, fitLine } = require('../dist/ha/house-stats.service');
const { defaultSettings, newSourceConfig } = require('../dist/shared/defaults');
const { addDays, fromLocal, toLocal } = require('../dist/engine/core/time');

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const TZ = 'Europe/Kyiv';
const NOW = Date.UTC(2026, 10, 14, 10, 0); // 2026-11-14 12:00 in Kyiv
const TODAY = '2026-11-14';
const near = (a, b, eps = 0.05) => assert.ok(a !== null && Math.abs(a - b) < eps, `${a} ≉ ${b}`);

/** The house of the tests: 8 kWh a day per kelvin less 20 kWh of gains, at 21 °C inside, the outdoors swinging day by day. */
const outdoorOf = (k) => 2 + 6 * Math.sin(k / 3);
const heatOf = (deltaK) => 8 * deltaK - 20;

function setup({ spans = [], indoor5 = null } = {}) {
  const clock = new FakeClock(NOW, TZ);
  const ha = new FakeHa();
  ha.set(state('sensor.gas', '1000', { unit_of_measurement: 'm³', state_class: 'total_increasing', device_class: 'gas' }));
  const settings = defaultSettings('uk');
  settings.tariffs = { ...settings.tariffs, gasKwhPerM3: 10, boilerEfficiencyPct: 80 };
  const boiler = { ...newSourceConfig('gas_boiler', { id: 's_boiler', name: 'Котел', now: 0 }), enabled: true, meters: [{ kind: 'gas', entityId: 'sensor.gas', unit: 'm³' }] };
  const config = {
    sources: [boiler],
    rooms: [{ id: 'r_a', slug: 'a', name: 'A' }],
    circuits: [{ id: 'c_floor', mode: 'follow_source', sourceIds: ['s_boiler'], order: 0 }],
    pumps: [{ id: 'p_floor', name: 'Насос ТП', circuitId: 'c_floor', manifoldId: null, enabled: true, order: 0 }],
    settings,
    list: (c) => config[c] ?? [],
    singleton: (k) => config[k],
    engineConfig: () => ({ sources: config.sources, rooms: config.rooms, circuits: config.circuits, pumps: config.pumps, settings }),
    revision: () => 1,
  };
  const days = [];
  for (let k = 30; k >= 1; k--) days.push({ date: addDays(TODAY, -k), k });
  ha.statisticsFn = (ids, start, end, period, types) => {
    assert.equal(period, 'day');
    assert.deepEqual(types, ['change']);
    // gas the boiler burnt for that heat at 80 %, 10 kWh per m³; one day without a reading
    const rows = days
      .filter((d) => d.k !== 7)
      .map((d) => ({ start: fromLocal(d.date, 0, TZ), change: Math.max(0, heatOf(21 - outdoorOf(d.k))) / 0.8 / 10 }));
    return { 'sensor.gas': rows };
  };
  const hours = (valueAt) => {
    const out = [];
    for (let t = fromLocal(addDays(TODAY, -31), 0, TZ); t < NOW; t += HOUR) out.push({ start: t, mean: valueAt(t) });
    return out;
  };
  const kOf = (t) => {
    const date = toLocal(t, TZ).date;
    return days.find((d) => d.date === date)?.k ?? 0;
  };
  const history = {
    indoorMeans: async (from, to, period) => {
      if (period === '5minute') return indoor5 ? { r_a: indoor5 } : {};
      return { r_a: hours(() => 21) };
    },
    outdoor: async () => ({ series: hours((t) => outdoorOf(kOf(t))).map((p) => ({ ...p, min: null, max: null, state: null, sum: null })), avgC: null, days: 31 }),
  };
  const store = {
    range: async (from, to, subject, id) => spans.filter((s) => s.startTs < to && (s.endTs ?? NOW) > from && (!subject || s.subject === subject) && (!id || s.subjectId === id)),
  };
  return { service: new HouseStatsService(ha, config, store, clock, history), ha, config };
}

test('the heat characteristic: gas at the boilers’ efficiency against the difference, a line through 30 days', async () => {
  const { service } = setup();
  const h = await service.heatLoss();
  assert.equal(h.from, '2026-10-15');
  assert.equal(h.to, '2026-11-13');
  assert.equal(h.days.length, 30);
  assert.equal(h.configured, true);
  assert.equal(h.recorder, 'ok');
  const missing = h.days.find((d) => d.date === addDays(TODAY, -7));
  assert.equal(missing.heatKwh, null, 'a day without the meter’s row is unknown');
  assert.equal(missing.used, false);
  const day = h.days.find((d) => d.date === addDays(TODAY, -3));
  near(day.deltaK, 21 - outdoorOf(3), 0.06);
  near(day.heatKwh, heatOf(21 - outdoorOf(3)), 0.01);
  near(day.gasKwh, heatOf(21 - outdoorOf(3)) / 0.8, 0.01);
  assert.ok(h.used >= 20);
  assert.equal(h.indoorC, 21);
  const fit = h.fit;
  near(fit.slopeKwhPerK, 8, 0.05);
  near(fit.interceptKwh, -20, 0.6);
  assert.ok(fit.r2 > 0.99);
  assert.equal(fit.wPerK, 330, '8 kWh a day per K is 333 W/K, to tens');
  // no heat below 20 kWh / 8 = 2.5 K of difference: above 18.5 °C outdoors
  near(fit.balanceC, 18.5, 0.1);
  near(fit.loadKw.minus10, (8 * 31 - 20) / 24, 0.05);
  near(fit.loadKw.minus20, (8 * 41 - 20) / 24, 0.05);
});

test('no line from too few days, too little spread, or heat that does not rise with the cold', () => {
  assert.equal(fitLine([[10, 60], [12, 76], [14, 92], [16, 108]], 21), null);
  assert.equal(fitLine([[10, 60], [11, 68], [10.5, 64], [11.5, 72], [12, 76]], 21), null);
  assert.equal(fitLine([[10, 90], [12, 80], [14, 70], [16, 60], [18, 50]], 21), null);
  assert.ok(fitLine([[10, 60], [11, 68], [12, 76], [13, 84], [14, 92]], 21));
});

test('the widgets’ sensor: the last 24 h of runs with the pumps that follow, the hourly outdoor, τ from a night pause', async () => {
  const run = (id, subject, subjectId, from, to) => ({ id, subject, subjectId, kind: 'run', mode: 'heat', startTs: from, endTs: to, meta: null });
  // the night of 13→14 November: the boiler stops at 21:00 and starts again at 07:00 (local)
  const stop = fromLocal('2026-11-13', 21 * 60, TZ);
  const restart = fromLocal('2026-11-14', 7 * 60, TZ);
  const tau = 40;
  const { service } = setup({
    spans: [
      run('r1', 'source', 's_boiler', NOW - 30 * HOUR, NOW - 25 * HOUR),
      run('r2', 'source', 's_boiler', stop - 2 * HOUR, stop),
      run('r3', 'source', 's_boiler', restart, null),
      run('p1', 'pump', 'p_floor', stop - 2 * HOUR, stop + 10 * MIN),
    ],
  });
  const w = await service.widgets();
  assert.equal(w.kv, 'klimo_stats');
  assert.equal(w.now, NOW);
  assert.equal(w.from, NOW - DAY);
  assert.equal(w.out.length, 24);
  assert.ok(w.out.every((v) => typeof v === 'number'));
  assert.equal(w.src.length, 1);
  const s = w.src[0];
  assert.equal(s.id, 's_boiler');
  assert.deepEqual(s.runs, [
    [(stop - 2 * HOUR - (NOW - DAY)) / MIN, (stop - (NOW - DAY)) / MIN],
    [(restart - (NOW - DAY)) / MIN, null],
  ]);
  assert.deepEqual(s.p.map((p) => [p.id, p.n, p.runs.length]), [['p_floor', 'Насос ТП', 1]]);
  assert.equal(w.heat.fit.wpk, 330);
  assert.equal(w.heat.pts.length, w.heat.pts.filter((p) => p[0] >= 2).length);
  assert.equal(w.inertia, null, 'no 5-minute statistics, no τ');

  // the rooms fall towards the night's outdoors at τ = 40 h: 22:00–06:00, two hours of the 13th and six of the 14th
  const outNight = (2 * outdoorOf(1) + 6 * outdoorOf(0)) / 8;
  const falling = [];
  for (let t = stop; t < restart; t += 5 * MIN) falling.push({ start: t, mean: outNight + (21 - outNight) * Math.exp(-(t - stop) / HOUR / tau) });
  const second = setup({ spans: [run('r2', 'source', 's_boiler', stop - 2 * HOUR, stop), run('r3', 'source', 's_boiler', restart, null)], indoor5: falling }).service;
  const w2 = await second.widgets();
  assert.equal(w2.inertia.n, 1);
  near(w2.inertia.tau, tau, 6);
  near(w2.inertia.c, (w2.inertia.tau * 330) / 1000, 0.1);
});
