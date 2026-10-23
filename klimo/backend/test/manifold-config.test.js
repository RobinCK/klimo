// Manifolds in the configuration: create/patch with their circuits and primary pump in one write, the
// sources they pass on to their circuits, validation, deletion, the migration of older rows and backups.
const assert = require('node:assert/strict');
const test = require('node:test');
const { ACTOR, openStores, rejection } = require('./foundation-harness');
const { newSourceConfig } = require('../dist/shared/defaults');
const { PlantController } = require('../dist/api/plant.controller');
const { graphFromBundle } = require('../dist/config/export-import.service');

async function withPlant(fn) {
  const s = await openStores();
  try {
    const ctrl = new PlantController(s.config, null, null, null);
    const source = async (kind, name, extra = {}) => {
      const base = newSourceConfig(kind, { id: '', name, now: 0, ...extra });
      delete base.id;
      return s.config.create('sources', { ...base, ...extra }, ACTOR);
    };
    const boiler = await source('gas_boiler', 'Газовий котел');
    const hp = await source('heat_pump', 'Тепловий насос');
    const room = await s.config.create('rooms', { name: 'Вітальня' }, ACTOR);
    const ac = await source('ac', 'Кондиціонер', { scope: 'room', roomId: room.id });
    const circuit = (name, kind, sourceIds) =>
      s.config.create('circuits', { name, shortName: name, kind, manifoldId: null, sourceIds, capabilities: { heat: true, cool: kind === 'floor' }, supply: { sensorEntityId: null, returnEntityId: null, coolC: 18, coolMaxC: 22 }, mixingValve: null, dewMarginC: null, pumpGroupMode: 'all', flowSafety: false }, ACTOR);
    const rad = await circuit('Радіатори', 'radiators', []);
    const floor = await circuit('Підлога', 'floor', [hp.id]);
    await fn({ ...s, ctrl, boiler, hp, ac, rad, floor });
  } finally {
    await s.close();
  }
}

test('a collector is created with its sources, circuits and primary pump in one write', () =>
  withPlant(async ({ config, ctrl, boiler, hp, rad, floor }) => {
    const m = await ctrl.createManifold(
      { name: 'Колектор', supplySensorEntityId: 'sensor.manifold_supply', sourceIds: [boiler.id], circuitIds: [rad.id, floor.id], pump: { entityId: 'switch.manifold_pump', name: 'Насос колектора', runOnHeatMin: 7 } },
      ACTOR,
    );
    assert.deepEqual(m.sourceIds, [boiler.id]);
    assert.equal(config.get('circuits', rad.id).manifoldId, m.id);
    assert.deepEqual(config.get('circuits', rad.id).sourceIds, [boiler.id], 'the collector’s source feeds its circuits');
    assert.deepEqual(config.get('circuits', floor.id).sourceIds, [hp.id, boiler.id], 'a direct source stays');
    const pumps = config.list('pumps').filter((p) => p.manifoldId === m.id);
    assert.equal(pumps.length, 1);
    assert.equal(pumps[0].circuitId, null);
    assert.equal(pumps[0].entityId, 'switch.manifold_pump');
    assert.equal(pumps[0].runOnHeatMin, 7);
    assert.equal(pumps[0].name, 'Насос колектора');
  }));

test('a collector needs a unique name and central sources; nothing is saved when one part fails', () =>
  withPlant(async ({ config, ctrl, boiler, ac, rad }) => {
    await ctrl.createManifold({ name: 'Колектор' }, ACTOR);
    const dup = await rejection(() => ctrl.createManifold({ name: ' колектор ' }, ACTOR));
    assert.equal(dup.getStatus(), 400);
    assert.ok(dup.issues.some((i) => i.path === 'name' && i.code === 'unique'));

    const scope = await rejection(() => ctrl.createManifold({ name: 'Другий', sourceIds: [ac.id] }, ACTOR));
    assert.ok(scope.issues.some((i) => i.path === 'sourceIds.0' && i.code === 'scope'));
    const missing = await rejection(() => ctrl.createManifold({ name: 'Третій', sourceIds: ['s_nope'] }, ACTOR));
    assert.ok(missing.issues.some((i) => i.path === 'sourceIds.0' && i.code === 'not_found'));

    // an unknown circuit fails the whole write: no collector, no circuit moved
    const bad = await rejection(() => ctrl.createManifold({ name: 'Гараж', sourceIds: [boiler.id], circuitIds: [rad.id, 'c_nope'] }, ACTOR));
    assert.ok(bad.issues.some((i) => i.path === 'circuitIds.1' && i.code === 'not_found'));
    assert.equal(config.list('manifolds').length, 1);
    assert.equal(config.get('circuits', rad.id).manifoldId, null);
    assert.deepEqual(config.get('circuits', rad.id).sourceIds, []);
  }));

