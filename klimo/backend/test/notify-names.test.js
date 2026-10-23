// Every device alert names its device: two silent sensors of one room must never read the same, in a
// single message, a grouped one, the morning digest, Telegram or the HA sidebar.
const assert = require('node:assert/strict');
const test = require('node:test');
const { ACTOR, MIN, SEC, WED_1910, det, kyiv, FakeClock, openNotify } = require('./notify-harness');
const { DEFAULT_ROOM, DEFAULT_SENSOR, DEFAULT_TRIGGER } = require('../dist/shared/defaults');
const m = require('../dist/notify/messages');

const TZ = 'Europe/Kyiv';

/** The house of the report: an «Office» with two thermometers, a phone, a Telegram chat and the HA sidebar. */
async function office(h, names = ['Desk', 'Shelf']) {
  await h.settings({ telegram: { mode: 'integration', haService: null, botUsername: null } });
  const phone = await h.target({ name: 'Phone', service: 'notify.mobile_app_phone', isPrimary: true, ownerUserId: 'u1' });
  const me = await h.target({ channel: 'telegram', name: 'Me', icon: 'send', chatId: '1001', chatTitle: 'Ігор' });
  const room = await h.config.create('rooms', { ...DEFAULT_ROOM(), name: 'Office', slug: 'office' }, ACTOR);
  const { id: _id, ...sensor } = DEFAULT_SENSOR();
  const ids = ['sensor.office_desk_temperature', 'sensor.office_shelf_temperature'];
  for (const [k, entityId] of ids.entries()) {
    await h.config.create('sensors', { ...sensor, roomId: room.id, entityId, role: 'temperature', name: names[k], haDeviceId: `dev_${k}`, order: k }, ACTOR);
  }
  // both thermometers are silent: the room reads its radiator valves
  h.engine.rooms.set(room.id, { tempC: 21.2, aggregation: { fallback: 'trv' } });
  return { room, phone, me, ids };
}

/** What device health raises for a silent thermometer. */
const silent = (room, entityId, k, name, minutes) =>
  det('sensor_offline', `sensor_offline:${entityId}`, { roomId: room.id, entityId, deviceKey: `dev_${k}`, facts: { entityId, name, minutes, left: 0, total: 2 } });

async function language(h, lang) {
  await h.config.patchSingleton('settings', { notificationLanguage: lang }, ACTOR);
}

test('two silent sensors in one room: two incidents, one grouped message that names each (uk)', async () => {
  const h = await openNotify();
  try {
    const { room, ids } = await office(h);
    await h.tick([silent(room, ids[0], 0, 'Desk', 100), silent(room, ids[1], 1, 'Shelf', 40)]);
    await h.advance(2 * MIN + SEC);

    // deduplicated per device, grouped only on delivery
    const incs = h.incidents.list({ scope: 'all' }).filter((i) => i.kind === 'sensor_offline');
    assert.deepEqual(incs.map((i) => i.dedupKey).sort(), ids.map((id) => `sensor_offline:${id}`).sort());
    assert.deepEqual(incs.map((i) => i.facts.name).sort(), ['Desk', 'Shelf']);

    const [msg] = await h.log();
    const lines = [
      '• Office · Desk: немає даних 1 год 40 хв — беру температуру з головок',
      '• Office · Shelf: немає даних 40 хв — беру температуру з головок',
    ];
    assert.equal(msg.title, '2 датчики не на зв’язку · Office');
    assert.equal(msg.body, lines.join('\n'));

    const pn = h.ha.callsOf('persistent_notification', 'create').at(-1).data;
    assert.deepEqual(pn, { notification_id: 'klimo_alert_sensor_offline', title: '2 датчики не на зв’язку · Office', message: lines.join('\n') });
    const tg = h.ha.callsOf('telegram_bot', 'send_message').at(-1).data;
    assert.equal(tg.message, `<b>2 датчики не на зв’язку · Office</b>\n${lines.join('\n')}`);
    const push = h.ha.callsOf('notify', 'mobile_app_phone').at(-1).data;
    assert.equal(push.title, '2 датчики не на зв’язку · Office');
    assert.equal(push.message, lines.join('\n'));
  } finally {
    await h.close();
  }
});

