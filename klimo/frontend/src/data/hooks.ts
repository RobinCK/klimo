import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type {
  CreateRoomReport,
  EntityRolePreset,
  EpochMs,
  HaEntityDto,
  HaEntityQuery,
  HouseState,
  Id,
  IncidentDto,
  MeDto,
  MetaDto,
  PlantState,
  RoomDetailDto,
  RoomState,
  RoomSummary,
  WsTopic,
} from '@api/model';
import { api, type IncidentScope } from '@api/endpoints';
import { isApiError } from '@api/client';
import { errorText, issuesByPath, setFormatContext, t } from '@i18n';
import { toast, undoToast } from '@ui';
import { liveStore, type CommandResult, type ConnectionStatus, type LiveEventName, type LiveEvents, type LiveState, type SimClock, type SyncSlice } from './live';
import { useResource, type ResourceState } from './resource';

/* ---------------- live slices ---------------- */

/** Select a slice of the live store; re-renders only when the selected value changes identity. */
export function useLive<T>(selector: (s: LiveState) => T): T {
  return useSyncExternalStore(liveStore.subscribe, () => selector(liveStore.getState()));
}

/** Keep an opt-in socket topic subscribed while the component is mounted. */
export function useTopic(topic: WsTopic | null): void {
  useEffect(() => (topic ? liveStore.retain(topic) : undefined), [topic]);
}

/** Run `handler` for every live message of one kind (journal lines, command results …). */
export function useLiveEvent<K extends LiveEventName>(name: K, handler: (payload: LiveEvents[K]) => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => liveStore.on(name, (p) => ref.current(p)), [name]);
}

export interface ConnectionInfo {
  status: ConnectionStatus;
  everConnected: boolean;
  /** Server time of the freshest data. */
  lastUpdateAt: EpochMs | null;
}

const selectConnection = (s: LiveState) => s.status;
const selectEver = (s: LiveState) => s.everConnected;
const selectLastUpdate = (s: LiveState) => s.lastUpdateAt;

/** State of the live socket, for the «оновлено N хв тому» banner. */
export function useConnection(): ConnectionInfo {
  const status = useLive(selectConnection);
  const everConnected = useLive(selectEver);
  const lastUpdateAt = useLive(selectLastUpdate);
  return useMemo(() => ({ status, everConnected, lastUpdateAt }), [status, everConnected, lastUpdateAt]);
}

const selectHouse = (s: LiveState) => s.house;
const selectRoomList = (s: LiveState) => s.roomList;
const selectRoomsLoaded = (s: LiveState) => s.roomsLoaded;
const selectPlant = (s: LiveState) => s.plant;
const selectSim = (s: LiveState) => s.sim;

/** House headline state (live). Null until the first overview arrives. */
export function useHouse(): HouseState | null {
  return useLive(selectHouse);
}

/** Every room's card summary in display order (live). */
export function useRoomSummaries(): readonly RoomSummary[] {
  return useLive(selectRoomList);
}

/** Whether the room list has been loaded at least once (an empty list then means «no rooms»). */
export function useRoomsLoaded(): boolean {
  return useLive(selectRoomsLoaded);
}

/** Plant state; subscribes the `plant` topic while mounted. */
export function usePlant(): PlantState | null {
  useTopic('plant');
  const plant = useLive(selectPlant);
  const reconnects = useLive((s) => s.reconnectSeq);
  useEffect(() => {
    void liveStore.loadPlant();
  }, [reconnects]);
  return plant;
}

/** Simulator clock (subscribes the `sim` topic); null outside the simulator. */
export function useSimClock(enabled: boolean): SimClock | null {
  useTopic(enabled ? 'sim' : null);
  return useLive(selectSim);
}

/** Sync progress of a room's devices after a change («Надсилаю на 2 головки…»). */
export function useRoomSync(roomId: Id | null | undefined): SyncSlice | null {
  return useLive((s) => (roomId ? (s.sync[roomId] ?? null) : null));
}

/** The result of a control action identified by its reqId, once the server reports it. */
export function useCommandResult(reqId: string | null | undefined): CommandResult | null {
  return useLive((s) => (reqId ? (s.commandResults[reqId] ?? null) : null));
}

