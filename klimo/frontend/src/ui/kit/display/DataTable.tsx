import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import { ScrollX } from '../../shell/Layout';
import { VisuallyHidden } from '../../basic/VisuallyHidden';
import s from './display.module.css';

export interface DataColumn {
  key: string;
  label: string;
  /** Grid track («minmax(200px, 1.1fr)», «104px»); default an equal share. */
  width?: string;
  align?: 'start' | 'center' | 'end';
  /** Header read by screen readers only (an actions column). */
  hideLabel?: boolean;
}

export interface DataRow {
  key: string;
  cells: Record<string, ReactNode>;
  /** Tinted row (a device with a problem). */
  tone?: 'warn';
  /** The row opens something (a drawer); Enter works too. */
  onClick?: () => void;
  ariaLabel?: string;
}

export interface DataTableProps {
  columns: DataColumn[];
  rows: DataRow[];
  /** Below this width the table scrolls sideways instead of squeezing. */
  minWidth: number;
  ariaLabel?: string;
  /** Shown instead of rows when there are none. */
  empty?: ReactNode;
}

// row padding and column gap of the grid rows (display.module.css .tr)
const ROW_PADDING = 20;
const COLUMN_GAP = 12;

/** The smallest px width a grid track can take ('minmax(200px, 1fr)' → 200, '104px' → 104, '1fr' → 0). */
function trackMin(width: string | undefined): number {
  const m = width ? /(\d+(?:\.\d+)?)px/.exec(width) : null;
  return m ? Number(m[1]) : 0;
}

/**
 * An ARIA table on CSS grid rows: every row has the same width and track list, so the
 * columns stay aligned; below the tracks' minimum the table scrolls inside its frame and the
 * page never scrolls sideways.
 */
export function DataTable({ columns, rows, minWidth, ariaLabel, empty }: DataTableProps) {
  const style = { '--cols': columns.map((c) => c.width ?? 'minmax(0, 1fr)').join(' ') } as CSSProperties;
  const tracks = columns.reduce((sum, c) => sum + trackMin(c.width), 0) + COLUMN_GAP * (columns.length - 1) + ROW_PADDING;
  const frameMin = Math.max(minWidth, tracks);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>, row: DataRow) => {
    if (row.onClick && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      row.onClick();
    }
  };
  return (
    <ScrollX minWidth={frameMin} ariaLabel={ariaLabel}>
      <div role="table" aria-label={ariaLabel} className={s.table} style={style}>
        <div role="row" className={`${s.tr} ${s.trHead}`}>
          {columns.map((c) => (
            <span key={c.key} role="columnheader" className={s.td} data-align={c.align}>
              {c.hideLabel ? <VisuallyHidden>{c.label}</VisuallyHidden> : c.label}
            </span>
          ))}
        </div>
        {rows.length === 0 && empty ? <div className={s.tableEmpty}>{empty}</div> : null}
        {rows.map((r) => (
          <div
            key={r.key}
            role="row"
            className={s.tr}
            data-tone={r.tone}
            data-clickable={r.onClick ? '' : undefined}
            tabIndex={r.onClick ? 0 : undefined}
            aria-label={r.ariaLabel}
            onClick={r.onClick}
            onKeyDown={r.onClick ? (e) => onKeyDown(e, r) : undefined}
          >
            {columns.map((c) => (
              <span key={c.key} role="cell" className={s.td} data-align={c.align}>
                {r.cells[c.key]}
              </span>
            ))}
          </div>
        ))}
      </div>
    </ScrollX>
  );
}
