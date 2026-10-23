/**
 * The «Змінити профіль будинку» panel: pick a profile and a duration, see what the switch
 * will do, apply it with an 8-second undo. Going back to the schedule is the house control.
 *
 * The consequence is shown at once from a local estimate (the same rules as the server:
 * which rooms go up or down and how many would start) and replaced by the server's own preview
 * a moment later, which also knows the source the strategy would pick.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DurationOption, HouseDuration, HouseProfilePreview, HouseState, Id, IconName, ProfileDto, Reason, RoomSummary } from '@api/model';
import { api } from '@api/endpoints';
import { liveStore, useHouse, useMutation, useResource, useRoomSummaries } from '@data';
import { fmtClock, fmtUntil, renderReason, renderReasons, t, type CodeContext } from '@i18n';
import { toast, undoToast } from '@ui';
import { newReqId } from './reqId';

/** The four choices of the panel; «до часу» needs a time picker and lives on the schedule page. */
export const PANEL_DURATIONS = ['slot', '2h', 'morning', 'none'] as const satisfies readonly HouseDuration[];
export type PanelDuration = (typeof PANEL_DURATIONS)[number];

export interface Consequence {
  tone: 'heat' | 'cool' | 'off' | 'hold' | 'warn';
  icon: IconName;
  main: string;
  chips: string[];
  same: boolean;
}

export interface ProfileSwitch {
  open: boolean;
  openPanel: () => void;
  close: () => void;
  profiles: readonly ProfileDto[];
  activeId: Id | null;
  pick: Id | null;
  setPick: (id: Id) => void;
  duration: PanelDuration;
  setDuration: (d: PanelDuration) => void;
  durationOptions: { value: PanelDuration; label: string; hint: string }[];
  consequence: Consequence | null;
  applyLabel: string;
  canApply: boolean;
  apply: () => void;
  applying: boolean;
}

const EPS = 0.05;

function untilOf(options: readonly DurationOption[] | undefined, d: HouseDuration): number | null {
  return options?.find((o) => o.id === d)?.until ?? null;
}

/** Room value of a profile for the season's mode; null when the profile switches the room off. */
function roomValue(p: ProfileDto, roomId: Id, cool: boolean): number | null {
  if (p.frostOnly) return null;
  const row = p.roomTargets.find((r) => r.roomId === roomId);
  if (row?.mode === 'off') return null;
  if (row?.mode === 'own') return cool ? (row.coolC ?? p.coolC) : (row.heatC ?? p.heatC);
  return cool ? p.coolC : p.heatC;
}

/** The local estimate (the server preview replaces it): same algorithm, without the source choice. */
export function localPreview(
  house: HouseState,
  rooms: readonly RoomSummary[],
  p: ProfileDto,
  activeId: Id | null,
  frostC: number | null,
): Omit<HouseProfilePreview, 'until' | 'clearsOverride' | 'sourceIds'> {
  const cool = house.season.season === 'cooling';
  if (p.id === activeId) {
    return {
      profileId: p.id,
      same: true,
      up: [],
      down: [],
      run: [],
      roomsOff: [],
      tone: 'hold',
      main: { code: 'house.preview.same', params: { profileId: p.id } },
      chips: [],
    };
  }
  const up: Id[] = [];
  const down: Id[] = [];
  const run: Id[] = [];
  const off: Id[] = [];
  for (const r of rooms) {
    if (r.state === 'monitor') continue;
    const v = roomValue(p, r.id, cool);
    if (v == null) {
      off.push(r.id);
      continue;
    }
    if (r.targetC != null && v > r.targetC + EPS) up.push(r.id);
    if (r.targetC != null && v < r.targetC - EPS) down.push(r.id);
    if (r.state === 'window' || r.tempC == null) continue;
    const need = cool ? r.tempC >= v + r.tol.above : r.tempC <= v - r.tol.below;
    if (need) run.push(r.id);
  }
  const active = house.counts.active;
  let main: Reason;
  let tone: HouseProfilePreview['tone'];
  if (run.length) {
    main = { code: cool ? 'house.preview.will_cool' : 'house.preview.will_heat', params: { n: run.length } };
    tone = cool ? 'cool' : 'heat';
  } else if (active > 0) {
    main = { code: cool ? 'house.preview.cooling_stops' : 'house.preview.heating_stops', params: { n: active } };
    tone = 'off';
  } else {
    main = { code: 'house.preview.no_change' };
    tone = 'hold';
  }
  const chips: Reason[] = [];
  if (up.length) chips.push({ code: 'house.chip.up', params: { n: up.length } });
  if (down.length) chips.push({ code: 'house.chip.down', params: { n: down.length } });
  if (off.length && !p.frostOnly) chips.push({ code: 'house.chip.off', params: { n: off.length } });
  if (p.frostOnly) chips.push({ code: 'house.chip.frost_stays', params: { frostC } });
  return { profileId: p.id, same: false, up, down, run, roomsOff: off, tone, main, chips };
}

const ICON: Record<HouseProfilePreview['tone'], IconName> = { heat: 'flame', cool: 'snow', off: 'power', hold: 'info' };

function consequenceOf(pv: Pick<HouseProfilePreview, 'same' | 'tone' | 'main' | 'chips'>, ctx: CodeContext): Consequence {
  return {
    tone: pv.tone,
    icon: pv.same ? 'info' : ICON[pv.tone],
    main: pv.same ? t('This is the current profile — pick another one.') : renderReason(pv.main, ctx),
    chips: pv.same ? [] : renderReasons(pv.chips, ctx),
    same: pv.same,
  };
}

