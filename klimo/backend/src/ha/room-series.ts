import type { AggregationMethod, EpochMs, HumidityMethod } from '../shared/model';
import { combine, type Point, valueAt } from './series';

/**
 * A room's value over time rebuilt from its sensors' recorder rows, the way the engine computes the live
 * value: the room's method over the sensors that have a reading then (unavailable and unknown left out),
 * an outlier dropped first when three or more report. HA records changes only, so each sensor is a step
 * function and the result changes only where one of them does.
 */

export interface SensorSteps {
  weight: number;
  /** Step series of one sensor, oldest first (null = unavailable from then on). */
  points: Point[];
}

export interface OutlierRule {
  enabled: boolean;
  thresholdC: number;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** The engine's outlier rule: only with ≥ 3 live readings, never a majority, the largest deviations first. */
export function dropOutliers<T extends { v: number }>(values: T[], rule: OutlierRule | null): T[] {
  if (!rule?.enabled || values.length < 3) return values;
  const cap = Math.floor((values.length - 1) / 2);
  const out = new Set(
    values
      .map((x, i) => ({ i, abs: Math.abs(x.v - median(values.filter((_, j) => j !== i).map((o) => o.v))) }))
      .filter((c) => c.abs > rule.thresholdC)
      .sort((a, b) => b.abs - a.abs || a.i - b.i)
      .slice(0, cap)
      .map((c) => c.i),
  );
  return values.filter((_, i) => !out.has(i));
}

/**
 * The combined step series over [from, end]: a point at `from` and wherever a sensor changes, repeated
 * values folded. Sensors come in the room's order (the first live one is `primary`).
 */
export function combineSteps(
  sensors: readonly SensorSteps[],
  method: AggregationMethod | HumidityMethod,
  outlier: OutlierRule | null,
  from: EpochMs,
  end: EpochMs,
): Point[] {
  if (!sensors.some((s) => s.points.some(([, v]) => v !== null))) return [];
  const times = new Set<EpochMs>([from]);
  for (const s of sensors) for (const [t] of s.points) if (t > from && t <= end) times.add(t);
  const out: Point[] = [];
  for (const t of [...times].sort((a, b) => a - b)) {
    const live = sensors.flatMap((s) => {
      const v = valueAt(s.points, t);
      return v === null ? [] : [{ v, w: s.weight }];
    });
    const v = combine(dropOutliers(live, outlier), method);
    if (out.length && out[out.length - 1][1] === v) continue;
    out.push([t, v]);
  }
  return out;
}

/** A step series as the chart draws it: sampled every `step` from `from`, and once more at `end` («now»). */
export function onGrid(points: readonly Point[], from: EpochMs, end: EpochMs, step: number): Point[] {
  if (!points.length || end <= from) return [];
  const out: Point[] = [];
  for (let t = from; t < end; t += step) out.push([t, valueAt(points, t)]);
  out.push([end, valueAt(points, end)]);
  return out;
}

/** Lowest and highest reading of a step series within [from, end], at the moment each was first reached. */
export function extremes(points: readonly Point[], from: EpochMs, end: EpochMs, round: (x: number) => number): { min: { c: number; at: EpochMs } | null; max: { c: number; at: EpochMs } | null } {
  let min: { c: number; at: EpochMs } | null = null;
  let max: { c: number; at: EpochMs } | null = null;
  for (const [t, v] of points) {
    if (v === null || t < from || t > end) continue;
    const c = round(v);
    if (!min || c < min.c) min = { c, at: t };
    if (!max || c > max.c) max = { c, at: t };
  }
  return { min, max };
}
