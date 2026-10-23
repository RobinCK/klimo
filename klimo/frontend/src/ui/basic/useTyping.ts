import { useEffect, useRef, useState, type InputHTMLAttributes, type KeyboardEvent } from 'react';

/**
 * The value turns into an input: Enter or leaving it applies what `read` makes of the text,
 * Escape cancels (and not the dialog around it). Unreadable text is marked on Enter and dropped
 * on leaving; the value gets the focus back after Enter or Escape.
 */
export function useTyping(read: (raw: string) => number | null, apply: (n: number) => void) {
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const typing = useRef(false);
  const selectAll = useRef(true);
  const refocus = useRef(false);
  const valueEl = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (draft == null && refocus.current) {
      refocus.current = false;
      valueEl.current?.focus();
    }
  }, [draft]);
  const finish = (keepFocus: boolean) => {
    typing.current = false;
    refocus.current = keepFocus;
    setInvalid(false);
    setDraft(null);
  };
  const commit = (raw: string, keepFocus: boolean) => {
    if (!typing.current) return;
    const n = read(raw);
    if (n == null) {
      if (keepFocus) setInvalid(true);
      else finish(false);
      return;
    }
    finish(keepFocus);
    apply(n);
  };
  /** `first`: a key pressed on the value starts the text instead of selecting the current one. */
  const start = (current: string, first?: string) => {
    typing.current = true;
    selectAll.current = first == null;
    setInvalid(false);
    setDraft(first ?? current);
  };
  const input: InputHTMLAttributes<HTMLInputElement> & { 'data-mantine-stop-propagation': string } = {
    type: 'text',
    enterKeyHint: 'done',
    autoComplete: 'off',
    spellCheck: false,
    autoFocus: true,
    'data-mantine-stop-propagation': 'true',
    'aria-invalid': invalid || undefined,
    value: draft ?? '',
    style: { width: `${Math.max(2, (draft ?? '').length) + 0.5}ch` },
    onFocus: (e) => {
      if (selectAll.current) e.currentTarget.select();
    },
    onChange: (e) => {
      setDraft(e.currentTarget.value);
      setInvalid(false);
    },
    onKeyDown: (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit(e.currentTarget.value, true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(true);
      }
    },
    onBlur: (e) => commit(e.currentTarget.value, false),
  };
  return { typing: draft != null, valueEl, start, input };
}

/** Enter, F2 or a key that `typed` accepts starts typing on a focused value; anything else spins. */
export function valueKeys(e: KeyboardEvent<HTMLElement>, start: (first?: string) => void, typed: RegExp | null, spin: () => void) {
  if (typed && (e.key === 'Enter' || e.key === 'F2')) {
    e.preventDefault();
    start();
  } else if (typed && typed.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    start(e.key);
  } else spin();
}
