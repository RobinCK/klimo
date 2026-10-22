const assert = require('node:assert/strict');
const test = require('node:test');
const { ACTOR, MIN, SEC, det, openNotify, rejection } = require('./notify-harness');

const offline = (entity, patch = {}) => det('sensor_offline', `sensor_offline:${entity}`, { entityId: entity, facts: { name: 'Шафа', minutes: 95 }, ...patch });

test('flap guard: a problem resolves only after 120 s clear, and comes back on the same row within 10 min', async () => {
  const h = await openNotify();
  const changes = [];
  h.incidents.onChange((c) => changes.push(c));
  try {
    await h.tick([offline('sensor.a')]);
    const [first] = h.incidents.list({ scope: 'all' });
    assert.equal(first.status, 'open');
    assert.equal(changes.at(-1).reason, 'opened');
    assert.equal(changes.at(-1).notify, true);

    // clear for 100 s: still open; a blip back keeps it open and silent
    await h.tick([], 0);
    await h.tick([], 100 * SEC);
    assert.equal(h.incidents.get(first.id).status, 'open');
    await h.tick([offline('sensor.a')], 10 * SEC);
    assert.equal(h.incidents.get(first.id).clearSince, null);
    assert.equal(changes.filter((c) => c.notify).length, 1);

    // clear continuously for 120 s → resolved
    await h.tick([], 0);
    await h.tick([], 119 * SEC);
    assert.equal(h.incidents.get(first.id).status, 'open');
    await h.tick([], 2 * SEC);
    assert.equal(h.incidents.get(first.id).status, 'resolved');
    assert.equal(changes.at(-1).reason, 'resolved');

    // back within 10 min: the same row re-opens without a new message
    await h.tick([offline('sensor.a')], 5 * MIN);
    assert.equal(h.incidents.get(first.id).status, 'open');
    assert.equal(changes.at(-1).reason, 'reopened');
    assert.equal(changes.at(-1).notify, false);
    assert.equal(h.incidents.list({ scope: 'all' }).length, 1);

    // solved again, then back after more than 10 min: a new incident
    await h.tick([], 0);
    await h.tick([], 3 * MIN);
    assert.equal(h.incidents.get(first.id).status, 'resolved');
    await h.tick([offline('sensor.a')], 11 * MIN);
    const all = h.incidents.list({ scope: 'all' });
    assert.equal(all.length, 2);
    assert.notEqual(all.find((i) => i.status === 'open').id, first.id);
  } finally {
    await h.close();
  }
});

test('grace period from the catalogue params and a disabled kind', async () => {
  const h = await openNotify();
  try {
    await h.config.setEventParams('signal_weak', { params: { openAfterSec: 60 } }, ACTOR);
    const weak = det('signal_weak', 'signal:dev1', { deviceKey: 'dev1', facts: { lqi: 50 } });
    await h.tick([weak]);
    assert.equal(h.incidents.list({ scope: 'all' }).length, 0);
    await h.tick([weak], 30 * SEC);
    assert.equal(h.incidents.list({ scope: 'all' }).length, 0);
    await h.tick([weak], 31 * SEC);
    assert.equal(h.incidents.list({ scope: 'all' }).length, 1);

    await h.config.setEventParams('battery_low', { enabled: false }, ACTOR);
    await h.tick([weak, det('battery_low', 'battery:dev2', { deviceKey: 'dev2', facts: { pct: 12 } })]);
    assert.equal(h.incidents.list({ scope: 'all' }).filter((i) => i.kind === 'battery_low').length, 0);
  } finally {
    await h.close();
  }
});

test('nothing resolves by silence while Home Assistant is away', async () => {
  const h = await openNotify();
  try {
    await h.tick([offline('sensor.a')]);
    h.ha.connected = false;
    await h.tick([], 0);
    await h.tick([], 10 * MIN);
    assert.equal(h.incidents.list({ scope: 'all' })[0].status, 'open');
    h.ha.connected = true;
    await h.tick([], 0);
    await h.tick([], 121 * SEC);
    assert.equal(h.incidents.list({ scope: 'all' })[0].status, 'resolved');
  } finally {
    await h.close();
  }
});

