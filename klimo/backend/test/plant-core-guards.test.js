const assert = require('node:assert/strict');
const test = require('node:test');
const h = require('./plant-core-harness');

const { MIN, SEC, kyiv } = h;

/** A boiler on a radiator circuit without pumps (no pre-run), one radiator room. */
function boilerHouse(boilerOver = {}) {
  const boiler = h.gasBoiler('s_boiler', boilerOver);
  const rad = h.circuit('c_rad', ['s_boiler']);
  const r = h.room('r_liv');
  const e = h.emitter('e_rad', 'r_liv', { circuitId: 'c_rad', roles: { heat: 'primary', cool: null } });
  return h.makeCfg({ rooms: [r], emitters: [e], sources: [boiler], circuits: [rad], heat: { chain: h.chain('s_boiler') } });
}

/** Heat pump leading, boiler in reserve, a source-rule pump that already runs (no pre-run wait). */
function hpBoilerHouse() {
  const hp = h.heatPump('s_hp');
  const boiler = h.gasBoiler('s_boiler');
  const rad = h.circuit('c_rad', ['s_hp', 's_boiler']);
  const p = h.pump('p_rad', 'c_rad', 'switch.rad_pump', { rule: 'source' });
  const r = h.room('r_liv');
  const e = h.emitter('e_rad', 'r_liv', { circuitId: 'c_rad', roles: { heat: 'primary', cool: null } });
  return h.makeCfg({ rooms: [r], emitters: [e], sources: [hp, boiler], circuits: [rad], pumps: [p], heat: { chain: h.chain('s_hp', 's_boiler') } });
}

function pumpRunning(run, id, since) {
  run.st.memory.pumps[id] = { ...h.d.defaultPumpMemory(id, since), on: true, onSince: since, reason: 'source', condSince: since };
}

test('a boiler stopped at 19:00 and asked again at 19:02 waits for its minimum pause until 19:05', () => {
  const t1900 = kyiv(2026, 10, 21, 19, 0);
  const run = h.runner(boilerHouse(), { start: t1900 });
  run.st.memory.sources.s_boiler = { ...h.d.defaultSourceMemory('s_boiler', t1900), offSince: t1900, mode: 'heat' };
  run.set('switch.boiler_relay', 'off');
  run.room('r_liv', { t: 19.7, demand: 'heat' });
  let res = run.tick(t1900 + 2 * MIN);
  const st = h.sourceState(res, 's_boiler');
  assert.equal(st.on, false);
  assert.equal(st.state, 'waiting_guard');
  assert.deepEqual(st.blockers[0], { code: 'source.blocked.min_off', params: { until: t1900 + 5 * MIN } });
  assert.deepEqual(h.verdictOf(res, 'r_liv').waitReason, { code: 'wait.min_off', params: { sourceId: 's_boiler', until: t1900 + 5 * MIN } });
  assert.equal(res.nextWakeAt, t1900 + 5 * MIN);

  res = run.tick(t1900 + 4 * MIN + 50 * SEC);
  assert.equal(h.sourceState(res, 's_boiler').on, false);
  res = run.tick(t1900 + 5 * MIN);
  assert.equal(h.sourceState(res, 's_boiler').on, true);
  assert.deepEqual(res.edges, [{ type: 'source', id: 's_boiler', on: true }]);
  assert.ok(h.decisionCodes(res).includes('source.start'));
});

