/**
 * Amounts of what sources used and what it cost: «1.54 m³», «29.1 kWh», «€7.06» / «7.06 ₴»,
 * «−31%», and the periods they are looked at in («Today», «13 Oct – 19 Oct») with the change
 * against the one before. Shared by the source page, the house's and a room's consumption, the
 * overview tile and the settings. Dates are the Home Assistant zone's.
 */
import type { ConsumptionBucket, ConsumptionRange, EnergyTariffs, LocalDate, MeterKind, SourceConsumptionDto } from '@api/model';
import { lang, t } from './core';
import { fmtDate, fmtNum, fmtTime, zonedParts } from './format';
import { monthLong, monthShort, weekdayShort } from './labels';

/** Fewer decimals as the amount grows: 0.044 · 0.26 · 1.54 · 20.1 · 207. */
function decimalsFor(v: number): number {
  const a = Math.abs(v);
  return a > 0 && a < 0.1 ? 3 : a < 10 ? 2 : a < 100 ? 1 : 0;
}

/** «1.54 m³», «29.1 kWh»; without a unit just the number. */
export function fmtAmount(v: number | null | undefined, unit: string | null): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const d = decimalsFor(v);
  // the third decimal is there for small amounts (0.044), not to pad 0.03 into «0.030»
  const n = d === 3 ? fmtNum(v, 3).replace(/(\.\d\d)0$/, '$1') : fmtNum(v, d);
  if (unit === 'kWh') return t('{v} kWh', { v: n });
  if (unit === 'm³') return t('{v} m³', { v: n });
  return unit ? `${n} ${unit}` : n;
}

/** The unit alone, as a column or legend label («m³», «кВт·год»). */
export function unitLabel(unit: string | null): string {
  if (unit === 'kWh') return t('kWh');
  if (unit === 'm³') return t('m³');
  return unit ?? '';
}

/** «€7.06» in English for a one-character sign, otherwise the amount then the currency («7.06 ₴», «7.06 UAH»). */
export function fmtMoney(v: number | null | undefined, currency: string | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const n = fmtNum(v, Math.abs(v) >= 1000 ? 0 : 2);
  const c = (currency ?? '').trim();
  if (!c) return n;
  if (lang() === 'en' && [...c].length === 1) return v < 0 ? `−${c}${n.replace('−', '')}` : `${c}${n}`;
  return `${n} ${c}`;
}

/** «+12%», «−31%»; null when there is nothing to compare with. */
export function fmtChange(now: number | null, before: number | null): string | null {
  if (now == null || before == null || !(before > 0)) return null;
  const p = Math.round(((now - before) / before) * 100);
  if (p === 0) return '±0%';
  return p > 0 ? `+${p}%` : `−${Math.abs(p)}%`;
}

/* ---------------- periods ---------------- */

const pad = (n: number) => String(n).padStart(2, '0');

function parts(d: LocalDate): { y: number; m: number; d: number } {
  const [y, m, day] = d.split('-').map(Number);
  return { y, m, d: day };
}

