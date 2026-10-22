const assert = require('node:assert/strict');
const test = require('node:test');
const h = require('./plant-core-harness');

const { MIN, SEC, kyiv } = h;

/** Heat pump on a floor circuit and a heat-only radiator circuit; one room on each. */
function hpTwoCircuits(o = {}) {
  const hp = h.heatPump('s_hp');
  const floor = h.circuit('c_floor', ['s_hp'], { kind: 'floor', capabilities: { heat: true, cool: true }, flowSafety: true, order: 0, ...(o.floor ?? {}) });
  const rad = h.circuit('c_rad', ['s_hp'], { kind: 'radiators', order: 1 });
  const pf = h.pump('p_floor', 'c_floor', 'switch.floor_pump', { rule: 'source', runOnHeatMin: 10, ...(o.floorPump ?? {}) });
  const pr = h.pump('p_rad', 'c_rad', 'switch.rad_pump', { rule: 'rooms', runOnHeatMin: 3 });
  const kitchen = h.room('r_kitchen');
  const living = h.room('r_living');
  const ef = h.emitter('e_floor', 'r_kitchen', { kind: 'floor', circuitId: 'c_floor', roles: { heat: 'primary', cool: 'primary' } });
  const er = h.emitter('e_rad', 'r_living', { kind: 'radiator', circuitId: 'c_rad', roles: { heat: 'primary', cool: null } });
  return h.makeCfg({
    rooms: [kitchen, living],
    emitters: [ef, er],
    sources: [hp],
    circuits: [floor, rad],
    pumps: [pf, pr],
    heat: { chain: h.chain('s_hp') },
    cool: { chain: h.chain('s_hp') },
    ...(o.cfg ?? {}),
  });
}

function heatPumpRunning(run, mode, since) {
  run.st.memory.sources.s_hp = { ...h.d.defaultSourceMemory('s_hp', since), on: true, mode, onSince: since, confirm: 'confirmed', confirmedAt: since, hpMode: mode, stage: 1, starts: [] };
  run.set('climate.heat_pump', mode, { attrs: { hvac_action: mode === 'heat' ? 'heating' : 'cooling' } });
}

function pumpOn(run, id, since, reason = 'source') {
  run.st.memory.pumps[id] = { ...h.d.defaultPumpMemory(id, since), on: true, onSince: since, reason, condSince: since, runOnMode: 'heat' };
  run.set(`switch.${id.slice(2)}_pump`, 'on');
}

test('floor pump with the «source» rule runs 10 minutes after the heat pump stops at 17:50', () => {
  const t1750 = kyiv(2026, 10, 21, 17, 50);
  const run = h.runner(hpTwoCircuits(), { start: t1750 - 30 * MIN });
  heatPumpRunning(run, 'heat', t1750 - 60 * MIN);
  pumpOn(run, 'p_floor', t1750 - 60 * MIN);
  run.set('switch.rad_pump', 'off');
  run.room('r_kitchen', { t: 19.9, demand: 'heat' });
  run.room('r_living', { t: 21, demand: 'none' });
  run.runUntil(t1750 - 10 * SEC);

  run.room('r_kitchen', { t: 20.3, demand: 'none' });
  let res = run.tick(t1750);
  assert.equal(h.sourceState(res, 's_hp').on, false);
  const p = h.pumpState(res, 'p_floor');
  assert.equal(p.on, true);
  assert.equal(p.state, 'run_on');
  assert.equal(p.runOnUntil, t1750 + 10 * MIN);
  assert.ok(res.spans.some((s) => s.subject === 'pump' && s.subjectId === 'p_floor' && s.kind === 'run_on' && s.edge === 'start'));
  assert.ok(res.decisions.some((x) => x.code === 'pump.run_on' && x.params.until === t1750 + 10 * MIN));
  assert.equal(res.plant.circuits.find((c) => c.circuitId === 'c_floor').state.code, 'circuit.run_on');

  res = run.runUntil(t1750 + 10 * MIN - 10 * SEC).at(-1);
  assert.equal(h.pumpState(res, 'p_floor').on, true);
  res = run.tick(t1750 + 10 * MIN);
  assert.equal(h.pumpState(res, 'p_floor').on, false);
  assert.ok(res.spans.some((s) => s.subjectId === 'p_floor' && s.kind === 'run_on' && s.edge === 'end'));
});

