const assert = require('node:assert/strict');
const test = require('node:test');
const { durationUntil } = require('../dist/engine/core/durations');
const { scheduleAt, scheduleChanges } = require('../dist/engine/core/schedule');
const { resolveHouseProfile, houseProfileEdges } = require('../dist/engine/core/targets');
const h = require('./room-core-harness');

const KYIV = h.KYIV;
const WED = (hh, mm = 0) => h.kyiv(2026, 10, 21, hh, mm);
const THU = (hh, mm = 0) => h.kyiv(2026, 10, 22, hh, mm);
const ACTOR = { via: 'ui', userId: 'u1', userName: 'Ігор', contextId: null };

function override(extra) {
  return { id: 'o1', scope: 'room', subjectId: 'r_living', group: 'target', duration: 'slot', createdAt: WED(19, 0), until: null, by: ACTOR, previous: null, revertToken: null, revertUntil: null, reqId: null, ...extra };
}

test('slot at Wed 19:10 ends at the 23:00 boundary; «до ранку» is Thu 06:30', () => {
  const cfg = h.makeCfg();
  assert.equal(durationUntil(cfg, 'r_living', 'slot', WED(19, 10), KYIV), WED(23, 0));
  assert.equal(durationUntil(cfg, 'r_living', 'morning', WED(19, 10), KYIV), THU(6, 30));
  assert.equal(durationUntil(cfg, null, 'slot', WED(19, 10), KYIV), WED(23, 0));
});

test('a block across midnight is one block: slot at 23:30 ends Thu 06:30', () => {
  const cfg = h.makeCfg();
  assert.equal(durationUntil(cfg, 'r_living', 'slot', WED(23, 30), KYIV), THU(6, 30));
  const at = scheduleAt(cfg, cfg.schedules[0], WED(23, 30), KYIV);
  assert.deepEqual(at, { profileId: 'night', start: WED(23, 0), until: THU(6, 30) });
});

test('fixed durations, explicit until bounds, none and forever', () => {
  const cfg = h.makeCfg();
  const now = WED(19, 10);
  assert.equal(durationUntil(cfg, 'r_living', '1h', now, KYIV), now + 3600_000);
  assert.equal(durationUntil(cfg, 'r_living', '3h', now, KYIV), now + 3 * 3600_000);
  assert.equal(durationUntil(cfg, 'r_living', '4h', now, KYIV), now + 4 * 3600_000);
  assert.equal(durationUntil(cfg, 'r_living', 'until', now, KYIV, now + 7200_000), now + 7200_000);
  assert.equal(durationUntil(cfg, 'r_living', 'until', now, KYIV, now + 60_000), now + 5 * h.MIN);
  assert.throws(() => durationUntil(cfg, 'r_living', 'until', now, KYIV), RangeError);
  assert.equal(durationUntil(cfg, 'r_living', 'none', now, KYIV), null);
  assert.equal(durationUntil(cfg, 'r_living', 'forever', now, KYIV), null);
  assert.equal(durationUntil(cfg, 'r_living', 'minutes', now, KYIV, now + 30 * h.MIN), now + 30 * h.MIN);
});

test('exceptions replace the plan of their date («як неділя» and an own plan)', () => {
  const cfg = h.makeCfg();
  cfg.scheduleExceptions.push({ id: 'se1', scheduleId: 'house', date: '2026-10-22', plan: { likeDow: 6 }, note: 'свято' });
  // Thursday like Sunday: night until 08:00
  assert.equal(durationUntil(cfg, 'r_living', 'slot', WED(23, 30), KYIV), THU(8, 0));
  cfg.scheduleExceptions[0] = { id: 'se1', scheduleId: 'house', date: '2026-10-22', plan: [{ start: 0, end: 600, profileId: 'night' }, { start: 600, end: 1440, profileId: 'guests' }], note: null };
  assert.equal(durationUntil(cfg, 'r_living', 'slot', WED(23, 30), KYIV), THU(10, 0));
  assert.equal(scheduleAt(cfg, cfg.schedules[0], THU(12, 0), KYIV).profileId, 'guests');
});

