const assert = require('node:assert/strict');
const test = require('node:test');
const { ADMIN, MEMBER, NOW, startApi } = require('./api-harness');
const { EVENT_CATALOGUE, isLockedCell } = require('../dist/shared/defaults');

const ROOM = {
  id: 'r_living',
  slug: 'vitalnia',
  name: 'Вітальня',
  order: 0,
  temperature: { method: 'median' },
};

async function withApi(opts, fn) {
  const api = await startApi(opts);
  try {
    api.config.put('rooms', ROOM);
    await fn(api);
  } finally {
    await api.close();
  }
}

test('a configuration write as an anonymous non-admin is refused with forbidden', async () => {
  await withApi({}, async (api) => {
    const res = await api.request('PATCH', '/api/rooms/r_living', { body: { name: 'Зала' } });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'forbidden');
    assert.equal(api.calls.count('update'), 0);
  });
});

test('a household member is refused too, an HA admin may write', async () => {
  await withApi({}, async (api) => {
    const member = await api.request('PATCH', '/api/rooms/r_living', { body: { name: 'Зала' }, headers: MEMBER });
    assert.equal(member.status, 403);
    const admin = await api.request('PATCH', '/api/rooms/r_living', { body: { name: 'Зала' }, headers: ADMIN });
    assert.equal(admin.status, 200);
    assert.equal(admin.body.config.name, 'Зала');
    const [[c, id, patch, actor]] = api.calls.of('update');
    assert.equal(c, 'rooms');
    assert.equal(id, 'r_living');
    assert.deepEqual(patch, { name: 'Зала' });
    assert.equal(actor.userId, 'u_admin');
  });
});

test('control actions are open to every panel user', async () => {
  await withApi({}, async (api) => {
    const res = await api.request('POST', '/api/rooms/r_living/boost', { body: { minutes: 30 } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { roomId: 'r_living', state: 'hold' });
    const [[roomId, req, actor]] = api.calls.of('roomActions.boost');
    assert.equal(roomId, 'r_living');
    assert.deepEqual(req, { minutes: 30 });
    assert.equal(actor.via, 'ui');
  });
});

test('with adminOnlyConfig off every panel user may change the configuration', async () => {
  await withApi({}, async (api) => {
    api.config.single.settings.adminOnlyConfig = false;
    const res = await api.request('PATCH', '/api/rooms/r_living', { body: { sunnySide: true } });
    assert.equal(res.status, 200);
  });
});

test('a room is addressed by id or slug', async () => {
  await withApi({}, async (api) => {
    const res = await api.request('POST', '/api/rooms/vitalnia/target', { body: { value: 22, duration: 'slot' } });
    assert.equal(res.status, 200);
    assert.equal(api.calls.of('roomActions.setTarget')[0][0], 'r_living');
    const missing = await api.request('GET', '/api/rooms/nowhere');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'not_found');
  });
});

test('a repeated reqId within a minute returns the first result instead of acting twice', async () => {
  await withApi({}, async (api) => {
    const body = { value: 21.5, duration: '1h', reqId: 'card-42' };
    const first = await api.request('POST', '/api/rooms/r_living/target', { body });
    const again = await api.request('POST', '/api/rooms/r_living/target', { body });
    assert.equal(api.calls.count('roomActions.setTarget'), 1);
    assert.deepEqual(again.body, first.body);

    api.clock.t += 61_000;
    await api.request('POST', '/api/rooms/r_living/target', { body });
    assert.equal(api.calls.count('roomActions.setTarget'), 2);

    // another id is another change
    await api.request('POST', '/api/rooms/r_living/target', { body: { ...body, reqId: 'card-43' } });
    assert.equal(api.calls.count('roomActions.setTarget'), 3);

    // other tabs and the cards learn about each outcome once
    const results = api.calls.of('bus.emit').filter(([event]) => event === 'command.result').map(([, p]) => p);
    assert.deepEqual(results.map((r) => r.reqId), ['card-42', 'card-42', 'card-43']);
    assert.ok(results.every((r) => r.ok && r.via === 'ui'));
  });
});

