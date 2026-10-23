import { Inject, Injectable, Logger } from '@nestjs/common';
import { notFound, validationError } from '../common/http';
import { errorText, LogOnce } from '../common/logger';
import { addDays, fromLocal, isLocalDate, toLocal } from '../engine/core/time';
import { HDD_BASE_C } from '../shared/defaults';
import { CONSUMPTION_RANGES, METER_KINDS, meterUnit, METER_QUANTITIES, outdoorSensorIds } from '../shared/model';
import type {
  ClockPort,
  ConsumptionBucket,
  ConsumptionMeterDto,
  ConsumptionQuery,
  ConsumptionRange,
  ConsumptionRun,
  ConsumptionTotals,
  ConsumptionUnits,
  ConsumptionValues,
  ConsumerUse,
  EnergyTariffs,
  EntityId,
  EpochMs,
  GasPriceUnit,
  HaPort,
  HouseConsumptionDto,
  IConfigStore,
  IConsumption,
  Id,
  ISpanStore,
  LocalDate,
  MeterKind,
  MeterUnitInfo,
  RunSpan,
  SourceConfig,
  SourceConsumptionDto,
  SourceMeter,
} from '../shared/model';
import { CLOCK, CONFIG_STORE, HA_PORT, SPAN_STORE } from '../tokens';
import {
  attributeRuns,
  costOf,
  degreeDays,
  gasKwh,
  integrateKw,
  type MeterReading,
  outdoorMean,
  type OutdoorRow,
  type PeriodPlan,
  planPeriod,
  ratio,
  roundTo,
  type RunShare,
  type RunWindow,
  rowChanges,
  runningTotal,
  shiftPeriod,
  totalDelta,
  type TotalPoint,
} from './meters';
import { combineBuckets } from './outdoor';
import { domainOf, isAvailableState, parseNumber } from './units';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const CACHE_MS = MIN;
/** The latest compiled hour is looked for this far back. */
const RECENT_MS = 3 * HOUR;
/** The recorder keeps ten days of states by default: state history is not asked for further back. */
const HISTORY_MS = 8 * DAY;
/** Below these inputs a ratio says nothing (a few minutes of standby). */
const MIN_GAS_KWH = 0.1;
const MIN_ELECTRICITY_KWH = 0.05;
const MIN_HDD = 1;

type Fine = 'hour' | 'day';
type StatRows = Awaited<ReturnType<HaPort['statistics']>>;

/** A source's meter as it can be read now. */
interface MeterRef {
  meter: SourceMeter;
  dto: ConsumptionMeterDto;
  /** null when the unit is not one a meter of this kind is read in. */
  unit: MeterUnitInfo | null;
}

/** Consumption of one meter in chart units: statistics rows, then pieces read from the state history after them. */
interface MeterSeries {
  /** [start, end) and what the meter grew in it; `end` is where its data ends (a running day: the last compiled hour). */
  pieces: { start: EpochMs; end: EpochMs; value: number | null }[];
  /** Running total from the state history (counters), for single runs. */
  totals: TotalPoint[];
  /** Readings in kW (power sensors), for single runs. */
  power: MeterReading[];
}

interface Reading {
  ok: boolean;
  series: Map<EntityId, MeterSeries>;
  outdoor: OutdoorRow[];
}

interface Window {
  from: EpochMs;
  to: EpochMs;
}

const EMPTY_VALUES: ConsumptionValues = { gas: null, electricity: null, heat: null, cost: null };

/** End of the period the window is cut at while it is still running: the same time elapsed («so far»). */
export function sameElapsed(plan: PeriodPlan, prev: PeriodPlan, now: EpochMs): EpochMs {
  if (now <= plan.from || now >= plan.to) {
    return prev.to;
  }

  return Math.min(prev.to, prev.from + (now - plan.from));
}

