import type { CSSProperties, ReactNode } from 'react';
import type { IconName, Tone } from '../../types';
import { toneVar } from '../../tokens/vars';
import { useUiText } from '../../UiTextContext';
import { useUiNav } from '../../UiNavContext';
import { useRouteClick } from '../../shell/Link';
import { Icon } from '../../basic/Icon';
import { cx } from '../internal/util';
import type { NodeSize } from './layout';
import s from './plant.module.css';

export type NodeTone = Tone | 'fault';

/** Background, border, state ink, icon and title colours of a schema node in a tone. */
export function nodeColors(tone: NodeTone): CSSProperties {
  let c: { bg: string; bd: string; fg: string; ic: string; tt: string };
  switch (tone) {
    case 'idle':
      c = { bg: 'var(--ui-surface-1)', bd: 'var(--ui-border)', fg: 'var(--ui-text-neutral-strong)', ic: 'var(--ui-text-3)', tt: 'var(--ui-text-1)' };
      break;
    case 'off':
      c = { bg: 'var(--ui-bg-chrome)', bd: 'var(--ui-divider)', fg: 'var(--ui-text-disabled)', ic: 'var(--ui-ring)', tt: 'var(--ui-text-3)' };
      break;
    case 'hold':
    case 'mixed':
      c = {
        bg: 'color-mix(in srgb, var(--ui-text-1) 5%, transparent)',
        bd: 'var(--ui-control-off)',
        fg: 'var(--ui-text-1)',
        ic: 'var(--ui-text-1)',
        tt: 'var(--ui-text-1)',
      };
      break;
    default: {
      const t: Tone = tone === 'fault' ? 'err' : tone;
      c = {
        bg: `color-mix(in srgb, ${toneVar(t, 'line')} 10%, transparent)`,
        bd: `color-mix(in srgb, ${toneVar(t, 'line')} 55%, transparent)`,
        fg: toneVar(t, 'fg'),
        ic: toneVar(t, 'line'),
        tt: 'var(--ui-text-1)',
      };
    }
  }
  return { '--node-bg': c.bg, '--node-bd': c.bd, '--node-fg': c.fg, '--node-ic': c.ic, '--node-tt': c.tt } as CSSProperties;
}

/** Arrow colour: flowing energy in its tone, waiting or idle paths in quiet greys. */
export function edgeColor(tone: NodeTone, dashed: boolean): string {
  if (tone === 'off') return 'var(--ui-track)';
  if (tone === 'idle') return 'var(--ui-dot)';
  if (tone === 'wait') return dashed ? 'var(--ui-dot)' : toneVar('wait', 'line');
  if (tone === 'hold' || tone === 'mixed') return 'var(--ui-text-2)';
  return toneVar(tone === 'fault' ? 'err' : tone, 'line');
}

/* ---------------------------------- PlantNodeCard ---------------------------------- */

export interface PlantNodeCardProps {
  icon: IconName;
  title: string;
  state: string;
  meta?: string | null;
  tone: NodeTone;
  size: NodeSize;
  /** Not running (waiting, idle, off): dashed border. */
  dashed?: boolean;
  onClick?: () => void;
  /** Extra text for screen readers (where the arrows go). */
  srText?: string;
}

/** One box of the plant schema: icon, name, state line in the tone, a quiet meta line. */
export function PlantNodeCard({ icon, title, state, meta, tone, size, dashed, onClick, srText }: PlantNodeCardProps) {
  const body = (
    <>
      <span className={s.nodeIcon}>
        <Icon name={icon} size={size === 'rooms' ? 24 : 28} />
      </span>
      <span className={s.nodeText}>
        <span className={s.nodeTitle}>{title}</span>
        <span className={s.nodeState}>{state}</span>
        {meta ? <span className={s.nodeMeta}>{meta}</span> : null}
        {srText ? <span className={s.srOnly}>{srText}</span> : null}
      </span>
    </>
  );
  const props = {
    className: cx(s.node, onClick && s.nodeButton),
    'data-size': size,
    'data-dashed': dashed ? '' : undefined,
    'data-tone': tone,
    style: nodeColors(tone),
  };
  return onClick ? (
    <button type="button" {...props} onClick={onClick}>
      {body}
    </button>
  ) : (
    <div {...props}>{body}</div>
  );
}

/* ---------------------------------- EnergyStrip ---------------------------------- */

export interface EnergyStripProps {
  grid: { present: boolean; label: string };
  /** «сонце 0.0 кВт», «батарея 78%», «будинок 3.4 кВт». */
  items: readonly string[];
  /** The one thing worth noticing («нічний тариф з 23:00», «у тепло 3.6 з 4.0 кВт»). */
  note?: { text: string; tone: Tone } | null;
  /** strip: the schema's full-width bar · compact: the phone status card. */
  variant?: 'strip' | 'compact';
}

