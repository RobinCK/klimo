import type { DurationUntilFn, EngineConfig, EpochMs, Id } from '../../shared/model';
import { DAY_MS, HOUR_MS, houseSchedule, scheduleAt, scheduleChanges } from './schedule';
import { nextBaseChange, scheduledBaseAt } from './targets';
import { addDays, fromLocal, toLocal } from './time';

/* =====================================================================================================
 * When a time-boxed change ends. «До кінця слоту» follows the room's base profile (its schedule, or the
 * house schedule, or a time-limited house override) — never the room's own override, so a manual change
 * lives until the base profile actually changes. «До ранку» is the first such change after 03:00.
 * ===================================================================================================== */

const MIN_MS = 60_000;
const SLOT_HORIZON_MS = 7 * DAY_MS;
export const UNTIL_MIN_MS = 5 * MIN_MS;
export const UNTIL_MAX_MS = 60 * DAY_MS;

/** An explicit «до …» time is accepted between now + 5 min and now + 60 days. */
export function untilInRange(now: EpochMs, until: EpochMs): boolean {
  return until >= now + UNTIL_MIN_MS && until <= now + UNTIL_MAX_MS;
}

/** Next change of the house schedule's profile (house-scope durations ignore room schedules). */
function nextHouseChange(cfg: EngineConfig, from: EpochMs, to: EpochMs, tz: string): EpochMs | null {
  const hs = houseSchedule(cfg);
  if (!hs || !hs.enabled) return null;
  const current = scheduleAt(cfg, hs, from, tz)?.profileId ?? null;
  for (const c of scheduleChanges(cfg, hs, from, to, tz)) if (c.profileId !== current) return c.at;
  return null;
}

function nextChange(cfg: EngineConfig, roomId: Id | null, from: EpochMs, to: EpochMs, tz: string): EpochMs | null {
  return roomId === null ? nextHouseChange(cfg, from, to, tz) : (nextBaseChange(cfg, roomId, from, to, tz)?.at ?? null);
}

/** The next local 03:00 strictly after `now`. */
function nextThreeAm(now: EpochMs, tz: string): EpochMs {
  const today = toLocal(now, tz).date;
  const t = fromLocal(today, 180, tz);
  return t > now ? t : fromLocal(addDays(today, 1), 180, tz);
}

function morning(cfg: EngineConfig, roomId: Id | null, now: EpochMs, tz: string): EpochMs {
  const m3 = nextThreeAm(now, tz);
  const date = toLocal(m3, tz).date;
  const noon = fromLocal(date, 720, tz);
  const change = nextChange(cfg, roomId, m3, noon, tz);
  return change !== null && change < noon ? change : fromLocal(date, 420, tz);
}

export const durationUntil: DurationUntilFn = (cfg, roomId, duration, now, tz, explicitUntil) => {
  switch (duration) {
    case 'slot':
      return nextChange(cfg, roomId, now, now + SLOT_HORIZON_MS, tz);
    case '1h':
      return now + HOUR_MS;
    case '2h':
      return now + 2 * HOUR_MS;
    case '3h':
      return now + 3 * HOUR_MS;
    case '4h':
      return now + 4 * HOUR_MS;
    case 'morning':
      return morning(cfg, roomId, now, tz);
    case 'until':
      if (explicitUntil === undefined) throw new RangeError("duration 'until' needs an explicit time");
      // request schemas reject out-of-range values; the core keeps the bounds as a last line of defence
      return Math.min(Math.max(explicitUntil, now + UNTIL_MIN_MS), now + UNTIL_MAX_MS);
    case 'minutes':
      return explicitUntil ?? null;
    case 'none':
    case 'forever':
    case 'manual':
      return null;
  }
};

/** Profile governing the room (or the house) at `ts`, as durations see it. */
export function baseProfileAt(cfg: EngineConfig, roomId: Id | null, ts: EpochMs, tz: string): Id {
  return scheduledBaseAt(cfg, roomId, ts, tz).profileId;
}
