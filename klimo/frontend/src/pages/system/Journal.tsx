/**
 * «Журнал рішень»: what the system did and why, newest first, by category. New entries arrive
 * live; older ones load page by page.
 */
import { useCallback, useEffect, useState } from 'react';
import type { JournalCategory, JournalEntry } from '@api/model';
import { api } from '@api/endpoints';
import { useLiveEvent, type NameDirectory } from '@data';
import { paths } from '@app';
import { Button, DecisionLog, Section, SegmentedControl, Stack } from '@ui';
import { fmtClock, renderJournal, renderReason, t } from '@i18n';

type Filter = 'all' | JournalCategory;
const PAGE = 15;

function rowOf(e: JournalEntry, ctx: NameDirectory) {
  const details: string[] = [];
  if (e.why) details.push(renderReason(e.why, ctx));
  const where = e.roomId ? ctx.room?.(e.roomId) : e.sourceId ? ctx.source?.(e.sourceId) : undefined;
  const title = renderJournal(e, ctx);
  const ids = e.entityIds.filter((id) => !title.includes(id));
  if (ids.length) details.push(ids.join(', '));
  if (e.notified.length) details.push(t('Notified'));
  return {
    time: fmtClock(e.ts, ctx.now),
    tone: e.tone,
    title: where && !title.includes(where) ? `${where} · ${title}` : title,
    why: details.join(' · '),
    to: e.roomId ? paths.room(e.roomId) : e.sourceId ? paths.source(e.sourceId) : e.deviceKey ? paths.device(e.deviceKey) : undefined,
  };
}

export function JournalSection({ ctx, focus }: { ctx: NameDirectory; focus?: boolean }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [items, setItems] = useState<JournalEntry[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (category: Filter, before?: number) => {
    setLoading(true);
    try {
      const page = await api.journal({ category: category === 'all' ? undefined : category, before, limit: PAGE });
      setItems((prev) => (before ? [...prev, ...page.items] : page.items));
      setNext(page.nextBefore);
    } catch {
      // the list keeps what it has; the next live entry or a filter change tries again
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(filter);
  }, [filter, load]);

  useLiveEvent('journal', (e) => {
    if (filter !== 'all' && e.category !== filter) return;
    setItems((prev) => (prev.some((x) => x.id === e.id) ? prev : [e, ...prev]));
  });

  // opened as «#/system/journal»: bring the log into view
  useEffect(() => {
    if (focus) window.setTimeout(() => document.getElementById('journal')?.scrollIntoView({ block: 'start' }), 300);
  }, [focus]);

  return (
    <Section id="journal" title={t('Decision journal')} subtitle={t('What the system did and why')}>
      <Stack gap="md">
        <DecisionLog
          filter={
            <SegmentedControl<Filter>
              size="sm"
              ariaLabel={t('Show')}
              value={filter}
              options={[
                { value: 'all', label: t('All') },
                { value: 'src', label: t('Sources') },
                { value: 'rooms', label: t('Rooms') },
                { value: 'dev', label: t('Devices') },
                { value: 'system', label: t('System') },
              ]}
              onChange={setFilter}
            />
          }
          rows={items.map((e) => rowOf(e, ctx))}
          emptyText={loading ? t('Loading…') : t('Nothing yet.')}
        />
        {next ? (
          <Button variant="secondary" size="sm" onClick={() => void load(filter, next)} loading={loading}>
            {t('Show more')}
          </Button>
        ) : null}
      </Stack>
    </Section>
  );
}
