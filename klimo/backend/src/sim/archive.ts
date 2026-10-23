import { addDays, fromLocal, toLocal } from '../engine/core/time';
import type { EpochMs, LocalDate } from '../shared/model';
import { stream } from './random';
import type { HourRow } from './sim-recorder';
import { BOILER_MAX_KW, BOILER_MIN_KW, gasM3PerHour, meterValue, type MeterReadings, stoveKw } from './sim-meters';
import { heatPumpCop } from './thermal-model';

/* =====================================================================================================
 * The demo house's long-term past, for the charts that span months: a year of weather — the seasons
 * of Kyiv with passing fronts, leading into the scenario's own days — and the heating it took. Minute
 * by minute the house loses heat to the outdoors; the heat pump cycles on its thermostat, the gas
 * boiler takes over below the bivalent point and helps when the pump falls behind on cold mornings,
 * the stove draws from the same gas meter. The result is what HA's statistics import would hold
 * (hourly rows), the readings the live meters go on from, and the runs Klimo would have logged.
 * ===================================================================================================== */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const YEAR_DAYS = 365.25;

/** Heat loss and heat capacity of the rooms of the thermal model together. */
const HOUSE_UA_KW_PER_K = 0.31;
const HOUSE_C_KWH_PER_K = 11.8;
const DAY_SETPOINT_C = 21;
const NIGHT_SETPOINT_C = 20;
/** The thermostat band around the setpoint. */
const BAND_C = 0.3;
const MIN_RUN_MIN = 10;
const MIN_PAUSE_MIN = 5;
/** The last days of the archive lead into the scenario's own weather. */
const BLEND_MS = 3 * DAY;

export interface ArchiveSpec {
  /** First hour of the archive; `to` is where the live recording starts. */
  from: EpochMs;
  to: EpochMs;
  tz: string;
  seed: number;
  /** The scenario's outdoor temperature around `to`. */
  near: (t: EpochMs) => number;
  bivalencePointC: number;
  bivalenceHysteresisC: number;
  heatingCutoffC: number;
  /** The boiler joins when the house stays this far below its setpoint for this long. */
  lag: { deficitC: number; forMin: number } | null;
}

export interface ArchiveRun {
  source: 'heatPump' | 'boiler';
  start: EpochMs;
  end: EpochMs;
}

export interface Archive {
  outdoor: HourRow[];
  sunnyWall: HourRow[];
  gas: HourRow[];
  hpEnergy: HourRow[];
  hpHeat: HourRow[];
  /** Meter readings at `to`. */
  end: MeterReadings;
  runs: ArchiveRun[];
}

/** Heat pump output at an outdoor temperature: less in frost, as an air-to-water unit gives. */
export function heatPumpCapacityKw(outdoorC: number): number {
  return Math.min(7.5, Math.max(4.2, 6.4 + 0.12 * (outdoorC - 7)));
}

/** Day of the year of a local date (1 = 1 January). */
function dayOfYear(date: LocalDate): number {
  const y = Number(date.slice(0, 4));
  return (Date.UTC(y, Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) - Date.UTC(y, 0, 1)) / DAY + 1;
}

/**
 * Outdoor temperature without the scenario: the seasonal mean of Kyiv (−4 °C mid-January, +21 °C
 * mid-July), fronts passing every few days (stronger in winter) and the day's swing. It depends on
 * absolute time and the seed only, so the histories of different scenarios agree where they overlap.
 */
export class ArchiveClimate {
  private readonly waves: { amp: number; periodMs: number; phase: number }[];

  constructor(seed: number) {
    const rng = stream(seed, 'archive-climate');
    this.waves = [
      [2.4, 9.7],
      [1.9, 5.3],
      [1.3, 3.1],
      [0.8, 1.7],
    ].map(([amp, days]) => ({ amp, periodMs: days * DAY, phase: rng.range(0, 2 * Math.PI) }));
  }

