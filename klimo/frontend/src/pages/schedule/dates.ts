/**
 * Picking a day without a calendar widget: the next few months as a list of local dates in
 * the Home Assistant time zone («пт, 24 жовт.»), and back from a date and a time to an instant.
 */
import type { EpochMs, LocalDate } from '@api/model';
import { fmtDate, startOfLocalDay, zonedParts } from '@i18n';

const DAY_MS = 86_400_000;

export interface DateOption {
  value: LocalDate;
  label: string;
  /** Local midnight of that day. */
  start: EpochMs;
}

export function upcomingDates(now: EpochMs, count = 120): DateOption[] {
  const today = startOfLocalDay(now);
  const out: DateOption[] = [];
  for (let k = 0; k < count; k++) {
    // noon never falls into a daylight-saving gap, so its midnight is the right day
    const start = startOfLocalDay(today + k * DAY_MS + DAY_MS / 2);
    out.push({ value: zonedParts(start).date, label: fmtDate(start + DAY_MS / 2, 'weekday'), start });
  }
  return out;
}

/** The instant of `minute` on the local day that starts at `dayStart`. */
export function atMinute(dayStart: EpochMs, minute: number): EpochMs {
  const guess = dayStart + minute * 60_000;
  // across a clock change the wall clock is one hour off; correct it once
  const got = zonedParts(guess).minuteOfDay;
  const diff = minute - got;
  return Math.abs(diff) >= 30 && Math.abs(diff) <= 90 ? guess + diff * 60_000 : guess;
}