/** Live add-room report (steps arrive one by one); falls back to polling every 2 s. */
export function useWizardReport(reportId: Id | null | undefined): CreateRoomReport | null {
  const live = useLive((s) => (reportId ? (s.wizard[reportId] ?? null) : null));
  const res = useResource(reportId ? `wizard-report:${reportId}` : null, () => api.rooms.report(reportId as Id), { reloadOnReconnect: true });
  const { reload } = res;
  const done = live?.done ?? res.data?.done ?? false;
  useEffect(() => {
    if (!reportId || done) return;
    const timer = window.setInterval(() => void reload(), 2000);
    return () => window.clearInterval(timer);
  }, [reportId, done, reload]);
  if (live && res.data) return live.steps.length >= res.data.steps.length ? live : res.data;
  return live ?? res.data ?? null;
}

/* ---------------- REST resources with live overlays ---------------- */

/** Version, time zone, Home Assistant link, the user's rights. */
export function useMeta(): ResourceState<MetaDto> {
  const res = useResource('meta', api.meta);
  const units = res.data?.defaults.units;
  useEffect(() => {
    if (units) setFormatContext({ units });
  }, [units]);
  return res;
}

/** The panel user (admin flag, whether config can be edited). */
export function useMe(): MeDto | null {
  return useMeta().data?.me ?? null;
}

export interface RoomResource extends ResourceState<RoomDetailDto> {
  /** Live state when the socket has one, else the state from the last fetch. */
  state: RoomState | null;
  summary: RoomSummary | null;
  sync: SyncSlice | null;
}

const ROOM_ENTITIES = ['room', 'sensor', 'emitter', 'emitter_device', 'profile', 'profile_room', 'schedule', 'override', 'source', 'circuit'] as const;

/** One room's detail (config, devices, thermostat) with its live state; `id` may be the slug. */
export function useRoom(id: Id | null | undefined): RoomResource {
  const res = useResource(id ? `room:${id}` : null, () => api.rooms.get(id as Id), { reloadOn: ROOM_ENTITIES });
  const roomId = res.data?.config.id ?? null;
  useTopic(roomId ? (`room:${roomId}` as WsTopic) : null);
  const liveState = useLive((s) => (roomId ? (s.room[roomId] ?? null) : null));
  const liveSummary = useLive((s) => (roomId ? (s.rooms.get(roomId) ?? null) : null));
  const sync = useRoomSync(roomId);
  const state = liveState && res.data && liveState.updatedAt >= res.data.state.updatedAt ? liveState : (res.data?.state ?? liveState);
  const summary = liveSummary ?? res.data?.summary ?? null;
  const data = useMemo(
    () => (res.data && (state !== res.data.state || summary !== res.data.summary) ? { ...res.data, state: state ?? res.data.state, summary: summary ?? res.data.summary } : res.data),
    [res.data, state, summary],
  );
  return { ...res, data, state: state ?? null, summary, sync };
}

/**
 * Incidents of one scope (attention, devices, inbox, all, room:<id>, source:<id>). A live update
 * of a listed item shows at once; the list is then re-read, because whether an incident belongs
 * to a scope (new, resolved, snoozed) is decided by the server.
 */
export function useIncidents(scope: IncidentScope): ResourceState<IncidentDto[]> {
  const res = useResource(`incidents:${scope}`, () => api.incidents.list({ scope }));
  const { data, setData, reload } = res;
  useLiveEvent('incident', (ev) => {
    const i = data ? data.findIndex((x) => x.id === ev.incident.id) : -1;
    if (data && i >= 0) {
      setData(ev.op === 'remove' ? [...data.slice(0, i), ...data.slice(i + 1)] : data.map((x, k) => (k === i ? ev.incident : x)));
    }
    scheduleReload(reload);
  });
  return res;
}

const reloadTimers = new WeakMap<() => unknown, number>();
function scheduleReload(reload: () => unknown): void {
  window.clearTimeout(reloadTimers.get(reload));
  reloadTimers.set(
    reload,
    window.setTimeout(() => void reload(), 300),
  );
}

/* ---------------- mutations ---------------- */

