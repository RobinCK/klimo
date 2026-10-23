import { addDays, dowOfDate, fromLocal, toLocal } from '../engine/core/time';
import type { ConsumptionBucketSize, ConsumptionRange, EnergyTariffs, EpochMs, GasPriceUnit, LocalDate } from '../shared/model';

/* =====================================================================================================
 * Consumption arithmetic, free of Home Assistant calls: calendar periods and their buckets, the change
 * of a meter from statistics rows or from its raw readings (resets and unavailable stretches), what
 * single runs used, power integrated to energy, heating degree-days and costs. Amounts are in the
 * units Klimo charts (kWh, m³, kW for power); converting from the meter's own unit happens before.
 * ===================================================================================================== */

const MIN = 60_000;
const HOUR = 60 * MIN;
/** A total_increasing meter that falls by more than this share has been reset (HA's own rule). */
const RESET_DROP = 0.1;
/** Readings further apart than this pin consumption to a run only approximately. */
const SPARSE_MS = 15 * MIN;
/** A run is an estimate when more than this share of its amount could not be pinned to it. */
const UNCERTAIN_SHARE = 0.1;

/* ── periods ───────────────────────────────────────────────────────────────────────────────────── */

export interface PeriodPlan {
  range: ConsumptionRange;
  /** First day of the period. */
  date: LocalDate;
  from: EpochMs;
  to: EpochMs;
  bucket: ConsumptionBucketSize;
  /** Bucket boundaries in order: bucket i is [edges[i], edges[i + 1]). */
  edges: EpochMs[];
}

/** First day of the month of `date`, moved by `n` months. */
export function addMonths(date: LocalDate, n: number): LocalDate {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7)) - 1 + n;
  const year = y + Math.floor(m / 12);
  const month = ((m % 12) + 12) % 12;

  return `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-01`;
}

/** The first day of the period that holds `date` (weeks start on Monday). */
export function periodStart(range: ConsumptionRange, date: LocalDate): LocalDate {
  switch (range) {
    case 'day':
      return date;
    case 'week':
      return addDays(date, -dowOfDate(date));
    case 'month':
      return `${date.slice(0, 8)}01`;
    case 'year':
      return `${date.slice(0, 5)}01-01`;
  }
}

/** The first day of the period `n` periods after the one starting on `start`. */
export function shiftPeriod(range: ConsumptionRange, start: LocalDate, n: number): LocalDate {
  switch (range) {
    case 'day':
      return addDays(start, n);
    case 'week':
      return addDays(start, 7 * n);
    case 'month':
      return addMonths(start, n);
    case 'year':
      return addMonths(start, 12 * n);
  }
}

/** A day is charted by hours, a week and a month by days, a year by months (local midnights in `tz`). */
export function planPeriod(range: ConsumptionRange, date: LocalDate, tz: string): PeriodPlan {
  const start = periodStart(range, date);
  const next = shiftPeriod(range, start, 1);
  const from = fromLocal(start, 0, tz);
  const to = fromLocal(next, 0, tz);
  const edges: EpochMs[] = [];
  if (range === 'day') {
    for (let t = from; t < to; t += HOUR) {
      edges.push(t);
    }
  } else if (range === 'year') {
    for (let d = start; d < next; d = addMonths(d, 1)) {
      edges.push(fromLocal(d, 0, tz));
    }
  } else {
    for (let d = start; d < next; d = addDays(d, 1)) {
      edges.push(fromLocal(d, 0, tz));
    }
  }
  edges.push(to);

  return { range, date: start, from, to, bucket: range === 'day' ? 'hour' : range === 'year' ? 'month' : 'day', edges };
}

/* ── statistics rows ───────────────────────────────────────────────────────────────────────────── */

