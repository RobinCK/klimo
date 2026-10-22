#!/usr/bin/env node
/**
 * Checks how server problems are matched to form fields (src/data/issues.ts): a problem shown at
 * no field must reach the form's inline message, never get lost.
 *
 *   node scripts/check-issue-paths.mjs        (Node 22.18+ runs the TypeScript source as is)
 */
import assert from 'node:assert/strict';
import { pathMatches, splitIssues } from '../src/data/issues.ts';

const issue = (path, code = 'range', params) => (params ? { path, code, params } : { path, code });

// a pattern covers the path itself and everything below it; `*` is exactly one segment
assert.equal(pathMatches('entityId', 'entityId'), true);
assert.equal(pathMatches('humidity', 'humidity.dehumidifier.onAbovePct'), true);
assert.equal(pathMatches('sensors.*.entityId', 'sensors.3.entityId'), true);
assert.equal(pathMatches('sensors.*.entityId', 'sensors.rs_x1.entityId'), true);
assert.equal(pathMatches('sensors.*', 'sensors.rs_x1.weight'), true);
assert.equal(pathMatches('sensors.*.entityId', 'sensors.entityId'), false);
assert.equal(pathMatches('entityId', 'entity'), false);
assert.equal(pathMatches('name', 'rooms.r_x.name'), false);
assert.equal(pathMatches('humidity.warnAbovePct', 'humidity'), false);

// the add-sensor dialog: entity, name and weight, also as rows of the room's sensor list
const fields = {
  entity: ['entityId', 'sensors.*.entityId'],
  name: ['name', 'sensors.*.name'],
  weight: ['weight', 'sensors.*.weight'],
};
const unique = issue('entityId', 'unique', { sensorId: 'rs_1', name: 'Вологість', state: 'excluded' });
let r = splitIssues([unique, issue('name', 'length'), issue('name', 'required')], fields);
assert.deepEqual(r.fields, { entity: unique, name: issue('name', 'length') });
assert.deepEqual(r.rest, []);

r = splitIssues([issue('sensors.2.weight', 'step'), issue('sensors.rs_9.entityId', 'bound_elsewhere', { room: 'Kitchen' })], fields);
assert.deepEqual(Object.keys(r.fields).sort(), ['entity', 'weight']);
assert.equal(r.fields.entity.params.room, 'Kitchen');

// what no field shows stays in `rest`, in order: a problem of the room, of the request, of the whole graph
const room = issue('rooms.r_study.frostC', 'range', { min: 8, max: 15 });
r = splitIssues([room, issue('contactKind', 'enum'), unique, issue('', 'cycle')], fields);
assert.deepEqual(r.fields, { entity: unique });
assert.deepEqual(r.rest.map((i) => i.path), ['rooms.r_study.frostC', 'contactKind', '']);

// a form without fields: everything is for its message
r = splitIssues([room], {});
assert.deepEqual(r, { fields: {}, rest: [room] });

console.log('check-issue-paths: ok');
