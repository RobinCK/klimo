/**
 * A day as its switch points: «06:30 → Дома», «08:30 → Поза домом», … Each point holds until the
 * next one, and the last one holds over midnight into the next morning, so a night from 23:00 to
 * 06:30 is one point, not two blocks. The plan the server stores (blocks covering 00:00–24:00)
 * and the points convert both ways; equal neighbours merge, so a point that repeats the profile
 * before it disappears.
 *
 * Days with the same plan form a day type («Будні», «Вихідні»): an edit of a type writes the plan
 * of all its days. A day can be taken out of its type to be edited alone.
 */
import type { DayPlan, Dow, Id } from '@api/model';
import { DAY, DOWS, STEP, mergeEqual, samePlan } from './blocks';

export interface SwitchPoint {
  minute: number;
  profileId: Id;
}

/** The switch points of a day plan, in time order. */
export function pointsOf(plan: DayPlan): SwitchPoint[] {
  const blocks = mergeEqual(plan);
  if (!blocks.length) return [];
  if (blocks.length === 1) return [{ minute: 0, profileId: blocks[0].profileId }];
  const wraps = blocks[0].profileId === blocks[blocks.length - 1].profileId;
  return blocks.filter((_, i) => i > 0 || !wraps).map((b) => ({ minute: b.start, profileId: b.profileId }));
}

/** The day plan of switch points: before the first point the last one still holds. */
export function planOf(points: readonly SwitchPoint[]): DayPlan {
  const sorted = [...points].sort((a, b) => a.minute - b.minute);
  if (!sorted.length) return [];
  const out: DayPlan = [];
  const last = sorted[sorted.length - 1];
  if (sorted[0].minute > 0) out.push({ start: 0, end: sorted[0].minute, profileId: last.profileId });
  sorted.forEach((p, i) => {
    const end = i < sorted.length - 1 ? sorted[i + 1].minute : DAY;
    if (end > p.minute) out.push({ start: p.minute, end, profileId: p.profileId });
  });
  return mergeEqual(out);
}

/** Where point `i` holds until (the next point; for the last one, the first point of the next day). */
export function untilOf(points: readonly SwitchPoint[], i: number): { minute: number; nextDay: boolean } {
  if (i < points.length - 1) return { minute: points[i + 1].minute, nextDay: false };
  return { minute: points[0].minute, nextDay: points.length > 1 || points[0].minute > 0 };
}

/** Minutes point `i` holds for. */
export function lengthOf(points: readonly SwitchPoint[], i: number): number {
  const until = untilOf(points, i);
  const len = until.minute - points[i].minute;
  return len > 0 ? len : len + DAY;
}

/** The point in force at `minute` (the last one before it, or the last of the day before). */
export function pointAt(points: readonly SwitchPoint[], minute: number): number {
  let at = points.length - 1;
  points.forEach((p, i) => {
    if (p.minute <= minute) at = i;
  });
  return at;
}

/** Where point `i` may move: a step after the previous one and a step before the next one. */
export function pointRange(points: readonly SwitchPoint[], i: number): { min: number; max: number } {
  const min = i > 0 ? points[i - 1].minute + STEP : 0;
  const max = i < points.length - 1 ? points[i + 1].minute - STEP : DAY - STEP;
  return { min, max };
}

const snap = (m: number) => Math.round(m / STEP) * STEP;

export function movePoint(points: readonly SwitchPoint[], i: number, minute: number): SwitchPoint[] {
  const r = pointRange(points, i);
  const v = Math.min(r.max, Math.max(r.min, snap(minute)));
  return points.map((p, k) => (k === i ? { ...p, minute: v } : { ...p }));
}

export function setPointProfile(points: readonly SwitchPoint[], i: number, profileId: Id): SwitchPoint[] {
  return points.map((p, k) => (k === i ? { ...p, profileId } : { ...p }));
}

export function removePoint(points: readonly SwitchPoint[], i: number): SwitchPoint[] {
  if (points.length <= 1) return points.map((p) => ({ ...p }));
  return points.filter((_, k) => k !== i).map((p) => ({ ...p }));
}

/**
 * A new point in the middle of the longest stretch, in the first profile (in the list's order)
 * that differs from the stretch it splits and from the one after it, so it does not merge away.
 */
