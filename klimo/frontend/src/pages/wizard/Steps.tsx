import { useState } from 'react';
import type { AggregationMethod, DiscoveryCandidate, ProfileDto, TrvStrategy, WindowReaction, WizardDeviceRole } from '@api/model';
import { AGGREGATION_METHODS, TRV_STRATEGIES } from '@api/model';
import { useEntitySearch } from '@data';
import {
  AreaSelect,
  AutoGrid,
  Button,
  CheckboxRow,
  DashedAddButton,
  Dialog,
  EmptyState,
  EntityPicker,
  FallbackNote,
  GuardList,
  KeyValueList,
  ProfileTile,
  RadioCardList,
  RadioValueGrid,
  Row,
  Section,
  Select,
  Stack,
  StatusBanner,
  Stepper,
  TextField,
  ToggleCard,
  type IconName,
} from '@ui';
import { aggregationHint, aggregationLabel, fmtDelta, fmtTemp, t, wizardDeviceRoleLabel, type CodeContext } from '@i18n';
import { candidateMeta, candidateValue, integrationName, ROLE_PRESET, stepWords, wizardIssue } from './texts';
import { ROLE_NEEDS, type EmitterChoice, type Wizard } from './useWizard';

const KINDS: { value: EmitterChoice; icon: IconName; title: () => string; hint: () => string }[] = [
  { value: 'trv', icon: 'radiator', title: () => t('Radiators with valves'), hint: () => t('radiator circuit · from the heat pump or the boiler') },
  { value: 'floor', icon: 'floor', title: () => t('Underfloor heating'), hint: () => t('floor circuit · its own pump') },
  { value: 'ac', icon: 'ac', title: () => t('Air conditioner'), hint: () => t('cold in summer, top-up heat in winter') },
  { value: 'local', icon: 'convector', title: () => t('Own heater'), hint: () => t('a convector, an infrared panel or anything from Home Assistant') },
];

function Issues({ w, paths }: { w: Wizard; paths?: (path: string) => boolean }) {
  const list = w.issues.filter((i) => (paths ? paths(i.path) : true));
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
        error={nameIssue ? wizardIssue(nameIssue, w.request) : undefined}
      />
      <AreaSelect label={t('Home Assistant area')} value={w.areaId} areas={w.areas} onChange={w.setArea} noneLabel={t('No area')} />
      <Section variant="plain" level={3} title={t('What heats or cools the room')}>
        <Stack gap="sm">
          {KINDS.map((k) => (
            <ToggleCard
              key={k.value}
              pressed={w.kinds.includes(k.value)}
              icon={k.icon}
              title={k.title()}
              hint={k.hint()}
              onToggle={() => w.toggleKind(k.value)}
            />
          ))}
        </Stack>
      </Section>
      <CheckboxRow
        variant="well"
        checked={w.demand === 'call'}
        title={t('Can start the sources')}
        hint={t('the heat pump, the boiler — switch off for rarely used rooms')}
        onChange={(on) => w.setDemand(on ? 'call' : 'piggyback')}
      />
      <Issues w={w} paths={(p) => p !== 'name'} />
    </Stack>
  );
}

/* ------------------------------------ step 2 ------------------------------------ */

interface Group {
  key: string;
  roles: WizardDeviceRole[];
  title: string;
  hint: string;
  need?: EmitterChoice;
  /** Shown (with a hint) even when nothing was found. */
  essential: boolean;
}

function groups(): Group[] {
  return [
    { key: 'trv', roles: ['trv'], title: t('Radiator valve'), hint: t('controlled'), need: 'trv', essential: true },
    { key: 'temp', roles: ['temp_humidity', 'temperature', 'humidity'], title: t('Temperature and humidity'), hint: t('for the calculation'), essential: true },
    { key: 'window', roles: ['window', 'door'], title: t('Window'), hint: t('optional'), essential: false },
    { key: 'ac', roles: ['ac'], title: t('Air conditioner'), hint: t('cold and top-up heat'), need: 'ac', essential: true },
    { key: 'heater', roles: ['heater'], title: t('Heater'), hint: t('a relay or a plug'), need: 'local', essential: true },
    {
      key: 'floor',
      roles: ['floor_zone', 'floor_probe'],
      title: t('Underfloor heating'),
      hint: t('a zone valve and a floor probe'),
      need: 'floor',
      essential: false,
    },
    { key: 'dehum', roles: ['dehumidifier'], title: t('Dehumidifier'), hint: t('optional'), essential: false },
  ];
}

