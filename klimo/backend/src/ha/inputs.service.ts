import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { errorText, LogOnce } from '../common/logger';
import { fromLocal, isLocalDate, toLocal } from '../engine/core/time';
import { outdoorSensorIds, round1 } from '../shared/model';
import type {
  ClockPort,
  ConditionNode,
  EngineConfig,
  EntityId,
  EpochMs,
  GeneralSettings,
  HaPort,
  HaStateObj,
  IBus,
  IConfigStore,
  Id,
  IHaInputs,
  InputSnapshot,
  OutdoorReadout,
  OutdoorSensorReading,
} from '../shared/model';
import { BUS, CLOCK, CONFIG_STORE, HA_PORT } from '../tokens';
import { combineBuckets, readOutdoorSensors } from './outdoor';
import { bucketize, combine, type Point, timeWeightedMean } from './series';
import { isAvailableState, lastChangedAt, parseNumber, systemTempUnit, tempUnit, type TempUnit, toCelsius } from './units';

const MIN = 60_000;
const HOUR = 60 * MIN;
const SAMPLE_EVERY = MIN;
const AVG_WINDOW = 10 * MIN;
const FORECAST_EVERY = 30 * MIN;
const CALENDAR_EVERY = 15 * MIN;
const CALENDAR_HORIZON = 48 * HOUR;
const HOURLY = HOUR;
const RENDER_TIMEOUT = 10_000;
const REFRESH_DEBOUNCE = 5_000;
/** Hours with a mean relative humidity above this count toward the mould risk. */
const HUMID_RH = 70;

type Outdoor = InputSnapshot['outdoor'];
type Forecast = InputSnapshot['forecasts'][EntityId];
type CalendarEvent = InputSnapshot['calendarEvents'][EntityId][number];
type TemplateResult = InputSnapshot['templateResults'][string];

