import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useUiText } from '../../UiTextContext';
import { Icon } from '../../basic/Icon';
import { clamp, cx, hhmmToMinutes, minutesToHhmm, snap } from '../internal/util';
import s from './fields.module.css';

function Messages({ id, error, help }: { id: string; error?: ReactNode; help?: ReactNode }) {
  return (
    <>
      {error ? (
        <span id={`${id}-err`} className={s.error} role="alert">
          <Icon name="alert" size={14} />
          {error}
        </span>
      ) : null}
      {help && !error ? (
        <span id={`${id}-help`} className={s.help}>
          {help}
        </span>
      ) : null}
    </>
  );
}

function describedBy(id: string, error?: ReactNode, help?: ReactNode): string | undefined {
  if (error) return `${id}-err`;
  if (help) return `${id}-help`;
  return undefined;
}

/* ---------------- Select ---------------- */

export interface SelectOption<T> {
  value: T;
  label: string;
  disabled?: boolean;
}

export interface SelectProps<T> {
  value: T;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  /** sm 40 (inline bars) · md 44 · lg 52 (wizard fields). */
  size?: 'sm' | 'md' | 'lg';
  ariaLabel: string;
  /** Focus in/out — the pending countdown pauses while the list is open. */
  onFocusChange?: (focused: boolean) => void;
  label?: string;
  disabled?: boolean;
  /** Stretch to the parent's width (default for md/lg, sm stays content-sized). */
  fullWidth?: boolean;
}

