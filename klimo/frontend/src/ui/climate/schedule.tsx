import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import type { IconName } from '../types';
import { useUiText } from '../UiTextContext';
import { Icon } from '../basic/Icon';
import { VisuallyHidden } from '../basic/VisuallyHidden';
import s from './schedule.module.css';

const pct = (v: number) => `${Number(((v / 1440) * 100).toFixed(3))}%`;

/* ---------------- DayTypeCard ---------------- */

export interface DayTypeCardProps {
  /** «Будні», «Пн–Чт», «Вихідні». */
  name: string;
  /** «Пн–Пт», «4 дні». */
  daysText?: string;
  /** Today is one of its days. */
  today?: boolean;
  /** The day's profile stretches as a thin strip. */
  segments: readonly { start: number; end: number; color: string }[];
  /** «4 зміни · 06:30 · 08:30 · 17:30 · 23:00». */
  summary?: string;
  selected: boolean;
  onClick: () => void;
  /** tab: name and days only (the phone's row of day types). */
  variant?: 'card' | 'tab';
}

/** A day type of a weekly schedule: the days that share one plan, with the plan as a strip. */
export function DayTypeCard({ name, daysText, today, segments, summary, selected, onClick, variant = 'card' }: DayTypeCardProps) {
  const ut = useUiText();
  return (
    <button type="button" className={s.dayType} data-variant={variant} aria-pressed={selected} onClick={onClick}>
      <span className={s.dayTypeHead}>
        <span className={s.dayTypeName}>{name}</span>
        {today && variant === 'card' ? <span className={s.badge}>{ut('today')}</span> : null}
        {daysText ? <span className={s.dayTypeDays}>{daysText}</span> : null}
      </span>
      <span className={s.dayTypeStrip} aria-hidden="true">
        {segments.map((seg, i) =>
          seg.end > seg.start ? (
            <span key={`${seg.start}-${i}`} style={{ left: pct(seg.start), width: pct(seg.end - seg.start), background: seg.color }} />
          ) : null,
        )}
      </span>
      {summary && variant === 'card' ? <span className={s.dayTypeSummary}>{summary}</span> : null}
    </button>
  );
}

/* ---------------- SwitchPointRow ---------------- */

export interface SwitchPointRowProps {
  /** «17:30». */
  time: string;
  /** Profile name and colour. */
  name: string;
  color: string;
  /** «до 23:00 · 5 год 30 хв». */
  untilText: string;
  heatText: string;
  coolText: string;
  /** The target shown large; the other one stays small. */
  emphasis: 'heat' | 'cool';
  /** The change in force right now. */
  now?: boolean;
  expanded: boolean;
  onToggle: () => void;
  /** A handle before the row (to drag it into another place). */
  grip?: ReactNode;
  /** The editor of the change, under the row while it is expanded. */
  children?: ReactNode;
}

/** One switch point of a day: the time, the profile it switches to, how long it holds and its targets. */
export function SwitchPointRow({ time, name, color, untilText, heatText, coolText, emphasis, now, expanded, onToggle, grip, children }: SwitchPointRowProps) {
  const ut = useUiText();
  return (
    <div className={s.point} data-expanded={expanded ? '' : undefined}>
      <div className={s.pointTop}>
        {grip}
        <button type="button" className={s.pointHead} aria-expanded={expanded} onClick={onToggle}>
          <span className={s.pointTime}>{time}</span>
          <span className={s.pointBar} style={{ '--fill': color } as CSSProperties} aria-hidden="true" />
          <span className={s.pointText}>
            <span className={s.pointName}>
              <span className={s.pointNameText}>{name}</span>
              {now ? <span className={s.badge}>{ut('now')}</span> : null}
            </span>
            <span className={s.pointUntil}>{untilText}</span>
          </span>
          <span className={s.pointTargets}>
            <span className={s.pointHeat} data-main={emphasis === 'heat' ? '' : undefined}>
              <Icon name="flame" size={14} />
              {heatText}
            </span>
            <span className={s.pointCool} data-main={emphasis === 'cool' ? '' : undefined}>
              <Icon name="snow" size={14} />
              {coolText}
            </span>
          </span>
          <span className={s.pointChevron} aria-hidden="true">
            <Icon name="chevronRight" size={18} tone="muted" />
          </span>
        </button>
      </div>
      {expanded && children ? <div className={s.pointBody}>{children}</div> : null}
    </div>
  );
}

