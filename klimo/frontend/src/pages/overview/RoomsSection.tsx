import { useMemo } from 'react';
import type { EpochMs, Id, RoomSummary, SparkDto } from '@api/model';
import { AutoGrid, Button, EmptyState, FilterPills, Link, RoomCard, Section, Stack } from '@ui';
import { paths, usePref } from '@app';
import { t, type CodeContext } from '@i18n';
import { attentionRank, needsAttention, roomCard, roomRow } from './summary';

type Filter = 'all' | 'active' | 'attention';

/** «Кімнати»: filter by what the rooms do, a card per room, and the way to add one. */
export function RoomsSection({
  rooms,
  sparks,
  cooling,
  ctx,
  now,
  canEdit,
}: {
  rooms: readonly RoomSummary[];
  sparks: Readonly<Record<Id, SparkDto>> | undefined;
  cooling: boolean;
  ctx: CodeContext;
  now: EpochMs;
  canEdit: boolean;
}) {
  const [filter, setFilter] = usePref<Filter>('overview.filter', 'all');
  const active = rooms.filter((r) => r.state === 'heat' || r.state === 'cool');
  const attention = rooms.filter(needsAttention);
  const shown = filter === 'active' ? active : filter === 'attention' ? attention : rooms;
  const options = [
    { value: 'all' as const, label: t('All'), count: rooms.length },
    { value: 'active' as const, label: cooling ? t('Cooling now') : t('Heating now'), count: active.length },
    { value: 'attention' as const, label: t('Attention'), count: attention.length },
  ];
  return (
    <Section
      id="rooms"
      variant="plain"
      title={t('Rooms')}
      subtitle={rooms.length ? t('A card only shows the state. The target changes inside the room — so a stray tap switches nothing.') : undefined}
      action={
        <>
          {rooms.length ? <FilterPills value={filter} options={options} onChange={setFilter} ariaLabel={t('Show rooms')} /> : null}
          {canEdit ? (
            <Button variant="secondary" icon="plus" to={paths.wizard()}>
              {t('Add a room')}
            </Button>
          ) : null}
        </>
      }
    >
      {!rooms.length ? (
        <EmptyState
          icon="home"
          title={t('No rooms yet')}
          text={t('Add the first room: its sensors, radiators or air conditioner.')}
          action={canEdit ? { label: t('Add a room'), to: paths.wizard() } : undefined}
        />
      ) : shown.length ? (
        <AutoGrid min={280} gap="md">
          {shown.map((r) => (
            <RoomCard key={r.id} {...roomCard(r, ctx, now, sparks?.[r.id])} />
          ))}
        </AutoGrid>
      ) : (
        <EmptyState
          icon={filter === 'attention' ? 'checkCircle' : 'pause'}
          tone={filter === 'attention' ? 'ok' : 'neutral'}
          title={filter === 'attention' ? t('No room needs attention') : cooling ? t('No room is cooling right now') : t('No room is heating right now')}
        />
      )}
    </Section>
  );
}

/** Phone: compact rows, problems first, with «+ Додати». */
export function RoomsList({ rooms, ctx, now, canEdit }: { rooms: readonly RoomSummary[]; ctx: CodeContext; now: EpochMs; canEdit: boolean }) {
  const sorted = useMemo(() => [...rooms].sort((a, b) => attentionRank(a) - attentionRank(b) || a.order - b.order), [rooms]);
  return (
    <Section
      variant="plain"
      title={t('Rooms')}
      action={
        canEdit ? (
          <Link to={paths.wizard()} variant="inline">
            {t('+ Add')}
          </Link>
        ) : undefined
      }
    >
      {sorted.length ? (
        <Stack gap="xs">
          {sorted.map((r) => (
            <RoomCard key={r.id} {...roomRow(r, ctx, now)} />
          ))}
        </Stack>
      ) : (
        <EmptyState icon="home" title={t('No rooms yet')} action={canEdit ? { label: t('Add a room'), to: paths.wizard() } : undefined} />
      )}
    </Section>
  );
}
