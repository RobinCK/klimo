const assert = require('node:assert/strict');
const test = require('node:test');
const { ApiException } = require('../dist/common/http');
const { openMqtt, WED_1910 } = require('./mqtt-harness');

const handle = (h, topic, payload) => h.commands.handle(topic, payload, WED_1910);

test('a configuration entity from a non-admin HA user is rejected and changes nothing', async () => {
  const h = openMqtt({ configEntities: true });
  h.attribution.record('switch.klimo_source_s_hp_allowed', 'u_olia');
  const out = await handle(h, 'klimo/source/s_hp/allowed/set', 'OFF');
  assert.equal(out.ok, false);
  assert.equal(out.code, 'forbidden');
  assert.equal(out.changed, false);
  assert.equal(h.overrides.rows.length, 0);
  assert.equal(h.journal.entries.length, 0);
});

test('an unknown MQTT client may not touch configuration entities', async () => {
  const h = openMqtt({ configEntities: true });
  for (const [topic, payload] of [
    ['klimo/source/s_hp/allowed/set', 'OFF'],
    ['klimo/rule/economy/set', 'OFF'],
    ['klimo/number/bivalent_point/set', '-12'],
  ]) {
    const out = await handle(h, topic, payload);
    assert.equal(out.code, 'forbidden', topic);
  }
  assert.equal(h.overrides.rows.length, 0);
  assert.equal(h.config.updates.length, 0);
  assert.equal(h.config.patches.length, 0);
});

test('configuration entities are refused while the opt-in setting is off, even for an admin', async () => {
  const h = openMqtt({ configEntities: false });
  h.attribution.record('switch.klimo_source_s_hp_allowed', 'u_admin');
  const out = await handle(h, 'klimo/source/s_hp/allowed/set', 'OFF');
  assert.equal(out.code, 'forbidden');
  assert.equal(h.overrides.rows.length, 0);
});

test('an HA admin switches a source off and on, edits a rule and the bivalent point', async () => {
  const h = openMqtt({ configEntities: true });
  h.attribution.record('switch.klimo_source_s_hp_allowed', 'u_admin');
  const off = await handle(h, 'klimo/source/s_hp/allowed/set', 'OFF');
  assert.equal(off.ok, true);
  assert.equal(off.via, 'ha');
  assert.equal(h.overrides.rows.length, 1);
  const lock = h.overrides.rows[0];
  assert.deepEqual([lock.scope, lock.subjectId, lock.kind, lock.group, lock.duration, lock.until], ['source', 's_hp', 'source_off', 'source_lock', 'none', null]);
  assert.equal(lock.by.userId, 'u_admin');
  assert.equal(h.journal.entries[0].code, 'source.lock');
  assert.equal(h.journal.entries[0].params.by, 'Ігор');
  // switching off twice keeps one lock
  await handle(h, 'klimo/source/s_hp/allowed/set', 'OFF');
  assert.equal(h.overrides.rows.length, 1);
  await handle(h, 'klimo/source/s_hp/allowed/set', 'ON');
  assert.equal(h.overrides.rows.length, 0);

  h.attribution.record('switch.klimo_rule_economy', 'u_admin');
  assert.equal((await handle(h, 'klimo/rule/economy/set', 'OFF')).ok, true);
  assert.deepEqual(h.config.updates[0].patch, { enabled: false });
  assert.equal(h.cfg.rules[0].enabled, false);

  h.attribution.record('number.klimo_bivalent_point', 'u_admin');
  assert.equal((await handle(h, 'klimo/number/bivalent_point/set', '-12.0')).ok, true);
  assert.equal(h.config.patches[0].patch.bivalence.pointC, -12);
  assert.equal(h.config.patches[0].patch.bivalence.hysteresisC, 2);
  // out of range: −25 is below the entity minimum
  assert.equal((await handle(h, 'klimo/number/bivalent_point/set', '-25')).code, 'validation');
});

test('a room target from an unknown MQTT client is accepted and attributed to «mqtt»', async () => {
  const h = openMqtt();
  const out = await handle(h, 'klimo/room/r_9f2a1c/temp/set', '21.5');
  assert.equal(out.ok, true);
  assert.equal(out.roomId, 'r_9f2a1c');
  assert.equal(out.changed, true);
  const call = h.roomActions.calls.at(-1);
  assert.equal(call.name, 'applyClimateCommand');
  assert.equal(call.args[0], 'r_9f2a1c');
  assert.deepEqual(call.args[1], { temp: 21.5 });
  assert.deepEqual(call.args[2], { via: 'mqtt', userId: null, userName: null, contextId: null });
});

