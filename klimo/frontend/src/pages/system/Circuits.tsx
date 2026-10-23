/**
 * «Контури й насоси»: the house's heating loops. Each card says what feeds the loop, how it runs (the
 * whole floor with its source, or by zones and rooms), how long its pump runs on, and which rooms are
 * on it — rooms are put on and taken off here, zone valves given to them, loops of one kind merged.
 * This replaces the usual «pump with the boiler + 10 min» automation. The drawer edits the rest.
 */
import { useEffect, useState } from 'react';
import type { CircuitDto, CircuitMode, Id, Pump } from '@api/model';
import { api } from '@api/endpoints';
import { useAutosave, useResource } from '@data';
import { paths } from '@app';
import { Button, CircuitCard, Section, Stack, StatusBanner, type CircuitRoom, type KitAction } from '@ui';
import { circuitKindLabel, fmtTemp, fmtTime, pumpGroupModeLabel, t } from '@i18n';
import type { SystemData } from './shared';
import { circuitModeHint, circuitRoomsHint, pumpHint, runOnHint } from './circuitHints';
import { memberMeta, memberState, modeLabel, modeOptions, modeWords, pumpChip, runOnSub } from './circuitTexts';
import { CircuitDrawer } from './CircuitDrawer';
import { AddRoomDialog, MergeDialog, RemoveRoomDialog, RemoveZoneDialog, ZoneDialog } from './CircuitDialogs';

type Member = CircuitDto['members'][number];

/** Kinds that have more than one loop: a house of 0.1 may have a floor circuit per room. */
function duplicates(list: readonly CircuitDto[]): CircuitDto['config']['kind'][] {
  const by = new Map<CircuitDto['config']['kind'], number>();
  for (const c of list) by.set(c.config.kind, (by.get(c.config.kind) ?? 0) + 1);
  return [...by].filter(([kind, n]) => n > 1 && (kind === 'floor' || kind === 'radiators')).map(([kind]) => kind);
}

