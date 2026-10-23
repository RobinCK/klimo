import type { EpochMs, RoomDayDto } from '@api/model';

/** A room reading seen on the live socket: [server time, °C or null]. */
export type LivePoint = [EpochMs, number | null];

const KEEP = 2000;

/** Adds a live reading: one a minute while it holds, every change at once. */
export function appendLive(points: readonly LivePoint[], t: EpochMs, c: number | null): readonly LivePoint[] {
  const last = points[points.length - 1];
  if (last && (t <= last[0] || (t - last[0] < 60_000 && last[1] === c))) return points;
  const next: LivePoint[] = [...points, [t, c]];
  return next.length > KEEP ? next.slice(next.length - KEEP) : next;
}

/**
 * The day to draw: today's answer, except that one the server could not complete (Klimo or Home
 * Assistant just restarted) does not replace a complete one of the same room and date.
 */
export function dayShown(data: RoomDayDto | undefined, lastComplete: RoomDayDto | undefined, roomId: string, today: string): RoomDayDto | undefined {
  const keep = lastComplete && lastComplete.roomId === roomId && lastComplete.date === today ? lastComplete : undefined;
  if (!data || data.roomId !== roomId || data.date !== today) return keep;
  return data.complete === false && keep ? keep : data;
}

/**
 * The day as the server read it, continued with what the socket brought since (`asOf`): the line up to
 * now, the minimum and maximum, and a run still going counted up to now.
 */
export function liveDay(d: RoomDayDto, live: readonly LivePoint[], current: number | null, now: EpochMs, dayEnd: EpochMs): Pick<RoomDayDto, 'series' | 'stats'> {
  const until = Math.min(now, dayEnd);
  if (until <= d.asOf) return { series: d.series, stats: d.stats };
  const extra: LivePoint[] = live.filter(([t]) => t > d.asOf && t <= until);
  if (current !== null && (!extra.length || extra[extra.length - 1][0] < until)) extra.push([until, current]);
  let { min, max } = d.stats;
  for (const [at, c] of extra) {
    if (c === null) continue;
    const v = Math.round(c * 10) / 10;
    if (!min || v < min.c) min = { c: v, at };
    if (!max || v > max.c) max = { c: v, at };
  }
  const grown = Math.max(0, Math.round((until - d.asOf) / 60_000));
  const running = (mode: 'heat' | 'cool') => d.demandSpans.some((s) => s.to === null && s.mode === mode);
  return {
    series: extra.length ? [...d.series, ...extra] : d.series,
    stats: {
      ...d.stats,
      min,
      max,
      heatedMin: d.stats.heatedMin + (running('heat') ? grown : 0),
      cooledMin: d.stats.cooledMin + (running('cool') ? grown : 0),
    },
  };
}
