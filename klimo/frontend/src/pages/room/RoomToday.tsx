import { useEffect, useMemo, useRef, useState } from 'react';
import type { EpochMs, LocalDate, ProfileDto, RoomDayDto, RoomDetailDto, RoomState } from '@api/model';
import { api } from '@api/endpoints';
import { liveStore, useLive, useLiveEvent, useResource, useRetryUntilComplete, type ResourceState } from '@data';
import { AutoGrid, DayChart, ProfileStrip, Skeleton, Stack, StatTile, type ProfileStripSegment } from '@ui';
import { displayUnits, fmtDur, fmtRate, startOfLocalDay, t, zonedParts } from '@i18n';
import { appendLive, dayShown, liveDay, type LivePoint } from './dayLive';
import { atText } from './texts';

const DAY_MS = 86_400_000;
const FIVE_MIN = 5 * 60_000;
/** A kept day older than this is read again when the page shows it (opened again, tab back, phone awake). */
const STALE_MS = 60_000;

/** Values the chart draws as given: in °F when the display unit says so. */
function shown(c: number | null): number | null {
  if (c == null) return null;
  return displayUnits() === 'F' ? (c * 9) / 5 + 32 : c;
}
const scale = (d: number) => (displayUnits() === 'F' ? (d * 9) / 5 : d);

/** Today's profile blocks for this room, with the manual change on top (hatched). */
export function stripSegments(room: RoomDetailDto, profiles: readonly ProfileDto[] | undefined, now: EpochMs): ProfileStripSegment[] {
  const byId = new Map((profiles ?? []).map((p) => [p.id, p] as const));
  const segs: ProfileStripSegment[] = room.thermostat.strip.map(([start, end, id]) => {
    const p = byId.get(id);
    return { start, end, color: p?.color ?? 'var(--ui-dot)', ink: p?.ink, label: p?.name };
  });
  const o = room.thermostat.override;
  if (o && (o.kind === 'room_target' || o.kind === 'room_boost' || o.kind === 'room_profile')) {
    const nowMin = zonedParts(now).minuteOfDay;
    const endMin = o.until == null || o.until - startOfLocalDay(now) >= DAY_MS ? 1440 : zonedParts(o.until).minuteOfDay;
    const cur = segs.find((s) => s.start <= nowMin && s.end > nowMin);
    if (endMin > nowMin) segs.push({ start: nowMin, end: endMin, color: cur?.color ?? 'var(--ui-dot)', ink: cur?.ink, override: true });
  }
  return segs;
}

/**
 * Keeps the day current while the page is open: every 5 min, again when it was kept from an earlier
 * visit, after midnight, when Home Assistant reconnects, when the tab comes back — and shortly after
 * an answer the server could not complete yet (the add-on had just started).
 */
