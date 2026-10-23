const assert = require('node:assert/strict');
const test = require('node:test');
const { EVENING, advance, fakeHa, settle } = require('./sim-harness');

async function withHa(fn, opts) {
  const h = fakeHa(opts);
  try {
    await fn(h);
  } finally {
    h.dispose();
  }
}

test('registries and states describe the demo house the way HA and Zigbee2MQTT do', () =>
  withHa(async ({ ha }) => {
    const reg = ha.registries();
    assert.deepEqual(reg.areas.map((a) => a.name), ['Вітальня', 'Спальня', 'Дитяча', 'Кабінет', 'Кухня', 'Ванна', 'Коридор', 'Котельня', 'Гараж', 'Склад']);
    const trv = reg.entities.find((e) => e.entity_id === 'climate.living_trv_window');
    assert.match(trv.unique_id, /^0x[0-9a-f]+_climate_zigbee2mqtt$/);
    const ext = reg.entities.find((e) => e.entity_id === 'number.living_trv_window_external_temperature_input');
    assert.match(ext.unique_id, /_external_temperature_input_zigbee2mqtt$/);
    assert.equal(ext.device_id, trv.device_id);
    const device = reg.devices.find((d) => d.id === trv.device_id);
    assert.deepEqual(device.identifiers[0][0], 'mqtt');
    assert.match(device.identifiers[0][1], /^zigbee2mqtt_0x/);
    assert.equal(device.area_id, 'vitalnia');
    const bridge2 = reg.devices.find((d) => d.id === 'dev_zigbee2mqtt_2_bridge');
    assert.equal(reg.devices.find((d) => d.id === 'dev_kids_trv').via_device_id, bridge2.id);
    // three spare devices in the garage, bound nowhere
    assert.equal(reg.devices.filter((d) => d.area_id === 'garazh').length, 3);
    for (const id of ['climate.heat_pump', 'number.boiler_relay_countdown', 'binary_sensor.boiler_flame', 'sensor.outdoor_temperature', 'binary_sensor.grid_offline', 'weather.home', 'sun.sun', 'calendar.family', 'person.ihor', 'zone.home']) {
      assert.ok(ha.getState(id), id);
    }
    assert.equal(ha.config().time_zone, 'Europe/Kyiv');
    const users = await ha.authUsers();
    assert.deepEqual(users.filter((u) => !u.system_generated).map((u) => [u.name, u.is_admin]), [['Ігор', true], ['Оля', false]]);
  }));

test('a service call returns a context id that the resulting state change carries', () =>
  withHa(async ({ ha, clock }) => {
    const changes = [];
    ha.onStateChanged((id, next) => changes.push([id, next]));
    const res = await ha.callService('climate', 'set_temperature', { entity_id: 'climate.living_trv_window' }, { temperature: 20.5 });
    assert.match(res.context.id, /^[0-9A-Z]{26}$/);
    // a Zigbee head needs a few seconds
    await advance(clock, 500);
    assert.notEqual(ha.getState('climate.living_trv_window').attributes.temperature, 20.5);
    await advance(clock, 5_000);
    const s = ha.getState('climate.living_trv_window');
    assert.equal(s.attributes.temperature, 20.5);
    assert.equal(s.context.id, res.context.id);
    assert.ok(changes.some(([id, next]) => id === 'climate.living_trv_window' && next.context.id === res.context.id));
    // relays switch in half a second
    const r = await ha.callService('switch', 'turn_on', { entity_id: 'switch.radiator_pump' });
    await advance(clock, 600);
    assert.equal(ha.getState('switch.radiator_pump').state, 'on');
    assert.equal(ha.getState('switch.radiator_pump').context.id, r.context.id);
  }));

test('every call is announced as a call_service event with the caller', () =>
  withHa(async ({ ha }) => {
    const events = [];
    ha.onEvent((type, data, ctx) => events.push({ type, data, ctx }));
    await ha.callServiceAs('u_olia', 'switch', 'turn_off', { entity_id: 'switch.study_heater' });
    const e = events.find((x) => x.type === 'call_service');
    assert.deepEqual(e.data, { domain: 'switch', service: 'turn_off', service_data: { entity_id: 'switch.study_heater' } });
    assert.equal(e.ctx.user_id, 'u_olia');
    await assert.rejects(ha.callService('climate', 'set_temperature', { entity_id: 'climate.nope' }, { temperature: 20 }), /not found/);
    await assert.rejects(ha.callService('number', 'set_value', { entity_id: 'number.floor_mixing_valve' }, { value: 99 }), /outside valid range/);
  }));

