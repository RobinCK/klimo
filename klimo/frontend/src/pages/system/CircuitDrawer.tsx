/**
 * A circuit's settings: what it is and what feeds it, its sensors and mixing valve, its pumps. A new
 * circuit gets its mode, pump and run-on here too, so it works from the moment it is saved; an
 * existing one changes those on its card.
 */
import { useState } from 'react';
import type { Circuit, CircuitCreateRequest, CircuitDto, CircuitKind, CircuitMode, Id, Pump, PumpGroupMode } from '@api/model';
import { api } from '@api/endpoints';
import { useEntitySearch, useMutation, useResource } from '@data';
import {
  Button,
  CheckboxRow,
  ConfirmDialog,
  Drawer,
  EntityPicker,
  IconButton,
  RadioCardList,
  Row,
  Section,
  SegmentedControl,
  Select,
  Stack,
  StatusBanner,
  Stepper,
  TextField,
} from '@ui';
import { circuitKindLabel, fmtTemp, pumpGroupModeLabel, t } from '@i18n';
import type { SystemData } from './shared';
import { bypassHint, flowSensorHint, mixingHeatHint, mixingValveHint, pumpHint, returnSensorHint, runOnHint } from './circuitHints';
import { changeErrorText, modeLabel, modeOptions, modeWords } from './circuitTexts';

const KINDS: readonly CircuitKind[] = ['radiators', 'floor', 'fancoil', 'other'];

/** New loops start as most houses run them: a floor as a whole with its source, radiators by the rooms. */
const defaultMode = (kind: CircuitKind): CircuitMode => (kind === 'floor' ? 'follow_source' : 'zoned');
const defaultRunOn = (kind: CircuitKind): number => (kind === 'floor' ? 10 : 3);

function emptyCircuit(kind: CircuitKind, sourceIds: Id[]): CircuitCreateRequest {
  return {
    name: '',
    shortName: '',
    kind,
    manifoldId: null,
    sourceIds,
    capabilities: { heat: true, cool: false },
    supply: { sensorEntityId: null, returnEntityId: null, coolC: 18, coolMaxC: 22 },
    mixingValve: null,
    dewMarginC: null,
    pumpGroupMode: 'all',
    flowSafety: false,
    mode: defaultMode(kind),
    bypass: false,
  };
}

