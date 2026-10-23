import { useState } from 'react';
import type { CircuitDto, CircuitMode, Id, NewCircuitRequest, RoomHeatingKind, RoomHeatingRequest } from '@api/model';
import { api } from '@api/endpoints';
import { useEntitySearch, useResource } from '@data';
import {
  AutoGrid,
  Button,
  CheckboxRow,
  ConfirmDialog,
  EntityPicker,
  RadioCardList,
  Row,
  Section,
  Select,
  Stack,
  StatusBanner,
  Stepper,
  Text,
  TextField,
  ToggleCard,
  toast,
} from '@ui';
import { brand } from '@brand';
import { circuitModeWords, fmtDur, fmtTemp, HEATING_KIND_ICON, HEATING_KIND_ORDER, heatingKindWords, t } from '@i18n';
import type { SectionProps } from '../sections/types';
import { circuitSummary, type EditState, type useCircuits, type useRoomWrite } from './shared';

type Circuits = ReturnType<typeof useCircuits>;
type Write = ReturnType<typeof useRoomWrite>;

interface Confirm {
  title: string;
  consequences: string[];
  label: string;
  send: () => void;
}

/** The kinds after a change (heads and ordinary valves are the same radiators: one replaces the other). */
function withKind(kinds: readonly RoomHeatingKind[], add: RoomHeatingKind | null, remove: RoomHeatingKind | null): RoomHeatingKind[] {
  const set = new Set(kinds);
  if (remove) set.delete(remove);
  if (add) {
    set.add(add);
    if (add === 'trv') set.delete('radiator_plain');
    if (add === 'radiator_plain') set.delete('trv');
  }
  return HEATING_KIND_ORDER.filter((k) => set.has(k));
}

/** A house circuit the room is on: how it runs, its pump and the rooms it shares it with; another one to move to. */
function CircuitCard({
  p,
  title,
  circuit,
  others,
  onMove,
  busy,
}: {
  p: SectionProps;
  title: string;
  circuit: CircuitDto | undefined;
  others: CircuitDto[];
  onMove: (id: Id) => void;
  busy: boolean;
}) {
  const sum = circuit ? circuitSummary(circuit, p.room.config.id, p.ctx) : null;
  return (
    <Section variant="well" level={3} title={title} subtitle={sum ? sum.mode.title : t('Its circuit was deleted — choose the one it is on now.')}>
      <Stack gap="xs">
        {sum ? <Text>{sum.mode.hint}</Text> : null}
        {sum ? <Text variant="caption">{sum.line}</Text> : null}
        {others.length > (circuit ? 1 : 0) ? (
          <Select
            value={circuit?.config.id ?? ''}
            options={[...(circuit ? [] : [{ value: '', label: t('Choose the circuit…') }]), ...others.map((c) => ({ value: c.config.id, label: c.config.name }))]}
            onChange={(v) => v && v !== circuit?.config.id && onMove(v)}
            label={t('On the circuit')}
            ariaLabel={t('On the circuit')}
            disabled={!p.canEdit || busy}
          />
        ) : null}
      </Stack>
    </Section>
  );
}

