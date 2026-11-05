import { useRef, useState } from 'react';
import type { CircuitDto, EpochMs, HouseState, LocalDate, PlantState, ProfileDto, ResolvedDayDto, RoomSummary, SourceDto, TodayDto, Tone } from '@api/model';
import { api } from '@api/endpoints';
import { useResource } from '@data';
import { LegendSwatch, Link, MiniTag, PeriodNav, Row, ScrollX, Section, Skeleton, Stack, StatusBanner, Text, Timeline24h, type TimelineSpan, type TimelineTrack } from '@ui';
import { paths, usePref } from '@app';
import type { NameDirectory } from '@data';
import { addDays, fmtDur, fmtTemp, fmtTime, nextPeriod, periodLabel, t, zonedParts, type CodeContext } from '@i18n';

const TRACK_ORDER: Record<TodayDto['tracks'][number]['kind'], number> = { profile: 0, source: 1, pump: 2, room: 3, rule: 4, trigger: 5 };

/** Epoch of a minute of today's local day; a DST day is 23 or 25 hours long, so the offset is corrected. */
function atMinute(today: TodayDto, minute: number): EpochMs {
  if (minute >= 1440) return today.to;
  const guess = today.from + minute * 60_000;
  const drift = zonedParts(guess).minuteOfDay - minute;
  return Math.abs(drift) <= 120 ? guess - drift * 60_000 : guess;
}

/**
 * The rest of the day as planned: the profile set by hand until it ends, then the house
 * schedule. Only the future is filled in — the past shows what really happened.
 */
function plannedProfiles(today: TodayDto, house: HouseState, plan: ResolvedDayDto | null): { start: EpochMs; end: EpochMs; profileId: string }[] {
  const now = today.now;
  const out: { start: EpochMs; end: EpochMs; profileId: string }[] = [];
  const p = house.profile;
  let from = now;
  if (p.layer === 'house_manual' || p.layer === 'calendar') {
    const until = p.layer === 'house_manual' ? (p.override?.until ?? null) : p.scheduledUntil;
    const end = Math.min(until ?? today.to, today.to);
    if (end > now) out.push({ start: now, end, profileId: p.activeProfileId });
    from = Math.max(now, end);
  }
  for (const seg of plan?.segments ?? []) {
    const start = Math.max(from, atMinute(today, seg.start));
    const end = atMinute(today, seg.end);
    if (end > start) out.push({ start, end, profileId: seg.profileId });
  }
  return out;
}

/** Profile, the sources that ran today (or lead), and the pumps; pump run-on in a muted shade. */
export function timelineTracks(
  today: TodayDto,
  profiles: readonly ProfileDto[] | undefined,
  leadId: string | null,
  ctx: CodeContext,
  planned: readonly { start: EpochMs; end: EpochMs; profileId: string }[] = [],
): TimelineTrack[] {
  const prof = new Map((profiles ?? []).map((p) => [p.id, p] as const));
  const profileSpan = (start: EpochMs, end: EpochMs | null, profileId: string | undefined): TimelineSpan => {
    const p = profileId ? prof.get(profileId) : undefined;
    return {
      start,
      end,
      color: p?.color,
      ink: p?.ink,
      tone: p ? undefined : ('hold' as Tone),
      label: p?.name ?? (profileId ? ctx.profile?.(profileId) : undefined),
    };
  };
  return [...today.tracks]
    .filter((tr) => tr.kind === 'profile' || tr.kind === 'pump' || tr.spans.length > 0 || (tr.kind === 'source' && tr.subjectId === leadId))
    .filter((tr) => tr.kind !== 'room')
    .sort((a, b) => TRACK_ORDER[a.kind] - TRACK_ORDER[b.kind])
    .map((tr) => {
      if (tr.kind === 'profile') {
        return {
          key: tr.key,
          label: tr.label || t('Profile'),
          spans: [
            ...tr.spans.map((s) => profileSpan(s.from, s.to == null ? today.now : Math.min(s.to, today.now), s.profileId)),
            ...planned.map((s) => profileSpan(s.start, s.end, s.profileId)),
          ],
        };
      }
      const label =
        tr.label ||
        (tr.kind === 'source' ? (ctx.source?.(tr.subjectId) ?? tr.subjectId) : tr.kind === 'pump' ? (ctx.pump?.(tr.subjectId) ?? tr.subjectId) : tr.subjectId);
      // rules and triggers are events, not hardware: never in the heat or cold colour of the legend
      const tone = (s: TodayDto['tracks'][number]['spans'][number]): Tone =>
        tr.kind === 'pump' ? 'hold' : tr.kind === 'rule' || tr.kind === 'trigger' ? 'event' : s.tone;
      return {
        key: tr.key,
        label,
        spans: tr.spans.map((s) => ({
          start: s.from,
          end: s.to,
          tone: tone(s),
          runOnFrom: s.kind === 'run_on' ? s.from : null,
        })),
      };
    });
}

