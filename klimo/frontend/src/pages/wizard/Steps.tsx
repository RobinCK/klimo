import { useEffect, useState } from 'react';
import type { AggregationMethod, ApiErrorIssue, CircuitDto, CircuitMode, DiscoveryCandidate, HaEntityDto, ProfileDto, TrvStrategy, WindowReaction, WizardDeviceRole } from '@api/model';
import { AGGREGATION_METHODS, TRV_STRATEGIES } from '@api/model';
import { useEntitySearch } from '@data';
import {
  AddDeviceDialog,
  AreaSelect,
  AutoGrid,
  Button,
  CheckboxRow,
  DeviceRow,
  EmptyState,
  EntityPicker,
  GuardList,
  KeyValueList,
  ProfileTile,
  QuickActionPill,
  RadioCardList,
  RadioValueGrid,
  Row,
  Section,
  Select,
  Stack,
  StatusBanner,
  Stepper,
  Text,
  TextField,
  ToggleCard,
} from '@ui';
import { brand } from '@brand';
import {
  aggregationHint,
  aggregationLabel,
  circuitLine,
  circuitModeWords,
  DEVICE_GROUP_ORDER,
  deviceGroupSearchRoles,
  deviceGroupWords,
  entityRoomNote,
  entityValueText,
  fmtDelta,
  fmtDur,
  fmtTemp,
  HEATING_KIND_ICON,
  HEATING_KIND_ORDER,
  heatingKindWords,
  integrationName,
  roleInGroup,
  sourceBlockText,
  t,
  toleranceHint,
  trvStrategiesHint,
  type CodeContext,
} from '@i18n';
import { candidateMeta, candidateValue, extraMeta, roleLabel, sectionWords, stepWords, wizardIssue } from './texts';
import { SECTION_ROLES, sectionOf, type EmitterChoice, type ExtraDevice, type SectionKey, type Wizard } from './useWizard';

function Issues({ w, only }: { w: Wizard; only?: (issue: ApiErrorIssue) => boolean }) {
  const list = w.issues.filter((i) => (only ? only(i) : true));
  if (!list.length) return null;
  return (
    <Stack gap="xs">
      {list.map((i, n) => (
        <StatusBanner key={`${i.path}-${n}`} tone="warn" text={wizardIssue(i, w.request)} />
      ))}
    </Stack>
  );
}

/* ------------------------------------ step 1 ------------------------------------ */

export function StepName({ w }: { w: Wizard }) {
  const nameIssue = w.issues.find((i) => i.path === 'name');
  return (
    <Stack gap="lg">
      <TextField
        label={t('Name')}
        size="xl"
        value={w.name}
        onChange={w.setName}
        maxLength={40}
        autoFocus
        onEnter={w.next}
        error={nameIssue ? wizardIssue(nameIssue, w.request) : undefined}
      />
      <AreaSelect label={t('Home Assistant area')} value={w.areaId} areas={w.areas} onChange={w.setArea} noneLabel={t('No area')} />
      <Section
        variant="plain"
        level={3}
        title={t('What heats or cools the room?')}
        subtitle={t('Tick everything there is. A device picked on the next step ticks its kind too.')}
      >
        <Stack gap="sm">
          <AutoGrid min={420} gap="sm">
            {HEATING_KIND_ORDER.map((k) => {
              const words = heatingKindWords(k, brand.productName);
              return <ToggleCard key={k} pressed={w.kinds.includes(k)} icon={HEATING_KIND_ICON[k]} title={words.title} hint={words.hint} onToggle={() => w.toggleKind(k)} />;
            })}
          </AutoGrid>
          <Issues w={w} only={(i) => i.path === 'emitterKinds' || i.path === 'demandPolicy'} />
        </Stack>
      </Section>
      <CheckboxRow
        variant="well"
        checked={w.demand === 'call'}
        title={t('Can start the sources')}
        hint={t('the heat pump, the boiler — switch off for rarely used rooms')}
        onChange={(on) => w.setDemand(on ? 'call' : 'piggyback')}
      />
      <Text>{t('Next come the devices: what the area holds is offered by kind, anything else is added with «{add}».', { add: t('Add a device') })}</Text>
      <Issues w={w} only={(i) => i.path !== 'name' && i.path !== 'emitterKinds' && i.path !== 'demandPolicy'} />
    </Stack>
  );
}

/* ------------------------------------ step 2 ------------------------------------ */