/** `phone`: the page bar above already names it, so the section only explains and adds. */
export function CircuitsSection({ d, focus, phone }: { d: SystemData; focus?: boolean; phone?: boolean }) {
  const [editing, setEditing] = useState<{ id: Id | null } | null>(null);
  const strategy = useResource('strategy', api.strategy.get, { reloadOn: ['strategy'] });
  const list = d.circuits.data ?? [];
  useEffect(() => {
    if (focus) window.setTimeout(() => document.getElementById('circuits')?.scrollIntoView({ block: 'start' }), 300);
  }, [focus]);
  return (
    <Section
      id="circuits"
      variant={phone ? 'plain' : 'card'}
      title={phone ? undefined : t('Circuits & pumps')}
      ariaLabel={t('Circuits & pumps')}
      subtitle={t('The house’s heating loops: what feeds them, when their pump runs, which rooms are on them.')}
      action={
        d.canEdit ? (
          <Button variant="outline" size="sm" icon="plus" onClick={() => setEditing({ id: null })}>
            {t('Circuit')}
          </Button>
        ) : undefined
      }
    >
      <Stack gap="md">
        {duplicates(list).map((kind) => (
          <StatusBanner
            key={kind}
            tone="event"
            icon="info"
            text={t('The house has several circuits of the kind «{kind}». If they are one pipe loop, merge them with «Merge into…»: the rooms then share one pump and one run-on.', {
              kind: circuitKindLabel(kind).toLowerCase(),
            })}
          />
        ))}
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

type Open =
  | { kind: 'add' }
  | { kind: 'merge' }
  | { kind: 'zone'; member: Member }
  | { kind: 'leave'; member: Member }
  | { kind: 'unzone'; member: Member; zone: Member['zones'][number] }
  | null;

function CircuitItem({ d, dto, dewMargin, onEdit }: { d: SystemData; dto: CircuitDto; dewMargin: number; onEdit: () => void }) {
  const [open, setOpen] = useState<Open>(null);
  const c = dto.config;
  const pumps = dto.pumps;
  const first = pumps[0] as Pump | undefined;
  const live = d.plant?.circuits.find((x) => x.circuitId === c.id) ?? dto.state;
  const mode = useAutosave<CircuitMode>(c.mode, (v) => api.circuits.patch(c.id, { mode: v }).then(() => d.circuits.reload()), { debounceMs: 0 });
  // the run-on is kept the same on every pump of a circuit (duty and standby)
  const runOn = useAutosave(first?.runOnHeatMin ?? 0, (v) => Promise.all(pumps.map((x) => api.pumps.patch(x.id, { runOnHeatMin: v }))).then(() => d.circuits.reload()));
  const valve = c.mixingValve;
  const label = c.shortName || c.name;
  const sameKind = (d.circuits.data ?? []).filter((x) => x.config.id !== c.id && x.config.kind === c.kind);
  const zoned = c.kind === 'floor' && mode.value === 'zoned';
  const runOnMin = first ? runOn.value : null;
  const words = modeWords(mode.value, c.kind, runOnMin);

  const extra = [
    pumps.length > 1 ? t('{count} pumps · {mode}', { count: pumps.length, mode: pumpGroupModeLabel(c.pumpGroupMode).toLowerCase() }) : null,
    valve ? t('valve {entity}', { entity: valve.entityId }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const feeds = c.sourceIds.map(d.nameOf);
  const chips: { label: string; tone?: CircuitDto['state']['tone'] }[] = [];
  if (feeds.length) chips.push({ label: t('from {list}', { list: feeds.join(', ') }), tone: 'heat' });
  if (valve) chips.push({ label: t('heating {t}', { t: fmtTemp(valve.heatC, { decimals: 0 }) }), tone: 'heat' });
  if (c.capabilities.cool) chips.push({ label: t('cooling {t}', { t: fmtTemp(c.supply.coolC, { decimals: 0 }) }), tone: 'cool' });
  else chips.push({ label: t('heating only') });
  if (zoned && c.bypass) chips.push({ label: t('bypass') });

  const rooms: CircuitRoom[] = dto.members.map((m) => {
    const name = d.roomName(m.roomId) ?? m.roomId;
    const floor = m.kind === 'floor';
    return {
      key: m.emitterId,
      name,
      to: paths.room(m.roomId),
      meta: floor && zoned && !m.zones.length ? t('{how} · no zone valve', { how: memberMeta(m) }) : memberMeta(m),
      state: memberState(m.roomId, live),
      zones: m.zones.map((z) => ({
        key: z.deviceId,
        name: z.name,
        entityId: z.entityId,
        onRemove: d.canEdit ? () => setOpen({ kind: 'unzone', member: m, zone: z }) : undefined,
      })),
      // a loop that runs as a whole opens every floor with its source; a valve there would only follow it
      zoneNote: floor && m.zones.length && !zoned ? t('Not needed while the floor runs as a whole: it opens with the source.') : undefined,
      onAddZone: d.canEdit && floor && zoned ? () => setOpen({ kind: 'zone', member: m }) : undefined,
      onRemove: d.canEdit ? () => setOpen({ kind: 'leave', member: m }) : undefined,
    };
  });

  const warning = !c.sourceIds.length
    ? t('Nothing feeds this circuit: its rooms cannot start a boiler or heat pump. Choose its sources in «Settings and pumps».')
    : undefined;
  const note = c.capabilities.cool ? t('Floor cooling only while the flow stays {margin} above the dew point.', { margin: fmtTemp(dewMargin, { decimals: 0 }) }) : undefined;
  const actions: KitAction[] = d.canEdit
    ? [
        ...(sameKind.length ? [{ label: t('Merge into…'), icon: 'layers' as const, onClick: () => setOpen({ kind: 'merge' }) }] : []),
        { label: t('Settings and pumps'), icon: 'pencil', onClick: onEdit },
      ]
    : [];

  return (
    <>
      <CircuitCard<CircuitMode>
        name={c.name}
        icon={c.kind === 'floor' ? 'floor' : c.kind === 'fancoil' ? 'fan' : 'radiator'}
        pumpEntity={pumps.map((p) => p.entityId).join(', ')}
        extra={extra || undefined}
        chip={pumpChip(dto, live, d.now, (at) => fmtTime(at))}
        pumpHint={pumpHint(first?.minOnSec ?? null, words.title)}
        mode={{
          label: modeLabel(c.kind),
          hint: circuitModeHint(c.kind),
          ariaLabel: t('How «{circuit}» runs', { circuit: label }),
          value: mode.value,
          options: modeOptions(c.kind, runOnMin, !d.canEdit),
          onChange: (v) => mode.set(v),
        }}
        runOn={
          first
            ? {
                label: t('Run-on after a stop'),
                sub: runOnSub(mode.value),
                value: runOn.value,
                text: t('{n} min', { n: runOn.value }),
                min: 0,
                max: 30,
                step: 1,
                disabled: !d.canEdit,
                onChange: (v) => runOn.set(v),
                ariaDec: t('Shorter run-on for {circuit}', { circuit: label }),
                ariaInc: t('Longer run-on for {circuit}', { circuit: label }),
                hint: runOnHint(),
              }
            : undefined
        }
        chips={chips}
        warning={warning}
        note={note}
        rooms={{
          label: dto.members.length ? t('Rooms on the circuit · {n}', { n: new Set(dto.memberRoomIds).size }) : t('Rooms on the circuit'),
          hint: circuitRoomsHint(c.kind),
          items: rooms,
          empty: t('No rooms yet. Add a room here, or tick this heating in the room’s settings.'),
          add: d.canEdit && (c.kind === 'floor' || c.kind === 'radiators') ? { label: t('Room'), onClick: () => setOpen({ kind: 'add' }) } : undefined,
        }}
        actions={actions}
      />
      {open?.kind === 'add' ? <AddRoomDialog d={d} dto={dto} onClose={() => setOpen(null)} /> : null}
      {open?.kind === 'merge' ? <MergeDialog d={d} dto={dto} onClose={() => setOpen(null)} /> : null}
      {open?.kind === 'zone' ? <ZoneDialog d={d} dto={dto} member={open.member} onClose={() => setOpen(null)} /> : null}
      {open?.kind === 'leave' ? <RemoveRoomDialog d={d} dto={dto} member={open.member} onClose={() => setOpen(null)} /> : null}
      {open?.kind === 'unzone' ? <RemoveZoneDialog d={d} dto={dto} member={open.member} zone={open.zone} onClose={() => setOpen(null)} /> : null}
    </>
  );
}
