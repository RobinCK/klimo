const assert = require('node:assert/strict');
const test = require('node:test');
const { ACTOR, HOUR, MIN, heatingTarget, openServices, rejection } = require('./services-harness');

async function withRoom(fn) {
  const s = await openServices();
  try {
    const room = await s.config.create('rooms', { name: 'Вітальня' }, ACTOR);
    s.setRoom(room.id, { state: 'heat', tempC: 19.8, target: heatingTarget(20) });
    s.engine.hp = { activeProfileId: 'home', layer: 'house_schedule', scheduledProfileId: 'home', scheduledUntil: null, nextProfileId: 'night', override: null, presence: { configured: false, anyoneHome: null, awaySince: null, approaching: false } };
    await fn(s, room);
  } finally {
    await s.close();
  }
}

test('a target until the end of the slot is an override with a 30-second undo token', () =>
  withRoom(async (s, room) => {
    const now = s.clock.now();
    s.t.slotEnd = now + 3 * HOUR + 50 * MIN; // 23:00
    const r = await s.roomActions.setTarget(room.id, { value: 20.5, duration: 'slot', reqId: 'req-1' }, ACTOR);
    assert.equal(r.override.kind, 'room_target');
    assert.equal(r.override.group, 'target');
    assert.deepEqual(r.override.value, { kind: 'room_target', mode: 'heat', heatC: 20.5, coolC: null });
    assert.equal(r.until, s.t.slotEnd);
    assert.equal(r.override.until, s.t.slotEnd);
    assert.equal(typeof r.revertToken, 'string');
    assert.equal(r.revertUntil, now + 30_000);
    assert.equal(r.reqId, 'req-1');
    assert.equal(r.override.reqId, 'req-1');
    assert.equal(r.profileWritten, null);
    assert.equal(r.state.roomId, room.id);
    assert.deepEqual(s.engine.runs, ['room.target']);

    // the same request id within a minute is the same change, not a second one
    const again = await s.roomActions.setTarget(room.id, { value: 20.5, duration: 'slot', reqId: 'req-1' }, ACTOR);
    assert.equal(again.override.id, r.override.id);
    assert.equal(s.overrides.active().length, 1);

    const page = await s.journal.page({ roomId: room.id });
    assert.equal(page.items[0].code, 'room.override');
    assert.equal(page.items[0].params.kind, 'room_target');
    assert.equal(page.items[0].params.valueC, 20.5);
    assert.equal(page.items[0].params.by, 'Ігор');
  }));

test('undo within 30 s restores the replaced override; later the token has expired (409)', () =>
  withRoom(async (s, room) => {
    const first = await s.roomActions.setTarget(room.id, { value: 21, duration: 'slot' }, ACTOR);
    const second = await s.roomActions.setTarget(room.id, { value: 22, duration: '1h' }, ACTOR);
    assert.equal(second.override.previous.override.id, first.override.id);
    assert.equal(s.overrides.active().length, 1);

    s.clock.advance(10_000);
    const undone = await s.roomActions.undo(room.id, second.revertToken, ACTOR);
    assert.equal(undone.override.id, first.override.id);
    assert.equal(undone.override.value.heatC, 21);
    assert.equal(undone.revertToken, null);
    const active = s.overrides.active();
    assert.equal(active.length, 1);
    assert.equal(active[0].value.heatC, 21);
    // a used token does not work twice
    assert.equal((await rejection(() => s.roomActions.undo(room.id, second.revertToken, ACTOR))).code, 'revert_expired');

    const third = await s.roomActions.setTarget(room.id, { value: 23, duration: '1h' }, ACTOR);
    s.clock.advance(31_000);
    const e = await rejection(() => s.roomActions.undo(room.id, third.revertToken, ACTOR));
    assert.equal(e.getStatus(), 409);
    assert.equal(e.code, 'revert_expired');
    assert.equal(s.overrides.active()[0].value.heatC, 23);
  }));

test('undo of the first manual change returns the room to its schedule', () =>
  withRoom(async (s, room) => {
    const r = await s.roomActions.setTarget(room.id, { value: 22, duration: '2h' }, ACTOR);
    const undone = await s.roomActions.undo(room.id, r.revertToken, ACTOR);
    assert.equal(undone.override, null);
    assert.equal(s.overrides.active().length, 0);
  }));

