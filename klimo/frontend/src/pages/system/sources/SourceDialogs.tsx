/**
 * The small editors of a source: switch it off for a while, rename or move it to another room,
 * duplicate it (linked to follow the original), delete it, its energy and guards, pick the
 * entity of one role, and one run condition.
 */
import { useMemo, useState } from 'react';
import type {
  ConditionNode,
  EnergyCarrier,
  EntityRolePreset,
  Id,
  LockDuration,
  Mode,
  SourceConditionItem,
  SourceDto,
  SourceEnergy,
  SourceGuards,
  SourceLockRequest,
  SourcePatch,
} from '@api/model';
import { api } from '@api/endpoints';
import { useEntitySearch, useMutation, useResource } from '@data';
import {
  Button,
  CheckboxRow,
  ConditionEditor,
  ConfirmDialog,
  Dialog,
  Drawer,
  DurationPills,
  EntityPicker,
  Row,
  SegmentedControl,
  Select,
  Stack,
  StatusBanner,
  Stepper,
  TextField,
  TimeStepper,
} from '@ui';
import { energyCarrierLabel, fmtDur, fmtKw, fmtPct, fmtTemp, fmtUntil, fmtW, lockDurationLabel, minuteToHhmm, t, zonedParts } from '@i18n';
import type { SystemData } from '../shared';
import { roleLabel } from './bindings';

const LOCKS: readonly LockDuration[] = ['1h', '4h', 'morning', 'until', 'none'];
// rated power: 0.1 kW below 2 kW (heaters of 0.8 kW), 0.5 kW up to 10 kW, whole kW above
const POWER_STEPS = [
  { from: 2, step: 0.5 },
  { from: 10, step: 1 },
] as const;

export function LockDialog({ d, dto, onClose }: { d: SystemData; dto: SourceDto; onClose: () => void }) {
  const [duration, setDuration] = useState<LockDuration>('4h');
  const [minute, setMinute] = useState(() => (zonedParts(d.now).minuteOfDay + 180) % 1440);
  const [reason, setReason] = useState('');
  const untilTs = () => {
    const nowMin = zonedParts(d.now).minuteOfDay;
    const ahead = (minute - nowMin + 1440) % 1440 || 1440;
    return d.now + ahead * 60_000;
  };
  const lock = useMutation(
    () => {
      const body: SourceLockRequest = { kind: 'source_off', duration, reason: reason.trim() || undefined };
      if (duration === 'until') body.until = untilTs();
      return api.sources.lock(dto.config.id, body);
    },
    {
      onSuccess: (s) => {
        d.sources.setData((prev) => (prev ?? []).map((x) => (x.config.id === s.config.id ? s : x)));
        onClose();
      },
      okToast: t('{source} is off for now; the next one in the chain takes over.', { source: d.nameOf(dto.config.id) }),
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('Switch {source} off for a while', { source: d.nameOf(dto.config.id) })}
      actions={[
        { label: t('Cancel'), onClick: onClose, variant: 'secondary' },
        { label: t('Switch off'), onClick: () => void lock.run(), loading: lock.pending },
      ]}
    >
      <Stack gap="md">
        <DurationPills<LockDuration>
          ariaLabel={t('For how long')}
          value={duration}
          onChange={setDuration}
          options={LOCKS.map((x) => ({
            value: x,
            label: lockDurationLabel(x),
            hint: x === 'until' ? fmtUntil(untilTs(), d.now) : x === 'none' ? t('until you switch it on') : x === 'morning' ? t('until 06:00') : '',
          }))}
        />
        {duration === 'until' ? (
          <TimeStepper
            label={t('Until')}
            value={minute}
            text={minuteToHhmm(minute)}
            min={0}
            max={1410}
            step={30}
            onChange={setMinute}
            ariaEarlier={t('30 min earlier')}
            ariaLater={t('30 min later')}
          />
        ) : null}
        <TextField label={t('Why (optional)')} value={reason} placeholder={t('Service visit')} maxLength={80} onChange={setReason} />
        <StatusBanner
          tone="event"
          icon="shield"
          text={t('Frost protection may still use it when it is the last heat source left — you get a notification then.')}
        />
      </Stack>
    </Dialog>
  );
}

