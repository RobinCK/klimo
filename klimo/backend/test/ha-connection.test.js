const assert = require('node:assert/strict');
const test = require('node:test');
const { FakeClock, TestHaService, Bus, state, settle } = require('./ha-harness');

function connect(opts = {}) {
  const clock = new FakeClock(Date.UTC(2026, 9, 21, 16, 0), 'UTC');
  const bus = new Bus();
  const ha = new TestHaService(clock, bus);
  const busEvents = [];
  bus.on('ha.connection', (e) => busEvents.push(e.connected));
  const conn = [];
  ha.onConnection((ok) => conn.push(ok));
  ha.start('ws://ha.test/api/websocket', opts.token ?? 'secret');
  if (opts.states) ha.server.states = opts.states;
  return { clock, bus, ha, conn, busEvents };
}

const subId = (server, eventType) => server.log.find((m) => m.type === 'subscribe_events' && m.event_type === eventType)?.id;

test('ready sequence: subscribe first, then states, config, registries, events', async () => {
  const { ha, conn, busEvents, clock } = connect({ states: [state('sensor.a', 21)] });
  await settle();
  assert.equal(ha.connected, true);
  assert.deepEqual(conn, [true]);
  assert.deepEqual(busEvents, [true]);
  const order = ha.server.log.map((m) => (m.type === 'subscribe_events' ? `sub:${m.event_type}` : m.type));
  assert.deepEqual(order.slice(0, 7), [
    'auth',
    'sub:state_changed',
    'get_states',
    'get_config',
    'config/entity_registry/list',
    'config/device_registry/list',
    'config/area_registry/list',
  ]);
  for (const t of ['entity_registry_updated', 'device_registry_updated', 'area_registry_updated', 'call_service', 'homeassistant_started', 'mobile_app_notification_action', 'telegram_callback']) {
    assert.ok(order.includes(`sub:${t}`), `subscribed to ${t}`);
  }
  assert.equal(ha.getState('sensor.a').state, '21');
  assert.equal(clock.tz(), 'Europe/Kyiv', 'the clock follows the HA time zone');
  assert.equal(ha.config().unit_system.temperature, '°C');
  ha.stop();
});

test('state cache follows state_changed; a removed entity is deleted', async () => {
  const { ha } = connect({ states: [state('sensor.a', 21)] });
  await settle();
  const seen = [];
  ha.onStateChanged((id, next, prev) => seen.push([id, next?.state ?? null, prev?.state ?? null]));
  const sub = subId(ha.server, 'state_changed');
  ha.server.event(sub, { event_type: 'state_changed', data: { entity_id: 'sensor.a', new_state: state('sensor.a', 22), old_state: state('sensor.a', 21) }, context: { id: 'x' } });
  ha.server.event(sub, { event_type: 'state_changed', data: { entity_id: 'sensor.b', new_state: state('sensor.b', 'on'), old_state: null }, context: { id: 'y' } });
  await settle();
  assert.equal(ha.getState('sensor.a').state, '22');
  ha.server.event(sub, { event_type: 'state_changed', data: { entity_id: 'sensor.a', new_state: null, old_state: state('sensor.a', 22) }, context: { id: 'z' } });
  await settle();
  assert.equal(ha.getState('sensor.a'), undefined);
  assert.deepEqual(seen, [
    ['sensor.a', '22', '21'],
    ['sensor.b', 'on', null],
    ['sensor.a', null, '22'],
  ]);
  ha.stop();
});

test('non-state events reach onEvent with their context', async () => {
  const { ha } = connect();
  await settle();
  const got = [];
  ha.onEvent((type, data, ctx) => got.push({ type, data, ctx }));
  ha.server.event(subId(ha.server, 'call_service'), {
    event_type: 'call_service',
    data: { domain: 'climate', service: 'set_temperature', service_data: { entity_id: 'climate.klimo_vitalnia', temperature: 21 } },
    context: { id: 'ctx1', user_id: 'u1', parent_id: null },
  });
  await settle();
  assert.equal(got.length, 1);
  assert.equal(got[0].type, 'call_service');
  assert.deepEqual(got[0].ctx, { id: 'ctx1', user_id: 'u1', parent_id: null });
  ha.stop();
});

