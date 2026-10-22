const assert = require('node:assert/strict');
const test = require('node:test');
const { WatchService } = require('../dist/notify/watch.service');
const { ACTOR, MIN, SEC, det, openNotify } = require('./notify-harness');

const offline = (entity, patch = {}) => det('sensor_offline', `sensor_offline:${entity}`, { entityId: entity, deviceKey: `dev_${entity}`, facts: { name: 'Вікно', minutes: 1800 }, ...patch });
const back = (entity) => ({ ...offline(entity), active: false, recovered: true });
const byEntity = (h) => Object.fromEntries(h.incidents.list({ scope: 'all' }).map((i) => [i.entityId, i]));

test('a device back on the air closes its incident on the same tick; an unclear end still waits for the flap guard', async () => {
  const h = await openNotify();
  try {
    await h.tick([offline('binary_sensor.office'), offline('sensor.hall')]);
    assert.equal(h.incidents.counts().deviceIssues, 2);
    h.sent.length = 0;

    await h.tick([back('binary_sensor.office'), { ...offline('sensor.hall'), active: false }], 10 * SEC);
    const now = h.clock.now();
    let all = byEntity(h);
    assert.equal(all['binary_sensor.office'].status, 'resolved');
    assert.equal(all['binary_sensor.office'].resolvedAt, now);
    assert.equal(all['sensor.hall'].status, 'open', 'no sign that it is back: the flap guard runs');
    assert.equal(h.incidents.counts().deviceIssues, 1, 'the badge drops at once');
    const pushed = h.sent.filter((m) => m.type === 'incident' && m.payload.incident.entityId === 'binary_sensor.office');
    assert.equal(pushed.at(-1).payload.incident.status, 'resolved');

    await h.tick([{ ...offline('sensor.hall'), active: false }], 121 * SEC);
    all = byEntity(h);
    assert.equal(all['sensor.hall'].status, 'resolved');
  } finally {
    await h.close();
  }
});

test('with two detectors on one problem, «back» from one closes it only when the other sees no problem either', async () => {
  const h = await openNotify();
  try {
    await h.tick([offline('binary_sensor.office')]);
    const watchStillSees = offline('binary_sensor.office', { severity: 'warning' });
    await h.tick([watchStillSees, back('binary_sensor.office')], 5 * SEC);
    assert.equal(byEntity(h)['binary_sensor.office'].status, 'open');

    const watchClear = { ...offline('binary_sensor.office', { severity: 'warning' }), active: false };
    await h.tick([watchClear, back('binary_sensor.office')], 5 * SEC);
    assert.equal(byEntity(h)['binary_sensor.office'].status, 'resolved');
  } finally {
    await h.close();
  }
});

test('a sensor that repeats its value is not silent while its device is heard (other entities, Zigbee2MQTT last seen)', async () => {
  const h = await openNotify();
  try {
    await h.config.create('watchRules', { origin: 'manual', entityId: 'sensor.cellar_temperature', name: 'Підвал', role: 'manual', ref: null, condition: { type: 'stale', noUpdateMin: 60 }, severity: 'warning', eventKind: 'sensor_offline', muted: false }, ACTOR);
    h.ha.set('sensor.cellar_temperature', '12.5', { device_class: 'temperature' }, { reportedAgoMs: 3 * 60 * MIN });
    let heard = null;
    const devices = { lastSeen: (id) => (id === 'sensor.cellar_temperature' ? heard : null) };
    const watch = new WatchService(h.config, h.clock, h.ha, { get: (token) => (token === 'DEVICE_HEALTH' ? devices : null) });
    const silent = () => watch.watchDetections(h.clock.now()).filter((d) => d.active && d.entityId === 'sensor.cellar_temperature');
    assert.equal(silent().length, 1);
    heard = h.clock.now() - 2 * MIN;
    assert.equal(silent().length, 0);
  } finally {
    await h.close();
  }
});
