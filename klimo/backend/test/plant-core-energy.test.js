const assert = require('node:assert/strict');
const test = require('node:test');
const { mergeOverlay } = require('../dist/engine/core/rules');
const h = require('./plant-core-harness');

const { MIN, SEC, d } = h;

/** Heat pump on a floor circuit (no pumps), a convector in the study, an AC in the living room. */
function blackoutHouse() {
  const hp = h.heatPump('s_hp', { energy: { maxPowerKw: 1.3, powerEntityId: 'sensor.hp_power' } });
  const conv = h.convector('s_conv', 'r_study', 'switch.study_heater', { energy: { maxPowerKw: 1.5 } });
  const ac = h.acUnit('s_ac', 'r_living', 'climate.living_ac', { energy: { maxPowerKw: 0.8 } });
  const floor = h.circuit('c_floor', ['s_hp'], { kind: 'floor' });
  const rooms = [h.room('r_kitchen'), h.room('r_study'), h.room('r_living')];
  const emitters = [
    h.emitter('e_floor', 'r_kitchen', { kind: 'floor', circuitId: 'c_floor', roles: { heat: 'primary', cool: null } }),
    h.emitter('e_conv', 'r_study', { kind: 'direct', sourceId: 's_conv', roles: { heat: 'primary', cool: null } }),
    h.emitter('e_ac', 'r_living', { kind: 'direct', sourceId: 's_ac', roles: { heat: 'primary', cool: 'primary' } }),
  ];
  return h.makeCfg({ rooms, emitters, sources: [hp, conv, ac], circuits: [floor], heat: { chain: h.chain('s_hp') } });
}

test('blackout: heat pump 1.3 + convector 1.5 + AC 0.8 are admitted 30 s apart; +1 kW sheds the convector first', () => {
  const run = h.runner(blackoutHouse(), { energyActive: true });
  run.set('climate.heat_pump', 'off').set('switch.study_heater', 'off').set('climate.living_ac', 'off');
  for (const id of ['r_kitchen', 'r_study', 'r_living']) run.room(id, { t: 19.5, demand: 'heat' });
  const t0 = run.st.now + 10 * SEC;
  let res = run.tick(t0);
  assert.equal(h.sourceState(res, 's_hp').on, true, 'the most important source goes first');
  assert.equal(h.sourceState(res, 's_ac').on, false);
  assert.equal(h.sourceState(res, 's_conv').on, false);
  assert.deepEqual(h.verdictOf(res, 'r_study').waitReason, { code: 'wait.stagger', params: { sourceId: 's_conv', until: t0 + 30 * SEC } });
  assert.equal(res.nextWakeAt, t0 + 30 * SEC, 'wakes when the stagger ends');

  res = run.tick(t0 + 30 * SEC);
  assert.equal(h.sourceState(res, 's_ac').on, true);
  assert.equal(h.sourceState(res, 's_conv').on, false);
  res = run.tick(t0 + 60 * SEC);
  assert.equal(h.sourceState(res, 's_conv').on, true);
  assert.equal(res.plant.energy.usedKw, 3.6);
  assert.equal(res.plant.energy.budgetKw, 4);
  assert.equal(res.plant.energy.phase, 'blackout');
  assert.deepEqual(res.plant.energy.note, { code: 'energy.budget_used', params: { usedKw: 3.6, budgetKw: 4 } });
  assert.equal(h.sourceState(res, 's_conv').admittedKw, 1.5);

  // the heat pump now draws 2.3 kW: 4.6 kW is over the budget for 30 s
  run.set('sensor.hp_power', '2300', { attrs: { unit_of_measurement: 'W' } });
  const over = t0 + 5 * MIN;
  res = run.tick(over);
  assert.equal(h.sourceState(res, 's_conv').on, true);
  res = run.runUntil(over + 30 * SEC).at(-1);
  assert.equal(h.sourceState(res, 's_conv').on, false, 'shed first');
  assert.equal(h.sourceState(res, 's_ac').on, true);
  assert.equal(h.sourceState(res, 's_hp').on, true);
  assert.ok(res.decisions.some((x) => x.code === 'budget.shed' && x.params.sourceId === 's_conv'));
  assert.equal(h.activeDetections(res, 'budget_shed').length, 1);
});