/** The one-time setup of the house floor circuit, when the room is the first with underfloor heating. */
function FloorSetup({ onJoin, onCancel, busy }: { onJoin: (c: NewCircuitRequest) => void; onCancel: () => void; busy: boolean }) {
  const search = useEntitySearch('pump', {});
  const sources = useResource('names:sources', api.sources.list, { reloadOn: ['source'] });
  const heat = (sources.data ?? []).filter((s) => s.config.scope === 'central' && s.config.capabilities.heat);
  const [name, setName] = useState('');
  const [pump, setPump] = useState<string | null>(null);
  const [mode, setMode] = useState<CircuitMode>('follow_source');
  const [sourceIds, setSourceIds] = useState<Id[]>([]);
  const [runOn, setRunOn] = useState(10);
  const all = sourceIds.length === 0;
  const toggle = (id: Id, on: boolean) => {
    const now = all ? heat.map((s) => s.config.id) : sourceIds;
    const next = on ? [...now, id] : now.filter((x) => x !== id);
    setSourceIds(next.length === heat.length ? [] : next);
  };
  return (
    <Section
      variant="well"
      level={3}
      title={t('Set up underfloor heating for the house')}
      subtitle={t('Once: every later room with underfloor heating joins it. All of it can be changed on the system page.')}
    >
      <Stack gap="md">
        <TextField label={t('Name')} value={name} onChange={setName} placeholder={t('Underfloor heating')} maxLength={40} />
        <Stack gap="xs">
          <EntityPicker value={pump} onChange={(id) => setPump(id)} search={search} placeholder={t('The floor pump — optional')} clearable />
          <Text variant="caption">{t('Leave it empty if the boiler or heat pump runs the floor pump itself.')}</Text>
        </Stack>
        <RadioCardList<CircuitMode>
          value={mode}
          options={(['follow_source', 'zoned'] as const).map((m) => {
            const words = circuitModeWords(m, 'floor', runOn);
            return { value: m, title: words.title, hint: words.hint, badge: m === 'follow_source' ? t('most floors') : undefined };
          })}
          onChange={setMode}
          ariaLabel={t('How the floor runs')}
        />
        {heat.length > 1 ? (
          <Stack gap="xs">
            <Text variant="caption">{t('Fed by')}</Text>
            {heat.map((s) => (
              <CheckboxRow
                key={s.config.id}
                variant="well"
                checked={all || sourceIds.includes(s.config.id)}
                title={s.config.name}
                onChange={(on) => toggle(s.config.id, on)}
              />
            ))}
          </Stack>
        ) : null}
        <Stepper
          variant="compact"
          label={t('The pump runs on after the source stops')}
          value={runOn}
          text={fmtDur(runOn)}
          min={0}
          max={30}
          step={1}
          onChange={(v) => setRunOn(Math.round(v))}
          ariaDec={t('Shorter')}
          ariaInc={t('Longer')}
        />
        <Row gap="sm" wrap>
          <Button
            variant="primary"
            icon="check"
            loading={busy}
            onClick={() => onJoin({ name: name.trim() || t('Underfloor heating'), pumpEntityId: pump, sourceIds, mode, runOnMin: runOn })}
          >
            {t('Set up and join')}
          </Button>
          <Button variant="ghost" onClick={onCancel}>
            {t('Cancel')}
          </Button>
        </Row>
      </Stack>
    </Section>
  );
}

/**
 * «Що гріє чи охолоджує кімнату», as on the wizard's first step: each card switches a kind on or off.
 * Taking something away asks first and says what happens to the devices; a kind that needs a device
 * (heads, an AC, a heater) opens its search below and is on once the first one is added.
 */
