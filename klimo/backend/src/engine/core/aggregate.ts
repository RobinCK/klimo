import { round1 } from '../../shared/model';
import type {
  AggregationMethod,
  AggregationResult,
  EmitterDevice,
  EntitySnap,
  EpochMs,
  Id,
  InputSnapshot,
  RoomConfig,
  RoomMemory,
  RoomSensor,
  SensorReading,
  SensorStatus,
} from '../../shared/model';
import { emaStep, median, slopePerHour } from './util';

/* =====================================================================================================
 * Room temperature from N sensors: drop what is excluded, unavailable or stale, smooth each sensor with a
 * time-based EMA, reject at most a minority of outliers, then compute all six methods (the method tiles
 * show them live) and round the chosen one half-up to 0.1 — the value every decision compares. When every
 * sensor is gone, the radiator heads' own readings minus a learned offset keep the room controlled.
 * ===================================================================================================== */

const MIN_MS = 60_000;
/** A TRV offset is trusted for the fallback only after this much joint data. */
export const TRV_OFFSET_MIN_MINUTES = 30;

export type EmaMap = Record<Id, { value: number; at: EpochMs }>;

const OPEN_STATES = new Set(['on', 'open', 'opening', 'true']);

export function isContactOpen(snap: EntitySnap): boolean {
  return OPEN_STATES.has(snap.state.toLowerCase());
}

