const assert = require('node:assert/strict');
const test = require('node:test');
const { ACTOR, openStores, rejection } = require('./foundation-harness');
const { newSourceConfig } = require('../dist/shared/defaults');

async function withStores(fn) {
  const s = await openStores();
  try {
    await fn(s);
  } finally {
    await s.close();
  }
}

const dehumidifier = (entityId) => ({ humidity: { dehumidifier: { entityId, onAbovePct: 62, offBelowPct: 57, minOnMin: 10 } } });

async function boiler(config) {
  const base = newSourceConfig('gas_boiler', { id: '', name: 'Gas boiler', now: 0, adapterType: 'relay' });
  delete base.id;
  return config.create('sources', { ...base, adapter: { ...base.adapter, command: 'switch.boiler_relay' } }, ACTOR);
}

test('a dehumidifier may not be a switch that already drives a source, a pump or another room', () =>
  withStores(async ({ config }) => {
    const study = await config.create('rooms', { name: 'Study' }, ACTOR);
    const bath = await config.create('rooms', { name: 'Bath' }, ACTOR);
    const src = await boiler(config);
    const c = await config.create('circuits', { name: 'Floor', shortName: 'Floor', kind: 'floor', manifoldId: null, sourceIds: [], capabilities: { heat: true, cool: false }, supply: { sensorEntityId: null, returnEntityId: null, coolC: 18, coolMaxC: 22 }, mixingValve: null, dewMarginC: null, pumpGroupMode: 'all', flowSafety: false, order: 0 }, ACTOR);
    await config.create('pumps', { name: 'Floor pump', circuitId: c.id, manifoldId: null, entityId: 'switch.floor_pump', rule: 'source', runOnHeatMin: 10, runOnCoolMin: 0, minOnSec: 60, exercise: true, speed: null, enabled: true, order: 0 }, ACTOR);
    await config.update('rooms', bath.id, dehumidifier('switch.bath_fan'), ACTOR);

    let e = await rejection(() => config.update('rooms', study.id, dehumidifier('switch.boiler_relay'), ACTOR));
    assert.equal(e.getStatus(), 400);
    assert.deepEqual(e.issues, [{ path: 'humidity.dehumidifier.entityId', code: 'in_use', params: { sourceId: src.id, source: 'Gas boiler' } }]);

    e = await rejection(() => config.update('rooms', study.id, dehumidifier('switch.floor_pump'), ACTOR));
    assert.deepEqual(e.issues, [{ path: 'humidity.dehumidifier.entityId', code: 'in_use', params: { by: 'Floor pump' } }]);

    // another room's dehumidifier: the same conflict as a sensor of another room
    e = await rejection(() => config.update('rooms', study.id, dehumidifier('switch.bath_fan'), ACTOR));
    assert.equal(e.getStatus(), 409);
    assert.deepEqual(e.issues, [{ path: 'humidity.dehumidifier.entityId', code: 'bound_elsewhere', params: { roomId: bath.id, room: 'Bath' } }]);
    assert.equal(config.get('rooms', study.id).humidity.dehumidifier, null);

    // a free plug is fine, and so is keeping the room's own dehumidifier on a later edit
    await config.update('rooms', study.id, dehumidifier('switch.study_plug'), ACTOR);
    await config.update('rooms', study.id, { humidity: { warnAbovePct: 70 } }, ACTOR);
    assert.equal(config.get('rooms', study.id).humidity.dehumidifier.entityId, 'switch.study_plug');
  }));
