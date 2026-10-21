import type { CSSProperties } from 'react';
import type { TargetDisplayKind } from '@api/model';
import type { IconName, Tone } from '../types';
import { toneVar } from '../tokens/vars';
import { Icon } from './Icon';
import s from './basic.module.css';

export type TemperatureSize = 'sm' | 'md' | 'lg' | 'xl' | 'hero' | 'dial';

export interface TemperatureProps {
  /** The number behind the text (null → «—»). */
  value: number | null;
  /** Pre-formatted text («19.8°», «−2.5°», «67.6°F»). */
  text: string;
  size: TemperatureSize;
}

/** A temperature in one of the type steps; the dial size stacks «°» and the decimals. */
export function Temperature({ value, text, size }: TemperatureProps) {
  if (value == null) {
    return (
      <span className={s.temp} data-size={size}>
        —
      </span>
    );
  }
  if (size === 'dial') {
    const m = /^([−-]?\d+)([.,]\d+)?(.*)$/.exec(text);
    if (m) {
      return (
        <span className={s.temp} data-size={size} aria-label={text}>
          <span aria-hidden="true">{m[1]}</span>
          <span className={s.tempFrac} aria-hidden="true">
            <span>{m[3] || '°'}</span>
            <span>{m[2] ?? ''}</span>
          </span>
        </span>
      );
    }
  }
  return (
    <span className={s.temp} data-size={size}>
      {text}
    </span>
  );
}

export interface TrendIndicatorProps {
  /** °C per hour; |x| ≤ 0.05 reads as steady. */
  cPerH: number | null;
  text: string;
}

export function TrendIndicator({ cPerH, text }: TrendIndicatorProps) {
  const icon: IconName = cPerH == null || Math.abs(cPerH) <= 0.05 ? 'trendFlat' : cPerH > 0 ? 'trendUp' : 'trendDown';
  return (
    <span className={s.trend}>
      <Icon name={icon} size={14} />
      {text}
    </span>
  );
}

const SOURCE_STYLE: Record<TargetDisplayKind | 'pending', { icon: IconName; color: string; strong: boolean }> = {
  schedule: { icon: 'clock', color: 'var(--ui-text-3)', strong: false },
  profile_updated: { icon: 'clock', color: 'var(--ui-text-3)', strong: false },
  manual: { icon: 'hand', color: 'var(--ui-text-1)', strong: true },
  range: { icon: 'range', color: 'var(--ui-text-1)', strong: true },
  boost: { icon: 'bolt', color: toneVar('heat', 'line'), strong: true },
  window: { icon: 'pause', color: toneVar('warn', 'line'), strong: true },
  airing: { icon: 'airing', color: toneVar('warn', 'line'), strong: true },
  off: { icon: 'power', color: 'var(--ui-text-3)', strong: false },
  monitor: { icon: 'eye', color: 'var(--ui-text-3)', strong: false },
  frost: { icon: 'shield', color: 'var(--ui-text-2)', strong: true },
  presence: { icon: 'users', color: 'var(--ui-text-3)', strong: false },
  calendar: { icon: 'calendar', color: 'var(--ui-text-3)', strong: false },
  room_profile: { icon: 'layers', color: 'var(--ui-text-1)', strong: true },
  preheat: { icon: 'sparkle', color: toneVar('heat', 'line'), strong: true },
  no_data: { icon: 'alert', color: toneVar('err', 'line'), strong: true },
  pending: { icon: 'pencil', color: 'var(--ui-text-1)', strong: true },
};

export interface TargetSourceLineProps {
  kind: TargetDisplayKind | 'pending';
  text: string;
  /** Icon colour override — a cooling boost is blue, not orange. */
  tone?: Tone;
}

/** Where the target comes from. A target is never shown without one of these lines. */
export function TargetSourceLine({ kind, text, tone }: TargetSourceLineProps) {
  const st = SOURCE_STYLE[kind];
  const style = { '--icon-color': tone ? toneVar(tone, 'line') : st.color } as CSSProperties;
  return (
    <span className={s.source} data-strong={st.strong ? '' : undefined}>
      <span className={s.icon} style={style}>
        <Icon name={st.icon} size={14} />
      </span>
      <span className={s.ellipsis}>{text}</span>
    </span>
  );
}

export interface MetaRowProps {
  items: { icon: IconName; text: string; tone?: 'warn' }[];
}

/** Up to three quiet facts in one line (humidity, windows, devices). */
export function MetaRow({ items }: MetaRowProps) {
  return (
    <span className={s.meta}>
      {items.map((m, i) => (
        <span key={`${m.icon}-${i}`} className={s.metaItem} data-tone={m.tone}>
          <Icon name={m.icon} size={14} />
          <span className={s.ellipsis}>{m.text}</span>
        </span>
      ))}
    </span>
  );
}
