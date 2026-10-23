/**
 * Simulator controls (only with the simulator on): the virtual clock, ready-made situations,
 * the weather, windows and device faults — so every screen can be tried without a real house.
 * Nothing here reaches Home Assistant; the last service calls the engine sent are listed below.
 */
import { useEffect, useMemo, useState } from 'react';
import type { DeviceHealth, SimFaultRequest, SimScenarioId, SimStateDto } from '@api/model';
import { api } from '@api/endpoints';
import { useAutosave, useMutation, useResource, useSimClock } from '@data';
import { Button, CheckboxRow, CodeBlock, KeyValueList, Row, Section, SegmentedControl, Select, Skeleton, Stack, Stepper } from '@ui';
import { fmtDateTime, fmtTemp, fmtTime, simScenarioLabel, t } from '@i18n';
import { openTab } from './links';

const SCENARIOS: readonly SimScenarioId[] = ['heating_evening', 'frost_morning', 'blackout_sun', 'shoulder', 'summer'];
const SPEEDS = [1, 10, 60, 600] as const;
type Fault = SimFaultRequest['kind'];

function faultLabel(k: Fault): string {
  switch (k) {
    case 'unavailable':
      return t('Unavailable');
    case 'stale':
      return t('Stops reporting');
    case 'no_ack':
      return t('Ignores commands');
    case 'weak':
      return t('Weak signal');
    case 'battery':
      return t('Battery almost empty');
    case 'knob':
      return t('Turned by hand');
    case 'error_code':
      return t('Reports a fault');
    case 'meter_reset':
      return t('Meter replaced, counts from zero');
    case 'clear':
      return t('Back to normal');
  }
}

function faultsFor(d: DeviceHealth): Fault[] {
  const out: Fault[] = ['unavailable', 'stale'];
  if (d.kind === 'trv') out.push('no_ack', 'knob');
  if (d.transport.type === 'z2m') out.push('weak');
  if (d.power.source === 'battery') out.push('battery');
  if (d.kind === 'source') out.push('error_code', 'no_ack');
  return [...new Set(out)];
}

function Outdoor({ state, onState }: { state: SimStateDto; onState: (s: SimStateDto) => void }) {
  const auto = useAutosave(state.outdoorC, async (tempC) => onState(await api.sim.outdoor(tempC)), { debounceMs: 500 });
  return (
    <Stepper
      variant="square"
      label={t('Outdoors')}
      value={auto.value}
      text={fmtTemp(auto.value)}
      min={-25}
      max={38}
      step={0.5}
      onChange={auto.set}
      ariaDec={t('Colder')}
      ariaInc={t('Warmer')}
    />
  );
}

