import type { CSSProperties } from 'react';
import type { Tone } from '../../types';
import { toneVar } from '../../tokens/vars';

/** Joins class names, skipping falsy ones. */
export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(' ');
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Number of decimals a step implies (0.5 → 1, 0.05 → 2, 30 → 0). */
export function decimalsOf(step: number): number {
  const s = String(step);
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}

/**
 * Snaps to the step grid anchored at `min` and drops float noise, so 0.1 + 0.2 never shows
 * up as 0.30000000000000004 in a tolerance stepper.
 */
export function snap(v: number, step: number, min: number): number {
  const n = Math.round((v - min) / step);
  return Number((min + n * step).toFixed(decimalsOf(step)));
}

/** CSS variables for a tone tint: `--tone-bg`, `--tone-fg`, `--tone-line`. */
export function toneVars(tone: Tone, prefix = 'tone'): CSSProperties {
  return {
    [`--${prefix}-bg`]: toneVar(tone, 'bg'),
    [`--${prefix}-fg`]: toneVar(tone, 'fg'),
    [`--${prefix}-line`]: toneVar(tone, 'line'),
  } as CSSProperties;
}

/** "07:30" → 450. Malformed input reads as 0. */
export function hhmmToMinutes(v: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return 0;
  return clamp(Number(m[1]), 0, 24) * 60 + clamp(Number(m[2]), 0, 59);
}

/** 450 → "07:30"; 1440 stays "24:00" (end of day). */
export function minutesToHhmm(min: number): string {
  const v = clamp(Math.round(min), 0, 1440);
  return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
}
