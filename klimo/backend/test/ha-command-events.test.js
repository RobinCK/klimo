const assert = require('node:assert/strict');
const test = require('node:test');
const { ApiException } = require('../dist/common/http');
const { HaCommandEventsService } = require('../dist/ha/command-events.service');
const { FakeClock, FakeHa, FakeConfig } = require('./ha-harness');
const { ACTOR, heatingTarget, openServices } = require('./services-harness');

const CTX = { id: 'ctx-1', user_id: 'u_olia', parent_id: null };

/** The service over fakes: room/house actions record their calls. */
function withFakes() {
  const clock = new FakeClock();
  const ha = new FakeHa();
  const config = new FakeConfig();
  config.addRoom('r_living', 'Вітальня', 'vitalnia');
  config.addRoom('r_kids', 'Дитяча кімната', 'dytiacha_kimnata');
  const calls = [];
  const control = { mode: 'schedule' };
  const rooms = {
    setControl: async (...a) => calls.push(['room.setControl', ...a]),
    setTarget: async (...a) => calls.push(['room.setTarget', ...a]),
    control: () => ({ ...control, since: null, until: null, setBy: null }),
  };
  const house = { setControl: async (...a) => calls.push(['house.setControl', ...a]) };
  const journal = { entries: [], add: async (d, ts, opts) => journal.entries.push({ ...d, ts, opts }) };
  const attribution = { userName: (id) => ({ u_olia: 'Оля' })[id] ?? null, forEntity: () => null, isAdmin: () => null };
  const moduleRef = { get: (token) => ({ ROOM_ACTIONS: rooms, HOUSE_ACTIONS: house })[token] };
  const svc = new HaCommandEventsService(ha, config, attribution, journal, clock, moduleRef);
  return { svc, ha, config, calls, journal, control, clock };
}

test('Klimo subscribes to klimo_command and applies events in the order they arrive', async () => {
  const f = withFakes();
  f.svc.onModuleInit();
  assert.deepEqual(f.ha.subscribedEvents, ['klimo_command']);
  f.ha.emitEvent('klimo_command', { command: 'set_manual', room: 'vitalnia' }, CTX);
  f.ha.emitEvent('klimo_command', { command: 'resume_schedule', room: 'vitalnia' }, CTX);
  f.ha.emitEvent('some_other_event', { command: 'set_off', room: 'vitalnia' }, CTX);
  await f.svc.enqueue({ command: 'set_off', room: 'r_living' }, CTX);
  assert.deepEqual(
    f.calls.map((c) => [c[0], c[1], c[2]]),
    [
      ['room.setControl', 'r_living', { mode: 'manual' }],
      ['room.setControl', 'r_living', { mode: 'schedule' }],
      ['room.setControl', 'r_living', { mode: 'off' }],
    ],
  );
  // attributed to the person who ran the script, through the event's own context
  assert.deepEqual(f.calls[0][3], { via: 'event', userId: 'u_olia', userName: 'Оля', contextId: 'ctx-1' });
});

test('a room is found by id, slug, name in any case or one of its Klimo entity ids', async () => {
  const f = withFakes();
  for (const room of ['r_kids', 'dytiacha_kimnata', 'Дитяча кімната', '  дитяча   КІМНАТА ', 'climate.klimo_dytiacha_kimnata', 'select.klimo_dytiacha_kimnata_control']) {
    const out = await f.svc.handle({ command: 'set_schedule', room }, CTX);
    assert.equal(out.ok, true, room);
    assert.equal(out.roomId, 'r_kids', room);
  }
  assert.equal(f.calls.length, 6);
});

test('no room: resume_schedule, set_schedule and set_manual act on the whole house', async () => {
  const f = withFakes();
  await f.svc.handle({ command: 'resume_schedule' }, CTX);
  await f.svc.handle({ command: 'set_schedule' }, CTX);
  await f.svc.handle({ command: 'set_manual' }, { id: 'ctx-2', user_id: null, parent_id: 'ctx-automation' });
  assert.deepEqual(
    f.calls.map((c) => [c[0], c[1]]),
    [
      ['house.setControl', { mode: 'schedule' }],
      ['house.setControl', { mode: 'schedule' }],
      ['house.setControl', { mode: 'manual' }],
    ],
  );
  assert.deepEqual(f.calls[2][2], { via: 'event', userId: null, userName: null, contextId: 'ctx-2' });
});

test('set_target: temporary by the HA setting, manual while the room is manual, or the duration given', async () => {
  const f = withFakes();
  await f.svc.handle({ command: 'set_target', room: 'vitalnia', target: 21.5 }, CTX);
  await f.svc.handle({ command: 'set_target', room: 'vitalnia', target: '22,5', duration: '2h' }, CTX);
  await f.svc.handle({ command: 'set_target', room: 'vitalnia', target: 23, duration: 'until', until: '2026-10-21T20:00:00Z' }, CTX);
  f.control.mode = 'manual';
  await f.svc.handle({ command: 'set_target', room: 'vitalnia', target: 24 }, CTX);
  await f.svc.handle({ command: 'set_manual', room: 'vitalnia', target: 20 }, CTX);
  assert.deepEqual(
    f.calls.map((c) => c[2]),
    [
      { value: 21.5, duration: 'slot' },
      { value: 22.5, duration: '2h' },
      { value: 23, duration: 'until', until: Date.UTC(2026, 9, 21, 20, 0) },
      { value: 24, duration: 'manual' },
      { value: 20, duration: 'manual' },
    ],
  );
});

