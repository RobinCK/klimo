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
/*
 * The y labels and the «now» tag are HTML of fixed pixel size over a stretched viewBox: on a phone 44
 * units are 15 px and the line would run under «20°». The plot keeps these pixels clear of data.
 */
const LABEL_GUTTER_PX = 32;
const NOW_TAG_PX = 20;

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
  /** Relative humidity (%), a faint line on its own scale with its last value at the end; null = no reading. */
  humidity?: readonly { t: number; pct: number | null }[];
  now: number;
  /** Local midnight of the charted day (epoch ms). */
  dayStart: number;
  /** Next local midnight; differs from +24 h on daylight-saving days. */
  dayEnd?: number;
  tol?: { heat: Band; cool: Band };
  legend: { temperature: string; target: string; future: string; heat?: string; cool?: string; humidity?: string };
  title?: string;
  /** One-sentence summary: «Графік температури у Вітальні за сьогодні: нічна ціль 18°, вдень 20°, тричі гріла». */
  ariaLabel: string;
  /** Suffix of the y labels («°», «°F»); values are drawn as given. */
  unitText: string;
  axis?: string[];
  /** Said over the plot while the readings are missing («loading», «no history yet»). */
  emptyText?: string;
}

const DEFAULT_TOL = { heat: { below: 0.2, above: 0.2 }, cool: { below: 0.3, above: 0.3 } };
/** The humidity scale spans at least this many points, so a few % of drift stays a gentle slope. */
const HUMIDITY_MIN_SPAN = 20;

/** Polylines of the known samples between `from` and `until`, broken at gaps, and the last one drawn. */
function track(points: readonly { t: number; v: number | null }[], X: (t: number) => number, Y: (v: number) => number, from: number, until: number) {
  const lines: string[] = [];
  let run: string[] = [];
  let last: { t: number; v: number } | null = null;
  for (const p of [...points].sort((a, b) => a.t - b.t)) {
    if (p.t < from || p.t > until) continue;
    if (p.v == null || !Number.isFinite(p.v)) {
      if (run.length > 1) lines.push(run.join(' '));
      run = [];
      continue;
    }
    run.push(`${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`);
    last = { t: p.t, v: p.v };
  }
  if (run.length > 1) lines.push(run.join(' '));
  return { lines, last };
}