export interface MeterStatRow {
  start: EpochMs;
  change?: number | null;
  sum?: number | null;
  state?: number | null;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Growth from one reading to the next: a drop of more than 10 % is a new cycle counted from zero, a smaller dip is noise. */
export function readingStep(prev: number, next: number): number {
  if (next >= prev) {
    return next - prev;
  }

  return next < prev * (1 - RESET_DROP) ? Math.max(0, next) : 0;
}

/** The reading the next one is measured from: a dip that is not a reset keeps the higher one, so the recovery is not counted twice. */
export function readingBase(prev: number, next: number): number {
  return next < prev && next >= prev * (1 - RESET_DROP) ? prev : next;
}

/**
 * What each statistics row added, in the meter's own unit: HA's `change` when it sent one, else the
 * difference of consecutive sums (HA's sum already continues across resets), else of states with
 * reset detection. A row that cannot be told (the first one without `change`, a row without values)
 * is null; hours missing from the list put their growth into the next row that has values.
 */
export function rowChanges(rows: readonly MeterStatRow[]): (number | null)[] {
  const out: (number | null)[] = [];
  let prevSum: number | null = null;
  let prevState: number | null = null;
  for (const r of rows) {
    let change: number | null = null;
    if (isNum(r.change)) {
      change = r.change;
    } else if (isNum(r.sum) && prevSum !== null) {
      change = r.sum - prevSum;
    } else if (isNum(r.state) && prevState !== null) {
      change = readingStep(prevState, r.state);
    }

    out.push(change);
    if (isNum(r.sum)) {
      prevSum = r.sum;
    }

    if (isNum(r.state)) {
      prevState = prevState === null ? r.state : readingBase(prevState, r.state);
    }
  }

  return out;
}

/* ── raw readings ──────────────────────────────────────────────────────────────────────────────── */

export interface MeterReading {
  t: EpochMs;
  /** null = unavailable / unknown (skipped). */
  v: number | null;
}

export type TotalPoint = [EpochMs, number];

/**
 * Readings as a running total from zero that only grows: unavailable readings are skipped (the growth
 * during the gap lands on the next reading), resets start a new cycle, small dips are ignored.
 */
export function runningTotal(readings: readonly MeterReading[]): TotalPoint[] {
  const out: TotalPoint[] = [];
  let base: number | null = null;
  let total = 0;
  for (const r of readings) {
    if (r.v === null || !Number.isFinite(r.v)) {
      continue;
    }

    if (base === null) {
      base = r.v;
      out.push([r.t, 0]);
      continue;
    }

    total += readingStep(base, r.v);
    base = readingBase(base, r.v);
    out.push([r.t, total]);
  }

  return out;
}

/**
 * The running total just before `t`, the way HA's statistics read a meter: an hour [a, b) holds the
 * readings from `a` up to, not including, `b` — a reading exactly on the hour belongs to the next one.
 */
export function totalAt(points: readonly TotalPoint[], t: EpochMs): number | null {
  let lo = 0;
  let hi = points.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid][0] < t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return found < 0 ? null : points[found][1];
}

/** Growth over [a, b) read as HA reads it (no interpolation); null when nothing was known before `b`. */
export function totalDelta(points: readonly TotalPoint[], a: EpochMs, b: EpochMs): number | null {
  const end = totalAt(points, b);
  if (end === null) {
    return null;
  }

  return end - (totalAt(points, a) ?? 0);
}

/** kWh of a power sensor (readings in kW, each held until the next) over [a, b]; null when no reading covers it. */
export function integrateKw(readings: readonly MeterReading[], a: EpochMs, b: EpochMs): number | null {
  let kwh = 0;
  let covered = false;
  for (let i = 0; i < readings.length; i++) {
    const r = readings[i];
    const until = i + 1 < readings.length ? readings[i + 1].t : b;
    const from = Math.max(a, r.t);
    const to = Math.min(b, until);
    if (to <= from || r.v === null) {
      continue;
    }

    covered = true;
    kwh += (r.v * (to - from)) / HOUR;
  }

  return covered ? kwh : null;
}

/* ── runs ──────────────────────────────────────────────────────────────────────────────────────── */

export interface RunWindow {
  start: EpochMs;
  end: EpochMs;
}

export interface RunShare {
  value: number | null;
  estimated: boolean;
}

const overlap = (a: RunWindow, from: EpochMs, to: EpochMs): number => Math.max(0, Math.min(a.end, to) - Math.max(a.start, from));

/**
 * What each run used. A meter reports only now and then, so every growth between two readings is shared
 * among the runs inside that interval by their running time: the meter grew while the source ran. Growth
 * with no run inside belongs to none (another appliance on the same gas meter, standby). A run's value is
 * an estimate when a noticeable part of it was split between runs or came from sparse readings, or when
 * the readings begin after the run did or stop well before it ends.
 */
