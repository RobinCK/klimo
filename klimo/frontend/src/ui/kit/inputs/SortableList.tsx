import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { useUiText } from '../../UiTextContext';
import { Icon } from '../../basic/Icon';
import { VisuallyHidden } from '../../basic/VisuallyHidden';
import s from './list.module.css';

export interface SortableItem {
  id: string;
  title: string;
  sub?: string;
  /** A state chip or a value on the right. */
  trailing?: ReactNode;
  /** Pinned in place (frost and window always come first); others cannot pass it either. */
  locked?: boolean;
}

export interface SortableListProps {
  items: SortableItem[];
  onReorder: (ids: string[]) => void;
  /** Rank badges 1, 2, 3 … */
  numbered?: boolean;
  ariaLabel: string;
  /** md: 64 px rows (source chains) · sm: 44 px rows (priority list). */
  size?: 'md' | 'sm';
}

/**
 * Moves `id` to the movable slot `to` (index among the unlocked items). Locked items keep
 * their absolute positions, so a drag can never reorder around a pinned row.
 */
export function moveAmongUnlocked(items: SortableItem[], id: string, to: number): string[] {
  const slots = items.map((it, i) => (it.locked ? -1 : i)).filter((i) => i >= 0);
  const movable = slots.map((i) => items[i].id);
  const from = movable.indexOf(id);
  if (from < 0) return items.map((it) => it.id);
  const target = Math.max(0, Math.min(movable.length - 1, to));
  movable.splice(from, 1);
  movable.splice(target, 0, id);
  const out = items.map((it) => it.id);
  slots.forEach((slot, k) => {
    out[slot] = movable[k];
  });
  return out;
}

interface DragState {
  id: string;
  startY: number;
  /** Top and height of every row when the drag began, by index. */
  rects: { top: number; height: number }[];
  dy: number;
}

/** The order while dragging: the dragged row takes the movable slot nearest to its centre. */
function dragOrder(items: SortableItem[], drag: DragState): string[] {
  const start = items.findIndex((it) => it.id === drag.id);
  const r = drag.rects[start];
  if (!r) return items.map((it) => it.id);
  const centre = r.top + drag.dy + r.height / 2;
  let best = 0;
  let bestDist = Infinity;
  let slot = -1;
  items.forEach((it, i) => {
    if (it.locked) return;
    slot += 1;
    const rect = drag.rects[i];
    if (!rect) return;
    const d = Math.abs(rect.top + rect.height / 2 - centre);
    if (d < bestDist) {
      bestDist = d;
      best = slot;
    }
  });
  return moveAmongUnlocked(items, drag.id, best);
}

/** Ordered list with drag handles (pointer: drag; keyboard: arrows on the handle move one step). */
export function SortableList({ items, onReorder, numbered, ariaLabel, size = 'md' }: SortableListProps) {
  const ut = useUiText();
  const rows = useRef(new Map<string, HTMLLIElement>());
  const grips = useRef(new Map<string, HTMLButtonElement>());
  const [drag, setDrag] = useState<DragState | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');

  // keyed reorders move DOM nodes; give focus back to the handle that moved
  useEffect(() => {
    if (focusId) grips.current.get(focusId)?.focus();
  }, [focusId, items]);

  const byId = new Map(items.map((it) => [it.id, it]));
  const shownIds = drag ? dragOrder(items, drag) : items.map((it) => it.id);
  const shown = shownIds.map((id) => byId.get(id)).filter((it): it is SortableItem => Boolean(it));

  // the drag follows the pointer on the window: the handle's own node moves while the list reorders
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const reorderRef = useRef(onReorder);
  reorderRef.current = onReorder;
  const dragRef = useRef<DragState | null>(null);
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return undefined;
    const move = (e: globalThis.PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      dragRef.current = { ...d, dy: e.clientY - d.startY };
      setDrag(dragRef.current);
    };
    const end = () => {
      const d = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!d) return;
      const next = dragOrder(itemsRef.current, d);
      if (next.some((id, i) => id !== itemsRef.current[i]?.id)) reorderRef.current(next);
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

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>, id: string) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const rects = items.map((it) => {
      const b = rows.current.get(it.id)?.getBoundingClientRect();
      return { top: b?.top ?? 0, height: b?.height ?? 0 };
    });
    dragRef.current = { id, startY: e.clientY, rects, dy: 0 };
    setDrag(dragRef.current);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, it: SortableItem) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const movable = items.filter((x) => !x.locked);
    const from = movable.findIndex((x) => x.id === it.id);
    const to = from + (e.key === 'ArrowUp' ? -1 : 1);
    if (to < 0 || to >= movable.length) return;
    const next = moveAmongUnlocked(items, it.id, to);
    setFocusId(it.id);
    setAnnounce(ut('{title}: position {n} of {total}', { title: it.title, n: next.indexOf(it.id) + 1, total: next.length }));
    onReorder(next);
  };

  return (
    <>
      <ol className={s.list} data-size={size} aria-label={ariaLabel}>
        {shown.map((it, i) => {
          const dragging = drag?.id === it.id;
          let offset = 0;
          if (dragging && drag) {
            const start = items.findIndex((x) => x.id === it.id);
            offset = drag.rects[start].top + drag.dy - drag.rects[i].top;
          }
          return (
            <li
              key={it.id}
              ref={(el) => {
                if (el) rows.current.set(it.id, el);
                else rows.current.delete(it.id);
              }}
              className={s.item}
              data-dragging={dragging ? '' : undefined}
              style={dragging ? { transform: `translateY(${offset}px)` } : undefined}
            >
              {numbered ? (
                <span className={s.rank} aria-hidden="true">
                  {i + 1}
                </span>
              ) : null}
              <span className={s.itemText}>
                <span className={s.itemTitle}>{it.title}</span>
                {it.sub ? <span className={s.itemSub}>{it.sub}</span> : null}
              </span>
              {it.trailing != null ? <span className={s.trailing}>{it.trailing}</span> : null}
              {it.locked ? (
                <span className={s.lock} title={ut('Fixed position')}>
                  <Icon name="lock" size={16} title={ut('Fixed position')} />
                </span>
              ) : (
                <button
                  ref={(el) => {
                    if (el) grips.current.set(it.id, el);
                    else grips.current.delete(it.id);
                  }}
                  type="button"
                  className={s.grip}
                  aria-label={ut('Move «{title}» — arrow keys up and down', { title: it.title })}
                  onPointerDown={(e) => onPointerDown(e, it.id)}
                  onKeyDown={(e) => onKeyDown(e, it)}
                  onBlur={() => setFocusId((f) => (f === it.id ? null : f))}
                >
                  <Icon name="grip" size={18} />
                </button>
              )}
            </li>
          );
        })}
      </ol>
      <VisuallyHidden live="polite">{announce}</VisuallyHidden>
    </>
  );
}
