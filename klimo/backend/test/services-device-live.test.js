const assert = require('node:assert/strict');
const test = require('node:test');
const { ACTOR, MIN, openServices } = require('./services-harness');

const HOUR = 60 * MIN;
const CONTACT = 'binary_sensor.zig_contact_window_office';
const BATTERY = 'sensor.zig_contact_window_office_battery';
const IEEE = '0x00158d0001a2b3c4';
const z2m = (friendlyName, ieee) => ({ type: 'z2m', instanceId: 'z2m1', friendlyName, ieee });

/** The office window contact: Aqara on Zigbee2MQTT with a battery entity; its link quality entity is disabled in HA. */
async function office(s, state, ages = {}) {
  const room = await s.config.create('rooms', { name: 'Кабінет' }, ACTOR);
  s.ha.set(CONTACT, state, { device_class: 'window' }, { deviceId: 'dev_office', ...ages });
  s.ha.set(BATTERY, state === 'unavailable' ? 'unavailable' : '87', { device_class: 'battery', unit_of_measurement: '%' }, { deviceId: 'dev_office', ...ages });
  s.search.devices.set(CONTACT, { key: 'dev_office', name: 'zig_contact_window_office', model: 'MCCGQ11LM', manufacturer: 'Aqara', areaId: null, transport: z2m('zig_contact_window_office', IEEE) });
  await s.config.create('sensors', { roomId: room.id, entityId: CONTACT, role: 'contact', contactKind: 'window', name: 'Вікно' }, ACTOR);
  return room;
}

async function withServices(fn) {
  const s = await openServices();
  try {
    await fn(s);
  } finally {
    await s.close();
  }
}

const byKey = (detections) => Object.fromEntries(detections.map((d) => [d.dedupKey, d]));
const row = (s) => s.devices.list().devices.find((d) => d.key === 'dev_office');
const devicePushes = (s) => s.sent.filter((m) => m.type === 'devices');

test('a contact back from «unavailable» is back at once: its row, an engine run, a «recovered» end of the problem and a live update', () =>
  withServices(async (s) => {
    await office(s, 'unavailable', { changedAgoMs: 30 * HOUR, reportedAgoMs: 30 * HOUR });
    const key = `sensor_offline:${CONTACT}`;
    assert.equal(byKey(s.devices.detect(s.clock.now()))[key].active, true);
    let dev = row(s);
    assert.equal(dev.available, false);
    assert.equal(dev.state.code, 'dev.offline');
    assert.equal(dev.lastSeenAt, s.clock.now() - 30 * HOUR);
    s.sent.length = 0;
    s.engine.requested = [];

    // Zigbee2MQTT marks it online again: HA restores the states
    s.clock.advance(MIN);
    s.ha.set(CONTACT, 'off', { device_class: 'window' });
    assert.deepEqual(s.engine.requested, ['device.state'], 'the engine re-evaluates within a second, not on its next pass');
    dev = row(s);
    assert.equal(dev.available, true);
    assert.equal(dev.state.code, 'dev.contact_closed');
    assert.equal(dev.lastSeenAt, s.clock.now());
    assert.deepEqual(dev.problems, []);

    const ended = byKey(s.devices.detect(s.clock.now()))[key];
    assert.equal(ended.active, false);
    assert.equal(ended.recovered, true, 'its incident closes now instead of after the flap guard');
    assert.deepEqual(devicePushes(s).map((m) => m.payload.keys), [['dev_office']]);

    // nothing changed: no further push
    s.devices.detect(s.clock.now());
    assert.equal(devicePushes(s).length, 1);
  }));

