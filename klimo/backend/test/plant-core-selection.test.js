const assert = require('node:assert/strict');
const test = require('node:test');
const h = require('./plant-core-harness');

const { MIN, HOUR, SEC } = h;

/** Heat pump first, gas boiler second, both on one radiator circuit with a source-rule pump. */
function bivalentHouse(mode = 'alt') {
  const hp = h.heatPump('s_hp');
  const boiler = h.gasBoiler('s_boiler');
  const rad = h.circuit('c_rad', ['s_hp', 's_boiler']);
  const p = h.pump('p_rad', 'c_rad', 'switch.rad_pump', { rule: 'source', runOnHeatMin: 3 });
  const r = h.room('r_liv');
  const e = h.emitter('e_rad', 'r_liv', { circuitId: 'c_rad', roles: { heat: 'primary', cool: null } });
  return h.makeCfg({
    rooms: [r],
    emitters: [e],
    sources: [hp, boiler],
    circuits: [rad],
    pumps: [p],
    heat: { chain: h.chain('s_hp', 's_boiler'), bivalence: { mode, pointC: -10, hysteresisC: 2, hpLimitC: -15 } },
  });
}

/** Ticks at `at` and lets pre-run and confirmation settle (one minute of 10-s ticks). */
function settle(run, at) {
  run.tick(at);
  return run.runUntil(at + MIN).at(-1);
}

const on = (res, id) => h.sourceState(res, id).on;

test('alt bivalence: −9 heat pump → −11 boiler → −9 still boiler → −8 heat pump again', () => {
  const run = h.runner(bivalentHouse('alt'));
  run.set('climate.heat_pump', 'off').set('switch.boiler_relay', 'off').set('switch.rad_pump', 'off');
  run.room('r_liv', { t: 19.5, demand: 'heat' });
  const t0 = run.st.now;

  run.outdoor(-9);
  let res = settle(run, t0 + 10 * SEC);
  assert.equal(on(res, 's_hp'), true);
  assert.equal(on(res, 's_boiler'), false);
  assert.equal(h.sourceState(res, 's_boiler').role, 'reserve');
  assert.equal(h.sourceState(res, 's_boiler').roleReason.code, 'role.reserve_below');
  assert.equal(h.sourceState(res, 's_hp').roleReason.code, 'role.lead');
  assert.ok(res.plant.why.some((w) => w.code === 'plant.bivalent_hp'), 'above the point the heat pump copes alone');
  assert.ok(!res.plant.why.some((w) => w.code === 'plant.bivalent_reserve'));

  run.outdoor(-11);
  res = settle(run, t0 + 20 * MIN);
  assert.equal(on(res, 's_boiler'), true, 'below the bivalent point the boiler leads');
  assert.equal(on(res, 's_hp'), false);
  assert.ok(res.plant.why.some((w) => w.code === 'plant.bivalent_reserve' && w.params.sourceId === 's_boiler'), 'below the point the reserve takes over');
  assert.ok(!res.plant.why.some((w) => w.code === 'plant.bivalent_hp'));
  // the idle heat pump says why it waits, as the reserve on standby rather than «off for the season»
  assert.equal(h.sourceState(res, 's_hp').state, 'standby');
  assert.equal(h.sourceState(res, 's_hp').blockers[0].code, 'source.blocked.bivalence');
  // one main source: the boiler; the heat pump's role is the bivalence hold, not «Основне»
  assert.deepEqual([h.sourceState(res, 's_boiler').role, h.sourceState(res, 's_boiler').roleReason.code], ['lead', 'role.lead']);
  assert.equal(h.sourceState(res, 's_hp').role, 'reserve');
  assert.deepEqual(h.sourceState(res, 's_hp').roleReason, { code: 'source.blocked.bivalence', params: { pointC: -10, toutC: -11 } });
  // with no room asking, the roles stay the same
  run.room('r_liv', { t: 21.5, demand: 'none' });
  res = settle(run, t0 + 30 * MIN);
  assert.equal(on(res, 's_boiler'), false);
  assert.deepEqual([h.sourceState(res, 's_boiler').role, h.sourceState(res, 's_hp').role], ['lead', 'reserve']);
  run.room('r_liv', { t: 19.5, demand: 'heat' });

  run.outdoor(-9);
  res = settle(run, t0 + 40 * MIN);
  assert.equal(on(res, 's_boiler'), true, 'between −10 and −8 the latch holds');
  assert.equal(on(res, 's_hp'), false);

  run.outdoor(-8);
  res = settle(run, t0 + 60 * MIN);
  assert.equal(on(res, 's_hp'), true, 'the heat pump returns at −8');
  assert.equal(on(res, 's_boiler'), false);
});

