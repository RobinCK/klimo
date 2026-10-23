import { useEffect, useRef, type CSSProperties } from 'react';
import type { SyncPhase } from '@api/model';
import type { IconName, Tone } from '../../types';
import { toneVar } from '../../tokens/vars';
import { useUiText } from '../../UiTextContext';
import { Icon } from '../../basic/Icon';
import { Button } from '../../basic/Button';
import { Select, type SelectOption } from '../inputs/fields';
import { clamp, cx } from '../internal/util';
import s from './feedback.module.css';

/* ---------------- CountdownBar ---------------- */

export interface CountdownBarProps {
  /** Seconds left. */
  remaining: number;
  total: number;
  /** Paused (dragging, the duration list is open): the bar stays full and grey. */
  frozen?: boolean;
}

/** A 3 px bar that empties as the send countdown runs out. */
export function CountdownBar({ remaining, total, frozen }: CountdownBarProps) {
  const pct = frozen ? 100 : total > 0 ? clamp((remaining / total) * 100, 0, 100) : 0;
  const prev = useRef(pct);
  // refilling (a new tap restarts the countdown) jumps; only the emptying animates
  const refill = pct > prev.current;
  useEffect(() => {
    prev.current = pct;
  }, [pct]);
  return (
    <span className={s.bar} data-frozen={frozen || refill ? '' : undefined} aria-hidden="true">
      <span className={s.barFill} style={{ '--pct': `${pct}%` } as CSSProperties} />
    </span>
  );
}

/* ---------------- SyncIndicator ---------------- */

const SYNC_STYLE: Record<SyncPhase, { icon: IconName; color: string }> = {
  idle: { icon: 'clock', color: 'var(--ui-text-3)' },
  sending: { icon: 'sync', color: toneVar('warn', 'fg') },
  partial: { icon: 'sync', color: toneVar('warn', 'fg') },
  retry: { icon: 'sync', color: toneVar('warn', 'fg') },
  done: { icon: 'check', color: toneVar('ok', 'fg') },
  failed: { icon: 'alert', color: toneVar('err', 'fg') },
};

export interface SyncIndicatorProps {
  phase: SyncPhase;
  /** «надсилаю на 2 головки…», «1 з 2 підтвердила…», «обидві підтвердили». */
  text: string;
}

/** Whether the devices confirmed a change. */
export function SyncIndicator({ phase, text }: SyncIndicatorProps) {
  const st = SYNC_STYLE[phase];
  return (
    <span className={s.sync} data-phase={phase} style={{ '--sync-color': st.color } as CSSProperties} aria-live="polite">
      <Icon name={st.icon} size={16} />
      {text}
    </span>
  );
}

/* ---------------- PendingChangePanel ---------------- */

export interface PendingChangePanelProps<T> {
  /** What the new value will do («Почне гріти · ≈ 25 хв, до 19:40»). */
  consequence: { tone: Tone; icon: IconName; text: string };
  /** How long the change lasts; focusing the list pauses the countdown. Left out when the length is
   *  not a choice (a room under manual control holds every new value). */
  duration?: { value: T; options: SelectOption<T>[]; onChange: (value: T) => void; onFocusChange: (focused: boolean) => void };
  /** In place of the duration list: how long the value holds («Вручну, поки не повернете розклад»). */
  durationNote?: string;
  /** «Надішлю 20.5° на 2 головки за 3 с». */
  countdown: { remaining: number; total: number; text: string; frozen?: boolean };
  onCancel: () => void;
  cancelLabel: string;
  /** Name of the region («Нова ціль · ще не надіслано»). */
  editingLabel: string;
}

/** The 3-second window before a change is sent: consequence, duration, countdown, cancel. */
export function PendingChangePanel<T>({ consequence, duration, durationNote, countdown, onCancel, cancelLabel, editingLabel }: PendingChangePanelProps<T>) {
  const ut = useUiText();
  return (
    <div className={s.statusPanel} role="group" aria-label={editingLabel}>
      <span className={s.consequence} style={{ '--tone-fg': toneVar(consequence.tone, 'fg') } as CSSProperties} aria-live="polite">
        <Icon name={consequence.icon} size={16} />
        {consequence.text}
      </span>
      <div className={s.pendingRow}>
        {duration ? (
          <Select
            value={duration.value}
            options={duration.options}
            onChange={duration.onChange}
            onFocusChange={duration.onFocusChange}
            size="sm"
            ariaLabel={ut('How long the new value lasts')}
          />
        ) : durationNote ? (
          <span className={s.durationNote}>
            <Icon name="hand" size={16} />
            {durationNote}
          </span>
        ) : null}
        <span className={s.countdown}>
          <span className={s.countdownText}>{countdown.text}</span>
          <CountdownBar remaining={countdown.remaining} total={countdown.total} frozen={countdown.frozen} />
        </span>
        <Button variant="outline" size="sm" onClick={onCancel}>
          {cancelLabel}
        </Button>
      </div>
    </div>
  );
}

/* ---------------- UndoBar ---------------- */

export interface UndoBarProps {
  /** «Ціль 20.5° до 23:00». */
  text: string;
  sync?: { phase: SyncPhase; text: string };
  /** Seconds left to undo. */
  remaining: number;
  /** «Повернути». */
  undoLabel: string;
  onUndo: () => void;
}

/** After sending: what was applied, the device confirmation, and an undo that counts down. */
export function UndoBar({ text, sync, remaining, undoLabel, onUndo }: UndoBarProps) {
  const ut = useUiText();
  return (
    <div className={cx(s.statusPanel, s.undoBar)}>
      <span className={s.undoCheck}>
        <Icon name="check" size={18} />
      </span>
      <span className={s.undoText} role="status">
        {text}
      </span>
      {sync ? <SyncIndicator phase={sync.phase} text={sync.text} /> : null}
      <Button variant="secondary" size="sm" icon="undo" onClick={onUndo}>
        {ut('{label} · {n} s', { label: undoLabel, n: Math.max(0, Math.ceil(remaining)) })}
      </Button>
    </div>
  );
}
