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
/** A pointer that travels this far drags a time label instead of clicking it. */
const DRAG_PX = 4;
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
  /** With it the time labels drag along the day, and arrows move a focused one by a step. */
  onMove?(index: number, minute: number): void;
  /** Where point `index` may move. */
  range?(index: number): { min: number; max: number };
  /** Grid of the moves in minutes. */
  step?: number;
  formatMinute?(minute: number): string;
  /** Scale label of a target («20°»). */
  formatValue?(value: number): string;
  axis?: string[];
  ariaLabel: string;
}

type Drag = { i: number; from: number; minute: number; min: number; max: number; x0: number; moved: boolean; rect: DOMRect };

/**
 * One day of a schedule: the target as a stepped line over the profile stretches, the profile
 * ribbon under it and the switch times above it. A time label is a button: a click selects the
 * point, a drag (or the arrow keys) moves it along the day.
 */
export function ScheduleDayChart({
  segments,
  points,
  tone,
  now,
  onSelect,
  onMove,
  range,
  step = 15,
  formatMinute = hhmm,
  formatValue = (v) => fmtAxisDeg(v),
  axis = HOUR_AXIS_3H,
  ariaLabel,
}: ScheduleDayChartProps) {
  const ut = useUiText();
  const plotRef = useRef<HTMLDivElement>(null);
  const { width } = useSize(plotRef);
  const [drag, setDragState] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const swallowClick = useRef(false);
  const setDrag = (next: Drag | null) => {
    dragRef.current = next;
    setDragState(next);
  };

  const dragging = drag?.moved ?? false;
  useEffect(() => {
    if (!dragging) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setDrag(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dragging]);

  const limits = (i: number) => {
    if (range) return range(i);
    const min = i > 0 ? points[i - 1].minute + step : 0;
    const max = i < points.length - 1 ? points[i + 1].minute - step : DAY_MIN - step;
    return { min, max };
  };

  // while a label is dragged its point and the stretches on both sides of it follow
  const minuteOf = (i: number) => (drag?.moved && drag.i === i ? drag.minute : points[i].minute);
  const shown = segments.map((seg) => {
    if (!drag?.moved) return seg;
    return {
      ...seg,
      start: seg.start === drag.from && seg.start > 0 ? drag.minute : seg.start,
      end: seg.end === drag.from ? drag.minute : seg.end,
    };
  });

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

  const onDown = (e: PointerEvent<HTMLButtonElement>, i: number) => {
    const rect = plotRef.current?.getBoundingClientRect();
    if (!onMove || e.button !== 0 || !rect) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const r = limits(i);
    setDrag({ i, from: points[i].minute, minute: points[i].minute, min: r.min, max: r.max, x0: e.clientX, moved: false, rect });
  };
  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    if (!d) return;
    if (!d.moved && Math.abs(e.clientX - d.x0) < DRAG_PX) return;
    const raw = ((e.clientX - d.rect.left) / d.rect.width) * DAY_MIN;
    const minute = clamp(Math.round(raw / step) * step, d.min, d.max);
    if (!d.moved || minute !== d.minute) setDrag({ ...d, moved: true, minute });
  };
  const onUp = () => {
    const d = dragRef.current;
    if (!d) return;
    setDrag(null);
    if (!d.moved) return;
    swallow();
    if (d.minute !== d.from) onMove?.(d.i, d.minute);
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

  return (
    <div className={s.sday} role="group" aria-label={ariaLabel} data-dragging={dragging ? '' : undefined} style={{ '--line': line, '--value': fg } as CSSProperties}>
      <div className={s.sdayChips} data-lanes={twoLanes ? '2' : '1'}>
        {points.map((p, i) => (
          <button
            key={i}
            type="button"
            className={s.sdayChip}
            style={{ left: pct((minuteOf(i) / DAY_MIN) * 100) }}
            data-lane={lanes[i] ? '1' : undefined}
            data-edit={onMove ? '' : undefined}
            data-active={drag?.moved && drag.i === i ? '' : undefined}
            aria-pressed={p.selected ? true : false}
            aria-label={p.aria}
            title={onMove ? ut('Drag it, or move it with the arrow keys') : undefined}
            onPointerDown={(e) => onDown(e, i)}
            onPointerMove={onPointerMove}
            onPointerUp={onUp}
            onPointerCancel={() => setDrag(null)}
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
          <div ref={plotRef} className={s.sdayPlot} aria-hidden="true">
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
                  onClick={() => onSelect(seg.point)}
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

          <div className={s.sdayRibbon} aria-hidden="true">
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
                  onClick={() => onSelect(seg.point)}
                >
                  {fits ? seg.label : null}
                </span>
              );
            })}
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