/** The device block a heating kind brings. */
const KIND_SECTION: Partial<Record<EmitterChoice, SectionKey>> = { trv: 'trv', floor: 'floor', ac: 'ac', local: 'heater' };
const SECTION_KIND = Object.fromEntries(Object.entries(KIND_SECTION).map(([kind, k]) => [k, kind])) as Partial<Record<SectionKey, EmitterChoice>>;

/** Where a device-step problem is read: in its block, the radiator block, under the heat chips, or in the list at the end. */
function issueHome(i: ApiErrorIssue): SectionKey | 'heat' | 'radiators' | null {
  if (i.path === 'emitterKinds') return 'heat';
  if (i.path.startsWith('circuits.radiator') || i.path.startsWith('circuits.newRadiator')) return 'radiators';
  if (i.path.startsWith('circuits')) return 'floor';
  if (i.path === 'devices' && i.code === 'needs_temperature') return 'temp';
  if (i.path === 'devices' && i.code === 'required' && typeof i.params?.role === 'string') return sectionOf(i.params.role as WizardDeviceRole);
  return null;
}

/** A house circuit in one line: how it runs, its pump and the rooms already on it. */
function circuitSummary(c: CircuitDto, ctx: CodeContext): { mode: { title: string; hint: string }; line: string } {
  const pumps = c.pumps.filter((p) => p.enabled);
  const runOn = pumps[0]?.runOnHeatMin ?? null;
  return {
    mode: circuitModeWords(c.config.mode, c.config.kind, runOn),
    line: circuitLine(
      pumps.map((p) => ctx.pump?.(p.id) ?? p.name),
      c.memberRoomIds.map((id) => ctx.room?.(id) ?? id),
    ),
  };
}

/** The floor circuit of the house the room joins — or, when the house has none, its one-time setup. */
function FloorCircuit({ w, ctx }: { w: Wizard; ctx: CodeContext }) {
  const search = useEntitySearch('pump', {});
  const several = w.floorCircuits.length > 1;
  const choose = several ? (
    <Select
      value={w.floorCircuit?.config.id ?? ''}
      options={[
        ...(w.floorCircuit ? [] : [{ value: '', label: t('Choose the floor circuit…') }]),
        ...w.floorCircuits.map((c) => ({ value: c.config.id, label: c.config.name })),
      ]}
      onChange={(v) => w.setFloor({ circuitId: v || null })}
      label={t('The floor circuit of the room')}
      ariaLabel={t('The floor circuit of the room')}
    />
  ) : null;
  if (w.floorCircuit) {
    const sum = circuitSummary(w.floorCircuit, ctx);
    return (
      <Section variant="well" level={3} title={t('Joins «{circuit}»', { circuit: w.floorCircuit.config.name })} subtitle={sum.mode.title}>
        <Stack gap="sm">
          <Text>{sum.mode.hint}</Text>
          <Text variant="caption">{sum.line}</Text>
          {choose}
          <Text variant="caption">{t('How the circuit runs, its pump and run-on are set on the system page.')}</Text>
        </Stack>
      </Section>
    );
  }
  if (several) {
    return (
      <Section variant="well" level={3} title={t('Which floor circuit?')} subtitle={t('The house has several — the room joins one of them.')}>
        {choose}
      </Section>
    );
  }
  const setup = w.floor.setup;
  const all = setup.sourceIds.length === 0;
  const fed = (id: string) => all || setup.sourceIds.includes(id);
  const toggleSource = (id: string, on: boolean) => {
    const now = all ? w.heatSources.map((x) => x.id) : setup.sourceIds;
    const next = on ? [...now, id] : now.filter((x) => x !== id);
    // every source ticked is the same as «all of them» (and stays so when one is added later)
    w.setFloor({ setup: { sourceIds: next.length === w.heatSources.length ? [] : next } });
  };
  return (
    <Section
      variant="well"
      level={3}
      title={t('Set up underfloor heating for the house')}
      subtitle={t('Once: every later room with underfloor heating joins it. All of it can be changed on the system page.')}
    >
      <Stack gap="md">
        <TextField label={t('Name')} value={setup.name} onChange={(v) => w.setFloor({ setup: { name: v } })} placeholder={t('Underfloor heating')} maxLength={40} />
        <Stack gap="xs">
          <EntityPicker
            value={setup.pumpEntityId}
            onChange={(id) => w.setFloor({ setup: { pumpEntityId: id } })}
            search={search}
            placeholder={t('The floor pump — optional')}
            clearable
          />
          <Text variant="caption">{t('Leave it empty if the boiler or heat pump runs the floor pump itself.')}</Text>
        </Stack>
        <RadioCardList<CircuitMode>
          value={setup.mode}
          options={(['follow_source', 'zoned'] as const).map((m) => {
            const words = circuitModeWords(m, 'floor', setup.runOnMin);
            return { value: m, title: words.title, hint: words.hint, badge: m === 'follow_source' ? t('most floors') : undefined };
          })}
          onChange={(m) => w.setFloor({ setup: { mode: m } })}
          ariaLabel={t('How the floor runs')}
        />
        {w.heatSources.length > 1 ? (
          <Stack gap="xs">
            <Text variant="caption">{t('Fed by')}</Text>
            {w.heatSources.map((x) => (
              <CheckboxRow key={x.id} variant="well" checked={fed(x.id)} title={x.name} onChange={(on) => toggleSource(x.id, on)} />
            ))}
          </Stack>
        ) : null}
        <Stepper
          variant="compact"
          label={t('The pump runs on after the source stops')}
          value={setup.runOnMin}
          text={fmtDur(setup.runOnMin)}
          min={0}
          max={30}
          step={1}
          onChange={(v) => w.setFloor({ setup: { runOnMin: Math.round(v) } })}
          ariaDec={t('Shorter')}
          ariaInc={t('Longer')}
        />
      </Stack>
    </Section>
  );
}