export function EditDialog({ d, dto, onClose }: { d: SystemData; dto: SourceDto; onClose: () => void }) {
  const [name, setName] = useState(dto.config.name);
  const [subtype, setSubtype] = useState(dto.config.subtype);
  const [roomId, setRoomId] = useState(dto.config.roomId ?? '');
  const save = useMutation(
    () => {
      const p: SourcePatch = { name: name.trim(), subtype: subtype.trim() };
      if (dto.config.scope === 'room') p.roomId = roomId || null;
      return api.sources.patch(dto.config.id, p);
    },
    {
      onSuccess: (s) => {
        d.sources.setData((prev) => (prev ?? []).map((x) => (x.config.id === s.config.id ? s : x)));
        onClose();
      },
      okToast: t('Saved'),
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('Name and place')}
      actions={[
        { label: t('Cancel'), onClick: onClose, variant: 'secondary' },
        { label: t('Save'), onClick: () => void save.run(), disabled: !name.trim(), loading: save.pending },
      ]}
    >
      <Stack gap="md">
        <TextField label={t('Name')} value={name} maxLength={40} onChange={setName} error={save.issues.name} />
        <TextField label={t('Type (free text)')} value={subtype} placeholder={t('Air to water')} maxLength={40} onChange={setSubtype} />
        {dto.config.scope === 'room' ? (
          <Select label={t('Room')} ariaLabel={t('Room')} value={roomId} options={d.rooms.map((r) => ({ value: r.id, label: r.name }))} onChange={setRoomId} />
        ) : null}
      </Stack>
    </Dialog>
  );
}

export function DuplicateDialog({ d, dto, onClose, onCreated }: { d: SystemData; dto: SourceDto; onClose: () => void; onCreated: (id: Id) => void }) {
  const free = d.rooms.filter((r) => !(d.sources.data ?? []).some((s) => s.config.kind === dto.config.kind && s.config.roomId === r.id));
  const [linked, setLinked] = useState(true);
  const [roomId, setRoomId] = useState(free[0]?.id ?? d.rooms[0]?.id ?? '');
  const [name, setName] = useState(dto.config.name);
  const dup = useMutation(
    () => api.sources.duplicate(dto.config.id, { linked, name: name.trim() || undefined, roomId: dto.config.scope === 'room' ? roomId || null : null }),
    {
      onSuccess: (s) => {
        onClose();
        onCreated(s.config.id);
      },
      okToast: t('Copy created — switched off until its entities are chosen'),
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('Duplicate {source}', { source: d.nameOf(dto.config.id) })}
      actions={[
        { label: t('Cancel'), onClick: onClose, variant: 'secondary' },
        { label: t('Duplicate'), onClick: () => void dup.run(), loading: dup.pending },
      ]}
    >
      <Stack gap="md">
        <TextField label={t('Name')} value={name} maxLength={40} onChange={setName} />
        {dto.config.scope === 'room' ? (
          <Select label={t('Room')} ariaLabel={t('Room')} value={roomId} options={d.rooms.map((r) => ({ value: r.id, label: r.name }))} onChange={setRoomId} />
        ) : null}
        <CheckboxRow
          checked={linked}
          title={t('Keep it like this one')}
          hint={t('Guards, energy, run conditions and curves follow this source; what you change in the copy stays its own.')}
          onChange={setLinked}
        />
      </Stack>
    </Dialog>
  );
}

