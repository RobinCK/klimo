const assert = require('node:assert/strict');
const test = require('node:test');
const ops = require('../dist/config/schedule-ops');
const { seedHouseDays } = require('../dist/shared/defaults');

const fmt = (day) => day.map((b) => `${b.start}-${b.end}:${b.profileId}`).join(' ');
const house = () => ({ id: 'house', scope: 'house', roomId: null, enabled: true, days: seedHouseDays(), updatedAt: 0 });
const exists = (id) => ['home', 'away', 'eco', 'night', 'guests'].includes(id);

test('a valid day has no issues; gaps, grid and short blocks are reported', () => {
  assert.deepEqual(ops.dayIssues(seedHouseDays()[0], exists), []);
  const bad = [
    { start: 0, end: 400, profileId: 'night' },
    { start: 420, end: 435, profileId: 'home' },
    { start: 435, end: 1440, profileId: 'ghost' },
  ];
  assert.deepEqual(ops.dayIssues(bad, exists).map((i) => [i.path, i.code]), [
    ['0', 'step'],
    ['1.start', 'contiguous'],
    ['1', 'step'],
    ['1.end', 'min_length'],
    ['2', 'step'],
    ['2.profileId', 'not_found'],
  ]);
  assert.deepEqual(ops.dayIssues([{ start: 0, end: 1380, profileId: 'home' }], exists).map((i) => i.code), ['contiguous']);
  assert.deepEqual(ops.weekIssues([[]], exists).map((i) => i.code), ['length']);
});

test('saving a day merges equal neighbours and repeats it on chosen days', () => {
  const plan = [
    { start: 0, end: 360, profileId: 'night' },
    { start: 360, end: 420, profileId: 'night' },
    { start: 420, end: 1440, profileId: 'home' },
  ];
  const s = ops.setDay(house(), 0, plan, [1, 2], exists);
  assert.equal(fmt(s.days[0]), '0-420:night 420-1440:home');
  assert.equal(fmt(s.days[2]), '0-420:night 420-1440:home');
  assert.equal(fmt(s.days[3]), fmt(seedHouseDays()[3]));
  assert.deepEqual(ops.daysWithSamePlan(s, 0), [0, 1, 2]);
  assert.throws(() => ops.setDay(house(), 0, [{ start: 0, end: 1000, profileId: 'home' }], [], exists), (e) => e.code === 'validation' && e.issues[0].path.startsWith('blocks'));
});

test('split, remove and copy', () => {
  const day = seedHouseDays()[0];
  const split = ops.splitBlock(day, 2); // 08:30–17:30 away → midpoint 13:00
  assert.equal(fmt(split), '0-390:night 390-510:home 510-780:away 780-1050:away 1050-1380:home 1380-1440:night');
  assert.equal(fmt(ops.splitBlock(day, 2, 600)), '0-390:night 390-510:home 510-600:away 600-1050:away 1050-1380:home 1380-1440:night');
  assert.throws(() => ops.splitBlock(seedHouseDays()[4], 5), (e) => e.code === 'validation'); // Friday 23:30–24:00 is 30 minutes
  assert.throws(() => ops.splitBlock(day, 2, 525), (e) => e.code === 'validation');

  // removing grows the previous block; equal neighbours then merge
  assert.equal(fmt(ops.removeBlock(day, 2)), '0-390:night 390-1380:home 1380-1440:night');
  assert.equal(fmt(ops.removeBlock(day, 0)), '0-510:home 510-1050:away 1050-1380:home 1380-1440:night');
  assert.throws(() => ops.removeBlock([{ start: 0, end: 1440, profileId: 'home' }], 0));

  const copied = ops.copyDay(house(), 5, [0, 1]);
  assert.equal(fmt(copied.days[0]), fmt(seedHouseDays()[5]));
  assert.equal(fmt(copied.days[4]), fmt(seedHouseDays()[4]));
});

test('exceptions and profile replacement', () => {
  const s = house();
  assert.equal(fmt(ops.planForDate(s, 2, { id: 'x', scheduleId: 'house', date: '2026-12-25', plan: { likeDow: 6 }, note: null })), fmt(s.days[6]));
  assert.equal(ops.planForDate(s, 2, undefined), s.days[2]);
  assert.equal(fmt(ops.replaceProfileInPlan(s.days[4], 'guests', 'home')), '0-390:night 390-510:home 510-1050:away 1050-1410:home 1410-1440:night');
});
