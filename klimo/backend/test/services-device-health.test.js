const assert = require('node:assert/strict');
const test = require('node:test');
const { ACTOR, MIN, openServices } = require('./services-harness');
const { DEFAULT_CIRCUIT, DEFAULT_EMITTER, DEFAULT_EMITTER_DEVICE, DEFAULT_TRV_CAPABILITIES, DEFAULT_TRV_SIBLINGS } = require('../dist/shared/defaults');
const { batteryTrend } = require('../dist/engine/services/device-health.service');

const DAY = 24 * 60 * MIN;
const z2m = (friendlyName) => ({ type: 'z2m', instanceId: 'z2m1', friendlyName, ieee: `0x${friendlyName}` });

function device(s, entityId, key, model, extra = {}) {
  s.search.devices.set(entityId, { key, name: key, model, manufacturer: extra.manufacturer ?? 'SONOFF', areaId: null, transport: z2m(key) });
}

/** Коридор (a sensor on a flat battery), Кухня (three sensors, one silent for 100 min) and Ванна (a TRV with a weak link). */
async function house(s) {
  const hall = await s.config.create('rooms', { name: 'Коридор' }, ACTOR);
  const kitchen = await s.config.create('rooms', { name: 'Кухня' }, ACTOR);
  const bath = await s.config.create('rooms', { name: 'Ванна' }, ACTOR);

  s.ha.set('sensor.hall_temperature', '19.1', { device_class: 'temperature', unit_of_measurement: '°C' }, { deviceId: 'dev_hall', reportedAgoMs: 8 * MIN });
  s.ha.set('sensor.hall_battery', '12', { device_class: 'battery', unit_of_measurement: '%' }, { deviceId: 'dev_hall', reportedAgoMs: 8 * MIN });
  s.ha.set('sensor.hall_linkquality', '92', {}, { deviceId: 'dev_hall', reportedAgoMs: 8 * MIN });
  device(s, 'sensor.hall_temperature', 'dev_hall', 'SNZB-02');
  await s.config.create('sensors', { roomId: hall.id, entityId: 'sensor.hall_temperature', role: 'temperature', name: 'Вхід' }, ACTOR);

  for (const [i, [id, key, model, ago]] of [
    ['sensor.kitchen_shelf_temperature', 'dev_shelf', 'WSDCGQ11LM', 100 * MIN],
    ['sensor.kitchen_island_temperature', 'dev_island', 'SNZB-02D', 3 * MIN],
    ['sensor.kitchen_window_temperature', 'dev_kwin', 'WSDCGQ11LM', 22 * MIN],
  ].entries()) {
    s.ha.set(id, '20.9', { device_class: 'temperature' }, { deviceId: key, reportedAgoMs: ago });
    s.ha.set(`sensor.${key}_battery`, '70', { device_class: 'battery' }, { deviceId: key, reportedAgoMs: ago });
    device(s, id, key, model, { manufacturer: model.startsWith('WSD') ? 'Aqara' : 'SONOFF' });
    await s.config.create('sensors', { roomId: kitchen.id, entityId: id, role: 'temperature', name: ['Полиця', 'Острів', 'Біля вікна'][i], order: i }, ACTOR);
  }

  const circuit = await s.config.create('circuits', { ...DEFAULT_CIRCUIT(), name: 'Тепла підлога', kind: 'floor' }, ACTOR);
  const emitter = await s.config.create('emitters', { ...DEFAULT_EMITTER(), roomId: bath.id, kind: 'towel_rail', name: 'Рушникосушка', circuitId: circuit.id, roles: { heat: 'primary', cool: null } }, ACTOR);
  s.ha.set('climate.bathroom_towel_trv', 'heat', { current_temperature: 23 }, { deviceId: 'dev_towel', reportedAgoMs: 6 * MIN });
  s.ha.set('sensor.towel_battery', '41', { device_class: 'battery' }, { deviceId: 'dev_towel', reportedAgoMs: 6 * MIN });
  s.ha.set('sensor.towel_linkquality', '54', {}, { deviceId: 'dev_towel', reportedAgoMs: 6 * MIN });
  device(s, 'climate.bathroom_towel_trv', 'dev_towel', 'TRVZB');
  const trv = await s.config.create(
    'emitterDevices',
    {
      ...DEFAULT_EMITTER_DEVICE(),
      emitterId: emitter.id,
      roomId: bath.id,
      kind: 'trv',
      entityId: 'climate.bathroom_towel_trv',
      name: 'Рушникосушка',
      label: 'рушникосушка',
      transport: z2m('dev_towel'),
      capabilities: { ...DEFAULT_TRV_CAPABILITIES, externalSensor: true },
      siblings: { ...DEFAULT_TRV_SIBLINGS, battery: 'sensor.towel_battery', linkquality: 'sensor.towel_linkquality' },
    },
    ACTOR,
  );
  return { hall, kitchen, bath, trv };
}

