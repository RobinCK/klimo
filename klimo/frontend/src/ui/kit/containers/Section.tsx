import { useId, type ReactNode } from 'react';
import type { IconName } from '../../types';
import { IconTile } from '../../basic/Icon';
import s from './containers.module.css';

export interface SectionProps {
  id?: string;
  title?: ReactNode;
  subtitle?: ReactNode;
  /** Buttons or a link on the right of the header. */
  action?: ReactNode;
  /** Quiet extra next to the title (a count, a badge). */
  tag?: ReactNode;
  /** heat/cool: tinted border (strategy cards, mode panels) · danger: red outline · emphasis: open editor. */
  accent?: 'heat' | 'cool' | 'danger' | 'emphasis';
  /** card: page section · well: inset block inside a card · plain: header and flow only. */
  variant?: 'card' | 'well' | 'plain';
  /** Leading icon tile, tinted by the accent. */
  icon?: IconName;
  /** Upper-case tone label instead of a heading («ОПАЛЕННЯ» inside a mode panel). */
  overline?: string;
  /** Heading level (2 for page sections, 3 inside another section). */
  level?: 2 | 3;
  /** Accessible name when there is no visible title. */
  ariaLabel?: string;
  children?: ReactNode;
}

/** A titled block of a page: card, inset well or plain flow. */
export function Section({
  id,
  title,
  subtitle,
  action,
  tag,
  accent,
  variant = 'card',
  icon,
  overline,
  level = 2,
  ariaLabel,
  children,
}: SectionProps) {
  const headingId = useId();
  const Heading = level === 3 ? 'h3' : 'h2';
  const hasHead = title != null || subtitle != null || action != null || overline != null;
  const tileTone = accent === 'heat' || accent === 'cool' ? accent : accent === 'danger' ? 'err' : 'neutral';
  return (
    <section
      id={id}
      className={s.section}
      data-variant={variant}
      data-accent={accent}
      data-level={level}
      aria-labelledby={title != null ? headingId : undefined}
      aria-label={title == null ? ariaLabel : undefined}
    >
      {hasHead ? (
        <div className={s.head}>
          <div className={s.headMain}>
            {icon ? <IconTile icon={icon} size={40} tone={tileTone} /> : null}
            <div className={s.titles}>
              {overline ? <span className={s.overline}>{overline}</span> : null}
              {title != null ? (
                <span className={s.titleRow}>
                  <Heading id={headingId} className={s.title}>
                    {title}
                  </Heading>
                  {tag != null ? <span className={s.tag}>{tag}</span> : null}
                </span>
              ) : null}
              {subtitle != null ? <span className={s.subtitle}>{subtitle}</span> : null}
            </div>
          </div>
          {action ? <div className={s.headAction}>{action}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}
