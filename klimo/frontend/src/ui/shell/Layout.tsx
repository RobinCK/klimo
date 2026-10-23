import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { Space } from '../types';
import s from './shell.module.css';

type Align = 'start' | 'center' | 'end' | 'stretch' | 'baseline';
type Justify = 'start' | 'center' | 'end' | 'between' | 'around';
type Tag = 'div' | 'section' | 'header' | 'footer' | 'ul' | 'ol' | 'li' | 'nav' | 'aside';

const ALIGN: Record<Align, string> = { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch', baseline: 'baseline' };
const JUSTIFY: Record<Justify, string> = { start: 'flex-start', center: 'center', end: 'flex-end', between: 'space-between', around: 'space-around' };

const gapVar = (gap: Space | undefined) => (gap ? `var(--ui-gap-${gap})` : undefined);

export interface FlexProps {
  gap?: Space;
  align?: Align;
  justify?: Justify;
  wrap?: boolean;
  /** Take the remaining space of a parent Row/Stack. */
  grow?: boolean;
  as?: Tag;
  id?: string;
  ariaLabel?: string;
  /** e.g. 'list' / 'listitem' / 'group' when the semantics are not carried by `as`. */
  role?: string;
  children?: ReactNode;
}

function flex(kind: 'stack' | 'row', { gap, align, justify, wrap, grow, as = 'div', id, ariaLabel, role, children }: FlexProps) {
  const Tag = as;
  const style = {
    '--gap': gapVar(gap),
    '--align': align ? ALIGN[align] : undefined,
    '--justify': justify ? JUSTIFY[justify] : undefined,
  } as CSSProperties;
  const cls = [s[kind], wrap ? s.wrap : '', grow ? s.grow : ''].filter(Boolean).join(' ');
  return (
    <Tag className={cls} style={style} id={id} aria-label={ariaLabel} role={role}>
      {children}
    </Tag>
  );
}

/** Vertical flow with a token gap. */
export function Stack(props: FlexProps) {
  return flex('stack', props);
}

/** Horizontal flow with a token gap; children may shrink (ellipsis works inside). */
export function Row(props: FlexProps) {
  return flex('row', props);
}

export interface AutoGridProps {
  /** Minimum column width in px (tiles 236, room cards 280, settings 560 …). */
  min: number;
  gap?: Space;
  /** Upper bound on the number of columns. */
  columns?: number;
  ariaLabel?: string;
  as?: 'div' | 'section' | 'ul';
  children?: ReactNode;
}

/** `repeat(auto-fit, minmax(min(<min>px, 100%), 1fr))` — never overflows a phone. */
export function AutoGrid({ min, gap = 'md', columns, ariaLabel, as = 'div', children }: AutoGridProps) {
  const Tag = as;
  const style = { '--min': `${min}px`, '--gap': gapVar(gap), '--cols': columns } as CSSProperties;
  return (
    <Tag className={s.grid} style={style} data-capped={columns ? '' : undefined} aria-label={ariaLabel}>
      {children}
    </Tag>
  );
}

export interface SplitProps {
  main: ReactNode;
  aside: ReactNode;
  /** Preferred widths in px; below their sum the aside wraps under (or above) the main column. */
  mainBasis: number;
  asideBasis: number;
  asideFirst?: boolean;
}

/** Two columns that stack on narrow screens. */
export function Split({ main, aside, mainBasis, asideBasis, asideFirst }: SplitProps) {
  const style = { '--main-basis': `${mainBasis}px`, '--aside-basis': `${asideBasis}px` } as CSSProperties;
  return (
    <div className={s.split} style={style} data-aside-first={asideFirst ? '' : undefined}>
      <div className={s.splitMain}>{main}</div>
      <div className={s.splitAside}>{aside}</div>
    </div>
  );
}

export interface ScrollXProps {
  /** Width below which the content scrolls sideways instead of squeezing. */
  minWidth: number;
  ariaLabel?: string;
  children: ReactNode;
}

/** The only sanctioned horizontal scroller (timelines, matrices, wide tables). */
export function ScrollX({ minWidth, ariaLabel, children }: ScrollXProps) {
  // keyboard users need a tab stop to scroll it — but only while it really scrolls; a region that fits
  // would just take focus on a click and draw a ring around the whole content
  const ref = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const check = () => setOverflows(el.scrollWidth > el.clientWidth + 1);
    const ro = new ResizeObserver(check);
    ro.observe(el);
    check();
    return () => ro.disconnect();
  }, [minWidth]);
  return (
    <div
      ref={ref}
      className={s.scrollX}
      role={ariaLabel ? 'region' : undefined}
      aria-label={ariaLabel}
      tabIndex={ariaLabel && overflows ? 0 : undefined}
    >
      <div className={s.scrollInner} style={{ '--min-width': `${minWidth}px` } as CSSProperties}>
        {children}
      </div>
    </div>
  );
}

export function Spacer({ size }: { size: Space }) {
  return <div className={s.spacer} style={{ '--size': `var(--ui-gap-${size})` } as CSSProperties} aria-hidden="true" />;
}