async function withHouse(fn) {
  const s = await openServices();
  try {
    await fn(s, await house(s));
  } finally {
    await s.close();
  }
}

const byKey = (detections) => Object.fromEntries(detections.map((d) => [d.dedupKey, d]));

test('a battery at 12 % raises battery_low; it resolves only above the resolve threshold', () =>
  withHouse(async (s) => {
    let d = byKey(s.devices.detect(s.clock.now()));
    const low = d['battery:dev_hall'];
    assert.equal(low.kind, 'battery_low');
    assert.equal(low.active, true);
    assert.equal(low.deviceKey, 'dev_hall');
    assert.equal(low.facts.pct, 12);
    assert.equal(low.facts.batteryType, 'CR2450');
    assert.equal(d['battery:dev_towel'], undefined);

    // between the low and the resolve threshold nothing changes
    s.ha.set('sensor.hall_battery', '22', { device_class: 'battery' });
    s.clock.advance(MIN);
    d = byKey(s.devices.detect(s.clock.now()));
    assert.equal(d['battery:dev_hall'].active, true);

    s.ha.set('sensor.hall_battery', '96', { device_class: 'battery' });
    s.clock.advance(MIN);
    d = byKey(s.devices.detect(s.clock.now()));
    assert.equal(d['battery:dev_hall'].active, false);
    // the inactive report repeats for the flap guard, then stops
    s.clock.advance(11 * MIN);
    d = byKey(s.devices.detect(s.clock.now()));
    assert.equal(d['battery:dev_hall'], undefined);
  }));

test('a link quality median of 54 over three samples raises signal_weak; it clears at 65', () =>
  withHouse(async (s) => {
    const weakAfter = () => byKey(s.devices.detect(s.clock.now()))['signal:dev_towel'];
    assert.equal(weakAfter(), undefined); // one sample is not a trend
    s.clock.advance(5 * MIN);
    assert.equal(weakAfter(), undefined);
    s.clock.advance(5 * MIN);
    const weak = weakAfter();
    assert.equal(weak.active, true);
    assert.equal(weak.facts.lqi, 54);
    assert.equal(weak.roomId, s.config.engineConfig().rooms.find((r) => r.name === 'Ванна').id);

    s.ha.set('sensor.towel_linkquality', '70', {}, { deviceId: 'dev_towel' });
    for (let i = 0; i < 3; i++) {
      s.clock.advance(5 * MIN);
      assert.equal(weakAfter().active, true);
    }
    s.clock.advance(5 * MIN);
    assert.equal(weakAfter().active, false);
  }));

test('weak signal is not reported on its own while the device has another problem', () =>
  withHouse(async (s) => {
    s.ha.set('sensor.hall_linkquality', '40', {}, { deviceId: 'dev_hall' });
    for (let i = 0; i < 3; i++) {
      s.clock.advance(5 * MIN);
      s.devices.detect(s.clock.now());
    }
    const d = byKey(s.devices.detect(s.clock.now()));
    assert.equal(d['battery:dev_hall'].active, true);
    assert.equal(d['signal:dev_hall'], undefined);
  }));

test('a battery sensor silent for longer than its class allows is offline; two of three still count', () =>
  withHouse(async (s, { kitchen }) => {
    const d = byKey(s.devices.detect(s.clock.now()));
    const off = d['sensor_offline:sensor.kitchen_shelf_temperature'];
    assert.equal(off.kind, 'sensor_offline');
    assert.equal(off.roomId, kitchen.id);
    assert.equal(off.deviceKey, 'dev_shelf');
    assert.deepEqual(off.facts, { entityId: 'sensor.kitchen_shelf_temperature', name: 'Полиця', minutes: 100, left: 2, total: 3 });
    assert.equal(d['sensor_offline:sensor.kitchen_window_temperature'], undefined);

    s.ha.set('sensor.kitchen_shelf_temperature', '20.8', { device_class: 'temperature' }, { deviceId: 'dev_shelf' });
    s.clock.advance(MIN);
    assert.equal(byKey(s.devices.detect(s.clock.now()))['sensor_offline:sensor.kitchen_shelf_temperature'].active, false);

    // the room's notification toggle silences it
    await s.config.update('rooms', kitchen.id, { notify: { sensorStale: false } }, ACTOR);
    s.ha.set('sensor.kitchen_island_temperature', 'unavailable', {}, { deviceId: 'dev_island', changedAgoMs: 120 * MIN });
    assert.equal(byKey(s.devices.detect(s.clock.now()))['sensor_offline:sensor.kitchen_island_temperature'], undefined);
  }));

