/**
 * «Дії за тригерами»: what changes while a trigger is active — targets up or down, which
 * sources may or may not run, a power cap — and everything returns to the schedule when it
 * ends. The builder takes the condition, an optional extra stop and the list of effects.
 */
import { useMemo, useState } from 'react';
import type { ConditionNode, EnergyCarrier, Id, Mode, RuleDto, RuleEffect, SourceMode, TriggerRule } from '@api/model';
import { api } from '@api/endpoints';
import { useEntitySearch, useMutation } from '@data';
import {
  ActionRuleCard,
  Button,
  CheckboxRow,
  ConditionEditor,
  ConfirmDialog,
  Drawer,
  IconButton,
  Row,
  Section,
  Select,
  Stack,
  StatusBanner,
  Stepper,
  TextField,
} from '@ui';
import { energyCarrierLabel, fmtClock, fmtDelta, fmtKw, fmtKwh, fmtTime, t } from '@i18n';
import { conditionText } from '../conditions';
import type { SystemData } from '../shared';
import type { StrategyData } from './data';

type EffectType = RuleEffect['type'];
const EFFECTS: readonly EffectType[] = [
  'target_offset',
  'allow_sources',
  'only_sources',
  'forbid_sources',
  'disable_carrier',
  'power_cap',
  'preheat_to_next_slot',
  'source_requires',
  'pumps_demand_only',
];

/** What each effect does while the action is active, for the «i» of «Що змінюється». */
function effectMeaning(type: EffectType): string {
  switch (type) {
    case 'target_offset':
      return t('raises or lowers the targets of the chosen rooms, e.g. +1° on cheap power; when several actions shift a room, the strongest wins — shifts do not add up.');
    case 'allow_sources':
      return t('lets these sources run even when their own conditions say no, e.g. the heat pump on solar surplus.');
    case 'only_sources':
      return t('every other source stays off.');
    case 'forbid_sources':
      return t('these sources stay off.');
    case 'disable_carrier':
      return t('every source on that energy (electricity, gas…) stays off.');
    case 'power_cap':
      return t('while the energy restrictions are on, electric heat and cold together stay under this power.');
    case 'preheat_to_next_slot':
      return t('the rooms these sources serve warm up now to the target of their next schedule slot (up to a day ahead), e.g. while power is cheap.');
    case 'source_requires':
      return t('the source runs only while that trigger is active as well.');
    case 'pumps_demand_only':
      return t('circulation pumps run only while rooms ask for heat; no anti-seize runs.');
  }
}

function effectLabel(type: EffectType): string {
  switch (type) {
    case 'target_offset':
      return t('Shift the targets');
    case 'allow_sources':
      return t('Allow sources');
    case 'only_sources':
      return t('Only these sources');
    case 'forbid_sources':
      return t('Forbid sources');
    case 'disable_carrier':
      return t('Switch off by energy');
    case 'power_cap':
      return t('Power cap');
    case 'preheat_to_next_slot':
      return t('Pre-heat to the next slot');
    case 'source_requires':
      return t('A source needs a trigger');
    case 'pumps_demand_only':
      return t('Pumps only on demand');
  }
}

function newEffect(type: EffectType, d: SystemData): RuleEffect {
  const first = (d.sources.data ?? [])[0]?.config.id ?? '';
  switch (type) {
    case 'target_offset':
      return { type, roomIds: 'all', deltaC: 1, mode: 'heat' };
    case 'allow_sources':
    case 'only_sources':
    case 'forbid_sources':
    case 'preheat_to_next_slot':
      return { type, sourceIds: [] };
    case 'disable_carrier':
      return { type, carrier: 'electric' };
    case 'power_cap':
      return { type, kw: 'budget' };
    case 'source_requires':
      return { type, sourceId: first, triggerId: '' };
    case 'pumps_demand_only':
      return { type };
  }
}

