const assert = require('node:assert/strict');
const test = require('node:test');
const { OverrideStore } = require('../dist/config/override.store');
const { ACTOR, HOUR, MIN, heatingTarget, openServices, rejection } = require('./services-harness');

const HA = { via: 'ha', userId: 'u_olia', userName: 'Оля', contextId: 'c1' };
const TRV = { via: 'trv', userId: null, userName: null, contextId: null };
const DAY = 24 * HOUR;

async function withRooms(fn) {
  const s = await openServices();
  try {
    const living = await s.config.create('rooms', { name: 'Вітальня' }, ACTOR);
    const bedroom = await s.config.create('rooms', { name: 'Спальня' }, ACTOR);
    const kids = await s.config.create('rooms', { name: 'Дитяча' }, ACTOR);
    for (const r of [living, bedroom, kids]) s.setRoom(r.id, { state: 'heat', tempC: 19.8, target: heatingTarget(20) });
    s.engine.hp = { activeProfileId: 'home', layer: 'house_schedule', scheduledProfileId: 'home', scheduledUntil: null, nextProfileId: 'night', override: null, presence: { configured: false, anyoneHome: null, awaySince: null, approaching: false } };
    await fn(s, { living, bedroom, kids });
  } finally {
    await s.close();
  }
}

const target = (s, roomId) => s.overrides.forSubject('room', roomId).find((o) => o.group === 'target') ?? null;
const codes = async (s, q = {}) => (await s.journal.page(q)).items.map((e) => e.code);

test('manual control without a value holds what the room aims at now, with no end', () =>
  withRooms(async (s, { living }) => {
    const r = await s.roomActions.setControl(living.id, { mode: 'manual', reqId: 'm-1' }, ACTOR);
    assert.deepEqual(r.control, { mode: 'manual', since: s.clock.now(), until: null, setBy: 'ui' });
    assert.equal(r.roomId, living.id);
    assert.equal(r.reqId, 'm-1');
    const o = target(s, living.id);
    assert.equal(o.duration, 'manual');
    assert.equal(o.until, null);
    assert.deepEqual(o.value, { kind: 'room_target', mode: 'heat', heatC: 20, coolC: null });
    assert.deepEqual(s.roomActions.control(living.id), r.control);
    // the same request again is the same change
    const again = await s.roomActions.setControl(living.id, { mode: 'manual', reqId: 'm-1' }, ACTOR);
    assert.deepEqual(again, r);
    const [entry] = (await s.journal.page({ roomId: living.id })).items;
    assert.equal(entry.code, 'room.control');
    assert.deepEqual({ ...entry.params }, { mode: 'manual', from: 'schedule', valueC: 20, lo: null, hi: null, profileId: null, by: 'Ігор', via: 'ui', entityId: null });
    assert.equal((await s.journal.page({ roomId: living.id })).items.length, 1);
    // manual again without a value changes nothing
    await s.roomActions.setControl(living.id, { mode: 'manual' }, ACTOR);
    assert.equal(target(s, living.id).id, o.id);
  }));

test('manual control with a value holds that value (on the step grid, inside the limits); a dual band too', () =>
  withRooms(async (s, { living, bedroom }) => {
    await s.roomActions.setControl(living.id, { mode: 'manual', heatC: 22.37 }, ACTOR);
    assert.deepEqual(target(s, living.id).value, { kind: 'room_target', mode: 'heat', heatC: 22.5, coolC: null });
    await s.roomActions.setControl(living.id, { mode: 'manual', heatC: 40 }, ACTOR);
    assert.equal(target(s, living.id).value.heatC, 30);
    await s.roomActions.setControl(bedroom.id, { mode: 'manual', heatC: 21, coolC: 25 }, ACTOR);
    assert.deepEqual(target(s, bedroom.id).value, { kind: 'room_target', mode: 'dual', heatC: 21, coolC: 25 });
    assert.equal((await rejection(() => s.roomActions.setControl(living.id, { mode: 'off', heatC: 20 }, ACTOR))).code, 'validation');
    assert.equal((await rejection(() => s.roomActions.setControl(living.id, { mode: 'temporary' }, ACTOR))).code, 'validation');
    assert.equal((await rejection(() => s.roomActions.setControl('r_missing', { mode: 'manual' }, ACTOR))).code, 'not_found');
  }));

