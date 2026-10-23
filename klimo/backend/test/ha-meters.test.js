const assert = require('node:assert/strict');
const test = require('node:test');
const m = require('../dist/ha/meters');
const { meterUnit, meterUnitFits } = require('../dist/shared/model');
const { defaultTariffs } = require('../dist/shared/defaults');

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 9, 20, 21, 0); // 2026-10-21 00:00 in Kyiv
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('statistics rows: HA change first, then the sum (which already continues across resets), then states', () => {
  // HA sent change: taken as is, a reset included
  assert.deepEqual(m.rowChanges([{ start: T0, change: 0.4 }, { start: T0 + HOUR, change: 0.2 }]), [0.4, 0.2]);
  // sums only: the first row has nothing to compare with
  assert.deepEqual(m.rowChanges([{ start: T0, sum: 10 }, { start: T0 + HOUR, sum: 10.5 }, { start: T0 + 3 * HOUR, sum: 11.25 }]), [null, 0.5, 0.75]);
  // states only: the counter was replaced (1500 → 3) mid-way, and dipped by a rounding step once
  const rows = [1500, 1501.2, 3, 4.5, 4.4, 4.6].map((state, i) => ({ start: T0 + i * HOUR, state }));
  const out = m.rowChanges(rows);
  assert.equal(out[0], null);
  near(out[1], 1.2);
  near(out[2], 3, 1e-9); // the new counter counted from zero, never negative
  near(out[3], 1.5);
  assert.equal(out[4], 0); // a small dip is noise
  near(out[5], 0.1); // and the recovery is not counted twice
  assert.ok(out.every((x) => x === null || x >= 0));
});

test('readings as a running total: unavailable gaps skipped, resets start over, an hour reads [a, b)', () => {
  const r = (min, v) => ({ t: T0 + min * MIN, v });
  const points = m.runningTotal([r(0, 100), r(20, 100.5), r(30, null), r(50, null), r(70, 101.5), r(80, 0.25), r(130, 0.75)]);
  assert.deepEqual(points.map(([t]) => (t - T0) / MIN), [0, 20, 70, 80, 130]);
  assert.deepEqual(points.map(([, v]) => v), [0, 0.5, 1.5, 1.75, 2.25]);
  // the growth during the unavailable stretch lands on the next reading
  near(m.totalDelta(points, T0, T0 + HOUR), 0.5);
  near(m.totalDelta(points, T0 + HOUR, T0 + 2 * HOUR), 1.25);
  // a reading exactly on the hour belongs to the next hour (as HA compiles it)
  const exact = m.runningTotal([r(0, 1), r(60, 2), r(90, 3)]);
  near(m.totalDelta(exact, T0, T0 + HOUR), 0);
  near(m.totalDelta(exact, T0 + HOUR, T0 + 2 * HOUR), 2);
  assert.equal(m.totalDelta(exact, T0 - 2 * HOUR, T0 - HOUR), null);
});

test('units: volume to m³, energy to kWh, power integrated; a temperature never fits a meter', () => {
  near(meterUnit('ft³').factor * 100, 2.8316846592);
  near(meterUnit('CCF').factor, 2.8316846592);
  near(meterUnit('MJ').factor * 36, 10);
  near(meterUnit('Wh').factor * 1000, 1);
  assert.equal(meterUnit('M3').quantity, 'volume', 'a spelling that differs only in case');
  assert.equal(meterUnit('°C'), null);
  assert.equal(meterUnitFits('gas', 'm³'), true);
  assert.equal(meterUnitFits('gas', 'kWh'), true);
  assert.equal(meterUnitFits('gas', 'W'), false);
  assert.equal(meterUnitFits('electricity', 'W'), true);
  assert.equal(meterUnitFits('heat', 'L'), false);
  assert.equal(meterUnitFits('heat', 'GJ'), true);
  // 2 kW for 30 min, then 1 kW for 90 min → 1 + 1.5 kWh; nothing before the first reading
  const kw = [{ t: T0 + 30 * MIN, v: 2 }, { t: T0 + HOUR, v: 1 }];
  near(m.integrateKw(kw, T0, T0 + 150 * MIN), 2.5);
  assert.equal(m.integrateKw(kw, T0 - HOUR, T0), null);
});

