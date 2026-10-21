import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from 'react';
import { useUiNav } from '../UiNavContext';
import s from './shell.module.css';

/**
 * Click handler for in-app anchors: a plain left click navigates through UiNavContext (so a
 * leave guard can intervene); modified clicks keep the browser behaviour (new tab, copy link).
 */
export function useRouteClick(to: string | undefined, onClick?: (e: MouseEvent<HTMLAnchorElement>) => void) {
  const nav = useUiNav();
  return (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (!to || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    nav.navigate(to);
  };
}

export interface LinkProps {
  to: string;
  children: ReactNode;
  ariaLabel?: string;
  /** inline: underlined text link · muted: secondary text · block: a whole card/row is the link · plain: no styling. */
  variant?: 'plain' | 'inline' | 'muted' | 'block';
  ariaCurrent?: AnchorHTMLAttributes<HTMLAnchorElement>['aria-current'];
}

/** In-app link: `to` is a route such as `/rooms/living`. */
export function Link({ to, children, ariaLabel, variant = 'plain', ariaCurrent }: LinkProps) {
  const nav = useUiNav();
  const onClick = useRouteClick(to);
  return (
    <a
      className={s.link}
      data-variant={variant}
      href={nav.href(to)}
      aria-label={ariaLabel}
      aria-current={ariaCurrent}
      onClick={onClick}
    >
      {children}
    </a>
  );
}
