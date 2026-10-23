import { DEFAULT_GAS_KWH_PER_M3 } from '../shared/defaults';
import type { EntityId, EpochMs, HaStateObj, Id, RunSpan, SourceConfig, SourceMode } from '../shared/model';
import type { World } from './thermal-model';

/* =====================================================================================================
 * The demo house's meters: a pulse counter on the gas meter (the boiler and the kitchen stove share
 * it), the heat pump's own electricity and heat counters and the energy counter of the floor pump's
 * plug. They grow with what the simulated plant
 * does — the flame and how hard the boiler fires, the compressor's draw and output — and report like
 * their integrations do: cumulative readings with a state class HA compiles into long-term statistics.
 * ===================================================================================================== */

const MIN = 60_000;
const HOUR = 60 * MIN;

export const GAS_METER = 'sensor.gas_meter';
export const HP_ENERGY_METER = 'sensor.heat_pump_energy';
export const HP_HEAT_METER = 'sensor.heat_pump_heat_energy';
/** The energy counter of the plug the floor pump runs on. */
export const FLOOR_PUMP_METER = 'sensor.floor_heating_pump_energy';
export const FLOOR_PUMP_KW = 0.045;
/** What the plug draws with the pump off (its own relay and radio). */
export const PLUG_STANDBY_KW = 0.0006;

/** The gas counter as other installs report it; the template copy has no state class, so no statistics. */
export const GAS_METER_MIRRORS: readonly { entityId: EntityId; perM3: number; statistics: boolean }[] = [
  { entityId: 'sensor.gas_meter_ft3', perM3: 35.3147, statistics: true },
  { entityId: 'sensor.gas_meter_energy', perM3: DEFAULT_GAS_KWH_PER_M3, statistics: true },
  { entityId: 'sensor.gas_meter_template', perM3: 1, statistics: false },
];

/** A condensing boiler turns this share of the gas energy into heat. */
export const BOILER_EFFICIENCY = 0.92;
export const BOILER_MIN_KW = 3.5;
export const BOILER_MAX_KW = 24;
export const KWH_PER_M3 = DEFAULT_GAS_KWH_PER_M3;

export interface MeterReadings {
  gasM3: number;
  hpKwh: number;
  hpHeatKwh: number;
  floorPumpKwh: number;
}

const METER_READINGS: Readonly<Record<EntityId, keyof MeterReadings>> = {
  [GAS_METER]: 'gasM3',
  [HP_ENERGY_METER]: 'hpKwh',
  [HP_HEAT_METER]: 'hpHeatKwh',
  [FLOOR_PUMP_METER]: 'floorPumpKwh',
};

/** Where the meters stood when the long-term history begins. */
export const READINGS_AT_ARCHIVE_START: MeterReadings = { gasM3: 4213.27, hpKwh: 6120.42, hpHeatKwh: 17830.95, floorPumpKwh: 212.64 };

/** Readings go to HA rounded to what the counters resolve (10 l of gas, 10 Wh). */
export const meterValue = (x: number): number => Math.round(x * 100) / 100;

/** The gas stove on the same meter: breakfast, lunch and dinner, by local minute of the day. */
export function stoveKw(minute: number): number {
  if (minute >= 7 * 60 + 30 && minute < 7 * 60 + 45) return 2.2;
  if (minute >= 13 * 60 && minute < 13 * 60 + 25) return 1.6;
  if (minute >= 18 * 60 + 20 && minute < 19 * 60 + 5) return 2.0;
  return 0;
}

/** m³ of gas per hour for the boiler's heat output and the stove. */
export function gasM3PerHour(boilerKw: number, stove: number): number {
  return (boilerKw / BOILER_EFFICIENCY + stove) / KWH_PER_M3;
}

/** The boiler's heat output: it modulates with the heat the water carries away (supply above return). */
export function boilerKw(w: World): number {
  if (!w.boiler.flame) return 0;
  return Math.min(BOILER_MAX_KW, Math.max(BOILER_MIN_KW, 1.5 + 2.1 * Math.max(0, w.supplyC - w.returnC)));
}

/** The live meters, integrated from the world as it runs. */
export class SimMeters {
  readings: MeterReadings = { ...READINGS_AT_ARCHIVE_START };
  private at: EpochMs = 0;

  reset(readings: MeterReadings, at: EpochMs): void {
    this.readings = { ...readings };
    this.at = at;
  }

  /** A meter replaced or reset: its counter goes on from `value`. False when `entityId` is no meter. */
  restart(entityId: EntityId, value: number): boolean {
    const key = METER_READINGS[entityId];
    if (!key) return false;
    this.readings[key] = value;
    return true;
  }

  /** Adds what the plant used since the last call, at the rates it runs with now. */
  advance(w: World, at: EpochMs, localMinute: number, floorPumpOn: boolean): void {
    const h = (at - this.at) / HOUR;
    if (h <= 0) return;
    this.at = at;
    // a long jump of the clock is integrated by the world in coarse steps; the meters follow its state
    this.readings.gasM3 += gasM3PerHour(boilerKw(w), stoveKw(localMinute)) * h;
    this.readings.hpKwh += w.hp.electricKw * h;
    if (w.hp.mode === 'heat') this.readings.hpHeatKwh += w.hp.thermalKw * h;
    this.readings.floorPumpKwh += (floorPumpOn ? FLOOR_PUMP_KW : PLUG_STANDBY_KW) * h;
  }
}

const CLIMATE_MODES: Record<string, SourceMode> = { heat: 'heat', cool: 'cool', dry: 'dry', fan_only: 'fan' };

/** Sources running now, read from their devices as Klimo commands them (a relay on, a climate in a mode). */
export function runningSources(sources: readonly SourceConfig[], state: (id: EntityId) => HaStateObj | undefined): Map<Id, SourceMode> {
  const out = new Map<Id, SourceMode>();
  for (const s of sources) {
    const a = s.adapter;
    if (a.type === 'relay' && a.command) {
      const on = state(a.command)?.state === 'on';
      if (on !== a.invert) out.set(s.id, 'heat');
    } else if (a.type === 'climate' && a.climate) {
      const mode = CLIMATE_MODES[state(a.climate)?.state ?? ''];
      if (mode) out.set(s.id, mode);
    }
  }
  return out;
}

export type ArchivedSpan = Omit<RunSpan, 'id'>;

/** Marks the runs of the simulated history: the next scenario replaces them, the engine's own stay. */
export const SIMULATED_HISTORY = 'simulated_history';

/** Source runs as Klimo would have logged them, from the on/off edges of what was running. */
export class RunTracker {
  private readonly open = new Map<Id, { start: EpochMs; mode: SourceMode }>();
  readonly spans: ArchivedSpan[] = [];

  observe(at: EpochMs, running: ReadonlyMap<Id, SourceMode>): void {
    for (const [id, o] of this.open) {
      if (running.get(id) === o.mode) continue;
      this.spans.push(span(id, o.mode, o.start, at));
      this.open.delete(id);
    }
    for (const [id, mode] of running) if (!this.open.has(id)) this.open.set(id, { start: at, mode });
  }

  /** Ends the runs still open at `at` (where the next part of the history takes over). */
  close(at: EpochMs): ArchivedSpan[] {
    for (const [id, o] of this.open) this.spans.push(span(id, o.mode, o.start, at));
    this.open.clear();
    return this.spans;
  }
}

function span(subjectId: Id, mode: SourceMode, startTs: EpochMs, endTs: EpochMs): ArchivedSpan {
  return { subject: 'source', subjectId, kind: 'run', mode, startTs, endTs, meta: { reason: SIMULATED_HISTORY } };
}
