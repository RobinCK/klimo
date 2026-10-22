import { useEffect } from 'react';
import type { EpochMs, ProfileDto, RoomDetailDto, RoomState } from '@api/model';
import { api } from '@api/endpoints';
import { useLiveEvent, useResource } from '@data';
import { AutoGrid, DayChart, ProfileStrip, Skeleton, Stack, StatTile, type ProfileStripSegment } from '@ui';
import { displayUnits, fmtDur, fmtRate, startOfLocalDay, t, zonedParts } from '@i18n';
import { atText } from './texts';

const DAY_MS = 86_400_000;

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
  useEffect(() => {
    const timer = window.setInterval(() => void reload(), 5 * 60_000);
    return () => window.clearInterval(timer);
  }, [reload]);
  // a heating span of this room started or ended
  useLiveEvent('span', (s) => {
    if (s.subject === 'room' && s.subjectId === id) void reload();
  });

  const d = day.data;
  const dayStart = startOfLocalDay(now);
  const dayEnd = startOfLocalDay(dayStart + 1.5 * DAY_MS);
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
      {d ? (
        <DayChart
          title={compact ? undefined : t('Today')}
          series={d.series.map(([ts, c]) => ({ t: ts, c: shown(c) }))}
          targets={d.targetSegments.map((s) => ({
            from: s.from,
            to: s.to,
            heat: heatShown ? shown(s.heatC) : null,
            cool: coolShown ? shown(s.coolC) : null,
            future: s.future,
          }))}
          spans={d.demandSpans.map((s) => ({ from: s.from, to: s.to, tone: s.mode }))}
          now={now}
          dayStart={dayStart}
          dayEnd={dayEnd}
          tol={{ heat: { below: scale(tol.heat.below), above: scale(tol.heat.above) }, cool: { below: scale(tol.cool.below), above: scale(tol.cool.above) } }}
          legend={{ temperature: t('temperature'), target: t('target ± tolerance'), future: t('scheduled ahead'), heat: t('heated'), cool: t('cooled') }}
          ariaLabel={aria}
          unitText={displayUnits() === 'F' ? '°F' : '°'}
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
            value={`≈ ${fmtRate(Math.abs(d.stats.rateCPerH ?? (cooled ? room.thermostat.rate.cool : room.thermostat.rate.heat)), { sign: false })}`}
          />
        </AutoGrid>
      ) : null}
    </Stack>
  );
}
