const assert = require('node:assert/strict');
const test = require('node:test');
const { buildDiscovery, climateModes, deviceInfo, roomCapabilities, commandSubscriptions } = require('../dist/mqtt/discovery');
const { houseConfig } = require('./mqtt-harness');

const DEVICE = deviceInfo('0.1.0', '/a0d7b954_klimo');

function discover(over = {}) {
  const cfg = over.cfg ?? houseConfig();
  return buildDiscovery({ cfg, season: 'heating', houseMode: 'auto', lang: 'uk', prefix: 'homeassistant', device: DEVICE, ...over });
}

const byId = (entities, uniqueId) => entities.find((e) => e.uniqueId === uniqueId);

test('the room climate pins its entity id with default_entity_id and offers the heating modes', () => {
  const climate = byId(discover(), 'klimo_r_9f2a1c_climate');
  assert.equal(climate.configTopic, 'homeassistant/climate/klimo_r_9f2a1c/config');
  assert.equal(climate.entityId, 'climate.klimo_vitalnia');
  const c = climate.config;
  assert.equal(c.object_id, undefined);
  assert.deepEqual(
    {
      unique_id: c.unique_id,
      default_entity_id: c.default_entity_id,
      has_entity_name: c.has_entity_name,
      name: c.name,
      availability_topic: c.availability_topic,
      modes: c.modes,
      mode_state_topic: c.mode_state_topic,
      mode_state_template: c.mode_state_template,
      mode_command_topic: c.mode_command_topic,
      current_temperature_template: c.current_temperature_template,
      temperature_state_template: c.temperature_state_template,
      temperature_command_topic: c.temperature_command_topic,
      action_template: c.action_template,
      preset_modes: c.preset_modes,
      preset_mode_command_topic: c.preset_mode_command_topic,
      min_temp: c.min_temp,
      max_temp: c.max_temp,
      temp_step: c.temp_step,
      precision: c.precision,
      temperature_unit: c.temperature_unit,
      optimistic: c.optimistic,
      json_attributes_template: c.json_attributes_template,
    },
    {
      unique_id: 'klimo_r_9f2a1c_climate',
      default_entity_id: 'climate.klimo_vitalnia',
      has_entity_name: true,
      name: 'Вітальня',
      availability_topic: 'klimo/status',
      modes: ['off', 'auto', 'heat'],
      mode_state_topic: 'klimo/room/r_9f2a1c/state',
      mode_state_template: '{{ value_json.mode }}',
      mode_command_topic: 'klimo/room/r_9f2a1c/mode/set',
      current_temperature_template: '{{ value_json.cur }}',
      temperature_state_template: '{{ value_json.t }}',
      temperature_command_topic: 'klimo/room/r_9f2a1c/temp/set',
      action_template: '{{ value_json.action }}',
      preset_modes: ['Дома', 'Поза домом', 'Еко', 'Ніч', 'Гості', 'Відпустка'],
      preset_mode_command_topic: 'klimo/room/r_9f2a1c/preset/set',
      min_temp: 5,
      max_temp: 30,
      temp_step: 0.5,
      precision: 0.1,
      temperature_unit: 'C',
      optimistic: false,
      json_attributes_template: '{{ value_json.attrs | tojson }}',
    },
  );
  // heating variant: no dual bounds
  assert.equal(c.temperature_low_command_topic, undefined);
  assert.deepEqual(c.device, {
    identifiers: ['klimo'],
    name: 'Klimo',
    manufacturer: 'Klimo',
    model: 'Climate add-on',
    sw_version: '0.1.0',
    configuration_url: 'homeassistant://hassio/ingress/a0d7b954_klimo',
  });
});

