/**
 * «Колектор»: where the sources meet the circuits — a manifold or a hydraulic separator. Each card
 * says which sources feed it, which circuits take from it, and when its own pump runs; the drawer
 * creates, changes and deletes it. A simple house without one skips it.
 */
import { useState } from 'react';
import type { Id, Manifold, ManifoldCreateRequest, Pump, PumpState, Tone } from '@api/model';
import { api } from '@api/endpoints';
import { useEntitySearch, useMutation, useResource } from '@data';
import { brand } from '@brand';
import { paths } from '@app';
import {
  Button,
  CheckboxRow,
  ConfirmDialog,
  Drawer,
  EntityPicker,
  KeyValueList,
  Row,
  Section,
  Stack,
  StatusBanner,
  StatusChip,
  Stepper,
  Text,
  TextField,
  type InfoHintContent,
  type KeyValueRow,
} from '@ui';
import { fmtTemp, fmtTime, t } from '@i18n';
import type { SystemData } from './shared';
import { runOnHint } from './circuitHints';
import { changeErrorText } from './circuitTexts';

const DEFAULT_RUN_ON = 3;

export function useManifolds() {
  const manifolds = useResource('manifolds', api.manifolds.list, { reloadOn: ['manifold'] });
  const pumps = useResource('names:pumps', api.pumps.list, { reloadOn: ['pump'] });
  return { manifolds, pumps };
}

/** What a manifold is and when a house needs one. */
export function manifoldHint(): InfoHintContent {
  return {
    title: t('The manifold is where the pipes of the sources and the circuits meet: a distribution manifold or a hydraulic separator (low-loss header).'),
    text: [
      t('Add one when several sources and/or several circuits share one header — often with a primary pump between the boiler and the header.'),
      t('Every circuit on it is fed by its sources, so a boiler added to the manifold heats all of them.'),
      t('A simple house — one boiler straight into one loop — does not need one: skip it.'),
    ],
  };
}

/** When the manifold pump runs, in one sentence. */
export function primaryPumpText(sources: string[], runOnMin: number): string {
  return sources.length
    ? t('Runs while one of its sources ({sources}) or a pump of its circuits runs. After the sources stop it runs {n} min more, or until the last circuit pump stops if that is later. Before a boiler starts, it moves the water first.', {
        sources: sources.join(', '),
        n: runOnMin,
      })
    : t('Runs while a source of the manifold or a pump of its circuits runs. After the sources stop it runs {n} min more, or until the last circuit pump stops if that is later.', { n: runOnMin });
}

function primaryPumpHint(): InfoHintContent {
  return {
    title: t('The pump between the sources and the manifold (primary pump).'),
    text: [
      t('{product} runs it while a source that feeds the manifold runs or any pump of its circuits runs, and keeps it on for its run-on after the stop, so the boiler gives away its heat.', {
        product: brand.productName,
      }),
      t('It also runs first, before a boiler or heat pump starts, so water moves through it; and once a week for a short anti-seize run.'),
      { lead: t('If empty:'), text: t('the manifold has no pump of its own; the circuit pumps move the water.') },
    ],
  };
}

function pumpChip(pump: Pump | undefined, live: PumpState | undefined, now: number): { tone: Tone; label: string } {
  if (!pump) return { tone: 'off', label: t('No pump') };
  if (live && !live.available) return { tone: 'err', label: t('Pump unavailable') };
  if (live?.state === 'run_on' && live.runOnUntil && live.runOnUntil > now) return { tone: 'hold', label: t('Run-on until {time}', { time: fmtTime(live.runOnUntil) }) };
  if (live?.on) return { tone: 'heat', label: t('Pump running') };
  return { tone: 'off', label: t('Pump off') };
}

