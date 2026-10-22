/**
 * Pure edits of one day plan. A day is a contiguous list of blocks covering 00:00–24:00 in
 * 30-minute steps; moving a boundary moves both neighbours, so blocks never gap or overlap,
 * and no block shrinks below 30 minutes (a neighbour cannot be swallowed by stepping).
 */
import type { DayPlan, Dow, Id, MinuteOfDay, ScheduleBlock } from '@api/model';

export const STEP = 30;
export const DAY = 1440;
export const DOWS: readonly Dow[] = [0, 1, 2, 3, 4, 5, 6];
export const WEEKDAYS: readonly Dow[] = [0, 1, 2, 3, 4];
export const WEEKEND: readonly Dow[] = [5, 6];

const snap = (m: number) => Math.round(m / STEP) * STEP;
const clone = (plan: DayPlan): DayPlan => plan.map((b) => ({ ...b }));

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

/** Days whose plan equals the plan of `dow` (including `dow` itself). */
export function identicalDays(days: readonly DayPlan[], dow: Dow): Dow[] {
  return DOWS.filter((d) => d === dow || samePlan(days[d], days[dow]));
}

/** The block that covers `minute` (the last one for 24:00). */
export function indexAt(plan: DayPlan, minute: MinuteOfDay): number {
  const i = plan.findIndex((b) => minute >= b.start && minute < b.end);
  return i >= 0 ? i : Math.max(0, plan.length - 1);
}

/** Allowed range for the start of block `i` (the first block is pinned at 00:00). */
export function startRange(plan: DayPlan, i: number): { min: number; max: number } {
  if (i <= 0) return { min: 0, max: 0 };
  return { min: plan[i - 1].start + STEP, max: plan[i].end - STEP };
}

/** Allowed range for the end of block `i` (the last block is pinned at 24:00). */
export function endRange(plan: DayPlan, i: number): { min: number; max: number } {
  if (i >= plan.length - 1) return { min: DAY, max: DAY };
  return { min: plan[i].start + STEP, max: plan[i + 1].end - STEP };
}

/** Move the start of block `i` (and the end of the previous block) to `minute`. */
export function setStart(plan: DayPlan, i: number, minute: number): DayPlan {
  const r = startRange(plan, i);
  const v = Math.min(r.max, Math.max(r.min, snap(minute)));
  if (i <= 0 || v === plan[i].start) return plan;
  const next = clone(plan);
  next[i].start = v;
  next[i - 1].end = v;
  return next;
}

/** Move the end of block `i` (and the start of the next block) to `minute`. */
export function setEnd(plan: DayPlan, i: number, minute: number): DayPlan {
  const r = endRange(plan, i);
  const v = Math.min(r.max, Math.max(r.min, snap(minute)));
  if (i >= plan.length - 1 || v === plan[i].end) return plan;
  const next = clone(plan);
  next[i].end = v;
  next[i + 1].start = v;
  return next;
}

export function setProfile(plan: DayPlan, i: number, profileId: Id): DayPlan {
  if (!plan[i] || plan[i].profileId === profileId) return plan;
  const next = clone(plan);
  next[i].profileId = profileId;
  return next;
}

/** A block of at least an hour splits at its middle (rounded to 30 min); both halves keep the profile. */
export function canSplit(plan: DayPlan, i: number): boolean {
  const b = plan[i];
  return Boolean(b) && b.end - b.start >= 2 * STEP;
}

export function split(plan: DayPlan, i: number): DayPlan {
  if (!canSplit(plan, i)) return plan;
  const b = plan[i];
  const mid = Math.min(b.end - STEP, Math.max(b.start + STEP, snap((b.start + b.end) / 2)));
  const next = clone(plan);
  next.splice(i, 1, { start: b.start, end: mid, profileId: b.profileId }, { start: mid, end: b.end, profileId: b.profileId });
  return next;
}

/** A deleted block is taken over by the previous block (the next one for the first block). */
export function remove(plan: DayPlan, i: number): DayPlan {
  if (plan.length <= 1 || !plan[i]) return plan;
  const next = clone(plan);
  const [gone] = next.splice(i, 1);
  if (i > 0) next[i - 1].end = gone.end;
  else next[0].start = gone.start;
  return mergeEqual(next);
}

/** A day with one block of the given profile (a new room schedule, a reset day). */
export function wholeDay(profileId: Id): DayPlan {
  return [{ start: 0, end: DAY, profileId }];
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

export type Block = ScheduleBlock;
