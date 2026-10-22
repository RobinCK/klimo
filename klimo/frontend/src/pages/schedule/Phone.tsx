/**
 * The schedule on a phone: one day at a time as a vertical timeline, a tap on a block opens a
 * sheet to move it by 30 minutes, change its profile or delete it. «Розклад | Профілі» leads to
 * the profile list, a profile's editor and the priority order as their own screens.
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
  DayTabs,
  DayTimelineVertical,
  MobileTopBar,
  RadioCardList,
  Row,
  Section,
  SegmentedControl,
  Skeleton,
  Stack,
  TimeStepper,
  ToggleChip,
  AutoGrid,
} from '@ui';
import { fmtTemp, minuteToHhmm, t, weekdayLong, weekdayShort } from '@i18n';
import { DOWS } from './blocks';
import type { ScheduleContext } from './data';
import { PriorityList } from './Priority';
import { ProfileEditor } from './ProfileEditor';
import { ProfileItems } from './Profiles';
import { RoomScheduleDialog } from './RoomScheduleDialog';
import { blockTargets, range, scopeName, shortDays } from './texts';
import type { BlockEdit } from './useBlockEdit';
import type { ScheduleEditor } from './useScheduleEditor';

type Tab = 'schedule' | 'profiles';

function TabSwitch({ value }: { value: Tab }) {
  return (
    <SegmentedControl<Tab>
      full
      ariaLabel={t('Schedule or profiles')}
      value={value}
      options={[
        { value: 'schedule', label: t('Schedule') },
        { value: 'profiles', label: t('Profiles') },
      ]}
      onChange={(v) => navigate(v === 'schedule' ? paths.schedule() : paths.scheduleProfiles(), { replace: true })}
    />
  );
}

interface DayProps {
  c: ScheduleContext;
  editor: ScheduleEditor;
  edit: BlockEdit;
  today: Dow;
  nowMinute: number;
  onScope: (scheduleId: Id) => void;
  onDay: (dow: Dow) => void;
}

export function PhoneDay({ c, editor, edit, today, nowMinute, onScope, onDay }: DayProps) {
  const [sheet, setSheet] = useState(false);
  const [scopes, setScopes] = useState(false);
  const [adding, setAdding] = useState(false);
  const schedule = editor.schedule;
  const profiles = c.profiles.data ?? [];
  const day = edit.dow;
  const plan = schedule?.days[day] ?? [];
  const cooling = c.house?.season.season === 'cooling';
  const scope = scopeName(schedule, c.rooms, c.ctx);
  const subtitle =
    schedule?.scope === 'room' ? t('{day} · own schedule of the room', { day: weekdayLong(day) }) : t('{day} · for all rooms', { day: weekdayLong(day) });

  const targetOf = (profileId: Id): number | null => {
    const p = profiles.find((x) => x.id === profileId);
    if (!p) return null;
    const row = schedule?.scope === 'room' ? p.roomTargets.find((r) => r.roomId === schedule.roomId) : undefined;
    if (row?.mode === 'off' || p.frostOnly) return null;
    if (row?.mode === 'own') return cooling ? (row.coolC ?? p.coolC) : (row.heatC ?? p.heatC);
    return cooling ? p.coolC : p.heatC;
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
      <DayTabs
        ariaLabel={t('Day of the week')}
        value={day}
        today={today}
        labels={shortDays()}
        onChange={(d) => {
          setSheet(false);
          onDay(d as Dow);
        }}
      />
      {schedule ? (
        <DayTimelineVertical
          ariaLabel={t('{day}, schedule of {scope}', { day: weekdayLong(day), scope })}
          hourPx={23}
          now={day === today ? { minute: nowMinute, label: minuteToHhmm(nowMinute) } : null}
          onSelect={(i) => {
            edit.select(day, i);
            setSheet(true);
          }}
          blocks={plan.map((b, i) => {
            const p = profiles.find((x) => x.id === b.profileId);
            const name = p?.name ?? b.profileId;
            const value = targetOf(b.profileId);
            return {
              start: b.start,
              end: b.end,
              color: p?.color ?? '',
              ink: p?.ink ?? '',
              label: name,
              valueText: value != null ? fmtTemp(value) : undefined,
              rangeText: range(b.start, b.end),
              aria: `${weekdayShort(day)} ${range(b.start, b.end)}, ${name}${value != null ? `, ${fmtTemp(value)}` : ''}`,
              selected: sheet && i === edit.index,
            };
          })}
        />
      ) : (
        <Skeleton height={552} radius={12} />
      )}

      <BottomSheet
        open={sheet && Boolean(edit.block)}
        onClose={() => setSheet(false)}
        title={edit.block ? `${weekdayShort(day)} · ${edit.profile?.name ?? edit.block.profileId}` : ''}
        subtitle={schedule ? blockTargets(schedule, edit.profile, c, { short: true }) : undefined}
        footer={
          <Row gap="sm">
            <Button variant="danger" size="xl" onClick={() => (edit.remove(), setSheet(false))} disabled={!c.canEdit || !edit.canRemove}>
              {t('Delete')}
            </Button>
            <Stack grow align="stretch">
              <Button variant="primary" size="xl" fullWidth onClick={() => setSheet(false)}>
                {t('Done')}
              </Button>
            </Stack>
          </Row>
        }
      >
        {edit.block ? (
          <Stack gap="lg">
            <AutoGrid min={140} columns={2} gap="sm">
              <TimeStepper
                variant="tile"
                label={t('Start')}
                value={edit.block.start}
                text={minuteToHhmm(edit.block.start)}
                min={c.canEdit ? edit.startRange.min : edit.block.start}
                max={c.canEdit ? edit.startRange.max : edit.block.start}
                onChange={edit.setStart}
                ariaEarlier={t('30 min earlier')}
                ariaLater={t('30 min later')}
              />
              <TimeStepper
                variant="tile"
                label={t('End')}
                value={edit.block.end}
                text={minuteToHhmm(edit.block.end)}
                min={c.canEdit ? edit.endRange.min : edit.block.end}
                max={c.canEdit ? edit.endRange.max : edit.block.end}
                onChange={edit.setEnd}
                ariaEarlier={t('30 min earlier')}
                ariaLater={t('30 min later')}
              />
            </AutoGrid>
            <Section variant="plain" level={3} overline={t('Profile of the block')}>
              <Row gap="sm" wrap>
                {profiles.map((p) => (
                  <ToggleChip
                    key={p.id}
                    pressed={p.id === edit.block?.profileId}
                    icon={p.icon}
                    label={p.name}
                    onToggle={() => c.canEdit && edit.setProfile(p.id)}
                  />
                ))}
              </Row>
            </Section>
            <Section variant="plain" level={3} overline={t('Repeat on')}>
              <DayOfWeekToggle
                ariaLabel={t('Repeat on')}
                value={edit.repeat}
                labels={shortDays()}
                fullLabels={DOWS.map((d) => weekdayLong(d))}
                onChange={(v) => c.canEdit && edit.setRepeat(v as Dow[])}
              />
            </Section>
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
              setSheet(false);
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
      <Button variant="secondary" fullWidth iconRight="chevronRight" to={paths.schedulePriority()}>
        {t('Who wins when rules disagree')}
      </Button>
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
      <MobileTopBar title={t('Priority')} subtitle={{ text: t('Who wins when rules disagree') }} onBack={() => navigate(paths.scheduleProfiles())} />
      <Section subtitle={t('Frost protection and windows always come first — they cannot be moved down.')}>
        <PriorityList c={c} plain />
      </Section>
    </Stack>
  );
}
