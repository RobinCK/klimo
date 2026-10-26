const assert = require('node:assert/strict');
const test = require('node:test');
const { FakeHa, FakeConfig, state } = require('./ha-harness');
const { RegistryService } = require('../dist/ha/registry.service');
const { EntitySearchService } = require('../dist/ha/entity-search.service');
const { matchScore, fold, searchKey } = require('../dist/ha/search-text');

const IEEE_TRV = '0x00124b0029aabbcc';
const IEEE_TH = '0x00124b0029000001';
const IEEE_WIN = '0x00124b0029000002';

function dev(id, name, area, model, identifiers, extra = {}) {
  return { id, name, name_by_user: null, area_id: area, model, manufacturer: extra.manufacturer ?? null, identifiers, via_device_id: extra.via ?? null };
}

function ent(entity_id, device_id, extra = {}) {
  return {
    entity_id,
    device_id,
    area_id: extra.area ?? null,
    platform: extra.platform ?? 'mqtt',
    unique_id: extra.unique ?? null,
    disabled_by: extra.disabled ?? null,
    hidden_by: extra.hidden ?? null,
    original_name: null,
    name: null,
    entity_category: extra.category ?? null,
  };
}

/** A small house: a Zigbee TRV with its siblings, a combined T/H sensor, a window, an AC, a plug. */
function house() {
  const ha = new FakeHa();
  const config = new FakeConfig();
  config.z2m = [{ id: 'z_1', name: 'Z2M #1', baseTopic: 'zigbee2mqtt', frontendUrl: null, bridgeEntityId: null, resendOnRestart: true }];
  const z2m = (ieee) => [['mqtt', `zigbee2mqtt_${ieee}`]];
  ha.regs = {
    areas: [
      { area_id: 'living_room', name: 'Вітальня' },
      { area_id: 'bedroom', name: 'Спальня' },
      { area_id: 'garage', name: 'Гараж' },
    ],
    devices: [
      dev('d_trv', 'Радіатор під вікном', 'living_room', 'Zigbee thermostatic radiator valve (TRVZB)', z2m(IEEE_TRV), { manufacturer: 'SONOFF' }),
      dev('d_th', 'Над диваном', 'living_room', 'Temperature and humidity sensor (SNZB-02D)', z2m(IEEE_TH)),
      dev('d_win', 'Вікно', 'living_room', 'Contact sensor (SNZB-04)', z2m(IEEE_WIN)),
      dev('d_ac', 'Кондиціонер', 'bedroom', 'MSAG-09', [['midea_ac_lan', '1234']]),
      dev('d_plug', 'Розетка біля ліжка', 'bedroom', 'Smart plug', [['tuya', 'abc']]),
      dev('d_klimo', 'Klimo', null, 'Climate add-on', [['mqtt', 'klimo']]),
      dev('d_phone', 'Pixel 7', null, 'Pixel 7', [['mobile_app', 'p7']]),
    ],
    entities: [
      ent('climate.living_trv', 'd_trv', { unique: `${IEEE_TRV}_climate_zigbee2mqtt` }),
      // renamed by the user: matched by its Zigbee2MQTT property in the unique id
      ent('number.radiator_ext', 'd_trv', { unique: `${IEEE_TRV}_external_temperature_input_zigbee2mqtt`, category: 'config' }),
      ent('select.living_trv_temperature_sensor_select', 'd_trv', { unique: `${IEEE_TRV}_temperature_sensor_select_zigbee2mqtt`, category: 'config' }),
      ent('switch.living_trv_child_lock', 'd_trv', { unique: `${IEEE_TRV}_child_lock_zigbee2mqtt`, category: 'config' }),
      ent('switch.living_trv_window_detection', 'd_trv', { unique: `${IEEE_TRV}_window_detection_zigbee2mqtt`, category: 'config' }),
      ent('number.living_trv_valve_opening_degree', 'd_trv', { unique: `${IEEE_TRV}_valve_opening_degree_zigbee2mqtt`, category: 'config' }),
      ent('number.living_trv_valve_closing_degree', 'd_trv', { unique: `${IEEE_TRV}_valve_closing_degree_zigbee2mqtt`, category: 'config' }),
      ent('sensor.living_trv_battery', 'd_trv', { unique: `${IEEE_TRV}_battery_zigbee2mqtt`, category: 'diagnostic' }),
      ent('sensor.living_trv_linkquality', 'd_trv', { unique: `${IEEE_TRV}_linkquality_zigbee2mqtt`, category: 'diagnostic' }),
      ent('sensor.living_temperature', 'd_th', { unique: `${IEEE_TH}_temperature_zigbee2mqtt` }),
      ent('sensor.living_humidity', 'd_th', { unique: `${IEEE_TH}_humidity_zigbee2mqtt` }),
      ent('sensor.living_th_linkquality', 'd_th', { unique: `${IEEE_TH}_linkquality_zigbee2mqtt`, category: 'diagnostic' }),
      ent('binary_sensor.living_window', 'd_win', { unique: `${IEEE_WIN}_contact_zigbee2mqtt` }),
      ent('climate.bedroom_ac', 'd_ac', { platform: 'midea_ac_lan', unique: 'ac1' }),
      ent('sensor.bedroom_ac_power', 'd_ac', { platform: 'midea_ac_lan', unique: 'ac1p' }),
      ent('switch.bedroom_plug', 'd_plug', { platform: 'tuya', unique: 'p1' }),
      ent('sensor.bedroom_plug_power', 'd_plug', { platform: 'tuya', unique: 'p1w' }),
      ent('sensor.bedroom_temperature', null, { platform: 'template', unique: 't1', area: 'bedroom' }),
      ent('climate.klimo_vitalnia', 'd_klimo', { unique: 'klimo_r_liv_climate' }),
      ent('sensor.garage_temperature', null, { platform: 'template', unique: 'g1', area: 'garage' }),
      ent('sensor.hidden_temp', null, { platform: 'template', unique: 'h1', hidden: 'user', area: 'garage' }),
      ent('sensor.disabled_temp', null, { platform: 'template', unique: 'x1', disabled: 'user' }),
      ent('device_tracker.pixel_7', 'd_phone', { platform: 'mobile_app', unique: 'p7t' }),
    ],
  };
  const temp = (id, v, name, unit = '°C') => state(id, v, { device_class: 'temperature', unit_of_measurement: unit, state_class: 'measurement', friendly_name: name });
  for (const s of [
    state('climate.living_trv', 'heat', { hvac_modes: ['off', 'heat'], current_temperature: 19.4, temperature: 21, min_temp: 5, max_temp: 35, target_temp_step: 0.5, friendly_name: 'Радіатор під вікном' }),
    state('number.radiator_ext', '19.8', { min: -127, max: 512, friendly_name: 'Радіатор під вікном External temperature input' }),
    state('select.living_trv_temperature_sensor_select', 'external', { options: ['internal', 'external'] }),
    state('switch.living_trv_child_lock', 'on', {}),
    state('switch.living_trv_window_detection', 'off', {}),
    state('number.living_trv_valve_opening_degree', '100', { min: 0, max: 100 }),
    state('number.living_trv_valve_closing_degree', '100', { min: 0, max: 100 }),
    state('sensor.living_trv_battery', '82', { device_class: 'battery', unit_of_measurement: '%' }),
    state('sensor.living_trv_linkquality', '54', { unit_of_measurement: 'lqi' }),
    temp('sensor.living_temperature', '19.8', 'Вітальня температура'),
    state('sensor.living_humidity', '46', { device_class: 'humidity', unit_of_measurement: '%', friendly_name: 'Вітальня вологість' }),
    state('sensor.living_th_linkquality', '115', { unit_of_measurement: 'lqi' }),
    state('binary_sensor.living_window', 'off', { device_class: 'window', friendly_name: 'Вікно' }),
    state('climate.bedroom_ac', 'off', { hvac_modes: ['off', 'cool', 'heat', 'dry', 'fan_only', 'auto'], fan_modes: ['auto', 'low', 'high'], current_temperature: 22, friendly_name: 'Кондиціонер' }),
    state('sensor.bedroom_ac_power', '850', { device_class: 'power', unit_of_measurement: 'W' }),
    state('switch.bedroom_plug', 'off', { friendly_name: 'Розетка біля ліжка' }),
    state('sensor.bedroom_plug_power', '2000', { device_class: 'power', unit_of_measurement: 'W' }),
    temp('sensor.bedroom_temperature', '18.2', 'Bedroom temperature'),
    temp('sensor.garage_temperature', '41', 'Garage temperature', '°F'),
    temp('sensor.hidden_temp', '20', 'Hidden temperature'),
    temp('sensor.outdoor_temperature', '4.2', 'Outdoor temperature'),
    state('climate.klimo_vitalnia', 'auto', { hvac_modes: ['off', 'auto', 'heat'] }),
    state('climate.office_floor', 'heat', { hvac_modes: ['off', 'heat'], friendly_name: 'Office thermostat' }),
    state('climate.hall_thermostat', 'heat_cool', { hvac_modes: ['off', 'heat_cool'], friendly_name: 'Hall thermostat' }),
    temp('sensor.living_room_temperature', '20.1', 'Living temperature'),
    state('person.ihor', 'home', { user_id: 'u1', device_trackers: ['device_tracker.pixel_7'], friendly_name: 'Ігор' }),
    state('calendar.family', 'off', { friendly_name: 'Родина' }),
  ]) ha.set(s);
  const registry = new RegistryService(ha, config);
  const search = new EntitySearchService(ha, config, registry);
  return { ha, config, registry, search };
}

