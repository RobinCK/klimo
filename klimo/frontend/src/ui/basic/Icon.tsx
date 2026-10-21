import type { CSSProperties } from 'react';
import type { IconName, Tone } from '../types';
import { ICON_PATHS } from '../icons/paths';
import { toneVar } from '../tokens/vars';
import s from './basic.module.css';

export type IconSize = 14 | 15 | 16 | 18 | 20 | 22 | 24 | 28;

export interface IconProps {
  name: IconName;
  size?: IconSize;
  /** Tone line colour, 'muted' (tertiary text) or 'current' (inherit; default). */
  tone?: Tone | 'muted' | 'current';
  /** Accessible name; without it the icon is decorative. */
  title?: string;
}

// small checks and chevrons read thin at 2px, the brand draws them at 2.2
const HEAVY = new Set<IconName>(['check', 'chevronDown', 'chevronLeft', 'chevronRight']);

export function iconColor(tone: IconProps['tone']): string | undefined {
  if (!tone || tone === 'current') return undefined;
  if (tone === 'muted') return 'var(--ui-text-3)';
  return toneVar(tone, 'line');
}

/** One stroke glyph from the shared icon set. */
export function Icon({ name, size = 18, tone, title }: IconProps) {
  const color = iconColor(tone);
  return (
    <svg
      className={s.icon}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={HEAVY.has(name) && size <= 16 ? 2.2 : 2}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      style={color ? ({ '--icon-color': color } as CSSProperties) : undefined}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

export interface IconTileProps {
  icon: IconName;
  size?: 28 | 32 | 36 | 40 | 48 | 52;
  /** Tone tint (bg + fg) or a neutral surface. */
  tone?: Tone | 'neutral';
  /** Explicit colours, e.g. a profile colour and its ink (wins over `tone`). */
  color?: { bg: string; fg: string };
  title?: string;
}

/** Rounded square with an icon: profile tiles, source avatars, list leading icons. */
export function IconTile({ icon, size = 36, tone = 'neutral', color, title }: IconTileProps) {
  const glyph: IconSize = size <= 32 ? 16 : size <= 40 ? 18 : 22;
  const bg = color?.bg ?? (tone === 'neutral' ? 'var(--ui-surface-2)' : toneVar(tone, 'bg'));
  const fg = color?.fg ?? (tone === 'neutral' ? 'var(--ui-text-1)' : toneVar(tone, 'fg'));
  const style = {
    '--size': `${size}px`,
    '--radius': `${Math.round(size * 0.28)}px`,
    '--tile-bg': bg,
    '--tile-fg': fg,
  } as CSSProperties;
  return (
    <span className={s.tile} style={style}>
      <Icon name={icon} size={glyph} title={title} />
    </span>
  );
}