/** The radiator circuit the room goes on, in one line (a choice only when 0.1.0 left several). */
function RadiatorCircuit({ w }: { w: Wizard }) {
  const c = w.radiatorCircuit;
  return (
    <Stack gap="xs">
      <Text variant="caption">
        {c ? t('Joins the radiator circuit «{circuit}».', { circuit: c.config.name }) : t('A radiator circuit for the house is set up with the room.')}
      </Text>
      {w.radiatorCircuits.length > 1 ? (
        <Select
          value={c?.config.id ?? ''}
          options={w.radiatorCircuits.map((x) => ({ value: x.config.id, label: x.config.name }))}
          onChange={(v) => w.setRadiatorCircuit(v || null)}
          label={t('The radiator circuit of the room')}
          ariaLabel={t('The radiator circuit of the room')}
        />
      ) : null}
    </Stack>
  );
}

/** Radiators with ordinary valves: nothing to pick, the room switches the pump and the source by its temperature. */
function PlainRadiators({ w }: { w: Wizard }) {
  return (
    <Section variant="plain" level={3} title={heatingKindWords('radiator_plain', brand.productName).title} tag={t('no device needed')}>
      <Stack gap="xs">
        <Text>
          {t('{product} switches the boiler or heat pump and the radiator pump on while it is colder here than the target. The valves stay as they are set by hand.', {
            product: brand.productName,
          })}
        </Text>
        <RadiatorCircuit w={w} />
        <Issues w={w} only={(i) => issueHome(i) === 'radiators'} />
      </Stack>
    </Section>
  );
}

interface SectionProps {
  w: Wizard;
  k: SectionKey;
  cands: DiscoveryCandidate[];
  extras: ExtraDevice[];
  ctx: CodeContext;
  rowIssue: (entityId: string, role: WizardDeviceRole) => string | undefined;
  onAdd: (k: SectionKey) => void;
}

