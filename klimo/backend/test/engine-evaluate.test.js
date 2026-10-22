const assert = require('node:assert/strict');
const test = require('node:test');
const h = require('./engine-harness');
const { evaluate } = require('../dist/engine/core/evaluate');
const { interestSet, templateNodes } = require('../dist/engine/interest-set');
const { snapOf } = require('../dist/engine/snapshot.service');
const { serviceCalls } = require('../dist/engine/command-bus');

const { SEC, MIN, kyiv } = h;

function entity(id, state, attrs = {}, at = 0) {
  const n = Number(state);
  const available = !['unavailable', 'unknown'].includes(state);
  return { entityId: id, state, num: available && state !== '' && Number.isFinite(n) ? n : null, attrs, available, lastChanged: at, lastReported: at, context: { id: null, userId: null, parentId: null } };
}

function inputs(now, entities, prev = { rooms: {}, plant: null }) {
  return {
    now,
    tz: h.KYIV,
    haConnected: true,
    blind: false,
    dryRun: false,
    entities,
    roomTempHistory: {},
    outdoor: { nowC: 4.2, avg10C: 4.2, avgNC: 6, source: 'sensor' },
    templateResults: {},
    calendarEvents: {},
    forecasts: {},
    z2mBridgeOnline: {},
    humidHours24h: {},
    haTempUnit: '°C',
    simulated: false,
    prev,
  };
}

function house(now, t, extra = {}) {
  return {
    'sensor.living_t1': entity('sensor.living_t1', String(t), { unit_of_measurement: '°C' }, now - MIN),
    'sensor.living_t2': entity('sensor.living_t2', String(t), { unit_of_measurement: '°C' }, now - MIN),
    'climate.living_trv': entity('climate.living_trv', 'heat', { temperature: 21.5, current_temperature: t + 1 }, now - MIN),
    'switch.boiler_relay': entity('switch.boiler_relay', 'off', {}, now - MIN),
    'switch.rad_pump': entity('switch.rad_pump', 'off', {}, now - MIN),
    ...extra,
  };
}

test('one evaluation composes season, rooms, the plant and the rooms again into one result', () => {
  const cfg = h.makeCfg();
  const now = h.WED_1910;
  const memory = h.makeMemory(cfg, now);
  const r = evaluate(cfg, inputs(now, house(now, 19.6)), memory, {});
  assert.equal(r.rooms.length, 1);
  const room = r.rooms[0];
  assert.equal(room.tempC, 19.6);
  assert.equal(room.demand.mode, 'heat');
  assert.equal(r.season.season, 'heating');
  assert.equal(r.houseProfile.activeProfileId, 'home');
  // the plant answered: the pump runs first (pre-run), the room waits for the boiler meanwhile
  assert.equal(r.plant.circuits[0].requestingRoomIds[0], 'r_living');
  assert.equal(room.state, 'wait');
  const keys = r.desired.map((d) => d.key);
  for (const k of ['switch.boiler_relay', 'switch.rad_pump', 'climate.living_trv']) assert.ok(keys.includes(k), k);
  assert.equal(r.desired.find((d) => d.key === 'climate.living_trv').value.temperature, 21.5, 'open head: T + above, rounded up to the step');
  // memory: the room's latch, the smoothing state, the plant's pump timer
  assert.equal(r.memory.rooms.r_living.heat.on, true);
  assert.ok(r.memory.ema.rs_1 && r.memory.ema.rs_2);
  assert.equal(r.memory.pumps.p_rad.on, true);
  assert.deepEqual(r.edges, [{ type: 'pump', id: 'p_rad', on: true }]);

  // twenty seconds later the boiler may fire
  const next = evaluate(cfg, inputs(now + 20 * SEC, house(now + 20 * SEC, 19.6, { 'switch.rad_pump': entity('switch.rad_pump', 'on', {}, now) }), { rooms: { r_living: room }, plant: r.plant }), r.memory, {});
  assert.equal(next.memory.sources.s_boiler.on, true);
  assert.ok(next.edges.some((e) => e.type === 'source' && e.id === 's_boiler' && e.on));
  assert.ok(next.decisions.some((d) => d.code === 'source.start'));
});

test('a window that opened at 18:59 wakes the engine at 19:00:00 sharp', () => {
  const cfg = h.makeCfg();
  cfg.sensorsByRoom.r_living.push({ ...h.d.DEFAULT_SENSOR(), id: 'rs_win', roomId: 'r_living', entityId: 'binary_sensor.living_window', role: 'contact', name: 'вікно', order: 2 });
  const opened = kyiv(2026, 10, 21, 18, 59);
  const now = opened + 20 * SEC;
  const memory = h.makeMemory(cfg, now);
  const ents = house(now, 20.6, { 'binary_sensor.living_window': entity('binary_sensor.living_window', 'on', { device_class: 'window' }, opened) });
  const first = evaluate(cfg, inputs(opened, ents), memory, {});
  const r = evaluate(cfg, inputs(now, ents, { rooms: { r_living: first.rooms[0] }, plant: first.plant }), first.memory, {});
  assert.equal(r.rooms[0].window.reactionAt, kyiv(2026, 10, 21, 19, 0));
  assert.equal(r.nextWakeAt, kyiv(2026, 10, 21, 19, 0));
});

