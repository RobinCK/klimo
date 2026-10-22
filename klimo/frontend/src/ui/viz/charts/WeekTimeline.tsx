import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { clamp, pct } from '../internal/util';
import { HOUR_AXIS_3H } from './DayChart';
import s from './charts.module.css';

export interface ScheduleBlock {
  /** Minutes of the local day, 0..1440. */
  start: number;
  end: number;
  /** Profile colour and its ink. */
  color: string;
  ink: string;
  /** Profile name (shown when the block is at least two hours long). */
  label: string;
  /** Full description for screen readers: «Ср 06:30–08:30, Дома». */
  aria: string;
  selected?: boolean;
}

export interface WeekTimelineDay {
  label: string;
  today: boolean;
  blocks: readonly ScheduleBlock[];
}

export interface WeekTimelineProps {
  days: readonly WeekTimelineDay[];
  /** Minute of today for the now marker on today's row. */
  now?: number | null;
  onSelect(day: number, index: number): void;
  axis?: string[];
  ariaLabel?: string;
}

type Pos = { d: number; i: number };

function initialPos(days: readonly WeekTimelineDay[]): Pos {
  for (let d = 0; d < days.length; d++) {
    const i = days[d].blocks.findIndex((b) => b.selected);
    if (i >= 0) return { d, i };
  }
  const today = days.findIndex((day) => day.today && day.blocks.length);
  if (today >= 0) return { d: today, i: 0 };
  const any = days.findIndex((day) => day.blocks.length);
  return { d: Math.max(0, any), i: 0 };
}

/** Keeps the roving position on an existing block when the schedule changes underneath it. */
function validPos(days: readonly WeekTimelineDay[], pos: Pos): Pos {
  if (days[pos.d]?.blocks[pos.i]) return pos;
  const d = clamp(pos.d, 0, Math.max(0, days.length - 1));
  return { d, i: clamp(pos.i, 0, Math.max(0, (days[d]?.blocks.length ?? 1) - 1)) };
}

/** The block of `blocks` that covers minute `m` (or the nearest one). */
function blockAt(blocks: readonly ScheduleBlock[], m: number): number {
  const hit = blocks.findIndex((b) => b.start <= m && m < b.end);
  if (hit >= 0) return hit;
  let best = 0;
  let dist = Infinity;
  blocks.forEach((b, i) => {
    const dd = Math.min(Math.abs(b.start - m), Math.abs(b.end - m));
    if (dd < dist) {
      dist = dd;
      best = i;
    }
  });
  return best;
}

/**
 * Seven 24-hour rows of schedule blocks. One block is in the tab order; arrows move between
 * blocks (left/right in a day, up/down to the block at the same time on the next day).
 */
