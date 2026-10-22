import { useUiNav } from '../../UiNavContext';
import { useRouteClick } from '../../shell/Link';
import { Icon } from '../../basic/Icon';
import { StatusDot } from '../../basic/Badges';
import { toneVars } from '../internal/util';
import s from './display.module.css';

export interface SeasonPillProps {
  tone: 'heat' | 'cool' | 'off';
  /** «Авто · опалення». */
  label: string;
  /** outline in the desktop header, filled (tinted) on phones. */
  variant: 'outline' | 'filled';
  to: string;
}

/** The house mode and season in the header; opens the System page. */
export function SeasonPill({ tone, label, variant, to }: SeasonPillProps) {
  const nav = useUiNav();
  const onClick = useRouteClick(to);
  return (
    <a className={s.season} data-variant={variant} style={toneVars(tone)} href={nav.href(to)} onClick={onClick}>
      <StatusDot tone={tone} size={8} />
      {label}
    </a>
  );
}

export interface NotificationBellProps {
  count: number;
  to: string;
  /** Accessible name, including the count («Сповіщення, 2 нові»). */
  label: string;
}

/** Bell with an unread dot (phone top bars). */
export function NotificationBell({ count, to, label }: NotificationBellProps) {
  const nav = useUiNav();
  const onClick = useRouteClick(to);
  return (
    <a className={s.bell} href={nav.href(to)} aria-label={label} title={label} onClick={onClick}>
      <Icon name="bell" size={22} />
      {count > 0 ? (
        <span className={s.bellDot}>
          <StatusDot tone="warn" size={8} ring />
        </span>
      ) : null}
    </a>
  );
}
