import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { useUiText } from '../../UiTextContext';
import { useSize } from '../internal/useSize';
import { clamp, fmtAxisDeg, hhmm, pct } from '../internal/util';
import { HOUR_AXIS_3H } from './DayChart';
import s from './charts.module.css';

const DAY_MIN = 1440;
/** Height of the temperature plot; the labels keep clear of its top and bottom. */
const PLOT_H = 168;
const PLOT_TOP = 40;
const PLOT_BOTTOM = 18;
/** A pointer that travels this far drags instead of clicking. */
const DRAG_PX = 4;
/** How close to the line between two stretches a pointer grabs that line. */
const EDGE_PX = 8;
/** Room a time label needs; closer labels go to a second row. */
const CHIP_PX = 50;

export interface ScheduleDaySegment {
  /** Minutes of the local day, 0..1440. */
  start: number;
  end: number;
  /** Profile colour and the ink that reads on it. */
  color: string;
  ink: string;
  /** Profile name, inside the ribbon where it fits. */
  label: string;
  /** The target, or null when the stretch has none (off, frost protection only). */
  value: number | null;
  /** «21.0°», «захист». */
  valueText: string;
  /** Index of the switch point this stretch belongs to (the stretch before the first point belongs to the last one). */
  point: number;
  selected?: boolean;
}

export interface ScheduleDayPoint {
  minute: number;
  /** «17:30, Дома, 21.0°». */
  aria: string;
  selected?: boolean;
}

export interface ScheduleDayChartProps {
  segments: readonly ScheduleDaySegment[];
  /** The switch points of the day, in time order. */
  points: readonly ScheduleDayPoint[];
  /** Which target the line shows. */
  tone: 'heat' | 'cool';
  now?: { minute: number; label: string } | null;
  onSelect(index: number): void;
  /** With it the time labels and the lines between stretches drag along the day, and arrows move a focused label by a step. */
  onMove?(index: number, minute: number): void;
  /** Where point `index` may move. */
  range?(index: number): { min: number; max: number };
  /** With it a stretch drags along the day as a whole: the stretch of point `index` moves by `delta` minutes. */
  onShift?(index: number, delta: number): void;
  /** How far the stretch of point `index` may move as a whole. */
  shiftRange?(index: number): { min: number; max: number };
  /** A profile to paint with: a drag over the chart then paints that stretch (`onPaint`) instead of moving things. */
  brush?: { color: string } | null;
  onPaint?(start: number, end: number): void;
  /** Grid of the moves in minutes. */
  step?: number;
  formatMinute?(minute: number): string;
  /** Scale label of a target («20°»). */
  formatValue?(value: number): string;
  axis?: string[];
  ariaLabel: string;
}

type Gesture =
  | { kind: 'edge'; i: number; from: number; minute: number; min: number; max: number }
  | { kind: 'shift'; i: number; moved: number[]; delta: number; min: number; max: number }
  | { kind: 'paint'; anchor: number; a: number; b: number };

type Live = { g: Gesture; x0: number; active: boolean; rect: DOMRect; pointerId: number; el: HTMLElement; click: number | null };

/**
 * One day of a schedule: the target as a stepped line over the profile stretches, the profile
 * ribbon under it and the switch times above it. A time label is a button: a click selects the
 * point, a drag (or the arrow keys) moves it. On the chart itself the line between two stretches
 * drags, a stretch drags as a whole, and with a brush a drag paints a new stretch.
 */
