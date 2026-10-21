import { round1 } from '../../shared/model';
import type { EpochMs } from '../../shared/model';

/** Small pure numeric helpers shared by the engine core. */

export { round1 };

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** Median; the mean of the two middle values for an even count; null for no values. */
export function median(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function mean(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function decimalsOf(step: number): number {
  const s = String(step);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

/**
 * Rounds to a multiple of `step` (TRV `target_temp_step`, profile 0.5° grid). `ceil`/`floor` tolerate
 * float noise so 20.5 stays 20.5 instead of jumping a step.
 */
export function roundStep(x: number, step: number, mode: 'nearest' | 'ceil' | 'floor' = 'nearest'): number {
  if (!(step > 0)) return x;
  const k = x / step;
  const eps = 1e-9;
  const n = mode === 'ceil' ? Math.ceil(k - eps) : mode === 'floor' ? Math.floor(k + eps) : Math.round(k);
  return Number((n * step).toFixed(decimalsOf(step)));
}

/** Minutes rounded to the nearest 5 (ETA texts: «≈ 25 хв»). */
export function round5min(minutes: number): number {
  return Math.round(minutes / 5) * 5;
}

/** Exponentially weighted moving average; the first sample seeds it. */
export function ewma(prev: number | null, sample: number, alpha: number): number {
  return prev === null || !Number.isFinite(prev) ? sample : prev + alpha * (sample - prev);
}

/** One step of a time-based EMA with time constant `tauMs` over an irregular interval `dtMs`. */
export function emaStep(prev: number | null, raw: number, dtMs: number, tauMs: number): number {
  if (prev === null || !Number.isFinite(prev) || tauMs <= 0) return raw;
  if (dtMs <= 0) return prev;
  const k = 1 - Math.exp(-dtMs / tauMs);
  return prev + k * (raw - prev);
}

/** Least-squares slope of `[ts, value]` points, in value units per hour; null with < 2 distinct times. */
export function slopePerHour(points: readonly [EpochMs, number][]): number | null {
  if (points.length < 2) return null;
  const t0 = points[0][0];
  let sx = 0;
  let sy = 0;
  for (const [t, v] of points) {
    sx += (t - t0) / 3_600_000;
    sy += v;
  }
  const n = points.length;
  const mx = sx / n;
  const my = sy / n;
  let num = 0;
  let den = 0;
  for (const [t, v] of points) {
    const dx = (t - t0) / 3_600_000 - mx;
    num += dx * (v - my);
    den += dx * dx;
  }
  return den === 0 ? null : num / den;
}

// Magnus coefficients (Sonntag 1990), valid −45…60 °C over water
const MAGNUS_A = 17.62;
const MAGNUS_B = 243.12;

/** Dew point (°C) from air temperature (°C) and relative humidity (%). 19.8 °C / 46 % → 7.8 °C. */
export function magnusDewPoint(t: number, rh: number): number {
  const gamma = Math.log(clamp(rh, 0.1, 100) / 100) + (MAGNUS_A * t) / (MAGNUS_B + t);
  return (MAGNUS_B * gamma) / (MAGNUS_A - gamma);
}

/** Absolute humidity (g/m³) from air temperature (°C) and relative humidity (%). 19.8 °C / 46 % → 7.9. */
export function absoluteHumidity(t: number, rh: number): number {
  const saturationHpa = 6.112 * Math.exp((17.67 * t) / (t + 243.5));
  return (saturationHpa * clamp(rh, 0, 100) * 2.1674) / (273.15 + t);
}