test('radiator pump stops 3 minutes after the last radiator closes; flow safety keeps the floor pump while the heat pump runs', () => {
  const now = kyiv(2026, 10, 21, 12, 0);
  const cfg = hpTwoCircuits({ floorPump: { rule: 'rooms', runOnHeatMin: 0 } });
  // the heat pump is forced on (no room asks for heat any more)
  cfg.overrides = [{ id: 'o1', scope: 'source', subjectId: 's_hp', kind: 'source_force', group: 'source_lock', value: { kind: 'source_force', mode: 'heat' }, duration: '1h', createdAt: now, until: now + 3600_000, by: { via: 'ui', userId: null, userName: null, contextId: null }, previous: null, revertToken: null, revertUntil: null, reqId: null }];
  const run = h.runner(cfg, { start: now - MIN });
  heatPumpRunning(run, 'heat', now - 60 * MIN);
  pumpOn(run, 'p_rad', now - 30 * MIN, 'rooms');
  run.st.memory.pumps.p_floor = h.d.defaultPumpMemory('p_floor', now);
  run.set('switch.floor_pump', 'off');
  run.room('r_kitchen', { t: 21, demand: 'none' });
  run.room('r_living', { t: 21, demand: 'none' });

  let res = run.tick(now);
  assert.equal(h.pumpState(res, 'p_rad').state, 'run_on');
  assert.equal(h.pumpState(res, 'p_floor').on, false, 'water still moves through the radiators');

  res = run.runUntil(now + 3 * MIN).at(-1);
  assert.equal(h.pumpState(res, 'p_rad').on, false, 'no TRV open: the radiator pump does not spin in vain');
  const pf = h.pumpState(res, 'p_floor');
  assert.equal(pf.on, true);
  assert.equal(pf.reason, 'flow_safety');
  assert.ok(res.decisions.some((x) => x.code === 'pump.flow_safety' && x.params.sourceId === 's_hp'));
});

test('cooling the floor: the heat-only radiator circuit is closed, its pump off and the Sunday exercise skipped', () => {
  const sunday10 = kyiv(2026, 10, 18, 10, 0);
  const run = h.runner(hpTwoCircuits(), { start: sunday10 - MIN, season: h.season('cooling') });
  heatPumpRunning(run, 'cool', sunday10 - 30 * MIN);
  pumpOn(run, 'p_floor', sunday10 - 30 * MIN);
  run.st.memory.pumps.p_rad = { ...h.d.defaultPumpMemory('p_rad', sunday10), offSince: sunday10 - 3 * 86_400_000 };
  run.set('switch.rad_pump', 'off');
  run.room('r_kitchen', { t: 26.4, heatC: 20, coolC: 25, demand: 'cool', rh: 52, dew: 15.6 });
  run.room('r_living', { t: 26, heatC: 20, coolC: 25, demand: 'none' });
  const res = run.tick(sunday10 + 10 * SEC);
  assert.equal(h.sourceState(res, 's_hp').mode, 'cool');
  const rad = h.pumpState(res, 'p_rad');
  assert.equal(rad.on, false);
  assert.equal(rad.state, 'blocked');
  assert.equal(h.desiredOf(res, 'switch.rad_pump').value.on, false);
  assert.ok(!res.decisions.some((x) => x.code === 'pump.exercise'), 'no exercise while chilled water flows');
  assert.equal(h.verdictOf(res, 'r_living').heatOnlyBlocked, true);
  assert.equal(h.verdictOf(res, 'r_living').emitterOpen.e_rad, false);
  assert.equal(res.plant.circuits.find((c) => c.circuitId === 'c_rad').state.code, 'circuit.heat_only_blocked');
  assert.equal(h.pumpState(res, 'p_floor').on, true);
});

test('weekly exercise: a pump idle for a day runs 60 s at Sunday 10:00 outside cooling', () => {
  const sunday10 = kyiv(2026, 10, 18, 10, 0);
  const run = h.runner(hpTwoCircuits(), { start: sunday10 - 20 * SEC });
  run.st.memory.pumps.p_rad = { ...h.d.defaultPumpMemory('p_rad', sunday10), offSince: sunday10 - 3 * 86_400_000 };
  run.set('switch.rad_pump', 'off').set('switch.floor_pump', 'off').set('climate.heat_pump', 'off');
  run.room('r_kitchen', { t: 21, demand: 'none' });
  run.room('r_living', { t: 21, demand: 'none' });
  let res = run.tick(sunday10 - 10 * SEC);
  assert.equal(res.nextWakeAt, sunday10, 'the engine wakes for the exercise slot');
  res = run.tick(sunday10);
  assert.equal(h.pumpState(res, 'p_rad').state, 'exercise');
  assert.ok(res.decisions.some((x) => x.code === 'pump.exercise'));
  res = run.runUntil(sunday10 + 60 * SEC).at(-1);
  assert.equal(h.pumpState(res, 'p_rad').on, false);
  res = run.runUntil(sunday10 + 3 * MIN).at(-1);
  assert.equal(h.pumpState(res, 'p_rad').on, false, 'once a week only');
});

