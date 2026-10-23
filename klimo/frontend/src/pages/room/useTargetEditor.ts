/**
 * The room target editor shared by the desktop stepper and the phone dial.
 *
 *   view ──(−/+, drag)──▶ pending (3 s, restarts on every change; paused while the duration
 *                          list is open or a knob is held) ──▶ applied (8 s undo) ──▶ view
 *
 * A change is sent only when the countdown runs out, so a few quick taps make one command.
 * While pending, the consequence is computed locally at once (the same rules as the server)
 * and replaced by the server's preview a moment later. After sending, the devices' confirmation
 * arrives over the socket under the command's reqId.
 *
 * A room under manual control holds every new value until the schedule is resumed, so its
 * changes are not asked how long they last.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Id,
  IconName,
  Reason,
  RoomDetailDto,
  RoomState,
  RoomTargetDuration,
  SetTargetRequest,
  SyncPhase,
  TargetCommandResult,
  TargetPreview,
  ThermostatModel,
} from '@api/model';
import { api } from '@api/endpoints';
import { liveStore, useRoomSync } from '@data';
import { errorText, fmtClock, fmtTemp, fmtUntil, nowMs, renderReason, roomDurationLabel, t, type CodeContext } from '@i18n';
import { toast, type Tone } from '@ui';
import { newReqId } from './reqId';
import { syncText } from './texts';

export const EDIT_DURATIONS = ['slot', '1h', '3h', 'manual', 'forever'] as const satisfies readonly RoomTargetDuration[];
export type EditDuration = (typeof EDIT_DURATIONS)[number];
export type EditValue = number | { lo: number; hi: number };
export type EditPhase = 'view' | 'pending' | 'applied';
export type EditMode = 'heat' | 'cool' | 'dual';

const PENDING_MS = 3000;
const UNDO_MS = 8000;
const TICK_MS = 100;
const PREVIEW_DEBOUNCE_MS = 300;

export interface Consequence {
  tone: Tone;
  icon: IconName;
  text: string;
}

export interface TargetEditor {
  phase: EditPhase;
  mode: EditMode;
  /** What the controls show: the pending value, or the active target. */
  value: EditValue | null;
  /** Dual: the bound −/+ act on. */
  selected: 'lo' | 'hi';
  select: (b: 'lo' | 'hi') => void;
  canEdit: boolean;
  min: number;
  max: number;
  stepC: number;
  gap: number;
  dragging: boolean;
  step: (dir: -1 | 1) => void;
  set: (value: EditValue, which?: 'lo' | 'hi' | 't') => void;
  dragStart: () => void;
  dragEnd: () => void;
  duration: EditDuration;
  /** Manual control: the new value holds with no end, there is no length to choose. */
  holds: boolean;
  setDuration: (d: EditDuration) => void;
  setDurationFocus: (focused: boolean) => void;
  durationOptions: (short: boolean) => { value: EditDuration; label: string }[];
  unchanged: boolean;
  consequence: Consequence | null;
  countdown: { remaining: number; total: number; frozen: boolean; text: (short: boolean) => string };
  cancel: () => void;
  applied: {
    text: string;
    sync?: { phase: SyncPhase; text: string };
    remaining: number;
    canUndo: boolean;
    undo: () => void;
  } | null;
}

const same = (a: EditValue | null, b: EditValue | null) =>
  a == null || b == null ? a === b : typeof a === 'number' || typeof b === 'number' ? a === b : Math.abs(a.lo - b.lo) < 1e-6 && Math.abs(a.hi - b.hi) < 1e-6;

const snap = (v: number, step: number) => Math.round(v / step) * step;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round5 = (m: number) => Math.round(m / 5) * 5;

function editModeOf(th: ThermostatModel, state: RoomState): EditMode {
  if (th.mode !== 'none') return th.mode;
  return state.activeModes.cool && !state.activeModes.heat ? 'cool' : 'heat';
}

function baseValue(th: ThermostatModel, state: RoomState, mode: EditMode): EditValue | null {
  if (mode === 'dual') {
    const lo = th.lo ?? state.target.heatC;
    const hi = th.hi ?? state.target.coolC;
    return lo != null && hi != null ? { lo, hi } : null;
  }
  return th.t ?? (mode === 'cool' ? state.target.coolC : state.target.heatC) ?? state.target.displayC;
}

