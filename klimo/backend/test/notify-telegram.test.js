const assert = require('node:assert/strict');
const test = require('node:test');
const { MIN, SEC, det, openNotify } = require('./notify-harness');
const ch = require('../dist/notify/channels/channel');

const UUID = '3f2c9a1e-8b7d-4c6e-9f00-1234567890ab';

test('button payloads of phones, the HA integration and the own bot', () => {
  assert.equal(ch.mobileActionId('snooze_until_morning', UUID), `KLIMO_SNOOZE_UNTIL_MORNING_${UUID}`);
  assert.deepEqual(ch.parseMobileAction(`KLIMO_SNOOZE_UNTIL_MORNING_${UUID}`), { action: 'snooze_until_morning', incidentId: UUID });
  assert.deepEqual(ch.parseMobileAction(`KLIMO_ACK_${UUID}`), { action: 'ack', incidentId: UUID });
  assert.equal(ch.parseMobileAction(`KLIMO_REBOOT_${UUID}`), null);
  assert.equal(ch.parseMobileAction('URI'), null);
  assert.equal(ch.parseMobileAction(`OTHER_ACK_${UUID}`), null);
  assert.equal(ch.parseMobileAction(42), null);

  assert.deepEqual(ch.parseIntegrationCallback(`/klimo retry_trv ${UUID}`), { action: 'retry_trv', incidentId: UUID });
  assert.deepEqual(ch.parseIntegrationCallback(`  /klimo ACK ${UUID} `), { action: 'ack', incidentId: UUID });
  assert.equal(ch.parseIntegrationCallback(`/klimo drop_table ${UUID}`), null);
  assert.equal(ch.parseIntegrationCallback(`/other ack ${UUID}`), null);

  const data = ch.ownCallbackData(UUID, 'snooze_until_morning');
  assert.ok(Buffer.byteLength(data) <= 64, `${data} is ${Buffer.byteLength(data)} bytes`);
  assert.deepEqual(ch.parseOwnCallback(data), { action: 'snooze_until_morning', incidentId: UUID });
  assert.equal(ch.parseOwnCallback(`k|${UUID}|nope`), null);
  assert.equal(ch.parseOwnCallback(`x|${UUID}|ack`), null);
  assert.equal(ch.parseOwnCallback('k|not an id|ack'), null);
});

async function ownBot(h) {
  await h.settings({ telegram: { mode: 'own', haService: null, botUsername: null } });
  return h.target({ channel: 'telegram', name: 'Особистий', icon: 'send', chatId: '1001', chatTitle: 'Ігор', isPrimary: true });
}

