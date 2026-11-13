import type { ReactNode } from 'react';
import type { IconName } from '../types';
import { Icon } from '../basic/Icon';
import { useUiNav } from '../UiNavContext';
import { useRouteClick } from './Link';
import s from './shell.module.css';

export interface PageProps {
  /** A quiet line above the title (the date on the overview). */
  eyebrow?: ReactNode;
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
export function Page({ eyebrow, title, subtitle, actions, subnav, children }: PageProps) {
  const hasHead = eyebrow != null || title != null || subtitle != null || actions != null;
  return (
    <div className={s.page}>
      {hasHead ? (
        <div className={s.pageHead}>
          <div className={s.pageTitles}>
            {eyebrow != null ? <span className={s.pageEyebrow}>{eyebrow}</span> : null}
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

export interface SideNavItem {
  key: string;
  label: string;
  /** A live one-line summary under the label («медіана · 3 · 19.8°»). */
  hint?: string;
  icon?: IconName;
  to: string;
}

export interface SideNavProps {
  items: SideNavItem[];
  current: string;
  ariaLabel: string;
}

function SideNavLink({ item, active }: { item: SideNavItem; active: boolean }) {
  const nav = useUiNav();
  const onClick = useRouteClick(item.to);
  return (
    <a className={s.sideLink} href={nav.href(item.to)} aria-current={active ? 'page' : undefined} onClick={onClick}>
      {item.icon ? (
        <span className={s.sideIcon} aria-hidden="true">
          <Icon name={item.icon} size={18} />
        </span>
      ) : null}
      <span className={s.sideText}>
        <span className={s.sideLabel}>{item.label}</span>
        {item.hint ? <span className={s.sideHint}>{item.hint}</span> : null}
      </span>
    </a>
  );
}

/** The parts of a long page as a vertical list beside it (a room's settings): one is shown at a time. */
export function SideNav({ items, current, ariaLabel }: SideNavProps) {
  return (
    <nav className={s.sideNav} aria-label={ariaLabel}>
      {items.map((i) => (
        <SideNavLink key={i.key} item={i} active={i.key === current} />
      ))}
    </nav>
  );
}
