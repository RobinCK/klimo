import type { CSSProperties, MouseEvent } from 'react';
import type { IconName } from '../types';
import { useUiNav } from '../UiNavContext';
import { useRouteClick } from '../shell/Link';
import { Icon, type IconSize } from './Icon';
import s from './basic.module.css';

export interface IconButtonProps {
  icon: IconName;
  /** Accessible name (also the tooltip). */
  label: string;
  size?: 36 | 40 | 44 | 48;
  /** surface: filled square · ghost: bare · round: outlined circle (−/+ steppers). */
  variant?: 'surface' | 'ghost' | 'round';
  onClick?: () => void;
  to?: string;
  disabled?: boolean;
  pressed?: boolean;
}

const GLYPH: Record<NonNullable<IconButtonProps['size']>, IconSize> = { 36: 18, 40: 18, 44: 20, 48: 22 };

export function IconButton({ icon, label, size = 40, variant = 'surface', onClick, to, disabled, pressed }: IconButtonProps) {
  const nav = useUiNav();
  const routeClick = useRouteClick(to);
  const common = {
    className: s.iconButton,
    'data-variant': variant,
    'data-size': String(size),
    'aria-label': label,
    title: label,
    'aria-disabled': disabled || undefined,
    style: { '--size': `${size}px` } as CSSProperties,
  };
  const glyph = <Icon name={icon} size={GLYPH[size]} />;
  if (to && !disabled) {
    return (
      <a
        {...common}
        href={nav.href(to)}
        onClick={(e: MouseEvent<HTMLAnchorElement>) => {
          onClick?.();
          routeClick(e);
        }}
      >
        {glyph}
      </a>
    );
  }
  return (
    <button
      {...common}
      type="button"
      aria-pressed={pressed}
      onClick={(e) => {
        if (disabled) {
          e.preventDefault();
          return;
        }
        onClick?.();
      }}
    >
      {glyph}
    </button>
  );
}