test('a temperature + humidity sensor gone quiet is one problem, told by its temperature entity', () =>
  withHouse(async (s, { kitchen }) => {
    s.ha.set('sensor.kitchen_shelf_humidity', '49', { device_class: 'humidity' }, { deviceId: 'dev_shelf', reportedAgoMs: 100 * MIN });
    device(s, 'sensor.kitchen_shelf_humidity', 'dev_shelf', 'WSDCGQ11LM', { manufacturer: 'Aqara' });
    await s.config.create('sensors', { roomId: kitchen.id, entityId: 'sensor.kitchen_shelf_humidity', role: 'humidity', name: 'Полиця', order: 0 }, ACTOR);
    const offline = s.devices.detect(s.clock.now()).filter((d) => d.kind === 'sensor_offline' && d.active);
    assert.deepEqual(offline.map((d) => d.dedupKey), ['sensor_offline:sensor.kitchen_shelf_temperature']);
  }));

test('a bound entity gone from HA for five minutes is entity_missing; a Zigbee2MQTT bridge offline for a minute is z2m_offline', () =>
  withHouse(async (s) => {
    await s.config.create('z2m', { name: 'Z2M #1', baseTopic: 'zigbee2mqtt', frontendUrl: 'http://z2m.local/', bridgeEntityId: null, resendOnRestart: true }, ACTOR);
    const inst = s.config.list('z2m')[0];
    s.ha.remove('sensor.kitchen_window_temperature');
    s.t.bridges = { [inst.id]: false };
    let d = byKey(s.devices.detect(s.clock.now()));
    assert.equal(d['entity_missing:sensor.kitchen_window_temperature'], undefined);
    assert.equal(d[`z2m_offline:${inst.id}`], undefined);
    s.clock.advance(61_000);
    d = byKey(s.devices.detect(s.clock.now()));
    assert.equal(d[`z2m_offline:${inst.id}`].active, true);
    assert.equal(d[`z2m_offline:${inst.id}`].facts.name, 'Z2M #1');
    s.clock.advance(5 * MIN);
    d = byKey(s.devices.detect(s.clock.now()));
    assert.equal(d['entity_missing:sensor.kitchen_window_temperature'].active, true);
    s.t.bridges = { [inst.id]: true };
    assert.equal(byKey(s.devices.detect(s.clock.now()))[`z2m_offline:${inst.id}`].active, false);

    // with HA away nothing is concluded
    s.ha.connected = false;
    assert.deepEqual(s.devices.detect(s.clock.now()), []);
  }));