test('faults: unavailable devices, dropped writes, a weak link, a hand-turned knob, an error code', () =>
  withHa(async ({ ha, clock }) => {
    ha.fault({ entityId: 'climate.heat_pump', kind: 'unavailable' }, clock.now());
    assert.equal(ha.getState('climate.heat_pump').state, 'unavailable');
    assert.equal(ha.getState('sensor.heat_pump_supply').state, 'unavailable');
    ha.fault({ entityId: 'climate.heat_pump', kind: 'clear' }, clock.now());
    assert.equal(ha.getState('climate.heat_pump').state, 'off');

    ha.fault({ entityId: 'climate.bedroom_trv', kind: 'no_ack' }, clock.now());
    await ha.callService('climate', 'set_temperature', { entity_id: 'climate.bedroom_trv' }, { temperature: 25 });
    await advance(clock, 6_000);
    assert.notEqual(ha.getState('climate.bedroom_trv').attributes.temperature, 25);

    // LQI 54: about a third of the commands never arrive
    let applied = 0;
    for (let i = 0; i < 60; i++) {
      await ha.callService('climate', 'set_temperature', { entity_id: 'climate.bathroom_towel_trv' }, { temperature: 20 + (i % 2) * 0.5 });
      const before = ha.getState('climate.bathroom_towel_trv').context.id;
      await advance(clock, 5_000);
      if (ha.getState('climate.bathroom_towel_trv').context.id !== before) applied++;
    }
    assert.ok(applied > 25 && applied < 55, `${applied} of 60 arrived`);

    const knobCtx = [];
    ha.onStateChanged((id, next) => id === 'climate.study_trv' && knobCtx.push(next.context));
    ha.fault({ entityId: 'climate.study_trv', kind: 'knob', value: 23 }, clock.now());
    assert.equal(ha.getState('climate.study_trv').attributes.temperature, 23);
    assert.deepEqual([knobCtx[0].user_id, knobCtx[0].parent_id], [null, null]);

    ha.fault({ entityId: 'climate.heat_pump', kind: 'error_code', value: 'E3' }, clock.now());
    assert.equal(ha.getState('sensor.heat_pump_error_code').state, 'E3');

    ha.fault({ entityId: 'sensor.hall_temperature', kind: 'battery', value: 4 }, clock.now());
    assert.equal(ha.getState('sensor.hall_battery').state, '4');
    assert.throws(() => ha.fault({ entityId: 'sensor.unknown_thing', kind: 'stale' }, clock.now()), /no simulated device/);
  }));

test('the boiler relay countdown drops the relay when nobody re-arms it', () =>
  withHa(async ({ ha, clock }) => {
    await ha.callService('switch', 'turn_on', { entity_id: 'switch.boiler_relay' });
    await ha.callService('number', 'set_value', { entity_id: 'number.boiler_relay_countdown' }, { value: 15 });
    await advance(clock, 1_000);
    const tick = (minutes) => {
      for (let i = 0; i < minutes; i++) ha.tickCountdown(clock.now() + (i + 1) * 60_000);
    };
    ha.tickCountdown(clock.now());
    tick(5);
    assert.equal(ha.getState('number.boiler_relay_countdown').state, '10');
    assert.equal(ha.getState('switch.boiler_relay').state, 'on');
    // Klimo re-arms it every five minutes …
    await ha.callService('number', 'set_value', { entity_id: 'number.boiler_relay_countdown' }, { value: 15 });
    await advance(clock, 1_000);
    const base = clock.now();
    ha.tickCountdown(base);
    // … and when it stops, the relay switches itself off at zero
    for (let i = 1; i <= 14; i++) ha.tickCountdown(base + i * 60_000);
    assert.equal(ha.getState('switch.boiler_relay').state, 'on');
    ha.tickCountdown(base + 15 * 60_000 + 1);
    assert.equal(ha.getState('switch.boiler_relay').state, 'off');
    assert.equal(ha.getState('number.boiler_relay_countdown').state, '0');
  }));

const DEVICE = { identifiers: ['klimo'], name: 'Klimo', manufacturer: 'Klimo', model: 'Climate add-on', sw_version: '0.1.0' };

