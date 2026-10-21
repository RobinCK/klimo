const assert = require('node:assert/strict');
const test = require('node:test');
const t = require('../dist/engine/core/time');

const KYIV = 'Europe/Kyiv';
const utc = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);

test('local parts in the HA time zone', () => {
  // Wednesday 2026-10-21 19:10 in Kyiv (summer time, UTC+3)
  const lt = t.toLocal(utc(2026, 10, 21, 16, 10), KYIV);
  assert.deepEqual(lt, { date: '2026-10-21', dow: 2, minute: 19 * 60 + 10, month: 10, year: 2026 });
  assert.equal(t.fromLocal('2026-10-21', 19 * 60 + 10, KYIV), utc(2026, 10, 21, 16, 10));
  assert.equal(t.toLocal(utc(2026, 10, 25, 22), KYIV).dow, 0); // Monday 00:00 local
});

test('spring forward 2026-03-29: missing wall times map to the first valid minute', () => {
  const jump = utc(2026, 3, 29, 1); // 03:00 EET → 04:00 EEST
  assert.equal(t.fromLocal('2026-03-29', 3 * 60, KYIV), jump);
  assert.equal(t.fromLocal('2026-03-29', 3 * 60 + 30, KYIV), jump);
  assert.equal(t.fromLocal('2026-03-29', 4 * 60, KYIV), jump);
  assert.equal(t.fromLocal('2026-03-29', 2 * 60 + 59, KYIV), utc(2026, 3, 29, 0, 59));
  assert.equal(t.toLocal(jump, KYIV).minute, 4 * 60);
  // the day is 23 hours long
  assert.equal(t.fromLocal('2026-03-30', 0, KYIV) - t.fromLocal('2026-03-29', 0, KYIV), 23 * 3_600_000);
});

test('fall back 2026-10-25: an ambiguous wall time maps to its first occurrence', () => {
  const first = utc(2026, 10, 25, 0, 30); // 03:30 EEST
  const second = utc(2026, 10, 25, 1, 30); // 03:30 EET
  assert.equal(t.fromLocal('2026-10-25', 3 * 60 + 30, KYIV), first);
  assert.equal(t.toLocal(first, KYIV).minute, 3 * 60 + 30);
  assert.equal(t.toLocal(second, KYIV).minute, 3 * 60 + 30);
  assert.equal(t.fromLocal('2026-10-26', 0, KYIV) - t.fromLocal('2026-10-25', 0, KYIV), 25 * 3_600_000);
  assert.equal(t.startOfLocalDay(second, KYIV), utc(2026, 10, 24, 21));
});

test('minute 1440 is the next midnight; dates roll over months and years', () => {
  assert.equal(t.fromLocal('2026-12-31', 1440, KYIV), t.fromLocal('2027-01-01', 0, KYIV));
  assert.equal(t.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(t.addDays('2028-03-01', -1), '2028-02-29');
  assert.equal(t.dowOfDate('2026-10-21'), 2);
  assert.ok(t.isLocalDate('2026-02-28'));
  assert.ok(!t.isLocalDate('2026-02-30'));
});

test('HH:MM conversions', () => {
  assert.equal(t.hhmmToMinute('06:30'), 390);
  assert.equal(t.hhmmToMinute('24:00'), 1440);
  assert.equal(t.minuteToHhmm(390), '06:30');
  assert.equal(t.minuteToHhmm(1440), '24:00');
  assert.throws(() => t.hhmmToMinute('7:75'));
});

test('time windows across midnight belong to the day they start', () => {
  const night = { from: '23:00', to: '07:00', days: [4] }; // starts on Friday
  assert.equal(t.inWindow(23 * 60 + 30, 4, night), true); // Fri 23:30
  assert.equal(t.inWindow(3 * 60, 5, night), true); // Sat 03:00
  assert.equal(t.inWindow(7 * 60, 5, night), false); // Sat 07:00 — the window ends
  assert.equal(t.inWindow(3 * 60, 4, night), false); // Fri 03:00 belongs to Thursday's window
  assert.equal(t.inWindow(23 * 60 + 30, 5, night), false);
  const daily = { from: '23:00', to: '07:00' };
  assert.equal(t.inWindow(6 * 60 + 59, 0, daily), true);
  assert.equal(t.inWindow(7 * 60, 0, daily), false);
  assert.equal(t.inWindow(22 * 60 + 59, 0, daily), false);
  assert.equal(t.inWindow(12 * 60, 3, { from: '08:00', to: '17:30', days: [3] }), true);
  assert.equal(t.inWindow(12 * 60, 2, { from: '08:00', to: '17:30', days: [3] }), false);
});
