/**
 * Schedule & profiles («Розклад»): when each profile is in force (the weekly schedule as day
 * types and their changes, rules that switch it on by themselves, dated exceptions), which
 * targets every profile gives the rooms, and who wins when rules disagree. Three tabs, each its
 * own address — the schedule, the profiles, the priority — on wide screens and phones alike.
 */
import { useEffect, useMemo } from 'react';
import type { Dow, Id } from '@api/model';
import { api } from '@api/endpoints';
import { useLayout, useResource } from '@data';
import { navigate, paths, usePref, useRoute } from '@app';
import { Page, Section, Skeleton, Split, Stack, StatusBanner, SubNav } from '@ui';
import { t, zonedParts } from '@i18n';
import { useScheduleContext } from './data';
import { DaySchedule } from './DaySchedule';
import { PhoneDay, PhonePriority, PhoneProfile, PhoneProfiles } from './Phone';
import { PriorityList } from './Priority';
import { ProfileEditor } from './ProfileEditor';
import { ProfileItems } from './Profiles';
import { useDayEdit } from './useDayEdit';
import { useScheduleEditor } from './useScheduleEditor';

type Tab = 'schedule' | 'profiles' | 'priority';

function ScheduleNav({ current }: { current: Tab }) {
  return (
    <SubNav
      ariaLabel={t('Schedule sections')}
      current={current}
      items={[
        { key: 'schedule', label: t('Schedule'), to: paths.schedule() },
        { key: 'profiles', label: t('Profiles'), to: paths.scheduleProfiles() },
        { key: 'priority', label: t('Priority'), to: paths.schedulePriority() },
      ]}
    />
  );
}

export default function SchedulePage(): JSX.Element {
  const route = useRoute();
  const phone = useLayout() === 'phone';
  const c = useScheduleContext();
  const [selectedId, setSelectedId] = usePref<Id>('schedule.profile', 'home');

  // the profile in the address is the open one; the profiles tab without one opens the last
  const routeProfile = route.name === 'scheduleProfile' ? route.params.id : undefined;
  useEffect(() => {
    if (routeProfile) setSelectedId(routeProfile);
  }, [routeProfile, setSelectedId]);
  const tab: Tab = route.name === 'schedulePriority' ? 'priority' : route.name === 'scheduleProfiles' || route.name === 'scheduleProfile' ? 'profiles' : 'schedule';
  const selectProfile = (id: Id) => {
    setSelectedId(id);
    navigate(paths.scheduleProfile(id), { replace: true });
  };
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
  const edit = useDayEdit(editor, c.profiles.data ?? [], day);

  const goScope = (id: Id) => {
    void editor.flush();
    const s = editor.schedules.find((x) => x.id === id);
    navigate(paths.schedule({ scope: s?.scope === 'room' && s.roomId ? s.roomId : undefined, day: route.query.day ? day : undefined }), { replace: true });
  };
  const goDay = (d: Dow) => {
    edit.select(-1);
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

  const selected = c.profileById(routeProfile ?? selectedId) ?? c.profiles.data?.[0] ?? null;
  return (
    <Page
      title={t('Schedule & profiles')}
      subtitle={t('A profile sets the rooms’ targets. The schedule, presence and the calendar decide when which profile is in force.')}
      actions={<ScheduleNav current={tab} />}
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
        </Stack>
      ) : tab === 'schedule' ? (
        <DaySchedule c={c} editor={editor} edit={edit} today={today} nowMinute={now.minuteOfDay} onScope={goScope} onDay={goDay} />
      ) : tab === 'profiles' ? (
        <Split
          asideFirst
          asideBasis={320}
          mainBasis={640}
          aside={
            <Section variant="plain" title={t('Profiles')}>
              <ProfileItems c={c} selectedId={selected?.id ?? null} onSelect={selectProfile} />
            </Section>
          }
          main={selected ? <ProfileEditor key={selected.id} c={c} profile={selected} schedules={editor.schedules} onSelect={selectProfile} /> : null}
        />
      ) : (
        <PriorityList c={c} />
      )}
    </Page>
  );
}