test('partial bivalence: −12 both, −16 boiler only, −13 heat pump back (boiler still joins)', () => {
  const run = h.runner(bivalentHouse('partial'));
  run.set('climate.heat_pump', 'off').set('switch.boiler_relay', 'off').set('switch.rad_pump', 'off');
  run.room('r_liv', { t: 19.5, demand: 'heat' });
  const t0 = run.st.now;

  run.outdoor(-12);
  let res = settle(run, t0 + 10 * SEC);
  assert.equal(on(res, 's_hp'), true);
  assert.equal(on(res, 's_boiler'), true);
  assert.equal(h.sourceState(res, 's_boiler').role, 'together');

  run.outdoor(-16);
  res = settle(run, t0 + 20 * MIN);
  assert.equal(on(res, 's_hp'), false, 'below the HP limit only the boiler runs');
  assert.equal(on(res, 's_boiler'), true);

  run.outdoor(-14);
  res = settle(run, t0 + 40 * MIN);
  assert.equal(on(res, 's_hp'), false, 'the limit latch holds until −13');

  run.outdoor(-13);
  res = settle(run, t0 + 60 * MIN);
  assert.equal(on(res, 's_hp'), true, 'the heat pump resumes at −13');
  assert.equal(on(res, 's_boiler'), true);
});

test('parallel bivalence: the heat pump always runs, the boiler joins below the point', () => {
  const run = h.runner(bivalentHouse('parallel'));
  run.set('climate.heat_pump', 'off').set('switch.boiler_relay', 'off').set('switch.rad_pump', 'off');
  run.room('r_liv', { t: 19.5, demand: 'heat' });
  const t0 = run.st.now;
  run.outdoor(-5);
  let res = settle(run, t0 + 10 * SEC);
  assert.equal(on(res, 's_hp'), true);
  assert.equal(on(res, 's_boiler'), false);
  run.outdoor(-12);
  res = settle(run, t0 + 20 * MIN);
  assert.equal(on(res, 's_hp'), true);
  assert.equal(on(res, 's_boiler'), true);
});

test('outdoor unknown for 35 min in alt mode at −8: latches hold, the boiler joins, the heat pump keeps running', () => {
  const run = h.runner(bivalentHouse('alt'));
  run.set('climate.heat_pump', 'off').set('switch.boiler_relay', 'off').set('switch.rad_pump', 'off');
  run.room('r_liv', { t: 19.5, demand: 'heat' });
  const t0 = run.st.now;
  run.outdoor(-8);
  let res = settle(run, t0 + 10 * SEC);
  assert.equal(on(res, 's_hp'), true);
  assert.equal(on(res, 's_boiler'), false);

  // the outdoor sensor and the weather fallback are gone from here on
  run.outdoor(null, { avgNC: null });
  const lost = run.st.now;
  res = run.runUntil(lost + 20 * MIN, MIN).at(-1);
  assert.equal(res.plant.bivalent.frostActive, false, 'the frost latch keeps its last state');
  assert.equal(on(res, 's_hp'), true);
  assert.equal(on(res, 's_boiler'), false, 'within 30 minutes the reserve waits');

  res = run.runUntil(lost + 36 * MIN, MIN).at(-1);
  assert.equal(on(res, 's_hp'), true, 'the heat pump is never switched off for missing data');
  assert.equal(on(res, 's_boiler'), true, 'after 30 minutes unknown the reserve may join');
});

