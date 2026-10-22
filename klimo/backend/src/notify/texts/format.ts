import { toLocal } from '../../engine/core/time';
import type { EpochMs, Lang } from '../../shared/model';

/**
 * Formatting primitives and the small template language every backend text is written in.
 *
 *   {name}            a variable, formatted by what its name says it is (°C, time, minutes, %, an id…)
 *   {name:fmt}        the same with an explicit format, for names that mean different things in
 *                     different messages (`{from:season}`, `{to:temp}`)
 *   {n|one|few|many}  the number and the right plural form (en: {n|one|other})
 *   {#n|one|few|many} the plural form alone («Гріє» / «Гріють»)
 *   [ … ]             an optional part: dropped when any variable inside it is missing
 *   {@t} {@d}         the Lovelace card's own placeholders (clock time / duration of `at`), left as
 *                     `{t}` / `{d}` for the card to fill in so MQTT attributes never tick per minute
 */

export type Var = string | number | boolean | null | undefined;
export type Vars = Readonly<Record<string, Var>>;
/** A template, or a function choosing one from the raw variables (for wording that depends on a value). */
export type Tpl = string | ((v: Vars) => string);
/** One message in every language: [en, uk]. A missing translation is a compile error. */
export type Row = readonly [en: Tpl, uk: Tpl];

export const LANGS: readonly Lang[] = ['en', 'uk'];

export function pick(row: Row, lang: Lang): Tpl {
  return row[lang === 'uk' ? 1 : 0];
}

/** Ids inside params are shown as names; every lookup may be missing (a deleted room, a fresh id). */
export interface NameResolver {
  room(id: string): string | null;
  source(id: string): string | null;
  profile(id: string): string | null;
  trigger(id: string): string | null;
  rule(id: string): string | null;
  circuit(id: string): string | null;
  pump(id: string): string | null;
  instance(id: string): string | null;
  /** HA device key or an emitter device id. */
  device(keyOrId: string): string | null;
  /** Entity id → friendly name. */
  entity(entityId: string): string | null;
}

export const NO_NAMES: NameResolver = {
  room: () => null,
  source: () => null,
  profile: () => null,
  trigger: () => null,
  rule: () => null,
  circuit: () => null,
  pump: () => null,
  instance: () => null,
  device: () => null,
  entity: () => null,
};

export interface TextContext {
  lang: Lang;
  now: EpochMs;
  tz: string;
  names: NameResolver;
  /** Labels of enum values (`mode`, `season`, fault codes…), looked up by format name. */
  label?: (format: string, value: string, lang: Lang) => string | null;
}

/* ── numbers ─────────────────────────────────────────────────────────────────────────────────── */

const MINUS = '−';
const MIN = 60_000;
const DAY = 86_400_000;

function signed(text: string, x: number, sign: boolean): string {
  if (x < 0) return MINUS + text;
  return sign && x > 0 ? `+${text}` : text;
}

/** One decimal, at most: 2 → «2», 1.25 → «1.3». */
export function fmtNumber(x: number, maxDigits = 1): string {
  const f = 10 ** maxDigits;
  const r = Math.round(Math.abs(x) * f) / f;
  const text = Number.isInteger(r) ? String(r) : r.toFixed(maxDigits).replace(/0+$/, '');
  return r === 0 ? '0' : signed(text, x, false);
}

/** Absolute temperature: always one decimal, U+2212 minus, «°» («20.0°», «−3.5°»). */
export function fmtTemp(c: number): string {
  const r = Math.round(Math.abs(c) * 10) / 10;
  return (r === 0 ? '0.0' : signed(r.toFixed(1), c, false)) + '°';
}

/** Temperature difference: «1°», «1.5°»; with `sign` «+1°», «−0.5°». */
export function fmtDelta(c: number, sign = false): string {
  const r = Math.round(Math.abs(c) * 10) / 10;
  const text = (Number.isInteger(r) ? String(r) : r.toFixed(1)) + '°';
  return r === 0 ? '0°' : signed(text, c, sign);
}

export function fmtPct(p: number): string {
  return `${Math.round(p)}%`;
}

export function fmtKw(kw: number, lang: Lang): string {
  return `${fmtNumber(kw)} ${lang === 'uk' ? 'кВт' : 'kW'}`;
}

export function fmtKwh(kwh: number, lang: Lang): string {
  return `${fmtNumber(kwh)} ${lang === 'uk' ? 'кВт·год' : 'kWh'}`;
}

export function fmtRate(cPerH: number, lang: Lang): string {
  return `${fmtNumber(Math.abs(cPerH))}°/${lang === 'uk' ? 'год' : 'h'}`;
}

