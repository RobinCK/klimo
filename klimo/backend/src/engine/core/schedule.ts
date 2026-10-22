import type { DayPlan, EngineConfig, EpochMs, Id, LocalDate, MinuteOfDay, Schedule } from '../../shared/model';
import { addDays, dowOfDate, fromLocal, toLocal } from './time';

/* =====================================================================================================
 * Weekly schedules as a timeline of real instants. Blocks are local minutes of a date; each boundary is
 * turned into an instant in the HA time zone, so a boundary inside the repeated autumn hour fires once
 * and a block that falls into the spring-forward gap simply has no length. Neighbours naming the same
 * profile are merged across midnight, so «Ніч» 23:00–24:00 + 00:00–06:30 is one block ending at 06:30.
 * ===================================================================================================== */

export interface ScheduleSegment {
  start: EpochMs;
  end: EpochMs;
  profileId: Id;
}

export interface ScheduleOpinion {
  profileId: Id;
  start: EpochMs;
  /** End of the merged block; null when the profile does not change within the look-ahead. */
  until: EpochMs | null;
}

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

// Wall-clock → instant conversions are deterministic per zone; caching them keeps a tick cheap when every
// room looks a week ahead.
const instantCache = new Map<string, EpochMs>();

function instant(date: LocalDate, minute: MinuteOfDay, tz: string): EpochMs {
  const key = `${tz}|${date}|${minute}`;
  let v = instantCache.get(key);
  if (v === undefined) {
    if (instantCache.size > 20_000) instantCache.clear();
    v = fromLocal(date, minute, tz);
    instantCache.set(key, v);
  }
  return v;
}

export function houseSchedule(cfg: Pick<EngineConfig, 'schedules'>): Schedule | null {
  return cfg.schedules.find((s) => s.scope === 'house') ?? null;
}

/** The room's own schedule when it exists and is switched on. */
export function roomSchedule(cfg: Pick<EngineConfig, 'schedules'>, roomId: Id): Schedule | null {
  const s = cfg.schedules.find((x) => x.scope === 'room' && x.roomId === roomId);
  return s && s.enabled ? s : null;
}

/** The plan in force on a local date: a dated exception (own plan or «як неділя»), else the weekday plan. */
export function planForDate(cfg: Pick<EngineConfig, 'scheduleExceptions'>, schedule: Schedule, date: LocalDate): DayPlan {
  const ex = cfg.scheduleExceptions.find((e) => e.scheduleId === schedule.id && e.date === date);
  if (ex) return Array.isArray(ex.plan) ? ex.plan : (schedule.days[ex.plan.likeDow] ?? []);
  return schedule.days[dowOfDate(date)] ?? [];
}

function daySegments(cfg: Pick<EngineConfig, 'scheduleExceptions'>, schedule: Schedule, date: LocalDate, tz: string): ScheduleSegment[] {
  const out: ScheduleSegment[] = [];
  const plan = [...planForDate(cfg, schedule, date)].sort((a, b) => a.start - b.start);
  for (const b of plan) {
    if (!(b.end > b.start)) continue;
    const start = instant(date, b.start, tz);
    const end = instant(date, Math.min(1440, b.end), tz);
    if (end > start) out.push({ start, end, profileId: b.profileId });
  }
  return out;
}

/**
 * Merged segments of a schedule from the local day before `from` up to (at least) `to`. The last segment
 * is cut at the end of the last day built, so its end is not a real change; `open` tells which.
 */
function buildSegments(
  cfg: Pick<EngineConfig, 'scheduleExceptions'>,
  schedule: Schedule,
  from: EpochMs,
  to: EpochMs,
  tz: string,
): { segments: ScheduleSegment[]; builtUntil: EpochMs } {
  const segments: ScheduleSegment[] = [];
  let date = addDays(toLocal(from, tz).date, -1);
  let builtUntil = instant(date, 0, tz);
  // a week plus a margin always covers [from, to] for the look-aheads the engine uses
  for (let guard = 0; guard < 400 && builtUntil <= to; guard++) {
    for (const s of daySegments(cfg, schedule, date, tz)) {
      const last = segments[segments.length - 1];
      if (last && last.profileId === s.profileId && last.end === s.start) last.end = s.end;
      else segments.push({ ...s });
    }
    date = addDays(date, 1);
    builtUntil = instant(date, 0, tz);
  }
  return { segments, builtUntil };
}

/** The block of `schedule` at `ts` with the end of its merged run, looking ahead `horizonMs` (7 days). */
export function scheduleAt(
  cfg: Pick<EngineConfig, 'scheduleExceptions'>,
  schedule: Schedule,
  ts: EpochMs,
  tz: string,
  horizonMs: number = WEEK_MS,
): ScheduleOpinion | null {
  const { segments, builtUntil } = buildSegments(cfg, schedule, ts, ts + horizonMs, tz);
  const i = segments.findIndex((s) => s.start <= ts && ts < s.end);
  if (i < 0) return null;
  const seg = segments[i];
  const real = seg.end < builtUntil || i < segments.length - 1;
  return { profileId: seg.profileId, start: seg.start, until: real && seg.end <= ts + horizonMs ? seg.end : null };
}

/** Instants in (from, to] where the schedule switches to a different profile, with the new profile. */
export function scheduleChanges(
  cfg: Pick<EngineConfig, 'scheduleExceptions'>,
  schedule: Schedule,
  from: EpochMs,
  to: EpochMs,
  tz: string,
): { at: EpochMs; profileId: Id }[] {
  const { segments } = buildSegments(cfg, schedule, from, to, tz);
  const out: { at: EpochMs; profileId: Id }[] = [];
  for (let i = 1; i < segments.length; i++) {
    const s = segments[i];
    if (s.start > from && s.start <= to) out.push({ at: s.start, profileId: s.profileId });
  }
  return out;
}

/** Today's blocks as local minutes (thermostat strip, day chart): [startMin, endMin, profileId]. */
export function dayStrip(cfg: Pick<EngineConfig, 'scheduleExceptions'>, schedule: Schedule, date: LocalDate): [MinuteOfDay, MinuteOfDay, Id][] {
  const out: [MinuteOfDay, MinuteOfDay, Id][] = [];
  for (const b of [...planForDate(cfg, schedule, date)].sort((x, y) => x.start - y.start)) {
    const last = out[out.length - 1];
    if (last && last[2] === b.profileId && last[1] === b.start) last[1] = b.end;
    else out.push([b.start, b.end, b.profileId]);
  }
  return out;
}
