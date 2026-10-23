import { useState } from 'react';
import type { HaEntityDto, RoomBinding, WizardDeviceRole } from '@api/model';
import { api } from '@api/endpoints';
import { useEntitySearch, useLayout } from '@data';
import {
  AutoGrid,
  Button,
  ConfirmDialog,
  DeviceRow,
  EntityFinder,
  QuickActionPill,
  Row,
  Section,
  Stack,
  StatusBanner,
  Text,
  type DeviceRowAction,
  type EntityFinderChoice,
} from '@ui';
import { brand } from '@brand';
import {
  DEVICE_GROUP_ROLES,
  DEVICE_GROUP_SEARCH,
  DEVICE_ROLE_ICON,
  deviceGroupOf,
  deviceGroupWords,
  deviceRoleLabel,
  entityValueText,
  fmtPct,
  fmtTemp,
  releaseWords,
  t,
  type DeviceGroup,
} from '@i18n';
import type { SectionProps } from '../sections/types';
import type { EditState, PendingKind, useRoomWrite } from './shared';

type Write = ReturnType<typeof useRoomWrite>;

const ORDER: readonly DeviceGroup[] = ['trv', 'temp', 'window', 'ac', 'heater', 'floor', 'dehum'];
/** The heating kind a device block belongs to (it waits for its first device while the kind is being ticked). */
const GROUP_KIND: Partial<Record<DeviceGroup, NonNullable<PendingKind>>> = { trv: 'trv', ac: 'ac', heater: 'local', floor: 'floor' };

const choice = (role: WizardDeviceRole): EntityFinderChoice => ({ value: role, label: deviceRoleLabel(role), icon: DEVICE_ROLE_ICON[role] });

/** The roles a source's own climate or relay cannot take as well (the server refuses them too). */
const DRIVEN: readonly WizardDeviceRole[] = ['trv', 'ac', 'heater', 'floor_zone'];

function sourceBlock(e: HaEntityDto): string | null {
  const source = e.usedBy.find((u) => u.type === 'source');
  if (!source || !(e.wizard?.suggested ?? []).every((r) => DRIVEN.includes(r))) return null;
  return t('the source «{source}» switches it — it cannot be a room device too', { source: source.label });
}

/** The role a result takes in a block: the entity's own likeliest one that fits the block. */
function roleIn(e: HaEntityDto, k: DeviceGroup): WizardDeviceRole {
  const fits = (r: WizardDeviceRole) => DEVICE_GROUP_ROLES[k].includes(r);
  return e.wizard?.suggested.find(fits) ?? e.wizard?.possible.find(fits) ?? DEVICE_GROUP_SEARCH[k];
}

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
  onClose?: () => void;
}

/** One block of devices: each with «Замінити» and «Прибрати», and «+ Додати» with the block's own search. */
function DeviceBlock({ p, k, list, edit, write, onRemove, onClose }: GroupProps) {
  const { room } = p;
  const id = room.config.id;
  const words = deviceGroupWords(k);
  const kind = GROUP_KIND[k];
  const waiting = kind != null && edit.pending === kind;
  const zoned = room.heating.floor?.circuit?.mode === 'zoned';
  // a floor that runs as a whole has no zone valve of a room to add (a floor probe comes from the search above)
  const canPick = p.canEdit && (k !== 'floor' || zoned);
  const [adding, setAdding] = useState(false);
  const [replacing, setReplacing] = useState<string | null>(null);
  const search = useEntitySearch(null, { wizard: DEVICE_GROUP_SEARCH[k], roomId: id, limit: 20 });
  const replaceSearch = useEntitySearch(null, { wizard: list.find((b) => b.key === replacing)?.role ?? DEVICE_GROUP_SEARCH[k], roomId: id, limit: 20 });
  const mixed = new Set(list.map((b) => b.role)).size > 1 || k === 'floor' || k === 'window';
  // an empty block that is the reason it is shown (the room's temperature, a kind being ticked, a block
  // just opened) offers its search at once; a block that may well stay empty (windows) waits for «+ Додати»
  const autoOpen = canPick && !list.length && (k === 'temp' || waiting || onClose != null);
  const finderOpen = canPick && (adding || autoOpen);

  const add = (e: HaEntityDto, role: WizardDeviceRole) => {
    setAdding(false);
    void write
      .run(
        () => api.rooms.bindings.add(id, { role, entityId: e.entityId, name: pickedName(e, role), move: otherRoom(e, id) ? true : undefined }),
        t('«{name}» is added as {role}.', { name: pickedName(e, role), role: deviceRoleLabel(role).toLowerCase() }),
      )
      .then((r) => {
        if (r && waiting) edit.setPending(null);
      });
  };
  const replace = (b: RoomBinding, e: HaEntityDto) => {
    setReplacing(null);
    void write.run(
      () => api.rooms.bindings.replace(id, b.key, { entityId: e.entityId, name: e.name, move: otherRoom(e, id) ? true : undefined }),
      t('«{old}» is replaced by «{name}».', { old: nameOf(b), name: e.name }),
    );
  };

  const action = canPick && !autoOpen ? (
    <Button variant="ghost" size="sm" icon={adding ? 'close' : 'plus'} onClick={() => setAdding((a) => !a)}>
      {adding ? t('Close') : t('Add')}
    </Button>
  ) : onClose && !list.length ? (
    <Button variant="ghost" size="sm" icon="close" onClick={onClose}>
      {t('Close')}
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
                    choices={() => [choice(b.role)]}
                    blocked={(e) => (e.entityId === b.entityId ? t('this is the one now') : sourceBlock(e))}
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
        {finderOpen ? (
          <EntityFinder
            search={search}
            choices={(e) => [choice(roleIn(e, k))]}
            blocked={sourceBlock}
            note={(e) => {
              const other = otherRoom(e, id);
              return other ? t('now in «{room}» — will be moved', { room: other }) : null;
            }}
            onPick={(e, role) => add(e, role as WizardDeviceRole)}
            placeholder={words.find}
            valueText={entityValueText}
            autoFocus={waiting || adding}
          />
        ) : null}
      </Stack>
    </Section>
  );
}