test('six starts within the hour block the seventh until the oldest is an hour old', () => {
  const now = kyiv(2026, 10, 21, 19, 0);
  const run = h.runner(boilerHouse(), { start: now });
  const starts = [50, 45, 40, 30, 20, 10].map((m) => now - m * MIN);
  run.st.memory.sources.s_boiler = { ...h.d.defaultSourceMemory('s_boiler', now), offSince: now - 6 * MIN, starts };
  run.set('switch.boiler_relay', 'off');
  run.room('r_liv', { t: 19.7, demand: 'heat' });
  let res = run.tick(now);
  const b = h.sourceState(res, 's_boiler').blockers.find((x) => x.code === 'source.blocked.max_starts');
  assert.deepEqual(b.params, { until: now + 10 * MIN, n: 6 });
  assert.equal(h.verdictOf(res, 'r_liv').waitReason.code, 'wait.max_starts');
  res = run.tick(now + 10 * MIN);
  assert.equal(h.sourceState(res, 's_boiler').on, true);
});

test('a boiler started at 19:04 whose demand ends at 19:06 is held until 19:09, with its pumps', () => {
  const t1904 = kyiv(2026, 10, 21, 19, 4);
  const boiler = h.gasBoiler('s_boiler');
  const rad = h.circuit('c_rad', ['s_boiler']);
  const p = h.pump('p_rad', 'c_rad', 'switch.rad_pump', { rule: 'rooms', runOnHeatMin: 0 });
  const r = h.room('r_liv');
  const e = h.emitter('e_rad', 'r_liv', { circuitId: 'c_rad', roles: { heat: 'primary', cool: null } });
  const cfg = h.makeCfg({ rooms: [r], emitters: [e], sources: [boiler], circuits: [rad], pumps: [p], heat: { chain: h.chain('s_boiler') } });
  const run = h.runner(cfg, { start: t1904 - MIN });
  pumpRunning(run, 'p_rad', t1904 - MIN);
  run.set('switch.boiler_relay', 'off').set('switch.rad_pump', 'on');
  run.room('r_liv', { t: 19.7, demand: 'heat' });
  let res = run.tick(t1904);
  assert.equal(h.sourceState(res, 's_boiler').on, true);

  run.room('r_liv', { t: 20.3, demand: 'none' });
  res = run.runUntil(t1904 + 2 * MIN).at(-1);
  const st = h.sourceState(res, 's_boiler');
  assert.equal(st.on, true, 'held by its minimum run');
  assert.equal(st.state, 'stopping');
  assert.deepEqual(st.blockers[0], { code: 'source.blocked.min_run', params: { until: t1904 + 5 * MIN } });
  const ps = h.pumpState(res, 'p_rad');
  assert.equal(ps.on, true);
  assert.equal(ps.reason, 'source_hold', 'never dead-head a running boiler');

  res = run.runUntil(t1904 + 5 * MIN).at(-1);
  assert.equal(h.sourceState(res, 's_boiler').on, false);
  assert.ok(res.decisions.some((x) => x.code === 'source.stop' && x.params.reason === 'no_demand'));
});

test('a heat pump that does not take its mode within 5 minutes faults and the boiler starts on the same tick', () => {
  const t1904 = kyiv(2026, 10, 21, 19, 4);
  const run = h.runner(hpBoilerHouse(), { start: t1904 - MIN });
  pumpRunning(run, 'p_rad', t1904 - 10 * MIN);
  run.st.deaf = new Set(['climate.heat_pump']); // the command never reaches the unit: it stays off
  run.set('climate.heat_pump', 'off').set('switch.boiler_relay', 'off').set('switch.rad_pump', 'on');
  run.room('r_liv', { t: 19.7, demand: 'heat' });
  let res = run.tick(t1904);
  assert.equal(h.sourceState(res, 's_hp').on, true);
  assert.equal(h.sourceState(res, 's_hp').state, 'starting');

  res = run.runUntil(t1904 + 5 * MIN - 10 * SEC).at(-1);
  assert.equal(h.sourceState(res, 's_hp').on, true, 'still within its confirmation time');

  res = run.tick(t1904 + 5 * MIN);
  assert.equal(h.sourceState(res, 's_hp').on, false);
  assert.equal(h.sourceState(res, 's_hp').state, 'fault');
  assert.equal(res.memory.sources.s_hp.fault.code, 'no_confirm');
  assert.equal(res.memory.sources.s_hp.fault.retryAt, t1904 + 20 * MIN);
  assert.equal(h.sourceState(res, 's_boiler').on, true, 'failover on the same tick');
  assert.deepEqual(res.edges.filter((e) => e.type === 'source'), [
    { type: 'source', id: 's_hp', on: false },
    { type: 'source', id: 's_boiler', on: true },
  ]);
  assert.equal(h.activeDetections(res, 'source_failed')[0].sourceId, 's_hp');
  assert.equal(h.activeDetections(res, 'source_fallback').length, 1);
  assert.ok(res.decisions.some((x) => x.code === 'source.failover' && x.params.from === 's_hp' && x.params.to === 's_boiler'));
  assert.equal(h.desiredOf(res, 'climate.heat_pump').urgency, 'safety');
  assert.equal(h.desiredOf(res, 'climate.heat_pump').value.hvacMode, 'off');
});

