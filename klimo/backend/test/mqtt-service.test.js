const assert = require('node:assert/strict');
const test = require('node:test');
const { PUBLISHED_KEY } = require('../dist/mqtt/mqtt.service');
const { FakeTransport, connected, openMqtt, settle, MIN, WED_1910 } = require('./mqtt-harness');

const configs = (log) => log.filter((m) => m.topic.startsWith('homeassistant/') && m.topic.endsWith('/config'));
const tick = (h) => h.bus.emit('engine.tick', { at: h.clock.now(), result: h.engine.last() });

test('on connect: online, subscriptions, every discovery config and every state, retained', async () => {
  const h = await connected();
  const log = h.transport.log;
  assert.deepEqual(log[0], { topic: 'klimo/status', payload: 'online', retain: true, qos: 1 });
  for (const t of ['klimo/command', 'klimo/room/+/+/set', 'klimo/room/+/+/press', 'klimo/house/+/set', 'klimo/house/+/press', 'klimo/resync/press', 'homeassistant/status', '+/bridge/state']) {
    assert.ok(h.transport.subs.includes(t), t);
  }
  assert.ok(!h.transport.subs.includes('klimo/rule/+/set'), 'configuration topics are opt-in');
  const cfgs = configs(log);
  assert.equal(cfgs.length, h.mqtt.status().publishedEntities);
  assert.ok(cfgs.length > 100, `${cfgs.length} configs`);
  assert.ok(cfgs.every((m) => m.retain && m.qos === 1));
  const climate = h.transport.json('homeassistant/climate/klimo_r_9f2a1c/config');
  assert.equal(climate.default_entity_id, 'climate.klimo_vitalnia');
  // states follow their configs and are retained
  const room = h.transport.json('klimo/room/r_9f2a1c/state');
  assert.equal(room.mode, 'auto');
  assert.equal(room.cur, 19.8);
  assert.equal(h.transport.json('klimo/room/r_9f2a1c/card').kv, 'klimo_room');
  assert.equal(h.transport.json('klimo/hub/attrs').kv, 'klimo');
  assert.equal(h.transport.retained.get('klimo/hub/state'), 'heating');
  assert.equal(h.transport.json('klimo/house/state').profile, 'Дома');
  assert.deepEqual(h.transport.json('klimo/reply/attrs'), { kv: 'klimo_reply', v: 1, replies: [] });
  assert.equal(h.transport.json('klimo/source/s_hp/state').state, 'ON');
  assert.equal(h.transport.json('klimo/circuit/c_rad/state').state, 'ON');
  assert.equal(h.transport.retained.get('klimo/circuit/c_spare/state'), undefined, 'no entity reads it, so it is never published');
  const states = log.filter((m) => m.topic.startsWith('klimo/') && m.topic !== 'klimo/status');
  assert.ok(states.every((m) => m.retain));
  const lastConfig = log.findLastIndex((m) => m.topic.endsWith('/config'));
  const firstState = log.findIndex((m) => m.topic === 'klimo/house/state');
  assert.ok(lastConfig < firstState, 'discovery goes out before the states');
  assert.deepEqual(h.events.find((e) => e.k === 'mqtt.connection').p, { connected: true });
  // the published set is remembered for pruning after a restart
  const stored = JSON.parse(await h.kv.kvGet(PUBLISHED_KEY));
  assert.equal(stored.length, cfgs.length);
  const entry = stored.find((e) => e.id === 'climate:klimo_r_9f2a1c_climate');
  assert.deepEqual(entry, { id: 'climate:klimo_r_9f2a1c_climate', config: 'homeassistant/climate/klimo_r_9f2a1c/config', topics: ['klimo/room/r_9f2a1c/state'] });
  assert.equal(h.mqtt.status().publishedEntities, cfgs.length);
  assert.equal(h.history.calls, 1);
});

test('only what changed is published again', async () => {
  const h = await connected();
  h.transport.mark();
  tick(h);
  await h.timers.advance(300);
  assert.deepEqual(h.transport.since(), []);

  h.engine.roomsList[0].tempC = 19.9;
  tick(h);
  await h.timers.advance(300);
  const topics = h.transport.since().map((m) => m.topic);
  assert.ok(topics.includes('klimo/room/r_9f2a1c/state'));
  assert.ok(!topics.includes('klimo/room/r_2b7d0e/state'));
  assert.ok(!topics.some((t) => t.endsWith('/config')));
  assert.equal(h.transport.json('klimo/room/r_9f2a1c/state').cur, 19.9);
});

