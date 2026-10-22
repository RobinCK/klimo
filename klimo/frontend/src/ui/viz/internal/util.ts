import type { Tone } from '../../types';
import type { BaseTone } from '../../tokens/base';
import { toneVar } from '../../tokens/vars';

/** Joins class names, skipping falsy ones. */
export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(' ');
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export const MINUS = '−';

/** 1 decimal with a typographic minus: −2.5, 19.8. */
export function fmtNum(v: number, decimals = 1): string {
  const s = Math.abs(v).toFixed(decimals);
  return Number(s) === 0 ? s : v < 0 ? `${MINUS}${s}` : s;
}

/** Axis label for a temperature: whole degrees without decimals («18°», «−10°»). */
export function fmtAxisDeg(v: number, unit = '°'): string {
  const decimals = Number.isInteger(Math.round(v * 10) / 10) ? 0 : 1;
  return `${fmtNum(v, decimals)}${unit}`;
}

/** Signed axis label for outdoor scales («−20°», «0°», «+15°»). */
export function fmtSignedDeg(v: number, unit = '°'): string {
  return v > 0 ? `+${fmtAxisDeg(v, unit)}` : fmtAxisDeg(v, unit);
}

/** 450 → "07:30"; 1440 → "24:00". */
export function hhmm(minute: number): string {
  const v = clamp(Math.round(minute), 0, 1440);
  return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
}

/** A percentage for absolute positioning, short enough to keep the DOM readable. */
export function pct(v: number): string {
  return `${Number(v.toFixed(3))}%`;
}

/** Colour of a chart mark: a tone's line, or a deeper shade of it for a second series of the same tone. */
export type VizColor = Tone | `${BaseTone}-deep`;

export function vizColor(c: VizColor): string {
  if (c.endsWith('-deep')) {
    const tone = c.slice(0, -5) as Tone;
    return `color-mix(in oklab, ${toneVar(tone, 'line')} 72%, black)`;
  }
  return toneVar(c as Tone, 'line');
}

/** Fill for a run span on a timeline: running hardware in its tone; neutral work (pumps) in secondary ink. */
export function spanFill(tone: Tone): { fill: string; ink: string } {
  if (tone === 'hold' || tone === 'mixed') return { fill: 'var(--ui-text-2)', ink: 'var(--ui-bg-page)' };
  if (tone === 'off' || tone === 'idle') return { fill: 'var(--ui-control-off)', ink: 'var(--ui-text-1)' };
  return { fill: toneVar(tone, 'solid'), ink: toneVar(tone, 'ink') };
}

export interface AxisTick {
  /** Position along the axis, 0..100 %. */
  at: number;
  label: string;
  anchor: 'start' | 'center' | 'end';
}

/**
 * Which tick labels fit on an axis `width` px wide without touching: the first and the last
 * always stay, the ones in between only where there is room (labels are ~6.6 px per glyph at
 * the 11 px mono axis size). Before the width is known everything is shown.
 */
export function visibleTicks(ticks: readonly AxisTick[], width: number): boolean[] {
  if (width <= 0 || ticks.length <= 2) return ticks.map(() => true);
  const span = (t: AxisTick): [number, number] => {
    const w = t.label.length * 6.6;
    const x = (t.at / 100) * width;
    return t.anchor === 'start' ? [x, x + w] : t.anchor === 'end' ? [x - w, x] : [x - w / 2, x + w / 2];
  };
  const show = ticks.map(() => false);
  const last = span(ticks[ticks.length - 1]);
  show[0] = true;
  show[ticks.length - 1] = true;
  let prevEnd = span(ticks[0])[1];
  for (let i = 1; i < ticks.length - 1; i++) {
    const [x0, x1] = span(ticks[i]);
    if (x0 >= prevEnd + 8 && x1 + 8 <= last[0]) {
      show[i] = true;
      prevEnd = x1;
    }
  }
  return show;
}
