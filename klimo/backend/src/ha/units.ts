import type { EpochMs, HaStateObj } from '../shared/model';

/**
 * Klimo thinks in °C. Home Assistant may report in °F: sensors carry their own unit, climate and
 * water-heater attributes follow the HA unit system, weather entities say so in `temperature_unit`.
 * Values are converted when they are read (capture, history) and back when a setpoint is written.
 */
export type TempUnit = '°C' | '°F';

const CELSIUS = new Set(['°c', 'c', '℃', 'celsius']);
const FAHRENHEIT = new Set(['°f', 'f', '℉', 'fahrenheit']);
const NO_VALUE = new Set(['unavailable', 'unknown', 'none', '']);

/** `°C` / `°F` for a recognised temperature unit, null for anything else. */
export function tempUnit(unit: unknown): TempUnit | null {
  if (typeof unit !== 'string') return null;
  const u = unit.trim().toLowerCase();
  if (CELSIUS.has(u)) return '°C';
  if (FAHRENHEIT.has(u)) return '°F';
  return null;
}

export function fToC(f: number): number {
  return Math.round(((f - 32) * 5 / 9) * 100) / 100;
}

export function cToF(c: number): number {
  return Math.round((c * 9 / 5 + 32) * 100) / 100;
}

export function toCelsius(value: number, unit: TempUnit): number {
  return unit === '°F' ? fToC(value) : value;
}

/** For writes: a °C setpoint in the unit the entity expects. */
export function fromCelsius(celsius: number, unit: TempUnit): number {
  return unit === '°F' ? cToF(celsius) : celsius;
}

/** `unavailable`, `unknown`, empty and NaN read as null — never as 0. */
export function parseNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (NO_VALUE.has(s.toLowerCase())) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function isAvailableState(state: string | null | undefined): boolean {
  return state !== undefined && state !== null && state !== 'unavailable' && state !== 'unknown';
}

export function domainOf(entityId: string): string {
  const dot = entityId.indexOf('.');
  return dot > 0 ? entityId.slice(0, dot) : '';
}

/** HA system unit (`get_config.unit_system.temperature`) as a TempUnit; °C unless HA says °F. */
export function systemTempUnit(unit: string | null | undefined): TempUnit {
  return tempUnit(unit) ?? '°C';
}

const SYSTEM_UNIT_DOMAINS = new Set(['climate', 'water_heater']);

/**
 * Unit of an entity's temperature values: '°C' / '°F', 'unknown' when it is a temperature entity whose
 * unit Klimo cannot interpret (actuation is then refused), null when the entity is not a temperature.
 */
export function entityTempUnit(s: HaStateObj, haUnit: TempUnit): TempUnit | 'unknown' | null {
  const domain = domainOf(s.entity_id);
  if (SYSTEM_UNIT_DOMAINS.has(domain)) return haUnit;
  if (domain === 'weather') return tempUnit(s.attributes.temperature_unit) ?? haUnit;
  const unit = s.attributes.unit_of_measurement;
  const parsed = tempUnit(unit);
  if (parsed) return parsed;
  if (s.attributes.device_class === 'temperature') return unit === undefined || unit === null ? haUnit : 'unknown';
  return null;
}

/** Numeric state in °C (temperatures) or as-is (other numbers); null when unavailable or unknown unit. */
export function stateValue(s: HaStateObj | undefined, haUnit: TempUnit): number | null {
  if (!s) return null;
  const n = parseNumber(s.state);
  if (n === null) return null;
  const unit = entityTempUnit(s, haUnit);
  if (unit === 'unknown') return null;
  return unit ? toCelsius(n, unit) : n;
}

/** A temperature attribute (`current_temperature`, `temperature`, `min_temp`…) in °C. */
export function tempAttr(s: HaStateObj | undefined, attr: string, haUnit: TempUnit): number | null {
  if (!s) return null;
  const n = parseNumber(s.attributes[attr]);
  if (n === null) return null;
  const unit = entityTempUnit(s, haUnit);
  return unit && unit !== 'unknown' ? toCelsius(n, unit) : n;
}

/** Power in kW from a W or kW sensor (other units: null). */
export function powerKw(s: HaStateObj | undefined): number | null {
  if (!s) return null;
  const n = parseNumber(s.state);
  if (n === null) return null;
  const unit = String(s.attributes.unit_of_measurement ?? '').trim();
  if (unit === 'W') return Math.round(n) / 1000;
  if (unit === 'kW') return n;
  if (unit === 'MW') return n * 1000;
  return null;
}

function isoTime(v: unknown): EpochMs | null {
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** `last_reported ?? last_updated`: a sensor repeating the same value is still alive. */
export function lastReportedAt(s: HaStateObj): EpochMs | null {
  return isoTime(s.last_reported) ?? isoTime(s.last_updated) ?? isoTime(s.last_changed);
}

export function lastChangedAt(s: HaStateObj): EpochMs | null {
  return isoTime(s.last_changed) ?? isoTime(s.last_updated);
}