/** A room's day: temperature line, target band (past solid, schedule ahead dashed), heating spans, now. */
export function DayChart({
  series,
  targets,
  spans,
  humidity,
  now,
  dayStart,
  dayEnd,
  tol = DEFAULT_TOL,
  legend,
  title,
  ariaLabel,
  unitText,
  axis = HOUR_AXIS_3H,
  emptyText,
}: DayChartProps) {
  const ut = useUiText();
  const end = dayEnd ?? dayStart + DAY_MS;
  const plot = useRef<HTMLDivElement>(null);
  const { width: plotW, height: plotH } = useSize(plot);
  const x0 = plotW > 0 ? Math.max(X0, (LABEL_GUTTER_PX / plotW) * W) : X0;
  const yTop = plotH > 0 ? Math.max(Y_TOP, (NOW_TAG_PX / plotH) * H) : Y_TOP;

  const g = useMemo(() => {
    const X = linear(dayStart, end, x0, X1);
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
    const Y = linear(lo, hi, Y_BOTTOM, yTop);
    // at most five gridlines, and never closer than 16 px (their labels would collide on a phone)
    const plotPx = plotH > 0 ? (plotH * (Y_BOTTOM - yTop)) / H : Y_BOTTOM - yTop;
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
      const d = rect(X(from), X(to), yTop, Y_BOTTOM);
      if (sp.tone === 'heat') heat += d;
      else cool += d;
    }

    // the line: known samples up to now, broken at gaps
    const { lines, last } = track(
      series.map((p) => ({ t: p.t, v: p.c })),
      X,
      Y,
      dayStart,
      Math.min(end, now),
    );

    // humidity on a scale of its own across the plot, never steeper than its minimum span
    const hum = (humidity ?? []).filter((p) => p.pct != null && Number.isFinite(p.pct)).map((p) => p.pct as number);
    let hLo = hum.length ? Math.min(...hum) : 0;
    let hHi = hum.length ? Math.max(...hum) : 100;
    if (hHi - hLo < HUMIDITY_MIN_SPAN) {
      const mid = (hHi + hLo) / 2;
      hLo = mid - HUMIDITY_MIN_SPAN / 2;
      hHi = mid + HUMIDITY_MIN_SPAN / 2;
    }
    const humTrack = track(
      (humidity ?? []).map((p) => ({ t: p.t, v: p.pct })),
      X,
      linear(hLo, hHi, Y_BOTTOM, yTop),
      dayStart,
      Math.min(end, now),
    );
    const humLast = humTrack.last ? { x: X(humTrack.last.t), y: linear(hLo, hHi, Y_BOTTOM, yTop)(humTrack.last.v), v: humTrack.last.v } : null;

    const nowIn = now >= dayStart && now <= end;
    const active = spans.find((sp) => sp.from <= now && (sp.to == null || sp.to >= now - 60_000));
    return {
      grid: grid.map((v) => ({ v, y: Y(v) })),
      gridPath: grid.map((v) => `M${x0.toFixed(1)} ${Y(v).toFixed(1)}H${X1}`).join(''),
      bandPast,
      bandFuture,
      heat,
      cool,
      lines,
      humLines: humTrack.lines,
      humLast,
      nowX: nowIn ? X(now) : null,
      dot: last && nowIn ? { x: X(last.t), y: Y(last.v) } : null,
      dotTone: active?.tone ?? null,
      hasCool: spans.some((sp) => sp.tone === 'cool'),
    };
  }, [series, targets, spans, humidity, now, dayStart, end, tol, plotH, x0, yTop]);

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
          {legend.humidity && g.humLines.length ? (
            <span className={s.legendItem}>
              <span className={s.swHumidity} style={{ '--c': toneVar('cool', 'line') } as CSSProperties} />
              {legend.humidity}
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
          {g.humLines.map((points, i) => (
            <polyline key={`h${i}`} points={points} className={s.dayHumidity} style={{ '--c': toneVar('cool', 'line') } as CSSProperties} vectorEffect="non-scaling-stroke" />
          ))}
          {g.lines.map((points, i) => (
            <polyline key={i} points={points} className={s.dayLine} vectorEffect="non-scaling-stroke" />
          ))}
          {g.nowX != null ? (
            <path d={`M${g.nowX.toFixed(1)} ${yTop.toFixed(1)}V${Y_BOTTOM}`} className={s.dayNow} vectorEffect="non-scaling-stroke" />
          ) : null}
        </svg>
        {g.dot ? (
          <span
            className={s.dayDot}
            style={{ left: pct((g.dot.x / W) * 100), top: pct((g.dot.y / H) * 100), '--c': dotColor } as CSSProperties}
            aria-hidden="true"
          />
        ) : null}
        {g.humLast ? (
          <span
            className={s.dayHumidityLabel}
            data-edge={g.humLast.x / W > 0.94 ? 'end' : undefined}
            style={{ left: pct((g.humLast.x / W) * 100), top: pct((g.humLast.y / H) * 100), '--c': toneVar('cool', 'line') } as CSSProperties}
            aria-hidden="true"
          >
            {Math.round(g.humLast.v)}%
          </span>
        ) : null}
        {g.grid.map(({ v, y }) => (
          <span key={v} className={s.dayYLabel} style={{ top: pct((y / H) * 100) }} aria-hidden="true">
            {fmtAxisDeg(v, unitText)}
          </span>
        ))}
        {emptyText ? (
          <span className={s.dayEmpty} role="status">
            {emptyText}
          </span>
        ) : null}
        {nowPct != null ? (
          <span className={s.dayNowLabel} data-edge={nowPct > 94 ? 'end' : nowPct < 8 ? 'start' : undefined} style={{ left: pct(nowPct) }} aria-hidden="true">
            {ut('now')}
          </span>
        ) : null}
      </div>
      {/* the hour labels span the same width as the plot above them */}
      <div className={s.dayAxis} style={{ paddingLeft: pct((x0 / W) * 100) }} aria-hidden="true">
        {axis.map((a, i) => (
          <span key={`${a}-${i}`}>{a}</span>
        ))}
      </div>
    </figure>
  );
}
