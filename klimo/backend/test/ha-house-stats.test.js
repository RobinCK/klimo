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
/** Hot water drawn at 23:00 and at 03:00, while the boiler does not heat: not the rooms' heat. */
const HOT_WATER = { 23: 0.4, 3: 0.2 };
const run = (id, subject, subjectId, from, to) => ({ id, subject, subjectId, kind: 'run', mode: 'heat', startTs: from, endTs: to, meta: null });

function setup({ spans = [], indoor5 = null, outdoorAt = null } = {}) {
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
  // the boiler heats 06:00–22:00 every day up to the 12th
  const heating = days.filter((d) => d.k >= 2).map((d) => run(`h${d.k}`, 'source', 's_boiler', fromLocal(d.date, 6 * 60, TZ), fromLocal(d.date, 22 * 60, TZ)));
  ha.statisticsFn = (ids, start, end, period, types) => {
    assert.equal(period, 'hour');
    assert.deepEqual(types, ['change']);
    // gas the boiler burnt for that heat at 80 %, 10 kWh per m³, spread over its 16 hours; hot water at
    // night on top; one day without a reading
    const rows = [];
    for (const d of days.filter((x) => x.k !== 7)) {
      for (let h = 0; h < 24; h++) {
        const heat = d.k >= 2 && h >= 6 && h < 22 ? Math.max(0, heatOf(21 - outdoorOf(d.k))) / 16 / 0.8 / 10 : 0;
        rows.push({ start: fromLocal(d.date, h * 60, TZ), change: heat + (HOT_WATER[h] ?? 0) });
      }
    }
    return { 'sensor.gas': rows };
  };
  const hours = (valueAt) => {
    const out = [];
    for (let t = fromLocal(addDays(TODAY, -31), 0, TZ); t < NOW; t += HOUR) out.push({ start: t, mean: valueAt(t) });
    return out;
  };
  const kOf = (t) => {
    const date = toLocal(t, TZ).date;
    // today is as mild as yesterday: one outdoor temperature through the night of the test
    return days.find((d) => d.date === date)?.k ?? 1;
  };
  const history = {
    indoorMeans: async (from, to, period) => {
      if (period === '5minute') return indoor5 ? { r_a: indoor5 } : {};
      return { r_a: hours(() => 21) };
    },
    outdoor: async () => ({
      // an hour's mean: the middle of the hour on a smooth curve
      series: hours((t) => (outdoorAt ? outdoorAt(t + HOUR / 2) : null) ?? outdoorOf(kOf(t))).map((p) => ({ ...p, min: null, max: null, state: null, sum: null })),
      avgC: null,
      days: 31,
    }),
  };
  const all = [...heating, ...spans];
  const store = {
    range: async (from, to, subject, id) => all.filter((s) => s.startTs < to && (s.endTs ?? NOW) > from && (!subject || s.subject === subject) && (!id || s.subjectId === id)),
  };
  return { service: new HouseStatsService(ha, config, store, clock, history), ha, config };
}

test('the heat characteristic: gas of the heating hours at the boilers’ efficiency against the difference, a line through 30 days', async () => {
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
  // the hot water at 23:00 and 03:00 (6 kWh of gas) is not the rooms' heat
  near(day.gasKwh, heatOf(21 - outdoorOf(3)) / 0.8, 0.01);
  const noRuns = h.days.find((d) => d.date === addDays(TODAY, -1));
  assert.equal(noRuns.heatKwh, 0, 'a day the boiler did not heat has no heat, whatever the meter counted');
  assert.equal(noRuns.used, false);
  assert.ok(h.used >= 20);
  assert.equal(h.indoorC, 21);
  const fit = h.fit;
  near(fit.slopeKwhPerK, 8, 0.05);
  near(fit.interceptKwh, -20, 0.6);
  assert.ok(fit.r2 > 0.99);
  assert.equal(fit.wPerK, 335, '8 kWh a day per K is 333 W/K, to 5');
  // no heat below 20 kWh / 8 = 2.5 K of difference: above 18.5 °C outdoors
  near(fit.balanceC, 18.5, 0.1);
  // the load is the loss × the difference: 8 kWh a day per K over 31 K and 41 K
  near(fit.loadKw.minus10, (8 * 31) / 24, 0.05);
  near(fit.loadKw.minus20, (8 * 41) / 24, 0.05);
});