test('a running heat pump unavailable for 5 seconds neither faults nor fails over', () => {
  const run = h.runner(hpBoilerHouse());
  pumpRunning(run, 'p_rad', run.st.now - 10 * MIN);
  run.set('climate.heat_pump', 'off').set('switch.boiler_relay', 'off').set('switch.rad_pump', 'on');
  run.room('r_liv', { t: 19.7, demand: 'heat' });
  run.runUntil(run.st.now + MIN);
  run.set('climate.heat_pump', 'unavailable');
  run.st.obey = false;
  let res = run.tick(run.st.now + 5 * SEC);
  assert.equal(h.sourceState(res, 's_hp').on, true, 'stays logically on');
  assert.equal(res.memory.sources.s_hp.fault, null);
  assert.equal(h.sourceState(res, 's_boiler').on, false);
  run.set('climate.heat_pump', 'heat', { attrs: { hvac_action: 'heating' } });
  res = run.tick();
  assert.equal(res.memory.sources.s_hp.unavailableSince, null);
  assert.equal(h.sourceState(res, 's_boiler').on, false);
  assert.equal(h.activeDetections(res, 'source_unavailable').length, 0);
});

test('a running heat pump unavailable for 3 minutes faults as unavailable and the boiler takes over', () => {
  const run = h.runner(hpBoilerHouse());
  pumpRunning(run, 'p_rad', run.st.now - 10 * MIN);
  run.set('climate.heat_pump', 'off').set('switch.boiler_relay', 'off').set('switch.rad_pump', 'on');
  run.room('r_liv', { t: 19.7, demand: 'heat' });
  run.runUntil(run.st.now + MIN);
  run.set('climate.heat_pump', 'unavailable');
  const lost = run.st.now + 10 * SEC;
  let res = run.runUntil(lost + 3 * MIN - 10 * SEC).at(-1);
  assert.equal(h.sourceState(res, 's_hp').on, true);
  assert.equal(h.sourceState(res, 's_boiler').on, false, 'no failover before the debounce');
  assert.equal(h.verdictOf(res, 'r_liv').served, true);

  res = run.runUntil(lost + 3 * MIN).at(-1);
  assert.equal(res.memory.sources.s_hp.fault.code, 'unavailable');
  assert.equal(h.sourceState(res, 's_hp').state, 'unavailable');
  assert.equal(h.sourceState(res, 's_boiler').on, true);
  assert.equal(h.activeDetections(res, 'source_unavailable').length, 1);
  assert.equal(h.activeDetections(res, 'source_failed').length, 0);

  // back for two minutes: the fault clears and the heat pump leads again (the boiler keeps its min run)
  run.set('climate.heat_pump', 'off');
  res = run.runUntil(run.st.now + 2 * MIN + 10 * SEC).at(-1);
  assert.equal(res.memory.sources.s_hp.fault, null);
  assert.ok(res.detections.some((x) => x.kind === 'source_recovered'));
  res = run.runUntil(run.st.now + 6 * MIN).at(-1);
  assert.equal(h.sourceState(res, 's_hp').on, true);
  assert.equal(h.sourceState(res, 's_boiler').on, false);
});

