import { useEffect, useId, useRef, type CSSProperties } from 'react';
import type { Action, IconName, Tone } from '../../types';
import { useUiText } from '../../UiTextContext';
import { Icon, IconTile } from '../../basic/Icon';
import { Button } from '../../basic/Button';
import { ActionButton } from '../internal/ActionButton';
import { cx, toneVars } from '../internal/util';
import s from './feedback.module.css';

/* ---------------- InlineConfirm ---------------- */

export interface InlineConfirmProps {
  title: string;
  /** The consequence of confirming («Опалення й охолодження зупиняться, захист від замерзання лишається»). */
  text: string;
  confirm: Action;
  cancel: Action;
}

/** A confirmation that opens in place under the control it belongs to; focus moves to it. */
export function InlineConfirm({ title, text, confirm, cancel }: InlineConfirmProps) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // it opens right under the control that asked, so no scroll jump is needed
    ref.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div ref={ref} className={cx(s.statusPanel, s.confirm)} role="group" aria-labelledby={titleId} tabIndex={-1}>
      <p id={titleId} className={s.confirmTitle}>
        {title}
      </p>
      <span className={s.confirmText}>{text}</span>
      <div className={s.confirmActions}>
        <ActionButton action={confirm} variant="primary" size="sm" />
        <ActionButton action={cancel} variant="secondary" size="sm" />
      </div>
    </div>
  );
}

/* ---------------- AutosaveStatus ---------------- */

export interface AutosaveStatusProps {
  state: 'idle' | 'saving' | 'saved' | 'error';
  retry?: () => void;
}

/** «Зберігаю…» → «Збережено» next to an editor that saves by itself. */
export function AutosaveStatus({ state, retry }: AutosaveStatusProps) {
  const ut = useUiText();
  return (
    <span className={s.autosave} data-state={state} role="status">
      {state === 'saving' ? (
        <>
          <span className={s.miniSpin} aria-hidden="true" />
          {ut('Saving…')}
        </>
      ) : state === 'saved' ? (
        <>
          <Icon name="check" size={14} />
          {ut('Saved')}
        </>
      ) : state === 'error' ? (
        <>
          <Icon name="alert" size={14} />
          {ut('Not saved')}
          {retry ? (
            <button type="button" className={s.retry} onClick={retry}>
              {ut('Retry')}
            </button>
          ) : null}
        </>
      ) : null}
    </span>
  );
}

/* ---------------- StatusBanner ---------------- */

export interface StatusBannerProps {
  tone: 'ok' | 'warn' | 'err' | 'event';
  icon?: IconName;
  text: string;
  action?: Action;
}

const BANNER_ICON: Record<StatusBannerProps['tone'], IconName> = { ok: 'check', warn: 'alert', err: 'offline', event: 'info' };

/** A full-width line about the state of things («Знайдено 6 пристроїв у зоні», «Симулятор»). */
export function StatusBanner({ tone, icon, text, action }: StatusBannerProps) {
  return (
    <div className={s.banner} style={toneVars(tone)} role={tone === 'err' ? 'alert' : 'status'} data-tone={tone}>
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

/* ---------------- StateBanner ---------------- */

export interface StateBannerProps {
  tone: Tone;
  /** «Гріє», «Чекає тригер». */
  label: string;
  /** «з 19:04 · подача 38° · COP 3.1». */
  detail?: string;
}

/** The current state of one thing (a source) as a tinted strip with a dot. */
export function StateBanner({ tone, label, detail }: StateBannerProps) {
  return (
    <div className={s.stateBanner} style={toneVars(tone)}>
      <span className={s.stateDot} aria-hidden="true" />
      <span className={s.stateLabel}>{label}</span>
      {detail ? <span className={s.stateDetail}>{detail}</span> : null}
    </div>
  );
}

/* ---------------- EmptyState ---------------- */

export interface EmptyStateProps {
  icon: IconName;
  title: string;
  text?: string;
  action?: Action;
  /** Tone of the icon (ok for «Усе гаразд»). */
  tone?: Tone | 'neutral';
}

export function EmptyState({ icon, title, text, action, tone = 'neutral' }: EmptyStateProps) {
  return (
    <div className={s.empty}>
      <IconTile icon={icon} size={40} tone={tone} />
      <span className={s.emptyTitle}>{title}</span>
      {text ? <span className={s.emptyText}>{text}</span> : null}
      {action ? (
        <span className={s.emptyAction}>
          <ActionButton action={action} variant="secondary" size="sm" />
        </span>
      ) : null}
    </div>
  );
}

/* ---------------- Skeleton ---------------- */

export interface SkeletonProps {
  /** px. */
  height: number;
  /** px or a CSS length («60%»); default the full width. */
  width?: number | string;
  radius?: number;
}

/** Placeholder while data loads (respects reduced motion through the global rule). */
export function Skeleton({ height, width, radius }: SkeletonProps) {
  const style = {
    '--h': `${height}px`,
    '--w': width == null ? undefined : typeof width === 'number' ? `${width}px` : width,
    '--r': radius == null ? undefined : `${radius}px`,
  } as CSSProperties;
  return <span className={s.skeleton} style={style} aria-hidden="true" />;
}
