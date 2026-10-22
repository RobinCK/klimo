/**
 * «Тижневий розклад» on wide screens: whose schedule (the house or a room with its own), the
 * week as seven strips, the selected block's editor and the dated exceptions.
 */
import { useState } from 'react';
import type { Dow, Id, ProfileDto, Schedule } from '@api/model';
import { api } from '@api/endpoints';
import { useMutation } from '@data';
import {
  AutosaveStatus,
  Button,
  CheckboxRow,
  ConfirmDialog,
  DayOfWeekToggle,
  InlinePanel,
  LegendSwatch,
  Row,
  ScrollX,
  Section,
  SegmentedControl,
  Stack,
  TimeStepper,
  ToggleChip,
  WeekTimeline,
} from '@ui';
import { minuteToHhmm, t, weekdayLong, weekdayShort } from '@i18n';
import { DOWS, WEEKDAYS, WEEKEND } from './blocks';
import type { ScheduleContext } from './data';
import { Exceptions } from './Exceptions';
import { RoomScheduleDialog } from './RoomScheduleDialog';
import { blockTargets, range, scopeName, shortDays } from './texts';
import type { BlockEdit } from './useBlockEdit';
import type { ScheduleEditor } from './useScheduleEditor';

const ADD = '__add';

interface Props {
  c: ScheduleContext;
  editor: ScheduleEditor;
  edit: BlockEdit;
  today: Dow;
  nowMinute: number;
  onScope: (scheduleId: Id) => void;
}

export function WeekSchedule({ c, editor, edit, today, nowMinute, onScope }: Props) {
  const [adding, setAdding] = useState(false);
  const schedule = editor.schedule;
  const profiles = c.profiles.data ?? [];
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const scopeOptions = [
    ...editor.schedules.map((s) => ({
      value: s.id,
      label: s.scope === 'house' ? t('Whole house') : t('{room} · own schedule', { room: scopeName(s, c.rooms, c.ctx) }),
    })),
    ...(c.canEdit && c.rooms.some((r) => !editor.schedules.some((s) => s.roomId === r.id)) ? [{ value: ADD, label: t('+ Room schedule') }] : []),
  ];
  const hint =
    schedule?.scope === 'room'
      ? t('The schedule of {room} replaces the house schedule for this room only.', { room: scopeName(schedule, c.rooms, c.ctx) })
      : t('Applies to every room without its own schedule. Click a block to edit it.');

  return (
    <Section
      title={t('Weekly schedule')}
      subtitle={hint}
      action={
        <SegmentedControl<string>
          ariaLabel={t('Whose schedule')}
          value={schedule?.id ?? 'house'}
          options={scopeOptions}
          onChange={(v) => (v === ADD ? setAdding(true) : onScope(v))}
        />
      }
    >
      <Stack gap="lg">
        <Row gap="md" wrap>
          {profiles.map((p) => (
            <LegendSwatch key={p.id} color={p.color} label={p.name} />
          ))}
        </Row>
        {schedule ? (
          <ScrollX minWidth={760} ariaLabel={t('Weekly schedule')}>
            <WeekTimeline
              ariaLabel={t('Weekly schedule of {scope}', { scope: scopeName(schedule, c.rooms, c.ctx) })}
              now={nowMinute}
              axis={['00', '03', '06', '09', '12', '15', '18', '21', '24']}
              onSelect={(d, i) => edit.select(d as Dow, i)}
              days={DOWS.map((d) => ({
                label: weekdayShort(d),
                today: d === today,
                blocks: (schedule.days[d] ?? []).map((b, i) => {
                  const p = byId.get(b.profileId);
                  const name = p?.name ?? b.profileId;
                  return {
                    start: b.start,
                    end: b.end,
                    color: p?.color ?? '',
                    ink: p?.ink ?? '',
                    label: name,
                    aria: `${weekdayShort(d)} ${range(b.start, b.end)}, ${name}`,
                    selected: d === edit.dow && i === edit.index,
                  };
                }),
              }))}
            />
          </ScrollX>
        ) : null}
        {schedule && edit.block ? <BlockPanel c={c} editor={editor} edit={edit} schedule={schedule} profiles={profiles} /> : null}
        {schedule?.scope === 'room' ? <RoomScheduleControls c={c} schedule={schedule} onRemoved={() => onScope('house')} /> : null}
        {schedule ? <Exceptions c={c} schedule={schedule} /> : null}
      </Stack>
      {adding ? (
        <RoomScheduleDialog
          c={c}
          schedules={editor.schedules}
          onClose={() => setAdding(false)}
          onCreated={(s) => {
            setAdding(false);
            void editor.resource.reload().then(() => onScope(s.id));
          }}
        />
      ) : null}
    </Section>
  );
}

