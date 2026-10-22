import { HttpStatus, Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ApiException, notFound, validationError } from '../common/http';
import { errorText, LogOnce } from '../common/logger';
import { lazyRef } from '../common/refs';
import { addDays, fromLocal, isLocalDate } from '../engine/core/time';
import { round1 } from '../shared/model';
import type {
  ApiErrorIssue,
  ClockPort,
  EntityId,
  EpochMs,
  EvaluateResult,
  HaPort,
  HaStateObj,
  HistoryQuery,
  HistorySeriesDto,
  IBus,
  IConfigStore,
  Id,
  IHistory,
  IReadModels,
  ISpanStore,
  LocalDate,
  Mode,
  OutdoorHistoryDto,
  RoomConfig,
  RoomDayDto,
  SparkDto,
  StatisticsQuery,
  StatisticsSeriesDto,
  TargetDisplayKind,
  TargetLayer,
} from '../shared/model';
import { BUS, CLOCK, CONFIG_STORE, HA_PORT, READ_MODELS, SPAN_STORE } from '../tokens';
import { bucketize, combine, downsample, type Point, roundTo, valueAt } from './series';
import { domainOf, entityTempUnit, fToC, isAvailableState, parseNumber, systemTempUnit, type TempUnit } from './units';

type HistoryRows = Record<EntityId, { s: string; lu: number; a?: Record<string, unknown> }[]>;
type StatRows = Awaited<ReturnType<HaPort['statistics']>>;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const HISTORY_TTL = MIN;
const STATISTICS_TTL = 10 * MIN;
const MAX_IDS = 20;
const MAX_STAT_IDS = 200;
const MAX_RANGE = 31 * DAY;
const MAX_POINTS = 300;
const RING_SPAN = 6 * HOUR;
const SPARK_STEP = 30 * MIN;
const SPARK_POINTS = 13;
const STAT_BUCKET = 5 * MIN;
/** A rebuilt room series is sampled on this grid (fine enough for a day chart, ≤ 288 points). */
const REBUILD_STEP = 5 * MIN;
/** Klimo's own sensor counts for the trend seed when it reported this close to the end of the window. */
const SEED_FRESH = 5 * MIN;

const DISPLAY_KINDS = new Set<TargetDisplayKind>([
  'schedule', 'profile_updated', 'manual', 'range', 'boost', 'window', 'airing', 'off', 'monitor', 'frost', 'presence',
  'calendar', 'room_profile', 'preheat', 'no_data',
]);

const LAYER_KIND: Record<TargetLayer, TargetDisplayKind> = {
  frost: 'frost',
  window: 'window',
  airing: 'airing',
  manual: 'manual',
  room_off: 'off',
  room_profile: 'room_profile',
  house_manual: 'schedule',
  calendar: 'calendar',
  presence: 'presence',
  room_schedule: 'schedule',
  house_schedule: 'schedule',
  default: 'schedule',
  monitor: 'monitor',
};

interface RingSample {
  t: EpochMs;
  c: number | null;
  h: number | null;
  target: number | null;
}

type Segment = RoomDayDto['targetSegments'][number];

const minuteOf = (t: EpochMs) => Math.floor(t / MIN);

/** The recorder's view of the last hour of room temperatures, for the engine's trend after a restart. */
export interface RecentRoomTemps {
  recentRoomTemps(rooms: readonly RoomConfig[], from: EpochMs, to: EpochMs): Promise<Record<Id, [EpochMs, number][]>>;
}

/**
 * Charts come from the HA recorder (Klimo stores no samples): entity series, statistics, the room day
 * (Klimo's own MQTT sensors, else rebuilt from the raw sensors, else the last 6 h kept in memory),
 * sparklines for every room in one statistics call, and the outdoor history of the season card.
 */