export function attributeRuns(points: readonly TotalPoint[], runs: readonly RunWindow[]): RunShare[] {
  if (!points.length) {
    return runs.map(() => ({ value: null, estimated: true }));
  }

  const value = runs.map(() => 0);
  const uncertain = runs.map(() => 0);
  const order = runs.map((r, i) => ({ r, i })).sort((x, y) => x.r.start - y.r.start);
  let first = 0;
  for (let p = 0; p + 1 < points.length; p++) {
    const [a, ca] = points[p];
    const [b, cb] = points[p + 1];
    const grew = cb - ca;
    while (first < order.length && order[first].r.end <= a) {
      first++;
    }

    if (grew <= 0) {
      continue;
    }

    const inside: { i: number; ms: number }[] = [];
    for (let k = first; k < order.length && order[k].r.start < b; k++) {
      const ms = overlap(order[k].r, a, b);
      if (ms > 0) {
        inside.push({ i: order[k].i, ms });
      }
    }

    const ran = inside.reduce((s, x) => s + x.ms, 0);
    for (const x of inside) {
      const part = (grew * x.ms) / ran;
      value[x.i] += part;
      if (x.ms < ran || b - a > SPARSE_MS) {
        uncertain[x.i] += part;
      }
    }
  }

  const firstAt = points[0][0];
  const lastAt = points[points.length - 1][0];

  return runs.map((r, i) => ({
    value: value[i],
    estimated: r.start < firstAt || r.end > lastAt + SPARSE_MS || uncertain[i] > UNCERTAIN_SHARE * value[i],
  }));
}

/* ── degree-days ───────────────────────────────────────────────────────────────────────────────── */

/** Mean outdoor temperature of one statistics row (hour or day). */
export interface OutdoorRow {
  start: EpochMs;
  end: EpochMs;
  meanC: number;
}

/**
 * Heating degree-days of [from, to) from hourly or daily means: each local day counts
 * max(0, base − its mean) for the share of the day the window covers, so an hour holds 1/24 of its
 * own degree-day and a day still running counts what has passed. null when no mean is known.
 */
export function degreeDays(rows: readonly OutdoorRow[], from: EpochMs, to: EpochMs, baseC: number, tz: string): number | null {
  const days = new Map<string, { weighted: number; ms: number; dayMs: number }>();
  for (const r of rows) {
    const ms = Math.min(r.end, to) - Math.max(r.start, from);
    if (ms <= 0) {
      continue;
    }

    const date = toLocal(r.start, tz).date;
    const dayMs = fromLocal(addDays(date, 1), 0, tz) - fromLocal(date, 0, tz);
    const d = days.get(date) ?? { weighted: 0, ms: 0, dayMs };
    d.weighted += r.meanC * ms;
    d.ms += ms;
    days.set(date, d);
  }

  if (!days.size) {
    return null;
  }

  let hdd = 0;
  for (const d of days.values()) {
    hdd += Math.max(0, baseC - d.weighted / d.ms) * (d.ms / d.dayMs);
  }

  return hdd;
}

/** Time-weighted mean outdoor temperature of [from, to); null when no mean is known. */
export function outdoorMean(rows: readonly OutdoorRow[], from: EpochMs, to: EpochMs): number | null {
  let weighted = 0;
  let ms = 0;
  for (const r of rows) {
    const part = Math.min(r.end, to) - Math.max(r.start, from);
    if (part > 0) {
      weighted += r.meanC * part;
      ms += part;
    }
  }

  return ms > 0 ? weighted / ms : null;
}

/* ── money and ratios ──────────────────────────────────────────────────────────────────────────── */

/** Gas in kWh, whichever way the meter counts it. */
export function gasKwh(gas: number, unit: GasPriceUnit, kwhPerM3: number): number {
  return unit === 'kWh' ? gas : gas * kwhPerM3;
}

/** Cost of what was used, counting the carriers that have a price; null when none of them has one. */
export function costOf(gas: number | null, electricity: number | null, gasUnit: GasPriceUnit | null, t: EnergyTariffs): number | null {
  let cost: number | null = null;
  if (electricity !== null && t.electricityPerKwh !== null) {
    cost = electricity * t.electricityPerKwh;
  }

  if (gas !== null && gasUnit !== null && t.gasPrice !== null) {
    const kwh = gasKwh(gas, gasUnit, t.gasKwhPerM3);
    const billed = t.gasPriceUnit === 'kWh' ? kwh : kwh / t.gasKwhPerM3;
    cost = (cost ?? 0) + billed * t.gasPrice;
  }

  return cost;
}

/** heat ÷ input energy; null for inputs too small to say anything or without output. */
export function ratio(heat: number | null, input: number | null, minInput: number): number | null {
  // nothing produced: the input was standby alone, a ratio of 0 would say nothing about the source
  if (heat === null || input === null || input < minInput || heat <= 0) {
    return null;
  }

  return heat / input;
}

export function roundTo(x: number | null, digits: number): number | null {
  if (x === null) {
    return null;
  }

  const f = 10 ** digits;

  return Math.round(x * f) / f;
}