test('«Постійно» writes the value into the governing profile, drops the manual override and undoes cleanly', () =>
  withRoom(async (s, room) => {
    const manual = await s.roomActions.setTarget(room.id, { value: 23, duration: 'slot' }, ACTOR);
    const now = s.clock.now();
    const r = await s.roomActions.setTarget(room.id, { value: 20.5, duration: 'forever' }, ACTOR);
    assert.equal(r.override, null);
    assert.deepEqual(r.profileWritten, { profileId: 'home', heatC: 20.5, coolC: null });
    assert.equal(r.until, null);
    assert.equal(typeof r.revertToken, 'string');
    const row = s.config.profileRooms().find((x) => x.roomId === room.id);
    assert.deepEqual(row, { profileId: 'home', roomId: room.id, mode: 'own', heatC: 20.5, coolC: null, writtenAt: now });
    assert.equal(s.overrides.active().length, 0);
    const page = await s.journal.page({ roomId: room.id, codes: ['room.profile_written'] });
    assert.equal(page.items[0].params.profileId, 'home');

    const undone = await s.roomActions.undo(room.id, r.revertToken, ACTOR);
    assert.equal(s.config.profileRooms().some((x) => x.roomId === room.id), false);
    assert.equal(undone.override.id, manual.override.id);
    assert.equal(s.overrides.active()[0].value.heatC, 23);
  }));

test('«Постійно» follows a room schedule that outranks the house schedule', () =>
  withRoom(async (s, room) => {
    const plan = [{ start: 0, end: 1440, profileId: 'night' }];
    await s.config.create('schedules', { scope: 'room', roomId: room.id, enabled: true, days: Array.from({ length: 7 }, () => plan), updatedAt: 0 }, ACTOR);
    const r = await s.roomActions.setTarget(room.id, { value: 18.5, duration: 'forever' }, ACTOR);
    assert.equal(r.profileWritten.profileId, 'night');
  }));

test('targets snap to the 0.5° grid and stay inside the room limits', () =>
  withRoom(async (s, room) => {
    const a = await s.roomActions.setTarget(room.id, { value: 20.3, duration: '1h' }, ACTOR);
    assert.equal(a.override.value.heatC, 20.5);
    const b = await s.roomActions.setTarget(room.id, { value: 35, duration: '1h' }, ACTOR);
    assert.equal(b.override.value.heatC, 30);
    await s.config.update('rooms', room.id, { limits: { heatMinC: 16, heatMaxC: 24, coolMinC: 20, coolMaxC: 28 } }, ACTOR);
    const c = await s.roomActions.setTarget(room.id, { value: 26, duration: '1h' }, ACTOR);
    assert.equal(c.override.value.heatC, 24);
    const e = await rejection(() => s.roomActions.setTarget(room.id, { duration: '1h' }, ACTOR));
    assert.equal(e.code, 'validation');
    const u = await rejection(() => s.roomActions.setTarget(room.id, { value: 21, duration: 'until', until: s.clock.now() + MIN }, ACTOR));
    assert.equal(u.issues[0].path, 'until');
  }));

test('a dual range keeps the minimum gap by moving the bound the user did not touch', () =>
  withRoom(async (s, room) => {
    s.setRoom(room.id, { state: 'hold', tempC: 22, target: { heatC: 20, coolC: 25, mode: 'dual', displayC: null, layer: 'house_schedule', display: 'schedule', profileId: 'home' }, activeModes: { heat: true, cool: true } });
    const lo = await s.roomActions.setTarget(room.id, { lo: 24, which: 'lo', duration: '1h' }, ACTOR);
    assert.deepEqual(lo.override.value, { kind: 'room_target', mode: 'dual', heatC: 24, coolC: 26 });
    const hi = await s.roomActions.setTarget(room.id, { hi: 21, which: 'hi', duration: '1h' }, ACTOR);
    assert.deepEqual(hi.override.value, { kind: 'room_target', mode: 'dual', heatC: 19, coolC: 21 });
  }));