function AddDeviceDialog({ w, open, onClose, roomId }: { w: Wizard; open: boolean; onClose: () => void; roomId?: string }) {
  const roles = (Object.keys(ROLE_PRESET) as WizardDeviceRole[]).filter((r) => {
    const need = ROLE_NEEDS[r];
    return !need || w.kinds.includes(need);
  });
  const [role, setRole] = useState<WizardDeviceRole>('temp_humidity');
  const [entity, setEntity] = useState<{ id: string; name: string } | null>(null);
  const search = useEntitySearch(ROLE_PRESET[role], { roomId });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('Find another device')}
      actions={[
        { label: t('Cancel'), onClick: onClose },
        {
          label: t('Add'),
          disabled: !entity,
          onClick: () => {
            if (!entity) return;
            w.addExtra({ role, entityId: entity.id, name: entity.name });
            setEntity(null);
            onClose();
          },
        },
      ]}
    >
      <Stack gap="md">
        <Select
          label={t('What it is')}
          value={role}
          options={roles.map((r) => ({ value: r, label: wizardDeviceRoleLabel(r) }))}
          onChange={(r) => {
            setRole(r);
            setEntity(null);
          }}
          ariaLabel={t('What it is')}
        />
        <EntityPicker
          value={entity?.id ?? null}
          onChange={(id, e) => setEntity(id ? { id, name: e?.name ?? id } : null)}
          search={search}
          placeholder={t('Search by name or entity id')}
          clearable
        />
      </Stack>
    </Dialog>
  );
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

export function StepDevices({ w, ctx }: { w: Wizard; ctx: CodeContext }) {
  const [adding, setAdding] = useState(false);
  const roomName = (id: string) => ctx.room?.(id) ?? id;
  const shown = groups().filter((g) => !g.need || w.kinds.includes(g.need));
  const found = w.candidates.length;
  // found in the area, but for a kind of heating that is not ticked on step 1
  const elsewhere = w.candidates.filter((c) => !shown.some((g) => g.roles.includes(c.role)));
  const banner = !w.areaId ? (
    <StatusBanner tone="event" text={t('No area chosen — pick the devices by hand below.')} />
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
    <StatusBanner tone="warn" text={t('Nothing found in «{area}» — pick the devices by hand below.', { area: w.areaName ?? '' })} />
  );
  return (
    <Stack gap="lg">
      {banner}
      {shown.map((g) => {
        const cands = w.candidates.filter((c) => g.roles.includes(c.role));
        const extras = w.extras.filter((x) => g.roles.includes(x.role));
        if (!cands.length && !extras.length && !g.essential && g.key !== 'floor') return null;
        return (
          <Section key={g.key} variant="plain" level={3} title={g.title} tag={g.hint}>
            <Stack gap="xs">
              {cands.map((c: DiscoveryCandidate) => (
                <CheckboxRow
                  key={c.entityId}
                  variant="well"
                  checked={w.picked(c)}
                  title={c.name}
                  hint={candidateMeta(c, roomName)}
                  trailing={candidateValue(c)}
                  onChange={() => w.togglePick(c)}
                />
              ))}
              {extras.map((x) => (
                <CheckboxRow key={x.entityId} variant="well" checked title={x.name} hint={x.entityId} onChange={() => w.removeExtra(x.entityId)} />
              ))}
              {!cands.length && !extras.length && g.key !== 'floor' ? (
                <FallbackNote icon="search" text={t('Nothing found — use «Find another device».')} />
              ) : null}
              {g.key === 'floor' ? <FloorCircuit w={w} /> : null}
            </Stack>
          </Section>
        );
      })}
      {elsewhere.length ? (
        <FallbackNote
          icon="info"
          text={t('Also found: {names} — they fit what is not chosen on the first step.', { names: elsewhere.map((c) => c.name).join(', ') })}
        />
      ) : null}
      <DashedAddButton label={t('+ Find another device')} onClick={() => setAdding(true)} />
      <Issues w={w} />
      <AddDeviceDialog w={w} open={adding} onClose={() => setAdding(false)} />
    </Stack>
  );
}

/* ------------------------------------ step 3 ------------------------------------ */

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
      <Section
        variant="well"
        level={3}
        title={t('Tolerance')}
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
      <Section variant="plain" level={3} title={t('When a window is open')}>
        <RadioCardList<WindowReaction> value={w.reaction} compact options={reactions} onChange={w.setReaction} ariaLabel={t('When a window is open')} />
      </Section>
      {hasTrv ? (
        <Section variant="plain" level={3} title={t('How the valves are controlled')}>
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
  const temps = w.request.devices.filter((d) => d.role === 'temperature' || d.role === 'temp_humidity').length;
  const value = w.methodValues?.[w.method] ?? null;
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
          {
            key: t('Current temperature'),
            value: temps
              ? t('{method} of {count} · now {t}', { method: aggregationLabel(w.method).toLowerCase(), count: temps, t: fmtTemp(value) })
              : t('from the radiator valves'),
            action: change(3),
          },
          { key: t('Tolerance'), value: `−${fmtDelta(w.heatTol.below)} / +${fmtDelta(w.heatTol.above)}`, action: change(3) },
          { key: t('Window open'), value: reaction, action: change(3) },
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