test('holding the current target ignores what a window or a boost bent; an idle room holds its profile value', () =>
  withRooms(async (s, { living, bedroom, kids }) => {
    // the window lowered the target by 2°: what the room holds is the value before
    s.setRoom(living.id, { state: 'window', tempC: 18, target: heatingTarget(18, { display: 'window', layer: 'window', adjustments: [{ code: 'window_lower', deltaC: -2, ref: null }] }) });
    await s.roomActions.setControl(living.id, { mode: 'manual' }, ACTOR);
    assert.equal(target(s, living.id).value.heatC, 21, 'the «Дома» value, not 18');
    // a boost holds where it boosted to
    await s.roomActions.boost(bedroom.id, { deltaC: 1, minutes: 30 }, ACTOR);
    await s.roomActions.setControl(bedroom.id, { mode: 'manual' }, ACTOR);
    assert.deepEqual(target(s, bedroom.id).value, { kind: 'room_target', mode: 'heat', heatC: 21, coolC: null });
    // a room with no active target (off by its profile) holds the profile value for the season
    s.setRoom(kids.id, { state: 'off', tempC: 19, target: { heatC: null, coolC: null, mode: 'none', displayC: null, layer: 'house_schedule', display: 'off', profileId: 'home' } });
    await s.roomActions.setControl(kids.id, { mode: 'manual' }, ACTOR);
    assert.equal(target(s, kids.id).value.heatC, 21);
  }));

test('off and back to schedule: journalled as control changes with who did it', () =>
  withRooms(async (s, { living }) => {
    let r = await s.roomActions.setControl(living.id, { mode: 'off' }, HA, { entityId: 'select.klimo_vitalnia_control' });
    assert.equal(r.control.mode, 'off');
    assert.equal(r.control.setBy, 'ha');
    const o = target(s, living.id);
    assert.equal(o.kind, 'room_off');
    assert.equal(o.duration, 'none');
    assert.equal(o.until, null);
    // journal lines of one instant have no order: let a second pass between the changes
    s.clock.advance(1000);
    r = await s.roomActions.setControl(living.id, { mode: 'schedule' }, HA, { entityId: 'select.klimo_vitalnia_control' });
    assert.equal(r.control.mode, 'schedule');
    assert.equal(target(s, living.id), null);
    const items = (await s.journal.page({ roomId: living.id })).items;
    assert.deepEqual(items.map((e) => [e.code, e.params.mode, e.params.from]), [
      ['room.control', 'schedule', 'off'],
      ['room.control', 'off', 'schedule'],
    ]);
    assert.equal(items[0].params.by, 'Оля');
    assert.equal(items[0].params.entityId, 'select.klimo_vitalnia_control');
    // a temporary change cleared by «back to schedule» is an ordinary override_cleared line
    await s.roomActions.setTarget(living.id, { value: 23, duration: '1h' }, ACTOR);
    s.clock.advance(1000);
    await s.roomActions.resume(living.id, ACTOR);
    assert.equal((await codes(s, { roomId: living.id }))[0], 'room.override_cleared');
  }));

test('resume clears manual, temporary, boost and off changes but not airing or a window ignore', () =>
  withRooms(async (s, { living }) => {
    await s.roomActions.setControl(living.id, { mode: 'manual', heatC: 23 }, ACTOR);
    await s.roomActions.boost(living.id, {}, ACTOR);
    await s.roomActions.airing(living.id, { minutes: 10 }, ACTOR);
    await s.roomActions.ignoreWindow(living.id, { minutes: 30 }, ACTOR);
    await s.roomActions.setControl(living.id, { mode: 'schedule' }, ACTOR);
    assert.deepEqual(s.overrides.forSubject('room', living.id).map((o) => o.group).sort(), ['airing', 'window_ignore']);
  }));

