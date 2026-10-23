import { HttpStatus, Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ApiException, notFound, validationError } from '../common/http';
import { errorText, LogOnce } from '../common/logger';
import { lazyRef } from '../common/refs';
import { addDays, fromLocal, isLocalDate } from '../engine/core/time';
import { outdoorSensorIds, round1 } from '../shared/model';
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
  OutdoorAggregation,
  OutdoorHistoryDto,
  RoomConfig,
  RoomDayDiag,
  RoomDayEntityRole,
  RoomDayDto,
  RoomDaySource,
  RoomSensor,
  SparkDto,
  StatisticsQuery,
  StatisticsSeriesDto,
  TargetDisplayKind,
  TargetLayer,
} from '../shared/model';
import { BUS, CLOCK, CONFIG_STORE, HA_PORT, READ_MODELS, SPAN_STORE } from '../tokens';
import { combineBuckets } from './outdoor';
import { combineSteps, dropOutliers, extremes, onGrid, type SensorSteps } from './room-series';
import { bucketize, combine, downsample, type Point, roundTo, valueAt } from './series';
import { domainOf, entityTempUnit, fToC, isAvailableState, parseNumber, systemTempUnit, tempUnit, type TempUnit } from './units';

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
/** The day chart samples the room's step series on this grid (≤ 288 points); min and max come from the changes themselves. */
const CHART_STEP = 5 * MIN;
const MINIMAL = { minimal: true, noAttributes: true } as const;
const FULL = { minimal: false, noAttributes: false } as const;
/** Targets that hold until a known end (or until changed by hand): drawn ahead of the schedule until then. */
const HELD_LAYERS = new Set<TargetLayer>(['manual', 'room_off', 'room_profile', 'house_manual', 'calendar', 'presence']);
/** The engine's last view of a room counts as current for this long (it evaluates at least every minute). */
const CURRENT_FRESH = 5 * MIN;

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

interface CurrentTarget {
  at: EpochMs;
  heatC: number | null;
  coolC: number | null;
  layer: TargetLayer;
  kind: TargetDisplayKind;
  until: EpochMs | null;
}

const minuteOf = (t: EpochMs) => Math.floor(t / MIN);
const hasData = (points: readonly Point[]) => points.some(([, v]) => v !== null);
/** Entity-id-safe form of a slug, as the MQTT discovery writes it. */
const objectId = (id: string) => id.toLowerCase().replace(/[^a-z0-9_]/g, '_');

/** The recorder's view of the last hour of room temperatures, for the engine's trend after a restart. */
export interface RecentRoomTemps {
  recentRoomTemps(rooms: readonly RoomConfig[], from: EpochMs, to: EpochMs): Promise<Record<Id, [EpochMs, number][]>>;
}

/**
 * Charts come from the HA recorder (Klimo stores no samples): entity series, statistics, the room day
 * (the room's own sensors combined the way the live value is, else Klimo's published MQTT sensor, else
 * the last 6 h kept in memory), sparklines for every room in one statistics call, and the outdoor history
 * of the season card. An answer given before the recorder could be read is never cached.
 */