export function effectText(e: RuleEffect, d: SystemData, budgetKw: number | null): string {
  const names = (ids: readonly Id[]) => ids.map(d.nameOf).join(', ');
  switch (e.type) {
    case 'target_offset': {
      const rooms =
        e.roomIds === 'all'
          ? t('everywhere')
          : e.roomIds === 'trigger_rooms'
            ? t('in the rooms of the trigger')
            : t('in the rooms: {rooms}', { rooms: e.roomIds.map((id) => d.roomName(id) ?? id).join(', ') });
      const mode = e.mode === 'heat' ? t('heating') : e.mode === 'cool' ? t('cooling') : '';
      return t('Targets {delta} {rooms}{mode}', { delta: fmtDelta(e.deltaC, { sign: true }), rooms, mode: mode ? ` (${mode})` : '' });
    }
    case 'allow_sources': {
      const modes = e.modes ? Object.entries(e.modes).filter(([, m]) => m === 'heat' || m === 'cool') : [];
      const extra = modes.length ? ` · ${t('{count} on {mode}', { count: modes.length, mode: modes[0][1] === 'heat' ? t('heating') : t('cooling') })}` : '';
      return t('Sources: {list}', { list: names(e.sourceIds) || '—' }) + extra;
    }
    case 'only_sources':
      return t('Only {list}; the other sources are off', { list: names(e.sourceIds) || '—' });
    case 'forbid_sources':
      return t('Without {list}', { list: names(e.sourceIds) || '—' });
    case 'disable_carrier':
      return t('Sources on {carrier} are off', { carrier: energyCarrierLabel(e.carrier) });
    case 'power_cap':
      return e.kw === 'budget' ? t('At most {kw} (the blackout budget)', { kw: fmtKw(budgetKw, 1) }) : t('At most {kw}', { kw: fmtKw(e.kw, 1) });
    case 'preheat_to_next_slot':
      return t('{list} warms the house up to the next schedule slot', { list: names(e.sourceIds) || '—' });
    case 'source_requires':
      return t('{source} — only while «{trigger}» is active', { source: d.nameOf(e.sourceId), trigger: d.ctx.trigger?.(e.triggerId) ?? e.triggerId });
    case 'pumps_demand_only':
      return t('Pumps — only when rooms ask');
  }
}

function lastText(r: RuleDto, now: number): string {
  if (r.state.active && r.state.since) return t('Active since {time}', { time: fmtClock(r.state.since, now) });
  const run = r.state.lastRun;
  if (!run) return t('Has not fired yet');
  const span = `${fmtClock(run.from, now)}–${run.to ? fmtTime(run.to) : '…'}`;
  return run.energyKwh != null ? t('Last time: {span} · {kwh} went into heat', { span, kwh: fmtKwh(run.energyKwh) }) : t('Last time: {span}', { span });
}

export function RulesSection({ d, s, embedded }: { d: SystemData; s: StrategyData; embedded?: boolean }) {
  const [editing, setEditing] = useState<{ dto: RuleDto | null } | null>(null);
  const toggle = useMutation((id: Id, enabled: boolean) => api.rules.patch(id, { enabled }), {
    onSuccess: () => void s.rules.reload(),
    onError: () => void s.rules.reload(),
  });
  const budget = s.energy.data?.policy.budgetKw ?? null;
  const list = [...(s.rules.data ?? [])].sort((a, b) => a.config.priority - b.config.priority);
  return (
    <Section
      variant={embedded ? 'plain' : 'card'}
      title={embedded ? undefined : t('Actions on triggers')}
      subtitle={t('What changes while a trigger is active. Afterwards everything returns to the schedule.')}
      action={
        d.canEdit ? (
          <Button variant="secondary" size="sm" icon="plus" onClick={() => setEditing({ dto: null })}>
            {t('Action')}
          </Button>
        ) : undefined
      }
    >
      <Stack gap="md">
        {list.map((r) => {
          const live = d.plant?.rules.find((x) => x.ruleId === r.config.id);
          const dto = live ? { ...r, state: live } : r;
          const effects = r.config.effects.map((e) => effectText(e, d, budget));
          if (r.config.stopWhen) effects.push(t('stops when {cond}', { cond: conditionText(r.config.stopWhen, d.ctx) }));
          return (
            <ActionRuleCard
              key={r.config.id}
              when={conditionText(r.config.when, d.ctx).replace(/^«(.*)»$/, '$1')}
              action={r.config.name}
              effects={effects}
              last={lastText(dto, d.now)}
              enabled={r.config.enabled}
              active={dto.state.active}
              onToggle={() => d.canEdit && void toggle.run(r.config.id, !r.config.enabled)}
              onEdit={d.canEdit ? () => setEditing({ dto: r }) : undefined}
            />
          );
        })}
        {s.rules.settled && !list.length ? <StatusBanner tone="event" icon="info" text={t('No actions yet.')} /> : null}
      </Stack>
      {editing ? <RuleDrawer d={d} s={s} dto={editing.dto} onClose={() => setEditing(null)} /> : null}
    </Section>
  );
}