test('a target with the manual duration is manual control; a change while manual stays manual', () =>
  withRooms(async (s, { living }) => {
    const r = await s.roomActions.setTarget(living.id, { value: 22, duration: 'manual' }, ACTOR);
    assert.equal(r.until, null);
    assert.equal(r.override.duration, 'manual');
    assert.equal(s.roomActions.control(living.id).mode, 'manual');
    // a head turned by hand changes the manual value instead of handing the room to the slot
    await s.roomActions.setTarget(living.id, { value: 23, duration: 'slot' }, TRV);
    const o = target(s, living.id);
    assert.equal(o.duration, 'manual');
    assert.equal(o.value.heatC, 23);
    // the same knob on a room that follows the schedule makes a temporary change, as before
    await s.roomActions.resume(living.id, ACTOR);
    s.t.slotEnd = s.clock.now() + 2 * HOUR;
    await s.roomActions.setTarget(living.id, { value: 23, duration: 'slot' }, TRV);
    assert.equal(target(s, living.id).duration, 'slot');
    assert.equal(s.roomActions.control(living.id).mode, 'temporary');
  }));

test('a boost on a manual room ends in manual control; cancelling it goes back to manual too', () =>
  withRooms(async (s, { living }) => {
    await s.roomActions.setControl(living.id, { mode: 'manual', heatC: 22 }, ACTOR);
    const held = target(s, living.id);
    await s.roomActions.boost(living.id, { deltaC: 1, minutes: 30 }, ACTOR);
    let o = target(s, living.id);
    assert.equal(o.kind, 'room_boost');
    assert.equal(o.previous.override.id, held.id);
    assert.equal(s.roomActions.control(living.id).mode, 'temporary');
    // a second boost replaces the first; manual control stays one level down
    await s.roomActions.boost(living.id, { deltaC: 2, minutes: 30 }, ACTOR);
    o = target(s, living.id);
    assert.equal(o.previous.override.kind, 'room_boost');
    assert.equal(o.previous.override.previous.override.id, held.id);
    await s.roomActions.cancelBoost(living.id, ACTOR);
    o = target(s, living.id);
    assert.equal(o.id, held.id);
    assert.equal(o.duration, 'manual');
    assert.equal(s.roomActions.control(living.id).mode, 'manual');
  }));

test('the HA thermostat: auto resumes, heat holds manually, a temperature is temporary unless the room is manual', () =>
  withRooms(async (s, { living }) => {
    s.t.slotEnd = s.clock.now() + 2 * HOUR;
    const climate = { entityId: 'climate.klimo_vitalnia' };
    await s.roomActions.applyClimateCommand(living.id, { temp: 21.5 }, HA, climate);
    assert.equal(target(s, living.id).duration, 'slot');
    assert.equal(s.roomActions.control(living.id).mode, 'temporary');
    await s.roomActions.applyClimateCommand(living.id, { mode: 'auto' }, HA, climate);
    assert.equal(s.roomActions.control(living.id).mode, 'schedule');
    await s.roomActions.applyClimateCommand(living.id, { mode: 'heat' }, HA, climate);
    let o = target(s, living.id);
    assert.equal(o.duration, 'manual');
    assert.deepEqual(o.value, { kind: 'room_target', mode: 'heat', heatC: 20, coolC: null });
    // a temperature set while manual stays manual
    await s.roomActions.applyClimateCommand(living.id, { temp: 23 }, HA, climate);
    o = target(s, living.id);
    assert.equal(o.duration, 'manual');
    assert.equal(o.value.heatC, 23);
    // picking heat again changes nothing
    await s.roomActions.applyClimateCommand(living.id, { mode: 'heat' }, HA, climate);
    assert.equal(target(s, living.id).id, o.id);
    // a preset while manual holds that profile with no end
    await s.roomActions.applyClimateCommand(living.id, { preset: 'Ніч' }, HA, climate);
    o = target(s, living.id);
    assert.equal(o.kind, 'room_profile');
    assert.equal(o.duration, 'none');
    assert.equal(s.roomActions.control(living.id).mode, 'manual');
    s.clock.advance(1000);
    await s.roomActions.applyClimateCommand(living.id, { mode: 'off' }, HA, climate);
    assert.equal(s.roomActions.control(living.id).mode, 'off');
    // the control changes: heat → manual, off → off (a temperature or a preset while manual is not one)
    const entries = (await s.journal.page({ roomId: living.id, codes: ['room.control'] })).items;
    assert.ok(entries.every((e) => e.params.entityId === 'climate.klimo_vitalnia' && e.params.by === 'Оля'));
    assert.deepEqual(entries.map((e) => [e.params.mode, e.params.from]), [
      ['off', 'manual'],
      ['manual', 'schedule'],
    ]);
  }));