test('the HA preset «none» clears the room’s own profile instead of being rejected', async () => {
  const h = openMqtt();
  const out = await handle(h, 'klimo/room/r_9f2a1c/preset/set', 'none');
  assert.equal(out.ok, true);
  assert.deepEqual(
    h.roomActions.calls.map((c) => [c.name, c.args[0]]),
    [['clearRoomProfile', 'r_9f2a1c']],
  );
});

test('climate topics map onto the climate command, attributed through the entity registry', async () => {
  const h = openMqtt();
  // the user renamed the entity in HA: the call_service names the new id
  h.ha.regs.entities.push({ entity_id: 'climate.living_room', platform: 'mqtt', unique_id: 'klimo_r_9f2a1c_climate', device_id: null, area_id: null, disabled_by: null, hidden_by: null, original_name: null, name: null, entity_category: null });
  h.attribution.record('climate.living_room', 'u_olia');
  await handle(h, 'klimo/room/r_9f2a1c/mode/set', 'heat_cool');
  await handle(h, 'klimo/room/r_9f2a1c/temp_low/set', '20');
  await handle(h, 'klimo/room/r_9f2a1c/temp_high/set', '24.5');
  await handle(h, 'klimo/room/vitalnia/preset/set', 'Ніч');
  const calls = h.roomActions.calls.map((c) => [c.args[0], c.args[1]]);
  assert.deepEqual(calls, [
    ['r_9f2a1c', { mode: 'heat_cool' }],
    ['r_9f2a1c', { low: 20 }],
    ['r_9f2a1c', { high: 24.5 }],
    ['r_9f2a1c', { preset: 'Ніч' }],
  ]);
  assert.equal(h.roomActions.calls[0].args[2].userId, 'u_olia');
  assert.equal(h.roomActions.calls[0].args[2].via, 'ha');
  // garbage never reaches the room
  const bad = await handle(h, 'klimo/room/r_9f2a1c/temp/set', 'warm');
  assert.equal(bad.code, 'validation');
  assert.equal((await handle(h, 'klimo/room/r_9f2a1c/mode/set', 'dry')).code, 'validation');
  assert.equal((await handle(h, 'klimo/room/r_nope/temp/set', '20')).code, 'not_found');
  assert.equal(h.roomActions.calls.length, 4);
});

test('buttons, house selects and resync', async () => {
  const h = openMqtt();
  await handle(h, 'klimo/room/r_9f2a1c/boost/press', 'PRESS');
  await handle(h, 'klimo/room/r_9f2a1c/resume/press', 'PRESS');
  assert.deepEqual(h.roomActions.calls.map((x) => x.name), ['boost', 'resume']);
  assert.deepEqual(h.roomActions.calls[0].args.slice(0, 2), ['r_9f2a1c', {}]);
  assert.equal(h.roomActions.calls[1].args[0], 'r_9f2a1c');
  await handle(h, 'klimo/house/profile/set', 'Ніч');
  await handle(h, 'klimo/house/profile/set', 'away');
  await handle(h, 'klimo/house/season_mode/set', 'cool');
  await handle(h, 'klimo/house/resume/press', 'PRESS');
  assert.deepEqual(
    h.houseActions.calls.slice(0, 3).map((x) => [x.name, x.args[0]]),
    [
      ['setProfile', { profileId: 'night', duration: 'slot' }],
      ['setProfile', { profileId: 'away', duration: 'slot' }],
      ['setMode', 'cool'],
    ],
  );
  assert.equal(h.houseActions.calls[3].name, 'clearProfile');
  assert.equal(h.houseActions.calls[3].args[0].via, 'mqtt');
  assert.equal((await handle(h, 'klimo/house/profile/set', 'Невідомий')).code, 'not_found');
  assert.equal((await handle(h, 'klimo/resync/press', 'PRESS')).ok, true);
  assert.deepEqual(h.engine.resends, [{ all: true }]);
});

test('a card command is attributed through its mqtt.publish call and answered with an undo token', async () => {
  const h = openMqtt();
  h.attribution.record('mqtt.publish:req-1', 'u_olia');
  const cmd = { action: 'room.set_target', roomId: 'r_9f2a1c', value: 20.5, which: 't', duration: 'slot', reqId: 'req-1', user: 'u_olia' };
  const out = await handle(h, 'klimo/command', JSON.stringify(cmd));
  assert.equal(out.ok, true);
  assert.equal(out.via, 'card');
  assert.equal(out.roomId, 'r_9f2a1c');
  assert.deepEqual(out.reply, { reqId: 'req-1', action: 'room.set_target', ok: true, at: WED_1910, code: null, error: null, preview: null, revertToken: 'tok-1' });
  const [roomId, req, actor] = h.roomActions.calls[0].args;
  assert.equal(roomId, 'r_9f2a1c');
  assert.deepEqual(req, { value: 20.5, which: 't', duration: 'slot', reqId: 'req-1' });
  assert.equal(actor.userId, 'u_olia');
});

