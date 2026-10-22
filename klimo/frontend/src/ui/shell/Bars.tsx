import type { CSSProperties, ReactNode } from 'react';
import type { IconName, NavItem } from '../types';
import { useUiText } from '../UiTextContext';
import { useUiNav } from '../UiNavContext';
import { Icon } from '../basic/Icon';
import { CountBadge } from '../basic/Badges';
import { IconButton } from '../basic/IconButton';
import { useRouteClick } from './Link';
import s from './shell.module.css';

function NavAnchor({ item, current, className, children }: { item: NavItem; current: string; className: string; children: ReactNode }) {
  const nav = useUiNav();
  const onClick = useRouteClick(item.to);
  const ut = useUiText();
  const badge = item.badge && item.badge.count > 0 ? item.badge : null;
  return (
    <a
      className={className}
      href={nav.href(item.to)}
      aria-current={item.key === current ? 'page' : undefined}
      aria-label={badge ? ut('{label}, {count} need attention', { label: item.label, count: badge.count }) : undefined}
      onClick={onClick}
    >
      {children}
    </a>
  );
}

export interface TopBarProps {
  logo: ReactNode;
  items: NavItem[];
  /** Key of the active item. */
  current: string;
  right?: ReactNode;
}

/** Desktop and tablet header: logo, section tabs, and a right-hand slot (season pill, settings). */
export function TopBar({ logo, items, current, right }: TopBarProps) {
  const ut = useUiText();
  return (
    <header className={s.topBar}>
      <div className={s.topInner}>
        <div className={s.logo}>{logo}</div>
        <nav className={s.nav} aria-label={ut('Sections')}>
          {items.map((item) => (
            <NavAnchor key={item.key} item={item} current={current} className={s.navLink}>
              {item.label}
              {item.badge && item.badge.count > 0 ? <CountBadge count={item.badge.count} tone={item.badge.tone} /> : null}
            </NavAnchor>
          ))}
        </nav>
        {right ? <div className={s.topRight}>{right}</div> : null}
      </div>
    </header>
  );
}

export interface BottomTabBarProps {
  items: NavItem[];
  current: string;
}

/** Phone navigation: icon + label tabs pinned to the bottom edge. */
export function BottomTabBar({ items, current }: BottomTabBarProps) {
  const ut = useUiText();
  return (
    <nav className={s.tabBar} aria-label={ut('Navigation')} style={{ '--tabs': items.length } as CSSProperties}>
      {items.map((item) => (
        <NavAnchor key={item.key} item={item} current={current} className={s.tab}>
          <Icon name={item.icon} size={22} />
          {item.label}
          {item.badge && item.badge.count > 0 ? (
            <span className={s.tabBadge}>
              <CountBadge count={item.badge.count} tone={item.badge.tone} variant="solid" />
            </span>
          ) : null}
        </NavAnchor>
      ))}
    </nav>
  );
}

export interface MobileTopBarProps {
  title: string;
  subtitle?: { icon?: IconName; text: string; strong?: boolean };
  onBack?: () => void;
  right?: ReactNode;
  /** center: the title sits in the middle between the back button and the actions (a room, the inbox). */
  align?: 'start' | 'center';
}

/** Phone page header: optional back button, title with a status line, right-hand actions. */
export function MobileTopBar({ title, subtitle, onBack, right, align = 'start' }: MobileTopBarProps) {
  const ut = useUiText();
  const center = align === 'center';
  // a centred title needs the same width on both sides of it
  const spacer = <span className={s.mobileSpacer} aria-hidden="true" />;
  return (
    <div className={s.mobileTop} data-align={align}>
      {onBack ? <IconButton icon="chevronLeft" label={ut('Back')} variant="ghost" size={44} onClick={onBack} /> : center && right ? spacer : null}
      <div className={s.mobileTitle}>
        <h1>{title}</h1>
        {subtitle ? (
          <span className={s.mobileSub} data-strong={subtitle.strong ? '' : undefined}>
            {subtitle.icon ? <Icon name={subtitle.icon} size={14} /> : null}
            <span>{subtitle.text}</span>
          </span>
        ) : null}
      </div>
      {right ? <div className={s.mobileRight}>{right}</div> : center && onBack ? spacer : null}
    </div>
  );
}
