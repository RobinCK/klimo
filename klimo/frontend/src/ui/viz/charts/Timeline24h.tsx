import type { CSSProperties } from 'react';
import type { Tone } from '../../types';
import { toneVar } from '../../tokens/vars';
import { hhmm, pct, spanFill } from '../internal/util';
import { HOUR_AXIS_3H } from './DayChart';
import s from './charts.module.css';

const DAY_MS = 24 * 3600_000;

export interface TimelineSpan {
  start: number;
  /** null = still running (drawn up to now). */
  end: number | null;
  /** Running hardware in its tone (pumps: 'hold'). */
  tone?: Tone;
  /** Categorical colour instead of a tone (profile segments), with the ink that reads on it. */
  color?: string;
  ink?: string;
  /** Text inside the segment, shown when the segment is at least two hours wide. */
  label?: string;
  /** From here to `end` the hardware only runs on (pump run-on): drawn in a muted shade. */
  runOnFrom?: number | null;
}

export interface TimelineTrack {
  key: string;
  label: string;
  spans: readonly TimelineSpan[];
}

export interface Timeline24hProps {
  tracks: readonly TimelineTrack[];
  /** Local midnight (epoch ms). */
  dayStart: number;
  dayEnd?: number;
  now: number;
  /** Below this width the parent ScrollX scrolls instead of squeezing. */
  minWidth?: number;
  axis?: string[];
  labelWidth?: number;
  ariaLabel?: string;
}

interface Placed {
  key: string;
  left: number;
  width: number;
  style: CSSProperties;
  label: string;
  describe: string;
  muted: boolean;
}

function place(span: TimelineSpan, i: number, dayStart: number, dayEnd: number, now: number): Placed[] {
  const total = dayEnd - dayStart;
  const clip = (t: number) => Math.min(dayEnd, Math.max(dayStart, t));
  const from = clip(span.start);
  const to = clip(span.end ?? now);
  if (to <= from) return [];
  const { fill, ink } = span.color ? { fill: span.color, ink: span.ink ?? 'var(--ui-bg-page)' } : spanFill(span.tone ?? 'heat');
  const minute = (t: number) => (t - dayStart) / 60_000;
  const describe = `${span.label ? `${span.label} ` : ''}${hhmm(minute(from))}–${hhmm(minute(to))}`;
  const at = (t: number) => ((t - dayStart) / total) * 100;
  const runOn = span.runOnFrom != null ? Math.min(to, Math.max(from, clip(span.runOnFrom))) : to;
  const out: Placed[] = [];
  if (runOn > from) {
    const width = at(runOn) - at(from);
    out.push({
      key: `${i}-run`,
      left: at(from),
      width,
      style: { '--fill': fill, '--ink': ink } as CSSProperties,
      label: span.label && (runOn - from) / total >= 2 / 24 ? span.label : '',
      describe,
      muted: false,
    });
  }
  if (to > runOn) {
    out.push({
      key: `${i}-runon`,
      left: at(runOn),
      width: at(to) - at(runOn),
      style: { '--fill': fill, '--ink': ink } as CSSProperties,
      label: '',
      describe: '',
      muted: true,
    });
  }
  return out;
}

/** Several 24-hour tracks (profile, sources, pumps) on one hour axis with a now line. */
export function Timeline24h({ tracks, dayStart, dayEnd, now, minWidth = 640, axis = HOUR_AXIS_3H, labelWidth = 124, ariaLabel }: Timeline24hProps) {
  const end = dayEnd ?? dayStart + DAY_MS;
  const nowIn = now >= dayStart && now <= end;
  const nowLeft = ((now - dayStart) / (end - dayStart)) * 100;
  const style = { '--min-width': `${minWidth}px`, '--label-w': `${labelWidth}px` } as CSSProperties;
  return (
    <div className={s.timeline} style={style} role="group" aria-label={ariaLabel}>
      <ul className={s.tracks}>
        {tracks.map((track) => {
          const placed = track.spans.flatMap((sp, i) => place(sp, i, dayStart, end, now));
          const said = placed.filter((p) => p.describe).map((p) => p.describe);
          return (
            <li key={track.key} className={s.trackRow}>
              <span className={s.trackLabel} title={track.label}>
                {track.label}
              </span>
              <span className={s.track} role="img" aria-label={said.length ? `${track.label}: ${said.join(', ')}` : track.label}>
                {placed.map((p) => (
                  <span
                    key={p.key}
                    className={s.trackSeg}
                    data-muted={p.muted ? '' : undefined}
                    style={{ ...p.style, left: pct(p.left), width: pct(p.width) }}
                  >
                    {p.label}
                  </span>
                ))}
                {nowIn ? <span className={s.trackNow} style={{ left: pct(nowLeft) }} /> : null}
              </span>
            </li>
          );
        })}
      </ul>
      <div className={s.trackAxis} aria-hidden="true">
        {axis.map((a, i) => (
          <span key={`${a}-${i}`}>{a}</span>
        ))}
      </div>
    </div>
  );
}

export interface RuntimeBar24hProps {
  spans: readonly { start: number; end: number | null }[];
  tone: Tone;
  dayStart: number;
  dayEnd?: number;
  now: number;
  ariaLabel?: string;
}

/** A thin bar of today's run spans (the sources tile). */
export function RuntimeBar24h({ spans, tone, dayStart, dayEnd, now, ariaLabel }: RuntimeBar24hProps) {
  const end = dayEnd ?? dayStart + DAY_MS;
  const total = end - dayStart;
  const at = (t: number) => ((Math.min(end, Math.max(dayStart, t)) - dayStart) / total) * 100;
  return (
    <span
      className={s.runtime}
      style={{ '--fill': toneVar(tone, 'line') } as CSSProperties}
      role={ariaLabel ? 'img' : undefined}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
    >
      {spans.map((sp, i) => {
        const a = at(sp.start);
        const b = at(sp.end ?? now);
        if (b <= a) return null;
        return <span key={i} className={s.runtimeSeg} style={{ left: pct(a), width: pct(Math.max(b - a, 0.35)) }} />;
      })}
    </span>
  );
}
