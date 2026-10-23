/*
 * Pure chart maths shared by the SPA and the Lovelace cards: the room card
 * sparkline and the thermostat dial must look identical in both places.
 */

/* ---------------------------------- sparkline ---------------------------------- */

export interface SparkGeometry {
  /** One polyline per run of known values; a gap (null) breaks the line. */
  lines: string[];
  /** Stepped target band path, or null when there is no usable target series. */
  band: string | null;
  /** The newest sample, when it is known: y as % of the box height for an HTML dot. */
  end: { yPct: number } | null;
  /** The humidity's polylines, on a scale of its own (empty without humidity). */
  humidity: string[];
}

export interface SparkOptions {
  /** The scale is at least this tall (a tenth of a degree is not a wave); 0 = as tall as the values. */
  minSpan?: number;
  /** The target band joins the scale only this close to the values (further off it would flatten them); none = always. */
  bandNear?: number;
  /** Humidity at the same samples, drawn on a scale at least {@link HUMIDITY_MIN_SPAN} tall. */
  humidity?: readonly (number | null)[] | null;
}

const SPARK_W = 100;
const SPARK_H = 40;
/** A few percent of humidity drift stay a gentle slope. */
const HUMIDITY_MIN_SPAN = 20;

const known = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);

/** Polylines through the known values; a lone known sample between gaps becomes a dot-sized dash. */
function sparkRuns(vals: readonly (number | null)[], X: (i: number) => number, Y: (v: number) => number): string[] {
  const f = (x: number) => Number(x.toFixed(2));
  const lines: string[] = [];
  let run: string[] = [];
  vals.forEach((v, i) => {
    if (!known(v)) {
      if (run.length) lines.push(run.join(' '));
      run = [];
      return;
    }
    run.push(`${f(X(i))},${f(Y(v))}`);
  });
  if (run.length) lines.push(run.join(' '));
  for (let k = 0; k < lines.length; k++) {
    if (!lines[k].includes(' ')) {
      const [x, y] = lines[k].split(',').map(Number);
      lines[k] = `${f(Math.max(0, x - 1.5))},${y} ${f(Math.min(SPARK_W, x + 1.5))},${y}`;
    }
  }
  return lines;
}

/** A scale from lo to hi stretched symmetrically to at least `span`. */
function widen(lo: number, hi: number, span: number): [number, number] {
  if (hi - lo >= span) return [lo, hi];
  const mid = (hi + lo) / 2;
  return [mid - span / 2, mid + span / 2];
}

/**
 * 13 samples over 100×40: y-domain covers the values and target ± tolerance, padded by 0.15°,
 * `Y = 37 − (v − lo)/(hi − lo)·34`. The band steps at sample midpoints between
 * `[t − below, t + above]`; no band when the target series is missing or misaligned. A band beyond
 * the scale is cut at the box's edge.
 */
export function sparkGeometry(
  values: readonly (number | null)[],
  targets: readonly (number | null)[] | null | undefined,
  below: number,
  above: number,
  opts: SparkOptions = {},
): SparkGeometry {
  // a single sample still draws a flat line, as a two-point series
  const vals = values.length === 1 ? [values[0], values[0]] : values.slice();
  const n = vals.length;
  const tg = targets && targets.length === values.length ? (values.length === 1 ? [targets[0], targets[0]] : targets.slice()) : null;
  const pool: number[] = [];
  for (const v of vals) if (known(v)) pool.push(v);
  if (n < 2 || pool.length === 0) return { lines: [], band: null, end: null, humidity: [] };
  const vlo = Math.min(...pool);
  const vhi = Math.max(...pool);
  if (tg) {
    for (const t of tg) {
      if (!known(t)) continue;
      if (opts.bandNear != null && (t + above < vlo - opts.bandNear || t - below > vhi + opts.bandNear)) continue;
      pool.push(t - below, t + above);
    }
  }

  const [lo, hi] = widen(Math.min(...pool) - 0.15, Math.max(...pool) + 0.15, opts.minSpan ?? 0);
  const X = (i: number) => (i / (n - 1)) * SPARK_W;
  const Y = (v: number) => 37 - ((v - lo) / (hi - lo)) * 34;
  const Yb = (v: number) => Math.min(SPARK_H, Math.max(0, Y(v)));
  const f = (x: number) => Number(x.toFixed(2));

  const lines = sparkRuns(vals, X, Y);

  let band: string | null = null;
  if (tg) {
    const parts: string[] = [];
    let i = 0;
    while (i < n) {
      if (tg[i] == null) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < n && tg[j + 1] != null) j++;
      const xStart = i === 0 ? 0 : (X(i - 1) + X(i)) / 2;
      const xEnd = j === n - 1 ? SPARK_W : (X(j) + X(j + 1)) / 2;
      let d = `M${f(xStart)} ${f(Yb((tg[i] as number) + above))}`;
      for (let k = i + 1; k <= j; k++) d += ` H${f((X(k - 1) + X(k)) / 2)} V${f(Yb((tg[k] as number) + above))}`;
      d += ` H${f(xEnd)} V${f(Yb((tg[j] as number) - below))}`;
      for (let k = j - 1; k >= i; k--) d += ` H${f((X(k) + X(k + 1)) / 2)} V${f(Yb((tg[k] as number) - below))}`;
      d += ` H${f(xStart)} Z`;
      parts.push(d);
      i = j + 1;
    }
    band = parts.length ? parts.join(' ') : null;
  }

  let humidity: string[] = [];
  const hum = opts.humidity && opts.humidity.length === values.length ? (values.length === 1 ? [opts.humidity[0], opts.humidity[0]] : opts.humidity.slice()) : null;
  const hs = hum ? hum.filter(known) : [];
  if (hum && hs.length) {
    const [hlo, hhi] = widen(Math.min(...hs), Math.max(...hs), HUMIDITY_MIN_SPAN);
    humidity = sparkRuns(hum, X, (h) => 37 - ((h - hlo) / (hhi - hlo)) * 34);
  }

  const last = vals[n - 1];
  const end = known(last) ? { yPct: (Y(last) / SPARK_H) * 100 } : null;
  return { lines, band, end, humidity };
}