function fromUtc(ms: number): LocalDate {
  const x = new Date(ms);
  return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}`;
}

/** Calendar arithmetic on plain dates (no time zone involved). */
function addDays(d: LocalDate, n: number): LocalDate {
  const p = parts(d);
  return fromUtc(Date.UTC(p.y, p.m - 1, p.d + n));
}

/** A day that exists: «2026-02-31» does not come back the same from the calendar. */
export function isCalendarDate(d: string): d is LocalDate {
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && addDays(d, 0) === d && d >= '2000-01-01' && d <= '2099-12-31';
}

/** First day of the period of `range` that holds `date` (weeks start on Monday, as the server counts them). */
export function periodStart(range: ConsumptionRange, date: LocalDate): LocalDate {
  const p = parts(date);
  if (range === 'day') return date;
  if (range === 'month') return `${p.y}-${pad(p.m)}-01`;
  if (range === 'year') return `${p.y}-01-01`;
  const dow = (new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay() + 6) % 7;
  return addDays(date, -dow);
}

/** The first day of the period after the one starting on `start`. */
export function nextPeriod(range: ConsumptionRange, start: LocalDate): LocalDate {
  const p = parts(start);
  if (range === 'day') return addDays(start, 1);
  if (range === 'week') return addDays(start, 7);
  if (range === 'month') return fromUtc(Date.UTC(p.y, p.m, 1));
  return `${p.y + 1}-01-01`;
}

/** «Today», «Tue, 20 Oct», «This week», «13 Oct – 19 Oct», «October 2026», «2026». */
export function periodLabel(dto: Pick<SourceConsumptionDto, 'range' | 'date' | 'from' | 'to' | 'now'>): string {
  const today = zonedParts(dto.now).date;
  const p = parts(dto.date);
  const current = dto.from <= dto.now && dto.now < dto.to;
  switch (dto.range) {
    case 'day':
      if (dto.date === today) return t('Today');
      if (dto.date === addDays(today, -1)) return t('Yesterday');
      return p.y === parts(today).y ? fmtDate(dto.from, 'weekday') : fmtDate(dto.from, 'long');
    case 'week':
      return current ? t('This week') : `${fmtDate(dto.from)} – ${fmtDate(dto.to - 1)}`;
    case 'month':
      return `${monthLong(p.m)} ${p.y}`;
    case 'year':
      return String(p.y);
  }
}

/** Axis label and full name of a bucket. */
export function bucketLabels(dto: Pick<SourceConsumptionDto, 'range' | 'bucket'>, b: Pick<ConsumptionBucket, 'start' | 'end'>): { label: string; title: string } {
  const z = zonedParts(b.start);
  if (dto.bucket === 'hour') return { label: pad(z.hour), title: `${fmtTime(b.start)}–${fmtTime(b.end)}` };
  if (dto.bucket === 'month') return { label: monthShort(z.month), title: `${monthLong(z.month)} ${z.year}` };
  if (dto.range === 'week') return { label: weekdayShort(z.dow), title: fmtDate(b.start, 'weekday') };
  return { label: String(z.day), title: fmtDate(b.start, 'weekday') };
}

/* ---------------- amounts ---------------- */

/** «+12% vs yesterday at this time» for an amount of the period and the same of the period before. */
export function changeAgainst(
  dto: Pick<SourceConsumptionDto, 'range' | 'from' | 'to' | 'now'>,
  value: number | null,
  before: number | null,
  complete: boolean,
): string | null {
  // against a period recorded only in part a percentage would mislead (+2653 %)
  if (!complete) return before != null ? t('the period before is only partly recorded') : null;
  const pct = fmtChange(value, before);
  if (!pct) return null;
  const running = dto.from <= dto.now && dto.now < dto.to;
  const text = running
    ? {
        day: t('{pct} vs yesterday at this time', { pct }),
        week: t('{pct} vs last week up to the same time', { pct }),
        month: t('{pct} vs last month up to the same day', { pct }),
        year: t('{pct} vs last year up to the same day', { pct }),
      }[dto.range]
    : {
        day: t('{pct} vs the day before', { pct }),
        week: t('{pct} vs the week before', { pct }),
        month: t('{pct} vs the month before', { pct }),
        year: t('{pct} vs the year before', { pct }),
      }[dto.range];
  return text;
}

export function kindLabel(kind: MeterKind): string {
  return kind === 'gas' ? t('Gas') : kind === 'electricity' ? t('Electricity') : t('Heat delivered');
}

/** The price line under the cost («€1.05 per m³ · €0.30 per kWh»). */
export function priceText(tariffs: EnergyTariffs, kinds: readonly MeterKind[]): string | null {
  const parts: string[] = [];
  if (kinds.includes('gas') && tariffs.gasPrice != null)
    parts.push(t('{price} per {unit}', { price: fmtMoney(tariffs.gasPrice, tariffs.currency), unit: unitLabel(tariffs.gasPriceUnit) }));
  if (kinds.includes('electricity') && tariffs.electricityPerKwh != null)
    parts.push(t('{price} per {unit}', { price: fmtMoney(tariffs.electricityPerKwh, tariffs.currency), unit: unitLabel('kWh') }));
  return parts.length ? parts.join(' · ') : null;
}

/** Whether a price is set for anything the source's meters count. */
export function hasPrice(tariffs: EnergyTariffs, kinds: readonly MeterKind[]): boolean {
  return (kinds.includes('gas') && tariffs.gasPrice != null) || (kinds.includes('electricity') && tariffs.electricityPerKwh != null);
}
