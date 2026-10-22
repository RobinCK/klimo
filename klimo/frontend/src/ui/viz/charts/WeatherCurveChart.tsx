import { useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { useUiText } from '../../UiTextContext';
import { toneVar } from '../../tokens/vars';
import { gridValues, interpolate, linear, snapToStep } from '../internal/geometry';
import { clamp, fmtAxisDeg, fmtSignedDeg, pct, visibleTicks } from '../internal/util';
import { useSize } from '../internal/useSize';
import s from './charts.module.css';

const W = 600;
const H = 150;
const PX0 = 40;
const PX1 = 590;
const PY_TOP = 10;
const PY_BOTTOM = 140;

export interface CurvePoint {
  /** Outdoor temperature, °C. */
  x: number;
  /** Flow temperature, °C. */
  y: number;
}

export interface WeatherCurveChartProps {
  points: readonly CurvePoint[];
  /** Outdoor temperature now: a dashed line and a dot on the curve. */
  now?: number | null;
  /** Drag the points up and down (or use the arrow keys on them). */
  editable?: boolean;
  onChange?: (points: CurvePoint[]) => void;
  /** «Чим холодніше надворі, тим гарячіша подача: від 32° при +15° до 52° при −20°». */
  ariaLabel: string;
  tone?: 'heat' | 'cool';
  /** Allowed flow temperatures while editing; also the fixed y-scale so points do not jump while dragged. */
  range?: [number, number];
  step?: number;
  unit?: string;
}

/** Outdoor → flow temperature curve (heat pumps, flow-temperature boilers). */
export function WeatherCurveChart({
  points,
  now,
  editable,
  onChange,
  ariaLabel,
  tone = 'heat',
  range = [20, 60],
  step = 1,
  unit = '°',
}: WeatherCurveChartProps) {
  const ut = useUiText();
  const box = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const { width: boxW, height: boxH } = useSize(box);
  const sorted = useMemo(() => points.map((p, i) => ({ ...p, i })).sort((a, b) => a.x - b.x), [points]);

  const g = useMemo(() => {
    const xs = sorted.map((p) => p.x);
    const ys = sorted.map((p) => p.y);
    const xLo = xs.length ? Math.min(...xs) : -20;
    const xHi = xs.length > 1 ? Math.max(...xs) : xLo + 1;
    const yLo = editable ? range[0] : ys.length ? Math.floor(Math.min(...ys) / 5) * 5 - 2 : 25;
    const yHi = editable ? range[1] : ys.length ? Math.max(...ys) + 2.5 : 55;
    const X = linear(xLo, xHi, PX0, PX1);
    const Y = linear(yLo, yHi, PY_BOTTOM, PY_TOP);
    // gridlines every 5° when there is room for their labels, sparser on a small chart
    const plotPx = boxH > 0 ? (boxH * (PY_BOTTOM - PY_TOP)) / H : 130;
    const step = [5, 10, 20].find((st) => (st / (yHi - yLo)) * plotPx >= 16) ?? 20;
    const grid = gridValues(yLo + 0.01, yHi - 0.01, step);
    return { X, Y, yLo, yHi, xLo, xHi, grid };
  }, [sorted, editable, range, boxH]);

  const line = sorted.map((p) => `${g.X(p.x).toFixed(1)},${g.Y(p.y).toFixed(1)}`).join(' ');
  const nowY = now != null && Number.isFinite(now) ? interpolate(sorted, now) : null;
  const nowX = now != null && Number.isFinite(now) ? g.X(clamp(now, g.xLo, g.xHi)) : null;
  const color = toneVar(tone, 'line');

  const valueAtPointer = (clientY: number): number | null => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect || rect.height === 0) return null;
    const py = ((clientY - rect.top) / rect.height) * H;
    const v = g.yLo + ((PY_BOTTOM - py) / (PY_BOTTOM - PY_TOP)) * (g.yHi - g.yLo);
    return clamp(snapToStep(v, step), range[0], range[1]);
  };

  const emit = (index: number, y: number) => {
    if (!onChange) return;
    const next = points.map((p, i) => (i === index ? { x: p.x, y } : { x: p.x, y: p.y }));
    if (next[index].y !== points[index].y) onChange(next);
  };

  const onKey = (e: KeyboardEvent<HTMLSpanElement>, index: number) => {
    const delta = { ArrowUp: step, ArrowRight: step, ArrowDown: -step, ArrowLeft: -step, PageUp: 5, PageDown: -5 }[e.key];
    let y: number | undefined;
    if (delta != null) y = points[index].y + delta;
    else if (e.key === 'Home') y = range[0];
    else if (e.key === 'End') y = range[1];
    if (y == null) return;
    e.preventDefault();
    emit(index, clamp(snapToStep(y, step), range[0], range[1]));
  };

  const ticks = sorted.map((p, k) => ({
    x: p.x,
    label: k === sorted.length - 1 ? ut('{value} outdoors', { value: fmtSignedDeg(p.x, unit) }) : fmtSignedDeg(p.x, unit),
    last: k === sorted.length - 1,
  }));
  const shown = visibleTicks(
    ticks.map((t) => ({ at: t.last ? 100 : (g.X(t.x) / W) * 100, label: t.label, anchor: t.last ? 'end' : 'center' })),
    boxW,
  );

  return (
    <div className={s.curveWrap}>
      <div ref={box} className={s.curve} data-dragging={drag != null ? '' : undefined} style={{ '--c': color } as CSSProperties}>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={ariaLabel} focusable="false">
          <path
            d={g.grid.map((v) => `M${PX0} ${g.Y(v).toFixed(1)}H${PX1}`).join('')}
            className={s.curveGrid}
            vectorEffect="non-scaling-stroke"
          />
          {sorted.length > 1 ? <polyline points={line} className={s.curveLine} vectorEffect="non-scaling-stroke" /> : null}
          {nowX != null ? <path d={`M${nowX.toFixed(1)} ${PY_TOP}V${PY_BOTTOM}`} className={s.curveNow} vectorEffect="non-scaling-stroke" /> : null}
        </svg>
        {nowX != null && nowY != null && !editable ? (
          <span className={s.curveDot} style={{ left: pct((nowX / W) * 100), top: pct((g.Y(nowY) / H) * 100) }} aria-hidden="true" />
        ) : null}
        {g.grid.map((v) => (
          <span key={v} className={s.curveYLabel} style={{ top: pct((g.Y(v) / H) * 100) }} aria-hidden="true">
            {fmtAxisDeg(v, unit)}
          </span>
        ))}
        {editable
          ? sorted.map((p) => (
              <span
                key={p.i}
                className={s.curveHandle}
                role="slider"
                tabIndex={0}
                aria-label={ut('Flow temperature at {outdoor} outdoors', { outdoor: fmtSignedDeg(p.x, unit) })}
                aria-valuemin={range[0]}
                aria-valuemax={range[1]}
                aria-valuenow={p.y}
                aria-valuetext={fmtAxisDeg(p.y, unit)}
                aria-orientation="vertical"
                data-active={drag === p.i ? '' : undefined}
                style={{ left: pct((g.X(p.x) / W) * 100), top: pct((g.Y(p.y) / H) * 100) }}
                onKeyDown={(e) => onKey(e, p.i)}
                onPointerDown={(e: PointerEvent<HTMLSpanElement>) => {
                  e.currentTarget.setPointerCapture?.(e.pointerId);
                  setDrag(p.i);
                }}
                onPointerMove={(e) => {
                  if (drag !== p.i) return;
                  const y = valueAtPointer(e.clientY);
                  if (y != null) emit(p.i, y);
                }}
                onPointerUp={() => setDrag(null)}
                onPointerCancel={() => setDrag(null)}
              />
            ))
          : null}
      </div>
      <div className={s.curveTicks} aria-hidden="true">
        {ticks.map((t, k) =>
          shown[k] ? (
            <span key={t.x} data-pos={t.last ? 'end' : undefined} style={t.last ? undefined : { left: pct((g.X(t.x) / W) * 100) }}>
              {t.label}
            </span>
          ) : null,
        )}
      </div>
    </div>
  );
}