  /** `doy` and `minute` are local; `season` = cos of the year phase (1 mid-January, −1 mid-July). */
  at(t: EpochMs, doy: number, minute: number): number {
    const season = Math.cos((2 * Math.PI * (doy - 15)) / YEAR_DAYS);
    const mean = 8.4 - 12.6 * season;
    let front = 0;
    for (const w of this.waves) front += w.amp * Math.sin((2 * Math.PI * t) / w.periodMs + w.phase);
    const swing = (3.5 - 1.5 * season) * Math.sin((2 * Math.PI * (minute / 60 - 9)) / 24);
    return mean + front * (1 + 0.4 * season) + swing;
  }
}

/** The south wall in the afternoon sun reads warmer than the air. */
function sunnyWallBonus(minute: number, doy: number): number {
  const h = minute / 60;
  if (h < 11 || h > 18) return 0;
  const strength = 2.5 + 1.5 * -Math.cos((2 * Math.PI * (doy - 15)) / YEAR_DAYS);
  return strength * Math.sin((Math.PI * (h - 11)) / 7);
}

/** Solar and internal gains of the house, kW. */
function gainsKw(minute: number, doy: number): number {
  const h = minute / 60;
  const sun = h > 8 && h < 17 ? Math.sin((Math.PI * (h - 8)) / 9) : 0;
  return 0.4 + sun * (0.9 - 0.5 * Math.cos((2 * Math.PI * (doy - 15)) / YEAR_DAYS));
}

class HourAcc {
  private n = 0;
  private sum = 0;
  private min = Infinity;
  private max = -Infinity;

  add(v: number): void {
    this.n++;
    this.sum += v;
    this.min = Math.min(this.min, v);
    this.max = Math.max(this.max, v);
  }

  row(start: EpochMs): HourRow | null {
    if (!this.n) return null;
    const r = { start, mean: Math.round((this.sum / this.n) * 1000) / 1000, min: Math.round(this.min * 10) / 10, max: Math.round(this.max * 10) / 10 };
    this.n = 0;
    this.sum = 0;
    this.min = Infinity;
    this.max = -Infinity;
    return r;
  }
}

