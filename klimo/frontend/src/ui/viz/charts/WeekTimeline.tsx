import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { clamp, pct } from '../internal/util';
import { HOUR_AXIS_3H } from './DayChart';
import s from './charts.module.css';

const DAY_MIN = 1440;
/** A pointer that travels this far along a day draws a block instead of clicking one. */
const DRAW_PX = 6;

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
  /**
   * With it the boundaries between blocks can be dragged: the boundary after block `index` of `day`
   * moves to `minute` (on the `step` grid, every block staying at least one step long).
   */
  onBoundary?(day: number, index: number, minute: number): void;
  /** With it a drag along a day draws a new block over [start, end). */
  onDraw?(day: number, start: number, end: number): void;
  /** The days that change along with `day` (the days it repeats on): they move with a drag on it. */
  linked?(day: number): readonly number[];
  /** Grid of the drags in minutes. */
  step?: number;
  /** Clock text of a minute of the day («06:30»), shown while dragging. */
  formatMinute?(minute: number): string;
}

type Pos = { d: number; i: number };

/** A boundary being dragged, or a block being drawn (`active` once the pointer has travelled). */
type Gesture =
  | { kind: 'edge'; day: number; i: number; minute: number; min: number; max: number; rect: DOMRect }
  | { kind: 'draw'; day: number; anchor: number; a: number; b: number; x0: number; active: boolean; rect: DOMRect; track: HTMLElement; pointerId: number };

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
 * Editable, the boundaries between blocks drag along the day and a drag across a day draws a block;
 * the days that repeat the dragged one move with it.
 */
