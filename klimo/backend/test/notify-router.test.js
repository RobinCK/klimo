const assert = require('node:assert/strict');
const test = require('node:test');
const { ACTOR, HOUR, MIN, SEC, det, kyiv, FakeClock, openNotify } = require('./notify-harness');

/** A house with two phones, a personal Telegram chat, the family group and the seeded panel/event targets. */
async function house(h, telegramMode = 'integration') {
  await h.settings({ telegram: { mode: telegramMode, haService: null, botUsername: null } });
  const phone = await h.target({ name: 'Мій телефон', service: 'notify.mobile_app_phone', isPrimary: true, ownerUserId: 'u1' });
  const tablet = await h.target({ name: 'Планшет на кухні', service: 'notify.mobile_app_kitchen_tablet', icon: 'tablet' });
  const me = await h.target({ channel: 'telegram', name: 'Особистий', icon: 'send', chatId: '1001', chatTitle: 'Ігор' });
  const family = await h.target({ channel: 'telegram', name: 'Сімейна група', icon: 'users', chatId: '-1002', chatTitle: 'Сім’я', isEscalation: true });
  const targets = h.config.list('targets');
  const panel = targets.find((t) => t.channel === 'ha_persistent');
  const event = targets.find((t) => t.channel === 'ha_event');
  return { phone, tablet, me, family, panel, event };
}

const critical = () => det('source_failed', 'source_failed:s_hp', { sourceId: 's_hp', entityId: 'climate.heat_pump', facts: { code: 'no_confirm', minutes: 5 } });
const offline = (entity, name) => det('sensor_offline', `sensor_offline:${entity}`, { entityId: entity, facts: { name, minutes: 95 } });
const delivered = (msg, targetId) => msg.targets.find((t) => t.targetId === targetId)?.state;

test('a critical alert reaches every routed target at once, with the alarm sound and buttons', async () => {
  const h = await openNotify();
  try {
    const t = await house(h);
    await h.tick([critical()]);
    const [inc] = h.incidents.list({ scope: 'all' });
    const [msg] = await h.log();
    assert.equal(msg.kind, 'alert');
    assert.equal(msg.title, 's_hp: аварія');
    for (const id of [t.phone.id, t.tablet.id, t.me.id, t.family.id, t.panel.id]) assert.equal(delivered(msg, id), 'delivered', id);
    assert.equal(h.incidents.get(inc.id).notifiedAt, h.clock.now());

    const push = h.ha.callsOf('notify', 'mobile_app_phone')[0].data;
    assert.equal(push.data.tag, inc.id);
    assert.deepEqual(push.data.push, { sound: { name: 'default', critical: 1, volume: 1.0 } });
    assert.equal(push.data.channel, 'alarm_stream', 'Android: through silent mode and Do Not Disturb');
    assert.equal(push.data.media_stream, 'alarm_stream');
    assert.deepEqual([push.data.priority, push.data.ttl], ['high', 0]);
    assert.deepEqual(push.data.actions[0], { action: `KLIMO_ACK_${inc.id}`, title: 'Бачу' });
    assert.deepEqual(push.data.actions.at(-1), { action: 'URI', title: 'Відкрити Klimo', uri: '/a0d7b954_klimo' });

    const tg = h.ha.callsOf('telegram_bot', 'send_message');
    assert.equal(tg.length, 2);
    assert.match(tg[0].data.message, /^<b>s_hp: аварія<\/b>\n/);
    assert.deepEqual(tg[0].data.inline_keyboard, [`Бачу:/klimo ack ${inc.id}`, `Відкрити Klimo:/klimo open ${inc.id}`]);

    const pn = h.ha.callsOf('persistent_notification', 'create')[0].data;
    assert.equal(pn.notification_id, `klimo_${inc.id}`);

    // the automation event goes out first, on the HA bus and on MQTT
    const ev = h.ha.fired.find((e) => e.type === 'klimo_event');
    assert.equal(ev.data.state, 'open');
    assert.equal(ev.data.kind, 'source_failed');
    assert.equal(ev.data.incident_id, inc.id);
    assert.equal(h.mqtt.published[0].topic, 'klimo/events');
    assert.deepEqual(h.mqtt.published[0].opts, { retain: false, qos: 1 });
  } finally {
    await h.close();
  }
});

