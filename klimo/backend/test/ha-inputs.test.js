const assert = require('node:assert/strict');
const test = require('node:test');
const { MIN, FakeClock, FakeHa, FakeConfig, Bus, state, iso, settle } = require('./ha-harness');
const { HaInputsService, templateBoolean } = require('../dist/ha/inputs.service');

const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 9, 21, 16, 0); // 19:00 in Kyiv

function setup() {
  const clock = new FakeClock(NOW);
  const ha = new FakeHa();
  const config = new FakeConfig();
  const bus = new Bus();
  config.settings.outdoor = { sensorEntityIds: ['sensor.outdoor'], aggregation: 'median', weatherEntityId: 'weather.home', staleAfterMin: 30, holdMin: 30 };
  const inputs = new HaInputsService(ha, config, clock, bus);
  return { clock, ha, config, bus, inputs };
}

const outdoorAt = (v, at) => state('sensor.outdoor', v, { device_class: 'temperature', unit_of_measurement: '°C' }, at);

test('outdoor: sensor → hold its last value 30 min → weather → none', () => {
  const { clock, ha, inputs } = setup();
  ha.set(outdoorAt('4.2', NOW));
  ha.set(state('weather.home', 'cloudy', { temperature: 41, temperature_unit: '°F' }));
  inputs.onApplicationBootstrap();
  assert.deepEqual(inputs.outdoor(), { nowC: 4.2, avg10C: 4.2, avgNC: null, source: 'sensor' });

  clock.advance(30_000);
  ha.set(outdoorAt('unavailable', clock.now()));
  clock.advance(29 * MIN);
  let o = inputs.outdoor();
  assert.equal(o.source, 'hold');
  assert.equal(o.nowC, 4.2);
  clock.advance(MIN);
  o = inputs.outdoor();
  assert.equal(o.source, 'weather', '30 min after the last good reading');
  assert.equal(o.nowC, 5, '41 °F');

  ha.remove('weather.home');
  assert.deepEqual(inputs.outdoor().source, 'none');
  assert.equal(inputs.outdoor().nowC, null);
  inputs.onModuleDestroy();
});

test('outdoor: a sensor silent longer than staleAfterMin counts as lost', () => {
  const { clock, ha, inputs } = setup();
  ha.set(outdoorAt('3.0', NOW - 31 * MIN));
  ha.set(state('weather.home', 'sunny', { temperature: 6.5, temperature_unit: '°C' }));
  inputs.onApplicationBootstrap();
  assert.equal(inputs.outdoor().source, 'weather');
  ha.set(outdoorAt('3.1', clock.now()));
  assert.equal(inputs.outdoor().source, 'sensor');
  inputs.onModuleDestroy();
});

test('outdoor: 10-min time-weighted mean of the 1-min samples', () => {
  const { clock, ha, inputs } = setup();
  ha.set(outdoorAt('0', NOW));
  inputs.onApplicationBootstrap(); // sample at 0 min: 0
  for (let i = 1; i <= 15; i++) {
    ha.set(outdoorAt(String(i), clock.now() + MIN));
    clock.advance(MIN); // sampled every minute: 1, 2, … 15
  }
  // window [5, 15] min: samples 5…14 hold one minute each → mean 9.5; the 15 sample has no width yet
  const o = inputs.outdoor();
  assert.equal(o.nowC, 15);
  assert.equal(o.avg10C, 9.5);
  inputs.onModuleDestroy();
});

test('outdoor: N-day mean from hourly statistics, else history, else kept', async () => {
  const { ha, config, inputs } = setup();
  config.season = { ...config.season, avgDays: 3 };
  ha.set(outdoorAt('4', NOW));
  ha.statisticsFn = () => ({ 'sensor.outdoor': Array.from({ length: 72 }, (_, i) => ({ start: NOW - (72 - i) * HOUR, mean: i % 2 ? 7 : 6 })) });
  await inputs.refreshAverage();
  assert.equal(inputs.outdoor().avgNC, 6.5);
  // too few hourly means (new install): the time-weighted mean of the raw history
  ha.statisticsFn = () => ({ 'sensor.outdoor': Array.from({ length: 10 }, (_, i) => ({ start: NOW - (10 - i) * HOUR, mean: 1 })) });
  ha.historyFn = () => ({ 'sensor.outdoor': [{ s: '2', lu: (NOW - 72 * HOUR) / 1000 }, { s: '4', lu: (NOW - 36 * HOUR) / 1000 }] });
  await inputs.refreshAverage();
  assert.equal(inputs.outdoor().avgNC, 3);
  ha.statisticsFn = () => {
    throw new Error('recorder down');
  };
  await inputs.refreshAverage();
  assert.equal(inputs.outdoor().avgNC, 3, 'the previous value stays');
});

