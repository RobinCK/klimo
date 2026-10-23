// Where a source delivers when it is added from «Нове джерело»: a room source (an AC, a heater) gets the
// emitter in its room that the engine serves the room by — created with it, moved with its room, its roles
// following what it can do — and a room source saved without one gets it when the configuration loads.
const assert = require('node:assert/strict');
const test = require('node:test');
const { ACTOR, openStores } = require('./foundation-harness');
const { SourcesController } = require('../dist/api/sources.controller');
const { sourceFeeds } = require('../dist/engine/services/mappers');
const { newSourceConfig } = require('../dist/shared/defaults');

const circuitValue = (name) => ({ name, shortName: name, kind: 'radiators', manifoldId: null, sourceIds: [], capabilities: { heat: true, cool: false }, supply: { sensorEntityId: null, returnEntityId: null, coolC: 18, coolMaxC: 22 }, mixingValve: null, dewMarginC: null, pumpGroupMode: 'all', flowSafety: false });

async function withHouse(fn) {
  const s = await openStores();
  try {
    const readModels = { source: (id) => ({ config: s.config.get('sources', id) }) };
    const ctrl = new SourcesController(s.config, null, null, null, readModels, null, null, null);
    const kitchen = await s.config.create('rooms', { name: 'Кухня' }, ACTOR);
    const living = await s.config.create('rooms', { name: 'Вітальня' }, ACTOR);
    const rad = await s.config.create('circuits', circuitValue('Радіатори'), ACTOR);
    // the living room already has radiators, the kitchen has no heating
    await s.config.create('emitters', { roomId: living.id, kind: 'radiator', name: 'Радіатор', order: 0, enabled: true, circuitId: rad.id, sourceId: null, roles: { heat: 'primary', cool: null }, assist: null, trigger: null, excludeFromCooling: false, ignoreSeason: false }, ACTOR);
    const own = (sourceId) => s.config.list('emitters').filter((e) => e.sourceId === sourceId);
    const feeds = (sourceId) => sourceFeeds(s.config.engineConfig(), s.config.get('sources', sourceId));
    await fn({ ...s, ctrl, kitchen, living, own, feeds });
  } finally {
    await s.close();
  }
}

test('a room AC added from the source wizard serves its room: the room’s heating alone, or a top-up beside radiators', () =>
  withHouse(async ({ ctrl, kitchen, living, own, feeds }) => {
    const a = await ctrl.create({ kind: 'ac', name: 'Кондиціонер · Кухня', scope: 'room', roomId: kitchen.id, adapterType: 'climate' }, ACTOR);
    const [ea] = own(a.config.id);
    assert.ok(ea, 'an emitter in its room');
    assert.equal(ea.roomId, kitchen.id);
    assert.equal(ea.kind, 'direct');
    assert.deepEqual(ea.roles, { heat: 'primary', cool: 'primary' }, 'nothing else heats the kitchen');
    assert.deepEqual(feeds(a.config.id).heat, [{ type: 'room', id: kitchen.id }]);
    assert.deepEqual(feeds(a.config.id).cool, [{ type: 'room', id: kitchen.id }]);

    const b = await ctrl.create({ kind: 'ac', scope: 'room', roomId: living.id, adapterType: 'climate' }, ACTOR);
    const [eb] = own(b.config.id);
    assert.deepEqual(eb.roles, { heat: 'assist', cool: 'primary' }, 'the radiators heat, the AC tops up');
    assert.deepEqual(eb.assist, { deficitC: 1.5 });

    const heater = await ctrl.create({ kind: 'electric_radiator', scope: 'room', roomId: kitchen.id }, ACTOR);
    assert.deepEqual(own(heater.config.id)[0].roles, { heat: 'primary', cool: null });
  }));

test('the room source’s emitter moves with its room and follows what the source can do; a role taken off stays off', () =>
  withHouse(async ({ config, ctrl, kitchen, living, own, feeds }) => {
    const a = await ctrl.create({ kind: 'ac', scope: 'room', roomId: kitchen.id, adapterType: 'climate' }, ACTOR);
    const id = a.config.id;
    await ctrl.patch(id, { roomId: living.id }, ACTOR);
    assert.equal(own(id).length, 1);
    assert.equal(own(id)[0].roomId, living.id, 'moved, not copied');
    assert.equal(own(id)[0].roles.heat, 'assist', 'beside the living room’s radiators it tops up');
    assert.deepEqual(own(id)[0].assist, { deficitC: 1.5 });
    assert.deepEqual(feeds(id).heat, [{ type: 'room', id: living.id }]);

    const caps = config.get('sources', id).capabilities;
    await ctrl.patch(id, { capabilities: { ...caps, heat: false } }, ACTOR);
    assert.equal(own(id)[0].roles.heat, null, 'it no longer heats');
    assert.deepEqual(feeds(id).heat, []);
    await ctrl.patch(id, { capabilities: { ...caps, heat: true } }, ACTOR);
    assert.equal(own(id)[0].roles.heat, 'assist', 'heating again');

    // a role someone took off the emitter is not put back by an unrelated edit
    await config.update('emitters', own(id)[0].id, { roles: { heat: null, cool: 'primary' } }, ACTOR);
    await ctrl.patch(id, { name: 'Кондиціонер' }, ACTOR);
    assert.equal(own(id)[0].roles.heat, null);
  }));

test('a duplicate of a room AC into another room gets its own emitter there', () =>
  withHouse(async ({ config, ctrl, kitchen, living, own }) => {
    const a = await ctrl.create({ kind: 'ac', scope: 'room', roomId: kitchen.id, adapterType: 'climate' }, ACTOR);
    const copy = await ctrl.duplicate(a.config.id, { linked: false, roomId: living.id }, ACTOR);
    assert.equal(own(copy.config.id).length, 1);
    assert.equal(own(copy.config.id)[0].roomId, living.id);
    assert.equal(own(a.config.id)[0].roomId, kitchen.id, 'the original stays');
    assert.equal(config.list('emitters').filter((e) => e.kind === 'direct').length, 2);
  }));

test('a central source gets no room emitter', () =>
  withHouse(async ({ ctrl, own }) => {
    const b = await ctrl.create({ kind: 'gas_boiler', name: 'Котел' }, ACTOR);
    assert.equal(own(b.config.id).length, 0);
  }));

test('a room source saved without its emitter gets it when the configuration loads', async () => {
  const s = await openStores();
  let dir;
  try {
    const kitchen = await s.config.create('rooms', { name: 'Кухня' }, ACTOR);
    const base = newSourceConfig('ac', { id: '', name: 'Кондиціонер', now: 0, roomId: kitchen.id });
    delete base.id;
    const ac = await s.config.create('sources', base, ACTOR);
    assert.equal(s.config.list('emitters').length, 0, 'as the source wizard left it before');
    dir = s.dir;
    await s.close({ keep: true });

    const again = await openStores({ dir });
    try {
      const [e] = again.config.list('emitters').filter((x) => x.sourceId === ac.id);
      assert.ok(e, 'healed');
      assert.equal(e.roomId, kitchen.id);
      assert.deepEqual(e.roles, { heat: 'primary', cool: 'primary' });
      const [row] = await again.ds.query('SELECT COUNT(*) AS n FROM emitter WHERE "sourceId" = ?', [ac.id]);
      assert.equal(Number(row.n), 1, 'written to the database');
    } finally {
      await again.close();
    }
  } finally {
    if (!dir) await s.close();
  }
});
