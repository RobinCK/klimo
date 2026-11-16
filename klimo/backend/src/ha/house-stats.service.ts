import { Inject, Injectable, Logger } from '@nestjs/common';
import { errorText, LogOnce } from '../common/logger';
import { sourceLabels } from '../config/source-labels';
import { addDays, fromLocal, toLocal } from '../engine/core/time';
import { METER_QUANTITIES, meterUnit } from '../shared/model';
import type {
  ClockPort,
  EntityId,
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
  MeterKind,
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
/**
 * Days closer than this above the difference where the line reaches zero heat ran the heating only part
 * of the time (the season starting, a mild day): they bend the line and are left out of it.
 */
const BALANCE_MARGIN_K = 3;
/** At night the house gets about half its average gains: no sun, less going on. */
const NIGHT_GAINS_SHARE = 0.5;
/** A run's last minutes reach the meter in the next hour: an hour this close after a run is still a heating hour. */
const RUN_TAIL_MS = 15 * MIN;
/** Night pauses are looked for in the last ten days (5-minute statistics are kept as long). */
const INERTIA_DAYS = 10;
/** A pause counts from this long after the last run (radiators and a floor still give their heat)… */
const SETTLE_MS = HOUR;
/** …for at least this long, between 22:00 and 06:00 (no sun, nobody cooking). */
const PAUSE_MIN_MS = 3 * HOUR;
const NIGHT_FROM = 22 * 60;
const NIGHT_TO = 6 * 60;
/**
 * The rooms are this much warmer than where they settle at its start, and fall at least this much: a
 * smaller fall is within the sensors' 0.1° steps and would make τ anything.
 */
const MIN_GAP_K = 5;
const MIN_DROP_K = 0.3;
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
    const [out, src, heat] = await Promise.all([
      this.outdoorHours(from).catch((e) => this.failed('outdoor', e, [] as (number | null)[])),
      this.cycles(from, now),
      this.heatLoss().catch((e) => this.failed('heat', e, null)),
    ]);
    const fit = heat?.fit ?? null;
    // the gains the line shows keep the rooms above the outdoors without heat, at night about half of them:
    // the cooling goes towards that
    const up = fit && fit.interceptKwh < 0 ? (NIGHT_GAINS_SHARE * -fit.interceptKwh) / fit.slopeKwhPerK : 0;
    const inertia = await this.inertia(now, up).catch((e) => this.failed('inertia', e, null));

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
      inertia: inertia ? { ...inertia, up: roundTo(up, 1) as number, c: fit ? roundTo((inertia.tau * fit.wPerK) / 1000, 1) : null } : null,
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
      const [stats, spans] = await Promise.all([
        ids.length ? this.ha.statistics(ids, fromMs, toMs, 'hour', ['change']) : Promise.resolve({} as Awaited<ReturnType<HaPort['statistics']>>),
        this.spans.range(fromMs - HOUR, toMs, 'source'),
      ]);
      // the hours a meter's sources heated (Klimo's runs): hot water, a stove on the gas meter and standby
      // between the runs are not the rooms' heat, and a day before Klimo kept its runs has none
      const heating = spans.filter((x) => x.kind === 'run' && x.mode !== 'cool');
      const runsOf = (entityId: EntityId, kind: MeterKind) => {
        const owners = new Set(sources.filter((x) => x.meters.some((m) => m.kind === kind && m.entityId === entityId)).map((x) => x.id));

        return merge(heating.filter((x) => owners.has(x.subjectId)).map((x): Interval => [x.startTs, (x.endTs ?? now) + RUN_TAIL_MS]));
      };
      const dateOf = new Map<EpochMs, LocalDate>();
      for (let h = Math.floor(fromMs / HOUR) * HOUR; h < toMs; h += HOUR) {
        dateOf.set(h, toLocal(h, tz).date);
      }

      const perDay = (meters: SourceMeter[], kwh: (m: SourceMeter, v: number) => number | null) => {
        const out = new Map<LocalDate, number | null>(dates.map((d) => [d, 0]));
        for (const m of meters) {
          const runs = runsOf(m.entityId, m.kind);
          const rows = new Map((stats[m.entityId] ?? []).map((r) => [r.start, r.change]));
          for (const [h, date] of dateOf) {
            const sum = out.get(date);
            if (sum === undefined || sum === null || !overlaps(runs, h, h + HOUR)) {
              continue;
            }

            const v = rows.get(h);
            const e = typeof v === 'number' && Number.isFinite(v) ? kwh(m, v) : null;
            // a heating hour without the meter's row leaves the day unknown
            out.set(date, e === null ? null : sum + e);
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
    const fit = indoorC === null ? null : fitLine(points.map((d) => [d.deltaK as number, d.heatKwh as number]), indoorC);
    // the days near the balance the line left out are not its points
    const kept = fit ? days.map((d) => ({ ...d, used: d.used && (d.deltaK as number) >= fit.minDeltaK })) : days;

    return {
      ...empty(true),
      days: kept,
      used: kept.filter((d) => d.used).length,
      indoorC: roundTo(indoorC, 1),
      fit,
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
   * source ran, from an hour after the last run, at least three hours between 22:00 and 06:00. In a
   * pause the rooms fall towards where they would settle without heat — the outdoors plus `up`, what
   * the house's own gains at night (people, appliances) hold them above it — as T = T∞ + (T0 − T∞)·e^(−t/τ);
   * each pause gives a τ, the median of the last ten is the house's.
   */
  private inertia(now: EpochMs, up: number): Promise<{ tau: number; n: number } | null> {
    const key = `inertia|${Math.floor(now / INERTIA_CACHE_MS)}|${this.config.revision()}|${up.toFixed(2)}`;

    return this.cached(key, INERTIA_CACHE_MS, async () => {
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
      const at = (t: EpochMs) => house.find((p) => p.start <= t && t < p.start + 5 * MIN)?.mean ?? null;
      /**
       * The rooms at the start and the end of the pause: the 5-minute means there, or without them the
       * first and the last hour wholly inside it, each at its middle (an hour that holds a run would lift its end).
       */
      const ends = (a: EpochMs, b: EpochMs): { from: EpochMs; to: EpochMs; t0: number; t1: number } | null => {
        const end = b - 5 * MIN;
        const t0 = at(a);
        const t1 = at(end);
        if (t0 !== null && t1 !== null) {
          return { from: a, to: end, t0, t1 };
        }

        const inside = hours.filter((h) => h.start >= a && h.start + HOUR <= b);
        if (inside.length < 2) {
          return null;
        }

        const first = inside[0];
        const last = inside[inside.length - 1];

        return { from: first.start + HOUR / 2, to: last.start + HOUR / 2, t0: first.mean, t1: last.mean };
      };
      // the outdoors through the night (it gets colder towards morning), from the hourly means
      const outdoorAt = (t: EpochMs) => between(outdoor, t) ?? outdoor.find((p) => p.start <= t && t < p.start + HOUR)?.mean ?? null;
      const taus: number[] = [];
      for (const [a, b] of usable) {
        const seen = ends(a, b);
        const outs = outdoor.filter((p) => p.start + HOUR > a && p.start < b).map((p) => p.mean);
        if (!seen || !outs.length) {
          continue;
        }

        const { t0, t1 } = seen;
        const settle = outs.reduce((sum, v) => sum + v, 0) / outs.length + up;
        if (t0 - settle < MIN_GAP_K || t0 - t1 < MIN_DROP_K || t1 <= settle) {
          continue;
        }

        const tau = solveTau(seen.from, seen.to, t0, t1, (t) => {
          const o = outdoorAt(t);

          return o === null ? null : o + up;
        });
        if (tau !== null) {
          taus.push(tau);
        }
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

/** Least squares through [x, y]; null with too few points, too little spread, or a line that does not rise. */
function leastSquares(points: readonly [number, number][]): { a: number; b: number; r2: number } | null {
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

  return { a: my - b * mx, b, r2: syy > 0 ? (sxy * sxy) / (sxx * syy) : 1 };
}

/**
 * The line through the days [ΔT, kWh]. Days within 3 K above where it reaches zero heat ran the
 * heating only part of the time, so they are left out and the line drawn again, until it holds. The
 * slope is the heat loss; the load at a temperature is that loss times the difference, as a heat-load
 * calculation gives it (gains are not counted on: a cold, dark night has few). A line that reaches zero
 * shows the gains, and where it does is the balance temperature; one that stays above zero has none to show.
 */
export function fitLine(points: readonly [number, number][], indoorC: number): HeatLossFit | null {
  let line = leastSquares(points);
  let kept = points.length;
  let cut = MIN_DELTA_K;
  for (let i = 0; line && line.a < 0 && i < 4; i++) {
    const next = Math.max(MIN_DELTA_K, -line.a / line.b + BALANCE_MARGIN_K);
    // the days above a threshold: the same count is the same days, and the line holds
    const trimmed = points.filter(([x]) => x >= next);
    if (trimmed.length === kept) {
      cut = next;
      break;
    }

    const again = leastSquares(trimmed);
    if (!again) {
      break;
    }

    line = again;
    kept = trimmed.length;
    cut = next;
  }

  if (!line) {
    return null;
  }

  const { a, b } = line;
  const load = (outdoorC: number) => Math.max(0, (b * (indoorC - outdoorC)) / 24);

  return {
    slopeKwhPerK: roundTo(b, 3) as number,
    interceptKwh: roundTo(a, 2) as number,
    r2: roundTo(line.r2, 2) as number,
    wPerK: Math.round(((b / 24) * 1000) / 5) * 5,
    balanceC: a < 0 ? (roundTo(indoorC + a / b, 1) as number) : null,
    loadKw: { minus10: roundTo(load(-10), 1) as number, minus20: roundTo(load(-20), 1) as number },
    minDeltaK: roundTo(cut, 1) as number,
  };
}

/**
 * The τ (h) for which the rooms, at `t0` at `a`, would be at `t1` at `b` cooling towards `towards(t)`:
 * every 5 minutes T moves to towards + (T − towards)·e^(−5 min/τ). A slower fall means a longer τ, so
 * it is found by halving between 1 h and 2000 h; null when no τ there gives `t1` or the outdoors is unknown.
 */
function solveTau(a: EpochMs, b: EpochMs, t0: number, t1: number, towards: (t: EpochMs) => number | null): number | null {
  const step = 5 * MIN;
  const endAt = (tau: number): number | null => {
    let temp = t0;
    for (let t = a; t < b; t += step) {
      const dt = Math.min(step, b - t);
      const target = towards(t + dt / 2);
      if (target === null) {
        return null;
      }

      temp = target + (temp - target) * Math.exp(-dt / (tau * HOUR));
    }

    return temp;
  };
  let lo = 1;
  let hi = 2000;
  const fast = endAt(lo);
  const slow = endAt(hi);
  if (fast === null || slow === null || t1 < fast || t1 > slow) {
    return null;
  }

  for (let i = 0; i < 40; i++) {
    const mid = Math.sqrt(lo * hi);
    if ((endAt(mid) as number) < t1) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  return Math.sqrt(lo * hi);
}

/** Whether [a, b) meets one of the sorted, merged intervals. */
function overlaps(list: readonly Interval[], a: EpochMs, b: EpochMs): boolean {
  return list.some(([x, y]) => x < b && y > a);
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