test('folding: KMU-2010 on both sides, diacritics dropped', () => {
  assert.equal(fold('Вітальня'), 'vitalnia');
  assert.equal(searchKey('Дитяча_кімната'), 'dytiacha kimnata');
  assert.equal(fold('Café'), 'cafe');
  assert.equal(matchScore('vitalnia', { entityId: 'sensor.x', name: 'Вітальня', areaName: null, deviceName: null }), 60);
});

test('search: «vitalnia» finds «Вітальня…», «вітал» finds entities of the area «Вітальня»', () => {
  const { search } = house();
  const latin = search.search({ q: 'vitalnia' });
  assert.equal(latin[0].name.startsWith('Вітальня'), true);
  assert.equal(latin[0].score, 70);
  const cyr = search.search({ q: 'вітал', domain: ['climate'] });
  assert.deepEqual(cyr.map((e) => e.entityId), ['climate.living_trv']);
  assert.equal(cyr[0].score, 60, 'area match 50 + available 10');
  assert.equal(cyr[0].areaName, 'Вітальня');
});

test('search: exact entity id scores 100, prefix 80; Klimo, disabled and hidden entities stay out', () => {
  const { search } = house();
  const exact = search.search({ q: 'sensor.living_temperature' });
  assert.equal(exact[0].entityId, 'sensor.living_temperature');
  assert.equal(exact[0].score, 110);
  const prefix = search.search({ q: 'sensor.living_t' });
  const score = (id) => prefix.find((e) => e.entityId === id)?.score;
  assert.equal(score('sensor.living_temperature'), 90, 'id prefix 80 + available');
  assert.equal(score('sensor.living_room_temperature'), 40, 'every word found somewhere: 30 + available');
  assert.ok(prefix.findIndex((e) => e.entityId === 'sensor.living_temperature') < prefix.findIndex((e) => e.entityId === 'sensor.living_room_temperature'));
  assert.equal(score('sensor.bedroom_plug_power'), undefined);
  assert.equal(search.search({ q: 'klimo' }).length, 0);
  assert.equal(search.search({ q: 'disabled' }).length, 0);
  assert.equal(search.search({ role: 'temperature' }).some((e) => e.entityId === 'sensor.hidden_temp'), false);
  assert.equal(search.search({ q: 'sensor.hidden_temp' })[0].entityId, 'sensor.hidden_temp', 'named → shown');
});