/** One kind of device: what the area offers (ticked or not), what was added by hand, and «+ Додати». */
function DeviceSection({ w, k, cands, extras, ctx, rowIssue, onAdd }: SectionProps) {
  const words = sectionWords(k, w.floorZoned);
  const roomName = (id: string) => ctx.room?.(id) ?? id;
  const empty = !cands.length && !extras.length;
  const kind = SECTION_KIND[k];
  // a block the room cannot do without says how to fill it; the floor's own block says what it needs
  const essential = k === 'temp' || (kind != null && k !== 'floor' && w.kinds.includes(kind));
  const devices = w.request.devices;
  const heads = devices.filter((d) => d.role === 'trv');
  const ownOffer = k === 'temp' && heads.length > 0 && !devices.some((d) => d.role === 'temperature' || d.role === 'temp_humidity');
  const plain = w.kinds.includes('radiator_plain');
  // a head's own reading shows what the head reads now
  const headValue = (entityId: string): string | undefined => {
    const c = w.candidates.find((x) => x.entityId === entityId);
    const x = w.extras.find((y) => y.entityId === entityId && !y.ownTemperature);
    const v = c?.valueC ?? x?.valueC ?? null;
    return v != null ? fmtTemp(v) : undefined;
  };
  const add = t('Add');

  return (
    <Section
      variant="plain"
      level={3}
      title={words.title}
      tag={words.tag}
      action={
        <Button variant="ghost" size="sm" icon="plus" ariaLabel={t('Add to «{section}»', { section: words.title })} onClick={() => onAdd(k)}>
          {add}
        </Button>
      }
      inlineAction
    >
      <Stack gap="xs">
        {k === 'floor' ? <FloorCircuit w={w} ctx={ctx} /> : null}
        {cands.map((c) => {
          const used = w.inUse(c);
          const picked = w.picked(c);
          return (
            <DeviceRow
              key={c.entityId}
              checked={picked}
              title={c.name}
              meta={candidateMeta({ ...c, role: w.roleOf(c) }, roomName, used)}
              value={candidateValue({ ...c, role: w.roleOf(c) })}
              // a source cannot also be a room's own device; a pump can, if the user insists
              disabled={used?.as === 'source' && !picked}
              onCheck={() => w.togglePick(c)}
              error={picked ? rowIssue(c.entityId, w.roleOf(c)) : undefined}
            />
          );
        })}
        {extras.map((x) => (
          <DeviceRow
            key={`${x.role}|${x.entityId}`}
            title={x.name}
            meta={extraMeta(x)}
            value={x.ownTemperature ? headValue(x.entityId) : x.valueC != null ? fmtTemp(x.valueC) : candidateValue({ role: x.role, state: x.state, valueC: null })}
            onRemove={() => w.removeExtra(x.entityId, x.role)}
            error={rowIssue(x.entityId, x.role)}
          />
        ))}
        {empty && essential && !ownOffer ? (
          <Text variant="caption">
            {w.areaId
              ? t('Nothing found — add it with «{top}» above or «+ {add}» here.', { top: t('Add a device'), add })
              : t('Nothing here yet — add it with «{top}» above or «+ {add}» here.', { top: t('Add a device'), add })}
          </Text>
        ) : null}
        {empty && k === 'floor' ? <Text variant="caption">{words.hint}</Text> : null}
        {k === 'trv' && empty && w.kinds.includes('trv') ? (
          // the head on most radiators is a mechanical one: it needs no device, only the other kind
          <StatusBanner
            tone="event"
            text={t('Mechanical heads or hand valves? They need no device — choose ordinary valves and {product} heats by the room temperature.', {
              product: brand.productName,
            })}
            action={{ label: t('Ordinary valves'), onClick: w.toOrdinaryValves }}
          />
        ) : null}
        {ownOffer ? (
          // the quickest way for a room with only a thermostat; a sensor of its own stays the better one
          <Stack gap="xs">
            <Row gap="sm" wrap>
              {heads.map((h) => (
                <QuickActionPill
                  key={h.entityId}
                  icon="thermometer"
                  label={heads.length === 1 ? t('Use the thermostat’s own temperature') : t('Use the temperature of «{name}»', { name: h.name ?? h.entityId })}
                  onClick={() => w.takeOwnTemperature({ entityId: h.entityId, name: h.name ?? h.entityId })}
                />
              ))}
            </Row>
            <Text variant="caption">
              {t('Fine to start with, but a thermostat on the radiator reads warmer than the room — a sensor away from it is more accurate.')}
            </Text>
          </Stack>
        ) : null}
        {k === 'trv' && w.kinds.includes('trv') && !plain ? <RadiatorCircuit w={w} /> : null}
        <Issues w={w} only={(i) => issueHome(i) === k || (k === 'trv' && !plain && issueHome(i) === 'radiators')} />
      </Stack>
    </Section>
  );
}