test('runs: dense readings pin a run exactly, sparse or shared ones make it an estimate', () => {
  const run = (a, b) => ({ start: T0 + a * MIN, end: T0 + b * MIN });
  // a gas pulse counter: 0.01 m³ per reading every few minutes while the boiler burns
  const dense = [];
  for (let i = 0; i <= 12; i++) dense.push([T0 + 60 * MIN + i * 5 * MIN, i * 0.1]);
  dense.push([T0 + 4 * HOUR, 1.25]); // the stove later, with no run around it
  const [one] = m.attributeRuns(dense, [run(60, 120)]);
  near(one.value, 1.2);
  assert.equal(one.estimated, false);

  // two runs inside one hour between readings share its growth by running time
  const sparse = [[T0, 0], [T0 + HOUR, 3]];
  const [a, b] = m.attributeRuns(sparse, [run(0, 10), run(30, 50)]);
  near(a.value, 1);
  near(b.value, 2);
  assert.equal(a.estimated, true);
  assert.equal(b.estimated, true);

  // growth with no run inside belongs to none; readings that begin after the run make it an estimate
  const later = m.attributeRuns([[T0 + 2 * HOUR, 0], [T0 + 3 * HOUR, 1]], [run(0, 30), run(110, 130)]);
  assert.equal(later[0].value, 0);
  assert.equal(later[1].estimated, true);
  // no readings at all: unknown
  assert.deepEqual(m.attributeRuns([], [run(0, 10)]), [{ value: null, estimated: true }]);
});

test('heating degree-days: each day counts base − its mean; an hour holds its 1/24 share', () => {
  const tz = 'Europe/Kyiv';
  const rows = [];
  for (let h = 0; h < 48; h++) rows.push({ start: T0 + h * HOUR, end: T0 + (h + 1) * HOUR, meanC: h < 24 ? 8 : 20 });
  near(m.degreeDays(rows, T0, T0 + 48 * HOUR, 18, tz), 10, 1e-9); // 10 for the cold day, 0 for the warm one
  near(m.degreeDays(rows, T0, T0 + HOUR, 18, tz), 10 / 24, 1e-9);
  near(m.degreeDays(rows, T0, T0 + 12 * HOUR, 18, tz), 5, 1e-9);
  assert.equal(m.degreeDays([], T0, T0 + HOUR, 18, tz), null);
  near(m.outdoorMean(rows, T0 + 12 * HOUR, T0 + 36 * HOUR), 14);
});

test('periods: weeks start on Monday, a day has its local hours (25 when the clocks go back)', () => {
  const tz = 'Europe/Kyiv';
  const week = m.planPeriod('week', '2026-10-22', tz);
  assert.equal(week.date, '2026-10-19');
  assert.equal(week.edges.length, 8);
  assert.equal(m.planPeriod('day', '2026-10-25', tz).edges.length, 26, 'DST ends: 25 hours');
  assert.equal(m.planPeriod('day', '2026-03-29', tz).edges.length, 24, 'DST begins: 23 hours');
  const year = m.planPeriod('year', '2026-10-22', tz);
  assert.equal(year.date, '2026-01-01');
  assert.equal(year.bucket, 'month');
  assert.equal(year.edges.length, 13);
  assert.equal(m.shiftPeriod('month', '2026-01-01', -1), '2025-12-01');
});

test('cost: gas priced per m³ or per kWh through the calorific value, electricity per kWh', () => {
  const t = { ...defaultTariffs(), currency: '₴', electricityPerKwh: 4.32, gasPrice: 8, gasPriceUnit: 'm³' };
  near(m.costOf(2, 10, 'm³', t), 2 * 8 + 10 * 4.32);
  // a meter counting kWh, a price per m³: 21 kWh at 10.5 kWh/m³ are 2 m³
  near(m.costOf(21, null, 'kWh', t), 16);
  // priced per kWh, a meter counting m³
  near(m.costOf(2, null, 'm³', { ...t, gasPrice: 0.8, gasPriceUnit: 'kWh' }), 2 * 10.5 * 0.8);
  assert.equal(m.costOf(2, 10, 'm³', defaultTariffs()), null, 'no prices, no cost');
  near(m.gasKwh(2, 'm³', 10.5), 21);
  assert.equal(m.ratio(0, 5, 0.05), null, 'standby alone says nothing about a COP');
  near(m.ratio(12, 4, 0.05), 3);
});
