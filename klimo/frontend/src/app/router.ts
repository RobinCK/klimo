/**
 * Hash router. Home Assistant ingress reloads the iframe at its base URL and drops the hash,
 * so the current route is also kept in localStorage; on boot the order is: a fresh deep link
 * written by a dashboard card (≤ 60 s, consumed once) → the hash → the stored route → `#/`.
 */
import { createContext, createElement, useContext, useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { t } from '@i18n';
import { DEEPLINK_KEY, getPref, readRaw, setPref, writeRaw } from './prefs';

export type RouteName =
  | 'overview'
  | 'rooms'
  | 'wizard'
  | 'room'
  | 'roomSettings'
  | 'roomUse'
  | 'schedule'
  | 'scheduleProfiles'
  | 'scheduleProfile'
  | 'schedulePriority'
  | 'system'
  | 'sources'
  | 'source'
  | 'strategy'
  | 'energy'
  | 'journal'
  | 'notifications'
  | 'devices'
  | 'device'
  | 'settings'
  | 'gallery'
  | 'notFound';

export interface Route {
  name: RouteName;
  /** `id` (room, profile, source) or `key` (device). */
  params: Readonly<Record<string, string>>;
  query: Readonly<Record<string, string>>;
  /** Normalised path with query, e.g. `/rooms/living/settings?section=win`. */
  path: string;
}

const PATTERNS: [RouteName, RegExp, string[]][] = [
  ['overview', /^\/$/, []],
  ['rooms', /^\/rooms$/, []],
  ['wizard', /^\/rooms\/new$/, []],
  ['roomSettings', /^\/rooms\/([^/]+)\/settings$/, ['id']],
  ['roomUse', /^\/rooms\/([^/]+)\/use$/, ['id']],
  ['room', /^\/rooms\/([^/]+)$/, ['id']],
  ['scheduleProfiles', /^\/schedule\/profiles$/, []],
  ['schedulePriority', /^\/schedule\/priority$/, []],
  ['scheduleProfile', /^\/schedule\/profiles\/([^/]+)$/, ['id']],
  ['schedule', /^\/schedule$/, []],
  ['sources', /^\/system\/sources$/, []],
  ['source', /^\/system\/sources\/([^/]+)$/, ['id']],
  ['strategy', /^\/system\/strategy$/, []],
  ['energy', /^\/system\/energy$/, []],
  ['journal', /^\/system\/journal$/, []],
  ['system', /^\/system$/, []],
  ['notifications', /^\/notifications$/, []],
  ['device', /^\/devices\/([^/]+)$/, ['key']],
  ['devices', /^\/devices$/, []],
  ['settings', /^\/settings$/, []],
  ['gallery', /^\/dev\/ui$/, []],
];

/** Path builders, so links are typed in one place. */
export const paths = {
  overview: () => '/',
  rooms: () => '/rooms',
  wizard: () => '/rooms/new',
  room: (id: string) => `/rooms/${encodeURIComponent(id)}`,
  roomSettings: (id: string, section?: string) => `/rooms/${encodeURIComponent(id)}/settings${section ? `?section=${encodeURIComponent(section)}` : ''}`,
  /** The room's consumption; `date` opens a past period (any day inside it). */
  roomUse: (id: string, date?: string) => withQuery(`/rooms/${encodeURIComponent(id)}/use`, { date }),
  schedule: (q: { scope?: string; day?: number } = {}) => withQuery('/schedule', { scope: q.scope, day: q.day }),
  scheduleProfiles: () => '/schedule/profiles',
  scheduleProfile: (id: string) => `/schedule/profiles/${encodeURIComponent(id)}`,
  schedulePriority: () => '/schedule/priority',
  system: (q: { sim?: string; section?: string } = {}) => withQuery('/system', q),
  sources: () => '/system/sources',
  source: (id: string) => `/system/sources/${encodeURIComponent(id)}`,
  strategy: () => '/system/strategy',
  energy: () => '/system/energy',
  journal: () => '/system/journal',
  notifications: () => '/notifications',
  devices: (q: { filter?: string } = {}) => withQuery('/devices', q),
  device: (key: string) => `/devices/${encodeURIComponent(key)}`,
  settings: () => '/settings',
  gallery: () => '/dev/ui',
};

function withQuery(path: string, q: Record<string, string | number | undefined>): string {
  const parts = Object.entries(q)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `${path}?${parts.join('&')}` : path;
}

export function parseRoute(input: string): Route {
  let raw = input.startsWith('#') ? input.slice(1) : input;
  if (!raw.startsWith('/')) raw = `/${raw}`;
  const [pathPart, queryPart = ''] = raw.split('?', 2);
  const clean = pathPart.length > 1 ? pathPart.replace(/\/+$/, '') : pathPart;
  const query: Record<string, string> = {};
  for (const pair of queryPart.split('&')) {
    if (!pair) continue;
    const [k, v = ''] = pair.split('=', 2);
    try {
      query[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' '));
    } catch {
      query[k] = v;
    }
  }
  const path = queryPart ? `${clean}?${queryPart}` : clean;
  for (const [name, re, keys] of PATTERNS) {
    const m = re.exec(clean);
    if (m) {
      const params: Record<string, string> = {};
      keys.forEach((k, i) => {
        try {
          params[k] = decodeURIComponent(m[i + 1]);
        } catch {
          params[k] = m[i + 1];
        }
      });
      return { name, params, query, path };
    }
  }
  return { name: 'notFound', params: {}, query, path };
}

