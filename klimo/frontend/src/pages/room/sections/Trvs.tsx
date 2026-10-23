import type { EmitterDevice, IconName, TrvActivity, TrvCapabilities, TrvManualPolicy, TrvStrategy } from '@api/model';
import { TRV_STRATEGIES } from '@api/model';
import { api } from '@api/endpoints';
import { useAutosave, useMutation } from '@data';
import { Button, CheckboxRow, FallbackNote, RadioCardList, Row, Section, SegmentedControl, Stack, TrvCard, type Tone } from '@ui';
import { brand } from '@brand';
import { paths } from '@app';
import { fmtAgo, fmtDelta, fmtPct, fmtTemp, fmtUntil, t, trvActivityLabel, trvManualPolicyLabel, trvStrategiesHint } from '@i18n';
import { AddEntityDialog } from '../AddEntityDialog';
import { closeDialog, openDialog, useOpenDialog } from '../dialogs';
import { deltaToRoom, lqiWord, trvSyncChip } from '../texts';
import type { SectionDef, SectionProps } from './types';

const ACTIVITY_TONE: Record<TrvActivity, Tone> = {
  heating: 'heat',
  idle: 'hold',
  closed: 'hold',
  off: 'off',
  frost: 'off',
  safe_mode: 'warn',
  exercise: 'event',
  offline: 'err',
};

function trvsOf(p: SectionProps): EmitterDevice[] {
  return p.room.emitters.flatMap((e) => e.devices.filter((d) => d.kind === 'trv')).sort((a, b) => a.order - b.order);
}

function supports(strategy: TrvStrategy, c: TrvCapabilities | null): boolean {
  if (!c) return strategy === 'onoff';
  switch (strategy) {
    case 'external':
      return c.externalSensor;
    case 'calibration':
      return c.calibration;
    case 'valve':
      return c.valvePosition || c.valveLimits;
    case 'onoff':
      return true;
  }
}

const TECH: Record<TrvStrategy, string> = {
  external: 'external_temperature_input + temperature_sensor_select',
  calibration: 'local_temperature_calibration',
  onoff: 'occupied_heating_setpoint',
  valve: 'valve_opening_degree',
};

function strategyText(s: TrvStrategy, roomTemp: string): { title: string; hint: string } {
  const product = brand.productName;
  switch (s) {
    case 'external':
      return {
        title: t('Room temperature → into the valve'),
        hint: t('{product} sends the calculated {t}; the valve opens by itself. The smoothest.', { product, t: roomTemp }),
      };
    case 'calibration':
      return {
        title: t('Dynamic offset'),
        hint: t('The offset is adjusted so the valve “sees” the room temperature. For valves without an external sensor input.'),
      };
    case 'onoff':
      return {
        title: t('On / off'),
        hint: t('{product} decides by the tolerance and sets 30° or 5°. Works with any valve, but the swings are larger.', { product }),
      };
    case 'valve':
      return {
        title: t('Valve opening, %'),
        hint: t('{product} sets how far the valve opens. The most precise, but more commands drain the battery faster.', { product }),
      };
  }
}

function transportText(p: SectionProps, d: EmitterDevice): string {
  switch (d.transport.type) {
    case 'z2m':
      return p.ctx.instance?.(d.transport.instanceId) ?? 'Zigbee2MQTT';
    case 'zha':
      return 'ZHA';
    case 'ha':
      return d.transport.integration ?? 'Home Assistant';
  }
}