/**
 * Ukrainian plural form: one (1, 21, 101), few (2–4, 22–24), many (0, 5–20, 11–14, 25…).
 * English uses the first form for exactly 1 and the second otherwise.
 */
export function plural(n: number, forms: readonly string[], lang: Lang): string {
  const a = Math.abs(Math.trunc(n));
  if (lang !== 'uk') return a === 1 && Number.isInteger(n) ? forms[0] : (forms[1] ?? forms[0]);
  if (!Number.isInteger(n)) return forms[1] ?? forms[0];
  const d = a % 10;
  const h = a % 100;
  if (d === 1 && h !== 11) return forms[0];
  if (d >= 2 && d <= 4 && (h < 12 || h > 14)) return forms[1] ?? forms[0];
  return forms[2] ?? forms[1] ?? forms[0];
}

/* ── durations and clock times ──────────────────────────────────────────────────────────────── */

/** Minutes as «45 хв», «1 год 40 хв», «2 д 3 год» (never «1 г»); English "1 h 40 min". */
export function fmtDuration(minutes: number, lang: Lang): string {
  const uk = lang === 'uk';
  const m = Math.max(0, Math.round(minutes));
  if (m < 1) return uk ? '<1 хв' : '<1 min';
  if (m < 60) return uk ? `${m} хв` : `${m} min`;
  if (m < 1440) {
    const h = Math.floor(m / 60);
    const rest = m % 60;
    const head = uk ? `${h} год` : `${h} h`;
    return rest ? `${head} ${uk ? `${rest} хв` : `${rest} min`}` : head;
  }
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const head = uk ? `${d} д` : `${d} d`;
  return h ? `${head} ${uk ? `${h} год` : `${h} h`}` : head;
}

/** Seconds: «45 с» under a minute, otherwise like `fmtDuration`. */
export function fmtSeconds(sec: number, lang: Lang): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return lang === 'uk' ? `${s} с` : `${s} s`;
  return fmtDuration(s / 60, lang);
}

const WEEKDAYS: Record<Lang, readonly string[]> = {
  uk: ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'нд'],
  en: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
};
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = (n: number) => String(n).padStart(2, '0');

function hhmm(minute: number): string {
  return `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`;
}

/** Days between two local dates (YYYY-MM-DD). */
function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY);
}

/**
 * A moment as people say it: «19:00» today, «вчора 16:14», «завтра 07:00», «пн 16:14» within a
 * week, else «21.10 16:14» ("21 Oct 16:14"). Always in the Home Assistant time zone.
 */
export function fmtClock(ts: EpochMs, now: EpochMs, tz: string, lang: Lang): string {
  const at = toLocal(ts, tz);
  const today = toLocal(now, tz);
  const time = hhmm(at.minute);
  const diff = dayDiff(at.date, today.date);
  const uk = lang === 'uk';
  if (diff === 0) return time;
  if (diff === -1) return `${uk ? 'вчора' : 'yesterday'} ${time}`;
  if (diff === 1) return `${uk ? 'завтра' : 'tomorrow'} ${time}`;
  if (Math.abs(diff) < 7) return `${WEEKDAYS[lang][at.dow]} ${time}`;
  const [, mm, dd] = at.date.split('-');
  return uk ? `${dd}.${mm} ${time}` : `${Number(dd)} ${MONTHS_EN[Number(mm) - 1]} ${time}`;
}

/** Local date as «21.10» / "21 Oct" (report headers). */
export function fmtDate(ts: EpochMs, tz: string, lang: Lang): string {
  const [, mm, dd] = toLocal(ts, tz).date.split('-');
  return lang === 'uk' ? `${dd}.${mm}` : `${Number(dd)} ${MONTHS_EN[Number(mm) - 1]}`;
}

/** Ago in minutes from `ts` to `now` (never negative). */
export function minutesSince(ts: EpochMs, now: EpochMs): number {
  return Math.max(0, (now - ts) / MIN);
}

/* ── variable formats ───────────────────────────────────────────────────────────────────────── */

export type Fmt =
  | 'auto' | 'raw' | 'int' | 'num' | 'temp' | 'delta' | 'sdelta' | 'clock' | 'dur' | 'durs' | 'pct' | 'kw' | 'kwh'
  | 'rate' | 'q' | 'ago' | 'tnum' | 'deg'
  | 'room' | 'source' | 'profile' | 'trigger' | 'rule' | 'circuit' | 'pump' | 'instance' | 'device' | 'entity'
  // enum labels (texts/labels.ts)
  | 'mode' | 'smode' | 'hmode' | 'season' | 'fault' | 'preason' | 'pstate' | 'sstate' | 'reaction' | 'policy'
  | 'okind' | 'carrier' | 'by' | 'centity' | 'event' | 'channel' | 'action' | 'rstate' | 'srcverb';