/** Source rows named alike («Кондиціонер» in three rooms) get their room after the name. */
function distinctLabels(tracks: TimelineTrack[], today: TodayDto, sources: readonly SourceDto[] | undefined, ctx: NameDirectory): TimelineTrack[] {
  return tracks.map((tr) => {
    const src = today.tracks.find((x) => x.key === tr.key);
    if (src?.kind !== 'source') return tr;
    const plain = sources?.find((x) => x.config.id === src.subjectId)?.config.name ?? ctx.source?.(src.subjectId);
    const label = ctx.sourceLabel(src.subjectId);
    return label && tr.label === plain ? { ...tr, label } : tr;
  });
}

interface Stretch {
  start: EpochMs;
  end: EpochMs;
}

/** Overlapping stretches joined into one: two rooms asking at once count once. */
function joined(list: readonly Stretch[]): Stretch[] {
  const out: Stretch[] = [];
  for (const x of [...list].filter((y) => y.end > y.start).sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1];
    if (last && x.start <= last.end) last.end = Math.max(last.end, x.end);
    else out.push({ ...x });
  }
  return out;
}

const minutesOf = (list: readonly Stretch[]) => Math.round(list.reduce((sum, x) => sum + (x.end - x.start), 0) / 60_000);

/**
 * When the rooms asked for heat (or cooling): one row for all of them — at least one room asked —
 * that opens the rows of the rooms that asked, each leading to its room, in the house's order.
 * The rooms that never asked that day are named after them.
 */
function roomTracks(
  today: TodayDto,
  rooms: readonly RoomSummary[],
  cooling: boolean,
  open: boolean,
  onToggle: () => void,
): { tracks: TimelineTrack[]; quiet: string[] } {
  const end = Math.min(today.to, today.now);
  const order = new Map(rooms.map((r) => [r.id, r.order] as const));
  const asked = today.tracks
    .filter((tr) => tr.kind === 'room' && tr.spans.length > 0)
    .sort((a, b) => (order.get(a.subjectId) ?? Infinity) - (order.get(b.subjectId) ?? Infinity) || a.label.localeCompare(b.label));
  const stretch = (s: TodayDto['tracks'][number]['spans'][number]): Stretch => ({ start: Math.max(s.from, today.from), end: Math.min(s.to ?? end, end) });
  const of = (mode: 'heat' | 'cool') =>
    joined(asked.flatMap((tr) => tr.spans.filter((s) => (mode === 'cool' ? s.tone === 'cool' : s.tone !== 'cool')).map(stretch)));
  const heat = of('heat');
  const cool = of('cool');
  const unions: TimelineTrack[] = [];
  const union = (mode: 'heat' | 'cool', list: Stretch[]): TimelineTrack => ({
    key: `rooms:${mode}`,
    label: mode === 'cool' ? t('Rooms asked for cooling') : t('Rooms asked for heat'),
    sub: list.length ? fmtDur(minutesOf(list)) : '—',
    strong: true,
    spans: list.map((x) => ({ start: x.start, end: x.end, tone: mode as Tone })),
  });
  if (heat.length || (!cool.length && !cooling)) unions.push(union('heat', heat));
  if (cool.length || (!heat.length && cooling)) unions.push(union('cool', cool));
  if (asked.length) unions[0] = { ...unions[0], onToggle, open };
  const each: TimelineTrack[] = open
    ? asked.map((tr) => ({
        key: tr.key,
        label: rooms.find((r) => r.id === tr.subjectId)?.name ?? tr.label,
        sub: fmtDur(minutesOf(joined(tr.spans.map(stretch)))),
        to: rooms.some((r) => r.id === tr.subjectId) ? paths.room(tr.subjectId) : undefined,
        indent: true,
        spans: tr.spans.map((s) => ({ start: s.from, end: s.to, tone: s.tone })),
      }))
    : [];
  const quiet = [...rooms]
    .filter((r) => !asked.some((tr) => tr.subjectId === r.id))
    .sort((a, b) => a.order - b.order)
    .map((r) => r.name);
  return { tracks: [...unions, ...each], quiet };
}

