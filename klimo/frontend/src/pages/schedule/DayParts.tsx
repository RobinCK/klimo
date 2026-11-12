/**
 * Parts of the day editor shared by the wide screen and the phone: which target the chart shows,
 * the «now» line with «today like a weekend», the editor of one change, the chart itself and the
 * house's plan under a room schedule for comparison.
 */
import { useState } from 'react';
import type { Dow, Id, Schedule } from '@api/model';
import { api } from '@api/endpoints';
import { useMutation, useResource } from '@data';
import { usePref } from '@app';
import {
  Button,
  DayOfWeekToggle,
  Dialog,
  ProfileChoice,
  ProfileStrip,
  Row,
  ScheduleDayChart,
  ScheduleNowBar,
  Section,
  SegmentedControl,
  Stack,
  Text,
  TimeStepper,
} from '@ui';
import { fmtTemp, minuteToHhmm, t, weekdayLong } from '@i18n';
import { DOWS, STEP } from './blocks';
import type { ScheduleContext } from './data';
import { localDate } from './dates';
import { pointAt, pointsOf, untilOf, type DayType } from './points';
import { scheduleTargets, shortDays, targetText } from './texts';
import type { DayEdit } from './useDayEdit';
import { dayView, todayPlan, typeTitle, type TargetMode } from './view';

/** Heating or cooling targets on the chart; the season decides until the user picks. */
export function useTargetMode(c: ScheduleContext): [TargetMode, (m: TargetMode) => void] {
  return usePref<TargetMode>('schedule.mode', c.house?.season.season === 'cooling' ? 'cool' : 'heat');
}

export function TargetModeSwitch({ value, onChange, full }: { value: TargetMode; onChange: (m: TargetMode) => void; full?: boolean }) {
  return (
    <SegmentedControl<TargetMode>
      full={full}
      ariaLabel={t('Which target to show')}
      value={value}
      options={[
        { value: 'heat', label: t('Heating targets'), icon: 'flame' },
        { value: 'cool', label: t('Cooling targets'), icon: 'snow' },
      ]}
      onChange={onChange}
    />
  );
}

/** What the schedule gives right now, what comes next, and «today like a weekend». */
export function ScheduleNow({ c, schedule, today, nowMinute, mode }: { c: ScheduleContext; schedule: Schedule; today: Dow; nowMinute: number; mode: TargetMode }) {
  const exceptions = useResource(`schedule-exceptions:${schedule.id}`, () => api.schedules.exceptions(schedule.id), { reloadOn: ['schedule'] });
  const date = localDate(c.now);
  const exception = exceptions.data?.find((e) => e.date === date) ?? null;
  const profiles = c.profiles.data ?? [];
  const byId = (id: string) => profiles.find((p) => p.id === id) ?? null;
  const points = pointsOf(todayPlan(schedule.days, today, exception));
  const weekend: Dow = 5;
  const asWeekend = useMutation(() => api.schedules.setException(schedule.id, date, { plan: { likeDow: weekend }, note: null }), {
    onSuccess: () => void exceptions.reload(),
    okToast: t('Today runs like {day}', { day: weekdayLong(weekend).toLowerCase() }),
  });
  const back = useMutation(() => api.schedules.removeException(schedule.id, date), {
    onSuccess: () => void exceptions.reload(),
    okToast: t('Today follows the week again'),
  });
  if (!points.length) return null;
  const i = pointAt(points, nowMinute);
  const cur = points[i];
  const profile = byId(cur.profileId);
  const more = points.length > 1;
  const next = points[(i + 1) % points.length];
  const nextProfile = byId(next.profileId);
  const note = exception
    ? 'likeDow' in exception.plan
      ? t('Today runs like {day}.', { day: weekdayLong(exception.plan.likeDow).toLowerCase() })
      : t('Today has its own plan.')
    : undefined;
  const canWeekend = !exception && today < 5;
  const action = !c.canEdit ? undefined : exception ? (
    <Button variant="ghost" size="sm" icon="undo" loading={back.pending} onClick={() => void back.run()}>
      {t('Back to the week')}
    </Button>
  ) : canWeekend ? (
    <Button variant="secondary" size="sm" icon="calendar" loading={asWeekend.pending} onClick={() => void asWeekend.run()}>
      {t('Today like a weekend')}
    </Button>
  ) : undefined;
  return (
    <ScheduleNowBar
      label={t('By the schedule now · {time}', { time: minuteToHhmm(nowMinute) })}
      name={profile?.name ?? cur.profileId}
      color={profile?.color ?? ''}
      valueText={targetText(scheduleTargets(schedule, profile), mode)}
      tone={mode}
      untilText={more ? t('until {time}', { time: minuteToHhmm(untilOf(points, i).minute) }) : t('all day')}
      nextText={more ? t('then {profile} {target}', { profile: nextProfile?.name ?? next.profileId, target: targetText(scheduleTargets(schedule, nextProfile), mode) }) : undefined}
      note={note}
      action={action}
    />
  );
}