test('neutral season: a radiator room 1° below its band calls central heat (18.7 ≤ 18.8), 19.0 does not', () => {
  const boiler = h.gasBoiler('s_boiler');
  const rad = h.circuit('c_rad', ['s_boiler']);
  const r = h.room('r_kids');
  const e = h.emitter('e_rad', 'r_kids', { circuitId: 'c_rad', roles: { heat: 'primary', cool: null } });
  const cfg = h.makeCfg({ rooms: [r], emitters: [e], sources: [boiler], circuits: [rad], heat: { chain: h.chain('s_boiler') } });

  const cold = h.runner(cfg, { season: h.season('neutral') });
  cold.set('switch.boiler_relay', 'off');
  cold.room('r_kids', { t: 18.7, demand: 'heat' });
  const res = cold.tick();
  assert.deepEqual(res.plant.circuits[0].requestingRoomIds, ['r_kids']);
  assert.equal(h.sourceState(res, 's_boiler').on, true);
  assert.ok(res.plant.why.some((w) => w.code === 'plant.neutral_guard'));

  const cool = h.runner(cfg, { season: h.season('neutral') });
  cool.set('switch.boiler_relay', 'off');
  cool.room('r_kids', { t: 19.0, demand: 'heat' });
  const res2 = cool.tick();
  assert.deepEqual(res2.plant.circuits[0].requestingRoomIds, []);
  assert.equal(h.sourceState(res2, 's_boiler').on, false);
  assert.equal(h.sourceState(res2, 's_boiler').state, 'waiting_season');
  assert.equal(h.verdictOf(res2, 'r_kids').waitReason.code, 'wait.season');

  // once it called, the room keeps calling until its latch lets go
  cold.room('r_kids', { t: 19.6, demand: 'heat' });
  const res3 = cold.tick();
  assert.deepEqual(res3.plant.circuits[0].requestingRoomIds, ['r_kids']);
});

test('neutral season: a room with its own heater does not start the central plant', () => {
  const boiler = h.gasBoiler('s_boiler');
  const conv = h.convector('s_conv', 'r_kids', 'switch.kids_heater');
  const rad = h.circuit('c_rad', ['s_boiler']);
  const r = h.room('r_kids');
  const e = h.emitter('e_rad', 'r_kids', { circuitId: 'c_rad', roles: { heat: 'primary', cool: null } });
  const ed = h.emitter('e_conv', 'r_kids', { kind: 'direct', sourceId: 's_conv', roles: { heat: 'primary', cool: null } });
  const cfg = h.makeCfg({ rooms: [r], emitters: [e, ed], sources: [boiler, conv], circuits: [rad], heat: { chain: h.chain('s_boiler') } });
  const run = h.runner(cfg, { season: h.season('neutral') });
  run.set('switch.boiler_relay', 'off').set('switch.kids_heater', 'off');
  run.room('r_kids', { t: 18.5, demand: 'heat' });
  const res = run.tick();
  assert.equal(h.sourceState(res, 's_boiler').on, false);
  assert.equal(h.sourceState(res, 's_conv').on, true);
});

test('heating cutoff: above +15 central heating stops for comfort, the cold guard still works', () => {
  const boiler = h.gasBoiler('s_boiler');
  const rad = h.circuit('c_rad', ['s_boiler']);
  const r = h.room('r_liv');
  const e = h.emitter('e_rad', 'r_liv', { circuitId: 'c_rad', roles: { heat: 'primary', cool: null } });
  const cfg = h.makeCfg({ rooms: [r], emitters: [e], sources: [boiler], circuits: [rad], heat: { chain: h.chain('s_boiler') } });
  const run = h.runner(cfg);
  run.set('switch.boiler_relay', 'off');
  run.outdoor(16);
  run.room('r_liv', { t: 19.7, demand: 'heat' });
  let res = run.tick();
  assert.equal(res.memory.plant.cutoff.on, true);
  assert.equal(h.sourceState(res, 's_boiler').on, false);
  assert.ok(h.sourceState(res, 's_boiler').blockers.some((b) => b.code === 'source.blocked.cutoff'));
  assert.ok(res.decisions.some((x) => x.code === 'cutoff.on'));

  run.room('r_liv', { t: 18.7, demand: 'heat' });
  res = run.tick();
  assert.equal(h.sourceState(res, 's_boiler').on, true, 'the cold guard lifts the cutoff');

  run.outdoor(14.5);
  res = run.tick();
  assert.equal(res.memory.plant.cutoff.on, true, 'the cutoff releases only at 14°');
  run.outdoor(14);
  res = run.tick();
  assert.equal(res.memory.plant.cutoff.on, false);
});

