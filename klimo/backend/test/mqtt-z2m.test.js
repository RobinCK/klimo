const assert = require('node:assert/strict');
const test = require('node:test');
const { parseOnline, trvCapabilities } = require('../dist/mqtt/z2m.service');
const { openMqtt, settle, MIN, HOUR } = require('./mqtt-harness');

const Z2M1 = { id: 'z2m1', name: 'Z2M #1', baseTopic: 'zigbee2mqtt', frontendUrl: null, bridgeEntityId: null, resendOnRestart: true };

/** Connected MQTT with one configured Zigbee2MQTT instance on `zigbee2mqtt`. */
async function withBridge() {
  const h = openMqtt();
  h.config.z2mList.push({ ...Z2M1 });
  await h.mqtt.onApplicationBootstrap();
  h.transport.connect();
  await settle();
  return h;
}

const SONOFF_TRVZB = [
  {
    type: 'climate',
    features: [
      { type: 'numeric', name: 'occupied_heating_setpoint', property: 'occupied_heating_setpoint', value_min: 4, value_max: 35, value_step: 0.5, access: 7 },
      { type: 'numeric', name: 'local_temperature', property: 'local_temperature', access: 5 },
      { type: 'enum', name: 'system_mode', property: 'system_mode', values: ['off', 'auto', 'heat'], access: 7 },
      { type: 'numeric', name: 'local_temperature_calibration', property: 'local_temperature_calibration', value_min: -12.8, value_max: 12.7, value_step: 0.2, access: 7 },
    ],
  },
  { type: 'binary', name: 'child_lock', property: 'child_lock', access: 7 },
  { type: 'binary', name: 'open_window', property: 'open_window', access: 7 },
  { type: 'numeric', name: 'valve_opening_degree', property: 'valve_opening_degree', access: 7 },
  { type: 'numeric', name: 'valve_closing_degree', property: 'valve_closing_degree', access: 7 },
  { type: 'numeric', name: 'external_temperature_input', property: 'external_temperature_input', access: 7 },
  { type: 'enum', name: 'temperature_sensor_select', property: 'temperature_sensor_select', access: 7 },
  { type: 'numeric', name: 'battery', property: 'battery', access: 1 },
  { type: 'numeric', name: 'linkquality', property: 'linkquality', access: 1 },
];

test('bridge state, plain or JSON, reaches the bus on every change', async () => {
  const h = await withBridge();
  assert.ok(h.transport.subs.includes('zigbee2mqtt/#'));
  h.transport.deliver('zigbee2mqtt/bridge/state', '{"state":"online"}');
  h.transport.deliver('zigbee2mqtt/bridge/state', 'online');
  h.transport.deliver('zigbee2mqtt/bridge/state', 'offline');
  const edges = h.events.filter((e) => e.k === 'z2m.bridge').map((e) => e.p);
  assert.deepEqual(edges, [
    { instanceId: 'z2m1', online: true },
    { instanceId: 'z2m1', online: false },
  ]);
  assert.deepEqual(h.z2m.bridgeStates(), { z2m1: false });
  assert.equal(parseOnline('{"state":"offline"}'), false);
  assert.equal(parseOnline('{"state":"weird"}'), null);
  assert.equal(parseOnline('garbage'), null);
});

test('a bridge on an unknown base topic becomes a new Zigbee2MQTT instance', async () => {
  const h = await withBridge();
  h.ha.states.set('binary_sensor.zigbee2mqtt_2_bridge_connection_state', { entity_id: 'binary_sensor.zigbee2mqtt_2_bridge_connection_state', state: 'on', attributes: {} });
  h.transport.deliver('zigbee2mqtt_2/bridge/state', 'online');
  // something else that happens to publish bridge/state is not Zigbee2MQTT
  h.transport.deliver('zwave/bridge/state', '{"status":"ready"}');
  await settle();
  assert.equal(h.config.created.length, 1);
  const { c, value, actor } = h.config.created[0];
  assert.equal(c, 'z2m');
  assert.deepEqual(value, { id: 'z2m2', name: 'Z2M #2', baseTopic: 'zigbee2mqtt_2', frontendUrl: null, bridgeEntityId: 'binary_sensor.zigbee2mqtt_2_bridge_connection_state', resendOnRestart: true });
  assert.equal(actor.via, 'system');
  assert.ok(h.transport.subs.includes('zigbee2mqtt_2/#'));
  assert.deepEqual(h.events.filter((e) => e.k === 'z2m.bridge').map((e) => e.p), [{ instanceId: 'z2m2', online: true }]);
  // the retained message arrives again on the instance's own subscription: no second instance
  h.transport.deliver('zigbee2mqtt_2/bridge/state', 'online');
  await settle();
  assert.equal(h.config.created.length, 1);
});

