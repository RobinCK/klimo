/**
 * The schedule on a phone: the day types one under another, the shown type's chart and its changes; a tap
 * on a change opens a sheet to move it by 15 minutes, change its profile or delete it. «Розклад |
 * Профілі | Пріоритети» switch between the day, the profile list (a profile opens as its own
 * screen) and the priority order.
 */
import { useState } from 'react';
import type { Dow, Id, Schedule } from '@api/model';
import { navigate, paths } from '@app';
import {
  AutosaveStatus,
  BottomSheet,
  Button,
  DashedAddButton,
  DayOfWeekToggle,
  DayTypeCard,
  MobileTopBar,
  RadioCardList,
  Row,
  Section,
  SegmentedControl,
  Skeleton,
  Stack,
  SwitchPointList,
} from '@ui';
import { minuteToHhmm, t, weekdayLong } from '@i18n';
import { DOWS } from './blocks';
import type { ScheduleContext } from './data';
import { BrushPicker, DayChart, HouseComparison, NewDayType, PointEditor, ScheduleNow, TargetModeSwitch, toggleDays, useTargetMode } from './DayParts';
import { Exceptions } from './Exceptions';
import { PriorityList } from './Priority';
import { ProfileEditor } from './ProfileEditor';
import { ProfileItems } from './Profiles';
import { QuickSetup } from './QuickSetup';
import { RoomScheduleDialog } from './RoomScheduleDialog';
import { scopeName, shortDays } from './texts';
import type { DayEdit } from './useDayEdit';
import type { ScheduleEditor } from './useScheduleEditor';
import { dayView, typeSummary, typeTitle } from './view';

type Tab = 'schedule' | 'profiles' | 'priority';

function TabSwitch({ value }: { value: Tab }) {
  return (
    <SegmentedControl<Tab>
      full
      ariaLabel={t('Schedule sections')}
      value={value}
      options={[
        { value: 'schedule', label: t('Schedule') },
        { value: 'profiles', label: t('Profiles') },
        { value: 'priority', label: t('Priority') },
      ]}
      onChange={(v) => navigate(v === 'schedule' ? paths.schedule() : v === 'profiles' ? paths.scheduleProfiles() : paths.schedulePriority(), { replace: true })}
    />
  );
}

interface DayProps {
  c: ScheduleContext;
  editor: ScheduleEditor;
  edit: DayEdit;
  today: Dow;
  nowMinute: number;
  onScope: (scheduleId: Id) => void;
  onDay: (dow: Dow) => void;
}