test('search: +5 for the area of nearRoomId, then name order; limit', () => {
  const { search, config } = house();
  config.addRoom('r_bed', 'Спальня', 'spalnia', { haAreaId: 'bedroom' });
  const plain = search.search({ q: 'temperature', domain: ['sensor'] });
  const near = search.search({ q: 'temperature', domain: ['sensor'], nearRoomId: 'r_bed' });
  const score = (list, id) => list.find((e) => e.entityId === id).score;
  assert.equal(score(near, 'sensor.bedroom_temperature') - score(plain, 'sensor.bedroom_temperature'), 5);
  assert.equal(score(near, 'sensor.living_room_temperature'), score(plain, 'sensor.living_room_temperature'));
  assert.equal(near[0].entityId, 'sensor.bedroom_temperature');
  assert.equal(search.search({ q: 'temperature', limit: 2 }).length, 2);
});

test('search: unassigned hides bound entities; usedBy lists who uses them', () => {
  const { search, config } = house();
  config.use('sensor.living_temperature', { type: 'room', id: 'r_liv', label: 'Вітальня' });
  const all = search.search({ role: 'temperature' });
  assert.deepEqual(all.find((e) => e.entityId === 'sensor.living_temperature').usedBy, [{ type: 'room', id: 'r_liv', label: 'Вітальня' }]);
  const free = search.search({ role: 'temperature', unassigned: true });
  assert.equal(free.some((e) => e.entityId === 'sensor.living_temperature'), false);
  assert.ok(free.some((e) => e.entityId === 'sensor.garage_temperature'));
});

