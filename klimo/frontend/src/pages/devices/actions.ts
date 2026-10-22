/**
 * What the buttons of a device problem do. A problem that has an incident behind it is handled
 * through the incident (so Overview, the inbox and every channel agree on «сховано»); excluding a
 * sensor without one goes straight to the room's sensor list.
 */
import { useCallback, useState } from 'react';
import type { DeviceHealth, DeviceHealthSettings, DeviceProblem, IncidentAction } from '@api/model';
import { api } from '@api/endpoints';
import { toast, type Action } from '@ui';
import { errorText, t } from '@i18n';

type ProblemAction = DeviceProblem['actions'][number];

const DAY_MIN = 24 * 60;

export function actionLabel(a: ProblemAction): string {
  switch (a) {
    case 'resend':
      return t('Retry now');
    case 'open_z2m':
      return t('Open in Zigbee2MQTT');
    case 'exclude_from_room':
      return t('Exclude from the calculation');
    case 'include_in_room':
      return t('Count it again');
    case 'snooze':
      return t('Remind me later');
    case 'dismiss':
      return t('Hide');
    case 'replace':
      return t('Replace the device');
  }
}

/** Opens an address outside the panel (the Zigbee2MQTT frontend) without leaving it. */
export function openExternal(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer');
}

async function setSensorIncluded(d: DeviceHealth, included: boolean): Promise<void> {
  if (!d.roomId) throw new Error(t('The sensor is not in a room.'));
  const room = await api.rooms.get(d.roomId);
  const sensors = room.sensors.filter((s) => d.entityIds.includes(s.entityId) && s.included !== included);
  if (!sensors.length) return;
  for (const s of sensors) await api.rooms.sensors.patch(d.roomId, s.id, { included });
}

async function incidentAction(p: DeviceProblem, action: IncidentAction, minutes?: number): Promise<void> {
  if (!p.incidentId) throw new Error(t('Nothing to hide yet — the problem has not been raised.'));
  await api.incidents.action(p.incidentId, minutes ? { action, minutes } : { action });
}

export interface ProblemActions {
  /** The two buttons of a card: the fix first, then the quieter one. */
  buttons: (d: DeviceHealth, p: DeviceProblem) => { primary: Action; secondary?: Action };
  busy: string | null;
}

/**
 * Builds the card buttons; `onDone` reloads the list, `onReplace` opens the device drawer where
 * the replacement is picked.
 */
export function useProblemActions(opts: { health: DeviceHealthSettings | undefined; onDone: () => void; onReplace: (d: DeviceHealth) => void; canEdit: boolean }): ProblemActions {
  const [busy, setBusy] = useState<string | null>(null);
  const { onDone, onReplace, health, canEdit } = opts;

  const run = useCallback(
    async (key: string, fn: () => Promise<void>, okText: string) => {
      setBusy(key);
      try {
        await fn();
        toast({ tone: 'ok', message: okText });
        onDone();
      } catch (e) {
        toast({ tone: 'err', message: errorText(e) || (e instanceof Error ? e.message : t('Did not go through')) });
      } finally {
        setBusy(null);
      }
    },
    [onDone],
  );

  const buttons = useCallback(
    (d: DeviceHealth, p: DeviceProblem) => {
      const key = (a: ProblemAction) => `${d.key}:${p.type}:${a}`;
      const usable = p.actions.filter((a) => {
        if (a === 'open_z2m') return Boolean(d.z2mUrl);
        if (a === 'snooze' || a === 'dismiss') return Boolean(p.incidentId);
        if (a === 'exclude_from_room' || a === 'include_in_room') return Boolean(p.incidentId || (d.roomId && canEdit));
        if (a === 'replace') return canEdit;
        return true;
      });
      const toAction = (a: ProblemAction): Action => {
        const k = key(a);
        const loading = busy === k;
        switch (a) {
          case 'resend':
            return { label: actionLabel(a), loading, onClick: () => void run(k, () => api.devices.resend(d.key), t('Sending again…')) };
          case 'open_z2m':
            return { label: actionLabel(a), onClick: () => d.z2mUrl && openExternal(d.z2mUrl) };
          case 'exclude_from_room':
            return {
              label: actionLabel(a),
              loading,
              onClick: () =>
                void run(k, () => (p.incidentId ? incidentAction(p, 'exclude_sensor') : setSensorIncluded(d, false)), t('Excluded from the calculation')),
            };
          case 'include_in_room':
            return {
              label: actionLabel(a),
              loading,
              onClick: () => void run(k, () => (p.incidentId ? incidentAction(p, 'include_sensor') : setSensorIncluded(d, true)), t('Counted again')),
            };
          case 'snooze':
            return { label: actionLabel(a), loading, onClick: () => void run(k, () => incidentAction(p, 'snooze', DAY_MIN), t('I will remind you tomorrow')) };
          case 'dismiss': {
            const until = p.type === 'battery_low' && health ? t('Hidden until the battery drops to {pct}%', { pct: health.batteryLow.reminderPct }) : t('Hidden until it happens again');
            return { label: actionLabel(a), loading, onClick: () => void run(k, () => incidentAction(p, 'dismiss'), until) };
          }
          case 'replace':
            return { label: actionLabel(a), onClick: () => onReplace(d) };
        }
      };
      const [first, second] = usable;
      // a problem the backend offers no fix for still leads somewhere useful: the device itself
      const primary = first ? toAction(first) : { label: t('Details'), onClick: () => onReplace(d) };
      return { primary, secondary: second ? toAction(second) : undefined };
    },
    [busy, run, health, onReplace, canEdit],
  );

  return { buttons, busy };
}
