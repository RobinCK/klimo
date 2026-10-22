import { useCallback, useRef, type KeyboardEvent } from 'react';

type Orientation = 'horizontal' | 'vertical' | 'both';

const KEYS: Record<Orientation, { next: string[]; prev: string[] }> = {
  horizontal: { next: ['ArrowRight'], prev: ['ArrowLeft'] },
  vertical: { next: ['ArrowDown'], prev: ['ArrowUp'] },
  both: { next: ['ArrowRight', 'ArrowDown'], prev: ['ArrowLeft', 'ArrowUp'] },
};

/**
 * Arrow-key movement inside a radio group or tab list (one tab stop for the whole group,
 * selection follows focus — the WAI-ARIA radio pattern). Disabled items are skipped.
 */
export function useRoving(count: number, opts: { orientation?: Orientation; isDisabled?: (i: number) => boolean; onMove: (i: number) => void }) {
  const refs = useRef<(HTMLElement | null)[]>([]);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const setRef = useCallback(
    (i: number) => (el: HTMLElement | null) => {
      refs.current[i] = el;
    },
    [],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>, i: number) => {
      const { orientation = 'both', isDisabled, onMove } = optsRef.current;
      const keys = KEYS[orientation];
      let dir = 0;
      let start = i;
      if (keys.next.includes(e.key)) dir = 1;
      else if (keys.prev.includes(e.key)) dir = -1;
      else if (e.key === 'Home') {
        dir = 1;
        start = -1;
      } else if (e.key === 'End') {
        dir = -1;
        start = count;
      } else return;
      e.preventDefault();
      for (let step = 1; step <= count; step++) {
        let j = start + dir * step;
        if (e.key !== 'Home' && e.key !== 'End') j = (j + count) % count;
        if (j < 0 || j >= count) break;
        if (isDisabled?.(j)) continue;
        refs.current[j]?.focus();
        onMove(j);
        return;
      }
    },
    [count],
  );

  return { setRef, onKeyDown };
}
