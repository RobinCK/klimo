/**
 * How a stepped number is shown and typed: as many decimals as its step has, so every press
 * changes what is on screen. Shared by the kit steppers, the value pill and the target stepper.
 */

/** Number of decimals a step implies (0.5 → 1, 0.05 → 2, 30 → 0). */
export function decimalsOf(step: number): number {
  const s = String(step);
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}

/**
 * Decimals to show `value` with: `decimals` or the step's own, more while the value sits off
 * that grid (30.1 kW left by an older, finer step reads «30.1», not «30»), at most `most`.
 */
export function shownDecimals(value: number, step: number, decimals?: number, most = 3): number {
  const d = decimals ?? decimalsOf(step);
  for (let k = d; k <= most; k++) if (Math.abs(Number(value.toFixed(k)) - value) < 1e-9) return k;
  return Math.max(d, most);
}

export interface NumberSpan {
  start: number;
  end: number;
  decimals: number;
  /** The decimal separator the text uses. */
  sep: string;
}

const NUMBER = /\d+(?:[.,]\d+)?/g;

/**
 * Where `text` shows `value`, sign aside: the first number that rounds to it at its own
 * precision («30 кВт» for 30.1, «−0.3°» for 0.3). Null when the text shows something else
 * («1 год 40 хв» for 100 minutes, °F for a °C value).
 */
export function findNumber(text: string, value: number): NumberSpan | null {
  const abs = Math.abs(value);
  for (const m of text.matchAll(NUMBER)) {
    const raw = m[0];
    const frac = raw.split(/[.,]/)[1] ?? '';
    if (Math.abs(Number(raw.replace(',', '.')) - abs) <= 0.5 * 10 ** -frac.length + 1e-9) {
      return { start: m.index ?? 0, end: (m.index ?? 0) + raw.length, decimals: frac.length, sep: raw.includes(',') ? ',' : '.' };
    }
  }
  return null;
}

/** `text` with the number that stands for `value` written with at least `decimals` digits. */
export function withDecimals(text: string, value: number, decimals: number): string {
  const at = findNumber(text, value);
  if (!at || at.decimals >= decimals) return text;
  return text.slice(0, at.start) + Math.abs(value).toFixed(decimals).replace('.', at.sep) + text.slice(at.end);
}

/** A typed number: «21,5», «−3», «2.5 кВт» (a unit typed along is ignored); null when it is not one. */
export function parseTyped(raw: string): number | null {
  const t = raw.replace(/\s+/g, '').replace(/[−–]/g, '-').replace(',', '.');
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+))\D*$/.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** A typed clock time in minutes: «7:30», «07.30», «730», «7» (whole hours), «24:00»; null otherwise. */
export function parseTypedTime(raw: string): number | null {
  const m = /^(\d{1,2})(?:[:.,]?(\d{2}))?$/.exec(raw.replace(/\s+/g, ''));
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (h > 24 || min > 59 || (h === 24 && min > 0)) return null;
  return h * 60 + min;
}
