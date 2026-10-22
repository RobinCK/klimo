import type { CircuitDto, EpochMs, HouseState, PlantState, ProfileDto, ResolvedDayDto, SourceDto, TodayDto, Tone } from '@api/model';
import { LegendSwatch, Link, MiniTag, Row, ScrollX, Section, Skeleton, Stack, Timeline24h, type TimelineSpan, type TimelineTrack } from '@ui';
import { paths } from '@app';
import type { NameDirectory } from '@data';
import { fmtDur, fmtTemp, fmtTime, t, zonedParts, type CodeContext } from '@i18n';

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

function statBadges(today: TodayDto, plant: PlantState | null, sources: readonly SourceDto[] | undefined, leadId: string | null, ctx: CodeContext): string[] {
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
  if (idle) out.push(t('{source} did not run today', { source: ctx.source?.(idle.sourceId) ?? idle.sourceId }));
  if (!out.length && plant) out.push(t('nothing ran today yet'));
  return out;
}

/** «Сьогодні»: what ran when, on one 24-hour axis. */
export function TodaySection({
  today,
  house,
  plan,
  plant,
  profiles,
  sources,
  circuits,
  leadId,
  ctx,
}: {
  today: TodayDto | null;
  house: HouseState;
  /** Today's house schedule, for the rest of the day on the profile row. */
  plan: ResolvedDayDto | null;
  plant: PlantState | null;
  profiles: readonly ProfileDto[] | undefined;
  sources: readonly SourceDto[] | undefined;
  circuits: readonly CircuitDto[] | undefined;
  leadId: string | null;
  ctx: NameDirectory;
}) {
  if (!today) {
    return (
      <Section title={t('Today')}>
        <Skeleton height={140} radius={12} />
      </Section>
    );
  }
  const tracks = distinctLabels(
    timelineTracks(today, profiles, leadId, ctx, plan && plan.date === today.date ? plannedProfiles(today, house, plan) : []),
    today,
    sources,
    ctx,
  );
  const badges = statBadges(today, plant, sources, leadId, ctx);
  const cooling = today.tracks.some((tr) => tr.kind === 'source' && tr.spans.some((s) => s.mode === 'cool'));
  const runOn = (circuits ?? [])
    .flatMap((c) => c.pumps)
    .filter((p) => (cooling ? p.runOnCoolMin : p.runOnHeatMin) > 0)
    .map((p) => `${p.name.toLowerCase()} ${fmtDur(cooling ? p.runOnCoolMin : p.runOnHeatMin)}`)
    .slice(0, 2)
    .join(', ');
  return (
    <Section
      id="today"
      title={t('Today')}
      action={
        <Row gap="xs" wrap>
          {badges.map((b) => (
            <MiniTag key={b}>{b}</MiniTag>
          ))}
        </Row>
      }
    >
      <Stack gap="md">
        <ScrollX minWidth={640} ariaLabel={t('Today on a 24-hour timeline')}>
          <Timeline24h tracks={tracks} dayStart={today.from} dayEnd={today.to} now={today.now} ariaLabel={t('Today')} />
        </ScrollX>
        <Row gap="lg" wrap>
          <LegendSwatch tone={cooling ? 'cool' : 'heat'} label={cooling ? t('source cooling') : t('source heating')} />
          <LegendSwatch tone="hold" label={t('pump running')} />
          <LegendSwatch variant="runon" label={runOn ? t('pump run-on: {list}', { list: runOn }) : t('pump run-on')} />
          <Link to={paths.journal()} variant="muted">
            {t('Decision journal')}
          </Link>
        </Row>
      </Stack>
    </Section>
  );
}