function baseDuration(th: ThermostatModel, holds: boolean): EditDuration {
  if (holds) return 'manual';
  const d = th.override?.kind === 'room_target' ? th.override.duration : null;
  return d && (EDIT_DURATIONS as readonly string[]).includes(d) ? (d as EditDuration) : 'slot';
}

const PREVIEW_ICON: Record<TargetPreview['tone'], IconName> = { heat: 'flame', cool: 'snow', off: 'power', warn: 'alert', hold: 'checkCircle' };

/** The consequence without the server: the same rules as its preview, applied to the current reading, latch and band. */
export function localConsequence(
  value: EditValue,
  mode: EditMode,
  th: ThermostatModel,
  state: RoomState,
  isSame: boolean,
): { reason: Reason; tone: TargetPreview['tone']; icon: IconName } | null {
  if (isSame) return { reason: { code: 'preview.same' }, tone: 'hold', icon: 'info' };
  if (state.window.reactionActive) return { reason: { code: 'preview.window_applies_later' }, tone: 'warn', icon: 'windowOpen' };
  const tNow = state.tempC;
  if (tNow == null) return null;
  const now = nowMs();
  const eta = (delta: number, rate: number) => {
    const minutes = Math.max(5, round5((Math.abs(delta) / Math.max(0.1, rate)) * 60));
    return { etaMin: minutes, at: now + minutes * 60_000 };
  };
  if (typeof value === 'object') {
    if (value.hi - value.lo < th.gapC - 1e-6) return { reason: { code: 'preview.gap_too_small', params: { gapC: th.gapC } }, tone: 'warn', icon: 'gap' };
    const hb = th.tol;
    const cb = th.tolCool;
    if (tNow <= value.lo - hb.below) {
      const to = value.lo + hb.above;
      return {
        reason: { code: th.latches.heat ? 'preview.keep_heat' : 'preview.start_heat', params: { toC: to, ...eta(to - tNow, th.rate.heat) } },
        tone: 'heat',
        icon: 'flame',
      };
    }
    if (tNow >= value.hi + cb.above) {
      const to = value.hi - cb.below;
      return {
        reason: { code: th.latches.cool ? 'preview.keep_cool' : 'preview.start_cool', params: { toC: to, ...eta(tNow - to, th.rate.cool) } },
        tone: 'cool',
        icon: 'snow',
      };
    }
    return { reason: { code: 'preview.no_change_band', params: { lo: value.lo, hi: value.hi } }, tone: 'hold', icon: 'checkCircle' };
  }
  const p = value;
  if (mode === 'cool') {
    const { below: b, above: a } = th.tolCool;
    const latch = th.latches.cool;
    if (tNow >= p + a)
      return {
        reason: { code: latch ? 'preview.keep_cool' : 'preview.start_cool', params: { toC: p - b, ...eta(tNow - (p - b), th.rate.cool) } },
        tone: 'cool',
        icon: 'snow',
      };
    if (tNow <= p - b) return { reason: { code: latch ? 'preview.stop_cool' : 'preview.no_cool_needed', params: { t: tNow } }, tone: 'off', icon: 'power' };
    return latch
      ? { reason: { code: 'preview.cool_to_band', params: { offC: p - b } }, tone: 'cool', icon: 'snow' }
      : { reason: { code: 'preview.no_change_band', params: { lo: p - b, hi: p + a } }, tone: 'hold', icon: 'checkCircle' };
  }
  const { below: b, above: a } = th.tol;
  const latch = th.latches.heat;
  if (tNow <= p - b)
    return {
      reason: { code: latch ? 'preview.keep_heat' : 'preview.start_heat', params: { toC: p + a, ...eta(p + a - tNow, th.rate.heat) } },
      tone: 'heat',
      icon: 'flame',
    };
  if (tNow >= p + a) return { reason: { code: latch ? 'preview.stop_heat' : 'preview.no_heat_needed', params: { t: tNow } }, tone: 'off', icon: 'power' };
  return latch
    ? { reason: { code: 'preview.heat_to_band', params: { offC: p + a } }, tone: 'heat', icon: 'flame' }
    : { reason: { code: 'preview.no_change_band', params: { lo: p - b, hi: p + a } }, tone: 'hold', icon: 'checkCircle' };
}