/** Minutes the spans ran inside [a, b); an open span runs until `now`. */
export function runtimeMin(spans: readonly RunSpan[], a: EpochMs, b: EpochMs, now: EpochMs): number {
  let ms = 0;
  for (const s of spans) {
    ms += Math.max(0, Math.min(s.endTs ?? now, b) - Math.max(s.startTs, a));
  }

  return ms / MIN;
}

/** The runs a period lists: every one that ran inside [a, b), also when it began before or ended after. */
function runsIn(spans: readonly RunSpan[], a: EpochMs, b: EpochMs, now: EpochMs): RunSpan[] {
  return spans.filter((s) => s.startTs < b && (s.endTs ?? now) > a);
}

/**
 * What a source used — gas, electricity, heat — by hour, day or month, with cost, runtime, outdoor
 * temperature, heating degree-days and efficiency, plus single runs. Everything is read on request:
 * meters from HA's long-term statistics (the latest, not yet compiled hour from the state history),
 * runtime from Klimo's run spans. Nothing is stored.
 */
@Injectable()
export class ConsumptionService implements IConsumption {
  private readonly log = new Logger('Consumption');
  private readonly once = new LogOnce(this.log);
  private readonly cache = new Map<string, { at: EpochMs; value: Promise<unknown> }>();

  constructor(
    @Inject(HA_PORT) private readonly ha: HaPort,
    @Inject(CONFIG_STORE) private readonly config: IConfigStore,
    @Inject(SPAN_STORE) private readonly spans: ISpanStore,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async source(sourceId: Id, q: ConsumptionQuery): Promise<SourceConsumptionDto> {
    const source = this.config.get('sources', sourceId);
    if (!source) {
      throw notFound('Source');
    }

    const range = q.range ?? 'day';
    if (!CONSUMPTION_RANGES.includes(range)) {
      throw validationError([{ path: 'range', code: 'enum', params: { values: CONSUMPTION_RANGES.join('|') } }]);
    }

    const now = this.clock.now();
    const date = this.dateOf(q.date, now);
    const key = `source|${source.id}|${range}|${date}|${Math.floor(now / MIN)}|${this.config.revision()}`;

    return this.cached(key, () => this.buildSource(source, range, date, now));
  }

  async house(q: Partial<ConsumptionQuery> = {}): Promise<HouseConsumptionDto> {
    const range = q.range ?? 'day';
    if (!CONSUMPTION_RANGES.includes(range)) {
      throw validationError([{ path: 'range', code: 'enum', params: { values: CONSUMPTION_RANGES.join('|') } }]);
    }

    const now = this.clock.now();
    const date = this.dateOf(q.date, now);
    const key = `house|${range}|${date}|${Math.floor(now / MIN)}|${this.config.revision()}`;

    return this.cached(key, () => this.buildHouse(range, date, now));
  }

  /* ── plumbing ─────────────────────────────────────────────────────────────────────────────── */

  private dateOf(date: LocalDate | undefined, now: EpochMs): LocalDate {
    if (date !== undefined && !isLocalDate(date)) {
      throw validationError([{ path: 'date', code: 'date' }]);
    }

    return date ?? toLocal(now, this.clock.tz()).date;
  }

  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const now = this.clock.now();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < CACHE_MS) {
      return hit.value as Promise<T>;
    }

    const value = load();
    this.cache.set(key, { at: now, value });
    value.catch(() => this.cache.delete(key));
    for (const [k, v] of this.cache) {
      if (now - v.at >= CACHE_MS) {
        this.cache.delete(k);
      }
    }

