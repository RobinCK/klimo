const assert = require('node:assert/strict');
const test = require('node:test');
const { Logger } = require('@nestjs/common');
const { CommandBus } = require('../dist/engine/command-bus');
const { MQTT_TRANSPORT } = require('../dist/tokens');

Logger.overrideLogger(false);

/** Home Assistant that records each call with the real time it arrived. */
function fakeHa() {
  const calls = [];
  let ctx = 0;
  return {
    calls,
    connected: true,
    getState: () => undefined,
    config: () => ({ unit_system: { temperature: '°C' } }),
    async callService(domain, service, target, data) {
      calls.push({ what: `${domain}.${service}`, entityId: target?.entity_id ?? null, data: data ?? null, at: performance.now() });
      return { context: { id: `c${++ctx}` }, response: null };
    },
  };
}

function busWith(rate, extra = {}) {
  const ha = fakeHa();
  const config = { singleton: () => ({ commandRate: { globalPerSec: 5, burst: 10, zigbeeSpacingMs: 250, perEntityMinIntervalSec: 5, ...rate } }) };
  const moduleRef = extra.transport ? { get: (token) => (token === MQTT_TRANSPORT ? extra.transport : null) } : null;
  return { ha, bus: new CommandBus(ha, config, moduleRef) };
}

/** The bus never keeps a process alive by itself (its pacing timer is unref'd); a test has to. */
async function alive(fn) {
  const keep = setInterval(() => undefined, 1000);
  try {
    await fn();
  } finally {
    clearInterval(keep);
  }
}

const on = (key, o = {}) => ({ key, entityId: key, value: { kind: 'switch', on: o.on ?? true }, urgency: o.urgency ?? 'normal', zigbee: o.zigbee ?? null });

test('the queue sends safety first, and a newer value replaces one still waiting', () =>
  alive(async () => {
    const { ha, bus } = busWith({ globalPerSec: 20, burst: 1 });
    try {
      const first = bus.send(on('switch.first')); // takes the only token at once
      const background = bus.send(on('switch.towel_rail', { urgency: 'background' }));
      const stale = bus.send(on('switch.floor_pump'));
      const safety = bus.send(on('switch.boiler_relay', { on: false, urgency: 'safety' }));
      const latest = bus.send(on('switch.floor_pump', { on: false }));
      const res = await Promise.all([first, background, stale, safety, latest]);
      assert.deepEqual(res[2], { ok: false, contextIds: [], error: null, superseded: true }, 'the older pump value never leaves');
      assert.ok(res[3].ok && res[3].contextIds.length === 1);
      assert.deepEqual(
        ha.calls.map((c) => `${c.what} ${c.entityId}`),
        ['switch.turn_on switch.first', 'switch.turn_off switch.boiler_relay', 'switch.turn_off switch.floor_pump', 'switch.turn_on switch.towel_rail'],
      );
    } finally {
      bus.onModuleDestroy();
    }
  }));

test('the token bucket lets a burst through at once and paces the rest', () =>
  alive(async () => {
    const { ha, bus } = busWith({ globalPerSec: 20, burst: 3, zigbeeSpacingMs: 0 });
    try {
      const t0 = performance.now();
      await Promise.all(Array.from({ length: 6 }, (_, i) => bus.send(on(`switch.s${i}`))));
      const at = ha.calls.map((c) => c.at - t0);
      assert.equal(at.length, 6);
      assert.ok(at.slice(0, 3).every((t) => t < 30), `the burst leaves at once: ${at.map(Math.round)}`);
      // three more tokens at 20/s take about 150 ms
      assert.ok(at[5] >= 120, `the rest is paced: ${at.map(Math.round)}`);
    } finally {
      bus.onModuleDestroy();
    }
  }));

