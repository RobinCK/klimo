import type { CSSProperties } from 'react';
import type { Action, IconName, Tone } from '../../types';
import { toneVar } from '../../tokens/vars';
import { useUiText } from '../../UiTextContext';
import { Icon } from '../../basic/Icon';
import { Button } from '../../basic/Button';
import { IconButton } from '../../basic/IconButton';
import { StatusChip } from '../../basic/Chips';
import { cx } from '../../viz/internal/util';
import s from './rows.module.css';

/* ---------------------------------- FallbackNote ---------------------------------- */

export interface FallbackNoteProps {
  icon: IconName;
  /** «Резерв — датчики головок 22.6° і 21.8° з поправкою. Лише якщо всі основні недоступні.» */
  text: string;
}

/** What Klimo falls back to when the primary inputs are gone (dashed: not in use right now). */
export function FallbackNote({ icon, text }: FallbackNoteProps) {
  return (
    <div className={s.fallback}>
      <Icon name={icon} size={18} />
      <span>{text}</span>
    </div>
  );
}

/* ---------------------------------- ContactRow ---------------------------------- */

export interface ContactRowProps {
  name: string;
  entityId: string;
  /** «91% · LQI 128». */
  meta: string;
  /** «закрите», «відкрите 12 хв». */
  stateText: string;
  open: boolean;
  /** The sensor is offline: the state is unknown. */
  unavailable?: boolean;
  /** Opens the sensor's settings (name, removal). */
  onEdit?: () => void;
}

/** A window or door contact with its live state. */
export function ContactRow({ name, entityId, meta, stateText, open, unavailable, onEdit }: ContactRowProps) {
  const ut = useUiText();
  return (
    <div className={s.row} data-open={open ? '' : undefined} data-unavailable={unavailable ? '' : undefined}>
      <span className={s.contactIcon}>
        <Icon name={unavailable ? 'offline' : open ? 'windowOpen' : 'windowClosed'} size={18} />
      </span>
      <span className={s.rowText}>
        <span className={s.rowTitle}>{name}</span>
        <span className={s.mono}>{entityId}</span>
      </span>
      <span className={s.rowMeta}>{meta}</span>
      <span className={s.contactState}>{stateText}</span>
      {onEdit ? <IconButton icon="pencil" label={ut('Edit sensor «{name}»', { name })} size={36} variant="ghost" onClick={onEdit} /> : null}
    </div>
  );
}

/* ---------------------------------- TrvCard ---------------------------------- */

export interface TrvCardProps {
  name: string;
  /** «SONOFF TRVZB · Z2M #1». */
  meta: string;
  entityId?: string;
  /** State chips («гріє», «✓ 20.0° підтверджено»). */
  chips: readonly { tone: Tone; icon?: IconName; label: string }[];
  /** «Датчик головки 22.6° +2.8° до кімнати», «Батарея 82%» … */
  stats: readonly { label: string; value: string; sub?: string }[];
  /** What the device supports (strategy options depend on it). */
  capabilities: readonly { label: string; on: boolean }[];
  /** Phone accordion: one chip, three small stats, no capabilities. */
  compact?: boolean;
  /** Opens the valve's settings (name, removal). */
  onEdit?: () => void;
}