    return value;
  }

  private tariffs(): EnergyTariffs {
    return this.config.singleton('settings').tariffs;
  }

  /** Meters of a source or a pump with their live unit and state. */
  private meterRefs(meters: readonly SourceMeter[]): MeterRef[] {
    return meters.map((meter) => {
      const st = this.ha.getState(meter.entityId);
      const liveUnit = st?.attributes.unit_of_measurement;
      const unitText = typeof liveUnit === 'string' && liveUnit ? liveUnit : meter.unit;
      const info = meterUnit(unitText);
      const fits = !!info && METER_QUANTITIES[meter.kind].includes(info.quantity);
      const friendly = st?.attributes.friendly_name;
      let status: ConsumptionMeterDto['status'] = 'ok';
      if (!fits) {
        status = 'unsupported_unit';
      } else if (!st) {
        status = this.ha.connected ? 'missing' : 'unavailable';
      } else if (!isAvailableState(st.state)) {
        status = 'unavailable';
      }

      return {
        meter,
        unit: fits ? info : null,
        dto: {
          kind: meter.kind,
          entityId: meter.entityId,
          name: typeof friendly === 'string' && friendly.trim() ? friendly : null,
          unit: unitText,
          reading: info?.quantity === 'power' ? 'power' : 'meter',
          status,
          statistics: typeof st?.attributes.state_class === 'string',
        },
      };
    });
  }

  private async runSpans(from: EpochMs, to: EpochMs, subject: 'source' | 'pump', subjectId?: Id): Promise<RunSpan[]> {
    try {
      return (await this.spans.range(from, to, subject, subjectId)).filter((s) => s.kind === 'run');
    } catch (e) {
      this.once.warn('spans', `run spans unavailable: ${errorText(e)}`);

      return [];
    }
  }

  /* ── reading Home Assistant ───────────────────────────────────────────────────────────────── */

  /**
   * Every meter over the window in one statistics call (`fine` rows: hours, or days for a year), the
   * latest compiled hour, then one state-history call for what statistics do not hold yet and for
   * single runs from `runsFrom`. A failing recorder leaves the meters unknown, never the request.
   */
  private async read(refs: MeterRef[], w: Window, fine: Fine, runsFrom: EpochMs | null, withOutdoor: boolean, now: EpochMs): Promise<Reading> {
    const usable = [...new Map(refs.filter((r) => r.unit).map((r) => [r.meter.entityId, r])).values()];
    const empty: Reading = { ok: this.ha.connected, series: new Map(), outdoor: [] };
    if (!this.ha.connected || w.to <= w.from) {
      return empty;
    }

    try {
      const ids = usable.map((r) => r.meter.entityId);
      const step = fine === 'hour' ? HOUR : DAY;
      const stats: StatRows = ids.length ? await this.ha.statistics(ids, w.from - step, w.to, fine, ['change', 'sum', 'state', 'mean']) : {};
      const needTail = w.to > now - RECENT_MS;
      const hourly: StatRows = fine === 'hour' || !needTail || !ids.length ? stats : await this.ha.statistics(ids, now - RECENT_MS, now, 'hour', ['change', 'sum', 'state', 'mean']);
      const statsEnd = new Map(ids.map((id) => [id, lastHourEnd(hourly[id])]));
      const histFrom = this.historyFrom(ids, statsEnd, w, runsFrom, needTail, now);
      const raw = histFrom !== null && ids.length ? await this.ha.history(ids, histFrom, w.to, { minimal: true, noAttributes: true }) : {};
      const series = new Map<EntityId, MeterSeries>();
      for (const ref of usable) {
        const id = ref.meter.entityId;
        const readings = (raw[id] ?? []).map((row) => ({ t: Math.round(row.lu * 1000), v: scaled(parseNumber(row.s), ref.unit) }));
        series.set(id, buildSeries(ref, stats[id] ?? [], fine, w, statsEnd.get(id) ?? null, histFrom, readings, this.clock.tz()));
      }

      const outdoor = withOutdoor ? await this.outdoorRows(w, fine) : [];
      this.once.reset('recorder');

      return { ok: true, series, outdoor };
    } catch (e) {
      this.once.warn('recorder', `recorder query for consumption failed: ${errorText(e)}`);

      return { ok: false, series: new Map(), outdoor: [] };
    }
  }

  /** Where the state history has to start: the earliest end of statistics, or the first run, within the recorder's reach. */
  private historyFrom(ids: EntityId[], statsEnd: Map<EntityId, EpochMs | null>, w: Window, runsFrom: EpochMs | null, needTail: boolean, now: EpochMs): EpochMs | null {
    const floor = Math.max(w.from, now - HISTORY_MS);
    let from: EpochMs | null = runsFrom === null ? null : Math.max(floor, runsFrom - HOUR);
    if (needTail) {
      for (const id of ids) {
        const end = statsEnd.get(id) ?? null;
        const start = end === null ? floor : Math.max(floor, Math.min(end, w.to));
        from = from === null ? start : Math.min(from, start);
      }
    }

    return from !== null && from < w.to ? from : null;
  }

  /** Mean outdoor temperature per hour (or day), the configured sensors combined like the live value. */
  private async outdoorRows(w: Window, fine: Fine): Promise<OutdoorRow[]> {
    const o = this.config.singleton('settings').outdoor;
    const ids = outdoorSensorIds(o).filter((id) => domainOf(id) !== 'weather');
    if (!ids.length) {
      return [];
    }

    const stats = await this.ha.statistics(ids, w.from, w.to, fine, ['mean']);
    const perSensor = ids.map((id) => (stats[id] ?? []).map((r) => ({ start: r.start, value: typeof r.mean === 'number' ? r.mean : null })));
    const tz = this.clock.tz();

    return combineBuckets(perSensor, o.aggregation).flatMap(([start, meanC]) => (meanC === null ? [] : [{ start, end: rowEnd(start, fine, tz), meanC }]));
  }

  /* ── one source ───────────────────────────────────────────────────────────────────────────── */

  private async buildSource(source: SourceConfig, range: ConsumptionRange, date: LocalDate, now: EpochMs): Promise<SourceConsumptionDto> {
    const tz = this.clock.tz();
    const plan = planPeriod(range, date, tz);
    const prevPlan = planPeriod(range, shiftPeriod(range, plan.date, -1), tz);
    const prev: Window = { from: prevPlan.from, to: sameElapsed(plan, prevPlan, now) };
    const until = Math.max(plan.from, Math.min(plan.to, now));
    const refs = this.meterRefs(source.meters);
    const tariffs = this.tariffs();
    const withRuns = range === 'day' || range === 'week';
    const spans = await this.runSpans(prevPlan.from, plan.to, 'source', source.id);
    // a run across the period's edge (last night's, from 23:36 to 06:30) is measured whole in either day,
    // so the readings reach past the edges; buckets and totals still stop at them
    const listed = withRuns ? runsIn(spans, plan.from, until, now) : [];
    const runsFrom = withRuns ? Math.min(plan.from, ...listed.map((s) => s.startTs)) : null;
    const readTo = Math.max(until, ...listed.map((s) => Math.min(s.endTs ?? now, now)));
    const reading = await this.read(refs, { from: prevPlan.from, to: readTo }, range === 'year' ? 'day' : 'hour', runsFrom, true, now);
    const values = new MeterValues(refs, reading, tariffs);
    const totals = (a: EpochMs, b: EpochMs): ConsumptionTotals => this.totals(values, spans, reading.outdoor, a, b, now);

    return {
      sourceId: source.id,
      range,
      date: plan.date,
      from: plan.from,
      to: plan.to,
      bucket: plan.bucket,
      buckets: plan.edges.slice(0, -1).map((start, i) => this.bucket(values, spans, reading.outdoor, start, plan.edges[i + 1], now)),
      totals: totals(plan.from, until),
      previous: { date: prevPlan.date, from: prev.from, to: prev.to, totals: totals(prev.from, prev.to), complete: values.knownFrom(prev.from, range === 'year' ? DAY : HOUR) },
      runs: withRuns ? this.runs(values, spans, plan.from, until, now) : null,
      meters: refs.map((r) => r.dto),
      units: values.units(),
      tariffs,
      hddBaseC: HDD_BASE_C,
      recorder: reading.ok ? 'ok' : 'unavailable',
      now,
    };
  }

  private bucket(values: MeterValues, spans: RunSpan[], outdoor: OutdoorRow[], start: EpochMs, end: EpochMs, now: EpochMs): ConsumptionBucket {
    const future = start >= now;
    const until = Math.min(end, now);
    const v = future ? EMPTY_VALUES : values.between(start, until);
    const tz = this.clock.tz();

    return {
      start,
      end,
      ...rounded(v),
      runtimeMin: future ? 0 : Math.round(runtimeMin(spans, start, until, now)),
      outdoorAvgC: future ? null : roundTo(outdoorMean(outdoor, start, until), 1),
      hdd: future ? null : roundTo(degreeDays(outdoor, start, until, HDD_BASE_C, tz), 2),
      efficiency: roundTo(values.efficiency(v), 2),
      cop: roundTo(values.cop(v), 2),
      partial: start < now && now < end,
      future,
    };
  }

  private totals(values: MeterValues, spans: RunSpan[], outdoor: OutdoorRow[], from: EpochMs, to: EpochMs, now: EpochMs): ConsumptionTotals {
    const v = values.between(from, to);
    const hdd = degreeDays(outdoor, from, to, HDD_BASE_C, this.clock.tz());

    return {
      ...rounded(v),
      runtimeMin: Math.round(runtimeMin(spans, from, to, now)),
      runs: spans.filter((s) => s.startTs >= from && s.startTs < to).length,
      outdoorAvgC: roundTo(outdoorMean(outdoor, from, to), 1),
      hdd: roundTo(hdd, 2),
      gasPerHdd: v.gas !== null && hdd !== null && hdd >= MIN_HDD ? roundTo(v.gas / hdd, 3) : null,
      efficiency: roundTo(values.efficiency(v), 2),
      cop: roundTo(values.cop(v), 2),
    };
  }

  private runs(values: MeterValues, spans: RunSpan[], from: EpochMs, to: EpochMs, now: EpochMs): ConsumptionRun[] {
    const mine = runsIn(spans, from, to, now).sort((a, b) => a.startTs - b.startTs);
    const windows = mine.map((s) => ({ start: s.startTs, end: s.endTs ?? now }));
    const shares = values.runShares(windows);

    return mine.map((s, i) => {
      const gas = shares.gas[i];
      const electricity = shares.electricity[i];
      const heat = shares.heat[i];

      return {
        start: s.startTs,
        end: s.endTs,
        minutes: Math.round((windows[i].end - windows[i].start) / MIN),
        mode: s.mode,
        gas: roundTo(gas.value, 3),
        electricity: roundTo(electricity.value, 3),
        heat: roundTo(heat.value, 3),
        cost: roundTo(values.cost(gas.value, electricity.value), 2),
        estimated: gas.estimated || electricity.estimated || heat.estimated,
      };
    });
  }

  /* ── the house ────────────────────────────────────────────────────────────────────────────── */

  /**
   * Every source and pump with a meter over the period, read in one go: the house counts each meter
   * once (a gas meter shared by two boilers is not doubled), each row counts its own meters whole.
   */
  private async buildHouse(range: ConsumptionRange, date: LocalDate, now: EpochMs): Promise<HouseConsumptionDto> {
    const tz = this.clock.tz();
    const plan = planPeriod(range, date, tz);
    const prevPlan = planPeriod(range, shiftPeriod(range, plan.date, -1), tz);
    const prevTo = sameElapsed(plan, prevPlan, now);
    const until = Math.max(plan.from, Math.min(plan.to, now));
    const tariffs = this.tariffs();
    const counted = (meters: readonly SourceMeter[]) => this.meterRefs(meters).filter((r) => r.meter.kind !== 'heat');
    const sources = this.config
      .list('sources')
      .map((s) => ({ id: s.id, refs: counted(s.meters) }))
      .filter((s) => s.refs.length);
    const pumps = this.config.list('pumps').flatMap((p) => (p.meter ? [{ id: p.id, refs: counted([p.meter]) }] : []));
    const all = [...sources, ...pumps].flatMap((x) => x.refs);
    const [sourceSpans, pumpSpans] = await Promise.all([this.runSpans(plan.from, plan.to, 'source'), this.runSpans(plan.from, plan.to, 'pump')]);
    const reading = await this.read(all, { from: prevPlan.from, to: until }, range === 'year' ? 'day' : 'hour', null, false, now);
    const house = new MeterValues(all, reading, tariffs);
    const use = (refs: MeterRef[], spans: RunSpan[]): ConsumerUse => {
      const own = new MeterValues(refs, reading, tariffs);
      const v = own.between(plan.from, until);

      return {
        gas: roundTo(own.gasIn(v.gas, house.gasUnit()), 3),
        electricity: roundTo(v.electricity, 3),
        cost: roundTo(v.cost, 2),
        runtimeMin: Math.round(runtimeMin(spans, plan.from, until, now)),
        meters: refs.map((r) => r.dto),
      };
    };
    const total = house.between(plan.from, until);

    return {
      range,
      date: plan.date,
      from: plan.from,
      to: plan.to,
      bucket: plan.bucket,
      buckets: plan.edges.slice(0, -1).map((start, i) => {
        const end = plan.edges[i + 1];
        const future = start >= now;
        const v = future ? EMPTY_VALUES : house.between(start, Math.min(end, now));

        return { start, end, gas: roundTo(v.gas, 3), electricity: roundTo(v.electricity, 3), cost: roundTo(v.cost, 2), partial: start < now && now < end, future };
      }),
      gas: roundTo(total.gas, 3),
      electricity: roundTo(total.electricity, 3),
      cost: roundTo(total.cost, 2),
      previous: rounded(house.between(prevPlan.from, prevTo)),
      previousDate: prevPlan.date,
      previousComplete: house.knownFrom(prevPlan.from, range === 'year' ? DAY : HOUR),
      units: house.units(),
      tariffs,
      sources: sources.map((s) => ({ sourceId: s.id, ...use(s.refs, sourceSpans.filter((x) => x.subjectId === s.id)) })),
      pumps: pumps.map((p) => ({ pumpId: p.id, ...use(p.refs, pumpSpans.filter((x) => x.subjectId === p.id)) })),
      configured: all.length > 0,
      recorder: reading.ok ? 'ok' : 'unavailable',
      now,
    };
  }
}