test('role presets: TRV vs AC heuristics', () => {
  const { search } = house();
  const ids = (role) => search.search({ role }).map((e) => e.entityId).sort();
  // siblings/model evidence and the heat-only fallback; heat_cool thermostats and ACs are not heads
  assert.deepEqual(ids('trv'), ['climate.living_trv', 'climate.office_floor']);
  assert.deepEqual(ids('ac'), ['climate.bedroom_ac']);
  assert.equal(ids('climate_source').length, 5 - 1, 'every climate except Klimo’s own');
  const temps = ids('temperature');
  assert.ok(temps.includes('sensor.living_temperature'));
  assert.equal(temps.includes('sensor.living_trv_battery'), false);
  // any thermometer can be an outdoor one; those that say so come first
  const outdoor = search.search({ role: 'outdoor' }).map((e) => e.entityId);
  assert.equal(outdoor[0], 'sensor.outdoor_temperature');
  assert.deepEqual([...outdoor].sort(), temps);
  assert.deepEqual(ids('contact'), ['binary_sensor.living_window']);
  assert.deepEqual(ids('power'), ['sensor.bedroom_ac_power', 'sensor.bedroom_plug_power']);
  assert.deepEqual(ids('person'), ['person.ihor']);
  assert.ok(ids('switchable').includes('switch.bedroom_plug'));
});

test('detail: siblings classified, TRV capabilities and strategies', () => {
  const { search } = house();
  const d = search.detail('climate.living_trv');
  const role = (id) => d.siblings.find((s) => s.entityId === id).role;
  assert.equal(role('number.radiator_ext'), 'external_temp');
  assert.equal(role('select.living_trv_temperature_sensor_select'), 'sensor_select');
  assert.equal(role('switch.living_trv_child_lock'), 'child_lock');
  assert.equal(role('switch.living_trv_window_detection'), 'window_detection');
  assert.equal(role('number.living_trv_valve_opening_degree'), 'valve_opening');
  assert.equal(role('number.living_trv_valve_closing_degree'), 'valve_closing');
  assert.equal(role('sensor.living_trv_battery'), 'battery');
  assert.equal(role('sensor.living_trv_linkquality'), 'linkquality');
  assert.deepEqual(d.trv.siblings.externalTemp, 'number.radiator_ext');
  assert.deepEqual(
    { ext: d.trv.capabilities.externalSensor, cal: d.trv.capabilities.calibration, lock: d.trv.capabilities.childLock, win: d.trv.capabilities.windowDetection, valve: d.trv.capabilities.valveLimits, range: d.trv.capabilities.setpointRange, step: d.trv.capabilities.setpointStep },
    { ext: true, cal: false, lock: true, win: true, valve: true, range: [5, 35], step: 0.5 },
  );
  assert.deepEqual(d.trv.strategies.map((s) => [s.strategy, s.supported, s.reason]), [
    ['external', true, null],
    ['calibration', false, 'no_calibration'],
    ['onoff', true, null],
    ['valve', true, null],
  ]);
  assert.deepEqual(d.climate.hvacModes, ['off', 'heat']);
  assert.equal(d.entity.integration, 'zigbee2mqtt');

  const ac = search.detail('climate.bedroom_ac');
  assert.equal(ac.trv, null);
  assert.deepEqual(ac.siblings, [{ role: 'power', entityId: 'sensor.bedroom_ac_power' }]);
  assert.deepEqual(ac.climate.fanModes, ['auto', 'low', 'high']);
  assert.equal(search.detail('sensor.nope'), null);
});

test('detail: in a °F house the head’s range and setpoint step are read in °C', () => {
  const { ha, search } = house();
  ha.info = { ...ha.info, unit_system: { temperature: '°F' } };
  ha.set(state('climate.living_trv', 'heat', { hvac_modes: ['off', 'heat'], current_temperature: 67, temperature: 70, min_temp: 41, max_temp: 95, target_temp_step: 1, friendly_name: 'Радіатор під вікном' }));
  const d = search.detail('climate.living_trv');
  assert.deepEqual(d.trv.capabilities.setpointRange, [5, 35]);
  assert.equal(d.trv.capabilities.setpointStep, 0.56, '1 °F, not 1 °C');
  assert.equal(d.climate.step, 0.56);
  ha.set(state('climate.living_trv', 'heat', { hvac_modes: ['off', 'heat'], min_temp: 41, max_temp: 95, target_temp_step: 0.5 }));
  assert.equal(search.detail('climate.living_trv').trv.capabilities.setpointStep, 0.28);
  // a step HA does not report (or reports as 0) falls back to the default half degree
  ha.set(state('climate.living_trv', 'heat', { hvac_modes: ['off', 'heat'], min_temp: 41, max_temp: 95, target_temp_step: 0 }));
  assert.equal(search.detail('climate.living_trv').trv.capabilities.setpointStep, 0.5);
  assert.equal(search.detail('climate.living_trv').climate.step, null);
});

