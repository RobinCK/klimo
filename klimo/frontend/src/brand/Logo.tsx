import type { CSSProperties } from 'react';
import { brand, type MarkColors } from './brand.config';

/**
 * The mark is a thermostat scale: a 270° ring, cold half on the left, warm half on the right,
 * the target dot on top and the gap of the scale at the bottom. Small sizes get thicker
 * strokes and a bigger dot so the mark survives a 24 px favicon.
 */

type On = 'auto' | 'dark' | 'light';

/** CSS variables follow the active scheme; explicit schemes use the brand colours directly. */
function colors(on: On): MarkColors {
  if (on === 'auto') {
    return {
      cold: 'var(--brand-cold)',
      warm: 'var(--brand-warm)',
      dot: 'var(--brand-dot)',
      tile: 'var(--brand-tile)',
      tileBorder: 'var(--brand-tile-border)',
    };
  }
  return brand.mark[on];
}

// optical sizes on the 512 grid: stroke, dot radius, knock-out ring, tile border
const OPTICAL = {
  large: { stroke: 54, dot: 40, ring: 22, border: 8 },
  medium: { stroke: 60, dot: 44, ring: 24, border: 10 },
  small: { stroke: 72, dot: 52, ring: 28, border: 0 },
} as const;

export interface LogoMarkProps {
  size: 24 | 28 | 32 | 48 | 96 | 128;
  /** Which tile to draw: follow the active scheme (default) or force one. */
  on?: On;
  /** Accessible name; without it the mark is decorative. */
  title?: string;
}

export function LogoMark({ size, on = 'auto', title }: LogoMarkProps) {
  const c = colors(on);
  const a11y = title ? { role: 'img' as const, 'aria-label': title } : { 'aria-hidden': true as const };

  if (size === 28 || size === 32) {
    // header mini-mark, drawn on its own 32 grid
    return (
      <svg width={size} height={size} viewBox="0 0 32 32" {...a11y} focusable="false" style={{ flex: 'none' }}>
        <rect x="0.5" y="0.5" width="31" height="31" rx="8.6" fill={c.tile} stroke={c.tileBorder} strokeWidth="1" />
        <path d="M9.28 22.72A9.5 9.5 0 0 1 16 6.5" fill="none" stroke={c.cold} strokeWidth="3.4" strokeLinecap="round" />
        <path d="M16 6.5A9.5 9.5 0 0 1 22.72 22.72" fill="none" stroke={c.warm} strokeWidth="3.4" strokeLinecap="round" />
        <circle cx="16" cy="6.5" r="2.7" fill={c.dot} stroke={c.tile} strokeWidth="1.6" />
      </svg>
    );
  }

  const o = size >= 96 ? OPTICAL.large : size >= 48 ? OPTICAL.medium : OPTICAL.small;
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" {...a11y} focusable="false" style={{ flex: 'none' }}>
      {title ? <title>{title}</title> : null}
      <rect width="512" height="512" rx="116" fill={c.tile} stroke={o.border ? c.tileBorder : 'none'} strokeWidth={o.border || undefined} />
      <path d="M149.93 362.07A150 150 0 0 1 256 106" fill="none" stroke={c.cold} strokeWidth={o.stroke} strokeLinecap="round" />
      <path d="M256 106A150 150 0 0 1 362.07 362.07" fill="none" stroke={c.warm} strokeWidth={o.stroke} strokeLinecap="round" />
      <circle cx="256" cy="106" r={o.dot} fill={c.dot} stroke={c.tile} strokeWidth={o.ring} />
    </svg>
  );
}

export interface WordmarkProps {
  /** Font size in px (header 19, phone header 20, about 54). */
  size?: number;
  /** Lockup: the mark replaces the final «o» of the wordmark (the «o» becomes the scale). */
  withMark?: boolean;
  /** What the lockup sits on — the dot's knock-out ring takes that colour. */
  background?: 'page' | 'surface';
}

export function Wordmark({ size = 19, withMark = false, background = 'surface' }: WordmarkProps) {
  const text: CSSProperties = {
    fontSize: size,
    fontWeight: 700,
    letterSpacing: size <= 24 ? '-0.02em' : '-0.037em',
    lineHeight: 1,
    color: 'var(--ui-text-1)',
    whiteSpace: 'nowrap',
  };
  if (!withMark) return <span style={text}>{brand.wordmark}</span>;

  const c = colors('auto');
  const bg = background === 'page' ? 'var(--ui-bg-page)' : 'var(--ui-surface-1)';
  const endsWithO = brand.wordmark.endsWith('o');
  const word = endsWithO ? brand.wordmark.slice(0, -1) : brand.wordmark;
  const mark = Math.round(size * 0.57);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: endsWithO ? 2 : Math.round(size * 0.12) }} aria-label={brand.productName} role="img">
      <span style={text} aria-hidden="true">
        {word}
      </span>
      <svg width={mark} height={mark} viewBox="0 0 56 56" aria-hidden="true" focusable="false" style={{ flex: 'none' }}>
        <path d="M13.15 42.85A21 21 0 0 1 28 7" fill="none" stroke={c.cold} strokeWidth="9.5" strokeLinecap="round" />
        <path d="M28 7A21 21 0 0 1 42.85 42.85" fill="none" stroke={c.warm} strokeWidth="9.5" strokeLinecap="round" />
        <circle cx="28" cy="7" r="6" fill={c.dot} stroke={bg} strokeWidth="3.5" />
      </svg>
    </span>
  );
}