/** Native select in the kit look: the OS list is the most usable one on phones. */
export function Select<T>({ value, options, onChange, size = 'md', ariaLabel, onFocusChange, label, disabled, fullWidth }: SelectProps<T>) {
  const id = useId();
  const index = options.findIndex((o) => Object.is(o.value, value) || o.value === value);
  const inline = !(fullWidth ?? size !== 'sm');
  const control = (
    <span className={cx(s.inputWrap, inline && s.selectInline)}>
      <select
        id={id}
        className={s.select}
        data-size={size}
        aria-label={label ? undefined : ariaLabel}
        value={index >= 0 ? String(index) : ''}
        disabled={disabled}
        onChange={(e) => {
          const next = options[Number(e.currentTarget.value)];
          if (next) onChange(next.value);
        }}
        onFocus={() => onFocusChange?.(true)}
        onBlur={() => onFocusChange?.(false)}
      >
        {index < 0 ? <option value="" disabled hidden /> : null}
        {options.map((o, i) => (
          <option key={i} value={String(i)} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
      <span className={s.selectChevron}>
        <Icon name="chevronDown" size={14} />
      </span>
    </span>
  );
  if (!label) return control;
  return (
    <div className={s.field}>
      <label htmlFor={id} className={s.label}>
        {label}
      </label>
      {control}
    </div>
  );
}

/* ---------------- TextField ---------------- */

export interface TextFieldProps {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  /** md 48 · lg 48 with a 20 px title weight (profile name) · xl 52 (wizard name). */
  size?: 'md' | 'lg' | 'xl';
  error?: string;
  placeholder?: string;
  autoFocus?: boolean;
  /** Name for screen readers when there is no visible label. */
  ariaLabel?: string;
  help?: ReactNode;
  maxLength?: number;
  /** Multi-line (templates). */
  multiline?: boolean;
  /** Mono font (entity ids, templates). */
  mono?: boolean;
  onBlur?: () => void;
  /** Enter in a single-line field. */
  onEnter?: () => void;
  disabled?: boolean;
}

export function TextField({
  value,
  onChange,
  label,
  size = 'md',
  error,
  placeholder,
  autoFocus,
  ariaLabel,
  help,
  maxLength,
  multiline,
  mono,
  onBlur,
  onEnter,
  disabled,
}: TextFieldProps) {
  const id = useId();
  const common = {
    id,
    className: s.input,
    'data-size': size,
    'data-mono': mono ? '' : undefined,
    // Mantine's focus trap honours data-autofocus inside dialogs
    'data-autofocus': autoFocus ? '' : undefined,
    autoFocus,
    value,
    placeholder,
    maxLength,
    disabled,
    'aria-label': label ? undefined : ariaLabel,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': describedBy(id, error, help),
    onBlur,
  };
  return (
    <div className={s.field}>
      {label ? (
        <label htmlFor={id} className={s.label}>
          {label}
        </label>
      ) : null}
      {multiline ? (
        <textarea {...common} rows={4} spellCheck={false} onChange={(e) => onChange(e.currentTarget.value)} />
      ) : (
        <input
          {...common}
          type="text"
          onChange={(e) => onChange(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && onEnter) {
              e.preventDefault();
              onEnter();
            }
          }}
        />
      )}
      <Messages id={id} error={error} help={help} />
    </div>
  );
}

/* ---------------- NumberField ---------------- */

export interface NumberFieldProps {
  value: number | null;
  /** Called with a clamped, step-snapped number once the entry is complete (blur, Enter, arrows). */
  onChange: (value: number) => void;
  min: number;
  max: number;
  step: number;
  /** Shown inside the field on the right («°», «хв», «%»). */
  unit?: string;
  label?: string;
  ariaLabel?: string;
  error?: string;
  disabled?: boolean;
}

const fmt = (v: number | null) => (v == null ? '' : String(v));

/** Free numeric entry that never leaves an out-of-range value behind. */
export function NumberField({ value, onChange, min, max, step, unit, label, ariaLabel, error, disabled }: NumberFieldProps) {
  const ut = useUiText();
  const id = useId();
  const [text, setText] = useState(fmt(value));
  const [invalid, setInvalid] = useState(false);
  const editing = useRef(false);

  useEffect(() => {
    if (!editing.current) setText(fmt(value));
  }, [value]);

  const commit = (raw: string) => {
    const n = Number(raw.replace(',', '.').replace('−', '-').trim());
    if (raw.trim() === '' || !Number.isFinite(n)) {
      setInvalid(raw.trim() !== '');
      setText(fmt(value));
      return;
    }
    const next = snap(clamp(n, min, max), step, min);
    setInvalid(false);
    setText(fmt(next));
    if (next !== value) onChange(next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') commit(e.currentTarget.value);
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const base = value ?? min;
      const next = snap(clamp(base + (e.key === 'ArrowUp' ? step : -step), min, max), step, min);
      setText(fmt(next));
      if (next !== value) onChange(next);
    }
  };

  const message = error ?? (invalid ? ut('Enter a number from {min} to {max}', { min, max }) : undefined);
  return (
    <div className={s.field}>
      {label ? (
        <label htmlFor={id} className={s.label}>
          {label}
        </label>
      ) : null}
      <span className={s.inputWrap}>
        <input
          id={id}
          className={s.input}
          data-unit={unit ? '' : undefined}
          type="text"
          inputMode="decimal"
          role="spinbutton"
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={value ?? undefined}
          aria-label={label ? undefined : ariaLabel}
          aria-invalid={message ? true : undefined}
          aria-describedby={message ? `${id}-err` : undefined}
          value={text}
          disabled={disabled}
          onFocus={() => {
            editing.current = true;
          }}
          onChange={(e) => setText(e.currentTarget.value)}
          onBlur={(e) => {
            editing.current = false;
            commit(e.currentTarget.value);
          }}
          onKeyDown={onKeyDown}
        />
        {unit ? <span className={s.unit}>{unit}</span> : null}
      </span>
      <Messages id={id} error={message} />
    </div>
  );
}

/* ---------------- TimeRangeInput ---------------- */

/**
 * Reads what people type for a time: "7" → 07:00, "730" → 07:30, "7:5" → 07:05, "23.30" →
 * 23:30. Null when it is not a time of day.
 */
export function parseTime(text: string): string | null {
  const t = text.trim().replace(/[.\s]/g, ':');
  let h: number;
  let m: number;
  const parts = /^(\d{1,2}):(\d{1,2})$/.exec(t);
  if (parts) {
    h = Number(parts[1]);
    m = Number(parts[2]);
  } else if (/^\d{1,4}$/.test(t)) {
    h = t.length <= 2 ? Number(t) : Number(t.slice(0, t.length - 2));
    m = t.length <= 2 ? 0 : Number(t.slice(-2));
  } else return null;
  if (h > 24 || m > 59 || (h === 24 && m > 0)) return null;
  return minutesToHhmm(h * 60 + m);
}

/**
 * A 24-hour time field. Native time inputs follow the browser locale and show AM/PM to
 * English-language browsers; schedules here are always 24 h.
 */
function TimeField({ value, onChange, label, stepMin }: { value: string; onChange: (v: string) => void; label: string; stepMin: number }) {
  const id = useId();
  const [text, setText] = useState(value);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setText(value);
  }, [value]);
  const commit = (raw: string) => {
    const next = parseTime(raw);
    setText(next ?? value);
    if (next && next !== value) onChange(next);
  };
  const nudge = (dir: 1 | -1) => {
    const base = hhmmToMinutes(parseTime(text) ?? value);
    const next = minutesToHhmm((((base + dir * stepMin) % 1440) + 1440) % 1440);
    setText(next);
    onChange(next);
  };
  return (
    <label className={s.rangePart} htmlFor={id}>
      {label}
      <input
        id={id}
        className={s.time}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        placeholder="00:00"
        maxLength={5}
        value={text}
        onFocus={() => {
          editing.current = true;
        }}
        onChange={(e) => setText(e.currentTarget.value)}
        onBlur={(e) => {
          editing.current = false;
          commit(e.currentTarget.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit(e.currentTarget.value);
          else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            nudge(e.key === 'ArrowUp' ? 1 : -1);
          }
        }}
      />
    </label>
  );
}