/**
 * Every device of the room, in the wizard's blocks: one search on top adds anything (its role is
 * guessed, a second choice offered when unsure), each device can be replaced by another entity or
 * removed — the confirmation says what happens to it (a head gets its own setpoint back, a heater
 * is switched off).
 */
export function RoomDevices({ p, edit, write }: { p: SectionProps; edit: EditState; write: Write }) {
  const { room } = p;
  const id = room.config.id;
  const h = room.heating;
  const phone = useLayout() === 'phone';
  const [removing, setRemoving] = useState<RoomBinding | null>(null);
  const [opened, setOpened] = useState<DeviceGroup[]>([]);
  const search = useEntitySearch(null, { wizard: 'any', roomId: id, limit: 30 });
  const byGroup = (k: DeviceGroup) => h.bindings.filter((b) => deviceGroupOf(b.role) === k);
  const kinds = h.kinds;
  const shown = (k: DeviceGroup): boolean => {
    if (byGroup(k).length || opened.includes(k)) return true;
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

  const add = (e: HaEntityDto, role: WizardDeviceRole) =>
    void write.run(
      () => api.rooms.bindings.add(id, { role, entityId: e.entityId, name: pickedName(e, role), move: otherRoom(e, id) ? true : undefined }),
      t('«{name}» is added as {role}.', { name: pickedName(e, role), role: deviceRoleLabel(role).toLowerCase() }),
    );
  const already = (e: HaEntityDto) => {
    const own = h.bindings.filter((b) => b.entityId === e.entityId);
    if (own.length) return t('already here as {role}', { role: own.map((b) => deviceRoleLabel(b.role).toLowerCase()).join(', ') });
    const other = otherRoom(e, id);
    return other ? t('now in «{room}» — will be moved', { room: other }) : null;
  };

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
  const chips = (['dehum'] as const).filter((k) => !shown(k));

  return (
    <Stack gap="lg">
      {p.canEdit ? (
        <EntityFinder
          search={search}
          choices={(e) => (e.wizard?.suggested ?? []).map(choice)}
          onPick={(e, role) => add(e, role as WizardDeviceRole)}
          placeholder={t('Add a device — name or entity id')}
          ariaLabel={t('Add a device to the room')}
          valueText={entityValueText}
          note={already}
          blocked={sourceBlock}
          help={phone ? undefined : t('Searches all of Home Assistant; the room’s area comes first. A click adds the device in the role shown.')}
        />
      ) : null}
      {/* two columns on a wide screen keep a room with many sensors within reach */}
      <AutoGrid min={440} gap="xl">
        {ORDER.filter(shown).map((k) => (
          <DeviceBlock
            key={k}
            p={p}
            k={k}
            list={byGroup(k)}
            edit={edit}
            write={write}
            onRemove={setRemoving}
            onClose={opened.includes(k) ? () => setOpened((o) => o.filter((x) => x !== k)) : undefined}
          />
        ))}
      </AutoGrid>
      {chips.length && p.canEdit ? (
        <Section variant="plain" level={3} title={t('Also in this room?')}>
          <Row gap="sm" wrap>
            {chips.map((k) => (
              <QuickActionPill key={k} icon="plus" label={deviceGroupWords(k).chip} onClick={() => setOpened((o) => [...o, k])} />
            ))}
          </Row>
        </Section>
      ) : null}
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