test('templates: sync keeps exactly the wanted subscriptions; results as booleans', async () => {
  const { ha, inputs } = setup();
  inputs.syncTemplates([
    { key: 'trigger:t1#n1', template: "{{ is_state('binary_sensor.grid', 'off') }}" },
    { key: 'rule:r1#n2', template: '{{ states("sensor.pv") | float(0) > 500 }}' },
  ]);
  await settle();
  assert.equal(ha.templateSubs.length, 2);
  assert.deepEqual(inputs.templateResults()['trigger:t1#n1'], { value: null, error: null }, 'unknown until rendered');
  ha.templateSubs[0].cb(true, null);
  ha.templateSubs[1].cb(null, "UndefinedError: 'pv' is undefined");
  assert.deepEqual(inputs.templateResults(), {
    'trigger:t1#n1': { value: true, error: null },
    'rule:r1#n2': { value: null, error: "UndefinedError: 'pv' is undefined" },
  });

  inputs.syncTemplates([{ key: 'trigger:t1#n1', template: "{{ is_state('binary_sensor.grid', 'on') }}" }]);
  await settle();
  assert.equal(ha.templateSubs[0].active, false, 'changed template re-subscribed');
  assert.equal(ha.templateSubs[1].active, false, 'removed template unsubscribed');
  assert.equal(ha.templateSubs.length, 3);
  assert.deepEqual(Object.keys(inputs.templateResults()), ['trigger:t1#n1']);
  ha.templateSubs[0].cb(true, null); // a late result of the old subscription is ignored
  assert.deepEqual(inputs.templateResults()['trigger:t1#n1'], { value: null, error: null });
  ha.templateSubs[2].cb('off', null);
  assert.deepEqual(inputs.templateResults()['trigger:t1#n1'], { value: false, error: null });
});

test('template results: what counts as true, false, unknown', () => {
  assert.deepEqual(templateBoolean(true), { value: true, error: null });
  assert.deepEqual(templateBoolean(0), { value: false, error: null });
  assert.deepEqual(templateBoolean('True'), { value: true, error: null });
  assert.deepEqual(templateBoolean(' off '), { value: false, error: null });
  assert.deepEqual(templateBoolean('unavailable'), { value: null, error: null });
  assert.deepEqual(templateBoolean('2.5'), { value: true, error: null });
  assert.equal(templateBoolean('maybe').value, null);
  assert.match(templateBoolean('maybe').error, /not a boolean/);
});

test('renderTemplate: first result, then unsubscribed; times out; refuses while HA is down', async () => {
  const { ha, inputs, clock } = setup();
  const p = inputs.renderTemplate('{{ 1 + 1 }}');
  await settle();
  ha.templateSubs[0].cb(2, null);
  assert.deepEqual(await p, { result: 2, error: null });
  assert.equal(ha.templateSubs[0].active, false);

  const slow = inputs.renderTemplate('{{ never }}');
  await settle();
  clock.advance(10_000);
  assert.match((await slow).error, /in time/);

  ha.connected = false;
  assert.match((await inputs.renderTemplate('{{ 1 }}')).error, /not connected/);
});

test('forecasts: daily high/low today and tomorrow from weather.get_forecasts; hourly fallback', async () => {
  const { ha, config, inputs } = setup();
  ha.set(state('weather.home', 'cloudy', { temperature: 6, temperature_unit: '°C' }));
  config.triggers = [{ id: 't1', condition: { op: 'weather', entityId: 'weather.other', field: 'forecast_high_tomorrow', cmp: '>', value: 10 } }];
  ha.set(state('weather.other', 'sunny', { temperature: 50, temperature_unit: '°F' }));
  ha.serviceFn = (domain, service, target, data) => {
    if (domain !== 'weather') return null;
    const id = target.entity_id;
    if (id === 'weather.home' && data.type === 'daily') {
      return { [id]: { forecast: [
        { datetime: '2026-10-21T10:00:00+00:00', temperature: 9.4, templow: 2.1, condition: 'rainy' },
        { datetime: '2026-10-22T10:00:00+00:00', temperature: 11.0, templow: 3.0, condition: 'sunny' },
      ] } };
    }
    if (id === 'weather.other' && data.type === 'daily') throw new Error('not supported');
    if (id === 'weather.other' && data.type === 'hourly') {
      return { [id]: { forecast: [
        { datetime: '2026-10-21T17:00:00+00:00', temperature: 50, condition: 'clear-night' },
        { datetime: '2026-10-21T19:00:00+00:00', temperature: 41 },
        { datetime: '2026-10-22T09:00:00+00:00', temperature: 59 },
      ] } };
    }
    return null;
  };
  await inputs.refreshForecasts();
  assert.deepEqual(inputs.forecasts()['weather.home'], { highToday: 9.4, lowToday: 2.1, highTomorrow: 11, condition: 'rainy' });
  assert.deepEqual(inputs.forecasts()['weather.other'], { highToday: 10, lowToday: 5, highTomorrow: 15, condition: 'clear-night' });
  assert.ok(ha.calls.every((c) => c.returnResponse === true));
});

