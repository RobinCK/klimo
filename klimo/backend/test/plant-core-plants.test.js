// The eight worked plant configurations: nothing in the engine is specific to any of them; each is built
// from configuration only and must behave as described.
const assert = require('node:assert/strict');
const test = require('node:test');
const { evaluateTriggers } = require('../dist/engine/core/rules');
const h = require('./plant-core-harness');

const { MIN, SEC, kyiv, d } = h;

const acAttrs = { fan_modes: ['auto', 'low', 'quiet'], min_temp: 16, max_temp: 30, target_temp_step: 0.5 };

function acFor(roomId) {
  const id = `ac_${roomId}`;
  return {
    source: h.acUnit(id, roomId, `climate.${roomId}_ac`),
    emitter: h.emitter(`e_ac_${roomId}`, roomId, { kind: 'direct', sourceId: id, roles: { heat: 'assist', cool: 'primary' }, assist: { deficitC: 1.5 }, order: 1 }),
  };
}

/* 1 ─ gas boiler on a dry contact + ACs */
function plant1() {
  const boiler = h.gasBoiler('boiler', {
    adapter: {
      command: 'switch.boiler_relay',
      confirm: { kind: 'entity_on', entityId: 'binary_sensor.boiler_flame' },
      watchdog: { kind: 'countdown_number', entityId: 'number.boiler_relay_countdown', minutes: 15, rearmEveryMin: 5 },
    },
    failsafe: { onStop: 'leave', handback: null },
  });
  const rad = h.circuit('c_rad', ['boiler'], { name: 'Радіатори' });
  const pump = h.pump('p_rad', 'c_rad', 'switch.radiator_pump', { rule: 'rooms', runOnHeatMin: 3 });
  const rooms = ['living', 'bedroom'].map((id) => h.room(id));
  const acs = rooms.map((r) => acFor(r.id));
  const emitters = [...rooms.map((r) => h.emitter(`e_rad_${r.id}`, r.id, { circuitId: 'c_rad', roles: { heat: 'primary', cool: null }, order: 0 })), ...acs.map((a) => a.emitter)];
  return h.makeCfg({
    rooms,
    emitters,
    sources: [boiler, ...acs.map((a) => a.source)],
    circuits: [rad],
    pumps: [pump],
    heat: { chain: h.chain('boiler') },
    cool: { chain: [{ id: 'ce_acs', sourceIds: acs.map((a) => a.source.id), label: 'Кондиціонери', enabled: true }] },
  });
}

test('plant 1, winter: the boiler heats on its dry contact, confirmed by the flame, its relay countdown re-armed every 5 min', () => {
  const run = h.runner(plant1());
  run.set('switch.boiler_relay', 'off').set('binary_sensor.boiler_flame', 'off').set('switch.radiator_pump', 'off');
  for (const id of ['living', 'bedroom']) run.set(`climate.${id}_ac`, 'off', { attrs: acAttrs });
  run.room('living', { t: 19.7, demand: 'heat' });
  run.room('bedroom', { t: 20.5, demand: 'none' });
  run.st.deaf = new Set(['switch.boiler_relay']);
  let res = run.runUntil(run.st.now + MIN).at(-1);
  assert.equal(h.sourceState(res, 'boiler').on, true);
  assert.equal(h.sourceState(res, 'boiler').state, 'starting', 'the relay has not switched yet');
  run.st.deaf = null;
  run.tick();
  res = run.tick();
  assert.equal(h.sourceState(res, 'boiler').state, 'heating', 'the relay took the command; the flame is the boiler\'s own business');
  run.set('binary_sensor.boiler_flame', 'on');
  res = run.runUntil(run.st.now + MIN).at(-1);
  assert.equal(h.sourceState(res, 'boiler').state, 'heating');
  const wd = h.desiredOf(res, 'number.boiler_relay_countdown');
  assert.equal(wd.value.value, 15);
  assert.equal(wd.refreshEverySec, 300);
  assert.equal(wd.owner.type, 'watchdog');
  assert.equal(h.desiredOf(res, 'switch.boiler_relay').value.on, true);
  assert.equal(h.pumpState(res, 'p_rad').on, true);
  assert.equal(h.sourceState(res, 'ac_living').on, false, 'the AC only assists');
  assert.equal(h.sourceState(res, 'ac_living').role, 'assist');
  assert.equal(h.verdictOf(res, 'living').served, true);
  // switched off: no keep-alive any more, the relay is told off
  run.room('living', { t: 20.3, demand: 'none' });
  res = run.runUntil(run.st.now + 6 * MIN).at(-1);
  assert.equal(h.sourceState(res, 'boiler').on, false);
  assert.equal(h.desiredOf(res, 'number.boiler_relay_countdown'), undefined);
  assert.equal(h.desiredOf(res, 'switch.boiler_relay').value.on, false);
});