export function PhoneDay({ c, editor, edit, today, nowMinute, onScope, onDay }: DayProps) {
  const [sheet, setSheet] = useState(false);
  const [scopes, setScopes] = useState(false);
  const [adding, setAdding] = useState(false);
  const [setup, setSetup] = useState(false);
  const [newType, setNewType] = useState(false);
  const [brush, setBrush] = useState<Id | null>(null);
  const [mode, setMode] = useTargetMode(c);
  const schedule = editor.schedule;
  const type = edit.type;
  const scope = scopeName(schedule, c.rooms, c.ctx);
  const title = type ? typeTitle(type.days) : null;
  const subtitle = schedule?.scope === 'room' ? t('Own schedule of the room') : t('For all rooms');
  const view = schedule && type ? dayView(edit.points, c.profiles.data ?? [], schedule, mode, edit.index, type.days.includes(today) ? nowMinute : null) : null;
  const close = () => {
    setSheet(false);
    edit.select(-1);
  };

  return (
    <Stack gap="md">
      <MobileTopBar
        title={t('Schedule')}
        subtitle={{ icon: 'calendar', text: subtitle }}
        right={
          <Button variant="secondary" size="sm" iconRight="chevronDown" onClick={() => setScopes(true)} ariaLabel={t('Whose schedule: {scope}', { scope })}>
            {scope}
          </Button>
        }
      />
      <TabSwitch value="schedule" />
      {schedule ? (
        <ScheduleNow
          c={c}
          schedule={schedule}
          today={today}
          nowMinute={nowMinute}
          mode={mode}
          action={
            c.canEdit ? (
              <Button variant="secondary" size="sm" icon="sparkle" onClick={() => setSetup(true)}>
                {t('Quick setup')}
              </Button>
            ) : undefined
          }
        />
      ) : null}
      <Stack gap="sm" role="group" ariaLabel={t('Day types')}>
        {edit.types.map((x) => {
          const tt = typeTitle(x.days);
          return (
            <DayTypeCard
              key={x.days.join('')}
              name={tt.name}
              daysText={tt.daysText}
              today={x.days.includes(today)}
              segments={x.plan.map((b) => ({ start: b.start, end: b.end, color: c.profileById(b.profileId)?.color ?? '' }))}
              summary={typeSummary(x)}
              selected={x === type}
              onClick={() => {
                close();
                onDay(x.days.includes(today) ? today : x.days[0]);
              }}
            />
          );
        })}
        {c.canEdit ? <DashedAddButton label={t('New day type')} onClick={() => setNewType(true)} /> : null}
      </Stack>
      {schedule && type && view ? (
        <>
          <TargetModeSwitch full value={mode} onChange={setMode} />
          {c.canEdit ? <BrushPicker compact c={c} schedule={schedule} mode={mode} brush={brush} onBrush={setBrush} /> : null}
          <DayChart c={c} schedule={schedule} edit={edit} mode={mode} today={today} nowMinute={nowMinute} brush={brush} />
          {schedule.scope === 'room' ? <HouseComparison house={editor.schedules.find((s) => s.scope === 'house') ?? null} type={type} c={c} /> : null}
          <Stack gap="sm">
            <SwitchPointList
              ariaLabel={t('Changes through the day')}
              rows={view.rows.map((r) => ({ ...r, emphasis: mode }))}
              expanded={-1}
              onToggle={(i) => {
                edit.select(i);
                setSheet(true);
              }}
              onReorder={c.canEdit ? edit.reorder : undefined}
            />
            {c.canEdit && edit.canAdd ? <DashedAddButton label={t('Add a change')} onClick={edit.add} /> : null}
          </Stack>
          {c.canEdit ? (
            <Section
              variant="plain"
              level={3}
              overline={t('Days of «{type}»', { type: title?.name ?? '' })}
              subtitle={t('Switch a day on to give it this plan; switch it off to make it a type of its own.')}
            >
              <DayOfWeekToggle
                ariaLabel={t('Days of this type')}
                value={type.days}
                labels={shortDays()}
                fullLabels={DOWS.map((d) => weekdayLong(d))}
                onChange={toggleDays(edit, onDay)}
              />
            </Section>
          ) : null}
          <Exceptions c={c} schedule={schedule} />
        </>
      ) : (
        <Skeleton height={420} radius={12} />
      )}

      <BottomSheet
        open={sheet && edit.index >= 0}
        onClose={close}
        title={edit.index >= 0 && edit.points[edit.index] ? t('Change at {time}', { time: minuteToHhmm(edit.points[edit.index].minute) }) : ''}
        subtitle={title ? [title.name, title.daysText].filter(Boolean).join(' · ') : undefined}
        footer={
          <Row gap="sm">
            {c.canEdit ? (
              <Button
                variant="danger"
                size="xl"
                onClick={() => {
                  edit.remove(edit.index);
                  close();
                }}
                disabled={!edit.canRemove}
              >
                {t('Delete')}
              </Button>
            ) : null}
            <Stack grow align="stretch">
              <Button variant="primary" size="xl" fullWidth onClick={close}>
                {t('Done')}
              </Button>
            </Stack>
          </Row>
        }
      >
        {schedule && edit.index >= 0 ? (
          <Stack gap="lg">
            <PointEditor c={c} schedule={schedule} edit={edit} index={edit.index} mode={mode} layout="list" />
            <AutosaveStatus state={editor.status} retry={editor.retry} />
          </Stack>
        ) : null}
      </BottomSheet>

      <BottomSheet open={scopes} onClose={() => setScopes(false)} title={t('Whose schedule')}>
        <Stack gap="md">
          <RadioCardList<string>
            compact
            ariaLabel={t('Whose schedule')}
            value={schedule?.id ?? ''}
            options={editor.schedules.map((s: Schedule) => ({
              value: s.id,
              title: s.scope === 'house' ? t('Whole house') : t('{room} · own schedule', { room: scopeName(s, c.rooms, c.ctx) }),
            }))}
            onChange={(id) => {
              setScopes(false);
              close();
              onScope(id);
            }}
          />
          {c.canEdit && c.rooms.some((r) => !editor.schedules.some((s) => s.roomId === r.id)) ? (
            <DashedAddButton
              label={t('Room schedule')}
              onClick={() => {
                setScopes(false);
                setAdding(true);
              }}
            />
          ) : null}
        </Stack>
      </BottomSheet>
      {newType ? <NewDayType edit={edit} onCreated={onDay} onClose={() => setNewType(false)} /> : null}
      {setup && schedule ? <QuickSetup c={c} editor={editor} schedule={schedule} onApplied={edit.reset} onClose={() => setSetup(false)} /> : null}
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
    </Stack>
  );
}

export function PhoneProfiles({ c }: { c: ScheduleContext }) {
  return (
    <Stack gap="md">
      <MobileTopBar title={t('Profiles')} subtitle={{ text: t('Targets of the rooms in every mode') }} />
      <TabSwitch value="profiles" />
      <ProfileItems c={c} selectedId={null} onSelect={(id) => navigate(paths.scheduleProfile(id))} />
    </Stack>
  );
}

export function PhoneProfile({ c, id, schedules }: { c: ScheduleContext; id: Id; schedules: readonly Schedule[] }) {
  const profile = c.profileById(id);
  return (
    <Stack gap="md">
      <MobileTopBar title={profile?.name ?? t('Profile')} onBack={() => navigate(paths.scheduleProfiles())} />
      {profile ? (
        <ProfileEditor
          key={profile.id}
          c={c}
          profile={profile}
          schedules={schedules}
          onSelect={(next) => navigate(paths.scheduleProfile(next), { replace: true })}
        />
      ) : (
        <Skeleton height={420} radius={18} />
      )}
    </Stack>
  );
}

export function PhonePriority({ c }: { c: ScheduleContext }) {
  return (
    <Stack gap="md">
      <MobileTopBar title={t('Priority')} subtitle={{ text: t('Who wins when rules disagree') }} />
      <TabSwitch value="priority" />
      <Section subtitle={t('Frost protection and windows always come first — they cannot be moved down.')}>
        <PriorityList c={c} plain />
      </Section>
    </Stack>
  );
}
