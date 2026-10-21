const assert = require('node:assert/strict');
const test = require('node:test');
const v = require('../dist/common/validate');
const { ApiException } = require('../dist/common/http');

const Band = v.obj({ below: v.num(0.1, 1.0, 0.1), above: v.num(0.1, 1.0, 0.1) });
const RoomPatch = v.obj(
  {
    name: v.opt(v.str(40, { min: 1, trim: true })),
    tolerance: v.opt(v.obj({ heat: v.opt(Band), cool: v.opt(Band) })),
    limits: v.opt(v.nullable(v.obj({ heatMinC: v.num(5, 30), heatMaxC: v.num(5, 30) }))),
    windowReaction: v.opt(v.oneOf(['pause', 'eco', 'lower', 'notify'])),
  },
  { partial: true },
);

function issuesOf(fn) {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ApiException);
    assert.equal(e.getStatus(), 400);
    assert.equal(e.code, 'validation');
    return e.issues;
  }
  assert.fail('expected a validation error');
}

test('accepts a valid patch and drops unknown keys', () => {
  const out = v.parse({ name: '  Вітальня ', tolerance: { heat: { below: 0.2, above: 0.3 } }, limits: null, extra: 1 }, RoomPatch);
  assert.deepEqual(out, { name: 'Вітальня', tolerance: { heat: { below: 0.2, above: 0.3 } }, limits: null });
});

test('reports every problem with its path', () => {
  const issues = issuesOf(() => v.parse({ name: '', tolerance: { heat: { below: 0.05, above: 0.25 } }, windowReaction: 'open' }, RoomPatch));
  assert.deepEqual(
    issues.map((i) => [i.path, i.code]),
    [
      ['name', 'required'],
      ['tolerance.heat.below', 'range'],
      ['tolerance.heat.above', 'step'],
      ['windowReaction', 'enum'],
    ],
  );
});

test('required keys, types and nullable', () => {
  const s = v.obj({ a: v.int(0, 10), b: v.nullable(v.bool()) });
  assert.deepEqual(issuesOf(() => v.parse({ b: 'x' }, s)).map((i) => [i.path, i.code]), [
    ['a', 'required'],
    ['b', 'type'],
  ]);
  assert.deepEqual(v.parse({ a: 3, b: null }, s), { a: 3, b: null });
  assert.deepEqual(issuesOf(() => v.parse({ a: 2.5, b: true }, s)).map((i) => i.code), ['type']);
});

test('entity ids, HH:MM and ids', () => {
  const s = v.obj({ e: v.entityId(['switch', 'input_boolean']), t: v.hhmm(), id: v.id() });
  assert.deepEqual(v.parse({ e: 'switch.boiler_relay', t: '23:00', id: 'r_9f2a1c0k' }, s), { e: 'switch.boiler_relay', t: '23:00', id: 'r_9f2a1c0k' });
  assert.deepEqual(issuesOf(() => v.parse({ e: 'light.hall', t: '24:00', id: 'bad id' }, s)).map((i) => [i.path, i.code]), [
    ['e', 'domain'],
    ['t', 'pattern'],
    ['id', 'pattern'],
  ]);
  assert.deepEqual(issuesOf(() => v.parse({ e: 'Switch.Boiler', t: '7:00', id: 'x' }, s)).map((i) => i.code), ['pattern', 'pattern']);
});

test('discriminated unions pick the variant by tag', () => {
  const Confirm = v.union('kind', {
    readback: v.obj({}),
    entity_on: v.obj({ entityId: v.entityId(['binary_sensor']) }),
    power_above: v.obj({ entityId: v.entityId(), thresholdW: v.num(1, 100000) }),
  });
  assert.deepEqual(v.parse({ kind: 'entity_on', entityId: 'binary_sensor.boiler_flame', junk: 1 }, Confirm), { kind: 'entity_on', entityId: 'binary_sensor.boiler_flame' });
  assert.deepEqual(issuesOf(() => v.parse({ kind: 'flame' }, Confirm)).map((i) => [i.path, i.code]), [['kind', 'enum']]);
  assert.deepEqual(issuesOf(() => v.parse({ kind: 'power_above', entityId: 'sensor.p' }, Confirm)).map((i) => [i.path, i.code]), [['thresholdW', 'required']]);
});

test('arrays, records, refinements and query coercion', () => {
  const s = v.obj({
    ids: v.arr(v.id(), { max: 2 }),
    params: v.record(v.num(0, 100)),
    days: v.refine(v.arr(v.int(0, 6), { max: 7 }), (d) => (new Set(d).size === d.length ? null : 'unique')),
    limit: v.opt(v.int(1, 200, { coerce: true })),
  });
  assert.deepEqual(v.parse({ ids: ['a'], params: { x: 1 }, days: [0, 6], limit: '50' }, s), { ids: ['a'], params: { x: 1 }, days: [0, 6], limit: 50 });
  assert.deepEqual(issuesOf(() => v.parse({ ids: ['a', 'b', 'c'], params: { x: 101 }, days: [1, 1] }, s)).map((i) => [i.path, i.code]), [
    ['ids', 'max_items'],
    ['params.x', 'range'],
    ['days', 'unique'],
  ]);
});

test('check() returns issues without throwing', () => {
  const r = v.check(5, v.num(0, 1));
  assert.equal(r.value, 5);
  assert.deepEqual(r.issues, [{ path: '', code: 'range', params: { min: 0, max: 1 } }]);
});
