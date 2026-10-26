/**
 * The order of the rooms (the room tabs, the overview, the phone list) and the heat or cooling a room
 * asks for right now — shared by the room page and the rooms list.
 */
import type { Id, RoomSummary } from '@api/model';
import { api } from '@api/endpoints';
import { liveStore, useMutation, useRoomSummaries } from '@data';
import { Dialog, SortableList } from '@ui';
import { errorText, fmtTemp, t } from '@i18n';

/** A room that asks for heat (heating, or waiting for its source) or for cooling; null when it does not ask. */
export function roomDemand(r: RoomSummary): { kind: 'heat' | 'cool'; label: string } | null {
  if (r.state === 'cool' || (r.state === 'wait' && r.tone === 'cool')) return { kind: 'cool', label: t('Asks for cooling') };
  if (r.state === 'heat' || r.state === 'wait') return { kind: 'heat', label: t('Asks for heat') };
  return null;
}

/** Drag the rooms (or move them with the arrow keys) into order; every move is saved at once. */
export function RoomOrderDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const rooms = useRoomSummaries();
  const save = useMutation((ids: Id[]) => api.rooms.reorder(ids), {
    onSuccess: (list) => liveStore.putRoomList(list),
    onError: () => liveStore.refetchRooms(),
  });
  const reorder = (ids: string[]) => {
    const byId = new Map(rooms.map((r) => [r.id, r] as const));
    // the tabs follow the drag at once; the server's answer confirms it
    liveStore.putRoomList(ids.flatMap((id, order) => (byId.has(id) ? [{ ...(byId.get(id) as RoomSummary), order }] : [])));
    void save.run(ids);
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('Order of the rooms')}
      size="sm"
      actions={[{ label: t('Done'), onClick: onClose }]}
      error={save.error ? errorText(save.error) : null}
    >
      <SortableList
        size="sm"
        numbered
        ariaLabel={t('Order of the rooms')}
        items={rooms.map((r) => ({ id: r.id, title: r.name, sub: fmtTemp(r.tempC) }))}
        onReorder={reorder}
      />
    </Dialog>
  );
}