test('plant 1, summer: the boiler waits for its season, each AC cools its own room', () => {
  const run = h.runner(plant1(), { season: h.season('cooling'), start: kyiv(2026, 7, 10, 15, 0) });
  run.set('switch.boiler_relay', 'off').set('switch.radiator_pump', 'off');
  for (const id of ['living', 'bedroom']) run.set(`climate.${id}_ac`, 'off', { attrs: acAttrs });
  run.room('living', { t: 25.6, heatC: 20, coolC: 25, demand: 'cool' });
  run.room('bedroom', { t: 25.4, heatC: 20, coolC: 25, demand: 'cool' });
  const res = run.tick();
  assert.equal(h.sourceState(res, 'boiler').state, 'waiting_season');
  for (const id of ['living', 'bedroom']) {
    assert.equal(h.sourceState(res, `ac_${id}`).mode, 'cool');
    assert.equal(h.desiredOf(res, `climate.${id}_ac`).value.hvacMode, 'cool');
    assert.equal(h.verdictOf(res, id).served, true);
  }
  assert.ok(res.plant.why.some((w) => w.code === 'plant.cool_by_ac' && w.params.n === 2));
  assert.equal(h.pumpState(res, 'p_rad').on, false);
});

/* 2 ─ electric boiler + ACs with a blackout budget */
test('plant 2: electric boiler in a blackout runs stage 1 when it fits, never stage 2', () => {
  const eb = h.eBoiler('eboiler', { energy: { maxPowerKw: 3, powerEntityId: 'sensor.eboiler_power' }, adapter: { command: 'switch.eboiler', confirm: { kind: 'readback' }, stages: [{ entityId: 'switch.eboiler_stage2', powerKw: 3 }] } });
  const rad = h.circuit('c_rad', ['eboiler']);
  const rooms = ['living', 'bedroom'].map((id) => h.room(id));
  const acs = rooms.map((r) => acFor(r.id));
  const emitters = [...rooms.map((r) => h.emitter(`e_rad_${r.id}`, r.id, { circuitId: 'c_rad', roles: { heat: 'primary', cool: null } })), ...acs.map((a) => a.emitter)];
  const cfg = h.makeCfg({ rooms, emitters, sources: [eb, ...acs.map((a) => a.source)], circuits: [rad], heat: { chain: h.chain('eboiler') } });
  const run = h.runner(cfg, { energyActive: true });
  run.set('switch.eboiler', 'off').set('switch.eboiler_stage2', 'off');
  for (const id of ['living', 'bedroom']) run.set(`climate.${id}_ac`, 'off', { attrs: acAttrs });
  run.room('living', { t: 17.5, demand: 'heat', heatLatch: { on: true, since: run.st.now - h.HOUR }, requests: { e_rad_living: 'heat', e_ac_living: 'heat' } });
  run.room('bedroom', { t: 20.5, demand: 'none' });
  const res = run.runUntil(run.st.now + 30 * MIN, MIN).at(-1);
  assert.equal(h.sourceState(res, 'ac_living').on, true, 'the AC assists the cold room (0.8 kW)');
  assert.equal(h.sourceState(res, 'eboiler').on, true, 'stage 1 (3 kW) fits next to it');
  assert.equal(res.memory.sources.eboiler.stage, 1);
  assert.equal(h.desiredOf(res, 'switch.eboiler_stage2').value.on, false);
  assert.ok(res.plant.energy.usedKw <= 4);
});