/* ---------------- current route store ---------------- */

let current: Route = parseRoute('/');
let previous: Route | null = null;
const listeners = new Set<() => void>();

function publish(route: Route): void {
  if (route.path !== current.path) previous = current;
  current = route;
  if (route.name !== 'notFound') setPref('route', route.path);
  for (const l of listeners) l();
}

export function currentRoute(): Route {
  return current;
}

/* ---------------- leave guards ---------------- */

const guards = new Map<symbol, string>();

function confirmLeave(): boolean {
  if (!guards.size) return true;
  const message = [...guards.values()][guards.size - 1];
  return window.confirm(message);
}

/** While `active`, navigation away asks first (unsaved wizard input). */
export function useLeaveGuard(active: boolean, message?: string): void {
  useEffect(() => {
    if (!active) return;
    const id = Symbol('guard');
    guards.set(id, message ?? t('Leave without saving? What you entered will be lost.'));
    const onUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onUnload);
    return () => {
      guards.delete(id);
      window.removeEventListener('beforeunload', onUnload);
    };
  }, [active, message]);
}

/* ---------------- navigation ---------------- */

/** Go to an app path (`/rooms/living`). `replace` keeps the history entry. */
export function navigate(path: string, opts: { replace?: boolean; force?: boolean } = {}): boolean {
  const target = parseRoute(path);
  if (target.path === current.path) return true;
  if (!opts.force && !confirmLeave()) return false;
  // pushState does not fire hashchange, so publishing here is the only notification
  const hash = `#${target.path}`;
  if (opts.replace) window.history.replaceState(window.history.state, '', hash);
  else window.history.pushState(window.history.state, '', hash);
  publish(target);
  return true;
}

/** Anchor href for an app path. */
export function href(path: string): string {
  return `#${parseRoute(path).path}`;
}

function onHashChange(): void {
  const hash = window.location.hash || '#/';
  const target = parseRoute(hash);
  if (target.path === current.path) return;
  // back/forward or an edited address: honour the leave guard by restoring the old hash
  if (!confirmLeave()) {
    window.history.replaceState(window.history.state, '', `#${current.path}`);
    return;
  }
  publish(target);
}

/* ---------------- deep links from the dashboard cards ---------------- */

const DEEPLINK_MAX_AGE_MS = 60_000;

function takeDeepLink(): string | null {
  const raw = readRaw(DEEPLINK_KEY);
  if (!raw) return null;
  writeRaw(DEEPLINK_KEY, null);
  try {
    const v = JSON.parse(raw) as { route?: unknown; ts?: unknown };
    if (typeof v.route !== 'string' || typeof v.ts !== 'number') return null;
    if (Math.abs(Date.now() - v.ts) > DEEPLINK_MAX_AGE_MS) return null;
    return v.route.replace(/^#/, '');
  } catch {
    return null;
  }
}

function followDeepLink(): void {
  const link = takeDeepLink();
  if (link) navigate(link, { force: false });
}

let booted = false;

/** Pick the start route and start listening. Idempotent. */
export function bootRouter(): void {
  if (booted) return;
  booted = true;
  const hash = window.location.hash.replace(/^#/, '');
  const start = takeDeepLink() ?? (hash && hash !== '/' ? hash : null) ?? getPref('route') ?? '/';
  const route = parseRoute(start);
  const resolved = route.name === 'notFound' ? parseRoute('/') : route;
  window.history.replaceState(window.history.state, '', `#${resolved.path}`);
  publish(resolved);
  window.addEventListener('hashchange', onHashChange);
  // the panel stays loaded while the user is on a dashboard; a card writes a deep link and
  // switches to the panel, so pick it up when it arrives or when the panel becomes visible
  window.addEventListener('storage', (e) => {
    if (e.key === DEEPLINK_KEY && e.newValue) followDeepLink();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') followDeepLink();
  });
  window.addEventListener('focus', followDeepLink);
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/* ---------------- hooks ---------------- */

const RouteOverride = createContext<Route | null>(null);

/**
 * Renders `children` as if `route` were current — the page behind the add-room panel keeps
 * resolving its own sub-route while the wizard owns the address bar.
 */
export function RouteScope({ route, children }: { route: Route; children: ReactNode }) {
  return createElement(RouteOverride.Provider, { value: route }, children);
}

/** The current route `{name, params, query, path}`. */
export function useRoute(): Route {
  const override = useContext(RouteOverride);
  const global = useSyncExternalStore(subscribe, currentRoute);
  return override ?? global;
}

/** The route before the current one, if any (for «back» from an overlay). */
export function previousRoute(): Route | null {
  return previous;
}