test('the same in English, and the places of a group across rooms', async () => {
  const h = await openNotify();
  try {
    const { room, ids } = await office(h);
    await language(h, 'en');
    const kitchen = await h.config.create('rooms', { ...DEFAULT_ROOM(), name: 'Kitchen', slug: 'kitchen' }, ACTOR);
    const { id: _id, ...sensor } = DEFAULT_SENSOR();
    await h.config.create('sensors', { ...sensor, roomId: kitchen.id, entityId: 'sensor.kitchen_temperature', role: 'temperature', name: 'Island' }, ACTOR);
    const island = det('sensor_offline', 'sensor_offline:sensor.kitchen_temperature', {
      roomId: kitchen.id,
      entityId: 'sensor.kitchen_temperature',
      facts: { entityId: 'sensor.kitchen_temperature', name: 'Island', minutes: 95, left: 1, total: 2 },
    });
    await h.tick([silent(room, ids[0], 0, 'Desk', 100), silent(room, ids[1], 1, 'Shelf', 40), island]);
    await h.advance(2 * MIN + SEC);
    const [msg] = await h.log();
    assert.equal(msg.title, '3 sensors offline · Office, Kitchen');
    assert.equal(
      msg.body,
      [
        '• Office · Desk: no data for 1 h 40 min — temperature from the radiator valves',
        '• Office · Shelf: no data for 40 min — temperature from the radiator valves',
        '• Kitchen · Island: no data for 1 h 35 min — temperature from 1 other sensor',
      ].join('\n'),
    );
  } finally {
    await h.close();
  }
});

test('one silent sensor: its own message says which, how long and what Klimo does', async () => {
  const h = await openNotify();
  try {
    const { room, ids } = await office(h);
    await h.settings({ grouping: { enabled: false, windowMin: 2 } });
    await h.tick([silent(room, ids[0], 0, 'Desk', 100)]);
    const [msg] = await h.log();
    assert.equal(msg.title, 'Office · Desk: не на зв’язку');
    assert.equal(msg.body, 'Немає даних 1 год 40 хв (останнє — 17:30). Інших датчиків немає — беру температуру з головок.');
    const [inc] = h.incidents.list({ scope: 'all' });
    assert.deepEqual(h.ha.callsOf('persistent_notification', 'create').at(-1).data, { notification_id: `klimo_${inc.id}`, title: msg.title, message: msg.body });

    await language(h, 'en');
    const en = h.texts.incident(h.incidents.snapshot(inc.id));
    assert.equal(en.title, 'Office · Desk: offline');
    assert.equal(en.body, 'No data for 1 h 40 min (last report 17:30). No other sensors — the temperature comes from the radiator valves.');
  } finally {
    await h.close();
  }
});

test('two sensors with the same or a generic name are told apart by their entity ids', async () => {
  for (const names of [
    ['Temperature', 'Temperature 2'],
    ['Bookshelf', 'bookshelf'],
  ]) {
    const h = await openNotify();
    try {
      const { room, ids } = await office(h, names);
      await h.tick([silent(room, ids[0], 0, names[0], 100), silent(room, ids[1], 1, names[1], 100)]);
      await h.advance(2 * MIN + SEC);
      const [msg] = await h.log();
      const lines = msg.body.split('\n');
      assert.equal(lines.length, 2);
      assert.notEqual(lines[0], lines[1]);
      assert.ok(lines[0].startsWith(`• Office · ${names[0]} (${ids[0]}): немає даних`), lines[0]);
      assert.ok(lines[1].startsWith(`• Office · ${names[1]} (${ids[1]}): немає даних`), lines[1]);
      assert.equal(h.incidents.list({ scope: 'all' })[0].facts.showEntity, true);
    } finally {
      await h.close();
    }
  }
});

