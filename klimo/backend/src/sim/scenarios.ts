import { fromLocal } from '../engine/core/time';
import type { EntityId, EpochMs, LocalDate, Override, Season, SimFaultRequest, SimScenarioId } from '../shared/model';
import { SIM_TZ } from './sim.clock';
import type { RoomKey } from './devices';
import { ROOM_IDS } from './demo-house';
import type { ClimateParams } from './thermal-model';

/* =====================================================================================================
 * The five demo situations: a heating evening, a frosty morning, a sunny blackout, an in-between
 * afternoon and a summer day. Each fixes the moment the simulation starts, the weather
 * of the days before it, how the rooms look at that moment (the warm-up steers them there over the
 * last hour, so charts stay smooth and the numbers match the screens) and what happened shortly
 * before: a window opened, a sensor went quiet, a manual target was set.
 * ===================================================================================================== */

export interface RoomStart {
  t: number;
  rh: number;
}

export type ScenarioEvent =
  | { atMin: number; kind: 'window'; entityId: EntityId; open: boolean }
  | { atMin: number; kind: 'fault'; fault: SimFaultRequest };

export interface ScenarioOverride {
  /** Minutes relative to the start when it was set. */
  createdMin: number;
  /** Absolute end as local minutes of the start day; null = until cleared. */
  untilLocalMin: number | null;
  scope: Override['scope'];
  subject: Id;
  kind: Override['kind'];
  group: Override['group'];
  value: Override['value'];
  duration: Override['duration'];
}

type Id = string;

export interface Scenario {
  id: SimScenarioId;
  /** Local date and minute of day in the simulator's zone. */
  date: LocalDate;
  minute: number;
  /** The season the warm-up thermostat runs (the engine decides for itself afterwards). */
  season: Season;
  climate: Omit<ClimateParams, 'start' | 'seed'>;
  /** Where the rooms are a week before the start. */
  initial: Record<RoomKey, RoomStart>;
  /** Where they are at the start (rooms not listed run freely). */
  atStart: Partial<Record<RoomKey, RoomStart>>;
  events: ScenarioEvent[];
  overrides: ScenarioOverride[];
  /** A head whose last commands got lost: its writes are dropped from this many minutes before the
   *  start and the command ledger shows the given retry («повтор 2 з 3»). */
  stuckHead: { entityId: EntityId; fromMin: number; attempt: number } | null;
}

const rooms = (living: number, bedroom: number, kids: number, study: number, kitchen: number, bath: number, hall: number, rh = 48): Record<RoomKey, RoomStart> => ({
  living: { t: living, rh },
  bedroom: { t: bedroom, rh: rh + 3 },
  kids: { t: kids, rh: rh + 4 },
  study: { t: study, rh: rh - 4 },
  kitchen: { t: kitchen, rh },
  bath: { t: bath, rh: rh + 10 },
  hall: { t: hall, rh: rh - 3 },
});

