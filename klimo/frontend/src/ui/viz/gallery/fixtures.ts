import type { ConditionEval, Reason } from '@api/model';
import { PROFILE_COLORS } from '../../tokens/base';

/*
 * Demo data for the component gallery: one winter evening at 19:10 — the heat pump runs,
 * the boiler is the reserve, two pumps follow it with their run-on.
 */

export const HOUR = 3600_000;

/** Local midnight of today, so the gallery's now line sits at 19:10 on any day. */
export function galleryDay(): { dayStart: number; now: number } {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const dayStart = d.getTime();
  return { dayStart, now: dayStart + (19 + 10 / 60) * HOUR };
}

export const P = {
  home: PROFILE_COLORS[0],
  away: PROFILE_COLORS[1],
  eco: PROFILE_COLORS[2],
  night: PROFILE_COLORS[3],
  guests: PROFILE_COLORS[4],
  vacation: PROFILE_COLORS[5],
};

/** [startHour, endHour, profile] for a weekday. */
export const WEEKDAY: [number, number, keyof typeof P][] = [
  [0, 6.5, 'night'],
  [6.5, 8.5, 'home'],
  [8.5, 17.5, 'away'],
  [17.5, 23, 'home'],
  [23, 24, 'night'],
];
export const FRIDAY: [number, number, keyof typeof P][] = [
  [0, 6.5, 'night'],
  [6.5, 8.5, 'home'],
  [8.5, 17.5, 'away'],
  [17.5, 19, 'home'],
  [19, 23.5, 'guests'],
  [23.5, 24, 'night'],
];
export const WEEKEND: [number, number, keyof typeof P][] = [
  [0, 8, 'night'],
  [8, 23.5, 'home'],
  [23.5, 24, 'night'],
];

/** Heat-pump run spans today (hours). */
export const HP_SPANS: [number, number][] = [
  [5.87, 6.67],
  [7.08, 7.67],
  [12.17, 12.5],
  [16.92, 17.83],
];
export const HP_RUNNING_SINCE = 19.07;

/** Living room temperatures through the day: [hour, °C]. */
export const LIVING_TEMPS: [number, number | null][] = [
  [0, 19.6],
  [1, 19.4],
  [2, 19.3],
  [3, 19.2],
  [4, 19.1],
  [5, 19.0],
  [5.87, 18.9],
  [6.5, 19.9],
  [6.67, 20.1],
  [7, 20.1],
  [8, 20.0],
  [8.5, 19.9],
  [9, 19.7],
  [10, 19.4],
  [10.5, null],
  [11, 19.2],
  [12, 19.0],
  [13, 18.9],
  [14, 18.8],
  [15, 18.7],
  [16, 18.6],
  [16.92, 18.6],
  [17.5, 19.9],
  [17.83, 20.1],
  [18.5, 19.9],
  [19.07, 19.8],
  [19.16, 19.8],
];

export const SPARK = {
  heat: { values: [18.9, 18.8, 18.8, 18.7, 18.7, 18.6, 18.6, 18.6, 19.3, 20.0, 20.0, 19.9, 19.8], target: [18, 18, 18, 18, 18, 18, 18, 18, 18, 20, 20, 20, 20] },
  window: { values: [19.2, 19.1, 19.1, 19.0, 19.0, 19.1, 19.0, 19.0, 19.0, 18.9, 18.6, 18.0, 17.6], target: [19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19] },
  gap: { values: [20.8, 20.9, 21.0, null, null, null, 20.9, 20.9, 21.0, 21.0, 20.9, 20.9, 20.9], target: [21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21] },
  off: { values: [18.4, 18.3, 18.3, 18.2, 18.2, 18.1, 18.1, 18.0, 18.0, 18.0, 17.9, 17.9, 17.9], target: null },
  cool: { values: [25.9, 26.0, 26.0, 25.9, 25.8, 25.7, 25.6, 25.5, 25.4, 25.4, 25.3, 25.3, 25.3], target: [24.5, 24.5, 24.5, 24.5, 24.5, 24.5, 24.5, 24.5, 24.5, 24.5, 24.5, 24.5, 24.5] },
};

/** A reason that carries its own words: the gallery renders `params.text` instead of a code. */
export function said(text: string): Reason {
  return { code: 'source.detail.running', params: { text } };
}

export const TREE: ConditionEval = {
  id: 'root',
  met: false,
  status: 'ok',
  children: [
    { id: 'grid', met: true, status: 'ok', value: 'off' },
    { id: 'pv', met: false, status: 'ok', value: 0.3, pendingSec: 0 },
    {
      id: 'any',
      met: true,
      status: 'ok',
      children: [
        { id: 'battery', met: true, status: 'ok', value: 97 },
        { id: 'forecast', met: false, status: 'unknown', value: null },
      ],
    },
    { id: 'delay', met: false, status: 'ok', pendingSec: 42 },
  ],
};