test('floor cooling: the supply follows the worst dew point plus the margin (17.1 + 2 = 19.1)', () => {
  const run = h.runner(hpTwoCircuits(), { season: h.season('cooling') });
  heatPumpRunning(run, 'cool', run.st.now - 30 * MIN);
  pumpOn(run, 'p_floor', run.st.now - 30 * MIN);
  run.set('switch.rad_pump', 'off');
  run.room('r_kitchen', { t: 26.4, heatC: 20, coolC: 25, demand: 'cool', rh: 60, dew: 17.1 });
  run.room('r_living', { t: 24, heatC: 20, coolC: 25, demand: 'none' });
  const res = run.tick();
  const c = res.plant.circuits.find((x) => x.circuitId === 'c_floor');
  assert.equal(c.supplySetpointC, 19.1);
  assert.equal(c.dewPointMaxC, 17.1);
  assert.equal(h.desiredOf(res, 'climate.heat_pump').value.temperature, 19.1);
});

test('floor cooling is pointless above the max supply: the room is excluded and the guard reported', () => {
  const run = h.runner(hpTwoCircuits(), { season: h.season('cooling') });
  run.set('climate.heat_pump', 'off').set('switch.floor_pump', 'off').set('switch.rad_pump', 'off');
  run.room('r_kitchen', { t: 27, heatC: 20, coolC: 25, demand: 'cool', rh: 60, dew: 20.5 });
  run.room('r_living', { t: 24, heatC: 20, coolC: 25, demand: 'none' });
  const res = run.tick();
  assert.equal(h.sourceState(res, 's_hp').on, false);
  const c = res.plant.circuits.find((x) => x.circuitId === 'c_floor');
  assert.deepEqual(c.excludedRooms, [{ roomId: 'r_kitchen', reason: 'dew' }]);
  assert.equal(c.state.code, 'circuit.dew_blocked');
  assert.equal(h.activeDetections(res, 'dew_point_guard').length, 1);
});

test('a humid room is left out of floor cooling', () => {
  const run = h.runner(hpTwoCircuits(), { season: h.season('cooling') });
  run.set('climate.heat_pump', 'off').set('switch.floor_pump', 'off').set('switch.rad_pump', 'off');
  run.room('r_kitchen', { t: 27, heatC: 20, coolC: 25, demand: 'cool', rh: 70, dew: 21 });
  run.room('r_living', { t: 24, heatC: 20, coolC: 25, demand: 'none' });
  const res = run.tick();
  assert.equal(h.sourceState(res, 's_hp').on, false);
  assert.deepEqual(res.plant.circuits.find((x) => x.circuitId === 'c_floor').excludedRooms, [{ roomId: 'r_kitchen', reason: 'humid' }]);
  assert.equal(h.verdictOf(res, 'r_kitchen').emitterOpen.e_floor, false);
});