/* ---------------- SwitchPointList ---------------- */

export type SwitchPointListRow = Omit<SwitchPointRowProps, 'expanded' | 'onToggle' | 'grip' | 'children'>;

export interface SwitchPointListProps {
  rows: readonly SwitchPointListRow[];
  /** Index of the open row, −1 for none. */
  expanded: number;
  onToggle: (index: number) => void;
  /** The editor of the open row. */
  editor?: (index: number) => ReactNode;
  /** With it every row has a handle: a drag (or the arrow keys on it) puts the row at `to`. */
  onReorder?: (from: number, to: number) => void;
  ariaLabel: string;
}

interface ListDrag {
  from: number;
  startY: number;
  /** Top and height of every row when the drag began. */
  rects: { top: number; height: number }[];
  dy: number;
}

/** Where the dragged row lands: the place whose centre is nearest to the row's centre. */
function dropAt(d: ListDrag): number {
  const r = d.rects[d.from];
  if (!r) return d.from;
  const centre = r.top + d.dy + r.height / 2;
  let best = d.from;
  let dist = Infinity;
  d.rects.forEach((x, i) => {
    const gap = Math.abs(x.top + x.height / 2 - centre);
    if (gap < dist) {
      dist = gap;
      best = i;
    }
  });
  return best;
}

/** The changes of a day as rows; with `onReorder` they drag by a handle into another order. */
export function SwitchPointList({ rows, expanded, onToggle, editor, onReorder, ariaLabel }: SwitchPointListProps) {
  const ut = useUiText();
  const items = useRef<(HTMLLIElement | null)[]>([]);
  const grips = useRef<(HTMLButtonElement | null)[]>([]);
  const [drag, setDragState] = useState<ListDrag | null>(null);
  const dragRef = useRef<ListDrag | null>(null);
  const [focusAt, setFocusAt] = useState<number | null>(null);
  const [announce, setAnnounce] = useState('');
  const reorderRef = useRef(onReorder);
  reorderRef.current = onReorder;
  const setDrag = (next: ListDrag | null) => {
    dragRef.current = next;
    setDragState(next);
  };

  // a row moved by the keyboard keeps the focus on its handle in its new place
  useEffect(() => {
    if (focusAt == null) return;
    grips.current[Math.min(focusAt, rows.length - 1)]?.focus();
  }, [focusAt, rows]);

  // the drag follows the pointer on the window: the rows reorder under the handle
  const dragging = drag != null;
  useEffect(() => {
    if (!dragging) return undefined;
    const move = (e: globalThis.PointerEvent) => {
      const d = dragRef.current;
      if (d) setDrag({ ...d, dy: e.clientY - d.startY });
    };
    const end = () => {
      const d = dragRef.current;
      setDrag(null);
      if (!d) return;
      const to = dropAt(d);
      if (to !== d.from) reorderRef.current?.(d.from, to);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  }, [dragging]);

  const onDown = (e: PointerEvent<HTMLButtonElement>, i: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const rects = rows.map((_, k) => {
      const b = items.current[k]?.getBoundingClientRect();
      return { top: b?.top ?? 0, height: b?.height ?? 0 };
    });
    setDrag({ from: i, startY: e.clientY, rects, dy: 0 });
  };

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const to = i + (e.key === 'ArrowUp' ? -1 : 1);
    if (to < 0 || to >= rows.length) return;
    setFocusAt(to);
    setAnnounce(ut('{title}: position {n} of {total}', { title: `${rows[i].time} ${rows[i].name}`, n: to + 1, total: rows.length }));
    onReorder?.(i, to);
  };

  // while dragging, the other rows make room where the dragged one would land
  const order = rows.map((_, i) => i);
  if (drag) {
    order.splice(drag.from, 1);
    order.splice(dropAt(drag), 0, drag.from);
  }

  return (
    <>
      <ol className={s.points} aria-label={ariaLabel}>
        {order.map((i, place) => {
          const row = rows[i];
          const moving = drag?.from === i;
          const offset = moving && drag ? drag.rects[drag.from].top + drag.dy - (drag.rects[place]?.top ?? 0) : 0;
          return (
            <li
              key={i}
              ref={(el) => {
                items.current[i] = el;
              }}
              className={s.pointsItem}
              data-dragging={moving ? '' : undefined}
              style={moving ? { transform: `translateY(${offset}px)` } : undefined}
            >
              <SwitchPointRow
                {...row}
                expanded={i === expanded && !drag}
                onToggle={() => onToggle(i)}
                grip={
                  onReorder && rows.length > 1 ? (
                    <button
                      ref={(el) => {
                        grips.current[i] = el;
                      }}
                      type="button"
                      className={s.pointGrip}
                      aria-label={ut('Move «{title}» — arrow keys up and down', { title: `${row.time} ${row.name}` })}
                      onPointerDown={(e) => onDown(e, i)}
                      onKeyDown={(e) => onKey(e, i)}
                      onBlur={() => setFocusAt((f) => (f === i ? null : f))}
                    >
                      <Icon name="grip" size={18} />
                    </button>
                  ) : undefined
                }
              >
                {i === expanded && editor ? editor(i) : null}
              </SwitchPointRow>
            </li>
          );
        })}
      </ol>
      <VisuallyHidden live="polite">{announce}</VisuallyHidden>
    </>
  );
}

