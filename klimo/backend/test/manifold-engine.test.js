// The primary pump of a manifold in the plant core: its own run-on, the pre-run through it when the
// circuits on the manifold have no pumps of their own, and a manifold fed by its own source list.
const assert = require('node:assert/strict');
const test = require('node:test');
const h = require('./plant-core-harness');
const { buildSchema } = require('../dist/engine/services/schema.builder');

const { SEC, MIN } = h;
const manifold = (over = {}) => ({ id: 'm1', name: 'Колектор', supplySensorEntityId: null, returnSensorEntityId: null, sourceIds: ['boiler'], order: 0, ...over });

function house({ circuitPumps = true, mainRunOn = 15 } = {}) {
  const boiler = h.gasBoiler('boiler');
  const rad = h.circuit('c_rad', ['boiler'], { kind: 'radiators', manifoldId: 'm1', mode: 'zoned', order: 0 });
  const floor = h.circuit('c_floor', ['boiler'], { kind: 'floor', manifoldId: 'm1', mode: 'follow_source', order: 1 });
  const pumps = [{ ...h.pump('p_main', null, 'switch.main_pump', { runOnHeatMin: mainRunOn, rule: 'source' }), manifoldId: 'm1' }];
  if (circuitPumps) {
    pumps.push(h.pump('p_rad', 'c_rad', 'switch.radiator_pump', { runOnHeatMin: 3 }));
    pumps.push(h.pump('p_floor', 'c_floor', 'switch.floor_pump', { runOnHeatMin: 10 }));
  }
  const rooms = [h.room('living'), h.room('bath')];
  const emitters = [
    h.emitter('e_rad', 'living', { circuitId: 'c_rad', roles: { heat: 'primary', cool: null } }),
    h.emitter('e_floor', 'bath', { kind: 'floor', circuitId: 'c_floor', roles: { heat: 'primary', cool: null } }),
  ];
  const cfg = h.makeCfg({ rooms, emitters, sources: [boiler], circuits: [rad, floor], pumps, manifolds: [manifold()], heat: { chain: h.chain('boiler') } });
  const run = h.runner(cfg);
  run.set('switch.boiler_relay', 'off').set('switch.main_pump', 'off');
  if (circuitPumps) run.set('switch.radiator_pump', 'off').set('switch.floor_pump', 'off');
  run.room('bath', { t: 23, heatC: 23, demand: 'none' });
  return { cfg, run };
}

test('manifold: the primary pump runs with the boiler and keeps its own run-on, longer than its circuits’', () => {
  const { run } = house({ mainRunOn: 15 });
  run.room('living', { t: 19.6, demand: 'heat' });
  let res = run.runUntil(run.st.now + 2 * MIN).at(-1);
  assert.equal(h.sourceState(res, 'boiler').on, true);
  assert.equal(h.pumpState(res, 'p_main').on, true);
  assert.equal(h.pumpState(res, 'p_main').manifoldId, 'm1');

  run.room('living', { t: 20.4, demand: 'none' });
  res = run.runUntil(run.st.now + 5 * MIN).at(-1);
  assert.equal(h.sourceState(res, 'boiler').on, false);
  const stop = res.memory.sources.boiler.offSince;
  res = run.runUntil(stop + 12 * MIN).at(-1);
  assert.equal(h.pumpState(res, 'p_floor').on, false, 'the floor pump ran on for its 10 min');
  assert.equal(h.pumpState(res, 'p_main').state, 'run_on', 'the primary pump keeps its 15 min');
  assert.ok(h.pumpState(res, 'p_main').runOnUntil >= stop + 15 * MIN - SEC);
  res = run.runUntil(stop + 15 * MIN + 20 * SEC).at(-1);
  assert.equal(h.pumpState(res, 'p_main').on, false);
});

