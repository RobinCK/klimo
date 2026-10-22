/**
 * «Нове джерело» in four steps: the kind (a template only fills in typical settings), the
 * Home Assistant entities, where it delivers, and its guards — then a two-minute test. The
 * source is created switched off unless its required entities are chosen.
 */
import { useEffect, useState } from 'react';
import type {
  AdapterType,
  CircuitDto,
  Id,
  SourceAdapter,
  SourceBinding,
  SourceConfig,
  SourceEnergy,
  SourceKind,
  SourceTemplate,
  SourceTestResult,
} from '@api/model';
import { api } from '@api/endpoints';
import { useMutation, useResource } from '@data';
import {
  AutoGrid,
  Button,
  CheckboxRow,
  EntityBindingTable,
  GuardList,
  MobileTopBar,
  Row,
  Section,
  SegmentedControl,
  Select,
  Skeleton,
  Stack,
  StatusBanner,
  TextField,
  ToggleChip,
  TypePickerCard,
  WizardShell,
  type EntityBindingRow,
} from '@ui';
import { adapterLabel, fmtDur, fmtDurSec, sourceKindLabel, sourceTemplateCan, sourceTemplateHint, sourceTemplateHow, t } from '@i18n';
import { SOURCE_ICON, type SystemData } from '../shared';
import { applySiblings, draftRows, emptyAdapter, mainEntity, rolePreset, roleLabel, setRole } from './bindings';
import { bindingHint, type HintSource } from './hints';
import { PickEntityDialog } from './SourceDialogs';

const ADAPTERS: readonly AdapterType[] = ['relay', 'climate', 'flow', 'script'];
const STEPS = 4;

interface Draft {
  kind: SourceKind;
  name: string;
  roomId: Id | null;
  adapter: SourceAdapter;
  energy: SourceEnergy;
  capabilities: SourceConfig['capabilities'];
  circuitIds: Id[];
  enable: boolean;
}

function fromTemplate(tpl: SourceTemplate, d: SystemData): Draft {
  return {
    kind: tpl.kind,
    name: sourceKindLabel(tpl.kind),
    roomId: tpl.scope === 'room' ? (d.rooms[0]?.id ?? null) : null,
    adapter: tpl.defaults.adapter,
    energy: tpl.defaults.energy,
    capabilities: tpl.defaults.capabilities,
    circuitIds: [],
    enable: true,
  };
}

