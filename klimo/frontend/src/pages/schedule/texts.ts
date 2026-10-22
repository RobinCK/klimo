/**
 * Words of the schedule screens built from data: the schedule summary of a profile («Будні
 * 06:30–08:30 і 17:30–23:00»), activation rule cards, priority hints and block captions.
 */
import type { ActivationRule, Dow, Id, PriorityKey, ProfileDto, RoomSummary, Schedule, SettingsBundle } from '@api/model';
import { fmtDateTime, fmtDur, fmtTemp, minuteToHhmm, t, weekdayShort, type CodeContext } from '@i18n';
import { DAY, DOWS, profileIntervals } from './blocks';

/** «06:30–08:30»; an interval running past midnight ends on the next day («23:00–06:30»). */
export const range = (start: number, end: number) => `${minuteToHhmm(start)}–${minuteToHhmm(end > DAY ? end - DAY : end)}`;

/** «Будні», «Вихідні», «Щодня», «Пн–Чт», «Пн, Ср, Пт». */
export function daysLabel(days: readonly Dow[]): string {
  const set = [...days].sort((a, b) => a - b);
  const key = set.join('');
  if (key === '0123456') return t('Every day');
  if (key === '01234') return t('Weekdays');
  if (key === '56') return t('Weekends');
  // a run of three or more days reads as a range
  const contiguous = set.every((d, i) => i === 0 || d === set[i - 1] + 1);
  if (contiguous && set.length >= 3) return `${weekdayShort(set[0])}–${weekdayShort(set[set.length - 1])}`;
  return set.map((d) => weekdayShort(d)).join(', ');
}

/** When the house schedule gives this profile, grouped by days with the same hours. */
export function scheduleSummary(profileId: Id, house: Schedule | null): { title: string; text: string } | null {
  if (!house) return null;
  const groups = new Map<string, { days: Dow[]; text: string }>();
  for (const d of DOWS) {
    const iv = profileIntervals(house.days[d] ?? [], profileId);
    if (!iv.length) continue;
    const text = iv.map((x) => range(x.start, x.end)).join(t(' and '));
    const g = groups.get(text);
    if (g) g.days.push(d);
    else groups.set(text, { days: [d], text });
  }
  const lines = [...groups.values()].map((g) => `${daysLabel(g.days)} ${g.text}`);
  if (!lines.length) return null;
  return {
    title: lines[0],
    text: lines
      .slice(1)
      .map((l) => `${l}.`)
      .join(' '),
  };
}

/** Rooms whose own schedule uses the profile (a note under the house summary). */
export function roomScheduleNote(profileId: Id, schedules: readonly Schedule[], rooms: readonly RoomSummary[]): string {
  const names = schedules
    .filter((s) => s.scope === 'room' && s.enabled && s.days.some((day) => day.some((b) => b.profileId === profileId)))
    .map((s) => rooms.find((r) => r.id === s.roomId)?.name)
    .filter((n): n is string => Boolean(n));
  return names.length ? t('Own schedule: {rooms}.', { rooms: names.join(', ') }) : '';
}

export function ruleTag(rule: ActivationRule): string {
  switch (rule.config.type) {
    case 'presence':
      return t('Presence');
    case 'calendar':
      return t('Calendar');
    case 'vacation':
      return t('Until a date');
  }
}

/** Title and line of a stored activation rule card. */
export function ruleCopy(rule: ActivationRule, profiles: readonly ProfileDto[], settings: SettingsBundle | null): { title: string; text: string } {
  const c = rule.config;
  switch (c.type) {
    case 'presence': {
      const p = settings?.general.presence;
      if (c.trigger === 'all_away') {
        return {
          title: t('Everyone has left'),
          text: p ? t('All people are away from home for longer than {dur}.', { dur: fmtDur(p.awayDelayMin) }) : t('All people are away from home.'),
        };
      }
      if (c.trigger === 'approaching') {
        return {
          title: t('Coming home'),
          text: p ? t('Someone is closer than {km} km — with an early start.', { km: p.approachKm }) : t('Someone is on the way home.'),
        };
      }
      return { title: t('Someone is home'), text: t('Cancels «Away» even in the middle of a schedule slot.') };
    }
    case 'calendar':
      return {
        title: t('Event «{text}» in {calendar}', { text: c.match.contains, calendar: c.calendarEntityId }),
        text: c.preheatMin > 0 ? t('Works during the event, warms up {dur} before it starts.', { dur: fmtDur(c.preheatMin) }) : t('Works during the event.'),
      };
    case 'vacation': {
      const back = profiles.find((p) => p.id === c.returnProfileId)?.name ?? c.returnProfileId;
      return {
        title: c.until ? t('Until {date}', { date: fmtDateTime(c.until) }) : t('Until the return date'),
        text:
          c.returnLeadH > 0
            ? t('{h} h before the return — «{profile}». Frost protection always works.', { h: c.returnLeadH, profile: back })
            : t('On return — «{profile}». Frost protection always works.', { profile: back }),
      };
    }
  }
}

export function priorityHint(key: PriorityKey, settings: SettingsBundle | null): string {
  switch (key) {
    case 'frost':
      return t('below {t} — always heat', { t: fmtTemp(settings?.safety.frostC ?? 7) });
    case 'window':
      return t('the room’s reaction');
    case 'manual':
      return t('until the end of the slot or a chosen time');
    case 'calendar':
      return t('an event in a Home Assistant calendar');
    case 'presence':
      return t('everyone left / someone is coming');
    case 'room_schedule':
      return t('if the room has its own');
    case 'house_schedule':
      return t('by default');
  }
}

/**
 * The targets a block gives: the profile defaults for the house, the room's own row for a
 * room schedule; the season decides whether heating, cooling or both matter.
 */
export function blockTargets(
  s: Schedule,
  profile: ProfileDto | null,
  c: { rooms: readonly RoomSummary[]; ctx: CodeContext; house: { season: { season: 'heating' | 'neutral' | 'cooling' } } | null },
  opts: { short?: boolean } = {},
): string {
  if (!profile) return '';
  const season = c.house?.season.season ?? 'neutral';
  const scope = scopeName(s, c.rooms, c.ctx);
  let heat: number | null = profile.heatC;
  let cool: number | null = profile.coolC;
  if (s.scope === 'room') {
    const row = profile.roomTargets.find((r) => r.roomId === s.roomId);
    if (row?.mode === 'off' || profile.frostOnly) return t('{scope}: off · frost protection works', { scope });
    if (row?.mode === 'own') {
      heat = row.heatC ?? profile.heatC;
      cool = row.coolC ?? profile.coolC;
    }
  } else if (profile.frostOnly) {
    return t('{scope}: frost protection only', { scope });
  }
  const parts: string[] = [];
  if (season !== 'cooling') parts.push(t('heating {t}', { t: fmtTemp(heat) }));
  if (season !== 'heating') parts.push(t('cooling {t}', { t: fmtTemp(cool) }));
  const main = `${scope} · ${parts.join(', ')}`;
  if (opts.short || s.scope === 'room') return main;
  return `${main} · ${t('rooms with their own targets — by the profile')}`;
}

/** Short and full weekday names in Monday-first order (day chips, tabs). */
export const shortDays = () => DOWS.map((d) => weekdayShort(d));

/** Name of the schedule's scope («Весь дім», «Дитяча»). */
export function scopeName(s: Schedule | null, rooms: readonly RoomSummary[], ctx: CodeContext): string {
  if (!s || s.scope === 'house') return t('Whole house');
  return rooms.find((r) => r.id === s.roomId)?.name ?? ctx.room?.(s.roomId ?? '') ?? s.roomId ?? '—';
}
