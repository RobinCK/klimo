import { useMemo } from 'react';
import type { EpochMs, Id, RoomSummary, SparkDto } from '@api/model';
import { AutoGrid, Button, EmptyState, FilterPills, Link, RoomCard, Section, Skeleton, Stack, Text } from '@ui';
import { paths, usePref } from '@app';
import { t, type CodeContext } from '@i18n';
import { attentionRank, needsAttention, roomCard, roomRow } from './summary';

type Filter = 'all' | 'active' | 'attention' | 'manual';

/** «Кімнати»: filter by what the rooms do, a card per room, and the way to add one. */
export function RoomsSection({
  rooms,
  loaded,
  sparks,
  cooling,
  ctx,
  now,
  canEdit,
}: {
  rooms: readonly RoomSummary[];
  /** The room list has arrived (an empty list before that is not «no rooms»). */
  loaded: boolean;
  sparks: Readonly<Record<Id, SparkDto>> | undefined;
  cooling: boolean;
  ctx: CodeContext;
  now: EpochMs;
  canEdit: boolean;
}) {
  const [filter, setFilter] = usePref<Filter>('overview.filter', 'all');
  const active = rooms.filter((r) => r.state === 'heat' || r.state === 'cool');
  const attention = rooms.filter(needsAttention);
  // set by hand: manual control, a temporary change or switched off
  const manual = rooms.filter((r) => r.control.mode !== 'schedule');
  const shown = filter === 'active' ? active : filter === 'attention' ? attention : filter === 'manual' ? manual : rooms;
  const options = [
    { value: 'all' as const, label: t('All'), count: rooms.length },
    { value: 'active' as const, label: cooling ? t('Cooling now') : t('Heating now'), count: active.length },
    { value: 'attention' as const, label: t('Attention'), count: attention.length },
    // only while some room is set by hand: an always-empty filter is noise
    ...(manual.length || filter === 'manual' ? [{ value: 'manual' as const, label: t('Manual'), count: manual.length }] : []),
  ];
  return (
    <Section
      id="rooms"
      variant="plain"
      title={t('Rooms')}
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
      {!loaded && !rooms.length ? (
        <AutoGrid min={280} gap="md">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} height={220} radius={16} />
          ))}
        </AutoGrid>
      ) : !rooms.length ? (
        <EmptyState
          icon="home"
          title={t('No rooms yet')}
          text={t('Add the first room: its sensors, radiators or air conditioner.')}
          action={canEdit ? { label: t('Add a room'), to: paths.wizard() } : undefined}
        />
      ) : shown.length ? (
        <>
          <AutoGrid min={280} gap="md">
            {shown.map((r) => (
              <RoomCard key={r.id} {...roomCard(r, ctx, now, sparks?.[r.id])} />
            ))}
          </AutoGrid>
          <Text>{t('A card only shows the state. The target changes inside the room — so a stray tap switches nothing.')}</Text>
        </>
      ) : (
        <EmptyState
          icon={filter === 'attention' ? 'checkCircle' : filter === 'manual' ? 'clock' : 'pause'}
          tone={filter === 'attention' || filter === 'manual' ? 'ok' : 'neutral'}
          title={
            filter === 'attention'
              ? t('No room needs attention')
              : filter === 'manual'
                ? t('Every room follows the schedule')
                : cooling
                  ? t('No room is cooling right now')
                  : t('No room is heating right now')
          }
        />
      )}
    </Section>
  );
}

/** Phone: compact rows, problems first, with «+ Додати». */
export function RoomsList({
  rooms,
  loaded,
  ctx,
  now,
  canEdit,
}: {
  rooms: readonly RoomSummary[];
  loaded: boolean;
  ctx: CodeContext;
  now: EpochMs;
  canEdit: boolean;
}) {
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
      {!loaded && !sorted.length ? (
        <Stack gap="xs">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} height={64} radius={16} />
          ))}
        </Stack>
      ) : sorted.length ? (
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
