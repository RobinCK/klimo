import type { CSSProperties, ReactNode } from 'react';
import type { Tone } from '../../types';
import { toneVar } from '../../tokens/vars';
import { useUiText } from '../../UiTextContext';
import { useUiNav } from '../../UiNavContext';
import { useRouteClick } from '../../shell/Link';
import { Icon } from '../../basic/Icon';
import s from './rows.module.css';

/* ---------------------------------- ActivityLog ---------------------------------- */

export interface ActivityLogProps {
  rows: readonly {
    /** «19:00», «вчора 16:14». */
    time: string;
    dot: Tone;
    title: string;
    /** Where it went («телефон, Telegram · я»). */
    where: string;
    /** Delivery state («доставлено», «"Бачу" о 16:07»). */
    state: string;
    /** Not sent yet / skipped: quieter state text. */
    muted?: boolean;
  }[];
  emptyText?: string;
}

/** Recently sent notifications. */
export function ActivityLog({ rows, emptyText }: ActivityLogProps) {
  if (!rows.length) return emptyText ? <p className={s.empty}>{emptyText}</p> : null;
  return (
    <ul className={s.log}>
      {rows.map((r, i) => (
        <li key={`${r.time}-${i}`} className={s.activity} style={{ '--dot': toneVar(r.dot, 'line') } as CSSProperties}>
          <span className={s.logTime}>{r.time}</span>
          <span className={s.logDot} aria-hidden="true" />
          <span className={s.rowText}>
            <span className={s.logTitle}>{r.title}</span>
            <span className={s.rowSubLg}>{r.where}</span>
          </span>
          <span className={s.activityState} data-muted={r.muted ? '' : undefined}>
            {r.state}
          </span>
        </li>
      ))}
    </ul>
  );
}

/* ---------------------------------- DecisionLog ---------------------------------- */

export interface DecisionLogRow {
  time: string;
  tone: Tone;
  /** «Тепловий насос: гріти». */
  title: string;
  /** Why, in one or two sentences. */
  why: string;
  /** Where the entry leads (the room, the device). */
  to?: string;
}

export interface DecisionLogProps {
  rows: readonly DecisionLogRow[];
  /** Category filter (a SegmentedControl from the page), drawn above the list. */
  filter?: ReactNode;
  emptyText?: string;
}

function DecisionItem({ row }: { row: DecisionLogRow }) {
  const nav = useUiNav();
  const onClick = useRouteClick(row.to);
  const body = (
    <>
      <span className={s.logTime} data-wide="">
        {row.time}
      </span>
      <span className={s.logDot} aria-hidden="true" />
      <span className={s.rowText}>
        <span className={s.logTitle}>{row.title}</span>
        <span className={s.rowSubLg}>{row.why}</span>
      </span>
    </>
  );
  return (
    <li className={s.decision} style={{ '--dot': toneVar(row.tone, 'line') } as CSSProperties}>
      {row.to ? (
        <a className={s.decisionLink} href={nav.href(row.to)} onClick={onClick}>
          {body}
          <span className={s.chevron} aria-hidden="true">
            <Icon name="chevronRight" size={16} />
          </span>
        </a>
      ) : (
        <span className={s.decisionBody}>{body}</span>
      )}
    </li>
  );
}

/** What the system decided and why («Журнал рішень»), newest first. */
export function DecisionLog({ rows, filter, emptyText }: DecisionLogProps) {
  return (
    <div className={s.decisions}>
      {filter ? <div className={s.logFilter}>{filter}</div> : null}
      {rows.length ? (
        <ol className={s.log}>
          {rows.map((r, i) => (
            <DecisionItem key={`${r.time}-${r.title}-${i}`} row={r} />
          ))}
        </ol>
      ) : emptyText ? (
        <p className={s.empty}>{emptyText}</p>
      ) : null}
    </div>
  );
}

/* ---------------------------------- NotificationPreview ---------------------------------- */

export interface NotificationPreviewProps {
  push?: {
    /** «Push на телефон · критичне». */
    label?: string;
    /** The app shown in the notification header («Home Assistant»). */
    app: string;
    /** App icon (the brand mark); a bell when omitted. */
    icon?: ReactNode;
    time?: string;
    title: string;
    body: string;
    actions: readonly string[];
    caption: string;
  };
  telegram?: {
    label?: string;
    sender: string;
    /** First line is the headline, the rest secondary. */
    lines: readonly string[];
    /** Inline keyboard: rows of button labels. */
    buttons: readonly (readonly string[])[];
    time: string;
    caption: string;
  };
}

/** How a notification will look on a phone and in Telegram (static mock-ups, not live). */
export function NotificationPreview({ push, telegram }: NotificationPreviewProps) {
  const ut = useUiText();
  return (
    <div className={s.previews}>
      {push ? (
        <div className={s.preview}>
          {push.label ? <span className={s.previewLabel}>{push.label}</span> : null}
          <div className={s.push} role="img" aria-label={`${push.app}: ${push.title}. ${push.body}`}>
            <div className={s.pushHead}>
              <span className={s.pushIcon}>{push.icon ?? <Icon name="bell" size={14} />}</span>
              <span className={s.pushApp}>{push.app}</span>
              <span>{push.time ?? ut('now')}</span>
            </div>
            <span className={s.pushText}>
              <span className={s.pushTitle}>{push.title}</span>
              <span className={s.pushBody}>{push.body}</span>
            </span>
            {push.actions.length ? (
              <div className={s.pushActions}>
                {push.actions.map((a, i) => (
                  <span key={`${a}-${i}`} className={s.pushAction}>
                    {a}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
          <span className={s.previewCaption}>{push.caption}</span>
        </div>
      ) : null}
      {telegram ? (
        <div className={s.preview}>
          {telegram.label ? <span className={s.previewLabel}>{telegram.label}</span> : null}
          <div className={s.tg} role="img" aria-label={`${telegram.sender}: ${telegram.lines.join(' ')}`}>
            <div className={s.tgBubble}>
              <span className={s.tgSender}>{telegram.sender}</span>
              {telegram.lines.map((l, i) => (
                <span key={i} className={i === 0 ? s.tgLead : s.tgLine}>
                  {l}
                </span>
              ))}
              <span className={s.tgTime}>{telegram.time}</span>
            </div>
            {telegram.buttons.map((row, r) => (
              <div key={r} className={s.tgButtons} style={{ '--cols': row.length } as CSSProperties}>
                {row.map((b, i) => (
                  <span key={`${b}-${i}`} className={s.tgButton}>
                    {b}
                  </span>
                ))}
              </div>
            ))}
          </div>
          <span className={s.previewCaption}>{telegram.caption}</span>
        </div>
      ) : null}
    </div>
  );
}