test('registry events trigger a debounced refetch and onRegistriesUpdated', async () => {
  const { ha, clock } = connect();
  await settle();
  let updated = 0;
  ha.onRegistriesUpdated(() => updated++);
  ha.server.answer['config/area_registry/list'] = [{ area_id: 'living_room', name: 'Вітальня' }];
  const sub = subId(ha.server, 'area_registry_updated');
  ha.server.event(sub, { event_type: 'area_registry_updated', data: { action: 'create', area_id: 'living_room' } });
  ha.server.event(sub, { event_type: 'area_registry_updated', data: { action: 'update', area_id: 'living_room' } });
  await settle();
  clock.advance(1_999);
  await settle();
  assert.equal(updated, 0);
  clock.advance(1);
  await settle();
  assert.equal(updated, 1, 'two events, one refetch');
  assert.deepEqual(ha.registries().areas, [{ area_id: 'living_room', name: 'Вітальня' }]);
  ha.stop();
});

test('reconnect re-subscribes events and templates; an unsubscribed template stays gone', async () => {
  const { ha, clock, conn } = connect();
  await settle();
  const results = [];
  const unsub1 = await ha.subscribeTemplate("{{ is_state('binary_sensor.grid', 'off') }}", {}, (r, e) => results.push(['a', r, e]));
  const unsub2 = await ha.subscribeTemplate('{{ 1 }}', {}, (r, e) => results.push(['b', r, e]));
  await ha.subscribeEvents('klimo_test_event');
  const first = ha.server;
  const tplId = first.sent('render_template')[0].id;
  assert.deepEqual(first.sent('render_template')[0].report_errors, true);
  first.event(tplId, { result: true, listeners: {} });
  await settle();
  assert.deepEqual(results, [['a', true, null]]);
  unsub2();
  await settle();
  assert.equal(first.sent('unsubscribe_events').length, 1);

  first.drop();
  await settle();
  assert.equal(ha.connected, false);
  assert.deepEqual(conn, [true, false]);
  clock.advance(1_000); // first back-off step
  await settle();
  const second = ha.server;
  assert.notEqual(second, first);
  assert.equal(ha.connected, true);
  assert.equal(second.sent('render_template').length, 1, 'only the live template is re-created');
  assert.ok(second.sent('subscribe_events').some((m) => m.event_type === 'klimo_test_event'));
  second.event(second.sent('render_template')[0].id, { result: false, listeners: {} });
  second.event(second.sent('render_template')[0].id, { error: "UndefinedError: 'x' is undefined", level: 'ERROR' });
  await settle();
  assert.deepEqual(results.slice(1), [['a', false, null], ['a', null, "UndefinedError: 'x' is undefined"]]);
  unsub1();
  ha.stop();
});

test('a template that does not compile reports its error', async () => {
  const { ha } = connect();
  await settle();
  ha.server.answer.render_template = { __error: { code: 'template_error', message: 'unexpected end of template' } };
  const got = [];
  await ha.subscribeTemplate('{{ states(', {}, (r, e) => got.push([r, e]));
  assert.deepEqual(got, [[null, 'unexpected end of template']]);
  ha.stop();
});

test('requests time out after 15 s; pending requests fail when the socket closes', async () => {
  const { ha, clock } = connect();
  await settle();
  ha.server.silent.add('get_services');
  const slow = ha.services();
  clock.advance(15_000);
  await assert.rejects(slow, /within 15 s/);
  const cut = assert.rejects(ha.services(), /connection closed/);
  ha.server.drop();
  await settle();
  await cut;
  await assert.rejects(ha.callService('switch', 'turn_on', { entity_id: 'switch.x' }), /not connected/);
  ha.stop();
});