test('discoverArea: roles, features, LQI, confidence, pre-selection, taken by another room', () => {
  const { search, config } = house();
  config.use('binary_sensor.living_window', { type: 'room', id: 'r_kitchen', label: 'Кухня' });
  const d = search.discoverArea('living_room');
  assert.equal(d.areaName, 'Вітальня');
  assert.deepEqual(d.integrations, ['zigbee2mqtt']);
  const by = Object.fromEntries(d.candidates.map((c) => [c.entityId, c]));
  assert.deepEqual(d.candidates.map((c) => [c.role, c.entityId]), [
    ['trv', 'climate.living_trv'],
    ['temp_humidity', 'sensor.living_temperature'],
    ['window', 'binary_sensor.living_window'],
  ]);
  assert.deepEqual(by['climate.living_trv'].features, ['external_sensor', 'child_lock', 'window_detection']);
  assert.equal(by['climate.living_trv'].lqi, 54);
  assert.equal(by['climate.living_trv'].valueC, 19.4);
  assert.equal(by['climate.living_trv'].preselected, true);
  assert.equal(by['sensor.living_temperature'].valueC, 19.8);
  assert.equal(by['sensor.living_temperature'].lqi, 115);
  assert.equal(by['binary_sensor.living_window'].takenByRoomId, 'r_kitchen');
  assert.equal(by['binary_sensor.living_window'].preselected, false, 'offered as «перенести», not pre-checked');

  const bed = search.discoverArea('bedroom');
  const ac = bed.candidates.find((c) => c.entityId === 'climate.bedroom_ac');
  assert.equal(ac.role, 'ac');
  assert.deepEqual(ac.features, ['power_sensor']);
  const plug = bed.candidates.find((c) => c.entityId === 'switch.bedroom_plug');
  assert.equal(plug.role, 'heater');
  assert.equal(plug.powerKw, 2);
  assert.equal(plug.preselected, false, 'a plug is a guess, not a certainty');
  assert.ok(bed.candidates.some((c) => c.entityId === 'sensor.bedroom_temperature' && c.role === 'temperature'));
});

test('areas, unassigned, deviceOf with the Z2M transport', () => {
  const { search, config } = house();
  config.use('sensor.living_temperature', { type: 'room', id: 'r_liv', label: 'Вітальня' });
  const areas = search.areas();
  assert.deepEqual(areas.find((a) => a.areaId === 'living_room'), { areaId: 'living_room', name: 'Вітальня', deviceCount: 3 });
  const free = search.unassigned().map((c) => c.entityId);
  assert.ok(free.includes('sensor.garage_temperature'));
  assert.equal(free.includes('sensor.living_temperature'), false);
  const garage = search.unassigned().find((c) => c.entityId === 'sensor.garage_temperature');
  assert.equal(garage.valueC, 5, '41 °F is read as 5 °C');

  assert.deepEqual(search.deviceOf('climate.living_trv'), {
    key: 'd_trv',
    name: 'Радіатор під вікном',
    model: 'Zigbee thermostatic radiator valve (TRVZB)',
    manufacturer: 'SONOFF',
    areaId: 'living_room',
    transport: { type: 'z2m', instanceId: 'z_1', friendlyName: 'Радіатор під вікном', ieee: IEEE_TRV },
  });
  assert.deepEqual(search.deviceOf('climate.bedroom_ac').transport, { type: 'ha', integration: 'midea_ac_lan', network: 'Wi‑Fi' });
  assert.equal(search.deviceOf('sensor.bedroom_temperature').key, 'entity:sensor.bedroom_temperature');
});

