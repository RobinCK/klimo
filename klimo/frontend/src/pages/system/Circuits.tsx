/**
 * «Контури й насоси»: when each circuit's pumps run (a room of the circuit asks, the source
 * runs, or both) and how long they run on after a stop to take the heat out of the loop. This
 * replaces the usual «pump with the boiler + 10 min» automation. The drawer edits the rest.
 */
import { useState } from 'react';
import type { Circuit, CircuitCreateRequest, CircuitDto, CircuitKind, Id, Pump, PumpGroupMode, PumpRule } from '@api/model';
import { api } from '@api/endpoints';
import { useAutosave, useEntitySearch, useMutation, useResource } from '@data';
import {
  Button,
  CheckboxRow,
  CircuitCard,
  ConfirmDialog,
  Drawer,
  EntityPicker,
  IconButton,
  Row,
  Section,
  SegmentedControl,
  Select,
  Stack,
  StatusBanner,
  Stepper,
  TextField,
} from '@ui';
import { circuitKindLabel, fmtDur, fmtTemp, fmtTime, pumpGroupModeLabel, t } from '@i18n';
import type { SystemData } from './shared';
import { flowSensorHint, mixingHeatHint, mixingValveHint, pumpHint, pumpRuleHint, returnSensorHint, runOnHint } from './circuitHints';

const RULES: readonly PumpRule[] = ['rooms', 'source', 'both'];

function ruleText(r: PumpRule): string {
  switch (r) {
    case 'rooms':
      return t('a room of the circuit asks');
    case 'source':
      return t('a source runs');
    case 'both':
      return t('source and room');
  }
}

function pumpChip(dto: CircuitDto, now: number): { tone: CircuitDto['state']['tone']; label: string } {
  const s = dto.state;
  if (!dto.pumps.length) return { tone: 'off', label: t('No pump') };
  if (s.pumps.some((p) => !p.available)) return { tone: 'err', label: t('Pump unavailable') };
  if (s.runOnUntil && s.runOnUntil > now) return { tone: s.tone, label: t('Run-on until {time}', { time: fmtTime(s.runOnUntil) }) };
  if (s.pumpOn) return { tone: s.tone === 'idle' || s.tone === 'off' ? 'hold' : s.tone, label: t('Pump running') };
  return { tone: 'off', label: t('Pump off') };
}

function circuitNote(dto: CircuitDto, rule: PumpRule, runOn: number, dewMargin: number): string {
  const parts: string[] = [];
  if (rule === 'rooms') parts.push(t('The pump does not spin for nothing: when every valve is closed it stops, even while a source runs.'));
  if (rule === 'source')
    parts.push(t('The pump runs with the source and {dur} after it — like the usual «pump with the boiler» automation.', { dur: fmtDur(runOn) }));
  if (rule === 'both') parts.push(t('The pump runs while a source runs and a room of the circuit asks.'));
  if (dto.config.capabilities.cool)
    parts.push(t('Floor cooling only while the flow stays {margin} above the dew point.', { margin: fmtTemp(dewMargin, { decimals: 0 }) }));
  return parts.join(' ');
}

export function CircuitsSection({ d }: { d: SystemData }) {
  const [editing, setEditing] = useState<{ id: Id | null } | null>(null);
  const strategy = useResource('strategy', api.strategy.get, { reloadOn: ['strategy'] });
  const list = d.circuits.data ?? [];
  return (
    <Section
      id="circuits"
      title={t('Circuits & pumps')}
      subtitle={t('Any number of pumps — each with its own rule and run-on.')}
      action={
        d.canEdit ? (
          <Button variant="outline" size="sm" icon="plus" onClick={() => setEditing({ id: null })}>
            {t('Circuit')}
          </Button>
        ) : undefined
      }
    >
      <Stack gap="md">
        {list.map((c) => (
          <CircuitItem
            key={c.config.id}
            d={d}
            dto={c}
            dewMargin={c.config.dewMarginC ?? strategy.data?.cool.dewMarginC ?? 2}
            onEdit={() => setEditing({ id: c.config.id })}
          />
        ))}
        {d.circuits.settled && !list.length ? (
          <StatusBanner
            tone="event"
            icon="info"
            text={t('No circuits yet. Add one when a pump moves water from a boiler or heat pump to radiators or a floor.')}
          />
        ) : null}
      </Stack>
      {editing ? <CircuitDrawer d={d} dto={list.find((c) => c.config.id === editing.id) ?? null} onClose={() => setEditing(null)} /> : null}
    </Section>
  );
}

