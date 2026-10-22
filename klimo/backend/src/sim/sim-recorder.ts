import { startOfLocalDay } from '../engine/core/time';
import type { EntityId, EpochMs, HaPort } from '../shared/model';

/* =====================================================================================================
 * The fake recorder: every state change of the fake Home Assistant, answered back through the same
 * `history` and `statistics` calls Klimo makes against a real HA. Samples older than a day are thinned
 * to one per 5 minutes (enough for week charts and the season mean), older than ten days dropped.
 * ===================================================================================================== */

type HistoryResult = Awaited<ReturnType<HaPort['history']>>;
type StatisticsResult = Awaited<ReturnType<HaPort['statistics']>>;
type Period = Parameters<HaPort['statistics']>[3];
type StatType = Parameters<HaPort['statistics']>[4][number];

interface Sample {
  t: EpochMs;
  s: string;
  a: Record<string, unknown> | null;
}

interface Series {
  samples: Sample[];
  /** Compiled into statistics (numeric sensors with a state class). */
  measurement: boolean;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const THIN_AFTER = DAY;
const THIN_STEP = 5 * MIN;
const KEEP = 10 * DAY;

/** Huge, churning attributes are not kept (the hub and card sensors are recorder-excluded in the docs). */
const NO_ATTRIBUTES = [/^sensor\.klimo_hub$/, /^sensor\.klimo_reply$/, /^sensor\.klimo_.*_card$/];

export class SimRecorder {
  private readonly series = new Map<EntityId, Series>();
  private thinnedUntil = 0;

  constructor(private readonly tz: () => string) {}

  /** Records a state (call it on every change; identical consecutive samples are skipped). */
  record(entityId: EntityId, state: string, attributes: Record<string, unknown> | null, t: EpochMs): void {
    let s = this.series.get(entityId);
    if (!s) {
      s = { samples: [], measurement: false };
      this.series.set(entityId, s);
    }
    if (attributes?.state_class === 'measurement' || attributes?.state_class === 'total' || attributes?.state_class === 'total_increasing') s.measurement = true;
    const a = attributes && !NO_ATTRIBUTES.some((re) => re.test(entityId)) ? attributes : null;
    const last = s.samples[s.samples.length - 1];
    if (last && last.s === state && last.a === a) return;
    if (last && t < last.t) {
      // a late sample (warm-up replays) goes into place; the series stays sorted
      const i = s.samples.findIndex((x) => x.t > t);
      s.samples.splice(i < 0 ? s.samples.length : i, 0, { t, s: state, a });
      return;
    }
    if (last && last.t === t) s.samples[s.samples.length - 1] = { t, s: state, a };
    else s.samples.push({ t, s: state, a });
  }

  /** Statistics need to know a series is a measurement even before its first live sample. */
  markMeasurement(entityId: EntityId): void {
    const s = this.series.get(entityId);
    if (s) s.measurement = true;
    else this.series.set(entityId, { samples: [], measurement: true });
  }

  clear(): void {
    this.series.clear();
    this.thinnedUntil = 0;
  }

  size(): number {
    let n = 0;
    for (const s of this.series.values()) n += s.samples.length;
    return n;
  }

  /** Thins samples older than a day to one per 5 minutes and drops what is older than ten days. */
  compact(now: EpochMs): void {
    const keepFrom = now - KEEP;
    const thinTo = now - THIN_AFTER;
    for (const s of this.series.values()) {
      const out: Sample[] = [];
      let bucket = -1;
      for (const x of s.samples) {
        if (x.t < keepFrom) {
          // keep the last old sample so the state at the window start stays known
          out.length = 0;
          out.push(x);
          continue;
        }
        if (x.t >= this.thinnedUntil && x.t < thinTo) {
          const b = Math.floor(x.t / THIN_STEP);
          if (b === bucket && out.length) {
            out[out.length - 1] = x;
            continue;
          }
          bucket = b;
        }
        out.push(x);
      }
      s.samples = out;
    }
    this.thinnedUntil = Math.max(this.thinnedUntil, thinTo);
  }