test('critical follow-ups: escalation after 10 min and at most 6 repeats every 30 min', async () => {
  const h = await openNotify();
  try {
    const t = await house(h);
    // the family group does not get this kind by the matrix, only by escalation
    await h.config.setRoute('source_failed', t.family.id, false, ACTOR);
    await h.tick([critical()]);
    const [inc] = h.incidents.list({ scope: 'all' });
    assert.equal((await h.log())[0].targets.some((x) => x.targetId === t.family.id), false);

    await h.advance(9 * MIN);
    assert.equal((await h.log()).filter((m) => m.kind === 'escalation').length, 0);
    await h.advance(1 * MIN + SEC);
    const esc = (await h.log()).filter((m) => m.kind === 'escalation');
    assert.equal(esc.length, 1);
    assert.deepEqual(esc[0].targets.map((x) => x.targetId), [t.family.id]);
    assert.equal(esc[0].title, 'Без відповіді: s_hp: аварія');

    for (let i = 0; i < 24; i++) await h.tick([critical()], 10 * MIN);
    const repeats = (await h.log()).filter((m) => m.kind === 'repeat');
    assert.equal(repeats.length, 6);
    assert.equal(repeats[0].title, 's_hp: аварія · повтор 1');
    assert.equal(repeats[5].title, 's_hp: аварія · повтор 6');
    assert.equal(h.incidents.get(inc.id).repeatCount, 6);
    // repeats go to those who got the alert, never to the escalation target
    assert.equal(repeats[0].targets.some((x) => x.targetId === t.family.id), false);
  } finally {
    await h.close();
  }
});

test('«Бачу» from a phone stops repeats and marks the log for everyone', async () => {
  const h = await openNotify();
  try {
    const t = await house(h);
    await h.tick([critical()]);
    const [inc] = h.incidents.list({ scope: 'all' });
    await h.advance(5 * MIN);
    await h.ha.emit('mobile_app_notification_action', { action: `KLIMO_ACK_${inc.id}` }, { id: 'c1', user_id: 'u1', parent_id: null });
    await h.router.idle();
    await h.incidents.flush();
    const acked = h.incidents.get(inc.id);
    assert.equal(acked.status, 'acknowledged');
    assert.equal(acked.ackBy.via, 'notification');
    assert.equal(acked.ackBy.userName, 'Ігор');
    await h.advance(3 * HOUR);
    const log = await h.log();
    assert.equal(log.filter((m) => m.kind === 'repeat' || m.kind === 'escalation').length, 0);
    assert.equal(delivered(log[0], t.phone.id), 'acknowledged');
    assert.equal(h.ha.fired.filter((e) => e.data.state === 'ack').length, 1);
  } finally {
    await h.close();
  }
});

test('a solved problem sends a silent recovery to the same targets and closes the HA notification', async () => {
  const h = await openNotify();
  try {
    const t = await house(h);
    await h.tick([critical()]);
    const [inc] = h.incidents.list({ scope: 'all' });
    await h.tick([], MIN);
    await h.tick([], 121 * SEC);
    assert.equal(h.incidents.get(inc.id).status, 'resolved');
    const rec = (await h.log()).find((m) => m.kind === 'resolved');
    assert.equal(rec.title, 's_hp знову працює');
    assert.deepEqual(rec.targets.map((x) => x.targetId).sort(), [t.phone.id, t.tablet.id, t.me.id, t.family.id].sort());
    const push = h.ha.callsOf('notify', 'mobile_app_phone').at(-1).data;
    assert.equal(push.data.tag, inc.id);
    assert.equal(push.data.push['interruption-level'], 'passive');
    assert.equal(push.message, 's_hp знову працює');
    assert.equal(h.ha.callsOf('persistent_notification', 'dismiss')[0].data.notification_id, `klimo_${inc.id}`);
    assert.equal(h.persistent.openCount(), 0);
    assert.equal(h.ha.fired.filter((e) => e.data.state === 'resolved').length, 1);
  } finally {
    await h.close();
  }
});

test('without recovery messages the phone notification is only cleared', async () => {
  const h = await openNotify();
  try {
    await house(h);
    await h.settings({ recoveryMessages: false });
    await h.tick([critical()]);
    const [inc] = h.incidents.list({ scope: 'all' });
    await h.tick([], MIN);
    await h.tick([], 121 * SEC);
    assert.equal((await h.log()).filter((m) => m.kind === 'resolved').length, 0);
    const clear = h.ha.callsOf('notify', 'mobile_app_phone').at(-1).data;
    assert.deepEqual(clear, { message: 'clear_notification', data: { tag: inc.id } });
  } finally {
    await h.close();
  }
});