export function DeleteDialog({ d, dto, onClose, onDeleted }: { d: SystemData; dto: SourceDto; onClose: () => void; onDeleted: () => void }) {
  const uses = dto.usages.filter((u) => u.label).map((u) => u.label);
  const remove = useMutation(() => api.sources.remove(dto.config.id, { force: dto.usages.length > 0 }), {
    onSuccess: () => {
      d.sources.setData((prev) => (prev ?? []).filter((x) => x.config.id !== dto.config.id));
      onDeleted();
    },
    okToast: t('Source deleted'),
  });
  const consequences = [
    dto.state.on ? t('It is running now — it is switched off first.') : null,
    uses.length ? t('It is removed from: {list}.', { list: [...new Set(uses)].join(', ') }) : null,
    dto.linkedChildren.length ? t('{count} linked copies keep their settings and stop following it.', { count: dto.linkedChildren.length }) : null,
  ].filter((x): x is string => Boolean(x));
  return (
    <ConfirmDialog
      open
      title={t('Delete {source}?', { source: d.nameOf(dto.config.id) })}
      body={t('The Home Assistant entities stay; only the source is removed.')}
      consequences={consequences}
      confirm={{ label: t('Delete'), tone: 'danger', onClick: () => void remove.run(), loading: remove.pending }}
      onCancel={onClose}
    />
  );
}

export function EnergyDialog({ d, dto, onClose }: { d: SystemData; dto: SourceDto; onClose: () => void }) {
  const [e, setE] = useState<SourceEnergy>(dto.config.energy);
  const set = (p: Partial<SourceEnergy>) => setE((x) => ({ ...x, ...p }));
  const search = useEntitySearch('power');
  const save = useMutation(() => api.sources.patch(dto.config.id, { energy: e }), {
    onSuccess: (s) => {
      d.sources.setData((prev) => (prev ?? []).map((x) => (x.config.id === s.config.id ? s : x)));
      onClose();
    },
    okToast: t('Saved'),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('Energy')}
      actions={[
        { label: t('Cancel'), onClick: onClose, variant: 'secondary' },
        { label: t('Save'), onClick: () => void save.run(), loading: save.pending },
      ]}
    >
      <Stack gap="md">
        <SegmentedControl<EnergyCarrier>
          full
          ariaLabel={t('Runs on')}
          value={e.carrier}
          options={(['electric', 'gas', 'other'] as const).map((c) => ({ value: c, label: energyCarrierLabel(c) }))}
          onChange={(carrier) => set({ carrier })}
        />
        <Stepper
          variant="compact"
          label={e.carrier === 'electric' ? t('Electric power') : t('Rated power')}
          value={e.maxPowerKw}
          text={fmtKw(e.maxPowerKw)}
          min={0}
          max={100}
          step={0.1}
          coarseSteps={POWER_STEPS}
          onChange={(maxPowerKw) => set({ maxPowerKw })}
          ariaDec={t('Less')}
          ariaInc={t('More')}
        />
        {e.carrier !== 'electric' ? (
          <Stepper
            variant="compact"
            label={t('Electricity of its electronics')}
            value={Math.round(e.auxPowerKw * 1000)}
            text={fmtW(e.auxPowerKw * 1000)}
            min={0}
            max={2000}
            step={10}
            onChange={(w) => set({ auxPowerKw: w / 1000 })}
            ariaDec={t('Less')}
            ariaInc={t('More')}
          />
        ) : null}
        <EntityPicker
          ariaLabel={t('Power sensor')}
          placeholder={t('Measured power (optional)')}
          clearable
          value={e.powerEntityId}
          search={search}
          onChange={(powerEntityId) => set({ powerEntityId })}
        />
        <CheckboxRow
          checked={e.countsInBlackoutBudget}
          title={t('Counts in the blackout budget')}
          hint={t('During a blackout it starts only when it fits the budget.')}
          onChange={(countsInBlackoutBudget) => set({ countsInBlackoutBudget })}
        />
        <CheckboxRow
          checked={e.nightTariffEligible}
          title={t('May pre-heat on the night tariff')}
          onChange={(nightTariffEligible) => set({ nightTariffEligible })}
        />
        <CheckboxRow
          checked={e.minBatteryPct != null}
          title={t('Allowed in a blackout while the battery is above a level')}
          trailing={e.minBatteryPct != null ? fmtPct(e.minBatteryPct) : undefined}
          onChange={(on) => set({ minBatteryPct: on ? 20 : null })}
        />
        {e.minBatteryPct != null ? (
          <Stepper
            variant="compact"
            label={t('Battery level')}
            value={e.minBatteryPct}
            text={fmtPct(e.minBatteryPct)}
            min={5}
            max={95}
            step={5}
            onChange={(minBatteryPct) => set({ minBatteryPct })}
            ariaDec={t('Less')}
            ariaInc={t('More')}
          />
        ) : null}
      </Stack>
    </Dialog>
  );
}

