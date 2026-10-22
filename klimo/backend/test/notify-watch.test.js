const assert = require('node:assert/strict');
const test = require('node:test');
const { ACTOR, MIN, kyiv, FakeClock, openNotify } = require('./notify-harness');
const { DEFAULT_ROOM, DEFAULT_SENSOR, newSourceConfig } = require('../dist/shared/defaults');

async function source(h, kind, name, adapter) {
  const base = newSourceConfig(kind, { id: '', name, now: 0 });
  delete base.id;
  return h.config.create('sources', { ...base, adapter: { ...base.adapter, ...adapter } }, ACTOR);
}

async function plant(h) {
  const hp = await source(h, 'heat_pump', 'Тепловий насос', { climate: 'climate.heat_pump' });
  const boiler = await source(h, 'gas_boiler', 'Газовий котел', { type: 'relay', command: 'switch.boiler_relay', confirm: { kind: 'entity_on', entityId: 'binary_sensor.boiler_flame' } });
  const room = await h.config.create('rooms', { ...DEFAULT_ROOM(), name: 'Кухня', slug: 'kukhnia' }, ACTOR);
  const { id: _a, ...sensor } = DEFAULT_SENSOR();
  await h.config.create('sensors', { ...sensor, roomId: room.id, entityId: 'sensor.kitchen_shelf_temperature', role: 'temperature', name: 'На полиці' }, ACTOR);
  await h.config.create('sensors', { ...sensor, roomId: room.id, entityId: 'sensor.kitchen_door_temperature', role: 'temperature', name: 'Біля дверей', order: 1 }, ACTOR);
  await h.config.create('sensors', { ...sensor, roomId: room.id, entityId: 'binary_sensor.kitchen_window', role: 'contact', contactKind: 'window', name: 'Вікно', order: 2 }, ACTOR);
  const settings = h.config.singleton('settings');
  await h.config.patchSingleton('settings', { outdoor: { ...settings.outdoor, sensorEntityIds: ['sensor.outdoor_temperature'] } }, ACTOR);
  await h.config.create('z2m', { name: 'Z2M #1', baseTopic: 'zigbee2mqtt', frontendUrl: null, bridgeEntityId: 'binary_sensor.zigbee2mqtt_bridge_connection_state', resendOnRestart: true }, ACTOR);
  return { hp, boiler, room };
}

test('rules derived from what Klimo uses, one per entity with role thresholds', async () => {
  const h = await openNotify();
  try {
    const { hp, boiler, room } = await plant(h);
    const rules = new Map(h.watch.rules().map((r) => [r.entityId, r]));
    assert.deepEqual(rules.get('climate.heat_pump').condition, { type: 'unavailable', forMin: hp.guards.unavailableAfterMin });
    assert.equal(rules.get('climate.heat_pump').severity, 'critical');
    assert.equal(rules.get('climate.heat_pump').eventKind, 'source_unavailable');
    assert.equal(rules.get('climate.heat_pump').id, 'auto:climate.heat_pump');
    assert.equal(rules.get('switch.boiler_relay').role, 'source.reserve_relay');
    assert.deepEqual(rules.get('switch.boiler_relay').ref, { sourceId: boiler.id });
    assert.equal(rules.get('binary_sensor.boiler_flame').condition.type, 'no_confirmation_after_demand');
    assert.equal(rules.get('binary_sensor.boiler_flame').eventKind, 'source_failed');
    assert.deepEqual(rules.get('sensor.outdoor_temperature').condition, { type: 'stale', noUpdateMin: 30 });
    assert.deepEqual(rules.get('sensor.kitchen_shelf_temperature').condition, { type: 'stale', noUpdateMin: 90 });
    assert.equal(rules.get('sensor.kitchen_shelf_temperature').name, 'Кухня · На полиці');
    assert.deepEqual(rules.get('sensor.kitchen_shelf_temperature').ref, { roomId: room.id });
    assert.deepEqual(rules.get('binary_sensor.kitchen_window').condition, { type: 'unavailable', forMin: 120 });
    assert.deepEqual(rules.get('binary_sensor.zigbee2mqtt_bridge_connection_state').condition, { type: 'offline', forMin: 1 });

    await h.settings({ watchAllUsedEntities: false });
    assert.equal(h.watch.rules().length, 0);
  } finally {
    await h.close();
  }
});