test('invalid commands are rejected and journaled with the reason; nothing is applied', async () => {
  const f = withFakes();
  const cases = [
    [{ command: 'make_it_warm', room: 'vitalnia' }, 'unknown_command', 'make_it_warm'],
    [{ room: 'vitalnia' }, 'unknown_command', null],
    [{ command: 'set_off' }, 'room_required', null],
    [{ command: 'set_target', target: 21 }, 'room_required', null],
    [{ command: 'set_manual', target: 21 }, 'room_required', null],
    [{ command: 'set_off', room: 'Горище' }, 'room_not_found', null],
    [{ command: 'set_target', room: 'vitalnia' }, 'target_required', null],
    [{ command: 'set_target', room: 'vitalnia', target: 'warm' }, 'invalid', 'target'],
    [{ command: 'set_target', room: 'vitalnia', target: 500 }, 'invalid', 'target'],
    [{ command: 'set_target', room: 'vitalnia', target: 21, duration: 'forever and ever' }, 'invalid', 'duration'],
    [{ command: 'set_target', room: 'vitalnia', target: 21, duration: 'until' }, 'invalid', 'until'],
    [{ command: 'set_off', room: 'vitalnia', target: 21 }, 'invalid', 'target'],
  ];
  for (const [data, reason, detail] of cases) {
    const out = await f.svc.handle(data, CTX);
    assert.equal(out.ok, false, JSON.stringify(data));
    assert.equal(out.reason, reason, JSON.stringify(data));
    assert.equal(out.detail, detail, JSON.stringify(data));
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.journal.entries.length, cases.length);
  const e = f.journal.entries.find((x) => x.params.reason === 'room_not_found');
  assert.equal(e.code, 'ha.command_rejected');
  assert.equal(e.category, 'system');
  assert.deepEqual(e.params, { command: 'set_off', room: 'Горище', reason: 'room_not_found', detail: null, by: 'Оля' });
  assert.deepEqual(e.opts, { dedup: false });
  // a command the room actions refuse is journaled with their reason, against the room
  const failing = withFakes();
  failing.svc.roomActions = () => ({ setControl: async () => Promise.reject(new ApiException(409, 'conflict', 'The room is not heating')) });
  const out = await failing.svc.handle({ command: 'set_manual', room: 'vitalnia' }, CTX);
  assert.equal(out.reason, 'failed');
  assert.equal(failing.journal.entries[0].roomId, 'r_living');
});

test('end to end: a script puts a room under manual control by its name and resumes the house', async () => {
  const s = await openServices();
  try {
    const room = await s.config.create('rooms', { name: 'Вітальня' }, ACTOR);
    s.setRoom(room.id, { state: 'heat', tempC: 19.8, target: heatingTarget(20) });
    const moduleRef = { get: (token) => ({ ROOM_ACTIONS: s.roomActions, HOUSE_ACTIONS: s.houseActions })[token] };
    const attribution = { userName: () => 'Оля' };
    const svc = new HaCommandEventsService(s.ha, s.config, attribution, s.journal, s.clock, moduleRef);
    let out = await svc.handle({ command: 'set_manual', room: 'вітальня', target: 22 }, CTX);
    assert.equal(out.ok, true);
    const o = s.overrides.forSubject('room', room.id)[0];
    assert.equal(o.duration, 'manual');
    assert.equal(o.value.heatC, 22);
    assert.equal(o.by.via, 'event');
    assert.equal(s.roomActions.control(room.id).setBy, 'event');
    s.clock.advance(1000);
    out = await svc.handle({ command: 'set_manual' }, CTX);
    assert.equal(s.houseActions.control().mode, 'manual');
    s.clock.advance(1000);
    out = await svc.handle({ command: 'resume_schedule' }, CTX);
    assert.equal(out.ok, true);
    assert.equal(s.houseActions.control().mode, 'schedule');
    assert.equal(s.roomActions.control(room.id).mode, 'schedule');
    const lines = (await s.journal.page({ codes: ['house.control'] })).items;
    assert.deepEqual(lines.map((l) => [l.params.mode, l.params.via, l.params.by]), [
      ['schedule', 'event', 'Оля'],
      ['manual', 'event', 'Оля'],
    ]);
  } finally {
    await s.close();
  }
});

test('the simulator fires klimo_command as a user\'s script or as an automation, once Klimo subscribed', async () => {
  const { fakeHa } = require('./sim-harness');
  const sim = fakeHa();
  try {
    const seen = [];
    sim.ha.onEvent((type, data, ctx) => type === 'klimo_command' && seen.push({ data, ctx }));
    await sim.ha.fireEventAs('u_olia', 'klimo_command', { command: 'set_off', room: 'vitalnia' });
    assert.equal(seen.length, 0, 'nobody subscribed yet');
    await sim.ha.subscribeEvents('klimo_command');
    const { contextId } = await sim.ha.fireEventAs('u_olia', 'klimo_command', { command: 'set_off', room: 'vitalnia' });
    await sim.ha.fireEventAs('u_olia', 'klimo_command', { command: 'resume_schedule' }, true);
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[0].data, { command: 'set_off', room: 'vitalnia' });
    assert.deepEqual(seen[0].ctx, { id: contextId, user_id: 'u_olia', parent_id: null });
    assert.equal(seen[1].ctx.user_id, null);
    assert.equal(typeof seen[1].ctx.parent_id, 'string');
  } finally {
    sim.dispose();
  }
});
