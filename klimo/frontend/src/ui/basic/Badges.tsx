import type { CSSProperties, ReactNode } from 'react';
import type { Tone } from '../types';
import { toneVar } from '../tokens/vars';
import s from './basic.module.css';

export interface ToneBadgeProps {
  tone: Tone;
  children: ReactNode;
  size?: 'sm' | 'md';
}

/** Small square-ish label in a tone («працює», «резерв», «2 кВт»). */
export function ToneBadge({ tone, children, size = 'md' }: ToneBadgeProps) {
  const style = {
    '--h': size === 'sm' ? '20px' : '24px',
    '--chip-bg': toneVar(tone, 'bg'),
    '--chip-fg': toneVar(tone, 'fg'),
  } as CSSProperties;
  return (
    <span className={s.toneBadge} style={style}>
      {children}
    </span>
  );
}

export interface CountBadgeProps {
  count: number;
  tone: 'warn' | 'err' | 'neutral';
  /** tint: 18 px on the tone background · solid: 16 px pin on a filled tone. */
  variant?: 'tint' | 'solid';
  ariaLabel?: string;
}

/** Counter next to a tab or a title; renders nothing for zero. */
export function CountBadge({ count, tone, variant = 'tint', ariaLabel }: CountBadgeProps) {
  if (!(count > 0)) return null;
  const neutral = tone === 'neutral';
  const style = {
    '--chip-bg': neutral
      ? variant === 'solid'
        ? 'var(--ui-text-2)'
        : 'var(--ui-surface-4)'
      : variant === 'solid'
        ? toneVar(tone, 'solid')
        : toneVar(tone, 'bg'),
    '--chip-fg': neutral
      ? variant === 'solid'
        ? 'var(--ui-bg-page)'
        : 'var(--ui-text-neutral-strong)'
      : variant === 'solid'
        ? toneVar(tone, 'ink')
        : toneVar(tone, 'fg'),
  } as CSSProperties;
  return (
    <span className={s.count} data-variant={variant} style={style} aria-label={ariaLabel}>
      {count > 99 ? '99+' : count}
    </span>
  );
}

export interface MiniTagProps {
  tone?: 'neutral' | 'ok' | 'heat' | 'cool';
  children: ReactNode;
}

/** Tiny uppercase-weight tag («зараз», «рекомендовано», step numbers). */
export function MiniTag({ tone = 'neutral', children }: MiniTagProps) {
  const style = {
    '--chip-bg': tone === 'neutral' ? 'var(--ui-surface-4)' : toneVar(tone, 'bg'),
    '--chip-fg': tone === 'neutral' ? 'var(--ui-text-neutral-strong)' : toneVar(tone, 'fg'),
  } as CSSProperties;
  return (
    <span className={s.miniTag} style={style}>
      {children}
    </span>
  );
}

export interface StatusDotProps {
  tone: Tone;
  size?: 8 | 10 | 12;
  /** Soft halo in the tone (running, live). */
  glow?: boolean;
  /** Knock-out ring in the card colour, for dots placed over other shapes. */
  ring?: boolean;
  label?: string;
}

export function StatusDot({ tone, size = 8, glow, ring, label }: StatusDotProps) {
  const shadows = [ring ? '0 0 0 2px var(--ui-surface-1)' : '', glow ? `0 0 0 ${ring ? 5 : 3}px ${toneVar(tone, 'halo')}` : '']
    .filter(Boolean)
    .join(', ');
  const style = {
    '--size': `${size}px`,
    '--dot': toneVar(tone, 'line'),
    '--dot-shadow': shadows || undefined,
  } as CSSProperties;
  return <span className={s.dot} style={style} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} />;
}
