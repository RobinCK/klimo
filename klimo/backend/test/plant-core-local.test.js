const assert = require('node:assert/strict');
const test = require('node:test');
const h = require('./plant-core-harness');

const { MIN, SEC, kyiv } = h;

function acRoom(acOver = {}, roomOver = {}, emitterOver = {}) {
  const ac = h.acUnit('s_ac', 'r_bed', 'climate.bedroom_ac', acOver);
  const r = h.room('r_bed', roomOver);
  const e = h.emitter('e_ac', 'r_bed', { kind: 'direct', sourceId: 's_ac', roles: { heat: 'primary', cool: 'primary' }, ...emitterOver });
  return h.makeCfg({ rooms: [r], emitters: [e], sources: [ac], cool: { chain: h.chain(['s_ac']) } });
}

const acAttrs = { fan_modes: ['auto', 'low', 'medium', 'high', 'quiet'], min_temp: 16, max_temp: 30, target_temp_step: 0.5, current_temperature: 26 };

test('AC «ціль кімнати»: cooling at the room target corrected by the learned offset, moved at most 1° per 5 minutes', () => {
  const run = h.runner(acRoom(), { season: h.season('cooling'), start: kyiv(2026, 7, 10, 15, 0) });
  run.set('climate.bedroom_ac', 'off', { attrs: acAttrs });
  run.room('r_bed', { t: 26.2, heatC: 20, coolC: 25, demand: 'cool', memory: { learned: { ...h.d.defaultRoomMemory('r_bed', 0).learned, acOffsetC: { s_ac: { value: 2.3, minutes: 120 } } } } });
  let res = run.tick();
  const d0 = h.desiredOf(res, 'climate.bedroom_ac');
  assert.equal(d0.value.hvacMode, 'cool');
  assert.equal(d0.value.temperature, 27.5, '25 + 2.3 → step 0.5');
  assert.equal(d0.value.fanMode, 'auto');
  assert.equal(d0.userSetpointAttr, 'temperature');
  assert.equal(d0.owner.type, 'local');
  assert.deepEqual(res.memory.rooms.r_bed.acSetpoint.s_ac.valueC, 2.3);
  assert.equal(h.verdictOf(res, 'r_bed').served, true);

  // the learned offset jumps to 0.3: the correction walks down 1° per 5 minutes
  run.room('r_bed', { t: 26.2, heatC: 20, coolC: 25, demand: 'cool', memory: { learned: { ...h.d.defaultRoomMemory('r_bed', 0).learned, acOffsetC: { s_ac: { value: 0.3, minutes: 200 } } } } });
  res = run.tick(run.st.now + 2 * MIN);
  assert.equal(h.desiredOf(res, 'climate.bedroom_ac').value.temperature, 27.5);
  res = run.tick(run.st.now + 3 * MIN);
  assert.equal(h.desiredOf(res, 'climate.bedroom_ac').value.temperature, 26.5);
  // a target change applies at once
  run.room('r_bed', { t: 26.2, heatC: 20, coolC: 24, demand: 'cool', memory: { learned: { ...h.d.defaultRoomMemory('r_bed', 0).learned, acOffsetC: { s_ac: { value: 0.3, minutes: 200 } } } } });
  res = run.tick();
  assert.equal(h.desiredOf(res, 'climate.bedroom_ac').value.temperature, 25.5);
});

test('AC at night: the quietest fan mode it offers', () => {
  const run = h.runner(acRoom(), { season: h.season('cooling'), start: kyiv(2026, 7, 10, 23, 30) });
  run.set('climate.bedroom_ac', 'off', { attrs: acAttrs });
  run.room('r_bed', { t: 26.2, heatC: 20, coolC: 25, demand: 'cool' });
  const res = run.tick();
  assert.equal(h.desiredOf(res, 'climate.bedroom_ac').value.fanMode, 'quiet');
});

