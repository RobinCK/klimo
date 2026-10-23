/**
 * «Керування з Home Assistant»: ready actions for scripts and automations — the resume buttons,
 * the room thermostat, the control select, the house schedule switch and the klimo_command event.
 * The entity ids are the ones Home Assistant actually gave (read back from its registry).
 */
import { useState } from 'react';
import type { ExposedEntityDto, RoomSummary } from '@api/model';
import { api } from '@api/endpoints';
import { useResource } from '@data';
import { CodeBlock, Row, Section, Select, Stack, Text } from '@ui';
import { brand } from '@brand';
import { t } from '@i18n';

type Example = 'room_resume' | 'house_resume' | 'room_manual' | 'room_auto' | 'room_select' | 'house_pause' | 'event_resume' | 'event_target';

const EXAMPLES: readonly Example[] = ['room_resume', 'house_resume', 'room_manual', 'room_auto', 'room_select', 'house_pause', 'event_resume', 'event_target'];
const HOUSE_LEVEL = new Set<Example>(['house_resume', 'house_pause']);

function exampleLabel(e: Example): string {
  switch (e) {
    case 'room_resume':
      return t('Resume the schedule in a room');
    case 'house_resume':
      return t('Resume the schedule for the whole house');
    case 'room_manual':
      return t('Manual control of a room at 21°');
    case 'room_auto':
      return t('A room back to the schedule (thermostat)');
    case 'room_select':
      return t('A room’s mode through its select');
    case 'house_pause':
      return t('Pause the house schedule');
    case 'event_resume':
      return t('Event: resume a room from a script');
    case 'event_target':
      return t('Event: a target for 2 hours');
  }
}

/** What the example does, in one sentence under it. */
function exampleNote(e: Example): string {
  switch (e) {
    case 'room_resume':
      return t('Ends the room’s manual, temporary and off changes. An open window and frost protection still act.');
    case 'house_resume':
      return t('Resumes the house schedule and every room’s own change. Rooms switched off stay off.');
    case 'room_manual':
      return t('heat, cool or heat_cool switch the room to manual control; the temperature then holds until the schedule is resumed.');
    case 'room_auto':
      return t('auto is the schedule; off switches the room off (frost protection stays).');
    case 'room_select':
      return t('Options: Schedule, Manual, Off. Manual holds the target the room has now.');
    case 'house_pause':
      return t('Off pauses the house schedule on the current profile; on resumes the whole house.');
    case 'event_resume':
      return t('room takes the room id, its slug, its name or one of its entities. Without room the command acts on the whole house.');
    case 'event_target':
      return t('Commands: resume_schedule, set_manual, set_schedule, set_off, set_target. A rejected command is written to the journal with the reason.');
  }
}

interface Ids {
  climate: string;
  select: string;
  roomButton: string;
  houseButton: string;
  houseSwitch: string;
  roomRef: string;
}

function idsFor(exposed: readonly ExposedEntityDto[] | undefined, room: RoomSummary | undefined): Ids {
  const slug = room?.slug ?? 'living_room';
  const of = (role: string, roomId: string | null, fallback: string) =>
    exposed?.find((e) => e.role === role && e.roomId === roomId)?.entityId ?? fallback;
  const rid = room?.id ?? null;
  return {
    climate: of('climate', rid, `climate.klimo_${slug}`),
    select: of('control', rid, `select.klimo_${slug}_control`),
    roomButton: of('resume_schedule', rid, `button.klimo_${slug}_resume_schedule`),
    houseButton: of('resume_schedule', null, 'button.klimo_resume_schedule'),
    houseSwitch: of('schedule', null, 'switch.klimo_schedule'),
    roomRef: slug,
  };
}

function yaml(e: Example, ids: Ids): string {
  switch (e) {
    case 'room_resume':
      return ['action: button.press', 'target:', `  entity_id: ${ids.roomButton}`].join('\n');
    case 'house_resume':
      return ['action: button.press', 'target:', `  entity_id: ${ids.houseButton}`].join('\n');
    case 'room_manual':
      return ['action: climate.set_temperature', 'target:', `  entity_id: ${ids.climate}`, 'data:', '  hvac_mode: heat', '  temperature: 21'].join('\n');
    case 'room_auto':
      return ['action: climate.set_hvac_mode', 'target:', `  entity_id: ${ids.climate}`, 'data:', '  hvac_mode: auto'].join('\n');
    case 'room_select':
      return ['action: select.select_option', 'target:', `  entity_id: ${ids.select}`, 'data:', '  option: Manual'].join('\n');
    case 'house_pause':
      return ['action: switch.turn_off', 'target:', `  entity_id: ${ids.houseSwitch}`].join('\n');
    case 'event_resume':
      return ['event: klimo_command', 'event_data:', '  command: resume_schedule', `  room: ${ids.roomRef}`].join('\n');
    case 'event_target':
      return ['event: klimo_command', 'event_data:', '  command: set_target', `  room: ${ids.roomRef}`, '  target: 21.5', '  duration: 2h'].join('\n');
  }
}

export function HaControlHelp({ rooms }: { rooms: readonly RoomSummary[] }) {
  const [example, setExample] = useState<Example>('room_resume');
  const [roomId, setRoomId] = useState<string | null>(null);
  const exposed = useResource('system:exposed', api.system.exposedEntities, { reloadOn: ['room', 'source', 'trigger', 'pump', 'circuit', 'settings'] });
  const room = rooms.find((r) => r.id === roomId) ?? rooms[0];
  const ids = idsFor(exposed.data, room);
  return (
    <Section
      title={t('Control from Home Assistant')}
      subtitle={t('Scripts and automations switch rooms the same way as this panel. Paste an example into an action.')}
      variant="plain"
      level={3}
    >
      <Stack gap="sm">
        <Row gap="sm" wrap>
          <Select<Example>
            ariaLabel={t('Example')}
            size="sm"
            value={example}
            options={EXAMPLES.map((e) => ({ value: e, label: exampleLabel(e) }))}
            onChange={setExample}
          />
          {!HOUSE_LEVEL.has(example) && rooms.length > 1 && room ? (
            <Select<string> ariaLabel={t('Room')} size="sm" value={room.id} options={rooms.map((r) => ({ value: r.id, label: r.name }))} onChange={setRoomId} />
          ) : null}
        </Row>
        <CodeBlock code={yaml(example, ids)} ariaLabel={exampleLabel(example)} copyable />
        <Text variant="caption">{exampleNote(example)}</Text>
        <Text variant="caption">
          {t('{product} cannot add services of its own to Home Assistant: the buttons, the select, the switch and the event are the way in.', {
            product: brand.productName,
          })}
        </Text>
      </Stack>
    </Section>
  );
}