test('critical alerts are acknowledged, never snoozed or hidden', async () => {
  const h = await openNotify();
  try {
    await h.tick([det('source_failed', 'source_failed:s_hp', { sourceId: 's_hp', facts: { code: 'no_confirm' } })]);
    const [inc] = h.incidents.list({ scope: 'attention' });
    assert.equal(inc.severity, 'critical');
    assert.ok(inc.actions.includes('ack'));
    assert.ok(!inc.actions.includes('snooze'));
    assert.equal(inc.dismiss, 'none');
    for (const action of ['snooze', 'snooze_until_morning', 'dismiss']) {
      const e = await rejection(() => h.incidents.act(inc.id, { action }, ACTOR));
      assert.equal(e.getStatus(), 409);
    }
    const acked = await h.incidents.act(inc.id, { action: 'ack' }, ACTOR);
    assert.equal(acked.status, 'acknowledged');
    assert.equal(acked.ackBy.userName, 'Ігор');
    // pressing «Бачу» twice changes nothing
    const again = await h.incidents.act(inc.id, { action: 'ack' }, { ...ACTOR, userName: 'Оля' });
    assert.equal(again.ackBy.userName, 'Ігор');
    assert.deepEqual(h.incidents.counts(), { critical: 1, warning: 0, total: 1, deviceIssues: 0, inbox: 0 });
  } finally {
    await h.close();
  }
});

test('snooze hides from attention and the inbox but not from Devices; after it the alert comes back once', async () => {
  const h = await openNotify();
  const changes = [];
  h.incidents.onChange((c) => changes.push(c));
  try {
    await h.tick([offline('sensor.a')]);
    const [inc] = h.incidents.list({ scope: 'inbox' });
    assert.equal(h.incidents.counts().inbox, 1);
    const snoozed = await h.incidents.act(inc.id, { action: 'snooze', minutes: 30 }, ACTOR);
    assert.equal(snoozed.hidden, true);
    assert.equal(snoozed.snoozedUntil, h.clock.now() + 30 * MIN);
    assert.deepEqual(h.incidents.counts(), { critical: 0, warning: 0, total: 0, deviceIssues: 1, inbox: 0 });
    assert.equal(h.incidents.list({ scope: 'devices' }).length, 1);

    await h.tick([offline('sensor.a')], 31 * MIN);
    const back = changes.filter((c) => c.reason === 'unsnoozed');
    assert.equal(back.length, 1);
    assert.equal(back[0].notify, true);
    assert.equal(h.incidents.counts().inbox, 1);

    const morning = await h.incidents.act(inc.id, { action: 'snooze_until_morning' }, ACTOR);
    const local = new Date(morning.snoozedUntil + 3 * 3600_000);
    assert.equal(local.getUTCHours(), 7);
    assert.equal(local.getUTCMinutes(), 0);
    assert.ok(morning.snoozedUntil > h.clock.now());
  } finally {
    await h.close();
  }
});

test('a dismissed battery comes back when it reaches the reminder level', async () => {
  const h = await openNotify();
  const changes = [];
  h.incidents.onChange((c) => changes.push(c));
  try {
    const battery = (pct) => det('battery_low', 'battery:dev1', { deviceKey: 'dev1', facts: { pct, name: 'Кнопка' } });
    await h.tick([battery(15)]);
    const [inc] = h.incidents.list({ scope: 'all' });
    const dismissed = await h.incidents.act(inc.id, { action: 'dismiss' }, ACTOR);
    assert.equal(dismissed.dismissedUntilPct, 5);
    assert.equal(dismissed.hidden, true);
    await h.tick([battery(9)], MIN);
    assert.equal(h.incidents.get(inc.id).hidden, true);
    await h.tick([battery(5)], MIN);
    const back = h.incidents.get(inc.id);
    assert.equal(back.hidden, false);
    assert.equal(back.dismissedUntilPct, null);
    assert.equal(changes.at(-1).notify, true);
  } finally {
    await h.close();
  }
});

test('one-shot events open and resolve at once and are not repeated', async () => {
  const h = await openNotify();
  const changes = [];
  h.incidents.onChange((c) => changes.push(c));
  try {
    const ev = det('trigger_fired', 'trigger:blackout:1000', { facts: { triggerId: 'blackout' } });
    await h.tick([ev]);
    await h.tick([ev], SEC);
    const all = h.incidents.list({ scope: 'all' });
    assert.equal(all.length, 1);
    assert.equal(all[0].status, 'resolved');
    assert.equal(all[0].tone, 'event');
    assert.equal(changes.filter((c) => c.reason === 'oneshot').length, 1);
    assert.equal(h.incidents.counts().total, 0);
  } finally {
    await h.close();
  }
});

