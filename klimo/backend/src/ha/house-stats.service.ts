import { Inject, Injectable, Logger } from '@nestjs/common';
import { errorText, LogOnce } from '../common/logger';
import { sourceLabels } from '../config/source-labels';
import { addDays, fromLocal, toLocal } from '../engine/core/time';
import { METER_QUANTITIES, meterUnit } from '../shared/model';
import type {
  ClockPort,
  EpochMs,
  HaPort,
  HeatLossDay,
  HeatLossDto,
  HeatLossFit,
  IConfigStore,
  Id,
  IHistory,
  IHouseStats,
  ISpanStore,
  LocalDate,
  RunSpan,
  SourceCycles,
  SourceMeter,
  StatsAttrs,
} from '../shared/model';
import { CLOCK, CONFIG_STORE, HA_PORT, HISTORY, SPAN_STORE } from '../tokens';
import { roundTo } from './meters';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const CACHE_MS = 10 * MIN;
const INERTIA_CACHE_MS = 30 * MIN;
/** The heat characteristic looks back this many complete days. */
const HEAT_DAYS = 30;
/** A day is a point with this much heat and this much difference between the rooms and the outdoors. */
const MIN_HEAT_KWH = 1;
const MIN_DELTA_K = 2;
/** A day's temperature is its mean over at least this many recorded hours. */
const MIN_HOURS = 18;
/** The line needs this many days spread over this many kelvin. */
const MIN_POINTS = 5;
const MIN_SPREAD_K = 3;
/** Night pauses are looked for in the last ten days (5-minute statistics are kept as long). */
const INERTIA_DAYS = 10;
/** A pause counts from this long after the last run (the radiators still give their heat)… */
const SETTLE_MS = 30 * MIN;
/** …for at least this long, between 22:00 and 06:00 (no sun, nobody cooking). */
const PAUSE_MIN_MS = 2 * HOUR;
const NIGHT_FROM = 22 * 60;
const NIGHT_TO = 6 * 60;
/** The rooms are this much warmer than the outdoors at its start, and fall at least this much. */
const MIN_GAP_K = 5;
const MIN_DROP_K = 0.1;
const PAUSES_KEEP = 10;

type Interval = [EpochMs, EpochMs];

/**
 * What the house's own records say about the building: its heat characteristic (heat a day against the
 * difference between the rooms and the outdoors, over the last 30 days) for System → Consumption and the
 * dashboard, and for the widgets' sensor the sources' last 24 h, the hourly outdoor temperature and how
 * fast the house cools in the boiler's night pauses. Read from Home Assistant's statistics and Klimo's
 * run spans on request, cached for minutes.
 */
@Injectable()
export class HouseStatsService implements IHouseStats {
  private readonly log = new Logger('HouseStats');
  private readonly once = new LogOnce(this.log);
  private readonly cache = new Map<string, { at: EpochMs; ttl: number; value: Promise<unknown> }>();

  constructor(
    @Inject(HA_PORT) private readonly ha: HaPort,
    @Inject(CONFIG_STORE) private readonly config: IConfigStore,
    @Inject(SPAN_STORE) private readonly spans: ISpanStore,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(HISTORY) private readonly history: IHistory,
  ) {}

  heatLoss(): Promise<HeatLossDto> {
    const now = this.clock.now();
    const today = toLocal(now, this.clock.tz()).date;

    return this.cached(`heat|${today}|${this.config.revision()}`, CACHE_MS, () => this.readHeatLoss(today, now));
  }

