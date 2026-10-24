import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { useUiText } from '../../UiTextContext';
import { fmtNum, pct } from '../internal/util';
import { useSize } from '../internal/useSize';
import s from './consumption.module.css';

/** What the bars count: gas, electricity or heat delivered (each has its own series colour). */
export type ConsumptionSeriesColor = 'gas' | 'electricity' | 'heat';

export interface ConsumptionChartBucket {
  /** Short axis label («06», «пн 20», «січ»). */
  label: string;
  /** Full name for the tooltip and the table («вт, 21 жовт., 15:00–16:00»). */
  title: string;
  /** null = nothing recorded (a gap, not a zero). */
  value: number | null;
  /** Includes now: the bar is the amount so far (lighter). */
  partial?: boolean;
  /** Entirely ahead: an empty slot. */
  future?: boolean;
  outdoorC?: number | null;
  runtimeMin?: number;
  /** More tooltip and table lines, already formatted (cost, electricity, efficiency). */
  details?: readonly { label: string; value: string }[];
}

export interface ConsumptionChartProps {
  buckets: readonly ConsumptionChartBucket[];
  /** The charted amount: name, unit, colour, and how one value reads («1.39 m³»). */
  series: { label: string; unit: string; color: ConsumptionSeriesColor; format: (v: number) => string };
  /** The outdoor temperature strip under the bars (its own scale); `axis` writes its lowest and highest value. */
  outdoor?: { label: string; format: (c: number) => string; axis?: (c: number) => string } | null;
  /** The running-time strip (its own scale); null hides it. */
  runtime?: { label: string; format: (min: number) => string } | null;
  /** One sentence for screen readers: what, when, the total and the largest bucket. */
  ariaLabel: string;
  /** While the next period loads the previous one stays, dimmed (no skeleton flash). */
  pending?: boolean;
  /** Over an empty plot (no bucket has a value). */
  emptyText?: string;
}

const COLOR: Record<ConsumptionSeriesColor, string> = {
  gas: 'var(--ui-series-gas)',
  electricity: 'var(--ui-series-electricity)',
  heat: 'var(--ui-series-heat)',
};

// px between the tooltip and the column it describes
const TIP_GAP = 6;

/** A readable top and step for 0…max: 1, 2, 2.5 or 5 × 10ⁿ, at most four gridlines. */
export function consumptionScale(max: number): { top: number; step: number; decimals: number } {
  if (!(max > 0) || !Number.isFinite(max)) return { top: 1, step: 0.5, decimals: 1 };
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((st) => st >= raw) ?? 10 * mag;
  const top = Math.ceil(max / step - 1e-9) * step;
  const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9)) + (Number.isInteger(Number((step / mag).toFixed(3))) ? 0 : 1);
  return { top, step, decimals: Math.min(decimals, 3) };
}

/** Keep every k-th axis label so none of them touch (labels ~6.6 px per glyph at 11 px mono). */
function labelStride(labels: readonly string[], width: number): number {
  if (width <= 0 || !labels.length) return 1;
  const longest = Math.max(...labels.map((l) => l.length));
  const need = longest * 6.6 + 8;
  const slot = width / labels.length;
  return Math.max(1, Math.ceil(need / slot));
}

/**
 * Consumption per hour, day or month as columns, with the outdoor temperature and the running
 * time as small strips of their own under it — one x axis, never a second y scale on the bars.
 * Every column is one hit target over the bars and both strips: hover, tap or the arrow keys show
 * all its values in one tooltip, and the same numbers are in the table view.
 */
