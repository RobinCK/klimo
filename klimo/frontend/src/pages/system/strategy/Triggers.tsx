/**
 * «Тригери»: named conditions from Home Assistant that sources, rules and the energy policy
 * rely on, with their live state. A new trigger starts from a kind (an entity state, a number
 * with a threshold, a template, a time window, sun and weather) and is built in the condition
 * editor with a live preview.
 */
import { useMemo, useState } from 'react';
import type { ConditionNode, IconName, Id, Trigger, TriggerDto, TriggerKind, TriggerState, UsageRef } from '@api/model';
import { api } from '@api/endpoints';
import { useEntitySearch, useMutation } from '@data';
import {
  AutoGrid,
  Button,
  CheckboxRow,
  ConditionEditor,
  ConfirmDialog,
  Drawer,
  IconPicker,
  Row,
  Section,
  Select,
  Stack,
  StatusBanner,
  Stepper,
  TextField,
  TriggerCard,
  TypePickerCard,
} from '@ui';
import { fmtClock, fmtDur, fmtTemp, renderReason, t, triggerKindLabel } from '@i18n';
import { conditionText } from '../conditions';
import type { SystemData } from '../shared';
import type { StrategyData } from './data';

const KINDS: readonly TriggerKind[] = ['entity_state', 'numeric', 'template', 'time', 'sun_weather', 'composite'];

const KIND_ICON: Record<TriggerKind, IconName> = {
  entity_state: 'plug',
  numeric: 'gauge',
  template: 'anyEntity',
  time: 'clock',
  sun_weather: 'sun',
  composite: 'layers',
};

function kindHint(k: TriggerKind): string {
  switch (k) {
    case 'entity_state':
      return t('binary_sensor, switch, input_boolean…');
    case 'numeric':
      return t('temperature, power, charge — with hysteresis');
    case 'template':
      return t('any condition in the Home Assistant template language');
    case 'time':
      return t('time windows, days of the week, a tariff');
    case 'sun_weather':
      return t('sunrise and sunset, clouds, the forecast');
    case 'composite':
      return t('several conditions and other triggers together');
  }
}

function initialCondition(k: TriggerKind): ConditionNode {
  switch (k) {
    case 'entity_state':
      return { op: 'state', entityId: '', equals: ['on'] };
    case 'numeric':
      return { op: 'numeric', entityId: '', cmp: '<', value: 0 };
    case 'template':
      return { op: 'template', template: '' };
    case 'time':
      return { op: 'time', windows: [{ from: '23:00', to: '07:00' }] };
    case 'sun_weather':
      return { op: 'sun', is: 'above_horizon' };
    case 'composite':
      return { op: 'all', items: [] };
  }
}

/** «ні · 4.2°», «так · з 12:05», «ні · з 23:00». */
function liveText(cfg: Trigger, s: TriggerState, d: SystemData): string {
  if (!cfg.enabled) return t('off');
  const yes = s.active ? t('yes') : t('no');
  if (s.status === 'unknown' || s.status === 'error') return `${t('no data')} · ${renderReason(s.live, d.ctx)}`;
  if (s.active && s.since) return `${yes} · ${t('since {time}', { time: fmtClock(s.since, d.now) })}`;
  if (s.nextChangeAt) return `${yes} · ${t('from {time}', { time: fmtClock(s.nextChangeAt, d.now) })}`;
  if (typeof s.value === 'number') return `${yes} · ${cfg.condition.op === 'outdoor' ? fmtTemp(s.value) : String(s.value)}`;
  return yes;
}

function usageText(u: UsageRef): string {
  switch (u.type) {
    case 'energy':
      return t('energy budget');
    case 'heat_chain':
      return t('heating chain');
    case 'cool_chain':
      return t('cooling chain');
    default:
      return u.label ? `«${u.label}»` : u.type;
  }
}