/* ── per-meter series ───────────────────────────────────────────────────────────────────────────── */

const scaled = (v: number | null, unit: MeterUnitInfo | null): number | null => (v === null || !unit ? null : v * unit.factor);

function lastHourEnd(rows: StatRows[string] | undefined): EpochMs | null {
  if (!rows?.length) {
    return null;
  }

  return Math.max(...rows.map((r) => r.start)) + HOUR;
}

/** End of a statistics row: an hour, or the next local midnight (23 or 25 hours on DST days). */
function rowEnd(start: EpochMs, fine: Fine, tz: string): EpochMs {
  return fine === 'hour' ? start + HOUR : fromLocal(addDays(toLocal(start, tz).date, 1), 0, tz);
}

/**
 * Statistics rows turned into chart units (a counter's change, a power sensor's mean × hours), then
 * hour pieces from the state history for what statistics do not hold yet (`statsEnd` onwards, or the
 * whole history window for a sensor without statistics).
 */
function buildSeries(ref: MeterRef, rows: StatRows[string], fine: Fine, w: Window, statsEnd: EpochMs | null, histFrom: EpochMs | null, readings: MeterReading[], tz: string): MeterSeries {
  const unit = ref.unit as MeterUnitInfo;
  const power = unit.quantity === 'power';
  const sorted = [...rows].sort((a, b) => a.start - b.start);
  const changes = power ? [] : rowChanges(sorted);
  const pieces: MeterSeries['pieces'] = [];
  sorted.forEach((r, i) => {
    if (r.start < w.from || r.start >= w.to) {
      return;
    }

    const end = Math.min(rowEnd(r.start, fine, tz), statsEnd ?? Infinity, w.to);
    const value = power ? (typeof r.mean === 'number' ? (r.mean * unit.factor * Math.max(0, end - r.start)) / HOUR : null) : changes[i] === null ? null : (changes[i] as number) * unit.factor;
    pieces.push({ start: r.start, end, value });
  });

  const totals = power ? [] : runningTotal(readings);
  const tailFrom = sorted.length ? statsEnd : histFrom;
  if (tailFrom !== null && histFrom !== null) {
    for (let a = Math.max(tailFrom, histFrom); a < w.to; a = Math.floor(a / HOUR) * HOUR + HOUR) {
      const b = Math.min(w.to, Math.floor(a / HOUR) * HOUR + HOUR);
      pieces.push({ start: a, end: b, value: power ? integrateKw(readings, a, b) : totalDelta(totals, a, b) });
    }
  }

  return { pieces: pieces.sort((x, y) => x.start - y.start), totals, power: power ? readings : [] };
}

