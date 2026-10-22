import type { CSSProperties } from 'react';
import { toneVar } from '../../tokens/vars';
import { clamp, pct } from '../internal/util';
import s from './meters.module.css';

/* ---------------------------------- ToleranceBar ---------------------------------- */

export interface ToleranceBarProps {
  mode: 'heat' | 'cool';
  target: number;
  /** Tolerance below and above the target (°). */
  below: number;
  above: number;
  current: number | null;
  /** on/off: «вмикати ≤ 19.8°», «вимикати ≥ 20.2°»; target: the line above the bar («ціль 20.0° · зараз 19.8°»). */
  labels: { on: string; off: string; target: string };
  caption?: string;
  /** The room is being heated/cooled right now: the current-value dot takes the mode colour. */
  active?: boolean;
}

/**
 * The hysteresis band around a target: where the room starts and stops asking for heat (or
 * cold), and where it is now. Heating starts at the left edge; cooling at the right one.
 */
export function ToleranceBar({ mode, target, below, above, current, labels, caption, active }: ToleranceBarProps) {
  // ±1.2° fits the usual tolerances; wider bands widen the scale so the ticks stay inside
  const scale = Math.max(1.2, below + 0.3, above + 0.3);
  const pos = (d: number) => 50 + (d / scale) * 50;
  const left = pos(-below);
  const right = pos(above);
  const cur = current == null ? null : clamp(pos(current - target), 2, 98);
  const heat = mode === 'heat';
  const style = {
    '--left-c': heat ? toneVar('heat', 'line') : 'var(--ui-text-2)',
    '--right-c': heat ? 'var(--ui-text-2)' : toneVar('cool', 'line'),
    '--left-fg': heat ? toneVar('heat', 'fg') : 'var(--ui-text-2)',
    '--right-fg': heat ? 'var(--ui-text-2)' : toneVar('cool', 'fg'),
    '--dot': active ? toneVar(mode, 'line') : 'var(--ui-text-1)',
  } as CSSProperties;
  return (
    <div className={s.tol} style={style} role="img" aria-label={`${labels.target}. ${labels.on}. ${labels.off}.`}>
      <span className={s.tolTarget} aria-hidden="true">
        {labels.target}
      </span>
      <div className={s.tolBar} aria-hidden="true">
        <span className={s.tolBand} style={{ left: pct(left), width: pct(right - left) }} />
        <span className={s.tolMid} />
        <span className={s.tolTick} data-side="left" style={{ left: pct(left) }} />
        <span className={s.tolTick} data-side="right" style={{ left: pct(right) }} />
        {cur != null ? <span className={s.tolCur} style={{ left: pct(cur) }} /> : null}
      </div>
      <div className={s.tolLabels} aria-hidden="true">
        <span data-side="left" style={{ left: pct(left) }}>
          {heat ? labels.on : labels.off}
        </span>
        <span data-side="right" style={{ left: pct(right) }}>
          {heat ? labels.off : labels.on}
        </span>
      </div>
      {caption ? <span className={s.caption}>{caption}</span> : null}
    </div>
  );
}

/* ---------------------------------- ComfortBar ---------------------------------- */

export interface ComfortBarProps {
  /** 0..100 (relative humidity); null = unknown. */
  valuePct: number | null;
  /** The comfortable range, e.g. [40, 60]. */
  comfort: [number, number];
  /** Scale labels: «0%», «комфорт 40–60%», «100%». */
  labels: { start: string; comfort: string; end: string };
  ariaLabel?: string;
}

/** A 0–100 % scale with the comfortable zone and a marker at the current value. */
export function ComfortBar({ valuePct, comfort, labels, ariaLabel }: ComfortBarProps) {
  const lo = clamp(Math.min(comfort[0], comfort[1]), 0, 100);
  const hi = clamp(Math.max(comfort[0], comfort[1]), 0, 100);
  return (
    <div className={s.comfort} role={ariaLabel ? 'img' : undefined} aria-label={ariaLabel}>
      <div className={s.comfortBar} aria-hidden="true">
        <span className={s.comfortZone} style={{ left: pct(lo), width: pct(hi - lo) }} />
        {valuePct != null ? (
          <span className={s.comfortMark} data-out={valuePct < lo || valuePct > hi ? '' : undefined} style={{ left: pct(clamp(valuePct, 0, 100)) }} />
        ) : null}
      </div>
      <div className={s.comfortLabels} aria-hidden={ariaLabel ? true : undefined}>
        <span>{labels.start}</span>
        <span>{labels.comfort}</span>
        <span>{labels.end}</span>
      </div>
    </div>
  );
}

/* ---------------------------------- BatteryBar ---------------------------------- */

export interface BatteryBarProps {
  pct: number | null;
  /** Powered from the mains: a full neutral bar. */
  mains?: boolean;
  low?: boolean;
  /** The value is old (device silent): drawn faded. */
  stale?: boolean;
  /** «82%», «мережа», «—». */
  label: string;
}

export function BatteryBar({ pct: value, mains, low, stale, label }: BatteryBarProps) {
  const width = mains ? 100 : value == null ? 0 : clamp(value, 0, 100);
  return (
    <span className={s.battery} data-low={low ? '' : undefined} data-mains={mains ? '' : undefined} data-stale={stale ? '' : undefined}>
      <span className={s.batteryBar} aria-hidden="true">
        <span className={s.batteryFill} style={{ width: pct(width) }} />
      </span>
      <span className={s.batteryText}>{label}</span>
    </span>
  );
}

/* ---------------------------------- SignalBars ---------------------------------- */

export interface SignalBarsProps {
  /** 0..4 (Zigbee link quality buckets); null = not a radio device (no bars). */
  bars: 0 | 1 | 2 | 3 | 4 | null;
  weak?: boolean;
  /** «LQI 156», «Wi‑Fi», «—». */
  label: string;
}

export function SignalBars({ bars, weak, label }: SignalBarsProps) {
  return (
    <span className={s.signal} data-weak={weak ? '' : undefined} data-none={bars === 0 ? '' : undefined} data-net={bars == null ? '' : undefined}>
      {bars != null ? (
        <span className={s.signalBars} aria-hidden="true">
          {[1, 2, 3, 4].map((i) => (
            <span key={i} data-on={i <= bars ? '' : undefined} style={{ height: `${i * 3 + 2}px` }} />
          ))}
        </span>
      ) : null}
      <span className={s.signalText}>{label}</span>
    </span>
  );
}
