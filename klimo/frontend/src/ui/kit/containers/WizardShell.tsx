import { useId, type CSSProperties, type ReactNode } from 'react';
import type { Action } from '../../types';
import { useUiText } from '../../UiTextContext';
import { Icon } from '../../basic/Icon';
import { Button } from '../../basic/Button';
import s from './containers.module.css';

export interface SegmentedProgressProps {
  /** Steps done, counting the current one (1 … total). */
  value: number;
  total: number;
  /** Accessible text («Крок 2 з 4»); without it the bar is decorative. */
  label?: string;
}

/** A row of short bars, one per step. */
export function SegmentedProgress({ value, total, label }: SegmentedProgressProps) {
  const n = Math.max(1, Math.round(total));
  return (
    <div
      className={s.progress}
      style={{ '--total': n } as CSSProperties}
      role={label ? 'progressbar' : undefined}
      aria-hidden={label ? undefined : true}
      aria-valuemin={label ? 0 : undefined}
      aria-valuemax={label ? n : undefined}
      aria-valuenow={label ? Math.min(value, n) : undefined}
      aria-valuetext={label}
    >
      {Array.from({ length: n }, (_, i) => (
        <span key={i} className={s.progressBar} data-done={i < value ? '' : undefined} />
      ))}
    </div>
  );
}

export interface WizardShellProps {
  /** Current step, 1-based. */
  step: number;
  total: number;
  title: ReactNode;
  /** «Крок 2 з 4 · пристрої». */
  stepLabel: string;
  onClose: () => void;
  children: ReactNode;
  back?: Action;
  next: Action;
  /** The finished state: the progress is full. */
  done?: boolean;
}

/**
 * Multi-step flow: close + step label + progress + title on top, a scrolling body and a sticky
 * footer with Back / Next. Full screen on phones, content-sized inside the desktop overlay.
 */
export function WizardShell({ step, total, title, stepLabel, onClose, children, back, next, done }: WizardShellProps) {
  const ut = useUiText();
  const titleId = useId();
  return (
    <div className={s.wizard} role="group" aria-labelledby={titleId}>
      <div className={s.wizardHead}>
        <div className={s.wizardTop}>
          <button type="button" className={s.wizardClose} aria-label={ut('Close the wizard')} title={ut('Close')} onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
          <span className={s.wizardStep} aria-live="polite">
            {stepLabel}
          </span>
        </div>
        <SegmentedProgress value={done ? total : step} total={total} />
        <h1 id={titleId} className={s.wizardTitle}>
          {title}
        </h1>
      </div>
      <div className={s.wizardBody}>{children}</div>
      <div className={s.wizardFoot}>
        {back ? (
          <Button variant="secondary" size="xl" onClick={back.onClick} to={back.to} disabled={back.disabled} loading={back.loading} fullWidth>
            {back.label}
          </Button>
        ) : null}
        <Button variant="primary" size="xl" onClick={next.onClick} to={next.to} disabled={next.disabled} loading={next.loading} fullWidth>
          {next.label}
        </Button>
      </div>
    </div>
  );
}
