import { useUiText } from '../../UiTextContext';
import { IconButton } from '../../basic/IconButton';
import s from './period.module.css';

export interface PeriodNavProps {
  /** The period shown («Жовтень 2026», «Сьогодні»). */
  label: string;
  onPrev: () => void;
  onNext: () => void;
  /** The next period has not begun yet. */
  nextDisabled?: boolean;
  prevDisabled?: boolean;
  /** Back to the period that holds now; shown only when given. */
  onCurrent?: () => void;
  currentLabel?: string;
}

/** ‹ a period › — steps a chart or a list through days, weeks, months or years. */
export function PeriodNav({ label, onPrev, onNext, nextDisabled, prevDisabled, onCurrent, currentLabel }: PeriodNavProps) {
  const ut = useUiText();
  return (
    <div className={s.nav} role="group" aria-label={label}>
      <IconButton icon="chevronLeft" label={ut('Previous period')} size={36} variant="ghost" onClick={onPrev} disabled={prevDisabled} />
      <span className={s.label} aria-live="polite">
        {label}
      </span>
      <IconButton icon="chevronRight" label={ut('Next period')} size={36} variant="ghost" onClick={onNext} disabled={nextDisabled} />
      {onCurrent ? (
        <button type="button" className={s.current} onClick={onCurrent}>
          {currentLabel ?? ut('Now')}
        </button>
      ) : null}
    </div>
  );
}
