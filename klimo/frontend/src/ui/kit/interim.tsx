/*
 * Minimal working versions of the few kit pieces the app chrome needs (season pill,
 * notification bell, status banner, toasts). They keep the kit's public names and props;
 * the full kit supersedes this file.
 */
import { useEffect, useState, type CSSProperties } from 'react';
import { notifications } from '@mantine/notifications';
import type { Action, IconName } from '../types';
import { toneVar } from '../tokens/vars';
import { useUiNav } from '../UiNavContext';
import { useUiText } from '../UiTextContext';
import { useRouteClick } from '../shell/Link';
import { Icon } from '../basic/Icon';
import { StatusDot } from '../basic/Badges';
import { Button } from '../basic/Button';
import s from './interim.module.css';

export interface SeasonPillProps {
  tone: 'heat' | 'cool' | 'off';
  label: string;
  variant: 'outline' | 'filled';
  to: string;
}

export function SeasonPill({ tone, label, variant, to }: SeasonPillProps) {
  const nav = useUiNav();
  const onClick = useRouteClick(to);
  const style = { '--pill-bg': toneVar(tone, 'bg'), '--pill-fg': toneVar(tone, 'fg') } as CSSProperties;
  return (
    <a className={s.pill} data-variant={variant} style={style} href={nav.href(to)} onClick={onClick}>
      <StatusDot tone={tone} size={8} />
      {label}
    </a>
  );
}

export interface NotificationBellProps {
  count: number;
  to: string;
  /** Accessible name, including the count («Сповіщення, 2 нові»). */
  label: string;
}

export function NotificationBell({ count, to, label }: NotificationBellProps) {
  const nav = useUiNav();
  const onClick = useRouteClick(to);
  return (
    <a className={s.bell} href={nav.href(to)} aria-label={label} title={label} onClick={onClick}>
      <Icon name="bell" size={22} />
      {count > 0 ? (
        <span className={s.bellDot}>
          <StatusDot tone="warn" size={8} ring />
        </span>
      ) : null}
    </a>
  );
}

export interface StatusBannerProps {
  tone: 'ok' | 'warn' | 'err' | 'event';
  icon?: IconName;
  text: string;
  action?: Action;
}

const BANNER_ICON: Record<StatusBannerProps['tone'], IconName> = { ok: 'check', warn: 'alert', err: 'offline', event: 'info' };

export function StatusBanner({ tone, icon, text, action }: StatusBannerProps) {
  const style = {
    '--banner-bg': toneVar(tone, 'bg'),
    '--banner-fg': toneVar(tone, 'fg'),
    '--banner-border': `color-mix(in srgb, ${toneVar(tone, 'line')} 35%, transparent)`,
  } as CSSProperties;
  return (
    <div className={s.banner} style={style} role={tone === 'err' ? 'alert' : 'status'}>
      <span className={s.bannerIcon}>
        <Icon name={icon ?? BANNER_ICON[tone]} size={18} />
      </span>
      <span className={s.bannerText}>{text}</span>
      {action ? (
        <Button variant="secondary" size="sm" onClick={action.onClick} to={action.to} disabled={action.disabled} loading={action.loading}>
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}

export interface ToastOptions {
  tone: 'ok' | 'warn' | 'err' | 'info';
  message: string;
  action?: Action;
  durationMs?: number;
}

const TOAST_COLOR = { ok: 'ok', warn: 'warn', err: 'err', info: 'neutral' } as const;
const TOAST_ICON: Record<ToastOptions['tone'], IconName> = { ok: 'check', warn: 'alert', err: 'alert', info: 'info' };

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

/** A transient message; errors stay longer than confirmations. Returns the toast id. */
export function toast({ tone, message, action, durationMs }: ToastOptions): string {
  const id = `toast-${++toastSeq}`;
  notifications.show({
    id,
    color: TOAST_COLOR[tone],
    icon: <Icon name={TOAST_ICON[tone]} size={18} />,
    message: <ToastBody message={message} action={action} close={() => notifications.hide(id)} />,
    autoClose: durationMs ?? (tone === 'err' ? 8000 : 4000),
    withCloseButton: true,
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
    color: 'ok',
    icon: <Icon name="check" size={18} />,
    message: <UndoBody message={message} onUndo={onUndo} seconds={seconds} close={() => notifications.hide(id)} />,
    autoClose: seconds * 1000,
    withCloseButton: false,
  });
  return id;
}