  async widgets(): Promise<StatsAttrs | null> {
    if (!this.ha.connected) {
      return null;
    }

    const now = this.clock.now();
    const from = Math.floor((now - DAY) / MIN) * MIN;
    const [out, src, heat, inertia] = await Promise.all([
      this.outdoorHours(from).catch((e) => this.failed('outdoor', e, [] as (number | null)[])),
      this.cycles(from, now),
      this.heatLoss().catch((e) => this.failed('heat', e, null)),
      this.inertia(now).catch((e) => this.failed('inertia', e, null)),
    ]);
    const fit = heat?.fit ?? null;

    return {
      kv: 'klimo_stats',
      v: 1,
      from,
      now,
      out,
      src,
      heat: heat
        ? {
            from: heat.from,
            to: heat.to,
            pts: heat.days.filter((d) => d.used).map((d) => [roundTo(d.deltaK, 1) as number, roundTo(d.heatKwh, 1) as number]),
            tin: heat.indoorC,
            fit: fit
              ? { wpk: fit.wPerK, a: roundTo(fit.interceptKwh, 2) as number, b: roundTo(fit.slopeKwhPerK, 3) as number, bal: fit.balanceC, l10: fit.loadKw.minus10, l20: fit.loadKw.minus20 }
              : null,
            kpm: heat.gasKwhPerM3,
            eff: heat.boilerEfficiencyPct,
            ok: heat.configured,
          }
        : null,
      inertia: inertia ? { ...inertia, c: fit ? roundTo((inertia.tau * fit.wPerK) / 1000, 1) : null } : null,
    };
  }

  /* ── the heat characteristic ──────────────────────────────────────────────────────────────── */

  private async readHeatLoss(today: LocalDate, now: EpochMs): Promise<HeatLossDto> {
    const tz = this.clock.tz();
    const from = addDays(today, -HEAT_DAYS);
    const to = addDays(today, -1);
    const fromMs = fromLocal(from, 0, tz);
    const toMs = fromLocal(today, 0, tz);
    const tariffs = this.config.singleton('settings').tariffs;
    const efficiency = tariffs.boilerEfficiencyPct / 100;
    const sources = this.config.list('sources');
    const unique = (meters: SourceMeter[]) => [...new Map(meters.map((m) => [m.entityId, m])).values()];
    const gas = unique(sources.flatMap((s) => s.meters.filter((m) => m.kind === 'gas')));
    // a source that burns gas is counted by its gas; the others by what their heat meters measured
    const heat = unique(sources.filter((s) => !s.meters.some((m) => m.kind === 'gas')).flatMap((s) => s.meters.filter((m) => m.kind === 'heat')));
    const dates: LocalDate[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      dates.push(d);
    }

    const empty = (ok: boolean): HeatLossDto => ({
      from,
      to,
      days: dates.map((date) => ({ date, indoorC: null, outdoorC: null, deltaK: null, gasKwh: null, heatKwh: null, used: false })),
      used: 0,
      indoorC: null,
      fit: null,
      gasKwhPerM3: tariffs.gasKwhPerM3,
      boilerEfficiencyPct: tariffs.boilerEfficiencyPct,
      configured: gas.length + heat.length > 0,
      recorder: ok ? 'ok' : 'unavailable',
      now,
    });
    if (!this.ha.connected) {
      return empty(false);
    }

    let gasByDay: Map<LocalDate, number | null>;
    let heatByDay: Map<LocalDate, number | null>;
    let indoor: Map<LocalDate, number>;
    let outdoor: Map<LocalDate, number>;
    try {
      const ids = [...gas, ...heat].map((m) => m.entityId);
      const stats = ids.length ? await this.ha.statistics(ids, fromMs, toMs, 'day', ['change']) : {};
      const perDay = (meters: SourceMeter[], kwh: (m: SourceMeter, v: number) => number | null) => {
        const out = new Map<LocalDate, number | null>();
        for (const m of meters) {
          const rows = new Map((stats[m.entityId] ?? []).map((r) => [toLocal(r.start, tz).date, r.change]));
          for (const date of dates) {
            const v = rows.get(date);
            const e = typeof v === 'number' && Number.isFinite(v) ? kwh(m, v) : null;
            // a meter with no row that day leaves the day unknown
            out.set(date, out.has(date) && out.get(date) === null ? null : e === null ? null : (out.get(date) ?? 0) + e);
          }
        }

        return out;
      };
      gasByDay = perDay(gas, (m, v) => {
        const unit = this.unitOf(m);
        if (!unit) {
          return null;
        }

        return unit.quantity === 'volume' ? v * unit.factor * tariffs.gasKwhPerM3 : v * unit.factor;
      });
      heatByDay = perDay(heat, (m, v) => {
        const unit = this.unitOf(m);

        return unit ? v * unit.factor : null;
      });
      const [rooms, out] = await Promise.all([this.history.indoorMeans(fromMs, toMs, 'hour'), this.history.outdoor(HEAT_DAYS + 1)]);
      indoor = dailyMeans(houseMeans(rooms), tz);
      outdoor = dailyMeans(out.series.flatMap((p) => (p.mean === null ? [] : [{ start: p.start, mean: p.mean }])), tz);
      this.once.reset('heat');
    } catch (e) {
      this.once.warn('heat', `recorder query for the heat characteristic failed: ${errorText(e)}`);

      return empty(false);
    }

    const days = dates.map((date): HeatLossDay => {
      const indoorC = indoor.get(date) ?? null;
      const outdoorC = outdoor.get(date) ?? null;
      const g = gas.length ? (gasByDay.get(date) ?? null) : 0;
      const h = heat.length ? (heatByDay.get(date) ?? null) : 0;
      const known = (gas.length || heat.length) && g !== null && h !== null;
      const heatKwh = known ? (g as number) * efficiency + (h as number) : null;
      const deltaK = indoorC !== null && outdoorC !== null ? indoorC - outdoorC : null;

      return {
        date,
        indoorC: roundTo(indoorC, 1),
        outdoorC: roundTo(outdoorC, 1),
        deltaK: roundTo(deltaK, 1),
        gasKwh: gas.length ? roundTo(g, 2) : null,
        heatKwh: roundTo(heatKwh, 2),
        used: heatKwh !== null && heatKwh >= MIN_HEAT_KWH && deltaK !== null && deltaK >= MIN_DELTA_K,
      };
    });
    const points = days.filter((d) => d.used);
    const indoorC = points.length ? points.reduce((sum, d) => sum + (d.indoorC as number), 0) / points.length : null;

    return {
      ...empty(true),
      days,
      used: points.length,
      indoorC: roundTo(indoorC, 1),
      fit: indoorC === null ? null : fitLine(points.map((d) => [d.deltaK as number, d.heatKwh as number]), indoorC),
    };
  }