test('the room schedule governs the room slot; a time-limited house override ends it earlier', () => {
  const cfg = h.makeCfg();
  const days = h.d.seedHouseDays().map(() => [{ start: 0, end: 1200, profileId: 'home' }, { start: 1200, end: 1440, profileId: 'eco' }]);
  cfg.schedules.push({ id: 'room_r_living', scope: 'room', roomId: 'r_living', enabled: true, days, updatedAt: 0 });
  assert.equal(durationUntil(cfg, 'r_living', 'slot', WED(19, 10), KYIV), WED(20, 0));
  cfg.overrides.push(override({ id: 'h1', scope: 'house', subjectId: 'house', kind: 'house_profile', group: 'house_profile', value: { kind: 'house_profile', profileId: 'guests' }, until: WED(19, 40) }));
  assert.equal(durationUntil(cfg, 'r_living', 'slot', WED(19, 10), KYIV), WED(19, 40));
});

test('DST fall back (2026-10-25): a boundary in the repeated hour fires once', () => {
  const cfg = h.makeCfg();
  const sunday = [{ start: 0, end: 210, profileId: 'night' }, { start: 210, end: 1440, profileId: 'home' }];
  const days = h.d.seedHouseDays();
  days[6] = sunday;
  cfg.schedules[0] = { ...cfg.schedules[0], days };
  const firstOccurrence = Date.UTC(2026, 9, 25, 0, 30); // 03:30 EEST
  const secondQuarterPast = Date.UTC(2026, 9, 25, 1, 15); // 03:15 EET, after the boundary fired
  const changes = scheduleChanges(cfg, cfg.schedules[0], Date.UTC(2026, 9, 24, 21, 0), Date.UTC(2026, 9, 25, 4, 0), KYIV);
  assert.deepEqual(changes, [{ at: firstOccurrence, profileId: 'home' }]);
  assert.equal(scheduleAt(cfg, cfg.schedules[0], secondQuarterPast, KYIV).profileId, 'home');
  // the Sunday is 25 hours long; the weekend morning boundary is 08:00 EET
  const sat = h.kyiv(2026, 10, 24, 23, 40);
  const normal = h.makeCfg();
  assert.equal(durationUntil(normal, 'r_living', 'slot', sat, KYIV), Date.UTC(2026, 9, 25, 6, 0));
});

test('DST spring forward (2026-03-29): a block inside the missing hour has no length', () => {
  const cfg = h.makeCfg();
  const days = h.d.seedHouseDays();
  days[6] = [{ start: 0, end: 180, profileId: 'night' }, { start: 180, end: 210, profileId: 'eco' }, { start: 210, end: 1440, profileId: 'home' }];
  cfg.schedules[0] = { ...cfg.schedules[0], days };
  const from = Date.UTC(2026, 2, 28, 22, 0); // Sun 00:00 EET
  const changes = scheduleChanges(cfg, cfg.schedules[0], from, from + 6 * 3600_000, KYIV);
  assert.deepEqual(changes, [{ at: Date.UTC(2026, 2, 29, 1, 0), profileId: 'home' }]);
});

/* ── house profile ────────────────────────────────────────────────────────────────────────────────── */

