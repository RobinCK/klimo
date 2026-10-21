import type { ReactNode } from 'react';
import { useUiNav } from '../UiNavContext';
import { useRouteClick } from './Link';
import s from './shell.module.css';

export interface PageProps {
  title?: ReactNode;
  /** One line under the title (date, summary). */
  subtitle?: ReactNode;
  /** Buttons on the right of the title row. */
  actions?: ReactNode;
  /** Section tabs under the header (System: schema · sources · strategy). */
  subnav?: ReactNode;
  children: ReactNode;
}

/** A routed page: optional header row, sub-navigation, then the sections in a vertical rhythm. */
export function Page({ title, subtitle, actions, subnav, children }: PageProps) {
  const hasHead = title != null || subtitle != null || actions != null;
  return (
    <div className={s.page}>
      {hasHead ? (
        <div className={s.pageHead}>
          <div className={s.pageTitles}>
            {title != null ? <h1>{title}</h1> : null}
            {subtitle != null ? <span className={s.pageSubtitle}>{subtitle}</span> : null}
          </div>
          {actions ? <div className={s.pageActions}>{actions}</div> : null}
        </div>
      ) : null}
      {subnav}
      {children}
    </div>
  );
}

function SubNavItem({ to, label, active }: { to: string; label: string; active: boolean }) {
  const nav = useUiNav();
  const onClick = useRouteClick(to);
  return (
    <a className={s.navLink} href={nav.href(to)} aria-current={active ? 'page' : undefined} onClick={onClick}>
      {label}
    </a>
  );
}

export interface SubNavProps {
  items: { key: string; label: string; to: string }[];
  current: string;
  ariaLabel: string;
}

/** Secondary tabs inside a page; scrolls sideways when it does not fit. */
export function SubNav({ items, current, ariaLabel }: SubNavProps) {
  return (
    <nav className={s.subNav} aria-label={ariaLabel}>
      {items.map((i) => (
        <SubNavItem key={i.key} to={i.to} label={i.label} active={i.key === current} />
      ))}
    </nav>
  );
}