test('invalid bodies answer 400 validation with every field problem', async () => {
  await withApi({}, async (api) => {
    const res = await api.request('POST', '/api/rooms/r_living/target', { body: { value: 'warm', duration: 'forever-ish' } });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'validation');
    const paths = res.body.issues.map((i) => i.path).sort();
    assert.deepEqual(paths, ['duration', 'value']);
    assert.equal(api.calls.count('roomActions.setTarget'), 0);
  });
});

test('a failed control action is announced and may be retried with the same reqId', async () => {
  await withApi({}, async (api) => {
    const res = await api.request('DELETE', '/api/rooms/r_living/boost?reqId=b1');
    assert.equal(res.status, 200);
    api.byToken.ROOM_ACTIONS.cancelBoost = async () => {
      throw new (require('../dist/common/http').ApiException)(409, 'conflict', 'no boost');
    };
    const failed = await api.request('DELETE', '/api/rooms/r_living/boost?reqId=b2');
    assert.equal(failed.status, 409);
    const results = api.calls.of('bus.emit').map(([, p]) => p);
    assert.deepEqual(results.map((r) => [r.reqId, r.ok, r.code]), [['b1', true, null], ['b2', false, 'conflict']]);
  });
});

test('unknown keys never reach the configuration', async () => {
  await withApi({}, async (api) => {
    await api.request('PATCH', '/api/rooms/r_living', { body: { name: 'Зала', id: 'hijack', createdAt: 1, tolerance: { heat: { below: 0.3, evil: 1 } } }, headers: ADMIN });
    const [[, , patch]] = api.calls.of('update');
    assert.deepEqual(patch, { name: 'Зала', tolerance: { heat: { below: 0.3 } } });
  });
});

test('the configuration export is a dated attachment', async () => {
  await withApi({}, async (api) => {
    const res = await api.request('GET', '/api/export', { headers: ADMIN });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-disposition'), 'attachment; filename="klimo-config-2026-10-21.json"');
    assert.equal(res.body.app, 'klimo');
  });
});

test('import checks the envelope and passes dryRun through', async () => {
  await withApi({}, async (api) => {
    const bad = await api.request('POST', '/api/import', { body: { app: 'zroshua', version: 1 }, headers: ADMIN });
    assert.equal(bad.status, 400);
    const res = await api.request('POST', '/api/import?dryRun=1', { body: { app: 'klimo', version: 1, rooms: [ROOM] }, headers: ADMIN });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true, dryRun: true, counts: { rooms: 1 }, issues: [] });
    assert.equal(api.calls.of('importBundle')[0][2].via, 'import');
  });
});

test('live engine reads answer 503 until the engine runs', async () => {
  await withApi({}, async (api) => {
    const res = await api.request('GET', '/api/house/state');
    assert.equal(res.status, 503);
  });
  await withApi({ engine: true }, async (api) => {
    const res = await api.request('GET', '/api/house/state');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { season: 'heating' });
  });
});

test('meta tells the SPA who is calling and whether they may edit', async () => {
  await withApi({}, async (api) => {
    const anon = await api.request('GET', '/api/meta');
    assert.equal(anon.status, 200);
    assert.deepEqual(anon.body.me, { userId: null, userName: null, isAdmin: false, canEditConfig: false });
    assert.equal(anon.body.tz, 'Europe/Kyiv');
    assert.equal(anon.body.haUnits, 'metric');
    assert.deepEqual(anon.body.defaults, { notificationLanguage: 'uk', units: 'C' });
    const admin = await api.request('GET', '/api/meta', { headers: ADMIN });
    assert.equal(admin.body.me.canEditConfig, true);
  });
});

test('sensor order: listed sensors first, the rest of that role keep their order', async () => {
  await withApi({}, async (api) => {
    for (const [id, order] of [['s1', 0], ['s2', 1], ['s3', 2]]) {
      api.config.put('sensors', { id, roomId: 'r_living', role: 'temperature', entityId: `sensor.${id}`, order });
    }
    api.config.put('sensors', { id: 'h1', roomId: 'r_living', role: 'humidity', entityId: 'sensor.h1', order: 3 });
    const res = await api.request('PUT', '/api/rooms/r_living/sensors/order', { body: { role: 'temperature', ids: ['s3'] }, headers: ADMIN });
    assert.equal(res.status, 200);
    assert.deepEqual(api.calls.of('reorder')[0][1], ['s3', 's1', 's2']);
    const foreign = await api.request('PUT', '/api/rooms/r_living/sensors/order', { body: { role: 'temperature', ids: ['h1'] }, headers: ADMIN });
    assert.equal(foreign.status, 400);
  });
});