test('boost stores an absolute target and never stacks on itself', () =>
  withRoom(async (s, room) => {
    const now = s.clock.now();
    await s.roomActions.boost(room.id, {}, ACTOR);
    let o = s.overrides.active()[0];
    assert.equal(o.kind, 'room_boost');
    assert.deepEqual(o.value, { kind: 'room_boost', mode: 'heat', deltaC: 1, targetC: 21 });
    assert.equal(o.until, now + 30 * MIN);
    assert.equal(o.duration, 'minutes');

    // the engine now shows the boosted target; a second press starts from the same base
    s.setRoom(room.id, { state: 'heat', tempC: 19.9, target: heatingTarget(21, { layer: 'manual', display: 'boost', overrideId: o.id }) });
    await s.roomActions.boost(room.id, { deltaC: 2, minutes: 60 }, ACTOR);
    o = s.overrides.active()[0];
    assert.deepEqual(o.value, { kind: 'room_boost', mode: 'heat', deltaC: 2, targetC: 22 });
    assert.equal(o.until, now + 60 * MIN);

    await s.roomActions.cancelBoost(room.id, ACTOR);
    assert.equal(s.overrides.active().length, 0);

    s.setRoom(room.id, { state: 'cool', tempC: 25.6, target: { heatC: null, coolC: 25, mode: 'cool', displayC: 25, layer: 'house_schedule', display: 'schedule', profileId: 'home' }, activeModes: { heat: false, cool: true } });
    await s.roomActions.boost(room.id, {}, ACTOR);
    assert.deepEqual(s.overrides.active()[0].value, { kind: 'room_boost', mode: 'cool', deltaC: -1, targetC: 24 });
    assert.equal((await rejection(() => s.roomActions.boost(room.id, { minutes: 5 }, ACTOR))).code, 'validation');
  }));

test('airing, window ignore and room off are separate overrides with their own lifetimes', () =>
  withRoom(async (s, room) => {
    const now = s.clock.now();
    await s.roomActions.airing(room.id, {}, ACTOR);
    await s.roomActions.ignoreWindow(room.id, { minutes: 45 }, ACTOR);
    await s.roomActions.off(room.id, { duration: 'none' }, ACTOR);
    const byGroup = Object.fromEntries(s.overrides.active().map((o) => [o.group, o]));
    assert.equal(byGroup.airing.until, now + 10 * MIN);
    assert.equal(byGroup.window_ignore.until, now + 45 * MIN);
    assert.equal(byGroup.target.kind, 'room_off');
    assert.equal(byGroup.target.until, null);

    await s.roomActions.on(room.id, ACTOR);
    await s.roomActions.cancelAiring(room.id, ACTOR);
    assert.deepEqual(s.overrides.active().map((o) => o.group), ['window_ignore']);
    await s.roomActions.cancelIgnoreWindow(room.id, ACTOR);
    assert.equal(s.overrides.active().length, 0);
  }));

test('HA climate commands map to the same overrides as the UI', () =>
  withRoom(async (s, room) => {
    await s.roomActions.applyClimateCommand(room.id, { temp: 22 }, ACTOR);
    let o = s.overrides.active()[0];
    assert.equal(o.kind, 'room_target');
    assert.equal(o.duration, 'slot');
    assert.equal(o.value.heatC, 22);

    await s.roomActions.applyClimateCommand(room.id, { mode: 'off' }, ACTOR);
    o = s.overrides.active()[0];
    assert.equal(o.kind, 'room_off');
    assert.equal(o.until, null);

    await s.roomActions.applyClimateCommand(room.id, { mode: 'auto' }, ACTOR);
    assert.equal(s.overrides.active().length, 0);

    await s.roomActions.applyClimateCommand(room.id, { preset: 'Ніч' }, ACTOR);
    o = s.overrides.active()[0];
    assert.equal(o.kind, 'room_profile');
    assert.equal(o.value.profileId, 'night');

    // the profile the room follows anyway clears the room profile instead of pinning it
    await s.roomActions.applyClimateCommand(room.id, { preset: 'Дома' }, ACTOR);
    assert.equal(s.overrides.active().length, 0);

    await s.roomActions.applyClimateCommand(room.id, { mode: 'heat' }, ACTOR);
    assert.deepEqual(s.overrides.active()[0].value, { kind: 'room_target', mode: 'heat', heatC: 20, coolC: null });
    assert.equal((await rejection(() => s.roomActions.applyClimateCommand(room.id, { preset: 'Нема такого' }, ACTOR))).code, 'validation');
  }));

test('duration options carry their resolved end times', () =>
  withRoom(async (s, room) => {
    const now = s.clock.now();
    s.t.slotEnd = now + 3 * HOUR + 50 * MIN;
    const d = Object.fromEntries(s.roomActions.durations(room.id).map((x) => [x.id, x.until]));
    assert.deepEqual(Object.keys(d), ['slot', '1h', '2h', '3h', 'morning', 'until', 'forever']);
    assert.equal(d.slot, s.t.slotEnd);
    assert.equal(d['1h'], now + HOUR);
    assert.equal(d.until, null);
    assert.equal(d.forever, null);
    assert.equal((await rejection(async () => s.roomActions.durations('r_missing'))).code, 'not_found');
  }));