test('notify services: from the service registry when available, else from mobile app devices; owner via person', async () => {
  const { search, ha } = house();
  const derived = await search.notifyServices();
  assert.deepEqual(derived, [{ service: 'notify.mobile_app_pixel_7', name: 'Pixel 7', deviceName: 'Pixel 7', haUserId: 'u1', mobile: true }]);
  ha.services = async () => ({ notify: { mobile_app_pixel_7: {}, telegram_family: {}, send_message: {} } });
  const listed = await search.notifyServices();
  assert.deepEqual(listed.map((s) => [s.service, s.mobile, s.haUserId]), [
    ['notify.mobile_app_pixel_7', true, 'u1'],
    ['notify.telegram_family', false, null],
  ]);
  assert.deepEqual(search.persons(), [{ entityId: 'person.ihor', name: 'Ігор', state: 'home', userId: 'u1' }]);
  assert.deepEqual(search.calendars(), [{ entityId: 'calendar.family', name: 'Родина' }]);
});

test('registry index follows new entities and registry updates', () => {
  const { search, ha } = house();
  assert.equal(search.search({ q: 'sensor.kitchen_temperature' }).length, 0);
  ha.set(state('sensor.kitchen_temperature', '21', { device_class: 'temperature', unit_of_measurement: '°C' }));
  assert.equal(search.search({ q: 'sensor.kitchen_temperature' }).length, 1);
  ha.setRegistries({ ...ha.regs, areas: [...ha.regs.areas, { area_id: 'kitchen', name: 'Кухня' }] });
  assert.ok(search.areas().some((a) => a.areaId === 'kitchen'));
});

test('wizard search: every entity with the room role it most likely has, ambiguous ones with two', () => {
  const { search, ha, config } = house();
  // a Zigbee thermostat on a radiator with no area: the add-room wizard has to find it by name
  ha.set(state('climate.zig_thermostat_office', 'heat', { hvac_modes: ['off', 'heat'], current_temperature: 21.5, temperature: 22, friendly_name: 'Office thermostat' }));
  const hint = (id) => search.search({ q: id, wizard: 'any' }).find((e) => e.entityId === id)?.wizard ?? null;

  const office = search.search({ q: 'office thermostat', wizard: 'any' });
  const zig = office.find((e) => e.entityId === 'climate.zig_thermostat_office');
  assert.deepEqual(zig.wizard, { suggested: ['trv'], possible: ['trv', 'heater'] });
  assert.equal(zig.valueC, 21.5, 'the room temperature it reads, not «heat»');

  assert.deepEqual(hint('climate.living_trv'), { suggested: ['trv'], possible: ['trv', 'heater'] });
  assert.deepEqual(hint('climate.bedroom_ac').suggested, ['ac']);
  assert.deepEqual(hint('climate.hall_thermostat'), { suggested: ['ac', 'trv'], possible: ['ac', 'trv', 'heater'] });
  assert.deepEqual(hint('sensor.living_temperature').suggested, ['temp_humidity']);
  assert.deepEqual(hint('sensor.living_humidity'), { suggested: ['humidity'], possible: ['humidity', 'temp_humidity'] });
  assert.deepEqual(hint('sensor.bedroom_temperature').suggested, ['temperature']);
  assert.deepEqual(hint('binary_sensor.living_window'), { suggested: ['window'], possible: ['window', 'door'] });
  // a plug could drive a heater or a floor zone: the wizard asks
  assert.deepEqual(hint('switch.bedroom_plug').suggested, ['heater', 'floor_zone']);
  // a head's own settings, its diagnostics, power meters and the outdoor sensor are no room devices
  for (const id of ['switch.living_trv_child_lock', 'number.radiator_ext', 'sensor.living_trv_battery', 'sensor.bedroom_plug_power', 'sensor.outdoor_temperature', 'person.ihor']) {
    assert.equal(hint(id), null, id);
  }
  // a source's own climate is offered last: it is the plant's, not a room's
  config.use('climate.bedroom_ac', { type: 'source', id: 's_ac', label: 'AC' });
  const all = search.search({ wizard: 'any', limit: 500 }).map((e) => e.entityId);
  assert.ok(all.indexOf('climate.bedroom_ac') > all.indexOf('sensor.bedroom_temperature'));
  // without `wizard` the picker DTO stays as it was
  assert.equal(search.search({ q: 'climate.zig_thermostat_office' })[0].wizard, undefined);
});