test('a new sensor takes its name and model from Home Assistant', async () => {
  await withApi({}, async (api) => {
    api.ha.states.set('sensor.sofa_t', { entity_id: 'sensor.sofa_t', state: '21.4', attributes: { friendly_name: 'Біля дивана' } });
    const res = await api.request('POST', '/api/rooms/r_living/sensors', { body: { entityId: 'sensor.sofa_t', role: 'temperature' }, headers: ADMIN });
    assert.equal(res.status, 201);
    const [[c, value]] = api.calls.of('create');
    assert.equal(c, 'sensors');
    assert.equal(value.name, 'Біля дивана');
    assert.equal(value.model, 'WSDCGQ11LM');
    assert.equal(value.haDeviceId, 'dev_sensor.sofa_t');
    assert.equal(value.contactKind, null);
    const missing = await api.request('POST', '/api/rooms/r_living/sensors', { body: { entityId: 'binary_sensor.ghost', role: 'contact' }, headers: ADMIN });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.issues[0].code, 'not_found');
  });
});

test('deleting a profile carries the replacement from the body or the query', async () => {
  await withApi({}, async (api) => {
    api.config.put('profiles', { id: 'guests', name: 'Гості', kind: 'custom', order: 4 });
    const res = await api.request('DELETE', '/api/profiles/guests', { body: { replaceWith: 'home' }, headers: ADMIN });
    assert.equal(res.status, 204);
    assert.deepEqual(api.calls.of('remove')[0][3], { replaceWith: 'home' });
    api.config.put('profiles', { id: 'guests', name: 'Гості', kind: 'custom', order: 4 });
    await api.request('DELETE', '/api/profiles/guests?replaceWith=eco', { headers: ADMIN });
    assert.deepEqual(api.calls.of('remove')[1][3], { replaceWith: 'eco' });
  });
});

test('a new profile copies «Дома» and its room values under the next free name', async () => {
  await withApi({}, async (api) => {
    api.config.put('profiles', { id: 'home', name: 'Дома', kind: 'system', heatC: 21, coolC: 25, frostOnly: false, order: 0 });
    api.config.put('profiles', { id: 'p1', name: 'Новий профіль', kind: 'custom', heatC: 20, coolC: 26, frostOnly: false, order: 1 });
    await api.config.setProfileRoom('home', 'r_living', { mode: 'own', heatC: 22 });
    const res = await api.request('POST', '/api/profiles', { body: {}, headers: ADMIN });
    assert.equal(res.status, 201);
    const created = api.calls.of('create').find(([c]) => c === 'profiles')[1];
    assert.equal(created.name, 'Новий профіль 2');
    assert.equal(created.kind, 'custom');
    assert.equal(created.heatC, 21);
    assert.equal(created.color, undefined, 'the store picks the next palette colour');
    const copied = api.calls.of('setProfileRoom').find(([p]) => p !== 'home');
    assert.deepEqual(copied.slice(1, 3), ['r_living', { mode: 'own', heatC: 22, coolC: null }]);
  });
});