/** «Додати пристрій»: what it is first, then the entity among all of Home Assistant (the area first). */
function AddDevice({ w, group, open, onClose }: { w: Wizard; group: SectionKey; open: boolean; onClose: () => void }) {
  const [k, setK] = useState<SectionKey>(group);
  useEffect(() => {
    if (open) setK(group);
  }, [open, group]);
  const search = useEntitySearch(null, { wizardRoles: deviceGroupSearchRoles(k, w.floorZoned), areaId: w.areaId, limit: 30 });
  const note = (e: HaEntityDto) => {
    const roles = w.request.devices.filter((d) => d.entityId === e.entityId).map((d) => roleLabel(d.role).toLowerCase());
    return roles.length ? t('already added as {role}', { role: roles.join(', ') }) : entityRoomNote(e);
  };
  // a combined sensor already brings both readings: its other entity would be the same sensor twice
  const together = (e: HaEntityDto) => {
    const x = e.deviceId ? w.extras.find((y) => y.role === 'temp_humidity' && y.deviceId === e.deviceId && y.entityId !== e.entityId) : undefined;
    const role = roleInGroup(e, k, w.floorZoned);
    return x && (role === 'temperature' || role === 'humidity') ? t('already here: «{name}» brings both the temperature and the humidity', { name: x.name }) : null;
  };
  return (
    <AddDeviceDialog<SectionKey>
      open={open}
      onClose={onClose}
      title={t('Add a device')}
      kinds={DEVICE_GROUP_ORDER.map((g) => ({ value: g, label: deviceGroupWords(g).what }))}
      kind={k}
      onKind={setK}
      kindLabel={t('What it is')}
      search={search}
      placeholder={t('Name or entity id')}
      help={w.areaName ? t('Searches all of Home Assistant; what is in «{area}» comes first.', { area: w.areaName }) : t('Searches all of Home Assistant by name or entity id.')}
      note={note}
      blocked={(e) => sourceBlockText(e, roleInGroup(e, k, w.floorZoned)) ?? together(e)}
      valueText={entityValueText}
      addLabel={t('Add')}
      onAdd={(e) => {
        w.addDevice(e, roleInGroup(e, k, w.floorZoned));
        onClose();
      }}
    />
  );
}

export function StepDevices({ w, ctx }: { w: Wizard; ctx: CodeContext }) {
  const [adding, setAdding] = useState<SectionKey | null>(null);
  const [group, setGroup] = useState<SectionKey>('temp');
  const devices = w.request.devices;
  const found = w.candidates.length;
  const kindOpen = (k: SectionKey) => {
    const kind = SECTION_KIND[k];
    return kind != null && w.kinds.includes(kind);
  };

  const rowIssue = (entityId: string, role: WizardDeviceRole) => {
    const i = devices.findIndex((d) => d.entityId === entityId && d.role === role);
    const issue = i < 0 ? undefined : w.issues.find((x) => x.path === `devices.${i}` || x.path.startsWith(`devices.${i}.`));
    return issue ? wizardIssue(issue, w.request) : undefined;
  };

  const sections = DEVICE_GROUP_ORDER.map((k) => {
    const cands = w.candidates.filter((c) => SECTION_ROLES[k].includes(w.roleOf(c)));
    const extras = w.extras.filter((x) => SECTION_ROLES[k].includes(x.role));
    return { k, cands, extras, shown: k === 'temp' || cands.length > 0 || extras.length > 0 || kindOpen(k) };
  });
  const plain = w.kinds.includes('radiator_plain');
  // until something heats or cools, the kinds are the question of the step
  const asksHeat = !w.kinds.length;
  const shownKeys = new Set(sections.filter((s) => s.shown).map((s) => s.k));
  const placed = (i: ApiErrorIssue) => {
    const home = issueHome(i);
    if (home === 'heat') return asksHeat;
    if (home === 'radiators') return plain || shownKeys.has('trv');
    return home !== null && shownKeys.has(home);
  };
  const open = (k: SectionKey) => {
    setGroup(k);
    setAdding(k);
  };
  // the top button starts with the first block the room still needs
  const firstNeeded = sections.find((s) => s.shown && s.k !== 'floor' && !s.cands.length && !s.extras.length && (s.k === 'temp' || kindOpen(s.k)))?.k ?? 'temp';

  const banner = !w.areaId ? (
    <StatusBanner tone="event" text={t('No area chosen — add the devices with «{top}».', { top: t('Add a device') })} />
  ) : w.discovering ? (
    <StatusBanner tone="event" icon="search" text={t('Looking for devices in «{area}»…', { area: w.areaName ?? '' })} />
  ) : found ? (
    <StatusBanner
      tone="ok"
      text={
        w.integrations.length
          ? t('Found {count} devices in «{area}» · {integrations}', {
              count: found,
              area: w.areaName ?? '',
              integrations: w.integrations.map(integrationName).join(', '),
            })
          : t('Found {count} devices in «{area}»', { count: found, area: w.areaName ?? '' })
      }
    />
  ) : (
    <StatusBanner tone="event" text={t('Nothing found in «{area}» — add the devices with «{top}».', { area: w.areaName ?? '', top: t('Add a device') })} />
  );

  return (
    <Stack gap="lg">
      {banner}
      <Button variant="secondary" size="lg" icon="plus" fullWidth onClick={() => open(firstNeeded)}>
        {t('Add a device')}
      </Button>
      {plain ? <PlainRadiators w={w} /> : null}
      {sections
        .filter((s) => s.shown)
        .map((s) => (
          <DeviceSection key={s.k} w={w} k={s.k} cands={s.cands} extras={s.extras} ctx={ctx} rowIssue={rowIssue} onAdd={open} />
        ))}
      {asksHeat ? (
        <Section variant="plain" level={3} title={t('What heats or cools the room?')}>
          <Stack gap="sm">
            <Row gap="sm" wrap>
              {HEATING_KIND_ORDER.map((k) => (
                <QuickActionPill key={k} icon={HEATING_KIND_ICON[k]} label={heatingKindWords(k, brand.productName).title} onClick={() => w.toggleKind(k)} />
              ))}
            </Row>
            <Issues w={w} only={(i) => issueHome(i) === 'heat'} />
          </Stack>
        </Section>
      ) : null}
      <Issues w={w} only={(i) => !placed(i) && (!/^devices\.\d+/.test(i.path) || rowIssueHidden(w, i.path))} />
      <AddDevice w={w} group={group} open={adding != null} onClose={() => setAdding(null)} />
    </Stack>
  );
}