test('a boiler needing flow: the flow-safety pump starts at 10:00:00, the boiler at 10:00:20', () => {
  const t10 = kyiv(2026, 10, 21, 10, 0);
  const boiler = h.gasBoiler('s_boiler');
  const rad = h.circuit('c_rad', ['s_boiler']);
  const floor = h.circuit('c_floor', ['s_boiler'], { kind: 'floor', flowSafety: true, order: 1 });
  const pr = h.pump('p_rad', 'c_rad', 'switch.rad_pump', { rule: 'rooms' });
  const pf = h.pump('p_floor', 'c_floor', 'switch.floor_pump', { rule: 'rooms' });
  const r = h.room('r_liv');
  const e = h.emitter('e_rad', 'r_liv', { circuitId: 'c_rad', roles: { heat: 'primary', cool: null } });
  const cfg = h.makeCfg({ rooms: [r], emitters: [e], sources: [boiler], circuits: [rad, floor], pumps: [pr, pf], heat: { chain: h.chain('s_boiler') } });
  const run = h.runner(cfg, { start: t10 - 10 * SEC });
  run.set('switch.boiler_relay', 'off').set('switch.rad_pump', 'off').set('switch.floor_pump', 'off');
  run.room('r_liv', { t: 19.7, demand: 'heat' });
  let res = run.tick(t10);
  assert.equal(h.sourceState(res, 's_boiler').on, false);
  assert.equal(h.pumpState(res, 'p_floor').on, true);
  assert.equal(h.pumpState(res, 'p_floor').reason, 'prerun');
  assert.equal(h.pumpState(res, 'p_rad').on, false);
  assert.deepEqual(h.verdictOf(res, 'r_liv').waitReason, { code: 'wait.prerun', params: { sourceId: 's_boiler', until: t10 + 20 * SEC } });
  assert.equal(res.nextWakeAt, t10 + 20 * SEC);

  res = run.tick(t10 + 10 * SEC);
  assert.equal(h.sourceState(res, 's_boiler').on, false);
  res = run.tick(t10 + 20 * SEC);
  assert.equal(h.sourceState(res, 's_boiler').on, true);
  assert.equal(h.pumpState(res, 'p_rad').on, true, 'the radiator pump follows the open radiators');
});

test('a check run starts the source regardless of demand, reports the confirmation and stops at its end', () => {
  const run = h.runner(boilerHouse({ adapter: { command: 'switch.boiler_relay', confirm: { kind: 'entity_on', entityId: 'binary_sensor.boiler_flame' } } }));
  const t0 = run.st.now;
  run.set('switch.boiler_relay', 'off').set('binary_sensor.boiler_flame', 'off');
  run.room('r_liv', { t: 21, demand: 'none' });
  run.st.memory.sources.s_boiler = { ...h.d.defaultSourceMemory('s_boiler', t0), test: { mode: 'heat', startedAt: t0, until: t0 + 2 * MIN, result: 'running', confirmAfterSec: null } };
  let res = run.tick(t0 + SEC);
  assert.equal(h.sourceState(res, 's_boiler').on, true);
  assert.equal(h.sourceState(res, 's_boiler').state, 'testing');
  run.set('binary_sensor.boiler_flame', 'on');
  res = run.tick(t0 + 41 * SEC);
  assert.equal(res.memory.sources.s_boiler.test.result, 'ok');
  assert.equal(res.memory.sources.s_boiler.test.confirmAfterSec, 40);
  res = run.runUntil(t0 + 2 * MIN).at(-1);
  assert.equal(h.sourceState(res, 's_boiler').on, false, 'the end of a check run stops at once');
  assert.ok(res.decisions.some((x) => x.code === 'source.test' && x.params.result === 'ok'));
  assert.equal(h.activeDetections(res, 'source_failed').length, 0);
});

