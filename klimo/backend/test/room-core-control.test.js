const assert = require('node:assert/strict');
const test = require('node:test');
const { durationUntil } = require('../dist/engine/core/durations');
const { resolveHouseProfile, roomControlOf, houseControlOf, roomTargetOverride, heldUnder, controlSetBy } = require('../dist/engine/core/targets');
const { isHeldOverride } = require('../dist/shared/model');
const h = require('./room-core-harness');

const KYIV = h.KYIV;
const WED = (hh, mm = 0) => h.kyiv(2026, 10, 21, hh, mm);
const THU = (hh, mm = 0) => h.kyiv(2026, 10, 22, hh, mm);
const ACTOR = { via: 'ui', userId: 'u1', userName: 'Ігор', contextId: null };

function override(extra) {
  return { id: 'o1', scope: 'room', subjectId: 'r_living', group: 'target', duration: 'slot', createdAt: WED(19, 0), until: null, by: ACTOR, previous: null, revertToken: null, revertUntil: null, reqId: null, ...extra };
}
const manual = (heatC, extra = {}) => override({ kind: 'room_target', value: { kind: 'room_target', mode: 'heat', heatC, coolC: null }, duration: 'manual', until: null, ...extra });
const houseOverride = (profileId, extra = {}) =>
  override({ id: 'h1', scope: 'house', subjectId: 'house', kind: 'house_profile', group: 'house_profile', value: { kind: 'house_profile', profileId }, ...extra });

function roomAt(now, t, cfgMut, entitiesExtra = {}) {
  const cfg = h.makeCfg({ now });
  cfgMut?.(cfg);
  const entities = { ...h.temps(now, [t, t, t]), 'climate.trv1': h.trvSnap('climate.trv1', now, t + 1), 'climate.trv2': h.trvSnap('climate.trv2', now, t + 1), ...entitiesExtra };
  const inputs = h.makeInputs(now, entities);
  return { cfg, inputs, memory: h.emptyMemory(cfg, now) };
}
const targetAt = (now, t, cfgMut) => {
  const r = roomAt(now, t, cfgMut);
  return h.tick(r.cfg, r.inputs, r.memory).state;
};

test('manual control holds the room target through schedule boundaries and house profile changes', () => {
  // 19:10 the schedule says «Дома» 21.0; manual control holds 23.0
  let s = targetAt(WED(19, 10), 20, (cfg) => cfg.overrides.push(manual(23)));
  assert.equal(s.target.heatC, 23);
  assert.equal(s.target.layer, 'manual');
  assert.equal(s.target.until, null, 'manual control has no end');
  assert.equal(s.target.next, null);
  // 23:30 the schedule moved to «Ніч»: the room does not follow
  s = targetAt(WED(23, 30), 20, (cfg) => cfg.overrides.push(manual(23)));
  assert.equal(s.target.heatC, 23);
  // next morning, a changed profile value and a house profile switched by hand do not touch it either
  s = targetAt(THU(9, 0), 20, (cfg) => {
    cfg.overrides.push(manual(23), houseOverride('eco', { until: THU(12, 0) }));
    cfg.profileRooms.push({ profileId: 'home', roomId: 'r_living', mode: 'own', heatC: 18, coolC: null, writtenAt: null });
  });
  assert.equal(s.target.heatC, 23);
  assert.equal(s.target.layer, 'manual');
});

test('manual control is not outranked by a calendar profile even when the calendar ranks above changes by hand', () => {
  const calendar = (cfg) => {
    cfg.house.priority = ['frost', 'window', 'calendar', 'manual', 'presence', 'room_schedule', 'house_schedule'];
    cfg.activationRules.push({ id: 'ar_cal', profileId: 'guests', enabled: true, order: 0, config: { type: 'calendar', calendarEntityId: 'calendar.family', match: { field: 'summary', contains: 'гості' }, preheatMin: 0 } });
  };
  const at = (cfgMut) => {
    const r = roomAt(WED(19, 10), 20, (cfg) => {
      calendar(cfg);
      cfgMut(cfg);
    });
    r.inputs.calendarEvents['calendar.family'] = [{ start: WED(19, 0), end: WED(23, 30), summary: 'гості', description: '', location: '' }];
    return h.tick(r.cfg, r.inputs, r.memory).state;
  };
  // a temporary change keeps today's behaviour: the calendar ranks above it
  const temporary = at((cfg) => cfg.overrides.push(manual(23, { duration: '2h', until: WED(21, 10) })));
  assert.equal(temporary.target.layer, 'calendar');
  // manual control holds
  const held = at((cfg) => cfg.overrides.push(manual(23)));
  assert.equal(held.target.layer, 'manual');
  assert.equal(held.target.heatC, 23);
});

