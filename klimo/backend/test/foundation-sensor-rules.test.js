const assert = require('node:assert/strict');
const test = require('node:test');
const { ACTOR, openStores, rejection } = require('./foundation-harness');
const { introducedIssues } = require('../dist/config/validators');
const { parse } = require('../dist/common/validate');
const { sensorCreateRequest } = require('../dist/api/schemas');

async function withStores(fn) {
  const s = await openStores();
  try {
    await fn(s);
  } finally {
    await s.close();
  }
}

const sensor = (roomId, entityId, role, extra = {}) => ({
  roomId,
  entityId,
  role,
  name: '',
  contactKind: null,
  model: 'SONOFF SNZB-02D',
  haDeviceId: 'dev_zig_temp_office',
  weight: 1,
  included: true,
  excludedBy: null,
  ...extra,
});

test('one device serves a room as its thermometer and its hygrometer', () =>
  withStores(async ({ config }) => {
    const r = await config.create('rooms', { name: 'Office' }, ACTOR);
    await config.create('sensors', sensor(r.id, 'sensor.zig_temp_office_temperature', 'temperature', { name: 'zig_temp_office' }), ACTOR);
    const h = await config.create('sensors', sensor(r.id, 'sensor.zig_temp_office_humidity', 'humidity', { name: 'Вологість' }), ACTOR);
    assert.equal(h.name, 'Вологість');
    assert.equal(h.haDeviceId, 'dev_zig_temp_office');
    // a second hygrometer of another device, a name with spaces and Cyrillic, and an empty name
    await config.create('sensors', sensor(r.id, 'sensor.bath_humidity', 'humidity', { name: 'Біля вікна, над радіатором', haDeviceId: 'dev_bath' }), ACTOR);
    await config.create('sensors', sensor(r.id, 'sensor.kitchen_humidity', 'humidity', { haDeviceId: null }), ACTOR);
    const roles = config.list('sensors').filter((s) => s.roomId === r.id).map((s) => [s.entityId, s.role]);
    assert.deepEqual(roles, [
      ['sensor.zig_temp_office_temperature', 'temperature'],
      ['sensor.zig_temp_office_humidity', 'humidity'],
      ['sensor.bath_humidity', 'humidity'],
      ['sensor.kitchen_humidity', 'humidity'],
    ]);
  }));

test('the add-sensor request takes a Cyrillic name and leaves an empty one to the entity name', () => {
  const ok = parse({ entityId: 'sensor.zig_temp_office_humidity', role: 'humidity', name: ' Вологість ' }, sensorCreateRequest);
  assert.equal(ok.name, 'Вологість');
  const unnamed = parse({ entityId: 'sensor.zig_temp_office_humidity', role: 'humidity' }, sensorCreateRequest);
  assert.equal(unnamed.name, undefined);
  const e = (() => {
    try {
      parse({ entityId: 'zig temp office', role: 'humidity' }, sensorCreateRequest);
    } catch (err) {
      return err;
    }
  })();
  assert.deepEqual(e.issues.map((i) => [i.path, i.code]), [['entityId', 'pattern']]);
});

test('the same entity twice in one role of a room names the row that already reads it', () =>
  withStores(async ({ config }) => {
    const r = await config.create('rooms', { name: 'Office' }, ACTOR);
    const first = await config.create('sensors', sensor(r.id, 'sensor.zig_temp_office_humidity', 'humidity', { name: 'Вологість' }), ACTOR);
    let e = await rejection(() => config.create('sensors', sensor(r.id, 'sensor.zig_temp_office_humidity', 'humidity', { name: 'Ще раз' }), ACTOR));
    assert.equal(e.getStatus(), 400);
    assert.deepEqual(e.issues, [{ path: 'entityId', code: 'unique', params: { sensorId: first.id, name: 'Вологість', state: 'included' } }]);

    // switched off in the room: still the same row, and the reason says so
    await config.update('sensors', first.id, { included: false, excludedBy: 'user' }, ACTOR);
    e = await rejection(() => config.create('sensors', sensor(r.id, 'sensor.zig_temp_office_humidity', 'humidity'), ACTOR));
    assert.equal(e.issues[0].params.state, 'excluded');
    assert.equal(config.list('sensors').filter((s) => s.roomId === r.id).length, 1);
  }));

test('a problem a room already had does not block adding a sensor to it; a new one still does', () =>
  withStores(async ({ config }) => {
    const r = await config.create('rooms', { name: 'Office' }, ACTOR);
    const t = await config.create('sensors', sensor(r.id, 'sensor.zig_temp_office_temperature', 'temperature'), ACTOR);
    await config.update('rooms', r.id, { frostC: 7.5 }, ACTOR);
    // the house floor is raised later: the room's own floor is now below it (harmless, the higher one applies)
    await config.patchSingleton('safety', { frostC: 8, frostReleaseC: 9 }, ACTOR);

    const h = await config.create('sensors', sensor(r.id, 'sensor.zig_temp_office_humidity', 'humidity', { name: 'Вологість' }), ACTOR);
    assert.equal(config.get('sensors', h.id).role, 'humidity');
    await config.update('sensors', h.id, { name: 'Вологість офісу' }, ACTOR);
    await config.update('rooms', r.id, { name: 'Study' }, ACTOR);
    await config.remove('sensors', h.id, ACTOR);

    // the frost floor itself edited to another value under the house floor is still refused
    let e = await rejection(() => config.update('rooms', r.id, { frostC: 7.6 }, ACTOR));
    assert.deepEqual(e.issues.map((i) => [i.path, i.code]), [['frostC', 'range']]);
    // a problem another write brings into the room is still reported, with the room's path
    await config.update('rooms', r.id, { limits: { heatMinC: 10, heatMaxC: 26, coolMinC: 18, coolMaxC: 30 } }, ACTOR);
    const lim = config.singleton('settings').targetLimits;
    e = await rejection(() => config.patchSingleton('settings', { targetLimits: { ...lim, heatMinC: 12 } }, ACTOR));
    assert.deepEqual(e.issues.map((i) => [i.path, i.code]), [[`rooms.${r.id}.limits.heatMinC`, 'range']]);
    await config.update('rooms', r.id, { frostC: 9 }, ACTOR);
    assert.equal(config.get('rooms', r.id).frostC, 9);
    assert.equal(config.get('sensors', t.id).roomId, r.id);
  }));

test('introducedIssues keeps new problems and problems whose value changed', () => {
  const before = [{ path: 'frostC', code: 'range' }, { path: 'limits.heatMaxC', code: 'order' }];
  const after = [{ path: 'frostC', code: 'range' }, { path: 'limits.heatMaxC', code: 'order' }, { path: 'name', code: 'required' }];
  const prev = { frostC: 7.5, limits: { heatMaxC: 20 }, name: 'A' };
  assert.deepEqual(introducedIssues(after, before, prev, { ...prev, name: '' }), [{ path: 'name', code: 'required' }]);
  assert.deepEqual(
    introducedIssues(after, before, prev, { ...prev, frostC: 7.6, limits: { heatMaxC: 19 }, name: '' }).map((i) => i.path),
    ['frostC', 'limits.heatMaxC', 'name'],
  );
  // a new object has nothing to carry over
  assert.equal(introducedIssues(after, [], undefined, prev).length, 3);
});