const ID_FORMATS: Record<string, Fmt> = {
  roomId: 'room',
  sourceId: 'source',
  fallbackId: 'source',
  profileId: 'profile',
  triggerId: 'trigger',
  ruleId: 'rule',
  circuitId: 'circuit',
  pumpId: 'pump',
  instanceId: 'instance',
  deviceKey: 'device',
  deviceId: 'device',
  entityId: 'entity',
};
const SIGNED = new Set(['delta', 'shiftC', 'deviationC']);
const DELTAS = new Set(['a', 'b', 'deltaC', 'dropC', 'deficitC', 'gapC', 'marginC', 'resolveC']);
const TEMPS = new Set(['t', 'T', 'on', 'off', 'lo', 'hi', 'temp', 'frost', 'avg', 'out', 'roomTemp', 'min', 'max']);
const TIMES = new Set(['since', 'until', 'at', 'deadline', 'ts']);
const PCTS = new Set(['pct', 'soc', 'rh']);
const ENUMS: Record<string, Fmt> = {
  mode: 'smode',
  season: 'season',
  code: 'fault',
  reaction: 'reaction',
  policy: 'policy',
  carrier: 'carrier',
  by: 'by',
};

/** What a variable is, judged by its name (the conventions of the reason and journal params). */
export function inferFormat(name: string): Fmt {
  if (ID_FORMATS[name]) return ID_FORMATS[name];
  if (ENUMS[name]) return ENUMS[name];
  if (SIGNED.has(name)) return 'sdelta';
  if (DELTAS.has(name)) return 'delta';
  if (TEMPS.has(name) || /C$/.test(name)) return 'temp';
  if (TIMES.has(name) || /At$/.test(name)) return 'clock';
  if (/Sec$/.test(name)) return 'durs';
  if (name === 'minutes' || name === 'duration' || /Min$/.test(name)) return 'dur';
  if (PCTS.has(name) || /Pct$/.test(name)) return 'pct';
  if (/Kwh$/.test(name)) return 'kwh';
  if (/Kw$/.test(name)) return 'kw';
  if (name === 'rate') return 'rate';
  return 'auto';
}

function asNumber(v: Var): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function nameOf(resolve: (id: string) => string | null, v: Var): string | null {
  if (v === null || v === undefined || v === '') return null;
  const id = String(v);
  return resolve(id) ?? id;
}

/** Formats one value; null = missing (an optional part containing it is dropped). */
export function formatVar(v: Var, fmt: Fmt, ctx: TextContext): string | null {
  if (v === null || v === undefined || v === '') return null;
  const { lang } = ctx;
  const n = asNumber(v);
  switch (fmt) {
    case 'raw':
      return String(v);
    case 'auto':
      return typeof v === 'number' ? fmtNumber(v) : String(v);
    case 'int':
      return n === null ? String(v) : String(Math.round(n));
    case 'num':
      return n === null ? String(v) : fmtNumber(n);
    case 'temp':
      return n === null ? String(v) : fmtTemp(n);
    case 'delta':
      return n === null ? String(v) : fmtDelta(n);
    case 'sdelta':
      return n === null ? String(v) : fmtDelta(n, true);
    case 'clock':
      return n === null ? String(v) : fmtClock(n, ctx.now, ctx.tz, lang);
    case 'dur':
      return n === null ? String(v) : fmtDuration(n, lang);
    case 'durs':
      return n === null ? String(v) : fmtSeconds(n, lang);
    case 'pct':
      return n === null ? String(v) : fmtPct(n);
    case 'kw':
      return n === null ? String(v) : fmtKw(n, lang);
    case 'kwh':
      return n === null ? String(v) : fmtKwh(n, lang);
    case 'rate':
      return n === null ? String(v) : fmtRate(n, lang);
    case 'q':
      return `«${String(v)}»`;
    case 'ago':
      return n === null ? String(v) : fmtDuration(minutesSince(n, ctx.now), lang);
    case 'tnum':
      return n === null ? String(v) : fmtTemp(n).slice(0, -1);
    case 'deg':
      return n === null ? String(v) : `${fmtNumber(n)}°`;
    case 'room':
      return nameOf((id) => ctx.names.room(id), v);
    case 'source':
      return nameOf((id) => ctx.names.source(id), v);
    case 'profile':
      return nameOf((id) => ctx.names.profile(id), v);
    case 'trigger':
      return nameOf((id) => ctx.names.trigger(id), v);
    case 'rule':
      return nameOf((id) => ctx.names.rule(id), v);
    case 'circuit':
      return nameOf((id) => ctx.names.circuit(id), v);
    case 'pump':
      return nameOf((id) => ctx.names.pump(id), v);
    case 'instance':
      return nameOf((id) => ctx.names.instance(id), v);
    case 'device':
      return nameOf((id) => ctx.names.device(id), v);
    case 'entity':
      return nameOf((id) => ctx.names.entity(id), v);
    default: {
      const s = String(v);
      return ctx.label?.(fmt, s, lang) ?? s;
    }
  }
}