test('an entity id that would push the state off a lock screen moves from the title to the body', async () => {
  const h = await openNotify();
  try {
    const { room, ids } = await office(h, ['Temperature', 'Temperature 2']);
    await h.settings({ grouping: { enabled: false, windowMin: 2 } });
    await h.tick([silent(room, ids[0], 0, 'Temperature', 100)]);
    const [msg] = await h.log();
    assert.equal(msg.title, 'Office · Temperature: не на зв’язку');
    assert.equal(msg.body, 'Сутність sensor.office_desk_temperature. Немає даних 1 год 40 хв (останнє — 17:30). Інших датчиків немає — беру температуру з головок.');
  } finally {
    await h.close();
  }
});

test('a label given on the Devices page names the device everywhere', async () => {
  const h = await openNotify();
  try {
    const { room, ids } = await office(h);
    await h.config.setDeviceMeta('dev_0', { label: 'Thermometer on the desk' }, ACTOR);
    await h.tick([silent(room, ids[0], 0, 'Desk', 100)]);
    const [inc] = h.incidents.list({ scope: 'all' });
    assert.equal(inc.facts.name, 'Thermometer on the desk');
    assert.equal(h.texts.incident(h.incidents.snapshot(inc.id)).title, 'Office · Thermometer on the desk: не на зв’язку');
  } finally {
    await h.close();
  }
});

test('lines that would still read the same get the entity id (a detector without names)', () => {
  const ctx = m.textContext('uk', WED_1910, TZ);
  const one = (entityId) => ({ kind: 'sensor_offline', roomId: null, sourceId: null, entityId, deviceKey: null, facts: { name: 'Датчик', minutes: 30 }, progress: null, openedAt: WED_1910 });
  assert.deepEqual(m.renderLines([{ incident: one('sensor.a') }, { incident: one('sensor.b') }], ctx), [
    'Датчик: немає даних 30 хв (sensor.a)',
    'Датчик: немає даних 30 хв (sensor.b)',
  ]);
});

test('the morning digest lists each sensor that is still silent by name', async () => {
  const h = await openNotify({ clock: new FakeClock(kyiv(2026, 10, 21, 23, 30)) });
  try {
    const { room, ids } = await office(h);
    const night = [silent(room, ids[0], 0, 'Desk', 100), silent(room, ids[1], 1, 'Shelf', 40)];
    await h.tick(night);
    while (h.clock.now() < kyiv(2026, 10, 22, 7, 1)) await h.tick(night, 30 * MIN);
    const digest = (await h.log()).find((x) => x.kind === 'digest');
    assert.equal(digest.title, 'Поки ви спали');
    assert.equal(
      digest.body,
      [
        'Ще відкрито — 2 проблеми:',
        '• Office · Desk: немає даних 1 год 40 хв — беру температуру з головок',
        '• Office · Shelf: немає даних 40 хв — беру температуру з головок',
      ].join('\n'),
    );
  } finally {
    await h.close();
  }
});

/** Names of a small house for the wording checks below. */
function house(lang) {
  const n = {
    r_office: 'Office',
    s_hp: lang === 'uk' ? 'Тепловий насос' : 'Heat pump',
    s_boiler: lang === 'uk' ? 'Газовий котел' : 'Gas boiler',
    blackout: lang === 'uk' ? 'Блекаут' : 'Blackout',
  };
  const look = (id) => n[id] ?? null;
  return m.textContext(lang, WED_1910, TZ, { room: look, source: look, profile: look, trigger: look, rule: look, circuit: look, pump: look, instance: look, device: look, entity: look });
}

const inc = (kind, patch) => ({ kind, roomId: null, sourceId: null, entityId: null, deviceKey: null, facts: {}, progress: null, openedAt: WED_1910 - 3 * MIN, ...patch });