test('AC «вкл/викл»: fixed setpoints by Klimo\'s latch; «як є»: the room target whenever the mode allows', () => {
  const base = h.d.DEFAULT_ROOM();
  const onoff = h.runner(acRoom({}, { ac: { ...base.ac, control: 'onoff' } }), { season: h.season('cooling') });
  onoff.set('climate.bedroom_ac', 'off', { attrs: acAttrs });
  onoff.room('r_bed', { t: 26.2, heatC: 20, coolC: 25, demand: 'cool' });
  assert.equal(h.desiredOf(onoff.tick(), 'climate.bedroom_ac').value.temperature, 22);

  const asis = h.runner(acRoom({}, { ac: { ...base.ac, control: 'asis' } }), { season: h.season('cooling') });
  asis.set('climate.bedroom_ac', 'off', { attrs: acAttrs });
  asis.room('r_bed', { t: 24.5, heatC: null, coolC: 25, demand: 'none' });
  const res = asis.tick();
  assert.equal(h.sourceState(res, 's_ac').on, true, 'runs in the allowed mode without a latch');
  assert.equal(h.desiredOf(res, 'climate.bedroom_ac').value.temperature, 25);
  asis.room('r_bed', { t: 24.5, heatC: null, coolC: 25, demand: 'none', paused: true });
  assert.equal(h.sourceState(asis.runUntil(asis.st.now + 6 * MIN).at(-1), 's_ac').on, false, 'off for an open window');
});

test('AC dries instead of cooling when humid inside the band; cool ↔ dry switches directly', () => {
  const run = h.runner(acRoom(), { season: h.season('cooling') });
  run.set('climate.bedroom_ac', 'off', { attrs: acAttrs });
  run.room('r_bed', { t: 25.1, heatC: 20, coolC: 25, demand: 'none', dry: true, rh: 66 });
  let res = run.tick();
  assert.equal(h.sourceState(res, 's_ac').mode, 'dry');
  assert.equal(h.sourceState(res, 's_ac').state, 'starting');
  assert.equal(h.desiredOf(res, 'climate.bedroom_ac').value.hvacMode, 'dry');
  assert.deepEqual(h.verdictOf(res, 'r_bed').servingSourceIds, ['s_ac']);
  run.room('r_bed', { t: 25.4, heatC: 20, coolC: 25, demand: 'cool', rh: 66 });
  res = run.tick();
  assert.equal(h.sourceState(res, 's_ac').mode, 'cool');
  assert.ok(!res.edges.some((e) => e.id === 's_ac'), 'no stop and start between dry and cool');
});

test('AC heating is blocked below −5 outdoors (released at −4); frost still takes it', () => {
  const run = h.runner(acRoom({}, {}, { roles: { heat: 'primary', cool: 'primary' } }));
  run.set('climate.bedroom_ac', 'off', { attrs: acAttrs });
  run.outdoor(-8);
  run.room('r_bed', { t: 19.5, demand: 'heat' });
  let res = run.tick();
  assert.equal(h.sourceState(res, 's_ac').on, false);
  assert.ok(h.sourceState(res, 's_ac').blockers.some((b) => b.code === 'source.blocked.outdoor_limit'));
  assert.equal(h.verdictOf(res, 'r_bed').waitReason.code, 'wait.condition');
  run.outdoor(-4.5);
  res = run.tick();
  assert.equal(h.sourceState(res, 's_ac').on, false, 'hysteresis: still blocked at −4.5');
  run.outdoor(-8);
  run.room('r_bed', { t: 6.8, frost: true });
  res = run.tick();
  assert.equal(h.sourceState(res, 's_ac').on, true, 'frost hands the room to the AC anyway');
  assert.ok(h.decisionCodes(res).includes('frost.fallback'));
  assert.equal(h.activeDetections(res, 'frost_risk')[0].dedupKey, 'frost_risk:fallback:s_ac');
});

test('a room heater stops at once when the room overheats or reaches its hard limit', () => {
  const conv = h.convector('s_conv', 'r_study', 'switch.study_heater');
  const r = h.room('r_study');
  const e = h.emitter('e_conv', 'r_study', { kind: 'direct', sourceId: 's_conv', roles: { heat: 'primary', cool: null } });
  const cfg = h.makeCfg({ rooms: [r], emitters: [e], sources: [conv] });
  const run = h.runner(cfg);
  run.set('switch.study_heater', 'off');
  run.room('r_study', { t: 19.7, demand: 'heat' });
  run.tick();
  run.room('r_study', { t: 26.1, heatC: 28, demand: 'heat' });
  let res = run.tick();
  assert.equal(h.sourceState(res, 's_conv').on, false, 'the 26° room limit cuts the heater, min run or not');
  assert.equal(h.desiredOf(res, 'switch.study_heater').urgency, 'safety');

  const run2 = h.runner(cfg);
  run2.set('switch.study_heater', 'off');
  run2.room('r_study', { t: 19.7, demand: 'heat' });
  run2.tick();
  run2.room('r_study', { t: 25.9, heatC: 25, demand: 'heat', overheat: true });
  res = run2.tick();
  assert.equal(h.sourceState(res, 's_conv').on, false);
});