export function WeekTimeline({
  days,
  now,
  onSelect,
  axis = HOUR_AXIS_3H,
  ariaLabel,
  onBoundary,
  onDraw,
  linked,
  step = 30,
  formatMinute = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`,
}: WeekTimelineProps) {
  const [pos, setPos] = useState<Pos>(() => initialPos(days));
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const focusNext = useRef(false);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const live = useRef<Gesture | null>(null);
  const swallowClick = useRef(false);

  const safe = validPos(days, pos);

  const show = (next: Gesture | null) => {
    live.current = next;
    setGesture(next);
  };
  const snap = (m: number) => clamp(Math.round(m / step) * step, 0, DAY_MIN);
  const minuteOf = (rect: DOMRect, x: number) => ((x - rect.left) / rect.width) * DAY_MIN;
  // the click that ends a drag is not a click on the block under it
  const swallow = () => {
    swallowClick.current = true;
    window.setTimeout(() => (swallowClick.current = false), 0);
  };

  // Escape drops a drag in progress
  const dragging = gesture != null;
  useEffect(() => {
    if (!dragging) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      live.current = null;
      setGesture(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dragging]);

  const startEdge = (e: PointerEvent<HTMLSpanElement>, d: number, i: number) => {
    const blocks = days[d]?.blocks;
    const track = e.currentTarget.parentElement?.querySelector<HTMLElement>('[data-track]');
    if (!onBoundary || e.button !== 0 || !blocks?.[i + 1] || !track) return;
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    show({ kind: 'edge', day: d, i, minute: blocks[i].end, min: blocks[i].start + step, max: blocks[i + 1].end - step, rect: track.getBoundingClientRect() });
  };

  const startDraw = (e: PointerEvent<HTMLDivElement>, d: number) => {
    if (!onDraw || e.button !== 0 || live.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    live.current = { kind: 'draw', day: d, anchor: minuteOf(rect, e.clientX), a: 0, b: 0, x0: e.clientX, active: false, rect, track: e.currentTarget, pointerId: e.pointerId };
  };

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const g = live.current;
    if (!g) return;
    if (g.kind === 'edge') {
      const minute = clamp(snap(minuteOf(g.rect, e.clientX)), g.min, g.max);
      if (minute !== g.minute) show({ ...g, minute });
      return;
    }
    if (!g.active && Math.abs(e.clientX - g.x0) < DRAW_PX) return;
    if (!g.active) g.track.setPointerCapture(g.pointerId);
    const m = minuteOf(g.rect, e.clientX);
    let a = snap(Math.min(g.anchor, m));
    let b = snap(Math.max(g.anchor, m));
    if (b - a < step) {
      if (m >= g.anchor) b = Math.min(DAY_MIN, a + step);
      else a = Math.max(0, b - step);
      if (b - a < step) a = Math.max(0, b - step);
    }
    if (!g.active || a !== g.a || b !== g.b) show({ ...g, active: true, a, b });
  };

  const onUp = () => {
    const g = live.current;
    if (!g) return;
    show(null);
    if (g.kind === 'edge') {
      swallow();
      if (g.minute !== days[g.day]?.blocks[g.i]?.end) onBoundary?.(g.day, g.i, g.minute);
      return;
    }
    if (!g.active) return;
    swallow();
    onDraw?.(g.day, g.a, g.b);
  };

  // the dragged day and the days that repeat it, which move along
  const moving = new Set(gesture && (gesture.kind === 'edge' || gesture.active) ? [gesture.day, ...(linked?.(gesture.day) ?? [])] : []);
  const lead = gesture?.kind === 'edge' ? days[gesture.day]?.blocks[gesture.i] : undefined;
  const shown = (d: number): readonly ScheduleBlock[] => {
    const blocks = days[d].blocks;
    if (gesture?.kind !== 'edge' || !lead || !moving.has(d)) return blocks;
    return blocks.map((b, i) => {
      // the same plan on a day that repeats it: its boundary moves too
      if (i === gesture.i && b.end === lead.end) return { ...b, end: gesture.minute };
      if (i === gesture.i + 1 && b.start === lead.end) return { ...b, start: gesture.minute };
      return b;
    });
  };

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
    <div
      className={s.week}
      role="group"
      aria-label={ariaLabel}
      data-gesture={gesture && (gesture.kind === 'edge' || gesture.active) ? gesture.kind : undefined}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={() => show(null)}
    >
      {days.map((day, d) => {
        const blocks = shown(d);
        const draw = gesture?.kind === 'draw' && gesture.active && moving.has(d) ? gesture : null;
        const edge = gesture?.kind === 'edge' && gesture.day === d ? gesture : null;
        return (
          <div key={`${day.label}-${d}`} className={s.weekRow} role="group" aria-label={day.label}>
            <span className={s.weekDay} data-today={day.today ? '' : undefined} data-linked={moving.has(d) ? '' : undefined} aria-hidden="true">
              {day.label}
            </span>
            <div className={s.weekLane}>
              <div className={s.weekTrack} data-track="" data-edit={onDraw ? '' : undefined} onPointerDown={(e) => startDraw(e, d)}>
                {blocks.map((b, i) => {
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
                      key={`${day.blocks[i]?.start ?? a}-${i}`}
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
                        if (swallowClick.current) return;
                        setPos({ d, i });
                        onSelect(d, i);
                      }}
                    >
                      {z - a >= 120 ? b.label : null}
                    </button>
                  );
                })}
                {day.today && now != null ? <span className={s.weekNow} style={{ left: pct((clamp(now, 0, 1440) / 1440) * 100) }} /> : null}
                {draw ? (
                  <span className={s.weekDraw} style={{ left: pct((draw.a / 1440) * 100), width: pct(((draw.b - draw.a) / 1440) * 100) }} aria-hidden="true" />
                ) : null}
              </div>
              {/* the boundaries between blocks, to drag; the time steppers of the block's panel are their keyboard way */}
              {onBoundary
                ? blocks.slice(0, -1).map((b, i) => (
                    <span
                      key={`h-${i}`}
                      className={s.weekHandle}
                      style={{ left: pct((clamp(b.end, 0, 1440) / 1440) * 100) }}
                      data-active={edge?.i === i ? '' : undefined}
                      onPointerDown={(e) => startEdge(e, d, i)}
                      aria-hidden="true"
                    />
                  ))
                : null}
              {edge ? (
                <span className={s.weekBubble} style={{ left: pct((edge.minute / 1440) * 100) }} aria-hidden="true">
                  {formatMinute(edge.minute)}
                </span>
              ) : null}
              {draw && draw.day === d ? (
                <span className={s.weekBubble} style={{ left: pct(((draw.a + draw.b) / 2 / 1440) * 100) }} aria-hidden="true">
                  {`${formatMinute(draw.a)}–${formatMinute(draw.b)}`}
                </span>
              ) : null}
            </div>
          </div>
        );
      })}
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
  /**
   * With it each boundary between blocks has a grip to drag up or down: the boundary after block
   * `index` moves to `minute` (on the `step` grid, every block staying at least one step long).
   */
  onBoundary?(index: number, minute: number): void;
  /** Grid of the drag in minutes. */
  step?: number;
  /** Clock text of a minute of the day («06:30»), shown while dragging. */
  formatMinute?(minute: number): string;
}

/** The height a finger needs to grab a grip between two blocks. */
const GRIP_PX = 30;

/* Text box of a block at the kit's type scale: a 13 px name and a 12 px range at line height 1.45. */
const NAME_PX = 19;
const RANGE_PX = 18;
const TALL_PAD = 8;
/** Air kept between the now line and the block's text. */
const NOW_CLEAR = 4;

interface NowFit {
  /** Moves the block's text off the line. */
  style: CSSProperties;
  /** The text could not move: show the range only when it fits. */
  range: boolean;
  /** Nowhere to move the text: the line stops at the block's edge instead of crossing it. */
  stub: boolean;
}

/**
 * Keeps the now line from striking through the block it falls in: the text moves below the line,
 * else above it (dropping the range when that is what fits); when neither fits, the line ends at
 * the block's edge and the time label in the gutter carries it.
 */
function fitAroundNow(blockH: number, lineY: number, tall: boolean, snug: boolean, hasRange: boolean): NowFit {
  const lineTop = lineY - 1 - NOW_CLEAR;
  const lineBottom = lineY + 1 + NOW_CLEAR;
  const tries = tall && hasRange ? [NAME_PX + 1 + RANGE_PX, NAME_PX] : [NAME_PX];
  const textH = tries[0];
  const top = tall && !snug ? TALL_PAD : (blockH - textH) / 2;
  if (lineBottom <= top || lineTop >= top + textH) return { style: {}, range: true, stub: false };
  for (const h of tries) {
    const range = h > NAME_PX;
    if (lineBottom + h + 2 <= blockH) return { style: { justifyContent: 'flex-start', paddingTop: lineBottom }, range, stub: false };
    if (lineTop - h >= 2) return { style: { justifyContent: 'flex-end', paddingBottom: blockH - lineTop }, range, stub: false };
  }
  return { style: {}, range: true, stub: true };
}

/** One day top to bottom (the phone schedule). Arrow keys move between blocks; editable, the grips between blocks drag. */
export function DayTimelineVertical({
  blocks: given,
  now,
  onSelect,
  hourPx = 23,
  ariaLabel,
  onBoundary,
  step = 30,
  formatMinute = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`,
}: DayTimelineVerticalProps) {
  const [active, setActive] = useState(() => Math.max(0, given.findIndex((b) => b.selected)));
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  // a boundary being dragged: the blocks on both sides of it follow
  const [drag, setDragState] = useState<{ i: number; minute: number; min: number; max: number; top: number } | null>(null);
  const dragRef = useRef(drag);
  const setDrag = (next: typeof drag) => {
    dragRef.current = next;
    setDragState(next);
  };
  const blocks = drag
    ? given.map((b, i) => (i === drag.i ? { ...b, end: drag.minute } : i === drag.i + 1 ? { ...b, start: drag.minute } : b))
    : given;
  const minuteAt = (y: number, d: { min: number; max: number; top: number }) =>
    clamp(Math.round(((y - d.top) / hourPx) * 60 / step) * step, d.min, d.max);
  const cur = clamp(active, 0, Math.max(0, blocks.length - 1));
  // grips closer than a finger apart (around a short block) sit side by side
  let lastY = -Infinity;
  let lastAside = false;
  const aside = blocks.slice(0, -1).map((b) => {
    const y = (clamp(b.end, 0, 1440) / 60) * hourPx;
    const moved = y - lastY < GRIP_PX && !lastAside;
    lastY = y;
    lastAside = moved;
    return moved;
  });
  const go = (i: number) => {
    setActive(i);
    refs.current[i]?.focus();
  };
  const hours = [0, 3, 6, 9, 12, 15, 18, 21, 24];
  const nowMin = now ? clamp(now.minute, 0, 1440) : null;
  let stub = false;
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
        const blockH = Math.max(18, h - 2);
        // a two-hour block holds the name and the range only without the top padding: centre them
        const snug = tall && !!b.rangeText && blockH < NAME_PX + 1 + RANGE_PX + 2 * TALL_PAD;
        const fit =
          nowMin !== null && a <= nowMin && nowMin < z
            ? fitAroundNow(blockH, ((nowMin - a) / 60) * hourPx - 1, tall, snug, !!b.rangeText)
            : null;
        if (fit?.stub) stub = true;
        const style = {
          top: `${(a / 60) * hourPx + 1}px`,
          height: `${blockH}px`,
          '--fill': b.color,
          '--ink': b.ink,
          ...(snug ? { justifyContent: 'center', paddingTop: 0, paddingBottom: 0 } : null),
          ...fit?.style,
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
            {tall && b.rangeText && (fit?.range ?? true) ? <span className={s.dayVRange}>{b.rangeText}</span> : null}
          </button>
        );
      })}
      {/* the grips between blocks; the time steppers of the block's sheet are their keyboard way */}
      {onBoundary
        ? blocks.slice(0, -1).map((b, i) => (
            <span
              key={`g-${i}`}
              className={s.dayVGrip}
              style={{ top: `${(clamp(b.end, 0, 1440) / 60) * hourPx}px` }}
              data-active={drag?.i === i ? '' : undefined}
              data-aside={aside[i] ? '' : undefined}
              aria-hidden="true"
              onPointerDown={(e) => {
                const next = given[i + 1];
                const box = e.currentTarget.parentElement?.getBoundingClientRect();
                if (e.button !== 0 || !next || !box) return;
                e.preventDefault();
                e.currentTarget.setPointerCapture(e.pointerId);
                setDrag({ i, minute: given[i].end, min: given[i].start + step, max: next.end - step, top: box.top });
              }}
              onPointerMove={(e) => {
                const d = dragRef.current;
                if (!d || d.i !== i) return;
                const minute = minuteAt(e.clientY, d);
                if (minute !== d.minute) setDrag({ ...d, minute });
              }}
              onPointerUp={() => {
                const d = dragRef.current;
                if (!d || d.i !== i) return;
                setDrag(null);
                if (d.minute !== given[i].end) onBoundary(i, d.minute);
              }}
              onPointerCancel={() => setDrag(null)}
            />
          ))
        : null}
      {drag ? (
        <span className={s.dayVBubble} style={{ top: `${(drag.minute / 60) * hourPx}px` }} data-aside={aside[drag.i] ? '' : undefined} aria-hidden="true">
          {formatMinute(drag.minute)}
        </span>
      ) : null}
      {now ? (
        <span aria-hidden="true">
          <span className={s.dayVNow} data-stub={stub ? '' : undefined} style={{ top: `${(clamp(now.minute, 0, 1440) / 60) * hourPx - 1}px` }} />
          <span className={s.dayVNowLabel} style={{ top: `${(clamp(now.minute, 0, 1440) / 60) * hourPx}px` }}>
            {now.label}
          </span>
        </span>
      ) : null}
    </div>
  );
}
