/**
 * Amounts of what sources used and what it cost: «1.54 m³», «29.1 kWh», «€7.06» / «7.06 ₴»,
 * «−31%». Shared by the source page, the overview tile and the settings.
 */
import { lang, t } from './core';
import { fmtNum } from './format';

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