/** A radiator valve: state, confirmation, own sensor, battery, signal and what it can do. */
export function TrvCard({ name, meta, entityId, chips, stats, capabilities, compact, onEdit }: TrvCardProps) {
  const ut = useUiText();
  return (
    <div className={s.trv} data-compact={compact ? '' : undefined}>
      <div className={s.trvHead}>
        <span className={s.rowText}>
          <span className={s.trvName}>{name}</span>
          <span className={s.rowSub}>
            {entityId ? (
              <>
                <span className={s.monoInline}>{entityId}</span>
                {' · '}
              </>
            ) : null}
            {meta}
          </span>
        </span>
        <span className={s.trvEnd}>
          <span className={s.chips}>
            {(compact ? chips.slice(0, 1) : chips).map((c, i) => (
              <StatusChip key={`${c.label}-${i}`} tone={c.tone} icon={c.icon} label={c.label} size={compact ? 24 : 26} />
            ))}
          </span>
          {onEdit ? <IconButton icon="pencil" label={ut('Edit «{name}»', { name })} size={36} variant="ghost" onClick={onEdit} /> : null}
        </span>
      </div>
      <div className={s.trvStats}>
        {(compact ? stats.slice(0, 3) : stats).map((st, i) => (
          <span key={`${st.label}-${i}`} className={s.trvStat}>
            <span className={s.trvStatLabel}>{st.label}</span>
            <span>
              <b className={s.trvStatValue}>{st.value}</b>
              {st.sub ? <span className={s.trvStatSub}> {st.sub}</span> : null}
            </span>
          </span>
        ))}
      </div>
      {!compact && capabilities.length ? (
        <div className={s.caps}>
          {capabilities.map((c) => (
            <span key={c.label} className={s.cap} data-on={c.on ? '' : undefined}>
              <span aria-hidden="true">{c.on ? '✓' : '—'}</span> {c.label}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ---------------------------------- EmitterRow ---------------------------------- */

export interface EmitterRowProps {
  /** «Радіатори · 2 головки». */
  title: string;
  /** «від теплового насоса, резерв — газовий котел». */
  sub?: string;
  entityId?: string;
  /** «основне», «догрів», «резерв» in the mode's tone. */
  role: { label: string; tone: Tone };
  /** Temporarily excluded (dew point, humidity, season): true, or the reason as text. */
  blocked?: boolean | string;
}

/** An emitter serving the room for one mode («Чим гріти й охолоджувати»). */
export function EmitterRow({ title, sub, entityId, role, blocked }: EmitterRowProps) {
  const style = { '--chip-bg': toneVar(role.tone, 'bg'), '--chip-fg': toneVar(role.tone, 'fg') } as CSSProperties;
  return (
    <div className={s.row} data-blocked={blocked ? '' : undefined} style={style}>
      <span className={s.rowText}>
        <span className={s.rowTitle}>{title}</span>
        {typeof blocked === 'string' ? (
          <span className={s.blockedText}>{blocked}</span>
        ) : entityId ? (
          <span className={s.mono}>{entityId}</span>
        ) : sub ? (
          <span className={s.rowSub}>{sub}</span>
        ) : null}
      </span>
      <span className={s.pill}>{role.label}</span>
    </div>
  );
}

/* ---------------------------------- ProblemCard ---------------------------------- */

export interface ProblemCardProps {
  icon: IconName;
  tone: 'warn' | 'err';
  /** «Ванна · рушникосушка». */
  title: string;
  meta: { entityId: string; text: string };
  /** «Не підтвердила 24.0° · повтор 2 з 3» — in the card's tone unless a tone is given. */
  chip: string | { tone: Tone; label: string };
  /** What to do about it. */
  hint: string;
  primary: Action;
  secondary?: Action;
}

/** One device problem with the fix and the action that helps. */
export function ProblemCard({ icon, tone, title, meta, chip, hint, primary, secondary }: ProblemCardProps) {
  const style = { '--tone-bg': toneVar(tone, 'bg'), '--tone-fg': toneVar(tone, 'fg') } as CSSProperties;
  return (
    <div className={s.problem} style={style}>
      <div className={s.problemHead}>
        <span className={s.problemIcon}>
          <Icon name={icon} size={18} />
        </span>
        <span className={s.rowText}>
          <span className={s.rowTitle}>{title}</span>
          <span className={s.rowSub}>
            <span className={s.monoInline}>{meta.entityId}</span>
            {meta.text ? ` · ${meta.text}` : null}
          </span>
        </span>
      </div>
      <span className={s.problemChip}>
        <StatusChip tone={typeof chip === 'string' ? tone : chip.tone} label={typeof chip === 'string' ? chip : chip.label} size={26} />
      </span>
      <span className={s.problemHint}>{hint}</span>
      <span className={s.actions}>
        <Button variant="secondary" size="sm" onClick={primary.onClick} to={primary.to} disabled={primary.disabled} loading={primary.loading}>
          {primary.label}
        </Button>
        {secondary ? (
          <Button variant="ghost" size="sm" onClick={secondary.onClick} to={secondary.to} disabled={secondary.disabled} loading={secondary.loading}>
            {secondary.label}
          </Button>
        ) : null}
      </span>
    </div>
  );
}

/* ---------------------------------- InstanceRow ---------------------------------- */

export interface InstanceRowProps {
  name: string;
  /** MQTT base topic. */
  topic: string;
  /** «20 пристроїв». */
  count: string;
  status: { tone: Tone; label: string };
}

/** A Zigbee2MQTT instance and whether it is online. */
export function InstanceRow({ name, topic, count, status }: InstanceRowProps) {
  const style = { '--dot': toneVar(status.tone, 'line'), '--status-fg': toneVar(status.tone, 'fg') } as CSSProperties;
  return (
    <div className={cx(s.row, s.rowWrap)} style={style}>
      <span className={s.rowText}>
        <span className={s.rowTitle}>{name}</span>
        <span className={s.mono}>{topic}</span>
      </span>
      <span className={s.rowCount}>{count}</span>
      <span className={s.status}>
        <span className={s.statusDot} aria-hidden="true" />
        {status.label}
      </span>
    </div>
  );
}

/* ---------------------------------- TargetRow ---------------------------------- */

export interface TargetRowProps {
  name: string;
  /** notify service or chat («notify.mobile_app_phone»). */
  entity: string;
  /** «за таблицею», «лише критичні». */
  scope: string;
  onEdit?: () => void;
  editLabel?: string;
}

/** One notification target of a channel. */
export function TargetRow({ name, entity, scope, onEdit, editLabel }: TargetRowProps) {
  const ut = useUiText();
  return (
    <div className={s.target}>
      <span className={s.rowText}>
        <span className={s.targetName}>{name}</span>
        <span className={s.monoSmall}>{entity}</span>
      </span>
      <span className={s.scope}>{scope}</span>
      {onEdit ? (
        <button type="button" className={s.iconBtn} aria-label={editLabel ?? ut('Edit {name}', { name })} onClick={onEdit}>
          <Icon name="pencil" size={16} />
        </button>
      ) : null}
    </div>
  );
}