/* ------------------------------------- dial ------------------------------------- */

/** Dial box 260 × 240, ring centre (130, 130), radius 100: a 270° arc from 135° clockwise to 45°. */
export const DIAL = { size: 260, height: 240, cx: 130, cy: 130, r: 100, stroke: 14, startDeg: 135, sweepDeg: 270 } as const;
export const DIAL_CIRCUMFERENCE = 2 * Math.PI * DIAL.r;

/** `angle(v) = 135° + 270°·(v − min)/(max − min)`, clockwise from +x (SVG). */
export function dialAngle(v: number, min: number, max: number): number {
  const span = max - min || 1;
  const c = Math.min(max, Math.max(min, v));
  return DIAL.startDeg + (DIAL.sweepDeg * (c - min)) / span;
}

export function dialPoint(v: number, min: number, max: number): { x: number; y: number } {
  const a = (dialAngle(v, min, max) * Math.PI) / 180;
  return { x: DIAL.cx + DIAL.r * Math.cos(a), y: DIAL.cy + DIAL.r * Math.sin(a) };
}

/** stroke-dasharray + rotation that draw the ring between two angles (degrees). */
export function dialArc(fromDeg: number, toDeg: number): { dash: string; rotate: number } {
  const len = Math.max(0.01, (DIAL_CIRCUMFERENCE * (toDeg - fromDeg)) / 360);
  return { dash: `${len.toFixed(2)} ${DIAL_CIRCUMFERENCE.toFixed(2)}`, rotate: fromDeg };
}

/** Rounds to the step grid, without float noise (0.5 → 20.5, never 20.499999). */
export function snapToStep(v: number, step: number): number {
  const decimals = (String(step).split('.')[1] ?? '').length;
  return Number((Math.round(v / step) * step).toFixed(decimals));
}

/**
 * The value under a pointer at (dx, dy) from the ring centre. Angles in the 90° gap at the
 * bottom snap to the nearer end, so a drag past the end of the arc pins instead of jumping.
 */
export function dialValueAt(dx: number, dy: number, min: number, max: number, step: number): number {
  let a = (Math.atan2(dy, dx) * 180) / Math.PI;
  if (a < 0) a += 360;
  let rel = a - DIAL.startDeg;
  if (rel < 0) rel += 360;
  if (rel > DIAL.sweepDeg) rel = rel > (360 + DIAL.sweepDeg) / 2 ? 0 : DIAL.sweepDeg;
  const v = min + (rel / DIAL.sweepDeg) * (max - min);
  return Math.min(max, Math.max(min, snapToStep(v, step)));
}

/* --------------------------------- linear scales --------------------------------- */

export function linear(d0: number, d1: number, r0: number, r1: number): (v: number) => number {
  const span = d1 - d0 || 1;
  return (v) => r0 + ((v - d0) / span) * (r1 - r0);
}

/** A readable gridline step for a span (0.5, 1, 2, 5, 10 …) giving at most `max` lines. */
export function niceStep(span: number, max = 5): number {
  const steps = [0.5, 1, 2, 5, 10, 20, 50];
  for (const s of steps) if (span / s <= max) return s;
  return steps[steps.length - 1];
}

/** Gridline values: multiples of `step` inside [lo, hi]. */
export function gridValues(lo: number, hi: number, step: number): number[] {
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Number(v.toFixed(3)));
  return out;
}

/** Piecewise-linear lookup, clamped to the end points (weather curves). */
export function interpolate(points: readonly { x: number; y: number }[], x: number): number | null {
  if (!points.length) return null;
  const pts = [...points].sort((a, b) => a.x - b.x);
  if (x <= pts[0].x) return pts[0].y;
  const last = pts[pts.length - 1];
  if (x >= last.x) return last.y;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (x <= b.x) return a.y + ((x - a.x) / (b.x - a.x || 1)) * (b.y - a.y);
  }
  return last.y;
}