test('watch detections: thresholds, dedup keys shared with device health, and the clear edge', async () => {
  const h = await openNotify();
  try {
    const { hp, boiler, room } = await plant(h);
    h.engine.plantData = { sources: [], lead: { heat: boiler.id, cool: null } };
    h.ha.set('climate.heat_pump', 'unavailable', {}, { changedAgoMs: 2 * MIN });
    h.ha.set('sensor.kitchen_shelf_temperature', '20.9', { unit_of_measurement: '°C' }, { reportedAgoMs: 100 * MIN });
    h.ha.set('sensor.kitchen_door_temperature', '21.1', { unit_of_measurement: '°C' }, { reportedAgoMs: 2 * MIN });
    h.ha.set('binary_sensor.kitchen_window', 'off', { device_class: 'window' });
    h.ha.set('sensor.outdoor_temperature', '4.2', { unit_of_measurement: '°C' }, { reportedAgoMs: 3 * MIN });
    h.ha.set('binary_sensor.zigbee2mqtt_bridge_connection_state', 'on');
    h.ha.set('switch.boiler_relay', 'off');

    let ds = h.watch.watchDetections(h.clock.now());
    assert.deepEqual(ds.map((d) => d.dedupKey), ['sensor_offline:sensor.kitchen_shelf_temperature']);
    const s = ds[0];
    assert.equal(s.kind, 'sensor_offline');
    assert.equal(s.roomId, room.id);
    assert.deepEqual(s.facts, { entityId: 'sensor.kitchen_shelf_temperature', minutes: 100, name: 'На полиці', lastAt: h.clock.now() - 100 * MIN, total: 2, left: 1 });

    h.clock.advance(2 * MIN);
    ds = h.watch.watchDetections(h.clock.now());
    const src = ds.find((d) => d.kind === 'source_unavailable');
    assert.equal(src.dedupKey, `source_unavailable:${hp.id}`);
    assert.equal(src.severity, 'critical');
    assert.equal(src.facts.fallbackId, boiler.id);
    assert.equal(src.facts.minutes, 4);

    // through the incident pipeline it becomes the message people get
    h.incidents.ingest(ds, h.clock.now());
    await h.router.idle();
    const inc = h.incidents.list({ scope: 'all' }).find((i) => i.kind === 'source_unavailable');
    assert.equal(h.texts.incident(inc).body, 'climate.heat_pump недоступний 4 хв. Опалення перейшло на Газовий котел — у кімнатах тепло.');

    // fixed: one inactive detection, then silence
    h.ha.set('climate.heat_pump', 'heat');
    ds = h.watch.watchDetections(h.clock.now());
    assert.deepEqual(ds.filter((d) => !d.active).map((d) => d.dedupKey), [`source_unavailable:${hp.id}`]);
    ds = h.watch.watchDetections(h.clock.now());
    assert.equal(ds.filter((d) => !d.active).length, 0);

    // a muted (stored) auto rule raises nothing; the room's own switch silences its sensors
    const derived = h.watch.rules().find((r) => r.entityId === 'sensor.kitchen_shelf_temperature');
    await h.config.create('watchRules', { ...derived, muted: true }, ACTOR);
    assert.equal(h.watch.watchDetections(h.clock.now()).filter((d) => d.active).length, 0);

    // with HA away nothing is concluded
    h.ha.connected = false;
    assert.deepEqual(h.watch.watchDetections(h.clock.now()), []);
  } finally {
    await h.close();
  }
});

test('a temperature + humidity sensor gone quiet raises one detection, for its temperature entity', async () => {
  const h = await openNotify();
  try {
    const { room } = await plant(h);
    const { id: _a, ...sensor } = DEFAULT_SENSOR();
    for (const id of ['sensor.kitchen_shelf_temperature', 'sensor.kitchen_door_temperature']) await h.config.update('sensors', h.config.list('sensors').find((x) => x.entityId === id).id, { haDeviceId: id.includes('shelf') ? 'dev_shelf' : 'dev_door' }, ACTOR);
    await h.config.create('sensors', { ...sensor, roomId: room.id, entityId: 'sensor.kitchen_shelf_humidity', role: 'humidity', name: 'На полиці', haDeviceId: 'dev_shelf', order: 3 }, ACTOR);
    h.ha.set('sensor.kitchen_shelf_temperature', '20.9', { unit_of_measurement: '°C' }, { reportedAgoMs: 100 * MIN });
    h.ha.set('sensor.kitchen_shelf_humidity', '49', { unit_of_measurement: '%' }, { reportedAgoMs: 100 * MIN });
    h.ha.set('sensor.kitchen_door_temperature', '21.1', { unit_of_measurement: '°C' }, { reportedAgoMs: 2 * MIN });
    h.ha.set('sensor.outdoor_temperature', '4.2', { unit_of_measurement: '°C' }, { reportedAgoMs: 3 * MIN });
    let keys = h.watch.watchDetections(h.clock.now()).filter((d) => d.kind === 'sensor_offline' && d.active).map((d) => d.dedupKey);
    assert.deepEqual(keys, ['sensor_offline:sensor.kitchen_shelf_temperature']);
    // only the humidity entity silent: it speaks for itself
    h.ha.set('sensor.kitchen_shelf_temperature', '20.9', { unit_of_measurement: '°C' });
    keys = h.watch.watchDetections(h.clock.now()).filter((d) => d.kind === 'sensor_offline' && d.active).map((d) => d.dedupKey);
    assert.deepEqual(keys, ['sensor_offline:sensor.kitchen_shelf_humidity']);
  } finally {
    await h.close();
  }
});