test('house profile: schedule, then a manual override, calendar and default', () => {
  const cfg = h.makeCfg();
  const inputs = h.makeInputs(WED(19, 10));
  const mem = h.emptyMemory(cfg, WED(19, 10));
  let s = resolveHouseProfile(cfg, inputs, mem).state;
  assert.equal(s.activeProfileId, 'home');
  assert.equal(s.layer, 'house_schedule');
  assert.equal(s.scheduledUntil, WED(23, 0));
  assert.equal(s.nextProfileId, 'night');

  cfg.activationRules.push({ id: 'ar_cal', profileId: 'guests', enabled: true, order: 0, config: { type: 'calendar', calendarEntityId: 'calendar.family', match: { field: 'summary', contains: 'гості' }, preheatMin: 60 } });
  inputs.calendarEvents['calendar.family'] = [{ start: WED(20, 0), end: WED(23, 30), summary: 'Гості в суботу', description: '', location: '' }];
  s = resolveHouseProfile(cfg, inputs, mem).state;
  assert.equal(s.activeProfileId, 'guests');
  assert.equal(s.layer, 'calendar');

  cfg.overrides.push(override({ id: 'h1', scope: 'house', subjectId: 'house', kind: 'house_profile', group: 'house_profile', value: { kind: 'house_profile', profileId: 'eco' }, until: WED(21, 0) }));
  s = resolveHouseProfile(cfg, inputs, mem).state;
  assert.equal(s.activeProfileId, 'eco');
  assert.equal(s.layer, 'house_manual');
  assert.equal(s.override.id, 'h1');

  const plain = h.makeCfg();
  plain.schedules[0] = { ...plain.schedules[0], enabled: false };
  s = resolveHouseProfile(plain, h.makeInputs(WED(19, 10)), mem).state;
  assert.equal(s.layer, 'default');
  assert.equal(s.activeProfileId, 'home');
});

test('presence: all away after the delay, someone home during a planned «away», vacation', () => {
  const cfg = h.makeCfg();
  cfg.settings.presence = { ...cfg.settings.presence, enabled: true, personEntityIds: ['person.a', 'person.b'] };
  cfg.activationRules.push(
    { id: 'ar_away', profileId: 'away', enabled: true, order: 0, config: { type: 'presence', trigger: 'all_away', optimalStart: false } },
    { id: 'ar_home', profileId: 'home', enabled: true, order: 1, config: { type: 'presence', trigger: 'someone_home', optimalStart: false } },
  );
  const now = WED(19, 10);
  const mem = h.emptyMemory(cfg, now);
  const persons = (a, b, changed) => ({ 'person.a': h.snap('person.a', a, { lastChanged: changed }), 'person.b': h.snap('person.b', b, { lastChanged: changed }) });
  let s = resolveHouseProfile(cfg, h.makeInputs(now, persons('not_home', 'not_home', now - 10 * h.MIN)), mem).state;
  assert.equal(s.layer, 'house_schedule');
  s = resolveHouseProfile(cfg, h.makeInputs(now, persons('not_home', 'not_home', now - 16 * h.MIN)), mem).state;
  assert.equal(s.activeProfileId, 'away');
  assert.equal(s.layer, 'presence');
  assert.equal(s.presence.anyoneHome, false);
  // Wed 10:00 the plan says «Поза домом»; someone stayed home → «Дома» until the 17:30 boundary
  const morning = WED(10, 0);
  s = resolveHouseProfile(cfg, h.makeInputs(morning, persons('home', 'not_home', morning - 3600_000)), mem).state;
  assert.equal(s.activeProfileId, 'home');
  assert.equal(s.layer, 'presence');

  cfg.activationRules.push({ id: 'ar_vac', profileId: 'vacation', enabled: true, order: 2, config: { type: 'vacation', from: now - 86_400_000, until: now + 5 * 86_400_000, returnProfileId: 'home', returnLeadH: 3 } });
  s = resolveHouseProfile(cfg, h.makeInputs(now, persons('not_home', 'not_home', now - 16 * h.MIN)), mem).state;
  assert.equal(s.activeProfileId, 'vacation');
});

test('house profile edges: span and journal entry when the profile changes', () => {
  const prev = { activeProfileId: 'home', layer: 'house_schedule', scheduledProfileId: 'home', scheduledUntil: null, nextProfileId: null, override: null, presence: { configured: false, anyoneHome: null, awaySince: null, approaching: false } };
  const next = { ...prev, activeProfileId: 'night', scheduledUntil: THU(6, 30) };
  const e = houseProfileEdges(prev, next, WED(23, 0));
  assert.deepEqual(e.spans.map((s) => [s.subjectId, s.edge]), [['home', 'end'], ['night', 'start']]);
  assert.equal(e.decisions[0].code, 'house_profile.changed');
  assert.equal(e.decisions[0].params.until, THU(6, 30));
  assert.equal(houseProfileEdges(next, next, WED(23, 1)).spans.length, 0);
});