test('days just above the balance ran the heating only part of the time: the line leaves them out', () => {
  // 8 kWh a day per K less 20 kWh of gains (zero heat at 2.5 K), and two mild days below that line
  const fit = fitLine([[3, 10], [4.5, 22], [8, 44], [10, 60], [12, 76], [14, 92], [16, 108]], 21);
  near(fit.slopeKwhPerK, 8, 0.001);
  near(fit.interceptKwh, -20, 0.01);
  near(fit.minDeltaK, 5.5, 0.01);
  near(fit.balanceC, 18.5, 0.01);
});

test('a line that stays above zero shows no balance temperature; the loads stay the loss × the difference', () => {
  // the whole meter, hot water and cooking included: 20 kWh a day more than heating at any difference
  const fit = fitLine([[10, 100], [12, 116], [14, 132], [16, 148], [18, 164]], 21);
  near(fit.slopeKwhPerK, 8, 0.001);
  near(fit.interceptKwh, 20, 0.01);
  assert.equal(fit.balanceC, null, 'not «no heating needed above 23.5 °C»');
  near(fit.loadKw.minus10, (8 * 31) / 24, 0.05);
});

test('no line from too few days, too little spread, or heat that does not rise with the cold', () => {
  assert.equal(fitLine([[10, 60], [12, 76], [14, 92], [16, 108]], 21), null);
  assert.equal(fitLine([[10, 60], [11, 68], [10.5, 64], [11.5, 72], [12, 76]], 21), null);
  assert.equal(fitLine([[10, 90], [12, 80], [14, 70], [16, 60], [18, 50]], 21), null);
  assert.ok(fitLine([[10, 60], [11, 68], [12, 76], [13, 84], [14, 92]], 21));
});

test('the widgets’ sensor: the last 24 h of runs with the pumps that follow, the hourly outdoor, τ from a night pause', async () => {
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
  assert.equal(w.heat.fit.wpk, 335);
  near(w.heat.fit.bal, 18.5, 0.1);
  assert.equal(w.heat.pts.length, w.heat.pts.filter((p) => p[0] >= 2).length);
  assert.equal(w.inertia, null, 'rooms that do not cool in the pauses give no τ');

  // at night half the gains (20 kWh a day ÷ 8 kWh per K ÷ 2) hold the rooms 1.25 K above the outdoors
  // without heat: they fall towards that at τ = 40 h, measured 22:00–06:00
  const settle = outdoorOf(1) + 1.25;
  const falling = [];
  for (let t = stop; t < restart; t += 5 * MIN) falling.push({ start: t, mean: settle + (21 - settle) * Math.exp(-(t - stop) / HOUR / tau) });
  const second = setup({ spans: [run('r2', 'source', 's_boiler', stop - 2 * HOUR, stop), run('r3', 'source', 's_boiler', restart, null)], indoor5: falling }).service;
  const w2 = await second.widgets();
  assert.equal(w2.inertia.n, 1);
  near(w2.inertia.up, 1.25, 0.1);
  near(w2.inertia.tau, tau, 0.6);
  near(w2.inertia.c, (w2.inertia.tau * 335) / 1000, 0.1);

  // a night that gets colder towards morning (4° down to −2° by 07:00): the rooms follow it, and τ still comes out
  const coldening = (t) => 4 - (6 * Math.min(1, Math.max(0, t - stop))) / (restart - stop);
  const real = [];
  let temp = 21;
  for (let t = stop; t < restart; t += MIN) {
    if ((t - stop) % (5 * MIN) === 0) real.push({ start: t, mean: temp });
    const target = coldening(t + MIN / 2) + 1.25;
    temp = target + (temp - target) * Math.exp(-MIN / HOUR / tau);
  }
  const third = setup({
    spans: [run('r2', 'source', 's_boiler', stop - 2 * HOUR, stop), run('r3', 'source', 's_boiler', restart, null)],
    indoor5: real,
    outdoorAt: (t) => (t >= stop - HOUR && t <= restart + HOUR ? coldening(t) : null),
  }).service;
  const w3 = await third.widgets();
  near(w3.inertia.tau, tau, 1);
});