/* 3 ─ heat pump for heat and cool */
function plant3() {
  const hp = h.heatPump('hp', { adapter: { climate: 'climate.heat_pump', defrostEntityId: 'binary_sensor.hp_defrost' } });
  const floor = h.circuit('c_floor', ['hp'], { name: 'Тепла підлога', kind: 'floor', capabilities: { heat: true, cool: true }, mixingValve: { entityId: 'number.floor_mixing_valve', heatC: 35, coolC: null }, flowSafety: true, order: 0 });
  const rad = h.circuit('c_rad', ['hp'], { name: 'Радіатори', order: 1 });
  const pf = h.pump('p_floor', 'c_floor', 'switch.floor_pump', { rule: 'source', runOnHeatMin: 10 });
  const pr = h.pump('p_rad', 'c_rad', 'switch.radiator_pump', { rule: 'rooms', runOnHeatMin: 3 });
  const rooms = ['kitchen', 'bath', 'living'].map((id) => h.room(id));
  const emitters = [
    h.emitter('e_kitchen', 'kitchen', { kind: 'floor', circuitId: 'c_floor', roles: { heat: 'primary', cool: 'primary' } }),
    h.emitter('e_bath', 'bath', { kind: 'floor', circuitId: 'c_floor', roles: { heat: 'primary', cool: 'primary' } }),
    h.emitter('e_living', 'living', { kind: 'radiator', circuitId: 'c_rad', roles: { heat: 'primary', cool: null } }),
  ];
  return h.makeCfg({ rooms, emitters, sources: [hp], circuits: [floor, rad], pumps: [pf, pr], heat: { chain: h.chain('hp') }, cool: { chain: h.chain('hp') } });
}

test('plant 3, heating: weather-compensated flow (4.2° → 37.8°), floor mixed to 35°, defrost is not a fault', () => {
  const run = h.runner(plant3());
  run.set('climate.heat_pump', 'off').set('binary_sensor.hp_defrost', 'off').set('switch.floor_pump', 'off').set('switch.radiator_pump', 'off');
  run.outdoor(4.2);
  run.room('kitchen', { t: 19.7, demand: 'heat' });
  run.room('bath', { t: 23, heatC: 23, demand: 'none' });
  run.room('living', { t: 19.7, demand: 'heat' });
  let res = run.runUntil(run.st.now + MIN).at(-1);
  const hp = h.desiredOf(res, 'climate.heat_pump');
  assert.equal(hp.value.hvacMode, 'heat');
  assert.equal(hp.value.temperature, 37.8);
  assert.equal(h.desiredOf(res, 'number.floor_mixing_valve').value.value, 35);
  assert.ok(res.plant.why.some((w) => w.code === 'plant.flow_curve' && w.params.flowC === 37.8));
  assert.equal(h.pumpState(res, 'p_floor').on, true);
  assert.equal(h.pumpState(res, 'p_rad').on, true);

  run.st.obey = false;
  run.set('climate.heat_pump', 'heat', { attrs: { hvac_action: 'defrosting' } }).set('binary_sensor.hp_defrost', 'on');
  res = run.runUntil(run.st.now + 12 * MIN, MIN).at(-1);
  assert.equal(h.sourceState(res, 'hp').state, 'defrost');
  assert.equal(res.memory.sources.hp.fault, null);
});

