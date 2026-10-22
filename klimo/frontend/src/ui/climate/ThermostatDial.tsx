import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import type { Tone } from '../types';
import { toneVar } from '../tokens/vars';
import { useUiText } from '../UiTextContext';
import { Icon } from '../basic/Icon';
import { DIAL, dialAngle, dialArc, dialPoint, dialValueAt, snapToStep } from '../viz/internal/geometry';
import { fmtNum } from '../viz/internal/util';
import s from './dial.module.css';

export type DialValue = number | { lo: number; hi: number };
export type DialKnob = 't' | 'lo' | 'hi';

export interface ThermostatDialProps {
  mode: 'heat' | 'cool' | 'dual';
  /** The target (or the dual band) shown on the dial — the pending value while editing. */
  value: DialValue;
  current: number | null;
  min: number;
  max: number;
  /** −/+ and drag step (0.5°). */
  step: number;
  /** Dual: the bounds never come closer than this (2°). */
  gap?: number;
  /** Which latch is on: that arc is drawn full strength, the other at 45 %. */
  active: { heat: boolean; cool: boolean };
  /** Dual: the bound the −/+ act on. */
  selected?: 'lo' | 'hi';
  /** Read-only (wall tablet, no actuator for this mode): no knob, no −/+. */
  locked?: boolean;
  /** off: no arcs or knob, −/+ still create a change · error: greyed, nothing to change. */
  variant?: 'normal' | 'off' | 'error';
  /** A change is pending: the selected knob shows its halo. */
  editing?: boolean;
  /** The line above the number («Гріє», «Нова ціль», «Тримає») and its colour. */
  centerTop: { text: string; tone?: Tone | 'neutral' };
  /** The target as text («20.5°», «—»); the integer is drawn large with «°» and the decimal stacked. */
  centerValue: string;
  /** «зараз 19.8°». */
  centerSub: string;
  /** Dual: the two bound values as text («20.0°», «25.0°»). */
  dualLabels?: { lo: string; hi: string };
  onChange: (value: DialValue, which: DialKnob) => void;
  onDragStart?: (which: DialKnob) => void;
  onDragEnd?: (which: DialKnob) => void;
  onSelectBound?: (which: 'lo' | 'hi') => void;
  ariaLabels: {
    /** Single knob («Ціль»). */
    slider: string;
    /** Dual knobs and bound buttons («Не холодніше, ніж», «Не тепліше, ніж»). */
    lo?: string;
    hi?: string;
    dec: string;
    inc: string;
    /** «Лише перегляд». */
    locked?: string;
    valueText?: (v: number) => string;
  };
  /** Largest width in px; the dial scales down with its container (and turns into a −/value/+ row below 200 px). */
  size?: number;
}

function topColor(tone: Tone | 'neutral' | undefined): string {
  if (!tone || tone === 'neutral') return 'var(--ui-text-1)';
  if (tone === 'hold' || tone === 'off' || tone === 'idle') return 'var(--ui-text-2)';
  return toneVar(tone, 'fg');
}

/** «20.5°» → ['20', '.5', '°']; anything else is drawn as is. */
function splitValue(text: string): [string, string, string] | null {
  const m = /^([−-]?\d+)([.,]\d+)?(\D*)$/.exec(text.trim());
  return m ? [m[1], m[2] ?? '', m[3] || '°'] : null;
}

/**
 * The 270° thermostat dial shared with the Lovelace thermostat card: heat arc from the bottom-left
 * up to the target, cool arc from the target to the end, current temperature on the ring. Only the
 * knob drags — the arc ignores touches, so scrolling a dashboard never changes a target.
 */
