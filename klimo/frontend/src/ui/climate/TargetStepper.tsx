import type { KeyboardEvent } from 'react';
import { Icon } from '../basic/Icon';
import { snapToStep } from '../viz/internal/geometry';
import s from './climate.module.css';

export interface TargetStepperProps {
  value: number;
  /** «20.5°». */
  text: string;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  ariaDec: string;
  ariaInc: string;
  /** The shown value is a pending change, not the active target yet. */
  editing?: boolean;
  /** Accessible name of the group («Ціль»). */
  label?: string;
}

/** − value + for the room target on desktop (the phone uses the dial). */
export function TargetStepper({ value, text, onChange, min, max, step, disabled, ariaDec, ariaInc, editing, label }: TargetStepperProps) {
  const set = (v: number) => {
    const next = Math.min(max, Math.max(min, snapToStep(v, step)));
    if (Math.abs(next - value) > 1e-6) onChange(next);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const delta = { ArrowUp: step, ArrowRight: step, ArrowDown: -step, ArrowLeft: -step, PageUp: 1, PageDown: -1 }[e.key];
    if (delta == null) return;
    e.preventDefault();
    set(value + delta);
  };
  return (
    <div className={s.stepper} role="group" aria-label={label} onKeyDown={onKey} data-editing={editing ? '' : undefined}>
      <button type="button" className={s.stepBtn} aria-label={ariaDec} disabled={disabled || value <= min + 1e-6} onClick={() => set(value - step)}>
        <Icon name="minus" size={20} />
      </button>
      <span className={s.stepValue} aria-live="polite">
        {text}
      </span>
      <button type="button" className={s.stepBtn} aria-label={ariaInc} disabled={disabled || value >= max - 1e-6} onClick={() => set(value + step)}>
        <Icon name="plus" size={20} />
      </button>
    </div>
  );
}