function useDayRefresh(day: ResourceState<RoomDayDto>, today: LocalDate): void {
  const { data, reload } = day;
  const dataRef = useRef(data);
  dataRef.current = data;
  const stale = () => {
    const d = dataRef.current;
    return !!d && (d.date !== today || liveStore.now() - d.asOf > STALE_MS);
  };
  const staleRef = useRef(stale);
  staleRef.current = stale;

  useEffect(() => {
    if (staleRef.current()) void reload();
    const timer = window.setInterval(() => void reload(), FIVE_MIN);
    const onVisible = () => {
      if (document.visibilityState === 'visible' && staleRef.current()) void reload();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [reload]);

  // midnight passed: once per new day (a server on another date must not make it loop)
  const rolled = useRef<LocalDate | null>(null);
  useEffect(() => {
    if (!data || data.date === today || rolled.current === today) return;
    rolled.current = today;
    void reload();
  }, [data, today, reload]);

  const haConnected = useLive((s) => s.ha?.connected ?? s.house?.engine.haConnected ?? null);
  const prevHa = useRef(haConnected);
  useEffect(() => {
    if (haConnected && prevHa.current === false) void reload();
    prevHa.current = haConnected;
  }, [haConnected, reload]);

  useRetryUntilComplete(day, (d) => d.complete === false);
}

/** The room's readings from the live socket since the page opened (the chart continues the day with them). */
function useLiveReadings(state: RoomState): readonly LivePoint[] {
  const [kept, setKept] = useState<{ roomId: string; points: readonly LivePoint[] }>({ roomId: state.roomId, points: [] });
  useEffect(() => {
    setKept((k) => {
      const points = k.roomId === state.roomId ? k.points : [];
      const next = appendLive(points, state.updatedAt, state.tempC);
      return next === points && k.roomId === state.roomId ? k : { roomId: state.roomId, points: next };
    });
  }, [state.roomId, state.updatedAt, state.tempC]);
  return kept.roomId === state.roomId ? kept.points : [];
}

/** «Сьогодні»: the profile strip, the temperature against the target band, and four numbers. */
export function RoomToday({
  room,
  state,
  profiles,
  now,
  compact,
}: {
  room: RoomDetailDto;
  state: RoomState;
  profiles: readonly ProfileDto[] | undefined;
  now: EpochMs;
  compact?: boolean;
}) {
  const id = room.config.id;
  const day = useResource(`room-day:${id}`, () => api.rooms.day(id), { reloadOn: ['override', 'profile_room', 'schedule', 'profile', 'room'] });
  const { reload } = day;
  const today = zonedParts(now).date;
  useDayRefresh(day, today);
  // a heating span of this room started or ended
  useLiveEvent('span', (s) => {
    if (s.subject === 'room' && s.subjectId === id) void reload();
  });
  const live = useLiveReadings(state);

  const dayStart = startOfLocalDay(now);
  const dayEnd = startOfLocalDay(dayStart + 1.5 * DAY_MS);
  const lastComplete = useRef<RoomDayDto | undefined>(undefined);
  if (day.data && day.data.complete !== false) lastComplete.current = day.data;
  // a day read before midnight is not drawn on today's axis
  const fetched = dayShown(day.data, lastComplete.current, id, today);
  const merged = useMemo(() => (fetched ? liveDay(fetched, live, state.tempC, now, dayEnd) : null), [fetched, live, state.tempC, now, dayEnd]);
  // until the recorder answers, the minutes Klimo kept itself are no day's minimum or maximum
  const loading = !fetched || fetched.complete === false;
  const d = fetched && merged ? { ...fetched, ...merged, stats: loading ? { ...merged.stats, min: null, max: null } : merged.stats } : undefined;
  const hasLine = !!d && d.series.some(([, c]) => c != null);
  const emptyText = loading ? t('Loading the temperature history…') : hasLine ? undefined : t('No temperature history for today yet');
  const tol = room.config.tolerance;
  const cooled = (d?.stats.cooledMin ?? 0) > (d?.stats.heatedMin ?? 0);
  const roomName = room.config.name;
  const aria = d
    ? t('Temperature in {room} today: from {min} to {max}; {mode} for {dur}.', {
        room: roomName,
        min: atText(d.stats.min),
        max: atText(d.stats.max),
        mode: cooled ? t('cooled') : t('heated'),
        dur: fmtDur(cooled ? d.stats.cooledMin : d.stats.heatedMin),
      })
    : t('Temperature in {room} today', { room: roomName });
  const segments = stripSegments(room, profiles, now);
  // only the bands of the modes the room works in now: a summer cooling target is noise in January
  const coolShown = state.activeModes.cool;
  const heatShown = state.activeModes.heat || !coolShown;
  return (
    <Stack gap="md">
      {segments.length ? (
        <ProfileStrip segments={segments} now={zonedParts(now).minuteOfDay} height={compact ? 22 : 26} ariaLabel={t('Profiles today')} />
      ) : null}
      {d || day.data ? (
        <DayChart
          title={compact ? undefined : t('Today')}
          series={(d?.series ?? []).map(([ts, c]) => ({ t: ts, c: shown(c) }))}
          targets={(d?.targetSegments ?? []).map((s) => ({
            from: s.from,
            to: s.to,
            heat: heatShown ? shown(s.heatC) : null,
            cool: coolShown ? shown(s.coolC) : null,
            future: s.future,
          }))}
          spans={(d?.demandSpans ?? []).map((s) => ({ from: s.from, to: s.to, tone: s.mode }))}
          humidity={(d?.humidity ?? []).map(([ts, v]) => ({ t: ts, pct: v }))}
          now={now}
          dayStart={dayStart}
          dayEnd={dayEnd}
          tol={{ heat: { below: scale(tol.heat.below), above: scale(tol.heat.above) }, cool: { below: scale(tol.cool.below), above: scale(tol.cool.above) } }}
          legend={{ temperature: t('temperature'), target: t('target ± tolerance'), future: t('scheduled ahead'), heat: t('heated'), cool: t('cooled'), humidity: t('humidity') }}
          ariaLabel={aria}
          unitText={displayUnits() === 'F' ? '°F' : '°'}
          emptyText={emptyText}
        />
      ) : (
        <Skeleton height={compact ? 180 : 240} radius={12} />
      )}
      {d ? (
        <AutoGrid min={150} gap="sm">
          <StatTile variant="well" title={cooled ? t('Cooled today') : t('Heated today')} value={fmtDur(cooled ? d.stats.cooledMin : d.stats.heatedMin)} />
          <StatTile variant="well" title={t('Minimum')} value={atText(d.stats.min)} />
          <StatTile variant="well" title={t('Maximum')} value={atText(d.stats.max)} />
          <StatTile
            variant="well"
            title={cooled ? t('Cooling speed') : t('Warming speed')}
            hint={
              cooled
                ? t('How many degrees an hour the room loses while it is cooled, learned from its recent runs.')
                : t('How many degrees an hour the room gains while it is heated, learned from its recent warm-ups. Optimal start uses it to begin early enough before a warmer slot.')
            }
            value={`≈ ${fmtRate(Math.abs(d.stats.rateCPerH ?? (cooled ? room.thermostat.rate.cool : room.thermostat.rate.heat)), { sign: false })}`}
          />
        </AutoGrid>
      ) : null}
    </Stack>
  );
}