export function WeekTimeline({ days, now, onSelect, axis = HOUR_AXIS_3H, ariaLabel }: WeekTimelineProps) {
  const [pos, setPos] = useState<Pos>(() => initialPos(days));
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const focusNext = useRef(false);

  const safe = validPos(days, pos);

  useEffect(() => {
    if (!focusNext.current) return;
    focusNext.current = false;
    refs.current.get(`${safe.d}:${safe.i}`)?.focus();
  });

  const move = (to: Pos) => {
    focusNext.current = true;
    setPos(to);
  };

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, d: number, i: number) => {
    const blocks = days[d].blocks;
    const mid = (blocks[i].start + blocks[i].end) / 2;
    const vertical = (dir: 1 | -1) => {
      for (let nd = d + dir; nd >= 0 && nd < days.length; nd += dir) {
        if (days[nd].blocks.length) return move({ d: nd, i: blockAt(days[nd].blocks, mid) });
      }
    };
    switch (e.key) {
      case 'ArrowRight':
        if (i + 1 < blocks.length) move({ d, i: i + 1 });
        break;
      case 'ArrowLeft':
        if (i > 0) move({ d, i: i - 1 });
        break;
      case 'ArrowDown':
        vertical(1);
        break;
      case 'ArrowUp':
        vertical(-1);
        break;
      case 'Home':
        move({ d, i: 0 });
        break;
      case 'End':
        move({ d, i: blocks.length - 1 });
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  return (
    <div className={s.week} role="group" aria-label={ariaLabel}>
      {days.map((day, d) => (
        <div key={`${day.label}-${d}`} className={s.weekRow} role="group" aria-label={day.label}>
          <span className={s.weekDay} data-today={day.today ? '' : undefined} aria-hidden="true">
            {day.label}
          </span>
          <div className={s.weekTrack}>
            {day.blocks.map((b, i) => {
              const a = clamp(b.start, 0, 1440);
              const z = clamp(b.end, 0, 1440);
              const style = {
                left: pct((a / 1440) * 100),
                width: pct(((z - a) / 1440) * 100),
                '--fill': b.color,
                '--ink': b.ink,
              } as CSSProperties;
              return (
                <button
                  key={`${a}-${i}`}
                  ref={(el) => {
                    if (el) refs.current.set(`${d}:${i}`, el);
                    else refs.current.delete(`${d}:${i}`);
                  }}
                  type="button"
                  className={s.weekBlock}
                  style={style}
                  aria-label={b.aria}
                  aria-pressed={b.selected ? true : false}
                  tabIndex={safe.d === d && safe.i === i ? 0 : -1}
                  onFocus={() => (safe.d !== d || safe.i !== i) && setPos({ d, i })}
                  onKeyDown={(e) => onKey(e, d, i)}
                  onClick={() => {
                    setPos({ d, i });
                    onSelect(d, i);
                  }}
                >
                  {z - a >= 120 ? b.label : null}
                </button>
              );
            })}
            {day.today && now != null ? <span className={s.weekNow} style={{ left: pct((clamp(now, 0, 1440) / 1440) * 100) }} /> : null}
          </div>
        </div>
      ))}
      <div className={s.weekAxis} aria-hidden="true">
        {axis.map((a, i) => (
          <span key={`${a}-${i}`}>{a}</span>
        ))}
      </div>
    </div>
  );
}

export interface DayTimelineBlock extends ScheduleBlock {
  /** «21.0°» next to the name. */
  valueText?: string;
  /** «06:30–08:30» under the name on blocks tall enough for it. */
  rangeText?: string;
}

export interface DayTimelineVerticalProps {
  blocks: readonly DayTimelineBlock[];
  now?: { minute: number; label: string } | null;
  onSelect(index: number): void;
  /** Pixels per hour (23 → a 552 px day). */
  hourPx?: number;
  ariaLabel?: string;
}

/** One day top to bottom (the phone schedule). Arrow keys move between blocks. */
export function DayTimelineVertical({ blocks, now, onSelect, hourPx = 23, ariaLabel }: DayTimelineVerticalProps) {
  const [active, setActive] = useState(() => Math.max(0, blocks.findIndex((b) => b.selected)));
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const cur = clamp(active, 0, Math.max(0, blocks.length - 1));
  const go = (i: number) => {
    setActive(i);
    refs.current[i]?.focus();
  };
  const hours = [0, 3, 6, 9, 12, 15, 18, 21, 24];
  return (
    <div className={s.dayV} style={{ '--day-h': `${hourPx * 24}px` } as CSSProperties} role="group" aria-label={ariaLabel}>
      {hours.map((h) => (
        <span key={h} aria-hidden="true">
          <span className={s.dayVHour} style={{ top: `${h * hourPx}px` }}>
            {String(h).padStart(2, '0')}
          </span>
          <span className={s.dayVRule} style={{ top: `${h * hourPx}px` }} />
        </span>
      ))}
      {blocks.map((b, i) => {
        const a = clamp(b.start, 0, 1440);
        const z = clamp(b.end, 0, 1440);
        const h = ((z - a) / 60) * hourPx;
        const tall = h >= 44;
        const style = {
          top: `${(a / 60) * hourPx + 1}px`,
          height: `${Math.max(18, h - 2)}px`,
          '--fill': b.color,
          '--ink': b.ink,
        } as CSSProperties;
        return (
          <button
            key={`${a}-${i}`}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            className={s.dayVBlock}
            data-tall={tall ? '' : undefined}
            style={style}
            aria-label={b.aria}
            aria-pressed={b.selected ? true : false}
            tabIndex={i === cur ? 0 : -1}
            onFocus={() => setActive(i)}
            onKeyDown={(e) => {
              const to = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? blocks.length - 1 : -2;
              if (to === -2) return;
              e.preventDefault();
              if (to >= 0 && to < blocks.length) go(to);
            }}
            onClick={() => {
              setActive(i);
              onSelect(i);
            }}
          >
            <span className={s.dayVHead}>
              <span className={s.dayVName}>{b.label}</span>
              {b.valueText ? <span className={s.dayVValue}>{b.valueText}</span> : null}
            </span>
            {tall && b.rangeText ? <span className={s.dayVRange}>{b.rangeText}</span> : null}
          </button>
        );
      })}
      {now ? (
        <span aria-hidden="true">
          <span className={s.dayVNow} style={{ top: `${(clamp(now.minute, 0, 1440) / 60) * hourPx - 1}px` }} />
          <span className={s.dayVNowLabel} style={{ top: `${(clamp(now.minute, 0, 1440) / 60) * hourPx}px` }}>
            {now.label}
          </span>
        </span>
      ) : null}
    </div>
  );
}