test('shared heat pump: heat ↔ cool changes direction at most every 3 h', () => {
  const hp = h.heatPump('s_hp');
  const floor = h.circuit('c_floor', ['s_hp'], { kind: 'floor', capabilities: { heat: true, cool: true } });
  const a = h.room('r_a');
  const ea = h.emitter('e_a', 'r_a', { kind: 'floor', circuitId: 'c_floor', roles: { heat: 'primary', cool: 'primary' } });
  const cfg = h.makeCfg({ rooms: [a], emitters: [ea], sources: [hp], circuits: [floor], heat: { chain: h.chain('s_hp') }, cool: { chain: h.chain('s_hp') } });
  const run = h.runner(cfg, { season: h.season('cooling') });
  const t0 = run.st.now;
  // it switched to heating an hour ago
  run.st.memory.sources.s_hp = { ...h.d.defaultSourceMemory('s_hp', t0), hpMode: 'heat', lastChangeoverAt: t0 - HOUR, offSince: t0 - 30 * MIN };
  run.set('climate.heat_pump', 'off');
  run.room('r_a', { t: 25.6, heatC: 20, coolC: 25, demand: 'cool', dew: 12 });
  let res = run.tick(t0);
  assert.equal(h.sourceState(res, 's_hp').on, false);
  const blocker = h.sourceState(res, 's_hp').blockers.find((b) => b.code === 'source.blocked.changeover');
  assert.equal(blocker.params.until, t0 + 2 * HOUR);
  assert.equal(h.verdictOf(res, 'r_a').waitReason.code, 'wait.changeover');
  assert.ok(h.decisionCodes(res).includes('source.changeover_blocked'));
  res = run.tick();
  assert.ok(!h.decisionCodes(res).includes('source.changeover_blocked'), 'journalled once');

  res = run.runUntil(t0 + 2 * HOUR + MIN, MIN).at(-1);
  assert.equal(h.sourceState(res, 's_hp').on, true);
  assert.equal(h.sourceState(res, 's_hp').mode, 'cool');
  assert.equal(res.memory.sources.s_hp.hpMode, 'cool');
  assert.ok(res.memory.sources.s_hp.lastChangeoverAt >= t0 + 2 * HOUR);
});

test('frost takes a shared heat pump even when it last cooled and the house mode is «cool»', () => {
  const hp = h.heatPump('s_hp');
  const floor = h.circuit('c_floor', ['s_hp'], { kind: 'floor', capabilities: { heat: true, cool: true } });
  const r = h.room('r_a');
  const e = h.emitter('e_a', 'r_a', { kind: 'floor', circuitId: 'c_floor', roles: { heat: 'primary', cool: 'primary' } });
  const cfg = h.makeCfg({ rooms: [r], emitters: [e], sources: [hp], circuits: [floor], heat: { chain: h.chain('s_hp') }, cool: { chain: h.chain('s_hp') }, house: { mode: 'cool' } });
  const run = h.runner(cfg, { season: h.season('cooling', 'cool') });
  const t0 = run.st.now;
  run.st.memory.sources.s_hp = { ...h.d.defaultSourceMemory('s_hp', t0), hpMode: 'cool', lastChangeoverAt: t0 - 10 * MIN, offSince: t0 - 30 * MIN };
  run.set('climate.heat_pump', 'off');
  run.room('r_a', { t: 6.8, heatC: null, coolC: 25, frost: true });
  const res = run.tick();
  assert.equal(h.sourceState(res, 's_hp').on, true);
  assert.equal(h.sourceState(res, 's_hp').mode, 'heat');
});