  /** `history/history_during_period`: the state at `start` first, `lu` in seconds. */
  history(entityIds: EntityId[], start: EpochMs, end: EpochMs, opts: { minimal: boolean; noAttributes: boolean }): HistoryResult {
    const out: HistoryResult = {};
    for (const id of entityIds) {
      const s = this.series.get(id);
      if (!s || !s.samples.length) continue;
      const rows: HistoryResult[string] = [];
      const first = lastIndexBefore(s.samples, start);
      const from = first >= 0 ? first : 0;
      for (let i = from; i < s.samples.length; i++) {
        const x = s.samples[i];
        if (x.t > end) break;
        const lu = Math.max(x.t, start) / 1000;
        const withAttrs = !opts.noAttributes && x.a && (!opts.minimal || rows.length === 0);
        rows.push(withAttrs ? { s: x.s, lu, a: x.a ?? {} } : { s: x.s, lu });
      }
      if (rows.length) out[id] = rows;
    }
    return out;
  }

  /** `recorder/statistics_during_period`: time-weighted mean, min and max per completed period. */
  statistics(statIds: string[], start: EpochMs, end: EpochMs, period: Period, types: StatType[], now: EpochMs): StatisticsResult {
    const out: StatisticsResult = {};
    const until = Math.min(end, now);
    for (const id of statIds) {
      const s = this.series.get(id);
      if (!s || !s.measurement || !s.samples.length) continue;
      const rows: StatisticsResult[string] = [];
      for (let b = this.periodStart(start, period); b < until; ) {
        const e = this.periodEnd(b, period);
        // like HA, only completed periods are compiled
        if (e > now) break;
        const agg = aggregate(s.samples, b, e);
        if (agg) {
          const row: StatisticsResult[string][number] = { start: b };
          if (types.includes('mean')) row.mean = agg.mean;
          if (types.includes('min')) row.min = agg.min;
          if (types.includes('max')) row.max = agg.max;
          if (types.includes('state')) row.state = agg.last;
          rows.push(row);
        }
        b = e;
      }
      if (rows.length) out[id] = rows;
    }
    return out;
  }

  private periodStart(t: EpochMs, period: Period): EpochMs {
    switch (period) {
      case '5minute':
        return Math.floor(t / (5 * MIN)) * 5 * MIN;
      case 'hour':
        return Math.floor(t / HOUR) * HOUR;
      case 'day':
        return startOfLocalDay(t, this.tz());
      case 'week': {
        const day = startOfLocalDay(t, this.tz());
        const dow = (new Date(day + 12 * HOUR).getUTCDay() + 6) % 7;
        return startOfLocalDay(day - dow * DAY + 12 * HOUR, this.tz());
      }
    }
  }

  private periodEnd(b: EpochMs, period: Period): EpochMs {
    switch (period) {
      case '5minute':
        return b + 5 * MIN;
      case 'hour':
        return b + HOUR;
      case 'day':
        // DST days are 23 or 25 hours long: the next local midnight, not b + 24 h
        return startOfLocalDay(b + DAY + 6 * HOUR, this.tz());
      case 'week':
        return startOfLocalDay(b + 7 * DAY + 6 * HOUR, this.tz());
    }
  }
}

function lastIndexBefore(samples: Sample[], t: EpochMs): number {
  let lo = 0;
  let hi = samples.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

function numeric(s: string): number | null {
  const n = Number(s);
  return s.trim() !== '' && Number.isFinite(n) ? n : null;
}

/** Time-weighted mean of a step function over [b, e), with min, max and the last value. */
function aggregate(samples: Sample[], b: EpochMs, e: EpochMs): { mean: number; min: number; max: number; last: number } | null {
  let i = lastIndexBefore(samples, b);
  if (i < 0) i = 0;
  let weighted = 0;
  let covered = 0;
  let min = Infinity;
  let max = -Infinity;
  let last: number | null = null;
  for (; i < samples.length && samples[i].t < e; i++) {
    const v = numeric(samples[i].s);
    const from = Math.max(b, samples[i].t);
    const to = Math.min(e, i + 1 < samples.length ? samples[i + 1].t : e);
    if (v === null || to <= from) {
      if (v !== null && samples[i].t >= b) {
        min = Math.min(min, v);
        max = Math.max(max, v);
        last = v;
      }
      continue;
    }
    weighted += v * (to - from);
    covered += to - from;
    min = Math.min(min, v);
    max = Math.max(max, v);
    last = v;
  }
  if (covered <= 0 || last === null) return null;
  return { mean: Math.round((weighted / covered) * 1000) / 1000, min, max, last };
}