/** Grid, solar, battery and house load in one line. */
export function EnergyStrip({ grid, items, note, variant = 'strip' }: EnergyStripProps) {
  const ut = useUiText();
  return (
    <div className={s.energy} data-variant={variant} role="group" aria-label={ut('Energy')}>
      {variant === 'strip' ? (
        <>
          <span className={s.energyIcon}>
            <Icon name="bolt" size={22} />
          </span>
          <span className={s.energyTitle}>{ut('Energy')}</span>
        </>
      ) : null}
      {grid.label ? (
        <span className={s.energyGrid} data-present={grid.present ? '' : undefined}>
          {variant === 'compact' ? <span className={s.energyDot} aria-hidden="true" /> : null}
          {grid.label}
        </span>
      ) : null}
      {items.map((t, i) => (
        <span key={`${t}-${i}`} className={s.energyItem}>
          {t}
        </span>
      ))}
      {note && note.text ? (
        <span className={s.energyNote} style={{ '--note': toneVar(note.tone, 'fg') } as CSSProperties}>
          {note.text}
        </span>
      ) : null}
    </div>
  );
}

/* ---------------------------------- LoopTile ---------------------------------- */

export interface LoopTileProps {
  dotTone: Tone;
  name: string;
  /** With a state the tile is a small card (phone); without, a chip («● радіатори»). */
  state?: string;
  sub?: string;
  /** Pump running: filled dot; otherwise a hollow ring. */
  on?: boolean;
  to?: string;
}

/** A circuit and its pump at a glance. */
export function LoopTile({ dotTone, name, state, sub, on = true, to }: LoopTileProps) {
  const nav = useUiNav();
  const onClick = useRouteClick(to);
  const tile = state != null || sub != null;
  const style = { '--dot': toneVar(dotTone, 'line') } as CSSProperties;
  const content = tile ? (
    <>
      <span className={s.loopHead}>
        <span className={s.loopDot} data-on={on ? '' : undefined} aria-hidden="true" />
        <span className={s.ellipsis}>{name}</span>
      </span>
      {state ? <span className={s.loopState}>{state}</span> : null}
      {sub ? <span className={s.loopSub}>{sub}</span> : null}
    </>
  ) : (
    <>
      <span className={s.loopDot} data-on={on ? '' : undefined} aria-hidden="true" />
      <span className={s.ellipsis}>{name}</span>
    </>
  );
  const cls = cx(tile ? s.loopTile : s.loopChip, to && s.linkish);
  return to ? (
    <a className={cls} style={style} href={nav.href(to)} onClick={onClick} data-on={on ? '' : undefined}>
      {content}
    </a>
  ) : (
    <span className={cls} style={style} data-on={on ? '' : undefined}>
      {content}
    </span>
  );
}

/* ---------------------------------- SourceRow ---------------------------------- */

export interface SourceRowProps {
  icon: IconName;
  name: string;
  meta: string;
  chip: { tone: Tone; label: string };
  /** Running: the icon tile takes the chip's tone. */
  on: boolean;
  to?: string;
}

/** A source in a list (phone system page): icon, name, what it does now, state chip. */
export function SourceRow({ icon, name, meta, chip, on, to }: SourceRowProps) {
  const nav = useUiNav();
  const onClick = useRouteClick(to);
  const style = {
    '--tile-bg': on ? toneVar(chip.tone, 'bg') : 'var(--ui-surface-2)',
    '--tile-fg': on ? toneVar(chip.tone, 'fg') : 'var(--ui-text-3)',
    '--chip-bg': toneVar(chip.tone, 'bg'),
    '--chip-fg': toneVar(chip.tone, 'fg'),
  } as CSSProperties;
  const content = (
    <>
      <span className={s.srcIcon}>
        <Icon name={icon} size={16} />
      </span>
      <span className={s.srcText}>
        <span className={s.srcName}>{name}</span>
        <span className={s.srcMeta}>{meta}</span>
      </span>
      <span className={s.srcChip}>{chip.label}</span>
      {to ? (
        <span className={s.srcChevron} aria-hidden="true">
          <Icon name="chevronRight" size={16} />
        </span>
      ) : null}
    </>
  );
  return to ? (
    <a className={cx(s.srcRow, s.linkish)} style={style} href={nav.href(to)} onClick={onClick}>
      {content}
    </a>
  ) : (
    <div className={s.srcRow} style={style}>
      {content}
    </div>
  );
}

/** Wraps rows (SourceRow) into one card with hairlines between them. */
export function RowList({ children, ariaLabel }: { children: ReactNode; ariaLabel?: string }) {
  return (
    <div className={s.rowList} role={ariaLabel ? 'group' : undefined} aria-label={ariaLabel}>
      {children}
    </div>
  );
}