  private unitOf(m: SourceMeter) {
    const live = this.ha.getState(m.entityId)?.attributes.unit_of_measurement;
    const info = meterUnit(typeof live === 'string' && live ? live : m.unit);

    return info && METER_QUANTITIES[m.kind].includes(info.quantity) ? info : null;
  }

  /* ── the last 24 h ────────────────────────────────────────────────────────────────────────── */

  /** The outdoor mean of each hour since `from` (24 of them), by the hour that holds its middle. */
  private async outdoorHours(from: EpochMs): Promise<(number | null)[]> {
    const { series } = await this.history.outdoor(2);
    const byHour = new Map(series.map((p) => [p.start, p.mean]));

    return Array.from({ length: 24 }, (_, k) => {
      const mid = from + k * HOUR + HOUR / 2;
      const v = byHour.get(Math.floor(mid / HOUR) * HOUR) ?? null;

      return roundTo(v, 1);
    });
  }

  /** Every enabled source's runs since `from`, with the pumps of the circuits that run with it. */
  private async cycles(from: EpochMs, now: EpochMs): Promise<SourceCycles[]> {
    const cfg = this.config.engineConfig();
    const names = sourceLabels(cfg);
    const minutes = (list: RunSpan[]): [number, number | null][] =>
      list
        .filter((s) => s.kind === 'run')
        .sort((a, b) => a.startTs - b.startTs)
        .map((s) => [Math.max(0, Math.round((s.startTs - from) / MIN)), s.endTs === null ? null : Math.round((Math.min(s.endTs, now) - from) / MIN)]);
    const sources = [...cfg.sources].filter((s) => s.enabled).sort((a, b) => a.order - b.order);

    return Promise.all(
      sources.map(async (s): Promise<SourceCycles> => {
        const loops = new Set(cfg.circuits.filter((c) => c.mode === 'follow_source' && c.sourceIds.includes(s.id)).map((c) => c.id));
        const pumps = cfg.pumps.filter((p) => p.enabled && p.circuitId !== null && loops.has(p.circuitId)).sort((a, b) => a.order - b.order);
        const [runs, ...pumpRuns] = await Promise.all([this.spans.range(from, now, 'source', s.id), ...pumps.map((p) => this.spans.range(from, now, 'pump', p.id))]);

        return { id: s.id, n: names.get(s.id) ?? s.name, runs: minutes(runs), p: pumps.map((p, i) => ({ id: p.id, n: p.name, runs: minutes(pumpRuns[i]) })) };
      }),
    );
  }