export function HeatingKinds({ p, edit, circuits, write }: { p: SectionProps; edit: EditState; circuits: Circuits; write: Write }) {
  const { room } = p;
  const h = room.heating;
  const kinds = h.kinds;
  const id = room.config.id;
  const product = brand.productName;
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [floorChoice, setFloorChoice] = useState<Id | null>(null);
  const release = fmtTemp(room.config.trv.releaseSetpointC);
  const heads = h.bindings.filter((b) => b.role === 'trv');
  const radiatorCircuit = circuits.byId(h.radiators?.circuit?.id);
  const floorCircuit = circuits.byId(h.floor?.circuit?.id);
  const zones = h.bindings.filter((b) => b.role === 'floor_zone');
  const sources = (kind: 'ac' | 'local') => h.bindings.filter((b) => b.role === (kind === 'ac' ? 'ac' : 'heater'));

  // a confirmation stays open until the change is done (heads handed back answer within seconds)
  const send = (req: RoomHeatingRequest, done: string) => void write.run(() => api.rooms.setHeating(id, req), done).finally(() => setConfirm(null));
  const ask = (c: Confirm) => setConfirm(c);

  const headsBack = heads.length
    ? t('The heads ({count}) get their own setpoint back ({t}) and regulate by themselves again.', { count: heads.length, t: release })
    : '';
  const leaves = (c: CircuitDto | undefined, what: string) =>
    c ? t('The room leaves «{circuit}»: {what} no longer runs for this room.', { circuit: c.config.name, what }) : '';

  const toggle = (k: RoomHeatingKind) => {
    if (!p.canEdit || write.pending) return;
    const on = kinds.includes(k);
    // the last kind of a controlled room cannot go: something has to answer for its temperature
    const last = on && kinds.length === 1 && k !== 'trv' && room.config.controlEnabled;
    if (last) {
      toast({ tone: 'warn', message: t('Something has to heat or cool the room. Tick what replaces it first, or let the room only be watched («{product} controls this room» below).', { product }) });
      return;
    }
    const plainWords = heatingKindWords('radiator_plain', product);
    switch (k) {
      case 'trv':
        if (on) {
          ask({
            title: t('Remove the smart heads?'),
            consequences: [headsBack, t('The radiators stay, with ordinary valves: {hint}', { hint: plainWords.hint })],
            label: t('Switch to ordinary valves'),
            send: () => send({ kinds: withKind(kinds, 'radiator_plain', 'trv') }, t('The room now has radiators with ordinary valves.')),
          });
        } else edit.setPending(edit.pending === 'trv' ? null : 'trv');
        return;
      case 'radiator_plain':
        if (on) {
          ask({
            title: t('Remove the radiators from the room?'),
            consequences: [leaves(radiatorCircuit, t('the radiator pump')), t('The boiler or heat pump is no longer started for this room’s radiators.')],
            label: t('Remove the radiators'),
            send: () => send({ kinds: withKind(kinds, null, 'radiator_plain') }, t('The room no longer has radiators.')),
          });
        } else if (kinds.includes('trv')) {
          ask({
            title: t('Switch to ordinary valves?'),
            consequences: [headsBack, plainWords.hint],
            label: t('Switch to ordinary valves'),
            send: () => send({ kinds: withKind(kinds, 'radiator_plain', 'trv') }, t('The room now has radiators with ordinary valves.')),
          });
        } else send({ kinds: withKind(kinds, 'radiator_plain', null) }, t('The room now has radiators with ordinary valves.'));
        return;
      case 'floor':
        if (on) {
          const zoned = floorCircuit?.config.mode === 'zoned';
          ask({
            title: t('Take the room off underfloor heating?'),
            consequences: [
              zoned || !floorCircuit
                ? leaves(floorCircuit, t('the floor pump'))
                : t('The room leaves «{circuit}»: it no longer starts the source for its floor.', { circuit: floorCircuit.config.name }),
              zones.length
                ? t('Its zone valve is left as the loop needs it — open on a floor that only heats.')
                : zoned
                  ? ''
                  : t('The whole floor runs together, so its loop here still warms whenever the source runs — only the room’s asking for heat ends.'),
            ].filter(Boolean),
            label: t('Take off underfloor heating'),
            send: () => send({ kinds: withKind(kinds, null, 'floor') }, t('The room is off underfloor heating.')),
          });
        } else if (circuits.floor.length === 1) {
          const c = circuits.floor[0];
          send({ kinds: withKind(kinds, 'floor', null), floorCircuitId: c.config.id }, t('The room joined «{circuit}».', { circuit: c.config.name }));
        } else edit.setPending(edit.pending === 'floor' ? null : 'floor');
        return;
      case 'ac':
      case 'local': {
        if (on) {
          const list = sources(k);
          ask({
            title: k === 'ac' ? t('Remove the air conditioner from the room?') : t('Remove the heater from the room?'),
            consequences: list.map((b) => t('«{name}» is switched off and no longer driven from here.', { name: b.name })),
            label: t('Remove'),
            send: () => send({ kinds: withKind(kinds, null, k) }, k === 'ac' ? t('The air conditioner is removed from the room.') : t('The heater is removed from the room.')),
          });
        } else edit.setPending(edit.pending === k ? null : k);
        return;
      }
    }
  };

  // heads being picked show as the radiators' new kind; ordinary valves stay until the first head is in
  const pressed = (k: RoomHeatingKind) => (kinds.includes(k) && !(k === 'radiator_plain' && edit.pending === 'trv')) || edit.pending === k;
  const joinFloor = (circuitId: Id | null, create: NewCircuitRequest | null) => {
    edit.setPending(null);
    const name = create?.name ?? circuits.byId(circuitId)?.config.name ?? '';
    send({ kinds: withKind(kinds, 'floor', null), floorCircuitId: circuitId, newFloorCircuit: create }, t('The room joined «{circuit}».', { circuit: name }));
  };

  return (
    <Stack gap="md">
      <Section variant="plain" level={3} title={t('What heats or cools the room?')}>
        <AutoGrid min={240} gap="sm">
          {HEATING_KIND_ORDER.map((k) => {
            const words = heatingKindWords(k, product);
            return <ToggleCard key={k} pressed={pressed(k)} icon={HEATING_KIND_ICON[k]} title={words.title} hint={words.hint} onToggle={() => toggle(k)} />;
          })}
        </AutoGrid>
      </Section>
      {!kinds.length && room.config.controlEnabled ? <StatusBanner tone="warn" text={t('Nothing heats or cools this room yet — tick what it has.')} /> : null}
      {kinds.includes('radiator_plain') && h.temperature === 'none' ? (
        <StatusBanner tone="warn" text={t('Ordinary radiators follow the room temperature — add a temperature sensor below.')} />
      ) : null}
      {h.radiators ? (
        <CircuitCard
          p={p}
          title={kinds.includes('trv') ? t('Radiators · on «{circuit}»', { circuit: radiatorCircuit?.config.name ?? '—' }) : t('Radiators with ordinary valves · on «{circuit}»', { circuit: radiatorCircuit?.config.name ?? '—' })}
          circuit={radiatorCircuit}
          others={circuits.radiators}
          busy={write.pending}
          onMove={(cid) =>
            send({ kinds, radiatorCircuitId: cid }, t('The radiators are on «{circuit}» now.', { circuit: circuits.byId(cid)?.config.name ?? '' }))
          }
        />
      ) : null}
      {h.floor ? (
        <CircuitCard
          p={p}
          title={t('Underfloor heating · on «{circuit}»', { circuit: floorCircuit?.config.name ?? '—' })}
          circuit={floorCircuit}
          others={circuits.floor}
          busy={write.pending}
          onMove={(cid) => send({ kinds, floorCircuitId: cid }, t('The floor is on «{circuit}» now.', { circuit: circuits.byId(cid)?.config.name ?? '' }))}
        />
      ) : null}
      {edit.pending === 'floor' && !h.floor ? (
        circuits.floor.length > 1 ? (
          <Section variant="well" level={3} title={t('Which floor circuit?')} subtitle={t('The house has several — the room joins one of them.')}>
            <Stack gap="sm">
              <Select
                value={floorChoice ?? ''}
                options={[{ value: '', label: t('Choose the floor circuit…') }, ...circuits.floor.map((c) => ({ value: c.config.id, label: c.config.name }))]}
                onChange={(v) => setFloorChoice(v || null)}
                ariaLabel={t('The floor circuit of the room')}
              />
              <Row gap="sm" wrap>
                <Button variant="primary" icon="check" disabled={!floorChoice} loading={write.pending} onClick={() => joinFloor(floorChoice, null)}>
                  {t('Join')}
                </Button>
                <Button variant="ghost" onClick={() => edit.setPending(null)}>
                  {t('Cancel')}
                </Button>
              </Row>
            </Stack>
          </Section>
        ) : (
          <FloorSetup busy={write.pending} onCancel={() => edit.setPending(null)} onJoin={(c) => joinFloor(null, c)} />
        )
      ) : null}
      <ConfirmDialog
        open={confirm != null}
        title={confirm?.title ?? ''}
        consequences={confirm?.consequences.filter(Boolean)}
        confirm={{ label: confirm?.label ?? '', tone: 'danger', onClick: () => confirm?.send(), loading: write.pending }}
        onCancel={() => setConfirm(null)}
      />
    </Stack>
  );
}
