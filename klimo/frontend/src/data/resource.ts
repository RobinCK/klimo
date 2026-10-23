/**
 * Shared request cache for REST resources. Components that ask for the same key share one
 * request and one copy of the data; a config event for a listed entity or a reconnect reloads
 * the data in place (stale-while-revalidate: the old data stays on screen while it reloads).
 */
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import type { ConfigEntityName } from '@api/model';
import { liveStore } from './live';

export interface ResourceSnapshot<T> {
  data: T | undefined;
  error: unknown;
  /** True while a request is in flight (also during a background reload). */
  loading: boolean;
  /** True once data or an error arrived at least once. */
  settled: boolean;
}

export interface ResourceState<T> extends ResourceSnapshot<T> {
  reload: () => Promise<T | undefined>;
  /** Replace the cached data (e.g. with the read model a mutation returned). */
  setData: (next: T | ((prev: T | undefined) => T)) => void;
}

interface Entry<T> {
  snapshot: ResourceSnapshot<T>;
  fetcher: () => Promise<T>;
  inflight: Promise<T | undefined> | null;
  listeners: Set<() => void>;
  /** Bumped on every request so a slow old response cannot overwrite a newer one. */
  seq: number;
}

const EMPTY: ResourceSnapshot<never> = { data: undefined, error: undefined, loading: false, settled: false };
const cache = new Map<string, Entry<unknown>>();

function entryOf<T>(key: string, fetcher: () => Promise<T>): Entry<T> {
  let e = cache.get(key) as Entry<T> | undefined;
  if (!e) {
    e = { snapshot: EMPTY, fetcher, inflight: null, listeners: new Set(), seq: 0 };
    cache.set(key, e as Entry<unknown>);
  }
  return e;
}

function publish<T>(e: Entry<T>, patch: Partial<ResourceSnapshot<T>>): void {
  e.snapshot = { ...e.snapshot, ...patch };
  for (const l of e.listeners) l();
}

function load<T>(e: Entry<T>): Promise<T | undefined> {
  const seq = ++e.seq;
  publish(e, { loading: true });
  const p = e.fetcher().then(
    (data) => {
      if (seq === e.seq) publish(e, { data, error: undefined, loading: false, settled: true });
      return data;
    },
    (error: unknown) => {
      if (seq === e.seq) publish(e, { error, loading: false, settled: true });
      return undefined;
    },
  );
  e.inflight = p.finally(() => {
    if (e.inflight === p) e.inflight = null;
  });
  return p;
}

/** Reload every cached resource whose key starts with `prefix` (no-op for unknown keys). */
export function invalidate(prefix: string): void {
  for (const [key, e] of cache) if (key.startsWith(prefix) && e.listeners.size) void load(e);
}

/** Put fresh data into a cached resource (only if someone has asked for that key before). */
export function setResourceData<T>(key: string, data: T): void {
  const e = cache.get(key) as Entry<T> | undefined;
  if (e) {
    e.seq++;
    publish(e, { data, error: undefined, loading: false, settled: true });
  }
}

export interface UseResourceOptions {
  /** Reload when the server announces a write to one of these config entities. */
  reloadOn?: readonly ConfigEntityName[];
  /** Reload after the live socket reconnects (default true). */
  reloadOnReconnect?: boolean;
}

/**
 * Fetches `key` once and shares it. `key` null disables the request (e.g. while an id is
 * unknown). The fetcher may change between renders; the latest one is used.
 */
export function useResource<T>(key: string | null, fetcher: () => Promise<T>, opts: UseResourceOptions = {}): ResourceState<T> {
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const entry = key ? entryOf<T>(key, () => fetcherRef.current()) : null;
  if (entry) entry.fetcher = () => fetcherRef.current();

  const subscribe = useCallback(
    (fn: () => void) => {
      if (!entry) return () => undefined;
      entry.listeners.add(fn);
      return () => {
        entry.listeners.delete(fn);
      };
    },
    [entry],
  );
  const snapshot = useSyncExternalStore(subscribe, () => (entry ? entry.snapshot : (EMPTY as ResourceSnapshot<T>)));

  useEffect(() => {
    if (entry && !entry.snapshot.settled && !entry.inflight) void load(entry);
  }, [entry]);

  const reloadOn = opts.reloadOn?.join(',') ?? '';
  const reloadOnReconnect = opts.reloadOnReconnect ?? true;
  useEffect(() => {
    if (!entry) return;
    const entities = reloadOn ? new Set(reloadOn.split(',')) : null;
    let timer: number | undefined;
    // several config events arrive together after one save; reload once
    const soon = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void load(entry), 200);
    };
    const offConfig = entities
      ? liveStore.on('config', (ev) => {
          if (entities.has(ev.entity) || ev.op === 'imported') soon();
        })
      : () => undefined;
    const offReconnect = reloadOnReconnect ? liveStore.on('reconnect', soon) : () => undefined;
    return () => {
      window.clearTimeout(timer);
      offConfig();
      offReconnect();
    };
  }, [entry, reloadOn, reloadOnReconnect]);

  const reload = useCallback(() => (entry ? load(entry) : Promise.resolve(undefined)), [entry]);
  const setData = useCallback(
    (next: T | ((prev: T | undefined) => T)) => {
      if (!entry) return;
      const data = typeof next === 'function' ? (next as (prev: T | undefined) => T)(entry.snapshot.data) : next;
      entry.seq++;
      publish(entry, { data, error: undefined, loading: false, settled: true });
    },
    [entry],
  );

  return { ...snapshot, reload, setData };
}

/**
 * Asks again while the answer is not complete yet (the add-on had just started and could not read the
 * recorder) or the request failed: after 5 s, 10 s, 20 s, then every 30 s, until a complete answer.
 */
export function useRetryUntilComplete<T>(res: ResourceState<T>, incomplete: (data: T) => boolean): void {
  const { data, error, loading, reload } = res;
  const attempt = useRef(0);
  const check = useRef(incomplete);
  check.current = incomplete;
  useEffect(() => {
    if (loading) return;
    const waiting = error != null || (data !== undefined && check.current(data));
    if (!waiting) {
      attempt.current = 0;
      return;
    }
    const timer = window.setTimeout(() => void reload(), Math.min(30_000, 5_000 * 2 ** attempt.current++));
    return () => window.clearTimeout(timer);
  }, [data, error, loading, reload]);
}