test('the collector’s sources follow to its circuits: added, taken off, a circuit put on or taken off', () =>
  withPlant(async ({ config, ctrl, boiler, hp, rad, floor }) => {
    const m = await ctrl.createManifold({ name: 'Колектор', sourceIds: [boiler.id], circuitIds: [rad.id] }, ACTOR);
    await ctrl.patchManifold(m.id, { sourceIds: [boiler.id, hp.id] }, ACTOR);
    assert.deepEqual(config.get('circuits', rad.id).sourceIds, [boiler.id, hp.id]);

    await ctrl.patchManifold(m.id, { sourceIds: [hp.id] }, ACTOR);
    assert.deepEqual(config.get('circuits', rad.id).sourceIds, [hp.id], 'a source taken off the collector stops feeding its circuits');

    await config.update('circuits', floor.id, { manifoldId: m.id, sourceIds: [] }, ACTOR);
    assert.deepEqual(config.get('circuits', floor.id).sourceIds, [hp.id], 'a circuit on a collector is always fed by its sources');

    await ctrl.patchManifold(m.id, { circuitIds: [floor.id] }, ACTOR);
    assert.equal(config.get('circuits', rad.id).manifoldId, null, 'left out → taken off');
    assert.deepEqual(config.get('circuits', rad.id).sourceIds, [hp.id], 'and still fed, now directly');
  }));

test('the primary pump: changed, then removed with pump: null; a pump needs a circuit or a manifold', () =>
  withPlant(async ({ config, ctrl }) => {
    const m = await ctrl.createManifold({ name: 'Колектор', pump: { entityId: 'switch.main_pump', runOnHeatMin: 3 } }, ACTOR);
    const [p] = config.list('pumps');
    assert.equal(p.name, 'Колектор', 'named after the collector when no name is given');
    await ctrl.patchManifold(m.id, { pump: { entityId: 'switch.other_pump', runOnHeatMin: 12 } }, ACTOR);
    const [q] = config.list('pumps');
    assert.equal(q.id, p.id, 'the same pump, changed');
    assert.equal(q.entityId, 'switch.other_pump');
    assert.equal(q.runOnHeatMin, 12);
    await ctrl.patchManifold(m.id, { pump: null }, ACTOR);
    assert.equal(config.list('pumps').length, 0);

    const base = { name: 'Насос', circuitId: null, manifoldId: null, entityId: 'switch.lonely_pump', rule: 'source', runOnHeatMin: 3, runOnCoolMin: 0, minOnSec: 60, exercise: true, speed: null, enabled: true };
    const none = await rejection(() => config.create('pumps', base, ACTOR));
    assert.ok(none.issues.some((i) => i.code === 'exactly_one'));
    const gone = await rejection(() => config.create('pumps', { ...base, manifoldId: 'm_nope' }, ACTOR));
    assert.ok(gone.issues.some((i) => i.path === 'manifoldId' && i.code === 'not_found'));
  }));

test('the primary pump counts its plug: a meter saved with the collector, kept when left out, removed with null', () =>
  withPlant(async ({ config, ctrl }) => {
    const meter = { kind: 'electricity', entityId: 'sensor.zig_plug_warm_floor_energy', unit: 'kWh' };
    const m = await ctrl.createManifold({ name: 'Колектор', pump: { entityId: 'switch.zig_plug_warm_floor', runOnHeatMin: 3, meter } }, ACTOR);
    assert.deepEqual(config.list('pumps')[0].meter, meter);
    await ctrl.patchManifold(m.id, { pump: { entityId: 'switch.zig_plug_warm_floor', runOnHeatMin: 5 } }, ACTOR);
    assert.deepEqual(config.list('pumps')[0].meter, meter, 'a change without the meter keeps it');
    await ctrl.patchManifold(m.id, { pump: { entityId: 'switch.zig_plug_warm_floor', runOnHeatMin: 5, meter: null } }, ACTOR);
    assert.equal(config.list('pumps')[0].meter, null);
    const bad = await rejection(() => ctrl.patchManifold(m.id, { pump: { entityId: 'switch.zig_plug_warm_floor', runOnHeatMin: 5, meter: { kind: 'gas', entityId: 'sensor.gas', unit: 'm³' } } }, ACTOR));
    assert.ok(bad.issues.some((i) => i.path.endsWith('meter.kind')));
  }));

test('deleting a collector: circuits stay with their sources, its pump and the pump’s watch go', () =>
  withPlant(async ({ config, ctrl, boiler, rad }) => {
    const m = await ctrl.createManifold({ name: 'Колектор', sourceIds: [boiler.id], circuitIds: [rad.id], pump: { entityId: 'switch.main_pump', runOnHeatMin: 3 } }, ACTOR);
    const [p] = config.list('pumps');
    await config.create('watchRules', { origin: 'manual', entityId: 'switch.main_pump', name: 'Насос', role: 'pump', ref: { pumpId: p.id }, condition: { type: 'unavailable', forMin: 5 }, severity: 'warning', eventKind: 'entity_unavailable', muted: false }, ACTOR);
    await ctrl.removeManifold(m.id, ACTOR);
    assert.equal(config.list('manifolds').length, 0);
    assert.equal(config.get('circuits', rad.id).manifoldId, null);
    assert.deepEqual(config.get('circuits', rad.id).sourceIds, [boiler.id]);
    assert.equal(config.list('pumps').length, 0);
    assert.equal(config.list('watchRules').filter((w) => w.ref?.pumpId === p.id).length, 0);
  }));

