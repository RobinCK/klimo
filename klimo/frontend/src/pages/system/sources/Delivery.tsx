/**
 * «Куди подає тепло / холод»: a central source feeds a manifold (and so every circuit on it) and/or
 * circuits directly; a room source heats or cools its room. The same choice in the source wizard and
 * on a source's page; it writes the relations the engine runs on (manifold and circuit sources).
 */
import { useState } from 'react';
import type { CircuitDto, Id, Manifold } from '@api/model';
import { api } from '@api/endpoints';
import { useMutation } from '@data';
import { CheckboxRow, DashedAddButton, Dialog, Section, Stack, StatusBanner, type InfoHintContent } from '@ui';
import { t } from '@i18n';
import type { SystemData } from '../shared';
import { manifoldHint, ManifoldDrawer, useManifolds } from '../Manifolds';

export interface Delivery {
  manifoldIds: Id[];
  /** Circuits fed directly (those on a chosen manifold are fed through it). */
  circuitIds: Id[];
}

export const NO_DELIVERY: Delivery = { manifoldIds: [], circuitIds: [] };

/** Where an existing source delivers now. */
export function deliveryOf(sourceId: Id, manifolds: readonly Manifold[], circuits: readonly CircuitDto[]): Delivery {
  const manifoldIds = manifolds.filter((m) => m.sourceIds.includes(sourceId)).map((m) => m.id);
  const circuitIds = circuits.filter((c) => c.config.sourceIds.includes(sourceId) && !(c.config.manifoldId && manifoldIds.includes(c.config.manifoldId))).map((c) => c.config.id);
  return { manifoldIds, circuitIds };
}

/** Writes the choice: manifolds first (they pass the source on to their circuits), then direct circuits. */
export async function saveDelivery(sourceId: Id, next: Delivery, manifolds: readonly Manifold[], circuits: readonly CircuitDto[]): Promise<void> {
  for (const m of manifolds) {
    const want = next.manifoldIds.includes(m.id);
    const has = m.sourceIds.includes(sourceId);
    if (want !== has) await api.manifolds.patch(m.id, { sourceIds: want ? [...m.sourceIds, sourceId] : m.sourceIds.filter((x) => x !== sourceId) });
  }
  for (const c of circuits) {
    const viaManifold = !!c.config.manifoldId && next.manifoldIds.includes(c.config.manifoldId);
    const leftManifold = !!c.config.manifoldId && !next.manifoldIds.includes(c.config.manifoldId) && manifolds.some((m) => m.id === c.config.manifoldId && m.sourceIds.includes(sourceId));
    const want = viaManifold || next.circuitIds.includes(c.config.id);
    // a manifold the source left already took it off its circuits
    const has = c.config.sourceIds.includes(sourceId) && !leftManifold;
    if (viaManifold || want === has) continue;
    await api.circuits.patch(c.config.id, { sourceIds: want ? [...c.config.sourceIds, sourceId] : c.config.sourceIds.filter((x) => x !== sourceId) });
  }
}

function deliveryHint(): InfoHintContent {
  return {
    title: t('Where the water of this boiler or heat pump goes.'),
    text: [
      { lead: t('Into a manifold:'), text: t('every circuit on it gets its heat or cold — the usual case when the pipes meet at a manifold or a hydraulic separator.') },
      { lead: t('Straight into circuits:'), text: t('when there is no manifold, or this source is piped to one loop only.') },
      t('Rooms on those circuits can then start it. A source connected to nothing never runs for the rooms.'),
    ],
  };
}

/** The choice itself: manifolds (with their circuits), then the circuits not covered by one. */
export function DeliveryPicker({ d, value, onChange }: { d: SystemData; value: Delivery; onChange: (v: Delivery) => void }) {
  const { manifolds } = useManifolds();
  const list = manifolds.data ?? [];
  const circuits = d.circuits.data ?? [];
  const [creating, setCreating] = useState(false);
  const short = (c: CircuitDto) => c.config.shortName || c.config.name;
  const toggle = (ids: Id[], x: Id, on: boolean) => (on ? [...ids.filter((y) => y !== x), x] : ids.filter((y) => y !== x));
  return (
    <Section variant="plain" level={3} title={t('Where it sends heat or cold')} hint={deliveryHint()}>
      <Stack gap="sm">
        {list.map((m) => {
          const on = circuits.filter((c) => c.config.manifoldId === m.id);
          return (
            <CheckboxRow
              key={m.id}
              variant="well"
              checked={value.manifoldIds.includes(m.id)}
              title={t('Into the manifold «{name}»', { name: m.name })}
              hint={on.length ? t('all its circuits: {list}', { list: on.map(short).join(', ') }) : t('no circuits on it yet')}
              info={manifoldHint()}
              onChange={(checked) => onChange({ ...value, manifoldIds: toggle(value.manifoldIds, m.id, checked) })}
            />
          );
        })}
        {!list.length && d.canEdit ? <DashedAddButton label={t('Create a manifold')} onClick={() => setCreating(true)} /> : null}
        {circuits.length ? (
          <Section variant="plain" level={3} subtitle={list.length ? t('Or straight into circuits') : t('Straight into circuits')}>
            <Stack gap="xs">
              {circuits.map((c) => {
                const via = c.config.manifoldId && value.manifoldIds.includes(c.config.manifoldId) ? list.find((m) => m.id === c.config.manifoldId) : undefined;
                return (
                  <CheckboxRow
                    key={c.config.id}
                    checked={!!via || value.circuitIds.includes(c.config.id)}
                    title={c.config.name}
                    hint={c.memberRoomIds.map((id) => d.roomName(id) ?? id).join(', ') || undefined}
                    locked={via ? { reason: t('through the manifold «{name}»', { name: via.name }) } : undefined}
                    onChange={(checked) => onChange({ ...value, circuitIds: toggle(value.circuitIds, c.config.id, checked) })}
                  />
                );
              })}
            </Stack>
          </Section>
        ) : (
          <StatusBanner tone="event" icon="info" text={t('No circuits yet — add them on the schema tab.')} />
        )}
        {!value.manifoldIds.length && !value.circuitIds.length ? (
          <StatusBanner tone="warn" icon="alert" text={t('Connected to nothing yet: no room can start it until it feeds a manifold or a circuit.')} />
        ) : null}
      </Stack>
      {creating ? (
        <ManifoldDrawer
          d={d}
          id={null}
          onClose={() => setCreating(false)}
          onSaved={(m) => onChange({ ...value, manifoldIds: [...value.manifoldIds.filter((x) => x !== m.id), m.id] })}
        />
      ) : null}
    </Section>
  );
}

/** «Змінити» on a source's page. */
export function DeliveryDialog({ d, sourceId, onClose }: { d: SystemData; sourceId: Id; onClose: () => void }) {
  const { manifolds } = useManifolds();
  const circuits = d.circuits.data ?? [];
  const [value, setValue] = useState<Delivery>(() => deliveryOf(sourceId, manifolds.data ?? [], circuits));
  const save = useMutation(() => saveDelivery(sourceId, value, manifolds.data ?? [], circuits), {
    onSuccess: () => {
      void manifolds.reload();
      void d.circuits.reload();
      void d.sources.reload();
      onClose();
    },
    okToast: t('Saved'),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('Where «{name}» sends heat or cold', { name: d.nameOf(sourceId) })}
      size="lg"
      actions={[
        { label: t('Cancel'), onClick: onClose, variant: 'secondary' },
        { label: t('Save'), onClick: () => void save.run(), loading: save.pending },
      ]}
    >
      <DeliveryPicker d={d} value={value} onChange={setValue} />
    </Dialog>
  );
}