test('a 409 from getUpdates stops polling: polling_conflict and channel_failed, sending still works', async () => {
  const h = await openNotify({ token: '123:abc' });
  try {
    await ownBot(h);
    h.tg.reply('getUpdates', 409, { ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' });
    assert.equal(await h.bot.pollOnce(), 'conflict');
    await h.router.idle();
    const ch = h.notify.settings().channels.find((c) => c.channel === 'telegram');
    assert.equal(ch.status, 'polling_conflict');
    const failed = h.incidents.list({ scope: 'all' }).find((i) => i.kind === 'channel_failed');
    assert.ok(failed);
    assert.equal(failed.dedupKey, 'channel:telegram');
    assert.equal(failed.facts.reason, 'polling_conflict');

    // sending is unaffected
    await h.notify.test({ channel: 'telegram' });
    assert.equal(h.tg.of('sendMessage').length >= 1, true);

    // the other poller went away: the next successful poll settles the alert
    h.tg.replies.delete('getUpdates');
    assert.equal(await h.bot.pollOnce(), 'ok');
    assert.equal(h.notify.settings().channels.find((c) => c.channel === 'telegram').status, 'ok');
    await h.tick([], 121 * SEC);
    assert.equal(h.incidents.get(failed.id).status, 'resolved');
  } finally {
    await h.close();
  }
});

test('a webhook on the token or a rejected token is reported instead of polled against', async () => {
  const h = await openNotify({ token: '123:abc' });
  try {
    await ownBot(h);
    h.tg.reply('getWebhookInfo', 200, { ok: true, result: { url: 'https://example.org/hook' } });
    assert.equal(await h.bot.checkWebhook(), false);
    assert.equal(h.notify.settings().channels.find((c) => c.channel === 'telegram').status, 'webhook_set');
    assert.equal(h.incidents.list({ scope: 'all' }).find((i) => i.kind === 'channel_failed').facts.reason, 'webhook_set');

    h.tg.replies.delete('getWebhookInfo');
    assert.equal(await h.bot.checkWebhook(), true);
    h.tg.reply('getMe', 401, { ok: false, error_code: 401, description: 'Unauthorized' });
    const me = await h.bot.verify();
    assert.equal(me.ok, false);
    assert.equal(h.notify.settings().channels.find((c) => c.channel === 'telegram').status, 'error');
  } finally {
    await h.close();
  }
});

test('own bot: buttons as callback queries, pressing one acts, answers and leaves a result line', async () => {
  const h = await openNotify({ token: '123:abc' });
  try {
    await ownBot(h);
    assert.deepEqual(await h.bot.verify(), { ok: true, botUsername: 'klimo_home_bot', error: null });
    assert.equal(h.config.singleton('notify').telegram.botUsername, 'klimo_home_bot');
    await h.tick([det('sensor_offline', 'sensor_offline:sensor.a', { entityId: 'sensor.a', facts: { name: 'Шафа', minutes: 95 } })]);
    await h.advance(2 * MIN + SEC);
    const [inc] = h.incidents.list({ scope: 'all' });
    const send = h.tg.of('sendMessage')[0].body;
    assert.equal(send.chat_id, '1001');
    assert.equal(send.parse_mode, 'HTML');
    assert.match(send.text, /^<b>Шафа: не на зв’язку<\/b>\n/);
    assert.deepEqual(send.reply_markup.inline_keyboard, [
      [
        { text: 'Ігнорувати до ранку', callback_data: `k|${inc.id}|snooze_until_morning` },
        { text: 'Виключити з розрахунку', callback_data: `k|${inc.id}|exclude_sensor` },
      ],
      [{ text: 'Відкрити Klimo', callback_data: `k|${inc.id}|open` }],
    ]);

    const nowSec = Math.floor(h.clock.now() / 1000);
    h.tg.reply('getUpdates', 200, {
      ok: true,
      result: [
        {
          update_id: 501,
          callback_query: {
            id: 'q1',
            from: { id: 1001, first_name: 'Ігор' },
            data: `k|${inc.id}|snooze_until_morning`,
            message: { message_id: 77, date: nowSec, chat: { id: 1001, type: 'private' }, text: 'Шафа: не на зв’язку\nШафа, 1 год 35 хв без даних.' },
          },
        },
      ],
    });
    assert.equal(await h.bot.pollOnce(), 'ok');
    const snoozed = h.incidents.get(inc.id);
    assert.ok(snoozed.snoozedUntil > h.clock.now());
    assert.equal(h.tg.of('answerCallbackQuery')[0].body.text, 'Сховано до завтра 07:00');
    const edit = h.tg.of('editMessageText')[0].body;
    assert.equal(edit.message_id, 77);
    assert.equal(edit.reply_markup, undefined);
    assert.equal(edit.text, '<b>Шафа: не на зв’язку</b>\nШафа, 1 год 35 хв без даних.\n\n✓ Сховано до завтра 07:00');
    assert.equal(await h.db.kvGet('telegram.offset'), '502');

    // a press from a chat Klimo does not know does nothing
    h.tg.reply('getUpdates', 200, { ok: true, result: [{ update_id: 502, callback_query: { id: 'q2', from: { id: 9 }, data: `k|${inc.id}|ack`, message: { message_id: 1, date: nowSec, chat: { id: 9, type: 'private' }, text: 'x' } } }] });
    await h.bot.pollOnce();
    assert.equal(h.tg.of('answerCallbackQuery')[1].body.text, 'Цей чат не підключено до Klimo');
    assert.equal(h.incidents.get(inc.id).status, 'open');

    // a button older than a day
    h.tg.reply('getUpdates', 200, { ok: true, result: [{ update_id: 503, callback_query: { id: 'q3', from: { id: 1001 }, data: `k|${inc.id}|exclude_sensor`, message: { message_id: 2, date: nowSec - 25 * 3600, chat: { id: 1001, type: 'private' }, text: 'x' } } }] });
    await h.bot.pollOnce();
    assert.equal(h.tg.of('answerCallbackQuery')[2].body.text, 'Застаріло — відкрийте Klimo');
  } finally {
    await h.close();
  }
});

test('pairing: /start with a fresh code turns the chat into a target', async () => {
  const h = await openNotify({ token: '123:abc' });
  try {
    await h.settings({ telegram: { mode: 'own', haService: null, botUsername: null } });
    await h.bot.verify();
    const pair = await h.notify.telegramPair();
    assert.match(pair.code, /^[A-Z2-9]{6}$/);
    assert.equal(pair.deepLink, `https://t.me/klimo_home_bot?start=${pair.code}`);
    assert.equal(pair.expiresAt, h.clock.now() + 10 * MIN);
    assert.equal(h.notify.telegramPairStatus(pair.code).status, 'pending');

    h.tg.reply('getUpdates', 200, { ok: true, result: [{ update_id: 10, message: { message_id: 3, date: 0, chat: { id: -100555, type: 'supergroup', title: 'Сім’я' }, text: `/start@klimo_home_bot ${pair.code}` } }] });
    await h.bot.pollOnce();
    const status = h.notify.telegramPairStatus(pair.code);
    assert.equal(status.status, 'paired');
    assert.equal(status.target.chatId, '-100555');
    assert.equal(status.target.chatTitle, 'Сім’я');
    assert.equal(status.target.icon, 'users');
    assert.equal(status.target.isPrimary, true, 'the first messaging target becomes the primary one');
    assert.equal(h.tg.of('sendMessage').at(-1).body.text, 'Готово: цей чат тепер отримує сповіщення Klimo.');

    // an unknown or expired code only gets an explanation
    const late = await h.notify.telegramPair();
    h.clock.advance(11 * MIN);
    h.tg.reply('getUpdates', 200, { ok: true, result: [{ update_id: 11, message: { message_id: 4, date: 0, chat: { id: 777, type: 'private', first_name: 'Оля' }, text: `/start ${late.code}` } }] });
    await h.bot.pollOnce();
    assert.equal(h.notify.telegramPairStatus(late.code).status, 'expired');
    assert.equal(h.config.list('targets').filter((t) => t.channel === 'telegram').length, 1);
    assert.equal(h.tg.of('sendMessage').at(-1).body.text, 'Код застарів — створіть новий у Klimo.');
  } finally {
    await h.close();
  }
});

test('pairing through the HA integration (telegram_command)', async () => {
  const h = await openNotify();
  try {
    await h.settings({ telegram: { mode: 'integration', haService: null, botUsername: null } });
    const pair = await h.notify.telegramPair();
    assert.equal(pair.deepLink, null);
    await h.ha.emit('telegram_command', { command: '/start', args: [pair.code.toLowerCase()], chat_id: 4242, from_first: 'Оля' });
    const t = h.config.list('targets').find((x) => x.channel === 'telegram');
    assert.equal(t.chatId, '4242');
    assert.equal(t.name, 'Оля');
    assert.equal(h.ha.callsOf('telegram_bot', 'send_message').at(-1).data.target[0], 4242);
    assert.ok(h.ha.subscribed.includes('telegram_command'));
  } finally {
    await h.close();
  }
});

test('«HA не на зв’язку» goes only through the own bot, to Telegram chats', async () => {
  const h = await openNotify({ token: '123:abc' });
  try {
    await h.settings({ telegram: { mode: 'integration', haService: null, botUsername: null } });
    await h.target({ name: 'Мій телефон', service: 'notify.mobile_app_phone', isPrimary: true });
    const me = await h.target({ channel: 'telegram', name: 'Особистий', icon: 'send', chatId: '1001' });
    h.ha.connected = false;
    await h.tick([det('ha_disconnected', 'ha_disconnected', { facts: { minutes: 11 } })]);
    const [msg] = await h.log();
    assert.deepEqual(msg.targets.map((x) => x.targetId), [me.id]);
    assert.equal(msg.targets[0].state, 'delivered');
    assert.equal(msg.title, 'Home Assistant не на зв’язку');
    assert.match(h.tg.of('sendMessage')[0].body.text, /Немає зв’язку 11 хв/);
    assert.equal(h.ha.calls.length, 0);
    // the automation event cannot reach HA, MQTT still carries it only when routed (it is not, by default)
    assert.equal(h.mqtt.published.length, 0);
  } finally {
    await h.close();
  }
});

test('pairing: a used code does not pair a second chat it was forwarded to', async () => {
  const h = await openNotify({ token: '123:abc' });
  try {
    await h.settings({ telegram: { mode: 'own', haService: null, botUsername: null } });
    await h.bot.verify();
    const pair = await h.notify.telegramPair();
    const start = (update_id, chat) => ({ update_id, message: { message_id: update_id, date: 0, chat, text: `/start ${pair.code}` } });
    h.tg.reply('getUpdates', 200, { ok: true, result: [start(20, { id: 501, type: 'private', first_name: 'Ігор' })] });
    await h.bot.pollOnce();
    assert.equal(h.notify.telegramPairStatus(pair.code).target.chatId, '501');

    // the same chat again is harmless; another chat with the same link is turned away
    h.tg.reply('getUpdates', 200, { ok: true, result: [start(21, { id: 501, type: 'private', first_name: 'Ігор' }), start(22, { id: 909, type: 'private', first_name: 'Чужий' })] });
    await h.bot.pollOnce();
    const chats = h.config.list('targets').filter((t) => t.channel === 'telegram').map((t) => t.chatId);
    assert.deepEqual(chats, ['501']);
    assert.equal(h.tg.of('sendMessage').at(-1).body.chat_id, '909');
    assert.equal(h.tg.of('sendMessage').at(-1).body.text, 'Код застарів — створіть новий у Klimo.');
  } finally {
    await h.close();
  }
});

test('polling survives a database hiccup and an unexpected failure does not wedge it', async () => {
  const h = await openNotify({ token: '123:abc' });
  try {
    await ownBot(h);
    const kvGet = h.db.kvGet.bind(h.db);
    h.db.kvGet = async () => {
      throw new Error('database is locked');
    };
    assert.equal(await h.bot.pollOnce(), 'error');
    h.db.kvGet = kvGet;
    assert.equal(await h.bot.pollOnce(), 'ok');

    // a crash inside the loop clears the polling flag, so the next reconcile starts it again
    h.bot.verify = async () => {
      throw new Error('boom');
    };
    await h.bot.reconcile();
    await h.bot.loopDone;
    assert.equal(h.bot.isPolling(), false);
    let started = 0;
    h.bot.verify = async () => {
      started++;
      return { ok: false, botUsername: null, error: 'offline' };
    };
    await h.bot.reconcile();
    await h.bot.loopDone;
    assert.equal(started, 1);
    await h.bot.stop();
  } finally {
    await h.close();
  }
});