export function ConsumptionChart({ buckets, series, outdoor, runtime, ariaLabel, pending, emptyText }: ConsumptionChartProps) {
  const ut = useUiText();
  const [active, setActive] = useState<number | null>(null);
  const [focusAt, setFocusAt] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const plot = useRef<HTMLDivElement>(null);
  const hits = useRef<(HTMLButtonElement | null)[]>([]);
  const tipEl = useRef<HTMLDivElement>(null);
  const [tipWidth, setTipWidth] = useState(0);
  const { width } = useSize(plot);
  const n = buckets.length;

  const g = useMemo(() => {
    const values = buckets.map((b) => (b.future ? null : b.value));
    const known = values.filter((v): v is number => v != null && Number.isFinite(v));
    const scale = consumptionScale(known.length ? Math.max(...known) : 0);
    const grid: number[] = [];
    for (let v = 0; v <= scale.top + 1e-9; v += scale.step) grid.push(Number(v.toFixed(6)));

    const temps = buckets.map((b) => (b.future || b.outdoorC == null || !Number.isFinite(b.outdoorC) ? null : b.outdoorC));
    const knownT = temps.filter((v): v is number => v != null);
    let tLo = knownT.length ? Math.min(...knownT) : 0;
    let tHi = knownT.length ? Math.max(...knownT) : 1;
    if (tHi - tLo < 2) {
      const mid = (tHi + tLo) / 2;
      tLo = mid - 1;
      tHi = mid + 1;
    }
    // 8 % air above and below so the line and its dot never touch the strip edges
    const tY = (c: number) => 92 - ((c - tLo) / (tHi - tLo)) * 84;
    const lines: string[] = [];
    let run: string[] = [];
    temps.forEach((c, i) => {
      if (c == null) {
        if (run.length) lines.push(run.join(' '));
        run = [];
        return;
      }
      run.push(`${(i + 0.5).toFixed(2)},${tY(c).toFixed(2)}`);
    });
    if (run.length) lines.push(run.join(' '));
    // a lone reading between gaps is still drawn, as a short dash
    for (let k = 0; k < lines.length; k++) {
      if (!lines[k].includes(' ')) {
        const [x, y] = lines[k].split(',').map(Number);
        lines[k] = `${(x - 0.2).toFixed(2)},${y} ${(x + 0.2).toFixed(2)},${y}`;
      }
    }
    const zeroY = tLo < 0 && tHi > 0 ? tY(0) : null;

    const mins = buckets.map((b) => (b.future ? 0 : Math.max(0, b.runtimeMin ?? 0)));
    const maxMin = Math.max(0, ...mins);
    return {
      values,
      scale,
      grid,
      empty: !known.length,
      partial: buckets.some((b) => b.partial && !b.future),
      temps,
      tY,
      tLo: knownT.length ? Math.min(...knownT) : null,
      tHi: knownT.length ? Math.max(...knownT) : null,
      lines,
      zeroY,
      mins,
      maxMin,
    };
  }, [buckets]);

  const stride = labelStride(
    buckets.map((b) => b.label),
    width,
  );
  const color = COLOR[series.color];
  const navigable = buckets.map((b, i) => (b.future ? -1 : i)).filter((i) => i >= 0);
  const lastKnown = navigable.length ? navigable[navigable.length - 1] : 0;
  const tabStop = focusAt != null && focusAt < n ? focusAt : lastKnown;
  const shown = active != null && active < n ? active : null;
  const showOutdoor = outdoor != null && g.tLo != null;
  const showRuntime = runtime != null;

  const describe = (b: ConsumptionChartBucket, i: number): string => {
    if (b.future) return `${b.title}: ${ut('ahead')}`;
    const parts = [
      `${b.title}${b.partial ? ` (${ut('so far')})` : ''}`,
      g.values[i] == null ? ut('no data') : `${series.label} ${series.format(g.values[i] as number)}`,
      ...(b.details ?? []).map((d) => `${d.label} ${d.value}`),
      showOutdoor && g.temps[i] != null ? `${outdoor.label} ${outdoor.format(g.temps[i] as number)}` : null,
      showRuntime ? `${runtime.label} ${runtime.format(g.mins[i])}` : null,
    ];
    return parts.filter(Boolean).join('; ');
  };

  const move = (to: number) => {
    const target = Math.max(0, Math.min(n - 1, to));
    setFocusAt(target);
    setActive(target);
    hits.current[target]?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const pos = navigable.indexOf(i);
    let to: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') to = navigable[Math.min(navigable.length - 1, pos + 1)] ?? null;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') to = navigable[Math.max(0, pos - 1)] ?? null;
    else if (e.key === 'Home') to = navigable[0] ?? null;
    else if (e.key === 'End') to = navigable[navigable.length - 1] ?? null;
    else if (e.key === 'Escape') {
      setActive(null);
      return;
    }
    if (to == null) return;
    e.preventDefault();
    move(to);
  };

  // the active column's label replaces the neighbours it would touch
  const labelShown = (i: number) => (shown == null ? i % stride === 0 : i === shown || (i % stride === 0 && Math.abs(i - shown) >= stride));
  const tip = shown != null ? buckets[shown] : null;
  const tipAt = shown != null ? ((shown + 0.5) / n) * 100 : 0;
  // beside the column, on the side with more room, so it never covers the bar it describes;
  // once measured it is kept inside the plot (a middle column on a phone has no room on either side)
  const tipStyle: CSSProperties | undefined =
    shown == null
      ? undefined
      : width > 0 && tipWidth > 0
        ? { left: Math.max(0, Math.min(width - tipWidth, tipAt <= 50 ? ((shown + 1) / n) * width + TIP_GAP : (shown / n) * width - TIP_GAP - tipWidth)) }
        : tipAt <= 50
          ? { left: `calc(${pct(((shown + 1) / n) * 100)} + ${TIP_GAP}px)` }
          : { right: `calc(${pct(((n - shown) / n) * 100)} + ${TIP_GAP}px)` };
  const detailLabels = Array.from(new Set(buckets.flatMap((b) => (b.details ?? []).map((d) => d.label))));
  // the tooltip's own width (its content, not its place: see .tip), read before the frame is painted
  useLayoutEffect(() => {
    const w = tipEl.current?.offsetWidth ?? 0;
    setTipWidth((old) => (w > 0 && w !== old ? w : old));
  }, [shown, buckets, width]);

  return (
    <figure className={s.figure} data-pending={pending ? '' : undefined} style={{ '--c': color, '--n': n } as CSSProperties}>
      <figcaption className={s.caption}>
        <span className={s.legend}>
          <span className={s.legendItem}>
            <span className={s.swBar} aria-hidden="true" />
            {series.unit ? `${series.label}, ${series.unit}` : series.label}
          </span>
          {g.partial && !g.empty ? (
            <span className={s.legendItem}>
              <span className={s.swBar} data-partial="" aria-hidden="true" />
              {ut('so far')}
            </span>
          ) : null}
        </span>
        <button type="button" className={s.toggle} aria-pressed={table} onClick={() => setTable((v) => !v)}>
          {table ? ut('Chart') : ut('Table')}
        </button>
      </figcaption>

      {table ? (
        <div className={s.tableWrap} role="region" aria-label={ariaLabel} tabIndex={0}>
          <table className={s.table}>
            <thead>
              <tr>
                <th scope="col">{ut('Period')}</th>
                <th scope="col" data-num="">
                  {series.unit ? `${series.label}, ${series.unit}` : series.label}
                </th>
                {detailLabels.map((l) => (
                  <th key={l} scope="col" data-num="">
                    {l}
                  </th>
                ))}
                {showOutdoor ? (
                  <th scope="col" data-num="">
                    {outdoor.label}
                  </th>
                ) : null}
                {showRuntime ? (
                  <th scope="col" data-num="">
                    {runtime.label}
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {buckets.map((b, i) =>
                b.future ? null : (
                  <tr key={`${b.title}-${i}`}>
                    <th scope="row">
                      {b.title}
                      {b.partial ? <span className={s.soFar}> · {ut('so far')}</span> : null}
                    </th>
                    <td data-num="">{g.values[i] == null ? '—' : series.format(g.values[i] as number)}</td>
                    {detailLabels.map((l) => (
                      <td key={l} data-num="">
                        {b.details?.find((d) => d.label === l)?.value ?? '—'}
                      </td>
                    ))}
                    {showOutdoor ? <td data-num="">{g.temps[i] == null ? '—' : outdoor.format(g.temps[i] as number)}</td> : null}
                    {showRuntime ? <td data-num="">{runtime.format(g.mins[i])}</td> : null}
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div className={s.body} onPointerLeave={() => setActive(focusAt != null && document.activeElement === hits.current[focusAt] ? focusAt : null)}>
          {/* bars */}
          <div className={s.gutter} data-row="plot" aria-hidden="true">
            {g.grid.map((v) => (
              <span key={v} className={s.yLabel} style={{ bottom: pct((v / g.scale.top) * 100) }}>
                {fmtNum(v, g.scale.decimals)}
              </span>
            ))}
          </div>
          <div ref={plot} className={s.plot} data-row="plot" aria-hidden="true">
            {g.grid.map((v) => (
              <span key={v} className={s.gridLine} data-zero={v === 0 ? '' : undefined} style={{ bottom: pct((v / g.scale.top) * 100) }} />
            ))}
            <div className={s.slots}>
              {buckets.map((b, i) => {
                const v = g.values[i];
                return (
                  <span key={i} className={s.slot} data-dim={shown != null && shown !== i ? '' : undefined}>
                    {v != null && v > 0 ? (
                      <span
                        className={s.bar}
                        data-partial={b.partial ? '' : undefined}
                        style={{ height: `max(2px, ${pct((v / g.scale.top) * 100)})` }}
                      />
                    ) : !b.future && v == null && !g.empty ? (
                      <span className={s.gap} />
                    ) : null}
                  </span>
                );
              })}
            </div>
            {g.empty && emptyText ? <span className={s.empty}>{emptyText}</span> : null}
          </div>

          {/* outdoor temperature */}
          {showOutdoor ? (
            <>
              <div className={s.gutter} data-row="outdoor" aria-hidden="true">
                <span className={s.stripMax}>{(outdoor.axis ?? outdoor.format)(g.tHi as number)}</span>
                <span className={s.stripMin}>{(outdoor.axis ?? outdoor.format)(g.tLo as number)}</span>
              </div>
              <div className={s.strip} data-row="outdoor" aria-hidden="true">
                <span className={s.stripLabel}>{outdoor.label}</span>
                <div className={s.stripPlot}>
                  <svg viewBox={`0 0 ${Math.max(1, n)} 100`} preserveAspectRatio="none" focusable="false">
                    {g.zeroY != null ? <path d={`M0 ${g.zeroY.toFixed(2)}H${n}`} className={s.zero} vectorEffect="non-scaling-stroke" /> : null}
                    {g.lines.map((points, i) => (
                      <polyline key={i} points={points} className={s.line} vectorEffect="non-scaling-stroke" />
                    ))}
                  </svg>
                  {shown != null && g.temps[shown] != null ? (
                    <span className={s.dot} style={{ left: pct(tipAt), top: pct(g.tY(g.temps[shown] as number)) }} />
                  ) : null}
                </div>
              </div>
            </>
          ) : null}

          {/* running time */}
          {showRuntime ? (
            <>
              <div className={s.gutter} data-row="runtime" aria-hidden="true" />
              <div className={s.strip} data-row="runtime" aria-hidden="true">
                <span className={s.stripLabel}>
                  <span>{runtime.label}</span>
                  {g.maxMin > 0 ? <span>{ut('up to {value}', { value: runtime.format(g.maxMin) })}</span> : null}
                </span>
                <div className={s.stripPlot}>
                  <div className={s.slots}>
                    {g.mins.map((m, i) => (
                      <span key={i} className={s.slot} data-dim={shown != null && shown !== i ? '' : undefined}>
                        {m > 0 ? <span className={s.runBar} style={{ height: `max(2px, ${pct((m / g.maxMin) * 100)})` }} /> : null}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </>
          ) : null}

          {/* axis */}
          <div className={s.axis} aria-hidden="true">
            {buckets.map((b, i) => (
              <span key={i} data-future={b.future ? '' : undefined} data-active={shown === i ? '' : undefined}>
                {labelShown(i) ? b.label : ''}
              </span>
            ))}
          </div>

          {/* one hit column per bucket over the bars and both strips */}
          <div className={s.hits} role="group" aria-label={ariaLabel}>
            {buckets.map((b, i) => (
              <button
                key={i}
                ref={(el) => {
                  hits.current[i] = el;
                }}
                type="button"
                className={s.hit}
                data-active={shown === i ? '' : undefined}
                aria-label={describe(b, i)}
                tabIndex={i === tabStop ? 0 : -1}
                disabled={b.future}
                onPointerEnter={() => !b.future && setActive(i)}
                onPointerDown={() => !b.future && setActive(i)}
                onFocus={() => {
                  setFocusAt(i);
                  setActive(i);
                }}
                onBlur={() => setActive((a) => (a === i ? null : a))}
                onKeyDown={(e) => onKey(e, i)}
              />
            ))}
            {tip && shown != null ? (
              <div ref={tipEl} className={s.tip} style={tipStyle} aria-hidden="true">
                <span className={s.tipTitle}>
                  {tip.title}
                  {tip.partial ? ` · ${ut('so far')}` : ''}
                </span>
                <span className={s.tipRow}>
                  <span className={s.tipKey} />
                  <strong>{g.values[shown] == null ? '—' : series.format(g.values[shown] as number)}</strong>
                  <span>{g.values[shown] == null ? ut('no data') : series.label}</span>
                </span>
                {(tip.details ?? []).map((d) => (
                  <span key={d.label} className={s.tipRow}>
                    <span className={s.tipKey} data-none="" />
                    <strong>{d.value}</strong>
                    <span>{d.label}</span>
                  </span>
                ))}
                {showOutdoor && g.temps[shown] != null ? (
                  <span className={s.tipRow}>
                    <span className={s.tipKey} data-line="" />
                    <strong>{outdoor.format(g.temps[shown] as number)}</strong>
                    <span>{outdoor.label}</span>
                  </span>
                ) : null}
                {showRuntime ? (
                  <span className={s.tipRow}>
                    <span className={s.tipKey} data-run="" />
                    <strong>{runtime.format(g.mins[shown])}</strong>
                    <span>{runtime.label}</span>
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </figure>
  );
}

