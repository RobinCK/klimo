/**
 * «Відкриті зараз»: the open problems that still wait for someone, with the same buttons the
 * phone notification has. A card that was just handled stays in place with what happened
 * («Сховано до 07:00»), so the list does not jump under the finger.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import type { EpochMs, Id, IncidentDto } from '@api/model';
import { api } from '@api/endpoints';
import { useIncidents } from '@data';
import { AutoGrid, Button, InboxCard, Skeleton, Stack, toast, type Action } from '@ui';
import { errorText, fmtClock, t, type CodeContext } from '@i18n';
import { inboxButtons, incidentLink, incidentWords, morningText, type InboxButton } from './incidents';

interface Handled {
  item: IncidentDto;
  result: string;
}

export interface InboxModel {
  items: IncidentDto[];
  handled: ReadonlyMap<Id, Handled>;
  /** Open, not yet handled in this view. */
  openCount: number;
  loading: boolean;
  act: (i: IncidentDto, b: InboxButton) => Promise<void>;
  busy: string | null;
}

export function useInbox(quietTo: string | null | undefined, now: EpochMs): InboxModel {
  const res = useIncidents('inbox');
  const [handled, setHandled] = useState<Map<Id, Handled>>(() => new Map());
  const [busy, setBusy] = useState<string | null>(null);
  const { reload } = res;

  const act = useCallback(
    async (i: IncidentDto, b: InboxButton) => {
      setBusy(`${i.id}:${b.action}`);
      try {
        await api.incidents.action(i.id, b.minutes ? { action: b.action, minutes: b.minutes } : { action: b.action });
        setHandled((prev) => new Map(prev).set(i.id, { item: i, result: b.result(morningText(quietTo, now)) }));
        void reload();
      } catch (e) {
        toast({ tone: 'err', message: errorText(e) || t('Did not go through') });
      } finally {
        setBusy(null);
      }
    },
    [quietTo, now, reload],
  );

  // handled cards keep their place: merge them back by when they opened, ties in the order first shown
  const seen = useRef(new Map<Id, number>());
  const items = useMemo(() => {
    const live = res.data ?? [];
    for (const i of live) if (!seen.current.has(i.id)) seen.current.set(i.id, seen.current.size);
    const ids = new Set(live.map((i) => i.id));
    const kept = [...handled.values()].filter((h) => !ids.has(h.item.id)).map((h) => h.item);
    const rank = (i: IncidentDto) => seen.current.get(i.id) ?? Number.MAX_SAFE_INTEGER;
    return [...live, ...kept].sort((a, b) => b.openedAt - a.openedAt || rank(a) - rank(b));
  }, [res.data, handled]);

  const openCount = items.filter((i) => !handled.has(i.id)).length;
  return { items, handled, openCount, loading: !res.settled, act, busy };
}

const FIRST = 6;

export function InboxList({ inbox, ctx, now, grid }: { inbox: InboxModel; ctx: CodeContext; now: EpochMs; grid?: boolean }) {
  const [all, setAll] = useState(false);
  if (inbox.loading && !inbox.items.length) {
    return (
      <Stack gap="sm">
        {[0, 1].map((i) => (
          <Skeleton key={i} height={120} radius={16} />
        ))}
      </Stack>
    );
  }
  const visible = all ? inbox.items : inbox.items.slice(0, FIRST);
  const cards = visible.map((i) => {
    const w = incidentWords(i, ctx, now);
    const handled = inbox.handled.get(i.id);
    const actions: Action[] = inboxButtons(i).map((b) => ({
      label: b.label,
      loading: inbox.busy === `${i.id}:${b.action}`,
      disabled: inbox.busy != null && inbox.busy !== `${i.id}:${b.action}`,
      onClick: () => void inbox.act(i, b),
    }));
    // the card carries at most three buttons; «Open» is the way out when the message has little else
    if (actions.length < 2) actions.push({ label: t('Open'), to: incidentLink(i) });
    return (
      <InboxCard
        key={i.id}
        time={fmtClock(i.openedAt, now)}
        tone={i.tone === 'err' ? 'err' : i.tone === 'ok' ? 'ok' : 'warn'}
        icon={i.icon}
        title={w.title}
        text={w.text || w.title}
        actions={actions}
        resolved={handled ? `${handled.result}.` : undefined}
      />
    );
  });
  const list = grid ? (
    <AutoGrid min={340} gap="md">
      {cards}
    </AutoGrid>
  ) : (
    <Stack gap="sm">{cards}</Stack>
  );
  return inbox.items.length > FIRST ? (
    <Stack gap="md">
      {list}
      <Button variant="secondary" size="sm" onClick={() => setAll((v) => !v)}>
        {all ? t('Show fewer') : t('Show all {count}', { count: inbox.items.length })}
      </Button>
    </Stack>
  ) : (
    list
  );
}