function numAttr(snap: EntitySnap | undefined, ...keys: string[]): number | null {
  if (!snap) return null;
  for (const k of keys) {
    const v = snap.attrs[k];
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Battery % reported as an attribute of the entity itself (many Zigbee integrations do). */
export function batteryOf(snap: EntitySnap | undefined): number | null {
  return numAttr(snap, 'battery', 'battery_level');
}

export function lqiOf(snap: EntitySnap | undefined): number | null {
  return numAttr(snap, 'linkquality', 'lqi');
}

/** TRV `current_temperature` (already °C after capture), when the head is reachable. */
export function trvLocalTemp(snap: EntitySnap | undefined): number | null {
  if (!snap || !snap.available) return null;
  return numAttr(snap, 'current_temperature', 'local_temperature');
}

/** Status of a sensor that reports a value: excluded › unavailable › stale › ok. */
export function sensorStatus(s: RoomSensor, snap: EntitySnap | undefined, now: EpochMs, staleAfterMin: number): SensorStatus {
  if (!s.included) return 'excluded';
  if (!snap || !snap.available) return 'unavailable';
  if (s.role !== 'contact') {
    if (snap.num === null) return 'unavailable';
    if (now - snap.lastReported > staleAfterMin * MIN_MS) return 'stale';
  }
  return 'ok';
}

function methodValues(live: { value: number; weight: number }[]): Record<AggregationMethod, number | null> {
  if (!live.length) return { median: null, average: null, weighted: null, min: null, max: null, primary: null };
  const vs = live.map((l) => l.value);
  const wsum = live.reduce((a, l) => a + l.weight, 0);
  return {
    median: median(vs),
    average: vs.reduce((a, v) => a + v, 0) / vs.length,
    weighted: wsum > 0 ? live.reduce((a, l) => a + l.value * l.weight, 0) / wsum : null,
    min: Math.min(...vs),
    max: Math.max(...vs),
    primary: vs[0],
  };
}

export interface AggregateOutput {
  result: AggregationResult;
  /** Every sensor of the room (all roles), in order. */
  readings: SensorReading[];
  /** Unrounded aggregate (offset learning, the shell's minute buffer). */
  rawC: number | null;
  /** EMA entries refreshed this tick. */
  ema: EmaMap;
}

export interface TrvInput {
  device: EmitterDevice;
  snap: EntitySnap | undefined;
}

/** D.3 for one room. `ema` is the previous smoothing state (volatile, rebuilt after a restart). */
export function aggregateRoom(
  room: RoomConfig,
  sensors: RoomSensor[],
  trvs: TrvInput[],
  inputs: InputSnapshot,
  ema: EmaMap,
  learned: RoomMemory['learned'],
): AggregateOutput {
  const now = inputs.now;
  const cfgT = room.temperature;
  const tauMs = cfgT.smoothingMin * MIN_MS;
  const ordered = [...sensors].sort((a, b) => a.order - b.order);
  const nextEma: EmaMap = {};
  const readings: SensorReading[] = [];
  const temps: { reading: SensorReading; value: number; weight: number }[] = [];

  for (const s of ordered) {
    const snap = inputs.entities[s.entityId];
    const status = sensorStatus(s, snap, now, cfgT.staleAfterMin);
    const reading: SensorReading = {
      sensorId: s.id,
      entityId: s.entityId,
      role: s.role,
      rawC: null,
      smoothedC: null,
      humidityPct: null,
      contactOpen: null,
      lastReportedAt: snap ? snap.lastReported : null,
      status,
      deviationC: null,
      weight: s.weight,
      batteryPct: batteryOf(snap),
      lqi: lqiOf(snap),
    };
    if (snap && snap.available) {
      if (s.role === 'contact') reading.contactOpen = isContactOpen(snap);
      else if (s.role === 'humidity') reading.humidityPct = snap.num;
      else reading.rawC = snap.num;
    }
    if (s.role === 'temperature' && status === 'ok' && reading.rawC !== null) {
      const prev = ema[s.id];
      const fresh = !prev || tauMs <= 0 || now - prev.at > 3 * tauMs || now < prev.at;
      const value = fresh ? reading.rawC : emaStep(prev.value, reading.rawC, now - prev.at, tauMs);
      nextEma[s.id] = { value, at: now };
      reading.smoothedC = value;
      temps.push({ reading, value, weight: s.weight });
    }
    readings.push(reading);
  }

  // deviation from the median of the others; outliers only with ≥ 3 live sensors, never a majority
  if (temps.length >= 2) {
    const devs = temps.map((t, i) => t.value - (median(temps.filter((_, j) => j !== i).map((o) => o.value)) as number));
    devs.forEach((d, i) => (temps[i].reading.deviationC = round1(d)));
    if (cfgT.outlier.enabled && temps.length >= 3) {
      const cap = Math.floor((temps.length - 1) / 2);
      const candidates = devs
        .map((d, i) => ({ i, abs: Math.abs(d) }))
        .filter((c) => c.abs > cfgT.outlier.thresholdC)
        .sort((a, b) => b.abs - a.abs || a.i - b.i)
        .slice(0, cap);
      for (const c of candidates) temps[c.i].reading.status = 'outlier';
    }
  }

  const live = temps.filter((t) => t.reading.status === 'ok');
  const values = methodValues(live);
  const totalCount = ordered.filter((s) => s.role === 'temperature' && s.included).length;
  const floorProbes = readings.filter((r) => r.role === 'floor_probe' && r.status === 'ok' && r.rawC !== null).map((r) => r.rawC as number);
  const floorC = floorProbes.length ? round1(Math.max(...floorProbes)) : null;

  let valueC: number | null = null;
  let rawC: number | null = null;
  let fallback: AggregationResult['fallback'] = 'none';
  const trvValues: AggregationResult['trvValues'] = [];
  const chosen = values[cfgT.method];
  if (live.length && chosen !== null) {
    rawC = chosen;
    valueC = round1(chosen);
  } else {
    for (const t of trvs) {
      const local = trvLocalTemp(t.snap);
      const o = learned.trvOffsetC[t.device.id];
      if (local === null || !o || o.minutes < TRV_OFFSET_MIN_MINUTES) continue;
      trvValues.push({ deviceId: t.device.id, rawC: local, correctedC: round1(local - o.value) });
    }
    if (cfgT.fallbackToTrvSensors && trvValues.length) {
      rawC = median(trvValues.map((v) => v.rawC - (learned.trvOffsetC[v.deviceId]?.value ?? 0)));
      valueC = rawC === null ? null : round1(rawC);
      fallback = 'trv';
    } else {
      fallback = 'no_data';
    }
  }

  return {
    result: {
      method: cfgT.method,
      valueC,
      values,
      usedSensorIds: live.map((t) => t.reading.sensorId),
      activeCount: live.length,
      totalCount,
      fallback,
      trvValues,
      floorC,
    },
    readings,
    rawC,
    ema: nextEma,
  };
}

/**
 * Trend over the last 30 minutes of the shell's minute buffer (≥ 5 points spanning ≥ 15 min), °C/h
 * rounded to 0.1; null when there is not enough data.
 */
export function trendOf(history: [EpochMs, number][] | undefined, now: EpochMs): number | null {
  if (!history) return null;
  const pts = history.filter(([ts]) => ts >= now - 30 * MIN_MS && ts <= now);
  if (pts.length < 5 || pts[pts.length - 1][0] - pts[0][0] < 15 * MIN_MS) return null;
  const s = slopePerHour(pts);
  return s === null ? null : round1(s);
}
