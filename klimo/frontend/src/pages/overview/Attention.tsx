import type { EpochMs, IncidentDto } from '@api/model';
import { api } from '@api/endpoints';
import { useMutation } from '@data';
import { AlertCard, AttentionBanner, AutoGrid, EmptyState, Section, Skeleton } from '@ui';
import { paths } from '@app';
import { t, type CodeContext } from '@i18n';
import { alertCard, incidentWords } from './incidents';

/** Severity first (errors before warnings), then the newest. */
export function sortAttention(items: readonly IncidentDto[]): IncidentDto[] {
  const rank = (i: IncidentDto) => (i.tone === 'err' ? 0 : i.tone === 'warn' ? 1 : 2);
  return [...items].filter((i) => !i.hidden).sort((a, b) => rank(a) - rank(b) || b.openedAt - a.openedAt);
}

function useDismiss(onDone: () => void) {
  return useMutation((i: IncidentDto) => api.incidents.action(i.id, i.dismiss === 'snooze_30m' ? { action: 'snooze', minutes: 30 } : { action: 'dismiss' }), {
    onSuccess: onDone,
  });
}

/** «Потребує уваги»: one card per open problem with the place to fix it. */
export function AttentionSection({
  items,
  loading,
  ctx,
  now,
  onChanged,
}: {
  items: readonly IncidentDto[];
  loading: boolean;
  ctx: CodeContext;
  now: EpochMs;
  onChanged: () => void;
}) {
  const dismiss = useDismiss(onChanged);
  const list = sortAttention(items);
  return (
    <Section id="attention" variant="plain" title={t('Needs attention')} tag={list.length ? String(list.length) : undefined}>
      {loading && !list.length ? (
        <Skeleton height={120} radius={16} />
      ) : list.length ? (
        <AutoGrid min={320} gap="sm" ariaLabel={t('Open problems')}>
          {list.map((i) => (
            <AlertCard key={i.id} {...alertCard(i, ctx, now, (x) => void dismiss.run(x))} />
          ))}
        </AutoGrid>
      ) : (
        <EmptyState icon="checkCircle" tone="ok" title={t('All good — no warnings.')} />
      )}
    </Section>
  );
}

/** Phone: one warm line with the first two problems; it opens the inbox with all of them. */
export function AttentionLine({ items, ctx, now }: { items: readonly IncidentDto[]; ctx: CodeContext; now: EpochMs }) {
  const list = sortAttention(items);
  if (!list.length) return null;
  const summary = list
    .slice(0, 2)
    .map((i) => incidentWords(i, ctx, now).title.replace(' · ', ': '))
    .join(' · ');
  return <AttentionBanner title={t('{count} need attention', { count: list.length })} summary={summary} to={paths.notifications()} />;
}
