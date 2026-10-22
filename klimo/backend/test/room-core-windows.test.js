const assert = require('node:assert/strict');
const test = require('node:test');
const { evaluateWindows, windowOpenLong } = require('../dist/engine/core/windows');
const h = require('./room-core-harness');

const at = (hh, mm, ss = 0) => h.kyiv(2026, 10, 21, hh, mm, ss);
const contact = h.sensor('w1', 'binary_sensor.window', 'contact', { contactKind: 'window' });
const fresh = () => h.d.defaultRoomMemory('r_living', 0).window;

function step(room, mem, now, state, extra = {}) {
  const entities = state === undefined ? {} : { 'binary_sensor.window': h.snap('binary_sensor.window', state, { at: now }) };
  const inputs = h.makeInputs(now, entities, extra.inputs);
  return evaluateWindows(room, inputs, mem, { contacts: extra.contacts ?? [contact], rawC: extra.rawC ?? 20, ignore: extra.ignore ?? null, airing: extra.airing ?? null });
}

test('opens 18:59:00 → reaction at 19:00:00; closes 19:10 → resumes 19:12', () => {
  const room = h.makeRoom();
  let r = step(room, fresh(), at(18, 59), 'on');
  assert.equal(r.state.reactionActive, false);
  assert.equal(r.state.reactionAt, at(19, 0));
  r = step(room, r.memory, at(18, 59, 50), 'on');
  assert.equal(r.state.reactionActive, false);
  r = step(room, r.memory, at(19, 0), 'on');
  assert.equal(r.state.reactionActive, true);
  assert.deepEqual(r.decisions.map((x) => x.code), ['room.window_reaction']);
  r = step(room, r.memory, at(19, 10), 'off');
  assert.equal(r.state.reactionActive, true);
  assert.equal(r.state.resumeAt, at(19, 12));
  r = step(room, r.memory, at(19, 11, 59), 'off');
  assert.equal(r.state.reactionActive, true);
  r = step(room, r.memory, at(19, 12), 'off');
  assert.equal(r.state.reactionActive, false);
  assert.deepEqual(r.decisions.map((x) => x.code), ['room.window_resume']);
});

test('a door opened briefly never reacts; re-opening during the resume delay keeps the reaction', () => {
  const room = h.makeRoom();
  let r = step(room, fresh(), at(18, 0), 'on');
  r = step(room, r.memory, at(18, 0, 40), 'off');
  r = step(room, r.memory, at(18, 1, 30), 'off');
  assert.equal(r.state.reactionActive, false);
  r = step(room, fresh(), at(19, 0), 'on');
  r = step(room, r.memory, at(19, 1), 'on');
  r = step(room, r.memory, at(19, 5), 'off');
  r = step(room, r.memory, at(19, 6), 'on');
  r = step(room, r.memory, at(19, 8), 'off');
  r = step(room, r.memory, at(19, 9, 30), 'off');
  assert.equal(r.state.reactionActive, true);
  r = step(room, r.memory, at(19, 10), 'off');
  assert.equal(r.state.reactionActive, false);
});

test('«Ігнорувати вікно» suppresses the reaction, not the display', () => {
  const room = h.makeRoom();
  const ignore = { kind: 'room_window_ignore', until: at(19, 30) };
  let r = step(room, fresh(), at(19, 0), 'on', { ignore });
  r = step(room, r.memory, at(19, 5), 'on', { ignore });
  assert.equal(r.state.reactionActive, false);
  assert.equal(r.state.anyOpen, true);
  assert.equal(r.state.ignoredUntil, at(19, 30));
  // the ignore ends while the window is still open: the reaction starts at once
  r = step(room, r.memory, at(19, 31), 'on');
  assert.equal(r.state.reactionActive, true);
});

test('virtual window: 20.4 → 19.3 within 4 minutes without contacts; clears on recovery', () => {
  const room = h.makeRoom();
  const now = at(19, 4);
  const history = { r_living: [0, 1, 2, 3].map((m) => [at(19, m), 20.4 - (m * 1.1) / 4]) };
  let r = step(room, fresh(), now, undefined, { contacts: [], rawC: 19.3, inputs: { roomTempHistory: history } });
  assert.equal(r.state.virtual, true);
  assert.equal(r.state.reactionActive, true);
  assert.equal(r.virtualDropC, 1.1);
  assert.deepEqual(r.decisions.map((x) => x.code), ['room.window_virtual', 'room.window_reaction']);
  r = step(room, r.memory, at(19, 8), undefined, { contacts: [], rawC: 19.1 });
  assert.equal(r.state.virtual, true);
  r = step(room, r.memory, at(19, 15), undefined, { contacts: [], rawC: 19.4 });
  assert.equal(r.state.virtual, false);
  r = step(room, r.memory, at(19, 17), undefined, { contacts: [], rawC: 19.5 });
  assert.equal(r.state.reactionActive, false);
});

test('no virtual window while a working contact exists; it takes over when every contact is offline', () => {
  const room = h.makeRoom();
  const history = { r_living: [[at(19, 0), 20.4]] };
  const r = step(room, fresh(), at(19, 4), 'off', { rawC: 19.3, inputs: { roomTempHistory: history } });
  assert.equal(r.state.virtual, false);
  const dead = step(room, fresh(), at(19, 4), 'unavailable', { rawC: 19.3, inputs: { roomTempHistory: history } });
  assert.equal(dead.state.virtual, true);
});