test('hub and room cards are coalesced to one update per 2 s; the room state is not', async () => {
  const h = await connected();
  await h.timers.advance(5_000);
  h.transport.mark();
  const living = h.engine.roomsList[0];
  living.tempC = 19.9;
  tick(h);
  await h.timers.advance(300);
  living.tempC = 20.0;
  tick(h);
  await h.timers.advance(300);
  const count = (topic) => h.transport.since().filter((m) => m.topic === topic).length;
  assert.equal(count('klimo/room/r_9f2a1c/state'), 2);
  assert.equal(count('klimo/room/r_9f2a1c/card'), 1);
  assert.equal(count('klimo/hub/attrs'), 1);
  await h.timers.advance(2_000);
  assert.equal(count('klimo/room/r_9f2a1c/card'), 2, 'the trailing update carries the latest value');
  assert.equal(count('klimo/hub/attrs'), 2);
  assert.equal(h.transport.json('klimo/room/r_9f2a1c/card').t, 20);
  assert.equal(h.transport.json('klimo/hub/attrs').rooms[0].t, 20);
});

test('sync progress of a room card is never held back', async () => {
  const h = await connected();
  h.engine.roomsList[0].tempC = 19.9;
  tick(h);
  await h.timers.advance(300);
  h.transport.mark();
  h.engine.roomsList[0].sync = { reqId: 'req-9', phase: 'partial', acked: 1, total: 2, attempt: 1, maxAttempts: 3, valueC: 20.5, what: 'trv' };
  tick(h);
  await h.timers.advance(300);
  const card = h.transport.since().filter((m) => m.topic === 'klimo/room/r_9f2a1c/card');
  assert.equal(card.length, 1);
  assert.equal(JSON.parse(card[0].payload).sync.phase, 'partial');
});

test('a card command: evaluation, the room card at once, then the reply and the bus result', async () => {
  const h = await connected();
  h.engine.roomsList[0].tempC = 19.9;
  tick(h);
  await h.timers.advance(300); // the card was just sent: a normal update would now wait 2 s
  h.transport.mark();
  h.engine.lastTickAt = WED_1910 - 1;
  h.engine.roomsList[0].target.displayC = 20.5;
  h.attribution.record('mqtt.publish:req-7', 'u_olia');
  h.transport.deliver('klimo/command', JSON.stringify({ action: 'room.set_target', roomId: 'r_9f2a1c', value: 20.5, duration: 'slot', reqId: 'req-7' }));
  await settle();
  assert.deepEqual(h.engine.runs, ['mqtt.command']);
  const log = h.transport.since();
  const card = log.findIndex((m) => m.topic === 'klimo/room/r_9f2a1c/card');
  const reply = log.findIndex((m) => m.topic === 'klimo/reply/attrs');
  assert.ok(card >= 0 && reply > card, 'the card goes out before the reply');
  const hub = log.findIndex((m) => m.topic === 'klimo/hub/attrs');
  assert.ok(hub >= 0 && hub < reply, 'so does the hub, without waiting for the 2-s window');
  assert.equal(JSON.parse(log[hub].payload).rooms[0].tg, 20.5);
  const attrs = h.transport.json('klimo/reply/attrs');
  assert.equal(attrs.replies.length, 1);
  assert.deepEqual(attrs.replies[0], { reqId: 'req-7', action: 'room.set_target', ok: true, at: WED_1910, code: null, error: null, preview: null, revertToken: 'tok-1' });
  assert.equal(h.transport.retained.get('klimo/reply/state'), 'req-7');
  assert.deepEqual(h.events.find((e) => e.k === 'command.result').p, { reqId: 'req-7', ok: true, code: null, error: null, via: 'card' });
});

test('the reply ring on the broker keeps the last 8 replies', async () => {
  const h = await connected();
  for (let i = 1; i <= 10; i++) {
    h.transport.deliver('klimo/command', JSON.stringify({ action: 'room.preview_target', roomId: 'r_9f2a1c', value: 21, duration: 'slot', reqId: `p-${i}` }));
    await settle();
  }
  const attrs = h.transport.json('klimo/reply/attrs');
  assert.deepEqual(attrs.replies.map((r) => r.reqId), ['p-3', 'p-4', 'p-5', 'p-6', 'p-7', 'p-8', 'p-9', 'p-10']);
  assert.equal(h.engine.runs.length, 0, 'previews never evaluate');
});