/* ── values of one source (or the house) ────────────────────────────────────────────────────────── */

interface BoundMeter {
  ref: MeterRef;
  series: MeterSeries | null;
}

/** Gas in `to`, converting between volume and energy with the calorific value. */
function convertGas(gas: number | null, from: GasPriceUnit | null, to: GasPriceUnit | null, kwhPerM3: number): number | null {
  if (gas === null || from === null || to === null || from === to) {
    return gas;
  }

  return to === 'kWh' ? gas * kwhPerM3 : gas / kwhPerM3;
}

/**
 * The meters of one source, or of the whole house: every distinct meter of a kind is summed (a source
 * has at most one per kind; two sources sharing one gas meter count it once). Gas is in m³ while every
 * gas meter counts volume, in kWh as soon as one counts energy.
 */
class MeterValues {
  private readonly byKind: Record<MeterKind, BoundMeter[]> = { gas: [], electricity: [], heat: [] };

  constructor(
    refs: MeterRef[],
    reading: Reading,
    private readonly tariffs: EnergyTariffs,
  ) {
    const seen = new Set<string>();
    for (const ref of refs) {
      const key = `${ref.meter.kind}|${ref.meter.entityId}`;
      if (!ref.unit || seen.has(key)) {
        continue;
      }

      seen.add(key);
      this.byKind[ref.meter.kind].push({ ref, series: reading.series.get(ref.meter.entityId) ?? null });
    }
  }