test('rule offsets never move a manually held value', () => {
  const offset = { r_living: { heat: { deltaC: -1, ruleId: 'economy' }, cool: null } };
  const r = roomAt(WED(19, 10), 19.5, (cfg) => cfg.overrides.push(manual(22)));
  const ctx = h.ctxOf(r.cfg, r.inputs, r.memory, { overlay: { ...h.emptyOverlay(), targetOffsets: offset } });
  assert.equal(h.tick(r.cfg, r.inputs, r.memory, { ctx }).state.target.heatC, 22);
});

test('an open window still pauses a room under manual control', () => {
  const contact = h.sensor('w1', 'binary_sensor.window', 'contact', { contactKind: 'window' });
  const open = { 'binary_sensor.window': h.snap('binary_sensor.window', 'on', { at: WED(19, 0) }) };
  const sensors = [h.sensor('s1', 'sensor.t1', 'temperature', { order: 0 }), h.sensor('s2', 'sensor.t2', 'temperature', { order: 1 }), h.sensor('s3', 'sensor.t3', 'temperature', { order: 2 }), contact];
  let r = roomAt(WED(19, 10), 19, (cfg) => {
    cfg.sensorsByRoom.r_living = sensors;
    cfg.overrides.push(manual(23));
  }, open);
  let step = h.tick(r.cfg, r.inputs, r.memory);
  // the reaction starts after the open delay
  const later = WED(19, 10) + (r.cfg.rooms[0].windows.openDelaySec + 60) * 1000;
  r = roomAt(later, 19, (cfg) => {
    cfg.sensorsByRoom.r_living = sensors;
    cfg.overrides.push(manual(23));
  }, open);
  step = h.tick(r.cfg, r.inputs, step.memory);
  assert.equal(step.state.window.reactionActive, true);
  assert.equal(step.state.target.layer, 'window');
  assert.equal(step.state.state, 'window');
  assert.equal(step.state.demand.mode, 'none');
});

test('off with no end keeps frost protection', () => {
  const off = override({ kind: 'room_off', value: { kind: 'room_off' }, duration: 'none', until: null });
  const warm = targetAt(WED(19, 10), 18, (cfg) => cfg.overrides.push(off));
  assert.equal(warm.state, 'off');
  assert.equal(warm.target.heatC, null);
  const cold = targetAt(WED(19, 10), 4, (cfg) => cfg.overrides.push(off));
  assert.equal(cold.state, 'frost');
  assert.equal(cold.demand.mode, 'heat');
});

test('a house held by hand (no end) outranks calendar and presence; a time-limited one keeps its rank', () => {
  const cfg = h.makeCfg();
  cfg.house.priority = ['frost', 'window', 'calendar', 'manual', 'presence', 'room_schedule', 'house_schedule'];
  cfg.activationRules.push({ id: 'ar_cal', profileId: 'guests', enabled: true, order: 0, config: { type: 'calendar', calendarEntityId: 'calendar.family', match: { field: 'summary', contains: '' }, preheatMin: 0 } });
  const inputs = h.makeInputs(WED(19, 10));
  inputs.calendarEvents['calendar.family'] = [{ start: WED(19, 0), end: WED(23, 0), summary: 'x', description: '', location: '' }];
  const mem = h.emptyMemory(cfg, WED(19, 10));
  cfg.overrides = [houseOverride('eco', { until: WED(21, 0) })];
  assert.equal(resolveHouseProfile(cfg, inputs, mem).state.layer, 'calendar');
  cfg.overrides = [houseOverride('eco', { duration: 'none', until: null })];
  const s = resolveHouseProfile(cfg, inputs, mem).state;
  assert.equal(s.layer, 'house_manual');
  assert.equal(s.activeProfileId, 'eco');
});