/** The profile a drag over the chart paints with: a tap picks it, a second tap puts it away. */
export function BrushPicker({
  c,
  schedule,
  mode,
  brush,
  onBrush,
  compact,
}: {
  c: ScheduleContext;
  schedule: Schedule;
  mode: TargetMode;
  brush: Id | null;
  onBrush: (id: Id | null) => void;
  /** A phone: one row that scrolls sideways, and the hint only while a profile is picked. */
  compact?: boolean;
}) {
  const profiles = c.profiles.data ?? [];
  const name = profiles.find((p) => p.id === brush)?.name;
  const hint = name
    ? t('Drag over the chart to paint «{profile}» there; tap it again to stop.', { profile: name })
    : compact
      ? undefined
      : t('Pick a profile and drag over the chart. Without one, drag a line to move a change or a stretch to move it whole.');
  return (
    <Section variant="plain" level={3} overline={t('Draw a stretch')} subtitle={hint}>
      <ProfileChoice
        ariaLabel={t('Profile to draw with')}
        value={brush ?? ''}
        tone={mode}
        layout={compact ? 'scroll' : 'chips'}
        options={profiles.map((x) => ({ value: x.id, name: x.name, color: x.color, valueText: targetText(scheduleTargets(schedule, x), mode) }))}
        onChange={(id) => onBrush(id === brush ? null : id)}
      />
    </Section>
  );
}

/** The chart of the shown day type. */
export function DayChart({
  c,
  schedule,
  edit,
  mode,
  today,
  nowMinute,
  brush,
}: {
  c: ScheduleContext;
  schedule: Schedule;
  edit: DayEdit;
  mode: TargetMode;
  today: Dow;
  nowMinute: number;
  brush: Id | null;
}) {
  const type = edit.type;
  if (!type) return null;
  const brushProfile = c.profileById(brush);
  const isToday = type.days.includes(today);
  const view = dayView(edit.points, c.profiles.data ?? [], schedule, mode, edit.index, isToday ? nowMinute : null);
  return (
    <ScheduleDayChart
      ariaLabel={t('{days}: the target through the day', { days: typeTitle(type.days).name })}
      segments={view.segments}
      points={view.chartPoints}
      tone={mode}
      now={isToday ? { minute: nowMinute, label: minuteToHhmm(nowMinute) } : null}
      onSelect={(i) => edit.select(i === edit.index ? -1 : i)}
      onMove={c.canEdit ? edit.move : undefined}
      range={edit.range}
      onShift={c.canEdit ? edit.shift : undefined}
      shiftRange={edit.shiftRange}
      brush={c.canEdit && brushProfile ? { color: brushProfile.color } : null}
      onPaint={brushProfile ? (a, b) => edit.paint(a, b, brushProfile.id) : undefined}
      step={STEP}
      formatMinute={minuteToHhmm}
      formatValue={(v) => fmtTemp(v, { decimals: 0 })}
    />
  );
}

