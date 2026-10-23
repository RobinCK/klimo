/**
 * The circuit card's changes that need a word first: a room put on the loop, a zone valve given to
 * a room, a room taken off, a zone valve removed, and two loops merged into one (a house set up by
 * 0.1 may have a circuit per room). Each says what will happen before it happens.
 */
import { useState } from 'react';
import type { CircuitDto, Id } from '@api/model';
import { api } from '@api/endpoints';
import { useEntitySearch, useMutation } from '@data';
import { brand } from '@brand';
import { CheckboxRow, ConfirmDialog, Dialog, EntityPicker, RadioCardList, Select, Stack, StatusBanner, Text } from '@ui';
import { releaseWords, t } from '@i18n';
import type { SystemData } from './shared';
import { changeErrorText } from './circuitTexts';

type Member = CircuitDto['members'][number];

/** «Додати кімнату»: any room not on this loop; one on another loop of the kind moves over. */
export function AddRoomDialog({ d, dto, onClose }: { d: SystemData; dto: CircuitDto; onClose: () => void }) {
  const c = dto.config;
  const zoned = c.kind === 'floor' && c.mode === 'zoned';
  const others = (d.circuits.data ?? []).filter((x) => x.config.id !== c.id && x.config.kind === c.kind);
  const onThis = new Set(dto.memberRoomIds);
  const candidates = d.rooms.filter((r) => !onThis.has(r.id));
  const [roomId, setRoomId] = useState<Id>(candidates[0]?.id ?? '');
  const [zone, setZone] = useState<string | null>(null);
  const search = useEntitySearch(null, { roomId: roomId || undefined, wizard: 'floor_zone' });
  const join = useMutation(() => api.circuits.addRoom(c.id, { roomId, zoneEntityId: zoned ? zone : null }), {
    onSuccess: () => {
      void d.circuits.reload();
      onClose();
    },
    okToast: () => t('«{room}» is on «{circuit}» now', { room: d.roomName(roomId) ?? roomId, circuit: c.name }),
    errorToast: false,
  });
  const from = others.find((x) => x.memberRoomIds.includes(roomId));
  const product = brand.productName;
  const what =
    c.kind === 'floor'
      ? t('The room gets underfloor heating from this loop: when it is colder than its target, it asks the source for heat.')
      : t('Radiators of the room join this loop: smart heads stay as they are; without heads the room switches the source and this pump by its temperature, like a room thermostat.');
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('Add a room to «{circuit}»', { circuit: c.name })}
      error={changeErrorText(join.error)}
      actions={[
        { label: t('Cancel'), onClick: onClose },
        { label: t('Add the room'), onClick: () => void join.run(), disabled: !roomId, loading: join.pending },
      ]}
    >
      <Stack gap="md">
        {candidates.length ? (
          <Select<Id>
            label={t('Room')}
            ariaLabel={t('Room')}
            value={roomId}
            options={candidates.map((r) => {
              const on = others.find((x) => x.memberRoomIds.includes(r.id));
              return { value: r.id, label: on ? t('{room} — now on «{circuit}»', { room: r.name, circuit: on.config.name }) : r.name };
            })}
            onChange={(id) => {
              setRoomId(id);
              setZone(null);
            }}
          />
        ) : (
          <StatusBanner tone="event" icon="info" text={t('Every room is on this circuit already.')} />
        )}
        <Text variant="body">{what}</Text>
        {from ? <Text>{t('It leaves «{circuit}»: one room is on one loop of a kind.', { circuit: from.config.name })}</Text> : null}
        {zoned && roomId ? (
          <Stack gap="xs">
            <EntityPicker
              ariaLabel={t('Zone valve')}
              placeholder={t('Zone valve or floor thermostat of the room (optional)')}
              clearable
              value={zone}
              search={search}
              onChange={(id) => setZone(id)}
            />
            <Text variant="caption">
              {t('{product} opens it while the room asks for heat and closes it when the room is warm. Without one the room still asks; its floor gets water whenever the pump runs.', { product })}
            </Text>
          </Stack>
        ) : null}
      </Stack>
    </Dialog>
  );
}

