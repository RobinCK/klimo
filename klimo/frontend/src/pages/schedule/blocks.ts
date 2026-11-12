/**
 * Day plans as the server stores them: a contiguous list of blocks covering 00:00–24:00 in
 * 15-minute steps, equal neighbours merged.
 */
import type { DayPlan, Dow, Id } from '@api/model';

export const STEP = 15;
export const DAY = 1440;
export const DOWS: readonly Dow[] = [0, 1, 2, 3, 4, 5, 6];

/** Adjacent blocks with the same profile become one (the server stores days that way). */
export function mergeEqual(plan: DayPlan): DayPlan {
  const out: DayPlan = [];
  for (const b of plan) {
    const last = out[out.length - 1];
    if (last && last.profileId === b.profileId && last.end === b.start) last.end = b.end;
    else out.push({ ...b });
  }
  return out;
}

export function samePlan(a: DayPlan | undefined, b: DayPlan | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((x, i) => x.start === b[i].start && x.end === b[i].end && x.profileId === b[i].profileId);
}

/** Intervals of one profile in a day, with a block running over midnight joined («23:00–06:30»). */
export function profileIntervals(plan: DayPlan, profileId: Id): { start: number; end: number }[] {
  const own = mergeEqual(plan)
    .filter((b) => b.profileId === profileId)
    .map((b) => ({ start: b.start, end: b.end }));
  if (own.length > 1 && own[0].start === 0 && own[own.length - 1].end === DAY) {
    const first = own.shift() as { start: number; end: number };
    own[own.length - 1] = { start: own[own.length - 1].start, end: first.end + DAY };
  }
  return own;
}