interface TemplateSub {
  template: string;
  cancelled: boolean;
  unsubscribe: (() => void) | null;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

function record(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Every condition tree of the configuration (triggers, rules, source conditions, energy, watch rules). */
function conditionTrees(cfg: EngineConfig): ConditionNode[] {
  const out: ConditionNode[] = [];
  for (const t of cfg.triggers) out.push(t.condition);
  for (const r of cfg.rules) {
    out.push(r.when);
    if (r.stopWhen) out.push(r.stopWhen);
  }
  for (const s of cfg.sources) for (const item of s.conditions.items) out.push(item.node);
  out.push(cfg.energy.activeWhen);
  for (const w of cfg.watchRules) if (w.condition.type === 'custom') out.push(w.condition.node);
  return out;
}

function walk(node: ConditionNode | null | undefined, visit: (n: ConditionNode) => void): void {
  if (!node) return;
  visit(node);
  if (node.op === 'all' || node.op === 'any') for (const c of node.items ?? []) walk(c, visit);
  else if (node.op === 'not') walk(node.item, visit);
}

/** A rendered template as a condition value: booleans, numbers ≠ 0 and on/true/yes are true. */
export function templateBoolean(result: unknown): TemplateResult {
  if (typeof result === 'boolean') return { value: result, error: null };
  if (typeof result === 'number') return { value: Number.isFinite(result) ? result !== 0 : null, error: null };
  if (result === null || result === undefined) return { value: null, error: null };
  const s = String(result).trim().toLowerCase();
  if (['true', 'on', 'yes', '1', 'open', 'home'].includes(s)) return { value: true, error: null };
  if (['false', 'off', 'no', '0', '', 'closed', 'not_home'].includes(s)) return { value: false, error: null };
  if (['unknown', 'unavailable', 'none'].includes(s)) return { value: null, error: null };
  const n = Number(s);
  if (Number.isFinite(n)) return { value: n !== 0, error: null };
  return { value: null, error: `not a boolean: "${String(result).slice(0, 60)}"` };
}

/**
 * Inputs of the engine that are more than a plain entity state: the outdoor temperature with its
 * fallbacks and means, weather forecasts, calendar events, HA-rendered template conditions, humid
 * hours for the mould warning and the Zigbee2MQTT bridge states. Everything is cached here so the
 * engine reads it synchronously every tick.
 */
@Injectable()
export class HaInputsService implements IHaInputs, OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('HaInputs');
  private readonly once = new LogOnce(this.log);
  private readonly timers: { cancel(): void }[] = [];
  private readonly unsubscribers: (() => void)[] = [];

  /** The last combined value and the sensor list it came from (a changed list ends the hold). */
  private lastGood: { key: string; value: number; at: EpochMs } | null = null;
  private current: Outdoor = { nowC: null, avg10C: null, avgNC: null, source: 'none' };
  private readings: OutdoorSensorReading[] = [];
  private samples: Point[] = [];
  private avgN: number | null = null;

  private forecastMap: InputSnapshot['forecasts'] = {};
  private calendarMap: InputSnapshot['calendarEvents'] = {};
  private humid: InputSnapshot['humidHours24h'] = {};
  private readonly bridges = new Map<Id, { online: boolean; at: EpochMs }>();
  private readonly templates = new Map<string, TemplateSub>();
  private readonly templateValues: InputSnapshot['templateResults'] = {};
  private refreshTimer: { cancel(): void } | null = null;
  private readonly busy = new Set<string>();

  constructor(
    @Inject(HA_PORT) private readonly ha: HaPort,
    @Inject(CONFIG_STORE) private readonly config: IConfigStore,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(BUS) private readonly bus: IBus,
  ) {}

  onApplicationBootstrap(): void {
    this.sampleOutdoor();
    this.timers.push(
      this.clock.setInterval(() => this.sampleOutdoor(), SAMPLE_EVERY),
      this.clock.setInterval(() => void this.refreshForecasts(), FORECAST_EVERY),
      this.clock.setInterval(() => void this.refreshCalendars(), CALENDAR_EVERY),
      this.clock.setInterval(() => {
        void this.refreshAverage();
        void this.refreshHumidHours();
      }, HOURLY),
    );
    this.ha.onConnection((ok) => {
      if (ok) this.refreshAll();
    });
    this.unsubscribers.push(
      this.bus.on('z2m.bridge', ({ instanceId, online }) => this.bridges.set(instanceId, { online, at: this.clock.now() })),
      this.bus.on('config.changed', ({ entity }) => {
        if (['settings', 'strategy', 'trigger', 'rule', 'source', 'energy', 'watch_rule', 'activation_rule', 'sensor', 'room'].includes(entity)) {
          this.scheduleRefresh();
        }
      }),
    );
    if (this.ha.connected) this.refreshAll();
  }

  onModuleDestroy(): void {
    for (const t of this.timers) t.cancel();
    this.refreshTimer?.cancel();
    for (const u of this.unsubscribers) u();
    for (const [key] of this.templates) this.dropTemplate(key);
  }

  private refreshAll(): void {
    void this.refreshForecasts();
    void this.refreshCalendars();
    void this.refreshAverage();
    void this.refreshHumidHours();
  }

  private scheduleRefresh(): void {
    this.refreshTimer?.cancel();
    this.refreshTimer = this.clock.setTimeout(() => {
      this.refreshTimer = null;
      if (this.ha.connected) this.refreshAll();
    }, REFRESH_DEBOUNCE);
  }

  /** Runs one refresh of a kind at a time; a failure is logged once until it succeeds again. */
  private async exclusive(kind: string, fn: () => Promise<void>): Promise<void> {
    if (this.busy.has(kind) || !this.ha.connected) return;
    this.busy.add(kind);
    try {
      await fn();
      this.once.reset(kind);
    } catch (e) {
      this.once.warn(kind, `${kind} refresh failed: ${errorText(e)}`);
    } finally {
      this.busy.delete(kind);
    }
  }

  private haUnit(): TempUnit {
    return systemTempUnit(this.ha.config()?.unit_system.temperature);
  }

  /* ── outdoor ───────────────────────────────────────────────────────────────────────────────── */

  outdoor(): Outdoor {
    this.evaluateOutdoor(this.clock.now());
    return { ...this.current };
  }

  outdoorReadout(): OutdoorReadout {
    this.evaluateOutdoor(this.clock.now());
    const method = this.config.engineConfig().settings.outdoor.aggregation ?? 'median';
    return { ...this.current, method, sensors: this.readings.map((r) => ({ ...r })) };
  }

  /** Every minute: the current value joins the samples of the 10-min mean. */
  sampleOutdoor(): void {
    const now = this.clock.now();
    this.evaluateOutdoor(now);
    if (this.current.nowC !== null) this.samples.push([now, this.current.nowC]);
    while (this.samples.length && now - this.samples[0][0] > AVG_WINDOW + SAMPLE_EVERY) this.samples.shift();
  }

  /**
   * The configured sensors combined while at least one of them is fresh; when none is, the last
   * combined value is held for `outdoor.holdMin` (counted from the last good reading), then the weather
   * entity's temperature, then nothing. The 10-min mean runs over the combined minute samples.
   */
  private evaluateOutdoor(now: EpochMs): void {
    const s = this.config.engineConfig().settings.outdoor;
    const ids = outdoorSensorIds(s);
    const key = ids.join(',');
    const read = readOutdoorSensors(s, (id) => this.ha.getState(id), now, this.haUnit());
    this.readings = read.readings;
    let nowC: number | null;
    let source: Outdoor['source'];
    if (read.valueC !== null) {
      this.lastGood = { key, value: read.valueC, at: now };
      nowC = read.valueC;
      source = 'sensor';
    } else if (this.lastGood && ids.length && this.lastGood.key === key && now - this.lastGood.at < s.holdMin * MIN) {
      nowC = this.lastGood.value;
      source = 'hold';
    } else {
      const w = s.weatherEntityId ? this.weatherNow(s.weatherEntityId) : null;
      nowC = w;
      source = w === null ? 'none' : 'weather';
    }
    const window = this.samples.filter(([t]) => t >= now - AVG_WINDOW - SAMPLE_EVERY && t <= now);
    const avg10 = window.length ? timeWeightedMean(window, now - AVG_WINDOW, now) : null;
    this.current = {
      nowC: nowC === null ? null : round1(nowC),
      avg10C: avg10 === null ? (nowC === null ? null : round1(nowC)) : round1(avg10),
      avgNC: this.avgN,
      source,
    };
  }

  private weatherNow(entityId: EntityId): number | null {
    const st = this.ha.getState(entityId);
    if (!st || !isAvailableState(st.state)) return null;
    const t = parseNumber(st.attributes.temperature);
    return t === null ? null : toCelsius(t, tempUnit(st.attributes.temperature_unit) ?? this.haUnit());
  }

  /**
   * The N-day mean for the season, over the combined value hour by hour: hourly means from long-term
   * statistics (needs ≥ 48 combined hours, or a full window when N is shorter), else the sensors' raw
   * history in hourly buckets, else the weather entity's history, else the previous value stays.
   */
  async refreshAverage(): Promise<void> {
    await this.exclusive('outdoor average', async () => {
      const cfg = this.config.engineConfig();
      const o = cfg.settings.outdoor;
      const ids = outdoorSensorIds(o);
      const method = o.aggregation ?? 'median';
      const days = Math.max(1, cfg.season.avgDays);
      const now = this.clock.now();
      const from = now - days * 24 * HOUR;
      let avg: number | null = null;
      if (ids.length) {
        const stats = await this.ha.statistics(ids, from, now, 'hour', ['mean']);
        const hours = combineBuckets(ids.map((id) => (stats[id] ?? []).map((r) => ({ start: r.start, value: typeof r.mean === 'number' ? r.mean : null }))), method);
        const means = hours.flatMap(([, v]) => (v === null ? [] : [v]));
        if (means.length >= Math.min(48, days * 24)) avg = mean(means);
        if (avg === null) avg = await this.sensorsHistoryMean(ids, method, from, now);
      }
      if (avg === null && o.weatherEntityId) avg = await this.weatherHistoryMean(o.weatherEntityId, from, now);
      if (avg !== null) this.avgN = round1(avg);
      this.current = { ...this.current, avgNC: this.avgN };
    });
  }

  /** The sensors' recorded states (each in its own unit) combined per hour, then averaged. */
  private async sensorsHistoryMean(ids: EntityId[], method: GeneralSettings['outdoor']['aggregation'], from: EpochMs, to: EpochMs): Promise<number | null> {
    const raw = await this.ha.history(ids, from, to, { minimal: true, noAttributes: true });
    const series = ids.map((id) => {
      const unit = tempUnit(this.ha.getState(id)?.attributes.unit_of_measurement) ?? this.haUnit();
      const points: Point[] = (raw[id] ?? []).map((row) => {
        const n = parseNumber(row.s);
        return [Math.round(row.lu * 1000), n === null ? null : toCelsius(n, unit)];
      });
      return bucketize(points, from, to, HOUR).map((b) => ({ start: b.start, value: b.mean }));
    });
    const hours = combineBuckets(series, method).flatMap(([, v]) => (v === null ? [] : [v]));
    return hours.length ? mean(hours) : null;
  }

  private async weatherHistoryMean(entityId: EntityId, from: EpochMs, to: EpochMs): Promise<number | null> {
    const rows = (await this.ha.history([entityId], from, to, { minimal: false, noAttributes: false }))[entityId] ?? [];
    const unit = tempUnit(this.ha.getState(entityId)?.attributes.temperature_unit) ?? this.haUnit();
    let attrs: Record<string, unknown> = {};
    const points: Point[] = rows.map((row) => {
      if (row.a) attrs = row.a;
      const n = parseNumber(attrs.temperature);
      return [Math.round(row.lu * 1000), n === null ? null : toCelsius(n, unit)];
    });
    return timeWeightedMean(points, from, to);
  }

  /* ── forecasts ─────────────────────────────────────────────────────────────────────────────── */

  forecasts(): InputSnapshot['forecasts'] {
    return { ...this.forecastMap };
  }

  /** Weather entities whose forecast someone reads: the outdoor fallback and every weather condition. */
  private weatherEntities(cfg: EngineConfig): EntityId[] {
    const ids = new Set<EntityId>();
    if (cfg.settings.outdoor.weatherEntityId) ids.add(cfg.settings.outdoor.weatherEntityId);
    for (const tree of conditionTrees(cfg)) walk(tree, (n) => {
      if (n.op === 'weather' && n.entityId) ids.add(n.entityId);
    });
    return [...ids];
  }

  async refreshForecasts(): Promise<void> {
    await this.exclusive('forecast', async () => {
      const ids = this.weatherEntities(this.config.engineConfig());
      const next: InputSnapshot['forecasts'] = {};
      for (const id of ids) {
        try {
          next[id] = await this.forecastOf(id);
        } catch (e) {
          this.once.warn(`forecast:${id}`, `no forecast from ${id}: ${errorText(e)}`);
          if (this.forecastMap[id]) next[id] = this.forecastMap[id];
        }
      }
      this.forecastMap = next;
    });
  }

  private async forecastOf(entityId: EntityId): Promise<Forecast> {
    const st = this.ha.getState(entityId);
    const unit = tempUnit(st?.attributes.temperature_unit) ?? this.haUnit();
    const tz = this.clock.tz();
    const now = this.clock.now();
    const today = toLocal(now, tz).date;
    const tomorrow = toLocal(now + 24 * HOUR, tz).date;
    const fetch = async (type: 'daily' | 'hourly') => {
      const res = await this.ha.callService('weather', 'get_forecasts', { entity_id: entityId }, { type }, true);
      const list = record(record(res.response)[entityId]).forecast;
      return Array.isArray(list) ? list.map(record) : [];
    };
    const temp = (v: unknown) => {
      const n = parseNumber(v);
      return n === null ? null : round1(toCelsius(n, unit));
    };
    const dateOf = (f: Record<string, unknown>) => {
      const t = typeof f.datetime === 'string' ? Date.parse(f.datetime) : NaN;
      return Number.isFinite(t) ? toLocal(t, tz).date : null;
    };

    let daily: Record<string, unknown>[] = [];
    try {
      daily = await fetch('daily');
    } catch {
      daily = [];
    }
    if (daily.length) {
      const dated = daily.map((f) => ({ f, date: dateOf(f) }));
      const d0 = dated.find((x) => x.date === today)?.f ?? (dated[0]?.date === null ? dated[0].f : undefined);
      const d1 = dated.find((x) => x.date === tomorrow)?.f ?? (dated[1]?.date === null ? dated[1].f : undefined);
      return {
        highToday: d0 ? temp(d0.temperature) : null,
        lowToday: d0 ? temp(d0.templow) : null,
        highTomorrow: d1 ? temp(d1.temperature) : null,
        condition: (typeof d0?.condition === 'string' ? d0.condition : null) ?? (st && isAvailableState(st.state) ? st.state : null),
      };
    }
    // weather integrations without a daily forecast: aggregate the hourly one per local day
    const hourly = await fetch('hourly');
    const byDay = (date: string) => hourly.filter((f) => dateOf(f) === date).map((f) => temp(f.temperature)).filter((x): x is number => x !== null);
    const t0 = byDay(today);
    const t1 = byDay(tomorrow);
    const firstToday = hourly.find((f) => dateOf(f) === today);
    return {
      highToday: t0.length ? Math.max(...t0) : null,
      lowToday: t0.length ? Math.min(...t0) : null,
      highTomorrow: t1.length ? Math.max(...t1) : null,
      condition: (typeof firstToday?.condition === 'string' ? firstToday.condition : null) ?? (st && isAvailableState(st.state) ? st.state : null),
    };
  }

  /* ── calendars ─────────────────────────────────────────────────────────────────────────────── */

  calendarEvents(): InputSnapshot['calendarEvents'] {
    return { ...this.calendarMap };
  }

  async refreshCalendars(): Promise<void> {
    await this.exclusive('calendar', async () => {
      const cfg = this.config.engineConfig();
      const ids = [...new Set(cfg.activationRules.flatMap((r) => (r.config.type === 'calendar' && r.config.calendarEntityId ? [r.config.calendarEntityId] : [])))];
      const now = this.clock.now();
      const next: InputSnapshot['calendarEvents'] = {};
      for (const id of ids) {
        try {
          const res = await this.ha.callService(
            'calendar',
            'get_events',
            { entity_id: id },
            { start_date_time: new Date(now).toISOString(), end_date_time: new Date(now + CALENDAR_HORIZON).toISOString() },
            true,
          );
          const events = record(record(res.response)[id]).events;
          next[id] = (Array.isArray(events) ? events.map(record) : [])
            .map((e) => this.calendarEvent(e))
            .filter((e): e is CalendarEvent => e !== null)
            .sort((a, b) => a.start - b.start);
        } catch (e) {
          this.once.warn(`calendar:${id}`, `cannot read events of ${id}: ${errorText(e)}`);
          if (this.calendarMap[id]) next[id] = this.calendarMap[id];
        }
      }
      this.calendarMap = next;
    });
  }

  /** All-day events carry dates; they span local midnight to midnight in the HA time zone. */
  private calendarEvent(e: Record<string, unknown>): CalendarEvent | null {
    const tz = this.clock.tz();
    const time = (v: unknown): EpochMs | null => {
      if (typeof v !== 'string') return null;
      if (isLocalDate(v)) return fromLocal(v, 0, tz);
      const t = Date.parse(v);
      return Number.isFinite(t) ? t : null;
    };
    const start = time(e.start);
    const end = time(e.end);
    if (start === null || end === null) return null;
    const text = (v: unknown) => (typeof v === 'string' ? v : '');
    return { start, end, summary: text(e.summary), description: text(e.description), location: text(e.location) };
  }

  /* ── templates ─────────────────────────────────────────────────────────────────────────────── */

  templateResults(): InputSnapshot['templateResults'] {
    return { ...this.templateValues };
  }

  syncTemplates(templates: { key: string; template: string }[]): void {
    const wanted = new Map(templates.map((t) => [t.key, t.template]));
    for (const [key, sub] of [...this.templates]) if (wanted.get(key) !== sub.template) this.dropTemplate(key);
    for (const [key, template] of wanted) if (!this.templates.has(key)) this.startTemplate(key, template);
  }

  private startTemplate(key: string, template: string): void {
    const sub: TemplateSub = { template, cancelled: false, unsubscribe: null };
    this.templates.set(key, sub);
    // unknown until HA renders it for the first time
    this.templateValues[key] = { value: null, error: null };
    this.ha
      .subscribeTemplate(template, {}, (result, error) => {
        if (sub.cancelled) return;
        this.templateValues[key] = error ? { value: null, error } : templateBoolean(result);
      })
      .then((unsubscribe) => {
        if (sub.cancelled) unsubscribe();
        else sub.unsubscribe = unsubscribe;
      })
      .catch((e: unknown) => {
        if (!sub.cancelled) this.templateValues[key] = { value: null, error: errorText(e) };
      });
  }

  private dropTemplate(key: string): void {
    const sub = this.templates.get(key);
    if (!sub) return;
    sub.cancelled = true;
    sub.unsubscribe?.();
    this.templates.delete(key);
    delete this.templateValues[key];
  }

  renderTemplate(template: string): Promise<{ result: unknown; error: string | null }> {
    if (!this.ha.connected) return Promise.resolve({ result: null, error: 'Home Assistant is not connected' });
    return new Promise((resolve) => {
      let done = false;
      let unsubscribe: (() => void) | null = null;
      const finish = (r: { result: unknown; error: string | null }) => {
        if (done) return;
        done = true;
        timer.cancel();
        unsubscribe?.();
        resolve(r);
      };
      const timer = this.clock.setTimeout(() => finish({ result: null, error: 'Home Assistant did not render the template in time' }), RENDER_TIMEOUT);
      this.ha
        .subscribeTemplate(template, {}, (result, error) => finish({ result: error ? null : result, error }))
        .then((u) => {
          unsubscribe = u;
          if (done) u();
        })
        .catch((e: unknown) => finish({ result: null, error: errorText(e) }));
    });
  }

  /* ── humid hours ───────────────────────────────────────────────────────────────────────────── */

  humidHours24h(): InputSnapshot['humidHours24h'] {
    return { ...this.humid };
  }

  /** Hours of the last day with the room's mean RH above 70 % (hourly statistics of its humidity sensors). */
  async refreshHumidHours(): Promise<void> {
    await this.exclusive('humid hours', async () => {
      const cfg = this.config.engineConfig();
      const sensors = new Map(cfg.rooms.map((r) => [r.id, (cfg.sensorsByRoom[r.id] ?? []).filter((s) => s.role === 'humidity' && s.included)]));
      const ids = [...new Set([...sensors.values()].flat().map((s) => s.entityId))];
      const now = this.clock.now();
      const stats = ids.length ? await this.ha.statistics(ids, now - 24 * HOUR, now, 'hour', ['mean']) : {};
      const next: InputSnapshot['humidHours24h'] = {};
      for (const room of cfg.rooms) {
        const list = sensors.get(room.id) ?? [];
        const hours = new Map<number, { v: number; w: number }[]>();
        for (const s of list) {
          for (const row of stats[s.entityId] ?? []) {
            if (typeof row.mean !== 'number') continue;
            const bucket = hours.get(row.start) ?? [];
            bucket.push({ v: row.mean, w: s.weight });
            hours.set(row.start, bucket);
          }
        }
        if (!hours.size) {
          next[room.id] = null;
          continue;
        }
        let humid = 0;
        for (const values of hours.values()) {
          const rh = combine(values, room.humidity.method);
          if (rh !== null && rh > HUMID_RH) humid++;
        }
        next[room.id] = humid;
      }
      this.humid = next;
    });
  }

  /* ── Zigbee2MQTT bridges ───────────────────────────────────────────────────────────────────── */

  /** Online state per configured instance: the newest of the MQTT bridge message and the HA connection entity. */
  z2mBridges(): InputSnapshot['z2mBridgeOnline'] {
    const instances = this.config.list('z2m');
    const out: InputSnapshot['z2mBridgeOnline'] = {};
    for (const inst of instances) {
      const fromBus = this.bridges.get(inst.id) ?? null;
      const entityId = inst.bridgeEntityId ?? (instances.length === 1 ? this.findBridgeEntity() : null);
      const st = entityId ? this.ha.getState(entityId) : undefined;
      const fromEntity = st ? { online: bridgeOnline(st), at: lastChangedAt(st) ?? 0 } : null;
      if (fromBus && (!fromEntity || fromEntity.online === null || fromBus.at >= fromEntity.at)) out[inst.id] = fromBus.online;
      else out[inst.id] = fromEntity ? fromEntity.online : null;
    }
    return out;
  }

  private findBridgeEntity(): EntityId | null {
    return this.ha.allStates().find((s) => s.entity_id.startsWith('binary_sensor.') && s.entity_id.endsWith('bridge_connection_state'))?.entity_id ?? null;
  }
}

function bridgeOnline(st: HaStateObj): boolean | null {
  const s = st.state.toLowerCase();
  if (s === 'on' || s === 'online' || s === 'true' || s === 'connected') return true;
  if (s === 'off' || s === 'offline' || s === 'false' || s === 'disconnected') return false;
  return null;
}