export function TriggersSection({ d, s, embedded }: { d: SystemData; s: StrategyData; embedded?: boolean }) {
  const [picking, setPicking] = useState(false);
  const [editing, setEditing] = useState<{ dto: TriggerDto | null; kind: TriggerKind } | null>(null);
  const toggle = useMutation((id: Id, enabled: boolean) => api.triggers.patch(id, { enabled }), {
    onSuccess: () => void s.triggers.reload(),
    onError: () => void s.triggers.reload(),
  });
  const list = s.triggers.data ?? [];
  return (
    <Section
      variant={embedded ? 'plain' : 'card'}
      title={embedded ? undefined : t('Triggers')}
      subtitle={t('Conditions from Home Assistant that sources, actions and energy rely on. The state updates live.')}
      action={
        d.canEdit ? (
          <Button variant="secondary" size="sm" icon="plus" onClick={() => setPicking((x) => !x)}>
            {t('New trigger')}
          </Button>
        ) : undefined
      }
    >
      <Stack gap="md">
        {picking ? (
          <Section variant="well" level={3} title={t('What should the trigger be built on?')}>
            <AutoGrid min={200} gap="sm">
              {KINDS.map((k) => (
                <TypePickerCard
                  key={k}
                  icon={KIND_ICON[k]}
                  name={triggerKindLabel(k)}
                  can={kindHint(k)}
                  how=""
                  selected={false}
                  onClick={() => {
                    setPicking(false);
                    setEditing({ dto: null, kind: k });
                  }}
                />
              ))}
            </AutoGrid>
          </Section>
        ) : null}
        <AutoGrid min={400} gap="md">
          {list.map((x) => {
            const st = d.plant?.triggers.find((y) => y.triggerId === x.config.id) ?? x.state;
            return (
              <TriggerCard
                key={x.config.id}
                icon={x.config.icon}
                name={x.config.name}
                kindLabel={triggerKindLabel(x.config.kind).toLowerCase()}
                live={{
                  text: liveText(x.config, st, d),
                  active: st.active,
                  disabled: !x.config.enabled,
                  unavailable: st.status === 'unknown' || st.status === 'error',
                }}
                code={conditionText(x.config.condition, d.ctx)}
                usages={st.usedBy.map(usageText)}
                usedByLabel={t('used by:')}
                enabled={x.config.enabled}
                locked={x.config.system ? t('Tied to the bivalence point — change it there.') : undefined}
                onToggle={() => d.canEdit && void toggle.run(x.config.id, !x.config.enabled)}
                onEdit={d.canEdit ? () => setEditing({ dto: x, kind: x.config.kind }) : undefined}
              />
            );
          })}
        </AutoGrid>
        {s.triggers.settled && !list.length ? <StatusBanner tone="event" icon="info" text={t('No triggers yet.')} /> : null}
      </Stack>
      {editing ? <TriggerDrawer d={d} s={s} dto={editing.dto} kind={editing.kind} onClose={() => setEditing(null)} /> : null}
    </Section>
  );
}

const ICONS = (): { name: IconName; label: string }[] => [
  { name: 'grid_power', label: t('Grid') },
  { name: 'sun', label: t('Sun') },
  { name: 'moon', label: t('Moon') },
  { name: 'snow', label: t('Frost') },
  { name: 'battery', label: t('Battery') },
  { name: 'bolt', label: t('Power') },
  { name: 'clock', label: t('Time') },
  { name: 'thermometer', label: t('Temperature') },
  { name: 'droplet', label: t('Humidity') },
  { name: 'users', label: t('People') },
  { name: 'plug', label: t('Plug') },
  { name: 'sparkle', label: t('Other') },
];

