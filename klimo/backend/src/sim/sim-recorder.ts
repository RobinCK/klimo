import { addDays, fromLocal, startOfLocalDay, toLocal } from '../engine/core/time';
import { addMonths, readingBase, readingStep } from '../ha/meters';
import type { EntityId, EpochMs, HaPort } from '../shared/model';

/* =====================================================================================================
 * The fake recorder: every state change of the fake Home Assistant, answered back through the same
 * `history` and `statistics` calls Klimo makes against a real HA. Samples older than a day are thinned
 * to one per 5 minutes (enough for week charts and the season mean), older than ten days dropped —
 * but, like HA, their hourly statistics are compiled first and kept. Meters (state class total or
 * total_increasing) compile to state and sum, the rest to mean, min and max. Hourly rows may also be
 * imported for the time before the first sample (the simulator's long-term history).
 * ===================================================================================================== */

type HistoryResult = Awaited<ReturnType<HaPort['history']>>;
type StatisticsResult = Awaited<ReturnType<HaPort['statistics']>>;
type StatRow = StatisticsResult[string][number];
type Period = Parameters<HaPort['statistics']>[3];
type StatType = Parameters<HaPort['statistics']>[4][number];

/** How HA compiles a sensor: mean/min/max, or state and a sum that keeps growing across resets. */
export type StatClass = 'measurement' | 'meter';

/** One compiled hour; `start` is on the hour. */
export interface HourRow {
  start: EpochMs;
  mean?: number;
  min?: number;
  max?: number;
  state?: number;
  sum?: number;
}

interface Sample {
  t: EpochMs;
  s: string;
  a: Record<string, unknown> | null;
}

interface Series {
  samples: Sample[];
  /** null = not compiled into statistics (no state class). */
  statClass: StatClass | null;
  /** Compiled or imported hours, oldest first; they win over samples for their hour. */
  hours: HourRow[];
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const THIN_AFTER = DAY;
const THIN_STEP = 5 * MIN;
const KEEP = 10 * DAY;

/** Domains HA always answers with full states (attributes in every row), even for a minimal response. */
const NEED_ATTRIBUTE_DOMAINS = new Set(['climate', 'humidifier', 'input_datetime', 'thermostat', 'water_heater']);

/** Huge, churning attributes are not kept (the hub and card sensors are recorder-excluded in the docs). */
const NO_ATTRIBUTES = [/^sensor\.klimo_hub$/, /^sensor\.klimo_reply$/, /^sensor\.klimo_.*_card$/];

function statClassOf(attributes: Record<string, unknown> | null): StatClass | null {
  const c = attributes?.state_class;
  if (c === 'total' || c === 'total_increasing') return 'meter';
  return c === 'measurement' ? 'measurement' : null;
}

const hourOf = (t: EpochMs) => Math.floor(t / HOUR) * HOUR;

export class SimRecorder {
  private readonly series = new Map<EntityId, Series>();
  private thinnedUntil = 0;

  constructor(private readonly tz: () => string) {}

  /** Records a state (call it on every change; identical consecutive samples are skipped). */
  record(entityId: EntityId, state: string, attributes: Record<string, unknown> | null, t: EpochMs): void {
    const s = this.seriesOf(entityId);
    const cls = statClassOf(attributes);
    if (cls) s.statClass = cls;
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
    const s = this.seriesOf(entityId);
    s.statClass ??= 'measurement';
  }