function climateConfig() {
  const state = 'klimo/room/r_living/state';
  return {
    unique_id: 'klimo_r_living_climate',
    default_entity_id: 'climate.klimo_vitalnia',
    has_entity_name: true,
    name: 'Вітальня',
    device: DEVICE,
    availability_topic: 'klimo/status',
    modes: ['off', 'auto', 'heat'],
    mode_state_topic: state,
    mode_state_template: '{{ value_json.mode }}',
    mode_command_topic: 'klimo/room/r_living/mode/set',
    current_temperature_topic: state,
    current_temperature_template: '{{ value_json.cur }}',
    temperature_state_topic: state,
    temperature_state_template: '{{ value_json.t }}',
    temperature_command_topic: 'klimo/room/r_living/temp/set',
    action_topic: state,
    action_template: '{{ value_json.action }}',
    preset_modes: ['Дома', 'Ніч'],
    preset_mode_state_topic: state,
    preset_mode_value_template: '{{ value_json.preset }}',
    preset_mode_command_topic: 'klimo/room/r_living/preset/set',
    min_temp: 5,
    max_temp: 30,
    temp_step: 0.5,
    json_attributes_topic: state,
    json_attributes_template: '{{ value_json.attrs | tojson }}',
  };
}

test('MQTT discovery creates Klimo entities whose state follows their state topics', () =>
  withHa(async ({ ha, mqtt }) => {
    const received = [];
    mqtt.onMessage((topic, payload) => received.push([topic, payload]));
    await mqtt.subscribe(['klimo/room/+/+/set']);
    await mqtt.publish('klimo/status', 'online', { retain: true, qos: 1 });
    await mqtt.publish('klimo/room/r_living/state', JSON.stringify({ mode: 'auto', action: 'heating', cur: 19.8, t: 20, preset: 'Дома', heat: 'ON', attrs: { room_id: 'r_living', state: 'heat' } }), { retain: true, qos: 0 });
    await mqtt.publish('homeassistant/climate/klimo_r_living/config', JSON.stringify(climateConfig()), { retain: true, qos: 1 });
    await mqtt.publish(
      'homeassistant/binary_sensor/klimo_r_living_heat/config',
      JSON.stringify({ unique_id: 'klimo_r_living_heat_demand', default_entity_id: 'binary_sensor.klimo_vitalnia_heat_demand', has_entity_name: true, name: 'Вітальня запит тепла', device: DEVICE, availability_topic: 'klimo/status', device_class: 'heat', state_topic: 'klimo/room/r_living/state', value_template: '{{ value_json.heat }}' }),
      { retain: true, qos: 1 },
    );
    await settle();

    const c = ha.getState('climate.klimo_vitalnia');
    assert.equal(c.state, 'auto');
    assert.equal(c.attributes.current_temperature, 19.8);
    assert.equal(c.attributes.temperature, 20);
    assert.equal(c.attributes.hvac_action, 'heating');
    assert.equal(c.attributes.preset_mode, 'Дома');
    assert.deepEqual(c.attributes.hvac_modes, ['off', 'auto', 'heat']);
    assert.equal(c.attributes.room_id, 'r_living');
    assert.equal(c.attributes.friendly_name, 'Klimo Вітальня');
    assert.equal(ha.getState('binary_sensor.klimo_vitalnia_heat_demand').state, 'on');
    const reg = ha.registries().entities.find((e) => e.entity_id === 'climate.klimo_vitalnia');
    assert.deepEqual([reg.platform, reg.unique_id], ['mqtt', 'klimo_r_living_climate']);

    // a thermostat change in HA reaches Klimo's command topic, and the call is attributed
    const calls = [];
    ha.onEvent((type, data, ctx) => type === 'call_service' && calls.push(ctx));
    await ha.callServiceAs('u_ihor', 'climate', 'set_temperature', { entity_id: 'climate.klimo_vitalnia', temperature: 21.5 });
    await settle();
    assert.deepEqual(received.find(([t]) => t === 'klimo/room/r_living/temp/set'), ['klimo/room/r_living/temp/set', '21.5']);
    assert.equal(calls[0].user_id, 'u_ihor');

    // Klimo going offline makes its entities unavailable; an empty config removes them
    await mqtt.publish('klimo/status', 'offline', { retain: true, qos: 1 });
    await settle();
    assert.equal(ha.getState('climate.klimo_vitalnia').state, 'unavailable');
    await mqtt.publish('homeassistant/climate/klimo_r_living/config', '', { retain: true, qos: 1 });
    await settle();
    assert.equal(ha.getState('climate.klimo_vitalnia'), undefined);
    assert.ok(!ha.registries().entities.some((e) => e.entity_id === 'climate.klimo_vitalnia'));
  }));

