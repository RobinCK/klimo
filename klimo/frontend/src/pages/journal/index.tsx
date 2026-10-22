/**
 * «Журнал рішень» on a phone: what the system did and why, newest first, filtered by category.
 * New entries arrive live at the top; older ones load page by page. Wide screens show the same
 * log as a section of the System page instead.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JournalCategory, JournalEntry } from '@api/model';
import { api } from '@api/endpoints';
import { useCodeContext, useLiveEvent, useNow, useResource, type NameDirectory } from '@data';
import { navigate, paths } from '@app';
import { Button, DecisionLog, FilterPills, MobileTopBar, ScrollX, Skeleton, Stack } from '@ui';
import { errorText, fmtClock, renderJournal, renderReason, t } from '@i18n';

type Filter = 'all' | JournalCategory;
const PAGE = 40;

function rowOf(e: JournalEntry, ctx: NameDirectory, now: number) {
  const details: string[] = [];
  if (e.why) details.push(renderReason(e.why, ctx));
  if (e.notified.length) details.push(t('Notified'));
  const where = e.roomId ? ctx.room?.(e.roomId) : e.sourceId ? ctx.source?.(e.sourceId) : undefined;
  const title = renderJournal(e, ctx);
  return {
    time: fmtClock(e.ts, now),
    tone: e.tone,
    title: where && !title.includes(where) ? `${where} · ${title}` : title,
    why: details.join(' · '),
    to: e.roomId ? paths.room(e.roomId) : e.sourceId ? paths.source(e.sourceId) : e.deviceKey ? paths.device(e.deviceKey) : undefined,
  };
}

function useJournal(filter: Filter) {
  const [items, setItems] = useState<JournalEntry[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // a slow answer for the previous filter must not replace the list of the current one
  const seq = useRef(0);

  const load = useCallback(async (category: Filter, before?: number) => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const page = await api.journal({ category: category === 'all' ? undefined : category, before, limit: PAGE });
      if (mine !== seq.current) return;
      setItems((prev) => (before ? [...prev, ...page.items.filter((x) => !prev.some((p) => p.id === x.id))] : page.items));
      setNext(page.nextBefore);
      setError(null);
    } catch (e) {
      if (mine === seq.current) setError(errorText(e) || t('Could not load the journal.'));
    } finally {
      if (mine === seq.current) {
        setLoading(false);
        setLoaded(true);
      }
    }
  }, []);

  useEffect(() => {
    setLoaded(false);
    void load(filter);
  }, [filter, load]);

  useLiveEvent('journal', (e) => {
    if (filter !== 'all' && e.category !== filter) return;
    setItems((prev) => (prev.some((x) => x.id === e.id) ? prev : [e, ...prev]));
  });

  return { items, next, loading, loaded, error, more: () => (next ? load(filter, next) : Promise.resolve()), retry: () => load(filter) };
}

/**
 * Entries name devices by their entity ids («switch.radiator_pump»); the device list turns those
 * into the names people gave them.
 */
function useJournalNames(): NameDirectory {
  const base = useCodeContext();
  const devices = useResource('devices', () => api.devices.list(), { reloadOn: ['device_meta', 'sensor', 'emitter_device', 'source', 'pump'] });
  return useMemo(() => {
    const byEntity = new Map<string, string>();
    const byKey = new Map<string, string>();
    for (const d of devices.data?.devices ?? []) {
      const name = d.label ?? d.name;
      byKey.set(d.key, name);
      for (const e of d.entityIds) byEntity.set(e, name);
    }
    return {
      ...base,
      // a spread copies the clock once; the directory's «now» must stay live
      get now() {
        return base.now;
      },
      entity: (id: string) => byEntity.get(id) ?? base.entity?.(id),
      device: (key: string) => byKey.get(key) ?? base.device?.(key),
    };
  }, [base, devices.data]);
}

export default function JournalPage(): JSX.Element {
  const ctx = useJournalNames();
  const now = useNow(60_000);
  const [filter, setFilter] = useState<Filter>('all');
  const j = useJournal(filter);

  const pills = (
    // five categories do not fit a phone's width: the row scrolls sideways instead of wrapping
    <ScrollX minWidth={460} ariaLabel={t('Show')}>
      <FilterPills<Filter>
        ariaLabel={t('Show')}
        value={filter}
        surface="page"
        options={[
          { value: 'all', label: t('All') },
          { value: 'src', label: t('Sources') },
          { value: 'rooms', label: t('Rooms') },
          { value: 'dev', label: t('Devices') },
          { value: 'system', label: t('System') },
        ]}
        onChange={setFilter}
      />
    </ScrollX>
  );

  const body = !j.loaded ? (
    <Stack gap="xs">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <Skeleton key={i} height={56} radius={12} />
      ))}
    </Stack>
  ) : (
    <Stack gap="md">
      <DecisionLog rows={j.items.map((e) => rowOf(e, ctx, now))} emptyText={j.error ?? t('Nothing yet.')} />
      {j.error && !j.items.length ? (
        <Button variant="secondary" size="sm" onClick={() => void j.retry()}>
          {t('Try again')}
        </Button>
      ) : null}
      {j.next ? (
        <Button variant="secondary" onClick={() => void j.more()} loading={j.loading} fullWidth>
          {t('Show more')}
        </Button>
      ) : null}
    </Stack>
  );

  return (
    <Stack gap="md">
      <MobileTopBar title={t('Decision journal')} subtitle={{ text: t('What the system did and why') }} onBack={() => navigate(paths.system())} />
      {pills}
      {body}
    </Stack>
  );
}