test('wizard search: a word naming the kind brings that kind first; a combined sensor leads with its temperature', () => {
  const { search, ha } = house();
  // a thermometer named after its place by the window outranked the window contact itself
  ha.set(state('sensor.sill_temperature', '17.5', { device_class: 'temperature', unit_of_measurement: '°C', state_class: 'measurement', friendly_name: 'By the window' }));
  const ids = (q) => search.search({ q, wizard: 'any' }).map((e) => e.entityId);
  assert.deepEqual(ids('window').slice(0, 2), ['binary_sensor.living_window', 'sensor.sill_temperature']);
  // «Вітальня вологість» sorts before «Вітальня температура», but Enter has to add the pair
  const living = ids('вітальня');
  assert.ok(living.indexOf('sensor.living_temperature') < living.indexOf('sensor.living_humidity'), living.join(', '));
  // ordinary pickers keep their plain text ranking
  assert.equal(search.search({ q: 'window' })[0].entityId, 'sensor.sill_temperature');
});

test('wizard search for a role: what can take it, the likeliest first, the room’s area before the rest', () => {
  const { search, ha } = house();
  ha.set(state('climate.zig_thermostat_office', 'heat', { hvac_modes: ['off', 'heat'], current_temperature: 21.5, friendly_name: 'Office thermostat' }));
  const trv = search.search({ wizard: 'trv' }).map((e) => e.entityId);
  // heat-only climates (a head, two thermostats) first
  assert.deepEqual(trv.slice(0, 3).sort(), ['climate.living_trv', 'climate.office_floor', 'climate.zig_thermostat_office']);
  assert.ok(trv.includes('climate.bedroom_ac'), 'an AC can still be switched to a head by hand');
  assert.ok(trv.indexOf('climate.hall_thermostat') < trv.indexOf('climate.bedroom_ac'), 'heat-and-cool thermostat before a clear AC');
  assert.equal(trv.some((id) => !id.startsWith('climate.')), false);

  const temps = search.search({ wizard: 'temperature', nearAreaId: 'bedroom' }).map((e) => e.entityId);
  assert.equal(temps[0], 'sensor.bedroom_temperature');
  assert.equal(temps.includes('sensor.outdoor_temperature'), false);
  const plain = search.search({ q: 'temperature', wizard: 'temperature' });
  const near = search.search({ q: 'temperature', wizard: 'temperature', nearAreaId: 'bedroom' });
  const score = (list, id) => list.find((e) => e.entityId === id).score;
  assert.equal(score(near, 'sensor.bedroom_temperature') - score(plain, 'sensor.bedroom_temperature'), 25);
});

test('discovery lists the roles a candidate can be switched to; a floor thermostat is a heater, never a zone valve', () => {
  const { search, ha } = house();
  const d = search.discoverArea('living_room');
  const by = Object.fromEntries(d.candidates.map((c) => [c.entityId, c]));
  assert.deepEqual(by['climate.living_trv'].possibleRoles, ['trv', 'heater']);
  assert.deepEqual(by['binary_sensor.living_window'].possibleRoles, ['window', 'door']);
  ha.set(state('climate.bathroom_floor_heating', 'heat', { hvac_modes: ['off', 'heat'], current_temperature: 24, friendly_name: 'Bathroom floor' }));
  ha.setRegistries({
    ...ha.regs,
    entities: [...ha.regs.entities, { entity_id: 'climate.bathroom_floor_heating', device_id: null, area_id: 'garage', platform: 'tuya', unique_id: 'bf1', disabled_by: null, hidden_by: null, original_name: null, name: null, entity_category: null }],
  });
  const floor = search.discoverArea('garage').candidates.find((c) => c.entityId === 'climate.bathroom_floor_heating');
  assert.equal(floor.role, 'heater');
  assert.deepEqual(floor.possibleRoles, ['heater', 'trv']);
});