test('the device list groups entities per HA device and puts problems first', () =>
  withHouse(async (s, { hall, bath, trv }) => {
    for (let i = 0; i < 3; i++) {
      s.devices.detect(s.clock.now());
      s.clock.advance(5 * MIN);
    }
    const { summary, devices } = s.devices.list();
    assert.equal(summary.total, 5);
    assert.deepEqual(summary.byKind, { trv: 1, sensor: 4, window: 0, relay: 0, pump: 0, source: 0, entity: 0 });
    assert.equal(summary.attention, 3);
    assert.deepEqual(summary.attentionTypes, ['offline', 'battery_low', 'weak_signal']);
    assert.deepEqual(summary.lowestBattery, { pct: 12, deviceKey: 'dev_hall' });
    assert.deepEqual(summary.weakest, { lqi: 54, deviceKey: 'dev_towel' });
    assert.deepEqual(devices.slice(0, 3).map((d) => d.key), ['dev_shelf', 'dev_towel', 'dev_hall']);

    const hallDev = devices.find((d) => d.key === 'dev_hall');
    assert.equal(hallDev.kind, 'sensor');
    assert.equal(hallDev.name, 'Вхід');
    assert.equal(hallDev.roomId, hall.id);
    assert.equal(hallDev.location, 'room');
    assert.deepEqual(hallDev.entityIds, ['sensor.hall_temperature', 'sensor.hall_battery', 'sensor.hall_linkquality']);
    assert.deepEqual(hallDev.power, { source: 'battery', batteryType: 'CR2450' });
    assert.equal(hallDev.batteryPct, 12);
    assert.equal(hallDev.lqi, 92);
    assert.equal(hallDev.lqiQuality, 'medium');
    assert.deepEqual(hallDev.state, { code: 'dev.reading', params: { value: 19.1, unit: '°C' } });
    assert.deepEqual(hallDev.problems.map((p) => [p.type, p.severity, p.hint]), [['battery_low', 'warn', { code: 'hint.battery_type', params: { type: 'CR2450' } }]]);
    assert.deepEqual(hallDev.usage, [{ type: 'room', id: hall.id, label: 'Коридор' }]);
    assert.equal(hallDev.z2mUrl, null);

    const shelf = devices.find((d) => d.key === 'dev_shelf');
    assert.equal(shelf.problems[0].type, 'offline');
    assert.deepEqual(shelf.problems[0].hint, { code: 'hint.aqara_rejoin' });
    assert.deepEqual(shelf.problems[0].actions, ['exclude_from_room', 'snooze']);

    const towel = devices.find((d) => d.key === 'dev_towel');
    assert.equal(towel.kind, 'trv');
    assert.equal(towel.label, 'рушникосушка');
    assert.equal(towel.roomId, bath.id);
    assert.equal(towel.problems[0].type, 'weak_signal');
    // the TRV's sync state from the engine turns into a confirmation problem
    s.setRoom(bath.id, { trvs: [{ deviceId: trv.id, emitterId: trv.emitterId, entityId: trv.entityId, name: 'Рушникосушка', activity: 'heating', commandedSetpointC: 24, reportedSetpointC: 22, localTempC: 23, deltaToRoomC: null, valvePct: null, externalTempSentC: null, batteryPct: 41, lqi: 54, lastSeenAt: null, available: true, sync: { status: 'retrying', attempt: 2, maxAttempts: 3, commandId: 'c', reqId: null, sentAt: s.clock.now(), confirmedAt: null } }] });
    const again = s.devices.list('trv').devices[0];
    assert.deepEqual(again.problems.map((p) => [p.type, p.hint.code, p.facts.attempt, p.facts.of]), [['trv_unconfirmed', 'hint.add_router', 2, 3]]);
    assert.deepEqual(again.state, { code: 'dev.trv_heating', params: { setpointC: 24, valvePct: null } });

    assert.equal(s.devices.list('problems').devices.length, 3);
    assert.deepEqual(s.devices.list('all', 'полиця').devices.map((d) => d.key), ['dev_shelf']);
    assert.deepEqual(s.devices.list(undefined, 'kitchen_island').devices.map((d) => d.key), ['dev_island']);

    // an ignored device keeps its row but has no problems and raises nothing
    await s.config.setDeviceMeta('dev_hall', { ignored: true }, ACTOR);
    const ignored = s.devices.list().devices.find((d) => d.key === 'dev_hall');
    assert.equal(ignored.ignored, true);
    assert.deepEqual(ignored.problems, []);
    assert.equal(byKey(s.devices.detect(s.clock.now()))['battery:dev_hall'].active, false);
  }));

test('«Замінити сутність» rebinds the configuration to the new entity', () =>
  withHouse(async (s, { hall }) => {
    s.ha.set('sensor.hall_temperature_2', '19.3', { device_class: 'temperature' }, { deviceId: 'dev_hall2' });
    device(s, 'sensor.hall_temperature_2', 'dev_hall2', 'SNZB-02D');
    const dev = await s.devices.replace('dev_hall', { oldEntityId: 'sensor.hall_temperature', newEntityId: 'sensor.hall_temperature_2' }, ACTOR);
    assert.equal(dev.key, 'dev_hall2');
    const sensor = s.config.engineConfig().sensorsByRoom[hall.id][0];
    assert.equal(sensor.entityId, 'sensor.hall_temperature_2');
    assert.equal(sensor.model, 'SNZB-02D');
    assert.equal(sensor.haDeviceId, 'dev_hall2');
    assert.equal(sensor.name, 'Вхід');
    await assert.rejects(() => s.devices.replace('dev_hall2', { oldEntityId: 'sensor.other', newEntityId: 'sensor.hall_temperature' }, ACTOR), (e) => e.code === 'validation');
    await assert.rejects(() => s.devices.replace('dev_hall2', { oldEntityId: 'sensor.hall_temperature_2', newEntityId: 'switch.hall' }, ACTOR), (e) => e.issues[0].code === 'domain');
  }));