test('every device alert names the device, the place, how long and what Klimo does (uk, en)', () => {
  const cases = [
    {
      i: inc('battery_low', { roomId: 'r_office', entityId: 'sensor.office_desk_battery', facts: { name: 'Desk', pct: 12, estDays: 9, batteryType: 'CR2032', reminderPct: 10 } }),
      uk: ['Office · Desk: батарея 12%', 'Заряд 12%, вистачить приблизно на 9 днів. Батарейка: CR2032. Нагадаю ще раз на 10%.', 'Office · Desk: батарея 12%, ще ~9 днів (CR2032) — нагадаю ще раз на 10%'],
      en: ['Office · Desk: battery 12%', 'Charge 12%, about 9 days left. Battery: CR2032. I will remind you again at 10%.', 'Office · Desk: battery 12%, about 9 days left (CR2032) — reminder again at 10%'],
    },
    {
      i: inc('trv_not_confirmed', { roomId: 'r_office', entityId: 'climate.office_trv', facts: { name: 'Radiator', showEntity: true, targetC: 21, attempt: 3, of: 3 }, progress: { attempt: 3, of: 3 } }),
      uk: ['Office · Radiator (climate.office_trv): без підтвердження', 'Ціль 21.0° не підтверджено після 3 спроб, уже 3 хв. Klimo повторює у фоні.', 'Office · Radiator (climate.office_trv): ціль 21.0° не підтверджено — повторюю у фоні'],
      en: ['Office · Radiator (climate.office_trv): not confirmed', 'Target 21.0° not confirmed after 3 attempts — 3 min so far. Klimo keeps retrying in the background.', 'Office · Radiator (climate.office_trv): target 21.0° not confirmed — retrying in the background'],
    },
    {
      i: inc('signal_weak', { roomId: 'r_office', entityId: 'climate.office_trv', facts: { name: 'Radiator under the window', lqi: 38 } }),
      uk: ['Office · Radiator under the window: слабкий сигнал', null, 'Office · Radiator under the window: слабкий сигнал, LQI 38 — команди повторюю'],
      en: ['Office · Radiator under the window: weak signal', null, 'Office · Radiator under the window: weak signal, LQI 38 — commands are repeated'],
    },
    {
      i: inc('actuator_conflict', { roomId: 'r_office', entityId: 'switch.office_floor', facts: { name: 'Floor relay', by: 'automation', until: WED_1910 + 7 * MIN } }),
      uk: ['Office · Floor relay: змінює щось інше', 'switch.office_floor змінює автоматизація всупереч Klimo. Klimo відступив до 19:17 — вимкніть ту автоматизацію.', 'Office · Floor relay: змінює щось інше — Klimo відступив до 19:17'],
      en: ['Office · Floor relay: changed by something else', 'switch.office_floor is changed by an automation against Klimo. Klimo backed off until 19:17 — disable that automation.', 'Office · Floor relay: changed by something else — Klimo backed off until 19:17'],
    },
    {
      i: inc('entity_unavailable', { entityId: 'sensor.garden_temperature', facts: { name: 'Garden', minutes: 45, outdoor: true, outdoorSource: 'sensor' } }),
      uk: ['Надворі · Garden: недоступно', 'Сутність sensor.garden_temperature недоступна 45 хв (з 18:25). Температуру надворі беру з інших датчиків.', 'Надворі · Garden: недоступно 45 хв — беру з інших датчиків надворі'],
      en: ['Outdoors · Garden: unavailable', 'sensor.garden_temperature unavailable for 45 min (since 18:25). The outdoor temperature comes from the other outdoor sensors.', 'Outdoors · Garden: unavailable for 45 min — using the other outdoor sensors'],
    },
    {
      i: inc('sensor_offline', { entityId: 'sensor.balcony_temperature', facts: { name: 'Balcony', minutes: 40, outdoor: true, outdoorSource: 'weather' } }),
      uk: ['Надворі · Balcony: не на зв’язку', 'Немає даних 40 хв (останнє — 18:30). Беру температуру з прогнозу погоди.', 'Надворі · Balcony: немає даних 40 хв — беру прогноз погоди'],
      en: ['Outdoors · Balcony: offline', 'No data for 40 min (last report 18:30). Using the weather forecast instead.', 'Outdoors · Balcony: no data for 40 min — using the weather forecast'],
    },
    {
      i: inc('entity_unavailable', { entityId: 'binary_sensor.grid_offline', facts: { name: 'Grid', minutes: 6, triggerId: 'blackout', unknownAs: 'hold_false' } }),
      uk: ['Grid: недоступно', 'Сутність binary_sensor.grid_offline недоступна 6 хв (з 19:04). Тригер «Блекаут» поки тримає останній стан.', 'Grid: недоступно 6 хв — тригер «Блекаут» тримає останній стан'],
      en: ['Grid: unavailable', 'binary_sensor.grid_offline unavailable for 6 min (since 19:04). Trigger «Blackout» keeps its last state meanwhile.', 'Grid: unavailable for 6 min — trigger «Blackout» keeps its last state'],
    },
    {
      i: inc('entity_unavailable', { entityId: 'switch.floor_pump', facts: { name: 'Floor pump', minutes: 12, role: 'pump' } }),
      uk: ['Floor pump: недоступно', 'Сутність switch.floor_pump недоступна 12 хв (з 18:58). Насосом не керую, доки він не повернеться.', 'Floor pump: недоступно 12 хв — насосом не керую'],
      en: ['Floor pump: unavailable', 'switch.floor_pump unavailable for 12 min (since 18:58). Klimo cannot switch the pump until it is back.', 'Floor pump: unavailable for 12 min — the pump cannot be switched'],
    },
    {
      i: inc('window_open_long', { roomId: 'r_office', facts: { name: 'Window by the desk', entityId: 'binary_sensor.office_window', openCount: 2, minutes: 25, since: WED_1910 - 25 * MIN, reaction: 'pause' } }),
      uk: ['Office · Window by the desk і ще 1: відкрито 25 хв', 'Відкрито 25 хв, з 18:45. Кімната на паузі, доки вікно не закриють.', 'Office · Window by the desk і ще 1: відкрито 25 хв — кімната на паузі'],
      en: ['Office · Window by the desk and 1 more: open 25 min', 'Open for 25 min, since 18:45. The room is paused until the window is closed.', 'Office · Window by the desk and 1 more: open 25 min — the room is paused'],
    },
    {
      i: inc('manual_override', { roomId: 'r_office', entityId: 'climate.office_trv', facts: { name: 'Radiator', showEntity: true, valueC: 23, by: 'Оля', policy: 'revert' } }),
      uk: ['Office · Radiator (climate.office_trv): 23.0° вручну', 'Ціль змінили на самому пристрої: 23.0° · Оля. Klimo повертає ціль розкладу.', 'Office · Radiator (climate.office_trv): 23.0° вручну — повертаю ціль розкладу'],
      en: ['Office · Radiator (climate.office_trv): 23.0° by hand', 'Set to 23.0° on the device itself · Оля. Klimo puts the schedule target back.', 'Office · Radiator (climate.office_trv): 23.0° by hand — the schedule target is put back'],
    },
    {
      i: inc('source_unavailable', { sourceId: 's_hp', entityId: 'climate.heat_pump', facts: { minutes: 3, fallbackId: 's_boiler' } }),
      uk: ['Тепловий насос не відповідає', null, 'Тепловий насос (climate.heat_pump): не відповідає 3 хв — опалення перейшло на Газовий котел'],
      en: ['Heat pump does not respond', null, 'Heat pump (climate.heat_pump): no response for 3 min — heating moved to Gas boiler'],
    },
  ];
  for (const c of cases) {
    for (const lang of ['uk', 'en']) {
      const ctx = house(lang);
      const [title, body, line] = c[lang];
      const t = m.renderIncident(c.i, ctx);
      assert.equal(t.title, title, `${lang} ${c.i.kind} title`);
      if (body) assert.equal(t.body, body, `${lang} ${c.i.kind} body`);
      assert.equal(m.renderLine(c.i, ctx), line, `${lang} ${c.i.kind} line`);
      assert.ok(t.body.length <= 140, `${lang} ${c.i.kind} body too long: ${t.body.length}`);
    }
  }
});

