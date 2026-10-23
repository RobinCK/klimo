import { useEffect, useState } from 'react';
import type { HaEntityDto, RoomBinding, WizardDeviceRole } from '@api/model';
import { api } from '@api/endpoints';
import { useEntitySearch } from '@data';
import { AddDeviceDialog, AutoGrid, Button, ConfirmDialog, DeviceRow, EntityFinder, Section, Stack, StatusBanner, Text, type DeviceRowAction } from '@ui';
import { brand } from '@brand';
import {
  DEVICE_GROUP_ORDER,
  DEVICE_ROLE_ICON,
  deviceGroupOf,
  deviceGroupSearchRoles,
  deviceGroupWords,
  deviceRoleLabel,
  entityValueText,
  fmtPct,
  fmtTemp,
  releaseWords,
  roleInGroup,
  sourceBlockText,
  t,
  type DeviceGroup,
} from '@i18n';
import type { SectionProps } from '../sections/types';
import type { EditState, PendingKind, useRoomWrite } from './shared';

type Write = ReturnType<typeof useRoomWrite>;

/** The heating kind a device block belongs to (it waits for its first device while the kind is being ticked). */
const GROUP_KIND: Partial<Record<DeviceGroup, NonNullable<PendingKind>>> = { trv: 'trv', ac: 'ac', heater: 'local', floor: 'floor' };

function splitKey(key: string): [string, string] {
  const i = key.indexOf(':');
  return i < 0 ? [key, ''] : [key.slice(0, i), key.slice(i + 1)];
}

/** What the device reads now, where the room's state knows it. */
function liveValue(p: SectionProps, b: RoomBinding): string | undefined {
  const [type, id] = splitKey(b.key);
  if (type === 'sensor') {
    const r = p.state.sensors.find((x) => x.sensorId === id);
    if (!r) return undefined;
    if (b.role === 'humidity') return fmtPct(r.humidityPct);
    if (b.role === 'window' || b.role === 'door') return r.contactOpen == null ? '—' : r.contactOpen ? t('open') : t('closed');
    return fmtTemp(r.smoothedC ?? r.rawC);
  }
  if (type === 'device' && b.role === 'trv') {
    const s = p.state.trvs.find((x) => x.deviceId === id);
    return s ? fmtTemp(s.localTempC) : undefined;
  }
  return undefined;
}

/** A binding without a name of its own (a dehumidifier) is called by what it is. */
function nameOf(b: RoomBinding): string {
  return b.name && b.name !== b.entityId ? b.name : deviceRoleLabel(b.role);
}

/** A combined sensor is named after its device («By the sofa»), not after one of its entities. */
function pickedName(e: HaEntityDto, role: WizardDeviceRole): string {
  return role === 'temp_humidity' && e.deviceName ? e.deviceName : e.name;
}

/** «in Bedroom — will be moved»: binding a device another room has moves it here. */
function otherRoom(e: HaEntityDto, roomId: string): string | null {
  return e.usedBy.find((u) => u.type === 'room' && u.id !== roomId)?.label ?? null;
}

interface GroupProps {
  p: SectionProps;
  k: DeviceGroup;
  list: RoomBinding[];
  edit: EditState;
  write: Write;
  onRemove: (b: RoomBinding) => void;
  onAdd: (k: DeviceGroup) => void;
}