test('a check run that gets no confirmation reports no_confirm and raises no fault', () => {
  const run = h.runner(boilerHouse({ adapter: { command: 'switch.boiler_relay', confirm: { kind: 'entity_on', entityId: 'binary_sensor.boiler_flame' } } }));
  const t0 = run.st.now;
  run.set('switch.boiler_relay', 'off').set('binary_sensor.boiler_flame', 'off');
  run.room('r_liv', { t: 21, demand: 'none' });
  run.st.memory.sources.s_boiler = { ...h.d.defaultSourceMemory('s_boiler', t0), test: { mode: 'heat', startedAt: t0, until: t0 + 5 * MIN, result: 'running', confirmAfterSec: null } };
  const res = run.runUntil(t0 + 4 * MIN).at(-1);
  assert.equal(res.memory.sources.s_boiler.test.result, 'no_confirm');
  assert.equal(res.memory.sources.s_boiler.fault, null);
  assert.equal(h.sourceState(res, 's_boiler').on, false);
});

test('a check run during the minimum pause is reported blocked', () => {
  const run = h.runner(boilerHouse());
  const t0 = run.st.now;
  run.set('switch.boiler_relay', 'off');
  run.room('r_liv', { t: 21, demand: 'none' });
  run.st.memory.sources.s_boiler = { ...h.d.defaultSourceMemory('s_boiler', t0), offSince: t0 - MIN, test: { mode: 'heat', startedAt: t0, until: t0 + 2 * MIN, result: 'running', confirmAfterSec: null } };
  const res = run.tick(t0 + SEC);
  assert.equal(res.memory.sources.s_boiler.test.result, 'blocked');
  assert.ok(res.decisions.some((x) => x.code === 'source.test' && x.params.result === 'blocked'));
});

test('«вимкнути на час»: a locked source is skipped; frost may still use it as the last resort', () => {
  const now = h.WED_1900;
  const lock = { id: 'o1', scope: 'source', subjectId: 's_boiler', kind: 'source_off', group: 'source_lock', value: { kind: 'source_off', reason: null }, duration: '1h', createdAt: now, until: now + 60 * MIN, by: { via: 'ui', userId: null, userName: null, contextId: null }, previous: null, revertToken: null, revertUntil: null, reqId: null };
  const cfg = boilerHouse();
  cfg.overrides = [lock];
  const run = h.runner(cfg);
  run.set('switch.boiler_relay', 'off');
  run.room('r_liv', { t: 19.7, demand: 'heat' });
  let res = run.tick();
  assert.equal(h.sourceState(res, 's_boiler').on, false);
  assert.equal(h.sourceState(res, 's_boiler').state, 'disabled');
  assert.equal(h.verdictOf(res, 'r_liv').waitReason.code, 'wait.lock');

  run.room('r_liv', { t: 6.8, frost: true });
  res = run.tick();
  assert.equal(h.sourceState(res, 's_boiler').on, true, 'frost protection takes even a locked source');
  assert.ok(h.decisionCodes(res).includes('frost.fallback'));
});

test('a forced source runs without demand; its lock expiry is journalled', () => {
  const now = h.WED_1900;
  const force = { id: 'o2', scope: 'source', subjectId: 's_boiler', kind: 'source_force', group: 'source_lock', value: { kind: 'source_force', mode: 'heat' }, duration: '1h', createdAt: now, until: now + 30 * SEC, by: { via: 'ui', userId: null, userName: null, contextId: null }, previous: null, revertToken: null, revertUntil: null, reqId: null };
  const cfg = boilerHouse();
  cfg.overrides = [force];
  const run = h.runner(cfg);
  run.set('switch.boiler_relay', 'off');
  run.room('r_liv', { t: 21, demand: 'none' });
  let res = run.tick();
  assert.equal(h.sourceState(res, 's_boiler').on, true);
  assert.equal(h.sourceState(res, 's_boiler').detail.code, 'source.detail.forced');
  res = run.tick(now + 30 * SEC);
  assert.ok(h.decisionCodes(res).includes('source.lock_expired'));
});