/** The manifold cards next to the circuits (`phone`: a plain block above the circuits). */
export function ManifoldsSection({ d, phone, onEdit }: { d: SystemData; phone?: boolean; onEdit: (id: Id | null) => void }) {
  const { manifolds, pumps } = useManifolds();
  const list = manifolds.data ?? [];
  return (
    <Section
      id="manifolds"
      variant={phone ? 'plain' : 'card'}
      title={t('Manifold')}
      level={phone ? 3 : 2}
      subtitle={t('Where the sources meet the circuits. Most houses have one; a simple house can skip it.')}
      hint={manifoldHint()}
      action={
        d.canEdit ? (
          <Button variant="outline" size="sm" icon="plus" onClick={() => onEdit(null)}>
            {t('Manifold')}
          </Button>
        ) : undefined
      }
    >
      <Stack gap="md">
        {list.map((m) => (
          <ManifoldCard key={m.id} d={d} m={m} pump={(pumps.data ?? []).find((p) => p.manifoldId === m.id)} onEdit={() => onEdit(m.id)} />
        ))}
        {manifolds.settled && !list.length ? <Text>{t('No manifold yet. Add one if your boiler or heat pump and your circuits meet at a manifold or a hydraulic separator.')}</Text> : null}
      </Stack>
    </Section>
  );
}

function ManifoldCard({ d, m, pump, onEdit }: { d: SystemData; m: Manifold; pump: Pump | undefined; onEdit: () => void }) {
  const live = d.plant?.manifolds.find((x) => x.manifoldId === m.id);
  const pumpLive = pump ? d.plant?.manifoldPumps.find((p) => p.pumpId === pump.id) : undefined;
  const circuits = (d.circuits.data ?? []).filter((c) => c.config.manifoldId === m.id);
  const sources = m.sourceIds.map(d.nameOf);
  const chip = pumpChip(pump, pumpLive, d.now);
  const rows: KeyValueRow[] = [
    { key: t('Sources feeding it'), value: sources.length ? sources.join(', ') : t('nothing yet'), hint: t('The boilers and heat pumps whose water goes into this manifold. Every circuit on it is fed by them.') },
    { key: t('Circuits on it'), value: circuits.length ? circuits.map((c) => c.config.shortName || c.config.name).join(', ') : t('none yet') },
    {
      key: t('Manifold pump'),
      value: pump ? `${pump.entityId} · ${t('run-on')} ${t('{n} min', { n: pump.runOnHeatMin })}` : t('no pump of its own'),
      hint: primaryPumpHint(),
    },
  ];
  if (m.supplySensorEntityId || m.returnSensorEntityId) {
    const fmt = (v: number | null | undefined) => (v == null ? '—' : fmtTemp(v, { decimals: 0 }));
    rows.push({ key: t('Flow / return'), value: `${fmt(live?.supplyC)} / ${fmt(live?.returnC)}` });
  }
  return (
    <Section
      variant="well"
      level={3}
      icon="manifold"
      title={m.name}
      tag={<StatusChip tone={chip.tone} label={chip.label} />}
      inlineAction
      action={
        d.canEdit ? (
          <Button variant="link" size="sm" onClick={onEdit}>
            {t('Change')}
          </Button>
        ) : undefined
      }
    >
      <Stack gap="sm">
        <KeyValueList rows={rows} />
        {pump ? <Text>{primaryPumpText(sources, pump.runOnHeatMin)}</Text> : null}
        {!sources.length ? (
          <StatusBanner tone="warn" icon="alert" text={t('No source feeds this manifold yet: choose the boiler or heat pump that sends water into it.')} />
        ) : null}
      </Stack>
    </Section>
  );
}

