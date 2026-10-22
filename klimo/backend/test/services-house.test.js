const assert = require('node:assert/strict');
const test = require('node:test');
const { ACTOR, HOUR, heatingTarget, openServices, rejection } = require('./services-harness');
const { emptyPlantState, emptySourceState } = require('../dist/engine/services/mappers');

const houseProfile = (active, scheduled = active, layer = 'house_schedule') => ({
  activeProfileId: active,
  layer,
  scheduledProfileId: scheduled,
  scheduledUntil: null,
  nextProfileId: 'night',
  override: null,
  presence: { configured: false, anyoneHome: null, awaySince: null, approaching: false },
});

/** A plant whose only running source is `sourceId` (lead in heating). */
function plantRunning(s, sourceId, extra = {}) {
  const cfg = s.config.engineConfig();
  const plant = emptyPlantState(cfg, () => [], [], s.clock.now());
  plant.sources = cfg.sources.map((src) => ({ ...emptySourceState(src, [], [], s.clock.now()), ...(src.id === sourceId ? { on: true, mode: 'heat', state: 'heating', tone: 'heat', ...extra } : {}) }));
  plant.lead = { heat: sourceId, cool: null };
  return plant;
}

async function heatPump(s) {
  const { newSourceConfig } = require('../dist/shared/defaults');
  const base = newSourceConfig('heat_pump', { id: '', name: 'Тепловий насос', now: 0 });
  delete base.id;
  return s.config.create('sources', base, ACTOR);
}

/** The heating demo house of the Overview (rooms, temperatures, targets and tolerances). */
async function demoHouse(s) {
  const mk = (name, tolerance) => s.config.create('rooms', { name, ...(tolerance ? { tolerance } : {}) }, ACTOR);
  const living = await mk('Вітальня');
  const bedroom = await mk('Спальня');
  const kids = await mk('Дитяча', { heat: { below: 0.3, above: 0.3 }, cool: { below: 0.3, above: 0.3 } });
  const study = await mk('Кабінет');
  const kitchen = await mk('Кухня', { heat: { below: 0.5, above: 0.3 }, cool: { below: 0.3, above: 0.3 } });
  const bath = await mk('Ванна');
  const hall = await mk('Коридор');
  await s.config.setProfileRoom('guests', study.id, { mode: 'own', heatC: 21 }, ACTOR);
  s.setRoom(living.id, { state: 'heat', tempC: 19.8, target: heatingTarget(20), demand: { mode: 'heat', served: true } });
  s.setRoom(bedroom.id, { state: 'window', tempC: 17.6, target: heatingTarget(19) });
  s.setRoom(kids.id, { state: 'heat', tempC: 21.7, target: heatingTarget(22), demand: { mode: 'heat', served: true } });
  s.setRoom(study.id, { state: 'hold', tempC: 21.0, target: heatingTarget(20.5, { layer: 'manual', display: 'manual' }) });
  s.setRoom(kitchen.id, { state: 'hold', tempC: 20.9, target: heatingTarget(21) });
  s.setRoom(bath.id, { state: 'heat', tempC: 23.7, target: heatingTarget(24), demand: { mode: 'heat', served: true } });
  s.setRoom(hall.id, { state: 'hold', tempC: 19.1, target: heatingTarget(19) });
  s.engine.hp = houseProfile('home');
  return { living, bedroom, kids, study, kitchen, bath, hall };
}

async function withHouse(fn) {
  const s = await openServices();
  try {
    const hp = await heatPump(s);
    s.engine.plantState = plantRunning(s, hp.id);
    s.engine.dryRunImpl = (mutate) => {
      const cfg = JSON.parse(JSON.stringify(s.config.engineConfig()));
      mutate(cfg, {}, {});
      s.lastDryRunCfg = cfg;
      return { plant: plantRunning(s, hp.id), rooms: s.engine.rooms() };
    };
    await fn(s, hp, await demoHouse(s));
  } finally {
    await s.close();
  }
}

