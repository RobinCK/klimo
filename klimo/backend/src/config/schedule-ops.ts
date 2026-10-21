import { ApiException } from '../common/http';
import type { ApiErrorIssue, DayPlan, Dow, Id, MinuteOfDay, Schedule, ScheduleBlock, ScheduleException } from '../shared/model';

/* =====================================================================================================
 * Weekly plan editing on a 30-minute grid. A day is a contiguous list of blocks covering 00:00–24:00;
 * blocks are at least 30 minutes; neighbours naming the same profile are merged on save so the plan
 * always has one canonical shape.
 * ===================================================================================================== */

export const GRID_MIN = 30;
export const DAY_MIN = 1440;

const copy = (plan: DayPlan): DayPlan => plan.map((b) => ({ start: b.start, end: b.end, profileId: b.profileId }));

/** Sorts and merges equal neighbours. */
export function normalizeDay(plan: DayPlan): DayPlan {
  const sorted = copy(plan).sort((a, b) => a.start - b.start);
  const out: DayPlan = [];
  for (const b of sorted) {
    const last = out[out.length - 1];
    if (last && last.profileId === b.profileId && last.end === b.start) last.end = b.end;
    else out.push(b);
  }
  return out;
}

/** Problems of one day plan (paths relative to the day: `0.end`). */
export function dayIssues(plan: unknown, profileExists: (id: Id) => boolean): ApiErrorIssue[] {
  const issues: ApiErrorIssue[] = [];
  if (!Array.isArray(plan) || plan.length === 0) return [{ path: '', code: 'required' }];
  let expect = 0;
  plan.forEach((raw: unknown, i) => {
    const b = raw as Partial<ScheduleBlock> | null;
    if (!b || typeof b !== 'object' || typeof b.start !== 'number' || typeof b.end !== 'number' || typeof b.profileId !== 'string') {
      issues.push({ path: `${i}`, code: 'type' });
      return;
    }
    if (b.start !== expect) issues.push({ path: `${i}.start`, code: 'contiguous', params: { expected: expect } });
    if (b.start % GRID_MIN || b.end % GRID_MIN) issues.push({ path: `${i}`, code: 'step', params: { step: GRID_MIN } });
    if (b.start < 0 || b.end > DAY_MIN) issues.push({ path: `${i}`, code: 'range', params: { min: 0, max: DAY_MIN } });
    if (b.end - b.start < GRID_MIN) issues.push({ path: `${i}.end`, code: 'min_length', params: { min: GRID_MIN } });
    if (!profileExists(b.profileId)) issues.push({ path: `${i}.profileId`, code: 'not_found' });
    expect = b.end;
  });
  if (expect !== DAY_MIN) issues.push({ path: `${plan.length - 1}.end`, code: 'contiguous', params: { expected: DAY_MIN } });
  return issues;
}

export function weekIssues(days: unknown, profileExists: (id: Id) => boolean): ApiErrorIssue[] {
  if (!Array.isArray(days) || days.length !== 7) return [{ path: 'days', code: 'length', params: { min: 7, max: 7 } }];
  return days.flatMap((d, dow) => dayIssues(d, profileExists).map((x) => ({ ...x, path: x.path ? `days.${dow}.${x.path}` : `days.${dow}` })));
}

function assertDay(plan: DayPlan, profileExists: (id: Id) => boolean): void {
  const issues = dayIssues(plan, profileExists);
  if (issues.length) throw new ApiException(400, 'validation', 'Invalid day plan', issues.map((x) => ({ ...x, path: x.path ? `blocks.${x.path}` : 'blocks' })));
}

function withDays(s: Schedule, days: DayPlan[]): Schedule {
  return { ...s, days };
}

/** «Зберегти день»: validates, merges equal neighbours, and writes the same plan to `applyTo` days. */
export function setDay(s: Schedule, dow: Dow, blocks: DayPlan, applyTo: Dow[] = [], profileExists: (id: Id) => boolean = () => true): Schedule {
  assertDay(blocks, profileExists);
  const plan = normalizeDay(blocks);
  const days = s.days.map((d, i) => (i === dow || applyTo.includes(i as Dow) ? copy(plan) : copy(d)));
  return withDays(s, days);
}

/** Splits block `index` at `at` (default: its midpoint on the grid); the block must be ≥ 60 min. */
export function splitBlock(plan: DayPlan, index: number, at?: MinuteOfDay): DayPlan {
  const b = plan[index];
  if (!b) throw new ApiException(404, 'not_found', `Block ${index} not found`);
  if (b.end - b.start < 2 * GRID_MIN) {
    throw new ApiException(400, 'validation', 'Block too short to split', [{ path: 'index', code: 'min_length', params: { min: 2 * GRID_MIN } }]);
  }
  const mid = at ?? b.start + Math.round((b.end - b.start) / 2 / GRID_MIN) * GRID_MIN;
  if (mid % GRID_MIN || mid - b.start < GRID_MIN || b.end - mid < GRID_MIN) {
    throw new ApiException(400, 'validation', 'Split point must leave two blocks of at least 30 minutes', [{ path: 'at', code: 'range', params: { min: b.start + GRID_MIN, max: b.end - GRID_MIN } }]);
  }
  const out = copy(plan);
  out.splice(index, 1, { start: b.start, end: mid, profileId: b.profileId }, { start: mid, end: b.end, profileId: b.profileId });
  return out;
}

/** Removes block `index`: the previous block grows over it (the first block is absorbed by the next). */
export function removeBlock(plan: DayPlan, index: number): DayPlan {
  const b = plan[index];
  if (!b) throw new ApiException(404, 'not_found', `Block ${index} not found`);
  if (plan.length === 1) throw new ApiException(400, 'validation', 'A day needs at least one block', [{ path: 'index', code: 'min_items', params: { min: 1 } }]);
  const out = copy(plan);
  if (index > 0) out[index - 1].end = b.end;
  else out[1].start = b.start;
  out.splice(index, 1);
  return normalizeDay(out);
}

/** «Копіювати день»: the plan of `from` to every day in `to`. */
export function copyDay(s: Schedule, from: Dow, to: Dow[]): Schedule {
  const src = s.days[from];
  return withDays(s, s.days.map((d, i) => (to.includes(i as Dow) && i !== from ? copy(src) : copy(d))));
}

/** Days whose plan equals `dow`'s — pre-checks the «Повторювати» toggles. */
export function daysWithSamePlan(s: Schedule, dow: Dow): Dow[] {
  const key = JSON.stringify(normalizeDay(s.days[dow] ?? []));
  return s.days.map((d, i) => (JSON.stringify(normalizeDay(d)) === key ? (i as Dow) : -1)).filter((i): i is Dow => i >= 0);
}

/** The plan in force on a date: the exception's own plan, «як <день>», or the weekday plan. */
export function planForDate(s: Schedule, dow: Dow, exception: ScheduleException | undefined): DayPlan {
  if (!exception) return s.days[dow] ?? [];
  if (Array.isArray(exception.plan)) return exception.plan;
  return s.days[exception.plan.likeDow] ?? [];
}

/** Replaces every block of profile `from` by `to` (profile deleted with «Замінити на…»). */
export function replaceProfileInPlan(plan: DayPlan, from: Id, to: Id): DayPlan {
  return normalizeDay(plan.map((b) => (b.profileId === from ? { ...b, profileId: to } : b)));
}

export function planUsesProfile(plan: DayPlan, profileId: Id): boolean {
  return plan.some((b) => b.profileId === profileId);
}