test('grouping merges three offline sensors into one message', async () => {
  const h = await openNotify();
  try {
    const t = await house(h);
    await h.tick([offline('sensor.a', 'Шафа')]);
    await h.tick([offline('sensor.a', 'Шафа'), offline('sensor.b', 'Полиця')], 30 * SEC);
    await h.tick([offline('sensor.a', 'Шафа'), offline('sensor.b', 'Полиця'), offline('sensor.c', 'Вікно')], 30 * SEC);
    assert.equal((await h.log()).length, 0);
    await h.tick([offline('sensor.a', 'Шафа'), offline('sensor.b', 'Полиця'), offline('sensor.c', 'Вікно')], 61 * SEC);
    const log = await h.log();
    assert.equal(log.length, 1);
    assert.equal(log[0].title, '3 датчики не на зв’язку');
    assert.equal(log[0].body, '• Шафа: не на зв’язку\n• Полиця: не на зв’язку\n• Вікно: не на зв’язку');
    // sensor_offline goes to the phone, personal Telegram and the HA panel by default
    assert.deepEqual(log[0].targets.map((x) => x.targetId).sort(), [t.phone.id, t.me.id, t.panel.id].sort());
    // later on, each of them notified counts as delivered for its own recovery
    for (const i of h.incidents.list({ scope: 'all' })) assert.notEqual(i.notifiedAt, null);
  } finally {
    await h.close();
  }
});

test('quiet hours: one digest in the morning with what is still open, solved ones dropped', async () => {
  const h = await openNotify({ clock: new FakeClock(kyiv(2026, 10, 21, 23, 30)) });
  try {
    const t = await house(h);
    const night = [offline('sensor.a', 'Шафа'), offline('sensor.b', 'Полиця'), offline('sensor.c', 'Вікно')];
    await h.tick(night);
    await h.tick([...night, det('trigger_fired', 'trigger:blackout:1', { facts: { triggerId: 'blackout' } })], 3 * MIN);
    const queued = (await h.log()).filter((m) => m.queuedUntil !== null);
    assert.equal(queued.length, 4);
    assert.equal(queued[0].queuedUntil, kyiv(2026, 10, 22, 7, 0));
    assert.ok(queued.every((m) => m.targets.every((x) => x.state === 'queued_quiet')));
    // the HA panel is silent anyway and is not held back
    assert.ok(queued.every((m) => !m.targets.some((x) => x.targetId === t.panel.id)));

    // «Шафа» comes back at night
    const rest = night.slice(1);
    await h.tick(rest, HOUR);
    await h.tick(rest, 3 * MIN);
    assert.equal(h.incidents.list({ scope: 'all' }).find((i) => i.facts.name === 'Шафа').status, 'resolved');

    while (h.clock.now() < kyiv(2026, 10, 22, 7, 1)) await h.tick(rest, 30 * MIN);
    const log = await h.log();
    const digests = log.filter((m) => m.kind === 'digest');
    assert.equal(digests.length, 2, 'one per target: the phone and the personal chat');
    const tg = digests.find((m) => m.targets.some((x) => x.targetId === t.me.id));
    assert.equal(tg.title, 'Поки ви спали');
    assert.match(tg.body, /Ще відкрито — 2 проблеми:/);
    assert.match(tg.body, /Полиця: не на зв’язку/);
    assert.match(tg.body, /Вікно: не на зв’язку/);
    assert.doesNotMatch(tg.body, /Шафа/);
    assert.match(tg.body, /Події:\n• Спрацював тригер «Блекаут»/);
    const phone = digests.find((m) => m.targets.some((x) => x.targetId === t.phone.id));
    assert.doesNotMatch(phone.body, /Події/);

    const rows = (await h.log()).filter((m) => m.queuedUntil !== null);
    const shafa = rows.find((m) => m.title === 'Шафа: не на зв’язку');
    assert.ok(shafa.targets.every((x) => x.state === 'skipped'));
    const polytsia = rows.find((m) => m.title === 'Полиця: не на зв’язку');
    assert.ok(polytsia.targets.every((x) => x.state === 'delivered'));
  } finally {
    await h.close();
  }
});

test('critical alerts ignore quiet hours', async () => {
  const h = await openNotify({ clock: new FakeClock(kyiv(2026, 10, 21, 23, 30)) });
  try {
    const t = await house(h);
    await h.tick([critical()]);
    const [msg] = await h.log();
    assert.equal(msg.queuedUntil, null);
    assert.equal(delivered(msg, t.phone.id), 'delivered');
  } finally {
    await h.close();
  }
});