function CircuitItem({ d, dto, dewMargin, onEdit }: { d: SystemData; dto: CircuitDto; dewMargin: number; onEdit: () => void }) {
  const pumps = dto.pumps;
  const first = pumps[0] as Pump | undefined;
  // the rule and run-on are kept the same on every pump of a circuit (duty and standby)
  const savePumps = (p: Partial<Pump>) => Promise.all(pumps.map((x) => api.pumps.patch(x.id, p))).then(() => d.circuits.reload());
  const rule = useAutosave<PumpRule>(first?.rule ?? 'rooms', (v) => savePumps({ rule: v }), { debounceMs: 0 });
  const runOn = useAutosave(first?.runOnHeatMin ?? 0, (v) => savePumps({ runOnHeatMin: v }));
  const valve = dto.config.mixingValve;
  const extra = [
    pumps.length > 1 ? t('{count} pumps · {mode}', { count: pumps.length, mode: pumpGroupModeLabel(dto.config.pumpGroupMode).toLowerCase() }) : null,
    valve ? t('valve {entity}', { entity: valve.entityId }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const feeds = dto.config.sourceIds.map(d.nameOf);
  const excluded = new Map(dto.state.excludedRooms.map((x) => [x.roomId, x.reason]));
  const chips: { label: string; tone?: CircuitDto['state']['tone'] }[] = [];
  if (feeds.length) chips.push({ label: t('from {list}', { list: feeds.join(', ') }), tone: 'heat' });
  if (valve) chips.push({ label: t('heating {t}', { t: fmtTemp(valve.heatC, { decimals: 0 }) }), tone: 'heat' });
  if (dto.config.capabilities.cool) chips.push({ label: t('cooling {t}', { t: fmtTemp(dto.config.supply.coolC, { decimals: 0 }) }), tone: 'cool' });
  else chips.push({ label: t('heating only') });
  for (const id of dto.memberRoomIds) {
    const why = excluded.get(id);
    const name = d.roomName(id) ?? id;
    chips.push({ label: why === 'humid' ? t('{room} · too humid', { room: name }) : why === 'heat_only' ? t('{room} · heating only', { room: name }) : name });
  }
  const label = dto.config.shortName || dto.config.name;
  return (
    <Stack gap="xs">
      <CircuitCard<PumpRule>
        name={dto.config.name}
        pumpEntity={pumps.map((p) => p.entityId).join(', ') || '—'}
        extra={extra || undefined}
        chip={pumpChip(dto, d.now)}
        ruleLabel={t('The pump runs when')}
        pumpHint={pumpHint(first?.minOnSec ?? null)}
        ruleHint={pumpRuleHint({ rooms: ruleText('rooms'), source: ruleText('source'), both: ruleText('both') })}
        rule={{
          ariaLabel: t('When the pump of {circuit} runs', { circuit: label }),
          value: rule.value,
          options: RULES.map((r) => ({ value: r, label: ruleText(r), disabled: !d.canEdit || !first })),
          onChange: (v) => rule.set(v),
        }}
        runOn={{
          label: t('Run-on after a stop'),
          sub: t('takes the remaining heat out of the loop'),
          value: runOn.value,
          text: t('{n} min', { n: runOn.value }),
          min: 0,
          max: 30,
          step: 1,
          disabled: !d.canEdit || !first,
          onChange: (v) => runOn.set(v),
          ariaDec: t('Shorter run-on for {circuit}', { circuit: label }),
          ariaInc: t('Longer run-on for {circuit}', { circuit: label }),
          hint: runOnHint(),
        }}
        chips={chips}
        note={circuitNote(dto, rule.value, runOn.value, dewMargin)}
      />
      {d.canEdit ? (
        <Row justify="end">
          <Button variant="ghost" size="sm" icon="pencil" onClick={onEdit}>
            {t('Circuit and pumps')}
          </Button>
        </Row>
      ) : null}
    </Stack>
  );
}

/* ---------------- circuit drawer ---------------- */

const KINDS: readonly CircuitKind[] = ['radiators', 'floor', 'fancoil', 'other'];

function emptyCircuit(): CircuitCreateRequest {
  return {
    name: '',
    shortName: '',
    kind: 'radiators',
    manifoldId: null,
    sourceIds: [],
    capabilities: { heat: true, cool: false },
    supply: { sensorEntityId: null, returnEntityId: null, coolC: 18, coolMaxC: 22 },
    mixingValve: null,
    dewMarginC: null,
    pumpGroupMode: 'all',
    flowSafety: false,
  };
}

function CircuitDrawer({ d, dto, onClose }: { d: SystemData; dto: CircuitDto | null; onClose: () => void }) {
  const [draft, setDraft] = useState<CircuitCreateRequest>(() => {
    if (!dto) return emptyCircuit();
    const { id: _id, order: _order, ...rest } = dto.config;
    return rest;
  });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const manifolds = useResource('manifolds', api.manifolds.list, { reloadOn: ['manifold'] });
  const sensorSearch = useEntitySearch('temperature');
  const numberSearch = useEntitySearch('number');
  const set = (p: Partial<CircuitCreateRequest>) => setDraft((x) => ({ ...x, ...p }));
  const save = useMutation(() => (dto ? api.circuits.patch(dto.config.id, draft) : api.circuits.create(draft)), {
    onSuccess: () => {
      void d.circuits.reload();
      onClose();
    },
    okToast: dto ? t('Circuit saved') : t('Circuit added'),
  });
  const remove = useMutation(() => api.circuits.remove((dto as CircuitDto).config.id), {
    onSuccess: () => {
      void d.circuits.reload();
      onClose();
    },
    okToast: t('Circuit deleted'),
  });
  const central = (d.sources.data ?? []).filter((s) => s.config.scope === 'central');
  const valid = draft.name.trim().length > 0;
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
        <TextField label={t('Name')} value={draft.name} placeholder={t('Radiator circuit')} onChange={(name) => set({ name })} error={save.issues.name} />
        <TextField label={t('Short name (schema, phone)')} value={draft.shortName} placeholder={t('Radiators')} onChange={(shortName) => set({ shortName })} />
        <Select<CircuitKind>
          label={t('Kind')}
          ariaLabel={t('Kind')}
          value={draft.kind}
          options={KINDS.map((k) => ({ value: k, label: circuitKindLabel(k) }))}
          onChange={(kind) => set({ kind })}
        />
        <Select<string>
          label={t('Manifold')}
          ariaLabel={t('Manifold')}
          value={draft.manifoldId ?? ''}
          options={[{ value: '', label: t('No manifold') }, ...(manifolds.data ?? []).map((m) => ({ value: m.id, label: m.name }))]}
          onChange={(v) => set({ manifoldId: v || null })}
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
          </Stack>
        </Section>
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
        {dto ? <PumpsEditor d={d} dto={dto} /> : <StatusBanner tone="event" icon="info" text={t('Save the circuit first, then add its pumps.')} />}
      </Stack>
      <ConfirmDialog
        open={confirmDelete}
        title={t('Delete «{name}»?', { name: dto?.config.name ?? '' })}
        consequences={[t('Its pumps are no longer switched; the rooms keep their radiators and valves.')]}
        confirm={{ label: t('Delete circuit'), tone: 'danger', onClick: () => void remove.run(), loading: remove.pending }}
        onCancel={() => setConfirmDelete(false)}
      />
    </Drawer>
  );
}

function PumpsEditor({ d, dto }: { d: SystemData; dto: CircuitDto }) {
  const search = useEntitySearch('pump');
  const first = dto.pumps[0];
  const add = useMutation(
    (entityId: string) =>
      api.pumps.create({
        name: t('Pump {n}', { n: dto.pumps.length + 1 }),
        circuitId: dto.config.id,
        manifoldId: null,
        entityId,
        rule: first?.rule ?? (dto.config.kind === 'floor' ? 'source' : 'rooms'),
        runOnHeatMin: first?.runOnHeatMin ?? (dto.config.kind === 'floor' ? 10 : 3),
        runOnCoolMin: first?.runOnCoolMin ?? 0,
        minOnSec: 60,
        exercise: true,
        speed: null,
        enabled: true,
      }),
    { onSuccess: () => void d.circuits.reload(), okToast: t('Pump added') },
  );
  const patch = useMutation((id: Id, p: Partial<Pump>) => api.pumps.patch(id, p), { onSuccess: () => void d.circuits.reload() });
  const remove = useMutation((id: Id) => api.pumps.remove(id), { onSuccess: () => void d.circuits.reload(), okToast: t('Pump removed') });
  const exercise = useMutation((id: Id) => api.pumps.exercise(id), { okToast: t('The pump runs for a minute now') });
  return (
    <Section variant="plain" level={3} title={t('Pumps')} hint={pumpHint(first?.minOnSec ?? null)}>
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
                <IconButton icon="trash" label={t('Remove {name}', { name: p.name })} variant="ghost" onClick={() => void remove.run(p.id)} />
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
    </Section>
  );
}