test('hard dew guard: supply below dew + margin − 0.5 for 2 minutes stops cooling now and keeps the pumps 2 minutes', () => {
  const cfg = hpTwoCircuits({ floor: { supply: { sensorEntityId: 'sensor.floor_supply', returnEntityId: null, coolC: 18, coolMaxC: 22 } }, floorPump: { rule: 'source', runOnCoolMin: 0 } });
  const run = h.runner(cfg, { season: h.season('cooling') });
  const t0 = run.st.now;
  heatPumpRunning(run, 'cool', t0 - 3 * MIN); // min run not over: only a safety stop may end it
  pumpOn(run, 'p_floor', t0 - 30 * MIN);
  run.set('switch.rad_pump', 'off').set('sensor.floor_supply', '15.5');
  run.room('r_kitchen', { t: 26.4, heatC: 20, coolC: 25, demand: 'cool', rh: 55, dew: 14.6 });
  run.room('r_living', { t: 24, heatC: 20, coolC: 25, demand: 'none' });
  let res = run.tick(t0 + 10 * SEC);
  assert.equal(h.sourceState(res, 's_hp').on, true);
  res = run.runUntil(t0 + 2 * MIN).at(-1);
  assert.equal(h.sourceState(res, 's_hp').on, true, 'not before 2 minutes');
  res = run.tick(t0 + 2 * MIN + 10 * SEC);
  assert.equal(h.sourceState(res, 's_hp').on, false);
  assert.equal(h.desiredOf(res, 'climate.heat_pump').urgency, 'safety');
  assert.ok(res.decisions.some((x) => x.code === 'dew.guard'));
  assert.equal(h.activeDetections(res, 'dew_point_guard').length, 1);
  const trip = run.st.now;
  assert.equal(h.pumpState(res, 'p_floor').reason, 'dew_runon');
  res = run.runUntil(trip + 2 * MIN - 10 * SEC).at(-1);
  assert.equal(h.pumpState(res, 'p_floor').on, true, 'keeps circulating to warm the water');
  res = run.runUntil(trip + 2 * MIN + 10 * SEC).at(-1);
  assert.equal(h.pumpState(res, 'p_floor').on, false, 'then the pump follows its rule again');
});

test('mixing valve: 35° while the floor heats, the dew-safe supply while it cools', () => {
  const cfg = hpTwoCircuits({ floor: { mixingValve: { entityId: 'number.floor_mixing_valve', heatC: 35, coolC: null } } });
  const run = h.runner(cfg);
  heatPumpRunning(run, 'heat', run.st.now - 30 * MIN);
  pumpOn(run, 'p_floor', run.st.now - 30 * MIN);
  run.set('switch.rad_pump', 'off');
  run.room('r_kitchen', { t: 19.9, heatC: 20, coolC: 25, demand: 'heat' });
  run.room('r_living', { t: 21, demand: 'none' });
  let res = run.tick();
  assert.equal(h.desiredOf(res, 'number.floor_mixing_valve').value.value, 35);
  assert.equal(res.plant.circuits.find((c) => c.circuitId === 'c_floor').supplySetpointC, 35);

  const cool = h.runner(cfg, { season: h.season('cooling') });
  heatPumpRunning(cool, 'cool', cool.st.now - 30 * MIN);
  pumpOn(cool, 'p_floor', cool.st.now - 30 * MIN);
  cool.set('switch.rad_pump', 'off');
  cool.room('r_kitchen', { t: 26.4, heatC: 20, coolC: 25, demand: 'cool', rh: 60, dew: 17.1 });
  cool.room('r_living', { t: 24, heatC: 20, coolC: 25, demand: 'none' });
  res = cool.tick();
  assert.equal(h.desiredOf(res, 'number.floor_mixing_valve').value.value, 19.1);
});

test('duty/standby: only the duty pump runs; an unavailable duty pump hands over after 60 s', () => {
  const boiler = h.gasBoiler('s_boiler');
  const floor = h.circuit('c_floor', ['s_boiler'], { kind: 'floor', pumpGroupMode: 'duty_standby' });
  const pa = h.pump('p_a', 'c_floor', 'switch.floor_pump_a', { rule: 'source', runOnHeatMin: 10, order: 0 });
  const pb = h.pump('p_b', 'c_floor', 'switch.floor_pump_b', { rule: 'source', runOnHeatMin: 10, order: 1 });
  const r = h.room('r_bath');
  const e = h.emitter('e_floor', 'r_bath', { kind: 'floor', circuitId: 'c_floor', roles: { heat: 'primary', cool: null } });
  const cfg = h.makeCfg({ rooms: [r], emitters: [e], sources: [boiler], circuits: [floor], pumps: [pa, pb], heat: { chain: h.chain('s_boiler') } });
  const run = h.runner(cfg);
  run.set('switch.boiler_relay', 'off').set('switch.floor_pump_a', 'off').set('switch.floor_pump_b', 'off');
  run.room('r_bath', { t: 22, heatC: 23, demand: 'heat' });
  let res = run.runUntil(run.st.now + MIN).at(-1);
  assert.equal(h.sourceState(res, 's_boiler').on, true);
  assert.equal(h.pumpState(res, 'p_a').on, true);
  assert.equal(h.pumpState(res, 'p_b').on, false);

  const down = run.st.now;
  run.set('switch.floor_pump_a', 'unavailable', { lastChanged: down });
  res = run.tick(down + 30 * SEC);
  assert.equal(h.pumpState(res, 'p_b').on, false, 'a short drop does not switch pumps');
  res = run.tick(down + 70 * SEC);
  assert.equal(h.pumpState(res, 'p_b').on, true);
  assert.ok(res.decisions.some((x) => x.code === 'pump.duty_switch' && x.params.from === 'p_a' && x.params.to === 'p_b'));
});