@Injectable()
export class HistoryService implements IHistory, RecentRoomTemps, OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('History');
  private readonly once = new LogOnce(this.log);
  private readonly cache = new Map<string, { at: EpochMs; ttl: number; value: Promise<unknown> }>();
  private readonly ring = new Map<Id, RingSample[]>();
  private readonly learned = new Map<Id, { heat: number | null; cool: number | null; mode: Mode | 'dual' | 'none' }>();
  private readonly current = new Map<Id, CurrentTarget>();
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
      this.current.set(r.roomId, { at, heatC: r.target.heatC, coolC: r.target.coolC, layer: r.target.layer, kind: r.target.display, until: r.target.until ?? null });
    }
    const alive = new Set(result.rooms.map((r) => r.roomId));
    for (const id of this.ring.keys()) if (!alive.has(id)) this.ring.delete(id);
    for (const id of this.current.keys()) if (!alive.has(id)) this.current.delete(id);
  }

  private ringPoints(roomId: Id, pick: (s: RingSample) => number | null): Point[] {
    return (this.ring.get(roomId) ?? []).map((s) => [s.t, pick(s)] as Point);
  }

  /* ── plumbing ──────────────────────────────────────────────────────────────────────────────── */

  /** `keep` false for an answer that must not be reused (the recorder could not be read yet). */
  private cached<T>(key: string, ttl: number, load: () => Promise<T>, keep: (value: T) => boolean = () => true): Promise<T> {
    const now = this.clock.now();
    const hit = this.cache.get(key);
    // an answer from a later time is stale too: the simulator's clock travels back to another scenario
    if (hit && hit.at <= now && now - hit.at < hit.ttl) return hit.value as Promise<T>;
    const value = load();
    this.cache.set(key, { at: now, ttl, value });
    const forget = () => {
      if (this.cache.get(key)?.value === value) this.cache.delete(key);
    };
    value.then((v) => {
      if (!keep(v)) forget();
    }, forget);
    if (this.cache.size > 256) for (const [k, v] of this.cache) if (v.at > now || now - v.at >= v.ttl) this.cache.delete(k);
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

  /* ── the room's sensors and Klimo's own ────────────────────────────────────────────────────── */

  /** Klimo's MQTT sensor of a room: by unique id in the registry (the entity id may have been renamed or suffixed), else the documented id. */
  private klimoIds(rooms: RoomConfig[]): Map<Id, Record<'temperature' | 'target' | 'humidity' | 'heat_demand' | 'cool_demand', EntityId>> {
    const byUnique = new Map<string, EntityId>();
    for (const e of this.ha.registries().entities) if (e.platform === 'mqtt' && e.unique_id?.startsWith('klimo_')) byUnique.set(e.unique_id, e.entity_id);
    const out = new Map<Id, Record<'temperature' | 'target' | 'humidity' | 'heat_demand' | 'cool_demand', EntityId>>();
    for (const r of rooms) {
      const id = (kind: string, domain: string) => byUnique.get(`klimo_${r.id}_${kind}`) ?? `${domain}.klimo_${objectId(r.slug)}_${kind}`;
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

  /** The room's included sensors of one role, in its order (the first live one is «primary»). */
  private roomSensors(roomId: Id, role: 'temperature' | 'humidity'): RoomSensor[] {
    return (this.config.engineConfig().sensorsByRoom[roomId] ?? []).filter((s) => s.included && s.role === role).sort((a, b) => a.order - b.order);
  }

  /** Recorder rows of room sensors: plain sensors as a minimal response, thermostats with their attributes. */
  private async readSensors(sensors: readonly RoomSensor[], from: EpochMs, end: EpochMs): Promise<HistoryRows> {
    const ids = [...new Set(sensors.map((s) => s.entityId))];
    const plain = ids.filter((id) => domainOf(id) !== 'climate');
    const climate = ids.filter((id) => domainOf(id) === 'climate');
    const [a, b] = await Promise.all([
      plain.length ? this.ha.history(plain, from, end, MINIMAL) : Promise.resolve({} as HistoryRows),
      climate.length ? this.ha.history(climate, from, end, FULL) : Promise.resolve({} as HistoryRows),
    ]);
    return { ...a, ...b };
  }

  /** One sensor's rows as numbers (°C for temperatures); a thermostat stands in with its current reading, never its setpoint. */
  private sensorPoints(entityId: EntityId, rows: HistoryRows[string] | undefined, role: 'temperature' | 'humidity'): Point[] {
    const climate = domainOf(entityId) === 'climate';
    const unit = role === 'temperature' ? this.tempUnitOf(entityId) : null;
    let attrs: Record<string, unknown> = {};
    return (rows ?? []).map((row) => {
      if (row.a) attrs = row.a;
      const raw = climate ? (isAvailableState(row.s) ? attrs[role === 'temperature' ? 'current_temperature' : 'current_humidity'] : null) : row.s;
      const n = parseNumber(raw);
      return [Math.round(row.lu * 1000), n === null ? null : unit === '°F' ? fToC(n) : n] as Point;
    });
  }

  private sensorSteps(raw: HistoryRows, sensors: readonly RoomSensor[], role: 'temperature' | 'humidity', note?: (entityId: EntityId, points: Point[]) => void): SensorSteps[] {
    return sensors.map((s) => {
      const points = this.sensorPoints(s.entityId, raw[s.entityId], role);
      note?.(s.entityId, points);
      return { weight: s.weight, points };
    });
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

  /* ── the engine's trend after a restart ────────────────────────────────────────────────────── */

  /**
   * Room temperatures over [from, to] on a 1-min grid, so the trend shows right after a restart rather
   * than after 15 min of new samples: the room's sensors combined by its method, Klimo's own sensor only
   * for a room whose sensors are not recorded. Rooms without data are left out.
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
    const temps = new Map(rooms.map((r) => [r.id, this.roomSensors(r.id, 'temperature')]));
    const raw = await this.readSensors([...temps.values()].flat(), from, to);
    const missing: RoomConfig[] = [];
    for (const r of rooms) {
      const steps = combineSteps(this.sensorSteps(raw, temps.get(r.id) ?? [], 'temperature'), r.temperature.method, r.temperature.outlier, from, to);
      const points = grid(steps);
      if (points.length) out[r.id] = points;
      else missing.push(r);
    }
    if (missing.length) {
      const ids = this.klimoIds(missing);
      const own = await this.ha.history(missing.map((r) => ids.get(r.id)!.temperature), from, to, MINIMAL);
      for (const r of missing) {
        const id = ids.get(r.id)!.temperature;
        const points = grid(this.numericPoints(own[id], this.tempUnitOf(id)));
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
    return this.cached(`day|${room.id}|${date}|${minuteOf(now)}`, HISTORY_TTL, () => this.buildRoomDay(room, date, now), (d) => d.complete);
  }

  private async buildRoomDay(room: RoomConfig, date: LocalDate, now: EpochMs): Promise<RoomDayDto> {
    const tz = this.clock.tz();
    const from = fromLocal(date, 0, tz);
    const to = fromLocal(addDays(date, 1), 0, tz);
    const end = Math.max(from, Math.min(to, now));
    const ids = this.klimoIds([room]).get(room.id)!;
    const tempSensors = this.roomSensors(room.id, 'temperature');
    const humSensors = this.roomSensors(room.id, 'humidity');
    const diag: RoomDayDiag = { ha: this.ha.connected, recorder: 'skipped', error: null, entities: [], humiditySource: 'none', targetSource: 'none' };
    const note = (role: RoomDayEntityRole, rows: HistoryRows) => (entityId: EntityId, points: Point[]) =>
      diag.entities.push({ entityId, role, rows: rows[entityId]?.length ?? 0, numeric: points.filter(([, v]) => v !== null).length });

    let temperature: Point[] = [];
    let humidity: Point[] = [];
    let source: RoomDaySource = 'none';
    let targetRows: HistoryRows[string] = [];
    // only a recorder that answered makes a day worth keeping; before that the page asks again
    let complete = end <= from;

    if (end > from && this.ha.connected) {
      try {
        const [raw, target] = await Promise.all([this.readSensors([...tempSensors, ...humSensors], from, end), this.ha.history([ids.target], from, end, FULL)]);
        temperature = combineSteps(this.sensorSteps(raw, tempSensors, 'temperature', note('temperature', raw)), room.temperature.method, room.temperature.outlier, from, end);
        humidity = combineSteps(this.sensorSteps(raw, humSensors, 'humidity', note('humidity', raw)), room.humidity.method, null, from, end);
        if (hasData(temperature)) source = 'raw_sensors';
        if (hasData(humidity)) diag.humiditySource = 'raw_sensors';
        targetRows = target[ids.target] ?? [];
        note('klimo_target', target)(ids.target, targetRows.map((r) => [0, parseNumber(r.s)] as Point));

        // Klimo's published sensors only stand in where the room's sensors have nothing recorded
        const ownIds = [...(source === 'none' ? [ids.temperature] : []), ...(diag.humiditySource === 'none' && humSensors.length ? [ids.humidity] : [])];
        if (ownIds.length) {
          const own = await this.ha.history(ownIds, from, end, MINIMAL);
          // HA shows (and records) Klimo's °C sensors in its own unit system
          const ownSteps = (id: EntityId, role: RoomDayEntityRole) => {
            const points = this.numericPoints(own[id], role === 'klimo_temperature' ? this.tempUnitOf(id) : null);
            note(role, own)(id, points);
            return combineSteps([{ weight: 1, points }], 'average', null, from, end);
          };
          if (source === 'none') {
            temperature = ownSteps(ids.temperature, 'klimo_temperature');
            if (hasData(temperature)) source = 'klimo_entity';
          }
          if (diag.humiditySource === 'none' && humSensors.length) {
            humidity = ownSteps(ids.humidity, 'klimo_humidity');
            if (hasData(humidity)) diag.humiditySource = 'klimo_entity';
          }
        }
        diag.recorder = 'ok';
        complete = true;
        this.once.reset(`day:${room.id}`);
      } catch (e) {
        diag.recorder = 'error';
        diag.error = errorText(e);
        temperature = [];
        humidity = [];
        source = 'none';
        diag.humiditySource = 'none';
        targetRows = [];
        this.once.warn(`day:${room.id}`, `recorder unavailable for the room day, using the last hours in memory: ${errorText(e)}`);
      }
    }
    // the recorder cannot be read (yet), or keeps none of these entities: the last hours Klimo kept itself
    if (end > from) {
      const inDay = ([t]: Point) => t >= from && t <= end;
      if (source === 'none') {
        const ring = this.ringPoints(room.id, (s) => s.c).filter(inDay);
        if (hasData(ring)) [temperature, source] = [ring, 'memory'];
      }
      if (diag.humiditySource === 'none') {
        const ring = this.ringPoints(room.id, (s) => s.h).filter(inDay);
        if (hasData(ring)) [humidity, diag.humiditySource] = [ring, 'memory'];
      }
    }

    const target = this.targetSegments(room, date, from, to, now, targetRows, this.tempUnitOf(ids.target));
    diag.targetSource = target.source;
    const demandSpans = await this.demandSpans(room, from, to, end, ids, diag);
    const chart = (points: Point[], kind: RoomDaySource, round: (x: number) => number): [EpochMs, number | null][] =>
      (kind === 'memory' ? downsample(points, from, end, MAX_POINTS) : onGrid(points, from, end, CHART_STEP)).map(([t, v]) => [t, v === null ? null : round(v)]);
    const day: RoomDayDto = {
      roomId: room.id,
      date,
      series: chart(temperature, source, round1),
      source,
      humidity: chart(humidity, diag.humiditySource, Math.round),
      targetSegments: target.segments,
      demandSpans,
      stats: this.dayStats(room.id, temperature, demandSpans, from, end),
      asOf: end,
      complete,
      diag,
    };
    this.log.debug(
      `day ${room.name} ${date}: temperature ${source}, humidity ${diag.humiditySource}, target ${diag.targetSource}; ` +
        `${complete ? 'complete' : 'incomplete'} (HA ${diag.ha ? 'connected' : 'not connected'}, recorder ${diag.recorder}${diag.error ? `: ${diag.error}` : ''}); ` +
        (diag.entities.map((e) => `${e.entityId} ${e.role} ${e.numeric}/${e.rows}`).join(', ') || 'no entities read'),
    );
    return day;
  }

  /**
   * The target band: the past from Klimo's recorded target sensor, its gaps (Klimo stopped, sensor not
   * recorded) from the schedule, so the elapsed part of the day always has a band. Ahead: a target held
   * by hand (or a room profile, presence…) until it ends, then the schedule.
   */
  private targetSegments(
    room: RoomConfig,
    date: LocalDate,
    from: EpochMs,
    to: EpochMs,
    now: EpochMs,
    rows: HistoryRows[string],
    unit: TempUnit | null,
  ): { segments: Segment[]; source: RoomDayDiag['targetSource'] } {
    const mode = this.learned.get(room.id)?.mode ?? 'heat';
    const pastEnd = Math.max(from, Math.min(now, to));
    let attrs: Record<string, unknown> = {};
    const past: { at: EpochMs; seg: Omit<Segment, 'from' | 'to'> | null }[] = [];
    for (const row of rows) {
      if (row.a) attrs = row.a;
      const at = Math.max(from, Math.round(row.lu * 1000));
      // the state is in HA's unit (°F with an imperial unit system); lo / hi are Klimo's own °C attributes
      const state = parseNumber(row.s);
      const v = state !== null && (tempUnit(attrs.unit_of_measurement) ?? unit) === '°F' ? fToC(state) : state;
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
    const recorded: Segment[] = [];
    for (let i = 0; i < past.length; i++) {
      const seg = past[i].seg;
      const segTo = Math.min(i + 1 < past.length ? past[i + 1].at : pastEnd, pastEnd);
      if (seg && segTo > past[i].at) recorded.push({ from: past[i].at, to: segTo, ...seg });
    }

    const plan = this.planned(room, date, from, to);
    const out: Segment[] = [...recorded];
    const gaps = gapsOf(recorded, from, pastEnd);
    for (const [a, b] of gaps) {
      for (const s of plan) {
        const x = Math.max(a, s.from);
        const y = Math.min(b, s.to);
        if (y > x) out.push({ ...s, from: x, to: y, future: false });
      }
    }
    let ahead = pastEnd;
    const cur = this.current.get(room.id);
    if (cur && now - cur.at <= CURRENT_FRESH && cur.at <= now && HELD_LAYERS.has(cur.layer) && (cur.heatC !== null || cur.coolC !== null)) {
      const until = Math.min(to, cur.until ?? to);
      if (until > ahead) {
        out.push({ from: ahead, to: until, heatC: cur.heatC, coolC: cur.coolC, future: true, kind: cur.kind });
        ahead = until;
      }
    }
    for (const s of plan) {
      const x = Math.max(ahead, s.from);
      if (s.to > x) out.push({ ...s, from: x, future: true });
    }
    const covered = pastEnd - from - gaps.reduce((n, [a, b]) => n + b - a, 0);
    const source: RoomDayDiag['targetSource'] = !recorded.length ? (plan.length ? 'plan' : 'none') : covered >= pastEnd - from ? 'klimo_target' : plan.length ? 'mixed' : 'klimo_target';
    return { segments: mergeSegments(out), source };
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
    ids: Record<'heat_demand' | 'cool_demand', EntityId>,
    diag: RoomDayDiag,
  ): Promise<RoomDayDto['demandSpans']> {
    let spans: RoomDayDto['demandSpans'] = [];
    try {
      spans = (await this.spans.range(from, to, 'room', room.id))
        .filter((s) => s.kind === 'demand' && (s.mode === 'heat' || s.mode === 'cool'))
        .map((s) => ({ from: Math.max(from, s.startTs), to: s.endTs === null ? null : Math.min(to, s.endTs), mode: s.mode as Mode }));
    } catch (e) {
      this.log.warn(`run spans unavailable: ${errorText(e)}`);
    }
    if (spans.length || diag.recorder !== 'ok') return spans.sort((a, b) => a.from - b.from);
    // no spans yet (new database): the recorded demand sensors tell the same story
    let rows: HistoryRows = {};
    try {
      rows = await this.ha.history([ids.heat_demand, ids.cool_demand], from, end, MINIMAL);
    } catch (e) {
      this.log.debug(`demand sensors not read: ${errorText(e)}`);
    }
    for (const mode of ['heat', 'cool'] as const) {
      const id = mode === 'heat' ? ids.heat_demand : ids.cool_demand;
      const list = rows[id] ?? [];
      if (list.length) diag.entities.push({ entityId: id, role: mode === 'heat' ? 'klimo_heat_demand' : 'klimo_cool_demand', rows: list.length, numeric: 0 });
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
    const { min, max } = extremes(series, from, end, round1);
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
    return this.cached(key, HISTORY_TTL, () => this.buildSparks(rooms, last, now), (v) => Object.values(v).every((s) => s.complete));
  }

  private async buildSparks(rooms: RoomConfig[], last: EpochMs, now: EpochMs): Promise<Record<Id, SparkDto>> {
    const from = last - (SPARK_POINTS - 1) * SPARK_STEP;
    const times = Array.from({ length: SPARK_POINTS }, (_, i) => from + i * SPARK_STEP);
    const ids = this.klimoIds(rooms);
    // thermostats keep no statistics of their current temperature: those rooms use Klimo's sensor
    const rawByRoom = new Map(rooms.map((r) => [r.id, this.roomSensors(r.id, 'temperature').filter((s) => domainOf(s.entityId) !== 'climate')]));
    const statIds = [...new Set(rooms.flatMap((r) => [ids.get(r.id)!.temperature, ids.get(r.id)!.target, ...(rawByRoom.get(r.id) ?? []).map((s) => s.entityId)]))];

    let stats: StatRows = {};
    let complete = this.ha.connected;
    if (statIds.length && this.ha.connected) {
      try {
        stats = await this.ha.statistics(statIds, from - 3 * STAT_BUCKET, now, '5minute', ['mean']);
        this.once.reset('sparks');
      } catch (e) {
        complete = false;
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
      const raw = rawByRoom.get(room.id) ?? [];
      // the room's sensors combined like the live value; Klimo's published sensor only without them
      let values = times.map((t) =>
        combine(
          dropOutliers(
            raw.flatMap((s) => {
              const v = pick(stats[s.entityId], t);
              return v === null ? [] : [{ v, w: s.weight }];
            }),
            room.temperature.outlier,
          ),
          room.temperature.method,
        ),
      );
      if (!nonEmpty(values)) values = times.map((t) => pick(stats[own.temperature], t));
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
        complete,
      };
    }
    return out;
  }

  /* ── outdoor ───────────────────────────────────────────────────────────────────────────────── */

  async outdoor(days: number): Promise<OutdoorHistoryDto> {
    const d = Math.min(31, Math.max(1, Math.round(Number.isFinite(days) ? days : 3)));
    this.requireHa();
    const o = this.config.engineConfig().settings.outdoor;
    const ids = outdoorSensorIds(o);
    const method = o.aggregation ?? 'median';
    const weatherEntityId = o.weatherEntityId;
    const now = this.clock.now();
    const end = Math.floor(now / HOUR) * HOUR + HOUR;
    const from = end - d * DAY;
    const key = `outdoor|${d}|${ids.join(',')}|${method}|${weatherEntityId ?? ''}|${minuteOf(end)}`;
    return this.cached(key, STATISTICS_TTL, async () => {
      let series: OutdoorHistoryDto['series'] = [];
      const known = () => series.some((p) => p.mean !== null);
      try {
        if (ids.length) {
          const stats = await this.ha.statistics(ids, from, end, 'hour', ['mean', 'min', 'max']);
          series = combineHourly(ids.map((id) => toStatPoints(stats[id] ?? [])), method);
          if (!known()) {
            const raw = await this.ha.history(ids, from, now, { minimal: true, noAttributes: true });
            series = combineHourly(ids.map((id) => toBuckets(bucketize(this.numericPoints(raw[id], this.tempUnitOf(id)), from, end, HOUR))), method);
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

/**
 * The outdoor sensors' hourly points as one series: mean, min and max of each hour are combined
 * across the sensors that have them, by the outdoor method (one sensor passes through unchanged).
 */
function combineHourly(perSensor: StatisticsSeriesDto['points'][], method: OutdoorAggregation): StatisticsSeriesDto['points'] {
  if (perSensor.length === 1) return perSensor[0];
  const field = (k: 'mean' | 'min' | 'max') => combineBuckets(perSensor.map((pts) => pts.map((p) => ({ start: p.start, value: p[k] }))), method);
  const mins = new Map(field('min'));
  const maxs = new Map(field('max'));
  return field('mean').map(([start, mean]) => ({
    start,
    mean: roundTo(mean, 2),
    min: roundTo(mins.get(start) ?? null, 2),
    max: roundTo(maxs.get(start) ?? null, 2),
    state: null,
    sum: null,
  }));
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

/** The parts of [from, end] no segment covers. */
function gapsOf(segments: readonly Segment[], from: EpochMs, end: EpochMs): [EpochMs, EpochMs][] {
  const gaps: [EpochMs, EpochMs][] = [];
  let at = from;
  for (const s of [...segments].sort((a, b) => a.from - b.from)) {
    if (s.from > at) gaps.push([at, Math.min(s.from, end)]);
    at = Math.max(at, s.to);
    if (at >= end) break;
  }
  if (at < end) gaps.push([at, end]);
  return gaps.filter(([a, b]) => b > a);
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