function TriggerDrawer({ d, s, dto, kind, onClose }: { d: SystemData; s: StrategyData; dto: TriggerDto | null; kind: TriggerKind; onClose: () => void }) {
  const cfg = dto?.config ?? null;
  const [name, setName] = useState(cfg?.name ?? triggerKindLabel(kind));
  const [icon, setIcon] = useState<IconName>(cfg?.icon ?? KIND_ICON[kind]);
  const [condition, setCondition] = useState<ConditionNode>(cfg?.condition ?? initialCondition(kind));
  const [whenUnknown, setWhenUnknown] = useState<Trigger['whenUnknown']>(cfg?.whenUnknown ?? 'hold_false');
  const [holdMaxMin, setHoldMaxMin] = useState(cfg?.holdMaxMin ?? 30);
  const [notify, setNotify] = useState(cfg?.notifyOnActivate ?? false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const search = useEntitySearch(null);
  const system = Boolean(cfg?.system);
  const done = () => {
    void s.triggers.reload();
    onClose();
  };
  const save = useMutation(
    () =>
      cfg
        ? api.triggers.patch(
            cfg.id,
            system ? { name, icon, notifyOnActivate: notify } : { name, icon, condition, whenUnknown, holdMaxMin, notifyOnActivate: notify },
          )
        : api.triggers.create({ name, icon, kind, condition, enabled: true, whenUnknown, holdMaxMin, notifyOnActivate: notify }),
    { onSuccess: done, okToast: cfg ? t('Trigger saved') : t('Trigger added') },
  );
  const remove = useMutation(() => api.triggers.remove((cfg as Trigger).id, { force: (dto?.state.usedBy.length ?? 0) > 0 }), {
    onSuccess: done,
    okToast: t('Trigger deleted'),
  });
  const others = useMemo(
    () => (s.triggers.data ?? []).filter((x) => x.config.id !== cfg?.id).map((x) => ({ id: x.config.id, name: x.config.name })),
    [s.triggers.data, cfg?.id],
  );
  const rooms = useMemo(() => d.rooms.map((r) => ({ id: r.id, name: r.name })), [d.rooms]);
  const sources = useMemo(() => (d.sources.data ?? []).map((x) => ({ id: x.config.id, name: d.nameOf(x.config.id) })), [d]);
  const usedBy = dto?.state.usedBy ?? [];
  return (
    <Drawer
      open
      onClose={onClose}
      width={640}
      title={cfg ? cfg.name : t('New trigger · {kind}', { kind: triggerKindLabel(kind).toLowerCase() })}
      footer={
        <Row gap="sm" justify={cfg && !system ? 'between' : 'end'} wrap>
          {cfg && !system ? (
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
        <TextField label={t('Name')} value={name} maxLength={40} onChange={setName} error={save.issues.name} />
        <IconPicker ariaLabel={t('Icon')} value={icon} icons={ICONS()} onChange={setIcon} />
        {system ? (
          <StatusBanner tone="event" icon="lock" text={t('Tied to the bivalence point: its threshold and exit follow the heating settings.')} />
        ) : (
          <ConditionEditor
            value={condition}
            onChange={setCondition}
            preview={(node) => api.conditions.preview({ node })}
            search={search}
            triggers={others}
            rooms={rooms}
            sources={sources}
          />
        )}
        {system ? null : (
          <Stack gap="sm">
            <Select<Trigger['whenUnknown']>
              label={t('While an input is unavailable')}
              ariaLabel={t('While an input is unavailable')}
              hint={t('What the trigger says while an entity it reads is unavailable — a Zigbee dropout, a Home Assistant restart. «Keep the last state» holds its last answer for the time below (default 30 min), then turns inactive or active; «at once» does not wait. Pick the side that is safe for what uses the trigger.')}
              value={whenUnknown}
              options={[
                { value: 'hold_false', label: t('keep the last state for a while, then inactive') },
                { value: 'hold_true', label: t('keep the last state for a while, then active') },
                { value: 'false', label: t('inactive at once') },
                { value: 'true', label: t('active at once') },
              ]}
              onChange={setWhenUnknown}
            />
            {whenUnknown.startsWith('hold') ? (
              <Stepper
                variant="compact"
                label={t('Keep the last state for')}
                value={holdMaxMin}
                text={fmtDur(holdMaxMin)}
                min={5}
                max={240}
                step={5}
                onChange={setHoldMaxMin}
                ariaDec={t('Shorter')}
                ariaInc={t('Longer')}
              />
            ) : null}
          </Stack>
        )}
        <CheckboxRow checked={notify} title={t('Notify when it fires')} hint={t('An event notification each time it becomes active.')} onChange={setNotify} />
        {usedBy.length ? <StatusBanner tone="event" icon="info" text={t('Used by: {list}', { list: usedBy.map(usageText).join(', ') })} /> : null}
      </Stack>
      <ConfirmDialog
        open={confirmDelete}
        title={t('Delete «{name}»?', { name: cfg?.name ?? '' })}
        consequences={usedBy.length ? [t('These stop using it: {list}', { list: usedBy.map(usageText).join(', ') })] : [t('Nothing uses this trigger.')]}
        confirm={{ label: t('Delete trigger'), tone: 'danger', onClick: () => void remove.run(), loading: remove.pending }}
        onCancel={() => setConfirmDelete(false)}
      />
    </Drawer>
  );
}
