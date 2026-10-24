const assert = require('node:assert/strict');
const test = require('node:test');
const { MEMBER, startApi } = require('./api-harness');

async function withApi(fn) {
  const api = await startApi({});
  try {
    await fn(api);
  } finally {
    await api.close();
  }
}

test('source consumption: any panel user, range and date validated, today by default', async () => {
  await withApi(async (api) => {
    let res = await api.request('GET', '/api/sources/s1/consumption?range=week&date=2026-10-19', { headers: MEMBER });
    assert.equal(res.status, 200);
    assert.deepEqual(api.calls.of('consumption.source')[0], ['s1', { range: 'week', date: '2026-10-19' }]);

    res = await api.request('GET', '/api/sources/s1/consumption');
    assert.equal(res.status, 200);
    assert.deepEqual(api.calls.of('consumption.source')[1], ['s1', { range: 'day', date: undefined }]);

    res = await api.request('GET', '/api/sources/s1/consumption?range=decade');
    assert.equal(res.status, 400);
    assert.equal(res.body.issues[0].path, 'range');
    res = await api.request('GET', '/api/sources/s1/consumption?date=21.10.2026');
    assert.equal(res.status, 400);
    assert.equal(res.body.issues[0].path, 'date');
    assert.equal(api.calls.count('consumption.source'), 2);

    res = await api.request('GET', '/api/sources/nope/consumption?range=day');
    assert.equal(res.status, 404);
  });
});

test('house consumption: today for the overview unless a period is given', async () => {
  await withApi(async (api) => {
    let res = await api.request('GET', '/api/energy/consumption', { headers: MEMBER });
    assert.equal(res.status, 200);
    assert.deepEqual(api.calls.of('consumption.house')[0], [{}]);
    res = await api.request('GET', '/api/energy/consumption?date=2026-10-20');
    assert.equal(res.status, 200);
    assert.deepEqual(api.calls.of('consumption.house')[1], [{ date: '2026-10-20' }]);
    res = await api.request('GET', '/api/energy/consumption?range=month&date=2026-10-20');
    assert.deepEqual(api.calls.of('consumption.house')[2], [{ range: 'month', date: '2026-10-20' }]);
    res = await api.request('GET', '/api/energy/consumption?date=yesterday');
    assert.equal(res.status, 400);
    res = await api.request('GET', '/api/energy/consumption?range=decade');
    assert.equal(res.status, 400);
  });
});

test('room consumption: by id or slug, any panel user, range and date validated, today by default', async () => {
  await withApi(async (api) => {
    let res = await api.request('GET', '/api/rooms/r_living/consumption?range=month&date=2026-10-15', { headers: MEMBER });
    assert.equal(res.status, 200);
    assert.equal(res.body.roomId, 'r_living');
    assert.deepEqual(api.calls.of('consumption.room')[0], ['r_living', { range: 'month', date: '2026-10-15' }]);

    res = await api.request('GET', '/api/rooms/vitalnia/consumption');
    assert.equal(res.status, 200);
    assert.deepEqual(api.calls.of('consumption.room')[1], ['vitalnia', {}]);

    res = await api.request('GET', '/api/rooms/r_living/consumption?range=decade');
    assert.equal(res.status, 400);
    assert.equal(res.body.issues[0].path, 'range');
    res = await api.request('GET', '/api/rooms/r_living/consumption?date=21.10.2026');
    assert.equal(res.status, 400);
    assert.equal(res.body.issues[0].path, 'date');
    assert.equal(api.calls.count('consumption.room'), 2);

    res = await api.request('GET', '/api/rooms/nope/consumption?range=day');
    assert.equal(res.status, 404);
  });
});