test('climate modes follow the season and the house mode', () => {
  const dual = { heat: true, cool: true };
  assert.deepEqual(climateModes(dual, 'heating', 'auto'), ['off', 'auto', 'heat']);
  assert.deepEqual(climateModes(dual, 'cooling', 'auto'), ['off', 'auto', 'cool']);
  assert.deepEqual(climateModes(dual, 'neutral', 'auto'), ['off', 'auto', 'heat_cool']);
  assert.deepEqual(climateModes({ heat: true, cool: false }, 'neutral', 'auto'), ['off', 'auto', 'heat']);
  assert.deepEqual(climateModes({ heat: true, cool: false }, 'cooling', 'auto'), ['off', 'auto']);
  assert.deepEqual(climateModes(dual, 'neutral', 'cool'), ['off', 'auto', 'cool']);
  assert.deepEqual(climateModes(dual, 'cooling', 'off'), ['off', 'auto']);

  // a room with an AC: dual band in the neutral season, cooling range in summer
  const cfg = houseConfig();
  const neutral = byId(discover({ cfg, season: 'neutral' }), 'klimo_r_9f2a1c_climate').config;
  assert.deepEqual(neutral.modes, ['off', 'auto', 'heat_cool']);
  assert.equal(neutral.temperature_low_command_topic, 'klimo/room/r_9f2a1c/temp_low/set');
  assert.equal(neutral.temperature_high_state_template, '{{ value_json.hi }}');
  // a room with one target in the neutral season must still show it
  assert.equal(neutral.temperature_command_topic, 'klimo/room/r_9f2a1c/temp/set');
  assert.equal(neutral.temperature_state_template, '{{ value_json.t }}');
  assert.deepEqual([neutral.min_temp, neutral.max_temp], [5, 32]);
  const summer = byId(discover({ cfg, season: 'cooling' }), 'klimo_r_9f2a1c_climate').config;
  assert.deepEqual(summer.modes, ['off', 'auto', 'cool']);
  assert.deepEqual([summer.min_temp, summer.max_temp], [16, 32]);
  // radiators only: nothing to cool with
  const study = byId(discover({ cfg, season: 'cooling' }), 'klimo_r_7e3b2d_climate').config;
  assert.deepEqual(study.modes, ['off', 'auto']);
});

test('per-room entities appear only when the room has what they report', () => {
  const entities = discover();
  const living = entities.filter((e) => e.roomId === 'r_9f2a1c').map((e) => e.entityId);
  assert.deepEqual(living.sort(), [
    'binary_sensor.klimo_vitalnia_cool_demand',
    'binary_sensor.klimo_vitalnia_heat_demand',
    'binary_sensor.klimo_vitalnia_window',
    'button.klimo_vitalnia_boost',
    'button.klimo_vitalnia_resume_schedule',
    'climate.klimo_vitalnia',
    'sensor.klimo_vitalnia_card',
    'sensor.klimo_vitalnia_dew_point',
    'sensor.klimo_vitalnia_humidity',
    'sensor.klimo_vitalnia_state',
    'sensor.klimo_vitalnia_target',
    'sensor.klimo_vitalnia_temperature',
  ]);
  // Кабінет: radiators only, no humidity sensor, no window contacts
  const study = entities.filter((e) => e.roomId === 'r_7e3b2d').map((e) => e.role);
  assert.ok(!study.includes('humidity') && !study.includes('window') && !study.includes('cool_demand'));
  const temp = byId(entities, 'klimo_r_9f2a1c_temperature').config;
  assert.equal(temp.name, 'Вітальня температура');
  assert.equal(temp.device_class, 'temperature');
  assert.equal(temp.state_class, 'measurement');
  assert.equal(temp.unit_of_measurement, '°C');
  assert.equal(temp.suggested_display_precision, 1);
  const card = byId(entities, 'klimo_r_9f2a1c_card').config;
  assert.equal(card.entity_category, 'diagnostic');
  assert.equal(card.json_attributes_topic, 'klimo/room/r_9f2a1c/card');
});

