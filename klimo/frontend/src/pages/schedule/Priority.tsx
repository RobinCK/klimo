/**
 * «Хто перемагає, коли правила суперечать»: the priority chain of target layers. Frost
 * protection and open windows always come first and cannot be moved; the rest reorders.
 */
import type { PriorityKey } from '@api/model';
import { api } from '@api/endpoints';
import { useMutation } from '@data';
import { Section, SortableList, Stack, StatusBanner } from '@ui';
import { priorityLabel, t } from '@i18n';
import type { ScheduleContext } from './data';
import { priorityHint } from './texts';

const LOCKED: readonly PriorityKey[] = ['frost', 'window'];

export function PriorityList({ c, plain }: { c: ScheduleContext; plain?: boolean }) {
  const { priority, settings } = c;
  const { setData } = priority;
  const save = useMutation((order: PriorityKey[]) => api.priority.set({ order }), {
    onSuccess: (order) => setData(order),
    onError: () => void priority.reload(),
  });
  const order = priority.data ?? [];
  const list = (
    <Stack gap="sm">
      <SortableList
        size="sm"
        numbered
        ariaLabel={t('Priority order')}
        items={order.map((key) => ({
          id: key,
          title: priorityLabel(key),
          sub: priorityHint(key, settings.data ?? null),
          locked: LOCKED.includes(key) || !c.canEdit,
        }))}
        onReorder={(ids) => {
          const next = ids as PriorityKey[];
          setData(next);
          void save.run(next);
        }}
      />
      {c.canEdit ? null : <StatusBanner tone="warn" icon="lock" text={t('Only a Home Assistant administrator can change this.')} />}
    </Stack>
  );
  if (plain) return list;
  return (
    <Section title={t('Who wins when rules disagree')} subtitle={t('Frost protection and windows always come first — they cannot be moved down.')} level={3}>
      {list}
    </Section>
  );
}