test('pruning after a restart: a room deleted while Klimo was down loses its config and its state topics', async () => {
  const gone = [
    { id: 'climate:klimo_r_gone_climate', config: 'homeassistant/climate/klimo_r_gone/config', topics: ['klimo/room/r_gone/state'] },
    { id: 'sensor:klimo_r_gone_temperature', config: 'homeassistant/sensor/klimo_r_gone_temperature/config', topics: ['klimo/room/r_gone/state'] },
    { id: 'sensor:klimo_r_gone_card', config: 'homeassistant/sensor/klimo_r_gone_card/config', topics: ['klimo/room/r_gone/state', 'klimo/room/r_gone/card'] },
    // still exists: must not be touched
    { id: 'climate:klimo_r_9f2a1c_climate', config: 'homeassistant/climate/klimo_r_9f2a1c/config', topics: ['klimo/room/r_9f2a1c/state'] },
  ];
  const h = await connected({ kv: { [PUBLISHED_KEY]: JSON.stringify(gone) } });
  const empties = h.transport.log.filter((m) => m.payload === '').map((m) => [m.topic, m.retain, m.qos]);
  assert.deepEqual(empties.sort(), [
    ['homeassistant/climate/klimo_r_gone/config', true, 1],
    ['homeassistant/sensor/klimo_r_gone_card/config', true, 1],
    ['homeassistant/sensor/klimo_r_gone_temperature/config', true, 1],
    ['klimo/room/r_gone/card', true, 1],
    ['klimo/room/r_gone/state', true, 1],
  ]);
  const stored = JSON.parse(await h.kv.kvGet(PUBLISHED_KEY));
  assert.ok(!stored.some((e) => e.id.includes('r_gone')));
  assert.ok(stored.some((e) => e.id === 'climate:klimo_r_9f2a1c_climate'));
});

test('a room deleted at runtime is removed from HA; a shared state topic stays while others read it', async () => {
  const h = await connected();
  h.transport.mark();
  const kitchen = h.cfg.rooms[4];
  // the kitchen loses its humidity sensor: humidity and dew point go, the room state topic stays
  h.cfg.sensorsByRoom[kitchen.id] = h.cfg.sensorsByRoom[kitchen.id].filter((s) => s.role !== 'humidity');
  // and the last room is deleted altogether
  const removed = h.cfg.rooms.pop();
  h.engine.roomsList = h.engine.roomsList.filter((r) => r.roomId !== removed.id);
  h.bus.emit('config.changed', { entity: 'room', id: removed.id, op: 'deleted', actor: null, revision: 2 });
  await h.timers.advance(300);
  const empties = h.transport.since().filter((m) => m.payload === '').map((m) => m.topic);
  assert.ok(empties.includes(`homeassistant/sensor/klimo_${kitchen.id}_humidity/config`));
  assert.ok(empties.includes(`homeassistant/sensor/klimo_${kitchen.id}_dew_point/config`));
  assert.ok(!empties.includes(`klimo/room/${kitchen.id}/state`));
  assert.ok(empties.includes(`homeassistant/climate/klimo_${removed.id}/config`));
  assert.ok(empties.includes(`klimo/room/${removed.id}/state`));
  assert.ok(empties.includes(`klimo/room/${removed.id}/card`));
  assert.equal(h.transport.retained.has(`klimo/room/${removed.id}/card`), false);
  const stored = JSON.parse(await h.kv.kvGet(PUBLISHED_KEY));
  assert.ok(!stored.some((e) => e.id.includes(removed.id)));
});

test('Home Assistant coming online gets discovery and states again', async () => {
  const h = await connected();
  h.transport.mark();
  h.transport.deliver('homeassistant/status', 'offline');
  await h.timers.advance(300);
  assert.equal(h.transport.since().length, 0);
  h.transport.deliver('homeassistant/status', 'online');
  await h.timers.advance(300);
  const again = h.transport.since();
  assert.equal(configs(again).length, h.mqtt.status().publishedEntities);
  assert.ok(again.some((m) => m.topic === 'klimo/hub/attrs'));
  assert.ok(again.some((m) => m.topic === 'klimo/room/r_9f2a1c/state'));
});

