import type { Dow, EpochMs, HHMM, LocalDate, MinuteOfDay, TimeWindow } from '../../shared/model';

/**
 * Local wall-clock arithmetic in the Home Assistant time zone. Pure: only `Intl.DateTimeFormat`, no
 * reading of the current time. DST rules: a wall minute that does not exist (spring forward) maps to
 * the first valid minute after it; an ambiguous minute (fall back) maps to its first occurrence.
 */

export interface LocalTime {
  date: LocalDate;
  /** ISO weekday, 0 = Monday … 6 = Sunday. */
  dow: Dow;
  minute: MinuteOfDay;
  /** 1..12 */
  month: number;
  year: number;
}

const MIN = 60_000;
const DAY = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function partsOf(ts: EpochMs, tz: string): Parts {
  const out: Parts = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  for (const p of formatter(tz).formatToParts(new Date(ts))) {
    if (p.type in out) out[p.type as keyof Parts] = Number(p.value);
  }
  if (out.hour === 24) out.hour = 0;
  return out;
}

/** Local wall time of `ts` expressed as if it were UTC (milliseconds, minute precision kept). */
function wallMs(ts: EpochMs, tz: string): number {
  const p = partsOf(ts, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) + (((ts % 1000) + 1000) % 1000);
}

/** UTC offset of the zone at `ts`, in ms (Kyiv summer: +3 h). */
export function offsetAt(ts: EpochMs, tz: string): number {
  return wallMs(ts, tz) - ts;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function dateOfUtcMs(ms: number): LocalDate {
  const d = new Date(ms);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function parseDate(date: LocalDate): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`invalid local date "${date}"`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function isLocalDate(v: unknown): v is LocalDate {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  return dateOfUtcMs(parseDate(v)) === v;
}

export function dowOfDate(date: LocalDate): Dow {
  return ((new Date(parseDate(date)).getUTCDay() + 6) % 7) as Dow;
}

export function toLocal(ts: EpochMs, tz: string): LocalTime {
  const p = partsOf(ts, tz);
  const dayMs = Date.UTC(p.year, p.month - 1, p.day);
  return {
    date: dateOfUtcMs(dayMs),
    dow: ((new Date(dayMs).getUTCDay() + 6) % 7) as Dow,
    minute: p.hour * 60 + p.minute,
    month: p.month,
    year: p.year,
  };
}

/** The instant of local `date` + `minute` (0..1440; 1440 = the next midnight). */
export function fromLocal(date: LocalDate, minute: MinuteOfDay, tz: string): EpochMs {
  const wall = parseDate(date) + minute * MIN;
  // the offset can only be one of the offsets around this wall time; try both, keep valid instants
  const offsets = new Set([offsetAt(wall - DAY / 2, tz), offsetAt(wall, tz), offsetAt(wall + DAY / 2, tz)]);
  const candidates: number[] = [];
  for (const off of offsets) {
    const t = wall - off;
    if (wallMs(t, tz) === wall) candidates.push(t);
  }
  if (candidates.length) return Math.min(...candidates);

  // spring-forward gap: the wall minute never happens; the first valid minute after it is the transition
  const sorted = [...offsets].sort((a, b) => a - b);
  let lo = wall - sorted[sorted.length - 1]; // before the jump (larger offset → earlier instant)
  let hi = wall - sorted[0];
  const before = offsetAt(lo, tz);
  while (hi - lo > MIN) {
    const mid = lo + Math.floor((hi - lo) / 2 / MIN) * MIN;
    if (offsetAt(mid, tz) === before) lo = mid;
    else hi = mid;
  }
  return hi;
}

export function addDays(date: LocalDate, n: number): LocalDate {
  return dateOfUtcMs(parseDate(date) + n * DAY);
}

/** Start (00:00 local) of the local day containing `ts`. */
export function startOfLocalDay(ts: EpochMs, tz: string): EpochMs {
  return fromLocal(toLocal(ts, tz).date, 0, tz);
}

export const startOfDay = startOfLocalDay;

/** "HH:MM" → minutes; "24:00" → 1440. */
export function hhmmToMinute(v: HHMM): MinuteOfDay {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v);
  if (!m) throw new Error(`invalid time "${v}"`);
  const minute = Number(m[1]) * 60 + Number(m[2]);
  if (Number(m[2]) > 59 || minute > 1440) throw new Error(`invalid time "${v}"`);
  return minute;
}

/** minutes → "HH:MM" (1440 → "24:00"). */
export function minuteToHhmm(minute: MinuteOfDay): HHMM {
  const m = Math.max(0, Math.min(1440, Math.round(minute)));
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/**
 * Is the local `minute` of weekday `dow` inside the window? Windows may cross midnight (23:00–07:00);
 * `days` names the weekday on which a window STARTS, so Friday 23:00–07:00 also covers Saturday 03:00.
 * `from === to` means the whole day.
 */
export function inWindow(minute: MinuteOfDay, dow: Dow, window: TimeWindow): boolean {
  const from = hhmmToMinute(window.from);
  const to = hhmmToMinute(window.to);
  const startsOn = (d: number) => !window.days || window.days.length === 0 || window.days.includes(((d + 7) % 7) as Dow);
  if (from === to) return startsOn(dow);
  if (from < to) return startsOn(dow) && minute >= from && minute < to;
  if (minute >= from) return startsOn(dow);
  return minute < to && startsOn(dow - 1);
}