test('a pump on a relay is the plant’s: not offered as a heater or zone valve, first in the circuit pump picker', () => {
  const { search, ha } = house();
  const reg = (entity_id, area = 'garage') => ({ entity_id, device_id: null, area_id: area, platform: 'tuya', unique_id: entity_id, disabled_by: null, hidden_by: null, original_name: null, name: null, entity_category: null });
  ha.set(state('switch.sirio_barrel_backyard_pump', 'off', { friendly_name: 'Sirio Barrel Backyard Pump' }));
  ha.set(state('switch.kotelnia_nasos', 'off', { friendly_name: 'Циркуляційний насос' }));
  ha.set(state('input_boolean.circulation', 'off', { friendly_name: 'Circulation' }));
  ha.set(state('switch.garage_heater', 'off', { friendly_name: 'Garage heater' }));
  ha.setRegistries({ ...ha.regs, entities: [...ha.regs.entities, ...['switch.sirio_barrel_backyard_pump', 'switch.kotelnia_nasos', 'input_boolean.circulation', 'switch.garage_heater'].map((id) => reg(id))] });
  const PUMPS = ['switch.sirio_barrel_backyard_pump', 'switch.kotelnia_nasos', 'input_boolean.circulation'];
  const hint = (id) => search.search({ q: id, wizard: 'any' }).find((e) => e.entityId === id)?.wizard ?? null;
  for (const id of PUMPS) assert.deepEqual(hint(id).suggested, [], id);
  assert.deepEqual(hint('switch.garage_heater').suggested, ['heater']);
  // the heater and zone valve categories leave pumps out until one is searched for by name
  for (const roles of [['heater'], ['floor_zone', 'floor_probe']]) {
    const ids = search.search({ wizardRoles: roles, limit: 500 }).map((e) => e.entityId);
    for (const id of PUMPS) assert.equal(ids.includes(id), false, `${roles}: ${id}`);
  }
  assert.ok(search.search({ q: 'sirio', wizardRoles: ['heater'] }).some((e) => e.entityId === 'switch.sirio_barrel_backyard_pump'), 'still possible on purpose');
  // nor does area discovery tick it as the room's heater
  assert.equal(search.discoverArea('garage').candidates.some((c) => PUMPS.includes(c.entityId)), false);
  assert.ok(search.discoverArea('garage').candidates.some((c) => c.entityId === 'switch.garage_heater'));
  // the circuit pump picker shows the pumps first
  const pumps = search.search({ role: 'pump', limit: 500 }).map((e) => e.entityId);
  assert.deepEqual(pumps.slice(0, 3).sort(), [...PUMPS].sort());
  // and of those the free one before a pump that already drives a circuit (it cannot drive two)
  const { search: s2, ha: ha2, config } = house();
  ha2.set(state('switch.sirio_barrel_backyard_pump', 'off', { friendly_name: 'Sirio Barrel Backyard Pump' }));
  ha2.set(state('switch.radiator_pump', 'on', { friendly_name: 'Radiator pump' }));
  ha2.setRegistries({ ...ha2.regs, entities: [...ha2.regs.entities, reg('switch.sirio_barrel_backyard_pump'), reg('switch.radiator_pump', null)] });
  config.uses.set('switch.radiator_pump', [{ type: 'pump', id: 'p_rad', label: 'Radiator pump' }]);
  const ranked = s2.search({ role: 'pump', limit: 500 }).map((e) => e.entityId);
  assert.ok(ranked.indexOf('switch.sirio_barrel_backyard_pump') < ranked.indexOf('switch.radiator_pump'), ranked.join(', '));
  assert.ok(ranked.indexOf('switch.radiator_pump') < ranked.indexOf('switch.garage_heater') || !ranked.includes('switch.garage_heater'), 'a used pump is still a pump');
});

test('wizard search for a device group: temperature, humidity and combined sensors together, nothing else', () => {
  const { search } = house();
  const ids = search.search({ wizardRoles: ['temp_humidity', 'temperature', 'humidity'], limit: 500 }).map((e) => e.entityId);
  for (const id of ['sensor.living_temperature', 'sensor.living_humidity', 'sensor.bedroom_temperature']) assert.ok(ids.includes(id), id);
  assert.equal(ids.some((id) => id.startsWith('climate.') || id.startsWith('binary_sensor.') || id.startsWith('switch.')), false, ids.join(', '));
  // a combined sensor leads with its temperature entity
  assert.ok(ids.indexOf('sensor.living_temperature') < ids.indexOf('sensor.living_humidity'));
});

test('an Aqara E1 calls its sensor switch plainly «sensor»: a select with an external option is the switch, another «…_sensor» select is not', () => {
  const { siblingRole } = require('../dist/ha/classify');
  const facts = (key, options) => ({ entityId: `select.office_trv_${key}`, domain: 'select', key, name: key, state: { entity_id: `select.office_trv_${key}`, state: options[0], attributes: { options } }, deviceClass: null, unit: null, entityCategory: 'config', model: 'SRTS-A01', areaName: null });
  assert.equal(siblingRole(facts('sensor', ['internal', 'external'])), 'sensor_select');
  assert.equal(siblingRole(facts('office_trv_sensor', ['internal', 'external'])), 'sensor_select');
  assert.equal(siblingRole(facts('motion_sensor', ['low', 'high'])), 'other');
});