/* ── room target layering ────────────────────────────────────────────────────────────────────────── */

function roomAt(now, t, cfgMut) {
  const cfg = h.makeCfg({ now });
  cfgMut?.(cfg);
  const entities = { ...h.temps(now, [t, t, t]), 'climate.trv1': h.trvSnap('climate.trv1', now, t + 1), 'climate.trv2': h.trvSnap('climate.trv2', now, t + 1) };
  const inputs = h.makeInputs(now, entities);
  return { cfg, inputs, memory: h.emptyMemory(cfg, now) };
}

test('schedule layer: Wed 19:10 «Дома» 21.0 until 23:00, next «Ніч» 19.5', () => {
  const { cfg, inputs, memory } = roomAt(WED(19, 10), 20.5);
  const { state } = h.tick(cfg, inputs, memory);
  assert.equal(state.target.profileId, 'home');
  assert.equal(state.target.layer, 'house_schedule');
  assert.equal(state.target.display, 'schedule');
  assert.equal(state.target.heatC, 21);
  assert.equal(state.target.coolC, null);
  assert.equal(state.target.mode, 'heat');
  assert.equal(state.target.displayC, 21);
  assert.equal(state.target.until, WED(23, 0));
  assert.deepEqual(state.target.next, { at: WED(23, 0), profileId: 'night', heatC: 19.5, coolC: null });
});

test('boost is an absolute target: a schedule boundary does not move it', () => {
  const boost = (cfg) => cfg.overrides.push(override({ kind: 'room_boost', value: { kind: 'room_boost', mode: 'heat', deltaC: 1, targetC: 22 }, duration: 'minutes', until: WED(23, 30) }));
  const before = roomAt(WED(22, 50), 20.5, boost);
  const a = h.tick(before.cfg, before.inputs, before.memory).state;
  assert.equal(a.target.heatC, 22);
  assert.equal(a.target.display, 'boost');
  const after = roomAt(WED(23, 10), 20.5, boost);
  const b = h.tick(after.cfg, after.inputs, after.memory).state;
  assert.equal(b.target.heatC, 22);
  assert.equal(b.target.until, WED(23, 30));
});

test('room profile override, profile rows, «off» row and a frost-only profile', () => {
  const rp = roomAt(WED(19, 10), 20, (cfg) => cfg.overrides.push(override({ kind: 'room_profile', value: { kind: 'room_profile', profileId: 'guests' }, until: WED(23, 0) })));
  let s = h.tick(rp.cfg, rp.inputs, rp.memory).state;
  assert.equal(s.target.heatC, 22);
  assert.equal(s.target.display, 'room_profile');

  const own = roomAt(WED(19, 10), 20, (cfg) => cfg.profileRooms.push({ profileId: 'home', roomId: 'r_living', mode: 'own', heatC: 20.0, coolC: null, writtenAt: null }));
  s = h.tick(own.cfg, own.inputs, own.memory).state;
  assert.equal(s.target.heatC, 20);

  const offRow = roomAt(WED(19, 10), 20, (cfg) => cfg.profileRooms.push({ profileId: 'home', roomId: 'r_living', mode: 'off', heatC: null, coolC: null, writtenAt: null }));
  s = h.tick(offRow.cfg, offRow.inputs, offRow.memory).state;
  assert.equal(s.target.heatC, null);
  assert.equal(s.state, 'off');
  assert.deepEqual(s.why[0], { code: 'why.off.profile', params: { profileId: 'home' } });

  const vac = roomAt(WED(19, 10), 20, (cfg) => cfg.overrides.push(override({ id: 'h1', scope: 'house', subjectId: 'house', kind: 'house_profile', group: 'house_profile', value: { kind: 'house_profile', profileId: 'vacation' }, duration: 'none', until: null })));
  s = h.tick(vac.cfg, vac.inputs, vac.memory).state;
  assert.equal(s.target.layer, 'house_manual');
  assert.equal(s.state, 'off');
  assert.equal(s.why[0].code, 'why.off.frost_only');
});