test('plant 3, cooling: dew-safe floor supply, a humid bath left out, radiators interlocked closed', () => {
  const run = h.runner(plant3(), { season: h.season('cooling'), start: kyiv(2026, 7, 10, 15, 0) });
  run.set('climate.heat_pump', 'off').set('switch.floor_pump', 'off').set('switch.radiator_pump', 'off');
  run.room('kitchen', { t: 26.4, heatC: 20, coolC: 26, demand: 'cool', rh: 52, dew: 15.6 });
  run.room('bath', { t: 26.5, heatC: 20, coolC: 26, demand: 'cool', rh: 70, dew: 20.6 });
  run.room('living', { t: 26, heatC: 20, coolC: 26, demand: 'none' });
  const res = run.runUntil(run.st.now + MIN).at(-1);
  assert.equal(h.sourceState(res, 'hp').mode, 'cool');
  const floor = res.plant.circuits.find((c) => c.circuitId === 'c_floor');
  assert.equal(floor.supplySetpointC, 18, 'max(18, 15.6 + 2)');
  assert.equal(h.desiredOf(res, 'climate.heat_pump').value.temperature, 18);
  assert.deepEqual(floor.excludedRooms, [{ roomId: 'bath', reason: 'humid' }]);
  assert.equal(h.verdictOf(res, 'bath').emitterOpen.e_bath, false);
  assert.equal(h.verdictOf(res, 'kitchen').served, true);
  assert.equal(h.pumpState(res, 'p_rad').state, 'blocked');
  assert.equal(h.verdictOf(res, 'living').heatOnlyBlocked, true);
  assert.equal(h.desiredOf(res, 'number.floor_mixing_valve').value.value, 18);
});

/* 4 ─ heat pump down to −10, then gas */
test('plant 4: the heat pump that cannot keep up gets the boiler after 45 minutes of a 1° deficit, which leaves once rooms recover', () => {
  const hp = h.heatPump('hp');
  const boiler = h.gasBoiler('boiler');
  const rad = h.circuit('c_rad', ['hp', 'boiler']);
  const p = h.pump('p_rad', 'c_rad', 'switch.radiator_pump', { rule: 'source' });
  const r = h.room('living');
  const e = h.emitter('e_rad', 'living', { circuitId: 'c_rad', roles: { heat: 'primary', cool: null } });
  const cfg = h.makeCfg({ rooms: [r], emitters: [e], sources: [hp, boiler], circuits: [rad], pumps: [p], heat: { chain: h.chain('hp', 'boiler') } });
  const run = h.runner(cfg);
  run.set('climate.heat_pump', 'off').set('switch.boiler_relay', 'off').set('switch.radiator_pump', 'off');
  run.outdoor(-5);
  run.room('living', { t: 18.8, demand: 'heat' });
  const t0 = run.st.now;
  let res = run.runUntil(t0 + 44 * MIN, MIN).at(-1);
  assert.equal(h.sourceState(res, 'hp').on, true);
  assert.equal(h.sourceState(res, 'boiler').on, false);
  assert.ok(res.memory.rooms.living.lagDeficitSince !== null);
  // the deficit counts from when the heat pump runs (it started after its 20-s pump pre-run)
  const since = res.memory.rooms.living.lagDeficitSince;
  res = run.runUntil(since + 45 * MIN, MIN).at(-1);
  assert.equal(res.plant.bivalent.lagActive, true);
  assert.equal(h.sourceState(res, 'boiler').on, true, 'both run together');
  assert.equal(h.sourceState(res, 'hp').on, true);
  assert.equal(h.sourceState(res, 'boiler').roleReason.code, 'role.lag_join');
  assert.ok(run.st.memory.plant.lagActive.on);

  run.room('living', { t: 19.9, demand: 'heat' });
  res = run.runUntil(t0 + 60 * MIN, MIN).at(-1);
  assert.equal(res.plant.bivalent.lagActive, false);
  assert.equal(h.sourceState(res, 'boiler').on, false, 'the joined boiler leaves after its minimum run');
  assert.equal(h.sourceState(res, 'hp').on, true);
});

