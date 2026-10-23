// Sparklines and the room sensors Klimo publishes, as Home Assistant records them.
const assert = require('node:assert/strict');
const test = require('node:test');
const { openMqtt, settle, sparkFor } = require('./mqtt-harness');

const tick = (h) => h.bus.emit('engine.tick', { at: h.clock.now(), result: h.engine.last() });

async function start(sparks) {
  const h = openMqtt();
  h.history.sparks = async function () {
    this.calls++;
    return sparks(this.calls, sparkFor(h.cfg));
  };
  await h.mqtt.onApplicationBootstrap();
  h.transport.connect();
  await settle();
  return h;
}

const withComplete = (all, complete) => Object.fromEntries(Object.entries(all).map(([id, s]) => [id, { ...s, complete }]));

test('sparklines read before the recorder answered are asked again on the next pass, not in 5 min', async () => {
  const h = await start((n, all) => withComplete(all, n > 1));
  assert.equal(h.history.calls, 1);
  // the next evaluation a few seconds later
  await h.timers.advance(6_000);
  tick(h);
  await h.timers.advance(300);
  assert.equal(h.history.calls, 2, 'incomplete: asked again');
  await h.timers.advance(6_000);
  tick(h);
  await h.timers.advance(300);
  assert.equal(h.history.calls, 2, 'complete: kept for 5 min');
});

test('the room sensors carry the aggregated temperature, the effective target and the humidity, on every change', async () => {
  const h = await start((_n, all) => withComplete(all, true));
  const living = h.engine.roomsList[0];
  await h.timers.advance(5_000);
  h.transport.mark();
  for (const t of [19.9, 20.0, 20.1]) {
    living.tempC = t;
    tick(h);
    await h.timers.advance(300);
  }
  const states = h.transport.since().filter((m) => m.topic === `klimo/room/${living.roomId}/state`).map((m) => JSON.parse(m.payload));
  assert.deepEqual(states.map((s) => s.cur), [19.9, 20, 20.1], 'no change is held back');
  const last = states.at(-1);
  assert.equal(last.target, living.target.displayC ?? living.target.heatC ?? living.target.coolC);
  assert.equal(last.hum, living.humidity.valuePct === null ? null : Math.round(living.humidity.valuePct));
  assert.notEqual(last.cur, last.target, 'the temperature is not the target');
});