function RuleDrawer({ d, s, dto, onClose }: { d: SystemData; s: StrategyData; dto: RuleDto | null; onClose: () => void }) {
  const cfg = dto?.config ?? null;
  const firstTrigger = s.triggers.data?.[0]?.config.id ?? '';
  const [name, setName] = useState(cfg?.name ?? t('New action'));
  const [priority, setPriority] = useState(cfg?.priority ?? 50);
  const [when, setWhen] = useState<ConditionNode>(cfg?.when ?? { op: 'trigger', triggerId: firstTrigger });
  const [stopWhen, setStopWhen] = useState<ConditionNode | null>(cfg?.stopWhen ?? null);
  const [effects, setEffects] = useState<RuleEffect[]>(cfg?.effects ?? []);
  const [notify, setNotify] = useState(cfg?.notifyOnActivate ?? false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const search = useEntitySearch(null);
  const triggers = useMemo(() => (s.triggers.data ?? []).map((x) => ({ id: x.config.id, name: x.config.name })), [s.triggers.data]);
  const rooms = useMemo(() => d.rooms.map((r) => ({ id: r.id, name: r.name })), [d.rooms]);
  const sources = useMemo(() => (d.sources.data ?? []).map((x) => ({ id: x.config.id, name: d.nameOf(x.config.id) })), [d]);
  const done = () => {
    void s.rules.reload();
    onClose();
  };
  const body = (): Omit<TriggerRule, 'id'> => ({
    name: name.trim(),
    enabled: cfg?.enabled ?? true,
    priority,
    when,
    stopWhen,
    effects,
    notifyOnActivate: notify,
  });
  const save = useMutation(() => (cfg ? api.rules.patch(cfg.id, body()) : api.rules.create(body())), {
    onSuccess: done,
    okToast: cfg ? t('Action saved') : t('Action added'),
  });
  const remove = useMutation(() => api.rules.remove((cfg as TriggerRule).id), { onSuccess: done, okToast: t('Action deleted') });
  const preview = (node: ConditionNode) => api.conditions.preview({ node });
  const setEffect = (i: number, e: RuleEffect) => setEffects((list) => list.map((x, k) => (k === i ? e : x)));

  return (
    <Drawer
      open
      onClose={onClose}
      width={640}
      title={cfg ? cfg.name : t('New action')}
      footer={
        <Row gap="sm" justify={cfg ? 'between' : 'end'} wrap>
          {cfg ? (
            <Button variant="danger" onClick={() => setConfirmDelete(true)}>
              {t('Delete')}
            </Button>
          ) : null}
          <Row gap="sm">
            <Button variant="secondary" onClick={onClose}>
              {t('Cancel')}
            </Button>
            <Button variant="primary" onClick={() => void save.run()} disabled={!name.trim() || !effects.length} loading={save.pending}>
              {t('Save')}
            </Button>
          </Row>
        </Row>
      }
    >
      <Stack gap="lg">
        <TextField label={t('Name')} value={name} maxLength={40} onChange={setName} error={save.issues.name} />
        <Section variant="plain" level={3} title={t('When')}>
          <ConditionEditor value={when} onChange={setWhen} preview={preview} search={search} triggers={triggers} rooms={rooms} sources={sources} />
        </Section>
        <Section
          variant="plain"
          level={3}
          title={t('What changes')}
          hint={{
            title: t('While the trigger is active; afterwards everything returns to the schedule.'),
            bullets: EFFECTS.map((x) => `«${effectLabel(x)}» — ${effectMeaning(x)}`),
          }}
        >
          <Stack gap="md">
            {effects.map((e, i) => (
              <EffectEditor
                key={i}
                d={d}
                effect={e}
                triggers={triggers}
                onChange={(x) => setEffect(i, x)}
                onRemove={() => setEffects((list) => list.filter((_, k) => k !== i))}
              />
            ))}
            <Select<EffectType | ''>
              ariaLabel={t('Add an effect')}
              value=""
              options={[{ value: '', label: t('+ Add an effect…') }, ...EFFECTS.map((x) => ({ value: x, label: effectLabel(x) }))]}
              onChange={(x) => x && setEffects((list) => [...list, newEffect(x, d)])}
            />
          </Stack>
        </Section>
        <CheckboxRow
          checked={stopWhen != null}
          title={t('Stop earlier on an extra condition')}
          hint={t('Once it stops this way, it waits until the trigger has ended once.')}
          onChange={(on) => setStopWhen(on ? { op: 'numeric', entityId: '', cmp: '<', value: 90 } : null)}
        />
        {stopWhen ? (
          <ConditionEditor value={stopWhen} onChange={setStopWhen} preview={preview} search={search} triggers={triggers} rooms={rooms} sources={sources} />
        ) : null}
        <Stepper
          variant="compact"
          label={t('Priority')}
          sub={t('lower wins when actions disagree')}
          value={priority}
          text={String(priority)}
          min={1}
          max={99}
          step={1}
          onChange={setPriority}
          ariaDec={t('Stronger')}
          ariaInc={t('Weaker')}
        />
        <CheckboxRow checked={notify} title={t('Notify when it starts')} onChange={setNotify} />
      </Stack>
      <ConfirmDialog
        open={confirmDelete}
        title={t('Delete «{name}»?', { name: cfg?.name ?? '' })}
        consequences={[t('Its changes stop at once; everything returns to the schedule.')]}
        confirm={{ label: t('Delete action'), tone: 'danger', onClick: () => void remove.run(), loading: remove.pending }}
        onCancel={() => setConfirmDelete(false)}
      />
    </Drawer>
  );
}

function SourcePicks({ d, value, onChange }: { d: SystemData; value: readonly Id[]; onChange: (ids: Id[]) => void }) {
  return (
    <Stack gap="xs">
      {(d.sources.data ?? []).map((x) => (
        <CheckboxRow
          key={x.config.id}
          checked={value.includes(x.config.id)}
          title={d.nameOf(x.config.id)}
          onChange={(on) => onChange(on ? [...value, x.config.id] : value.filter((v) => v !== x.config.id))}
        />
      ))}
    </Stack>
  );
}

function EffectEditor({
  d,
  effect,
  triggers,
  onChange,
  onRemove,
}: {
  d: SystemData;
  effect: RuleEffect;
  triggers: { id: string; name: string }[];
  onChange: (e: RuleEffect) => void;
  onRemove: () => void;
}) {
  const e = effect;
  const fields = (() => {
    switch (e.type) {
      case 'target_offset':
        return (
          <Stack gap="sm">
            <Stepper
              variant="compact"
              label={t('Shift')}
              value={e.deltaC}
              text={fmtDelta(e.deltaC, { sign: true })}
              min={-5}
              max={5}
              step={0.1}
              onChange={(deltaC) => onChange({ ...e, deltaC })}
              ariaDec={t('Lower')}
              ariaInc={t('Higher')}
            />
            <Select<Mode | 'both'>
              ariaLabel={t('For which mode')}
              value={e.mode}
              options={[
                { value: 'heat', label: t('for heating') },
                { value: 'cool', label: t('for cooling') },
                { value: 'both', label: t('for both') },
              ]}
              onChange={(mode) => onChange({ ...e, mode })}
            />
            <CheckboxRow checked={e.roomIds === 'all'} title={t('In every room')} onChange={(all) => onChange({ ...e, roomIds: all ? 'all' : [] })} />
            {e.roomIds !== 'all' && e.roomIds !== 'trigger_rooms' ? (
              <Stack gap="xs">
                {d.rooms.map((r) => {
                  const ids = e.roomIds as Id[];
                  return (
                    <CheckboxRow
                      key={r.id}
                      checked={ids.includes(r.id)}
                      title={r.name}
                      onChange={(on) => onChange({ ...e, roomIds: on ? [...ids, r.id] : ids.filter((x) => x !== r.id) })}
                    />
                  );
                })}
              </Stack>
            ) : null}
          </Stack>
        );
      case 'allow_sources':
        return (
          <Stack gap="sm">
            <SourcePicks d={d} value={e.sourceIds} onChange={(sourceIds) => onChange({ ...e, sourceIds })} />
            <CheckboxRow
              checked={Boolean(e.modes && Object.keys(e.modes).length)}
              title={t('Air conditioners and heat pumps only heat')}
              onChange={(on) => onChange({ ...e, modes: on ? Object.fromEntries(e.sourceIds.map((id) => [id, 'heat' as SourceMode])) : undefined })}
            />
          </Stack>
        );
      case 'only_sources':
      case 'forbid_sources':
      case 'preheat_to_next_slot':
        return <SourcePicks d={d} value={e.sourceIds} onChange={(sourceIds) => onChange({ ...e, sourceIds })} />;
      case 'disable_carrier':
        return (
          <Select<EnergyCarrier>
            ariaLabel={t('Energy')}
            value={e.carrier}
            options={(['electric', 'gas', 'other'] as const).map((c) => ({ value: c, label: energyCarrierLabel(c) }))}
            onChange={(carrier) => onChange({ ...e, carrier })}
          />
        );
      case 'power_cap':
        return (
          <Stack gap="sm">
            <CheckboxRow checked={e.kw === 'budget'} title={t('As the blackout budget')} onChange={(on) => onChange({ ...e, kw: on ? 'budget' : 4 })} />
            {e.kw !== 'budget' ? (
              <Stepper
                variant="compact"
                label={t('At most')}
                value={e.kw}
                text={fmtKw(e.kw, 1)}
                min={0.5}
                max={20}
                step={0.5}
                onChange={(kw) => onChange({ ...e, kw })}
                ariaDec={t('Less')}
                ariaInc={t('More')}
              />
            ) : null}
          </Stack>
        );
      case 'source_requires':
        return (
          <Stack gap="sm">
            <Select<Id>
              ariaLabel={t('Source')}
              value={e.sourceId}
              options={(d.sources.data ?? []).map((x) => ({ value: x.config.id, label: d.nameOf(x.config.id) }))}
              onChange={(sourceId) => onChange({ ...e, sourceId })}
            />
            <Select<Id>
              ariaLabel={t('Trigger')}
              value={e.triggerId}
              options={[{ value: '', label: t('Choose a trigger') }, ...triggers.map((x) => ({ value: x.id, label: x.name }))]}
              onChange={(triggerId) => onChange({ ...e, triggerId })}
            />
          </Stack>
        );
      case 'pumps_demand_only':
        return null;
    }
  })();
  return (
    <Section
      variant="well"
      level={3}
      title={effectLabel(e.type)}
      action={<IconButton icon="trash" label={t('Remove the effect')} variant="ghost" size={36} onClick={onRemove} />}
    >
      {fields}
    </Section>
  );
}
