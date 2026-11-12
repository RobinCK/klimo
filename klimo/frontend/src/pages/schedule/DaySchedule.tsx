/**
 * «Розклад» on wide screens: whose schedule, what it gives now, the week as day types (the days
 * that share a plan) and the shown type's day as switch points — «17:30 → Дома» — on a chart of
 * the target and as rows that open their editor in place.
 */
import { useState } from 'react';
import type { Dow, Id, Schedule } from '@api/model';
import { api } from '@api/endpoints';
import { useMutation } from '@data';
import {
  AutosaveStatus,
  Button,
  CheckboxRow,
  ConfirmDialog,
  DashedAddButton,
  DayOfWeekToggle,
  DayTypeCard,
  Row,
  Section,
  Select,
  Split,
  Stack,
  SwitchPointRow,
  Text,
} from '@ui';
import { t, weekdayLong } from '@i18n';
import { DOWS } from './blocks';
import type { ScheduleContext } from './data';
import { DayChart, HouseComparison, PointEditor, ScheduleNow, TargetModeSwitch, useTargetMode } from './DayParts';
import { Exceptions } from './Exceptions';
import { QuickSetup } from './QuickSetup';
import { RoomScheduleDialog } from './RoomScheduleDialog';
import { scopeName, shortDays } from './texts';
import type { DayEdit } from './useDayEdit';
import type { ScheduleEditor } from './useScheduleEditor';
import { dayView, typeSummary, typeTitle } from './view';

const ADD = '__add';

interface Props {
  c: ScheduleContext;
  editor: ScheduleEditor;
  edit: DayEdit;
  today: Dow;
  nowMinute: number;
  onScope: (scheduleId: Id) => void;
  onDay: (dow: Dow) => void;
}

export function DaySchedule({ c, editor, edit, today, nowMinute, onScope, onDay }: Props) {
  const [adding, setAdding] = useState(false);
  const [setup, setSetup] = useState(false);
  const [mode, setMode] = useTargetMode(c);
  const schedule = editor.schedule;
  const house = editor.schedules.find((s) => s.scope === 'house') ?? null;
  const type = edit.type;
  const ownRooms = editor.schedules.filter((s) => s.scope === 'room' && s.enabled).length;
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
      : ownRooms
        ? t('Applies to every room without its own schedule ({count} have their own).', { count: ownRooms })
        : t('Applies to every room.');

  // a day switched on joins the shown type; switched off, it is taken out to be edited alone
  const onDays = (next: number[]) => {
    if (!type) return;
    const added = next.find((d) => !type.days.includes(d as Dow));
    const removed = type.days.find((d) => !next.includes(d));
    if (added != null) edit.join(added as Dow);
    else if (removed != null) {
      edit.detach(removed);
      onDay(removed);
    }
  };

  return (
    <Section
      title={t('Weekly schedule')}
      subtitle={hint}
      action={
        <Row gap="sm" wrap>
          {c.canEdit && schedule ? (
            <Button variant="secondary" size="sm" icon="sparkle" onClick={() => setSetup(true)}>
              {t('Quick setup')}
            </Button>
          ) : null}
          <Select<string>
            size="sm"
            ariaLabel={t('Whose schedule')}
            value={schedule?.id ?? ''}
            options={scopeOptions}
            onChange={(v) => (v === ADD ? setAdding(true) : onScope(v))}
          />
        </Row>
      }
    >
      {schedule ? (
        <Stack gap="lg">
          <ScheduleNow c={c} schedule={schedule} today={today} nowMinute={nowMinute} mode={mode} />
          <Split
            asideFirst
            asideBasis={300}
            mainBasis={640}
            aside={
              <Stack gap="lg">
                <Section variant="plain" level={3} title={t('Day types')} subtitle={t('Days with the same plan are edited together.')}>
                  <Stack gap="sm">
                    {edit.types.map((x) => {
                      const title = typeTitle(x.days);
                      return (
                        <DayTypeCard
                          key={x.days.join('')}
                          name={title.name}
                          daysText={title.daysText}
                          today={x.days.includes(today)}
                          segments={x.plan.map((b) => ({ start: b.start, end: b.end, color: c.profileById(b.profileId)?.color ?? '' }))}
                          summary={typeSummary(x)}
                          selected={x === type}
                          onClick={() => onDay(x.days.includes(today) ? today : x.days[0])}
                        />
                      );
                    })}
                  </Stack>
                </Section>
                <Exceptions c={c} schedule={schedule} />
                {schedule.scope === 'room' ? <RoomScheduleControls c={c} schedule={schedule} onRemoved={() => onScope(house?.id ?? 'house')} /> : null}
              </Stack>
            }
            main={type ? <TypeEditor c={c} editor={editor} edit={edit} schedule={schedule} house={house} today={today} nowMinute={nowMinute} mode={mode} onMode={setMode} onDays={onDays} /> : null}
          />
        </Stack>
      ) : null}
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
      {setup && schedule ? <QuickSetup c={c} editor={editor} schedule={schedule} onApplied={edit.reset} onClose={() => setSetup(false)} /> : null}
    </Section>
  );
}

