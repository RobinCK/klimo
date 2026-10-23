import { useMemo, type CSSProperties } from 'react';
import type { Tone } from '../../types';
import { toneVar } from '../../tokens/vars';
import { sparkGeometry } from '../internal/geometry';
import s from './charts.module.css';

export interface SparklineProps {
  /** Newest last (13 half-hour samples on the room card); null = no reading, the line breaks. */
  values: readonly (number | null)[];
  /** The active target at the same sample times; null/missing/misaligned → no band. */
  target?: readonly (number | null)[] | null;
  /** Tolerance below / above the target (the band). */
  below: number;
  above: number;
  /** Line and end-dot colour: the room state's tone. */
  tone: Tone;
  /** Humidity at the same samples: a faint line on a scale of its own, behind the temperature. */
  humidity?: readonly (number | null)[] | null;
  /** The scale is at least this tall (a room card: 1°, so a tenth of a degree is not a wave). */
  minSpan?: number;
  /** The target band joins the scale only this close to the values; further off it would flatten them. */
  bandNear?: number;
  height?: number;
  /** Summary for screen readers; without it the sparkline is decorative (the card text says it all). */
  ariaLabel?: string;
}

/** Temperature over the last hours with the target band, and the humidity faintly, behind it. */
export function Sparkline({ values, target, below, above, tone, humidity, minSpan, bandNear, height = 40, ariaLabel }: SparklineProps) {
  const geo = useMemo(() => sparkGeometry(values, target, below, above, { humidity, minSpan, bandNear }), [values, target, below, above, humidity, minSpan, bandNear]);
  const style = { '--h': `${height}px`, '--line': toneVar(tone, 'line'), '--c': toneVar('cool', 'line') } as CSSProperties;
  return (
    <div className={s.spark} style={style} role={ariaLabel ? 'img' : undefined} aria-label={ariaLabel} aria-hidden={ariaLabel ? undefined : true}>
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" width="100%" height={height} focusable="false" aria-hidden="true">
        {geo.band ? <path d={geo.band} className={s.sparkBand} /> : null}
        {geo.humidity.map((points, i) => (
          <polyline key={`h${i}`} points={points} className={s.sparkHumidity} vectorEffect="non-scaling-stroke" />
        ))}
        {geo.lines.map((points, i) => (
          <polyline key={i} points={points} className={s.sparkLine} vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
      {geo.end ? <span className={s.sparkDot} style={{ top: `${geo.end.yPct.toFixed(1)}%` }} /> : null}
    </div>
  );
}
