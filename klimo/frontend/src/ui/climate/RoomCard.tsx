import type { CSSProperties } from 'react';
import type { RoomStateKind, TargetDisplayKind } from '@api/model';
import { ROOM_STATE_STYLE } from '@api/model';
import type { IconName, Tone } from '../types';
import { toneVar } from '../tokens/vars';
import { useUiNav } from '../UiNavContext';
import { useRouteClick } from '../shell/Link';
import { Icon } from '../basic/Icon';
import { IssueChip, StatusChip } from '../basic/Chips';
import { MetaRow, TargetSourceLine, TrendIndicator, type MetaRowProps } from '../basic/Readouts';
import { Sparkline } from '../viz/charts/Sparkline';
import s from './climate.module.css';

/** A tenth of a degree is not a wave: the card's temperature scale is at least this tall. */
const ROOM_SPARK_MIN_SPAN_C = 1;
/** The target band joins the scale only this close to the line; further off it would flatten it. */
const ROOM_SPARK_BAND_NEAR_C = 1.5;

export interface RoomCardProps {
  /** card: the overview grid · compact: a 64 px row for phone lists. */
  variant: 'card' | 'compact';
  title: string;
  state: RoomStateKind;
  stateLabel: string;
  /** Overrides the state's tone ('wait' takes the tone of the mode it waits for). */
  tone?: Tone;
  /** «19.8°» or «—». */
  tempText: string;
  trend?: { cPerH: number | null; text: string } | null;
  /** Where the target comes from — never a bare number. */
  source: { kind: TargetDisplayKind | 'pending'; text: string; tone?: Tone };
  /** Last 6 h with the target band and the humidity (card variant only). */
  spark?: {
    values: readonly (number | null)[];
    target: readonly (number | null)[] | null;
    below: number;
    above: number;
    humidity?: readonly (number | null)[] | null;
  } | null;
  meta?: MetaRowProps['items'];
  /** The one problem the card has room for; replaces the meta row. */
  issue?: { tone: 'warn' | 'err'; icon: IconName; text: string } | null;
  /** Compact: «→ 20.0°». */
  targetText?: string;
  /** Compact: the line under the name when there is no issue («Пауза · вікно відкрите 12 хв»). */
  subText?: string;
  /** The whole card opens this room. */
  to: string;
  /** «Вітальня: 19.8°, гріє, ціль 20.0° · Дома до 23:00». */
  ariaLabel: string;
}

/** A room at a glance. The card only shows state; targets change inside the room, so a stray tap changes nothing. */
export function RoomCard(p: RoomCardProps) {
  const nav = useUiNav();
  const onClick = useRouteClick(p.to);
  const tone = p.tone ?? ROOM_STATE_STYLE[p.state].tone;
  const icon = ROOM_STATE_STYLE[p.state].icon;

  if (p.variant === 'compact') {
    const style = {
      '--avatar-bg': toneVar(tone, 'bg'),
      '--avatar-fg': toneVar(tone, 'fg'),
      '--issue-line': p.issue ? toneVar(p.issue.tone, 'line') : undefined,
      '--sub-fg': p.issue ? toneVar(p.issue.tone, 'fg') : 'var(--ui-text-3)',
    } as CSSProperties;
    return (
      <a className={s.roomRow} href={nav.href(p.to)} onClick={onClick} aria-label={p.ariaLabel} style={style}>
        <span className={s.roomAvatar} aria-hidden="true">
          <Icon name={icon} size={18} />
          {p.issue ? <span className={s.roomAvatarDot} /> : null}
        </span>
        <span className={s.roomRowText}>
          <span className={s.roomRowTitle}>{p.title}</span>
          <span className={s.roomRowSub}>{p.issue ? p.issue.text : p.subText ?? `${p.stateLabel} · ${p.source.text}`}</span>
        </span>
        <span className={s.roomRowEnd}>
          <span className={s.roomRowTemp}>{p.tempText}</span>
          {p.targetText ? <span className={s.roomRowTarget}>{p.targetText}</span> : null}
        </span>
      </a>
    );
  }

  return (
    <a className={s.roomCard} href={nav.href(p.to)} onClick={onClick} aria-label={p.ariaLabel}>
      <span className={s.roomHead}>
        <span className={s.roomTitle}>{p.title}</span>
        <StatusChip tone={tone} icon={icon} label={p.stateLabel} size={26} />
      </span>
      <span className={s.roomValue}>
        <span className={s.roomTemp}>{p.tempText}</span>
        {p.trend ? <TrendIndicator cPerH={p.trend.cPerH} text={p.trend.text} /> : null}
      </span>
      <TargetSourceLine kind={p.source.kind} text={p.source.text} tone={p.source.tone} />
      {p.spark ? (
        <Sparkline
          values={p.spark.values}
          target={p.spark.target}
          below={p.spark.below}
          above={p.spark.above}
          humidity={p.spark.humidity}
          minSpan={ROOM_SPARK_MIN_SPAN_C}
          bandNear={ROOM_SPARK_BAND_NEAR_C}
          tone={tone}
        />
      ) : (
        <span className={s.roomSparkGap} aria-hidden="true" />
      )}
      <span className={s.roomFoot}>
        {p.issue ? <IssueChip tone={p.issue.tone} icon={p.issue.icon} text={p.issue.text} /> : p.meta && p.meta.length ? <MetaRow items={p.meta.slice(0, 3)} /> : null}
      </span>
    </a>
  );
}