export function ThermostatDial(props: ThermostatDialProps) {
  const {
    mode,
    value,
    current,
    min,
    max,
    step,
    gap = 2,
    active,
    selected = 'hi',
    locked = false,
    variant = 'normal',
    editing = false,
    centerTop,
    centerValue,
    centerSub,
    dualLabels,
    onChange,
    onDragStart,
    onDragEnd,
    onSelectBound,
    ariaLabels,
    size = 260,
  } = props;
  const ut = useUiText();
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<DialKnob | null>(null);

  const dual = mode === 'dual' && typeof value === 'object';
  const single = typeof value === 'number' ? value : mode === 'cool' ? value.hi : value.lo;
  const lo = dual ? (value as { lo: number }).lo : single;
  const hi = dual ? (value as { hi: number }).hi : single;
  const interactive = !locked && variant === 'normal';
  const canStep = !locked && variant !== 'error';
  const target: DialKnob = dual ? selected : 't';
  const valueText = ariaLabels.valueText ?? ((v: number) => `${fmtNum(v)}°`);

  /** Applies a new value for one knob, keeping the dual bounds apart and everything in range. */
  const place = (which: DialKnob, raw: number): DialValue => {
    const v = Math.min(max, Math.max(min, snapToStep(raw, step)));
    if (!dual) return v;
    if (which === 'lo') return { lo: Math.max(min, Math.min(hi - gap, v)), hi };
    return { lo, hi: Math.min(max, Math.max(lo + gap, v)) };
  };
  const same = (a: DialValue, b: DialValue) =>
    typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-6 : typeof a === 'object' && typeof b === 'object' && Math.abs(a.lo - b.lo) < 1e-6 && Math.abs(a.hi - b.hi) < 1e-6;
  const emit = (which: DialKnob, raw: number) => {
    const next = place(which, raw);
    const prev: DialValue = dual ? { lo, hi } : single;
    if (!same(next, prev)) onChange(next, which);
  };
  const knobValue = (which: DialKnob) => (which === 'lo' ? lo : which === 'hi' ? hi : single);
  const bounds = (which: DialKnob): [number, number] => (which === 'lo' ? [min, hi - gap] : which === 'hi' ? [lo + gap, max] : [min, max]);

  const fromPointer = (e: PointerEvent<SVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return null;
    const scale = DIAL.size / rect.width;
    const dx = (e.clientX - (rect.left + rect.width / 2)) * scale;
    const dy = (e.clientY - (rect.top + rect.height / 2)) * scale;
    return dialValueAt(dx, dy, min, max, step);
  };

  const knobHandlers = (which: DialKnob) => ({
    onPointerDown: (e: PointerEvent<SVGCircleElement>) => {
      if (!interactive || e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture?.(e.pointerId);
      setDrag(which);
      if (dual && which !== 't' && which !== selected) onSelectBound?.(which);
      onDragStart?.(which);
    },
    onPointerMove: (e: PointerEvent<SVGCircleElement>) => {
      if (drag !== which) return;
      const v = fromPointer(e);
      if (v != null) emit(which, v);
    },
    onPointerUp: () => {
      if (drag !== which) return;
      setDrag(null);
      onDragEnd?.(which);
    },
    onPointerCancel: () => {
      if (drag !== which) return;
      setDrag(null);
      onDragEnd?.(which);
    },
  });

  const onKnobKey = (e: KeyboardEvent<SVGGElement>, which: DialKnob) => {
    const v = knobValue(which);
    const [bLo, bHi] = bounds(which);
    let next: number | null = null;
    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowRight':
        next = v + step;
        break;
      case 'ArrowDown':
      case 'ArrowLeft':
        next = v - step;
        break;
      case 'PageUp':
        next = v + 1;
        break;
      case 'PageDown':
        next = v - 1;
        break;
      case 'Home':
        next = bLo;
        break;
      case 'End':
        next = bHi;
        break;
      default:
        return;
    }
    e.preventDefault();
    if (dual && which !== selected && which !== 't') onSelectBound?.(which);
    emit(which, next);
  };

  const stepBy = (delta: number) => emit(target, knobValue(target) + delta);
  const [tLo, tHi] = bounds(target);
  const atMin = knobValue(target) <= tLo + 1e-6;
  const atMax = knobValue(target) >= tHi - 1e-6;

  // arcs
  const arcs: { key: string; from: number; to: number; tone: 'heat' | 'cool'; on: boolean }[] = [];
  if (variant === 'normal') {
    const start = DIAL.startDeg;
    const end = DIAL.startDeg + DIAL.sweepDeg;
    if (mode === 'heat' || dual) arcs.push({ key: 'heat', from: start, to: dialAngle(lo, min, max), tone: 'heat', on: active.heat });
    if (mode === 'cool' || dual) arcs.push({ key: 'cool', from: dialAngle(hi, min, max), to: end, tone: 'cool', on: active.cool });
  }
  const knobs: { which: DialKnob; v: number; tone: 'heat' | 'cool'; label: string; vmin: number; vmax: number }[] =
    variant !== 'normal'
      ? []
      : dual
        ? [
            { which: 'lo', v: lo, tone: 'heat', label: ariaLabels.lo ?? ariaLabels.slider, vmin: min, vmax: hi - gap },
            { which: 'hi', v: hi, tone: 'cool', label: ariaLabels.hi ?? ariaLabels.slider, vmin: lo + gap, vmax: max },
          ]
        : [{ which: 't', v: single, tone: mode === 'cool' ? 'cool' : 'heat', label: ariaLabels.slider, vmin: min, vmax: max }];
  const cur = current != null && Number.isFinite(current) ? dialPoint(current, min, max) : null;
  const split = dual ? null : splitValue(centerValue);
  const lockedText = ariaLabels.locked ?? ut('View only');
  const track = dialArc(DIAL.startDeg, DIAL.startDeg + DIAL.sweepDeg);

  const stepper = (kind: 'dec' | 'inc', compact: boolean) => (
    <button
      type="button"
      className={compact ? s.compactBtn : s.roundBtn}
      data-kind={kind}
      aria-label={kind === 'dec' ? ariaLabels.dec : ariaLabels.inc}
      disabled={kind === 'dec' ? atMin : atMax}
      onClick={() => stepBy(kind === 'dec' ? -step : step)}
    >
      <Icon name={kind === 'dec' ? 'minus' : 'plus'} size={22} />
    </button>
  );

  return (
    <div className={s.host} style={{ '--dial-max': `${size}px` } as CSSProperties}>
      <div className={s.dial} data-variant={variant} data-locked={locked ? '' : undefined}>
        <svg ref={svgRef} className={s.svg} viewBox={`0 0 ${DIAL.size} ${DIAL.size}`} focusable="false">
          <circle
            cx={DIAL.cx}
            cy={DIAL.cy}
            r={DIAL.r}
            className={s.track}
            strokeDasharray={track.dash}
            transform={`rotate(${track.rotate} ${DIAL.cx} ${DIAL.cy})`}
          />
          {arcs.map((a) => {
            const d = dialArc(a.from, a.to);
            return (
              <circle
                key={a.key}
                cx={DIAL.cx}
                cy={DIAL.cy}
                r={DIAL.r}
                className={s.arc}
                style={{ '--c': toneVar(a.tone, 'line'), opacity: a.on ? 1 : 0.45 } as CSSProperties}
                strokeDasharray={d.dash}
                transform={`rotate(${d.rotate.toFixed(2)} ${DIAL.cx} ${DIAL.cy})`}
              />
            );
          })}
          {cur ? <circle cx={cur.x} cy={cur.y} r={4.5} className={s.current} /> : null}
          {knobs.map((k) => {
            const p = dialPoint(k.v, min, max);
            const halo = drag === k.which || (editing && k.which === target);
            const handlers = knobHandlers(k.which);
            return (
              <g
                key={k.which}
                className={s.knob}
                style={{ '--c': toneVar(k.tone, 'line') } as CSSProperties}
                role={interactive ? 'slider' : undefined}
                tabIndex={interactive ? 0 : undefined}
                aria-hidden={interactive ? undefined : true}
                aria-label={k.label}
                aria-valuemin={k.vmin}
                aria-valuemax={k.vmax}
                aria-valuenow={k.v}
                aria-valuetext={valueText(k.v)}
                onKeyDown={interactive ? (e) => onKnobKey(e, k.which) : undefined}
              >
                <circle cx={p.x} cy={p.y} r={19} className={s.halo} style={{ opacity: halo ? 0.25 : 0 }} />
                <circle cx={p.x} cy={p.y} r={16} className={s.focusRing} />
                <circle cx={p.x} cy={p.y} r={11} className={s.cap} />
                {interactive ? (
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={24}
                    className={s.hit}
                    data-dragging={drag === k.which ? '' : undefined}
                    {...handlers}
                  />
                ) : null}
              </g>
            );
          })}
        </svg>

        <div className={s.center}>
          <span className={s.centerTop} style={{ color: topColor(centerTop.tone) }}>
            {centerTop.text}
          </span>
          {dual && dualLabels ? (
            <span className={s.bounds}>
              {(['lo', 'hi'] as const).map((w, i) => (
                <span key={w} className={s.boundWrap}>
                  {i === 1 ? <span className={s.boundDivider} aria-hidden="true" /> : null}
                  <button
                    type="button"
                    className={s.bound}
                    data-which={w}
                    aria-pressed={selected === w}
                    aria-label={`${(w === 'lo' ? ariaLabels.lo : ariaLabels.hi) ?? ''} ${w === 'lo' ? dualLabels.lo : dualLabels.hi}`.trim()}
                    disabled={!canStep}
                    onClick={() => onSelectBound?.(w)}
                  >
                    {w === 'lo' ? dualLabels.lo : dualLabels.hi}
                  </button>
                </span>
              ))}
            </span>
          ) : split ? (
            <span className={s.big} aria-live="polite" aria-label={centerValue}>
              <span className={s.bigInt} aria-hidden="true">
                {split[0]}
              </span>
              <span className={s.bigFrac} aria-hidden="true">
                <span>{split[2]}</span>
                <span>{split[1]}</span>
              </span>
            </span>
          ) : (
            <span className={s.bigText} aria-live="polite">
              {centerValue}
            </span>
          )}
          <span className={s.centerSub}>{centerSub}</span>
        </div>

        {canStep ? (
          <>
            <span className={s.decSlot}>{stepper('dec', false)}</span>
            <span className={s.incSlot}>{stepper('inc', false)}</span>
          </>
        ) : locked ? (
          <span className={s.lockedNote}>
            <Icon name="lock" size={14} />
            {lockedText}
          </span>
        ) : null}
      </div>

      {/* below 200 px the ring is too small to drag: the same control as a −/value/+ row */}
      <div className={s.compact} data-variant={variant}>
        {canStep ? stepper('dec', true) : null}
        <span className={s.compactValue}>
          <span className={s.compactTop} style={{ color: topColor(centerTop.tone) }}>
            {centerTop.text}
          </span>
          <span className={s.compactNum} aria-live="polite">
            {dual && dualLabels ? `${dualLabels.lo} – ${dualLabels.hi}` : centerValue}
          </span>
          <span className={s.compactSub}>{locked ? lockedText : centerSub}</span>
        </span>
        {canStep ? stepper('inc', true) : null}
      </div>
    </div>
  );
}
