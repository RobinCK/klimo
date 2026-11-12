/**
 * «Швидке налаштування»: four times of an ordinary day — waking up, leaving, coming back, going
 * to bed — for the weekdays and for the weekend, and the week's plan follows from them. It
 * replaces the plan of the shown schedule, with one undo.
 */
import { useState } from 'react';
import type { Id, ProfileDto, Schedule } from '@api/model';
import { CheckboxRow, Dialog, HOUR_AXIS_3H, ProfileStrip, ProfileTile, Row, SegmentedControl, Stack, Text, TimeStepper } from '@ui';
import { minuteToHhmm, t } from '@i18n';
import { DAY, STEP } from './blocks';
import type { ScheduleContext } from './data';
import { useTargetMode } from './DayParts';
import { planOf, type SwitchPoint } from './points';
import { scopeName, scheduleTargets, targetText } from './texts';
import type { ScheduleEditor } from './useScheduleEditor';

type Part = 'weekdays' | 'weekend';
type Key = 'wake' | 'leave' | 'back' | 'sleep';

interface Answers {
  wake: number;
  leave: number;
  back: number;
  sleep: number;
  homeAllDay: boolean;
}

const START: Record<Part, Answers> = {
  weekdays: { wake: 390, leave: 510, back: 1050, sleep: 1380, homeAllDay: false },
  weekend: { wake: 480, leave: 600, back: 1080, sleep: 1410, homeAllDay: true },
};

/** The profiles the answers switch to: home, away and night (eco, then home, where one is missing). */
function roles(profiles: readonly ProfileDto[]) {
  const by = (id: Id) => profiles.find((p) => p.id === id) ?? null;
  const home = by('home') ?? profiles[0] ?? null;
  return { home, away: by('away'), night: by('night') ?? by('eco') ?? home };
}

function pointsFor(a: Answers, r: ReturnType<typeof roles>): SwitchPoint[] {
  if (!r.home || !r.night) return [];
  const out: SwitchPoint[] = [{ minute: a.wake, profileId: r.home.id }];
  if (!a.homeAllDay && r.away) out.push({ minute: a.leave, profileId: r.away.id }, { minute: a.back, profileId: r.home.id });
  out.push({ minute: a.sleep, profileId: r.night.id });
  return out;
}

export function QuickSetup({
  c,
  editor,
  schedule,
  onApplied,
  onClose,
}: {
  c: ScheduleContext;
  editor: ScheduleEditor;
  schedule: Schedule;
  onApplied: () => void;
  onClose: () => void;
}) {
  const [part, setPart] = useState<Part>('weekdays');
  const [answers, setAnswers] = useState<Record<Part, Answers>>(START);
  const [mode] = useTargetMode(c);
  const profiles = c.profiles.data ?? [];
  const r = roles(profiles);
  const a = answers[part];
  const out = !a.homeAllDay && r.away != null;
  const set = (patch: Partial<Answers>) => setAnswers((prev) => ({ ...prev, [part]: { ...prev[part], ...patch } }));

  // each time stays between its neighbours, a step apart
  const order: Key[] = out ? ['wake', 'leave', 'back', 'sleep'] : ['wake', 'sleep'];
  const bounds = (k: Key) => {
    const i = order.indexOf(k);
    return { min: i > 0 ? a[order[i - 1]] + STEP : 0, max: i < order.length - 1 ? a[order[i + 1]] - STEP : DAY - STEP };
  };
  const rows: { key: Key; label: string; profile: ProfileDto | null }[] = [
    { key: 'wake', label: t('I wake up'), profile: r.home },
    ...(out
      ? [
          { key: 'leave' as const, label: t('I leave home'), profile: r.away },
          { key: 'back' as const, label: t('I come back'), profile: r.home },
        ]
      : []),
    { key: 'sleep', label: t('I go to bed'), profile: r.night },
  ];
  const preview = planOf(pointsFor(a, r));

  const apply = () => {
    const weekdays = planOf(pointsFor(answers.weekdays, r));
    const weekend = planOf(pointsFor(answers.weekend, r));
    if (!weekdays.length || !weekend.length) return;
    editor.editDays(
      [
        { dow: 0, plan: weekdays, also: [1, 2, 3, 4] },
        { dow: 5, plan: weekend, also: [6] },
      ],
      t('The schedule follows your answers now'),
    );
    onApplied();
    onClose();
  };

  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title={t('Quick setup')}
      actions={[
        { label: t('Cancel'), onClick: onClose, variant: 'secondary' },
        { label: t('Create the schedule'), onClick: apply, disabled: !r.home },
      ]}
    >
      <Stack gap="lg">
        <Text>{t('Tell how an ordinary day goes, and the schedule follows. Any change can be adjusted afterwards.')}</Text>
        <SegmentedControl<Part>
          full
          ariaLabel={t('Which days')}
          value={part}
          options={[
            { value: 'weekdays', label: t('Weekdays · Mon–Fri') },
            { value: 'weekend', label: t('Weekends · Sat–Sun') },
          ]}
          onChange={setPart}
        />
        <Stack gap="md">
          {rows.map((row) => {
            const b = bounds(row.key);
            return (
              <Row key={row.key} gap="lg" align="end" wrap>
                <TimeStepper
                  label={row.label}
                  value={a[row.key]}
                  text={minuteToHhmm(a[row.key])}
                  min={b.min}
                  max={b.max}
                  step={STEP}
                  onChange={(m) => set({ [row.key]: m } as Partial<Answers>)}
                  ariaEarlier={t('15 min earlier')}
                  ariaLater={t('15 min later')}
                />
                {row.profile ? (
                  <ProfileTile
                    variant="inline"
                    name={row.profile.name}
                    color={row.profile.color}
                    ink={row.profile.ink}
                    icon={row.profile.icon}
                    value={targetText(scheduleTargets(schedule, row.profile), mode)}
                  />
                ) : null}
              </Row>
            );
          })}
        </Stack>
        {r.away ? (
          <CheckboxRow
            checked={a.homeAllDay}
            title={t('Someone stays at home during the day')}
            hint={t('Then no «{away}»: «{home}» from waking up to bedtime.', { away: r.away.name, home: r.home?.name ?? '' })}
            onChange={(v) => {
              // leaving and coming back stay between waking up and bedtime, which moved meanwhile
              const leave = Math.min(Math.max(a.leave, a.wake + STEP), a.sleep - 2 * STEP);
              set({ homeAllDay: v, leave, back: Math.min(Math.max(a.back, leave + STEP), a.sleep - STEP) });
            }}
          />
        ) : null}
        <Stack gap="xs">
          <Text variant="caption">{t('An ordinary day will look like this')}</Text>
          <ProfileStrip
            height={26}
            ariaLabel={part === 'weekdays' ? t('Weekdays') : t('Weekends')}
            axis={HOUR_AXIS_3H}
            segments={preview.map((blk) => {
              const p = profiles.find((x) => x.id === blk.profileId);
              return { start: blk.start, end: blk.end, color: p?.color ?? '', ink: p?.ink, label: p?.name ?? blk.profileId };
            })}
          />
        </Stack>
        <Text variant="caption">{t('It replaces the weekly plan of «{scope}».', { scope: scopeName(schedule, c.rooms, c.ctx) })}</Text>
      </Stack>
    </Dialog>
  );
}
