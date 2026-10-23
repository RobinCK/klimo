/**
 * The house schedule on the house profile tile: «За розкладом | Вручну» (manual = the house
 * schedule is paused on the profile active now) and «Повернути розклад для всього дому».
 *
 * Resuming the house is resuming everything, the same as the Home Assistant switch and button:
 * the house profile change and every room's manual or temporary change end. A room switched off
 * stays off until it is resumed on its own page, and the tile says so.
 */
import type { HouseControlMode, HouseState, RoomSummary } from '@api/model';
import { api } from '@api/endpoints';
import { liveStore, useMutation } from '@data';
import { Button, closeToast, Row, SegmentedControl, Stack, Text, toast, undoToast } from '@ui';
import { t, type CodeContext } from '@i18n';
import { newReqId } from './reqId';

export interface HouseControlView {
  mode: HouseControlMode;
  /** Rooms with their own manual or temporary change (they follow the schedule after a resume). */
  ownRooms: RoomSummary[];
  /** Rooms switched off (they stay off after a resume). */
  offRooms: RoomSummary[];
  /** Something does not follow the schedule: the house profile was changed, or a room's own. */
  resumable: boolean;
  set: (mode: HouseControlMode) => void;
  pending: boolean;
}

/** The last confirmation shown: a newer change closes it, so an older «Undo» cannot be pressed. */
let lastToast: string | null = null;

const refreshHouse = () =>
  api.house
    .state()
    .then((h) => liveStore.putHouse(h))
    .catch(() => undefined);

export function useHouseControl(house: HouseState, rooms: readonly RoomSummary[], ctx: CodeContext): HouseControlView {
  const mode = house.control.mode;
  const ownRooms = rooms.filter((r) => r.control.mode === 'manual' || r.control.mode === 'temporary');
  const offRooms = rooms.filter((r) => r.control.mode === 'off');
  const names = (ids: readonly string[]) => ids.map((id) => ctx.room?.(id) ?? id).join(', ');
  const m = useMutation((next: HouseControlMode, _undoable: boolean) => api.house.setControl({ mode: next, reqId: newReqId() }), {
    onSuccess: (res, next, undoable) => {
      void refreshHouse();
      // the rooms' own changes ended too: their cards follow without waiting for the next push
      liveStore.refetchRooms();
      if (lastToast) closeToast(lastToast);
      const profile = ctx.profile?.(res.profile.activeProfileId) ?? res.profile.activeProfileId;
      if (next === 'manual') {
        const message = t('The house schedule is paused on «{profile}».', { profile });
        // a pause on top of a plain schedule is undone by clearing the house change alone
        lastToast = undoable
          ? undoToast({ message, seconds: 8, onUndo: () => void api.house.clearProfile().then(refreshHouse, () => undefined) })
          : toast({ tone: 'ok', message });
        return;
      }
      // a resume cannot bring the rooms' changes back: no undo
      const back = t('The whole house follows the schedule again.');
      lastToast = toast({ tone: 'ok', message: res.offRoomIds.length ? `${back} ${t('Still off: {rooms}.', { rooms: names(res.offRoomIds) })}` : back });
    },
  });
  return {
    mode,
    ownRooms,
    offRooms,
    resumable: mode === 'manual' || house.profile.layer === 'house_manual' || ownRooms.length > 0,
    set: (next) => {
      // «За розкладом» while already on it still resumes the rooms and a timed house change
      if (m.pending || (next === 'manual' && mode === 'manual')) return;
      void m.run(next, next === 'manual' && house.profile.layer !== 'house_manual');
    },
    pending: m.pending,
  };
}

/** What «Повернути розклад» leaves alone («Вимкнені кімнати лишаються вимкненими: Спальня»). */
function offNote(hc: HouseControlView): string | null {
  if (!hc.offRooms.length) return null;
  return t('Rooms switched off stay off: {rooms}.', { rooms: hc.offRooms.map((r) => r.name).join(', ') });
}

/** The toggle and the resume button; `full`: the toggle takes the whole width. */
export function HouseControlBlock({ hc, full }: { hc: HouseControlView; full?: boolean }) {
  const note = offNote(hc);
  return (
    <Stack gap="xs">
      <SegmentedControl<HouseControlMode>
        value={hc.mode}
        options={[
          { value: 'schedule', label: t('By schedule') },
          { value: 'manual', label: t('Manual') },
        ]}
        onChange={hc.set}
        size="xs"
        full={full}
        ariaLabel={t('House schedule')}
      />
      {hc.mode === 'manual' ? (
        <Text variant="caption">{t('«By schedule» resumes the whole house, the rooms’ own changes too.')}</Text>
      ) : hc.resumable ? (
        <Row>
          <Button variant="link" size="sm" icon="undo" onClick={() => hc.set('schedule')} loading={hc.pending}>
            {t('Resume schedule for the whole house')}
          </Button>
        </Row>
      ) : null}
      {hc.resumable && note ? <Text variant="caption">{note}</Text> : null}
    </Stack>
  );
}