test('a relay the reconciler could not switch, with no foreign writer, is a relay mismatch fault', () => {
  const run = h.runner(boilerHouse());
  run.set('switch.boiler_relay', 'off');
  run.room('r_liv', { t: 19.7, demand: 'heat' });
  run.tick();
  run.st.obey = false;
  run.set('switch.boiler_relay', 'off');
  run.st.ledger['switch.boiler_relay'] = {
    key: 'switch.boiler_relay', entityId: 'switch.boiler_relay', kind: 'switch', desired: { kind: 'switch', on: true }, commanded: { kind: 'switch', on: true },
    commandId: 'c1', reqId: null, commandedAt: run.st.now, attempts: 3, status: 'failed', confirmedAt: null, nextAttemptAt: null, lastError: null, contextIds: [], conflicts: [], backoffUntil: null, updatedAt: run.st.now,
  };
  const res = run.tick();
  assert.equal(res.memory.sources.s_boiler.fault.code, 'relay_mismatch');
  const keys = h.activeDetections(res, 'source_failed').map((x) => x.dedupKey).sort();
  // the only heat source is gone: the house is told that nothing can heat
  assert.deepEqual(keys, ['source_failed:none_eligible:heat:c_rad', 'source_failed:s_boiler']);
});

test('a heater still drawing power two minutes after its stop is reported and re-commanded', () => {
  const conv = h.convector('s_conv', 'r_study', 'switch.study_heater', { adapter: { confirm: { kind: 'power_above', entityId: 'sensor.study_heater_power', thresholdW: 50 } } });
  const r = h.room('r_study');
  const e = h.emitter('e_conv', 'r_study', { kind: 'direct', sourceId: 's_conv', roles: { heat: 'primary', cool: null } });
  const cfg = h.makeCfg({ rooms: [r], emitters: [e], sources: [conv] });
  const run = h.runner(cfg);
  run.set('switch.study_heater', 'off').set('sensor.study_heater_power', '1500', { attrs: { unit_of_measurement: 'W' } });
  run.room('r_study', { t: 19.7, demand: 'heat' });
  run.runUntil(run.st.now + 3 * MIN);
  run.room('r_study', { t: 20.3, demand: 'none' });
  const stop = run.st.now + 10 * SEC;
  let res = run.tick(stop);
  assert.equal(h.sourceState(res, 's_conv').on, false);
  res = run.runUntil(stop + 2 * MIN).at(-1);
  const det = res.detections.find((x) => x.dedupKey === 'source_failed:s_conv:not_turned_off');
  assert.equal(det.active, true);
  assert.equal(h.desiredOf(res, 'switch.study_heater').refreshEverySec, 60);
  assert.equal(h.desiredOf(res, 'switch.study_heater').urgency, 'safety');
});

test('while Klimo is blind its confirmation clock stands still', () => {
  const run = h.runner(hpBoilerHouse());
  pumpRunning(run, 'p_rad', run.st.now - 10 * MIN);
  run.st.deaf = new Set(['climate.heat_pump']);
  run.set('climate.heat_pump', 'off').set('switch.boiler_relay', 'off').set('switch.rad_pump', 'on');
  run.room('r_liv', { t: 19.7, demand: 'heat' });
  const t0 = run.st.now + 10 * SEC;
  let res = run.tick(t0);
  assert.equal(res.memory.sources.s_hp.confirmDeadline, t0 + 5 * MIN);
  run.st.blind = true;
  res = run.runUntil(t0 + 20 * MIN, MIN).at(-1);
  assert.equal(res.memory.sources.s_hp.fault, null, 'no fault while HA cannot be seen');
  assert.equal(h.sourceState(res, 's_hp').on, true);
  run.st.blind = false;
  res = run.runUntil(t0 + 23 * MIN, MIN).at(-1);
  assert.equal(res.memory.sources.s_hp.fault, null, 'the deadline moved by the blind time');
  res = run.runUntil(t0 + 26 * MIN, MIN).at(-1);
  assert.equal(res.memory.sources.s_hp.fault.code, 'no_confirm');
});