test('a reconnect republishes everything; a disconnect is announced on the bus', async () => {
  const h = await connected();
  h.transport.drop();
  assert.deepEqual(h.events.filter((e) => e.k === 'mqtt.connection').map((e) => e.p.connected), [true, false]);
  h.transport.mark();
  h.transport.connect();
  await settle();
  assert.equal(h.transport.since()[0].topic, 'klimo/status');
  assert.equal(configs(h.transport.since()).length, h.mqtt.status().publishedEntities);
});

test('discovery waits for the first evaluation, so climate modes are right from the start', async () => {
  const h = openMqtt();
  h.engine.hasRun = false;
  await h.mqtt.onApplicationBootstrap();
  h.transport.connect();
  await settle();
  assert.equal(configs(h.transport.log).length, 0);
  assert.ok(h.transport.log.some((m) => m.topic === 'klimo/status'));
  h.engine.hasRun = true;
  h.engine.seasonState = { ...h.engine.seasonState, season: 'neutral' };
  tick(h);
  await h.timers.advance(10);
  assert.deepEqual(h.transport.json('homeassistant/climate/klimo_r_9f2a1c/config').modes, ['off', 'auto', 'heat_cool']);
});

test('season change republishes the climate configs with the new modes', async () => {
  const h = await connected();
  h.transport.mark();
  h.engine.seasonState = { ...h.engine.seasonState, season: 'cooling', houseMode: 'auto' };
  tick(h);
  await h.timers.advance(300);
  const changed = configs(h.transport.since()).map((m) => m.topic);
  assert.ok(changed.includes('homeassistant/climate/klimo_r_9f2a1c/config'));
  assert.ok(!changed.includes('homeassistant/sensor/klimo_r_9f2a1c_temperature/config'));
  assert.deepEqual(h.transport.json('homeassistant/climate/klimo_r_9f2a1c/config').modes, ['off', 'auto', 'cool']);
});

test('asHaStates mirrors what HA would show for the card harness', async () => {
  const h = await connected();
  const states = new Map(h.mqtt.asHaStates().map((s) => [s.entity_id, s]));
  const climate = states.get('climate.klimo_vitalnia');
  assert.equal(climate.state, 'auto');
  assert.equal(climate.attributes.current_temperature, 19.8);
  assert.equal(climate.attributes.temperature, 20);
  assert.deepEqual(climate.attributes.hvac_modes, ['off', 'auto', 'heat']);
  assert.equal(climate.attributes.hvac_action, 'heating');
  assert.equal(climate.attributes.preset_mode, 'Дома');
  assert.equal(climate.attributes.room_id, 'r_9f2a1c');
  assert.equal(climate.attributes.friendly_name, 'Klimo Вітальня');
  assert.equal(states.get('binary_sensor.klimo_vitalnia_heat_demand').state, 'on');
  assert.equal(states.get('binary_sensor.klimo_vitalnia_window').state, 'off');
  assert.deepEqual(states.get('sensor.klimo_vitalnia_target').attributes, {
    friendly_name: 'Klimo Вітальня ціль',
    unit_of_measurement: '°C',
    device_class: 'temperature',
    state_class: 'measurement',
    icon: 'mdi:thermostat',
    lo: null,
    hi: null,
    mode: 'heat',
    source: 'schedule',
    until: h.engine.profileState.scheduledUntil,
  });
  assert.equal(states.get('sensor.klimo_vitalnia_temperature').state, '19.8');
  assert.equal(states.get('sensor.klimo_hub').state, 'heating');
  assert.equal(states.get('sensor.klimo_hub').attributes.kv, 'klimo');
  assert.equal(states.get('sensor.klimo_vitalnia_card').state, 'heat');
  assert.equal(states.get('sensor.klimo_vitalnia_card').attributes.kv, 'klimo_room');
  assert.equal(states.get('sensor.klimo_reply').state, 'unknown');
  assert.equal(states.get('select.klimo_house_profile').state, 'Дома');
  assert.equal(states.get('binary_sensor.klimo_heat_demand').attributes.rooms.length, 3);
  assert.equal(states.get('button.klimo_resync').state, 'unknown');
  h.transport.drop();
  assert.ok(h.mqtt.asHaStates().every((s) => s.state === 'unavailable'));
});

