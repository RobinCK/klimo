/**
 * Overview («Огляд»): what the house is doing now, which source runs, what needs attention and
 * how every room is — plus the house profile switch. Phones get their own layout: a summary
 * card, one attention line and compact room rows.
 */
import { useCallback, useEffect, useRef } from 'react';
import type { HouseState, PlantState, SourceDto } from '@api/model';
import { api } from '@api/endpoints';
import { useCodeContext, useHouse, useIncidents, useLayout, useLiveEvent, useMe, useNow, usePlant, useResource, useRoomSummaries, useRoomsLoaded } from '@data';
import { AutoGrid, Button, Page, ProfileTile, RowList, Row, Section, Skeleton, SourceRow, Stack, StatusBanner } from '@ui';
import { LogoMark, Wordmark } from '@brand';
import { HouseSeasonPill, InboxBell, paths } from '@app';
import { fmtDur, fmtTemp, sourceStateLabel, t } from '@i18n';
import { AttentionLine, AttentionSection } from './Attention';
import { dateLine, headline, isRunning, profileOrigin, SOURCE_ICON, subline } from './house';
import { Onboarding } from './Onboarding';
import { ProfileSwitchPanel } from './ProfileSwitchPanel';
import { RoomsList, RoomsSection } from './RoomsSection';
import { runningSummary, SystemTiles } from './SystemTiles';
import { TodaySection } from './TodaySection';
import { useProfileSwitch, type ProfileSwitch } from './useProfileSwitch';

const FIVE_MIN = 5 * 60_000;

/** Reload a resource every few minutes while the page is open (sparklines, today's spans). */
function useEvery(ms: number, reload: () => unknown): void {
  useEffect(() => {
    const id = window.setInterval(() => void reload(), ms);
    return () => window.clearInterval(id);
  }, [ms, reload]);
}

/**
 * Reload at most once per `ms`, the last call winning: a pump and its source often start
 * together, and each start or stop arrives as its own event.
 */
function useCoalesced(ms: number, reload: () => unknown): () => void {
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current != null) window.clearTimeout(timer.current);
    },
    [],
  );
  return useCallback(() => {
    if (timer.current != null) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      void reload();
    }, ms);
  }, [ms, reload]);
}

function useOverviewData() {
  const house = useHouse();
  const rooms = useRoomSummaries();
  const roomsLoaded = useRoomsLoaded();
  const plant = usePlant();
  const ctx = useCodeContext();
  const now = useNow(30_000);
  const me = useMe();
  const overview = useResource('overview', api.overview, { reloadOn: ['settings', 'room', 'source', 'notify_target'] });
  const today = useResource('today', () => api.today(), { reloadOn: ['profile', 'schedule'] });
  const date = today.data?.date ?? null;
  const plan = useResource(date ? `house-plan:${date}` : null, () => api.schedules.resolved('house', { date: date ?? undefined }), {
    reloadOn: ['schedule', 'profile', 'activation_rule'],
  });
  const sparks = useResource('room-sparks', api.rooms.sparks);
  const attention = useIncidents('attention');
  const sources = useResource('names:sources', api.sources.list, { reloadOn: ['source'] });
  const circuits = useResource('names:circuits', api.circuits.list, { reloadOn: ['circuit', 'pump'] });
  useEvery(FIVE_MIN, sparks.reload);
  useEvery(FIVE_MIN, today.reload);
  // a run span opened or closed: the timeline and the runtime bar change
  const spanChanged = useCoalesced(5_000, today.reload);
  useLiveEvent('span', spanChanged);
  return { house, rooms, roomsLoaded, plant, ctx, now, me, overview, today, plan, sparks, attention, sources, circuits };
}

type Data = ReturnType<typeof useOverviewData>;

function Desktop({ d, sw, house }: { d: Data; sw: ProfileSwitch; house: HouseState }) {
  const cooling = house.season.season === 'cooling';
  const canEdit = d.me?.canEditConfig ?? false;
  const onboarding = d.overview.data?.onboarding ?? null;
  return (
    <Page eyebrow={dateLine(d.now)} title={headline(house)} subtitle={subline(house, d.plant, d.ctx)}>
      {onboarding ? <Onboarding onboarding={onboarding} canEdit={canEdit} /> : null}
      <SystemTiles house={house} plant={d.plant} today={d.today.data ?? null} sources={d.sources.data} circuits={d.circuits.data} sw={sw} ctx={d.ctx} />
      <ProfileSwitchPanel sw={sw} house={house} ctx={d.ctx} phone={false} />
      <AttentionSection items={d.attention.data ?? []} loading={!d.attention.settled} ctx={d.ctx} now={d.now} onChanged={() => void d.attention.reload()} />
      <RoomsSection rooms={d.rooms} loaded={d.roomsLoaded} sparks={d.sparks.data} cooling={cooling} ctx={d.ctx} now={d.now} canEdit={canEdit} />
      <TodaySection
        today={d.today.data ?? null}
        house={house}
        plan={d.plan.data ?? null}
        plant={d.plant}
        profiles={sw.profiles}
        sources={d.sources.data}
        circuits={d.circuits.data}
        leadId={house.leadSourceId ?? d.plant?.lead.heat ?? d.plant?.lead.cool ?? null}
        ctx={d.ctx}
      />
    </Page>
  );
}

