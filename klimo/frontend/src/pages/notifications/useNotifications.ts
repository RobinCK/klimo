/**
 * The notification configuration as one shared resource: channels, targets, the routing matrix,
 * delivery rules and alert thresholds. Every write returns the whole configuration, which
 * replaces the cached copy, so the page never shows a half-applied change.
 */
import { useCallback } from 'react';
import type { EventKind, EventParams, Id, NotificationsDto, NotifySettings, NotifyTargetCreateRequest, NotifyTargetPatch } from '@api/model';
import { api } from '@api/endpoints';
import { useMutation, useResource, type ResourceState } from '@data';
import { t } from '@i18n';

export type SettingsPatch = { [K in keyof Omit<NotifySettings, 'updatedAt'>]?: Partial<NotifySettings[K]> | NotifySettings[K] };

export interface NotificationsModel {
  res: ResourceState<NotificationsDto>;
  data: NotificationsDto | undefined;
  /** Deep-merges a settings patch locally at once, then saves it. */
  patchSettings: (p: SettingsPatch) => Promise<void>;
  setRoute: (kind: EventKind, targetId: Id, on: boolean) => Promise<void>;
  addTarget: (body: NotifyTargetCreateRequest) => Promise<NotificationsDto | undefined>;
  patchTarget: (id: Id, p: NotifyTargetPatch) => Promise<NotificationsDto | undefined>;
  removeTarget: (id: Id) => Promise<NotificationsDto | undefined>;
  patchEvent: (kind: EventKind, p: Partial<EventParams>) => Promise<NotificationsDto | undefined>;
  pending: boolean;
}

const RELOAD_ON = ['notify_settings', 'notify_target', 'routing', 'event_params', 'personal_prefs'] as const;

function mergeSettings(s: NotifySettings, p: SettingsPatch): NotifySettings {
  const out = { ...s } as Record<string, unknown>;
  for (const [k, v] of Object.entries(p)) {
    const cur = out[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' ? { ...(cur as object), ...v } : v;
  }
  return out as unknown as NotifySettings;
}

export function useNotifications(): NotificationsModel {
  const res = useResource('notifications', api.notifications.get, { reloadOn: RELOAD_ON });
  const { setData, reload } = res;
  const apply = useCallback((dto: NotificationsDto | undefined) => dto && setData(dto), [setData]);
  // optimistic edits change the cached copy only once it exists
  const update = useCallback(
    (fn: (d: NotificationsDto) => NotificationsDto) => setData((prev) => (prev ? fn(prev) : (prev as unknown as NotificationsDto))),
    [setData],
  );

  // a refused write puts the server's copy back on screen
  const settings = useMutation((p: SettingsPatch) => api.notifications.patchSettings(p as Parameters<typeof api.notifications.patchSettings>[0]), {
    onSuccess: apply,
    onError: () => void reload(),
  });
  const route = useMutation((kind: EventKind, targetId: Id, on: boolean) => api.notifications.setRoute(kind, targetId, on), {
    onSuccess: apply,
    onError: () => void reload(),
  });
  const add = useMutation((body: NotifyTargetCreateRequest) => api.notifications.addTarget(body), { onSuccess: apply, okToast: t('Added') });
  const patch = useMutation((id: Id, p: NotifyTargetPatch) => api.notifications.patchTarget(id, p), { onSuccess: apply, onError: () => void reload() });
  const remove = useMutation((id: Id) => api.notifications.removeTarget(id), { onSuccess: apply, okToast: t('Removed') });
  const event = useMutation((kind: EventKind, p: Partial<EventParams>) => api.notifications.patchEvent(kind, p), { onSuccess: apply });

  const runSettings = settings.run;
  const runRoute = route.run;
  const patchSettings = useCallback(
    async (p: SettingsPatch) => {
      update((d) => ({ ...d, settings: mergeSettings(d.settings, p) }));
      await runSettings(p);
    },
    [update, runSettings],
  );

  const setRoute = useCallback(
    async (kind: EventKind, targetId: Id, on: boolean) => {
      update((d) => ({ ...d, routing: d.routing.map((c) => (c.kind === kind && c.targetId === targetId ? { ...c, on } : c)) }));
      await runRoute(kind, targetId, on);
    },
    [update, runRoute],
  );

  return {
    res,
    data: res.data,
    patchSettings,
    setRoute,
    addTarget: add.run,
    patchTarget: patch.run,
    removeTarget: remove.run,
    patchEvent: event.run,
    pending: add.pending || patch.pending || remove.pending || event.pending,
  };
}