export function CircuitDrawer({ d, dto, onClose }: { d: SystemData; dto: CircuitDto | null; onClose: () => void }) {
  const central = (d.sources.data ?? []).filter((s) => s.config.scope === 'central');
  const [draft, setDraft] = useState<CircuitCreateRequest>(() => {
    // a new loop is fed by every central heat source, as the wizard sets one up
    if (!dto) return emptyCircuit('radiators', central.filter((s) => s.config.capabilities.heat).map((s) => s.config.id));
    const { id: _id, order: _order, ...rest } = dto.config;
    return rest;
  });
  const [pumpEntityId, setPumpEntityId] = useState<string | null>(null);
  const [runOn, setRunOn] = useState(defaultRunOn('radiators'));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const manifolds = useResource('manifolds', api.manifolds.list, { reloadOn: ['manifold'] });
  const sensorSearch = useEntitySearch('temperature');
  const numberSearch = useEntitySearch('number');
  const pumpSearch = useEntitySearch('pump');
  const set = (p: Partial<CircuitCreateRequest>) => setDraft((x) => ({ ...x, ...p }));
  const setKind = (kind: CircuitKind) => {
    // a kind chosen before anything else brings its usual mode and run-on along
    set({ kind, ...(dto ? {} : { mode: defaultMode(kind), capabilities: { heat: true, cool: draft.capabilities.cool } }) });
    if (!dto) setRunOn(defaultRunOn(kind));
  };
  const save = useMutation(
    async () => {
      if (dto) return api.circuits.patch(dto.config.id, draft);
      const created = await api.circuits.create(draft);
      if (pumpEntityId) {
        await api.pumps.create({
          name: t('Pump {n}', { n: 1 }),
          circuitId: created.config.id,
          manifoldId: null,
          entityId: pumpEntityId,
          rule: draft.mode === 'follow_source' ? 'source' : 'rooms',
          runOnHeatMin: runOn,
          runOnCoolMin: 0,
          minOnSec: 60,
          exercise: true,
          speed: null,
          enabled: true,
        });
      }
      return created;
    },
    {
      onSuccess: () => {
        void d.circuits.reload();
        onClose();
      },
      okToast: dto ? t('Circuit saved') : t('Circuit added'),
      errorToast: false,
    },
  );
  const members = dto?.members ?? [];
  const remove = useMutation(() => api.circuits.remove((dto as CircuitDto).config.id, { force: members.length > 0 || (dto?.pumps.length ?? 0) > 0 }), {
    onSuccess: () => {
      void d.circuits.reload();
      onClose();
    },
    okToast: t('Circuit deleted'),
  });
  const valid = draft.name.trim().length > 0;
  const mode = draft.mode ?? defaultMode(draft.kind);
  const roomNames = [...new Set(members.map((m) => d.roomName(m.roomId) ?? m.roomId))];
  const error = changeErrorText(save.error);
  const deleteLines = [
    roomNames.length
      ? t('Its rooms are left without this loop and wait to be put on another one: {rooms}.', { rooms: roomNames.join(', ') })
      : t('No rooms are on it.'),
    dto?.pumps.length
      ? t('Its pumps are switched off and no longer controlled: {pumps}.', { pumps: dto.pumps.map((p) => p.entityId).join(', ') })
      : t('It has no pumps.'),
  ];
  return (
    <Drawer
      open
      onClose={onClose}
      title={dto ? dto.config.name : t('New circuit')}
      width={560}
      footer={
        <Row gap="sm" justify={dto ? 'between' : 'end'} wrap>
          {dto ? (
            <Button variant="danger" onClick={() => setConfirmDelete(true)}>
              {t('Delete')}
            </Button>
          ) : null}
          <Row gap="sm">
            <Button variant="secondary" onClick={onClose}>
              {t('Cancel')}
            </Button>
            <Button variant="primary" onClick={() => void save.run()} disabled={!valid} loading={save.pending}>
              {t('Save')}
            </Button>
          </Row>
        </Row>
      }
    >
      <Stack gap="lg">
        {error ? <StatusBanner tone="err" icon="alert" text={error} /> : null}
        <Select<CircuitKind>
          label={t('Kind')}
          ariaLabel={t('Kind')}
          value={draft.kind}
          options={KINDS.map((k) => ({ value: k, label: circuitKindLabel(k) }))}
          onChange={setKind}
        />
        <TextField
          label={t('Name')}
          value={draft.name}
          placeholder={draft.kind === 'floor' ? t('Underfloor heating') : t('Radiator circuit')}
          onChange={(name) => set({ name })}
          error={save.issues.name}
        />
        <TextField
          label={t('Short name (schema, phone)')}
          value={draft.shortName}
          placeholder={draft.kind === 'floor' ? t('Floor') : t('Radiators')}
          onChange={(shortName) => set({ shortName })}
        />
        <Section variant="plain" level={3} title={t('Fed by')}>
          <Stack gap="xs">
            {central.map((s) => (
              <CheckboxRow
                key={s.config.id}
                checked={draft.sourceIds.includes(s.config.id)}
                title={d.nameOf(s.config.id)}
                onChange={(on) => set({ sourceIds: on ? [...draft.sourceIds, s.config.id] : draft.sourceIds.filter((x) => x !== s.config.id) })}
              />
            ))}
            {!central.length ? <StatusBanner tone="event" icon="info" text={t('No central sources yet.')} /> : null}
            {central.length && !draft.sourceIds.length ? (
              <StatusBanner tone="warn" icon="alert" text={t('Nothing feeds this circuit: its rooms could not start a boiler or heat pump.')} />
            ) : null}
          </Stack>
        </Section>
        {!dto ? (
          <>
            <Section variant="plain" level={3} title={modeLabel(draft.kind)}>
              <RadioCardList<CircuitMode> ariaLabel={modeLabel(draft.kind)} value={mode} options={modeOptions(draft.kind, runOn, false)} onChange={(m) => set({ mode: m })} />
            </Section>
            <Section variant="plain" level={3} subtitle={t('Pump')} hint={pumpHint(60, modeWords(mode, draft.kind, runOn).title)}>
              <EntityPicker
                ariaLabel={t('Pump')}
                placeholder={t('The pump: switch, plug or relay (optional)')}
                clearable
                value={pumpEntityId}
                search={pumpSearch}
                onChange={(id) => setPumpEntityId(id)}
              />
            </Section>
            {pumpEntityId ? (
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
            ) : null}
          </>
        ) : null}
        {mode === 'zoned' && draft.kind === 'floor' ? (
          <Section variant="plain" level={3} subtitle={t('Bypass')} hint={bypassHint()}>
            <CheckboxRow
              checked={draft.bypass ?? false}
              title={t('Water can flow with every zone closed')}
              hint={t('An open bypass valve, or a loop that is never fully shut.')}
              onChange={(bypass) => set({ bypass })}
            />
          </Section>
        ) : null}
        <Select<string>
          label={t('Manifold')}
          ariaLabel={t('Manifold')}
          value={draft.manifoldId ?? ''}
          options={[{ value: '', label: t('No manifold') }, ...(manifolds.data ?? []).map((m) => ({ value: m.id, label: m.name }))]}
          onChange={(v) => set({ manifoldId: v || null })}
        />
        <Section variant="plain" level={3} title={t('What it can do')}>
          <Stack gap="xs">
            <CheckboxRow checked={draft.capabilities.heat} title={t('Heat')} onChange={(heat) => set({ capabilities: { ...draft.capabilities, heat } })} />
            <CheckboxRow
              checked={draft.capabilities.cool}
              title={t('Cool')}
              hint={t('Floor cooling; the flow is kept above the dew point.')}
              onChange={(cool) => set({ capabilities: { ...draft.capabilities, cool } })}
            />
          </Stack>
        </Section>
        <Section variant="plain" level={3} subtitle={t('Flow sensor')} hint={flowSensorHint(d.settings.data?.safety.frostSupplyAlertC ?? null, draft.capabilities.cool)}>
          <EntityPicker
            ariaLabel={t('Flow sensor')}
            placeholder={t('Flow temperature sensor (optional)')}
            clearable
            value={draft.supply.sensorEntityId}
            search={sensorSearch}
            onChange={(id) => set({ supply: { ...draft.supply, sensorEntityId: id } })}
          />
        </Section>
        <Section variant="plain" level={3} subtitle={t('Return sensor')} hint={returnSensorHint()}>
          <EntityPicker
            ariaLabel={t('Return sensor')}
            placeholder={t('Return temperature sensor (optional)')}
            clearable
            value={draft.supply.returnEntityId}
            search={sensorSearch}
            onChange={(id) => set({ supply: { ...draft.supply, returnEntityId: id } })}
          />
        </Section>
        <Section variant="plain" level={3} subtitle={t('Mixing valve')} hint={mixingValveHint()}>
          <EntityPicker
            ariaLabel={t('Mixing valve')}
            placeholder={t('Mixing valve number entity (optional)')}
            clearable
            value={draft.mixingValve?.entityId ?? null}
            search={numberSearch}
            onChange={(id) =>
              set({ mixingValve: id ? { entityId: id, heatC: draft.mixingValve?.heatC ?? 35, coolC: draft.mixingValve?.coolC ?? null } : null })
            }
          />
        </Section>
        {draft.mixingValve ? (
          <Stepper
            variant="compact"
            label={t('Valve mixes the heating flow down to')}
            hint={mixingHeatHint()}
            value={draft.mixingValve.heatC}
            text={fmtTemp(draft.mixingValve.heatC, { decimals: 0 })}
            min={20}
            max={60}
            step={1}
            onChange={(heatC) => set({ mixingValve: { ...(draft.mixingValve as NonNullable<Circuit['mixingValve']>), heatC } })}
            ariaDec={t('Lower')}
            ariaInc={t('Higher')}
          />
        ) : null}
        <SegmentedControl<PumpGroupMode>
          ariaLabel={t('Several pumps')}
          value={draft.pumpGroupMode}
          options={(['all', 'duty_standby'] as const).map((m) => ({ value: m, label: pumpGroupModeLabel(m) }))}
          onChange={(pumpGroupMode) => set({ pumpGroupMode })}
          hint={
            draft.pumpGroupMode === 'duty_standby'
              ? t('One pump runs, the other takes over when it fails; they swap every week.')
              : t('All pumps of the circuit run together.')
          }
        />
        <CheckboxRow
          checked={draft.flowSafety}
          title={t('Flow for the source')}
          hint={t('When a boiler or heat pump runs and no pump is on, this circuit’s pump is switched on so water always moves.')}
          onChange={(flowSafety) => set({ flowSafety })}
        />
        {dto ? <PumpsEditor d={d} dto={dto} /> : null}
      </Stack>
      <ConfirmDialog
        open={confirmDelete}
        title={t('Delete «{name}»?', { name: dto?.config.name ?? '' })}
        body={roomNames.length ? t('To keep the rooms heated, merge this circuit into another one instead.') : undefined}
        consequences={deleteLines}
        confirm={{ label: t('Delete circuit'), tone: 'danger', onClick: () => void remove.run(), loading: remove.pending }}
        onCancel={() => setConfirmDelete(false)}
      />
    </Drawer>
  );
}

