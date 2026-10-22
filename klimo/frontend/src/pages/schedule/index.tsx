/**
 * Schedule & profiles («Розклад»): which targets every profile gives the rooms, when each
 * profile is in force (the weekly schedule, rules that switch it on by themselves, dated
 * exceptions) and who wins when rules disagree. Wide screens show it all on one page; phones
 * get the day view, with profiles and priority as their own screens.
 */
import { useEffect, useMemo } from 'react';
import type { Dow, Id } from '@api/model';
import { api } from '@api/endpoints';
import { useLayout, useResource } from '@data';
import { navigate, paths, usePref, useRoute } from '@app';
import { Page, Section, Skeleton, Split, Stack, StatusBanner } from '@ui';
import { t, zonedParts } from '@i18n';
import { indexAt } from './blocks';
import { useScheduleContext } from './data';
import { PhoneDay, PhonePriority, PhoneProfile, PhoneProfiles } from './Phone';
import { PriorityList } from './Priority';
import { ProfileEditor } from './ProfileEditor';
import { ProfileItems } from './Profiles';
import { useBlockEdit } from './useBlockEdit';
import { useScheduleEditor } from './useScheduleEditor';
import { WeekSchedule } from './WeekSchedule';

export default function SchedulePage(): JSX.Element {
  const route = useRoute();
  const phone = useLayout() === 'phone';
  const c = useScheduleContext();
  const [selectedId, setSelectedId] = usePref<Id>('schedule.profile', 'home');

  // the profile and priority addresses are separate screens on phones only
  useEffect(() => {
    if (phone) return;
    if (route.name === 'scheduleProfile' && route.params.id) setSelectedId(route.params.id);
    if (route.name === 'scheduleProfile' || route.name === 'scheduleProfiles' || route.name === 'schedulePriority') {
      navigate(paths.schedule(), { replace: true, force: true });
    }
  }, [phone, route.name, route.params.id, setSelectedId]);

  // whose schedule and which day come from the address, so they can be shared
  const now = zonedParts(c.now);
  const today = now.dow;
  const scope = route.query.scope ?? 'house';
  const queryDay = Number(route.query.day);
  const day: Dow = Number.isInteger(queryDay) && queryDay >= 0 && queryDay <= 6 ? (queryDay as Dow) : today;

  const scheduleList = useResource('schedules', api.schedules.list, { reloadOn: ['schedule', 'profile'] }).data ?? [];
  const scheduleId = useMemo(() => {
    const s = scope === 'house' ? scheduleList.find((x) => x.scope === 'house') : scheduleList.find((x) => x.roomId === scope || x.id === scope);
    return s?.id ?? scheduleList.find((x) => x.scope === 'house')?.id ?? null;
  }, [scheduleList, scope]);
  const editor = useScheduleEditor(scheduleId);
  const edit = useBlockEdit(editor, c.profiles.data ?? [], { dow: day, minute: day === today ? now.minuteOfDay : 12 * 60 });

  const goScope = (id: Id) => {
    void editor.flush();
    const s = editor.schedules.find((x) => x.id === id);
    navigate(paths.schedule({ scope: s?.scope === 'room' && s.roomId ? s.roomId : undefined, day: route.query.day ? day : undefined }), { replace: true });
  };
  const goDay = (d: Dow) => {
    const plan = editor.schedule?.days[d] ?? [];
    edit.select(d, plan.length ? indexAt(plan, d === today ? now.minuteOfDay : 12 * 60) : 0);
    navigate(paths.schedule({ scope: scope === 'house' ? undefined : scope, day: d === today ? undefined : d }), { replace: true });
  };

  const loading = !c.profiles.settled || !editor.resource.settled;
  const failed = c.profiles.error && !c.profiles.data;

  if (phone) {
    if (route.name === 'scheduleProfiles') return <PhoneProfiles c={c} />;
    if (route.name === 'schedulePriority') return <PhonePriority c={c} />;
    if (route.name === 'scheduleProfile') return <PhoneProfile c={c} id={route.params.id ?? ''} schedules={editor.schedules} />;
    return <PhoneDay c={c} editor={editor} edit={edit} today={today} nowMinute={now.minuteOfDay} onScope={goScope} onDay={goDay} />;
  }

  const selected = c.profileById(selectedId) ?? c.profiles.data?.[0] ?? null;
  return (
    <Page
      title={t('Schedule & profiles')}
      subtitle={t('A profile sets the rooms’ targets. The schedule, presence and the calendar decide when which profile is in force.')}
    >
      {failed ? (
        <StatusBanner
          tone="err"
          icon="alert"
          text={t('Could not load the profiles.')}
          action={{ label: t('Retry'), onClick: () => void c.profiles.reload() }}
        />
      ) : null}
      {loading ? (
        <Stack gap="lg">
          <Skeleton height={520} radius={20} />
          <Skeleton height={420} radius={20} />
        </Stack>
      ) : (
        <>
          <Split
            asideFirst
            asideBasis={320}
            mainBasis={640}
            aside={
              <Stack gap="lg">
                <Section variant="plain" title={t('Profiles')}>
                  <ProfileItems c={c} selectedId={selected?.id ?? null} onSelect={setSelectedId} />
                </Section>
                <PriorityList c={c} />
              </Stack>
            }
            main={selected ? <ProfileEditor key={selected.id} c={c} profile={selected} schedules={editor.schedules} onSelect={setSelectedId} /> : null}
          />
          <WeekSchedule c={c} editor={editor} edit={edit} today={today} nowMinute={now.minuteOfDay} onScope={goScope} />
        </>
      )}
    </Page>
  );
}