/* ---------------- ProfileChoice ---------------- */

export interface ProfileChoiceOption {
  value: string;
  name: string;
  color: string;
  icon?: IconName;
  /** The target it gives («21.0°», «захист»). */
  valueText?: string;
}

export interface ProfileChoiceProps {
  value: string;
  options: readonly ProfileChoiceOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  /** Colour of the targets. */
  tone: 'heat' | 'cool';
  /** chips: a wrapping row · list: one per line (a phone sheet). */
  layout?: 'chips' | 'list';
  disabled?: boolean;
}

/** Choosing a profile, each with its colour and the target it gives (a tap on the chosen one reports it again). */
export function ProfileChoice({ value, options, onChange, ariaLabel, tone, layout = 'chips', disabled }: ProfileChoiceProps) {
  return (
    <div className={s.choice} data-layout={layout} data-tone={tone} role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={s.choiceItem}
          aria-pressed={o.value === value}
          disabled={disabled}
          onClick={() => onChange(o.value)}
        >
          <span className={s.choiceSwatch} style={{ background: o.color }} aria-hidden="true" />
          <span className={s.choiceName}>{o.name}</span>
          {o.valueText ? <span className={s.choiceValue}>{o.valueText}</span> : null}
          {layout === 'list' ? (
            <span className={s.choiceCheck} aria-hidden="true">
              {o.value === value ? <Icon name="check" size={18} /> : null}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

/* ---------------- ScheduleNowBar ---------------- */

export interface ScheduleNowBarProps {
  /** «Зараз за розкладом · 15:20». */
  label: string;
  name: string;
  color: string;
  /** «18.0°». */
  valueText: string;
  tone: 'heat' | 'cool';
  /** «до 17:30». */
  untilText?: string;
  /** «далі Дома 21.0°». */
  nextText?: string;
  /** A line under it («Сьогодні як субота»). */
  note?: string;
  action?: ReactNode;
}

/** What the schedule gives right now and what comes next. */
export function ScheduleNowBar({ label, name, color, valueText, tone, untilText, nextText, note, action }: ScheduleNowBarProps) {
  return (
    <section className={s.now} aria-label={label} data-tone={tone}>
      <span className={s.nowLabel}>{label}</span>
      <span className={s.nowMain}>
        <span className={s.choiceSwatch} style={{ background: color }} aria-hidden="true" />
        <span className={s.nowName}>{name}</span>
        <span className={s.nowValue}>{valueText}</span>
      </span>
      {untilText || nextText ? (
        <span className={s.nowNext}>
          {untilText}
          {untilText && nextText ? <Icon name="arrowRight" size={16} tone="muted" /> : null}
          {nextText}
        </span>
      ) : null}
      {action ? <span className={s.nowAction}>{action}</span> : null}
      {note ? <span className={s.nowNote}>{note}</span> : null}
    </section>
  );
}
