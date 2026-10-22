import type { ReactNode } from 'react';
import type { IconName, Tone } from '../../types';
import { useUiNav } from '../../UiNavContext';
import { useRouteClick } from '../../shell/Link';
import { Icon } from '../../basic/Icon';
import { StatusDot } from '../../basic/Badges';
import { toneVars } from '../internal/util';
import s from './display.module.css';

/* ---------------- StatTile ---------------- */

export interface StatTileProps {
  title: string;
  icon?: IconName;
  /** State dot on the right; glow while something runs. */
  dot?: { tone: Tone; glow?: boolean };
  value: ReactNode;
  sub?: ReactNode;
  /** The quieter third line («котел — резерв · кондиціонери не потрібні»). */
  others?: ReactNode;
  /** Bottom slot (runtime bar, loop chips, a badge, buttons). */
  footer?: ReactNode;
  /** The whole tile links here. */
  to?: string;
  emphasis?: 'warn';
  /** card: overview tiles · summary: big number (devices) · well: small stats inside a card. */
  variant?: 'card' | 'summary' | 'well';
}

/** A headline number or state with its context. */
export function StatTile({ title, icon, dot, value, sub, others, footer, to, emphasis, variant = 'card' }: StatTileProps) {
  const nav = useUiNav();
  const onClick = useRouteClick(to);
  const content = (
    <>
      <span className={s.tileHead}>
        <span className={s.tileTitle}>
          {icon ? <Icon name={icon} size={18} /> : null}
          {title}
        </span>
        {dot ? <StatusDot tone={dot.tone} size={10} glow={dot.glow} /> : null}
      </span>
      <span className={s.tileValue}>{value}</span>
      {sub != null ? <span className={s.tileSub}>{sub}</span> : null}
      {others != null ? <span className={s.tileOthers}>{others}</span> : null}
      {footer != null ? <span className={s.tileFooter}>{footer}</span> : null}
    </>
  );
  const common = { className: s.tile, 'data-variant': variant, 'data-emphasis': emphasis };
  if (to) {
    return (
      <a {...common} href={nav.href(to)} onClick={onClick}>
        {content}
      </a>
    );
  }
  return <div {...common}>{content}</div>;
}

/* ---------------- BigReadout ---------------- */

export interface BigReadoutProps {
  /** «Зараз · медіана з 3». */
  caption: string;
  /** The big number (a string, or a Temperature in hero size). */
  value: ReactNode;
  /** What sits next to it (the target block). */
  aside?: ReactNode;
}

export function BigReadout({ caption, value, aside }: BigReadoutProps) {
  return (
    <div className={s.readout}>
      <div className={s.readoutMain}>
        <span className={s.readoutCaption}>{caption}</span>
        {typeof value === 'string' ? <span className={s.readoutValue}>{value}</span> : value}
      </div>
      {aside != null ? <div className={s.readoutAside}>{aside}</div> : null}
    </div>
  );
}

/* ---------------- ExplainCallout ---------------- */

export interface ExplainCalloutProps {
  /** «Гріє, бо 19.6° — нижче цілі на 0.4°». */
  title: string;
  text: string;
  /** «Дійде до 20.2° приблизно о 19:40». */
  eta?: string;
  icon?: IconName;
}

/** «Why» box: the reason behind what a room or the plant is doing. */
export function ExplainCallout({ title, text, eta, icon = 'info' }: ExplainCalloutProps) {
  return (
    <div className={s.explain}>
      <Icon name={icon} size={18} />
      <div className={s.explainText}>
        <span className={s.explainTitle}>{title}</span>
        <span className={s.explainBody}>{text}</span>
        {eta ? <span className={s.explainEta}>{eta}</span> : null}
      </div>
    </div>
  );
}

/* ---------------- ConsequencePreview ---------------- */

export interface ConsequencePreviewProps {
  tone: 'heat' | 'cool' | 'off' | 'warn' | 'hold';
  icon: IconName;
  /** «Почнуть гріти 3 кімнати». */
  main: string;
  /** Rooms or details affected. */
  chips?: string[];
}

/** What a change will do before it is applied (profile switch, house mode). */
export function ConsequencePreview({ tone, icon, main, chips }: ConsequencePreviewProps) {
  return (
    <div className={s.consequence} style={toneVars(tone)} data-tone={tone} role="status">
      <Icon name={icon} size={20} />
      <div className={s.consequenceText}>
        <span className={s.consequenceMain}>{main}</span>
        {chips?.length ? (
          <span className={s.consequenceChips}>
            {chips.map((c, i) => (
              <span key={`${c}-${i}`} className={s.consequenceChip}>
                {c}
              </span>
            ))}
          </span>
        ) : null}
      </div>
    </div>
  );
}