test('a source that does not fit the budget is not started; a gas boiler is exempt', () => {
  const cfg = blackoutHouse();
  cfg.sources.push(h.gasBoiler('s_boiler'));
  cfg.circuits[0].sourceIds.push('s_boiler');
  cfg.heat.chain = h.chain('s_hp', 's_boiler');
  cfg.energy = { ...cfg.energy, budgetKw: 1.0, exempt: { sourceIds: ['s_boiler'], pumps: true, whileSocAbovePct: 20 } };
  const run = h.runner(cfg, { energyActive: true });
  run.set('climate.heat_pump', 'off').set('switch.boiler_relay', 'off').set('switch.study_heater', 'off').set('climate.living_ac', 'off');
  run.room('r_kitchen', { t: 19.5, demand: 'heat' });
  run.room('r_study', { t: 21, demand: 'none' });
  run.room('r_living', { t: 21, demand: 'none' });
  const res = run.tick();
  assert.equal(h.sourceState(res, 's_hp').on, false);
  const b = h.sourceState(res, 's_hp').blockers.find((x) => x.code === 'source.blocked.budget');
  assert.deepEqual(b.params, { usedKw: 0, budgetKw: 1, needKw: 1.3 });
  assert.equal(h.sourceState(res, 's_boiler').on, true, 'the heat pump does not fit: the boiler takes over');
});

test('critical battery: only frost protection runs, gas first; comfort sources stop at once', () => {
  const cfg = blackoutHouse();
  cfg.sources.push(h.gasBoiler('s_boiler'));
  cfg.circuits[0].sourceIds.push('s_boiler');
  cfg.heat.chain = h.chain('s_hp', 's_boiler');
  cfg.energy = { ...cfg.energy, entities: { gridOffline: 'binary_sensor.grid_offline', pvPower: null, houseLoad: null, batterySoc: 'sensor.soc', tariff: null } };
  const run = h.runner(cfg, { energyActive: true });
  run.set('climate.heat_pump', 'off').set('switch.boiler_relay', 'off').set('switch.study_heater', 'off').set('climate.living_ac', 'off');
  run.set('binary_sensor.grid_offline', 'on').set('sensor.soc', '60');
  run.room('r_kitchen', { t: 19.5, demand: 'heat' });
  run.room('r_study', { t: 19.5, demand: 'heat' });
  run.room('r_living', { t: 21, demand: 'none' });
  let res = run.runUntil(run.st.now + MIN).at(-1);
  assert.equal(h.sourceState(res, 's_conv').on, true);

  run.set('sensor.soc', '18');
  run.room('r_kitchen', { t: 6.8, frost: true });
  res = run.tick();
  assert.equal(res.plant.energy.phase, 'critical');
  assert.equal(h.sourceState(res, 's_conv').on, false, 'stopped at once, despite its minimum run');
  assert.equal(h.desiredOf(res, 'switch.study_heater').urgency, 'safety');
  assert.equal(h.sourceState(res, 's_boiler').on, true, 'gas before the heat pump');
  assert.equal(h.sourceState(res, 's_hp').on, false);
  assert.ok(h.decisionCodes(res).includes('budget.critical'));
  assert.equal(h.activeDetections(res, 'energy_critical').length, 1);
  assert.deepEqual(res.plant.energy.note, { code: 'energy.critical', params: { soc: 18 } });
});

