const assert = require('node:assert/strict');
const test = require('node:test');
const { ACTOR, MIN, openNotify } = require('./notify-harness');

test('several outdoor sensors: each is watched; a silent one says the others carry on', async () => {
  const h = await openNotify();
  try {
    const settings = h.config.singleton('settings');
    await h.config.patchSingleton('settings', { outdoor: { ...settings.outdoor, sensorEntityIds: ['sensor.north', 'sensor.south'], aggregation: 'min' } }, ACTOR);
    const rules = h.watch.rules().filter((r) => r.role === 'outdoor');
    assert.deepEqual(rules.map((r) => [r.entityId, r.condition.type, r.condition.noUpdateMin]), [
      ['sensor.north', 'stale', 30],
      ['sensor.south', 'stale', 30],
    ]);

    h.ha.set('sensor.north', '4.1', { unit_of_measurement: '°C' }, { reportedAgoMs: 2 * MIN });
    h.ha.set('sensor.south', '9.3', { unit_of_measurement: '°C' }, { reportedAgoMs: 40 * MIN });
    let ds = h.watch.watchDetections(h.clock.now()).filter((d) => d.kind === 'sensor_offline');
    assert.deepEqual(ds.map((d) => d.dedupKey), ['sensor_offline:sensor.south']);
    assert.equal(ds[0].facts.outdoor, true);
    assert.equal(ds[0].facts.outdoorSource, 'sensor');
    h.incidents.ingest(ds, h.clock.now());
    await h.router.idle();
    const inc = h.incidents.list({ scope: 'all' }).find((i) => i.kind === 'sensor_offline');
    assert.match(h.texts.incident(inc).body, /з інших датчиків/);

    // with every outdoor sensor silent there is nobody to carry on
    h.ha.set('sensor.north', '4.1', { unit_of_measurement: '°C' }, { reportedAgoMs: 45 * MIN });
    ds = h.watch.watchDetections(h.clock.now()).filter((d) => d.kind === 'sensor_offline' && d.active);
    assert.deepEqual(ds.map((d) => d.dedupKey).sort(), ['sensor_offline:sensor.north', 'sensor_offline:sensor.south']);
    assert.ok(ds.every((d) => d.facts.outdoorSource === undefined));
  } finally {
    await h.close();
  }
});