export function buildArchive(spec: ArchiveSpec, start: MeterReadings): Archive {
  const climate = new ArchiveClimate(spec.seed);
  const out: Archive = { outdoor: [], sunnyWall: [], gas: [], hpEnergy: [], hpHeat: [], end: { ...start }, runs: [] };
  const readings = { ...start };
  const outdoorAcc = new HourAcc();
  const wallAcc = new HourAcc();
  const meterRow = (rows: HourRow[], hour: EpochMs, value: number, base: number) => {
    const state = meterValue(value);
    rows.push({ start: hour, state, sum: meterValue(state - meterValue(base)) });
  };

  let tin = 20.5;
  let mean24 = Number.NaN;
  let heating = false;
  let boilerOnly = false;
  let hp = { on: false, since: spec.from - HOUR };
  let boiler = { on: false, since: spec.from - HOUR };
  let deficitSince: EpochMs | null = null;
  const lastHour = Math.floor(spec.to / HOUR) * HOUR;
  let hour = spec.from;

  for (let date = toLocal(spec.from, spec.tz).date; ; date = addDays(date, 1)) {
    const dayStart = fromLocal(date, 0, spec.tz);
    if (dayStart >= spec.to) break;
    const dayEnd = fromLocal(addDays(date, 1), 0, spec.tz);
    const doy = dayOfYear(date);
    for (let t = Math.max(spec.from, dayStart); t < Math.min(dayEnd, spec.to); t += MIN) {
      const minute = Math.floor((t - dayStart) / MIN);
      const w = Math.min(1, Math.max(0, 1 - (spec.to - t) / BLEND_MS));
      const tout = (1 - w) * climate.at(t, doy, minute) + w * spec.near(t);
      mean24 = Number.isNaN(mean24) ? tout : mean24 + (tout - mean24) / (24 * 60);
      heating = heating ? mean24 < spec.heatingCutoffC + 1 : mean24 < spec.heatingCutoffC;
      boilerOnly = boilerOnly ? tout < spec.bivalencePointC + spec.bivalenceHysteresisC : tout < spec.bivalencePointC;

      const set = minute >= 6 * 60 && minute < 23 * 60 ? DAY_SETPOINT_C : NIGHT_SETPOINT_C;
      const gains = gainsKw(minute, doy);
      const holdKw = HOUSE_UA_KW_PER_K * (set - tout) - gains;
      const ran = (s: { on: boolean; since: EpochMs }) => (t - s.since) / MIN;
      const toggle = (s: { on: boolean; since: EpochMs }, on: boolean, who: ArchiveRun['source']) => {
        if (s.on === on) return s;
        if (!on) out.runs.push({ source: who, start: s.since, end: t });
        return { on, since: t };
      };

      // the heat pump keeps the band unless the boiler has the house to itself
      const hpWanted = heating && !boilerOnly && (hp.on ? !(tin > set + BAND_C && ran(hp) >= MIN_RUN_MIN) : tin < set - BAND_C && ran(hp) >= MIN_PAUSE_MIN);
      hp = toggle(hp, hpWanted, 'heatPump');
      const cap = heatPumpCapacityKw(tout);
      const hpKw = hp.on ? Math.min(cap, Math.max(0.4 * cap, holdKw + HOUSE_C_KWH_PER_K * (set + BAND_C - tin))) : 0;

      let boilerWanted = false;
      if (heating && boilerOnly) {
        boilerWanted = boiler.on ? !(tin > set + BAND_C && ran(boiler) >= MIN_RUN_MIN) : tin < set - BAND_C && ran(boiler) >= MIN_PAUSE_MIN;
      } else if (heating && spec.lag) {
        // the pump falls behind: the boiler helps until the house is nearly back at its setpoint
        const deficit = set - tin;
        deficitSince = deficit >= spec.lag.deficitC ? deficitSince ?? t : null;
        boilerWanted = boiler.on ? !(deficit <= 0.2 && ran(boiler) >= MIN_RUN_MIN) : deficitSince !== null && t - deficitSince >= spec.lag.forMin * MIN;
      }
      boiler = toggle(boiler, boilerWanted, 'boiler');
      const boilerKw = boiler.on ? Math.min(BOILER_MAX_KW, Math.max(BOILER_MIN_KW, holdKw + HOUSE_C_KWH_PER_K * (set + BAND_C - tin) * 2 - hpKw)) : 0;

      const h = 1 / 60;
      tin += ((hpKw + boilerKw + gains - HOUSE_UA_KW_PER_K * (tin - tout)) * h) / HOUSE_C_KWH_PER_K;
      // no cooling in this history: the windows open on warm days
      tin = Math.min(26, tin);
      readings.gasM3 += gasM3PerHour(boilerKw, stoveKw(minute)) * h;
      readings.hpKwh += (hp.on ? hpKw / heatPumpCop(tout) + 0.05 : heating ? 0.12 : 0.01) * h;
      readings.hpHeatKwh += hpKw * h;

      outdoorAcc.add(tout);
      wallAcc.add(tout + sunnyWallBonus(minute, doy));
      if ((t + MIN) % HOUR === 0 && t + MIN <= lastHour) {
        const o = outdoorAcc.row(hour);
        const s = wallAcc.row(hour);
        if (o) out.outdoor.push(o);
        if (s) out.sunnyWall.push(s);
        meterRow(out.gas, hour, readings.gasM3, start.gasM3);
        meterRow(out.hpEnergy, hour, readings.hpKwh, start.hpKwh);
        meterRow(out.hpHeat, hour, readings.hpHeatKwh, start.hpHeatKwh);
        hour += HOUR;
      }
    }
  }

  for (const [s, who] of [[hp, 'heatPump'], [boiler, 'boiler']] as const) if (s.on) out.runs.push({ source: who, start: s.since, end: spec.to });
  out.runs.sort((a, b) => a.start - b.start);
  out.end = readings;
  return out;
}
