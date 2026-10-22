/**
 * «Захисти системи»: what always holds, whatever the mode — frost and overheat protection,
 * failover when a source does not answer, re-sync after a restart, relay watchdogs and the
 * weekly pump run. The numbers come from the safety settings and can be changed here.
 */
import { useState } from 'react';
import type { Dow, SafetySettings, SafetySettingsPatch } from '@api/model';
import { api } from '@api/endpoints';
import { useMutation } from '@data';
import { brand } from '@brand';
import { Button, CheckboxRow, Drawer, GuardList, Row, Section, Select, Stack, Stepper, TimeStepper } from '@ui';
import { fmtDur, fmtTemp, hhmmToMinute, minuteToHhmm, t, weekdayLong } from '@i18n';
import type { SystemData } from './shared';

export function GuardsSection({ d }: { d: SystemData }) {
  const [open, setOpen] = useState(false);
  const s = d.settings.data?.safety ?? null;
  if (!s) return <Section title={t('System protections')} />;
  const product = brand.productName;
  const items = [
    {
      icon: 'shield' as const,
      title: t('Frost protection — {t}', { t: fmtTemp(s.frostC, { decimals: 0 }) }),
      text: t('Works in every mode. Heats with the first available source, even one that otherwise runs «by trigger».'),
    },
    {
      icon: 'swap' as const,
      title: t('A source does not answer — the next one'),
      text: t('No confirmation of running within {dur} or the entity is unavailable — takes the next one in the chain and notifies.', {
        dur: fmtDur(s.sourceConfirmDefaultMin),
      }),
    },
    {
      icon: 'thermometer' as const,
      title: t('Overheat protection — {t}', { t: fmtTemp(s.overheatC, { decimals: 0 }) }),
      text: t('The room closes its valves and switches off its local sources, even with a manual target.'),
    },
    {
      icon: 'sync' as const,
      title: t('After a Home Assistant or Zigbee2MQTT restart'),
      text: s.reconcileOnRestart
        ? t('Checks the state of sources and pumps and sends the targets to the valves again.')
        : t('Switched off — nothing is checked again after a restart.'),
      warn: !s.reconcileOnRestart,
    },
    {
      icon: 'clock' as const,
      title: t('Relay watchdog'),
      text: t('Relays with a device timer switch off by themselves after {dur} if {product} stops renewing the command.', {
        dur: fmtDur(s.relayWatchdogMin),
        product,
      }),
    },
    {
      icon: 'pumps' as const,
      title: t('Pump anti-seize run'),
      text: s.pumpExercise.enabled
        ? t('Every {day} at {time} every pump runs for {dur}.', {
            day: weekdayLong(s.pumpExercise.dow).toLowerCase(),
            time: s.pumpExercise.time,
            dur: fmtDur(s.pumpExercise.durationSec / 60),
          })
        : t('Switched off — pumps may seize over the summer.'),
      warn: !s.pumpExercise.enabled,
    },
  ];
  return (
    <Section
      id="guards"
      title={t('System protections')}
      action={
        d.canEdit ? (
          <Button variant="ghost" size="sm" icon="pencil" onClick={() => setOpen(true)}>
            {t('Change')}
          </Button>
        ) : undefined
      }
    >
      <GuardList items={items} />
      {open ? <SafetyDrawer d={d} safety={s} onClose={() => setOpen(false)} /> : null}
    </Section>
  );
}

function SafetyDrawer({ d, safety, onClose }: { d: SystemData; safety: SafetySettings; onClose: () => void }) {
  const [draft, setDraft] = useState<SafetySettings>(safety);
  const set = (p: Partial<SafetySettings>) => setDraft((x) => ({ ...x, ...p }));
  const save = useMutation(
    () => {
      const { updatedAt: _u, ...rest } = draft;
      const patch: SafetySettingsPatch = rest;
      return api.settings.patchSafety(patch);
    },
    {
      onSuccess: (bundle) => {
        d.settings.setData(bundle);
        onClose();
      },
      okToast: t('Protections saved'),
    },
  );
  const ex = draft.pumpExercise;
  return (
    <Drawer
      open
      onClose={onClose}
      title={t('System protections')}
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
        <Stepper
          variant="compact"
          label={t('Frost protection')}
          sub={t('below this every room heats, in any mode')}
          value={draft.frostC}
          text={fmtTemp(draft.frostC, { decimals: 0 })}
          min={5}
          max={10}
          step={1}
          onChange={(frostC) => set({ frostC, frostReleaseC: frostC + 1 })}
          ariaDec={t('Lower')}
          ariaInc={t('Higher')}
        />
        <Stepper
          variant="compact"
          label={t('Overheat protection')}
          sub={t('above this a room closes its valves')}
          value={draft.overheatC}
          text={fmtTemp(draft.overheatC, { decimals: 0 })}
          min={24}
          max={32}
          step={1}
          onChange={(overheatC) => set({ overheatC, overheatReleaseC: overheatC - 0.5 })}
          ariaDec={t('Lower')}
          ariaInc={t('Higher')}
        />
        <Stepper
          variant="compact"
          label={t('A source must confirm it runs within')}
          sub={t('default for new sources; each source can have its own')}
          value={draft.sourceConfirmDefaultMin}
          text={fmtDur(draft.sourceConfirmDefaultMin)}
          min={2}
          max={15}
          step={1}
          onChange={(sourceConfirmDefaultMin) => set({ sourceConfirmDefaultMin })}
          ariaDec={t('Shorter')}
          ariaInc={t('Longer')}
        />
        <Stepper
          variant="compact"
          label={t('Relay watchdog')}
          sub={t('the device switches the relay off when it is not renewed')}
          value={draft.relayWatchdogMin}
          text={fmtDur(draft.relayWatchdogMin)}
          min={5}
          max={30}
          step={1}
          onChange={(relayWatchdogMin) => set({ relayWatchdogMin, relayRearmEveryMin: Math.min(draft.relayRearmEveryMin, Math.floor(relayWatchdogMin / 3)) })}
          ariaDec={t('Shorter')}
          ariaInc={t('Longer')}
        />
        <CheckboxRow
          checked={draft.reconcileOnRestart}
          title={t('Check everything after a restart')}
          hint={t('After Home Assistant or Zigbee2MQTT restarts: read every source and pump back and send the valves their targets again.')}
          onChange={(reconcileOnRestart) => set({ reconcileOnRestart })}
        />
        <CheckboxRow checked={ex.enabled} title={t('Weekly pump anti-seize run')} onChange={(enabled) => set({ pumpExercise: { ...ex, enabled } })} />
        {ex.enabled ? (
          <Stack gap="md">
            <Select<Dow>
              label={t('Day')}
              ariaLabel={t('Day of the anti-seize run')}
              value={ex.dow}
              options={([0, 1, 2, 3, 4, 5, 6] as Dow[]).map((x) => ({ value: x, label: weekdayLong(x) }))}
              onChange={(dow) => set({ pumpExercise: { ...ex, dow } })}
            />
            <TimeStepper
              label={t('Time')}
              value={hhmmToMinute(ex.time)}
              text={ex.time}
              min={0}
              max={1410}
              step={30}
              onChange={(m) => set({ pumpExercise: { ...ex, time: minuteToHhmm(m) } })}
              ariaEarlier={t('30 min earlier')}
              ariaLater={t('30 min later')}
            />
          </Stack>
        ) : null}
      </Stack>
    </Drawer>
  );
}