/** «+ Клапан зони» of a room on a zoned floor. */
export function ZoneDialog({ d, dto, member, onClose }: { d: SystemData; dto: CircuitDto; member: Member; onClose: () => void }) {
  const room = d.roomName(member.roomId) ?? member.roomId;
  const [zone, setZone] = useState<string | null>(null);
  const search = useEntitySearch(null, { roomId: member.roomId, wizard: 'floor_zone' });
  const add = useMutation(() => api.rooms.bindings.add(member.roomId, { role: 'floor_zone', entityId: zone as string }), {
    onSuccess: () => {
      void d.circuits.reload();
      onClose();
    },
    okToast: t('Zone valve added'),
    errorToast: false,
  });
  return (
    <Dialog
      open
      size="sm"
      onClose={onClose}
      title={t('Zone valve for «{room}»', { room })}
      error={changeErrorText(add.error)}
      actions={[
        { label: t('Cancel'), onClick: onClose },
        { label: t('Add'), onClick: () => void add.run(), disabled: !zone, loading: add.pending },
      ]}
    >
      <Stack gap="sm">
        <EntityPicker ariaLabel={t('Zone valve')} placeholder={t('Valve, relay or floor thermostat…')} value={zone} search={search} onChange={(id) => setZone(id)} autoFocus />
        <Text>
          {t('{product} opens it while «{room}» asks for heat and closes it when the room is warm; the pump of «{circuit}» runs while any zone is open.', {
            product: brand.productName,
            room,
            circuit: dto.config.name,
          })}
        </Text>
      </Stack>
    </Dialog>
  );
}

/** Taking a room off the loop: what happens to its heads, its zone and its demand. */
export function RemoveRoomDialog({ d, dto, member, onClose }: { d: SystemData; dto: CircuitDto; member: Member; onClose: () => void }) {
  const room = d.roomName(member.roomId) ?? member.roomId;
  const leave = useMutation(() => api.circuits.removeRoom(dto.config.id, member.roomId), {
    onSuccess: () => {
      void d.circuits.reload();
      onClose();
    },
    okToast: t('«{room}» is off «{circuit}»', { room, circuit: dto.config.name }),
    errorToast: false,
  });
  const lines: string[] = [];
  if (member.kind === 'trv') lines.push(t('Its smart heads get their own setpoints back and regulate by themselves.'));
  else if (member.kind === 'radiator_plain') lines.push(t('The room no longer starts the source and this pump.'));
  else lines.push(t('Its floor is no longer heated from here, and the pump no longer runs for it.'));
  for (const z of member.zones) lines.push(`${z.name}: ${releaseWords({ release: dto.config.capabilities.cool ? 'zone_close' : 'zone_open', role: 'floor_zone' }, 0)}`);
  lines.push(t('The room keeps its sensors and any other heating.'));
  const error = changeErrorText(leave.error);
  return (
    <ConfirmDialog
      open
      title={t('Take «{room}» off «{circuit}»?', { room, circuit: dto.config.name })}
      body={error ? <StatusBanner tone="err" icon="alert" text={error} /> : undefined}
      consequences={lines}
      confirm={{ label: t('Take off'), tone: 'danger', onClick: () => void leave.run(), loading: leave.pending }}
      onCancel={onClose}
    />
  );
}

/** Removing a room's zone valve: the valve is left as the loop needs it, the room keeps asking. */
export function RemoveZoneDialog({ d, dto, member, zone, onClose }: { d: SystemData; dto: CircuitDto; member: Member; zone: Member['zones'][number]; onClose: () => void }) {
  const room = d.roomName(member.roomId) ?? member.roomId;
  const remove = useMutation(() => api.rooms.bindings.remove(member.roomId, `device:${zone.deviceId}`), {
    onSuccess: () => {
      void d.circuits.reload();
      onClose();
    },
    okToast: t('Zone valve removed'),
    errorToast: false,
  });
  const error = changeErrorText(remove.error);
  return (
    <ConfirmDialog
      open
      title={t('Remove the zone valve «{name}» of «{room}»?', { name: zone.name, room })}
      body={error ? <StatusBanner tone="err" icon="alert" text={error} /> : undefined}
      consequences={[
        releaseWords({ release: dto.config.capabilities.cool ? 'zone_close' : 'zone_open', role: 'floor_zone' }, 0),
        t('The room still asks for heat; without a valve its floor gets water whenever the pump runs.'),
      ]}
      confirm={{ label: t('Remove'), tone: 'danger', onClick: () => void remove.run(), loading: remove.pending }}
      onCancel={onClose}
    />
  );
}

