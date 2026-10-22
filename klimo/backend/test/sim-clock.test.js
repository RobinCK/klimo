const assert = require('node:assert/strict');
const test = require('node:test');
const { SimClock, parseLocalIso, clampSpeed } = require('../dist/sim/sim.clock');
const { EVENING, sleep, settle } = require('./sim-harness');

test('virtual time stands at the start until the clock is started, then runs at its speed', async () => {
  const clock = new SimClock(EVENING, 600);
  try {
    await sleep(30);
    assert.equal(clock.now(), EVENING);
    clock.start();
    await sleep(50);
    const elapsed = clock.now() - EVENING;
    assert.ok(elapsed >= 25_000 && elapsed < 200_000, `${elapsed} ms of virtual time in ~50 ms`);
    clock.setPaused(true);
    const frozen = clock.now();
    await sleep(20);
    assert.equal(clock.now(), frozen);
    assert.equal(clock.tz(), 'Europe/Kyiv');
  } finally {
    clock.dispose();
  }
});

test('timers run on virtual time; a frozen clock still lets them fire at real pace', async () => {
  const clock = new SimClock(EVENING, 600);
  try {
    clock.start();
    const fired = [];
    clock.setTimeout(() => fired.push('minute'), 60_000);
    await sleep(150);
    assert.deepEqual(fired, ['minute'], 'a virtual minute passes in 100 ms at 600×');

    clock.setSpeed(0);
    const at = clock.now();
    clock.setTimeout(() => fired.push('debounce'), 20);
    await sleep(60);
    assert.deepEqual(fired, ['minute', 'debounce']);
    assert.equal(clock.now(), at, 'virtual time did not move');
  } finally {
    clock.dispose();
  }
});

test('jumping forward fires what fell due, an interval only once', async () => {
  const clock = new SimClock(EVENING, 1);
  try {
    let ticks = 0;
    let once = 0;
    clock.setInterval(() => ticks++, 10_000);
    clock.setTimeout(() => once++, 30 * 60_000);
    const cancelled = clock.setTimeout(() => assert.fail('cancelled timers never fire'), 60_000);
    cancelled.cancel();
    clock.jumpTo(EVENING + 3_600_000);
    await settle();
    assert.equal(clock.now(), EVENING + 3_600_000);
    assert.equal(once, 1);
    assert.equal(ticks, 1);
    // going back moves the calendar but fires nothing
    clock.jumpTo(EVENING);
    await settle();
    assert.equal(ticks, 1);
  } finally {
    clock.dispose();
  }
});

test('the start can be given as local wall time; speeds are clamped', () => {
  assert.equal(parseLocalIso('2026-10-21T19:10'), EVENING);
  assert.equal(parseLocalIso('2026-07-18 15:40'), Date.UTC(2026, 6, 18, 12, 40));
  assert.equal(parseLocalIso('21.10.2026 19:10'), null);
  assert.equal(parseLocalIso('2026-10-21T25:00'), null);
  assert.deepEqual([clampSpeed(-1), clampSpeed(1000), clampSpeed(Number.NaN), clampSpeed(60)], [0, 600, 1, 60]);
});