export function addPoint(points: readonly SwitchPoint[], order: readonly Id[]): { points: SwitchPoint[]; minute: number } | null {
  if (!points.length || !order.length) return null;
  let best = 0;
  points.forEach((_, i) => {
    if (lengthOf(points, i) > lengthOf(points, best)) best = i;
  });
  const len = lengthOf(points, best);
  if (len < 2 * STEP) return null;
  const minute = (points[best].minute + Math.round(len / 2 / 30) * 30) % DAY;
  if (points.some((p) => p.minute === minute)) return null;
  const around = [points[best].profileId, points[(best + 1) % points.length].profileId];
  const profileId = order.find((id) => !around.includes(id)) ?? order.find((id) => id !== points[best].profileId);
  if (!profileId) return null;
  const next = [...points.map((p) => ({ ...p })), { minute, profileId }].sort((a, b) => a.minute - b.minute);
  return { points: next, minute };
}

export interface DayType {
  /** The days of the type, Monday first. */
  days: Dow[];
  plan: DayPlan;
}

/** Days grouped by equal plans, in the order of their first day; `detached` days stand alone. */
export function dayTypes(days: readonly DayPlan[], detached: readonly Dow[]): DayType[] {
  const types: DayType[] = [];
  for (const d of DOWS) {
    const plan = days[d] ?? [];
    const alone = detached.includes(d);
    const same = alone ? undefined : types.find((x) => !detached.includes(x.days[0]) && samePlan(x.plan, plan));
    if (same) same.days.push(d);
    else types.push({ days: [d], plan });
  }
  return types;
}

/** The two points that bound stretch `i`: its own and the next one (the first, for the last stretch). */
function stretchEnds(points: readonly SwitchPoint[], i: number): [number, number] | null {
  if (points.length < 2 || !points[i]) return null;
  const j = (i + 1) % points.length;
  // a day that starts with a change at 00:00 does not run on into the next morning
  if (j === 0 && points[0].minute === 0) return null;
  return [i, j];
}

/** How far stretch `i` may move as a whole, in minutes (both bounds 0 when it cannot). */
export function shiftRange(points: readonly SwitchPoint[], i: number): { min: number; max: number } {
  const ends = stretchEnds(points, i);
  if (!ends) return { min: 0, max: 0 };
  const n = points.length;
  const moving = (k: number) => k === ends[0] || k === ends[1];
  let min = -Infinity;
  let max = Infinity;
  // each moving point keeps a step from its neighbours that stay; the other moving point goes along
  for (const k of ends) {
    const lo = k > 0 ? (moving(k - 1) ? -Infinity : points[k - 1].minute + STEP) : 0;
    const hi = k < n - 1 ? (moving(k + 1) ? Infinity : points[k + 1].minute - STEP) : DAY - STEP;
    min = Math.max(min, lo - points[k].minute);
    max = Math.min(max, hi - points[k].minute);
  }
  return { min: Math.min(0, min), max: Math.max(0, max) };
}

/** Stretch `i` moved as a whole by `delta` minutes: its start and its end move together. */
export function shiftStretch(points: readonly SwitchPoint[], i: number, delta: number): SwitchPoint[] {
  const ends = stretchEnds(points, i);
  const r = shiftRange(points, i);
  const d = Math.min(r.max, Math.max(r.min, Math.round(delta / STEP) * STEP));
  if (!ends || !d) return points.map((p) => ({ ...p }));
  return points.map((p, k) => (k === ends[0] || k === ends[1] ? { ...p, minute: p.minute + d } : { ...p }));
}

/** [start, end) of the day painted in a profile: the stretches under it shrink or go, equal neighbours merge. */
export function paintStretch(points: readonly SwitchPoint[], start: number, end: number, profileId: Id): SwitchPoint[] {
  const a = Math.max(0, Math.round(Math.min(start, end) / STEP) * STEP);
  const b = Math.min(DAY, Math.round(Math.max(start, end) / STEP) * STEP);
  const plan = planOf(points);
  if (b - a < STEP || !plan.length) return points.map((p) => ({ ...p }));
  const out: DayPlan = [];
  for (const x of plan) {
    if (x.end <= a || x.start >= b) out.push({ ...x });
    else {
      if (x.start < a) out.push({ start: x.start, end: a, profileId: x.profileId });
      if (x.end > b) out.push({ start: b, end: x.end, profileId: x.profileId });
    }
  }
  out.push({ start: a, end: b, profileId });
  return pointsOf(out.sort((p, q) => p.start - q.start));
}