test('room chips name the silent sensor and the open window', () => {
  const uk = m.textContext('uk', WED_1910, TZ, m.sampleNames('uk'));
  const en = m.textContext('en', WED_1910, TZ, m.sampleNames('en'));
  const sensor = { code: 'sensor_offline', params: { left: 1, total: 3, entityId: 'sensor.kitchen_shelf_temperature', more: 1 } };
  assert.equal(m.renderIssue(sensor, uk), 'На полиці і ще 1: не на зв’язку · 2 з 3 датчиків');
  assert.equal(m.renderIssue(sensor, en), 'Shelf and 1 more: offline · 2 of 3 sensors');
  assert.equal(m.renderIssue({ code: 'sensor_offline', params: { left: 2, total: 3, entityId: 'sensor.kitchen_shelf_temperature', more: 0 } }, uk), 'На полиці: не на зв’язку · 1 з 3 датчиків');
  const win = { code: 'window_long', params: { since: WED_1910 - 25 * MIN, entityId: 'binary_sensor.kitchen_window_contact', more: 0 } };
  assert.equal(m.renderIssue(win, uk), 'Вікно біля плити: відкрито 25 хв');
  assert.equal(m.renderIssue({ code: 'trv_retry', params: { attempt: 2, of: 3, deviceId: 'climate.bathroom_towel_trv' } }, uk), 'Рушникосушка: ціль не підтверджено · повтор 2/3');
});