/* 5 ─ floor loops with several pumps and a manifold primary pump */
test('plant 5: floor pumps all follow the source with 10 min run-on, the manifold pump with them, radiators 3 min', () => {
  const boiler = h.gasBoiler('boiler');
  const floor = h.circuit('c_floor', ['boiler'], { kind: 'floor', manifoldId: 'm1', pumpGroupMode: 'all', order: 0 });
  const rad = h.circuit('c_rad', ['boiler'], { kind: 'radiators', manifoldId: 'm1', order: 1 });
  const pumps = [
    h.pump('p_floor_a', 'c_floor', 'switch.floor_pump_a', { rule: 'source', runOnHeatMin: 10, order: 0 }),
    h.pump('p_floor_b', 'c_floor', 'light.floor_pump_b', { rule: 'source', runOnHeatMin: 10, order: 1 }),
    h.pump('p_rad', 'c_rad', 'input_boolean.radiator_pump', { rule: 'rooms', runOnHeatMin: 3 }),
    { ...h.pump('p_main', null, 'valve.main_pump'), manifoldId: 'm1' },
  ];
  const rooms = [h.room('bath'), h.room('living')];
  const emitters = [
    h.emitter('e_floor', 'bath', { kind: 'floor', circuitId: 'c_floor', roles: { heat: 'primary', cool: null } }),
    h.emitter('e_rad', 'living', { circuitId: 'c_rad', roles: { heat: 'primary', cool: null } }),
  ];
  const cfg = h.makeCfg({ rooms, emitters, sources: [boiler], circuits: [floor, rad], pumps, manifolds: [{ id: 'm1', name: 'Колектор', supplySensorEntityId: null, returnSensorEntityId: null, order: 0 }], heat: { chain: h.chain('boiler') } });
  const run = h.runner(cfg);
  run.set('switch.boiler_relay', 'off').set('switch.floor_pump_a', 'off').set('light.floor_pump_b', 'off').set('input_boolean.radiator_pump', 'off').set('valve.main_pump', 'closed');
  run.room('bath', { t: 23, heatC: 23, demand: 'none' });
  run.room('living', { t: 19.7, demand: 'heat' });
  let res = run.runUntil(run.st.now + MIN).at(-1);
  for (const id of ['p_floor_a', 'p_floor_b', 'p_rad', 'p_main']) assert.equal(h.pumpState(res, id).on, true, id);
  assert.deepEqual(h.desiredOf(res, 'valve.main_pump').value, { kind: 'valve', open: true, position: null });
  assert.deepEqual(h.desiredOf(res, 'light.floor_pump_b').value, { kind: 'switch', on: true });

  run.room('living', { t: 20.3, demand: 'none' });
  res = run.runUntil(run.st.now + 5 * MIN).at(-1);
  assert.equal(h.sourceState(res, 'boiler').on, false);
  const stop = res.memory.sources.boiler.offSince;
  assert.equal(h.pumpState(res, 'p_rad').on, false, 'radiators: 3 minutes');
  res = run.runUntil(stop + 10 * MIN - 10 * SEC).at(-1);
  assert.equal(h.pumpState(res, 'p_floor_a').state, 'run_on');
  assert.equal(h.pumpState(res, 'p_floor_b').state, 'run_on');
  assert.equal(h.pumpState(res, 'p_main').on, true);
  res = run.runUntil(stop + 10 * MIN + 10 * SEC).at(-1);
  for (const id of ['p_floor_a', 'p_floor_b', 'p_main']) assert.equal(h.pumpState(res, id).on, false, id);
});