test('a new value under manual control keeps when and through what manual control began', () =>
  withRooms(async (s, { living, bedroom }) => {
    const t0 = s.clock.now();
    await s.roomActions.setControl(living.id, { mode: 'manual', heatC: 21 }, ACTOR);
    s.clock.advance(10 * MIN);
    await s.roomActions.applyClimateCommand(living.id, { temp: 22 }, HA, { entityId: 'climate.klimo_vitalnia' });
    s.clock.advance(10 * MIN);
    await s.roomActions.setTarget(living.id, { value: 22.5, duration: 'manual' }, HA);
    assert.equal(target(s, living.id).value.heatC, 22.5);
    assert.deepEqual(s.roomActions.control(living.id), { mode: 'manual', since: t0, until: null, setBy: 'ui' });
    // a boost on top and its end: still the same manual control
    await s.roomActions.boost(living.id, { minutes: 30 }, HA);
    await s.roomActions.cancelBoost(living.id, HA);
    assert.deepEqual(s.roomActions.control(living.id), { mode: 'manual', since: t0, until: null, setBy: 'ui' });
    // back to the schedule and manual again: a new start
    await s.roomActions.setControl(living.id, { mode: 'schedule' }, ACTOR);
    await s.roomActions.setControl(living.id, { mode: 'manual' }, HA);
    assert.deepEqual(s.roomActions.control(living.id), { mode: 'manual', since: s.clock.now(), until: null, setBy: 'ha' });
    // off stays off from when it was switched off
    const off0 = s.clock.now();
    await s.roomActions.setControl(bedroom.id, { mode: 'off' }, HA);
    s.clock.advance(MIN);
    await s.roomActions.off(bedroom.id, { duration: 'none' }, ACTOR);
    assert.deepEqual(s.roomActions.control(bedroom.id), { mode: 'off', since: off0, until: null, setBy: 'ha' });
  }));

test('with «until the schedule is resumed» as the HA duration a temperature from HA puts the room under manual control', () =>
  withRooms(async (s, { living }) => {
    await s.config.patchSingleton('settings', { haTargetChangeDuration: 'manual' }, ACTOR);
    await s.roomActions.applyClimateCommand(living.id, { temp: 21.5 }, HA, { entityId: 'climate.klimo_vitalnia' });
    const o = target(s, living.id);
    assert.equal(o.duration, 'manual');
    assert.equal(o.until, null);
    assert.equal(s.roomActions.control(living.id).mode, 'manual');
    const [entry] = (await s.journal.page({ roomId: living.id, codes: ['room.control'] })).items;
    assert.deepEqual([entry.params.mode, entry.params.valueC, entry.params.entityId], ['manual', 21.5, 'climate.klimo_vitalnia']);
  }));