test('control modes are derived from the room override: schedule, manual, temporary, off', () => {
  const now = WED(19, 10);
  assert.deepEqual(roomControlOf([], 'r_living', now), { mode: 'schedule', since: null, until: null, setBy: null });
  assert.deepEqual(roomControlOf([manual(22)], 'r_living', now), { mode: 'manual', since: WED(19, 0), until: null, setBy: 'ui' });
  const temp = manual(22, { duration: '1h', until: WED(20, 0), by: { ...ACTOR, via: 'card' } });
  assert.deepEqual(roomControlOf([temp], 'r_living', now), { mode: 'temporary', since: WED(19, 0), until: WED(20, 0), setBy: 'card' });
  const off = override({ kind: 'room_off', value: { kind: 'room_off' }, duration: 'none', until: null, by: { ...ACTOR, via: 'event' } });
  assert.deepEqual(roomControlOf([off], 'r_living', now), { mode: 'off', since: WED(19, 0), until: null, setBy: 'event' });
  // a temporary off is a temporary change
  assert.equal(roomControlOf([{ ...off, duration: '2h', until: WED(21, 0) }], 'r_living', now).mode, 'temporary');
  // a room profile until cleared is held like manual control
  assert.equal(roomControlOf([override({ kind: 'room_profile', value: { kind: 'room_profile', profileId: 'guests' }, duration: 'none', until: null })], 'r_living', now).mode, 'manual');
  // other rooms, other groups and expired rows do not count
  assert.equal(roomControlOf([manual(22, { subjectId: 'r_other' })], 'r_living', now).mode, 'schedule');
  assert.equal(roomControlOf([override({ kind: 'room_airing', group: 'airing', value: { kind: 'room_airing' }, duration: 'minutes', until: WED(19, 30) })], 'r_living', now).mode, 'schedule');
  assert.equal(roomControlOf([temp], 'r_living', WED(20, 0)).mode, 'schedule');
  // who: HA entities, voice and notification actions read as HA; automations and events as themselves
  assert.equal(controlSetBy({ via: 'voice' }), 'ha');
  assert.equal(controlSetBy({ via: 'mqtt' }), 'ha');
  assert.equal(controlSetBy({ via: 'automation' }), 'automation');
  assert.equal(controlSetBy({ via: 'engine' }), null);
  // the house
  assert.deepEqual(houseControlOf([], now), { mode: 'schedule', since: null });
  assert.deepEqual(houseControlOf([houseOverride('eco', { until: WED(21, 0) })], now), { mode: 'schedule', since: null });
  assert.deepEqual(houseControlOf([houseOverride('eco', { duration: 'none', until: null })], now), { mode: 'manual', since: WED(19, 0) });
  assert.equal(isHeldOverride({ duration: 'manual', until: null }), true);
  assert.equal(isHeldOverride({ duration: '1h', until: now }), false);
});

test('a temporary change on a manual room hands back to manual the moment it ends', () => {
  const held = manual(23);
  const boost = override({ id: 'o2', kind: 'room_boost', value: { kind: 'room_boost', mode: 'heat', deltaC: 1, targetC: 24 }, duration: 'minutes', createdAt: WED(19, 5), until: WED(19, 35), previous: { override: held, profileRow: null } });
  assert.equal(heldUnder(boost).id, 'o1');
  assert.equal(roomTargetOverride([boost], 'r_living', WED(19, 10)).id, 'o2');
  // expired but not yet removed: the held change is what counts
  assert.equal(roomTargetOverride([boost], 'r_living', WED(19, 40)).id, 'o1');
  assert.equal(roomControlOf([boost], 'r_living', WED(19, 10)).mode, 'temporary');
  assert.equal(roomControlOf([boost], 'r_living', WED(19, 40)).mode, 'manual');
  let s = targetAt(WED(19, 10), 20, (cfg) => cfg.overrides.push(boost));
  assert.equal(s.target.heatC, 24);
  s = targetAt(WED(19, 40), 20, (cfg) => cfg.overrides.push(boost));
  assert.equal(s.target.heatC, 23, 'not the schedule\'s 21.0');
  // two levels down (a second boost replaced the first)
  const second = { ...boost, id: 'o3', previous: { override: { ...boost, previous: { override: held, profileRow: null } }, profileRow: null } };
  assert.equal(heldUnder(second).id, 'o1');
});

test('the manual duration has no end', () => {
  const cfg = h.makeCfg();
  assert.equal(durationUntil(cfg, 'r_living', 'manual', WED(19, 10), KYIV), null);
});