/* 6 ─ a room electric radiator enabled by «блекаут І сонце» */
test('plant 6: the study convector waits for «Сонце при блекауті», then stores heat within the budget', () => {
  const bind = { gridOffline: 'binary_sensor.grid_offline', pvPower: 'sensor.pv_power', houseLoad: 'sensor.house_load', batterySoc: 'sensor.battery_soc', tariff: null };
  const triggers = d.seedTriggers('uk').map((t) =>
    t.id === 'blackout' ? { ...t, enabled: true, condition: d.blackoutCondition(bind) } : t.id === 'solar' ? { ...t, enabled: true, condition: d.solarCondition(bind) } : t,
  );
  const conv = h.convector('conv', 'study', 'switch.study_heater', {
    adapter: { command: 'switch.study_heater', confirm: { kind: 'power_above', entityId: 'sensor.study_heater_power', thresholdW: 50 } },
    conditions: { join: 'all', items: [{ id: 'ci_solar', mode: null, enabled: true, node: { op: 'trigger', triggerId: 'solar' } }] },
  });
  const r = h.room('study');
  const e = h.emitter('e_conv', 'study', { kind: 'direct', sourceId: 'conv', roles: { heat: 'trigger', cool: null }, trigger: { heatStoreAboveTargetC: 1.5 } });
  const rule = d.storeHeatRule('uk', { gasBoilers: [], heatPumps: [], electricHeat: ['conv'] }, 'sensor.battery_soc');
  const cfg = h.makeCfg({ rooms: [r], emitters: [e], sources: [conv], triggers, rules: [rule], energy: { ...d.defaultEnergy(), entities: bind } });
  const run = h.runner(cfg);
  run.set('switch.study_heater', 'off').set('sensor.study_heater_power', '0', { attrs: { unit_of_measurement: 'W' } });
  run.set('binary_sensor.grid_offline', 'on').set('sensor.pv_power', '3000', { attrs: { unit_of_measurement: 'W' } }).set('sensor.house_load', '1000', { attrs: { unit_of_measurement: 'W' } }).set('sensor.battery_soc', '97');
  const tick = (at, roomOpts) => {
    run.st.now = at;
    const tr = evaluateTriggers(cfg, run.inputs(), run.st.memory, run.st.prevPlant, {});
    run.st.memory = { ...run.st.memory, conditions: tr.conditions };
    Object.assign(run.st, { overlay: tr.overlay, triggers: tr.triggers, rules: tr.rules, energyActive: tr.energyActive });
    run.room('study', roomOpts(tr));
    return { res: run.tick(at), tr };
  };
  // the room core asks the trigger-role emitter for heat only once the source may run
  const study = (tr) => {
    const solar = tr.triggers.find((t) => t.triggerId === 'solar').active;
    return { t: 21.3, heatC: 21, demand: 'none', store: solar, requests: { e_conv: solar ? 'heat' : null }, roles: { e_conv: 'trigger' } };
  };
  const t0 = run.st.now + 10 * SEC;
  let { res, tr } = tick(t0, study);
  assert.equal(tr.energyActive, true, 'restrictions apply in the blackout');
  assert.equal(tr.triggers.find((t) => t.triggerId === 'solar').active, false, 'the surplus must last 5 minutes');
  assert.equal(h.sourceState(res, 'conv').state, 'waiting_trigger');
  assert.deepEqual(h.sourceState(res, 'conv').blockers[0], { code: 'source.blocked.trigger', params: { triggerId: 'solar' } });

  for (let at = t0 + MIN; at < t0 + 5 * MIN; at += MIN) ({ res, tr } = tick(at, study));
  ({ res, tr } = tick(t0 + 5 * MIN, study));
  assert.equal(tr.triggers.find((t) => t.triggerId === 'solar').active, true);
  assert.equal(tr.rules.find((r) => r.ruleId === 'store_heat').active, true);
  assert.deepEqual(tr.overlay.targetOffsets.study.heat, { deltaC: 1.5, ruleId: 'store_heat' });
  assert.equal(h.sourceState(res, 'conv').on, true);
  assert.equal(h.sourceState(res, 'conv').role, 'trigger_only');
  assert.equal(res.plant.energy.usedKw, 1.5);
  assert.equal(h.sourceState(res, 'conv').admittedKw, 1.5);
});