test('the watch list: live status, last outage, filters and search', async () => {
  const h = await openNotify();
  try {
    await plant(h);
    h.ha.set('climate.heat_pump', 'unavailable', {}, { changedAgoMs: 12 * MIN });
    h.ha.set('sensor.kitchen_shelf_temperature', '20.9', { unit_of_measurement: '°C' }, { reportedAgoMs: 3 * MIN });
    h.ha.set('binary_sensor.kitchen_window', 'off', { device_class: 'window' });
    let list = h.notify.watchRules('problems');
    const hp = list.find((r) => r.entityId === 'climate.heat_pump');
    assert.equal(hp.status.tone, 'err');
    assert.equal(hp.status.text.code, 'dev.offline');

    h.ha.set('climate.heat_pump', 'heat');
    list = h.notify.watchRules('all');
    const back = list.find((r) => r.entityId === 'climate.heat_pump');
    assert.equal(back.status.tone, 'ok');
    assert.equal(back.status.lastOutageMin, 12);
    const sensor = list.find((r) => r.entityId === 'sensor.kitchen_shelf_temperature');
    assert.deepEqual(sensor.status.text, { code: 'dev.reading', params: { value: 20.9, unit: '°C' } });
    assert.equal(list.find((r) => r.entityId === 'binary_sensor.kitchen_window').status.text.code, 'dev.contact_closed');
    // the flame sensor only matters while the boiler is asked to run
    const flame = list.find((r) => r.entityId === 'binary_sensor.boiler_flame');
    assert.equal(flame.status.tone, 'idle');
    assert.deepEqual(flame.status.text, { code: 'source.detail.idle' });

    assert.deepEqual(h.notify.watchRules('all', 'полиці').map((r) => r.entityId), ['sensor.kitchen_shelf_temperature']);
    await h.config.create('watchRules', { origin: 'manual', entityId: 'sensor.cellar_temperature', name: 'Підвал', role: 'manual', ref: null, condition: { type: 'stale', noUpdateMin: 60 }, severity: 'warning', eventKind: 'sensor_offline', muted: false }, ACTOR);
    assert.deepEqual(h.notify.watchRules('manual').map((r) => r.name), ['Підвал']);
  } finally {
    await h.close();
  }
});

test('daily summary: runtime and starts per source, rooms, problems and yesterday', async () => {
  const h = await openNotify({ clock: new FakeClock(kyiv(2026, 10, 21, 21, 0)) });
  try {
    const { hp } = await plant(h);
    await h.target({ name: 'Мій телефон', service: 'notify.mobile_app_phone', isPrimary: true });
    const me = await h.target({ channel: 'telegram', name: 'Особистий', icon: 'send', chatId: '1001' });
    await h.settings({ telegram: { mode: 'integration', haService: null, botUsername: null } });
    const run = (from, to) => [
      { subject: 'source', subjectId: hp.id, kind: 'run', mode: 'heat', edge: 'start', at: from },
      { subject: 'source', subjectId: hp.id, kind: 'run', mode: 'heat', edge: 'end', at: to },
    ];
    await h.spans.apply(run(kyiv(2026, 10, 21, 6, 0), kyiv(2026, 10, 21, 7, 0)));
    await h.spans.apply(run(kyiv(2026, 10, 21, 18, 0), kyiv(2026, 10, 21, 18, 30)));
    await h.spans.apply(run(kyiv(2026, 10, 20, 6, 0), kyiv(2026, 10, 20, 9, 0)));
    h.ha.stats['sensor.klimo_kukhnia_temperature'] = [{ start: 0, min: 19.4, max: 22.1 }];

    const text = await h.reports.daily(h.clock.now());
    assert.equal(text.title, 'Підсумок дня · 21.10');
    assert.equal(
      text.body,
      ['Тепловий насос: 1 год 30 хв, 2 запуски', 'Кімнати: від 19.4° (Кухня) до 22.1° (Кухня)', 'Відкритих проблем немає.', 'На 1 год 30 хв менше, ніж учора (3 год).'].join('\n'),
    );

    // routed to the personal chat only, once per day even if asked twice
    await h.reports.runDue(h.clock.now());
    await h.reports.runDue(h.clock.now() + MIN);
    const reports = (await h.log()).filter((m) => m.kind === 'report');
    assert.equal(reports.length, 1);
    assert.deepEqual(reports[0].targets.map((t) => t.targetId), [me.id]);
    assert.equal(h.reports.nextDaily(h.clock.now() + MIN), kyiv(2026, 10, 22, 21, 0));
    // Sunday 20:00 is already winter time (UTC+2)
    assert.equal(h.reports.nextWeekly(h.clock.now()), Date.UTC(2026, 9, 25, 18, 0));
  } finally {
    await h.close();
  }
});