test('house and plant entities: one device, documented ids, names in the notification language', () => {
  const entities = discover();
  const ids = new Set(entities.map((e) => e.entityId));
  for (const id of [
    'select.klimo_house_profile',
    'select.klimo_season_mode',
    'sensor.klimo_season',
    'sensor.klimo_outdoor_average',
    'sensor.klimo_active_source',
    'binary_sensor.klimo_heat_demand',
    'binary_sensor.klimo_cool_demand',
    'binary_sensor.klimo_problem',
    'sensor.klimo_alerts',
    'sensor.klimo_power_used',
    'button.klimo_resume_schedule',
    'button.klimo_resync',
    'sensor.klimo_hub',
    'sensor.klimo_reply',
    'binary_sensor.klimo_source_s_hp',
    'binary_sensor.klimo_pump_c_rad',
    'binary_sensor.klimo_trigger_blackout',
  ]) {
    assert.ok(ids.has(id), id);
  }
  // a circuit without pumps has no pump sensor; config entities are opt-in
  assert.ok(!ids.has('binary_sensor.klimo_pump_c_spare'));
  assert.ok(![...ids].some((id) => id.startsWith('switch.') || id.startsWith('number.')));
  for (const e of entities) {
    assert.deepEqual(e.config.device.identifiers, ['klimo']);
    assert.equal(e.config.availability_topic, 'klimo/status');
    assert.equal(e.config.object_id, undefined);
    assert.equal(e.config.default_entity_id, e.entityId);
    assert.match(e.configTopic, /^homeassistant\/[a-z_]+\/[a-zA-Z0-9_-]+\/config$/);
  }
  assert.equal(new Set(entities.map((e) => e.configTopic)).size, entities.length);
  const profile = byId(entities, 'klimo_house_profile').config;
  assert.equal(profile.name, 'Профіль будинку');
  assert.deepEqual(profile.options, ['Дома', 'Поза домом', 'Еко', 'Ніч', 'Гості', 'Відпустка']);
  assert.equal(profile.command_topic, 'klimo/house/profile/set');
  const mode = byId(entities, 'klimo_season_mode').config;
  assert.deepEqual(mode.options, ['auto', 'heat', 'cool', 'off']);
  const hub = byId(entities, 'klimo_hub');
  assert.equal(hub.config.entity_category, 'diagnostic');
  assert.deepEqual(hub.topics.sort(), ['klimo/hub/attrs', 'klimo/hub/state']);
  // English names when notifications are in English
  const en = discover({ cfg: houseConfig({ lang: 'en' }), lang: 'en' });
  assert.equal(byId(en, 'klimo_house_profile').config.name, 'House profile');
  assert.equal(byId(en, 'klimo_r_9f2a1c_temperature').config.name, 'Вітальня temperature');
});

test('configuration entities are published only when switched on, and only then subscribed', () => {
  const entities = discover({ cfg: houseConfig({ configEntities: true }) });
  const allowed = byId(entities, 'klimo_src_s_hp_allowed');
  assert.equal(allowed.entityId, 'switch.klimo_source_s_hp_allowed');
  assert.equal(allowed.config.command_topic, 'klimo/source/s_hp/allowed/set');
  assert.equal(allowed.config.entity_category, 'config');
  assert.equal(byId(entities, 'klimo_rule_economy').config.command_topic, 'klimo/rule/economy/set');
  const point = byId(entities, 'klimo_bivalent_point').config;
  assert.deepEqual([point.min, point.max, point.step], [-20, 5, 1]);
  assert.equal(point.command_topic, 'klimo/number/bivalent_point/set');
  assert.ok(!commandSubscriptions(false).some((t) => t.startsWith('klimo/source') || t.startsWith('klimo/rule') || t.startsWith('klimo/number')));
  assert.deepEqual(commandSubscriptions(true).slice(-3), ['klimo/source/+/allowed/set', 'klimo/rule/+/set', 'klimo/number/+/set']);
});

test('a monitor-only room can neither heat nor cool', () => {
  const cfg = houseConfig();
  const room = { ...cfg.rooms[0], controlEnabled: false };
  assert.deepEqual(roomCapabilities(cfg, room), { heat: false, cool: false });
  assert.deepEqual(roomCapabilities(cfg, cfg.rooms[0]), { heat: true, cool: true });
  // the bathroom floor is excluded from cooling
  assert.deepEqual(roomCapabilities(cfg, cfg.rooms[5]), { heat: true, cool: false });
});
