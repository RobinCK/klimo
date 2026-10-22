import type { CSSProperties } from 'react';
import type { IconName } from '../../types';
import { toneVar } from '../../tokens/vars';
import { useUiText } from '../../UiTextContext';
import { Icon } from '../../basic/Icon';
import { useRoving } from '../internal/useRoving';
import s from './choice.module.css';

/* ---------------- ColorSwatchPicker ---------------- */

export interface ColorSwatchPickerProps {
  value: string;
  /** Colour and the ink that reads on it; `label` names it for screen readers. */
  palette: { color: string; ink: string; label?: string }[];
  onChange: (color: string, ink: string) => void;
  ariaLabel?: string;
}

const sameColor = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Categorical colour choice (profiles); the picked swatch gets a ring with a gap. */
export function ColorSwatchPicker({ value, palette, onChange, ariaLabel }: ColorSwatchPickerProps) {
  const ut = useUiText();
  const selected = palette.findIndex((p) => sameColor(p.color, value));
  const { setRef, onKeyDown } = useRoving(palette.length, { onMove: (i) => onChange(palette[i].color, palette[i].ink) });
  return (
    <div role="radiogroup" aria-label={ariaLabel ?? ut('Colour')} className={s.swatches}>
      {palette.map((p, i) => {
        const on = i === selected;
        const name = p.label ?? ut('Colour {n}', { n: i + 1 });
        return (
          <button
            key={`${p.color}-${i}`}
            ref={setRef(i)}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={name}
            title={name}
            tabIndex={on || (selected < 0 && i === 0) ? 0 : -1}
            className={s.swatch}
            style={{ '--swatch': p.color } as CSSProperties}
            onClick={() => onChange(p.color, p.ink)}
            onKeyDown={(e) => onKeyDown(e, i)}
          />
        );
      })}
    </div>
  );
}

/* ---------------- IconPicker ---------------- */

export interface IconPickerProps {
  value: IconName | null;
  icons: { name: IconName; label: string }[];
  onChange: (name: IconName) => void;
  ariaLabel?: string;
}

export function IconPicker({ value, icons, onChange, ariaLabel }: IconPickerProps) {
  const ut = useUiText();
  const selected = icons.findIndex((i) => i.name === value);
  const { setRef, onKeyDown } = useRoving(icons.length, { onMove: (i) => onChange(icons[i].name) });
  return (
    <div role="radiogroup" aria-label={ariaLabel ?? ut('Icon')} className={s.swatches}>
      {icons.map((ic, i) => {
        const on = i === selected;
        return (
          <button
            key={ic.name}
            ref={setRef(i)}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={ic.label}
            title={ic.label}
            tabIndex={on || (selected < 0 && i === 0) ? 0 : -1}
            className={s.iconChoice}
            onClick={() => onChange(ic.name)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            <Icon name={ic.name} size={18} />
          </button>
        );
      })}
    </div>
  );
}

/* ---------------- MonthToggleGrid ---------------- */

export interface MonthToggleGridProps {
  /** 12 flags, January first. */
  value: boolean[];
  /** Short names («січ»), shown in the cells. */
  labels: string[];
  /** Full names («січень»), read by screen readers. */
  fullLabels: string[];
  onChange: (value: boolean[]) => void;
  /** The meaning of an allowed month. */
  accent: 'heat' | 'cool';
  /** Contiguous-range text («травень — вересень»). */
  summary: string;
  title?: string;
}

/** Twelve month cells: which months a mode is allowed in. */
export function MonthToggleGrid({ value, labels, fullLabels, onChange, accent, summary, title }: MonthToggleGridProps) {
  const style = {
    '--accent': toneVar(accent, 'line'),
    '--accent-bg': toneVar(accent, 'bg'),
    '--accent-fg': toneVar(accent, 'fg'),
  } as CSSProperties;
  return (
    <div className={s.field} style={style}>
      <div className={s.monthHead}>
        {title ? <span className={s.monthTitle}>{title}</span> : null}
        <span className={s.monthSummary} aria-live="polite">
          {summary}
        </span>
      </div>
      <div role="group" aria-label={title ?? summary} className={s.months}>
        {labels.slice(0, 12).map((label, i) => (
          <button
            key={i}
            type="button"
            aria-pressed={Boolean(value[i])}
            aria-label={fullLabels[i] ?? label}
            className={s.month}
            onClick={() => onChange(Array.from({ length: 12 }, (_, j) => (j === i ? !value[j] : Boolean(value[j]))))}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ---------------- DayOfWeekToggle ---------------- */

export interface DayOfWeekToggleProps {
  /** Selected days, 0 = Monday … 6 = Sunday. */
  value: number[];
  /** Seven short names starting with Monday. */
  labels: string[];
  onChange: (value: number[]) => void;
  ariaLabel?: string;
  /** Full names for screen readers. */
  fullLabels?: string[];
}

export function DayOfWeekToggle({ value, labels, onChange, ariaLabel, fullLabels }: DayOfWeekToggleProps) {
  const ut = useUiText();
  const set = new Set(value);
  return (
    <div role="group" aria-label={ariaLabel ?? ut('Days of the week')} className={s.dows}>
      {labels.slice(0, 7).map((label, d) => (
        <button
          key={d}
          type="button"
          aria-pressed={set.has(d)}
          aria-label={fullLabels?.[d]}
          className={s.dow}
          onClick={() => {
            const next = new Set(set);
            if (next.has(d)) next.delete(d);
            else next.add(d);
            onChange([...next].sort((a, b) => a - b));
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/* ---------------- DayTabs ---------------- */

export interface DayTabsProps {
  /** Selected day, 0 = Monday … 6 = Sunday. */
  value: number;
  today: number;
  labels: string[];
  onChange: (day: number) => void;
  ariaLabel?: string;
  /** id of the panel the tabs control. */
  panelId?: string;
}

/** Seven day tabs with a dot under today (phone schedule). */
export function DayTabs({ value, today, labels, onChange, ariaLabel, panelId }: DayTabsProps) {
  const ut = useUiText();
  const days = labels.slice(0, 7);
  const { setRef, onKeyDown } = useRoving(days.length, { orientation: 'horizontal', onMove: onChange });
  return (
    <div role="tablist" aria-label={ariaLabel ?? ut('Day of the week')} className={s.dayTabs}>
      {days.map((label, d) => {
        const on = d === value;
        return (
          <button
            key={d}
            ref={setRef(d)}
            type="button"
            role="tab"
            aria-selected={on}
            aria-controls={panelId}
            tabIndex={on ? 0 : -1}
            className={s.dayTab}
            data-today={d === today ? '' : undefined}
            onClick={() => onChange(d)}
            onKeyDown={(e) => onKeyDown(e, d)}
          >
            <span>{label}</span>
            <span className={s.dayDot} aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}
