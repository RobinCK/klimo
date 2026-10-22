import { useMemo, useRef, type CSSProperties } from 'react';
import type { Band } from '@api/model';
import { useUiText } from '../../UiTextContext';
import { toneVar } from '../../tokens/vars';
import { gridValues, linear, niceStep } from '../internal/geometry';
import { fmtAxisDeg, pct } from '../internal/util';
import { useSize } from '../internal/useSize';
import s from './charts.module.css';

const DAY_MS = 24 * 3600_000;
export const HOUR_AXIS_3H = ['00', '03', '06', '09', '12', '15', '18', '21', '24'];

/** Plot area inside the 960 × 240 viewBox (37.5 px per hour). */
const W = 960;
const H = 240;
const X0 = 44;
const X1 = 944;
const Y_TOP = 16;
const Y_BOTTOM = 208;

export interface DayChartTarget {
  from: number;
  to: number;
  heat: number | null;
  cool: number | null;
  /** Comes from the schedule ahead (dashed); past parts are solid. */
  future: boolean;
}

export interface DayChartSpan {
  from: number;
  /** null = still running. */
  to: number | null;
  tone: 'heat' | 'cool';
}

export interface DayChartProps {
  /** Room temperature over the day; null = no reading (the line breaks). */
  series: readonly { t: number; c: number | null }[];
  /** Target segments of the day; the band is target ± tolerance. */
  targets: readonly DayChartTarget[];
  /** When the room was heated or cooled (full-height tinted columns). */
  spans: readonly DayChartSpan[];
  now: number;
  /** Local midnight of the charted day (epoch ms). */
  dayStart: number;
  /** Next local midnight; differs from +24 h on daylight-saving days. */
  dayEnd?: number;
  tol?: { heat: Band; cool: Band };
  legend: { temperature: string; target: string; future: string; heat?: string; cool?: string };
  title?: string;
  /** One-sentence summary: «Графік температури у Вітальні за сьогодні: нічна ціль 18°, вдень 20°, тричі гріла». */
  ariaLabel: string;
  /** Suffix of the y labels («°», «°F»); values are drawn as given. */
  unitText: string;
  axis?: string[];
}

const DEFAULT_TOL = { heat: { below: 0.2, above: 0.2 }, cool: { below: 0.3, above: 0.3 } };

