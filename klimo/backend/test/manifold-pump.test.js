// The primary pump of a manifold beside its circuit pumps: it runs with any of them even when no source
// runs (the weekly anti-seize run of a circuit pump), and has no run-on of its own then; with a source it
// runs on for its own run-on after the source stops, longer only while a circuit pump still runs on.
const assert = require('node:assert/strict');
const test = require('node:test');
const h = require('./plant-core-harness');

const { MIN, SEC, kyiv } = h;

function house({ mainRunOn = 3, floorRunOn = 10, mainExercise = false } = {}) {
  const boiler = h.gasBoiler('boiler');
  const floor = h.circuit('c_floor', ['boiler'], { kind: 'floor', manifoldId: 'm1', mode: 'follow_source', order: 0 });
  const pumps = [
    h.pump('p_floor', 'c_floor', 'switch.floor_pump', { rule: 'source', runOnHeatMin: floorRunOn }),
    { ...h.pump('p_main', null, 'switch.main_pump', { runOnHeatMin: mainRunOn, exercise: mainExercise }), manifoldId: 'm1' },
  ];
  const cfg = h.makeCfg({
    rooms: [h.room('bath')],
    emitters: [h.emitter('e_floor', 'bath', { kind: 'floor', circuitId: 'c_floor', roles: { heat: 'primary', cool: null } })],
    sources: [boiler],
    circuits: [floor],
    pumps,
    manifolds: [{ id: 'm1', name: 'Колектор', supplySensorEntityId: null, returnSensorEntityId: null, sourceIds: ['boiler'], order: 0 }],
    heat: { chain: h.chain('boiler') },
  });
  return cfg;
}

test('primary pump: on with a circuit pump’s anti-seize run while no source runs, off with it', () => {
  const sunday10 = kyiv(2026, 10, 18, 10, 0);
  const run = h.runner(house(), { start: sunday10 - 20 * SEC });
  run.st.memory.pumps.p_floor = { ...h.d.defaultPumpMemory('p_floor', sunday10), offSince: sunday10 - 3 * 86_400_000 };
  run.set('switch.boiler_relay', 'off').set('switch.floor_pump', 'off').set('switch.main_pump', 'off');
  run.room('bath', { t: 23, heatC: 23, demand: 'none' });
  let res = run.tick(sunday10);
  assert.equal(h.pumpState(res, 'p_floor').state, 'exercise');
  assert.equal(h.sourceState(res, 'boiler').on, false);
  assert.equal(h.pumpState(res, 'p_main').on, true, 'it runs with the circuit pump');
  assert.equal(h.pumpState(res, 'p_main').reason, 'manifold');
  res = run.runUntil(sunday10 + 2 * MIN).at(-1);
  assert.equal(h.pumpState(res, 'p_floor').on, false);
  assert.equal(h.pumpState(res, 'p_main').on, false, 'no run-on: no source ran');
});

test('primary pump: after the source stops it keeps its own run-on, or runs until the last circuit pump stops if that is later', () => {
  for (const [mainRunOn, floorRunOn, stopsAfter] of [
    [15, 10, 15],
    [3, 10, 10],
  ]) {
    const run = h.runner(house({ mainRunOn, floorRunOn }));
    run.set('switch.boiler_relay', 'off').set('switch.floor_pump', 'off').set('switch.main_pump', 'off');
    run.room('bath', { t: 22, heatC: 23, demand: 'heat' });
    let res = run.runUntil(run.st.now + 2 * MIN).at(-1);
    assert.equal(h.sourceState(res, 'boiler').on, true);
    assert.equal(h.pumpState(res, 'p_main').on, true);
    run.room('bath', { t: 23.4, heatC: 23, demand: 'none' });
    res = run.runUntil(run.st.now + 6 * MIN).at(-1);
    assert.equal(h.sourceState(res, 'boiler').on, false);
    const stop = res.memory.sources.boiler.offSince;
    res = run.runUntil(stop + stopsAfter * MIN - 20 * SEC).at(-1);
    assert.equal(h.pumpState(res, 'p_main').on, true, `${mainRunOn}/${floorRunOn}: still on before ${stopsAfter} min`);
    res = run.runUntil(stop + stopsAfter * MIN + 20 * SEC).at(-1);
    assert.equal(h.pumpState(res, 'p_main').on, false, `${mainRunOn}/${floorRunOn}: off after ${stopsAfter} min`);
    assert.equal(h.pumpState(res, 'p_floor').on, false);
  }
});
