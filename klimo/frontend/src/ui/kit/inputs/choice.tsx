import type { ReactNode } from 'react';
import type { IconName } from '../../types';
import { useUiText } from '../../UiTextContext';
import { Icon } from '../../basic/Icon';
import { useRoving } from '../internal/useRoving';
import s from './choice.module.css';

/** Value types the choice controls accept (keys and `==` comparison must work). */
export type ChoiceValue = string | number | boolean;

export interface SegmentOption<T extends ChoiceValue> {
  value: T;
  label: string;
  count?: number;
  icon?: IconName;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends ChoiceValue> {
  value: T;
  options: SegmentOption<T>[];
  onChange: (value: T) => void;
  /** xs 32 (table cells) · sm 36 · md 40; phones grow every size to a 44 px target. */
  size?: 'xs' | 'sm' | 'md';
  /** Across the full width: equal columns while the labels fit. */
  full?: boolean;
  /** An option that waits for confirmation is outlined until it is applied or dropped. */
  pending?: T | null;
  ariaLabel: string;
  /** Explanation of the selected option, under the control. */
  hint?: ReactNode;
  /** The track colour: on a card (default) or inside a well. */
  surface?: 'card' | 'well';
}

/** One-of-N choice as a single row (radio group semantics, arrows move the selection). */
export function SegmentedControl<T extends ChoiceValue>({
  value,
  options,
  onChange,
  size = 'sm',
  full,
  pending,
  ariaLabel,
  hint,
  surface = 'card',
}: SegmentedControlProps<T>) {
  const selected = options.findIndex((o) => o.value === value);
  const focusable = selected >= 0 ? selected : options.findIndex((o) => !o.disabled);
  const { setRef, onKeyDown } = useRoving(options.length, {
    orientation: 'horizontal',
    isDisabled: (i) => Boolean(options[i]?.disabled),
    onMove: (i) => onChange(options[i].value),
  });

  const group = (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={s.seg}
      data-size={size}
      data-full={full ? '' : undefined}
      data-surface={surface === 'well' ? 'well' : undefined}
    >
      {options.map((o, i) => {
        const on = i === selected;
        return (
          <button
            key={String(o.value)}
            ref={setRef(i)}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={i === focusable ? 0 : -1}
            disabled={o.disabled}
            className={s.segItem}
            data-pending={pending != null && pending === o.value && !on ? '' : undefined}
            onClick={() => !on && onChange(o.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {o.icon ? <Icon name={o.icon} size={16} /> : null}
            <span className={s.segLabel}>{o.label}</span>
            {o.count != null ? <span className={s.segCount}>{o.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
  if (hint == null) return group;
  return (
    <div className={s.field}>
      {group}
      <span className={s.hint}>{hint}</span>
    </div>
  );
}

export interface FilterPillsProps<T extends ChoiceValue> {
  value: T;
  options: { value: T; label: string; count?: number }[];
  onChange: (value: T) => void;
  ariaLabel: string;
  /** The track sits on the page (outlined) or on a card (filled). */
  surface?: 'page' | 'card';
}

/** Filter for a list below it: segmented look, toggle-button semantics (aria-pressed). */
export function FilterPills<T extends ChoiceValue>({ value, options, onChange, ariaLabel, surface = 'card' }: FilterPillsProps<T>) {
  return (
    <div role="group" aria-label={ariaLabel} className={s.seg} data-surface={surface === 'page' ? 'page' : undefined}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button key={String(o.value)} type="button" aria-pressed={on} className={s.segItem} onClick={() => !on && onChange(o.value)}>
            <span className={s.segLabel}>{o.label}</span>
            {o.count != null ? <span className={s.segCount}>{o.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export interface DurationPillsProps<T extends ChoiceValue> {
  value: T;
  /** «До 23:00» + «потім розклад», «1 година» + «до 20:10» … */
  options: { value: T; label: string; hint: string }[];
  onChange: (value: T) => void;
  ariaLabel?: string;
}

/** How long a change lasts: pills with a label and the resulting end time. */
export function DurationPills<T extends ChoiceValue>({ value, options, onChange, ariaLabel }: DurationPillsProps<T>) {
  const ut = useUiText();
  const selected = options.findIndex((o) => o.value === value);
  const { setRef, onKeyDown } = useRoving(options.length, { onMove: (i) => onChange(options[i].value) });
  return (
    <div role="radiogroup" aria-label={ariaLabel ?? ut('Duration')} className={s.pills}>
      {options.map((o, i) => {
        const on = i === selected;
        return (
          <button
            key={String(o.value)}
            ref={setRef(i)}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on || (selected < 0 && i === 0) ? 0 : -1}
            className={s.pill}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            <span className={s.pillLabel}>{o.label}</span>
            <span className={s.pillHint}>{o.hint}</span>
          </button>
        );
      })}
    </div>
  );
}