  has(kind: MeterKind): boolean {
    return this.byKind[kind].length > 0;
  }

  gasUnit(): GasPriceUnit | null {
    const gas = this.byKind.gas;
    if (!gas.length) {
      return null;
    }

    return gas.every((g) => g.ref.unit?.quantity === 'volume') ? 'm³' : 'kWh';
  }

  units(): ConsumptionUnits {
    return {
      gas: this.gasUnit(),
      electricity: this.has('electricity') ? 'kWh' : null,
      heat: this.has('heat') ? 'kWh' : null,
      currency: this.tariffs.currency || null,
    };
  }

  /** Every meter has a known amount from `t` on (allowing one statistics row of `slack`). */
  knownFrom(t: EpochMs, slack: number): boolean {
    return METER_KINDS.every((kind) =>
      this.byKind[kind].every((m) => {
        const first = m.series?.pieces.find((p) => p.value !== null);
        return !!first && first.start <= t + slack;
      }),
    );
  }

  /** What was used in [a, b). */
  between(a: EpochMs, b: EpochMs): ConsumptionValues {
    const unit = this.gasUnit();
    const gas = sumValues(this.byKind.gas.map((m) => convertGas(valueIn(m.series, a, b), meterGasUnit(m.ref), unit, this.tariffs.gasKwhPerM3)));
    const electricity = sumValues(this.byKind.electricity.map((m) => valueIn(m.series, a, b)));
    const heat = sumValues(this.byKind.heat.map((m) => valueIn(m.series, a, b)));

    return { gas, electricity, heat, cost: this.cost(gas, electricity) };
  }