function request(value: EditValue, duration: EditDuration, which: 'lo' | 'hi' | 't', reqId?: string): SetTargetRequest {
  return typeof value === 'number' ? { value, duration, reqId } : { lo: value.lo, hi: value.hi, which, duration, reqId };
}

const keyOf = (value: EditValue, duration: EditDuration) => JSON.stringify([value, duration]);

interface Applied {
  value: EditValue;
  duration: EditDuration;
  reqId: string;
  result: TargetCommandResult | null;
}

export function useTargetEditor(room: RoomDetailDto | undefined, state: RoomState | null, ctx: CodeContext): TargetEditor {
  const roomId: Id | null = room?.config.id ?? null;
  const th = room?.thermostat ?? null;
  const live = useRoomSync(roomId);

  const mode: EditMode = th && state ? editModeOf(th, state) : 'heat';
  const base = th && state ? baseValue(th, state, mode) : null;
  const holds = room?.summary.control.mode === 'manual';
  const baseDur = th ? baseDuration(th, holds) : 'slot';
  const canEdit = Boolean(th && state && !th.locked && state.tempC != null && roomId);

  const [phase, setPhase] = useState<EditPhase>('view');
  const [pending, setPending] = useState<{ value: EditValue; duration: EditDuration; which: 'lo' | 'hi' | 't' } | null>(null);
  const [remaining, setRemaining] = useState(PENDING_MS);
  const [focused, setFocused] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [selected, setSelected] = useState<'lo' | 'hi'>('hi');
  const [applied, setApplied] = useState<Applied | null>(null);
  const [undoLeft, setUndoLeft] = useState(UNDO_MS);
  const [server, setServer] = useState<{ key: string; preview: TargetPreview } | null>(null);

  // the room changed under the editor (another tab): start clean
  useEffect(() => {
    setPhase('view');
    setPending(null);
    setApplied(null);
  }, [roomId]);

  const frozen = focused || dragging;
  const shown: EditValue | null = phase === 'pending' && pending ? pending.value : phase === 'applied' && applied ? applied.value : base;

  /* ---------- editing ---------- */

  const set = useCallback(
    (value: EditValue, which: 'lo' | 'hi' | 't' = 't') => {
      if (!canEdit) return;
      setPending((p) => ({ value, duration: holds ? 'manual' : (p?.duration ?? baseDur), which: typeof value === 'number' ? 't' : which }));
      setPhase('pending');
      setApplied(null);
      setRemaining(PENDING_MS);
    },
    [canEdit, baseDur, holds],
  );

  const shownRef = useRef(shown);
  shownRef.current = shown;
  const step = useCallback(
    (dir: -1 | 1) => {
      if (!th) return;
      const cur = shownRef.current;
      if (cur == null) return;
      if (typeof cur === 'number') {
        set(clamp(snap(cur + dir * th.step, th.step), th.min, th.max));
        return;
      }
      const next = { ...cur };
      if (selected === 'lo') next.lo = clamp(snap(cur.lo + dir * th.step, th.step), th.min, next.hi - th.gapC);
      else next.hi = clamp(snap(cur.hi + dir * th.step, th.step), next.lo + th.gapC, th.max);
      set(next, selected);
    },
    [th, set, selected],
  );

  const dragStart = useCallback(() => {
    if (!canEdit) return;
    setDragging(true);
    if (phase !== 'pending' && shownRef.current != null) set(shownRef.current, selected);
  }, [canEdit, phase, set, selected]);
  const dragEnd = useCallback(() => {
    setDragging(false);
    setRemaining(PENDING_MS);
  }, []);

  const setDuration = useCallback((d: EditDuration) => {
    setPending((p) => (p ? { ...p, duration: d } : p));
    setRemaining(PENDING_MS);
  }, []);
  const setDurationFocus = useCallback((f: boolean) => {
    setFocused(f);
    setRemaining(PENDING_MS);
  }, []);
  const cancel = useCallback(() => {
    setPhase('view');
    setPending(null);
  }, []);

  /* ---------- countdowns ---------- */

  useEffect(() => {
    if (phase !== 'pending') return;
    const id = window.setInterval(() => setRemaining((r) => (frozen ? PENDING_MS : r - TICK_MS)), TICK_MS);
    return () => window.clearInterval(id);
  }, [phase, frozen]);

  useEffect(() => {
    if (phase !== 'applied') return;
    setUndoLeft(UNDO_MS);
    const id = window.setInterval(() => setUndoLeft((r) => r - TICK_MS), TICK_MS);
    return () => window.clearInterval(id);
  }, [phase, applied?.reqId]);

  useEffect(() => {
    if (phase === 'applied' && undoLeft <= 0) {
      setPhase('view');
      setApplied(null);
    }
  }, [phase, undoLeft]);

  const unchanged = Boolean(pending && same(pending.value, base) && pending.duration === baseDur);

  /* ---------- commit ---------- */

  const commit = useCallback(() => {
    if (!pending || !roomId) return;
    if (unchanged) {
      setPhase('view');
      setPending(null);
      return;
    }
    const reqId = newReqId();
    // the room went to manual control while the change waited: it holds the new value too
    const sent = holds ? { ...pending, duration: 'manual' as const } : pending;
    setApplied({ value: sent.value, duration: sent.duration, reqId, result: null });
    setPending(null);
    setPhase('applied');
    api.rooms
      .setTarget(roomId, request(sent.value, sent.duration, sent.which, reqId))
      .then((res) => {
        liveStore.putRoomState(res.state);
        setApplied((a) => (a && a.reqId === reqId ? { ...a, result: res } : a));
      })
      .catch((e: unknown) => {
        const text = errorText(e);
        toast({ tone: 'err', message: text ? t('The target was not changed: {reason}', { reason: text }) : t('The target was not changed.') });
        setApplied((a) => (a && a.reqId === reqId ? null : a));
        setPhase((p) => (p === 'applied' ? 'view' : p));
      });
  }, [pending, roomId, unchanged, holds]);

  useEffect(() => {
    if (phase === 'pending' && remaining <= 0) commit();
  }, [phase, remaining, commit]);

  const undo = useCallback(() => {
    const token = applied?.result?.revertToken;
    if (!roomId || !token) return;
    setPhase('view');
    setApplied(null);
    api.rooms
      .undo(roomId, { revertToken: token })
      .then((res) => {
        liveStore.putRoomState(res.state);
        toast({ tone: 'ok', message: t('The previous target is back.') });
      })
      .catch((e: unknown) => toast({ tone: 'err', message: errorText(e) || t('Too late to undo — the change is already final.') }));
  }, [applied, roomId]);

  /* ---------- previews ---------- */

  useEffect(() => {
    if (phase !== 'pending' || !pending || !roomId || unchanged) return;
    const key = keyOf(pending.value, pending.duration);
    const req = request(pending.value, pending.duration, pending.which);
    const timer = window.setTimeout(() => {
      api.rooms
        .preview(roomId, req)
        .then((preview) => setServer({ key, preview }))
        .catch(() => {
          /* the local estimate stays */
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [phase, pending, roomId, unchanged]);

  const consequence = useMemo<Consequence | null>(() => {
    if (phase !== 'pending' || !pending || !th || !state) return null;
    const writes =
      pending.duration === 'forever' && !unchanged
        ? renderReason({ code: 'preview.writes_profile', params: { profileId: state.target.profileId ?? th.profileId ?? null } }, ctx)
        : '';
    const join = (main: string) => (writes ? `${main} · ${writes}` : main);
    const key = keyOf(pending.value, pending.duration);
    if (server && server.key === key && !unchanged) {
      const pv = server.preview;
      const tone: Tone = pv.tone;
      return { tone, icon: pv.icon ?? PREVIEW_ICON[pv.tone], text: join(renderReason(pv.main, ctx)) };
    }
    const local = localConsequence(pending.value, mode, th, state, unchanged);
    if (!local) return null;
    return { tone: local.tone, icon: local.icon, text: unchanged ? t('Same target — nothing will be sent') : join(renderReason(local.reason, ctx)) };
  }, [phase, pending, th, state, server, unchanged, mode, ctx]);

  /* ---------- texts ---------- */

  const durationOptions = useCallback(
    (short: boolean) =>
      EDIT_DURATIONS.map((d) => {
        if (d === 'slot') {
          const until = th?.untils.slot ?? null;
          return { value: d, label: until != null ? t('Until {time}', { time: fmtClock(until) }) : t('Until the next slot') };
        }
        if (short) return { value: d, label: d === '1h' ? t('1 h') : d === '3h' ? t('3 h') : d === 'manual' ? t('Manual') : t('Permanently') };
        return { value: d, label: roomDurationLabel(d) };
      }),
    [th],
  );

  const devices = th?.devices ?? { trv: 0, ac: 0, heater: 0, zone: 0 };
  const valueText = (v: EditValue) => (typeof v === 'number' ? fmtTemp(v) : `${fmtTemp(v.lo)}–${fmtTemp(v.hi)}`);
  const seconds = Math.max(0, Math.ceil(remaining / 1000));
  const countdownText = (short: boolean): string => {
    if (dragging) return t('Release to choose');
    if (unchanged) return t('Closing in {n} s', { n: seconds });
    if (short || !pending) return t('Sending in {n} s', { n: seconds });
    const v = valueText(pending.value);
    if (devices.trv > 0) return t('Sending {t} to {count} radiator valves in {n} s', { t: v, count: devices.trv, n: seconds });
    if (devices.ac > 0) return t('Sending {t} to the air conditioner in {n} s', { t: v, n: seconds });
    return t('Sending {t} in {n} s', { t: v, n: seconds });
  };

  const appliedInfo = useMemo<TargetEditor['applied']>(() => {
    if (phase !== 'applied' || !applied) return null;
    const res = applied.result;
    const v = valueText(applied.value);
    let text: string;
    if (applied.duration === 'manual') {
      text = t('Target {t} · manual control', { t: v });
    } else if (applied.duration === 'forever') {
      const pid = res?.profileWritten?.profileId ?? state?.target.profileId ?? null;
      text = pid ? t('Target {t} saved to «{profile}»', { t: v, profile: ctx.profile?.(pid) ?? pid }) : t('Target {t} saved to the profile', { t: v });
    } else {
      const until = res?.until ?? th?.untils[applied.duration] ?? null;
      text = t('Target {t} {until}', { t: v, until: fmtUntil(until) });
    }
    const slice = live && live.reqId === applied.reqId ? live.sync : state?.sync.reqId === applied.reqId ? state.sync : null;
    const total = devices.trv + devices.ac + devices.heater + devices.zone;
    const sync =
      slice && slice.phase !== 'idle'
        ? { phase: slice.phase, text: syncText(slice) }
        : state?.window.reactionActive
          ? // the valves stay closed while the window is open: nothing is sent yet
            { phase: 'idle' as SyncPhase, text: t('applies when the window is closed') }
          : total > 0
            ? {
                phase: 'sending' as SyncPhase,
                text: syncText({
                  phase: 'sending',
                  acked: 0,
                  total: devices.trv || total,
                  attempt: 1,
                  maxAttempts: 3,
                  what: devices.trv ? 'trv' : devices.ac ? 'ac' : 'mixed',
                }),
              }
            : undefined;
    return { text, sync, remaining: undoLeft / 1000, canUndo: Boolean(res?.revertToken), undo };
    // valueText is pure; devices is derived from th
  }, [phase, applied, th, state, live, undoLeft, undo, ctx, devices.trv, devices.ac, devices.heater, devices.zone]);

  return {
    phase,
    mode,
    value: shown,
    selected,
    select: setSelected,
    canEdit,
    min: th?.min ?? 5,
    max: th?.max ?? 30,
    stepC: th?.step ?? 0.5,
    gap: th?.gapC ?? 2,
    dragging,
    step,
    set,
    dragStart,
    dragEnd,
    duration: pending?.duration ?? baseDur,
    holds,
    setDuration,
    setDurationFocus,
    durationOptions,
    unchanged,
    consequence,
    countdown: { remaining: remaining / 1000, total: PENDING_MS / 1000, frozen, text: countdownText },
    cancel,
    applied: appliedInfo,
  };
}