function statBadges(
  today: TodayDto,
  plant: PlantState | null,
  sources: readonly SourceDto[] | undefined,
  leadId: string | null,
  ctx: CodeContext,
  isToday: boolean,
): string[] {
  const st = today.stats;
  const out: string[] = [];
  const cooling = today.tracks.some((tr) => tr.kind === 'source' && tr.spans.some((s) => s.mode === 'cool'));
  const lead = st.perSource.find((p) => p.sourceId === leadId);
  const leadName = leadId ? (ctx.source?.(leadId) ?? leadId) : null;
  if (cooling) {
    if (st.runtimeMin > 0) out.push(t('cooling {dur}', { dur: fmtDur(st.runtimeMin) }));
    if (st.coolSince != null) out.push(t('floor cooling since {time}', { time: fmtTime(st.coolSince) }));
    if (st.dewPointMaxC != null) out.push(t('dew point {t}', { t: fmtTemp(st.dewPointMaxC) }));
    return out;
  }
  if (lead && leadName && lead.cycles > 0) out.push(t('{count} cycles · {source}', { count: lead.cycles, source: leadName }));
  else if (st.cycles > 0) out.push(t('{count} cycles', { count: st.cycles }));
  if (st.runtimeMin > 0) out.push(fmtDur(st.runtimeMin));
  if (st.avgCycleMin != null && st.cycles > 0) out.push(t('average cycle {dur}', { dur: fmtDur(st.avgCycleMin) }));
  const idle = st.perSource.find((p) => !p.started && p.sourceId !== leadId && sources?.find((s) => s.config.id === p.sourceId)?.config.scope === 'central');
  if (idle) {
    const source = ctx.source?.(idle.sourceId) ?? idle.sourceId;
    out.push(isToday ? t('{source} did not run today', { source }) : t('{source} did not run that day', { source }));
  }
  if (!out.length && plant) out.push(isToday ? t('nothing ran today yet') : t('nothing ran that day'));
  return out;
}

/** A past day asked of the server; the day shown before stays on screen until it arrives. */
function useDay(today: TodayDto | null, date: LocalDate | null) {
  const past = useResource(date ? `today:${date}` : null, () => api.today(date ?? undefined));
  const last = useRef<TodayDto | null>(null);
  const fresh = date ? (past.data ?? null) : today;
  if (fresh) last.current = fresh;
  const failed = date != null && !past.data && past.settled && !past.loading && past.error != null;
  return { day: fresh ?? (date && !failed ? last.current : null), failed, retry: past.reload };
}

/**
 * «Сьогодні»: what ran when, on one 24-hour axis.
 * The profile, the sources, the pumps and when the rooms asked for heat, all of them and each one.
 * A pointer (a finger) over the bars says what ran at that moment; the arrows step through the days before.
 */