export function AddSource({ d, phone, onClose, onCreated }: { d: SystemData; phone: boolean; onClose: () => void; onCreated: (id: Id) => void }) {
  const templates = useResource('source-templates', api.sources.templates);
  const [step, setStep] = useState(1);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [created, setCreated] = useState<Id | null>(null);
  const [test, setTest] = useState<SourceTestResult | null>(null);
  const [checked, setChecked] = useState<SourceBinding[] | null>(null);

  const list = templates.data ?? [];
  const tpl = list.find((x) => x.kind === draft?.kind) ?? null;
  useEffect(() => {
    if (!draft && list.length) setDraft(fromTemplate(list.find((x) => x.kind === 'electric_boiler') ?? list[0], d));
  }, [draft, list, d]);

  // live values of what is chosen so far, checked by the server
  useEffect(() => {
    if (!draft || step !== 2) return;
    const timer = window.setTimeout(() => {
      api.sources.validateBindings({ adapter: draft.adapter, capabilities: draft.capabilities }).then(
        (r) => setChecked(r.rows),
        () => setChecked(null),
      );
    }, 300);
    return () => window.clearTimeout(timer);
  }, [draft, step]);

  const create = useMutation(
    async () => {
      if (!draft || !tpl) throw new Error('no draft');
      const dto = await api.sources.create({
        kind: draft.kind,
        name: draft.name.trim(),
        scope: tpl.scope,
        roomId: tpl.scope === 'room' ? draft.roomId : null,
        adapterType: draft.adapter.type,
      });
      const id = dto.config.id;
      const ready = requiredSet(draft);
      await api.sources.patch(id, { adapter: draft.adapter, energy: draft.energy, capabilities: draft.capabilities, enabled: draft.enable && ready });
      for (const cid of draft.circuitIds) {
        const c = d.circuits.data?.find((x) => x.config.id === cid);
        if (c && !c.config.sourceIds.includes(id)) await api.circuits.patch(cid, { sourceIds: [...c.config.sourceIds, id] });
      }
      return id;
    },
    {
      onSuccess: (id) => {
        setCreated(id);
        setStep(STEPS + 1);
        void d.sources.reload();
        void d.circuits.reload();
      },
    },
  );
  const runTest = useMutation((id: Id) => api.sources.test(id, { durationSec: 120 }), { onSuccess: setTest });

  if (!draft || !tpl) {
    return (
      <Section title={t('New source')}>
        {templates.error ? <StatusBanner tone="err" icon="alert" text={t('Could not load the source kinds.')} /> : <Skeleton height={280} radius={14} />}
      </Section>
    );
  }

  const set = (p: Partial<Draft>) => setDraft((x) => (x ? { ...x, ...p } : x));
  const pick = async (role: string, entityId: string | null) => {
    setPicking(null);
    let next = setRole(draft.adapter, draft.energy, role, entityId);
    if (entityId && mainEntity(next.adapter) === entityId) {
      try {
        const detail = await api.ha.entity(entityId);
        const filled = applySiblings(next.adapter, next.energy, detail);
        next = filled;
        if (filled.filled.length) setNotice(t('Also filled from the same device: {list}', { list: filled.filled.map(roleLabel).join(', ') }));
      } catch {
        // suggestions are a convenience; the pick itself stands
      }
    }
    set({ adapter: next.adapter, energy: next.energy });
  };

  const rows = draftRows(draft.adapter, draft.capabilities, draft.energy.powerEntityId);
  const live = new Map((checked ?? []).map((r) => [r.role, r]));
  const hintSource: HintSource = { kind: draft.kind, adapter: draft.adapter, energy: draft.energy, guards: tpl.defaults.guards };
  const bindingRows: EntityBindingRow[] = rows.map((b) => {
    const c = live.get(b.role);
    const status = !b.entityId ? (b.required ? 'empty' : 'info') : c?.status === 'ok' || !c ? 'ok' : c.status === 'unavailable' ? 'warn' : 'err';
    return {
      role: roleLabel(b.role),
      value: b.entityId ?? (b.required ? t('choose an entity') : t('optional')),
      mono: Boolean(b.entityId),
      live: c?.live ?? undefined,
      status,
      statusLabel: !b.entityId
        ? b.required
          ? t('choose')
          : undefined
        : status === 'ok'
          ? t('online')
          : c?.status === 'unavailable'
            ? t('unavailable')
            : t('check'),
      onPick: () => setPicking(b.role),
      hint: bindingHint(b.role, hintSource),
    };
  });

  const central = tpl.scope === 'central';
  const circuits: CircuitDto[] = d.circuits.data ?? [];
  const g = tpl.defaults.guards;
  const ready = requiredSet(draft);

  const title = step > STEPS ? t('Source added') : t('New source');
  const stepNames = [t('kind'), t('entities'), t('where it delivers'), t('guards')];
  const body = (() => {
    if (step > STEPS) {
      return (
        <Stack gap="md">
          <StatusBanner
            tone="ok"
            icon="checkCircle"
            text={
              ready && draft.enable
                ? t('«{name}» is in use. Test it for two minutes to be sure it answers.', { name: draft.name })
                : t('«{name}» is saved but not in use until its entities are chosen.', { name: draft.name })
            }
          />
          {test ? (
            <StatusBanner
              tone={test.status === 'ok' ? 'ok' : test.status === 'running' ? 'event' : 'err'}
              icon="play"
              text={
                test.status === 'running'
                  ? t('Test run for two minutes…')
                  : test.status === 'ok'
                    ? t('Test passed: confirmed in {dur}.', { dur: fmtDurSec(test.confirmAfterSec) })
                    : t('The test did not confirm the start — open the source to check its entities.')
              }
            />
          ) : null}
          <Row gap="sm" wrap>
            {ready && draft.enable && created ? (
              <Button variant="secondary" icon="play" onClick={() => void runTest.run(created)} loading={runTest.pending}>
                {t('Test for 2 min')}
              </Button>
            ) : null}
            <Button variant="primary" onClick={() => created && onCreated(created)}>
              {t('Open the source')}
            </Button>
          </Row>
        </Stack>
      );
    }
    switch (step) {
      case 1:
        return (
          <Stack gap="md">
            <AutoGrid min={200} gap="sm">
              {list.map((x) => (
                <TypePickerCard
                  key={x.kind}
                  icon={SOURCE_ICON[x.kind]}
                  name={sourceKindLabel(x.kind)}
                  can={sourceTemplateCan(x.kind)}
                  how={sourceTemplateHow(x.kind)}
                  selected={x.kind === draft.kind}
                  onClick={() => setDraft(fromTemplate(x, d))}
                />
              ))}
            </AutoGrid>
            <StatusBanner tone="event" icon="info" text={sourceTemplateHint(draft.kind)} />
          </Stack>
        );
      case 2:
        return (
          <Stack gap="md">
            <TextField label={t('Name')} value={draft.name} maxLength={40} onChange={(name) => set({ name })} />
            {!central ? (
              <Select
                label={t('Room')}
                ariaLabel={t('Room')}
                value={draft.roomId ?? ''}
                options={d.rooms.map((r) => ({ value: r.id, label: r.name }))}
                onChange={(roomId) => set({ roomId })}
              />
            ) : null}
            <SegmentedControl<AdapterType>
              ariaLabel={t('Way of control')}
              value={draft.adapter.type}
              options={ADAPTERS.map((a) => ({ value: a, label: adapterLabel(a) }))}
              onChange={(a) => set({ adapter: a === tpl.defaults.adapter.type ? tpl.defaults.adapter : emptyAdapter(a) })}
            />
            <EntityBindingTable ariaLabel={t('Entities of the source')} rows={bindingRows} />
            {notice ? <StatusBanner tone="ok" icon="sparkle" text={notice} /> : null}
          </Stack>
        );
      case 3:
        return (
          <Stack gap="md">
            <Section variant="plain" level={3} title={t('What it can do')}>
              <Row gap="sm" wrap>
                <ToggleChip
                  pressed={draft.capabilities.heat}
                  icon="flame"
                  label={t('Heat')}
                  accent="heat"
                  onToggle={() => set({ capabilities: { ...draft.capabilities, heat: !draft.capabilities.heat } })}
                />
                <ToggleChip
                  pressed={draft.capabilities.cool}
                  icon="snow"
                  label={t('Cool')}
                  accent="cool"
                  onToggle={() => set({ capabilities: { ...draft.capabilities, cool: !draft.capabilities.cool } })}
                />
                <ToggleChip
                  pressed={draft.capabilities.dry}
                  icon="droplet"
                  label={t('Dry')}
                  onToggle={() => set({ capabilities: { ...draft.capabilities, dry: !draft.capabilities.dry } })}
                />
                <ToggleChip
                  pressed={draft.capabilities.fan}
                  icon="fan"
                  label={t('Fan')}
                  onToggle={() => set({ capabilities: { ...draft.capabilities, fan: !draft.capabilities.fan } })}
                />
              </Row>
            </Section>
            {central ? (
              <Section variant="plain" level={3} title={t('Which circuits it feeds')}>
                <Stack gap="xs">
                  {circuits.map((c) => (
                    <CheckboxRow
                      key={c.config.id}
                      checked={draft.circuitIds.includes(c.config.id)}
                      title={c.config.name}
                      hint={c.memberRoomIds.map((id) => d.roomName(id) ?? id).join(', ')}
                      onChange={(on) => set({ circuitIds: on ? [...draft.circuitIds, c.config.id] : draft.circuitIds.filter((x) => x !== c.config.id) })}
                    />
                  ))}
                  {!circuits.length ? <StatusBanner tone="event" icon="info" text={t('No circuits yet — add them on the schema tab.')} /> : null}
                </Stack>
              </Section>
            ) : (
              <StatusBanner
                tone="event"
                icon="home"
                text={t('Heats or cools {room} directly, without a circuit.', { room: d.roomName(draft.roomId ?? '') ?? '' })}
              />
            )}
          </Stack>
        );
      default:
        return (
          <Stack gap="md">
            <GuardList
              items={[
                {
                  icon: 'shield',
                  title: t('Minimum run — {dur}', { dur: fmtDur(g.minRunMin) }),
                  text: t('Minimum pause — {dur}', { dur: fmtDur(g.minOffMin) }),
                },
                {
                  icon: 'swap',
                  title: t('Not running after {dur} → fault → the next source', { dur: fmtDur(g.startConfirmTimeoutMin) }),
                  text: t('Unavailable for {dur} counts as a fault too; a retry after {retry}.', {
                    dur: fmtDur(g.unavailableAfterMin),
                    retry: fmtDur(g.faultRetryMin),
                  }),
                },
              ]}
            />
            <StatusBanner tone="event" icon="info" text={t('Typical values for this kind; change them any time in the source.')} />
            <CheckboxRow
              checked={draft.enable && ready}
              disabled={!ready}
              title={t('Put in use right away')}
              hint={ready ? t('The strategy may start it as soon as it is saved.') : t('First choose the required entities on step 2.')}
              onChange={(enable) => set({ enable })}
            />
          </Stack>
        );
    }
  })();

  const shell = (
    <WizardShell
      step={Math.min(step, STEPS)}
      total={STEPS}
      done={step > STEPS}
      title={title}
      stepLabel={step > STEPS ? t('Done') : t('Step {n} of {total} · {name}', { n: step, total: STEPS, name: stepNames[step - 1] })}
      onClose={onClose}
      back={step > 1 && step <= STEPS ? { label: t('Back'), onClick: () => setStep((s) => s - 1) } : undefined}
      next={
        step > STEPS
          ? { label: t('Close'), onClick: onClose }
          : step < STEPS
            ? {
                label: step === 1 ? t('Next: Home Assistant entities') : t('Next'),
                onClick: () => setStep((s) => s + 1),
                disabled: step === 2 && !draft.name.trim(),
              }
            : { label: t('Create'), onClick: () => void create.run(), loading: create.pending, disabled: !draft.name.trim() }
      }
    >
      {body}
    </WizardShell>
  );

  return (
    <>
      {phone ? (
        <Stack gap="md">
          <MobileTopBar title={title} onBack={onClose} />
          {shell}
        </Stack>
      ) : (
        <Section accent="emphasis" ariaLabel={title}>
          {shell}
        </Section>
      )}
      {picking ? (
        <PickEntityDialog
          role={picking}
          preset={rolePreset(picking)}
          value={rows.find((r) => r.role === picking)?.entityId ?? null}
          onClose={() => setPicking(null)}
          onPick={(id) => void pick(picking, id)}
        />
      ) : null}
    </>
  );
}

/** The roles without which the source cannot be switched. */
function requiredSet(d: Draft): boolean {
  return draftRows(d.adapter, d.capabilities, d.energy.powerEntityId).every((r) => !r.required || r.entityId);
}
