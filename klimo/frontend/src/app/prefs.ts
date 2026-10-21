/**
 * Per-browser preferences in localStorage, namespaced by the brand id. Every access is
 * guarded: private windows and locked-down iframes throw on storage, and the panel must keep
 * working without it.
 */
import { useCallback, useEffect, useState } from 'react';
import { brand } from '@brand';

export const prefKey = (name: string) => `${brand.id}.${name}`;

/**
 * Written by the dashboard cards (fixed technical id, independent of the brand) and consumed
 * once by the panel: «open this room».
 */
export const DEEPLINK_KEY = 'klimo.deeplink';

export function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeRaw(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

export function getPref(name: string): string | null {
  return readRaw(prefKey(name));
}

export function setPref(name: string, value: string | null): void {
  writeRaw(prefKey(name), value);
}

export function getJsonPref<T>(name: string, fallback: T): T {
  const raw = getPref(name);
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function setJsonPref(name: string, value: unknown): void {
  setPref(name, value === undefined ? null : JSON.stringify(value));
}

/**
 * A remembered UI choice (an accordion left open, a selected tab). Same-name hooks in other
 * components and tabs stay in sync.
 */
export function usePref<T>(name: string, fallback: T): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => getJsonPref(name, fallback));
  useEffect(() => {
    const key = prefKey(name);
    const onStorage = (e: StorageEvent) => {
      if (e.key === key) setValue(getJsonPref(name, fallback));
    };
    const onLocal = (e: Event) => {
      if ((e as CustomEvent<string>).detail === key) setValue(getJsonPref(name, fallback));
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('ui-pref', onLocal);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('ui-pref', onLocal);
    };
    // the fallback is only the initial default; a new literal each render must not resubscribe
  }, [name]);
  const set = useCallback(
    (next: T) => {
      setJsonPref(name, next);
      setValue(next);
      window.dispatchEvent(new CustomEvent('ui-pref', { detail: prefKey(name) }));
    },
    [name],
  );
  return [value, set];
}