export function TodaySection({
  today,
  house,
  plan,
  plant,
  profiles,
  sources,
  circuits,
  rooms,
  leadId,
  ctx,
  phone = false,
}: {
  today: TodayDto | null;
  house: HouseState;
  /** Today's house schedule, for the rest of the day on the profile row. */
  plan: ResolvedDayDto | null;
  plant: PlantState | null;
  profiles: readonly ProfileDto[] | undefined;
  sources: readonly SourceDto[] | undefined;
  circuits: readonly CircuitDto[] | undefined;
  rooms: readonly RoomSummary[];
  leadId: string | null;
  ctx: NameDirectory;
  /** A phone's own page: each label above its bar, no sideways scrolling. */
  phone?: boolean;
}) {
  const [date, setDate] = useState<LocalDate | null>(null);
  const [roomsOpen, setRoomsOpen] = usePref<boolean>('day-rooms', true);
  const { day, failed, retry } = useDay(today, date);
  const title = t('Day by the hour');
  if (!day) {
    return (
      <Section id="today" title={title}>
        {failed ? (
          <StatusBanner tone="err" icon="alert" text={t('Could not load this day.')} action={{ label: t('Try again'), onClick: () => void retry() }} />
        ) : (
          <Skeleton height={140} radius={12} />
        )}
      </Section>
    );
  }
  const todayDate = today?.date ?? zonedParts(day.now).date;
  const isToday = day.date === todayDate;
  const shownDate = date ?? todayDate;
  const go = (to: LocalDate) => setDate(to >= todayDate ? null : to);
  const cooling = day.tracks.some((tr) => tr.kind === 'source' && tr.spans.some((s) => s.mode === 'cool'));
  const base = distinctLabels(
    timelineTracks(day, profiles, isToday ? leadId : null, ctx, isToday && plan && plan.date === day.date ? plannedProfiles(day, house, plan) : []),
    day,
    sources,
    ctx,
  );
  const roomPart = roomTracks(day, rooms, cooling || house.season.season === 'cooling', roomsOpen, () => setRoomsOpen(!roomsOpen));
  // the rooms after the hardware that served them, before the rules and triggers
  const cut = base.findIndex((tr) => tr.key.startsWith('rule:') || tr.key.startsWith('trigger:'));
  const tracks = cut < 0 ? [...base, ...roomPart.tracks] : [...base.slice(0, cut), ...roomPart.tracks, ...base.slice(cut)];
  const badges = statBadges(day, plant, sources, isToday ? leadId : null, ctx, isToday);
  const runOn = (circuits ?? [])
    .flatMap((c) => c.pumps)
    .filter((p) => (cooling ? p.runOnCoolMin : p.runOnHeatMin) > 0)
    .map((p) => `${p.name.toLowerCase()} ${fmtDur(cooling ? p.runOnCoolMin : p.runOnHeatMin)}`)
    .slice(0, 2)
    .join(', ');
  const nav = (
    <PeriodNav
      label={periodLabel({ range: 'day', date: day.date, from: day.from, to: day.to, now: day.now })}
      onPrev={() => go(addDays(shownDate, -1))}
      onNext={() => go(nextPeriod('day', shownDate))}
      nextDisabled={shownDate >= todayDate}
      onCurrent={date ? () => setDate(null) : undefined}
      currentLabel={t('Today')}
    />
  );
  const tags = badges.map((b) => <MiniTag key={b}>{b}</MiniTag>);
  const timeline = (
    <Timeline24h
      tracks={tracks}
      dayStart={day.from}
      dayEnd={day.to}
      now={day.now}
      ariaLabel={title}
      layout={phone ? 'stacked' : 'side'}
      labelWidth={phone ? undefined : 248}
      formatTime={fmtTime}
    />
  );
  const body = (
    <Stack gap="md">
      {phone ? (
        timeline
      ) : (
        <ScrollX minWidth={640} ariaLabel={t('Today on a 24-hour timeline')}>
          {timeline}
        </ScrollX>
      )}
      {roomsOpen && roomPart.quiet.length ? <Text variant="caption">{t('Did not ask: {rooms}', { rooms: roomPart.quiet.join(', ') })}</Text> : null}
      <Row gap="lg" wrap>
        <LegendSwatch tone={cooling ? 'cool' : 'heat'} label={cooling ? t('cooling · asking for cooling') : t('heating · asking for heat')} />
        <LegendSwatch tone="hold" label={t('pump running')} />
        <LegendSwatch variant="runon" label={runOn ? t('pump run-on: {list}', { list: runOn }) : t('pump run-on')} />
        <Link to={paths.journal()} variant="muted">
          {t('Decision journal')}
        </Link>
      </Row>
    </Stack>
  );
  if (phone) {
    return (
      <Stack gap="md">
        {nav}
        {tags.length ? (
          <Row gap="xs" wrap>
            {tags}
          </Row>
        ) : null}
        {body}
      </Stack>
    );
  }
  return (
    <Section
      id="today"
      title={title}
      action={
        <Row gap="sm" wrap>
          {tags}
          {nav}
        </Row>
      }
    >
      {body}
    </Section>
  );
}