  /* ── how fast the house cools ─────────────────────────────────────────────────────────────── */

  /**
   * The time constant of the rooms' mean temperature in the night pauses of the last ten days: no
   * source ran, from half an hour after the last run, at least two hours between 22:00 and 06:00. In a
   * pause the rooms fall towards the outdoors as T = Tout + (T0 − Tout)·e^(−t/τ); each pause gives a τ,
   * the median of the last ten is the house's.
   */
  private inertia(now: EpochMs): Promise<{ tau: number; n: number } | null> {
    return this.cached(`inertia|${Math.floor(now / INERTIA_CACHE_MS)}|${this.config.revision()}`, INERTIA_CACHE_MS, async () => {
      const tz = this.clock.tz();
      const from = now - INERTIA_DAYS * DAY;
      const runs = merge((await this.spans.range(from, now, 'source')).filter((s) => s.kind === 'run').map((s): Interval => [s.startTs, s.endTs ?? now]));
      const pauses: Interval[] = [];
      let last = from;
      for (const [a, b] of [...runs, [now, now] as Interval]) {
        if (a > last) {
          pauses.push(...nightParts([last + SETTLE_MS, a], tz));
        }

        last = Math.max(last, b);
      }

      const usable = pauses.filter(([a, b]) => b - a >= PAUSE_MIN_MS && a >= from);
      if (!usable.length) {
        return null;
      }

      const [fine, hourly, out] = await Promise.all([
        this.history.indoorMeans(from, now, '5minute'),
        this.history.indoorMeans(from, now, 'hour'),
        this.history.outdoor(INERTIA_DAYS + 1),
      ]);
      const house = houseMeans(fine);
      const hours = houseMeans(hourly);
      const outdoor = out.series.flatMap((p) => (p.mean === null ? [] : [{ start: p.start, mean: p.mean }]));
      // the 5-minute mean around the moment; without one, the hourly means between their middles
      const at = (t: EpochMs) => house.find((p) => p.start <= t && t < p.start + 5 * MIN)?.mean ?? between(hours, t);
      const taus: number[] = [];
      for (const [a, b] of usable) {
        const t0 = at(a);
        const t1 = at(b - 5 * MIN);
        const outs = outdoor.filter((p) => p.start + HOUR > a && p.start < b).map((p) => p.mean);
        if (t0 === null || t1 === null || !outs.length) {
          continue;
        }

        const tout = outs.reduce((sum, v) => sum + v, 0) / outs.length;
        if (t0 - tout < MIN_GAP_K || t0 - t1 < MIN_DROP_K || t1 <= tout) {
          continue;
        }

        const hours = (b - 5 * MIN - a) / HOUR;
        taus.push(hours / Math.log((t0 - tout) / (t1 - tout)));
      }

      const recent = taus.slice(-PAUSES_KEEP).sort((x, y) => x - y);
      if (!recent.length) {
        return null;
      }

      const mid = recent.length / 2;
      const tau = recent.length % 2 ? recent[Math.floor(mid)] : (recent[mid - 1] + recent[mid]) / 2;

      return { tau: roundTo(tau, 1) as number, n: recent.length };
    });
  }

  /* ── helpers ──────────────────────────────────────────────────────────────────────────────── */

  private failed<T>(what: string, e: unknown, fallback: T): T {
    this.once.warn(`widgets:${what}`, `widget data (${what}) failed: ${errorText(e)}`);

    return fallback;
  }

  private cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
    const now = this.clock.now();
    const hit = this.cache.get(key);
    // an answer from a later time is stale too: the simulator's clock travels back to another scenario
    if (hit && hit.at <= now && now - hit.at < hit.ttl) {
      return hit.value as Promise<T>;
    }

    const value = load();
    this.cache.set(key, { at: now, ttl, value });
    value.catch(() => this.cache.delete(key));
    for (const [k, v] of this.cache) {
      if (v.at > now || now - v.at >= v.ttl) {
        this.cache.delete(k);
      }
    }

