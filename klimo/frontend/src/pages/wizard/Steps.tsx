import { useState } from 'react';
import type { AggregationMethod, ApiErrorIssue, DiscoveryCandidate, HaEntityDto, ProfileDto, TrvStrategy, WindowReaction, WizardDeviceRole } from '@api/model';
import { AGGREGATION_METHODS, TRV_STRATEGIES } from '@api/model';
import { useEntitySearch, useLayout } from '@data';
import {
  AreaSelect,
  AutoGrid,
  Button,
  CheckboxRow,
  DeviceRow,
  EmptyState,
  EntityFinder,
  EntityPicker,
  GuardList,
  IconButton,
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
  type DeviceRowRole,
  type EntityFinderChoice,
} from '@ui';
import { brand } from '@brand';
import { aggregationHint, aggregationLabel, fmtDelta, fmtTemp, integrationName, t, toleranceHint, trvStrategiesHint, type CodeContext } from '@i18n';
import { candidateMeta, candidateValue, extraMeta, resultValue, ROLE_ICON, roleLabel, sectionWords, stepWords, wizardIssue } from './texts';
import { SECTION_ROLES, sectionOf, type ExtraDevice, type SectionKey, type Wizard } from './useWizard';

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
      <CheckboxRow
        variant="well"
        checked={w.demand === 'call'}
        title={t('Can start the sources')}
        hint={t('the heat pump, the boiler — switch off for rarely used rooms')}
        onChange={(on) => w.setDemand(on ? 'call' : 'piggyback')}
      />
      <Text>{t('Next come the devices: what the area holds is offered, anything else is one search away.')}</Text>
      <Issues w={w} only={(i) => i.path !== 'name'} />
    </Stack>
  );
}

/* ------------------------------------ step 2 ------------------------------------ */

const SECTION_ORDER: readonly SectionKey[] = ['trv', 'temp', 'window', 'ac', 'heater', 'floor', 'dehum'];
/** What heats or cools: one of these the room cannot do without. */
const HEAT_KEYS: readonly SectionKey[] = ['trv', 'ac', 'heater', 'floor'];
const CHIP_ORDER: readonly SectionKey[] = [...HEAT_KEYS, 'window', 'dehum'];

/** Where a device-step problem is read: in its block, under the heat chips, or in the list at the end. */
function issueHome(i: ApiErrorIssue): SectionKey | 'heat' | null {
  if (i.path === 'emitterKinds') return 'heat';
  if (i.path.startsWith('circuits')) return 'floor';
  if (i.path === 'devices' && i.code === 'needs_temperature') return 'temp';
  if (i.path === 'devices' && i.code === 'required' && typeof i.params?.role === 'string') return sectionOf(i.params.role as WizardDeviceRole);
  return null;
}

/** What a block's own search looks for. */
const SECTION_SEARCH: Record<SectionKey, WizardDeviceRole> = {
  trv: 'trv',
  temp: 'temperature',
  window: 'window',
  ac: 'ac',
  heater: 'heater',
  floor: 'floor_zone',
  dehum: 'dehumidifier',
};

const choice = (role: WizardDeviceRole): EntityFinderChoice => ({ value: role, label: roleLabel(role), icon: ROLE_ICON[role] });

/** The roles a source's own climate or relay cannot take as well (the server refuses them too). */
const DRIVEN: readonly WizardDeviceRole[] = ['trv', 'ac', 'heater', 'floor_zone'];

/** A result a source already switches: shown, but it cannot become a room's device. */
function sourceBlock(e: HaEntityDto): string | null {
  const source = e.usedBy.find((u) => u.type === 'source');
  if (!source || !(e.wizard?.suggested ?? []).every((r) => DRIVEN.includes(r))) return null;
  return t('the source «{source}» switches it — it cannot be a room device too', { source: source.label });
}

/** The role a result takes in a block: the entity's own likeliest one that fits the block. */
function roleIn(e: HaEntityDto, k: SectionKey): WizardDeviceRole {
  const fits = (r: WizardDeviceRole) => SECTION_ROLES[k].includes(r);
  return e.wizard?.suggested.find(fits) ?? e.wizard?.possible.find(fits) ?? SECTION_SEARCH[k];
}

function FloorCircuit({ w }: { w: Wizard }) {
  const search = useEntitySearch('pump', {});
  const NEW = '__new__';
  return (
    <Section variant="well" level={3} title={t('Floor circuit')} subtitle={t('The pump and its run-on are set on the system page.')}>
      <Stack gap="sm">
        <Select
          value={w.floor.circuitId ?? NEW}
          options={[...w.floorCircuits.map((c) => ({ value: c.id, label: c.name })), { value: NEW, label: t('A new floor circuit') }]}
          onChange={(v) => w.setFloor({ circuitId: v === NEW ? null : v })}
          ariaLabel={t('Floor circuit')}
        />
        {w.floor.circuitId ? null : (
          <>
            <TextField
              label={t('Circuit name')}
              value={w.floor.newName}
              onChange={(v) => w.setFloor({ newName: v })}
              placeholder={t('e.g. «Floor · kitchen»')}
              maxLength={40}
            />
            <EntityPicker
              value={w.floor.pumpEntityId}
              onChange={(id) => w.setFloor({ pumpEntityId: id })}
              search={search}
              placeholder={t('The pump of the circuit')}
              clearable
            />
          </>
        )}
      </Stack>
    </Section>
  );
}

