import { useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import type { Tone } from '../../types';
import { toneVar } from '../../tokens/vars';
import { Icon } from '../../basic/Icon';
import { useUiNav } from '../../UiNavContext';
import { useUiText } from '../../UiTextContext';
import { useRouteClick } from '../../shell/Link';
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
  /** A short figure beside the label («1 год 20 хв»). */
  sub?: string;
  /** The label leads there (a room's page). */
  to?: string;
  /** A summary row drawn a little heavier («the rooms asked for heat»). */
  strong?: boolean;
  /** One of the rows under a summary row, set in. */
  indent?: boolean;
  /** The label opens and closes the rows under it (with `open` for their state). */
  onToggle?: () => void;
  open?: boolean;
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
  /** stacked: each label above its bar across the full width (a phone, no sideways scrolling). */
  layout?: 'side' | 'stacked';
  /**
   * Clock time of a moment («14:35»): with it, a pointer (a finger) over the bars shows a line through every
   * row at that moment, marks the rows that ran then and lists them under the axis.
   */
  formatTime?: (t: number) => string;
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

/** The span of a track that holds `t`, if any (an open span runs up to now). */
function spanAt(track: TimelineTrack, t: number, now: number): TimelineSpan | null {
  return track.spans.find((sp) => sp.start <= t && t < (sp.end ?? now)) ?? null;
}

/** A row's label: a link when it leads somewhere, a switch when it opens the rows under it, with its figure beside it. */
function TrackLabel({ track, on }: { track: TimelineTrack; on: boolean }) {
  const nav = useUiNav();
  const onClick = useRouteClick(track.to ?? '');
  const name = track.onToggle ? (
    <button type="button" className={s.trackToggle} aria-expanded={track.open ?? false} onClick={track.onToggle}>
      <Icon name="chevronDown" size={14} />
      <span className={s.trackName}>{track.label}</span>
    </button>
  ) : track.to ? (
    <a className={s.trackLink} href={nav.href(track.to)} onClick={onClick}>
      {track.label}
    </a>
  ) : (
    <span className={s.trackName}>{track.label}</span>
  );
  return (
    <span className={s.trackLabel} title={track.label} data-on={on ? '' : undefined}>
      {name}
      {track.sub ? <span className={s.trackSub}>{track.sub}</span> : null}
    </span>
  );
}

/** Several 24-hour tracks (profile, sources, pumps, rooms) on one hour axis with a now line. */
export function Timeline24h({
  tracks,
  dayStart,
  dayEnd,
  now,
  minWidth = 640,
  axis = HOUR_AXIS_3H,
  labelWidth = 124,
  ariaLabel,
  layout = 'side',
  formatTime,
}: Timeline24hProps) {
  const ut = useUiText();
  const end = dayEnd ?? dayStart + DAY_MS;
  const nowIn = now >= dayStart && now <= end;
  const nowLeft = ((now - dayStart) / (end - dayStart)) * 100;
  const stacked = layout === 'stacked';
  const style = { '--min-width': stacked ? '0px' : `${minWidth}px`, '--label-w': `${labelWidth}px` } as CSSProperties;
  // the moment under the pointer; the bars of every row share one time scale, read from the first bar
  const list = useRef<HTMLUListElement>(null);
  const [hoverT, setHoverT] = useState<number | null>(null);
  const lastT = Math.min(end, now);
  const onPointer = (e: PointerEvent<HTMLUListElement>) => {
    const bar = list.current?.querySelector<HTMLElement>('[data-bar]');
    if (!formatTime || !bar) return;
    // a tap on a row's link or switch is not a look at the bars
    if (e.target instanceof Element && e.target.closest('a, button')) return;
    const r = bar.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const t = dayStart + x * (end - dayStart);
    setHoverT(x < 0 || x > 1 || t > lastT ? null : t);
  };
  const crossLeft = hoverT != null ? ((hoverT - dayStart) / (end - dayStart)) * 100 : null;
  const active = hoverT != null ? tracks.map((tr) => ({ tr, sp: spanAt(tr, hoverT, now) })).filter((x) => x.sp) : [];
  // what ran at the moment under the pointer: the time, then every row that held it
  const readout = formatTime ? (
    <div className={s.trackReadout} aria-live="polite">
      {hoverT != null ? (
        <>
          <span className={s.readoutTime}>{formatTime(hoverT)}</span>
          {active.length ? (
            active.map(({ tr, sp }) => {
              const fill = sp?.color ?? (sp?.tone ? spanFill(sp.tone).fill : 'var(--ui-text-2)');
              return (
                <span key={tr.key} className={s.readoutItem}>
                  <span className={s.readoutDot} style={{ background: fill }} aria-hidden="true" />
                  {sp?.label ? `${tr.label}: ${sp.label}` : tr.label}
                </span>
              );
            })
          ) : (
            <span className={s.readoutItem}>{ut('nothing ran')}</span>
          )}
        </>
      ) : (
        <span className={s.readoutHint}>{ut('Point at the bars to see what ran at that moment')}</span>
      )}
    </div>
  ) : null;
  return (
    <div className={s.timeline} data-layout={layout} style={style} role="group" aria-label={ariaLabel}>
      {/* a phone's rows run past the screen: the moment it picked stays in sight above them */}
      {stacked ? readout : null}
      <ul
        ref={list}
        className={s.tracks}
        data-cross={formatTime ? '' : undefined}
        onPointerMove={onPointer}
        onPointerDown={onPointer}
        // a lifted finger leaves too: the moment it picked stays on screen to be read
        onPointerLeave={(e) => {
          if (e.pointerType === 'mouse') setHoverT(null);
        }}
      >
        {tracks.map((track) => {
          const placed = track.spans.flatMap((sp, i) => place(sp, i, dayStart, end, now));
          const said = placed.filter((p) => p.describe).map((p) => p.describe);
          const on = hoverT != null && spanAt(track, hoverT, now) != null;
          return (
            <li key={track.key} className={s.trackRow} data-strong={track.strong ? '' : undefined} data-indent={track.indent ? '' : undefined}>
              <TrackLabel track={track} on={on} />
              <span data-bar="" className={s.track} role="img" aria-label={said.length ? `${track.label}: ${said.join(', ')}` : track.label}>
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
                {crossLeft != null ? <span className={s.trackCross} style={{ left: pct(crossLeft) }} aria-hidden="true" /> : null}
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
      {stacked ? null : readout}
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