/** One block of devices: each with «Замінити» and «Прибрати», and «+ Додати» opening «Додати пристрій» for this block. */
function DeviceBlock({ p, k, list, edit, write, onRemove, onAdd }: GroupProps) {
  const { room } = p;
  const id = room.config.id;
  const words = deviceGroupWords(k);
  const kind = GROUP_KIND[k];
  const waiting = kind != null && edit.pending === kind;
  const zoned = room.heating.floor?.circuit?.mode === 'zoned';
  const [replacing, setReplacing] = useState<string | null>(null);
  const replaceSearch = useEntitySearch(null, { wizard: list.find((b) => b.key === replacing)?.role ?? 'any', roomId: id, limit: 20 });
  const mixed = new Set(list.map((b) => b.role)).size > 1 || k === 'floor' || k === 'window';

  const replace = (b: RoomBinding, e: HaEntityDto) => {
    setReplacing(null);
    void write.run(
      () => api.rooms.bindings.replace(id, b.key, { entityId: e.entityId, name: e.name, move: otherRoom(e, id) ? true : undefined }),
      t('«{old}» is replaced by «{name}».', { old: nameOf(b), name: e.name }),
    );
  };

  const action = p.canEdit ? (
    <Button variant="ghost" size="sm" icon="plus" ariaLabel={t('Add to «{section}»', { section: words.title })} onClick={() => onAdd(k)}>
      {t('Add')}
    </Button>
  ) : undefined;

  return (
    <Section variant="plain" level={3} title={words.title} tag={words.tag} action={action} inlineAction>
      <Stack gap="xs">
        {waiting ? (
          <StatusBanner
            tone="event"
            text={
              kind === 'trv'
                ? t('Pick the radiator heads: with the first one the radiators are driven head by head.')
                : kind === 'ac'
                  ? t('Pick the air conditioner: once it is added, it cools the room and can top up the heat.')
                  : t('Pick the heater: once it is added, it heats the room.')
            }
            action={{ label: t('Cancel'), onClick: () => edit.setPending(null) }}
          />
        ) : null}
        {list.map((b) => {
          // a combined sensor is two rows of one name: the role tells them apart for a screen reader
          const label = mixed ? `${nameOf(b)} · ${deviceRoleLabel(b.role).toLowerCase()}` : nameOf(b);
          const actions: DeviceRowAction[] = p.canEdit
            ? [
                {
                  label: t('Replace'),
                  icon: 'swap',
                  ariaLabel: t('Replace «{name}»', { name: label }),
                  expanded: replacing === b.key,
                  disabled: write.pending,
                  onClick: () => setReplacing((x) => (x === b.key ? null : b.key)),
                },
                { label: t('Remove'), icon: 'trash', danger: true, ariaLabel: t('Remove «{name}»', { name: label }), disabled: write.pending, onClick: () => onRemove(b) },
              ]
            : [];
          return (
            <Stack key={b.key} gap="xs">
              <DeviceRow
                title={nameOf(b)}
                meta={mixed ? `${deviceRoleLabel(b.role)} · ${b.entityId}` : b.entityId}
                value={liveValue(p, b)}
                actions={actions}
              />
              {replacing === b.key ? (
                <Stack gap="xs">
                  <EntityFinder
                    search={replaceSearch}
                    choices={() => [{ value: b.role, label: deviceRoleLabel(b.role), icon: DEVICE_ROLE_ICON[b.role] }]}
                    blocked={(e) => (e.entityId === b.entityId ? t('this is the one now') : sourceBlockText(e, b.role))}
                    note={(e) => {
                      const other = otherRoom(e, id);
                      return other ? t('now in «{room}» — will be moved', { room: other }) : null;
                    }}
                    onPick={(e) => replace(b, e)}
                    placeholder={t('Replace «{name}» with…', { name: nameOf(b) })}
                    valueText={entityValueText}
                    autoFocus
                  />
                  {b.release === 'trv_handback' ? <Text variant="caption">{releaseWords(b, room.config.trv.releaseSetpointC)}</Text> : null}
                </Stack>
              ) : null}
            </Stack>
          );
        })}
        {!list.length ? (
          <Text variant="caption">{k === 'floor' && !zoned ? t('The floor runs as a whole with the source, so this room needs no valve of its own.') : words.hint}</Text>
        ) : null}
        {k === 'temp' && room.heating.temperature === 'trvs' ? (
          <Text variant="caption">{t('No sensor of its own — the heads’ own readings stand in. A sensor away from the radiator measures the room better.')}</Text>
        ) : null}
      </Stack>
    </Section>
  );
}

/** «Додати пристрій» of room settings: the same dialog as the wizard's, the device bound at once. */
function AddBinding({ p, group, open, onClose, write, edit }: { p: SectionProps; group: DeviceGroup; open: boolean; onClose: () => void; write: Write; edit: EditState }) {
  const { room } = p;
  const id = room.config.id;
  const zoned = room.heating.floor?.circuit?.mode === 'zoned';
  const [k, setK] = useState<DeviceGroup>(group);
  useEffect(() => {
    if (open) setK(group);
  }, [open, group]);
  const search = useEntitySearch(null, { wizardRoles: deviceGroupSearchRoles(k, zoned), roomId: id, limit: 30 });
  const note = (e: HaEntityDto) => {
    const own = room.heating.bindings.filter((b) => b.entityId === e.entityId);
    if (own.length) return t('already here as {role}', { role: own.map((b) => deviceRoleLabel(b.role).toLowerCase()).join(', ') });
    const other = otherRoom(e, id);
    return other ? t('now in «{room}» — will be moved', { room: other }) : null;
  };
  const add = (e: HaEntityDto) => {
    const role = roleInGroup(e, k, zoned);
    const kind = GROUP_KIND[deviceGroupOf(role)];
    return write
      .run(
        () => api.rooms.bindings.add(id, { role, entityId: e.entityId, name: pickedName(e, role), move: otherRoom(e, id) ? true : undefined }),
        t('«{name}» is added as {role}.', { name: pickedName(e, role), role: deviceRoleLabel(role).toLowerCase() }),
      )
      .then((r) => {
        if (!r) return;
        if (kind != null && edit.pending === kind) edit.setPending(null);
        onClose();
      });
  };
  return (
    <AddDeviceDialog<DeviceGroup>
      open={open}
      onClose={onClose}
      title={t('Add a device')}
      kinds={DEVICE_GROUP_ORDER.map((g) => ({ value: g, label: deviceGroupWords(g).what }))}
      kind={k}
      onKind={setK}
      kindLabel={t('What it is')}
      search={search}
      placeholder={t('Name or entity id')}
      help={t('Searches all of Home Assistant; the room’s area comes first.')}
      note={note}
      blocked={(e) => sourceBlockText(e, roleInGroup(e, k, zoned))}
      valueText={entityValueText}
      addLabel={t('Add')}
      onAdd={add}
      busy={write.pending}
    />
  );
}

