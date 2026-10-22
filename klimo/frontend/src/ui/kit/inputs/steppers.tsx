import { useEffect, useRef, type CSSProperties, type KeyboardEvent } from 'react';
import type { Tone } from '../../types';
import { toneVar } from '../../tokens/vars';
import { Icon } from '../../basic/Icon';
import { clamp, snap } from '../internal/util';
import s from './fields.module.css';

// press-and-hold: first repeat after this delay, then every REPEAT_MS
const HOLD_MS = 450;
const REPEAT_MS = 110;

/**
 * −/+ buttons that repeat while held; the latest value is read through a ref. `apply`
 * returns false at a bound, which ends the repeat (a disabled button gets no pointerup).
 */
function useHoldRepeat(apply: (dir: -1 | 1) => boolean) {
  const timer = useRef<number | undefined>(undefined);
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const stop = () => {
    window.clearTimeout(timer.current);
    window.clearInterval(timer.current);
    timer.current = undefined;
  };
  useEffect(() => stop, []);
  return (dir: -1 | 1) => ({
    onPointerDown: (e: { button: number }) => {
      if (e.button !== 0) return;
      stop();
      timer.current = window.setTimeout(() => {
        timer.current = window.setInterval(() => {
          if (!applyRef.current(dir)) stop();
        }, REPEAT_MS);
      }, HOLD_MS);
    },
    onPointerUp: stop,
    onPointerLeave: stop,
    onPointerCancel: stop,
  });
}

function spinKeys(e: KeyboardEvent<HTMLElement>, change: (dir: -1 | 1, jump?: number) => void, toEdge: (edge: 'min' | 'max') => void) {
  switch (e.key) {
    case 'ArrowUp':
    case 'ArrowRight':
      change(1);
      break;
    case 'ArrowDown':
    case 'ArrowLeft':
      change(-1);
      break;
    case 'PageUp':
      change(1, 5);
      break;
    case 'PageDown':
      change(-1, 5);
      break;
    case 'Home':
      toEdge('min');
      break;
    case 'End':
      toEdge('max');
      break;
    default:
      return;
  }
  e.preventDefault();
}

/* ---------------- Stepper ---------------- */

export interface StepperProps {
  value: number;
  /** The formatted value («−0.3°», «20.0°», «5 хв»). */
  text: string;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step: number;
  /**
   * round: hero target · square: tolerance rows · big: profile targets · tile: strategy
   * parameters · compact: a settings row with small buttons (pump run-on, budgets).
   */
  variant: 'round' | 'square' | 'big' | 'tile' | 'compact';
  label?: string;
  sub?: string;
  /** Colour of the label: heat/cool for the mode it belongs to, hold for neutral. */
  labelTone?: Tone;
  disabled?: boolean;
  ariaDec: string;
  ariaInc: string;
}

/**
 * −/value/+ with a keyboard-operable value (role spinbutton: arrows, PageUp/Down, Home/End).
 * Values are snapped to the step grid, so tenths never accumulate float noise.
 */
export function Stepper({ value, text, onChange, min, max, step, variant, label, sub, labelTone, disabled, ariaDec, ariaInc }: StepperProps) {
  const valueRef = useRef(value);
  valueRef.current = value;
  const change = (dir: -1 | 1, jump = 1): boolean => {
    if (disabled) return false;
    const next = snap(clamp(valueRef.current + dir * step * jump, min, max), step, min);
    if (next === valueRef.current) return false;
    valueRef.current = next;
    onChange(next);
    return true;
  };
  const hold = useHoldRepeat((dir) => change(dir));
  const style = labelTone ? ({ '--label-color': toneVar(labelTone, 'fg') } as CSSProperties) : undefined;
  const atMin = value <= min;
  const atMax = value >= max;
  return (
    <div className={s.stepper} data-variant={variant} data-disabled={disabled ? '' : undefined} style={style}>
      {label || sub ? (
        <span className={s.stepLabel}>
          {label ? <span className={s.stepLabelText}>{label}</span> : null}
          {sub ? <span className={s.stepSub}>{sub}</span> : null}
        </span>
      ) : null}
      <span className={s.stepControls}>
        <button
          type="button"
          className={s.stepButton}
          aria-label={ariaDec}
          title={ariaDec}
          disabled={disabled || atMin}
          onClick={() => change(-1)}
          {...hold(-1)}
        >
          <Icon name="minus" size={variant === 'tile' || variant === 'compact' ? 18 : 20} />
        </button>
        <span
          className={s.stepValue}
          role="spinbutton"
          tabIndex={disabled ? -1 : 0}
          aria-label={label ?? sub}
          aria-valuenow={value}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuetext={text}
          aria-disabled={disabled || undefined}
          aria-live="polite"
          onKeyDown={(e) =>
            spinKeys(e, change, (edge) => {
              if (disabled) return;
              const next = edge === 'min' ? min : max;
              if (next !== value) onChange(next);
            })
          }
        >
          {text}
        </span>
        <button
          type="button"
          className={s.stepButton}
          aria-label={ariaInc}
          title={ariaInc}
          disabled={disabled || atMax}
          onClick={() => change(1)}
          {...hold(1)}
        >
          <Icon name="plus" size={variant === 'tile' || variant === 'compact' ? 18 : 20} />
        </button>
      </span>
    </div>
  );
}

/* ---------------- TimeStepper ---------------- */

export interface TimeStepperProps {
  /** Minutes since midnight (0 … 1440). */
  value: number;
  /** «07:30». */
  text: string;
  onChange: (minutes: number) => void;
  min: number;
  max: number;
  label: string;
  ariaEarlier: string;
  ariaLater: string;
  /** Minutes per press (schedule blocks move in 30-minute steps). */
  step?: number;
  /** inline: label above a compact row · tile: a phone sheet tile with 44 px buttons. */
  variant?: 'inline' | 'tile';
}

export function TimeStepper({ value, text, onChange, min, max, label, ariaEarlier, ariaLater, step = 30, variant = 'inline' }: TimeStepperProps) {
  const valueRef = useRef(value);
  valueRef.current = value;
  const change = (dir: -1 | 1, jump = 1): boolean => {
    const next = clamp(snap(valueRef.current + dir * step * jump, step, 0), min, max);
    if (next === valueRef.current) return false;
    valueRef.current = next;
    onChange(next);
    return true;
  };
  const hold = useHoldRepeat((dir) => change(dir));
  return (
    <div className={s.timeStepper} data-variant={variant}>
      <span className={s.timeLabel}>{label}</span>
      <span className={s.timeControls}>
        <button
          type="button"
          className={s.stepButton}
          aria-label={ariaEarlier}
          title={ariaEarlier}
          disabled={value <= min}
          onClick={() => change(-1)}
          {...hold(-1)}
        >
          <Icon name="minus" size={18} />
        </button>
        <span
          className={s.timeValue}
          role="spinbutton"
          tabIndex={0}
          aria-label={label}
          aria-valuenow={value}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuetext={text}
          aria-live="polite"
          onKeyDown={(e) =>
            spinKeys(
              e,
              (dir, jump) => change(dir, jump === 5 ? 60 / step : 1),
              (edge) => onChange(edge === 'min' ? min : max),
            )
          }
        >
          {text}
        </span>
        <button
          type="button"
          className={s.stepButton}
          aria-label={ariaLater}
          title={ariaLater}
          disabled={value >= max}
          onClick={() => change(1)}
          {...hold(1)}
        >
          <Icon name="plus" size={18} />
        </button>
      </span>
    </div>
  );
}
