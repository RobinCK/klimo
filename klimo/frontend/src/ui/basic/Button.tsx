import type { MouseEvent, ReactNode } from 'react';
import type { IconName } from '../types';
import { useUiNav } from '../UiNavContext';
import { useRouteClick } from '../shell/Link';
import { Icon } from './Icon';
import s from './basic.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger' | 'link';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'xl';

export interface ButtonProps {
  variant: ButtonVariant;
  /** sm 40 · md 44 · lg 48 · xl 52 px (sm grows to 44 on phones). */
  size?: ButtonSize;
  icon?: IconName;
  iconRight?: IconName;
  fullWidth?: boolean;
  loading?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  /** Route: renders a link. */
  to?: string;
  type?: 'button' | 'submit';
  /** Accessible name when the visible text is not enough. */
  ariaLabel?: string;
  children: ReactNode;
}

const ICON_SIZE = { sm: 16, md: 16, lg: 18, xl: 18 } as const;

/**
 * Actions are neutral: a primary button is ink-on-paper, never orange or blue — those colours
 * mean heat and cold. There is deliberately no tone prop.
 */
export function Button({
  variant,
  size = 'md',
  icon,
  iconRight,
  fullWidth,
  loading,
  disabled,
  onClick,
  to,
  type = 'button',
  ariaLabel,
  children,
}: ButtonProps) {
  const nav = useUiNav();
  const inert = Boolean(disabled || loading);
  const routeClick = useRouteClick(to);
  const glyph = ICON_SIZE[size];
  const content = (
    <>
      {icon ? <Icon name={icon} size={glyph} /> : null}
      <span>{children}</span>
      {iconRight ? <Icon name={iconRight} size={glyph} /> : null}
      {loading ? <span className={s.spinner} aria-hidden="true" /> : null}
    </>
  );
  const common = {
    className: s.button,
    'data-variant': variant,
    'data-size': size,
    'data-full': fullWidth ? '' : undefined,
    'data-loading': loading ? '' : undefined,
    'aria-disabled': inert || undefined,
    'aria-busy': loading || undefined,
    'aria-label': ariaLabel,
  };

  if (to && !inert) {
    return (
      <a
        {...common}
        href={nav.href(to)}
        onClick={(e: MouseEvent<HTMLAnchorElement>) => {
          onClick?.();
          routeClick(e);
        }}
      >
        {content}
      </a>
    );
  }
  return (
    <button
      {...common}
      type={type}
      onClick={(e) => {
        if (inert) {
          e.preventDefault();
          return;
        }
        onClick?.();
      }}
    >
      {content}
    </button>
  );
}