export function SimulatorSection() {
  const clock = useSimClock(true);
  const state = useResource('sim-state', api.sim.state);
  const devices = useResource('devices', () => api.devices.list(), { reloadOn: ['room', 'sensor', 'source'] });
  const [deviceKey, setDeviceKey] = useState<string>('');
  const [fault, setFault] = useState<Fault>('unavailable');
  const apply = (s: SimStateDto | undefined) => s && state.setData(s);
  const clockRun = useMutation(api.sim.clock, { onSuccess: apply });
  const scenario = useMutation(api.sim.scenario, { onSuccess: apply, okToast: t('Situation loaded') });
  const afterChange = (next: SimStateDto | undefined) => {
    apply(next);
    void devices.reload();
  };
  const faultRun = useMutation(api.sim.fault, { onSuccess: afterChange, okToast: t('Applied') });
  const windowRun = useMutation(api.sim.window, { onSuccess: afterChange });
  // the outbox fills as the engine works; keep it fresh while the panel is open
  const { reload } = state;
  useEffect(() => {
    const id = window.setInterval(() => void reload(), 10_000);
    return () => window.clearInterval(id);
  }, [reload]);

  const list = useMemo(() => [...(devices.data?.devices ?? [])].sort((a, b) => a.name.localeCompare(b.name)), [devices.data]);
  const windows = list.filter((d) => d.kind === 'window');
  const device = list.find((d) => d.key === deviceKey) ?? list[0];
  const faults = device ? faultsFor(device) : [];
  const s = state.data;
  const speed = clock?.speed ?? s?.speed ?? 1;
  const paused = clock?.paused ?? s?.paused ?? false;
  const now = clock ? clock.now + (paused ? 0 : (Date.now() - clock.receivedAt) * speed) : (s?.now ?? null);

  return (
    <Section id="simulator" title={t('Simulator')} icon="sparkle" accent="emphasis" subtitle={t('A virtual house: nothing real is switched.')}>
      {!s ? (
        <Skeleton height={260} radius={12} />
      ) : (
        <Stack gap="lg">
          <KeyValueList
            rows={[
              { key: t('Simulated time'), value: now ? fmtDateTime(now) : '—' },
              { key: t('Situation'), value: simScenarioLabel(clock?.scenario ?? s.scenario) },
            ]}
          />
          <Row gap="sm" wrap align="center">
            <SegmentedControl<number>
              ariaLabel={t('Clock speed')}
              value={speed}
              options={SPEEDS.map((v) => ({ value: v, label: `${v}×` }))}
              onChange={(v) => void clockRun.run({ speed: v })}
            />
            <Button variant="secondary" size="sm" icon={paused ? 'play' : 'pause'} onClick={() => void clockRun.run({ paused: !paused })}>
              {paused ? t('Resume') : t('Pause')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => now && void clockRun.run({ jumpTo: now + 3_600_000 })}>
              {t('+1 hour')}
            </Button>
          </Row>
          <Select<SimScenarioId>
            label={t('Situation')}
            ariaLabel={t('Situation')}
            value={clock?.scenario ?? s.scenario}
            fullWidth
            options={SCENARIOS.map((id) => ({ value: id, label: simScenarioLabel(id) }))}
            onChange={(id) => void scenario.run(id)}
          />
          <Outdoor state={s} onState={(next) => state.setData(next)} />
          {windows.length ? (
            <Section title={t('Windows')} variant="plain" level={3}>
              <Stack gap="2xs">
                {windows.map((w) => (
                  <CheckboxRow
                    key={w.key}
                    checked={w.state.code === 'dev.contact_open'}
                    title={w.roomId ? `${w.name} · ${w.usage.find((u) => u.type === 'room')?.label ?? ''}` : w.name}
                    hint={w.primaryEntityId}
                    disabled={windowRun.pending}
                    onChange={(open) => void windowRun.run(w.primaryEntityId, open)}
                  />
                ))}
              </Stack>
            </Section>
          ) : null}
          {device ? (
            <Section title={t('Device faults')} variant="plain" level={3}>
              <Stack gap="sm">
                <Select<string>
                  ariaLabel={t('Device')}
                  value={device.key}
                  fullWidth
                  options={list.map((d) => ({ value: d.key, label: `${d.name} · ${d.primaryEntityId}` }))}
                  onChange={(k) => {
                    setDeviceKey(k);
                    setFault('unavailable');
                  }}
                />
                <Row gap="sm" wrap>
                  <Select<Fault>
                    ariaLabel={t('Fault to simulate')}
                    size="sm"
                    value={faults.includes(fault) ? fault : faults[0]}
                    options={faults.map((f) => ({ value: f, label: faultLabel(f) }))}
                    onChange={setFault}
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={faultRun.pending}
                    onClick={() => void faultRun.run({ entityId: device.primaryEntityId, kind: faults.includes(fault) ? fault : faults[0] })}
                  >
                    {t('Apply')}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => void faultRun.run({ entityId: device.primaryEntityId, kind: 'clear' })}>
                    {faultLabel('clear')}
                  </Button>
                </Row>
              </Stack>
            </Section>
          ) : null}
          <Section
            title={t('Sent to the virtual house')}
            variant="plain"
            level={3}
            action={
              <Button variant="link" size="sm" iconRight="external" onClick={() => openTab(api.sim.cardsUrl({ layout: 'tablet' }))}>
                {t('Dashboard cards')}
              </Button>
            }
          >
            <CodeBlock
              ariaLabel={t('Last service calls')}
              code={
                s.outbox.length
                  ? s.outbox
                      .slice(-8)
                      .reverse()
                      .map((o) => `${fmtTime(o.at)}  ${o.domain}.${o.service}  ${JSON.stringify(o.data)}`)
                      .join('\n')
                  : t('Nothing sent yet.')
              }
            />
          </Section>
        </Stack>
      )}
    </Section>
  );
}
