import { Fragment, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { IconName, Tone } from '../../types';
import { useUiText } from '../../UiTextContext';
import { ScrollX } from '../../shell/Layout';
import { Icon } from '../../basic/Icon';
import { StatusDot } from '../../basic/Badges';
import s from './display.module.css';

export type MatrixCell = 'on' | 'off' | 'locked';

export interface RoutingMatrixProps {
  /** Channels («Телефон Ігоря», «Telegram», «HA»…). */
  columns: { id: string; label: string; icon: IconName }[];
  /** Severity groups of events; `cells` follow `columns`. */
  groups: {
    key: string;
    title: string;
    dotTone: Tone;
    sub?: string;
    rows: { id: string; title: string; sub?: string; cells: MatrixCell[] }[];
  }[];
  onToggle: (rowId: string, colId: string) => void;
  ariaLabel?: string;
}

/**
 * Which event goes to which channel. A grid: one tab stop, arrow keys move between cells,
 * Space toggles. Locked cells (critical → at least one phone) cannot be switched off.
 * The event column stays in place while the channels scroll.
 */
export function RoutingMatrix({ columns, groups, onToggle, ariaLabel }: RoutingMatrixProps) {
  const ut = useUiText();
  const rows = groups.flatMap((g) => g.rows);
  const [focus, setFocus] = useState({ r: 0, c: 0 });
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const key = (r: number, c: number) => `${r}:${c}`;

  const move = (e: KeyboardEvent<HTMLButtonElement>, r: number, c: number) => {
    let nr = r;
    let nc = c;
    if (e.key === 'ArrowRight') nc = Math.min(columns.length - 1, c + 1);
    else if (e.key === 'ArrowLeft') nc = Math.max(0, c - 1);
    else if (e.key === 'ArrowDown') nr = Math.min(rows.length - 1, r + 1);
    else if (e.key === 'ArrowUp') nr = Math.max(0, r - 1);
    else if (e.key === 'Home') nc = 0;
    else if (e.key === 'End') nc = columns.length - 1;
    else return;
    e.preventDefault();
    setFocus({ r: nr, c: nc });
    refs.current.get(key(nr, nc))?.focus();
  };

  // the focused cell survives rows disappearing
  const fr = Math.max(0, Math.min(focus.r, rows.length - 1));
  const fc = Math.max(0, Math.min(focus.c, columns.length - 1));
  let rowIndex = -1;
  return (
    <ScrollX minWidth={940} ariaLabel={ariaLabel ?? ut('Events and channels')}>
      <div role="grid" aria-label={ariaLabel ?? ut('Events and channels')} className={s.matrix} style={{ '--n': columns.length } as CSSProperties}>
        <div role="row" className={s.contents}>
          <span role="columnheader" className={s.mxCorner}>
            {ut('Event')}
          </span>
          {columns.map((c) => (
            <span key={c.id} role="columnheader" className={s.mxHead}>
              <Icon name={c.icon} size={16} />
              {c.label}
            </span>
          ))}
        </div>
        {groups.map((g) => (
          <Fragment key={g.key}>
            <div role="row" className={s.contents}>
              <span role="rowheader" className={s.mxGroup}>
                <StatusDot tone={g.dotTone} size={8} />
                {g.title}
                {g.sub ? <span className={s.mxGroupSub}>{g.sub}</span> : null}
              </span>
              <span className={s.mxGroupFill} role="presentation" />
            </div>
            {g.rows.map((row) => {
              rowIndex += 1;
              const r = rowIndex;
              return (
                <div key={row.id} role="row" className={s.contents}>
                  <span role="rowheader" className={s.mxEvent}>
                    <span className={s.mxEventTitle}>{row.title}</span>
                    {row.sub ? <span className={s.mxEventSub}>{row.sub}</span> : null}
                  </span>
                  {columns.map((col, c) => {
                    const cell = row.cells[c] ?? 'off';
                    const locked = cell === 'locked';
                    const on = cell !== 'off';
                    const label = `${row.title} → ${col.label}`;
                    return (
                      <span key={col.id} role="gridcell" className={s.mxCell}>
                        <button
                          ref={(el) => {
                            if (el) refs.current.set(key(r, c), el);
                            else refs.current.delete(key(r, c));
                          }}
                          type="button"
                          className={s.mxToggle}
                          aria-pressed={on}
                          aria-disabled={locked || undefined}
                          aria-label={locked ? `${label} · ${ut('always on')}` : label}
                          title={locked ? ut('Critical alerts always reach at least one phone') : label}
                          data-locked={locked ? '' : undefined}
                          tabIndex={fr === r && fc === c ? 0 : -1}
                          onFocus={() => setFocus({ r, c })}
                          onKeyDown={(e) => move(e, r, c)}
                          onClick={() => !locked && onToggle(row.id, col.id)}
                        >
                          <Icon name={locked ? 'lock' : 'check'} size={14} />
                        </button>
                      </span>
                    );
                  })}
                </div>
              );
            })}
          </Fragment>
        ))}
      </div>
    </ScrollX>
  );
}
