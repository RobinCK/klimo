import { round1 } from '../../shared/model';
import type { Detection, EpochMs, HumidityState, InputSnapshot, Latch, RoomConfig, SensorReading, Season } from '../../shared/model';
import { absoluteHumidity, magnusDewPoint, median } from './util';

/* =====================================================================================================
 * Humidity, dew point and the condensation estimate for the window glass. Humidity alerts are facts here;
 * the incident service applies the hold time (`humidity.warnForMin`) before anyone is told.
 * ===================================================================================================== */

const MIN_MS = 60_000;
/** RH must stay above the dehumidifier ON threshold this long. */
const DEHUMIDIFIER_CONFIRM_MS = 2 * MIN_MS;
/** Hours above 70 % RH within a day that mean mould risk. */
const MOLD_HOURS = 6;

export interface HumidityOutput {
  state: HumidityState;
  dehumidifier: Latch;
  detections: Detection[];
}

export interface HumidityInput {
  readings: SensorReading[];
  tempC: number | null;
  season: Season;
  /** Window reaction or airing active: the dehumidifier is pointless with the window open. */
  ventilating: boolean;
  dehumidifier: Latch;
  /** settings.glassCoefficient: T_glass ≈ T − k·(T − T_out). */
  glassK: number;
}

/** Relative humidity over the room's live humidity sensors, rounded to 1 %. */
export function aggregateHumidity(room: RoomConfig, readings: SensorReading[]): { valuePct: number | null; maxPct: number | null } {
  const vs = readings.filter((r) => r.role === 'humidity' && r.status === 'ok' && r.humidityPct !== null).map((r) => r.humidityPct as number);
  if (!vs.length) return { valuePct: null, maxPct: null };
  const m = room.humidity.method;
  const v = m === 'median' ? (median(vs) as number) : m === 'max' ? Math.max(...vs) : m === 'min' ? Math.min(...vs) : vs.reduce((a, x) => a + x, 0) / vs.length;
  return { valuePct: Math.round(v), maxPct: Math.round(Math.max(...vs)) };
}

export function evaluateHumidity(room: RoomConfig, inputs: InputSnapshot, h: HumidityInput): HumidityOutput {
  const now: EpochMs = inputs.now;
  const { valuePct, maxPct } = aggregateHumidity(room, h.readings);
  const t = h.tempC;
  const dew = t !== null && valuePct !== null && valuePct > 0 ? round1(magnusDewPoint(t, valuePct)) : null;
  const abs = t !== null && valuePct !== null ? round1(absoluteHumidity(t, valuePct)) : null;

  const glassReading = h.readings.find((r) => r.role === 'glass' && r.status === 'ok' && r.rawC !== null);
  const tout = inputs.outdoor.nowC;
  let glassC: number | null = null;
  if (glassReading) glassC = round1(glassReading.rawC as number);
  else if (t !== null && tout !== null) glassC = round1(t - h.glassK * (t - tout));
  const glassMarginC = glassC !== null && dew !== null ? round1(glassC - dew) : null;

  const warn = valuePct !== null && valuePct > room.humidity.warnAbovePct;
  const condensationRisk = h.season === 'heating' && glassMarginC !== null && glassMarginC < room.humidity.dewGlassMarginC;

  // dehumidifier: ON after RH stays above the threshold for 2 min; while OFF, `since` marks the last tick
  // the air was dry enough, which keeps the confirmation restart-safe without another column
  let dehum = h.dehumidifier;
  const d = room.humidity.dehumidifier;
  if (!d || h.ventilating || valuePct === null) {
    dehum = { on: false, since: dehum.on || d ? now : dehum.since };
  } else if (dehum.on) {
    if (valuePct < d.offBelowPct && now - dehum.since >= d.minOnMin * MIN_MS) dehum = { on: false, since: now };
  } else if (valuePct > d.onAbovePct) {
    if (now - dehum.since >= DEHUMIDIFIER_CONFIRM_MS) dehum = { on: true, since: now };
  } else {
    dehum = { on: false, since: now };
  }

  const detections: Detection[] = [];
  if (room.notify.humidity) {
    detections.push({
      kind: 'humidity_high',
      dedupKey: `humidity_high:${room.id}`,
      active: warn,
      roomId: room.id,
      facts: { rh: valuePct, dewC: dew },
    });
    detections.push({
      kind: 'condensation_risk',
      dedupKey: `condensation_risk:${room.id}`,
      active: condensationRisk,
      roomId: room.id,
      facts: { glassC, dewC: dew, rh: valuePct },
    });
    const hours = inputs.humidHours24h[room.id];
    detections.push({
      kind: 'humidity_high',
      dedupKey: `humidity_high:${room.id}:mold`,
      active: hours != null && hours >= MOLD_HOURS,
      roomId: room.id,
      facts: { cause: 'mold', hours: hours ?? null, rh: valuePct },
    });
  }

  return {
    state: {
      valuePct,
      method: room.humidity.method,
      maxPct,
      dewPointC: dew,
      absGm3: abs,
      glassC,
      glassMarginC,
      warn,
      condensationRisk,
      dehumidifierOn: d ? dehum.on : null,
    },
    dehumidifier: dehum,
    detections,
  };
}