test('overrides past their end are reported for removal', () => {
  const cfg = h.makeCfg();
  const now = h.WED_1910;
  const o = (id, until) => ({ id, scope: 'room', subjectId: 'r_living', kind: 'room_airing', group: 'airing', value: { kind: 'room_airing' }, duration: 'minutes', createdAt: now - 20 * MIN, until, by: { via: 'ui', userId: null, userName: null, contextId: null }, previous: null, revertToken: null, revertUntil: null, reqId: null });
  cfg.overrides = [o('o_old', now - SEC), o('o_live', now + 5 * MIN)];
  const r = evaluate(cfg, inputs(now, house(now, 20.6)), h.makeMemory(cfg, now), {});
  assert.deepEqual(r.expiredOverrideIds, ['o_old']);
});

test('the interest set covers every configured entity and the implicit ones; Z2M pseudo entities stay out', () => {
  const cfg = h.makeCfg();
  cfg.triggers = [{ ...h.d.DEFAULT_TRIGGER(), id: 't_sun', condition: { op: 'sun', is: 'above_horizon' } }];
  cfg.settings.presence = { ...cfg.settings.presence, enabled: true, homeZoneEntityId: null };
  const set = interestSet(cfg, [...h.referenced(cfg), 'z2m:zigbee2mqtt/head:child_lock']);
  for (const id of ['sensor.living_t1', 'climate.living_trv', 'number.living_trv_external', 'switch.boiler_relay', 'number.boiler_countdown', 'switch.rad_pump', 'sun.sun', 'zone.home']) assert.ok(set.has(id), id);
  assert.ok(![...set].some((id) => id.startsWith('z2m:')));
});

test('template conditions are keyed exactly as the evaluator reads them', () => {
  const cfg = h.makeCfg();
  cfg.triggers = [{ ...h.d.DEFAULT_TRIGGER(), id: 't_pv', condition: { op: 'all', items: [{ op: 'template', template: '{{ 1 }}', id: 'n_a' }, { op: 'not', item: { op: 'template', template: '{{ 0 }}' } }] } }];
  cfg.rules = [{ ...h.d.DEFAULT_RULE(), id: 'ru_x', when: { op: 'template', template: '{{ x }}' }, stopWhen: { op: 'template', template: '{{ y }}' } }];
  assert.deepEqual(templateNodes(cfg).map((t) => t.key), ['trigger:t_pv#n_a', 'trigger:t_pv#$.1.0', 'rule:ru_x#$w', 'rule:ru_x#$s']);
});

test('°F: a house in Fahrenheit is read in °C and written back in °F', () => {
  const sensor = snapOf({ entity_id: 'sensor.t', state: '68', attributes: { unit_of_measurement: '°F', device_class: 'temperature' }, last_changed: '2026-10-21T16:00:00Z', last_updated: '2026-10-21T16:00:00Z' }, '°F').snap;
  assert.equal(sensor.num, 20);
  const head = snapOf({ entity_id: 'climate.t', state: 'heat', attributes: { temperature: 70, current_temperature: 68 }, last_changed: '2026-10-21T16:00:00Z', last_updated: '2026-10-21T16:00:00Z' }, '°F').snap;
  assert.equal(head.attrs.temperature, 21.11);
  assert.equal(head.attrs.current_temperature, 20);
  const calls = serviceCalls('climate.t', { kind: 'climate', hvacMode: 'heat', temperature: 21.5, targetLow: null, targetHigh: null, fanMode: null }, { haUnit: '°F', entityUnit: undefined });
  assert.deepEqual(calls, [{ domain: 'climate', service: 'set_temperature', target: { entity_id: 'climate.t' }, data: { hvac_mode: 'heat', temperature: 70.7 } }]);
  const unknown = snapOf({ entity_id: 'sensor.k', state: '293', attributes: { unit_of_measurement: 'K', device_class: 'temperature' }, last_changed: '2026-10-21T16:00:00Z', last_updated: '2026-10-21T16:00:00Z' }, '°C');
  assert.equal(unknown.snap.num, null);
  assert.equal(unknown.unknownUnit, 'K');
});

test('desired values become the HA service each entity understands', () => {
  const call = (id, v) => serviceCalls(id, v, { haUnit: '°C', entityUnit: undefined }).map((c) => `${c.domain}.${c.service}${c.data ? ' ' + JSON.stringify(c.data) : ''}`);
  assert.deepEqual(call('switch.p', { kind: 'switch', on: true }), ['switch.turn_on']);
  assert.deepEqual(call('input_boolean.p', { kind: 'switch', on: false }), ['input_boolean.turn_off']);
  assert.deepEqual(call('valve.zone', { kind: 'valve', open: true, position: null }), ['valve.open_valve']);
  assert.deepEqual(call('valve.zone', { kind: 'valve', open: true, position: 40 }), ['valve.set_valve_position {"position":40}']);
  assert.deepEqual(call('climate.ac', { kind: 'climate', hvacMode: 'off', temperature: 22, targetLow: null, targetHigh: null, fanMode: 'quiet' }), ['climate.set_hvac_mode {"hvac_mode":"off"}']);
  assert.deepEqual(call('climate.ac', { kind: 'climate', hvacMode: 'cool', temperature: 24, targetLow: null, targetHigh: null, fanMode: 'quiet' }), ['climate.set_temperature {"hvac_mode":"cool","temperature":24}', 'climate.set_fan_mode {"fan_mode":"quiet"}']);
  assert.deepEqual(call('input_number.flow', { kind: 'number', value: 38.5 }), ['input_number.set_value {"value":38.5}']);
  assert.deepEqual(call('select.mode', { kind: 'select', option: 'heat' }), ['select.select_option {"option":"heat"}']);
  assert.deepEqual(call('script.hp_on', { kind: 'script', script: 'script.hp_on', variables: { mode: 'heat' }, runKey: 'heat:1' }), ['script.turn_on {"variables":{"mode":"heat"}}']);
});
