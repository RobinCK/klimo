import type { AggregationMethod, EpochMs, HumidityMethod } from '../shared/model';

/** Pure helpers for recorder data: HA history is a step function (a value holds until the next change). */

export type Point = [EpochMs, number | null];

/**
 * At most `max` points: equal time buckets over [from, to], each the mean of its numeric samples at
 * the mean time of those samples; a bucket holding only gaps stays a gap, an empty bucket is dropped.
 */
export function downsample(points: readonly Point[], from: EpochMs, to: EpochMs, max = 300): Point[] {
  if (points.length <= max) return points.slice();
  const width = Math.max(1, (to - from) / max);
  const buckets = new Map<number, { tSum: number; n: number; vSum: number; vn: number }>();
  for (const [t, v] of points) {
    const i = Math.min(max - 1, Math.max(0, Math.floor((t - from) / width)));
    const b = buckets.get(i) ?? { tSum: 0, n: 0, vSum: 0, vn: 0 };
    b.tSum += t;
    b.n++;
    if (v !== null) {
      b.vSum += v;
      b.vn++;
    }
    buckets.set(i, b);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, b]) => [Math.round(b.tSum / b.n), b.vn ? b.vSum / b.vn : null] as Point);
}

/** Value of a step series at `t` (the last sample at or before t; null when none or older than maxAgeMs). */
export function valueAt(points: readonly Point[], t: EpochMs, maxAgeMs = Infinity): number | null {
  let lo = 0;
  let hi = points.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid][0] <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (found < 0) return null;
  const [at, v] = points[found];
  return t - at > maxAgeMs ? null : v;
}

/** Time-weighted mean of a step series over [from, to]; gaps do not count. Null when nothing is known. */
export function timeWeightedMean(points: readonly Point[], from: EpochMs, to: EpochMs): number | null {
  if (to <= from) return null;
  let sum = 0;
  let weight = 0;
  for (let i = 0; i < points.length; i++) {
    const [t, v] = points[i];
    const next = i + 1 < points.length ? points[i + 1][0] : to;
    const a = Math.max(t, from);
    const b = Math.min(next, to);
    if (v === null || b <= a) continue;
    sum += v * (b - a);
    weight += b - a;
  }
  return weight > 0 ? sum / weight : null;
}

export interface Bucket {
  start: EpochMs;
  mean: number | null;
  min: number | null;
  max: number | null;
}

/** Fixed-width buckets (e.g. hourly) of a step series: time-weighted mean plus the extremes. */
export function bucketize(points: readonly Point[], from: EpochMs, to: EpochMs, widthMs: number): Bucket[] {
  const out: Bucket[] = [];
  for (let start = from; start < to; start += widthMs) {
    const end = Math.min(to, start + widthMs);
    const mean = timeWeightedMean(points, start, end);
    let min: number | null = null;
    let max: number | null = null;
    const first = valueAt(points, start);
    for (const v of [first, ...points.filter(([t]) => t > start && t < end).map(([, v]) => v)]) {
      if (v === null) continue;
      min = min === null ? v : Math.min(min, v);
      max = max === null ? v : Math.max(max, v);
    }
    out.push({ start, mean, min: mean === null ? null : min, max: mean === null ? null : max });
  }
  return out;
}

function sorted(values: number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

function middle(values: number[]): number {
  const s = sorted(values);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Combines simultaneous readings of several sensors by a room's method (weights for 'weighted'). */
export function combine(values: { v: number; w: number }[], method: AggregationMethod | HumidityMethod): number | null {
  if (!values.length) return null;
  const vs = values.map((x) => x.v);
  switch (method) {
    case 'median':
      return middle(vs);
    case 'min':
      return Math.min(...vs);
    case 'max':
      return Math.max(...vs);
    case 'primary':
      return vs[0];
    case 'weighted': {
      const w = values.reduce((s, x) => s + x.w, 0);
      return w > 0 ? values.reduce((s, x) => s + x.v * x.w, 0) / w : vs.reduce((a, b) => a + b, 0) / vs.length;
    }
    default:
      return vs.reduce((a, b) => a + b, 0) / vs.length;
  }
}

export function roundTo(x: number | null, decimals: number): number | null {
  if (x === null) return null;
  const f = 10 ** decimals;
  return Math.round(x * f) / f;
}
