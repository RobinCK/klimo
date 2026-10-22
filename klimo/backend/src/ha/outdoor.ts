import { outdoorSensorIds, round1 } from '../shared/model';
import type { EntityId, EpochMs, GeneralSettings, HaStateObj, OutdoorSensorReading } from '../shared/model';
import { combine, type Point } from './series';
import { domainOf, isAvailableState, lastReportedAt, parseNumber, stateValue, tempUnit, type TempUnit, toCelsius } from './units';

/* =====================================================================================================
 * Several outdoor thermometers make one outdoor temperature, combined like a room's sensors: what is
 * unavailable or silent longer than `staleAfterMin` is left out, the rest is combined by the chosen
 * method. A sensor the sun reaches reads high in the afternoon, which is why 'min' is offered.
 * ===================================================================================================== */

const MIN = 60_000;

export interface OutdoorNow {
  /** Every configured sensor in order, with what it reads and whether it counts. */
  readings: OutdoorSensorReading[];
  /** The combination of the counted sensors, unrounded; null when none counts. */
  valueC: number | null;
}

/** An outdoor thermometer in °C: a sensor's state, or a weather entity's temperature attribute. */
export function outdoorValue(st: HaStateObj | undefined, haUnit: TempUnit): number | null {
  if (!st || !isAvailableState(st.state)) return null;
  if (domainOf(st.entity_id) === 'weather') {
    const t = parseNumber(st.attributes.temperature);
    return t === null ? null : toCelsius(t, tempUnit(st.attributes.temperature_unit) ?? haUnit);
  }
  return stateValue(st, haUnit);
}

export function readOutdoorSensors(
  o: GeneralSettings['outdoor'],
  getState: (id: EntityId) => HaStateObj | undefined,
  now: EpochMs,
  haUnit: TempUnit,
): OutdoorNow {
  const staleMs = o.staleAfterMin * MIN;
  const live: { v: number; w: number }[] = [];
  const readings = outdoorSensorIds(o).map((entityId): OutdoorSensorReading => {
    const st = getState(entityId);
    const value = outdoorValue(st, haUnit);
    const reported = st ? lastReportedAt(st) : null;
    const status = value === null ? 'unavailable' : reported !== null && now - reported > staleMs ? 'stale' : 'ok';
    if (status === 'ok' && value !== null) live.push({ v: value, w: 1 });
    const friendly = st?.attributes.friendly_name;
    return {
      entityId,
      name: typeof friendly === 'string' && friendly.trim() ? friendly : entityId,
      valueC: value === null ? null : round1(value),
      lastReportedAt: reported,
      status,
    };
  });
  return { readings, valueC: combine(live, o.aggregation) };
}

/**
 * Several sensors' series combined bucket by bucket (hourly statistics or history buckets): each
 * bucket combines the sensors that have a value in it, so a sensor that was offline for a while
 * leaves the others to speak for those hours.
 */
export function combineBuckets(series: readonly (readonly { start: EpochMs; value: number | null }[])[], method: GeneralSettings['outdoor']['aggregation']): Point[] {
  const byStart = new Map<EpochMs, (number | null)[]>();
  series.forEach((rows, i) => {
    for (const r of rows) {
      const slot = byStart.get(r.start) ?? new Array<number | null>(series.length).fill(null);
      slot[i] = r.value;
      byStart.set(r.start, slot);
    }
  });
  return [...byStart.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([start, values]) => [start, combine(values.flatMap((v) => (v === null ? [] : [{ v, w: 1 }])), method)] as Point);
}