test('calendars: next 48 h of events of the referenced calendars; all-day events in local time', async () => {
  const { ha, config, inputs } = setup();
  config.activationRules = [{ id: 'ar_1', profileId: 'guests', enabled: true, order: 0, config: { type: 'calendar', calendarEntityId: 'calendar.family', match: { field: 'summary', contains: 'Гості' }, preheatMin: 60 } }];
  ha.serviceFn = (domain, service, target, data) => {
    assert.equal(domain, 'calendar');
    assert.equal(service, 'get_events');
    assert.equal(data.start_date_time, iso(NOW));
    assert.equal(data.end_date_time, iso(NOW + 48 * HOUR));
    return { 'calendar.family': { events: [
      { start: '2026-10-23', end: '2026-10-24', summary: 'Відпустка' },
      { start: '2026-10-21T19:00:00+03:00', end: '2026-10-21T23:30:00+03:00', summary: 'Гості', description: 'вечеря', location: 'дім' },
    ] } };
  };
  await inputs.refreshCalendars();
  assert.deepEqual(inputs.calendarEvents()['calendar.family'], [
    { start: Date.UTC(2026, 9, 21, 16, 0), end: Date.UTC(2026, 9, 21, 20, 30), summary: 'Гості', description: 'вечеря', location: 'дім' },
    { start: Date.UTC(2026, 9, 22, 21, 0), end: Date.UTC(2026, 9, 23, 21, 0), summary: 'Відпустка', description: '', location: '' },
  ]);
});

test('humid hours: hours of the last day with the room mean above 70 %', async () => {
  const { ha, config, inputs } = setup();
  const room = config.addRoom('r_bath', 'Ванна', 'vanna');
  room.humidity = { ...room.humidity, method: 'average' };
  config.addSensor('r_bath', 'sensor.bath_h1', 'humidity');
  config.addSensor('r_bath', 'sensor.bath_h2', 'humidity');
  config.addRoom('r_hall', 'Коридор', 'korydor');
  const hours = (values) => values.map((mean, i) => ({ start: NOW - (values.length - i) * HOUR, mean }));
  ha.statisticsFn = (ids) => {
    assert.deepEqual(ids, ['sensor.bath_h1', 'sensor.bath_h2']);
    return { 'sensor.bath_h1': hours([80, 75, 60, 90]), 'sensor.bath_h2': hours([70, 60, 60, 60]) };
  };
  await inputs.refreshHumidHours();
  // averages 75, 67.5, 60, 75 → two hours above 70 %
  assert.deepEqual(inputs.humidHours24h(), { r_bath: 2, r_hall: null });
});

test('Z2M bridges: the connection entity, overridden by a newer bridge message on the bus', () => {
  const { ha, config, bus, inputs, clock } = setup();
  config.z2m = [
    { id: 'z_1', name: 'Z2M #1', baseTopic: 'zigbee2mqtt', bridgeEntityId: 'binary_sensor.z2m_bridge_connection_state', frontendUrl: null, resendOnRestart: true },
    { id: 'z_2', name: 'Z2M #2', baseTopic: 'zigbee2mqtt_2', bridgeEntityId: null, frontendUrl: null, resendOnRestart: true },
  ];
  ha.set(state('binary_sensor.z2m_bridge_connection_state', 'on', { device_class: 'connectivity' }, NOW - HOUR));
  inputs.onApplicationBootstrap();
  assert.deepEqual(inputs.z2mBridges(), { z_1: true, z_2: null });
  bus.emit('z2m.bridge', { instanceId: 'z_1', online: false });
  bus.emit('z2m.bridge', { instanceId: 'z_2', online: true });
  assert.deepEqual(inputs.z2mBridges(), { z_1: false, z_2: true });
  clock.advance(MIN);
  ha.set(state('binary_sensor.z2m_bridge_connection_state', 'on', { device_class: 'connectivity' }, clock.now()));
  assert.equal(inputs.z2mBridges().z_1, true, 'the newer observation wins');
  inputs.onModuleDestroy();
});

test('refresh on connect and after relevant config changes', async () => {
  const { ha, bus, inputs, clock } = setup();
  ha.set(state('weather.home', 'cloudy', { temperature: 6 }));
  ha.serviceFn = () => ({ 'weather.home': { forecast: [{ datetime: '2026-10-21T10:00:00+00:00', temperature: 9, templow: 2 }] } });
  inputs.onApplicationBootstrap();
  await settle();
  const after = ha.calls.length;
  assert.ok(after >= 1, 'refreshed at start while connected');
  bus.emit('config.changed', { entity: 'trigger', id: 't1', op: 'updated', actor: null, revision: 2 });
  clock.advance(5_000);
  await settle();
  assert.ok(ha.calls.length > after);
  inputs.onModuleDestroy();
});