function Body(p: SectionProps) {
  const { room, state } = p;
  const id = room.config.id;
  const trv = useAutosave(room.config.trv, (v) => p.save({ trv: v }));
  const devices = trvsOf(p);
  const radiator = room.emitters.find((e) => e.kind === 'radiator' || e.kind === 'towel_rail');
  const dialog = useOpenDialog();
  const resync = useMutation(() => api.rooms.resyncTrvs(id), { okToast: t('The targets were sent to the valves again.') });
  const resend = useMutation((deviceId: string) => api.rooms.devices.resend(id, deviceId), { okToast: t('The target was sent to the valve again.') });
  const add = useMutation(
    (entityId: string, name: string) => api.rooms.devices.add(id, radiator?.id ?? '', { kind: 'trv', entityId, name: name || undefined }),
    {
      onSuccess: (r) => {
        p.setRoom(r);
        closeDialog();
      },
    },
  );
  const builtin = useMutation((on: boolean) => p.save({ windows: { ...room.config.windows, disableTrvBuiltinDetection: on } }));
  const v = trv.value;
  const roomTemp = fmtTemp(state.tempC);

  const options = TRV_STRATEGIES.map((s) => {
    const lacking = devices.find((d) => !supports(s, d.capabilities));
    const text = strategyText(s, roomTemp);
    return {
      value: s,
      title: text.title,
      hint: p.phone ? undefined : text.hint,
      tech: p.phone ? undefined : TECH[s],
      badge: s === 'external' ? t('recommended') : undefined,
      disabled: Boolean(lacking) || !p.canEdit,
      disabledReason: lacking ? t('«{device}» cannot do this', { device: lacking.name }) : undefined,
    };
  });
  const policyHint = (x: TrvManualPolicy) =>
    x === 'slot'
      ? t('A change by hand lasts {until}, then the schedule again.', { until: fmtUntil(room.thermostat.untils.slot ?? null) })
      : x === 'revert'
        ? t('{product} restores its target after a minute and shows who changed what.', { product: brand.productName })
        : t('The new value becomes the target of {room} in the current profile.', { room: room.config.name });

  return (
    <Stack gap="lg">
      {devices.length ? (
        <Stack gap="sm">
          {devices.map((d) => {
            const s = state.trvs.find((x) => x.deviceId === d.id);
            const chips: { tone: Tone; label: string; icon?: IconName }[] = [];
            if (s) {
              chips.push({ tone: ACTIVITY_TONE[s.activity], label: trvActivityLabel(s.activity).toLowerCase() });
              const sync = trvSyncChip(s.sync, s.commandedSetpointC, p.now);
              if (sync) chips.push(sync);
            }
            const caps = d.capabilities;
            // a valve that gave up confirming gets its own retry next to it
            const stuck = s?.sync.status === 'failed' || s?.sync.status === 'backoff';
            return (
              <Stack key={d.id} gap="xs">
                <TrvCard
                  name={d.name}
                  entityId={p.phone ? undefined : d.entityId}
                  meta={[d.model, transportText(p, d)].filter(Boolean).join(' · ')}
                  chips={chips}
                  compact={p.phone}
                  stats={[
                    { label: t('Valve sensor'), value: fmtTemp(s?.localTempC ?? null), sub: p.phone ? undefined : deltaToRoom(s?.deltaToRoomC ?? null) },
                    { label: t('Battery'), value: fmtPct(s?.batteryPct ?? null) },
                    { label: t('Signal'), value: s?.lqi != null ? `LQI ${s.lqi}` : '—', sub: p.phone ? undefined : lqiWord(s?.lqi ?? null) },
                    ...(p.phone ? [] : [{ label: t('Last seen'), value: s?.lastSeenAt != null ? fmtAgo(s.lastSeenAt, p.now) : '—' }]),
                  ]}
                  capabilities={
                    caps
                      ? [
                          { label: t('external sensor'), on: caps.externalSensor },
                          { label: t('offset'), on: caps.calibration },
                          { label: t('valve limits'), on: caps.valveLimits },
                          { label: t('child lock'), on: caps.childLock },
                          { label: t('actual valve opening'), on: caps.valvePosition },
                        ]
                      : []
                  }
                />
                {stuck ? (
                  <Row gap="sm">
                    <Button variant="secondary" size="sm" icon="sync" onClick={() => void resend.run(d.id)} loading={resend.pending}>
                      {t('Resend to «{device}»', { device: d.name })}
                    </Button>
                  </Row>
                ) : null}
              </Stack>
            );
          })}
          {/* replacing or removing a head hands it back first, which «Room and devices» explains */}
          {p.canEdit ? (
            <Row>
              <Button variant="link" size="sm" icon="pencil" to={paths.roomSettings(id, 'setup')}>
                {t('Replace or remove a valve')}
              </Button>
            </Row>
          ) : null}
        </Stack>
      ) : (
        <FallbackNote icon="radiator" text={t('No radiator valves in this room yet.')} />
      )}
      <Stack gap="sm">
        {/* the phone list drops the per-option explanations; the «i» brings them back */}
        <Section
          variant="plain"
          level={3}
          title={t('How {product} controls the valves', { product: brand.productName })}
          hint={p.phone ? trvStrategiesHint(brand.productName) : undefined}
        />
        <RadioCardList<TrvStrategy>
          value={v.strategy}
          options={options}
          onChange={(x) => trv.set((c) => ({ ...c, strategy: x }))}
          ariaLabel={t('How {product} controls the valves', { product: brand.productName })}
        />
      </Stack>
      <Stack gap="sm">
        <Section variant="plain" level={3} title={t('If a valve is turned by hand')} />
        {/* content-sized options wrap instead of cutting the longer labels short */}
        <SegmentedControl<TrvManualPolicy>
          value={v.manualPolicy}
          options={(['slot', 'revert', 'save'] as const).map((x) => ({ value: x, label: trvManualPolicyLabel(x), disabled: v.childLock || !p.canEdit }))}
          onChange={(x) => trv.set((c) => ({ ...c, manualPolicy: x }))}
          ariaLabel={t('If a valve is turned by hand')}
          hint={v.childLock ? t('The child lock is on, so nobody can turn the valves by hand.') : policyHint(v.manualPolicy)}
        />
      </Stack>
      <Stack gap="xs">
        <CheckboxRow
          variant="divided"
          checked={v.childLock}
          disabled={!p.canEdit}
          title={t('Child lock on the valves')}
          hint={t('The buttons on the valve do nothing — the target changes only here.')}
          onChange={(on) => trv.set((c) => ({ ...c, childLock: on }))}
        />
        {p.phone ? null : (
          <CheckboxRow
            variant="divided"
            checked={room.config.windows.disableTrvBuiltinDetection}
            disabled={!p.canEdit || builtin.pending}
            title={t('Switch off the valves’ own “open window” detection')}
            hint={t('Windows are handled here, so a valve does not close on its own from a draught.')}
            onChange={(on) => void builtin.run(on)}
          />
        )}
        <CheckboxRow
          variant="divided"
          checked={v.batterySaver.enabled}
          disabled={!p.canEdit}
          title={t('Save the battery')}
          hint={t('Send the temperature to a valve at most every {min} min and only on a change of {delta} or more.', {
            min: v.batterySaver.minIntervalMin,
            delta: fmtDelta(v.batterySaver.minDeltaC),
          })}
          onChange={(on) => trv.set((c) => ({ ...c, batterySaver: { ...c.batterySaver, enabled: on } }))}
        />
        {p.phone ? null : (
          <>
            <CheckboxRow
              variant="divided"
              checked={v.ack.attempts > 1}
              disabled={!p.canEdit}
              title={t('Repeat unconfirmed commands')}
              hint={t('No answer in {min} min — repeat, up to {n} times, then a notification.', {
                min: Math.round(v.ack.timeoutSec / 60),
                n: Math.max(3, v.ack.attempts),
              })}
              onChange={(on) => trv.set((c) => ({ ...c, ack: { ...c.ack, attempts: on ? 3 : 1 } }))}
            />
            <CheckboxRow
              variant="divided"
              checked={v.resendOnBridgeRestart}
              disabled={!p.canEdit}
              title={t('Resend the targets after Zigbee2MQTT restarts')}
              hint={t('And after the coordinator gets power back.')}
              onChange={(on) => trv.set((c) => ({ ...c, resendOnBridgeRestart: on }))}
            />
          </>
        )}
      </Stack>
      <Row gap="sm" wrap>
        {devices.length ? (
          <Button variant="secondary" icon="sync" onClick={() => void resync.run()} loading={resync.pending}>
            {t('Resend the targets')}
          </Button>
        ) : null}
        {p.phone && p.canEdit && radiator ? (
          <Button variant="secondary" icon="plus" onClick={() => openDialog('add-trv')}>
            {t('Add a valve')}
          </Button>
        ) : null}
      </Row>
      {radiator ? (
        <AddEntityDialog
          open={dialog === 'add-trv'}
          title={t('Add a radiator valve')}
          role="trv"
          roomId={id}
          placeholder={t('Search a radiator valve')}
          onClose={closeDialog}
          onSubmit={(entityId, name) => add.run(entityId, name)}
          errors={add}
        />
      ) : null}
    </Stack>
  );
}