    return value;
  }
}

/** The house's mean of each period: the mean of the rooms that have one. */
function houseMeans(rooms: Record<Id, { start: EpochMs; mean: number }[]>): { start: EpochMs; mean: number }[] {
  const sums = new Map<EpochMs, { sum: number; n: number }>();
  for (const rows of Object.values(rooms)) {
    for (const r of rows) {
      const acc = sums.get(r.start) ?? { sum: 0, n: 0 };
      acc.sum += r.mean;
      acc.n += 1;
      sums.set(r.start, acc);
    }
  }

  return [...sums.entries()].sort((a, b) => a[0] - b[0]).map(([start, { sum, n }]) => ({ start, mean: sum / n }));
}

/** The mean of each local day over its hours, for days with at least MIN_HOURS of them. */
function dailyMeans(hours: readonly { start: EpochMs; mean: number }[], tz: string): Map<LocalDate, number> {
  const days = new Map<LocalDate, { sum: number; n: number }>();
  for (const h of hours) {
    const date = toLocal(h.start, tz).date;
    const acc = days.get(date) ?? { sum: 0, n: 0 };
    acc.sum += h.mean;
    acc.n += 1;
    days.set(date, acc);
  }

  return new Map([...days.entries()].filter(([, v]) => v.n >= MIN_HOURS).map(([date, v]) => [date, v.sum / v.n]));
}

/** Least squares through [ΔT, kWh]; null with too few days, too little spread, or a line that does not rise. */
export function fitLine(points: readonly [number, number][], indoorC: number): HeatLossFit | null {
  const n = points.length;
  if (n < MIN_POINTS) {
    return null;
  }

  const xs = points.map((p) => p[0]);
  if (Math.max(...xs) - Math.min(...xs) < MIN_SPREAD_K) {
    return null;
  }

  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = points.reduce((s, p) => s + p[1], 0) / n;
  const sxy = points.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0);
  const sxx = points.reduce((s, [x]) => s + (x - mx) ** 2, 0);
  const syy = points.reduce((s, [, y]) => s + (y - my) ** 2, 0);
  const b = sxy / sxx;
  if (!(b > 0)) {
    return null;
  }

  const a = my - b * mx;
  const load = (outdoorC: number) => Math.max(0, (b * (indoorC - outdoorC) + a) / 24);

  return {
    slopeKwhPerK: roundTo(b, 3) as number,
    interceptKwh: roundTo(a, 2) as number,
    r2: roundTo(syy > 0 ? (sxy * sxy) / (sxx * syy) : 1, 2) as number,
    wPerK: Math.round(((b / 24) * 1000) / 10) * 10,
    balanceC: roundTo(indoorC + a / b, 1) as number,
    loadKw: { minus10: roundTo(load(-10), 1) as number, minus20: roundTo(load(-20), 1) as number },
  };
}

/** The value at `t` on the line through the hourly means, each taken at the middle of its hour; null outside them or across a gap. */
function between(hours: readonly { start: EpochMs; mean: number }[], t: EpochMs): number | null {
  const i = hours.findIndex((p) => p.start + HOUR / 2 > t);
  if (i <= 0) {
    return null;
  }

  const a = hours[i - 1];
  const b = hours[i];
  if (b.start - a.start > HOUR) {
    return null;
  }

  return a.mean + ((b.mean - a.mean) * (t - a.start - HOUR / 2)) / HOUR;
}

function merge(list: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const [a, b] of [...list].sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) {
      last[1] = Math.max(last[1], b);
    } else {
      out.push([a, b]);
    }
  }

  return out;
}

/** The parts of [a, b) between 22:00 and 06:00 local time. */
function nightParts([a, b]: Interval, tz: string): Interval[] {
  const out: Interval[] = [];
  if (b <= a) {
    return out;
  }

  for (let date = addDays(toLocal(a, tz).date, -1); fromLocal(date, NIGHT_FROM, tz) < b; date = addDays(date, 1)) {
    const start = Math.max(a, fromLocal(date, NIGHT_FROM, tz));
    const end = Math.min(b, fromLocal(addDays(date, 1), NIGHT_TO, tz));
    if (end > start) {
      out.push([start, end]);
    }
  }

  return out;
}