/* 7 ─ a room heated only by its AC */
test('plant 7: an AC-only room waits below −5 outdoors, and frost protection still hands it the AC', () => {
  const ac = h.acUnit('ac', 'den', 'climate.den_ac');
  const r = h.room('den');
  const e = h.emitter('e_ac', 'den', { kind: 'direct', sourceId: 'ac', roles: { heat: 'primary', cool: 'primary' } });
  const cfg = h.makeCfg({ rooms: [r], emitters: [e], sources: [ac] });
  const run = h.runner(cfg);
  run.set('climate.den_ac', 'off', { attrs: acAttrs });
  run.outdoor(-9);
  run.room('den', { t: 19, demand: 'heat' });
  let res = run.tick();
  assert.equal(h.sourceState(res, 'ac').on, false);
  assert.equal(h.verdictOf(res, 'den').served, false);
  assert.equal(h.verdictOf(res, 'den').waitReason.code, 'wait.condition');
  run.room('den', { t: 6.8, frost: true });
  res = run.tick();
  assert.equal(h.sourceState(res, 'ac').on, true);
  assert.equal(h.desiredOf(res, 'climate.den_ac').value.hvacMode, 'heat');
  assert.equal(h.verdictOf(res, 'den').served, true);
});

/* 8 ─ anything from HA */
test('plant 8: a custom source drives any HA services, with the setpoint substituted and its own conditions', () => {
  const custom = h.source('custom', 'tank', {
    name: 'Бойлер',
    adapter: {
      type: 'custom',
      on: { heat: [{ domain: 'water_heater', service: 'set_operation_mode', target: { entity_id: 'water_heater.boiler' }, data: { operation_mode: 'heat' } }] },
      off: [{ domain: 'water_heater', service: 'set_operation_mode', target: { entity_id: 'water_heater.boiler' }, data: { operation_mode: 'off' } }],
      setpoint: [{ domain: 'water_heater', service: 'set_temperature', target: { entity_id: 'water_heater.boiler' }, data: { temperature: '{{setpoint}}', note: 'mode {{mode}}' } }],
      confirm: { kind: 'state_in', entityId: 'water_heater.boiler', values: ['heat'] },
    },
    conditions: { join: 'any', items: [{ id: 'ci_tpl', mode: null, enabled: true, node: { op: 'template', id: 'tpl', template: "{{ states('sensor.price') | float < 3 }}" } }] },
  });
  const rad = h.circuit('c_rad', ['tank']);
  const r = h.room('living');
  const e = h.emitter('e_rad', 'living', { circuitId: 'c_rad', roles: { heat: 'primary', cool: null } });
  const cfg = h.makeCfg({ rooms: [r], emitters: [e], sources: [custom], circuits: [rad], heat: { chain: h.chain('tank') } });
  const run = h.runner(cfg, { obey: false });
  run.set('water_heater.boiler', 'off');
  run.room('living', { t: 19.7, heatC: 21, demand: 'heat' });
  run.st.templateResults = { 'source:tank:ci_tpl#tpl': { value: false, error: null } };
  let res = run.tick();
  assert.equal(h.sourceState(res, 'tank').on, false);
  assert.deepEqual(h.verdictOf(res, 'living').waitReason, { code: 'wait.condition', params: { sourceId: 'tank', itemId: 'ci_tpl' } });
  assert.equal(h.desiredOf(res, 'svc:tank:off').value.kind, 'service');

  run.st.templateResults = { 'source:tank:ci_tpl#tpl': { value: true, error: null } };
  res = run.tick();
  assert.equal(h.sourceState(res, 'tank').on, true);
  const on = h.desiredOf(res, 'svc:tank:on');
  assert.equal(on.value.calls[0].data.operation_mode, 'heat');
  assert.equal(on.value.runKey, `heat:${res.memory.sources.tank.onSince}`);
  const sp = h.desiredOf(res, 'svc:tank:setpoint');
  assert.equal(sp.value.calls[0].data.temperature, 21, 'a lone placeholder keeps its number type');
  assert.equal(sp.value.calls[0].data.note, 'mode heat');
  assert.equal(sp.minIntervalSec, 600);
  run.set('water_heater.boiler', 'heat');
  res = run.tick();
  assert.equal(h.sourceState(res, 'tank').state, 'heating');
  assert.equal(h.desiredOf(res, 'svc:tank:off'), undefined);
});