test('device detail: 7-day battery and outages from the recorder; days of battery left from a 21-day trend', () =>
  withHouse(async (s) => {
    const now = s.clock.now();
    s.t.series = (q) =>
      q.ids.map((entityId) => {
        if (entityId === 'sensor.hall_battery') {
          const days = q.to - q.from > 10 * DAY ? 21 : 7;
          return { entityId, unit: '%', points: Array.from({ length: days + 1 }, (_, i) => [q.from + i * DAY, 12 + (days - i)]) };
        }
        if (entityId === 'sensor.hall_temperature') {
          return { entityId, unit: '°C', points: [[now - 3 * DAY, 19], [now - 2 * DAY, null], [now - 2 * DAY + 90 * MIN, 19.2]], states: [[now - 3 * DAY, '19'], [now - 2 * DAY, 'unavailable'], [now - 2 * DAY + 90 * MIN, '19.2']] };
        }
        return { entityId, unit: null, points: [] };
      });
    await s.devices.refreshBatteryEstimates();
    const detail = await s.devices.detail('dev_hall');
    assert.equal(detail.device.batteryEstDays, 12);
    assert.equal(detail.battery7d.length, 8);
    assert.deepEqual(detail.availability7d, [{ from: now - 2 * DAY, to: now - 2 * DAY + 90 * MIN }]);
    assert.deepEqual(detail.trvLog, []);
    assert.equal(await s.devices.detail('nope'), null);

    const trend = batteryTrend([[0, 40], [DAY, 39], [2 * DAY, 38.5], [3 * DAY, 37]]);
    assert.ok(trend.slopePerDay < -0.9 && trend.slopePerDay > -1.1);
    assert.ok(trend.r2 > 0.9);
    assert.equal(batteryTrend([[0, 40], [DAY, 40]]), null);
  }));

test('«Повторити зараз» re-sends what the engine wants for the device', () =>
  withHouse(async (s) => {
    assert.equal(s.devices.resend('dev_towel', ACTOR), 1);
    assert.deepEqual(s.engine.resent, [{ deviceKey: 'dev_towel' }]);
    assert.throws(() => s.devices.resend('nope', ACTOR), (e) => e.code === 'not_found');
  }));

test('two inputs of one trigger are named from Home Assistant, not both after the trigger', () =>
  withHouse(async (s) => {
    const ids = ['binary_sensor.grid_offline', 'binary_sensor.grid_phase_b'];
    await s.config.create(
      'triggers',
      { name: 'Блекаут', enabled: true, condition: { op: 'any', items: ids.map((entityId) => ({ op: 'state', entityId, equals: ['on'] })) } },
      ACTOR,
    );
    s.ha.set(ids[0], 'unavailable', { friendly_name: 'Мережа' }, { changedAgoMs: 60 * MIN });
    s.ha.set(ids[1], 'unavailable', { friendly_name: 'Фаза B' }, { changedAgoMs: 60 * MIN });
    const d = byKey(s.devices.detect(s.clock.now()));
    const facts = ids.map((id) => d[`entity_unavailable:${id}`]?.facts);
    assert.ok(facts.every(Boolean), 'both inputs are unavailable');
    // the trigger's name would make both alerts read «Блекаут: недоступно»
    assert.deepEqual(facts.map((f) => f.name), ['', '']);
    const rows = s.devices.list().devices.filter((x) => ids.includes(x.primary?.entityId ?? x.entityIds[0]));
    assert.deepEqual(rows.map((x) => x.name).sort(), ['Мережа', 'Фаза B']);
  }));

test('a head set up before its sensor switch was recognised gets it filled in; what it has is never replaced', () =>
  withHouse(async (s, { trv }) => {
    s.search.details.set('climate.bathroom_towel_trv', {
      trv: {
        siblings: { ...DEFAULT_TRV_SIBLINGS, sensorSelect: 'select.bathroom_towel_trv_sensor', externalTemp: 'number.towel_external', battery: 'sensor.other_battery' },
      },
    });
    await s.devices.completeTrvSiblings();
    const after = s.config.get('emitterDevices', trv.id).siblings;
    assert.equal(after.sensorSelect, 'select.bathroom_towel_trv_sensor');
    assert.equal(after.externalTemp, 'number.towel_external');
    assert.equal(after.battery, 'sensor.towel_battery', 'a sibling already set stays');
    assert.equal(after.linkquality, 'sensor.towel_linkquality');
    // nothing new: no write
    const rev = s.config.revision();
    await s.devices.completeTrvSiblings();
    assert.equal(s.config.revision(), rev);
  }));
