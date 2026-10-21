const assert = require('node:assert/strict');
const test = require('node:test');
const u = require('../dist/engine/core/util');

test('median, mean and clamp', () => {
  assert.equal(u.median([19.7, 19.8, 20.9]), 19.8);
  assert.equal(u.median([20.0, 20.1]), 20.05);
  assert.equal(u.median([4, 1, 3, 2]), 2.5);
  assert.equal(u.median([]), null);
  assert.equal(u.mean([1, 2, 3, 4]), 2.5);
  assert.equal(u.mean([]), null);
  assert.equal(u.clamp(35, 5, 30), 30);
  assert.equal(u.clamp(-1, 0, 10), 0);
  assert.equal(u.lerp(10, 20, 0.25), 12.5);
});

test('rounding to the setpoint grid', () => {
  assert.equal(u.roundStep(20.2, 0.5, 'ceil'), 20.5);
  assert.equal(u.roundStep(20.5, 0.5, 'ceil'), 20.5);
  assert.equal(u.roundStep(19.8, 0.5, 'floor'), 19.5);
  assert.equal(u.roundStep(19.5, 0.5, 'floor'), 19.5);
  assert.equal(u.roundStep(20.26, 0.1), 20.3);
  assert.equal(u.roundStep(20.1 + 0.2, 0.1, 'floor'), 20.3);
  assert.equal(u.round1(20.05), 20.1);
  assert.equal(u.round1(-0.05), -0.1);
  assert.equal(u.round5min(23), 25);
  assert.equal(u.round5min(22), 20);
});

test('dew point and absolute humidity (19.8 °C, 46 %)', () => {
  assert.equal(u.round1(u.magnusDewPoint(19.8, 46)), 7.8);
  assert.equal(u.round1(u.absoluteHumidity(19.8, 46)), 7.9);
  assert.ok(Math.abs(u.magnusDewPoint(25, 100) - 25) < 0.01);
});

test('smoothing and trends', () => {
  assert.equal(u.ewma(null, 1.4, 0.2), 1.4);
  assert.ok(Math.abs(u.ewma(1.0, 2.0, 0.2) - 1.2) < 1e-9);
  assert.equal(u.emaStep(null, 20, 60_000, 300_000), 20);
  assert.equal(u.emaStep(20, 21, 60_000, 0), 21);
  const one = u.emaStep(20, 21, 300_000, 300_000);
  assert.ok(Math.abs(one - (20 + (1 - Math.exp(-1)))) < 1e-9);
  const t0 = Date.UTC(2026, 9, 21, 16);
  const rising = [0, 15, 30, 45, 60].map((m) => [t0 + m * 60_000, 19 + m / 60]);
  assert.ok(Math.abs(u.slopePerHour(rising) - 1) < 1e-9);
  assert.equal(u.slopePerHour([[t0, 20]]), null);
  assert.equal(u.slopePerHour([[t0, 20], [t0, 21]]), null);
});