test('two outdoor sensors with the same name are told apart by their entity ids, also when they are back', async () => {
  const h = await openNotify();
  try {
    await h.settings({ grouping: { enabled: false, windowMin: 2 } });
    const ids = ['sensor.north_wall_temperature', 'sensor.south_wall_temperature'];
    const settings = h.config.singleton('settings');
    await h.config.patchSingleton('settings', { outdoor: { ...settings.outdoor, sensorEntityIds: ids } }, ACTOR);
    for (const [k, id] of ids.entries()) h.ha.set(id, 'unavailable', { friendly_name: 'Wall' }, { changedAgoMs: (20 + k * 5) * MIN });
    const gone = (id, minutes) => det('entity_unavailable', `entity_unavailable:${id}`, { roomId: null, entityId: id, deviceKey: `entity:${id}`, facts: { entityId: id, name: '', minutes, outdoor: true } });
    await h.tick([gone(ids[0], 20), gone(ids[1], 25)]);
    const titles = (await h.log()).map((x) => x.title).sort();
    assert.deepEqual(titles, ids.map((id) => `Надворі · Wall (${id}): недоступно`).sort());
    const resolved = h.incidents.list({ scope: 'all' }).map((i) => h.texts.resolved(h.incidents.snapshot(i.id) ?? i));
    assert.notEqual(resolved[0], resolved[1]);
  } finally {
    await h.close();
  }
});

test('a sensor without a name of its own is named from Home Assistant, never «Office · Office ·»', async () => {
  const h = await openNotify();
  try {
    const { room, ids } = await office(h, ['', '']);
    await h.settings({ grouping: { enabled: false, windowMin: 2 } });
    h.ha.set(ids[0], '20.1', { unit_of_measurement: '°C', friendly_name: 'Desk thermometer' }, { reportedAgoMs: 100 * MIN });
    h.ha.set(ids[1], '20.1', { unit_of_measurement: '°C', friendly_name: 'Shelf thermometer' }, { reportedAgoMs: 140 * MIN });
    await h.tick(h.watch.watchDetections(h.clock.now()));
    const titles = (await h.log()).map((x) => x.title).sort();
    assert.deepEqual(titles, ['Office · Desk thermometer: не на зв’язку', 'Office · Shelf thermometer: не на зв’язку']);
    assert.ok(h.watch.rules().filter((r) => ids.includes(r.entityId)).every((r) => r.name === 'Office'), 'no rule named «Office · »');
  } finally {
    await h.close();
  }
});

