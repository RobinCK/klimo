import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { Action, Tone } from '../../types';
import { toneVar } from '../../tokens/vars';
import { useUiText } from '../../UiTextContext';
import { Icon } from '../../basic/Icon';
import { Button } from '../../basic/Button';
import s from './display.module.css';

/* ---------------- KeyValueList ---------------- */

export interface KeyValueRow {
  key: string;
  value: ReactNode;
  /** The value is an id or a template (mono). */
  mono?: boolean;
  /** A small link-button on the right («Змінити»). */
  action?: Action;
}

export interface KeyValueListProps {
  rows: KeyValueRow[];
  /** rows: key and value side by side in wells · stacked: caption over value in one card (review lists). */
  variant?: 'rows' | 'stacked';
}

export function KeyValueList({ rows, variant = 'rows' }: KeyValueListProps) {
  return (
    <ul className={s.kv} data-variant={variant}>
      {rows.map((r, i) => {
        const value = (
          <span className={s.kvValue} data-mono={r.mono ? '' : undefined}>
            {r.value}
          </span>
        );
        const action = r.action ? (
          <Button variant="link" size="sm" onClick={r.action.onClick} to={r.action.to} disabled={r.action.disabled}>
            {r.action.label}
          </Button>
        ) : null;
        return (
          <li key={`${r.key}-${i}`} className={s.kvRow}>
            {variant === 'stacked' ? (
              <span className={s.kvStack}>
                <span className={s.kvKey}>{r.key}</span>
                {value}
              </span>
            ) : (
              <>
                <span className={s.kvKey}>{r.key}</span>
                <span className={s.kvEnd}>
                  {value}
                  {action}
                </span>
              </>
            )}
            {variant === 'stacked' ? action : null}
          </li>
        );
      })}
    </ul>
  );
}

/* ---------------- EntityId ---------------- */

export interface EntityIdProps {
  id: string;
  copyable?: boolean;
}

/** A Home Assistant entity id: mono, ellipsis, optionally one-tap copy. */
export function EntityId({ id, copyable }: EntityIdProps) {
  const ut = useUiText();
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked (insecure context): the id is selectable text anyway
    }
  };
  return (
    <span className={s.entityId}>
      <span className={s.entityIdText} title={id}>
        {id}
      </span>
      {copyable ? (
        <button
          type="button"
          className={s.copy}
          data-copied={copied ? '' : undefined}
          aria-label={copied ? ut('Copied') : ut('Copy {id}', { id })}
          title={copied ? ut('Copied') : ut('Copy')}
          onClick={copy}
        >
          <Icon name={copied ? 'check' : 'copy'} size={14} />
        </button>
      ) : null}
    </span>
  );
}

/* ---------------- RelativeTime ---------------- */

export interface RelativeTimeProps {
  /** «4 хв тому». */
  text: string;
  /** The exact time on hover («22.10 19:04»). */
  title: string;
  tone?: Tone;
  /** ISO date for the machine-readable attribute. */
  dateTime?: string;
}

export function RelativeTime({ text, title, tone, dateTime }: RelativeTimeProps) {
  const style = tone ? ({ '--time-color': toneVar(tone, 'fg') } as CSSProperties) : undefined;
  return (
    <time className={s.time} title={title} dateTime={dateTime} style={style}>
      {text}
    </time>
  );
}

/* ---------------- CodeBlock ---------------- */

export interface CodeBlockProps {
  code: string;
  /** Wrap long lines instead of scrolling sideways. */
  wrap?: boolean;
  ariaLabel?: string;
}

/** YAML, templates, event payloads. */
export function CodeBlock({ code, wrap, ariaLabel }: CodeBlockProps) {
  // a scrollable block must be reachable by keyboard
  return (
    <pre className={s.code} data-wrap={wrap ? '' : undefined} tabIndex={wrap ? undefined : 0} aria-label={ariaLabel}>
      <code>{code}</code>
    </pre>
  );
}

/* ---------------- NumberedList ---------------- */

export function NumberedList({ items }: { items: ReactNode[] }) {
  return (
    <ol className={s.numbered}>
      {items.map((item, i) => (
        <li key={i}>
          <span className={s.num} aria-hidden="true">
            {i + 1}
          </span>
          <span>{item}</span>
        </li>
      ))}
    </ol>
  );
}

/* ---------------- CapabilityChip ---------------- */

export interface CapabilityChipProps {
  on: boolean;
  label: string;
}

/** What a device can do: «✓ зовнішній датчик» or «— дитячий замок». */
export function CapabilityChip({ on, label }: CapabilityChipProps) {
  const ut = useUiText();
  return (
    <span className={s.cap} data-off={on ? undefined : ''}>
      <Icon name={on ? 'check' : 'minus'} size={14} title={on ? ut('supported') : ut('not supported')} />
      {label}
    </span>
  );
}

/* ---------------- LegendSwatch ---------------- */

export interface LegendSwatchProps {
  tone?: Tone;
  /** An explicit colour (profile colours); wins over the tone. */
  color?: string;
  /** solid · band (target band) · dashed (planned) · runon (pump run-on) · line (a chart line). */
  variant?: 'solid' | 'band' | 'dashed' | 'runon' | 'line';
  label: string;
}

export function LegendSwatch({ tone, color, variant = 'solid', label }: LegendSwatchProps) {
  const sw = color ?? (tone ? toneVar(tone, 'line') : 'var(--ui-text-1)');
  return (
    <span className={s.legend}>
      <span className={s.swatch} data-variant={variant} style={{ '--sw': sw } as CSSProperties} aria-hidden="true" />
      {label}
    </span>
  );
}