export interface TimeRangeInputProps {
  /** "HH:MM", 24 h. */
  from: string;
  to: string;
  onChange: (range: { from: string; to: string }) => void;
  ariaLabel?: string;
  /** Minutes per arrow-key step (default 5). */
  stepMin?: number;
}

/** From–to in 24 h; may cross midnight (23:00–07:00). Arrow keys move by `stepMin`. */
export function TimeRangeInput({ from, to, onChange, ariaLabel, stepMin = 5 }: TimeRangeInputProps) {
  const ut = useUiText();
  return (
    <div role="group" aria-label={ariaLabel} className={s.range}>
      <TimeField label={ut('from')} value={from} stepMin={stepMin} onChange={(v) => onChange({ from: v, to })} />
      <TimeField label={ut('to')} value={to} stepMin={stepMin} onChange={(v) => onChange({ from, to: v })} />
    </div>
  );
}

/* ---------------- AreaSelect ---------------- */

export interface AreaSelectProps {
  /** HA area id, null = no area. */
  value: string | null;
  /** `hint` explains what picking the area brings («У зоні знайдено 6 пристроїв»). */
  areas: { id: string; name: string; hint?: string }[];
  onChange: (areaId: string | null) => void;
  /** «Без зони». */
  noneLabel: string;
  label?: string;
}

/** Home Assistant area of a room; the hint under it says what the choice brings. */
export function AreaSelect({ value, areas, onChange, noneLabel, label }: AreaSelectProps) {
  const ut = useUiText();
  const options: SelectOption<string | null>[] = [...areas.map((a) => ({ value: a.id as string | null, label: a.name })), { value: null, label: noneLabel }];
  const hint = areas.find((a) => a.id === value)?.hint;
  return (
    <div className={s.field}>
      <Select value={value} options={options} onChange={onChange} size="lg" label={label} ariaLabel={label ?? ut('Home Assistant area')} />
      {hint ? <span className={s.help}>{hint}</span> : null}
    </div>
  );
}
