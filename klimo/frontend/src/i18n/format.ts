/**
 * Number, temperature and time formatting. Temperatures are °C inside Klimo; °F appears only
 * on screen when the display unit says so. Clock times are shown in the Home Assistant time
 * zone (the browser may be elsewhere), and "now" comes from the server clock so the simulator's
 * accelerated time reads correctly.
 */
import type { Dow, EpochMs, LocalDate, MinuteOfDay } from '@api/model';
import { lang, locale, t } from './core';

const MINUS = '−';

let tz: string | undefined;
let units: 'C' | 'F' = 'C';
let nowSource: () => EpochMs = () => Date.now();

/** Called by the data layer when the server tells the time zone, the units and its clock. */
export function setFormatContext(ctx: { tz?: string | null; units?: 'C' | 'F'; now?: () => EpochMs }): void {
  if (ctx.tz !== undefined) tz = ctx.tz || undefined;
  if (ctx.units) units = ctx.units;
  if (ctx.now) nowSource = ctx.now;
}

export function timeZone(): string | undefined {
  return tz;
}

export function displayUnits(): 'C' | 'F' {
  return units;
}

/** Server-aligned now (simulator time when the simulator runs). */
export function nowMs(): EpochMs {
  return nowSource();
}

/** Fixed decimals, U+2212 minus, never «−0.0». */
export function fmtNum(v: number, decimals = 1): string {
  const s = v.toFixed(decimals);
  if (/^-0(\.0+)?$/.test(s)) return s.slice(1);
  return s.startsWith('-') ? MINUS + s.slice(1) : s;
}

const toDisplay = (c: number, u: 'C' | 'F') => (u === 'F' ? (c * 9) / 5 + 32 : c);

/** «19.8°» (°C) or «67.6°F»; «—» for null. */
export function fmtTemp(c: number | null | undefined, opts: { units?: 'C' | 'F'; decimals?: number; unit?: boolean } = {}): string {
  if (c == null || !Number.isFinite(c)) return '—';
  const u = opts.units ?? units;
  const text = fmtNum(toDisplay(c, u), opts.decimals ?? 1);
  if (opts.unit === false) return text;
  return u === 'F' ? `${text}°F` : `${text}°`;
}

/** Converted number without the degree sign («19.8»), e.g. for steppers. */
export function fmtTempValue(c: number | null | undefined, decimals = 1): string {
  return fmtTemp(c, { decimals, unit: false });
}

/** A temperature difference: «0.2°», with `sign` «+0.5°» / «−0.2°» (°F deltas scale, no offset). */
export function fmtDelta(d: number | null | undefined, opts: { sign?: boolean; decimals?: number } = {}): string {
  if (d == null || !Number.isFinite(d)) return '—';
  const v = units === 'F' ? (d * 9) / 5 : d;
  const text = fmtNum(opts.sign ? v : Math.abs(v), opts.decimals ?? 1);
  const signed = opts.sign && v > 0 && text !== fmtNum(0, opts.decimals ?? 1) ? `+${text}` : text;
  return `${signed}°`;
}

/** «−0.2°/год». */
export function fmtRate(cPerH: number | null | undefined, opts: { sign?: boolean } = { sign: true }): string {
  if (cPerH == null || !Number.isFinite(cPerH)) return '—';
  return t('{v}/h', { v: fmtDelta(cPerH, { sign: opts.sign }) });
}

export function fmtPct(v: number | null | undefined, decimals = 0): string {
  return v == null || !Number.isFinite(v) ? '—' : `${fmtNum(v, decimals)}%`;
}

export function fmtKw(kw: number | null | undefined): string {
  if (kw == null || !Number.isFinite(kw)) return '—';
  return t('{v} kW', { v: fmtNum(kw, kw >= 10 ? 0 : 1) });
}

export function fmtKwh(kwh: number | null | undefined): string {
  if (kwh == null || !Number.isFinite(kwh)) return '—';
  return t('{v} kWh', { v: fmtNum(kwh, kwh >= 10 ? 0 : 1) });
}

/* ---------------- time zone aware calendar maths ---------------- */

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function dtf(opts: Intl.DateTimeFormatOptions, loc = locale()): Intl.DateTimeFormat {
  const key = `${loc}|${tz ?? ''}|${JSON.stringify(opts)}`;
  let f = fmtCache.get(key);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat(loc, { ...opts, timeZone: tz });
    } catch {
      // an unknown zone name from a misconfigured HA falls back to the browser's zone
      f = new Intl.DateTimeFormat(loc, opts);
    }
    fmtCache.set(key, f);
  }
  return f;
}

export interface ZonedParts {
  year: number;
  /** 1..12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Monday … 6 = Sunday. */
  dow: Dow;
  date: LocalDate;
  minuteOfDay: MinuteOfDay;
}

const WEEKDAY_INDEX: Record<string, Dow> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

/** Wall-clock parts of `ts` in the Home Assistant time zone. */
export function zonedParts(ts: EpochMs): ZonedParts {
  const parts = dtf(
    { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short', hourCycle: 'h23' },
    'en-US',
  ).formatToParts(new Date(ts));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '0';
  const year = Number(get('year'));
  const month = Number(get('month'));
  const day = Number(get('day'));
  const hour = Number(get('hour')) % 24;
  const minute = Number(get('minute'));
  const second = Number(get('second'));
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    dow: WEEKDAY_INDEX[get('weekday')] ?? 0,
    date: `${year}-${pad(month)}-${pad(day)}`,
    minuteOfDay: hour * 60 + minute,
  };
}