test('personal level switches and personal quiet hours', async () => {
  const h = await openNotify({ clock: new FakeClock(kyiv(2026, 10, 21, 23, 30)) });
  try {
    const t = await house(h);
    await h.config.setPersonalPrefs('u1', { quietHours: false, levels: { critical: true, warning: true, event: false, report: true } });
    await h.tick([offline('sensor.a', 'Шафа')]);
    await h.advance(2 * MIN + SEC);
    const log = await h.log();
    // the phone's owner turned quiet hours off: the phone gets it now, Telegram waits for the morning
    const now = log.find((m) => m.queuedUntil === null);
    assert.equal(delivered(now, t.phone.id), 'delivered');
    const later = log.find((m) => m.queuedUntil !== null);
    assert.equal(later.targets[0].targetId, t.me.id);
    // events are off for this user: the phone is not among the targets
    assert.equal(h.router.recipients('source_fallback', 'event').some((x) => x.id === t.phone.id), false);
    assert.equal(h.router.recipients('source_failed', 'critical').some((x) => x.id === t.phone.id), true);
  } finally {
    await h.close();
  }
});

test('nothing got through for a critical alert: the HA sidebar shows it and the targets are retried', async () => {
  const h = await openNotify();
  try {
    const t = await house(h);
    await h.config.update('targets', t.panel.id, { enabled: false }, ACTOR);
    for (const s of ['notify.mobile_app_phone', 'notify.mobile_app_kitchen_tablet', 'telegram_bot.send_message']) h.ha.failing.add(s);
    await h.tick([critical()]);
    const [msg] = await h.log();
    assert.ok(msg.targets.every((x) => x.state === 'failed' && x.error));
    assert.equal(h.ha.callsOf('persistent_notification', 'create').length, 1);

    h.ha.failing.clear();
    await h.advance(75 * SEC);
    const [again] = await h.log();
    assert.ok(again.targets.every((x) => x.state === 'delivered'), JSON.stringify(again.targets));
  } finally {
    await h.close();
  }
});

test('a channel failing three times in a row raises channel_failed; the next success settles it', async () => {
  const h = await openNotify();
  try {
    await house(h);
    h.ha.failing.add('notify.mobile_app_phone');
    for (let i = 0; i < 3; i++) await h.tick([offline(`sensor.x${i}`, `D${i}`)], 3 * MIN);
    await h.advance(3 * MIN);
    const failed = h.incidents.list({ scope: 'all' }).find((i) => i.kind === 'channel_failed');
    assert.ok(failed, 'channel_failed opened');
    assert.equal(failed.facts.channel, 'ha_mobile');
    assert.equal(h.notify.settings().channels.find((c) => c.channel === 'ha_mobile').status, 'error');
    h.ha.failing.clear();
    await h.notify.test({ channel: 'ha_mobile' });
    await h.advance(121 * SEC);
    await h.tick([], SEC);
    assert.equal(h.incidents.get(failed.id).status, 'resolved');
    assert.equal(h.notify.settings().channels.find((c) => c.channel === 'ha_mobile').status, 'ok');
  } finally {
    await h.close();
  }
});

test('«Надіслати тест» reaches every target regardless of quiet hours and reports per target', async () => {
  const h = await openNotify({ clock: new FakeClock(kyiv(2026, 10, 21, 23, 30)) });
  try {
    const t = await house(h);
    h.ha.failing.add('notify.mobile_app_kitchen_tablet');
    const res = await h.notify.test({ all: true });
    const by = new Map(res.results.map((r) => [r.targetId, r]));
    assert.equal(by.get(t.phone.id).ok, true);
    assert.equal(by.get(t.tablet.id).ok, false);
    assert.match(by.get(t.tablet.id).error, /failed/);
    assert.equal(by.get(t.event.id).ok, true);
    assert.equal(h.ha.fired.at(-1).data.facts.test, true);
    const [msg] = await h.log();
    assert.equal(msg.kind, 'test');
    assert.equal(msg.title, 'Klimo · тест');
  } finally {
    await h.close();
  }
});