/** A room's day: temperature line, target band (past solid, schedule ahead dashed), heating spans, now. */
export function DayChart({
  series,
  targets,
  spans,
  now,
  dayStart,
  dayEnd,
  tol = DEFAULT_TOL,
  legend,
  title,
  ariaLabel,
  unitText,
  axis = HOUR_AXIS_3H,
}: DayChartProps) {
  const ut = useUiText();
  const end = dayEnd ?? dayStart + DAY_MS;
  const plot = useRef<HTMLDivElement>(null);
  const { height: plotH } = useSize(plot);

  const g = useMemo(() => {
    const X = linear(dayStart, end, X0, X1);
    const clipT = (t: number) => Math.min(end, Math.max(dayStart, t));
    const bands: { lo: number; hi: number; from: number; to: number; future: boolean }[] = [];
    for (const seg of targets) {
      const from = clipT(seg.from);
      const to = clipT(seg.to);
      if (to <= from) continue;
      const pieces: [number, number, boolean][] = seg.future
        ? [[from, to, true]]
        : now <= from
          ? [[from, to, true]]
          : now >= to
            ? [[from, to, false]]
            : [
                [from, now, false],
                [now, to, true],
              ];
      for (const [a, b, future] of pieces) {
        if (seg.heat != null) bands.push({ lo: seg.heat - tol.heat.below, hi: seg.heat + tol.heat.above, from: a, to: b, future });
        if (seg.cool != null) bands.push({ lo: seg.cool - tol.cool.below, hi: seg.cool + tol.cool.above, from: a, to: b, future });
      }
    }

    const pool: number[] = [];
    for (const p of series) if (p.c != null && Number.isFinite(p.c)) pool.push(p.c);
    for (const b of bands) pool.push(b.lo, b.hi);
    let lo = pool.length ? Math.min(...pool) - 0.3 : 18;
    let hi = pool.length ? Math.max(...pool) + 0.3 : 22;
    if (hi - lo < 2) {
      const mid = (hi + lo) / 2;
      lo = mid - 1;
      hi = mid + 1;
    }
    const Y = linear(lo, hi, Y_BOTTOM, Y_TOP);
    // at most five gridlines, and never closer than 16 px (their labels would collide on a phone)
    const plotPx = plotH > 0 ? (plotH * (Y_BOTTOM - Y_TOP)) / H : Y_BOTTOM - Y_TOP;
    const first = niceStep(hi - lo, 5);
    const step = [0.5, 1, 2, 5, 10, 20, 50].find((st) => st >= first && (st / (hi - lo)) * plotPx >= 16) ?? 50;
    const grid = gridValues(lo, hi, step);

    const rect = (x0: number, x1: number, y0: number, y1: number) =>
      `M${x0.toFixed(1)} ${y0.toFixed(1)}H${x1.toFixed(1)}V${y1.toFixed(1)}H${x0.toFixed(1)}Z`;
    let bandPast = '';
    let bandFuture = '';
    for (const b of bands) {
      const d = rect(X(b.from), X(b.to), Y(b.hi), Y(b.lo));
      if (b.future) bandFuture += d;
      else bandPast += d;
    }

    let heat = '';
    let cool = '';
    for (const sp of spans) {
      const from = clipT(sp.from);
      const to = clipT(sp.to ?? now);
      if (to <= from) continue;
      const d = rect(X(from), X(to), Y_TOP, Y_BOTTOM);
      if (sp.tone === 'heat') heat += d;
      else cool += d;
    }

    // the line: known samples up to now, broken at gaps
    const lines: string[] = [];
    let run: string[] = [];
    let last: { t: number; c: number } | null = null;
    for (const p of [...series].sort((a, b) => a.t - b.t)) {
      if (p.t < dayStart || p.t > Math.min(end, now)) continue;
      if (p.c == null || !Number.isFinite(p.c)) {
        if (run.length > 1) lines.push(run.join(' '));
        run = [];
        continue;
      }
      run.push(`${X(p.t).toFixed(1)},${Y(p.c).toFixed(1)}`);
      last = { t: p.t, c: p.c };
    }
    if (run.length > 1) lines.push(run.join(' '));

    const nowIn = now >= dayStart && now <= end;
    const active = spans.find((sp) => sp.from <= now && (sp.to == null || sp.to >= now - 60_000));
    return {
      grid: grid.map((v) => ({ v, y: Y(v) })),
      gridPath: grid.map((v) => `M${X0} ${Y(v).toFixed(1)}H${X1}`).join(''),
      bandPast,
      bandFuture,
      heat,
      cool,
      lines,
      nowX: nowIn ? X(now) : null,
      dot: last && nowIn ? { x: X(last.t), y: Y(last.c) } : null,
      dotTone: active?.tone ?? null,
      hasCool: spans.some((sp) => sp.tone === 'cool'),
    };
  }, [series, targets, spans, now, dayStart, end, tol, plotH]);

  const dotColor = g.dotTone ? toneVar(g.dotTone, 'line') : 'var(--ui-text-1)';
  const nowPct = g.nowX != null ? (g.nowX / W) * 100 : null;

  return (
    <figure className={s.dayFigure}>
      <figcaption className={s.dayCaption}>
        {title ? <span className={s.dayTitle}>{title}</span> : <span />}
        <span className={s.legend}>
          <span className={s.legendItem}>
            <span className={s.swLine} />
            {legend.temperature}
          </span>
          <span className={s.legendItem}>
            <span className={s.swBand} />
            {legend.target}
          </span>
          <span className={s.legendItem}>
            <span className={s.swFuture} />
            {legend.future}
          </span>
          {legend.heat ? (
            <span className={s.legendItem}>
              <span className={s.swSpan} style={{ '--c': toneVar('heat', 'line') } as CSSProperties} />
              {legend.heat}
            </span>
          ) : null}
          {legend.cool && g.hasCool ? (
            <span className={s.legendItem}>
              <span className={s.swSpan} style={{ '--c': toneVar('cool', 'line') } as CSSProperties} />
              {legend.cool}
            </span>
          ) : null}
        </span>
      </figcaption>
      <div ref={plot} className={s.dayPlot}>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={ariaLabel} focusable="false">
          <path d={g.gridPath} className={s.dayGrid} vectorEffect="non-scaling-stroke" />
          {g.heat ? <path d={g.heat} className={s.daySpan} style={{ '--c': toneVar('heat', 'line') } as CSSProperties} /> : null}
          {g.cool ? <path d={g.cool} className={s.daySpan} style={{ '--c': toneVar('cool', 'line') } as CSSProperties} /> : null}
          {g.bandPast ? <path d={g.bandPast} className={s.dayBandPast} /> : null}
          {g.bandFuture ? <path d={g.bandFuture} className={s.dayBandFuture} vectorEffect="non-scaling-stroke" /> : null}
          {g.lines.map((points, i) => (
            <polyline key={i} points={points} className={s.dayLine} vectorEffect="non-scaling-stroke" />
          ))}
          {g.nowX != null ? (
            <path d={`M${g.nowX.toFixed(1)} ${Y_TOP}V${Y_BOTTOM}`} className={s.dayNow} vectorEffect="non-scaling-stroke" />
          ) : null}
        </svg>
        {g.dot ? (
          <span
            className={s.dayDot}
            style={{ left: pct((g.dot.x / W) * 100), top: pct((g.dot.y / H) * 100), '--c': dotColor } as CSSProperties}
            aria-hidden="true"
          />
        ) : null}
        {g.grid.map(({ v, y }) => (
          <span key={v} className={s.dayYLabel} style={{ top: pct((y / H) * 100) }} aria-hidden="true">
            {fmtAxisDeg(v, unitText)}
          </span>
        ))}
        {nowPct != null ? (
          <span className={s.dayNowLabel} data-edge={nowPct > 94 ? 'end' : nowPct < 8 ? 'start' : undefined} style={{ left: pct(nowPct) }} aria-hidden="true">
            {ut('now')}
          </span>
        ) : null}
      </div>
      <div className={s.dayAxis} aria-hidden="true">
        {axis.map((a, i) => (
          <span key={`${a}-${i}`}>{a}</span>
        ))}
      </div>
    </figure>
  );
}
