const assert = require('node:assert/strict');
const test = require('node:test');
const { flowFromCurve, coolSupplySetpoint } = require('../dist/engine/core/curves');

const HP = { points: [{ outdoorC: -20, flowC: 52 }, { outdoorC: -10, flowC: 45 }, { outdoorC: 0, flowC: 40 }, { outdoorC: 15, flowC: 32 }], shiftC: 0, minFlowC: 25, maxFlowC: 55 };

test('weather curve: 4.2° outdoors → 37.8° flow (40 − 8·4.2/15)', () => {
  assert.equal(flowFromCurve(HP, 4.2), 37.8);
  assert.equal(flowFromCurve(HP, -10), 45);
  assert.equal(flowFromCurve(HP, -15), 48.5);
});

test('weather curve: flat beyond its ends, points in any order, parallel shift, device limits', () => {
  assert.equal(flowFromCurve(HP, -30), 52);
  assert.equal(flowFromCurve(HP, 25), 32);
  assert.equal(flowFromCurve({ ...HP, points: [...HP.points].reverse() }, 4.2), 37.8);
  assert.equal(flowFromCurve({ ...HP, shiftC: 2 }, 4.2), 39.8);
  assert.equal(flowFromCurve({ ...HP, shiftC: 5 }, -20), 55, 'clamped to the maximum flow');
  assert.equal(flowFromCurve({ ...HP, minFlowC: 35 }, 25), 35, 'clamped to the minimum flow');
});

test('dew-safe cooling supply: the design flow, raised to dew point + margin', () => {
  assert.equal(coolSupplySetpoint(18, 17.1, 2), 19.1);
  assert.equal(coolSupplySetpoint(18, 14.6, 2), 18);
  assert.equal(coolSupplySetpoint(18, null, 2), 18);
});
