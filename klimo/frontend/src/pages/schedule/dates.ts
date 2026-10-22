/**
 * Days in the Home Assistant time zone: the local date a number of days from now, the instant a
 * local date starts, and back from a date and a time to an instant.
 */
import type { EpochMs, LocalDate } from '@api/model';
import { startOfLocalDay, zonedParts } from '@i18n';

const DAY_MS = 86_400_000;

/** Today's local date ('YYYY-MM-DD'), or the one `days` later. */
export function localDate(now: EpochMs, days = 0): LocalDate {
  // noon never falls into a daylight-saving gap, so its date is the right day
  return zonedParts(startOfLocalDay(now) + days * DAY_MS + DAY_MS / 2).date;
}

/** Local midnight of a date. */
export function dayStart(date: LocalDate): EpochMs {
  let noon = Date.parse(`${date}T12:00:00Z`);
  const got = zonedParts(noon).date;
  // far east of Greenwich noon UTC is already the next day there, far west still the previous one
  if (got > date) noon -= DAY_MS;
  else if (got < date) noon += DAY_MS;
  return startOfLocalDay(noon);
}

/** The instant of `minute` on the local day that starts at `dayStart`. */
export function atMinute(dayStart: EpochMs, minute: number): EpochMs {
  const guess = dayStart + minute * 60_000;
  // across a clock change the wall clock is one hour off; correct it once
  const got = zonedParts(guess).minuteOfDay;
  const diff = minute - got;
  return Math.abs(diff) >= 30 && Math.abs(diff) <= 90 ? guess + diff * 60_000 : guess;
}