function summary(p: SectionProps): string {
  const devices = trvsOf(p);
  if (!devices.length) return t('no valves');
  const models = [...new Set(devices.map((d) => d.model).filter(Boolean))];
  const model = models.length === 1 ? `${devices.length} × ${models[0]}` : t('{count} valves', { count: devices.length });
  const strategy = strategyText(p.room.config.trv.strategy, '').title;
  const states = p.state.trvs.map((x) => x.sync.status);
  const sync = states.includes('failed')
    ? t('not confirmed')
    : states.some((s) => s === 'sending' || s === 'retrying' || s === 'queued')
      ? t('sending…')
      : t('in sync');
  return [model, strategy.toLowerCase(), sync].join(' · ');
}

export const trvsSection: SectionDef = {
  key: 'trv',
  icon: 'radiator',
  title: (p) => (trvsOf(p).some((d) => d.transport.type === 'z2m') ? t('Radiator valves · Zigbee') : t('Radiator valves')),
  subtitle: (p) =>
    trvsOf(p).some((d) => d.transport.type === 'z2m') ? t('Zigbee via Zigbee2MQTT · commands arrive with a delay, so every target is confirmed') : undefined,
  summary,
  // radiators with ordinary valves have no head to set up here
  hidden: (p) => !trvsOf(p).length && !p.room.heating.kinds.includes('trv'),
  action: (p) =>
    p.canEdit && p.room.emitters.some((e) => e.kind === 'radiator' || e.kind === 'towel_rail') ? (
      <Button variant="secondary" size="sm" icon="plus" onClick={() => openDialog('add-trv')}>
        {t('Add')}
      </Button>
    ) : null,
  Body,
};