test('a heat pump that takes its mode but idles at its own setpoint is healthy, and the boiler stays off', () => {
  const run = h.runner(hpBoilerHouse());
  pumpRunning(run, 'p_rad', run.st.now - 10 * MIN);
  run.st.confirmClimate = false; // mode 'heat', hvac_action 'idle': the unit's own thermostat is satisfied
  run.set('climate.heat_pump', 'off').set('switch.boiler_relay', 'off').set('switch.rad_pump', 'on');
  run.room('r_liv', { t: 19.7, demand: 'heat' });
  const t0 = run.st.now + 10 * SEC;
  let res = run.tick(t0);
  assert.equal(h.sourceState(res, 's_hp').state, 'starting');
  res = run.tick();
  assert.equal(res.memory.sources.s_hp.confirm, 'confirmed', 'the unit shows the commanded mode');
  res = run.runUntil(t0 + 30 * MIN, MIN).at(-1);
  assert.equal(res.memory.sources.s_hp.fault, null);
  assert.equal(h.sourceState(res, 's_hp').on, true);
  assert.equal(h.sourceState(res, 's_boiler').on, false, 'no failover for a unit that regulates itself');
  assert.equal(h.activeDetections(res, 'source_failed').length, 0);
});

test('a boiler whose flame goes out at its own limit stays healthy while the relay holds', () => {
  const run = h.runner(boilerHouse({ adapter: { command: 'switch.boiler_relay', confirm: { kind: 'entity_on', entityId: 'binary_sensor.boiler_flame' } } }));
  run.set('switch.boiler_relay', 'off').set('binary_sensor.boiler_flame', 'off');
  run.room('r_liv', { t: 19.7, demand: 'heat' });
  run.tick();
  run.set('binary_sensor.boiler_flame', 'on');
  let res = run.tick();
  assert.equal(res.memory.sources.s_boiler.confirm, 'confirmed');
  run.set('binary_sensor.boiler_flame', 'off'); // the boiler reached its own flow limit
  res = run.runUntil(run.st.now + 20 * MIN, MIN).at(-1);
  assert.equal(res.memory.sources.s_boiler.fault, null);
  assert.equal(h.sourceState(res, 's_boiler').on, true);
});

test('a running heat pump switched to another mode behind Klimo\'s back faults after the start timeout', () => {
  const run = h.runner(hpBoilerHouse());
  pumpRunning(run, 'p_rad', run.st.now - 10 * MIN);
  run.set('climate.heat_pump', 'off').set('switch.boiler_relay', 'off').set('switch.rad_pump', 'on');
  run.room('r_liv', { t: 19.7, demand: 'heat' });
  let res = run.runUntil(run.st.now + MIN).at(-1);
  assert.equal(res.memory.sources.s_hp.confirm, 'confirmed');
  run.st.deaf = new Set(['climate.heat_pump']);
  run.set('climate.heat_pump', 'cool', { attrs: { hvac_action: 'cooling' } });
  const changed = run.st.now;
  res = run.runUntil(changed + 4 * MIN, MIN).at(-1);
  assert.equal(res.memory.sources.s_hp.fault, null, 'still within the start timeout');
  res = run.runUntil(changed + 6 * MIN, MIN).at(-1);
  assert.equal(res.memory.sources.s_hp.fault.code, 'no_confirm');
  assert.equal(h.sourceState(res, 's_boiler').on, true);
});