export function GuardsDialog({ d, dto, onClose }: { d: SystemData; dto: SourceDto; onClose: () => void }) {
  const [g, setG] = useState<SourceGuards>(dto.config.guards);
  const set = (p: Partial<SourceGuards>) => setG((x) => ({ ...x, ...p }));
  const save = useMutation(() => api.sources.patch(dto.config.id, { guards: g }), {
    onSuccess: (s) => {
      d.sources.setData((prev) => (prev ?? []).map((x) => (x.config.id === s.config.id ? s : x)));
      onClose();
    },
    okToast: t('Saved'),
  });
  const minutes = (key: keyof SourceGuards, label: string, sub: string, min: number, max: number) => (
    <Stepper
      variant="compact"
      label={label}
      sub={sub}
      value={g[key] as number}
      text={fmtDur(g[key] as number)}
      unit={t('min')}
      min={min}
      max={max}
      step={1}
      onChange={(v) => set({ [key]: v } as Partial<SourceGuards>)}
      ariaDec={t('Shorter')}
      ariaInc={t('Longer')}
    />
  );
  return (
    <Drawer
      open
      onClose={onClose}
      title={t('Guards of {source}', { source: d.nameOf(dto.config.id) })}
      footer={
        <Row gap="sm" justify="end">
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button variant="primary" onClick={() => void save.run()} loading={save.pending}>
            {t('Save')}
          </Button>
        </Row>
      }
    >
      <Stack gap="lg">
        {minutes('minRunMin', t('Minimum run'), t('once started, it runs at least this long'), 0, 60)}
        {minutes('minOffMin', t('Minimum pause'), t('once stopped, it rests at least this long'), 0, 60)}
        {minutes('startConfirmTimeoutMin', t('Must confirm it runs within'), t('otherwise it is a fault and the next source takes over'), 1, 15)}
        {minutes('unavailableAfterMin', t('Unavailable for'), t('before it counts as a fault'), 1, 30)}
        <CheckboxRow
          checked={g.maxStartsPerHour != null}
          title={t('Limit starts per hour')}
          trailing={g.maxStartsPerHour != null ? String(g.maxStartsPerHour) : undefined}
          onChange={(on) => set({ maxStartsPerHour: on ? 6 : null })}
        />
        {g.maxStartsPerHour != null ? (
          <Stepper
            variant="compact"
            label={t('Starts per hour')}
            value={g.maxStartsPerHour}
            text={String(g.maxStartsPerHour)}
            min={1}
            max={20}
            step={1}
            onChange={(maxStartsPerHour) => set({ maxStartsPerHour })}
            ariaDec={t('Fewer')}
            ariaInc={t('More')}
          />
        ) : null}
        <CheckboxRow checked={g.defrostIsNotFault} title={t('Defrosting is not a fault')} onChange={(defrostIsNotFault) => set({ defrostIsNotFault })} />
        <CheckboxRow
          checked={g.roomMaxC != null}
          title={t('Switch off above a room temperature')}
          trailing={g.roomMaxC != null ? fmtTemp(g.roomMaxC) : undefined}
          onChange={(on) => set({ roomMaxC: on ? 26 : null })}
        />
        {g.roomMaxC != null ? (
          <Stepper
            variant="compact"
            label={t('Room temperature limit')}
            value={g.roomMaxC}
            text={fmtTemp(g.roomMaxC)}
            min={20}
            max={32}
            step={0.5}
            onChange={(roomMaxC) => set({ roomMaxC })}
            ariaDec={t('Lower')}
            ariaInc={t('Higher')}
          />
        ) : null}
      </Stack>
    </Drawer>
  );
}

