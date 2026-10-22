import { useRef, type CSSProperties } from 'react';
import { pct, visibleTicks, vizColor, type VizColor } from '../internal/util';
import { useSize } from '../internal/useSize';
import s from './charts.module.css';

export interface BivalenceTrack {
  label: string;
  /** Outdoor range (°C) in which this source may heat; null = open towards that end of the scale. */
  from: number | null;
  to: number | null;
  color: VizColor;
}

export interface BivalenceChartProps {
  tracks: readonly BivalenceTrack[];
  /** Outdoor temperature now; null hides the marker. */
  nowC: number | null;
  /** «зараз 4.2°». */
  nowLabel: string;
  /** Scale ticks left to right; the first and last bound the scale («−20°» … «+20° надворі»). */
  ticks: readonly { value: number; label: string }[];
  ariaLabel: string;
  caption?: string;
}

/** Which source may heat at which outdoor temperature, with today's outdoor temperature on top. */
export function BivalenceChart({ tracks, nowC, nowLabel, ticks, ariaLabel, caption }: BivalenceChartProps) {
  const values = ticks.map((t) => t.value);
  const lo = values.length ? Math.min(...values) : -20;
  const hi = values.length ? Math.max(...values) : 20;
  const at = (v: number) => ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo || 1)) * 100;
  const now = nowC != null && Number.isFinite(nowC) ? at(nowC) : null;
  const axis = useRef<HTMLDivElement>(null);
  const { width } = useSize(axis);
  const shown = visibleTicks(
    ticks.map((t, i) => ({ at: at(t.value), label: t.label, anchor: i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'center' })),
    width,
  );
  return (
    <div className={s.biv} role="img" aria-label={ariaLabel}>
      <div className={s.bivHead}>
        {now != null ? (
          <span className={s.bivNow} data-edge={now > 90 ? 'end' : now < 10 ? 'start' : undefined} style={{ left: pct(now) }}>
            {nowLabel}
          </span>
        ) : null}
      </div>
      {tracks.map((t, i) => {
        const a = at(t.from ?? lo);
        const b = at(t.to ?? hi);
        return (
          <div key={`${t.label}-${i}`} className={s.bivRow}>
            <span className={s.bivLabel}>{t.label}</span>
            <span className={s.bivTrack}>
              {b > a ? <span className={s.bivBar} style={{ left: pct(a), width: pct(b - a), '--fill': vizColor(t.color) } as CSSProperties} /> : null}
              {now != null ? <span className={s.bivLine} style={{ left: pct(now) }} /> : null}
            </span>
          </div>
        );
      })}
      <div ref={axis} className={s.bivTicks}>
        {ticks.map((t, i) =>
          shown[i] ? (
            <span key={`${t.value}-${i}`} data-pos={i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : undefined} style={{ left: pct(at(t.value)) }}>
              {t.label}
            </span>
          ) : null,
        )}
      </div>
      {caption ? <span className={s.bivCaption}>{caption}</span> : null}
    </div>
  );
}