function PumpsEditor({ d, dto }: { d: SystemData; dto: CircuitDto }) {
  const search = useEntitySearch('pump');
  const first = dto.pumps[0];
  const [removing, setRemoving] = useState<Pump | null>(null);
  const add = useMutation(
    (entityId: string) =>
      api.pumps.create({
        name: t('Pump {n}', { n: dto.pumps.length + 1 }),
        circuitId: dto.config.id,
        manifoldId: null,
        entityId,
        rule: dto.config.mode === 'follow_source' ? 'source' : 'rooms',
        runOnHeatMin: first?.runOnHeatMin ?? defaultRunOn(dto.config.kind),
        runOnCoolMin: first?.runOnCoolMin ?? 0,
        minOnSec: 60,
        exercise: true,
        speed: null,
        enabled: true,
      }),
    { onSuccess: () => void d.circuits.reload(), okToast: t('Pump added') },
  );
  const patch = useMutation((id: Id, p: Partial<Pump>) => api.pumps.patch(id, p), { onSuccess: () => void d.circuits.reload() });
  const remove = useMutation((id: Id) => api.pumps.remove(id), {
    onSuccess: () => {
      setRemoving(null);
      void d.circuits.reload();
    },
    okToast: t('Pump removed'),
  });
  const exercise = useMutation((id: Id) => api.pumps.exercise(id), { okToast: t('The pump runs for a minute now') });
  return (
    <Section variant="plain" level={3} title={t('Pumps')} hint={pumpHint(first?.minOnSec ?? null, modeWords(dto.config.mode, dto.config.kind, first?.runOnHeatMin ?? null).title)}>
      <Stack gap="md">
        {dto.pumps.map((p) => (
          <Section key={p.id} variant="well" level={3} title={p.name} subtitle={p.entityId}>
            <Stack gap="sm">
              <CheckboxRow checked={p.enabled} title={t('In operation')} onChange={(enabled) => void patch.run(p.id, { enabled })} />
              <CheckboxRow
                checked={p.exercise}
                title={t('Weekly anti-seize run')}
                hint={t('A short run once a week, so the pump does not seize in summer.')}
                onChange={(on) => void patch.run(p.id, { exercise: on })}
              />
              <Row gap="sm" wrap>
                <Button variant="secondary" size="sm" icon="play" onClick={() => void exercise.run(p.id)}>
                  {t('Run for a minute')}
                </Button>
                <IconButton icon="trash" label={t('Remove {name}', { name: p.name })} variant="ghost" onClick={() => setRemoving(p)} />
              </Row>
            </Stack>
          </Section>
        ))}
        <EntityPicker
          ariaLabel={t('Add a pump')}
          placeholder={t('Add a pump: switch, plug or relay…')}
          value={null}
          search={search}
          onChange={(id) => id && void add.run(id)}
        />
      </Stack>
      <ConfirmDialog
        open={removing !== null}
        title={t('Remove the pump «{name}»?', { name: removing?.name ?? '' })}
        consequences={[
          t('{entity} is switched off and no longer controlled.', { entity: removing?.entityId ?? '' }),
          dto.pumps.length === 1 ? t('The circuit is left without a pump: no water is moved for it, its rooms still ask the source for heat.') : t('The other pumps of the circuit keep working.'),
        ]}
        confirm={{ label: t('Remove the pump'), tone: 'danger', onClick: () => removing && void remove.run(removing.id), loading: remove.pending }}
        onCancel={() => setRemoving(null)}
      />
    </Section>
  );
}