test('deleting a source takes it off the collector', () =>
  withPlant(async ({ config, ctrl, boiler, hp }) => {
    const m = await ctrl.createManifold({ name: 'Колектор', sourceIds: [boiler.id, hp.id] }, ACTOR);
    await config.remove('sources', boiler.id, ACTOR, { force: true });
    assert.deepEqual(config.get('manifolds', m.id).sourceIds, [hp.id]);
  }));

test('a collector saved before it listed sources reads the sources its circuits share, once, and keeps them', async () => {
  const s = await openStores();
  let dir;
  try {
    const ctrl = new PlantController(s.config, null, null, null);
    const mk = async (kind, name) => {
      const base = newSourceConfig(kind, { id: '', name, now: 0 });
      delete base.id;
      return s.config.create('sources', base, ACTOR);
    };
    const boiler = await mk('gas_boiler', 'Котел');
    const hp = await mk('heat_pump', 'ТН');
    const m = await ctrl.createManifold({ name: 'Колектор' }, ACTOR);
    const circuit = (name, sourceIds) =>
      s.config.create('circuits', { name, shortName: name, kind: 'radiators', manifoldId: m.id, sourceIds, capabilities: { heat: true, cool: false }, supply: { sensorEntityId: null, returnEntityId: null, coolC: 18, coolMaxC: 22 }, mixingValve: null, dewMarginC: null, pumpGroupMode: 'all', flowSafety: false }, ACTOR);
    const a = await circuit('А', [boiler.id, hp.id]);
    const b = await circuit('Б', [hp.id]);
    await s.ds.query('UPDATE manifold SET "sourceIds" = NULL');
    dir = s.dir;
    await s.close({ keep: true });

    const again = await openStores({ dir });
    try {
      assert.deepEqual(again.config.get('manifolds', m.id).sourceIds, [hp.id], 'what both circuits share');
      assert.deepEqual(again.config.get('circuits', a.id).sourceIds, [boiler.id, hp.id], 'nothing else changes');
      assert.deepEqual(again.config.get('circuits', b.id).sourceIds, [hp.id]);
      const [row] = await again.ds.query('SELECT "sourceIds" FROM manifold');
      assert.deepEqual(JSON.parse(row.sourceIds), [hp.id], 'written back');
    } finally {
      await again.close();
    }
  } finally {
    if (!dir) await s.close();
  }
});

test('backups carry the collector’s sources; an older backup without them reads the shared ones', () =>
  withPlant(async ({ config, ctrl, boiler, hp, rad, floor }) => {
    const m = await ctrl.createManifold({ name: 'Колектор', sourceIds: [boiler.id], circuitIds: [rad.id, floor.id], pump: { entityId: 'switch.main_pump', runOnHeatMin: 9 } }, ACTOR);
    const bundle = config.exportBundle();
    assert.deepEqual(bundle.manifolds.map((x) => [x.id, x.sourceIds]), [[m.id, [boiler.id]]]);
    assert.equal(bundle.pumps.find((p) => p.manifoldId === m.id).runOnHeatMin, 9);

    const round = await config.importBundle(bundle, { dryRun: false }, ACTOR);
    assert.equal(round.ok, true, JSON.stringify(round.issues));
    assert.deepEqual(config.get('manifolds', m.id).sourceIds, [boiler.id]);

    const old = JSON.parse(JSON.stringify(bundle));
    for (const x of old.manifolds) delete x.sourceIds;
    const parsed = graphFromBundle(old);
    assert.deepEqual(parsed.graph.manifolds.get(m.id).sourceIds, [boiler.id], 'the source both circuits share');
    assert.ok(config.get('circuits', floor.id).sourceIds.includes(hp.id));
  }));

test('the request is checked: a pump needs its entity and run-on, unknown keys are refused', () =>
  withPlant(async ({ config, ctrl }) => {
    const e = await rejection(() => ctrl.createManifold({ name: 'Колектор', pump: { runOnHeatMin: 3 } }, ACTOR));
    assert.equal(e.getStatus(), 400);
    assert.ok(e.issues.some((i) => i.path === 'pump.entityId' && i.code === 'required'));
    const range = await rejection(() => ctrl.createManifold({ name: 'Колектор', pump: { entityId: 'switch.main_pump', runOnHeatMin: 45 } }, ACTOR));
    assert.ok(range.issues.some((i) => i.path === 'pump.runOnHeatMin'));
    assert.equal(config.list('manifolds').length, 0);
  }));