test('manifold primary pump runs with any feeding source or circuit pump, with the longest run-on', () => {
  const boiler = h.gasBoiler('s_boiler');
  const floor = h.circuit('c_floor', ['s_boiler'], { kind: 'floor', manifoldId: 'm_main' });
  const pf = h.pump('p_floor', 'c_floor', 'switch.floor_pump', { rule: 'source', runOnHeatMin: 10 });
  const pm = { ...h.pump('p_main', null, 'switch.main_pump'), manifoldId: 'm_main' };
  const r = h.room('r_bath');
  const e = h.emitter('e_floor', 'r_bath', { kind: 'floor', circuitId: 'c_floor', roles: { heat: 'primary', cool: null } });
  const cfg = h.makeCfg({ rooms: [r], emitters: [e], sources: [boiler], circuits: [floor], pumps: [pf, pm], manifolds: [{ id: 'm_main', name: 'Колектор', supplySensorEntityId: null, returnSensorEntityId: null, order: 0 }], heat: { chain: h.chain('s_boiler') } });
  const run = h.runner(cfg);
  run.set('switch.boiler_relay', 'off').set('switch.floor_pump', 'off').set('switch.main_pump', 'off');
  run.room('r_bath', { t: 22, heatC: 23, demand: 'heat' });
  let res = run.runUntil(run.st.now + MIN).at(-1);
  assert.equal(h.pumpState(res, 'p_main').on, true);
  assert.equal(h.pumpState(res, 'p_main').reason, 'manifold');
  run.room('r_bath', { t: 23.3, heatC: 23, demand: 'none' });
  res = run.runUntil(run.st.now + 6 * MIN).at(-1);
  assert.equal(h.sourceState(res, 's_boiler').on, false);
  assert.equal(h.pumpState(res, 'p_floor').state, 'run_on');
  assert.equal(h.pumpState(res, 'p_main').on, true);
  res = run.runUntil(run.st.now + 12 * MIN).at(-1);
  assert.equal(h.pumpState(res, 'p_floor').on, false);
  assert.equal(h.pumpState(res, 'p_main').on, false);
});

test('house mode off: sources stop after their minimum run, pumps finish their run-on', () => {
  const boiler = h.gasBoiler('s_boiler');
  const rad = h.circuit('c_rad', ['s_boiler']);
  const pr = h.pump('p_rad', 'c_rad', 'switch.rad_pump', { rule: 'source', runOnHeatMin: 3 });
  const r = h.room('r_liv');
  const e = h.emitter('e_rad', 'r_liv', { circuitId: 'c_rad', roles: { heat: 'primary', cool: null } });
  const cfg = h.makeCfg({ rooms: [r], emitters: [e], sources: [boiler], circuits: [rad], pumps: [pr], heat: { chain: h.chain('s_boiler') } });
  const run = h.runner(cfg);
  run.set('switch.boiler_relay', 'off').set('switch.rad_pump', 'off');
  run.room('r_liv', { t: 19.7, demand: 'heat' });
  run.runUntil(run.st.now + MIN);
  const offAt = run.st.now + 10 * SEC;
  run.st.season = h.season('heating', 'off');
  run.room('r_liv', { t: 19.7, heatC: null, demand: 'none' });
  let res = run.tick(offAt);
  assert.equal(h.sourceState(res, 's_boiler').on, true, 'house mode off is not a safety stop');
  res = run.runUntil(run.st.now + 5 * MIN).at(-1);
  assert.equal(h.sourceState(res, 's_boiler').on, false);
  const stoppedAt = res.memory.sources.s_boiler.offSince;
  assert.equal(h.pumpState(res, 'p_rad').state, 'run_on');
  assert.equal(h.pumpState(res, 'p_rad').runOnUntil, stoppedAt + 3 * MIN);
  assert.ok(res.plant.why.some((w) => w.code === 'plant.house_off'));
});
