/**
 * Room page. Wide screens: room tabs, the hero (temperature, target editor, why, today's chart)
 * and every setting in two columns. Phones: the dial page, and the settings as accordions on
 * `#/rooms/<id>/settings`.
 */
import { useCallback, useMemo } from 'react';
import type { RoomDetailDto, RoomPatch } from '@api/model';
import { api } from '@api/endpoints';
import { useCodeContext, useLayout, useMe, useNow, useResource, useRoom, useRoomSummaries } from '@data';
import { EmptyState, Skeleton, Stack } from '@ui';
import { paths, useRoute } from '@app';
import { t, type CodeContext } from '@i18n';
import { PhoneControl } from './PhoneControl';
import { PhoneSettings } from './PhoneSettings';
import { RoomDesktop } from './RoomDesktop';
import type { SectionProps } from './sections';
import { useTargetEditor } from './useTargetEditor';

/** Names of this room's devices and sensors, so explanations say «Радіатор під вікном», not an id. */
function useRoomContext(base: CodeContext, room: RoomDetailDto | undefined): CodeContext {
  return useMemo(() => {
    if (!room) return base;
    const devices = new Map<string, string>();
    const entities = new Map<string, string>();
    for (const e of room.emitters) {
      for (const d of e.devices) {
        devices.set(d.id, d.name);
        if (d.haDeviceId) devices.set(d.haDeviceId, d.name);
        entities.set(d.entityId, d.name);
      }
    }
    for (const s of room.sensors) {
      entities.set(s.entityId, s.name);
      if (s.haDeviceId) devices.set(s.haDeviceId, s.name);
    }
    return {
      ...base,
      device: (k) => devices.get(k) ?? base.device?.(k),
      entity: (id) => entities.get(id) ?? base.entity?.(id),
    };
  }, [base, room]);
}

function Missing() {
  return (
    <EmptyState
      icon="home"
      title={t('This room does not exist')}
      text={t('It may have been deleted or renamed.')}
      action={{ label: t('To the overview'), to: paths.overview() }}
    />
  );
}

export default function RoomPage(): JSX.Element {
  const route = useRoute();
  const res = useRoom(route.params.id);
  const phone = useLayout() === 'phone';
  const rooms = useRoomSummaries();
  const baseCtx = useCodeContext();
  const now = useNow(30_000);
  const me = useMe();
  const profiles = useResource('names:profiles', api.profiles.list, { reloadOn: ['profile', 'profile_room'] });
  const room = res.data;
  const state = res.state;
  const ctx = useRoomContext(baseCtx, room);
  const ed = useTargetEditor(room, state, ctx);
  const roomId = room?.config.id;
  const { setData } = res;

  const save = useCallback(
    async (patch: RoomPatch) => {
      if (!roomId) return undefined;
      const next = await api.rooms.patch(roomId, patch);
      setData(next);
      return next;
    },
    [roomId, setData],
  );

  if (!room || !state) {
    if (res.error && !res.loading) return <Missing />;
    return (
      <Stack gap="lg">
        <Skeleton height={44} radius={12} />
        <Skeleton height={phone ? 320 : 420} radius={22} />
        {phone ? null : <Skeleton height={360} radius={18} />}
      </Stack>
    );
  }

  const p: SectionProps = {
    room,
    state,
    ctx,
    now,
    phone,
    canEdit: me?.canEditConfig ?? false,
    save,
    setRoom: setData,
    profiles: profiles.data,
  };
  const section = route.query.section;
  if (phone) {
    return route.name === 'roomSettings' ? <PhoneSettings p={p} section={section} /> : <PhoneControl p={p} ed={ed} profiles={profiles.data} now={now} />;
  }
  return <RoomDesktop p={p} ed={ed} rooms={rooms} profiles={profiles.data} now={now} section={route.name === 'roomSettings' ? section : undefined} />;
}