test('«Гості» from «Дома»: five targets up, one down, four rooms would heat from the heat pump', () =>
  withHouse(async (s, hp, r) => {
    const p = s.houseActions.preview({ profileId: 'guests', duration: '2h' });
    assert.equal(p.same, false);
    assert.equal(p.clearsOverride, false);
    assert.deepEqual(new Set(p.up), new Set([r.living.id, r.bedroom.id, r.study.id, r.kitchen.id, r.hall.id]));
    assert.deepEqual(p.down, [r.bath.id]);
    assert.deepEqual(new Set(p.run), new Set([r.living.id, r.kids.id, r.kitchen.id, r.hall.id]));
    assert.deepEqual(p.roomsOff, []);
    assert.deepEqual(p.sourceIds, [hp.id]);
    assert.deepEqual(p.main, { code: 'house.preview.will_heat', params: { n: 4, sourceId: hp.id } });
    assert.equal(p.tone, 'heat');
    assert.deepEqual(p.chips, [{ code: 'house.chip.up', params: { n: 5 } }, { code: 'house.chip.down', params: { n: 1 } }]);
    assert.equal(p.until, s.clock.now() + 2 * HOUR);
    // the strategy was asked with the hypothetical override in place
    const ov = s.lastDryRunCfg.overrides.filter((o) => o.group === 'house_profile');
    assert.equal(ov.length, 1);
    assert.equal(ov[0].value.profileId, 'guests');
  }));

test('«Еко» lowers five targets and stops the heating', () =>
  withHouse(async (s) => {
    const p = s.houseActions.preview({ profileId: 'eco', duration: 'slot' });
    assert.equal(p.down.length, 5);
    assert.deepEqual(p.run, []);
    assert.equal(p.main.code, 'house.preview.heating_stops');
    assert.equal(p.tone, 'off');
  }));

test('the current profile previews as «same»; a frost-only profile turns rooms off and keeps frost protection', () =>
  withHouse(async (s) => {
    const same = s.houseActions.preview({ profileId: 'home', duration: 'slot' });
    assert.equal(same.same, true);
    assert.equal(same.clearsOverride, true);
    assert.deepEqual(same.main, { code: 'house.preview.same', params: { profileId: 'home' } });
    assert.deepEqual(same.chips, []);

    const vacation = s.houseActions.preview({ profileId: 'vacation', duration: 'none' });
    assert.equal(vacation.roomsOff.length, 7);
    assert.equal(vacation.until, null);
    assert.deepEqual(vacation.chips, [{ code: 'house.chip.frost_stays', params: { frostC: 7 } }]);
  }));

test('picking the scheduled profile with «до кінця слоту» clears the override (and can be undone)', () =>
  withHouse(async (s) => {
    const set = await s.houseActions.setProfile({ profileId: 'guests', duration: '2h', reqId: 'h1' }, ACTOR);
    const ov = s.overrides.active().find((o) => o.group === 'house_profile');
    assert.equal(ov.value.profileId, 'guests');
    assert.equal(ov.until, s.clock.now() + 2 * HOUR);
    assert.equal(set.revertToken, ov.revertToken);
    // the same request id is answered from memory
    const again = await s.houseActions.setProfile({ profileId: 'guests', duration: '2h', reqId: 'h1' }, ACTOR);
    assert.equal(again.revertToken, set.revertToken);

    s.engine.hp = houseProfile('guests', 'home', 'house_manual');
    s.clock.advance(1_000);
    assert.equal(s.houseActions.preview({ profileId: 'home', duration: 'slot' }).clearsOverride, true);
    const cleared = await s.houseActions.setProfile({ profileId: 'home', duration: 'slot' }, ACTOR);
    assert.equal(s.overrides.active().some((o) => o.group === 'house_profile'), false);
    assert.equal(typeof cleared.revertToken, 'string');
    const journal = await s.journal.page({ category: 'system' });
    assert.deepEqual(journal.items.map((e) => e.code), ['house_profile.cleared', 'house_profile.changed']);

    await s.houseActions.undo(cleared.revertToken, ACTOR);
    const back = s.overrides.active().find((o) => o.group === 'house_profile');
    assert.equal(back.value.profileId, 'guests');
    assert.equal((await rejection(() => s.houseActions.undo(cleared.revertToken, ACTOR))).code, 'revert_expired');
  }));