  /**
   * Hourly statistics for the time before the samples, as HA's statistics import writes them (the
   * simulator's long-term history). Meters need `state` and `sum`, measurements `mean`, `min`, `max`.
   */
  importHours(entityId: EntityId, statClass: StatClass, rows: readonly HourRow[]): void {
    const s = this.seriesOf(entityId);
    s.statClass = statClass;
    const byStart = new Map(s.hours.map((r) => [r.start, r]));
    for (const r of rows) byStart.set(hourOf(r.start), { ...r, start: hourOf(r.start) });
    s.hours = [...byStart.values()].sort((a, b) => a.start - b.start);
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

  /**
   * Thins samples older than a day to one per 5 minutes and drops what is older than ten days; the
   * hours being dropped are compiled first, so long-term statistics outlive the states (as in HA).
   */
  compact(now: EpochMs): void {
    const keepFrom = hourOf(now - KEEP);
    const thinTo = now - THIN_AFTER;
    for (const s of this.series.values()) {
      if (s.statClass && s.samples.length && s.samples[0].t < keepFrom) this.compileUntil(s, keepFrom);
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

  /**
   * `history/history_during_period` as HA answers it: the state at `start` first (its `lu` is `start`), then
   * every row up to `end`, `lu` in float seconds, states as strings. A minimal response keeps only state
   * changes after the first row and leaves their attributes out — except for the domains that need them.
   */
  history(entityIds: EntityId[], start: EpochMs, end: EpochMs, opts: { minimal: boolean; noAttributes: boolean }): HistoryResult {
    const out: HistoryResult = {};
    for (const id of entityIds) {
      const s = this.series.get(id);
      if (!s || !s.samples.length) continue;
      const full = !opts.minimal || NEED_ATTRIBUTE_DOMAINS.has(id.slice(0, id.indexOf('.')));
      const rows: HistoryResult[string] = [];
      const first = lastIndexBefore(s.samples, start);
      const from = first >= 0 ? first : 0;
      for (let i = from; i < s.samples.length; i++) {
        const x = s.samples[i];
        if (x.t > end) break;
        if (!full && rows.length && rows[rows.length - 1].s === x.s) continue;
        const lu = Math.max(x.t, start) / 1000;
        const withAttrs = !opts.noAttributes && (full || rows.length === 0);
        rows.push(withAttrs ? { s: x.s, lu, a: x.a ?? {} } : { s: x.s, lu });
      }
      if (rows.length) out[id] = rows;
    }
    return out;
  }

  /**
   * `recorder/statistics_during_period`. Hours (and 5-minute periods) only once complete; days, weeks
   * and months in the HA time zone, reduced from the hours compiled so far — the running one included.
   * `change` is the growth of the sum since the end of the previous period.
   */
  statistics(statIds: string[], start: EpochMs, end: EpochMs, period: Period, types: StatType[], now: EpochMs): StatisticsResult {
    const out: StatisticsResult = {};
    const until = Math.min(end, now);
    for (const id of statIds) {
      const s = this.series.get(id);
      if (!s || !s.statClass || (!s.samples.length && !s.hours.length)) continue;
      const rows: StatRow[] = [];
      for (let b = this.periodStart(start, period); b < until; ) {
        const e = this.periodEnd(b, period);
        const short = period === '5minute' || period === 'hour';
        if (short && e > now) break;
        const compiledTo = Math.min(e, hourOf(now));
        const agg = short ? this.periodRow(s, b, e) : this.reduce(s, b, compiledTo);
        if (agg) {
          const row: StatRow = { start: b };
          if (types.includes('mean') && agg.mean !== undefined) row.mean = agg.mean;
          if (types.includes('min') && agg.min !== undefined) row.min = agg.min;
          if (types.includes('max') && agg.max !== undefined) row.max = agg.max;
          if (types.includes('state') && agg.state !== undefined) row.state = agg.state;
          if (types.includes('sum') && agg.sum !== undefined) row.sum = agg.sum;
          if (types.includes('change') && agg.sum !== undefined) row.change = round6(agg.sum - (this.sumBefore(s, b) ?? 0));
          rows.push(row);
        }
        b = e;
      }
      if (rows.length) out[id] = rows;
    }
    return out;
  }

  /* ── compiling ──────────────────────────────────────────────────────────────────────────────── */

  private seriesOf(entityId: EntityId): Series {
    let s = this.series.get(entityId);
    if (!s) {
      s = { samples: [], statClass: null, hours: [] };
      this.series.set(entityId, s);
    }
    return s;
  }

  /** Compiles every hour from the first sample up to `to` that has no row yet. */
  private compileUntil(s: Series, to: EpochMs): void {
    const rows: HourRow[] = [];
    for (let b = hourOf(s.samples[0].t); b < to; b += HOUR) {
      if (findHour(s.hours, b)) continue;
      const r = this.periodRow(s, b, b + HOUR);
      if (r) rows.push({ start: b, ...r });
    }
    if (rows.length) s.hours = [...s.hours, ...rows].sort((a, b) => a.start - b.start);
  }

  /** One hour or 5-minute period: a compiled row for the hour, else the samples. */
  private periodRow(s: Series, b: EpochMs, e: EpochMs): Omit<HourRow, 'start'> | null {
    if (e - b === HOUR) {
      const compiled = findHour(s.hours, b);
      if (compiled) return compiled;
    }
    if (s.statClass === 'meter') {
      const state = this.stateBefore(s, e);
      const sum = this.sumBefore(s, e);
      return state === null || sum === null ? null : { state, sum };
    }
    const agg = aggregate(s.samples, b, e);
    return agg ? { mean: agg.mean, min: agg.min, max: agg.max, state: agg.last } : null;
  }

  /** A day, week or month from its hours: mean of the means, extremes, the last state and sum. */
  private reduce(s: Series, b: EpochMs, e: EpochMs): Omit<HourRow, 'start'> | null {
    let n = 0;
    let meanSum = 0;
    let min = Infinity;
    let max = -Infinity;
    let last: Omit<HourRow, 'start'> | null = null;
    for (let h = b; h < e; h += HOUR) {
      const r = this.periodRow(s, h, h + HOUR);
      if (!r) continue;
      last = r;
      if (r.mean !== undefined) {
        n++;
        meanSum += r.mean;
      }
      if (r.min !== undefined) min = Math.min(min, r.min);
      if (r.max !== undefined) max = Math.max(max, r.max);
    }
    if (!last) return null;
    if (s.statClass === 'meter') return { state: last.state, sum: last.sum };
    return { mean: n ? Math.round((meanSum / n) * 1000) / 1000 : undefined, min: Number.isFinite(min) ? min : undefined, max: Number.isFinite(max) ? max : undefined, state: last.state };
  }

  /** The last state before `t`: from the samples after the compiled hours, else the last compiled hour. */
  private stateBefore(s: Series, t: EpochMs): number | null {
    const compiledEnd = lastCompiledEnd(s.hours, t);
    for (let i = lastIndexBefore(s.samples, t - 1); i >= 0 && s.samples[i].t >= compiledEnd.end; i--) {
      const v = numeric(s.samples[i].s);
      if (v !== null) return v;
    }
    return compiledEnd.row?.state ?? null;
  }

  /**
   * The meter's sum just before `t`: the last compiled hour's sum, grown by the samples after it the
   * way HA grows it (a drop of more than 10 % is a reset counted from zero, a smaller dip is noise).
   */
  private sumBefore(s: Series, t: EpochMs): number | null {
    const { end, row } = lastCompiledEnd(s.hours, t);
    let sum = row?.sum ?? null;
    let prev = row?.state ?? null;
    for (const x of s.samples) {
      if (x.t >= t) break;
      if (x.t < end) continue;
      const v = numeric(x.s);
      if (v === null) continue;
      if (prev === null) {
        // the first reading ever starts the sum
        sum ??= 0;
      } else {
        sum = (sum ?? 0) + readingStep(prev, v);
      }
      prev = prev === null ? v : readingBase(prev, v);
    }
    return sum === null ? null : round6(sum);
  }

  private periodStart(t: EpochMs, period: Period): EpochMs {
    switch (period) {
      case '5minute':
        return Math.floor(t / (5 * MIN)) * 5 * MIN;
      case 'hour':
        return hourOf(t);
      case 'day':
        return startOfLocalDay(t, this.tz());
      case 'week': {
        const day = startOfLocalDay(t, this.tz());
        const dow = (new Date(day + 12 * HOUR).getUTCDay() + 6) % 7;
        return startOfLocalDay(day - dow * DAY + 12 * HOUR, this.tz());
      }
      case 'month':
        return fromLocal(`${toLocal(t, this.tz()).date.slice(0, 8)}01`, 0, this.tz());
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
        return fromLocal(addDays(toLocal(b, this.tz()).date, 1), 0, this.tz());
      case 'week':
        return fromLocal(addDays(toLocal(b, this.tz()).date, 7), 0, this.tz());
      case 'month':
        return fromLocal(addMonths(toLocal(b, this.tz()).date, 1), 0, this.tz());
    }
  }
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

function findHour(hours: readonly HourRow[], start: EpochMs): HourRow | null {
  let lo = 0;
  let hi = hours.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (hours[mid].start === start) return hours[mid];
    if (hours[mid].start < start) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}

/** The last compiled hour that ends by `t`, and where it ends (−∞ without one). */
function lastCompiledEnd(hours: readonly HourRow[], t: EpochMs): { end: EpochMs; row: HourRow | null } {
  let lo = 0;
  let hi = hours.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (hours[mid].start + HOUR <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found < 0 ? { end: -Infinity, row: null } : { end: hours[found].start + HOUR, row: hours[found] };
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
