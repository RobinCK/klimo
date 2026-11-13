/**
 * Rooms list (phone «Кімнати» tab): compact rows with the rooms that need attention on top.
 * Wide screens never stay here — the app opens the last visited room instead.
 */
import { useMemo, useState } from 'react';
import { useCodeContext, useHouse, useMe, useNow, useRoomSummaries, useRoomsLoaded } from '@data';
import { EmptyState, IconButton, MobileTopBar, RoomCard, Skeleton, Stack, Button } from '@ui';
import { InboxBell, RoomOrderDialog, paths } from '@app';
import { t } from '@i18n';
import { attentionRank, roomRow } from './rows';

export default function RoomsPage(): JSX.Element {
  const rooms = useRoomSummaries();
  const loaded = useRoomsLoaded();
  const house = useHouse();
  const ctx = useCodeContext();
  const now = useNow(30_000);
  const canEdit = useMe()?.canEditConfig ?? false;
  const sorted = useMemo(() => [...rooms].sort((a, b) => attentionRank(a) - attentionRank(b) || a.order - b.order), [rooms]);
  const attention = rooms.filter((r) => attentionRank(r) < 2).length;
  const [ordering, setOrdering] = useState(false);

  return (
    <Stack gap="md">
      <MobileTopBar
        title={t('Rooms')}
        subtitle={
          rooms.length
            ? { icon: attention ? 'alert' : 'checkCircle', text: attention ? t('{count} need attention', { count: attention }) : t('all in order') }
            : undefined
        }
        right={
          <>
            {canEdit && rooms.length > 1 ? <IconButton icon="grip" label={t('Order of the rooms')} onClick={() => setOrdering(true)} variant="ghost" size={44} /> : null}
            {canEdit ? <IconButton icon="plus" label={t('Add a room')} to={paths.wizard()} variant="ghost" size={44} /> : null}
            <InboxBell house={house} />
          </>
        }
      />
      {!loaded ? (
        <Stack gap="xs">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} height={64} radius={16} />
          ))}
        </Stack>
      ) : sorted.length ? (
        <Stack gap="xs">
          {/* a tap opens the room; its devices and heating are under its settings there */}
          {sorted.map((r) => (
            <RoomCard key={r.id} {...roomRow(r, ctx, now)} />
          ))}
          {canEdit ? (
            <Button variant="secondary" icon="plus" to={paths.wizard()} fullWidth>
              {t('Add a room')}
            </Button>
          ) : null}
        </Stack>
      ) : (
        <EmptyState
          icon="home"
          title={t('No rooms yet')}
          text={t('Add the first room: its sensors, radiators or air conditioner.')}
          action={canEdit ? { label: t('Add a room'), to: paths.wizard() } : undefined}
        />
      )}
      <RoomOrderDialog open={ordering} onClose={() => setOrdering(false)} />
    </Stack>
  );
}
