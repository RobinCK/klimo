import { useId, type ReactNode } from 'react';
import { useUiText } from '../../UiTextContext';
import { IconButton } from '../../basic/IconButton';
import s from './containers.module.css';

export interface InlinePanelProps {
  title: ReactNode;
  hint?: ReactNode;
  /** Shows the close button. */
  onClose?: () => void;
  /** Tinted editor look (the block editor under the week schedule). */
  emphasis?: boolean;
  children?: ReactNode;
  /** Buttons row at the bottom, right-aligned. */
  footer?: ReactNode;
}

/** A panel that opens inside the page flow (change profile, block editor) — never covers the page. */
export function InlinePanel({ title, hint, onClose, emphasis, children, footer }: InlinePanelProps) {
  const ut = useUiText();
  const titleId = useId();
  return (
    <section className={s.panel} data-emphasis={emphasis ? '' : undefined} aria-labelledby={titleId}>
      <div className={s.panelHead}>
        <div className={s.panelTitles}>
          <h2 id={titleId} className={s.panelTitle}>
            {title}
          </h2>
          {hint != null ? <span className={s.panelHint}>{hint}</span> : null}
        </div>
        {onClose ? <IconButton icon="close" label={ut('Close')} size={44} onClick={onClose} /> : null}
      </div>
      {children}
      {footer ? <div className={s.footer}>{footer}</div> : null}
    </section>
  );
}
