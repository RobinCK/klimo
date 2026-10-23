import { useId, type CSSProperties, type ReactNode } from 'react';
import { Icon } from '../../basic/Icon';
import { MiniTag } from '../../basic/Badges';
import { useRoving } from '../internal/useRoving';
import type { ChoiceValue } from './choice';
import s from './choice.module.css';

function focusIndex<T>(options: { value: T; disabled?: boolean }[], value: T): number {
  const i = options.findIndex((o) => o.value === value);
  return i >= 0 ? i : options.findIndex((o) => !o.disabled);
}

/* ---------------- RadioCardList ---------------- */

export interface RadioCardOption<T extends ChoiceValue> {
  value: T;
  title: string;
  hint?: string;
  /** Technical line in mono («external_temperature_input · sensor_select»). */
  tech?: string;
  /** Small green tag («рекомендовано»). */
  badge?: string;
  disabled?: boolean;
  /** Why it cannot be chosen («головка не має зовнішнього датчика»). */
  disabledReason?: string;
}

export interface RadioCardListProps<T extends ChoiceValue> {
  value: T;
  options: RadioCardOption<T>[];
  onChange: (value: T) => void;
  /** One line per option (no hint), 52 px rows. */
  compact?: boolean;
  ariaLabel: string;
  /** 'well': inside a grey card, the options stand out in the card colour. */
  surface?: 'card' | 'well';
}

/** A vertical list of radio cards: dot, title, explanation — for choices that need a sentence. */
export function RadioCardList<T extends ChoiceValue>({ value, options, onChange, compact, ariaLabel, surface = 'card' }: RadioCardListProps<T>) {
  const baseId = useId();
  const focusable = focusIndex(options, value);
  const { setRef, onKeyDown } = useRoving(options.length, {
    orientation: 'vertical',
    isDisabled: (i) => Boolean(options[i]?.disabled),
    onMove: (i) => onChange(options[i].value),
  });
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={s.radioList} data-surface={surface === 'well' ? 'well' : undefined}>
      {options.map((o, i) => {
        const on = o.value === value;
        const reasonId = o.disabled && o.disabledReason ? `${baseId}-r${i}` : undefined;
        return (
          <button
            key={String(o.value)}
            ref={setRef(i)}
            type="button"
            role="radio"
            aria-checked={on}
            aria-disabled={o.disabled || undefined}
            aria-describedby={reasonId}
            tabIndex={i === focusable ? 0 : -1}
            className={s.radioCard}
            data-compact={compact ? '' : undefined}
            onClick={() => !o.disabled && !on && onChange(o.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            <span className={s.radioDot} aria-hidden="true" />
            <span className={s.radioText}>
              <span className={s.radioTitleRow}>
                <span className={s.radioTitle}>{o.title}</span>
                {o.badge ? <MiniTag tone="ok">{o.badge}</MiniTag> : null}
              </span>
              {!compact && o.hint ? <span className={s.radioHint}>{o.hint}</span> : null}
              {!compact && o.tech ? <span className={s.radioTech}>{o.tech}</span> : null}
              {reasonId ? (
                <span id={reasonId} className={s.radioReason}>
                  <Icon name="lock" size={14} />
                  {o.disabledReason}
                </span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ---------------- RadioValueGrid ---------------- */

export interface RadioValueGridProps<T extends ChoiceValue> {
  value: T;
  /** Each choice shows what it would give right now («Медіана» · «19.8°»). */
  options: { value: T; label: string; valueText: string }[];
  /** Fixed number of columns; default fits 130 px tiles (3 per row on phones). */
  columns?: number;
  onChange: (value: T) => void;
  hint?: ReactNode;
  ariaLabel?: string;
}

/** Method tiles with live values: choose by the outcome, not by the name. */
export function RadioValueGrid<T extends ChoiceValue>({ value, options, columns, onChange, hint, ariaLabel }: RadioValueGridProps<T>) {
  const focusable = focusIndex(options, value);
  const { setRef, onKeyDown } = useRoving(options.length, { onMove: (i) => onChange(options[i].value) });
  const grid = (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={s.valueGrid}
      data-cols={columns ? '' : undefined}
      style={columns ? ({ '--cols': columns } as CSSProperties) : undefined}
    >
      {options.map((o, i) => (
        <button
          key={String(o.value)}
          ref={setRef(i)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={i === focusable ? 0 : -1}
          className={s.valueTile}
          onClick={() => o.value !== value && onChange(o.value)}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          <span className={s.valueTileLabel}>{o.label}</span>
          <span className={s.valueTileValue}>{o.valueText}</span>
        </button>
      ))}
    </div>
  );
  if (hint == null) return grid;
  return (
    <div className={s.field}>
      {grid}
      <span className={s.hint}>{hint}</span>
    </div>
  );
}

/* ---------------- RadioCardGrid ---------------- */

export interface RadioCardGridOption<T extends ChoiceValue> {
  value: T;
  /** Leading mark (a profile icon tile). */
  leading?: ReactNode;
  title: string;
  /** Neutral tag on the right («зараз»). */
  badge?: string;
  /** First line strong («20° · охолодження 26°»), the rest quiet. */
  lines: string[];
}

export interface RadioCardGridProps<T extends ChoiceValue> {
  value: T;
  options: RadioCardGridOption<T>[];
  /** Minimum card width in px. */
  minWidth: number;
  onChange: (value: T) => void;
  ariaLabel: string;
}

/** Big option cards in a fluid grid (house profiles). */
export function RadioCardGrid<T extends ChoiceValue>({ value, options, minWidth, onChange, ariaLabel }: RadioCardGridProps<T>) {
  const focusable = focusIndex(options, value);
  const { setRef, onKeyDown } = useRoving(options.length, { onMove: (i) => onChange(options[i].value) });
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={s.cardGrid} style={{ '--min': `${minWidth}px` } as CSSProperties}>
      {options.map((o, i) => (
        <button
          key={String(o.value)}
          ref={setRef(i)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={i === focusable ? 0 : -1}
          className={s.gridCard}
          onClick={() => o.value !== value && onChange(o.value)}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          <span className={s.gridCardHead}>
            <span className={s.gridCardTitle}>
              {o.leading}
              <span>{o.title}</span>
            </span>
            {o.badge ? <MiniTag>{o.badge}</MiniTag> : null}
          </span>
          {o.lines.map((line, j) => (
            <span key={j} className={s.gridCardLine}>
              {line}
            </span>
          ))}
        </button>
      ))}
    </div>
  );
}