/** A device check whose row is not on screen (an unticked candidate) still has to be read somewhere. */
function rowIssueHidden(w: Wizard, path: string): boolean {
  const m = /^devices\.(\d+)/.exec(path);
  const dev = m ? w.request.devices[Number(m[1])] : undefined;
  if (!dev) return true;
  return !w.candidates.some((c) => c.entityId === dev.entityId) && !w.extras.some((x) => x.entityId === dev.entityId && x.role === dev.role);
}

/* ------------------------------------ step 3 ------------------------------------ */

/** What the later steps ask about depends on it: the temperature sensors, and whether a window reports. */
function roomShape(w: Wizard) {
  const d = w.request.devices;
  return {
    temps: d.filter((x) => x.role === 'temperature' || x.role === 'temp_humidity'),
    hasWindow: d.some((x) => x.role === 'window' || x.role === 'door'),
  };
}

function strategyTitle(s: TrvStrategy): string {
  switch (s) {
    case 'external':
      return t('Room temperature → into the valve');
    case 'calibration':
      return t('Dynamic offset');
    case 'onoff':
      return t('On / off');
    case 'valve':
      return t('Valve opening, %');
  }
}

export function StepControl({ w, profiles, defaultProfileId }: { w: Wizard; profiles: readonly ProfileDto[] | undefined; defaultProfileId: string }) {
  const home = profiles?.find((p) => p.id === defaultProfileId) ?? profiles?.[0];
  const hasTrv = w.request.devices.some((d) => d.role === 'trv');
  const { temps, hasWindow } = roomShape(w);
  const strategy = w.strategy ?? w.autoStrategy ?? 'external';
  const reactions: { value: WindowReaction; title: string }[] = [
    { value: 'pause', title: t('Do not heat') },
    { value: 'eco', title: t('Switch to «{profile}»', { profile: profiles?.find((p) => p.id === 'eco')?.name ?? t('Eco') }) },
    { value: 'notify', title: t('Only notify') },
  ];
  const tolRow = (mode: 'heat' | 'cool') => {
    const band = mode === 'heat' ? w.heatTol : w.coolTol;
    const set = mode === 'heat' ? w.setHeatTol : w.setCoolTol;
    const r = (v: number) => Math.round(v * 10) / 10;
    return (
      <Stack gap="xs" key={mode}>
        <Stepper
          variant="compact"
          label={mode === 'heat' ? t('below the target — switch on') : t('above the target — switch on')}
          labelTone={mode}
          value={mode === 'heat' ? band.below : band.above}
          text={mode === 'heat' ? `−${fmtDelta(band.below)}` : `+${fmtDelta(band.above)}`}
          min={0.1}
          max={1}
          step={0.1}
          onChange={(v) => set(mode === 'heat' ? { ...band, below: r(v) } : { ...band, above: r(v) })}
          ariaDec={t('Narrower')}
          ariaInc={t('Wider')}
        />
        <Stepper
          variant="compact"
          label={mode === 'heat' ? t('above the target — switch off') : t('below the target — switch off')}
          value={mode === 'heat' ? band.above : band.below}
          text={mode === 'heat' ? `+${fmtDelta(band.above)}` : `−${fmtDelta(band.below)}`}
          min={0.1}
          max={1}
          step={0.1}
          onChange={(v) => set(mode === 'heat' ? { ...band, above: r(v) } : { ...band, below: r(v) })}
          ariaDec={t('Narrower')}
          ariaInc={t('Wider')}
        />
      </Stack>
    );
  };
  return (
    <Stack gap="lg">
      {/* one sensor or none leaves nothing to combine */}
      {temps.length >= 2 ? (
        <Section variant="plain" level={3} title={t('The current temperature is')}>
          <RadioValueGrid<AggregationMethod>
            value={w.method}
            columns={3}
            options={AGGREGATION_METHODS.map((m) => ({ value: m, label: aggregationLabel(m), valueText: fmtTemp(w.methodValues?.[m] ?? null) }))}
            onChange={w.setMethod}
            hint={aggregationHint(w.method)}
            ariaLabel={t('The current temperature is')}
          />
        </Section>
      ) : null}
      <Section
        variant="well"
        level={3}
        title={t('Tolerance')}
        hint={toleranceHint(w.heatTol, home?.heatC ?? null)}
        subtitle={
          home
            ? t('With «{profile}» ({t}): heats from {on}, stops at {off}.', {
                profile: home.name,
                t: fmtTemp(home.heatC),
                on: fmtTemp(home.heatC - w.heatTol.below),
                off: fmtTemp(home.heatC + w.heatTol.above),
              })
            : undefined
        }
      >
        <Stack gap="md">
          {tolRow('heat')}
          {w.needsCool ? tolRow('cool') : null}
        </Stack>
      </Section>
      {hasWindow ? (
        <Section variant="plain" level={3} title={t('When a window is open')}>
          <RadioCardList<WindowReaction> value={w.reaction} compact options={reactions} onChange={w.setReaction} ariaLabel={t('When a window is open')} />
        </Section>
      ) : null}
      {hasTrv ? (
        <Section variant="plain" level={3} title={t('How the valves are controlled')} hint={trvStrategiesHint(brand.productName)}>
          <RadioCardList<TrvStrategy>
            value={strategy}
            compact
            options={TRV_STRATEGIES.map((s) => {
              const miss = w.unsupported.find((u) => u.strategy === s);
              return {
                value: s,
                title: strategyTitle(s),
                badge: s === w.autoStrategy ? t('recommended') : undefined,
                disabled: Boolean(miss),
                disabledReason: miss ? t('a picked valve cannot do this') : undefined,
              };
            })}
            onChange={w.setStrategy}
            ariaLabel={t('How the valves are controlled')}
          />
        </Section>
      ) : null}
      <Issues w={w} />
    </Stack>
  );
}