test('priority keeps frost and window first', async () => {
  await withApi({}, async (api) => {
    const bad = await api.request('PUT', '/api/priority', {
      body: { order: ['manual', 'frost', 'window', 'calendar', 'presence', 'room_schedule', 'house_schedule'] },
      headers: ADMIN,
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.issues[0].code, 'locked');
    const ok = await api.request('PUT', '/api/priority', {
      body: { order: ['frost', 'window', 'calendar', 'manual', 'presence', 'room_schedule', 'house_schedule'] },
      headers: ADMIN,
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, ['frost', 'window', 'calendar', 'manual', 'presence', 'room_schedule', 'house_schedule']);
  });
});

test('a duplicated source keeps settings but none of the original entities', async () => {
  await withApi({}, async (api) => {
    const ac = {
      id: 's_ac1',
      name: 'Кондиціонер',
      kind: 'ac',
      scope: 'room',
      roomId: 'r_living',
      order: 0,
      enabled: true,
      capabilities: { heat: true, cool: true, dry: true, fan: true },
      energy: { carrier: 'electric', maxPowerKw: 1, powerEntityId: 'sensor.ac_power' },
      adapter: {
        type: 'climate',
        climate: 'climate.ac_living',
        modeMap: { heat: 'heat', cool: 'cool', off: 'off' },
        setpoint: 'room_target',
        fixedSetpoint: null,
        quietFanMode: 'quiet',
        confirm: { kind: 'power_above', entityId: 'sensor.ac_power', thresholdW: 50 },
        defrostEntityId: null,
        errorEntityId: 'sensor.ac_error',
        errorOkValues: ['0'],
        copEntityId: null,
        supplyTempEntityId: null,
      },
      linkedTo: null,
      ownFields: [],
      createdAt: 1,
      updatedAt: 1,
    };
    api.config.put('sources', ac);
    const res = await api.request('POST', '/api/sources/s_ac1/duplicate', { body: { linked: true }, headers: ADMIN });
    assert.equal(res.status, 201);
    const copy = api.calls.of('create')[0][1];
    assert.equal(copy.name, 'Кондиціонер (копія)');
    assert.equal(copy.enabled, false);
    assert.equal(copy.linkedTo, 's_ac1');
    assert.equal(copy.roomId, 'r_living');
    assert.equal(copy.adapter.climate, null);
    assert.equal(copy.adapter.errorEntityId, null);
    assert.deepEqual(copy.adapter.confirm, { kind: 'hvac_action' });
    assert.deepEqual(copy.adapter.modeMap, { heat: 'heat', cool: 'cool', off: 'off' });
    assert.equal(copy.adapter.quietFanMode, 'quiet');
    assert.equal(copy.energy.powerEntityId, null);
    assert.equal(copy.id, undefined);
    assert.equal(copy.createdAt, undefined);
  });
});

test('a source lock is an override with its end resolved by the core, journaled with the person', async () => {
  await withApi({ engine: true }, async (api) => {
    api.config.put('sources', { id: 's_hp', name: 'Тепловий насос', kind: 'heat_pump', capabilities: { heat: true, cool: true, dry: false, fan: false } });
    const dry = await api.request('PUT', '/api/sources/s_hp/lock', { body: { kind: 'source_force', mode: 'dry', duration: '2h' } });
    assert.equal(dry.status, 400);
    const res = await api.request('PUT', '/api/sources/s_hp/lock', { body: { kind: 'source_off', duration: '2h', reason: 'сервіс' }, headers: MEMBER });
    assert.equal(res.status, 200);
    const [[o]] = api.calls.of('overrides.put');
    assert.equal(o.scope, 'source');
    assert.equal(o.subjectId, 's_hp');
    assert.equal(o.group, 'source_lock');
    assert.deepEqual(o.value, { kind: 'source_off', reason: 'сервіс' });
    assert.equal(o.until, NOW + 3_600_000);
    assert.equal(o.by.userId, 'u_olia');
    const [[entry]] = api.calls.of('journal.add');
    assert.equal(entry.code, 'source.lock');
    assert.equal(entry.params.by, 'olia');
    assert.equal(api.calls.count('engine.runNow'), 1);
  });
});

test('routing level toggles: own targets for members, locked critical cells stay on', async () => {
  await withApi({}, async (api) => {
    api.config.put('targets', { id: 'nt_phone', channel: 'ha_mobile', isPrimary: true, isEscalation: false, ownerUserId: 'u_olia', order: 0 });
    api.config.put('targets', { id: 'nt_other', channel: 'ha_mobile', isPrimary: false, isEscalation: false, ownerUserId: 'u_admin', order: 1 });
    const foreign = await api.request('PUT', '/api/notifications/routing/bulk', { body: { severity: 'warning', targetIds: ['nt_other'], on: false }, headers: MEMBER });
    assert.equal(foreign.status, 403);
    const own = await api.request('PUT', '/api/notifications/routing/bulk', { body: { severity: 'critical', targetIds: ['nt_phone'], on: false }, headers: MEMBER });
    assert.equal(own.status, 200);
    // critical kinds locked on the primary phone are left alone
    const phone = api.config.get('targets', 'nt_phone');
    const critical = EVENT_CATALOGUE.filter((e) => e.severity === 'critical');
    const touched = api.calls.of('setRoute').map(([kind]) => kind);
    assert.ok(touched.length < critical.length);
    assert.ok(touched.every((kind) => !isLockedCell(kind, phone)));
    api.calls.list.length = 0;
    await api.request('PUT', '/api/notifications/routing/bulk', { body: { severity: 'warning', targetIds: ['nt_phone'], on: false }, headers: MEMBER });
    assert.ok(api.calls.count('setRoute') > 10);
    assert.ok(api.calls.of('setRoute').every(([, targetId, on]) => targetId === 'nt_phone' && on === false));
  });
});

test('automatic watch rules are stored when first edited and never deleted', async () => {
  await withApi({}, async (api) => {
    const res = await api.request('PATCH', '/api/notifications/watch/auto:sensor.derived', { body: { muted: true }, headers: ADMIN });
    assert.equal(res.status, 200);
    const [[c, value]] = api.calls.of('create');
    assert.equal(c, 'watchRules');
    assert.equal(value.id, 'auto:sensor.derived');
    assert.equal(value.origin, 'auto');
    assert.equal(value.muted, true);
    assert.equal(value.status, undefined);
    const del = await api.request('DELETE', '/api/notifications/watch/auto:sensor.derived', { headers: ADMIN });
    assert.equal(del.status, 409);
  });
});

test('personal preferences need a Home Assistant user', async () => {
  await withApi({}, async (api) => {
    const anon = await api.request('GET', '/api/notifications/me');
    assert.equal(anon.status, 403);
    const me = await api.request('PATCH', '/api/notifications/me', { body: { levels: { event: false } }, headers: MEMBER });
    assert.equal(me.status, 200);
    assert.equal(me.body.userId, 'u_olia');
    assert.equal(me.body.levels.event, false);
    assert.equal(me.body.levels.critical, true);
  });
});

test('schedules: a room schedule starts from the house plan, days are edited on the grid', async () => {
  await withApi({}, async (api) => {
    const day = [{ start: 0, end: 1440, profileId: 'home' }];
    api.config.put('profiles', { id: 'home', name: 'Дома', order: 0 });
    api.config.put('profiles', { id: 'night', name: 'Ніч', order: 1 });
    api.config.put('schedules', { id: 'house', scope: 'house', roomId: null, enabled: true, days: Array.from({ length: 7 }, () => day) });
    const created = await api.request('POST', '/api/schedules', { body: { roomId: 'vitalnia', copyFrom: 'house' }, headers: ADMIN });
    assert.equal(created.status, 201);
    assert.equal(created.body.roomId, 'r_living');
    assert.equal(created.body.days.length, 7);
    const again = await api.request('POST', '/api/schedules', { body: { roomId: 'r_living', copyFrom: 'empty' }, headers: ADMIN });
    assert.equal(again.status, 409);

    const id = created.body.id;
    const split = await api.request('POST', `/api/schedules/${id}/days/2/split`, { body: { index: 0 }, headers: ADMIN });
    assert.equal(split.status, 200);
    assert.deepEqual(split.body.days[2].map((b) => [b.start, b.end]), [[0, 720], [720, 1440]]);
    const badDay = await api.request('PUT', `/api/schedules/${id}/days/7`, { body: { blocks: day }, headers: ADMIN });
    assert.equal(badDay.status, 400);
    const gap = await api.request('PUT', `/api/schedules/${id}/days/1`, { body: { blocks: [{ start: 0, end: 600, profileId: 'night' }] }, headers: ADMIN });
    assert.equal(gap.status, 400);
    const ok = await api.request('PUT', `/api/schedules/${id}/days/1`, {
      body: { blocks: [{ start: 0, end: 420, profileId: 'night' }, { start: 420, end: 1440, profileId: 'home' }], applyTo: [3] },
      headers: ADMIN,
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.days[3], ok.body.days[1]);

    const ex = await api.request('PUT', `/api/schedules/${id}/exceptions/2026-12-31`, { body: { plan: { likeDow: 6 }, note: 'Новий рік' }, headers: ADMIN });
    assert.equal(ex.status, 200);
    assert.deepEqual(ex.body.plan, { likeDow: 6 });
    const list = await api.request('GET', `/api/schedules/${id}/exceptions`);
    assert.equal(list.body.length, 1);
    const removed = await api.request('DELETE', `/api/schedules/${id}/exceptions/2026-12-31`, { headers: ADMIN });
    assert.equal(removed.status, 204);
  });
});

test('history queries default to the last day and refuse more than a month', async () => {
  await withApi({}, async (api) => {
    const res = await api.request('GET', '/api/history?ids=sensor.a,sensor.b');
    assert.equal(res.status, 200);
    const [[q]] = api.calls.of('history.series');
    assert.deepEqual(q.ids, ['sensor.a', 'sensor.b']);
    assert.equal(q.to, NOW);
    assert.equal(q.from, NOW - 86_400_000);
    const long = await api.request('GET', `/api/history?ids=sensor.a&from=${NOW - 40 * 86_400_000}&to=${NOW}`);
    assert.equal(long.status, 400);
    const none = await api.request('GET', '/api/history');
    assert.equal(none.status, 400);
  });
});

test('templates render only while Home Assistant is connected', async () => {
  await withApi({ haConnected: false }, async (api) => {
    // without HA nobody can be confirmed as an admin; the setting opens the route for this check
    api.config.single.settings.adminOnlyConfig = false;
    const res = await api.request('POST', '/api/ha/render-template', { body: { template: '{{ 1 }}' }, headers: ADMIN });
    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'ha_unavailable');
  });
});

test('settings carry the outdoor readout; the house section refreshes it on its own', async () => {
  await withApi({}, async (api) => {
    const all = await api.request('GET', '/api/settings');
    assert.equal(all.status, 200);
    assert.deepEqual(all.body.outdoor, { nowC: null, avg10C: null, avgNC: null, source: 'none', method: 'median', sensors: [] });
    const one = await api.request('GET', '/api/settings/outdoor');
    assert.equal(one.status, 200);
    assert.deepEqual(one.body, all.body.outdoor);
    assert.equal(api.calls.count('inputs.outdoorReadout'), 2);
  });
});

test('control modes over REST: any panel user, by id or slug, validated, idempotent per reqId', async () => {
  await withApi({}, async (api) => {
    let res = await api.request('PUT', '/api/rooms/vitalnia/control', { body: { mode: 'manual', heatC: 22, reqId: 'ctl-1' }, headers: MEMBER });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.control, { mode: 'manual', since: NOW, until: null, setBy: 'ui' });
    const [[roomId, req, actor]] = api.calls.of('roomActions.setControl');
    assert.equal(roomId, 'r_living');
    assert.deepEqual(req, { mode: 'manual', heatC: 22, reqId: 'ctl-1' });
    assert.equal(actor.via, 'ui');
    await api.request('PUT', '/api/rooms/r_living/control', { body: { mode: 'manual', heatC: 22, reqId: 'ctl-1' } });
    assert.equal(api.calls.count('roomActions.setControl'), 1);
    res = await api.request('PUT', '/api/rooms/r_living/control', { body: { mode: 'off', heatC: 22 } });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'validation');
    assert.ok(res.body.issues.some((i) => i.path === 'heatC' && i.code === 'not_allowed'));
    res = await api.request('GET', '/api/rooms/vitalnia/control');
    assert.deepEqual(res.body, { mode: 'schedule', since: null, until: null, setBy: null });
    assert.equal((await api.request('PUT', '/api/rooms/nope/control', { body: { mode: 'manual' } })).status, 404);

    res = await api.request('PUT', '/api/house/control', { body: { mode: 'manual' }, headers: MEMBER });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.control, { mode: 'manual', since: NOW });
    res = await api.request('PUT', '/api/house/control', { body: { mode: 'off' } });
    assert.equal(res.status, 400);
    res = await api.request('GET', '/api/house/control');
    assert.deepEqual(res.body, { mode: 'schedule', since: null });
  });
});