test('window_open_long: notify-only after 10 min, any reaction after 20 min, only while conditioned', () => {
  const notifyRoom = h.makeRoom({ windows: { ...h.makeRoom().windows, reaction: 'notify' } });
  const state = { openSince: at(19, 0) };
  assert.equal(windowOpenLong(notifyRoom, state, fresh(), at(19, 9), true).detection.active, false);
  const ten = windowOpenLong(notifyRoom, state, fresh(), at(19, 10), true);
  assert.equal(ten.detection.active, true);
  assert.equal(ten.detection.dedupKey, 'window:r_living');
  assert.equal(ten.memory.notifiedAt, at(19, 10));
  const pause = h.makeRoom();
  assert.equal(windowOpenLong(pause, state, fresh(), at(19, 15), true).detection.active, false);
  assert.equal(windowOpenLong(pause, state, fresh(), at(19, 20), true).detection.active, true);
  assert.equal(windowOpenLong(pause, state, fresh(), at(19, 30), false).detection.active, false);
});

/* ── reactions through the room ─────────────────────────────────────────────────────────────────── */

function windowRoom(reaction, t = 20.0) {
  const now = h.WED_1910;
  const cfg = h.makeCfg({ room: { windows: { ...h.makeRoom().windows, reaction } } });
  cfg.sensorsByRoom.r_living.push(contact);
  const entities = {
    ...h.temps(now, [t, t, t]),
    'binary_sensor.window': h.snap('binary_sensor.window', 'on', { at: now - 5 * h.MIN }),
    'climate.trv1': h.trvSnap('climate.trv1', now, 21),
    'climate.trv2': h.trvSnap('climate.trv2', now, 21),
  };
  const memory = h.emptyMemory(cfg, now);
  memory.rooms.r_living.window = { ...fresh(), contactOpenSince: now - 5 * h.MIN };
  return { cfg, inputs: h.makeInputs(now, entities), memory };
}

test('pause: values kept, demand blocked, heads to the frost floor, chip window', () => {
  const { cfg, inputs, memory } = windowRoom('pause', 19.5);
  const { state, fin } = h.tick(cfg, inputs, memory);
  // Wed 19:10 is «Дома» 21.0 in the seeded plan
  assert.equal(state.target.heatC, 21);
  assert.equal(state.target.display, 'window');
  assert.equal(state.demand.mode, 'none');
  assert.equal(state.demand.block, 'window');
  assert.equal(state.state, 'window');
  assert.equal(state.why[0].code, 'why.window.pause');
  assert.equal(h.climateOf(fin, 'climate.trv1').temperature, 7);
  assert.equal(h.climateOf(fin, 'climate.trv1').hvacMode, 'heat');
});

test('eco: the eco profile target (19.0); lower: target − 3', () => {
  const eco = windowRoom('eco', 18.5);
  const a = h.tick(eco.cfg, eco.inputs, eco.memory);
  assert.equal(a.state.target.heatC, 19);
  assert.equal(a.state.state, 'window');
  assert.equal(a.state.demand.mode, 'heat');
  assert.deepEqual(a.state.why[0], { code: 'why.window.eco', params: { profileId: 'eco' } });
  const lower = windowRoom('lower', 17.5);
  const b = h.tick(lower.cfg, lower.inputs, lower.memory);
  assert.equal(b.state.target.heatC, 18);
  assert.equal(b.state.target.adjustments.find((x) => x.code === 'window_lower').deltaC, -3);
  assert.deepEqual(b.state.why[0], { code: 'why.window.lower', params: { deltaC: -3 } });
});

test('notify: control unchanged, only the reminder', () => {
  const { cfg, inputs, memory } = windowRoom('notify', 20.5);
  const { state } = h.tick(cfg, inputs, memory);
  assert.equal(state.target.heatC, 21);
  assert.equal(state.target.display, 'schedule');
  assert.equal(state.demand.mode, 'heat');
  assert.equal(state.state, 'heat');
  assert.ok(state.why.some((r) => r.code === 'why.window.notify'));
});

test('airing override: chip window, demand blocked, the window reaction suppressed', () => {
  const { cfg, inputs, memory } = windowRoom('pause', 19.0);
  cfg.overrides.push({
    id: 'air', scope: 'room', subjectId: 'r_living', kind: 'room_airing', group: 'airing', value: { kind: 'room_airing' }, duration: 'minutes',
    createdAt: inputs.now - h.MIN, until: inputs.now + 9 * h.MIN, by: { via: 'ui', userId: null, userName: null, contextId: null },
    previous: null, revertToken: null, revertUntil: null, reqId: null,
  });
  const { state } = h.tick(cfg, inputs, memory);
  assert.equal(state.window.reactionActive, false);
  assert.equal(state.target.display, 'airing');
  assert.equal(state.state, 'window');
  assert.equal(state.demand.block, 'airing');
  assert.deepEqual(state.why[0], { code: 'why.airing', params: { until: inputs.now + 9 * h.MIN } });
});

test('frost wins over an open window', () => {
  const { cfg, inputs, memory } = windowRoom('pause', 6.5);
  const { state, fin } = h.tick(cfg, inputs, memory);
  assert.equal(state.state, 'frost');
  assert.equal(state.demand.mode, 'heat');
  assert.equal(h.climateOf(fin, 'climate.trv1').temperature, 8.5);
});