/* ------------------------------------ step 4 ------------------------------------ */

function devicesLine(w: Wizard): string {
  const d = w.request.devices;
  const n = (roles: WizardDeviceRole[]) => d.filter((x) => roles.includes(x.role)).length;
  const parts: string[] = [];
  if (n(['trv'])) parts.push(t('{count} valves', { count: n(['trv']) }));
  if (n(['temperature', 'temp_humidity', 'humidity'])) parts.push(t('{count} sensors', { count: n(['temperature', 'temp_humidity', 'humidity']) }));
  if (n(['window', 'door'])) parts.push(t('{count} windows', { count: n(['window', 'door']) }));
  if (n(['ac'])) parts.push(t('air conditioner'));
  if (n(['heater'])) parts.push(t('heater'));
  if (n(['floor_zone'])) parts.push(t('floor zone valve'));
  if (n(['dehumidifier'])) parts.push(t('dehumidifier'));
  return parts.join(' · ') || t('no devices');
}

/** «Радіатори зі звичайними вентилями · Тепла підлога (новий контур)». */
function heatingLine(w: Wizard): string {
  return (
    w.kinds
      .map((k) => {
        const title = heatingKindWords(k, brand.productName).title;
        if (k === 'floor') {
          const c = w.floorCircuit;
          return c ? t('{kind} · «{circuit}»', { kind: title, circuit: c.config.name }) : t('{kind} · set up for the house now', { kind: title });
        }
        return title;
      })
      .join(' · ') || t('nothing yet')
  );
}

