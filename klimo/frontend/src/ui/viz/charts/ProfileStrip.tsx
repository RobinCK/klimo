import type { CSSProperties } from 'react';
import { clamp, hhmm, pct } from '../internal/util';
import s from './charts.module.css';

export const HOUR_AXIS_6H = ['00', '06', '12', '18', '24'];

export interface ProfileStripSegment {
  /** Minutes of the local day, 0..1440. */
  start: number;
  end: number;
  /** Profile colour and the ink that reads on it. */
  color: string;
  ink?: string;
  /** Profile name; drawn inside the segment on the tall strip when it is at least two hours long. */
  label?: string;
  /** A manual change on top of the schedule: drawn hatched. */
  override?: boolean;
}

export interface ProfileStripProps {
  segments: readonly ProfileStripSegment[];
  /** Minute of the day for the now marker. */
  now?: number | null;
  /** Tick labels spread evenly under the strip; omit for none. */
  axis?: string[] | null;
  height?: 22 | 26;
  ariaLabel?: string;
}

/** Today's profile blocks as one 24-hour strip (thermostat card, room page). */
export function ProfileStrip({ segments, now, axis = HOUR_AXIS_6H, height = 22, ariaLabel }: ProfileStripProps) {
  const described = segments.map((seg) => `${hhmm(seg.start)}–${hhmm(seg.end)}${seg.label ? ` ${seg.label}` : ''}`).join(', ');
  return (
    <div className={s.strip} style={{ '--h': `${height}px` } as CSSProperties}>
      <div className={s.stripBar} role="img" aria-label={ariaLabel ? `${ariaLabel}: ${described}` : described}>
        <div className={s.stripClip}>
          {segments.map((seg, i) => {
            const a = clamp(seg.start, 0, 1440);
            const b = clamp(seg.end, 0, 1440);
            if (b <= a) return null;
            const style = {
              left: pct((a / 1440) * 100),
              width: pct(((b - a) / 1440) * 100),
              '--fill': seg.color,
              '--ink': seg.ink ?? 'var(--ui-bg-page)',
            } as CSSProperties;
            return (
              <span key={`${a}-${i}`} className={s.stripSeg} data-override={seg.override ? '' : undefined} style={style}>
                {height === 26 && seg.label && b - a >= 120 ? seg.label : null}
              </span>
            );
          })}
        </div>
        {now != null ? <span className={s.stripNow} style={{ left: pct((clamp(now, 0, 1440) / 1440) * 100) }} /> : null}
      </div>
      {axis && axis.length ? (
        <div className={s.stripAxis} aria-hidden="true">
          {axis.map((a, i) => (
            <span key={`${a}-${i}`}>{a}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