/** Phone «Сьогодні»: one row with the lead source's day, leading to the system page. */
function TodayRow({ d, house, sources }: { d: Data; house: HouseState; sources: readonly SourceDto[] | undefined }) {
  const plant: PlantState | null = d.plant;
  const leadId = house.leadSourceId ?? plant?.lead.heat ?? plant?.lead.cool ?? null;
  const lead = plant?.sources.find((s) => s.sourceId === leadId) ?? null;
  const today = d.today.data;
  if (!lead || !today) return null;
  const kind = sources?.find((s) => s.config.id === lead.sourceId)?.config.kind ?? 'custom';
  const stat = today.stats.perSource.find((p) => p.sourceId === lead.sourceId);
  const meta = stat && stat.cycles > 0 ? t('{count} cycles · {dur}', { count: stat.cycles, dur: fmtDur(stat.runtimeMin) }) : t('did not run today');
  return (
    <RowList ariaLabel={t('Today')}>
      <SourceRow
        icon={SOURCE_ICON[kind]}
        name={d.ctx.sourceLabel(lead.sourceId) ?? lead.sourceId}
        meta={`${t('Today')} · ${meta}`}
        chip={{ tone: lead.fault ? 'err' : lead.tone, label: sourceStateLabel(lead.state) }}
        on={isRunning(lead)}
        to={paths.system()}
      />
    </RowList>
  );
}

function Phone({ d, sw, house }: { d: Data; sw: ProfileSwitch; house: HouseState }) {
  const canEdit = d.me?.canEditConfig ?? false;
  const id = house.profile.activeProfileId;
  const profile = sw.profiles.find((p) => p.id === id);
  const running = runningSummary(d.plant, d.ctx);
  const outdoor = house.season.outdoorC;
  const line = [running, outdoor != null ? t('outdoor {t}', { t: fmtTemp(outdoor) }) : ''].filter(Boolean).join(' · ');
  return (
    <Stack gap="md">
      <Row justify="between" gap="sm">
        <Row gap="sm">
          <LogoMark size={28} />
          <Wordmark size={20} />
        </Row>
        <Row gap="xs">
          <HouseSeasonPill house={house} variant="filled" />
          <InboxBell house={house} />
        </Row>
      </Row>
      <Section title={headline(house)} subtitle={line || undefined}>
        <Section
          variant="plain"
          level={3}
          icon="home"
          title={profile ? <ProfileTile variant="inline" name={profile.name} color={profile.color} /> : (d.ctx.profile?.(id) ?? id)}
          subtitle={profileOrigin(house, d.ctx)}
          inlineAction
          action={
            <Row gap="xs" wrap justify="end">
              {sw.overridden ? (
                <Button variant="link" size="sm" onClick={sw.resume} loading={sw.resuming}>
                  {t('Back to schedule')}
                </Button>
              ) : null}
              <Button variant="secondary" size="sm" onClick={sw.openPanel}>
                {t('Change')}
              </Button>
            </Row>
          }
        />
      </Section>
      <AttentionLine items={d.attention.data ?? []} ctx={d.ctx} now={d.now} />
      <RoomsList rooms={d.rooms} loaded={d.roomsLoaded} ctx={d.ctx} now={d.now} canEdit={canEdit} />
      <TodayRow d={d} house={house} sources={d.sources.data} />
      <ProfileSwitchPanel sw={sw} house={house} ctx={d.ctx} phone />
    </Stack>
  );
}

function Loading({ phone }: { phone: boolean }) {
  return (
    <Stack gap="xl">
      <Skeleton height={phone ? 120 : 64} width={phone ? undefined : '50%'} radius={12} />
      {phone ? null : (
        <AutoGrid min={236} gap="md">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} height={170} radius={16} />
          ))}
        </AutoGrid>
      )}
      <AutoGrid min={280} gap="md">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} height={phone ? 64 : 220} radius={16} />
        ))}
      </AutoGrid>
    </Stack>
  );
}

export default function OverviewPage(): JSX.Element {
  const d = useOverviewData();
  const phone = useLayout() === 'phone';
  const sw = useProfileSwitch(d.ctx);
  const house = d.house;
  if (!house) {
    // the engine has not published a house state yet (just started, or Home Assistant is away)
    return (
      <Stack gap="lg">
        {d.overview.error && !d.overview.loading ? <StatusBanner tone="warn" icon="clock" text={t('Waiting for the first data from Home Assistant…')} /> : null}
        <Loading phone={phone} />
      </Stack>
    );
  }
  return phone ? <Phone d={d} sw={sw} house={house} /> : <Desktop d={d} sw={sw} house={house} />;
}
