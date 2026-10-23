const assert = require('node:assert/strict');
const test = require('node:test');
const { ACTOR, openStores, rejection } = require('./foundation-harness');
const { collectionFromRow, singletonFromRow } = require('../dist/config/graph');
const { defaultSettings, newSourceConfig, storedMeters } = require('../dist/shared/defaults');

async function withStores(fn) {
  const s = await openStores();
  try {
    await fn(s);
  } finally {
    await s.close();
  }
}

const boiler = (extra = {}) => {
  const s = newSourceConfig('gas_boiler', { id: '', name: 'Котел', now: 0 });
  delete s.id;
  return { ...s, ...extra };
};

test('a source saved before meters existed reads its power sensor as the electricity meter', () => {
  const legacy = newSourceConfig('heat_pump', { id: 's_hp', name: 'ТН', now: 0 });
  legacy.energy.powerEntityId = 'sensor.hp_power';
  const row = { ...legacy, meters: null };
  assert.deepEqual(collectionFromRow('sources', row).meters, [{ kind: 'electricity', entityId: 'sensor.hp_power', unit: null }]);
  assert.deepEqual(collectionFromRow('sources', { ...row, energy: { ...row.energy, powerEntityId: null } }).meters, []);
  // a list, even an empty one, is kept as it is: a meter unbound on purpose stays unbound
  assert.deepEqual(collectionFromRow('sources', { ...row, meters: [] }).meters, []);
  // malformed entries and a second meter of one kind are dropped
  assert.deepEqual(
    storedMeters([{ kind: 'gas', entityId: 'sensor.gas', unit: 'm³' }, { kind: 'gas', entityId: 'sensor.gas2', unit: 'm³' }, { kind: 'water', entityId: 'sensor.w' }, { kind: 'heat', entityId: '' }, 'x'], { powerEntityId: 'sensor.p' }),
    [{ kind: 'gas', entityId: 'sensor.gas', unit: 'm³' }],
  );
});

test('a settings row saved before tariffs existed gets the defaults (10.5 kWh per m³)', () => {
  const { tariffs, ...rest } = defaultSettings('uk');
  const settings = singletonFromRow('settings', { id: 'settings', ...rest, tariffs: null });
  assert.deepEqual(settings.tariffs, { currency: '', electricityPerKwh: null, gasPrice: null, gasPriceUnit: 'm³', gasKwhPerM3: 10.5 });
  assert.equal(tariffs.gasKwhPerM3, 10.5);
});

test('meters: one per kind, in a unit that fits; tariffs are validated', () =>
  withStores(async ({ config }) => {
    const ok = await config.create('sources', boiler({ meters: [{ kind: 'gas', entityId: 'sensor.gas_meter', unit: 'ft³' }, { kind: 'heat', entityId: 'sensor.boiler_heat', unit: 'MJ' }] }), ACTOR);
    assert.deepEqual(config.get('sources', ok.id).meters.map((m) => m.unit), ['ft³', 'MJ']);

    let e = await rejection(() => config.create('sources', boiler({ name: 'Котел 2', meters: [{ kind: 'gas', entityId: 'sensor.boiler_temperature', unit: '°C' }] }), ACTOR));
    assert.deepEqual(e.issues.map((i) => [i.path, i.code]), [['meters.0.unit', 'unit']]);
    e = await rejection(() =>
      config.create('sources', boiler({ name: 'Котел 3', meters: [{ kind: 'gas', entityId: 'sensor.a', unit: 'm³' }, { kind: 'gas', entityId: 'sensor.b', unit: 'm³' }] }), ACTOR),
    );
    assert.deepEqual(e.issues.map((i) => [i.path, i.code]), [['meters.1.kind', 'unique']]);
    e = await rejection(() => config.create('sources', boiler({ name: 'Котел 4', meters: [{ kind: 'electricity', entityId: 'switch.boiler', unit: 'kWh' }] }), ACTOR));
    assert.equal(e.issues[0].path, 'meters.0.entityId');

    await config.patchSingleton('settings', { tariffs: { currency: '₴', gasPrice: 7.96, electricityPerKwh: 4.32 } }, ACTOR);
    assert.deepEqual(config.singleton('settings').tariffs, { currency: '₴', electricityPerKwh: 4.32, gasPrice: 7.96, gasPriceUnit: 'm³', gasKwhPerM3: 10.5 });
    e = await rejection(() => config.patchSingleton('settings', { tariffs: { gasKwhPerM3: 40 } }, ACTOR));
    assert.equal(e.issues[0].path, 'tariffs.gasKwhPerM3');
  }));

test('an export from before meters imports with the power sensor as the electricity meter', () =>
  withStores(async ({ config }) => {
    const s = await config.create('sources', boiler({ name: 'Конвектор', kind: 'electric_radiator' }), ACTOR);
    const bundle = JSON.parse(JSON.stringify(config.exportBundle()));
    const src = bundle.sources.find((x) => x.id === s.id);
    src.energy.powerEntityId = 'sensor.convector_power';
    delete src.meters;
    delete bundle.settings.tariffs;
    const res = await config.importBundle(bundle, { dryRun: false }, ACTOR);
    assert.deepEqual(res.issues, []);
    assert.deepEqual(config.get('sources', s.id).meters, [{ kind: 'electricity', entityId: 'sensor.convector_power', unit: null }]);
    assert.equal(config.singleton('settings').tariffs.gasKwhPerM3, 10.5);
  }));

test('a pump counts what its plug draws: an electricity meter kept across a restart; gas or °C refused', async () => {
  const s = await openStores();
  const dir = s.dir;
  let pumpId;
  try {
    const c = await s.config.create('circuits', { name: 'Тепла підлога', shortName: 'Підлога', kind: 'floor', manifoldId: null, sourceIds: [], capabilities: { heat: true, cool: false }, supply: { sensorEntityId: null, returnEntityId: null, coolC: 18, coolMaxC: 22 }, mixingValve: null, dewMarginC: null, pumpGroupMode: 'all', flowSafety: false, order: 0 }, ACTOR);
    const p = await s.config.create('pumps', { name: 'Насос підлоги', circuitId: c.id, manifoldId: null, entityId: 'switch.floor_plug', rule: 'source', runOnHeatMin: 10, runOnCoolMin: 0, minOnSec: 60, exercise: true, speed: null, enabled: true, order: 0 }, ACTOR);
    pumpId = p.id;
    assert.equal(s.config.get('pumps', p.id).meter, null, 'a pump starts without a meter');
    await s.config.update('pumps', p.id, { meter: { kind: 'electricity', entityId: 'sensor.floor_plug_energy', unit: 'kWh' } }, ACTOR);
    let e = await rejection(() => s.config.update('pumps', p.id, { meter: { kind: 'gas', entityId: 'sensor.gas_meter', unit: 'm³' } }, ACTOR));
    assert.deepEqual(e.issues.map((i) => [i.path, i.code]), [['meter.kind', 'enum']]);
    e = await rejection(() => s.config.update('pumps', p.id, { meter: { kind: 'electricity', entityId: 'sensor.floor_temperature', unit: '°C' } }, ACTOR));
    assert.deepEqual(e.issues.map((i) => [i.path, i.code]), [['meter.unit', 'unit']]);
  } finally {
    await s.close({ keep: true });
  }
  const again = await openStores({ dir });
  try {
    assert.deepEqual(again.config.get('pumps', pumpId).meter, { kind: 'electricity', entityId: 'sensor.floor_plug_energy', unit: 'kWh' });
  } finally {
    await again.close();
  }
});
