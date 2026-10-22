import type { CircuitDto, PlantState, ProfileDto, SourceDto, TodayDto, Tone } from '@api/model';
import { LegendSwatch, MiniTag, Row, ScrollX, Section, Skeleton, Stack, Timeline24h, type TimelineTrack } from '@ui';
import { Link } from '@ui';
import { paths } from '@app';
import { fmtDur, fmtTemp, fmtTime, t, type CodeContext } from '@i18n';

const TRACK_ORDER: Record<TodayDto['tracks'][number]['kind'], number> = { profile: 0, source: 1, pump: 2, room: 3, rule: 4, trigger: 5 };

/** Profile, the sources that ran today (or lead), and the pumps; pump run-on in a muted shade. */
export function timelineTracks(today: TodayDto, profiles: readonly ProfileDto[] | undefined, leadId: string | null, ctx: CodeContext): TimelineTrack[] {
  const prof = new Map((profiles ?? []).map((p) => [p.id, p] as const));
  return [...today.tracks]
    .filter((tr) => tr.kind === 'profile' || tr.kind === 'pump' || tr.spans.length > 0 || (tr.kind === 'source' && tr.subjectId === leadId))
    .filter((tr) => tr.kind !== 'room')
    .sort((a, b) => TRACK_ORDER[a.kind] - TRACK_ORDER[b.kind])
    .map((tr) => {
      if (tr.kind === 'profile') {
        return {
          key: tr.key,
          label: tr.label || t('Profile'),
          spans: tr.spans.map((s) => {
            const p = s.profileId ? prof.get(s.profileId) : undefined;
            return {
              start: s.from,
              end: s.to,
              color: p?.color,
              ink: p?.ink,
              tone: p ? undefined : ('hold' as Tone),
              label: p?.name ?? (s.profileId ? ctx.profile?.(s.profileId) : undefined),
            };
          }),
        };
      }
      const label =
        tr.label ||
        (tr.kind === 'source' ? (ctx.source?.(tr.subjectId) ?? tr.subjectId) : tr.kind === 'pump' ? (ctx.pump?.(tr.subjectId) ?? tr.subjectId) : tr.subjectId);
      return {
        key: tr.key,
        label,
        spans: tr.spans.map((s) => ({
          start: s.from,
          end: s.to,
          tone: tr.kind === 'pump' ? ('hold' as Tone) : s.tone,
          runOnFrom: s.kind === 'run_on' ? s.from : null,
        })),
      };
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
  plant,
  profiles,
  sources,
  circuits,
  leadId,
  ctx,
}: {
  today: TodayDto | null;
  plant: PlantState | null;
  profiles: readonly ProfileDto[] | undefined;
  sources: readonly SourceDto[] | undefined;
  circuits: readonly CircuitDto[] | undefined;
  leadId: string | null;
  ctx: CodeContext;
}) {
  if (!today) {
    return (
      <Section title={t('Today')}>
        <Skeleton height={140} radius={12} />
      </Section>
    );
  }
  const tracks = timelineTracks(today, profiles, leadId, ctx);
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