export function ScheduleDayChart({
  segments,
  points,
  tone,
  now,
  onSelect,
  onMove,
  range,
  onShift,
  shiftRange,
  brush,
  onPaint,
  step = 15,
  formatMinute = hhmm,
  formatValue = (v) => fmtAxisDeg(v),
  axis = HOUR_AXIS_3H,
  ariaLabel,
}: ScheduleDayChartProps) {
  const ut = useUiText();
  const plotRef = useRef<HTMLDivElement>(null);
  const { width } = useSize(plotRef);
  const [gesture, setGestureState] = useState<Gesture | null>(null);
  const live = useRef<Live | null>(null);
  const swallowClick = useRef(false);
  const [hover, setHover] = useState<'edge' | 'stretch' | null>(null);
  const show = (next: Gesture | null) => setGestureState(next);
  const stop = () => {
    live.current = null;
    show(null);
  };

  const active = gesture != null;
  useEffect(() => {
    if (!active) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') stop();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);

  const limits = (i: number) => {
    if (range) return range(i);
    const min = i > 0 ? points[i - 1].minute + step : 0;
    const max = i < points.length - 1 ? points[i + 1].minute - step : DAY_MIN - step;
    return { min, max };
  };
  const snap = (m: number) => clamp(Math.round(m / step) * step, 0, DAY_MIN);
  const minuteAt = (rect: DOMRect, x: number) => clamp(((x - rect.left) / rect.width) * DAY_MIN, 0, DAY_MIN);
  const segmentAt = (m: number) => segments.find((seg) => seg.start <= m && m < seg.end) ?? segments[segments.length - 1];
  /** The point whose line is under `x`, if one is within reach. */
  const edgeAt = (rect: DOMRect, x: number): number | null => {
    let best: number | null = null;
    let dist = EDGE_PX + 1;
    points.forEach((p, i) => {
      const d = Math.abs(rect.left + (p.minute / DAY_MIN) * rect.width - x);
      if (d < dist) {
        dist = d;
        best = i;
      }
    });
    return best;
  };

  // while something is dragged the points and the stretches follow it
  const shiftOf = (i: number) => {
    if (gesture?.kind === 'edge' && gesture.i === i) return gesture.minute - gesture.from;
    if (gesture?.kind === 'shift' && gesture.moved.includes(i)) return gesture.delta;
    return 0;
  };
  const minuteOf = (i: number) => points[i].minute + shiftOf(i);
  const moves = new Map<number, number>();
  points.forEach((p, i) => {
    const d = shiftOf(i);
    if (d) moves.set(p.minute, p.minute + d);
  });
  const shown = moves.size
    ? segments.map((seg) => ({
        ...seg,
        start: seg.start > 0 ? (moves.get(seg.start) ?? seg.start) : seg.start,
        end: seg.end < DAY_MIN ? (moves.get(seg.end) ?? seg.end) : seg.end,
      }))
    : segments;
  const paint = gesture?.kind === 'paint' && gesture.b > gesture.a ? gesture : null;

  const values = shown.map((seg) => seg.value).filter((v): v is number => v != null);
  const lo = values.length ? Math.floor(Math.min(...values)) - 1 : 15;
  const hi = values.length ? Math.ceil(Math.max(...values)) + 1 : 25;
  const y = (v: number) => PLOT_TOP + ((hi - v) / (hi - lo)) * (PLOT_H - PLOT_TOP - PLOT_BOTTOM);
  const every = hi - lo > 4 ? 2 : 1;
  const ticks: number[] = [];
  for (let v = Math.ceil(lo); v <= hi; v++) if (v % every === 0 && y(v) > 10 && y(v) < PLOT_H - 6) ticks.push(v);

  // time labels closer than a label's width go to a second row
  const lanes: number[] = [];
  let lastX = -Infinity;
  let lastLane = 1;
  points.forEach((_, i) => {
    const x = (minuteOf(i) / DAY_MIN) * width;
    const lane = width > 0 && x - lastX < CHIP_PX && lastLane === 0 ? 1 : 0;
    lanes.push(lane);
    lastX = x;
    lastLane = lane;
  });
  const twoLanes = lanes.some((l) => l === 1);

  const swallow = () => {
    swallowClick.current = true;
    window.setTimeout(() => (swallowClick.current = false), 0);
  };

  const begin = (e: PointerEvent<HTMLElement>, g: Gesture, click: number | null) => {
    const rect = plotRef.current?.getBoundingClientRect();
    if (!rect || e.button !== 0) return;
    live.current = { g, x0: e.clientX, active: false, rect, pointerId: e.pointerId, el: e.currentTarget, click };
  };

  const onChipDown = (e: PointerEvent<HTMLButtonElement>, i: number) => {
    if (!onMove) return;
    const r = limits(i);
    begin(e, { kind: 'edge', i, from: points[i].minute, minute: points[i].minute, min: r.min, max: r.max }, null);
  };

  const onSurfaceDown = (e: PointerEvent<HTMLDivElement>) => {
    const rect = plotRef.current?.getBoundingClientRect();
    if (!rect || e.button !== 0 || !segments.length) return;
    const m = minuteAt(rect, e.clientX);
    const under = segmentAt(m).point;
    if (brush && onPaint) return begin(e, { kind: 'paint', anchor: m, a: 0, b: 0 }, under);
    const edge = onMove ? edgeAt(rect, e.clientX) : null;
    if (edge != null) {
      const r = limits(edge);
      return begin(e, { kind: 'edge', i: edge, from: points[edge].minute, minute: points[edge].minute, min: r.min, max: r.max }, under);
    }
    if (onShift && shiftRange) {
      const r = shiftRange(under);
      const next = (under + 1) % points.length;
      return begin(e, { kind: 'shift', i: under, moved: [under, next], delta: 0, min: r.min, max: r.max }, under);
    }
    begin(e, { kind: 'paint', anchor: m, a: 0, b: 0 }, under);
  };

  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    const l = live.current;
    if (!l) {
      // the cursor tells what a drag would do
      const rect = plotRef.current?.getBoundingClientRect();
      if (!rect || e.currentTarget.dataset.surface == null) return;
      const next = brush && onPaint ? null : onMove && edgeAt(rect, e.clientX) != null ? 'edge' : onShift ? 'stretch' : null;
      if (next !== hover) setHover(next);
      return;
    }
    if (!l.active && Math.abs(e.clientX - l.x0) < DRAG_PX) return;
    if (!l.active) {
      l.active = true;
      l.el.setPointerCapture(l.pointerId);
    }
    const m = minuteAt(l.rect, e.clientX);
    const g = l.g;
    if (g.kind === 'edge') {
      const minute = clamp(snap(m), g.min, g.max);
      l.g = { ...g, minute };
    } else if (g.kind === 'shift') {
      const raw = ((e.clientX - l.x0) / l.rect.width) * DAY_MIN;
      l.g = { ...g, delta: clamp(Math.round(raw / step) * step, g.min, g.max) };
    } else {
      if (!brush || !onPaint) return;
      let a = snap(Math.min(g.anchor, m));
      let b = snap(Math.max(g.anchor, m));
      if (b - a < step) {
        if (m >= g.anchor) b = Math.min(DAY_MIN, a + step);
        else a = Math.max(0, b - step);
      }
      l.g = { ...g, a, b };
    }
    show(l.g);
  };

  const onPointerUp = () => {
    const l = live.current;
    if (!l) return;
    stop();
    if (!l.active) {
      // no drag: a click on the chart selects the stretch under it (a label selects through its click)
      if (l.click != null) onSelect(l.click);
      return;
    }
    swallow();
    const g = l.g;
    if (g.kind === 'edge' && g.minute !== g.from) onMove?.(g.i, g.minute);
    else if (g.kind === 'shift' && g.delta) onShift?.(g.i, g.delta);
    else if (g.kind === 'paint' && g.b > g.a) onPaint?.(g.a, g.b);
  };

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (!onMove) return;
    const by = e.shiftKey ? 60 : step;
    const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const r = limits(i);
    const next = clamp(points[i].minute + dir * by, r.min, r.max);
    if (next !== points[i].minute) onMove(i, next);
  };

  const line = tone === 'heat' ? 'var(--ui-tone-heat-line)' : 'var(--ui-tone-cool-line)';
  const fg = tone === 'heat' ? 'var(--ui-tone-heat-fg)' : 'var(--ui-tone-cool-fg)';
  const nowMin = now ? clamp(now.minute, 0, DAY_MIN) : null;
  const dragging = gesture?.kind ?? (brush && onPaint ? 'brush' : hover ?? undefined);

  return (
    <div className={s.sday} role="group" aria-label={ariaLabel} data-gesture={dragging} style={{ '--line': line, '--value': fg } as CSSProperties}>
      <div className={s.sdayChips} data-lanes={twoLanes ? '2' : '1'}>
        {points.map((p, i) => (
          <button
            key={i}
            type="button"
            className={s.sdayChip}
            style={{ left: pct((minuteOf(i) / DAY_MIN) * 100) }}
            data-lane={lanes[i] ? '1' : undefined}
            data-edit={onMove ? '' : undefined}
            data-active={shiftOf(i) ? '' : undefined}
            aria-pressed={p.selected ? true : false}
            aria-label={p.aria}
            title={onMove ? ut('Drag it, or move it with the arrow keys') : undefined}
            onPointerDown={(e) => onChipDown(e, i)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={stop}
            onKeyDown={(e) => onKey(e, i)}
            onClick={() => {
              if (swallowClick.current) return;
              onSelect(i);
            }}
          >
            {formatMinute(minuteOf(i))}
          </button>
        ))}
      </div>

      <div className={s.sdayBody}>
        <div className={s.sdayScale} aria-hidden="true">
          {ticks.map((v) => (
            <span key={v} style={{ top: `${y(v)}px` }}>
              {formatValue(v)}
            </span>
          ))}
        </div>
        <div className={s.sdayLanes}>
          <div
            className={s.sdaySurface}
            data-surface=""
            data-edit={onMove || onShift || onPaint ? '' : undefined}
            aria-hidden="true"
            onPointerDown={onSurfaceDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={stop}
            onPointerLeave={() => !live.current && hover && setHover(null)}
          >
            <div ref={plotRef} className={s.sdayPlot}>
              {ticks.map((v) => (
                <span key={v} className={s.sdayGrid} style={{ top: `${y(v)}px` }} />
              ))}
              {shown.map((seg, i) => {
                const a = clamp(seg.start, 0, DAY_MIN);
                const b = clamp(seg.end, 0, DAY_MIN);
                if (b <= a) return null;
                return (
                  <span
                    key={`t-${i}`}
                    className={s.sdayTint}
                    data-selected={seg.selected ? '' : undefined}
                    style={{ left: pct((a / DAY_MIN) * 100), width: pct(((b - a) / DAY_MIN) * 100), '--fill': seg.color } as CSSProperties}
                  />
                );
              })}
              {points.map((p, i) => (
                <span key={`g-${i}`} className={s.sdayGuide} data-selected={p.selected ? '' : undefined} style={{ left: pct((minuteOf(i) / DAY_MIN) * 100) }} />
              ))}
              {shown.map((seg, i) => {
                const prev = shown[i - 1];
                if (!prev || seg.value == null || prev.value == null || prev.value === seg.value) return null;
                const y1 = y(prev.value);
                const y2 = y(seg.value);
                return (
                  <span
                    key={`c-${i}`}
                    className={s.sdayRise}
                    style={{ left: pct((clamp(seg.start, 0, DAY_MIN) / DAY_MIN) * 100), top: `${Math.min(y1, y2) - 1.5}px`, height: `${Math.abs(y1 - y2) + 3}px` }}
                  />
                );
              })}
              {shown.map((seg, i) => {
                const a = clamp(seg.start, 0, DAY_MIN);
                const b = clamp(seg.end, 0, DAY_MIN);
                if (b <= a) return null;
                const mid = pct(((a + b) / 2 / DAY_MIN) * 100);
                const roomy = ((b - a) / DAY_MIN) * width >= 52;
                if (seg.value == null) {
                  return roomy ? (
                    <span key={`l-${i}`} className={s.sdayNone} style={{ left: mid }}>
                      {seg.valueText}
                    </span>
                  ) : null;
                }
                const top = y(seg.value);
                return (
                  <span key={`l-${i}`}>
                    <span className={s.sdayStep} style={{ left: pct((a / DAY_MIN) * 100), width: pct(((b - a) / DAY_MIN) * 100), top: `${top - 1.5}px` }} />
                    {roomy ? (
                      <span className={s.sdayValue} style={{ left: mid, top: `${top - 24}px` }}>
                        {seg.valueText}
                      </span>
                    ) : null}
                  </span>
                );
              })}
              {nowMin != null && now ? (
                <>
                  <span className={s.sdayNow} style={{ left: pct((nowMin / DAY_MIN) * 100) }} />
                  <span className={s.sdayNowLabel} data-flip={nowMin > DAY_MIN * 0.85 ? '' : undefined} style={{ left: pct((nowMin / DAY_MIN) * 100) }}>
                    {now.label}
                  </span>
                </>
              ) : null}
            </div>

            <div className={s.sdayRibbon}>
              {shown.map((seg, i) => {
                const a = clamp(seg.start, 0, DAY_MIN);
                const b = clamp(seg.end, 0, DAY_MIN);
                if (b <= a) return null;
                const fits = ((b - a) / DAY_MIN) * width >= seg.label.length * 7 + 16;
                return (
                  <span
                    key={`r-${i}`}
                    className={s.sdaySeg}
                    data-selected={seg.selected ? '' : undefined}
                    style={{ left: pct((a / DAY_MIN) * 100), width: pct(((b - a) / DAY_MIN) * 100), '--fill': seg.color, '--ink': seg.ink } as CSSProperties}
                  >
                    {fits ? seg.label : null}
                  </span>
                );
              })}
            </div>

            {paint && brush ? (
              <>
                <span
                  className={s.sdayPaint}
                  style={{ left: pct((paint.a / DAY_MIN) * 100), width: pct(((paint.b - paint.a) / DAY_MIN) * 100), '--fill': brush.color } as CSSProperties}
                />
                <span className={s.sdayBubble} style={{ left: pct(((paint.a + paint.b) / 2 / DAY_MIN) * 100) }}>
                  {`${formatMinute(paint.a)}–${formatMinute(paint.b)}`}
                </span>
              </>
            ) : null}
          </div>

          <div className={s.sdayAxis} aria-hidden="true">
            {axis.map((a, i) => (
              <span key={`${a}-${i}`}>{a}</span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
