import { useId, type CSSProperties, type ReactNode } from 'react';
import type { IconName, Tone } from '../../types';
import { toneVar } from '../../tokens/vars';
import { Icon } from '../../basic/Icon';
import s from './choice.module.css';

/* ---------------- ToggleCard ---------------- */

export interface ToggleCardProps {
  pressed: boolean;
  icon: IconName;
  title: string;
  hint?: string;
  onToggle: () => void;
}

/** A big on/off card with a square check («Радіатори з головками»). */
export function ToggleCard({ pressed, icon, title, hint, onToggle }: ToggleCardProps) {
  return (
    <button type="button" aria-pressed={pressed} className={s.toggleCard} onClick={onToggle}>
      <span className={s.toggleIcon}>
        <Icon name={icon} size={18} />
      </span>
      <span className={s.toggleText}>
        <span className={s.toggleTitle}>{title}</span>
        {hint ? <span className={s.toggleHint}>{hint}</span> : null}
      </span>
      <span className={s.check} aria-hidden="true">
        <Icon name="check" size={14} />
      </span>
    </button>
  );
}

/* ---------------- ToggleChip ---------------- */

export interface ToggleChipProps {
  pressed: boolean;
  icon: IconName;
  label: string;
  /** Colour of the pressed state (a capability's meaning: heat, cool …); neutral by default. */
  accent?: Tone;
  onToggle: () => void;
}

/** Compact on/off chip for capabilities («Гріє», «Охолоджує», «Осушує»). */
export function ToggleChip({ pressed, icon, label, accent, onToggle }: ToggleChipProps) {
  const style = accent ? ({ '--accent': toneVar(accent, 'line'), '--accent-fg': toneVar(accent, 'fg') } as CSSProperties) : undefined;
  return (
    <button type="button" aria-pressed={pressed} className={s.chip} style={style} onClick={onToggle}>
      <Icon name={icon} size={15} />
      {label}
    </button>
  );
}

/* ---------------- CheckboxRow ---------------- */

export interface CheckboxRowProps {
  checked: boolean;
  title: ReactNode;
  hint?: ReactNode;
  /** Value on the right (a ValuePill or a quiet text); stays clickable on its own. */
  trailing?: ReactNode;
  disabled?: boolean;
  /** Fixed by policy: shown checked state, not changeable, with the reason. */
  locked?: { reason: string };
  onChange: (checked: boolean) => void;
  /** plain · well (rule rows) · divided (rows with a top rule) · list (grouped phone list, check on the right). */
  variant?: 'plain' | 'well' | 'divided' | 'list';
  /** Leading mark for list rows (a tone dot, an icon). */
  leading?: ReactNode;
}

/** A native checkbox with a title and a hint; the whole text is the label. */
export function CheckboxRow({ checked, title, hint, trailing, disabled, locked, onChange, variant = 'plain', leading }: CheckboxRowProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const inert = Boolean(disabled || locked);
  const described = [hint ? hintId : '', locked ? `${id}-lock` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className={s.checkRow} data-variant={variant} data-disabled={inert ? '' : undefined}>
      {leading ? <span className={s.checkLeading}>{leading}</span> : null}
      <input
        id={id}
        type="checkbox"
        className={s.checkBox}
        checked={checked}
        disabled={inert}
        aria-describedby={described}
        onChange={(e) => onChange(e.currentTarget.checked)}
      />
      <label htmlFor={id} className={s.checkLabel}>
        <span className={s.checkTitle}>{title}</span>
        {hint ? (
          <span id={hintId} className={s.checkHint}>
            {hint}
          </span>
        ) : null}
        {locked ? (
          <span id={`${id}-lock`} className={s.checkLocked}>
            <Icon name="lock" size={14} />
            {locked.reason}
          </span>
        ) : null}
      </label>
      {trailing != null ? <span className={s.checkTrailing}>{trailing}</span> : null}
    </div>
  );
}
