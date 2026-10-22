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
  height?: number;
  /** Summary for screen readers; without it the sparkline is decorative (the card text says it all). */
  ariaLabel?: string;
}

/** Temperature over the last hours with the target band behind it. */
export function Sparkline({ values, target, below, above, tone, height = 40, ariaLabel }: SparklineProps) {
  const geo = useMemo(() => sparkGeometry(values, target, below, above), [values, target, below, above]);
  const style = { '--h': `${height}px`, '--line': toneVar(tone, 'line') } as CSSProperties;
  return (
    <div className={s.spark} style={style} role={ariaLabel ? 'img' : undefined} aria-label={ariaLabel} aria-hidden={ariaLabel ? undefined : true}>
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" width="100%" height={height} focusable="false" aria-hidden="true">
        {geo.band ? <path d={geo.band} className={s.sparkBand} /> : null}
        {geo.lines.map((points, i) => (
          <polyline key={i} points={points} className={s.sparkLine} vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
      {geo.end ? <span className={s.sparkDot} style={{ top: `${geo.end.yPct.toFixed(1)}%` }} /> : null}
    </div>
  );
}