test('exposed entities report the id HA actually uses', async () => {
  const h = await connected();
  h.ha.regs.entities.push({ entity_id: 'climate.living_room', platform: 'mqtt', unique_id: 'klimo_r_9f2a1c_climate' });
  const list = h.mqtt.exposedEntities();
  assert.deepEqual(list.find((e) => e.uniqueId === 'klimo_r_9f2a1c_climate'), { entityId: 'climate.living_room', component: 'climate', role: 'climate', roomId: 'r_9f2a1c', uniqueId: 'klimo_r_9f2a1c_climate' });
  assert.equal(list.find((e) => e.uniqueId === 'klimo_hub').entityId, 'sensor.klimo_hub');
});

/** The real client's shape: idle until started with a broker. */
class FakeBrokerTransport extends FakeTransport {
  constructor() {
    super();
    this.broker = null;
  }
  start(broker) {
    this.broker = broker;
  }
  info() {
    return { started: !!this.broker, broker: this.broker ? `${this.broker.host}:${this.broker.port}` : null, source: this.broker?.source ?? 'none', lastError: null };
  }
}

function withBroker(options) {
  const h = openMqtt();
  const t = new FakeBrokerTransport();
  const { MqttService } = require('../dist/mqtt/mqtt.service');
  const mqtt = new MqttService(t, h.clock, h.bus, h.config, h.ha, { addonVersion: () => '0.1.0', panelPath: () => null, mqttService: async () => options.supervisor ?? null }, h.history, h.kv, h.ports, h.commands, h.z2m);
  mqtt.timers = h.timers;
  mqtt.settings = { prefix: 'homeassistant', broker: { host: options.host, port: options.port, user: undefined, password: undefined, discoveryPrefix: 'homeassistant' } };
  return { ...h, transport: t, mqtt };
}

test('broker: options first, then the Supervisor; dormant with a readable reason otherwise', async () => {
  const none = withBroker({});
  await none.mqtt.onApplicationBootstrap();
  await settle();
  const dormant = none.mqtt.status();
  assert.equal(dormant.configured, false);
  assert.equal(dormant.source, 'none');
  assert.match(dormant.detail, /No MQTT broker found/);
  assert.deepEqual(none.mqtt.detect(), []);

  const sup = withBroker({ supervisor: { host: 'core-mosquitto', port: 1883, username: 'addons', password: 'secret' } });
  await sup.mqtt.onApplicationBootstrap();
  await settle();
  assert.deepEqual(sup.transport.broker, { host: 'core-mosquitto', port: 1883, username: 'addons', password: 'secret', source: 'supervisor' });
  assert.deepEqual(sup.mqtt.status(), { configured: true, connected: false, broker: 'core-mosquitto:1883', source: 'supervisor', detail: 'connecting…', publishedEntities: 0 });

  const opts = withBroker({ host: '192.168.1.5', supervisor: { host: 'core-mosquitto', port: 1883, username: null, password: null } });
  await opts.mqtt.onApplicationBootstrap();
  await settle();
  assert.equal(opts.transport.broker.host, '192.168.1.5');
  assert.equal(opts.transport.broker.port, 1883);
  assert.equal(opts.transport.broker.source, 'options');
});

test('mqtt_offline is raised after 5 minutes without the broker and clears on reconnect', async () => {
  const h = withBroker({ host: 'broker' });
  await h.mqtt.onApplicationBootstrap();
  await settle();
  h.transport.connect();
  await settle();
  assert.equal(h.mqtt.status().detail, 'connected');
  h.transport.drop();
  assert.equal(h.mqtt.status().detail, 'disconnected, retrying…');
  h.clock.t += 4 * MIN;
  assert.equal(h.mqtt.detect()[0].active, false);
  h.clock.t += 2 * MIN;
  const [d] = h.mqtt.detect();
  assert.equal(d.kind, 'mqtt_offline');
  assert.equal(d.dedupKey, 'mqtt_offline');
  assert.equal(d.active, true);
  h.transport.connect();
  await settle();
  assert.equal(h.mqtt.detect()[0].active, false);
});
