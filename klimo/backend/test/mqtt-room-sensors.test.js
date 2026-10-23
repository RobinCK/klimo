// A simulated hour of the room sensors Klimo publishes: every minute the engine's room values change (and a
// sensor drops out now and then); what Home Assistant would show for sensor.klimo_<room>_temperature /
// _target / _humidity — the discovery value_template rendered against the retained state payload, as the
// MQTT integration does — must be the engine's value of that minute.
const assert = require('node:assert/strict');
const test = require('node:test');
const { openMqtt, settle, sparkFor, MIN } = require('./mqtt-harness');
const { renderTemplate } = require('../dist/sim/jinja-lite');

const host = { state: () => undefined, attributes: () => undefined, entityIds: () => [] };
const r1 = (x) => Math.round(x * 10) / 10;

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** What HA's MQTT sensor shows for a payload: the rendered template, `None` / empty read as unknown. */
function haState(config, payload) {
  const tpl = config.value_template ?? config.val_tpl;
  const v = renderTemplate(tpl, host, { value: payload, value_json: JSON.parse(payload) }).trim();
  return v === '' || v === 'None' ? 'unknown' : v;
}

test('a simulated hour: HA’s view of the room temperature, target and humidity sensors is the engine’s value every minute', async () => {
  const h = openMqtt();
  h.history.sparks = async () => Object.fromEntries(Object.entries(sparkFor(h.cfg)).map(([id, s]) => [id, { ...s, complete: true }]));
  await h.mqtt.onApplicationBootstrap();
  h.transport.connect();
  await settle();
  await h.timers.advance(5_000);

  const configs = new Map();
  for (const [topic, payload] of h.transport.retained) {
    const m = /^homeassistant\/sensor\/klimo_(.+)_(temperature|target|humidity)\/config$/.exec(topic);
    if (m && payload) configs.set(`${m[1]}|${m[2]}`, JSON.parse(payload));
  }
  const rooms = h.engine.roomsList;
  assert.ok(rooms.every((r) => configs.has(`${r.roomId}|temperature`) && configs.has(`${r.roomId}|target`)), 'every room has its temperature and target sensors');
  assert.ok(rooms.some((r) => configs.has(`${r.roomId}|humidity`)), 'and some a humidity sensor');

  const rand = rng(7);
  let compared = 0;
  for (let minute = 1; minute <= 60; minute++) {
    for (const [i, r] of rooms.entries()) {
      // a sensor drops out for a minute now and then: the engine has no temperature
      r.tempC = (minute + i) % 17 === 0 ? null : r1((r.tempC ?? 20) + (rand() - 0.5) * 0.4);
      r.humidity = { ...r.humidity, valuePct: Math.max(20, Math.min(90, Math.round((r.humidity.valuePct ?? 50) + (rand() - 0.5) * 4))) };
      if (minute === 20 && i === 0) r.target = { ...r.target, heatC: 22.5, displayC: 22.5, layer: 'manual', display: 'manual' };
      if (minute === 40 && i === 1) r.target = { ...r.target, heatC: 18, displayC: 18 };
    }
    h.clock.t += MIN;
    h.bus.emit('engine.tick', { at: h.clock.now(), result: h.engine.last() });
    await h.timers.advance(400);

    for (const r of rooms) {
      const payload = h.transport.retained.get(`klimo/room/${r.roomId}/state`);
      assert.ok(payload, `state of ${r.roomId}`);
      const t = r.target;
      const expected = {
        temperature: r.tempC === null ? 'unknown' : String(r1(r.tempC)),
        target: String(r1(t.displayC ?? t.heatC ?? t.coolC)),
        humidity: String(Math.round(r.humidity.valuePct)),
      };
      for (const kind of ['temperature', 'target', 'humidity']) {
        const config = configs.get(`${r.roomId}|${kind}`);
        if (!config) continue;
        assert.equal(haState(config, payload), expected[kind], `minute ${minute}, ${r.roomId} ${kind}`);
        compared++;
      }
    }
  }
  assert.ok(compared > 60 * rooms.length * 2, `${compared} values compared`);
});