/** The editor of change `index`: its time, its profile, and deleting it. */
export function PointEditor({ c, schedule, edit, index, mode, layout = 'chips' }: { c: ScheduleContext; schedule: Schedule; edit: DayEdit; index: number; mode: TargetMode; layout?: 'chips' | 'list' }) {
  const p = edit.points[index];
  const type = edit.type;
  if (!p || !type) return null;
  const r = edit.range(index);
  const until = untilOf(edit.points, index);
  const disabled = !c.canEdit;
  const profiles = c.profiles.data ?? [];
  return (
    <Stack gap="lg">
      <Row gap="xl" wrap align="center">
        <TimeStepper
          label={t('Starts at')}
          value={p.minute}
          text={minuteToHhmm(p.minute)}
          min={disabled ? p.minute : r.min}
          max={disabled ? p.minute : r.max}
          step={STEP}
          variant={layout === 'list' ? 'tile' : 'inline'}
          onChange={(m) => edit.move(index, m)}
          ariaEarlier={t('15 min earlier')}
          ariaLater={t('15 min later')}
        />
        {edit.points.length > 1 ? (
          <Text variant="caption">
            {until.nextDay
              ? t('It holds until {time} the next day, where the next change starts.', { time: minuteToHhmm(until.minute) })
              : t('It holds until {time}, where the next change starts.', { time: minuteToHhmm(until.minute) })}
          </Text>
        ) : null}
      </Row>
      <Section variant="plain" level={3} overline={t('Profile')}>
        <ProfileChoice
          ariaLabel={t('Profile of the change')}
          value={p.profileId}
          tone={mode}
          layout={layout}
          disabled={disabled}
          options={profiles.map((x) => ({
            value: x.id,
            name: x.name,
            color: x.color,
            valueText: targetText(scheduleTargets(schedule, x), mode),
          }))}
          onChange={(id) => edit.setProfile(index, id)}
        />
      </Section>
      <Row gap="md" wrap align="center" justify="between">
        <Text variant="caption">
          {type.days.length > 1
            ? t('Changes on every day of «{type}». To change one day alone, take it out of the type above.', { type: typeTitle(type.days).name })
            : t('Changes on this day only.')}
        </Text>
        {layout === 'chips' && c.canEdit ? (
          <Button variant="ghost" icon="trash" disabled={!edit.canRemove} onClick={() => edit.remove(index)}>
            {t('Delete the change')}
          </Button>
        ) : null}
      </Row>
    </Stack>
  );
}

/** Under a room schedule: the house's plan on the same days, to see what the room does its own way. */
export function HouseComparison({ house, type, c }: { house: Schedule | null; type: DayType | null; c: ScheduleContext }) {
  if (!house || !type) return null;
  const profiles = c.profiles.data ?? [];
  const plan = house.days[type.days[0]] ?? [];
  return (
    <Stack gap="xs">
      <Text variant="caption">{t('The whole house on these days, for comparison')}</Text>
      <ProfileStrip
        ariaLabel={t('Whole house')}
        axis={null}
        segments={plan.map((b) => {
          const p = profiles.find((x) => x.id === b.profileId);
          return { start: b.start, end: b.end, color: p?.color ?? '', ink: p?.ink, label: p?.name ?? b.profileId };
        })}
      />
    </Stack>
  );
}

/**
 * The days under the shown type: a day switched on joins it; a day switched off becomes a type of
 * its own while the view stays on this type.
 */
export function toggleDays(edit: DayEdit, onDay: (dow: Dow) => void) {
  return (next: number[]) => {
    const type = edit.type;
    if (!type) return;
    const added = next.find((d) => !type.days.includes(d as Dow));
    const removed = type.days.find((d) => !next.includes(d));
    if (added != null) edit.join(added as Dow);
    else if (removed != null) {
      edit.detach(removed);
      // the shown day was the one taken out: show the rest of the type
      if (removed === edit.day) onDay(type.days.find((d) => d !== removed) ?? removed);
    }
  };
}

/** «Новий тип днів»: pick the days (a pair such as Saturday and Sunday) that get one plan together. */
export function NewDayType({ edit, onCreated, onClose }: { edit: DayEdit; onCreated: (first: Dow) => void; onClose: () => void }) {
  const [chosen, setChosen] = useState<number[]>([]);
  const first = [...chosen].sort((a, b) => a - b)[0] as Dow | undefined;
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('New day type')}
      actions={[
        { label: t('Cancel'), onClick: onClose, variant: 'secondary' },
        {
          label: t('Create'),
          disabled: !chosen.length,
          onClick: () => {
            edit.create(chosen as Dow[]);
            if (first != null) onCreated(first);
            onClose();
          },
        },
      ]}
    >
      <Stack gap="md">
        <Text>{t('Pick the days that run on one plan, for example Saturday and Sunday. They leave the types they are in now.')}</Text>
        <DayOfWeekToggle ariaLabel={t('Days of the new type')} value={chosen} labels={shortDays()} fullLabels={DOWS.map((d) => weekdayLong(d))} onChange={setChosen} />
        {first != null && chosen.length > 1 ? (
          <Text variant="caption">{t('They all take the plan of {day}; change it afterwards.', { day: weekdayLong(first).toLowerCase() })}</Text>
        ) : null}
      </Stack>
    </Dialog>
  );
}