test('heartbeat: a missing pong closes the half-open connection', async () => {
  const { ha, clock, conn } = connect();
  await settle();
  clock.advance(30_000);
  await settle();
  assert.equal(ha.server.sent('ping').length, 1);
  assert.equal(ha.connected, true, 'pong received');
  ha.server.silent.add('ping');
  clock.advance(30_000);
  await settle();
  clock.advance(9_999);
  await settle();
  assert.equal(ha.connected, true);
  clock.advance(1);
  await settle();
  assert.equal(ha.connected, false);
  assert.deepEqual(conn, [true, false]);
  ha.stop();
});

test('back-off 1, 2, 5 s; reset after 60 s connected', async () => {
  const { ha, clock } = connect();
  await settle();
  const sockets = () => ha.sockets;
  ha.server.drop();
  await settle();
  clock.advance(999);
  assert.equal(sockets(), 1);
  clock.advance(1); // 1 s
  assert.equal(sockets(), 2);
  ha.server.drop(); // fails before auth
  await settle();
  clock.advance(1_999);
  assert.equal(sockets(), 2);
  clock.advance(1); // 2 s
  assert.equal(sockets(), 3);
  ha.server.drop();
  await settle();
  clock.advance(4_999);
  assert.equal(sockets(), 3);
  clock.advance(1); // 5 s
  assert.equal(sockets(), 4);
  await settle();
  assert.equal(ha.connected, true);
  clock.advance(60_000); // stable: the next loss starts again at 1 s
  await settle();
  ha.server.drop();
  await settle();
  clock.advance(1_000);
  assert.equal(sockets(), 5);
  ha.stop();
});

test('auth_invalid: logged, retried every 60 s', async () => {
  const { ha, clock } = connect({ token: 'wrong' });
  await settle();
  assert.equal(ha.connected, false);
  assert.equal(ha.sockets, 1);
  clock.advance(59_999);
  assert.equal(ha.sockets, 1);
  clock.advance(1);
  assert.equal(ha.sockets, 2);
  ha.stop();
});

test('callService returns the context id; return_response only when asked', async () => {
  const { ha } = connect();
  await settle();
  ha.server.answer.call_service = (msg) => ({ context: { id: `ctx-${msg.service}`, parent_id: null, user_id: null }, response: msg.return_response ? { 'weather.home': { forecast: [] } } : null });
  const plain = await ha.callService('climate', 'set_temperature', { entity_id: 'climate.trv' }, { temperature: 21 });
  assert.deepEqual(plain, { context: { id: 'ctx-set_temperature' }, response: null });
  const sent = ha.server.sent('call_service')[0];
  assert.deepEqual(sent.target, { entity_id: 'climate.trv' });
  assert.deepEqual(sent.service_data, { temperature: 21 });
  assert.equal('return_response' in sent, false);
  const withResponse = await ha.callService('weather', 'get_forecasts', { entity_id: 'weather.home' }, { type: 'daily' }, true);
  assert.deepEqual(withResponse.response, { 'weather.home': { forecast: [] } });
  assert.equal(ha.server.sent('call_service')[1].return_response, true);
  ha.stop();
});

test('recorder calls: history passes the flags, statistics asks for °C and normalises times', async () => {
  const { ha } = connect();
  await settle();
  ha.server.answer['history/history_during_period'] = { 'sensor.t': [{ s: '20.5', a: { unit_of_measurement: '°C' }, lu: 1761062400.5 }, { s: '21', lu: 1761062460 }] };
  ha.server.answer['recorder/statistics_during_period'] = { 'sensor.t': [{ start: '2026-10-21T12:00:00+00:00', end: 0, mean: 20.4 }, { start: 1761051600000, mean: 20.6, min: 20, max: 21 }] };
  const h = await ha.history(['sensor.t'], 0, 1000, { minimal: true, noAttributes: true });
  const hq = ha.server.sent('history/history_during_period')[0];
  assert.equal(hq.minimal_response, true);
  assert.equal(hq.no_attributes, true);
  assert.equal(hq.significant_changes_only, false);
  assert.deepEqual(h['sensor.t'][1], { s: '21', lu: 1761062460 });
  const s = await ha.statistics(['sensor.t'], 0, 1000, 'hour', ['mean']);
  assert.deepEqual(ha.server.sent('recorder/statistics_during_period')[0].units, { temperature: '°C' });
  assert.equal(s['sensor.t'][0].start, Date.parse('2026-10-21T12:00:00+00:00'));
  assert.equal(s['sensor.t'][1].max, 21);
  ha.stop();
});