test('house manual pauses the schedule on the current profile; rooms keep their own modes', () =>
  withRooms(async (s, { living }) => {
    await s.roomActions.setControl(living.id, { mode: 'manual', heatC: 22 }, ACTOR);
    const r = await s.houseActions.setControl({ mode: 'manual', reqId: 'h-1' }, HA, { entityId: 'switch.klimo_schedule' });
    const house = s.overrides.forSubject('house', 'house');
    assert.equal(house.length, 1);
    assert.deepEqual(house[0].value, { kind: 'house_profile', profileId: 'home' });
    assert.equal(house[0].duration, 'none');
    assert.equal(house[0].until, null);
    assert.deepEqual(r.control, { mode: 'manual', since: s.clock.now() });
    assert.deepEqual(s.houseActions.control(), r.control);
    assert.equal(s.roomActions.control(living.id).mode, 'manual');
    assert.deepEqual(await s.houseActions.setControl({ mode: 'manual', reqId: 'h-1' }, HA), r);
    const [entry] = (await s.journal.page({ codes: ['house.control'] })).items;
    assert.deepEqual({ ...entry.params }, { mode: 'manual', from: 'schedule', profileId: 'home', rooms: null, off: null, by: 'Оля', via: 'ha', entityId: 'switch.klimo_schedule' });
    // the house is already manual: a second request changes nothing
    await s.houseActions.setControl({ mode: 'manual' }, HA);
    assert.equal(s.overrides.forSubject('house', 'house')[0].id, house[0].id);
    assert.equal((await s.journal.page({ codes: ['house.control'] })).items.length, 1);
    assert.equal((await rejection(() => s.houseActions.setControl({ mode: 'off' }, ACTOR))).code, 'validation');
  }));

test('another profile held by hand keeps the house paused from when the pause began; a time-limited one resumes it', () =>
  withRooms(async (s) => {
    const t0 = s.clock.now();
    await s.houseActions.setControl({ mode: 'manual' }, ACTOR);
    s.clock.advance(5 * MIN);
    await s.houseActions.setProfile({ profileId: 'night', duration: 'none' }, HA);
    assert.deepEqual(s.houseActions.control(), { mode: 'manual', since: t0 });
    assert.equal(s.overrides.forSubject('house', 'house')[0].value.profileId, 'night');
    await s.houseActions.setProfile({ profileId: 'away', duration: '2h' }, HA);
    assert.deepEqual(s.houseActions.control(), { mode: 'schedule', since: null });
  }));

test('house «resume schedule» clears the house override and every manual or temporary room; off rooms stay off', () =>
  withRooms(async (s, { living, bedroom, kids }) => {
    await s.houseActions.setControl({ mode: 'manual' }, ACTOR);
    await s.roomActions.setControl(living.id, { mode: 'manual', heatC: 22 }, ACTOR);
    await s.roomActions.setControl(bedroom.id, { mode: 'off' }, ACTOR);
    await s.roomActions.setTarget(kids.id, { value: 23, duration: '1h' }, ACTOR);
    await s.roomActions.airing(kids.id, { minutes: 10 }, ACTOR);
    s.clock.advance(1000);
    const r = await s.houseActions.setControl({ mode: 'schedule' }, HA, { entityId: 'button.klimo_resume_schedule' });
    assert.deepEqual(r.control, { mode: 'schedule', since: null });
    assert.deepEqual(r.resumedRoomIds.sort(), [living.id, kids.id].sort());
    assert.deepEqual(r.offRoomIds, [bedroom.id]);
    assert.equal(s.overrides.forSubject('house', 'house').length, 0);
    assert.equal(target(s, living.id), null);
    assert.equal(target(s, kids.id), null);
    assert.equal(target(s, bedroom.id).kind, 'room_off');
    assert.equal(s.roomActions.control(bedroom.id).mode, 'off');
    // airing is not a control change
    assert.equal(s.overrides.forSubject('room', kids.id)[0].group, 'airing');
    const [entry] = (await s.journal.page({ codes: ['house.control'] })).items;
    assert.equal(entry.params.mode, 'schedule');
    assert.equal(entry.params.rooms, 2);
    assert.equal(entry.params.off, 1);
    assert.equal(entry.params.entityId, 'button.klimo_resume_schedule');
    assert.deepEqual(await codes(s, { roomId: living.id, codes: ['room.control'] }), ['room.control', 'room.control']);
    assert.equal((await s.journal.page({ roomId: living.id, codes: ['room.control'] })).items[0].params.mode, 'schedule');
  }));