interface SectionProps {
  w: Wizard;
  k: SectionKey;
  cands: DiscoveryCandidate[];
  extras: ExtraDevice[];
  roomName: (id: string) => string;
  rowIssue: (entityId: string, role: WizardDeviceRole) => string | undefined;
  focus: boolean;
}

function DeviceSection({ w, k, cands, extras, roomName, rowIssue, focus }: SectionProps) {
  const words = sectionWords(k);
  const [adding, setAdding] = useState(false);
  const search = useEntitySearch(null, { wizard: SECTION_SEARCH[k], areaId: w.areaId, limit: 20 });
  const empty = !cands.length && !extras.length;
  const devices = w.request.devices;
  const heads = devices.filter((d) => d.role === 'trv');
  const ownOffer = k === 'temp' && heads.length > 0 && !devices.some((d) => d.role === 'temperature' || d.role === 'temp_humidity');

  const roleMenu = (entityId: string, current: WizardDeviceRole, possible: readonly WizardDeviceRole[]): DeviceRowRole => ({
    value: current,
    options: (possible.includes(current) ? possible : [current, ...possible]).map((r) => ({ value: r, label: roleLabel(r) })),
    onChange: (v) => w.setRole(entityId, current, v as WizardDeviceRole),
  });
  // a head's own reading shows what the head reads now
  const headValue = (entityId: string): string | undefined => {
    const c = w.candidates.find((x) => x.entityId === entityId);
    const x = w.extras.find((y) => y.entityId === entityId && !y.ownTemperature);
    const v = c?.valueC ?? x?.valueC ?? null;
    return v != null ? fmtTemp(v) : undefined;
  };

  const action = !empty ? (
    <Button variant="ghost" size="sm" icon={adding ? 'close' : 'plus'} onClick={() => setAdding((a) => !a)}>
      {adding ? t('Close') : t('Add')}
    </Button>
  ) : k !== 'temp' ? (
    <IconButton icon="close" label={t('Remove «{section}»', { section: words.title })} size={36} variant="ghost" onClick={() => w.closeSection(k)} />
  ) : undefined;

  return (
    <Section variant="plain" level={3} title={words.title} tag={words.tag} action={action} inlineAction>
      <Stack gap="xs">
        {cands.map((c) => {
          const used = w.inUse(c);
          const role = w.roleOf(c);
          return (
            <DeviceRow
              key={c.entityId}
              checked={w.picked(c)}
              title={c.name}
              meta={candidateMeta(c, roomName, used)}
              value={candidateValue({ ...c, role })}
              // a source cannot also be a room's own device; a pump can, if the user insists
              disabled={used?.as === 'source' && !w.picked(c)}
              onCheck={() => w.togglePick(c)}
              role={roleMenu(c.entityId, role, c.possibleRoles ?? [c.role])}
              error={w.picked(c) ? rowIssue(c.entityId, role) : undefined}
            />
          );
        })}
        {extras.map((x) => (
          <DeviceRow
            key={`${x.role}|${x.entityId}`}
            title={x.name}
            meta={extraMeta(x)}
            value={x.ownTemperature ? headValue(x.entityId) : x.valueC != null ? fmtTemp(x.valueC) : candidateValue({ role: x.role, state: x.state, valueC: null })}
            role={x.ownTemperature ? undefined : roleMenu(x.entityId, x.role, x.roles)}
            onRemove={() => w.removeExtra(x.entityId, x.role)}
            error={rowIssue(x.entityId, x.role)}
          />
        ))}
        {empty && !ownOffer ? <Text variant="caption">{words.hint}</Text> : null}
        {ownOffer ? (
          // the quickest way for a room with only a thermostat; the search below stays the better one
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
        {empty || adding ? (
          <EntityFinder
            search={search}
            choices={(e) => [choice(roleIn(e, k))]}
            blocked={sourceBlock}
            onPick={(e, role) => {
              w.addDevice(e, role as WizardDeviceRole);
              setAdding(false);
            }}
            placeholder={words.find}
            valueText={resultValue}
            autoFocus={focus || adding}
          />
        ) : null}
        {k === 'floor' ? <FloorCircuit w={w} /> : null}
        <Issues w={w} only={(i) => issueHome(i) === k} />
      </Stack>
    </Section>
  );
}

export function StepDevices({ w, ctx }: { w: Wizard; ctx: CodeContext }) {
  const [focusKey, setFocusKey] = useState<SectionKey | null>(null);
  const search = useEntitySearch(null, { wizard: 'any', areaId: w.areaId, limit: 30 });
  // ready to type on a computer; a phone would throw its keyboard over the list
  const typeAway = useLayout() !== 'phone';
  const roomName = (id: string) => ctx.room?.(id) ?? id;
  const devices = w.request.devices;
  const found = w.candidates.length;

  const rowIssue = (entityId: string, role: WizardDeviceRole) => {
    const i = devices.findIndex((d) => d.entityId === entityId && d.role === role);
    const issue = i < 0 ? undefined : w.issues.find((x) => x.path === `devices.${i}` || x.path.startsWith(`devices.${i}.`));
    return issue ? wizardIssue(issue, w.request) : undefined;
  };
  const blocked = (e: HaEntityDto) => sourceBlock(e);
  const added = (e: HaEntityDto) => {
    const roles = devices.filter((d) => d.entityId === e.entityId).map((d) => roleLabel(d.role));
    return roles.length ? t('added as {role}', { role: roles.join(', ') }) : null;
  };

  const sections = SECTION_ORDER.map((k) => {
    const cands = w.candidates.filter((c) => SECTION_ROLES[k].includes(w.roleOf(c)));
    const extras = w.extras.filter((x) => SECTION_ROLES[k].includes(x.role));
    return { k, cands, extras, shown: k === 'temp' || cands.length > 0 || extras.length > 0 || w.opened.includes(k) };
  });
  const hidden = CHIP_ORDER.map((k) => sections.find((s) => s.k === k && !s.shown)).filter((s) => s !== undefined);
  // until something heats or cools, those chips are the question of the step, not extras
  const asksHeat = !w.kinds.length && hidden.some((s) => HEAT_KEYS.includes(s.k));
  const extraChips = asksHeat ? hidden.filter((s) => !HEAT_KEYS.includes(s.k)) : hidden;
  const shownKeys = new Set(sections.filter((s) => s.shown).map((s) => s.k));
  const placed = (i: ApiErrorIssue) => {
    const home = issueHome(i);
    return home === 'heat' ? asksHeat : home !== null && shownKeys.has(home);
  };
  const chip = (k: SectionKey) => (
    <QuickActionPill
      key={k}
      icon="plus"
      label={sectionWords(k).chip}
      onClick={() => {
        setFocusKey(k);
        w.openSection(k);
      }}
    />
  );

  const banner = !w.areaId ? null : w.discovering ? (
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
    <StatusBanner tone="event" text={t('Nothing found in «{area}» — find the devices with the search.', { area: w.areaName ?? '' })} />
  );

  return (
    <Stack gap="lg">
      <EntityFinder
        search={search}
        choices={(e) => (e.wizard?.suggested ?? []).map(choice)}
        onPick={(e, role) => w.addDevice(e, role as WizardDeviceRole)}
        placeholder={t('Add a device — name or entity id')}
        ariaLabel={t('Add a device')}
        valueText={resultValue}
        note={added}
        blocked={blocked}
        autoFocus={typeAway && !focusKey}
        help={
          w.areaName
            ? t('Searches all of Home Assistant; what is in «{area}» comes first.', { area: w.areaName })
            : t('Searches all of Home Assistant: thermostats, valves, sensors, plugs.')
        }
      />
      {banner}
      {sections
        .filter((s) => s.shown)
        .map((s) => (
          <DeviceSection key={s.k} w={w} k={s.k} cands={s.cands} extras={s.extras} roomName={roomName} rowIssue={rowIssue} focus={focusKey === s.k} />
        ))}
      {asksHeat ? (
        <Section variant="plain" level={3} title={t('What heats or cools the room?')}>
          <Stack gap="sm">
            <Row gap="sm" wrap>
              {hidden.filter((s) => HEAT_KEYS.includes(s.k)).map((s) => chip(s.k))}
            </Row>
            <Issues w={w} only={(i) => issueHome(i) === 'heat'} />
          </Stack>
        </Section>
      ) : null}
      {extraChips.length ? (
        <Section variant="plain" level={3} title={t('Also in this room?')}>
          <Row gap="sm" wrap>
            {extraChips.map((s) => chip(s.k))}
          </Row>
        </Section>
      ) : null}
      <Issues w={w} only={(i) => !placed(i) && (!/^devices\.\d+/.test(i.path) || rowIssueHidden(w, i.path))} />
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
  if (n(['temperature', 'temp_humidity'])) parts.push(t('{count} sensors', { count: n(['temperature', 'temp_humidity']) }));
  if (n(['window', 'door'])) parts.push(t('{count} windows', { count: n(['window', 'door']) }));
  if (n(['ac'])) parts.push(t('air conditioner'));
  if (n(['heater'])) parts.push(t('heater'));
  if (w.kinds.includes('floor')) parts.push(t('underfloor heating'));
  if (n(['dehumidifier'])) parts.push(t('dehumidifier'));
  return parts.join(' · ') || t('no devices');
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
