import { useEffect, useRef, type CSSProperties, type KeyboardEvent } from 'react';
import type { Tone } from '../../types';
import { toneVar } from '../../tokens/vars';
import { Icon } from '../../basic/Icon';
import { InfoHint, type InfoHintContent } from '../../basic/InfoHint';
import { decimalsOf, findNumber, parseTyped, parseTypedTime, shownDecimals, withDecimals } from '../../basic/stepNumber';
import { useTyping, valueKeys } from '../../basic/useTyping';
import { useUiText } from '../../UiTextContext';
import { clamp, snap } from '../internal/util';
import s from './fields.module.css';

// press-and-hold: the first repeat after HOLD_MS, then faster down to FASTEST_MS; a long hold
// moves 2, later 5 steps per repeat
const HOLD_MS = 450;
const REPEAT_MS = 120;
const FASTEST_MS = 40;
const jumpAfter = (repeats: number) => (repeats < 20 ? 1 : repeats < 40 ? 2 : 5);

/**
 * −/+ buttons that step on a click and repeat, faster and faster, while held; the latest value
 * is read through a ref. `apply` returns false at a bound, which ends the repeat (a disabled
 * button gets no pointerup). The click that ends a hold is not one more step.
 */
function useHoldRepeat(apply: (dir: -1 | 1, jump: number) => boolean) {
  const timer = useRef<number | undefined>(undefined);
  const held = useRef(false);
  const applyRef = useRef(apply);
  applyRef.current = apply;
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const repeat = (dir: -1 | 1, n: number) => {
    timer.current = window.setTimeout(
      () => {
        held.current = true;
        if (applyRef.current(dir, jumpAfter(n))) repeat(dir, n + 1);
        else {
          timer.current = undefined;
          held.current = false;
        }
      },
      n === 0 ? HOLD_MS : Math.max(FASTEST_MS, REPEAT_MS * 0.85 ** (n - 1)),
    );
  };
  const stop = () => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    // after the click that follows the release
    window.setTimeout(() => {
      held.current = false;
    }, 0);
  };
  return (dir: -1 | 1) => ({
    onPointerDown: (e: { button: number }) => {
      if (e.button !== 0) return;
      window.clearTimeout(timer.current);
      held.current = false;
      repeat(dir, 0);
    },
    onPointerUp: stop,
    onPointerLeave: stop,
    onPointerCancel: stop,
    // a long press on a phone opens no menu
    onContextMenu: (e: { preventDefault: () => void }) => e.preventDefault(),
    onClick: () => {
      if (!held.current) applyRef.current(dir, 1);
    },
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

/* ---------------- step grid ---------------- */

interface Grid {
  from: number;
  step: number;
}

/** The grid around `v`: the last coarser tier that starts below it (at it, going up), else the base step. */
function gridAt(v: number, dir: -1 | 1, base: Grid, tiers: readonly Grid[]): Grid {
  let g = base;
  for (const t of tiers) if (dir > 0 ? v >= t.from - 1e-9 : v > t.from + 1e-9) g = t;
  return g;
}

const clean = (v: number, g: Grid) => Number(v.toFixed(Math.max(decimalsOf(g.step), decimalsOf(g.from))));

/** One step from `v`: to the next grid point, so an off-grid 0.8 goes to 1.0 or 0.5, not 1.3. */
function stepFrom(v: number, dir: -1 | 1, base: Grid, tiers: readonly Grid[]): number {
  const g = gridAt(v, dir, base, tiers);
  const n = (v - g.from) / g.step;
  let next = g.from + (dir > 0 ? Math.floor(n + 1e-9) + 1 : Math.ceil(n - 1e-9) - 1) * g.step;
  const up = tiers.find((t) => t.from > v + 1e-9);
  if (dir > 0 && up && next > up.from) next = up.from;
  return clean(next, g);
}

function nearest(v: number, base: Grid, tiers: readonly Grid[]): number {
  const g = gridAt(v, 1, base, tiers);
  return clean(g.from + Math.round((v - g.from) / g.step) * g.step, g);
}

/* ---------------- Stepper ---------------- */

export interface StepperProps {
  value: number;
  /** The formatted value («−0.3°», «20.0°», «5 хв»); its number is shown with the step's decimals. */
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
  /** What the setting does, behind an «i» after the label. */
  hint?: InfoHintContent;
  /** Digits after the point; by default as many as the step has (0.1 → 1, 0.5 → 1, 1 → 0). */
  decimals?: number;
  /** Coarser steps further up the range: `[{ from: 10, step: 1 }]` steps by 1 from 10 up, by `step` below. */
  coarseSteps?: readonly { from: number; step: number }[];
  /** Tapping the value types a number (checked, clamped, rounded to the step); false keeps it press-only. */
  typeable?: boolean;
  /** Unit beside the typed number when `text` does not show the value as a number («хв» for «1 год 40 хв»). */
  unit?: string;
}

/**
 * −/value/+ with a keyboard-operable value (role spinbutton: arrows, PageUp/Down, Home/End;
 * Enter or a digit types). Values land on the step grid (multiples of the step), so tenths never
 * accumulate float noise, and the shown number always has the step's decimals, so every press
 * changes what is seen.
 */
export function Stepper({
  value,
  text,
  onChange,
  min,
  max,
  step,
  variant,
  label,
  sub,
  labelTone,
  disabled,
  ariaDec,
  ariaInc,
  hint,
  decimals,
  coarseSteps,
  typeable = true,
  unit,
}: StepperProps) {
  const ut = useUiText();
  const valueRef = useRef(value);
  valueRef.current = value;

  // multiples of the step, not counted from `min`: a 1…1440 min field with a 5 min step reads 5, 10, 15
  const base = { from: 0, step };
  const tiers = [...(coarseSteps ?? [])].sort((a, b) => a.from - b.from);
  const shownDigits = shownDecimals(value, gridAt(value, 1, base, tiers).step, decimals);
  const shown = withDecimals(text, value, shownDigits);
  const at = findNumber(text, value);
  const suffix = at ? text.slice(at.end).trim() : unit;
  const canType = typeable && !disabled && (at != null || unit != null);

  const change = (dir: -1 | 1, jump = 1): boolean => {
    if (disabled) return false;
    let next = valueRef.current;
    for (let i = 0; i < jump; i++) next = clamp(stepFrom(next, dir, base, tiers), min, max);
    if (Math.abs(next - valueRef.current) < 1e-9) return false;
    valueRef.current = next;
    onChange(next);
    return true;
  };
  const hold = useHoldRepeat(change);
  const type = useTyping(parseTyped, (n) => {
    const next = clamp(nearest(n, base, tiers), min, max);
    if (Math.abs(next - value) > 1e-9) onChange(next);
  });
  const startTyping = (first?: string) => {
    if (canType) type.start((value < 0 ? '−' : '') + Math.abs(value).toFixed(shownDigits).replace('.', at?.sep ?? '.'), first);
  };

  const style = labelTone ? ({ '--label-color': toneVar(labelTone, 'fg') } as CSSProperties) : undefined;
  const atMin = value <= min + 1e-9;
  const atMax = value >= max - 1e-9;
  const iconSize = variant === 'tile' || variant === 'compact' ? 18 : 20;
  return (
    <div className={s.stepper} data-variant={variant} data-disabled={disabled ? '' : undefined} style={style}>
      {label || sub ? (
        <span className={s.stepLabel}>
          {label ? (
            <span className={s.stepLabelText}>
              {label}
              {hint ? (
                <>
                  {' '}
                  <InfoHint content={hint} subject={label} />
                </>
              ) : null}
            </span>
          ) : null}
          {sub ? (
            <span className={s.stepSub}>
              {sub}
              {hint && !label ? (
                <>
                  {' '}
                  <InfoHint content={hint} subject={sub} />
                </>
              ) : null}
            </span>
          ) : null}
        </span>
      ) : null}
      <span className={s.stepControls}>
        <button type="button" className={s.stepButton} aria-label={ariaDec} title={ariaDec} disabled={disabled || atMin} {...hold(-1)}>
          <Icon name="minus" size={iconSize} />
        </button>
        {type.typing && canType ? (
          <span className={s.stepValue} data-typing="">
            <input className={s.stepInput} inputMode="decimal" aria-label={label ?? sub ?? ut('Value')} {...type.input} />
            {suffix ? <span className={s.stepUnit}>{suffix}</span> : null}
          </span>
        ) : (
          <span
            ref={type.valueEl}
            className={s.stepValue}
            role="spinbutton"
            tabIndex={disabled ? -1 : 0}
            aria-label={label ?? sub}
            aria-valuenow={value}
            aria-valuemin={min}
            aria-valuemax={max}
            aria-valuetext={shown}
            aria-disabled={disabled || undefined}
            aria-live="polite"
            title={canType ? ut('Click to type a value') : undefined}
            data-typeable={canType ? '' : undefined}
            onClick={() => startTyping()}
            onKeyDown={(e) =>
              valueKeys(e, startTyping, canType ? /^[\d.,−-]$/ : null, () =>
                spinKeys(e, change, (edge) => {
                  if (disabled) return;
                  const next = edge === 'min' ? min : max;
                  if (next !== value) onChange(next);
                }),
              )
            }
          >
            {shown}
          </span>
        )}
        <button type="button" className={s.stepButton} aria-label={ariaInc} title={ariaInc} disabled={disabled || atMax} {...hold(1)}>
          <Icon name="plus" size={iconSize} />
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
  /** Tapping the time types one («7:30», «730»), rounded to the step and kept in range; false keeps it press-only. */
  typeable?: boolean;
}

export function TimeStepper({ value, text, onChange, min, max, label, ariaEarlier, ariaLater, step = 30, variant = 'inline', typeable = true }: TimeStepperProps) {
  const ut = useUiText();
  const valueRef = useRef(value);
  valueRef.current = value;
  const change = (dir: -1 | 1, jump = 1): boolean => {
    const next = clamp(snap(valueRef.current + dir * step * jump, step, 0), min, max);
    if (next === valueRef.current) return false;
    valueRef.current = next;
    onChange(next);
    return true;
  };
  const hold = useHoldRepeat(change);
  const canType = typeable && min < max;
  const type = useTyping(parseTypedTime, (m) => {
    const next = clamp(snap(m, step, 0), min, max);
    if (next !== value) onChange(next);
  });
  const startTyping = (first?: string) => {
    if (canType) type.start(text, first);
  };
  return (
    <div className={s.timeStepper} data-variant={variant}>
      <span className={s.timeLabel}>{label}</span>
      <span className={s.timeControls}>
        <button type="button" className={s.stepButton} aria-label={ariaEarlier} title={ariaEarlier} disabled={value <= min} {...hold(-1)}>
          <Icon name="minus" size={18} />
        </button>
        {type.typing && canType ? (
          <span className={s.timeValue} data-typing="">
            <input className={s.stepInput} inputMode="numeric" aria-label={label} {...type.input} />
          </span>
        ) : (
          <span
            ref={type.valueEl}
            className={s.timeValue}
            role="spinbutton"
            tabIndex={0}
            aria-label={label}
            aria-valuenow={value}
            aria-valuemin={min}
            aria-valuemax={max}
            aria-valuetext={text}
            aria-live="polite"
            title={canType ? ut('Click to type a value') : undefined}
            data-typeable={canType ? '' : undefined}
            onClick={() => startTyping()}
            onKeyDown={(e) =>
              valueKeys(e, startTyping, canType ? /^\d$/ : null, () =>
                spinKeys(
                  e,
                  (dir, jump) => change(dir, jump === 5 ? 60 / step : 1),
                  (edge) => onChange(edge === 'min' ? min : max),
                ),
              )
            }
          >
            {text}
          </span>
        )}
        <button type="button" className={s.stepButton} aria-label={ariaLater} title={ariaLater} disabled={value >= max} {...hold(1)}>
          <Icon name="plus" size={18} />
        </button>
      </span>
    </div>
  );
}
