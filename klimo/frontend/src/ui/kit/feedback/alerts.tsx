import type { Action, IconName } from '../../types';
import { useUiNav } from '../../UiNavContext';
import { useRouteClick } from '../../shell/Link';
import { Icon } from '../../basic/Icon';
import { ActionButton } from '../internal/ActionButton';
import { toneVars } from '../internal/util';
import s from './feedback.module.css';

/* ---------------- AttentionBanner ---------------- */

export interface AttentionBannerProps {
  /** «5 потребують уваги». */
  title: string;
  /** The first issues in one line («Спальня: вікно відкрите 12 хв · Дитяча: вологість 67%»). */
  summary: string;
  to: string;
}

/** Phone overview: one warm line that leads to the attention list. */
export function AttentionBanner({ title, summary, to }: AttentionBannerProps) {
  const nav = useUiNav();
  const onClick = useRouteClick(to);
  return (
    <a className={s.attention} href={nav.href(to)} onClick={onClick}>
      <Icon name="alert" size={20} />
      <span className={s.attentionText}>
        <span className={s.attentionTitle}>{title}</span>
        <span className={s.attentionSummary}>{summary}</span>
      </span>
      <Icon name="chevronRight" size={18} />
    </a>
  );
}

/* ---------------- AlertCard ---------------- */

export interface AlertCardProps {
  tone: 'warn' | 'err';
  icon: IconName;
  title: string;
  text: string;
  /** Go and fix («Відкрити кімнату»). */
  primary: Action;
  /** Quiet dismissal («Сховати на 30 хв»). */
  secondary: Action;
}

/** One problem on the overview with what to do about it. */
export function AlertCard({ tone, icon, title, text, primary, secondary }: AlertCardProps) {
  return (
    <div className={s.card} style={toneVars(tone)}>
      <span className={s.cardIcon}>
        <Icon name={icon} size={18} />
      </span>
      <div className={s.cardText}>
        <span className={s.cardTitle}>{title}</span>
        <span className={s.cardBody}>{text}</span>
        <span className={s.cardActions}>
          <ActionButton action={primary} variant="secondary" size="sm" />
          <ActionButton action={secondary} variant="ghost" size="sm" />
        </span>
      </div>
    </div>
  );
}

/* ---------------- InboxCard ---------------- */

export interface InboxCardProps {
  /** «19:04», «вчора». */
  time: string;
  tone: 'warn' | 'err' | 'ok';
  icon: IconName;
  title: string;
  text: string;
  /** Message buttons; they act immediately. */
  actions: Action[];
  /** After an action: what was done («Виключено з розрахунку»); the buttons go away. */
  resolved?: string | boolean;
}

/** An open notification in the phone inbox. */
export function InboxCard({ time, tone, icon, title, text, actions, resolved }: InboxCardProps) {
  const done = Boolean(resolved);
  return (
    <div className={s.inbox} data-resolved={done ? '' : undefined} style={toneVars(done ? 'ok' : tone)}>
      <div className={s.inboxHead}>
        <span className={s.cardIcon}>
          <Icon name={done ? 'check' : icon} size={16} />
        </span>
        <span className={s.cardText}>
          <span className={s.cardTitle}>{title}</span>
          <span className={s.cardBody}>{text}</span>
        </span>
        <span className={s.inboxTime}>{time}</span>
      </div>
      {done ? (
        typeof resolved === 'string' ? (
          <span className={s.inboxResolved} role="status">
            <Icon name="check" size={14} />
            {resolved}
          </span>
        ) : null
      ) : actions.length ? (
        <div className={s.inboxActions}>
          {actions.map((a, i) => (
            <ActionButton key={`${a.label}-${i}`} action={a} variant="secondary" size="sm" />
          ))}
        </div>
      ) : null}
    </div>
  );
}