function uniqueName(base: string, taken: readonly string[]): string {
  const lower = new Set(taken.map((x) => x.trim().toLowerCase()));
  if (!lower.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!lower.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

/**
 * Create or change a manifold: its name, the sources that feed it, the circuits on it, its pump and
 * sensors — saved together. `onSaved` gets the manifold (the source wizard selects a new one).
 */
export function ManifoldDrawer({ d, id, onClose, onSaved }: { d: SystemData; id: Id | null; onClose: () => void; onSaved?: (m: Manifold) => void }) {
  const { manifolds, pumps } = useManifolds();
  const list = manifolds.data ?? [];
  const m = id ? (list.find((x) => x.id === id) ?? null) : null;
  const primary = m ? (pumps.data ?? []).find((p) => p.manifoldId === m.id) : undefined;
  const central = (d.sources.data ?? []).filter((s) => s.config.scope === 'central');
  const circuits = d.circuits.data ?? [];
  const [name, setName] = useState(() => m?.name ?? uniqueName(t('Manifold'), list.map((x) => x.name)));
  // a new manifold is fed by every boiler and heat pump and takes every circuit not on another one
  const [sourceIds, setSourceIds] = useState<Id[]>(() => m?.sourceIds ?? central.map((s) => s.config.id));
  const [circuitIds, setCircuitIds] = useState<Id[]>(() =>
    m ? circuits.filter((c) => c.config.manifoldId === m.id).map((c) => c.config.id) : circuits.filter((c) => !c.config.manifoldId).map((c) => c.config.id),
  );
  const [pumpEntity, setPumpEntity] = useState<string | null>(primary?.entityId ?? null);
  const [runOn, setRunOn] = useState(primary?.runOnHeatMin ?? DEFAULT_RUN_ON);
  const [supply, setSupply] = useState<string | null>(m?.supplySensorEntityId ?? null);
  const [ret, setRet] = useState<string | null>(m?.returnSensorEntityId ?? null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const pumpSearch = useEntitySearch('pump');
  const sensorSearch = useEntitySearch('temperature');

  const reload = () => {
    void manifolds.reload();
    void pumps.reload();
    void d.circuits.reload();
  };
  const save = useMutation(
    () => {
      const body: ManifoldCreateRequest = {
        name: name.trim(),
        supplySensorEntityId: supply,
        returnSensorEntityId: ret,
        sourceIds,
        circuitIds,
        pump: pumpEntity ? { entityId: pumpEntity, runOnHeatMin: runOn, ...(primary ? {} : { name: t('Manifold pump') }) } : null,
      };
      return m ? api.manifolds.patch(m.id, body) : api.manifolds.create(body);
    },
    {
      onSuccess: (saved) => {
        reload();
        onSaved?.(saved);
        onClose();
      },
      okToast: m ? t('Manifold saved') : t('Manifold added'),
      errorToast: false,
    },
  );
  const remove = useMutation(() => api.manifolds.remove((m as Manifold).id), {
    onSuccess: () => {
      reload();
      onClose();
    },
    okToast: t('Manifold deleted'),
  });

  const toggle = (ids: Id[], x: Id, on: boolean) => (on ? [...ids.filter((y) => y !== x), x] : ids.filter((y) => y !== x));
  const sourceNames = sourceIds.map(d.nameOf);
  const attached = m ? circuits.filter((c) => c.config.manifoldId === m.id) : [];
  const error = changeErrorText(save.error);
  return (
    <Drawer
      open
      onClose={onClose}
      title={m ? m.name : t('New manifold')}
      width={560}
      footer={
        <Row gap="sm" justify={m ? 'between' : 'end'} wrap>
          {m ? (
            <Button variant="danger" onClick={() => setConfirmDelete(true)}>
              {t('Delete')}
            </Button>
          ) : null}
          <Row gap="sm">
            <Button variant="secondary" onClick={onClose}>
              {t('Cancel')}
            </Button>
            <Button variant="primary" onClick={() => void save.run()} disabled={!name.trim()} loading={save.pending}>
              {t('Save')}
            </Button>
          </Row>
        </Row>
      }
    >
      <Stack gap="lg">
        {!m ? <StatusBanner tone="event" icon="info" text={t('Most houses have one manifold. A simple house — one boiler straight into one loop — can skip it.')} /> : null}
        {error ? <StatusBanner tone="err" icon="alert" text={error} /> : null}
        <TextField label={t('Name')} value={name} maxLength={40} placeholder={t('Manifold')} onChange={setName} error={save.issues.name} />

        <Section variant="plain" level={3} title={t('Sources feeding it')} hint={t('The boilers and heat pumps whose water goes into this manifold. Every circuit on it is fed by them.')}>
          <Stack gap="xs">
            {central.map((s) => (
              <CheckboxRow
                key={s.config.id}
                checked={sourceIds.includes(s.config.id)}
                title={d.nameOf(s.config.id)}
                onChange={(on) => setSourceIds((x) => toggle(x, s.config.id, on))}
              />
            ))}
            {!central.length ? (
              <StatusBanner tone="event" icon="info" text={t('No boiler or heat pump yet. Add one under «Sources» and choose this manifold there.')} action={{ label: t('Sources'), to: paths.sources() }} />
            ) : null}
          </Stack>
        </Section>

        <Section variant="plain" level={3} title={t('Circuits on it')} hint={t('The heating loops that take water from this manifold. A circuit can be on one manifold only.')}>
          <Stack gap="xs">
            {circuits.map((c) => {
              const other = c.config.manifoldId && c.config.manifoldId !== m?.id ? list.find((x) => x.id === c.config.manifoldId) : undefined;
              const rooms = c.memberRoomIds.map((r) => d.roomName(r) ?? r).join(', ');
              return (
                <CheckboxRow
                  key={c.config.id}
                  checked={circuitIds.includes(c.config.id)}
                  title={c.config.name}
                  hint={other && !circuitIds.includes(c.config.id) ? t('now on «{name}»', { name: other.name }) : rooms || undefined}
                  onChange={(on) => setCircuitIds((x) => toggle(x, c.config.id, on))}
                />
              );
            })}
            {!circuits.length ? <StatusBanner tone="event" icon="info" text={t('No circuits yet. Add them under «Circuits & pumps», then put them on the manifold.')} /> : null}
          </Stack>
        </Section>

        <Section variant="plain" level={3} title={t('Manifold pump')} hint={primaryPumpHint()}>
          <Stack gap="sm">
            <EntityPicker
              ariaLabel={t('Manifold pump')}
              placeholder={t('The pump: switch, plug or relay (optional)')}
              clearable
              value={pumpEntity}
              search={pumpSearch}
              onChange={(v) => setPumpEntity(v)}
            />
            {pumpEntity ? (
              <>
                <Stepper
                  variant="compact"
                  label={t('Run-on after a stop')}
                  hint={runOnHint()}
                  value={runOn}
                  text={t('{n} min', { n: runOn })}
                  min={0}
                  max={30}
                  step={1}
                  onChange={setRunOn}
                  ariaDec={t('Shorter run-on')}
                  ariaInc={t('Longer run-on')}
                />
                <Text>{primaryPumpText(sourceNames, runOn)}</Text>
              </>
            ) : null}
          </Stack>
        </Section>

        <Section variant="plain" level={3} subtitle={t('Flow sensor')} hint={t('The temperature of the water leaving the manifold to the circuits. Shown on the card and the schema; optional.')}>
          <EntityPicker ariaLabel={t('Flow sensor')} placeholder={t('Flow temperature sensor (optional)')} clearable value={supply} search={sensorSearch} onChange={(v) => setSupply(v)} />
        </Section>
        <Section variant="plain" level={3} subtitle={t('Return sensor')} hint={t('The temperature of the water coming back from the circuits. Shown on the card and the schema; optional.')}>
          <EntityPicker ariaLabel={t('Return sensor')} placeholder={t('Return temperature sensor (optional)')} clearable value={ret} search={sensorSearch} onChange={(v) => setRet(v)} />
        </Section>
      </Stack>
      <ConfirmDialog
        open={confirmDelete}
        title={t('Delete «{name}»?', { name: m?.name ?? '' })}
        consequences={[
          attached.length
            ? t('Its circuits stay and keep their sources, now fed directly: {list}.', { list: attached.map((c) => c.config.name).join(', ') })
            : t('No circuits are on it.'),
          primary ? t('Its pump is switched off and no longer controlled: {entity}.', { entity: primary.entityId }) : t('It has no pump of its own.'),
        ]}
        confirm={{ label: t('Delete manifold'), tone: 'danger', onClick: () => void remove.run(), loading: remove.pending }}
        onCancel={() => setConfirmDelete(false)}
      />
    </Drawer>
  );
}