export function PickEntityDialog({
  role,
  preset,
  value,
  onClose,
  onPick,
}: {
  role: string;
  preset: { role: EntityRolePreset | null; domain?: string[] };
  value: string | null;
  onClose: () => void;
  onPick: (id: string | null) => void;
}) {
  const search = useEntitySearch(preset.role, { domain: preset.domain });
  const [picked, setPicked] = useState<string | null>(value);
  return (
    <Dialog
      open
      onClose={onClose}
      title={roleLabel(role)}
      size="md"
      actions={[
        { label: t('Cancel'), onClick: onClose, variant: 'secondary' },
        { label: t('Use it'), onClick: () => onPick(picked) },
      ]}
    >
      <EntityPicker
        autoFocus
        clearable
        ariaLabel={roleLabel(role)}
        placeholder={t('Search Home Assistant entities')}
        value={picked}
        search={search}
        onChange={(id) => setPicked(id)}
      />
    </Dialog>
  );
}

/** One run condition of a source, built with the condition editor and checked live. */
export function ConditionDrawer({ d, dto, item, onClose }: { d: SystemData; dto: SourceDto; item: SourceConditionItem | null; onClose: () => void }) {
  const triggers = useResource('names:triggers', api.triggers.list, { reloadOn: ['trigger'] });
  const search = useEntitySearch(null);
  const [node, setNode] = useState<ConditionNode>(item?.node ?? { op: 'outdoor', cmp: '>=', value: -5 });
  const [mode, setMode] = useState<Mode | 'both'>(item?.mode ?? 'both');
  const perMode = dto.config.conditions.join === 'perMode';
  const items = dto.config.conditions.items;
  const write = (next: SourceConditionItem[]) => api.sources.patch(dto.config.id, { conditions: { ...dto.config.conditions, items: next } });
  const done = (s: SourceDto) => {
    d.sources.setData((prev) => (prev ?? []).map((x) => (x.config.id === s.config.id ? s : x)));
    onClose();
  };
  const save = useMutation(
    () => {
      const it: SourceConditionItem = {
        id: item?.id ?? `c_${Date.now().toString(36)}`,
        mode: mode === 'both' ? null : mode,
        node,
        enabled: item?.enabled ?? true,
      };
      return write(item ? items.map((x) => (x.id === item.id ? it : x)) : [...items, it]);
    },
    { onSuccess: done, okToast: t('Condition saved') },
  );
  const remove = useMutation(() => write(items.filter((x) => x.id !== item?.id)), { onSuccess: done, okToast: t('Condition removed') });
  const rooms = useMemo(() => d.rooms.map((r) => ({ id: r.id, name: r.name })), [d.rooms]);
  const sources = useMemo(
    () => (d.sources.data ?? []).filter((s) => s.config.id !== dto.config.id).map((s) => ({ id: s.config.id, name: d.nameOf(s.config.id) })),
    [d, dto.config.id],
  );
  return (
    <Drawer
      open
      onClose={onClose}
      width={640}
      title={item ? t('Run condition') : t('New run condition')}
      footer={
        <Row gap="sm" justify={item ? 'between' : 'end'} wrap>
          {item ? (
            <Button variant="danger" onClick={() => void remove.run()} loading={remove.pending}>
              {t('Remove')}
            </Button>
          ) : null}
          <Row gap="sm">
            <Button variant="secondary" onClick={onClose}>
              {t('Cancel')}
            </Button>
            <Button variant="primary" onClick={() => void save.run()} loading={save.pending}>
              {t('Save')}
            </Button>
          </Row>
        </Row>
      }
    >
      <Stack gap="lg">
        {perMode ? (
          <SegmentedControl<Mode | 'both'>
            full
            ariaLabel={t('For which mode')}
            value={mode}
            options={[
              { value: 'heat', label: t('For heating') },
              { value: 'cool', label: t('For cooling') },
              { value: 'both', label: t('For both') },
            ]}
            onChange={setMode}
          />
        ) : null}
        <ConditionEditor
          value={node}
          onChange={setNode}
          preview={(n) => api.conditions.preview({ node: n, sourceId: dto.config.id })}
          search={search}
          triggers={(triggers.data ?? []).map((x) => ({ id: x.config.id, name: x.config.name }))}
          rooms={rooms}
          sources={sources}
        />
      </Stack>
    </Drawer>
  );
}