test('auth users: admin from the flag, the owner or the admin group; cached 5 min', async () => {
  const { ha, clock } = connect();
  await settle();
  ha.server.answer['config/auth/list'] = [
    { id: 'u1', name: 'Ігор', is_owner: true, group_ids: ['system-admin'], system_generated: false },
    { id: 'u2', name: 'Оля', is_owner: false, group_ids: ['system-users'], system_generated: false },
    { id: 'u3', name: 'Supervisor', is_owner: false, group_ids: ['system-admin'], system_generated: true },
  ];
  const users = await ha.authUsers();
  assert.deepEqual(users.map((u) => [u.id, u.is_admin, u.system_generated]), [['u1', true, false], ['u2', false, false], ['u3', true, true]]);
  await ha.authUsers();
  assert.equal(ha.server.sent('config/auth/list').length, 1);
  // in heartbeat-sized steps so the fake server can answer the pings
  for (let i = 0; i < 10; i++) {
    clock.advance(30_000);
    await settle();
  }
  await ha.authUsers();
  assert.equal(ha.server.sent('config/auth/list').length, 2);
  ha.stop();
});

test('lovelace resource: exists, updated with a new version, created, unsupported in YAML mode', async () => {
  const { ha } = connect();
  await settle();
  let resources = [{ id: 'r1', type: 'module', url: '/klimo/card/klimo-cards.js?v=0.1.0' }];
  ha.server.answer['lovelace/resources'] = () => resources;
  ha.server.answer['lovelace/resources/update'] = (m) => (resources = [{ id: m.resource_id, type: 'module', url: m.url }]);
  assert.equal(await ha.ensureLovelaceResource('/klimo/card/klimo-cards.js?v=0.1.0'), 'exists');
  assert.equal(await ha.ensureLovelaceResource('/klimo/card/klimo-cards.js?v=0.2.0'), 'updated');
  assert.equal(ha.server.sent('lovelace/resources/update')[0].resource_id, 'r1');
  resources = [];
  assert.equal(await ha.ensureLovelaceResource('/klimo/card/klimo-cards.js?v=0.2.0'), 'created');
  ha.server.answer['lovelace/resources/create'] = { __error: { code: 'unknown_command', message: 'YAML mode' } };
  assert.equal(await ha.ensureLovelaceResource('/other.js'), 'unsupported');
  ha.stop();
});

test('lovelace resource: a timeout or an HA error is an error, only a missing command means YAML mode', async () => {
  const { ha, clock } = connect();
  await settle();
  ha.server.silent.add('lovelace/resources');
  const slow = ha.ensureLovelaceResource('/local/klimo-cards.js?v=1');
  clock.advance(15_000);
  await assert.rejects(slow, /within 15 s/);
  ha.server.silent.delete('lovelace/resources');
  ha.server.answer['lovelace/resources'] = () => [];
  ha.server.answer['lovelace/resources/create'] = { __error: { code: 'unauthorized', message: 'Unauthorized' } };
  await assert.rejects(ha.ensureLovelaceResource('/local/klimo-cards.js?v=1'), (e) => e.code === 'unauthorized');
  ha.server.answer['lovelace/resources/create'] = { __error: { code: 'unknown_command', message: 'Unknown command.' } };
  assert.equal(await ha.ensureLovelaceResource('/local/klimo-cards.js?v=1'), 'unsupported');
  ha.stop();
});