/** «Об’єднати»: the rooms (and pumps) of this loop move to another loop of the kind; this one goes. */
export function MergeDialog({ d, dto, onClose }: { d: SystemData; dto: CircuitDto; onClose: () => void }) {
  const c = dto.config;
  const targets = (d.circuits.data ?? []).filter((x) => x.config.id !== c.id && x.config.kind === c.kind);
  const [intoId, setIntoId] = useState<Id>(targets[0]?.config.id ?? '');
  const [dropPumps, setDropPumps] = useState(false);
  const into = targets.find((x) => x.config.id === intoId);
  const merge = useMutation(() => api.circuits.merge(c.id, { intoId, dropPumps }), {
    onSuccess: () => {
      void d.circuits.reload();
      onClose();
    },
    okToast: () => t('«{from}» is merged into «{into}»', { from: c.name, into: into?.config.name ?? '' }),
    errorToast: false,
  });
  const rooms = [...new Set(dto.memberRoomIds.map((id) => d.roomName(id) ?? id))];
  const pumps = dto.pumps.map((p) => p.entityId);
  const newSources = c.sourceIds.filter((id) => !into?.config.sourceIds.includes(id)).map(d.nameOf);
  const into1 = into?.config.name ?? '';
  const lines = [
    rooms.length ? t('These rooms move to «{into}»: {rooms}.', { into: into1, rooms: rooms.join(', ') }) : t('It has no rooms to move.'),
    ...(pumps.length
      ? [dropPumps ? t('Its pumps are removed and switched off: {pumps}.', { pumps: pumps.join(', ') }) : t('Its pumps move along: {pumps}.', { pumps: pumps.join(', ') })]
      : []),
    ...(newSources.length ? [t('«{into}» is also fed by: {sources}.', { into: into1, sources: newSources.join(', ') })] : []),
    t('«{from}» is deleted.', { from: c.name }),
  ];
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('Merge «{from}» into another circuit', { from: c.name })}
      error={changeErrorText(merge.error)}
      actions={[
        { label: t('Cancel'), onClick: onClose },
        { label: t('Merge'), onClick: () => void merge.run(), disabled: !into, loading: merge.pending },
      ]}
    >
      <Stack gap="md">
        <Text variant="body">{t('For one pipe loop that was set up as several circuits, e.g. a floor circuit per room. The rooms keep their settings and sensors.')}</Text>
        <RadioCardList<Id>
          ariaLabel={t('Merge into')}
          value={intoId}
          onChange={setIntoId}
          options={targets.map((x) => {
            const names = x.memberRoomIds.map((id) => d.roomName(id) ?? id);
            return {
              value: x.config.id,
              title: x.config.name,
              hint: [
                x.pumps.length ? t('pump: {pumps}', { pumps: x.pumps.map((p) => p.entityId).join(', ') }) : t('no pump of its own'),
                names.length ? t('rooms: {rooms}', { rooms: names.join(', ') }) : t('no rooms yet'),
              ].join(' · '),
            };
          })}
        />
        {pumps.length && into?.pumps.length ? (
          <CheckboxRow
            checked={dropPumps}
            title={t('{pumps} is the same pump as «{into}» has', { pumps: pumps.join(', '), into: into1 })}
            hint={t('Then it is removed instead of moved, so one physical pump is not switched twice.')}
            onChange={setDropPumps}
          />
        ) : null}
        <Stack gap="xs">
          {lines.map((l) => (
            <Text key={l}>{l}</Text>
          ))}
        </Stack>
      </Stack>
    </Dialog>
  );
}