test('manifold: circuits without pumps — the primary pump does the pre-run, so the boiler starts', () => {
  const { run } = house({ circuitPumps: false, mainRunOn: 5 });
  run.room('living', { t: 19.6, demand: 'heat' });
  let res = run.tick();
  assert.equal(h.sourceState(res, 'boiler').on, false, 'the boiler waits for water to move');
  assert.equal(h.pumpState(res, 'p_main').on, true);
  assert.equal(h.pumpState(res, 'p_main').reason, 'prerun');
  res = run.runUntil(run.st.now + 40 * SEC).at(-1);
  assert.equal(h.sourceState(res, 'boiler').on, true, 'started after the pre-run through the primary pump');
  assert.equal(h.pumpState(res, 'p_main').reason, 'manifold');

  run.room('living', { t: 20.4, demand: 'none' });
  res = run.runUntil(run.st.now + 5 * MIN).at(-1);
  assert.equal(h.sourceState(res, 'boiler').on, false);
  const stop = res.memory.sources.boiler.offSince;
  res = run.runUntil(stop + 4 * MIN).at(-1);
  assert.equal(h.pumpState(res, 'p_main').state, 'run_on');
  res = run.runUntil(stop + 5 * MIN + 20 * SEC).at(-1);
  assert.equal(h.pumpState(res, 'p_main').on, false);
});

test('manifold: a source listed on the manifold runs its primary pump even before circuits are put on it', () => {
  const boiler = h.gasBoiler('boiler');
  const rad = h.circuit('c_rad', ['boiler'], { kind: 'radiators', mode: 'zoned', order: 0 });
  const pumps = [h.pump('p_rad', 'c_rad', 'switch.radiator_pump', { runOnHeatMin: 3 }), { ...h.pump('p_main', null, 'switch.main_pump', { runOnHeatMin: 2 }), manifoldId: 'm1' }];
  const cfg = h.makeCfg({
    rooms: [h.room('living')],
    emitters: [h.emitter('e_rad', 'living', { circuitId: 'c_rad', roles: { heat: 'primary', cool: null } })],
    sources: [boiler],
    circuits: [rad],
    pumps,
    manifolds: [manifold()],
    heat: { chain: h.chain('boiler') },
  });
  const run = h.runner(cfg);
  run.set('switch.boiler_relay', 'off').set('switch.main_pump', 'off').set('switch.radiator_pump', 'off');
  run.room('living', { t: 19.6, demand: 'heat' });
  const res = run.runUntil(run.st.now + 2 * MIN).at(-1);
  assert.equal(h.sourceState(res, 'boiler').on, true);
  assert.equal(h.pumpState(res, 'p_main').on, true);
  assert.equal(res.plant.manifolds.find((m) => m.manifoldId === 'm1').tone, 'heat');
});

test('schema: every manifold is drawn, sources reach circuits through it, direct feeds go straight', () => {
  const { cfg, run } = house({ mainRunOn: 15 });
  const hp = h.heatPump('hp');
  const lone = h.circuit('c_garage', ['boiler'], { kind: 'radiators', mode: 'zoned', order: 2 });
  const spare = manifold({ id: 'm2', name: 'Гараж', sourceIds: [], order: 1 });
  // the heat pump feeds the floor directly, not through the header
  const circuits = cfg.circuits.map((c) => (c.id === 'c_floor' ? { ...c, sourceIds: ['boiler', 'hp'] } : c));
  const next = { ...cfg, sources: [...cfg.sources, hp], circuits: [...circuits, lone], manifolds: [...cfg.manifolds, spare] };
  run.st.cfg = next;
  run.set('climate.heat_pump', 'off');
  run.room('living', { t: 19.6, demand: 'heat' });
  const res = run.runUntil(run.st.now + 2 * MIN).at(-1);
  const view = buildSchema({ cfg: next, plant: res.plant, rooms: [], simulated: false, preset: 'now', conditions: { at: run.st.now, outdoorC: 4, gridPresent: true, pvKw: 0, batteryPct: 100, houseLoadKw: 1 } });
  const keys = view.nodes.map((n) => n.key);
  assert.ok(keys.includes('manifold:m1'));
  assert.ok(keys.includes('manifold:m2'), 'an empty manifold is still drawn so it can be opened');
  const edges = view.edges.map((e) => `${e.from}>${e.to}`);
  assert.ok(edges.includes('source:boiler>manifold:m1'));
  assert.ok(edges.includes('manifold:m1>circuit:c_rad'));
  assert.ok(edges.includes('manifold:m1>circuit:c_floor'));
  assert.ok(!edges.includes('source:boiler>circuit:c_rad'), 'not past the manifold');
  assert.ok(edges.includes('source:hp>circuit:c_floor'), 'a direct feed goes straight to its circuit');
  assert.ok(!edges.includes('source:hp>manifold:m1'));
  assert.ok(edges.includes('source:boiler>circuit:c_garage'), 'a circuit without a manifold connects to its source');
  assert.equal(view.nodes.find((n) => n.key === 'manifold:m1').tone, 'heat');
});