function BlockPanel({
  c,
  editor,
  edit,
  schedule,
  profiles,
}: {
  c: ScheduleContext;
  editor: ScheduleEditor;
  edit: BlockEdit;
  schedule: Schedule;
  profiles: readonly ProfileDto[];
}) {
  const block = edit.block;
  if (!block) return null;
  const name = edit.profile?.name ?? block.profileId;
  const disabled = !c.canEdit;
  const copy = (to: readonly Dow[], message: string) => void editor.copyDay(edit.dow, [...to], message);
  return (
    <InlinePanel
      emphasis
      title={`${weekdayShort(edit.dow)} · ${range(block.start, block.end)} · ${name}`}
      hint={blockTargets(schedule, edit.profile, c)}
      footer={
        <Row gap="sm" wrap justify="end">
          <AutosaveStatus state={editor.status} retry={editor.retry} />
          <Button variant="ghost" icon="trash" onClick={edit.remove} disabled={disabled || !edit.canRemove}>
            {t('Delete block')}
          </Button>
          <Button variant="ghost" onClick={edit.split} disabled={disabled || !edit.canSplit}>
            {t('Split block')}
          </Button>
          <Button
            variant="secondary"
            icon="copy"
            onClick={() => copy(WEEKDAYS, t('{day} copied to weekdays', { day: weekdayLong(edit.dow) }))}
            disabled={disabled}
          >
            {t('Copy to weekdays')}
          </Button>
          <Button variant="ghost" onClick={() => copy(WEEKEND, t('{day} copied to the weekend', { day: weekdayLong(edit.dow) }))} disabled={disabled}>
            {t('to the weekend')}
          </Button>
          <Button variant="ghost" onClick={() => copy(DOWS, t('{day} copied to every day', { day: weekdayLong(edit.dow) }))} disabled={disabled}>
            {t('to every day')}
          </Button>
        </Row>
      }
    >
      <Stack gap="lg">
        <Row gap="xl" wrap>
          <TimeStepper
            label={t('Start')}
            value={block.start}
            text={minuteToHhmm(block.start)}
            min={disabled ? block.start : edit.startRange.min}
            max={disabled ? block.start : edit.startRange.max}
            onChange={edit.setStart}
            ariaEarlier={t('Start 30 min earlier')}
            ariaLater={t('Start 30 min later')}
          />
          <TimeStepper
            label={t('End')}
            value={block.end}
            text={minuteToHhmm(block.end)}
            min={disabled ? block.end : edit.endRange.min}
            max={disabled ? block.end : edit.endRange.max}
            onChange={edit.setEnd}
            ariaEarlier={t('End 30 min earlier')}
            ariaLater={t('End 30 min later')}
          />
        </Row>
        <Stack gap="xs">
          <Section variant="plain" level={3} overline={t('Profile of the block')}>
            <Row gap="sm" wrap>
              {profiles.map((p) => (
                <ToggleChip key={p.id} pressed={p.id === block.profileId} icon={p.icon} label={p.name} onToggle={() => !disabled && edit.setProfile(p.id)} />
              ))}
            </Row>
          </Section>
        </Stack>
        <Section variant="plain" level={3} overline={t('Repeat on')}>
          <DayOfWeekToggle
            ariaLabel={t('Repeat on')}
            value={edit.repeat}
            labels={shortDays()}
            fullLabels={DOWS.map((d) => weekdayLong(d))}
            onChange={(v) => !disabled && edit.setRepeat(v as Dow[])}
          />
        </Section>
      </Stack>
    </InlinePanel>
  );
}

function RoomScheduleControls({ c, schedule, onRemoved }: { c: ScheduleContext; schedule: Schedule; onRemoved: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const room = scopeName(schedule, c.rooms, c.ctx);
  const toggle = useMutation((enabled: boolean) => api.schedules.patch(schedule.id, { enabled }), {
    okToast: (s) => (s.enabled ? t('The schedule of {room} is on', { room }) : t('{room} follows the house schedule for now', { room })),
  });
  const remove = useMutation(() => api.schedules.remove(schedule.id), {
    onSuccess: () => {
      setConfirm(false);
      onRemoved();
    },
    okToast: t('{room} follows the house schedule again', { room }),
  });
  return (
    <Row gap="md" wrap align="center">
      <Stack grow align="stretch">
        <CheckboxRow
          variant="well"
          checked={schedule.enabled}
          disabled={!c.canEdit || toggle.pending}
          title={t('The room schedule is in use')}
          hint={t('Switched off, {room} follows the house schedule; the plan stays for later.', { room })}
          onChange={(v) => void toggle.run(v)}
        />
      </Stack>
      {c.canEdit ? (
        <Button variant="danger" onClick={() => setConfirm(true)}>
          {t('Delete the room schedule')}
        </Button>
      ) : null}
      <ConfirmDialog
        open={confirm}
        title={t('Delete the schedule of {room}?', { room })}
        consequences={[t('{room} will follow the house schedule.', { room })]}
        confirm={{ label: t('Delete'), tone: 'danger', onClick: () => void remove.run(), loading: remove.pending }}
        onCancel={() => setConfirm(false)}
      />
    </Row>
  );
}
