import type { CSSProperties } from 'react';
import type { RoomStateKind } from '@api/model';
import { ROOM_STATE_STYLE } from '@api/model';
import type { IconName, Tone } from '../types';
import { toneVar } from '../tokens/vars';
import { Icon } from './Icon';
import s from './basic.module.css';

export type ChipSize = 24 | 26 | 30;

const CHIP_SIZE: Record<ChipSize, { px: number; fs: number; icon: 14 | 16 }> = {
  24: { px: 8, fs: 12, icon: 14 },
  26: { px: 10, fs: 12, icon: 14 },
  30: { px: 12, fs: 13, icon: 16 },
};

export interface StatusChipProps {
  tone: Tone;
  icon?: IconName;
  label: string;
  size?: ChipSize;
}

/** Pill in a tone: the language of states («Гріє», «Тримає», «Вікно» …). */
export function StatusChip({ tone, icon, label, size = 26 }: StatusChipProps) {
  const d = CHIP_SIZE[size];
  const style = {
    '--h': `${size}px`,
    '--px': `${d.px}px`,
    '--fs': `${d.fs}px`,
    '--chip-bg': toneVar(tone, 'bg'),
    '--chip-fg': toneVar(tone, 'fg'),
  } as CSSProperties;
  return (
    <span className={s.chip} style={style}>
      {icon ? <Icon name={icon} size={d.icon} /> : null}
      {label}
    </span>
  );
}

export interface RoomStateChipProps {
  state: RoomStateKind;
  label: string;
  size?: ChipSize;
  /** Overrides the default tone — 'wait' takes the tone of the mode it waits for. */
  tone?: Tone;
}

export function RoomStateChip({ state, label, size, tone }: RoomStateChipProps) {
  const style = ROOM_STATE_STYLE[state];
  return <StatusChip tone={tone ?? style.tone} icon={style.icon} label={label} size={size} />;
}

export interface IssueChipProps {
  tone: 'warn' | 'err';
  icon: IconName;
  text: string;
}

/** The one problem a card has room for; long texts end in an ellipsis. */
export function IssueChip({ tone, icon, text }: IssueChipProps) {
  const style = { '--chip-bg': toneVar(tone, 'bg'), '--chip-fg': toneVar(tone, 'fg') } as CSSProperties;
  return (
    <span className={s.issue} style={style} title={text}>
      <Icon name={icon} size={14} />
      <span className={s.ellipsis}>{text}</span>
    </span>
  );
}