test('house resume keeps a room off even under a temporary change on top of it', () =>
  withRooms(async (s, { living }) => {
    await s.roomActions.setControl(living.id, { mode: 'off' }, ACTOR);
    await s.roomActions.setTarget(living.id, { value: 23, duration: '1h' }, ACTOR);
    assert.equal(s.roomActions.control(living.id).mode, 'temporary');
    const r = await s.houseActions.setControl({ mode: 'schedule' }, ACTOR);
    assert.deepEqual(r.offRoomIds, [living.id]);
    assert.equal(s.roomActions.control(living.id).mode, 'off');
  }));

test('what a held change replaced is history: off → manual → house resume is the schedule, manual → off → on too', () =>
  withRooms(async (s, { living, bedroom }) => {
    await s.roomActions.setControl(living.id, { mode: 'off' }, ACTOR);
    await s.roomActions.setControl(living.id, { mode: 'manual', heatC: 22 }, ACTOR);
    assert.equal(target(s, living.id).previous.override.kind, 'room_off', 'kept for undo');
    const r = await s.houseActions.setControl({ mode: 'schedule' }, ACTOR);
    assert.deepEqual(r.resumedRoomIds, [living.id]);
    assert.deepEqual(r.offRoomIds, []);
    assert.equal(target(s, living.id), null);
    assert.equal(s.roomActions.control(living.id).mode, 'schedule');

    await s.roomActions.setControl(bedroom.id, { mode: 'manual', heatC: 22 }, ACTOR);
    await s.roomActions.off(bedroom.id, { duration: 'none' }, ACTOR);
    await s.roomActions.on(bedroom.id, ACTOR);
    assert.equal(target(s, bedroom.id), null);
    assert.equal(s.roomActions.control(bedroom.id).mode, 'schedule');
    // a temporary off on a manual room still ends in manual
    await s.roomActions.setControl(bedroom.id, { mode: 'manual', heatC: 22 }, ACTOR);
    await s.roomActions.off(bedroom.id, { duration: '1h' }, ACTOR);
    await s.roomActions.on(bedroom.id, ACTOR);
    assert.equal(s.roomActions.control(bedroom.id).mode, 'manual');
    assert.equal(target(s, bedroom.id).value.heatC, 22);
  }));

test('manual control and house manual are stored rows: they survive a restart and never expire', () =>
  withRooms(async (s, { living }) => {
    await s.roomActions.setControl(living.id, { mode: 'manual', heatC: 22 }, ACTOR);
    await s.houseActions.setControl({ mode: 'manual' }, ACTOR);
    await s.roomActions.boost(living.id, { minutes: 30 }, ACTOR);
    const reopened = new OverrideStore(s.db, s.clock);
    await reopened.load();
    const room = reopened.forSubject('room', living.id).find((o) => o.group === 'target');
    assert.equal(room.kind, 'room_boost');
    assert.equal(room.previous.override.duration, 'manual', 'the held value under the boost is stored with it');
    // a year later only the boost has run out
    const expired = await reopened.expire(s.clock.now() + 365 * DAY);
    assert.deepEqual(expired.map((o) => o.kind), ['room_boost']);
    assert.equal(reopened.forSubject('house', 'house')[0].duration, 'none');
    assert.equal(reopened.active().length, 1);
    void MIN;
  }));
