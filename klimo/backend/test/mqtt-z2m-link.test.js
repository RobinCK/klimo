const assert = require('node:assert/strict');
const test = require('node:test');
const { parseLastSeen } = require('../dist/mqtt/z2m.service');
const { openMqtt, settle, MIN } = require('./mqtt-harness');

const Z2M1 = { id: 'z2m1', name: 'Z2M #1', baseTopic: 'zigbee2mqtt', frontendUrl: null, bridgeEntityId: null, resendOnRestart: true };
const IEEE = '0x00158d0001a2b3c4';

async function withBridge() {
  const h = openMqtt();
  h.config.z2mList.push({ ...Z2M1 });
  await h.mqtt.onApplicationBootstrap();
  h.transport.connect();
  await settle();
  h.transport.deliver('zigbee2mqtt/bridge/devices', JSON.stringify([{ type: 'EndDevice', ieee_address: IEEE, friendly_name: 'office_window', power_source: 'Battery', definition: { model: 'MCCGQ11LM', vendor: 'Aqara', exposes: [] } }]));
  const seen = [];
  h.bus.on('z2m.device', (p) => seen.push(p));
  return { h, seen };
}

const say = (h, name, msg) => h.transport.deliver(`zigbee2mqtt/${name}`, JSON.stringify(msg));
/** A stored message the broker hands to a new subscription (the retain flag set). */
const replay = (h, name, msg) => {
  for (const cb of h.transport.cbs.message) cb(`zigbee2mqtt/${name}`, JSON.stringify(msg), true);
};

test('a device message fills link quality, battery and last seen; last_seen is read in every Zigbee2MQTT format', async () => {
  const { h } = await withBridge();
  const at = h.clock.now() - 2 * MIN;
  say(h, 'office_window', { contact: true, battery: 87, linkquality: 72, last_seen: new Date(at).toISOString() });
  let link = h.z2m.deviceLink('z2m1', IEEE, 'office_window');
  assert.deepEqual([link.lqi, link.lqiAt, link.batteryPct, link.batteryAt, link.lastSeenAt], [72, at, 87, at, at]);

  // epoch milliseconds and a local offset name the same kind of instant
  h.clock.t += MIN;
  say(h, 'office_window', { contact: true, last_seen: h.clock.now() });
  assert.equal(h.z2m.link('z2m1', 'office_window').lastSeenAt, h.clock.now());
  assert.equal(parseLastSeen('2026-10-21T19:06:00+03:00'), Date.UTC(2026, 9, 21, 16, 6));
  assert.equal(parseLastSeen(1_792_000_000), 1_792_000_000_000, 'seconds are read as seconds');
  assert.equal(parseLastSeen('never'), null);

  // without last_seen a live message is «now»
  h.clock.t += MIN;
  say(h, 'office_window', { contact: false, linkquality: 64 });
  link = h.z2m.link('z2m1', 'office_window');
  assert.equal(link.lastSeenAt, h.clock.now());
  assert.equal(link.lqi, 64);
  assert.equal(link.lqiAt, h.clock.now());
});

test('a stored message replayed on subscribe tells nothing without its own last_seen', async () => {
  const { h } = await withBridge();
  replay(h, 'office_window', { contact: true, battery: 40, linkquality: 20 });
  assert.equal(h.z2m.link('z2m1', 'office_window'), null);
  const old = h.clock.now() - 2 * 60 * MIN;
  replay(h, 'office_window', { contact: true, battery: 41, linkquality: 22, last_seen: new Date(old).toISOString() });
  const link = h.z2m.link('z2m1', 'office_window');
  assert.deepEqual([link.lastSeenAt, link.batteryPct, link.lqi], [old, 41, 22]);
});

test('a device heard after a silence is announced once; a rename in Zigbee2MQTT keeps it by IEEE address', async () => {
  const { h, seen } = await withBridge();
  say(h, 'office_window', { contact: true });
  h.clock.t += MIN;
  say(h, 'office_window', { contact: true });
  assert.equal(seen.length, 1, 'the first message after the start, not the chatter that follows');
  h.clock.t += 30 * MIN;
  say(h, 'office_window', { contact: true });
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1], { instanceId: 'z2m1', friendlyName: 'office_window', at: h.clock.now() });

  h.transport.deliver('zigbee2mqtt/bridge/devices', JSON.stringify([{ type: 'EndDevice', ieee_address: IEEE, friendly_name: 'Кабінет/вікно', definition: { model: 'MCCGQ11LM', vendor: 'Aqara', exposes: [] } }]));
  h.clock.t += MIN;
  say(h, 'Кабінет/вікно', { contact: true, linkquality: 90 });
  // HA still names the device by its old friendly name until discovery catches up
  assert.equal(h.z2m.deviceLink('z2m1', IEEE, 'office_window').lqi, 90);
  assert.equal(h.z2m.deviceLink('z2m1', null, 'nobody'), null);
});