test('mqtt.publish from a card lands on klimo/command with the caller in the call_service event', () =>
  withHa(async ({ ha, mqtt }) => {
    const received = [];
    mqtt.onMessage((topic, payload) => received.push([topic, payload]));
    await mqtt.subscribe(['klimo/command']);
    const events = [];
    ha.onEvent((type, data, ctx) => events.push({ type, data, ctx }));
    const payload = JSON.stringify({ action: 'room.boost', roomId: 'r_living', reqId: 'abc' });
    await ha.callServiceAs('u_ihor', 'mqtt', 'publish', { topic: 'klimo/command', payload });
    await settle();
    assert.deepEqual(received, [['klimo/command', payload]]);
    assert.deepEqual(events[0].data.service_data, { topic: 'klimo/command', payload });
    assert.equal(events[0].ctx.user_id, 'u_ihor');
  }));

test('template subscriptions re-render when an entity they read changes', () =>
  withHa(async ({ ha, clock }) => {
    const results = [];
    await ha.subscribeTemplate("{{ states('sensor.pv_power') | float(0) - states('sensor.house_load') | float(0) > 1500 }}", {}, (r, e) => results.push([r, e]));
    const errors = [];
    await ha.subscribeTemplate('{{ now() }}', {}, (r, e) => errors.push(e));
    await settle();
    assert.deepEqual(results, [[false, null]]);
    ha.report('sensor.pv_power', '5200', null, clock.now());
    ha.report('sensor.house_load', '700', null, clock.now());
    await settle();
    assert.deepEqual(results.at(-1), [true, null]);
    ha.report('sensor.outdoor_temperature', '3.9', null, clock.now());
    await settle();
    assert.equal(results.length, 2, 'unrelated changes do not re-render');
    assert.match(errors[0], /not a supported function/);
  }));

test('the recorder answers history and compiles statistics from what changed', () =>
  withHa(async ({ ha, clock }) => {
    const t0 = EVENING;
    for (let i = 0; i < 36; i++) ha.report('sensor.outdoor_temperature', (4 + (i % 2)).toFixed(1), null, t0 + i * 10 * 60_000);
    clock.jumpTo(t0 + 7 * 3_600_000);
    const hist = await ha.history(['sensor.outdoor_temperature'], t0 + 60 * 60_000, t0 + 2 * 3_600_000, { minimal: true, noAttributes: true });
    const rows = hist['sensor.outdoor_temperature'];
    assert.equal(rows[0].lu, (t0 + 60 * 60_000) / 1000);
    assert.equal(rows.length, 7);
    const stats = await ha.statistics(['sensor.outdoor_temperature'], t0, t0 + 6 * 3_600_000, 'hour', ['mean', 'min', 'max']);
    const hour = stats['sensor.outdoor_temperature'];
    assert.ok(hour.length >= 5);
    const full = hour.find((h) => h.start >= t0);
    assert.ok(full.mean > 4.3 && full.mean < 4.7, `mean ${full.mean}`);
    assert.deepEqual([full.min, full.max], [4, 5]);
    // a contact sensor has no state class: no statistics
    assert.deepEqual(await ha.statistics(['binary_sensor.bedroom_window'], t0, t0 + 3_600_000, 'hour', ['mean']), {});
  }));

test('Zigbee2MQTT bridges announce their devices; a bridge restart takes its devices offline and back', () =>
  withHa(async ({ ha, mqtt, clock }) => {
    await ha.announceZigbee();
    await settle();
    const state = mqtt.retained('+/bridge/state');
    assert.deepEqual(state.map((x) => [x.topic, JSON.parse(x.payload).state]).sort(), [['zigbee2mqtt/bridge/state', 'online'], ['zigbee2mqtt_2/bridge/state', 'online']]);
    const devices = JSON.parse(mqtt.retained('zigbee2mqtt_2/bridge/devices')[0].payload);
    const towel = devices.find((d) => d.friendly_name === 'bathroom_towel_trv');
    assert.equal(towel.definition.model, 'TRVZB');
    assert.ok(towel.definition.exposes.some((e) => e.property === 'external_temperature_input'));

    ha.fault({ entityId: 'binary_sensor.zigbee2mqtt_2_bridge_connection_state', kind: 'unavailable', value: 'restart' }, clock.now());
    await settle();
    assert.equal(ha.getState('climate.kids_trv').state, 'unavailable');
    assert.equal(ha.getState('climate.living_trv_window').state, 'heat', 'the other instance is unaffected');
    assert.equal(JSON.parse(mqtt.retained('zigbee2mqtt_2/bridge/state')[0].payload).state, 'offline');
    await advance(clock, 31_000);
    assert.equal(ha.getState('climate.kids_trv').state, 'heat');
    assert.equal(ha.getState('binary_sensor.zigbee2mqtt_2_bridge_connection_state').state, 'on');
  }));
