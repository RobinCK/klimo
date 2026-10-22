import { useId, type ReactNode } from 'react';
import type { IconName } from '../../types';
import { Icon } from '../../basic/Icon';
import s from './containers.module.css';

export interface AccordionProps {
  /** Stable key (deep links `?section=…` scroll to `id`). */
  id: string;
  icon: IconName;
  title: string;
  /** Live one-line summary under the title («Медіана з 3 · 19.8°»). */
  summary?: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}

/** One collapsible settings group of the phone layouts; the open state belongs to the page. */
export function Accordion({ id, icon, title, summary, open, onToggle, children }: AccordionProps) {
  const bodyId = useId();
  return (
    <section id={id} className={s.accordion}>
      <h2 className={s.accordionHead}>
        <button type="button" className={s.accordionButton} aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
          <span className={s.accordionIcon}>
            <Icon name={icon} size={18} />
          </span>
          <span className={s.accordionText}>
            <span className={s.accordionTitle}>{title}</span>
            {summary ? <span className={s.accordionSummary}>{summary}</span> : null}
          </span>
          <span className={s.chevron} data-open={open ? '' : undefined}>
            <Icon name="chevronDown" size={18} />
          </span>
        </button>
      </h2>
      {open ? (
        <div id={bodyId} className={s.accordionBody}>
          {children}
        </div>
      ) : null}
    </section>
  );
}
