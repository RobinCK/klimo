import type { KeyboardEvent } from 'react';
import { Icon } from '../basic/Icon';
import { findNumber, parseTyped, shownDecimals, withDecimals } from '../basic/stepNumber';
import { useTyping, valueKeys } from '../basic/useTyping';
import { useUiText } from '../UiTextContext';
import { snapToStep } from '../viz/internal/geometry';
import s from './climate.module.css';

export interface TargetStepperProps {
  value: number;
  /** «20.5°»; its number is shown with the step's decimals. */
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

/**
 * − value + for the room target on desktop (the phone uses the dial). Tapping the value types
 * one (rounded to the step, kept in range) while `text` shows it as a number (not in °F).
 */
export function TargetStepper({ value, text, onChange, min, max, step, disabled, ariaDec, ariaInc, editing, label }: TargetStepperProps) {
  const ut = useUiText();
  const set = (v: number) => {
    const next = Math.min(max, Math.max(min, snapToStep(v, step)));
    if (Math.abs(next - value) > 1e-6) onChange(next);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled || e.target instanceof HTMLInputElement) return;
    const delta = { ArrowUp: step, ArrowRight: step, ArrowDown: -step, ArrowLeft: -step, PageUp: 1, PageDown: -1 }[e.key];
    if (delta == null) return;
    e.preventDefault();
    set(value + delta);
  };
  // with the step's decimals: a 0.25° step shows «20.25°», not «20.3°»
  const digits = shownDecimals(value, step);
  const shown = withDecimals(text, value, digits);
  const at = findNumber(text, value);
  const canType = !disabled && at != null;
  const type = useTyping(parseTyped, set);
  const startTyping = (first?: string) => {
    if (canType) type.start((value < 0 ? '−' : '') + Math.abs(value).toFixed(digits).replace('.', at?.sep ?? '.'), first);
  };
  return (
    <div className={s.stepper} role="group" aria-label={label} onKeyDown={onKey} data-editing={editing ? '' : undefined}>
      <button type="button" className={s.stepBtn} aria-label={ariaDec} disabled={disabled || value <= min + 1e-6} onClick={() => set(value - step)}>
        <Icon name="minus" size={20} />
      </button>
      {type.typing && canType ? (
        <span className={s.stepValue} data-typing="">
          <input className={s.stepInput} inputMode="decimal" aria-label={label ?? ut('Value')} {...type.input} />
          <span className={s.stepUnit}>{at ? text.slice(at.end).trim() : ''}</span>
        </span>
      ) : (
        <span
          ref={type.valueEl}
          className={s.stepValue}
          role="spinbutton"
          tabIndex={disabled ? -1 : 0}
          aria-label={label}
          aria-valuenow={value}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuetext={shown}
          aria-disabled={disabled || undefined}
          aria-live="polite"
          title={canType ? ut('Click to type a value') : undefined}
          data-typeable={canType ? '' : undefined}
          onClick={() => startTyping()}
          onKeyDown={(e) => valueKeys(e, startTyping, canType ? /^[\d.,−-]$/ : null, () => undefined)}
        >
          {shown}
        </span>
      )}
      <button type="button" className={s.stepBtn} aria-label={ariaInc} disabled={disabled || value >= max - 1e-6} onClick={() => set(value + step)}>
        <Icon name="plus" size={20} />
      </button>
    </div>
  );
}
