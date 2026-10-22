/**
 * «+ Розклад кімнати»: give a room its own week, starting from a copy of the house schedule or
 * from one profile for the whole day.
 */
import { useState } from 'react';
import type { Schedule } from '@api/model';
import { api } from '@api/endpoints';
import { useMutation } from '@data';
import { Dialog, RadioCardList, Select, Stack } from '@ui';
import { t } from '@i18n';
import type { ScheduleContext } from './data';

export function RoomScheduleDialog({
  c,
  schedules,
  onClose,
  onCreated,
}: {
  c: ScheduleContext;
  schedules: readonly Schedule[];
  onClose: () => void;
  onCreated: (s: Schedule) => void;
}) {
  const free = c.rooms.filter((r) => !schedules.some((s) => s.roomId === r.id));
  const [roomId, setRoomId] = useState(free[0]?.id ?? '');
  const [from, setFrom] = useState<'house' | 'empty'>('house');
  const create = useMutation(() => api.schedules.create({ roomId, copyFrom: from }), {
    onSuccess: onCreated,
    okToast: (s) => t('{room} has its own schedule now', { room: c.rooms.find((r) => r.id === s.roomId)?.name ?? '' }),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('Room schedule')}
      actions={[
        { label: t('Cancel'), onClick: onClose, variant: 'secondary' },
        { label: t('Create'), onClick: () => void create.run(), disabled: !roomId, loading: create.pending },
      ]}
    >
      <Stack gap="lg">
        <Select label={t('Room')} ariaLabel={t('Room')} value={roomId} options={free.map((r) => ({ value: r.id, label: r.name }))} onChange={setRoomId} />
        <RadioCardList
          ariaLabel={t('Start from')}
          value={from}
          onChange={setFrom}
          options={[
            { value: 'house', title: t('A copy of the house schedule'), hint: t('Then change only what differs for this room.') },
            { value: 'empty', title: t('One profile all day'), hint: t('The default profile from midnight to midnight.') },
          ]}
        />
      </Stack>
    </Dialog>
  );
}