  /** `gas` (in this set's gas unit) in another set's unit. */
  gasIn(gas: number | null, unit: GasPriceUnit | null): number | null {
    return convertGas(gas, this.gasUnit(), unit, this.tariffs.gasKwhPerM3);
  }

  cost(gas: number | null, electricity: number | null): number | null {
    return costOf(gas, electricity, this.gasUnit(), this.tariffs);
  }

  /** heat ÷ gas energy: a gas source with a heat meter. */
  efficiency(v: ConsumptionValues): number | null {
    const unit = this.gasUnit();
    if (v.gas === null || unit === null) {
      return null;
    }

    return ratio(v.heat, gasKwh(v.gas, unit, this.tariffs.gasKwhPerM3), MIN_GAS_KWH);
  }

  /** heat ÷ electricity: an electric source (no gas meter) with a heat meter. */
  cop(v: ConsumptionValues): number | null {
    return this.has('gas') ? null : ratio(v.heat, v.electricity, MIN_ELECTRICITY_KWH);
  }

  /** What each run used, per kind (a source's own meters). */
  runShares(windows: RunWindow[]): Record<MeterKind, RunShare[]> {
    const none = (): RunShare[] => windows.map(() => ({ value: null, estimated: false }));
    const out: Record<MeterKind, RunShare[]> = { gas: none(), electricity: none(), heat: none() };
    for (const kind of METER_KINDS) {
      const m = this.byKind[kind][0];
      if (!m?.series) {
        continue;
      }

      const series = m.series;
      out[kind] =
        m.ref.unit?.quantity === 'power'
          ? windows.map((w) => ({ value: integrateKw(series.power, w.start, w.end), estimated: true }))
          : attributeRuns(series.totals, windows);
      if (kind === 'gas') {
        out.gas = out.gas.map((s) => ({ ...s, value: convertGas(s.value, meterGasUnit(m.ref), this.gasUnit(), this.tariffs.gasKwhPerM3) }));
      }
    }

    return out;
  }
}