test('Telegram buttons through the HA integration act and then disappear', async () => {
  const h = await openNotify();
  try {
    await house(h);
    await h.tick([offline('sensor.a', 'Шафа')]);
    await h.advance(2 * MIN + SEC);
    const [inc] = h.incidents.list({ scope: 'all' });
    const sent = h.ha.callsOf('telegram_bot', 'send_message')[0].data;
    assert.deepEqual(sent.inline_keyboard, [
      `Ігнорувати до ранку:/klimo snooze_until_morning ${inc.id}, Виключити з розрахунку:/klimo exclude_sensor ${inc.id}`,
      `Відкрити Klimo:/klimo open ${inc.id}`,
    ]);
    // a stranger's chat is refused
    await h.ha.emit('telegram_callback', { id: 'cb0', chat_id: 999, data: `/klimo snooze_until_morning ${inc.id}`, message: { message_id: 7, date: Math.floor(h.clock.now() / 1000) } });
    assert.equal(h.incidents.get(inc.id).snoozedUntil, null);
    assert.equal(h.ha.callsOf('telegram_bot', 'answer_callback_query')[0].data.message, 'Цей чат не підключено до Klimo');

    await h.ha.emit('telegram_callback', { id: 'cb1', chat_id: 1001, from_first: 'Ігор', data: `/klimo snooze_until_morning ${inc.id}`, message: { message_id: 8, date: Math.floor(h.clock.now() / 1000) } });
    await h.router.idle();
    assert.equal(h.incidents.get(inc.id).snoozedUntil, kyiv(2026, 10, 22, 7, 0));
    assert.equal(h.ha.callsOf('telegram_bot', 'answer_callback_query')[1].data.message, 'Сховано до завтра 07:00');
    assert.deepEqual(h.ha.callsOf('telegram_bot', 'edit_replymarkup')[0].data, { message_id: 8, chat_id: 1001, inline_keyboard: [] });

    // a button older than a day only says it is stale
    await h.ha.emit('telegram_callback', { id: 'cb2', chat_id: 1001, data: `/klimo exclude_sensor ${inc.id}`, message: { message_id: 9, date: Math.floor((h.clock.now() - 25 * HOUR) / 1000) } });
    assert.equal(h.ha.callsOf('telegram_bot', 'answer_callback_query')[2].data.message, 'Застаріло — відкрийте Klimo');
  } finally {
    await h.close();
  }
});

test('the preview uses the real templates and the settings show live channel state', async () => {
  const h = await openNotify();
  try {
    await house(h);
    const p = h.notify.preview('source_unavailable');
    assert.equal(p.push.title, 'Тепловий насос не відповідає');
    assert.equal(p.push.body, 'climate.heat_pump недоступний 3 хв. Опалення перейшло на Газовий котел — у кімнатах тепло.');
    assert.deepEqual(p.push.actions, ['Бачу', 'Відкрити Klimo']);
    const w = h.notify.preview('sensor_offline');
    assert.deepEqual(w.telegram.buttons, [['Ігнорувати до ранку', 'Виключити з розрахунку'], ['Відкрити Klimo']]);

    const s = h.notify.settings();
    const scope = new Map(s.targets.map((x) => [x.name, x.scope]));
    assert.equal(scope.get('Мій телефон'), 'by_matrix');
    assert.equal(scope.get('Планшет на кухні'), 'critical_only');
    assert.equal(scope.get('Сімейна група'), 'critical_and_escalation');
    assert.equal(s.catalogue.length, 35);
    assert.equal(s.telegramTokenPresent, false);
    assert.equal(s.channels.find((c) => c.channel === 'ha_persistent').openCount, 0);
  } finally {
    await h.close();
  }
});

test('sources sharing a name are told apart by their room in the messages', async () => {
  const h = await openNotify();
  try {
    await house(h);
    const { newSourceConfig } = require('../dist/shared/defaults');
    const room = (name) => h.config.create('rooms', { name }, ACTOR);
    const ac = async (roomId) => {
      const { id: _id, ...base } = newSourceConfig('ac', { id: '', name: 'Кондиціонер', now: 0 });
      return h.config.create('sources', { ...base, roomId }, ACTOR);
    };
    const living = await room('Вітальня');
    const bedroom = await room('Спальня');
    const a = await ac(living.id);
    await ac(bedroom.id);
    assert.equal(h.texts.names().source(a.id), 'Кондиціонер · Вітальня');
    await h.tick([det('source_unavailable', `source_unavailable:${a.id}`, { sourceId: a.id, facts: { sourceId: a.id, minutes: 3 } })]);
    await h.advance(5 * MIN);
    const msg = (await h.log()).find((m) => m.incidentId);
    assert.ok(msg.title.startsWith('Кондиціонер · Вітальня'), msg.title);
  } finally {
    await h.close();
  }
});