test('a silent contact that repeats its value is back through Zigbee2MQTT’s last seen, or through any other entity of the device', () =>
  withServices(async (s) => {
    await office(s, 'off', { reportedAgoMs: 30 * HOUR });
    const key = `sensor_offline:${CONTACT}`;
    assert.equal(byKey(s.devices.detect(s.clock.now()))[key].facts.minutes, 30 * 60);
    assert.equal(row(s).problems[0].type, 'offline');
    s.engine.requested = [];

    // the same «closed» again moves only HA's last_reported, which reaches no subscriber; Zigbee2MQTT hears it
    s.clock.advance(MIN);
    const link = { lqi: null, lqiAt: null, batteryPct: 87, batteryAt: s.clock.now(), lastSeenAt: s.clock.now() };
    s.t.mqtt = { zigbee: () => ({ deviceLink: (instanceId, ieee) => (instanceId === 'z2m1' && ieee === IEEE ? link : null) }) };
    s.bus.emit('z2m.device', { instanceId: 'z2m1', friendlyName: 'zig_contact_window_office', at: s.clock.now() });
    assert.deepEqual(s.engine.requested, ['z2m.device']);
    const ended = byKey(s.devices.detect(s.clock.now()))[key];
    assert.deepEqual([ended.active, ended.recovered], [false, true]);
    assert.equal(row(s).lastSeenAt, s.clock.now());
    assert.equal(s.devices.lastSeen(CONTACT), s.clock.now());

    // without Zigbee2MQTT: a report of another entity of the device (its voltage) is a sign of life as well
    s.t.mqtt = { zigbee: () => ({ deviceLink: () => null }) };
    s.clock.advance(3 * HOUR);
    assert.equal(byKey(s.devices.detect(s.clock.now()))[key].active, true);
    s.ha.set('sensor.zig_contact_window_office_voltage', '3005', { device_class: 'voltage' }, { deviceId: 'dev_office' });
    s.devices.list(); // the next device index picks the sibling up
    s.clock.advance(61 * 1000);
    s.ha.set('sensor.zig_contact_window_office_voltage', '3010', { device_class: 'voltage' }, { deviceId: 'dev_office' });
    assert.equal(byKey(s.devices.detect(s.clock.now()))[key].active, false);
    assert.equal(row(s).lastSeenAt, s.clock.now());
  }));

test('unknown link quality stays unknown — no weak signal; Zigbee2MQTT’s own link quality and battery fill it', () =>
  withServices(async (s) => {
    const room = await s.config.create('rooms', { name: 'Кабінет' }, ACTOR);
    const T = 'sensor.office_temperature';
    s.ha.set(T, '21.4', { device_class: 'temperature', unit_of_measurement: '°C' }, { deviceId: 'dev_office_t' });
    s.search.devices.set(T, { key: 'dev_office_t', name: 'office_t', model: 'SNZB-02D', manufacturer: 'SONOFF', areaId: null, transport: z2m('office_t', '0x0ceff6fffe0001') });
    await s.config.create('sensors', { roomId: room.id, entityId: T, role: 'temperature', name: 'Стіл' }, ACTOR);
    for (let i = 0; i < 4; i++) {
      s.devices.detect(s.clock.now());
      s.clock.advance(5 * MIN);
      s.ha.set(T, String(21.4 + i / 10), { device_class: 'temperature', unit_of_measurement: '°C' }, { deviceId: 'dev_office_t' });
    }
    let dev = s.devices.list().devices.find((d) => d.key === 'dev_office_t');
    assert.deepEqual([dev.lqi, dev.lqiQuality, dev.batteryPct, dev.power.source], [null, null, null, 'mains']);
    assert.deepEqual(dev.problems, []);
    assert.equal(s.devices.list().summary.weakest, null);

    // Zigbee2MQTT reports a weak link three times, five minutes apart
    const link = { lqi: 45, lqiAt: null, batteryPct: 64, batteryAt: null, lastSeenAt: null };
    s.t.mqtt = { zigbee: () => ({ deviceLink: (instanceId, ieee, name) => (name === 'office_t' ? link : null) }) };
    let detections = [];
    for (let i = 0; i < 3; i++) {
      s.clock.advance(5 * MIN);
      Object.assign(link, { lqiAt: s.clock.now(), batteryAt: s.clock.now(), lastSeenAt: s.clock.now() });
      detections = s.devices.detect(s.clock.now());
    }
    // a link quality that is not news adds no sample
    s.clock.advance(5 * MIN);
    s.devices.detect(s.clock.now());
    dev = s.devices.list().devices.find((d) => d.key === 'dev_office_t');
    assert.deepEqual([dev.lqi, dev.lqiQuality, dev.batteryPct, dev.power.source], [45, 'weak', 64, 'battery']);
    assert.equal(dev.problems[0].type, 'weak_signal');
    assert.equal(byKey(detections)['signal:dev_office_t'].facts.lqi, 45);
    const detail = await s.devices.detail('dev_office_t');
    assert.equal(detail.lqi7d.length, 3);
  }));
