import { useEffect, useState, type CSSProperties } from 'react';
import { notifications } from '@mantine/notifications';
import type { Action, IconName } from '../../types';
import { useUiText } from '../../UiTextContext';
import { Icon } from '../../basic/Icon';
import { Button } from '../../basic/Button';
import s from './feedback.module.css';

export interface ToastOptions {
  tone: 'ok' | 'warn' | 'err' | 'info';
  message: string;
  action?: Action;
  durationMs?: number;
}

const TOAST_ICON: Record<ToastOptions['tone'], IconName> = { ok: 'check', warn: 'alert', err: 'alert', info: 'info' };
const TOAST_ICON_COLOR: Record<ToastOptions['tone'], string> = {
  ok: 'var(--ui-tone-ok-fg)',
  warn: 'var(--ui-tone-warn-fg)',
  err: 'var(--ui-tone-err-fg)',
  info: 'var(--ui-text-2)',
};

const CLASS_NAMES = { root: s.toast, icon: s.toastIcon, description: s.toastDescription, closeButton: s.toastClose };

function toneStyle(tone: ToastOptions['tone']): CSSProperties {
  return {
    '--toast-icon': TOAST_ICON_COLOR[tone],
    '--toast-border': tone === 'err' ? 'color-mix(in srgb, var(--ui-tone-err-line) 45%, transparent)' : undefined,
  } as CSSProperties;
}

function ToastBody({ message, action, close }: { message: string; action?: Action; close: () => void }) {
  return (
    <span className={s.toastBody}>
      <span className={s.toastText}>{message}</span>
      {action ? (
        <Button
          variant="secondary"
          size="sm"
          to={action.to}
          disabled={action.disabled}
          onClick={() => {
            action.onClick?.();
            close();
          }}
        >
          {action.label}
        </Button>
      ) : null}
    </span>
  );
}

let toastSeq = 0;

/**
 * A transient message in the corner; errors stay longer than confirmations and are announced
 * assertively. Returns the toast id.
 */
export function toast({ tone, message, action, durationMs }: ToastOptions): string {
  const id = `toast-${++toastSeq}`;
  notifications.show({
    id,
    icon: <Icon name={TOAST_ICON[tone]} size={18} />,
    message: <ToastBody message={message} action={action} close={() => notifications.hide(id)} />,
    autoClose: durationMs ?? (tone === 'err' ? 8000 : action ? 6000 : 4000),
    withCloseButton: true,
    classNames: CLASS_NAMES,
    style: toneStyle(tone),
    role: tone === 'err' ? 'alert' : 'status',
  });
  return id;
}

function UndoBody({ message, onUndo, seconds, close }: { message: string; onUndo: () => void; seconds: number; close: () => void }) {
  const ut = useUiText();
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    const started = Date.now();
    const timer = window.setInterval(() => {
      const n = seconds - Math.floor((Date.now() - started) / 1000);
      setLeft(Math.max(0, n));
      if (n <= 0) window.clearInterval(timer);
    }, 250);
    return () => window.clearInterval(timer);
  }, [seconds]);
  return (
    <span className={s.toastBody}>
      <span className={s.toastText}>{message}</span>
      <Button
        variant="secondary"
        size="sm"
        icon="undo"
        onClick={() => {
          onUndo();
          close();
        }}
      >
        {ut('Undo · {n}', { n: left })}
      </Button>
    </span>
  );
}

/** «Done — Undo · 8»: the change is already applied, the button reverts it. */
export function undoToast({ message, onUndo, seconds }: { message: string; onUndo: () => void; seconds: number }): string {
  const id = `undo-${++toastSeq}`;
  notifications.show({
    id,
    icon: <Icon name="check" size={18} />,
    message: <UndoBody message={message} onUndo={onUndo} seconds={seconds} close={() => notifications.hide(id)} />,
    autoClose: seconds * 1000,
    withCloseButton: false,
    classNames: CLASS_NAMES,
    style: toneStyle('ok'),
    role: 'status',
  });
  return id;
}