export function StepReview({ w, profiles }: { w: Wizard; profiles: readonly ProfileDto[] | undefined }) {
  const { temps, hasWindow } = roomShape(w);
  const value = w.methodValues?.[w.method] ?? null;
  const sensor = temps.length === 1 ? temps[0] : null;
  const current =
    temps.length >= 2
      ? t('{method} of {count} · now {t}', { method: aggregationLabel(w.method).toLowerCase(), count: temps.length, t: fmtTemp(value) })
      : sensor && w.extras.some((x) => x.ownTemperature && x.entityId === sensor.entityId)
        ? t('the thermostat’s own reading · now {t}', { t: fmtTemp(value) })
        : sensor
          ? t('«{name}» · now {t}', { name: sensor.name || sensor.entityId, t: fmtTemp(value) })
          : t('from the radiator valves');
  const reaction = w.reaction === 'pause' ? t('do not heat') : w.reaction === 'eco' ? t('switch to eco') : t('only notify');
  const hasTrv = w.request.devices.some((d) => d.role === 'trv');
  const change = (s: 1 | 2 | 3) => ({ label: t('Change'), onClick: () => w.goTo(s) });
  return (
    <Stack gap="lg">
      <KeyValueList
        variant="stacked"
        rows={[
          {
            key: t('Name and area'),
            value: w.areaName ? t('{name} · area «{area}»', { name: w.name, area: w.areaName }) : t('{name} · no area', { name: w.name }),
            action: change(1),
          },
          { key: t('What heats or cools'), value: heatingLine(w), action: change(1) },
          { key: t('Devices'), value: devicesLine(w), action: change(2) },
          // with a single sensor there is nothing to change about it on step 3
          { key: t('Current temperature'), value: current, action: temps.length >= 2 ? change(3) : change(2) },
          { key: t('Tolerance'), value: `−${fmtDelta(w.heatTol.below)} / +${fmtDelta(w.heatTol.above)}`, action: change(3) },
          ...(hasWindow ? [{ key: t('Window open'), value: reaction, action: change(3) }] : []),
          ...(hasTrv ? [{ key: t('Valve'), value: strategyTitle(w.strategy ?? w.autoStrategy ?? 'external'), action: change(3) }] : []),
        ]}
      />
      <Section
        variant="plain"
        level={3}
        title={t('The targets come from the profiles')}
        subtitle={t('An own target per profile can be set later in the room settings.')}
      >
        <AutoGrid min={100} columns={3} gap="xs">
          {(profiles ?? []).map((p) => (
            <ProfileTile key={p.id} name={p.name} color={p.color} value={p.frostOnly ? t('frost guard') : fmtTemp(p.heatC)} />
          ))}
        </AutoGrid>
      </Section>
      <Issues w={w} />
    </Stack>
  );
}

/* ------------------------------------ step 5 ------------------------------------ */

export function StepDone({ w, ctx }: { w: Wizard; ctx: CodeContext }) {
  const r = w.report;
  if (!r) return <EmptyState icon="sync" title={t('Creating the room…')} />;
  const profile = ctx.profile?.(r.activeProfileId) ?? r.activeProfileId;
  const failed = r.steps.filter((s) => s.status === 'failed');
  return (
    <Stack gap="lg">
      <EmptyState
        icon="checkCircle"
        tone="ok"
        title={t('«{room}» is created', { room: w.name })}
        text={t('The room switched to the profile «{profile}» right away.', { profile })}
      />
      {r.steps.length ? (
        <GuardList
          items={r.steps
            .filter((s) => s.status !== 'skipped')
            .map((s) => {
              const words = stepWords(s, ctx);
              return {
                icon: s.status === 'ok' ? 'check' : s.status === 'failed' ? 'alert' : 'sync',
                title: words.title,
                text: words.text,
                warn: s.status === 'failed',
              };
            })}
        />
      ) : (
        <StatusBanner tone="event" icon="sync" text={t('Waiting for the devices to confirm…')} />
      )}
      {failed.length ? (
        <Row gap="sm" wrap>
          {[...new Map(failed.map((s) => [s.kind, s] as const)).values()].map((s) => (
            <Button key={s.kind} variant="secondary" icon="sync" onClick={() => w.retry(s.kind)} loading={w.retrying === s.kind}>
              {t('Retry: {what}', { what: stepWords({ ...s, status: 'ok' }, ctx).title })}
            </Button>
          ))}
        </Row>
      ) : null}
    </Stack>
  );
}