/** The unit a gas meter is charted in: m³ for volume, kWh for energy. */
function meterGasUnit(ref: MeterRef): GasPriceUnit | null {
  if (!ref.unit) {
    return null;
  }

  return ref.unit.quantity === 'volume' ? 'm³' : 'kWh';
}

function sumValues(values: (number | null)[]): number | null {
  const known = values.filter((v): v is number => v !== null);

  return known.length ? known.reduce((s, v) => s + v, 0) : null;
}

/**
 * A meter's consumption in [a, b): the pieces starting there, the one reaching past `b` in proportion
 * (the previous period cut «so far» ends inside an hour or a day); null when none of them is known.
 */
function valueIn(series: MeterSeries | null, a: EpochMs, b: EpochMs): number | null {
  if (!series) {
    return null;
  }

  let sum = 0;
  let known = false;
  for (const p of series.pieces) {
    if (p.start >= a && p.start < b && p.value !== null) {
      sum += p.end > b ? (p.value * (b - p.start)) / (p.end - p.start) : p.value;
      known = true;
    }
  }

  return known ? sum : null;
}

function rounded(v: ConsumptionValues): ConsumptionValues {
  return { gas: roundTo(v.gas, 3), electricity: roundTo(v.electricity, 3), heat: roundTo(v.heat, 3), cost: roundTo(v.cost, 2) };
}