test('an AC on assist heats only when the room asks with its assist role', () => {
  const boiler = h.gasBoiler('s_boiler');
  const rad = h.circuit('c_rad', ['s_boiler']);
  const ac = h.acUnit('s_ac', 'r_liv', 'climate.living_ac');
  const r = h.room('r_liv');
  const er = h.emitter('e_rad', 'r_liv', { circuitId: 'c_rad', roles: { heat: 'primary', cool: null }, order: 0 });
  const ea = h.emitter('e_ac', 'r_liv', { kind: 'direct', sourceId: 's_ac', roles: { heat: 'assist', cool: 'primary' }, assist: { deficitC: 1.5 }, order: 1 });
  const cfg = h.makeCfg({ rooms: [r], emitters: [er, ea], sources: [boiler, ac], circuits: [rad], heat: { chain: h.chain('s_boiler') } });
  const run = h.runner(cfg);
  run.set('switch.boiler_relay', 'off').set('climate.living_ac', 'off', { attrs: acAttrs });
  run.room('r_liv', { t: 19.7, demand: 'heat' });
  let res = run.tick();
  assert.equal(h.sourceState(res, 's_boiler').on, true);
  assert.equal(h.sourceState(res, 's_ac').on, false, 'radiators heat; the AC stands by');
  assert.equal(h.sourceState(res, 's_ac').role, 'assist');
  run.room('r_liv', { t: 18.2, demand: 'heat', requests: { e_rad: 'heat', e_ac: 'heat' } });
  res = run.tick();
  assert.equal(h.sourceState(res, 's_ac').on, true);
  assert.equal(h.sourceState(res, 's_ac').role, 'assist');
  assert.deepEqual(h.verdictOf(res, 'r_liv').servingSourceIds.sort(), ['s_ac', 's_boiler']);
});

test('frost in house mode off: 6.8° asks for heat and the boiler runs; without an eligible source frost falls back', () => {
  const boiler = h.gasBoiler('s_boiler');
  const rad = h.circuit('c_rad', ['s_boiler']);
  const r = h.room('r_liv');
  const e = h.emitter('e_rad', 'r_liv', { circuitId: 'c_rad', roles: { heat: 'primary', cool: null } });
  const cfg = h.makeCfg({ rooms: [r], emitters: [e], sources: [boiler], circuits: [rad], heat: { chain: h.chain('s_boiler') }, house: { mode: 'off' } });
  const run = h.runner(cfg, { season: h.season('heating', 'off') });
  run.set('switch.boiler_relay', 'off');
  run.room('r_liv', { t: 6.8, heatC: null, frost: true });
  let res = run.tick();
  assert.equal(h.sourceState(res, 's_boiler').on, true, 'frost ignores the house mode');
  assert.equal(h.verdictOf(res, 'r_liv').served, true);
  assert.equal(h.verdictOf(res, 'r_liv').emitterOpen.e_rad, true);

  // the only heat source is a trigger-only convector whose trigger is off: frost takes it regardless
  const conv = h.convector('s_conv', 'r_study', 'switch.study_heater', { conditions: { join: 'all', items: [{ id: 'ci_solar', mode: null, enabled: true, node: { op: 'trigger', triggerId: 'solar' } }] } });
  const rs = h.room('r_study');
  const es = h.emitter('e_conv', 'r_study', { kind: 'direct', sourceId: 's_conv', roles: { heat: 'trigger', cool: null }, trigger: { heatStoreAboveTargetC: 1.5 } });
  const cfg2 = h.makeCfg({ rooms: [rs], emitters: [es], sources: [conv], house: { mode: 'off' } });
  const solarOff = [{ triggerId: 'solar', active: false, enabled: true, since: null, status: 'ok', value: null, live: { code: 'trigger.live.inactive', params: {} }, nextChangeAt: null, eval: { id: '$', met: false, status: 'ok' }, usedBy: [] }];
  const run2 = h.runner(cfg2, { season: h.season('heating', 'off'), triggers: solarOff });
  run2.set('switch.study_heater', 'off');
  run2.room('r_study', { t: 21, heatC: null, demand: 'none' });
  res = run2.tick();
  assert.equal(h.sourceState(res, 's_conv').state, 'waiting_trigger');
  run2.room('r_study', { t: 6.8, heatC: null, frost: true });
  res = run2.tick();
  assert.equal(h.sourceState(res, 's_conv').on, true);
});