test('«Постійно, у профіль»: a freshly written row shows «Дома (оновлено)» for 8 hours', () => {
  const now = WED(19, 10);
  const fresh = roomAt(now, 20, (cfg) => cfg.profileRooms.push({ profileId: 'home', roomId: 'r_living', mode: 'own', heatC: 21.5, coolC: null, writtenAt: now - 3600_000 }));
  let s = h.tick(fresh.cfg, fresh.inputs, fresh.memory).state;
  assert.equal(s.target.heatC, 21.5);
  assert.equal(s.target.profileUpdated, true);
  assert.equal(s.target.display, 'profile_updated');
  assert.equal(s.target.overrideId, null);
  const old = roomAt(now, 20, (cfg) => cfg.profileRooms.push({ profileId: 'home', roomId: 'r_living', mode: 'own', heatC: 21.5, coolC: null, writtenAt: now - 9 * 3600_000 }));
  s = h.tick(old.cfg, old.inputs, old.memory).state;
  assert.equal(s.target.profileUpdated, false);
  assert.equal(s.target.display, 'schedule');
});

test('rule offsets apply to scheduled targets, never over a manual value', () => {
  const offset = { r_living: { heat: { deltaC: -1, ruleId: 'economy' }, cool: null } };
  const sched = roomAt(WED(19, 10), 19.5);
  const ctx = h.ctxOf(sched.cfg, sched.inputs, sched.memory, { overlay: { ...h.emptyOverlay(), targetOffsets: offset } });
  let s = h.tick(sched.cfg, sched.inputs, sched.memory, { ctx }).state;
  assert.equal(s.target.heatC, 20);
  assert.ok(s.why.some((r) => r.code === 'why.rule_offset' && r.params.deltaC === -1));
  assert.deepEqual(s.activeRuleIds, ['economy']);
  const manual = roomAt(WED(19, 10), 19.5, (cfg) => cfg.overrides.push(override({ kind: 'room_target', value: { kind: 'room_target', mode: 'heat', heatC: 22, coolC: null }, until: WED(23, 0) })));
  const ctx2 = h.ctxOf(manual.cfg, manual.inputs, manual.memory, { overlay: { ...h.emptyOverlay(), targetOffsets: offset } });
  s = h.tick(manual.cfg, manual.inputs, manual.memory, { ctx: ctx2 }).state;
  assert.equal(s.target.heatC, 22);
});

test('limits clamp the target; the dual gap pushes the cooling target', () => {
  const clamp = roomAt(WED(19, 10), 20, (cfg) => cfg.overrides.push(override({ kind: 'room_target', value: { kind: 'room_target', mode: 'heat', heatC: 35, coolC: null } })));
  let s = h.tick(clamp.cfg, clamp.inputs, clamp.memory).state;
  assert.equal(s.target.heatC, 30);
  assert.ok(s.target.adjustments.some((a) => a.code === 'clamped'));
  // neutral season with an AC: both modes live, 24 / 25 → 24 / 26
  const dual = roomAt(WED(19, 10), 24.5, (cfg) => {
    const ac = { ...h.d.newSourceConfig('ac', { id: 's_ac', name: 'AC', now: 0, scope: 'room', roomId: 'r_living' }), enabled: true };
    cfg.sources.push(ac);
    cfg.emittersByRoom.r_living.push({ ...h.d.DEFAULT_EMITTER(), id: 'e_ac', roomId: 'r_living', kind: 'direct', sourceId: 's_ac', roles: { heat: 'assist', cool: 'primary' }, assist: { deficitC: 1.5 } });
    cfg.overrides.push(override({ kind: 'room_target', value: { kind: 'room_target', mode: 'dual', heatC: 24, coolC: 25 } }));
  });
  s = h.tick(dual.cfg, dual.inputs, dual.memory, { ctxExtra: { season: h.season('neutral') } }).state;
  assert.equal(s.target.mode, 'dual');
  assert.equal(s.target.heatC, 24);
  assert.equal(s.target.coolC, 26);
  assert.equal(s.target.display, 'range');
  assert.equal(s.target.displayC, null);
  assert.equal(s.why[0].code, 'why.dual.in_band');
});

