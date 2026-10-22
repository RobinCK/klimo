const assert = require('node:assert/strict');
const test = require('node:test');
const { ACTOR, openStores, rejection } = require('./foundation-harness');
const { normalizeOutdoor } = require('../dist/shared/defaults');
const { outdoorSensorIds } = require('../dist/shared/model');

// 0.1.0 stored one outdoor sensor; later versions keep a list and a combining method
const LEGACY = { sensorEntityId: 'sensor.outdoor_temperature', weatherEntityId: 'weather.home', staleAfterMin: 30, holdMin: 45 };

async function storedOutdoor(s) {
  const [row] = await s.ds.query("SELECT outdoor FROM settings WHERE id = 'main'");
  return JSON.parse(row.outdoor);
}

test('a single outdoor sensor of an older database becomes the list on boot, stored in the new shape', async () => {
  let s = await openStores();
  const { dir, clock } = s;
  try {
    await s.ds.query("UPDATE settings SET outdoor = ? WHERE id = 'main'", [JSON.stringify(LEGACY)]);
    await s.close({ keep: true });

    s = await openStores({ dir, clock });
    const want = { sensorEntityIds: ['sensor.outdoor_temperature'], aggregation: 'median', weatherEntityId: 'weather.home', staleAfterMin: 30, holdMin: 45 };
    assert.deepEqual(s.config.singleton('settings').outdoor, want);
    assert.deepEqual(await storedOutdoor(s), want, 'written back without the old field');
    assert.ok(s.config.referencedEntities().includes('sensor.outdoor_temperature'));

    // the list and the method survive a restart as they are
    await s.config.patchSingleton('settings', { outdoor: { sensorEntityIds: ['sensor.south', 'sensor.north'], aggregation: 'max' } }, ACTOR);
    await s.close({ keep: true });
    s = await openStores({ dir, clock });
    const o = s.config.singleton('settings').outdoor;
    assert.deepEqual([o.sensorEntityIds, o.aggregation], [['sensor.south', 'sensor.north'], 'max']);
  } finally {
    await s.close();
  }
});

test('outdoor settings: a list with a method; an older panel naming one sensor replaces the list', async () => {
  const s = await openStores();
  try {
    const { config } = s;
    let o = (await config.patchSingleton('settings', { outdoor: { sensorEntityIds: ['sensor.north', 'sensor.south'], aggregation: 'min' } }, ACTOR)).outdoor;
    assert.deepEqual([o.sensorEntityIds, o.aggregation], [['sensor.north', 'sensor.south'], 'min']);

    o = (await config.patchSingleton('settings', { outdoor: { sensorEntityId: 'sensor.east' } }, ACTOR)).outdoor;
    assert.deepEqual(o.sensorEntityIds, ['sensor.east']);
    assert.equal('sensorEntityId' in o, false);
    assert.deepEqual(await storedOutdoor(s).then((x) => [x.sensorEntityIds, 'sensorEntityId' in x]), [['sensor.east'], false]);

    o = (await config.patchSingleton('settings', { outdoor: { sensorEntityId: null } }, ACTOR)).outdoor;
    assert.deepEqual(o.sensorEntityIds, []);

    // a repeated sensor is stored once
    o = (await config.patchSingleton('settings', { outdoor: { sensorEntityIds: ['sensor.north', 'sensor.north'] } }, ACTOR)).outdoor;
    assert.deepEqual(o.sensorEntityIds, ['sensor.north']);

    let e = await rejection(() => config.patchSingleton('settings', { outdoor: { sensorEntityIds: ['light.kitchen'] } }, ACTOR));
    assert.deepEqual(e.issues.map((i) => [i.path, i.code]), [['outdoor.sensorEntityIds.0', 'domain']]);
    e = await rejection(() => config.patchSingleton('settings', { outdoor: { sensorEntityIds: Array.from({ length: 9 }, (_, i) => `sensor.t${i}`) } }, ACTOR));
    assert.deepEqual(e.issues.map((i) => [i.path, i.code]), [['outdoor.sensorEntityIds', 'max_items']]);
  } finally {
    await s.close();
  }
});

test('a backup from before several outdoor sensors imports into the list', async () => {
  const s = await openStores();
  try {
    const { config } = s;
    const bundle = config.exportBundle();
    bundle.settings = { ...bundle.settings, outdoor: LEGACY };
    const res = await config.importBundle(bundle, { dryRun: false }, ACTOR);
    assert.equal(res.ok, true, JSON.stringify(res.issues));
    assert.deepEqual(config.singleton('settings').outdoor.sensorEntityIds, ['sensor.outdoor_temperature']);
    assert.equal(config.singleton('settings').outdoor.aggregation, 'median');
    assert.equal('sensorEntityId' in (await storedOutdoor(s)), false);
    // and the export carries the new shape
    assert.deepEqual(config.exportBundle().settings.outdoor.sensorEntityIds, ['sensor.outdoor_temperature']);
  } finally {
    await s.close();
  }
});

test('outdoor sensor ids read the old single field too; normalisation keeps a given list', () => {
  assert.deepEqual(outdoorSensorIds({ sensorEntityId: 'sensor.a' }), ['sensor.a']);
  assert.deepEqual(outdoorSensorIds({ sensorEntityIds: [], sensorEntityId: null }), []);
  assert.deepEqual(outdoorSensorIds({ sensorEntityIds: ['sensor.b', 'sensor.c'], sensorEntityId: 'sensor.a' }), ['sensor.b', 'sensor.c']);
  const n = normalizeOutdoor({ sensorEntityIds: ['sensor.b'], sensorEntityId: 'sensor.a', aggregation: 'weighted', weatherEntityId: null, staleAfterMin: 30, holdMin: 30 });
  assert.deepEqual(n, { sensorEntityIds: ['sensor.b'], aggregation: 'median', weatherEntityId: null, staleAfterMin: 30, holdMin: 30 });
});