test('economy rule: only the gas boiler, no electric carrier, pumps without run-on', () => {
  const hp = h.heatPump('s_hp');
  const boiler = h.gasBoiler('s_boiler');
  const rad = h.circuit('c_rad', ['s_hp', 's_boiler']);
  const p = h.pump('p_rad', 'c_rad', 'switch.rad_pump', { rule: 'source', runOnHeatMin: 3 });
  const r = h.room('r_liv');
  const e = h.emitter('e_rad', 'r_liv', { circuitId: 'c_rad', roles: { heat: 'primary', cool: null } });
  const economy = { ...d.DEFAULT_RULE(), id: 'economy', priority: 10, effects: [{ type: 'only_sources', sourceIds: ['s_boiler'] }, { type: 'disable_carrier', carrier: 'electric' }, { type: 'pumps_demand_only' }] };
  const cfg = h.makeCfg({ rooms: [r], emitters: [e], sources: [hp, boiler], circuits: [rad], pumps: [p], rules: [economy], heat: { chain: h.chain('s_hp', 's_boiler') } });
  const run = h.runner(cfg, { energyActive: true, overlay: mergeOverlay(cfg, [economy]), rules: [{ ruleId: 'economy', active: true, stopped: false, since: 0, lastRun: null }] });
  run.set('climate.heat_pump', 'off').set('switch.boiler_relay', 'off').set('switch.rad_pump', 'off');
  run.room('r_liv', { t: 19.5, demand: 'heat' });
  let res = run.runUntil(run.st.now + MIN).at(-1);
  assert.equal(res.plant.energy.phase, 'economy');
  assert.equal(h.sourceState(res, 's_hp').on, false);
  assert.ok(h.sourceState(res, 's_hp').blockers.some((b) => b.code === 'source.blocked.rule' && b.params.ruleId === 'economy'));
  assert.ok(h.sourceState(res, 's_hp').blockers.some((b) => b.code === 'source.blocked.carrier'));
  assert.equal(h.sourceState(res, 's_boiler').on, true);
  assert.equal(h.pumpState(res, 'p_rad').reason, 'rooms', '«source» pumps behave as «rooms» in economy');
  run.room('r_liv', { t: 20.3, demand: 'none' });
  res = run.runUntil(run.st.now + 6 * MIN).at(-1);
  assert.equal(h.sourceState(res, 's_boiler').on, false);
  assert.equal(h.pumpState(res, 'p_rad').on, false, 'no run-on in economy');
});

test('electric boiler stages: stage 2 after 10 cold minutes; during a blackout stage 2 never fits', () => {
  const eb = h.eBoiler('s_eb', { energy: { maxPowerKw: 3, powerEntityId: null }, adapter: { command: 'switch.eboiler', confirm: { kind: 'readback' }, stages: [{ entityId: 'switch.eboiler_stage2', powerKw: 3 }] } });
  const rad = h.circuit('c_rad', ['s_eb']);
  const r = h.room('r_liv');
  const e = h.emitter('e_rad', 'r_liv', { circuitId: 'c_rad', roles: { heat: 'primary', cool: null } });
  const cfg = h.makeCfg({ rooms: [r], emitters: [e], sources: [eb], circuits: [rad], heat: { chain: h.chain('s_eb') } });

  const normal = h.runner(cfg);
  normal.set('switch.eboiler', 'off').set('switch.eboiler_stage2', 'off');
  normal.room('r_liv', { t: 18.5, demand: 'heat', heatLatch: { on: true, since: normal.st.now - 30 * MIN } });
  const t0 = normal.st.now + 10 * SEC;
  let res = normal.tick(t0);
  assert.equal(res.memory.sources.s_eb.stage, 1);
  assert.equal(h.desiredOf(res, 'switch.eboiler_stage2').value.on, false);
  res = normal.runUntil(t0 + 10 * MIN, MIN).at(-1);
  assert.equal(res.memory.sources.s_eb.stage, 2);
  assert.equal(h.desiredOf(res, 'switch.eboiler_stage2').value.on, true);
  assert.ok(normal.st.last.decisions.some((x) => x.code === 'source.stage_up') || res.memory.sources.s_eb.stage === 2);
  assert.deepEqual(h.sourceState(res, 's_eb').detail, { code: 'source.detail.stage', params: { stage: 2, of: 2 } });

  const blackout = h.runner(cfg, { energyActive: true });
  blackout.set('switch.eboiler', 'off').set('switch.eboiler_stage2', 'off');
  blackout.room('r_liv', { t: 18.5, demand: 'heat', heatLatch: { on: true, since: blackout.st.now - 30 * MIN } });
  res = blackout.runUntil(blackout.st.now + 30 * MIN, MIN).at(-1);
  assert.equal(h.sourceState(res, 's_eb').on, true, 'stage 1 (3 kW) fits into 4 kW');
  assert.equal(res.memory.sources.s_eb.stage, 1, '6 kW never does');
  assert.equal(res.plant.energy.usedKw, 3);
});