test('optimal start: the 17:30 «Дома» block starts early by the learned rate', () => {
  const setup = (now) => {
    const r = roomAt(now, 18.0);
    r.memory.rooms.r_living.learned = { ...r.memory.rooms.r_living.learned, heatRateCPerH: 4, heatSamples: 5 };
    return r;
  };
  // away 18.0 → home 21.0: lead = round5(3 / 4 · 60) = 45 min → from 16:45
  const early = setup(WED(16, 40));
  let s = h.tick(early.cfg, early.inputs, early.memory).state;
  assert.equal(s.target.heatC, 18);
  assert.equal(s.target.preheat, null);
  const on = setup(WED(16, 50));
  s = h.tick(on.cfg, on.inputs, on.memory).state;
  assert.equal(s.target.heatC, 21);
  assert.equal(s.target.display, 'preheat');
  assert.deepEqual(s.target.preheat, { forBlockAt: WED(17, 30), leadMin: 45 });
  assert.ok(s.why.some((r) => r.code === 'why.preheat' && r.params.profileId === 'home'));
  assert.equal(s.demand.mode, 'heat');
});

test('optimal start holds once started, until the room reaches the target or the plan changes', () => {
  let memory = null;
  const step = (now, t, cfgMut) => {
    const r = roomAt(now, t, cfgMut);
    if (!memory) {
      memory = r.memory;
      memory.rooms.r_living.learned = { ...memory.rooms.r_living.learned, heatRateCPerH: 4, heatSamples: 5 };
    }
    const out = h.tick(r.cfg, r.inputs, memory);
    memory = out.memory;
    return out.state;
  };
  // 16:50, 18.0°: 45 min ahead of the 17:30 «Дома» block → pre-heat starts
  let s = step(WED(16, 50), 18.0);
  assert.equal(s.target.display, 'preheat');
  assert.deepEqual(memory.rooms.r_living.preheat, { forBlockAt: WED(17, 30), profileId: 'home', heatC: 21, leadMin: 45, since: WED(16, 50) });
  // 17:00, 19.6°: the lead alone is now 20 min (start at 17:10), but the heating keeps going
  s = step(WED(17, 0), 19.6);
  assert.equal(s.target.heatC, 21);
  assert.equal(s.target.display, 'preheat');
  assert.deepEqual(s.target.preheat, { forBlockAt: WED(17, 30), leadMin: 45 });
  assert.equal(s.demand.mode, 'heat');
  // 17:10, 21.2° = 21 + tolerance above: done, back to «Не вдома» until the block
  s = step(WED(17, 10), 21.2);
  assert.equal(s.target.heatC, 18);
  assert.equal(s.target.preheat, null);
  assert.equal(memory.rooms.r_living.preheat, null);
  // 17:25, 20.6°: needed again for the last minutes
  s = step(WED(17, 25), 20.6);
  assert.equal(s.target.display, 'preheat');
  assert.equal(memory.rooms.r_living.preheat.since, WED(17, 25));
  // 17:30: the block itself
  s = step(WED(17, 30), 20.9);
  assert.equal(s.target.display, 'schedule');
  assert.equal(s.target.heatC, 21);
  assert.equal(memory.rooms.r_living.preheat, null);

  // the plan changes: a manual target while pre-heating drops the latch for good
  memory = null;
  step(WED(16, 50), 18.0);
  const manual = override({ kind: 'room_target', createdAt: WED(16, 55), until: WED(17, 30), value: { kind: 'room_target', mode: 'heat', heatC: 19.5, coolC: null } });
  s = step(WED(16, 55), 18.5, (cfg) => cfg.overrides.push(manual));
  assert.equal(s.target.display, 'manual');
  assert.equal(memory.rooms.r_living.preheat, null);
  // the override is gone at 17:00 and the room is at 19.6: the lead decides again (start at 17:10)
  s = step(WED(17, 0), 19.6);
  assert.equal(s.target.heatC, 18);
  assert.equal(s.target.preheat, null);
});