test('commands to one Zigbee network are spaced; others pass a waiting Zigbee command', () =>
  alive(async () => {
    const { ha, bus } = busWith({ globalPerSec: 100, burst: 10, zigbeeSpacingMs: 120 });
    try {
      await Promise.all([
        bus.send(on('switch.trv_a_lock', { zigbee: 'z2m_1' })),
        bus.send(on('switch.trv_b_lock', { zigbee: 'z2m_1' })),
        bus.send(on('switch.wifi_plug')),
        bus.send(on('switch.trv_c_lock', { zigbee: 'z2m_2' })),
      ]);
      const by = Object.fromEntries(ha.calls.map((c) => [c.entityId, c.at]));
      assert.ok(by['switch.trv_b_lock'] - by['switch.trv_a_lock'] >= 110, 'the second head on the same network waits');
      assert.ok(by['switch.wifi_plug'] < by['switch.trv_b_lock'], 'a plain relay does not queue behind it');
      assert.ok(by['switch.trv_c_lock'] < by['switch.trv_b_lock'], 'another network is independent');
    } finally {
      bus.onModuleDestroy();
    }
  }));

test('Zigbee2MQTT values are published to the bridge, and fail cleanly without MQTT', () =>
  alive(async () => {
    const published = [];
    const transport = {
      connected: true,
      async publish(topic, payload, opts) {
        published.push({ topic, payload: JSON.parse(payload), retain: opts.retain });
      },
    };
    const { ha, bus } = busWith({}, { transport });
    try {
      const value = { kind: 'z2m', topic: 'zigbee2mqtt/Спальня головка/set', payload: { external_temperature_input: 18.4 } };
      const res = await bus.send({ key: 'z2m:zigbee2mqtt/Спальня головка:external_temperature_input', entityId: null, value, urgency: 'normal', zigbee: 'z2m_1' });
      assert.equal(res.ok, true);
      assert.deepEqual(published, [{ topic: 'zigbee2mqtt/Спальня головка/set', payload: { external_temperature_input: 18.4 }, retain: false }]);
      assert.equal(ha.calls.length, 0, 'nothing goes through Home Assistant');
      transport.connected = false;
      const down = await bus.send({ key: 'z2m:other', entityId: null, value, urgency: 'normal', zigbee: 'z2m_1' });
      assert.equal(down.ok, false);
      assert.match(down.error, /MQTT/);
    } finally {
      bus.onModuleDestroy();
    }
  }));

test('a failed call is reported, not thrown; a stopped bus refuses new work', async () => {
  const { ha, bus } = busWith({});
  ha.connected = false;
  const res = await bus.send(on('switch.boiler_relay'));
  assert.equal(res.ok, false);
  assert.match(res.error, /not connected/);
  bus.onModuleDestroy();
  const after = await bus.send(on('switch.boiler_relay'));
  assert.deepEqual(after, { ok: false, contextIds: [], error: 'stopped', superseded: false });
});

test('a calibration number in °F is written the way it is read: the head gets the offset Klimo means', () => {
  const { serviceCalls } = require('../dist/engine/command-bus');
  const { snapOf } = require('../dist/engine/snapshot.service');
  const entity = 'number.living_trv_local_temperature_calibration';
  // HA converts a temperature number absolutely: the head's +1.0° is shown as 33.8 °F
  const shownF = (c) => Math.round(((c * 9) / 5 + 32) * 10) / 10;
  const storedC = (f) => Math.round((((f - 32) * 5) / 9) * 10) / 10;
  const readC = (f) => snapOf({ entity_id: entity, state: String(f), attributes: { unit_of_measurement: '°F', device_class: 'temperature' }, last_changed: '2026-10-21T16:00:00Z', last_updated: '2026-10-21T16:00:00Z' }, '°F').snap.num;
  assert.equal(readC(shownF(1)), 1);
  const [call] = serviceCalls(entity, { kind: 'number', value: -1.5 }, { haUnit: '°F', entityUnit: '°F' });
  assert.equal(call.data.value, 29.3);
  assert.equal(storedC(call.data.value), -1.5, 'the head is set to −1.5°');
  assert.equal(readC(call.data.value), -1.5, 'and Klimo reads back what it wrote');
});