/** Local midnight (HA zone) of the day containing `ts`; DST days are 23 or 25 hours long. */
export function startOfLocalDay(ts: EpochMs): EpochMs {
  const p = zonedParts(ts);
  let guess = ts - (p.minuteOfDay * 60 + p.second) * 1000 - (ts % 1000);
  // a DST switch between midnight and ts shifts the guess by the offset change; correct once
  const q = zonedParts(guess);
  if (q.minuteOfDay !== 0) guess += (q.minuteOfDay > 720 ? 1440 - q.minuteOfDay : -q.minuteOfDay) * 60000;
  return guess;
}

export function minuteToHhmm(m: MinuteOfDay): string {
  const mm = Math.max(0, Math.min(1440, Math.round(m)));
  return `${String(Math.floor(mm / 60)).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`;
}

export function hhmmToMinute(s: string): MinuteOfDay {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

/** «07:30» (24 h). */
export function fmtTime(ts: EpochMs | null | undefined): string {
  if (ts == null) return '—';
  return minuteToHhmm(zonedParts(ts).minuteOfDay);
}

/** «21 жовт.» / «вт, 21 жовт.» / «21 жовтня 2026». */
export function fmtDate(ts: EpochMs | null | undefined, style: 'short' | 'weekday' | 'long' = 'short'): string {
  if (ts == null) return '—';
  const opts: Intl.DateTimeFormatOptions =
    style === 'long'
      ? { day: 'numeric', month: 'long', year: 'numeric' }
      : style === 'weekday'
        ? { weekday: 'short', day: 'numeric', month: 'short' }
        : { day: 'numeric', month: 'short' };
  return dtf(opts).format(new Date(ts));
}

export function fmtDateTime(ts: EpochMs | null | undefined): string {
  if (ts == null) return '—';
  return `${fmtDate(ts)} ${fmtTime(ts)}`;
}

function dayDiff(ts: EpochMs, now: EpochMs): number {
  return Math.round((startOfLocalDay(ts) - startOfLocalDay(now)) / 86_400_000);
}

/** «23:00» today, «завтра 06:30», «вчора 22:10», else «пт 06:30» within a week or «25 жовт. 06:30». */
export function fmtClock(ts: EpochMs | null | undefined, now: EpochMs = nowMs()): string {
  if (ts == null) return '—';
  const time = fmtTime(ts);
  const d = dayDiff(ts, now);
  if (d === 0) return time;
  if (d === 1) return t('tomorrow {time}', { time });
  if (d === -1) return t('yesterday {time}', { time });
  if (d > 1 && d < 7) return `${dtf({ weekday: 'short' }).format(new Date(ts))} ${time}`;
  return `${fmtDate(ts)} ${time}`;
}

/** «до 23:00», «до завтра 06:30»; null → «до скасування». */
export function fmtUntil(ts: EpochMs | null | undefined, now: EpochMs = nowMs()): string {
  if (ts == null) return t('until cancelled');
  const d = dayDiff(ts, now);
  if (d === 1) return t('until tomorrow {time}', { time: fmtTime(ts) });
  return t('until {time}', { time: fmtClock(ts, now) });
}

/** «1 год 40 хв», «25 хв», «2 дн 3 год». */
export function fmtDur(minutes: number | null | undefined): string {
  if (minutes == null || !Number.isFinite(minutes)) return '—';
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return t('{m} min', { m });
  if (m < 1440) {
    const h = Math.floor(m / 60);
    const r = m % 60;
    return r ? t('{h} h {m} min', { h, m: r }) : t('{h} h', { h });
  }
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  return h ? t('{d} d {h} h', { d, h }) : t('{d} d', { d });
}

/** Seconds: «45 с», then minutes. */
export function fmtDurSec(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return '—';
  return sec < 90 ? t('{s} s', { s: Math.max(0, Math.round(sec)) }) : fmtDur(sec / 60);
}

/** «щойно», «4 хв тому», «2 год тому», «вчора», «3 дні тому». */
export function fmtAgo(ts: EpochMs | null | undefined, now: EpochMs = nowMs()): string {
  if (ts == null) return t('never');
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 60) return t('just now');
  const m = Math.round(s / 60);
  if (m < 60) return t('{n} min ago', { n: m });
  const d = -dayDiff(ts, now);
  if (d <= 0) return t('{n} h ago', { n: Math.floor(m / 60) });
  if (d === 1) return t('yesterday');
  return t('{count} days ago', { count: d });
}

/** «через 2 хв», «зараз». */
export function fmtIn(ts: EpochMs | null | undefined, now: EpochMs = nowMs()): string {
  if (ts == null) return '—';
  const min = (ts - now) / 60000;
  if (min < 0.5) return t('now');
  return t('in {dur}', { dur: fmtDur(Math.max(1, min)) });
}

/** How long ago `since` started, as a duration («12 хв»). */
export function fmtSince(since: EpochMs | null | undefined, now: EpochMs = nowMs()): string {
  if (since == null) return '—';
  return fmtDur((now - since) / 60000);
}

export interface PluralForms {
  one: string;
  few?: string;
  many?: string;
  other: string;
}

/**
 * Picks the plural form for `n` by the active language's CLDR rules: Ukrainian has one / few /
 * many (1 кімната, 2 кімнати, 5 кімнат), English one / other. Prefer t() with `count` for
 * translated strings; this helper is for word lists that arrive as data.
 */
export function pl(n: number, forms: PluralForms): string {
  let cat: Intl.LDMLPluralRule = 'other';
  try {
    cat = new Intl.PluralRules(lang() === 'uk' ? 'uk' : 'en').select(n);
  } catch {
    cat = n === 1 ? 'one' : 'other';
  }
  return (cat === 'one' ? forms.one : cat === 'few' ? forms.few : cat === 'many' ? forms.many : undefined) ?? forms.other;
}