@Injectable()
export class HistoryService implements IHistory, RecentRoomTemps, OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('History');
  private readonly once = new LogOnce(this.log);
  private readonly cache = new Map<string, { at: EpochMs; ttl: number; value: Promise<unknown> }>();
  private readonly ring = new Map<Id, RingSample[]>();
  private readonly learned = new Map<Id, { heat: number | null; cool: number | null; mode: Mode | 'dual' | 'none' }>();
  private readonly readModels: () => IReadModels | null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    @Inject(HA_PORT) private readonly ha: HaPort,
    @Inject(CONFIG_STORE) private readonly config: IConfigStore,
    @Inject(SPAN_STORE) private readonly spans: ISpanStore,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(BUS) private readonly bus: IBus,
    @Optional() moduleRef?: ModuleRef,
  ) {
    this.readModels = lazyRef<IReadModels>(moduleRef, READ_MODELS);
  }

  onModuleInit(): void {
    this.unsubscribe = this.bus.on('engine.tick', ({ at, result }) => this.remember(at, result));
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }

  /* ── in-memory ring (last 6 h; the fallback when the recorder is unreachable) ───────────────── */

  /** One sample per room and minute from the engine's own result. */
  remember(at: EpochMs, result: EvaluateResult): void {
    for (const r of result.rooms) {
      const list = this.ring.get(r.roomId) ?? [];
      const sample: RingSample = { t: at, c: r.tempC, h: r.humidity.valuePct, target: r.target.displayC ?? r.target.heatC ?? r.target.coolC };
      const last = list[list.length - 1];
      if (last && minuteOf(last.t) === minuteOf(at)) list[list.length - 1] = sample;
      else list.push(sample);
      while (list.length && at - list[0].t > RING_SPAN) list.shift();
      this.ring.set(r.roomId, list);
      const mem = result.memory.rooms[r.roomId];
      this.learned.set(r.roomId, { heat: mem?.learned.heatRateCPerH ?? null, cool: mem?.learned.coolRateCPerH ?? null, mode: r.target.mode });
    }
    const alive = new Set(result.rooms.map((r) => r.roomId));
    for (const id of this.ring.keys()) if (!alive.has(id)) this.ring.delete(id);
  }

  private ringPoints(roomId: Id, pick: (s: RingSample) => number | null): Point[] {
    return (this.ring.get(roomId) ?? []).map((s) => [s.t, pick(s)] as Point);
  }

  /* ── plumbing ──────────────────────────────────────────────────────────────────────────────── */

  private cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
    const now = this.clock.now();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < hit.ttl) return hit.value as Promise<T>;
    const value = load();
    this.cache.set(key, { at: now, ttl, value });
    value.catch(() => {
      if (this.cache.get(key)?.value === value) this.cache.delete(key);
    });
    if (this.cache.size > 256) for (const [k, v] of this.cache) if (now - v.at >= v.ttl) this.cache.delete(k);
    return value;
  }

  private haUnit(): TempUnit {
    return systemTempUnit(this.ha.config()?.unit_system.temperature);
  }

  private requireHa(): void {
    if (!this.ha.connected) throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, 'ha_unavailable');
  }

  private recorderError(e: unknown): ApiException {
    if (e instanceof ApiException) return e;
    this.log.warn(`recorder query failed: ${errorText(e)}`);
    return new ApiException(HttpStatus.SERVICE_UNAVAILABLE, 'ha_unavailable', `Recorder query failed: ${errorText(e)}`);
  }

  private checkRange(ids: unknown, from: unknown, to: unknown, maxIds: number, maxRange: number | null): void {
    const issues: ApiErrorIssue[] = [];
    if (!Array.isArray(ids) || !ids.length) issues.push({ path: 'ids', code: 'required' });
    else if (ids.length > maxIds) issues.push({ path: 'ids', code: 'max_items', params: { max: maxIds } });
    else if (ids.some((x) => typeof x !== 'string' || !x.includes('.'))) issues.push({ path: 'ids', code: 'entity_id' });
    if (typeof from !== 'number' || !Number.isFinite(from)) issues.push({ path: 'from', code: 'required' });
    if (typeof to !== 'number' || !Number.isFinite(to)) issues.push({ path: 'to', code: 'required' });
    else if (typeof from === 'number' && to <= from) issues.push({ path: 'to', code: 'range' });
    else if (maxRange !== null && typeof from === 'number' && to - from > maxRange) issues.push({ path: 'to', code: 'max_range', params: { days: maxRange / DAY } });
    if (issues.length) throw validationError(issues);
  }

  /* ── entity series ─────────────────────────────────────────────────────────────────────────── */

  async series(q: HistoryQuery): Promise<HistorySeriesDto[]> {
    this.checkRange(q.ids, q.from, q.to, MAX_IDS, MAX_RANGE);
    this.requireHa();
    const attr = q.attribute ?? null;
    const key = `series|${q.ids.join(',')}|${minuteOf(q.from)}|${minuteOf(q.to)}|${attr ?? ''}`;
    return this.cached(key, HISTORY_TTL, async () => {
      let raw: HistoryRows;
      try {
        raw = await this.ha.history(q.ids, q.from, q.to, { minimal: !attr, noAttributes: !attr });
      } catch (e) {
        throw this.recorderError(e);
      }
      return q.ids.map((id) => this.toSeries(id, raw[id] ?? [], q.from, q.to, attr));
    });
  }

  private toSeries(entityId: EntityId, rows: HistoryRows[string], from: EpochMs, to: EpochMs, attr: string | null): HistorySeriesDto {
    const state = this.ha.getState(entityId);
    const unit = this.seriesUnit(entityId, state, attr);
    const points: Point[] = [];
    const states: [EpochMs, string][] = [];
    let numeric = 0;
    let attrs: Record<string, unknown> | undefined;
    for (const row of rows) {
      const ts = Math.round(row.lu * 1000);
      // attributes may be sent only when they change: carry the last ones forward
      if (row.a) attrs = row.a;
      const raw = attr ? attrs?.[attr] : row.s;
      const n = parseNumber(raw);
      if (n !== null) {
        numeric++;
        points.push([ts, unit === '°F' ? fToC(n) : n]);
        continue;
      }
      points.push([ts, null]);
      const text = raw === undefined || raw === null ? null : String(raw);
      if (text !== null && isAvailableState(text)) states.push([ts, text]);
    }
    const isNumeric = numeric > 0 && numeric >= states.length;
    const dto: HistorySeriesDto = {
      entityId,
      unit: unit === '°F' || unit === '°C' ? '°C' : unit,
      points: isNumeric ? downsample(points, from, to, MAX_POINTS) : [],
    };
    if (!isNumeric) dto.states = states;
    return dto;
  }

  /** Unit of the series values: temperatures are converted to °C, other numbers keep theirs. */
  private seriesUnit(entityId: EntityId, state: HaStateObj | undefined, attr: string | null): string | null {
    const haUnit = this.haUnit();
    if (attr) {
      const domain = domainOf(entityId);
      const tempAttr = /temp|temperature/.test(attr) && (domain === 'climate' || domain === 'water_heater' || domain === 'weather');
      if (!tempAttr) return null;
      const t = state ? entityTempUnit(state, haUnit) : haUnit;
      return t === '°C' || t === '°F' ? t : null;
    }
    if (!state) return null;
    const t = entityTempUnit(state, haUnit);
    if (t === '°C' || t === '°F') return t;
    const u = state.attributes.unit_of_measurement;
    return typeof u === 'string' ? u : null;
  }

  async statistics(q: StatisticsQuery): Promise<StatisticsSeriesDto[]> {
    this.checkRange(q.ids, q.from, q.to, MAX_STAT_IDS, null);
    this.requireHa();
    const key = `stats|${q.ids.join(',')}|${q.period}|${q.types.join(',')}|${minuteOf(q.from)}|${minuteOf(q.to)}`;
    return this.cached(key, STATISTICS_TTL, async () => {
      let raw: StatRows;
      try {
        raw = await this.ha.statistics(q.ids, q.from, q.to, q.period, q.types);
      } catch (e) {
        throw this.recorderError(e);
      }
      return q.ids.map((id) => ({ statisticId: id, points: toStatPoints(raw[id] ?? []) }));
    });
  }

  /* ── Klimo's own sensors ───────────────────────────────────────────────────────────────────── */

  /** Klimo's MQTT sensor of a room: by unique id in the registry (the entity id may have been renamed), else the documented id. */
  private klimoIds(rooms: RoomConfig[]): Map<Id, Record<'temperature' | 'target' | 'humidity' | 'heat_demand' | 'cool_demand', EntityId>> {
    const byUnique = new Map<string, EntityId>();
    for (const e of this.ha.registries().entities) if (e.platform === 'mqtt' && e.unique_id?.startsWith('klimo_')) byUnique.set(e.unique_id, e.entity_id);
    const out = new Map<Id, Record<'temperature' | 'target' | 'humidity' | 'heat_demand' | 'cool_demand', EntityId>>();
    for (const r of rooms) {
      const id = (kind: string, domain: string) => byUnique.get(`klimo_${r.id}_${kind}`) ?? `${domain}.klimo_${r.slug}_${kind}`;
      out.set(r.id, {
        temperature: id('temperature', 'sensor'),
        target: id('target', 'sensor'),
        humidity: id('humidity', 'sensor'),
        heat_demand: id('heat_demand', 'binary_sensor'),
        cool_demand: id('cool_demand', 'binary_sensor'),
      });
    }
    return out;
  }

  private numericPoints(rows: HistoryRows[string] | undefined, unit: TempUnit | null): Point[] {
    return (rows ?? []).map((row) => {
      const n = parseNumber(row.s);
      return [Math.round(row.lu * 1000), n === null ? null : unit === '°F' ? fToC(n) : n] as Point;
    });
  }

  private tempUnitOf(entityId: EntityId): TempUnit | null {
    const s = this.ha.getState(entityId);
    if (!s) return null;
    const u = entityTempUnit(s, this.haUnit());
    return u === '°F' || u === '°C' ? u : null;
  }

  /**
   * A room series rebuilt from its raw sensors with the room's own method, on a 5-min grid. The
   * recorder stores changes only, so a quiet sensor keeps its value until it changes or goes unavailable.
   */
  private rebuild(
    raw: HistoryRows,
    sensors: { entityId: EntityId; weight: number }[],
    method: Parameters<typeof combine>[1],
    from: EpochMs,
    end: EpochMs,
    round: (x: number) => number,
    temperature: boolean,
    step = REBUILD_STEP,
  ): Point[] {
    const series = sensors.map((s) => ({ w: s.weight, points: this.numericPoints(raw[s.entityId], temperature ? this.tempUnitOf(s.entityId) : null) }));
    if (!series.some((s) => s.points.some(([, v]) => v !== null))) return [];
    const out: Point[] = [];
    for (let t = from; t <= end; t += step) {
      const values = series.flatMap((s) => {
        const v = valueAt(s.points, t);
        return v === null ? [] : [{ v, w: s.w }];
      });
      const c = combine(values, method);
      out.push([t, c === null ? null : round(c)]);
    }
    return out;
  }

  /* ── the engine's trend after a restart ────────────────────────────────────────────────────── */

  /**
   * Room temperatures over [from, to] on a 1-min grid, so the trend shows right after a restart rather
   * than after 15 min of new samples. Klimo's own sensor (the aggregate as it was published) when it ran
   * until shortly before, else the room rebuilt from its raw sensors. Rooms without data are left out.
   */
  async recentRoomTemps(rooms: readonly RoomConfig[], from: EpochMs, to: EpochMs): Promise<Record<Id, [EpochMs, number][]>> {
    const out: Record<Id, [EpochMs, number][]> = {};
    if (!rooms.length || to <= from || !this.ha.connected) return out;
    const start = Math.ceil(from / MIN) * MIN;
    const grid = (points: Point[]): [EpochMs, number][] => {
      const res: [EpochMs, number][] = [];
      for (let t = start; t <= to; t += MIN) {
        const v = valueAt(points, t);
        if (v !== null) res.push([t, v]);
      }
      return res;
    };
    const ids = this.klimoIds([...rooms]);
    const ownIds = rooms.map((r) => ids.get(r.id)!.temperature);
    const own = await this.ha.history(ownIds, from, to, { minimal: true, noAttributes: true });
    const cfg = this.config.engineConfig();
    const tempSensors = (r: RoomConfig) => (cfg.sensorsByRoom[r.id] ?? []).filter((s) => s.included && s.role === 'temperature');
    const ownOf = new Map<Id, [EpochMs, number][]>();
    const stale: RoomConfig[] = [];
    for (const r of rooms) {
      const id = ids.get(r.id)!.temperature;
      const points = grid(this.numericPoints(own[id], this.tempUnitOf(id)));
      ownOf.set(r.id, points);
      // Klimo was down for a while: its sensor has a gap at the end the raw sensors do not
      if (points.length && points[points.length - 1][0] >= to - SEED_FRESH) out[r.id] = points;
      else if (tempSensors(r).length) stale.push(r);
      else if (points.length) out[r.id] = points;
    }
    if (stale.length) {
      const rawIds = [...new Set(stale.flatMap((r) => tempSensors(r).map((s) => s.entityId)))];
      const raw = await this.ha.history(rawIds, from, to, { minimal: true, noAttributes: true });
      for (const r of stale) {
        const rebuilt = this.rebuild(raw, tempSensors(r), r.temperature.method, start, to, (x) => x, true, MIN).filter((p): p is [EpochMs, number] => p[1] !== null);
        const points = rebuilt.length ? rebuilt : ownOf.get(r.id) ?? [];
        if (points.length) out[r.id] = points;
      }
    }
    return out;
  }

  /* ── room day ──────────────────────────────────────────────────────────────────────────────── */

  async roomDay(roomId: Id, date: LocalDate): Promise<RoomDayDto> {
    if (!isLocalDate(date)) throw validationError([{ path: 'date', code: 'date' }]);
    const room = this.config.room(roomId);
    if (!room) throw notFound('Room');
    const now = this.clock.now();
    return this.cached(`day|${room.id}|${date}|${minuteOf(now)}`, HISTORY_TTL, () => this.buildRoomDay(room, date, now));
  }

  private async buildRoomDay(room: RoomConfig, date: LocalDate, now: EpochMs): Promise<RoomDayDto> {
    const tz = this.clock.tz();
    const from = fromLocal(date, 0, tz);
    const to = fromLocal(addDays(date, 1), 0, tz);
    const end = Math.min(to, now);
    const ids = this.klimoIds([room]).get(room.id)!;
    const cfg = this.config.engineConfig();
    const sensors = (cfg.sensorsByRoom[room.id] ?? []).filter((s) => s.included);
    const tempSensors = sensors.filter((s) => s.role === 'temperature');
    const humSensors = sensors.filter((s) => s.role === 'humidity');

    let series: Point[] = [];
    let humidity: Point[] = [];
    let source: RoomDayDto['source'] = 'klimo_entity';
    let targetRows: HistoryRows[string] = [];
    let demandRows: HistoryRows = {};
    let recorderOk = end > from && this.ha.connected;

    if (recorderOk) {
      try {
        const own = await this.ha.history([ids.temperature, ids.humidity, ids.heat_demand, ids.cool_demand], from, end, { minimal: true, noAttributes: true });
        series = this.numericPoints(own[ids.temperature], null);
        humidity = this.numericPoints(own[ids.humidity], null);
        demandRows = own;
        targetRows = (await this.ha.history([ids.target], from, end, { minimal: false, noAttributes: false }))[ids.target] ?? [];

        const hasData = (p: Point[]) => p.some(([, v]) => v !== null);
        if (!hasData(series) || (!hasData(humidity) && humSensors.length)) {
          const rawIds = [...new Set([...(hasData(series) ? [] : tempSensors), ...(hasData(humidity) ? [] : humSensors)].map((s) => s.entityId))];
          const raw = rawIds.length ? await this.ha.history(rawIds, from, end, { minimal: true, noAttributes: true }) : {};
          if (!hasData(series)) {
            source = 'raw_sensors';
            series = this.rebuild(raw, tempSensors, room.temperature.method, from, end, round1, true);
          }
          if (!hasData(humidity)) humidity = this.rebuild(raw, humSensors, room.humidity.method, from, end, Math.round, false);
        }
        // a recorder that keeps none of these entities (excluded) has nothing — the memory still may
        if (!hasData(series) && this.ringPoints(room.id, (s) => s.c).some(([t, v]) => v !== null && t >= from)) recorderOk = false;
      } catch (e) {
        this.once.warn(`day:${room.id}`, `recorder unavailable for the room day, using the last hours in memory: ${errorText(e)}`);
        recorderOk = false;
      }
    }
    if (!recorderOk && end > from) {
      source = 'memory';
      const inDay = ([t]: Point) => t >= from && t <= end;
      series = this.ringPoints(room.id, (s) => s.c).filter(inDay);
      humidity = this.ringPoints(room.id, (s) => s.h).filter(inDay);
    } else if (recorderOk) this.once.reset(`day:${room.id}`);

    const targetSegments = await this.targetSegments(room, date, from, to, now, targetRows);
    const demandSpans = await this.demandSpans(room, from, to, end, demandRows, ids);
    return {
      roomId: room.id,
      date,
      series: downsample(series, from, end, MAX_POINTS).map(([t, v]) => [t, v === null ? null : round1(v)] as [EpochMs, number | null]),
      source,
      humidity: downsample(humidity, from, end, MAX_POINTS).map(([t, v]) => [t, v === null ? null : Math.round(v)] as [EpochMs, number | null]),
      targetSegments,
      demandSpans,
      stats: this.dayStats(room.id, series, demandSpans, from, end),
    };
  }

  private async targetSegments(room: RoomConfig, date: LocalDate, from: EpochMs, to: EpochMs, now: EpochMs, rows: HistoryRows[string]): Promise<Segment[]> {
    const out: Segment[] = [];
    const mode = this.learned.get(room.id)?.mode ?? 'heat';
    let attrs: Record<string, unknown> = {};
    const past: { at: EpochMs; seg: Omit<Segment, 'from' | 'to'> | null }[] = [];
    for (const row of rows) {
      if (row.a) attrs = row.a;
      const at = Math.max(from, Math.round(row.lu * 1000));
      const v = parseNumber(row.s);
      const lo = parseNumber(attrs.lo);
      const hi = parseNumber(attrs.hi);
      const kindAttr = typeof attrs.source === 'string' && DISPLAY_KINDS.has(attrs.source as TargetDisplayKind) ? (attrs.source as TargetDisplayKind) : null;
      if (v === null && lo === null && hi === null) {
        past.push({ at, seg: isAvailableState(row.s) ? { heatC: null, coolC: null, future: false, kind: kindAttr ?? 'off' } : null });
        continue;
      }
      const cool = attrs.mode === 'cool' || (attrs.mode === undefined && mode === 'cool');
      past.push({
        at,
        seg: {
          heatC: lo !== null || hi !== null ? lo : cool ? null : v,
          coolC: lo !== null || hi !== null ? hi : cool ? v : null,
          future: false,
          kind: kindAttr ?? (lo !== null && hi !== null ? 'range' : 'schedule'),
        },
      });
    }
    const pastEnd = Math.min(now, to);
    for (let i = 0; i < past.length; i++) {
      const seg = past[i].seg;
      const segTo = Math.min(i + 1 < past.length ? past[i + 1].at : pastEnd, pastEnd);
      if (seg && segTo > past[i].at) out.push({ from: past[i].at, to: segTo, ...seg });
    }

    // the plan from the schedule: the future, and the past too when Klimo's target sensor is not recorded
    const plannedFrom = out.length ? Math.max(from, now) : from;
    if (plannedFrom < to) {
      for (const s of this.planned(room, date, from, to)) {
        const a = Math.max(s.from, plannedFrom);
        if (s.to <= a) continue;
        if (a < now && s.to > now) {
          out.push({ ...s, from: a, to: now, future: false });
          out.push({ ...s, from: now, future: true });
        } else out.push({ ...s, from: a, future: a >= now });
      }
    }
    return mergeSegments(out);
  }

  private planned(room: RoomConfig, date: LocalDate, from: EpochMs, to: EpochMs): Segment[] {
    const rm = this.readModels();
    if (!rm) return [];
    const schedules = this.config.engineConfig().schedules;
    const own = schedules.find((s) => s.scope === 'room' && s.roomId === room.id && s.enabled);
    const scheduleId = own?.id ?? schedules.find((s) => s.scope === 'house')?.id ?? 'house';
    try {
      const day = rm.resolvedDay(scheduleId, date, room.id);
      const tz = this.clock.tz();
      return day.segments.map((s) => {
        const kind = LAYER_KIND[s.layer] ?? 'schedule';
        return {
          from: s.start <= 0 ? from : fromLocal(date, s.start, tz),
          to: s.end >= 1440 ? to : fromLocal(date, s.end, tz),
          heatC: s.heatC,
          coolC: s.coolC,
          future: true,
          kind: kind === 'schedule' && s.heatC === null && s.coolC === null ? 'off' : kind,
        };
      });
    } catch (e) {
      this.once.warn(`plan:${room.id}`, `cannot resolve the schedule of ${room.name}: ${errorText(e)}`);
      return [];
    }
  }

  private async demandSpans(
    room: RoomConfig,
    from: EpochMs,
    to: EpochMs,
    end: EpochMs,
    rows: HistoryRows,
    ids: Record<'heat_demand' | 'cool_demand', EntityId>,
  ): Promise<RoomDayDto['demandSpans']> {
    let spans: RoomDayDto['demandSpans'] = [];
    try {
      spans = (await this.spans.range(from, to, 'room', room.id))
        .filter((s) => s.kind === 'demand' && (s.mode === 'heat' || s.mode === 'cool'))
        .map((s) => ({ from: Math.max(from, s.startTs), to: s.endTs === null ? null : Math.min(to, s.endTs), mode: s.mode as Mode }));
    } catch (e) {
      this.log.warn(`run spans unavailable: ${errorText(e)}`);
    }
    if (spans.length) return spans.sort((a, b) => a.from - b.from);
    // no spans yet (new database): the recorded demand sensors tell the same story
    for (const mode of ['heat', 'cool'] as const) {
      const list = rows[mode === 'heat' ? ids.heat_demand : ids.cool_demand] ?? [];
      let open: EpochMs | null = null;
      for (const row of list) {
        const at = Math.max(from, Math.round(row.lu * 1000));
        if (row.s === 'on' && open === null) open = at;
        else if (row.s !== 'on' && open !== null) {
          spans.push({ from: open, to: at, mode });
          open = null;
        }
      }
      if (open !== null) spans.push({ from: open, to: end >= to ? to : null, mode });
    }
    return spans.sort((a, b) => a.from - b.from);
  }

  private dayStats(roomId: Id, series: Point[], spans: RoomDayDto['demandSpans'], from: EpochMs, end: EpochMs): RoomDayDto['stats'] {
    let heated = 0;
    let cooled = 0;
    for (const s of spans) {
      const ms = Math.max(0, Math.min(s.to ?? end, end) - Math.max(s.from, from));
      if (s.mode === 'heat') heated += ms;
      else cooled += ms;
    }
    let min: { c: number; at: EpochMs } | null = null;
    let max: { c: number; at: EpochMs } | null = null;
    for (const [at, v] of series) {
      if (v === null) continue;
      const c = round1(v);
      if (!min || c < min.c) min = { c, at };
      if (!max || c > max.c) max = { c, at };
    }
    const l = this.learned.get(roomId);
    const rate = l ? (l.mode === 'cool' ? l.cool : l.heat ?? l.cool) : null;
    return {
      heatedMin: Math.round(heated / MIN),
      cooledMin: Math.round(cooled / MIN),
      min,
      max,
      rateCPerH: rate === null ? null : round1(rate),
    };
  }

  /* ── sparks ────────────────────────────────────────────────────────────────────────────────── */

  async sparks(roomIds?: Id[]): Promise<Record<Id, SparkDto>> {
    const all = this.config.engineConfig().rooms;
    const rooms = roomIds ? all.filter((r) => roomIds.includes(r.id)) : all;
    const now = this.clock.now();
    const last = Math.floor(now / STAT_BUCKET) * STAT_BUCKET;
    const key = `sparks|${rooms.map((r) => r.id).sort().join(',')}|${minuteOf(last)}`;
    return this.cached(key, HISTORY_TTL, () => this.buildSparks(rooms, last, now));
  }

  private async buildSparks(rooms: RoomConfig[], last: EpochMs, now: EpochMs): Promise<Record<Id, SparkDto>> {
    const from = last - (SPARK_POINTS - 1) * SPARK_STEP;
    const times = Array.from({ length: SPARK_POINTS }, (_, i) => from + i * SPARK_STEP);
    const ids = this.klimoIds(rooms);
    const sensorsByRoom = this.config.engineConfig().sensorsByRoom;
    const rawByRoom = new Map(rooms.map((r) => [r.id, (sensorsByRoom[r.id] ?? []).filter((s) => s.role === 'temperature' && s.included)]));
    const statIds = [...new Set(rooms.flatMap((r) => [ids.get(r.id)!.temperature, ids.get(r.id)!.target, ...(rawByRoom.get(r.id) ?? []).map((s) => s.entityId)]))];

    let stats: StatRows = {};
    if (statIds.length && this.ha.connected) {
      try {
        stats = await this.ha.statistics(statIds, from - 3 * STAT_BUCKET, now, '5minute', ['mean']);
      } catch (e) {
        this.once.warn('sparks', `statistics unavailable for sparklines, using memory: ${errorText(e)}`);
      }
    }
    const pick = (rows: StatRows[string] | undefined, t: EpochMs): number | null => {
      let best: number | null = null;
      for (const r of rows ?? []) if (r.start < t && r.start >= t - 3 * STAT_BUCKET && r.mean !== null && r.mean !== undefined) best = r.mean;
      return best;
    };
    const nonEmpty = (xs: (number | null)[]) => xs.some((x) => x !== null);
    const out: Record<Id, SparkDto> = {};
    for (const room of rooms) {
      const own = ids.get(room.id)!;
      let values = times.map((t) => pick(stats[own.temperature], t));
      if (!nonEmpty(values)) {
        const raw = rawByRoom.get(room.id) ?? [];
        values = times.map((t) => combine(raw.flatMap((s) => {
          const v = pick(stats[s.entityId], t);
          return v === null ? [] : [{ v, w: s.weight }];
        }), room.temperature.method));
      }
      if (!nonEmpty(values)) {
        const ring = this.ringPoints(room.id, (s) => s.c);
        values = times.map((t) => valueAt(ring, t, 15 * MIN));
      }
      let targets: (number | null)[] | null = times.map((t) => pick(stats[own.target], t));
      if (!nonEmpty(targets)) {
        const ring = this.ringPoints(room.id, (s) => s.target);
        targets = times.map((t) => valueAt(ring, t, 15 * MIN));
      }
      out[room.id] = {
        values: values.map((v) => (v === null ? null : round1(v))),
        targets: nonEmpty(targets) ? targets.map((v) => (v === null ? null : round1(v))) : null,
        from,
        stepMin: 30,
      };
    }
    return out;
  }

  /* ── outdoor ───────────────────────────────────────────────────────────────────────────────── */

  async outdoor(days: number): Promise<OutdoorHistoryDto> {
    const d = Math.min(31, Math.max(1, Math.round(Number.isFinite(days) ? days : 3)));
    this.requireHa();
    const { sensorEntityId, weatherEntityId } = this.config.engineConfig().settings.outdoor;
    const now = this.clock.now();
    const end = Math.floor(now / HOUR) * HOUR + HOUR;
    const from = end - d * DAY;
    const key = `outdoor|${d}|${sensorEntityId ?? ''}|${weatherEntityId ?? ''}|${minuteOf(end)}`;
    return this.cached(key, STATISTICS_TTL, async () => {
      let series: OutdoorHistoryDto['series'] = [];
      const known = () => series.some((p) => p.mean !== null);
      try {
        if (sensorEntityId) {
          const stats = await this.ha.statistics([sensorEntityId], from, end, 'hour', ['mean', 'min', 'max']);
          series = toStatPoints(stats[sensorEntityId] ?? []);
          if (!known()) {
            const raw = await this.ha.history([sensorEntityId], from, now, { minimal: true, noAttributes: true });
            series = toBuckets(bucketize(this.numericPoints(raw[sensorEntityId], this.tempUnitOf(sensorEntityId)), from, end, HOUR));
          }
        }
        if (!known() && weatherEntityId) {
          const raw = await this.ha.history([weatherEntityId], from, now, { minimal: false, noAttributes: false });
          const unit = this.tempUnitOf(weatherEntityId);
          let last: Record<string, unknown> = {};
          const pts = (raw[weatherEntityId] ?? []).map((row) => {
            if (row.a) last = row.a;
            const n = parseNumber(last.temperature);
            return [Math.round(row.lu * 1000), n === null ? null : unit === '°F' ? fToC(n) : n] as Point;
          });
          series = toBuckets(bucketize(pts, from, end, HOUR));
        }
      } catch (e) {
        throw this.recorderError(e);
      }
      const means = series.flatMap((p) => (p.mean === null ? [] : [p.mean]));
      const avg = means.length ? means.reduce((a, b) => a + b, 0) / means.length : null;
      return { series, avgC: avg === null ? null : round1(avg), days: d };
    });
  }
}

function toStatPoints(rows: StatRows[string]): StatisticsSeriesDto['points'] {
  return rows.map((r) => ({ start: r.start, mean: r.mean ?? null, min: r.min ?? null, max: r.max ?? null, state: r.state ?? null, sum: r.sum ?? null }));
}

function toBuckets(buckets: ReturnType<typeof bucketize>): StatisticsSeriesDto['points'] {
  return buckets.map((b) => ({
    start: b.start,
    mean: roundTo(b.mean, 2),
    min: b.min,
    max: b.max,
    state: null,
    sum: null,
  }));
}

/** Adjacent segments with the same values and kind become one. */
function mergeSegments(segments: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const s of segments.sort((a, b) => a.from - b.from)) {
    const prev = out[out.length - 1];
    if (prev && prev.to === s.from && prev.heatC === s.heatC && prev.coolC === s.coolC && prev.kind === s.kind && prev.future === s.future) prev.to = s.to;
    else out.push({ ...s });
  }
  return out;
}