/**
 * Every device of the room, in the wizard's blocks: «Додати пристрій» on top and «+ Додати» in a block
 * add one (what it is first, then the entity), each device can be replaced by another entity or
 * removed — the confirmation says what happens to it (a head gets its own setpoint back, a heater
 * is switched off).
 */
export function RoomDevices({ p, edit, write }: { p: SectionProps; edit: EditState; write: Write }) {
  const { room } = p;
  const id = room.config.id;
  const h = room.heating;
  const [removing, setRemoving] = useState<RoomBinding | null>(null);
  const [adding, setAdding] = useState(false);
  const [group, setGroup] = useState<DeviceGroup>('temp');
  const byGroup = (k: DeviceGroup) => h.bindings.filter((b) => deviceGroupOf(b.role) === k);
  const kinds = h.kinds;
  const shown = (k: DeviceGroup): boolean => {
    if (byGroup(k).length) return true;
    switch (k) {
      case 'temp':
      case 'window':
        return true;
      case 'trv':
        return kinds.includes('trv') || edit.pending === 'trv';
      case 'ac':
        return kinds.includes('ac') || edit.pending === 'ac';
      case 'heater':
        return kinds.includes('local') || edit.pending === 'local';
      case 'floor':
        return kinds.includes('floor');
      default:
        return false;
    }
  };
  const heads = byGroup('trv');
  const open = (k: DeviceGroup) => {
    setGroup(k);
    setAdding(true);
  };
  // the top button starts with what the room still lacks: a head being ticked, else its temperature
  const firstNeeded: DeviceGroup = edit.pending === 'trv' ? 'trv' : edit.pending === 'ac' ? 'ac' : edit.pending === 'local' ? 'heater' : 'temp';

  const consequences = (b: RoomBinding): string[] => {
    const out = [releaseWords(b, room.config.trv.releaseSetpointC)];
    if (b.role === 'trv' && heads.length === 1) {
      out.push(t('It is the last head: the radiators stay, with ordinary valves — {product} switches the boiler or heat pump and the radiator pump by the room temperature.', { product: brand.productName }));
    }
    if ((b.role === 'ac' || b.role === 'heater') && byGroup(deviceGroupOf(b.role)).length === 1) {
      out.push(b.role === 'ac' ? t('The room no longer has an air conditioner.') : t('The room no longer has a heater of its own.'));
    }
    if (b.lastTemperature) out.push(t('This is the room’s only temperature: until another one is added the room can neither heat nor protect itself from frost.'));
    return out;
  };
  // the dialog stays until the change is done: handing a head back waits for the head to confirm
  const remove = (b: RoomBinding) =>
    void write
      .run(() => api.rooms.bindings.remove(id, b.key, { force: b.lastTemperature }), t('«{name}» is removed from the room.', { name: nameOf(b) }))
      .finally(() => setRemoving(null));
  return (
    <Stack gap="lg">
      {p.canEdit ? (
        <Button variant="secondary" size="lg" icon="plus" fullWidth onClick={() => open(firstNeeded)}>
          {t('Add a device')}
        </Button>
      ) : null}
      {/* two columns on a wide screen keep a room with many sensors within reach */}
      <AutoGrid min={440} gap="xl">
        {DEVICE_GROUP_ORDER.filter(shown).map((k) => (
          <DeviceBlock key={k} p={p} k={k} list={byGroup(k)} edit={edit} write={write} onRemove={setRemoving} onAdd={open} />
        ))}
      </AutoGrid>
      {p.canEdit ? <AddBinding p={p} group={group} open={adding} onClose={() => setAdding(false)} write={write} edit={edit} /> : null}
      <ConfirmDialog
        open={removing != null}
        title={removing ? t('Remove «{name}» from the room?', { name: nameOf(removing) }) : ''}
        consequences={removing ? consequences(removing) : undefined}
        confirm={{
          label: removing?.lastTemperature ? t('Remove anyway') : t('Remove'),
          tone: 'danger',
          onClick: () => removing && remove(removing),
          loading: write.pending,
        }}
        onCancel={() => setRemoving(null)}
      />
    </Stack>
  );
}
