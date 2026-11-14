import { useMemo, useRef } from 'react';
import { gridValues, linear, niceStep } from '../internal/geometry';
import { pct, visibleTicks } from '../internal/util';
import { useSize } from '../internal/useSize';
import s from './charts.module.css';

const W = 600;
const H = 180;
const PX1 = 590;
/** The y labels' gutter, in pixels: the plot starts after it whatever the chart's width. */
const LABEL_GUTTER_PX = 34;
const PY_TOP = 10;
const PY_BOTTOM = 170;

export interface HeatLossPoint {
  /** Difference between the rooms and the outdoors, K. */
  x: number;
  /** Heat a day, kWh. */
  y: number;
}

export interface HeatLossChartProps {
  points: readonly HeatLossPoint[];
  /** The line through the days: y = a + b·x. */
  fit?: { a: number; b: number } | null;
  ariaLabel: string;
  /** Unit after the last x tick («K») and on the y scale («кВт·год»). */
  xUnit: string;
  yUnit: string;
  formatX?: (v: number) => string;
  formatY?: (v: number) => string;
}

/** Heat a day against the temperature difference, a dot per day and the line through them (the house's heat characteristic). */
export function HeatLossChart({ points, fit, ariaLabel, xUnit, yUnit, formatX = (v) => String(Math.round(v)), formatY = (v) => String(Math.round(v)) }: HeatLossChartProps) {
  const box = useRef<HTMLDivElement>(null);
  const { width: boxW } = useSize(box);

  const g = useMemo(() => {
    const px0 = boxW > 0 ? (LABEL_GUTTER_PX / boxW) * W : 44;
    const xs = points.map((p) => p.x);
    const xLo0 = xs.length ? Math.min(...xs) : 0;
    const xHi0 = xs.length ? Math.max(...xs) : 10;
    const xStep = niceStep(Math.max(1, xHi0 - xLo0), 6);
    const xLo = Math.floor(xLo0 / xStep) * xStep;
    const xHi = Math.max(xLo + xStep, Math.ceil(xHi0 / xStep) * xStep);
    // the line's ends stay inside the plot
    const ys = [...points.map((p) => p.y), ...(fit ? [fit.a + fit.b * xLo, fit.a + fit.b * xHi] : [])];
    // heat is never below zero: the line is cut there
    const yLo0 = ys.length ? Math.max(0, Math.min(...ys)) : 0;
    const yHi0 = ys.length ? Math.max(...ys) : 10;
    const yStep = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500].find((st) => (yHi0 - yLo0) / st <= 4) ?? 1000;
    const yLo = Math.floor(yLo0 / yStep) * yStep;
    const yHi = Math.max(yLo + yStep, Math.ceil(yHi0 / yStep) * yStep);
    return {
      px0,
      X: linear(xLo, xHi, px0, PX1),
      Y: linear(yLo, yHi, PY_BOTTOM, PY_TOP),
      xLo,
      xHi,
      yLo,
      xTicks: gridValues(xLo, xHi, xStep),
      yTicks: gridValues(yLo, yHi, yStep),
    };
  }, [points, fit, boxW]);

  const ticks = g.xTicks.map((v, k) => ({ at: (g.X(v) / W) * 100, label: k === g.xTicks.length - 1 ? `${formatX(v)} ${xUnit}` : formatX(v), anchor: 'center' as const }));
  const shown = visibleTicks(ticks, boxW);

  return (
    <div className={s.curveWrap}>
      <div ref={box} className={s.heatLoss}>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={ariaLabel} focusable="false">
          <rect x={g.px0} y={PY_TOP} width={PX1 - g.px0} height={PY_BOTTOM - PY_TOP} className={s.heatLossWell} />
          <path d={g.yTicks.map((v) => `M${g.px0.toFixed(1)} ${g.Y(v).toFixed(1)}H${PX1}`).join('')} className={s.heatLossGrid} vectorEffect="non-scaling-stroke" />
          {fit ? (
            <path
              d={`M${g.X(fitFrom(fit, g.xLo, g.yLo)).toFixed(1)} ${g.Y(fit.a + fit.b * fitFrom(fit, g.xLo, g.yLo)).toFixed(1)}L${g.X(g.xHi).toFixed(1)} ${g.Y(fit.a + fit.b * g.xHi).toFixed(1)}`}
              className={s.heatLossFit}
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
        </svg>
        {points.map((p, i) => (
          <span key={i} className={s.heatLossDot} style={{ left: pct((g.X(p.x) / W) * 100), top: pct((g.Y(p.y) / H) * 100) }} aria-hidden="true" />
        ))}
        {g.yTicks.map((v) => (
          <span key={v} className={s.curveYLabel} style={{ top: pct((g.Y(v) / H) * 100) }} aria-hidden="true">
            {formatY(v)}
          </span>
        ))}
        <span className={s.heatLossUnit} aria-hidden="true">
          {yUnit}
        </span>
      </div>
      <div className={s.curveTicks} aria-hidden="true">
        {ticks.map((t, k) =>
          shown[k] ? (
            <span key={t.label} style={{ left: pct(t.at) }}>
              {t.label}
            </span>
          ) : null,
        )}
      </div>
    </div>
  );
}

/** Where the line enters the plot: at its left edge, or later where it rises above the bottom. */
function fitFrom(fit: { a: number; b: number }, xLo: number, yLo: number): number {
  return fit.b > 0 && fit.a + fit.b * xLo < yLo ? (yLo - fit.a) / fit.b : xLo;
}