/* ── the template renderer ──────────────────────────────────────────────────────────────────── */

const PLACEHOLDER = /\{(#?)(\w+)(?::(\w+))?((?:\|[^{}|]*)+)?\}/g;
/** An optional part or a placeholder, in one left-to-right pass (values are never re-scanned). */
const PART = new RegExp(`\\[([^\\[\\]]*)\\]|${PLACEHOLDER.source}`, 'g');
const KNOWN_FORMATS = new Set<string>([
  'auto', 'raw', 'int', 'num', 'temp', 'delta', 'sdelta', 'clock', 'dur', 'durs', 'pct', 'kw', 'kwh', 'rate', 'q',
  'ago', 'tnum', 'deg',
  'room', 'source', 'profile', 'trigger', 'rule', 'circuit', 'pump', 'instance', 'device', 'entity',
  'mode', 'smode', 'hmode', 'season', 'fault', 'preason', 'pstate', 'sstate', 'reaction', 'policy', 'okind', 'carrier',
  'by', 'centity', 'event', 'channel', 'action', 'rstate', 'srcverb',
]);

/** Placeholder text shown for a missing value outside an optional part. */
export const MISSING = '—';

function placeholder(wordOnly: string, name: string, fmt: string | undefined, forms: string | undefined, vars: Vars, ctx: TextContext): string | null {
  const raw = vars[name];
  if (forms) {
    const n = asNumber(raw);
    if (n === null) return null;
    const word = plural(n, forms.slice(1).split('|'), ctx.lang);
    return wordOnly ? word : `${fmtNumber(n)} ${word}`;
  }
  const f: Fmt = fmt && KNOWN_FORMATS.has(fmt) ? (fmt as Fmt) : inferFormat(name);
  return formatVar(raw, f, ctx);
}

function fill(tpl: string, vars: Vars, ctx: TextContext, onMissing: () => void): string {
  return tpl.replace(PLACEHOLDER, (_m, wordOnly: string, name: string, fmt: string | undefined, forms: string | undefined) => {
    const text = placeholder(wordOnly, name, fmt, forms, vars, ctx);
    if (text === null) onMissing();
    return text ?? MISSING;
  });
}

/** Renders a template with variables; never leaves a `{var}` behind. */
export function render(tpl: Tpl, vars: Vars, ctx: TextContext): string {
  const text = typeof tpl === 'function' ? tpl(vars) : tpl;
  const out = text.replace(
    PART,
    (_m, optional: string | undefined, wordOnly: string, name: string, fmt: string | undefined, forms: string | undefined) => {
      if (optional !== undefined) {
        // the card fills {t}/{d} from `at`: a caller that says there is no `at` drops the part
        let missing = optional.includes('{@') && 'at' in vars && (vars.at === null || vars.at === undefined);
        const inner = fill(optional, vars, ctx, () => (missing = true));
        return missing ? '' : inner;
      }
      return placeholder(wordOnly, name, fmt, forms, vars, ctx) ?? MISSING;
    },
  );
  return out
    .replace(/\{@([td])\}/g, '{$1}')
    .replace(/ {2,}/g, ' ')
    .replace(/ +([.,])/g, '$1')
    .trim();
}

export function renderRow(row: Row, vars: Vars, ctx: TextContext): string {
  return render(pick(row, ctx.lang), vars, ctx);
}

/** Names of the variables a template string refers to (tests, previews). */
export function placeholders(tpl: string): string[] {
  const out = new Set<string>();
  for (const m of tpl.matchAll(PLACEHOLDER)) out.add(m[2]);
  return [...out];
}

/** Telegram HTML needs these escaped; nothing else is interpreted. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Shortens to `max` characters with an ellipsis (push titles are cut by the phone anyway). */
export function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export { MIN as MINUTE_MS };