test('the payload «user» is a display name only, never an identity', async () => {
  const h = openMqtt();
  const out = await handle(h, 'klimo/command', JSON.stringify({ action: 'room.boost', roomId: 'r_9f2a1c', reqId: 'req-2', user: 'u_admin' }));
  assert.equal(out.ok, true);
  const actor = h.roomActions.calls[0].args[2];
  assert.deepEqual(actor, { via: 'mqtt', userId: null, userName: 'Ігор', contextId: null });
});

test('previews come back as card-ready texts and change nothing', async () => {
  const h = openMqtt();
  const room = await handle(h, 'klimo/command', JSON.stringify({ action: 'room.preview_target', roomId: 'r_9f2a1c', value: 21, duration: 'slot', reqId: 'p-1' }));
  assert.equal(room.changed, false);
  assert.deepEqual(room.reply.preview, { tone: 'heat', icon: 'flame', main: 'Пояснення preview.start_heat', chips: [], until: h.engine.profileState.scheduledUntil, etaMin: 25 });
  const house = await handle(h, 'klimo/command', JSON.stringify({ action: 'house.preview_profile', profileId: 'away', duration: 'slot', reqId: 'p-2' }));
  assert.equal(house.changed, false);
  assert.equal(house.reply.preview.icon, 'snow');
  assert.deepEqual(house.reply.preview.chips, ['Пояснення house.chip.down']);
});

test('invalid and unknown commands are answered when they carry a request id', async () => {
  const h = openMqtt();
  const invalid = await handle(h, 'klimo/command', JSON.stringify({ action: 'room.set_target', roomId: 'r_9f2a1c', value: 21, reqId: 'bad-1' }));
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reply.code, 'validation');
  assert.equal(invalid.reply.error, 'Невірні дані');
  const unknown = await handle(h, 'klimo/command', JSON.stringify({ action: 'room.dance', roomId: 'r_9f2a1c', reqId: 'bad-2' }));
  assert.equal(unknown.reply.code, 'validation');
  assert.equal(unknown.reply.error, 'Невідома дія');
  assert.equal(unknown.reply.action, 'room.dance');
  assert.equal(await handle(h, 'klimo/command', '{not json'), null);
  assert.equal(await handle(h, 'klimo/command', JSON.stringify({ action: 'room.boost', roomId: 'r_9f2a1c' })), null);
  assert.equal(h.roomActions.calls.length, 0);
});

test('a refusal from the action service reaches the card with its code', async () => {
  const h = openMqtt();
  h.roomActions.undo = async () => {
    throw new ApiException(409, 'revert_expired', 'The undo window has expired');
  };
  h.roomActions.boost = async () => {
    throw new ApiException(404, 'not_found', 'Room not found');
  };
  const expired = await handle(h, 'klimo/command', JSON.stringify({ action: 'room.undo', roomId: 'r_9f2a1c', revertToken: 'tok-1', reqId: 'u-1' }));
  assert.equal(expired.reply.code, 'revert_expired');
  assert.equal(expired.roomId, 'r_9f2a1c');
  const missing = await handle(h, 'klimo/command', JSON.stringify({ action: 'room.boost', roomId: 'r_9f2a1c', reqId: 'u-2' }));
  assert.equal(missing.reply.error, 'Не знайдено');
});

test('incident and house commands from the cards', async () => {
  const h = openMqtt();
  const snooze = await handle(h, 'klimo/command', JSON.stringify({ action: 'incident.snooze', incidentId: 'i_1', minutes: 30, reqId: 's-1' }));
  assert.equal(snooze.ok, true);
  assert.equal(snooze.roomId, 'r_0a4f6c');
  assert.deepEqual(h.incidents.acts[0].req, { action: 'snooze', minutes: 30 });
  await handle(h, 'klimo/command', JSON.stringify({ action: 'incident.dismiss', incidentId: 'i_2', reqId: 's-2' }));
  assert.deepEqual(h.incidents.acts[1].req, { action: 'dismiss' });
  const set = await handle(h, 'klimo/command', JSON.stringify({ action: 'house.set_profile', profileId: 'guests', duration: '2h', reqId: 'h-1' }));
  assert.equal(set.reply.revertToken, 'tok-house');
  assert.deepEqual(h.houseActions.calls[0].args[0], { profileId: 'guests', duration: '2h', reqId: 'h-1' });
  await handle(h, 'klimo/command', JSON.stringify({ action: 'room.off', roomId: 'r_9f2a1c', reqId: 'o-1' }));
  assert.deepEqual(h.roomActions.calls[0].args[1], { duration: 'none' });
  await handle(h, 'klimo/command', JSON.stringify({ action: 'resync', reqId: 'x-1' }));
  assert.deepEqual(h.engine.resends, [{ all: true }]);
});
