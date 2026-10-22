const assert = require('node:assert/strict');
const test = require('node:test');
const { state } = require('./ha-harness');
const units = require('../dist/ha/units');

test('numbers: unavailable, unknown, empty and NaN are null, never 0', () => {
  assert.equal(units.parseNumber('21.5'), 21.5);
  assert.equal(units.parseNumber(' 0 '), 0);
  for (const v of ['unavailable', 'unknown', '', 'None', 'abc', null, undefined, NaN]) assert.equal(units.parseNumber(v), null);
  assert.equal(units.isAvailableState('unknown'), false);
  assert.equal(units.isAvailableState('off'), true);
});

test('temperature units: sensors carry their own, climate follows HA, weather says so itself', () => {
  const f = state('sensor.out', '41', { device_class: 'temperature', unit_of_measurement: '°F' });
  const c = state('sensor.in', '20', { device_class: 'temperature', unit_of_measurement: '°C' });
  const odd = state('sensor.k', '293', { device_class: 'temperature', unit_of_measurement: 'K' });
  const climate = state('climate.trv', 'heat', { current_temperature: 68, temperature: 70 });
  const weather = state('weather.home', 'sunny', { temperature: 5, temperature_unit: '°C' });
  assert.equal(units.entityTempUnit(f, '°C'), '°F');
  assert.equal(units.entityTempUnit(c, '°F'), '°C');
  assert.equal(units.entityTempUnit(odd, '°C'), 'unknown', 'actuation of such an entity is refused');
  assert.equal(units.entityTempUnit(climate, '°F'), '°F');
  assert.equal(units.entityTempUnit(weather, '°F'), '°C');
  assert.equal(units.entityTempUnit(state('sensor.power', '5', { unit_of_measurement: 'W' }), '°C'), null);
  assert.equal(units.stateValue(f, '°C'), 5);
  assert.equal(units.stateValue(odd, '°C'), null);
  assert.equal(units.stateValue(state('sensor.rh', '46', { device_class: 'humidity', unit_of_measurement: '%' }), '°C'), 46);
  assert.equal(units.tempAttr(climate, 'current_temperature', '°F'), 20);
  assert.equal(units.tempAttr(climate, 'current_temperature', '°C'), 68);
  assert.equal(units.fromCelsius(21, '°F'), 69.8);
  assert.equal(units.fromCelsius(21, '°C'), 21);
  assert.equal(units.fToC(-40), -40);
});

test('power in kW from W or kW; last reported falls back to last updated', () => {
  assert.equal(units.powerKw(state('sensor.p', '2000', { unit_of_measurement: 'W' })), 2);
  assert.equal(units.powerKw(state('sensor.p', '1.5', { unit_of_measurement: 'kW' })), 1.5);
  assert.equal(units.powerKw(state('sensor.p', '3', { unit_of_measurement: 'A' })), null);
  const s = state('sensor.t', '20', {}, Date.UTC(2026, 9, 21, 12, 0));
  assert.equal(units.lastReportedAt(s), Date.UTC(2026, 9, 21, 12, 0));
  delete s.last_reported;
  s.last_updated = new Date(Date.UTC(2026, 9, 21, 12, 5)).toISOString();
  assert.equal(units.lastReportedAt(s), Date.UTC(2026, 9, 21, 12, 5));
});