export interface MutationOptions<A extends unknown[], R> {
  /** Toast after success (text, or built from the result). */
  okToast?: string | ((result: R, ...args: A) => string);
  /** Offer an 8-second undo after success. */
  undo?: (result: R, ...args: A) => { message: string; onUndo: () => void } | null;
  onSuccess?: (result: R, ...args: A) => void;
  onError?: (error: unknown) => void;
  /** Show the red toast on failure (default true). */
  errorToast?: boolean;
}

export interface Mutation<A extends unknown[], R> {
  run: (...args: A) => Promise<R | undefined>;
  pending: boolean;
  error: unknown;
  /** Field problems of a 400, by path ('tolerance.heat.below' → «Від 0.1 до 1»). */
  issues: Record<string, string>;
  reset: () => void;
}

/** Wraps a write: pending flag, red toast with the server's reason, field issues, optional undo. */
export function useMutation<A extends unknown[], R>(fn: (...args: A) => Promise<R>, opts: MutationOptions<A, R> = {}): Mutation<A, R> {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const run = useCallback(async (...args: A): Promise<R | undefined> => {
    const o = optsRef.current;
    setPending(true);
    setError(undefined);
    setIssues({});
    try {
      const result = await fnRef.current(...args);
      if (mounted.current) setPending(false);
      o.onSuccess?.(result, ...args);
      const undo = o.undo?.(result, ...args);
      if (undo) undoToast({ message: undo.message, onUndo: undo.onUndo, seconds: 8 });
      else if (o.okToast) toast({ tone: 'ok', message: typeof o.okToast === 'function' ? o.okToast(result, ...args) : o.okToast });
      return result;
    } catch (e) {
      if (mounted.current) {
        setPending(false);
        setError(e);
        if (isApiError(e) && e.issues.length) setIssues(issuesByPath(e.issues));
      }
      o.onError?.(e);
      const text = errorText(e);
      if (o.errorToast !== false && text) toast({ tone: 'err', message: text });
      return undefined;
    }
  }, []);

  const reset = useCallback(() => {
    setError(undefined);
    setIssues({});
  }, []);

  return { run, pending, error, issues, reset };
}

/* ---------------- autosave ---------------- */

export type AutosaveState = 'idle' | 'saving' | 'saved' | 'error';

export interface Autosave<T> {
  /** What the control shows (the local edit, or the server value when nothing is pending). */
  value: T;
  set: (next: T | ((prev: T) => T)) => void;
  state: AutosaveState;
  retry: () => void;
  /** Save a pending edit now (e.g. before navigating away). */
  flush: () => Promise<void>;
  dirty: boolean;
}

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * Optimistic settings field: edits show immediately, are saved after `debounceMs` of quiet, and
 * on failure the control returns to the server value with a red toast.
 */
export function useAutosave<T>(serverValue: T, save: (next: T) => Promise<unknown>, opts: { debounceMs?: number } = {}): Autosave<T> {
  const debounceMs = opts.debounceMs ?? 400;
  const [local, setLocal] = useState<T>(serverValue);
  const [dirty, setDirty] = useState(false);
  const [state, setState] = useState<AutosaveState>('idle');
  const saveRef = useRef(save);
  saveRef.current = save;
  const timer = useRef<number | undefined>(undefined);
  const savedTimer = useRef<number | undefined>(undefined);
  const latest = useRef<T>(serverValue);
  const pendingValue = useRef<T | null>(null);
  const lastAttempt = useRef<T | null>(null);
  const serverRef = useRef(serverValue);
  serverRef.current = serverValue;
  const mounted = useRef(true);

  // follow the server while the user is not editing
  useEffect(() => {
    if (!dirty && !same(latest.current, serverValue)) {
      latest.current = serverValue;
      setLocal(serverValue);
    }
  }, [serverValue, dirty]);

  const doSave = useCallback(async (value: T) => {
    pendingValue.current = null;
    lastAttempt.current = value;
    setState('saving');
    try {
      await saveRef.current(value);
      if (!mounted.current) return;
      // a newer edit may already be queued; it owns the dirty flag then
      if (pendingValue.current === null) setDirty(false);
      setState('saved');
      window.clearTimeout(savedTimer.current);
      savedTimer.current = window.setTimeout(() => mounted.current && setState('idle'), 2000);
    } catch (e) {
      if (!mounted.current) return;
      window.clearTimeout(timer.current);
      pendingValue.current = null;
      latest.current = serverRef.current;
      setLocal(serverRef.current);
      setDirty(false);
      setState('error');
      const text = errorText(e);
      if (text) toast({ tone: 'err', message: t('Not saved: {reason}', { reason: text }) });
    }
  }, []);

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      const value = typeof next === 'function' ? (next as (prev: T) => T)(latest.current) : next;
      latest.current = value;
      pendingValue.current = value;
      setLocal(value);
      setDirty(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void doSave(value), debounceMs);
    },
    [debounceMs, doSave],
  );

  const flush = useCallback(async () => {
    window.clearTimeout(timer.current);
    if (pendingValue.current !== null) await doSave(pendingValue.current);
  }, [doSave]);

  const retry = useCallback(() => {
    if (lastAttempt.current !== null) set(lastAttempt.current);
  }, [set]);

  // an edit still waiting for its debounce is saved when the control goes away
  useEffect(
    () => () => {
      mounted.current = false;
      window.clearTimeout(timer.current);
      window.clearTimeout(savedTimer.current);
      if (pendingValue.current !== null) void saveRef.current(pendingValue.current).catch(() => undefined);
    },
    [],
  );

  return { value: local, set, state, retry, flush, dirty };
}