export const SCENARIOS: Record<SimScenarioId, Scenario> = {
  heating_evening: {
    id: 'heating_evening',
    date: '2026-10-21',
    minute: 19 * 60 + 10,
    season: 'heating',
    climate: {
      outdoorNowC: 4.2,
      avg3dC: 6.8,
      outdoorRhPct: 80,
      pvAtStartW: null,
      loadAtStartW: 3400,
      gridOffline: null,
      socAtStartPct: 78,
      extraMoisture: { kids: 2.5 },
    },
    initial: rooms(20.1, 19.2, 21.9, 20.6, 21.1, 23.8, 19.2),
    atStart: {
      living: { t: 19.8, rh: 46 },
      bedroom: { t: 17.6, rh: 52 },
      kids: { t: 21.7, rh: 67 },
      study: { t: 21.0, rh: 41 },
      kitchen: { t: 20.9, rh: 49 },
      bath: { t: 23.7, rh: 58 },
      hall: { t: 19.1, rh: 44 },
    },
    events: [
      // the shelf sensor in the kitchen stopped reporting at 17:30 (an Aqara after a power cut)
      { atMin: -100, kind: 'fault', fault: { entityId: 'sensor.kitchen_shelf_temperature', kind: 'stale' } },
      { atMin: -12, kind: 'window', entityId: 'binary_sensor.bedroom_window', open: true },
    ],
    overrides: [
      {
        createdMin: -20,
        untilLocalMin: 20 * 60 + 30,
        scope: 'room',
        subject: ROOM_IDS.study,
        kind: 'room_target',
        group: 'target',
        value: { kind: 'room_target', mode: 'heat', heatC: 20.5, coolC: null },
        duration: 'until',
      },
    ],
    stuckHead: { entityId: 'climate.bathroom_towel_trv', fromMin: -9, attempt: 2 },
  },
  frost_morning: {
    id: 'frost_morning',
    date: '2026-01-15',
    minute: 7 * 60 + 20,
    season: 'heating',
    climate: {
      outdoorNowC: -14,
      avg3dC: -11,
      outdoorRhPct: 82,
      pvAtStartW: 150,
      loadAtStartW: 1800,
      gridOffline: null,
      socAtStartPct: 85,
      extraMoisture: {},
    },
    initial: rooms(20.0, 19.0, 21.8, 20.0, 21.0, 23.8, 19.0, 38),
    atStart: {},
    events: [],
    overrides: [],
    stuckHead: null,
  },
  blackout_sun: {
    id: 'blackout_sun',
    date: '2026-03-16',
    minute: 12 * 60 + 40,
    season: 'heating',
    climate: {
      outdoorNowC: 6,
      avg3dC: 5,
      outdoorRhPct: 70,
      pvAtStartW: 5200,
      loadAtStartW: 700,
      gridOffline: { from: 0, until: null },
      socAtStartPct: 97,
      extraMoisture: {},
    },
    initial: rooms(19.8, 18.6, 21.0, 18.5, 20.6, 23.4, 18.8, 42),
    atStart: {},
    events: [],
    overrides: [],
    stuckHead: null,
  },
  shoulder: {
    id: 'shoulder',
    date: '2026-04-16',
    minute: 16 * 60 + 20,
    season: 'neutral',
    climate: {
      outdoorNowC: 16,
      avg3dC: 16,
      outdoorRhPct: 62,
      pvAtStartW: 2600,
      loadAtStartW: 1000,
      gridOffline: null,
      socAtStartPct: 92,
      extraMoisture: {},
    },
    initial: rooms(22.5, 20.5, 21.5, 21.5, 21.5, 23.0, 20.5, 50),
    atStart: { living: { t: 25.6, rh: 50 }, bedroom: { t: 19.4, rh: 49 } },
    events: [],
    overrides: [
      {
        createdMin: -35,
        untilLocalMin: 17 * 60 + 30,
        scope: 'house',
        subject: 'house',
        kind: 'house_profile',
        group: 'house_profile',
        value: { kind: 'house_profile', profileId: 'home' },
        duration: 'slot',
      },
      {
        createdMin: -25,
        untilLocalMin: 17 * 60 + 30,
        scope: 'room',
        subject: ROOM_IDS.bedroom,
        kind: 'room_target',
        group: 'target',
        value: { kind: 'room_target', mode: 'heat', heatC: 20, coolC: null },
        duration: 'slot',
      },
    ],
    stuckHead: null,
  },
  summer: {
    id: 'summer',
    date: '2026-07-18',
    minute: 15 * 60 + 40,
    season: 'cooling',
    climate: {
      outdoorNowC: 31.5,
      avg3dC: 27.2,
      outdoorRhPct: 42,
      pvAtStartW: 6100,
      loadAtStartW: 1200,
      gridOffline: null,
      socAtStartPct: 100,
      extraMoisture: { kids: 2.5, bath: 3.5 },
    },
    initial: rooms(25.2, 24.6, 25.0, 26.0, 26.0, 25.4, 25.8, 52),
    atStart: {
      living: { t: 25.6, rh: 52 },
      bedroom: { t: 26.2, rh: 50 },
      kids: { t: 25.3, rh: 61 },
      study: { t: 26.1, rh: 47 },
      kitchen: { t: 26.4, rh: 50 },
      bath: { t: 25.2, rh: 63 },
      hall: { t: 25.8, rh: 49 },
    },
    events: [{ atMin: -4, kind: 'window', entityId: 'binary_sensor.bedroom_window', open: true }],
    overrides: [],
    stuckHead: null,
  },
};

export const SCENARIO_IDS = Object.keys(SCENARIOS) as SimScenarioId[];

/** The scenario's start instant (or the configured start), and its climate pinned to that instant. */
export function scenarioStart(s: Scenario, override: EpochMs | null = null): EpochMs {
  return override ?? fromLocal(s.date, s.minute, SIM_TZ);
}

export function climateFor(s: Scenario, start: EpochMs, seed: number): ClimateParams {
  const c = s.climate;
  // a blackout scenario has been off-grid since 10:00
  const gridOffline = c.gridOffline ? { from: start - (s.minute - 10 * 60) * 60_000, until: c.gridOffline.until } : null;
  return { ...c, start, seed, gridOffline };
}