test('two Zigbee2MQTT instances offline: each message and its recovery name the instance', async () => {
  const h = await openNotify();
  try {
    await h.settings({ grouping: { enabled: false, windowMin: 2 } });
    const out = [];
    for (const [k, name] of ['Будинок', 'Z2M гараж'].entries()) {
      const z = await h.config.create('z2m', { name, baseTopic: `zigbee2mqtt${k}`, frontendUrl: null, bridgeEntityId: `binary_sensor.z2m_${k}_bridge`, resendOnRestart: true }, ACTOR);
      out.push(det('z2m_offline', `z2m_offline:${z.id}`, { entityId: `binary_sensor.z2m_${k}_bridge`, facts: { instanceId: z.id, name, since: WED_1910 - (k + 2) * MIN } }));
    }
    await h.tick(out);
    const titles = (await h.log()).map((x) => x.title).sort();
    assert.deepEqual(titles, ['Z2M гараж не на зв’язку', 'Zigbee2MQTT «Будинок» не на зв’язку']);
    const incs = h.incidents.list({ scope: 'all' });
    assert.deepEqual(incs.map((i) => h.texts.resolved(h.incidents.snapshot(i.id) ?? i)).sort(), [
      'Z2M гараж повернувся — команди надіслано знову',
      'Zigbee2MQTT «Будинок» повернувся — команди надіслано знову',
    ]);
    await language(h, 'en');
    assert.deepEqual(incs.map((i) => h.texts.incident(h.incidents.snapshot(i.id)).title).sort(), ['Z2M гараж offline', 'Zigbee2MQTT «Будинок» offline']);
  } finally {
    await h.close();
  }
});

test('two inputs of one trigger: named from Home Assistant, the same names told apart by their ids', async () => {
  const h = await openNotify();
  try {
    await h.settings({ grouping: { enabled: false, windowMin: 2 } });
    const ids = ['binary_sensor.grid_phase_a', 'binary_sensor.grid_phase_b'];
    await h.config.create('triggers', { ...DEFAULT_TRIGGER(), name: 'Блекаут', condition: { op: 'any', items: ids.map((entityId) => ({ op: 'state', entityId, equals: ['on'] })) } }, ACTOR);
    for (const id of ids) h.ha.set(id, 'unavailable', { friendly_name: 'Voltage' }, { changedAgoMs: 6 * MIN });
    // what device health raises: no Klimo name of its own (the trigger's name is not the input's)
    const gone = (id) => det('entity_unavailable', `entity_unavailable:${id}`, { roomId: null, entityId: id, deviceKey: `entity:${id}`, facts: { entityId: id, name: '', minutes: 6 } });
    await h.tick(ids.map(gone));
    const msgs = await h.log();
    assert.deepEqual(msgs.map((x) => x.title).sort(), ids.map((id) => `Voltage (${id}): недоступно`).sort());
    assert.ok(msgs.every((x) => x.body.includes('Тригер «Блекаут»')), msgs.map((x) => x.body).join(' / '));
  } finally {
    await h.close();
  }
});

/** Two air conditioners both called «Кондиціонер» in the Office, both gone from Home Assistant. */
async function twoAcs(h, room) {
  const { newSourceConfig } = require('../dist/shared/defaults');
  const ids = ['climate.ac_window', 'climate.ac_door'];
  for (const entityId of ids) {
    const { id: _id, ...ac } = newSourceConfig('ac', { id: 'x', name: 'Кондиціонер', now: 0, scope: 'room', roomId: room.id });
    await h.config.create('sources', { ...ac, adapter: { ...ac.adapter, climate: entityId } }, ACTOR);
    h.ha.set(entityId, 'unavailable', {}, { changedAgoMs: 20 * MIN });
  }
  await h.tick(h.watch.watchDetections(h.clock.now()).filter((d) => d.kind === 'source_unavailable'));
  return ids;
}