/* ---------------- entity search, time, layout ---------------- */

export interface EntitySearchContext {
  /** Rank entities of this room's area first. */
  roomId?: Id;
  /** Rank entities of this HA area first (before the room exists). */
  areaId?: string | null;
  /** Add-room wizard: what can take this device role ('any': any role), each with its role hint. */
  wizard?: HaEntityQuery['wizard'];
  /** Only entities not yet used by Klimo. */
  unassigned?: boolean;
  domain?: string[];
  limit?: number;
}

/** The `search` function an entity picker needs, preset for a role. */
export function useEntitySearch(role: EntityRolePreset | null, ctx: EntitySearchContext = {}): (q: string) => Promise<HaEntityDto[]> {
  const { roomId, areaId, wizard, unassigned, limit } = ctx;
  const domain = ctx.domain?.join(',');
  return useCallback(
    (q: string) =>
      api.ha.entities({
        q: q.trim() || undefined,
        role: role ?? undefined,
        nearRoomId: roomId,
        nearAreaId: areaId ?? undefined,
        wizard,
        unassigned,
        domain: domain ? domain.split(',') : undefined,
        limit: limit ?? 50,
      }),
    [role, roomId, areaId, wizard, unassigned, domain, limit],
  );
}

/** Server-aligned now (simulator time in the simulator), re-rendering every `stepMs`. */
export function useNow(stepMs = 1000): EpochMs {
  const [now, setNow] = useState(() => liveStore.now());
  useEffect(() => {
    let timer: number | undefined;
    const tick = () => setNow(liveStore.now());
    tick();
    // align to the step so «через 2 хв» changes on the minute, not at a random second
    const first = window.setTimeout(
      () => {
        tick();
        timer = window.setInterval(tick, stepMs);
      },
      stepMs - (Date.now() % stepMs),
    );
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [stepMs]);
  return now;
}

export type Layout = 'phone' | 'tablet' | 'desktop';

function readLayout(): Layout {
  if (typeof window === 'undefined') return 'desktop';
  const w = window.innerWidth;
  return w < 700 ? 'phone' : w < 1020 ? 'tablet' : 'desktop';
}

let layoutCache: Layout = readLayout();
const layoutListeners = new Set<() => void>();
if (typeof window !== 'undefined') {
  window.addEventListener('resize', () => {
    const next = readLayout();
    if (next !== layoutCache) {
      layoutCache = next;
      for (const l of layoutListeners) l();
    }
  });
}

/** phone < 700 px · tablet 700–1019 · desktop ≥ 1020. */
export function useLayout(): Layout {
  return useSyncExternalStore(
    (fn) => {
      layoutListeners.add(fn);
      return () => {
        layoutListeners.delete(fn);
      };
    },
    () => layoutCache,
  );
}
