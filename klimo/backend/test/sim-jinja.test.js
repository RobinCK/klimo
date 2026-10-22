const assert = require('node:assert/strict');
const test = require('node:test');
const { evaluateTemplate, renderTemplate, TemplateError } = require('../dist/sim/jinja-lite');

function host(states) {
  return {
    state: (id) => states[id]?.state,
    attributes: (id) => states[id]?.attributes,
    entityIds: () => Object.keys(states),
  };
}

const HOUSE = host({
  'sensor.pv_power': { state: '5200', attributes: { unit_of_measurement: 'W' } },
  'sensor.house_load': { state: '700', attributes: {} },
  'sensor.battery_soc': { state: '97', attributes: {} },
  'binary_sensor.grid_offline': { state: 'on', attributes: { device_class: 'problem' } },
  'climate.heat_pump': { state: 'heat', attributes: { temperature: 37.8, hvac_action: 'heating' } },
  'sensor.broken': { state: 'unavailable', attributes: {} },
});

const value = (tpl, vars) => evaluateTemplate(tpl, HOUSE, vars).value;

test('the «sun during a blackout» template evaluates to a boolean', () => {
  assert.equal(value("{{ states('sensor.pv_power')|float(0) - states('sensor.house_load')|float(0) > 1500 }}"), true);
  assert.equal(value("{{ states('sensor.pv_power') | float(0) - states('sensor.house_load') | float(0) > 5000 }}"), false);
  const full = "{{ is_state('binary_sensor.grid_offline', 'on') and states('sensor.pv_power') | float(0) - states('sensor.house_load') | float(0) > 1500 and states('sensor.battery_soc') | float(0) >= 95 }}";
  const r = evaluateTemplate(full, HOUSE);
  assert.equal(r.value, true);
  // the entities it read decide when the subscription re-renders
  assert.deepEqual([...r.info.entities].sort(), ['binary_sensor.grid_offline', 'sensor.battery_soc', 'sensor.house_load', 'sensor.pv_power']);
});

test('is_state, state_attr, defaults and missing entities behave like Home Assistant', () => {
  assert.equal(value("{{ is_state('binary_sensor.grid_offline', 'off') }}"), false);
  assert.equal(value("{{ is_state('binary_sensor.grid_offline', ['off', 'on']) }}"), true);
  assert.equal(value("{{ state_attr('climate.heat_pump', 'temperature') }}"), 37.8);
  assert.equal(value("{{ state_attr('climate.heat_pump', 'nope') }}"), null);
  assert.equal(value("{{ states('sensor.missing') }}"), 'unknown');
  assert.equal(value("{{ states('sensor.broken') | float(-1) }}"), -1);
  assert.equal(value("{{ states('sensor.battery_soc') | int(0) + 1 }}"), 98);
  assert.equal(value("{{ has_value('sensor.broken') or not has_value('sensor.pv_power') }}"), false);
  assert.equal(value('{{ states.sensor.pv_power.state | float }}'), 5200);
  assert.equal(value('{{ (1 + 2) * 3 // 2 }}'), 4);
  assert.equal(value("{{ 'a' if 2 > 1 else 'b' }}"), 'a');
});

test('if blocks render text with elif and else', () => {
  const tpl = "{% if is_state('binary_sensor.grid_offline', 'off') %}grid{% elif states('sensor.battery_soc') | int(0) > 90 %}battery full{% else %}battery{% endif %}";
  assert.equal(renderTemplate(tpl, HOUSE), 'battery full');
  assert.equal(renderTemplate('{%- if true -%}  yes  {%- endif %}', HOUSE), 'yes');
  // text results are parsed like HA parses them (Python literals), anything else stays text
  assert.equal(value("{% if states('sensor.pv_power') | float(0) > 1000 %}True{% else %}False{% endif %}"), true);
  assert.equal(value("{% if states('sensor.pv_power') | float(0) > 1000 %}on{% else %}off{% endif %}"), 'on');
  assert.equal(value('{% if false %}1{% else %}42{% endif %}'), 42);
});

test('MQTT value templates read value_json, dicts and tojson', () => {
  const vars = { value: '{"mode":"heat","cur":19.8,"attrs":{"room_id":"r_living"}}', value_json: { mode: 'heat', cur: 19.8, lo: null, attrs: { room_id: 'r_living' } } };
  assert.equal(renderTemplate('{{ value_json.mode }}', HOUSE, vars), 'heat');
  assert.equal(renderTemplate('{{ value_json.cur }}', HOUSE, vars), '19.8');
  assert.equal(renderTemplate('{{ value_json.lo }}', HOUSE, vars), 'None');
  assert.deepEqual(JSON.parse(renderTemplate('{{ value_json.attrs | tojson }}', HOUSE, vars)), { room_id: 'r_living' });
  assert.deepEqual(JSON.parse(renderTemplate("{{ {'lo': value_json.lo, 'cur': value_json.cur} | tojson }}", HOUSE, vars)), { lo: null, cur: 19.8 });
});

test('anything outside the subset is a template error', () => {
  const fails = (tpl) => assert.throws(() => evaluateTemplate(tpl, HOUSE), TemplateError, tpl);
  fails('{{ now() }}');
  fails('{% for s in states.sensor %}{{ s }}{% endfor %}');
  fails('{% set x = 1 %}{{ x }}');
  fails("{{ states('sensor.broken') | float }}");
  fails("{{ states('sensor.pv_power') | regex_findall('x') }}");
  fails("{{ states('sensor.pv_power') > 5 }}");
  fails('{{ 1 / 0 }}');
  fails('{% if true %}open');
  fails('{{ 2 ** 3 }}');
});
