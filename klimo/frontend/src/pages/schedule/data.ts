/**
 * What the schedule screens read: profiles (with their room rows and rules), the priority
 * order, the settings that bound the targets, and the live house and rooms.
 */
import { useCallback } from 'react';
import type { Id, ProfileDto, SettingsBundle } from '@api/model';
import { api } from '@api/endpoints';
import { useCodeContext, useHouse, useMe, useNow, useResource, useRoomSummaries } from '@data';

export function useProfiles() {
  // shares the request with the name directory, so names and the editor never disagree
  const res = useResource('names:profiles', api.profiles.list, { reloadOn: ['profile', 'profile_room', 'activation_rule', 'schedule', 'house'] });
  const { setData } = res;
  /** Put a profile the server returned into the list (after a write). */
  const put = useCallback(
    (p: ProfileDto) =>
      setData((prev) => {
        const list = prev ?? [];
        return list.some((x) => x.id === p.id) ? list.map((x) => (x.id === p.id ? p : x)) : [...list, p].sort((a, b) => a.order - b.order);
      }),
    [setData],
  );
  return { ...res, put };
}

export function useSettings() {
  return useResource<SettingsBundle>('settings', api.settings.get, { reloadOn: ['settings', 'safety', 'house'] });
}

export function useScheduleContext() {
  const profiles = useProfiles();
  const settings = useSettings();
  const priority = useResource('priority', api.priority.get, { reloadOn: ['house'] });
  // the smallest gap between a profile's heating and cooling targets is a cooling setting
  const strategy = useResource('strategy', api.strategy.get, { reloadOn: ['strategy'] });
  const minGapC = strategy.data?.cool.autoMinGapC ?? 2;
  const rooms = useRoomSummaries();
  const house = useHouse();
  const me = useMe();
  const ctx = useCodeContext();
  const now = useNow(60_000);
  const canEdit = me?.canEditConfig ?? false;
  const profileById = (id: Id | null | undefined) => profiles.data?.find((p) => p.id === id) ?? null;
  return { profiles, settings, priority, minGapC, rooms, house, ctx, now, canEdit, profileById };
}

export type ScheduleContext = ReturnType<typeof useScheduleContext>;