test('a house profile change is undone with its token within 30 s', () =>
  withHouse(async (s) => {
    await s.houseActions.setProfile({ profileId: 'eco', duration: '1h' }, ACTOR);
    const second = await s.houseActions.setProfile({ profileId: 'guests', duration: 'none' }, ACTOR);
    await s.houseActions.undo(second.revertToken, ACTOR);
    const active = s.overrides.active().filter((o) => o.group === 'house_profile');
    assert.equal(active.length, 1);
    assert.equal(active[0].value.profileId, 'eco');
    const third = await s.houseActions.setProfile({ profileId: 'night', duration: 'none' }, ACTOR);
    s.clock.advance(31_000);
    assert.equal((await rejection(() => s.houseActions.undo(third.revertToken, ACTOR))).code, 'revert_expired');
    assert.equal((await rejection(() => s.houseActions.setProfile({ profileId: 'nope', duration: 'slot' }, ACTOR))).code, 'not_found');
  }));

test('house mode: a change is stored and journalled; its preview names what stops', () =>
  withHouse(async (s, hp, r) => {
    const same = s.houseActions.previewMode('auto');
    assert.equal(same.changesNow, false);
    assert.equal(same.main.code, 'mode.preview.no_change');

    // with the mode off the pump runs out its minimum time and the rooms are no longer served
    s.engine.dryRunImpl = (mutate) => {
      const cfg = JSON.parse(JSON.stringify(s.config.engineConfig()));
      mutate(cfg, {}, {});
      assert.equal(cfg.house.mode, 'off');
      const plant = plantRunning(s, hp.id, { blockers: [{ code: 'source.blocked.min_run', params: { until: s.clock.now() + 600_000 } }] });
      const rooms = s.engine.rooms().map((x) => ({ ...x, demand: { ...x.demand, mode: 'none', served: false } }));
      return { plant, rooms };
    };
    const p = s.houseActions.previewMode('off');
    assert.equal(p.changesNow, true);
    assert.deepEqual(p.stoppingSourceIds, [hp.id]);
    assert.deepEqual(p.startingSourceIds, []);
    assert.deepEqual(new Set(p.affectedRoomIds), new Set([r.living.id, r.kids.id, r.bath.id]));
    assert.deepEqual(p.main, { code: 'mode.preview.stops', params: { n: 3, sourceId: hp.id } });

    await s.houseActions.setMode('off', ACTOR);
    const house = s.config.singleton('house');
    assert.equal(house.mode, 'off');
    assert.equal(house.modeChangedBy.userName, 'Ігор');
    const j = await s.journal.page({ codes: ['house_mode.changed'] });
    assert.deepEqual(j.items[0].params, { from: 'auto', to: 'off', by: 'Ігор' });
    assert.equal((await rejection(() => s.houseActions.setMode('sometimes', ACTOR))).code, 'validation');
  }));

test('house durations resolve their end times; activation rules are tested in isolation', () =>
  withHouse(async (s) => {
    const d = Object.fromEntries(s.houseActions.durations().map((x) => [x.id, x.until]));
    assert.deepEqual(Object.keys(d), ['slot', '1h', '2h', '3h', 'morning', 'until', 'none']);
    assert.equal(d['3h'], s.clock.now() + 3 * HOUR);
    assert.equal(d.none, null);

    const rule = s.config.list('activationRules')[0];
    s.engine.inputs = { now: s.clock.now(), calendarEvents: {} };
    let seen = null;
    s.t.resolved = (cfg) => {
      seen = cfg;
      return houseProfile(rule.profileId, 'home', 'presence');
    };
    const res = s.houseActions.activationRuleTest(rule.id);
    assert.equal(res.wouldActivate, rule.config.type !== 'calendar');
    assert.equal(seen.activationRules.length, 1);
    assert.equal(seen.activationRules[0].enabled, true);
    assert.equal((await rejection(async () => s.houseActions.activationRuleTest('ar_none'))).code, 'not_found');
  }));