test('two air conditioners with one name in one room: each alert and its recovery carry the entity id', async () => {
  const h = await openNotify();
  try {
    const { room } = await office(h);
    await h.settings({ grouping: { enabled: false, windowMin: 2 } });
    const ids = await twoAcs(h, room);
    const titles = (await h.log()).map((x) => x.title).sort();
    assert.deepEqual(titles, ids.map((id) => `Кондиціонер · Office (${id}) не відповідає`).sort());
    const incs = h.incidents.list({ scope: 'all' }).filter((i) => i.kind === 'source_unavailable');
    assert.deepEqual(incs.map((i) => h.texts.resolved(h.incidents.snapshot(i.id) ?? i)).sort(), ids.map((id) => `Кондиціонер · Office (${id}) знову на зв’язку`).sort());
  } finally {
    await h.close();
  }
});

test('two air conditioners with one name, grouped: each line names its entity once', async () => {
  const h = await openNotify();
  try {
    const { room } = await office(h);
    const ids = await twoAcs(h, room);
    await h.advance(2 * MIN + SEC);
    const msg = (await h.log()).find((x) => x.body.includes('• '));
    assert.equal(msg.title, '2 джерела не відповідають · Кондиціонер · Office', 'the place once, without the ids');
    const lines = msg.body.split('\n');
    assert.equal(lines.length, 2, msg.body);
    for (const id of ids) assert.equal(lines.filter((l) => l.startsWith(`• Кондиціонер · Office (${id}): не відповідає 20 хв`)).length, 1, msg.body);
    for (const l of lines) assert.equal(l.match(/climate\./g).length, 1, l);
  } finally {
    await h.close();
  }
});

test('two Zigbee2MQTT bridges with one name are told apart by their base topics', async () => {
  const h = await openNotify();
  try {
    await h.settings({ grouping: { enabled: false, windowMin: 2 } });
    const out = [];
    for (const k of [0, 1]) {
      const z = await h.config.create('z2m', { name: 'Гараж', baseTopic: `zigbee2mqtt_${k}`, frontendUrl: null, bridgeEntityId: `binary_sensor.z2m_${k}_bridge`, resendOnRestart: true }, ACTOR);
      out.push(det('z2m_offline', `z2m_offline:${z.id}`, { entityId: `binary_sensor.z2m_${k}_bridge`, facts: { instanceId: z.id, name: z.name, since: WED_1910 - (k + 2) * MIN } }));
    }
    await h.tick(out);
    assert.deepEqual((await h.log()).map((x) => x.title).sort(), ['Zigbee2MQTT «Гараж» (zigbee2mqtt_0) не на зв’язку', 'Zigbee2MQTT «Гараж» (zigbee2mqtt_1) не на зв’язку']);
    const incs = h.incidents.list({ scope: 'all' });
    assert.deepEqual(incs.map((i) => h.texts.resolved(h.incidents.snapshot(i.id) ?? i)).sort(), [
      'Zigbee2MQTT «Гараж» (zigbee2mqtt_0) повернувся — команди надіслано знову',
      'Zigbee2MQTT «Гараж» (zigbee2mqtt_1) повернувся — команди надіслано знову',
    ]);
  } finally {
    await h.close();
  }
});

test('group titles agree with the count in Ukrainian («5 сутностей недоступно»)', () => {
  const uk = m.textContext('uk', WED_1910, TZ);
  assert.deepEqual([1, 2, 5, 11, 21, 22].map((n) => m.renderGroupTitle('entity_unavailable', n, uk)), [
    '1 сутність недоступна',
    '2 сутності недоступні',
    '5 сутностей недоступно',
    '11 сутностей недоступно',
    '21 сутність недоступна',
    '22 сутності недоступні',
  ]);
});
