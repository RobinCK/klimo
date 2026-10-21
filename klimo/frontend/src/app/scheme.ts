/**
 * Colour scheme: the stored choice (auto | dark | light) → the parent Home Assistant
 * frontend's dark mode → the device preference. index.html runs the same resolution before
 * the first paint; this module keeps it current (HA can switch themes while the panel is open).
 */
import { useEffect, useState } from 'react';
import type { ColorScheme } from '@ui';
import { getPref, setPref } from './prefs';
import { haDarkMode } from './haBridge';

export type SchemePref = 'auto' | 'dark' | 'light';

export function schemePref(): SchemePref {
  const v = getPref('scheme');
  return v === 'dark' || v === 'light' ? v : 'auto';
}

export function resolveScheme(pref: SchemePref = schemePref()): ColorScheme {
  if (pref !== 'auto') return pref;
  const ha = haDarkMode();
  if (ha !== null) return ha ? 'dark' : 'light';
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

const listeners = new Set<() => void>();

export function setSchemePref(pref: SchemePref): void {
  setPref('scheme', pref === 'auto' ? null : pref);
  for (const l of listeners) l();
}

/** The resolved scheme; re-checked every 5 s, on focus and on a device change. */
export function useColorScheme(): { scheme: ColorScheme; pref: SchemePref; setPref: (p: SchemePref) => void } {
  const [pref, setPrefState] = useState<SchemePref>(schemePref);
  const [scheme, setScheme] = useState<ColorScheme>(() => resolveScheme(pref));

  useEffect(() => {
    const update = () => {
      const p = schemePref();
      setPrefState(p);
      setScheme(resolveScheme(p));
    };
    listeners.add(update);
    const timer = window.setInterval(update, 5000);
    const onVisible = () => document.visibilityState === 'visible' && update();
    document.addEventListener('visibilitychange', onVisible);
    let mq: MediaQueryList | null = null;
    try {
      mq = window.matchMedia('(prefers-color-scheme: light)');
      mq.addEventListener('change', update);
    } catch {
      mq = null;
    }
    return () => {
      listeners.delete(update);
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      mq?.removeEventListener('change', update);
    };
  }, []);

  return { scheme, pref, setPref: setSchemePref };
}