test('severity rising re-raises an acknowledged incident', async () => {
  const h = await openNotify();
  const changes = [];
  h.incidents.onChange((c) => changes.push(c));
  try {
    const noData = (severity) => det('room_no_data', 'room_no_data:r1', { roomId: 'r1', severity, facts: { minutes: 12 } });
    await h.tick([noData('warning')]);
    const [inc] = h.incidents.list({ scope: 'all' });
    await h.incidents.act(inc.id, { action: 'ack' }, ACTOR);
    await h.tick([noData('critical')], MIN);
    const now = h.incidents.get(inc.id);
    assert.equal(now.severity, 'critical');
    assert.equal(now.status, 'open');
    assert.equal(changes.at(-1).reason, 'severity');
    assert.equal(changes.at(-1).notify, true);
  } finally {
    await h.close();
  }
});

test('actions reach the room, the sensor and the radiator valve', async () => {
  const h = await openNotify();
  try {
    const room = await h.config.create('rooms', { ...require('../dist/shared/defaults').DEFAULT_ROOM(), name: 'Кухня', slug: 'kukhnia' }, ACTOR);
    const { id: _s, ...sensorBase } = require('../dist/shared/defaults').DEFAULT_SENSOR();
    const sensor = await h.config.create('sensors', { ...sensorBase, roomId: room.id, entityId: 'sensor.kitchen_shelf_temperature', role: 'temperature', name: 'На полиці' }, ACTOR);
    await h.tick([offline('sensor.kitchen_shelf_temperature', { roomId: room.id })]);
    const [inc] = h.incidents.list({ scope: 'all' });
    const after = await h.incidents.act(inc.id, { action: 'exclude_sensor' }, ACTOR);
    assert.equal(h.config.get('sensors', sensor.id).included, false);
    assert.equal(h.config.get('sensors', sensor.id).excludedBy, 'notification');
    assert.equal(after.hidden, true);
    const page = await h.journal.page({ codes: ['sensor.excluded'] });
    assert.equal(page.items.length, 1);
    await h.incidents.act(inc.id, { action: 'include_sensor' }, ACTOR);
    assert.equal(h.config.get('sensors', sensor.id).included, true);

    await h.tick([offline('sensor.kitchen_shelf_temperature', { roomId: room.id }), det('trv_not_confirmed', 'trv:climate.bath', { roomId: room.id, entityId: 'climate.bath', facts: {} }), det('window_open_long', `window:${room.id}`, { roomId: room.id, facts: { minutes: 25 } })]);
    const trv = h.incidents.list({ scope: 'all' }).find((i) => i.kind === 'trv_not_confirmed');
    await h.incidents.act(trv.id, { action: 'retry_trv' }, ACTOR);
    assert.deepEqual(h.engine.resent, [{ entityId: 'climate.bath' }]);
    const win = h.incidents.list({ scope: 'all' }).find((i) => i.kind === 'window_open_long');
    assert.equal(win.dismiss, 'snooze_30m');
    const ignored = await h.incidents.act(win.id, { action: 'ignore_window' }, ACTOR);
    assert.equal(h.roomActions.calls[0].op, 'ignoreWindow');
    assert.equal(h.roomActions.calls[0].req.minutes, 30);
    assert.equal(ignored.hidden, true);
  } finally {
    await h.close();
  }
});

test('incidents survive a restart with their flags', async () => {
  const h = await openNotify({ keepDir: true });
  let id;
  try {
    await h.tick([det('source_failed', 'source_failed:s_hp', { sourceId: 's_hp', facts: { code: 'no_confirm' } })]);
    id = h.incidents.list({ scope: 'all' })[0].id;
    await h.incidents.act(id, { action: 'ack' }, ACTOR);
    h.incidents.markDelivery(id, { notifiedAt: h.clock.now(), repeatCount: 2 });
  } finally {
    await h.close();
  }
  const h2 = await openNotify({ dir: h.dir });
  try {
    const inc = h2.incidents.get(id);
    assert.equal(inc.status, 'acknowledged');
    assert.equal(inc.repeatCount, 2);
    assert.equal(inc.ackBy.userName, 'Ігор');
    // the restored row keeps its dedup key: the same detection updates it
    await h2.tick([det('source_failed', 'source_failed:s_hp', { sourceId: 's_hp', facts: { code: 'no_confirm' } })]);
    assert.equal(h2.incidents.list({ scope: 'all' }).length, 1);
  } finally {
    await h2.close();
  }
});
