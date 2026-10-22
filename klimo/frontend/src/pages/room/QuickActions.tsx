import type { RoomDetailDto, RoomState } from '@api/model';
import { api } from '@api/endpoints';
import { liveStore, useMutation } from '@data';
import { QuickActionPill, Row } from '@ui';
import { fmtDelta, fmtDur, t } from '@i18n';

type Action = 'boost' | 'cancelBoost' | 'airing' | 'cancelAiring' | 'ignoreWindow' | 'cancelIgnore' | 'resume' | 'on';

/**
 * One-tap changes next to the target: a short boost, airing, ignoring an open window, back to
 * the schedule. Hidden while a target change is pending or can still be undone.
 */
export function QuickActions({ room, state }: { room: RoomDetailDto; state: RoomState }) {
  const id = room.config.id;
  const run = useMutation(
    (a: Action) => {
      switch (a) {
        case 'boost':
          return api.rooms.boost(id);
        case 'cancelBoost':
          return api.rooms.cancelBoost(id);
        case 'airing':
          return api.rooms.airing(id);
        case 'cancelAiring':
          return api.rooms.cancelAiring(id);
        case 'ignoreWindow':
          return api.rooms.ignoreWindow(id, { minutes: 30 });
        case 'cancelIgnore':
          return api.rooms.cancelIgnoreWindow(id);
        case 'resume':
          return api.rooms.resume(id);
        case 'on':
          return api.rooms.on(id);
      }
    },
    { onSuccess: (s) => liveStore.putRoomState(s) },
  );
  const th = room.thermostat;
  if (th.locked) return null;
  const tg = state.target;
  const quick = th.quick;
  const cool = tg.mode === 'cool' || (state.activeModes.cool && !state.activeModes.heat);
  const pills: { key: Action; icon: Parameters<typeof QuickActionPill>[0]['icon']; label: string }[] = [];

  if (tg.layer === 'room_off') pills.push({ key: 'on', icon: 'power', label: t('Switch the room on') });
  if (state.window.reactionActive && state.window.ignoredUntil == null) pills.push({ key: 'ignoreWindow', icon: 'windowOpen', label: t('Ignore for 30 min') });
  if (state.window.ignoredUntil != null) pills.push({ key: 'cancelIgnore', icon: 'windowOpen', label: t('Stop ignoring the window') });
  if (tg.display === 'boost') pills.push({ key: 'cancelBoost', icon: 'close', label: t('Stop the boost') });
  else if (tg.display === 'manual' || tg.display === 'range' || tg.display === 'room_profile')
    pills.push({ key: 'resume', icon: 'undo', label: t('Back to schedule') });
  else if (tg.layer !== 'room_off' && tg.display !== 'airing' && tg.display !== 'window' && tg.display !== 'off' && tg.mode !== 'none' && tg.mode !== 'dual') {
    const delta = cool ? -quick.boostDeltaC : quick.boostDeltaC;
    pills.push({ key: 'boost', icon: 'bolt', label: t('{delta} for {dur}', { delta: fmtDelta(delta, { sign: true }), dur: fmtDur(quick.boostMin) }) });
  }
  if (tg.display === 'airing') pills.push({ key: 'cancelAiring', icon: 'play', label: t('Resume now') });
  else if (tg.layer !== 'room_off' && tg.display !== 'off')
    pills.push({ key: 'airing', icon: 'airing', label: t('Air for {dur}', { dur: fmtDur(quick.airingMin) }) });

  if (!pills.length) return null;
  return (
    <Row gap="sm" wrap>
      {pills.map((p) => (
        <QuickActionPill key={p.key} icon={p.icon} label={p.label} onClick={() => void run.run(p.key)} disabled={run.pending} />
      ))}
    </Row>
  );
}