test('the device list yields model, power source and TRV capabilities', async () => {
  const h = await withBridge();
  h.transport.deliver(
    'zigbee2mqtt/bridge/devices',
    JSON.stringify([
      { type: 'Coordinator', ieee_address: '0x00', friendly_name: 'Coordinator' },
      { type: 'EndDevice', ieee_address: '0xa4c1', friendly_name: 'Вітальня/TRV вікно', power_source: 'Battery', definition: { model: 'TRVZB', vendor: 'SONOFF', exposes: SONOFF_TRVZB } },
      { type: 'EndDevice', ieee_address: '0xa4c2', friendly_name: 'Датчик кухня', power_source: 'Battery', definition: { model: 'WSDCGQ11LM', vendor: 'Aqara', exposes: [{ type: 'numeric', property: 'temperature', access: 1 }] } },
    ]),
  );
  const devices = h.z2m.devices('z2m1');
  assert.equal(devices.length, 2);
  const trv = h.z2m.device('z2m1', 'Вітальня/TRV вікно');
  assert.deepEqual([trv.ieee, trv.model, trv.vendor, trv.powerSource], ['0xa4c1', 'TRVZB', 'SONOFF', 'Battery']);
  assert.deepEqual(trv.trv, {
    externalSensor: true,
    calibration: true,
    calibrationRange: [-12.8, 12.7],
    valveLimits: true,
    valvePosition: false,
    childLock: true,
    windowDetection: true,
    setpointRange: [4, 35],
    setpointStep: 0.5,
  });
  assert.equal(h.z2m.device('z2m1', 'Датчик кухня').trv, null);
  assert.equal(trvCapabilities([{ type: 'climate', features: [{ name: 'current_heating_setpoint' }] }]).setpointStep, 0.5);
});

test('device messages: 6-hour link-quality median, battery, last seen, availability', async () => {
  const h = await withBridge();
  const say = (name, msg) => h.transport.deliver(`zigbee2mqtt/${name}`, JSON.stringify(msg));
  say('Вітальня/TRV вікно', { linkquality: 120, battery: 81, local_temperature: 21.5 });
  h.clock.t += 20_000;
  say('Вітальня/TRV вікно', { linkquality: 110 }); // same minute: replaces the sample
  for (const lqi of [54, 60, 48]) {
    h.clock.t += 10 * MIN;
    say('Вітальня/TRV вікно', { linkquality: lqi });
  }
  let link = h.z2m.link('z2m1', 'Вітальня/TRV вікно');
  assert.equal(link.lqiSamples, 4);
  assert.equal(link.lqi, 48);
  assert.equal(link.lqiMedian, 57);
  assert.equal(link.batteryPct, 81);
  assert.equal(link.lastSeenAt, h.clock.now());
  assert.equal(link.available, true);
  // samples older than 6 hours no longer count
  h.clock.t += 6 * HOUR - 15 * MIN;
  say('Вітальня/TRV вікно', { linkquality: 30 });
  link = h.z2m.link('z2m1', 'Вітальня/TRV вікно');
  assert.equal(link.lqiSamples, 3);
  assert.equal(link.lqiMedian, 48);
  h.transport.deliver('zigbee2mqtt/Вітальня/TRV вікно/availability', '{"state":"offline"}');
  assert.equal(h.z2m.link('z2m1', 'Вітальня/TRV вікно').available, false);
  // our own writes and requests are not device reports
  h.transport.deliver('zigbee2mqtt/Датчик кухня/set', '{"linkquality": 1}');
  h.transport.deliver('zigbee2mqtt/bridge/logging', '{"level":"info"}');
  assert.equal(h.z2m.link('z2m1', 'Датчик кухня'), null);
});

test('instances added in the UI are subscribed without a reconnect', async () => {
  const h = await withBridge();
  h.config.z2mList.push({ ...Z2M1, id: 'z2m3', name: 'Гараж', baseTopic: 'garage/z2m' });
  h.bus.emit('config.changed', { entity: 'z2m_instance', id: 'z2m3', op: 'created', actor: null, revision: 3 });
  await settle();
  assert.ok(h.transport.subs.includes('garage/z2m/#'));
  // a nested base topic is matched by the longest prefix
  h.transport.deliver('garage/z2m/bridge/state', 'online');
  assert.deepEqual(h.events.filter((e) => e.k === 'z2m.bridge').map((e) => e.p), [{ instanceId: 'z2m3', online: true }]);
});