function TypeEditor({
  c,
  editor,
  edit,
  schedule,
  house,
  today,
  nowMinute,
  mode,
  onMode,
  onDays,
}: {
  c: ScheduleContext;
  editor: ScheduleEditor;
  edit: DayEdit;
  schedule: Schedule;
  house: Schedule | null;
  today: Dow;
  nowMinute: number;
  mode: 'heat' | 'cool';
  onMode: (m: 'heat' | 'cool') => void;
  onDays: (days: number[]) => void;
}) {
  const type = edit.type;
  if (!type) return null;
  const view = dayView(edit.points, c.profiles.data ?? [], schedule, mode, edit.index, type.days.includes(today) ? nowMinute : null);
  return (
    <Section variant="well" level={3} title={typeTitle(type.days).name} action={<TargetModeSwitch value={mode} onChange={onMode} />}>
      <Stack gap="lg">
        {c.canEdit ? (
          <Stack gap="xs">
            <DayOfWeekToggle ariaLabel={t('Days of this type')} value={type.days} labels={shortDays()} fullLabels={DOWS.map((d) => weekdayLong(d))} onChange={onDays} />
            <Text variant="caption">{t('Switch a day on to give it this plan; switch it off to edit it alone.')}</Text>
          </Stack>
        ) : null}
        <DayChart c={c} schedule={schedule} edit={edit} mode={mode} today={today} nowMinute={nowMinute} />
        {schedule.scope === 'room' ? <HouseComparison house={house} type={type} c={c} /> : null}
        <Section variant="plain" level={3} title={t('Changes through the day')} subtitle={t('Each one holds until the next.')}>
          <Stack gap="sm">
            {view.rows.map((r, i) => (
              <SwitchPointRow
                key={`${r.time}-${i}`}
                time={r.time}
                name={r.name}
                color={r.color}
                untilText={r.untilText}
                heatText={r.heatText}
                coolText={r.coolText}
                emphasis={mode}
                now={r.now}
                expanded={i === edit.index}
                onToggle={() => edit.select(i === edit.index ? -1 : i)}
              >
                <PointEditor c={c} schedule={schedule} edit={edit} index={i} mode={mode} />
              </SwitchPointRow>
            ))}
            {c.canEdit && edit.canAdd ? <DashedAddButton label={t('Add a change')} onClick={edit.add} /> : null}
          </Stack>
        </Section>
        <Row justify="end">
          <AutosaveStatus state={editor.status} retry={editor.retry} />
        </Row>
      </Stack>
    </Section>
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
    <Stack gap="md">
      <CheckboxRow
        variant="well"
        checked={schedule.enabled}
        disabled={!c.canEdit || toggle.pending}
        title={t('The room schedule is in use')}
        hint={t('Switched off, {room} follows the house schedule; the plan stays for later.', { room })}
        onChange={(v) => void toggle.run(v)}
      />
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
    </Stack>
  );
}
