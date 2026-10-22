import { useEffect, useRef, useState } from 'react';
import type { IconName } from '../../types';
import { useUiText } from '../../UiTextContext';
import { Icon } from '../../basic/Icon';
import { Button, type ButtonVariant } from '../../basic/Button';
import s from './list.module.css';

/* ---------------- TestButton ---------------- */

export interface TestButtonProps {
  label: string;
  /** Shown for a moment after success, next to a check mark («Надіслано»). */
  successLabel: string;
  run: () => Promise<{ ok: boolean; error?: string }>;
  icon?: IconName;
}

// how long the success or failure state stays before the button resets
const OK_MS = 2500;
const ERROR_MS = 6000;

/** Fires a test (a message, a 2-minute source run) and reports the outcome in place. */
export function TestButton({ label, successLabel, run, icon = 'sendTest' }: TestButtonProps) {
  const ut = useUiText();
  const [state, setState] = useState<'idle' | 'running' | 'ok' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    // set here, not only initialised: development remounts run the cleanup once in between
    mounted.current = true;
    return () => {
      mounted.current = false;
      window.clearTimeout(timer.current);
    };
  }, []);

  const settle = (next: 'ok' | 'error', message: string | null) => {
    if (!mounted.current) return;
    setState(next);
    setError(message);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => mounted.current && setState('idle'), next === 'ok' ? OK_MS : ERROR_MS);
  };

  const onClick = async () => {
    if (state === 'running') return;
    setState('running');
    setError(null);
    try {
      const r = await run();
      settle(r.ok ? 'ok' : 'error', r.ok ? null : r.error ?? ut('Did not go through'));
    } catch (e) {
      settle('error', e instanceof Error && e.message ? e.message : ut('Did not go through'));
    }
  };

  const text = state === 'ok' ? successLabel : state === 'error' ? ut('Failed — try again') : label;
  return (
    <span className={s.test}>
      <button
        type="button"
        className={s.testButton}
        data-state={state}
        aria-disabled={state === 'running' || undefined}
        aria-busy={state === 'running' || undefined}
        onClick={onClick}
      >
        {state === 'running' ? <span className={s.spin} aria-hidden="true" /> : <Icon name={state === 'ok' ? 'check' : state === 'error' ? 'alert' : icon} size={16} />}
        <span aria-live="polite">{text}</span>
      </button>
      {state === 'error' && error ? (
        <span className={s.testError} role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}

/* ---------------- QuickActionPill ---------------- */

export interface QuickActionPillProps {
  icon?: IconName;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

/** One-tap shortcut under a room's target («+1° на 30 хв», «Провітрити 10 хв»). */
export function QuickActionPill({ icon, label, onClick, disabled }: QuickActionPillProps) {
  return (
    <button type="button" className={s.quick} onClick={onClick} disabled={disabled}>
      {icon ? <Icon name={icon} size={16} /> : null}
      {label}
    </button>
  );
}

/* ---------------- DashedAddButton ---------------- */

export interface DashedAddButtonProps {
  label: string;
  onClick: () => void;
  /** For a button that opens an inline panel. */
  expanded?: boolean;
}

/** «+ Новий профіль», «+ Додати джерело» at the end of a list. */
export function DashedAddButton({ label, onClick, expanded }: DashedAddButtonProps) {
  return (
    <button type="button" className={s.dashed} onClick={onClick} aria-expanded={expanded}>
      <Icon name="plus" size={16} />
      {label}
    </button>
  );
}

/* ---------------- FileButton ---------------- */

export interface FileButtonProps {
  label: string;
  /** File types offered by the browser's dialog («application/json,.json»). */
  accept?: string;
  /** Called with the chosen file; choosing the same file again calls it again. */
  onFile: (file: File) => void;
  variant?: ButtonVariant;
  icon?: IconName;
  loading?: boolean;
  disabled?: boolean;
}

/** A button that opens the browser's file dialog. */
export function FileButton({ label, accept, onFile, variant = 'outline', icon, loading, disabled }: FileButtonProps) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button variant={variant} icon={icon} loading={loading} disabled={disabled} onClick={() => input.current?.click()}>
        {label}
      </Button>
      <input
        ref={input}
        type="file"
        accept={accept}
        hidden
        tabIndex={-1}
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          e.currentTarget.value = '';
          if (file) onFile(file);
        }}
      />
    </>
  );
}