function durationLabel(d: PanelDuration, until: number | null): { label: string; hint: string } {
  switch (d) {
    case 'slot':
      return until != null
        ? { label: t('Until {time}', { time: fmtClock(until) }), hint: t('next schedule change') }
        : { label: t('Until the next change'), hint: t('next schedule change') };
    case '2h':
      return { label: t('2 hours'), hint: until != null ? fmtUntil(until) : '' };
    case 'morning':
      return { label: t('Until morning'), hint: until != null ? fmtUntil(until) : '' };
    case 'none':
      return { label: t('No limit'), hint: t('the schedule is paused') };
  }
}

export function useProfileSwitch(ctx: CodeContext): ProfileSwitch {
  const house = useHouse();
  const rooms = useRoomSummaries();
  const profilesRes = useResource('names:profiles', api.profiles.list, { reloadOn: ['profile', 'profile_room'] });
  const houseProfile = useResource('house-profile', api.house.profile, { reloadOn: ['override', 'schedule', 'house', 'profile'] });
  const settings = useResource('settings', api.settings.get, { reloadOn: ['settings', 'safety'] });
  const frostC = settings.data?.safety.frostC ?? null;
  const profiles = useMemo(() => [...(profilesRes.data ?? [])].sort((a, b) => a.order - b.order), [profilesRes.data]);
  const activeId = house?.profile.activeProfileId ?? null;

  const [open, setOpen] = useState(false);
  const [pick, setPickState] = useState<Id | null>(null);
  const [duration, setDuration] = useState<PanelDuration>('slot');
  const [server, setServer] = useState<HouseProfilePreview | null>(null);
  const seq = useRef(0);

  const openPanel = useCallback(() => {
    setPickState(activeId);
    setDuration('slot');
    setServer(null);
    setOpen(true);
    void houseProfile.reload();
  }, [activeId, houseProfile]);
  const close = useCallback(() => setOpen(false), []);
  const setPick = useCallback((id: Id) => {
    setPickState(id);
    setServer(null);
  }, []);
  const setDur = useCallback((d: PanelDuration) => {
    setDuration(d);
    setServer(null);
  }, []);

  // the server preview, 150 ms after the last change; a late answer for an older pick is dropped
  useEffect(() => {
    if (!open || !pick) return;
    const my = ++seq.current;
    const timer = window.setTimeout(() => {
      api.house
        .preview({ profileId: pick, duration })
        .then((pv) => {
          if (seq.current === my) setServer(pv);
        })
        .catch(() => {
          /* the local estimate stays */
        });
    }, 150);
    return () => window.clearTimeout(timer);
  }, [open, pick, duration]);

  const picked = profiles.find((p) => p.id === pick) ?? null;
  const consequence = useMemo(() => {
    if (server && server.profileId === pick) return consequenceOf(server, ctx);
    if (!house || !picked) return null;
    return consequenceOf(localPreview(house, rooms, picked, activeId, frostC), ctx);
  }, [server, pick, house, picked, rooms, activeId, frostC, ctx]);

  const durations = houseProfile.data?.durations;
  const durationOptions = PANEL_DURATIONS.map((d) => ({ value: d, ...durationLabel(d, untilOf(durations, d)) }));
  const until = untilOf(durations, duration);
  const same = consequence?.same ?? pick === activeId;
  const untilText = duration === 'none' ? t('with no limit') : until != null ? fmtUntil(until) : '';
  const applyLabel = same || !picked ? t('Switch over') : t('Switch to «{profile}» {until}', { profile: picked.name, until: untilText }).trim();

  // the tiles and the headline follow at once, without waiting for the next engine tick
  const refreshHouse = useCallback(() => {
    api.house
      .state()
      .then((h) => liveStore.putHouse(h))
      .catch(() => undefined);
  }, []);

  const applyMut = useMutation((profileId: Id, d: PanelDuration) => api.house.setProfile({ profileId, duration: d, reqId: newReqId() }), {
    onSuccess: (res, profileId) => {
      setOpen(false);
      houseProfile.setData(res);
      refreshHouse();
      const name = profiles.find((p) => p.id === profileId)?.name ?? profileId;
      const scheduled = res.state.layer !== 'house_manual';
      const message = scheduled
        ? t('Back to the schedule: «{profile}».', { profile: ctx.profile?.(res.state.activeProfileId) ?? name })
        : t('Profile «{profile}» is on {until}.', {
            profile: name,
            until: res.state.override?.until != null ? fmtUntil(res.state.override.until) : t('with no limit'),
          });
      const token = res.revertToken;
      if (token) {
        undoToast({
          message,
          seconds: 8,
          onUndo: () => {
            api.house
              .undo({ revertToken: token })
              .then((back) => {
                houseProfile.setData(back);
                refreshHouse();
                toast({ tone: 'ok', message: t('The previous profile is back.') });
              })
              .catch(() => toast({ tone: 'err', message: t('Too late to undo — the change is already final.') }));
          },
        });
      } else toast({ tone: 'ok', message });
    },
  });

  return {
    open,
    openPanel,
    close,
    profiles,
    activeId,
    pick,
    setPick,
    duration,
    setDuration: setDur,
    durationOptions,
    consequence,
    applyLabel,
    canApply: Boolean(picked) && !same && !applyMut.pending,
    apply: () => {
      if (pick && !same) void applyMut.run(pick, duration);
    },
    applying: applyMut.pending,
  };
}
