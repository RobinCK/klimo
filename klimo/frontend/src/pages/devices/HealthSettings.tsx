/**
 * «Сповіщати, коли»: the device-health thresholds. The same records drive the room screen's
 * battery and offline notes and the notification watch list, so they are edited in one place.
 */
import type { DeviceHealthSettings } from '@api/model';
import { api } from '@api/endpoints';
import { useAutosave } from '@data';
import { paths } from '@app';
import { AutosaveStatus, CheckboxRow, Link, Section, Stack, ValuePill } from '@ui';
import { fmtDur, t } from '@i18n';

type Health = Omit<DeviceHealthSettings, 'updatedAt'>;

interface NumPillProps {
  text: string;
  ariaLabel: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (v: number) => void;
  canEdit: boolean;
}

/** A threshold as a pill; only people who may change the configuration get the stepper. */
export function NumPill({ text, ariaLabel, value, min, max, step, unit, onChange, canEdit }: NumPillProps) {
  if (!canEdit) return <ValuePill text={text} ariaLabel={ariaLabel} />;
  return <ValuePill text={text} ariaLabel={ariaLabel} editor={{ kind: 'number', min, max, step, unit }} value={value} onChange={onChange} />;
}

function strip(h: DeviceHealthSettings): Health {
  const { updatedAt: _ignored, ...rest } = h;
  return rest;
}

export function HealthSettings({ health, onSaved, canEdit }: { health: DeviceHealthSettings; onSaved: (h: DeviceHealthSettings) => void; canEdit: boolean }) {
  const auto = useAutosave<Health>(strip(health), async (next) => onSaved(await api.settings.patchDeviceHealth(next)));
  const v = auto.value;
  const set = (patch: Partial<Health>) => auto.set((prev) => ({ ...prev, ...patch }));

  return (
    <Section title={t('Notify me when')} level={2} action={<AutosaveStatus state={auto.state} retry={auto.retry} />}>
      <Stack gap="xs">
        <CheckboxRow
          checked={v.batteryLow.enabled}
          title={t('Battery below')}
          hint={t('Reminds once more at {pct}%', { pct: v.batteryLow.reminderPct })}
          disabled={!canEdit}
          onChange={(enabled) => set({ batteryLow: { ...v.batteryLow, enabled } })}
          trailing={
            <NumPill
              canEdit={canEdit}
              text={`${v.batteryLow.pct}%`}
              ariaLabel={t('Battery below')}
              min={5}
              max={50}
              step={5}
              unit="%"
              value={v.batteryLow.pct}
              onChange={(pct) => set({ batteryLow: { ...v.batteryLow, pct } })}
            />
          }
        />
        <CheckboxRow
          checked={v.offline.enabled}
          title={t('No connection for longer than')}
          info={t('Battery devices report rarely while nothing changes, so silence is what counts: a battery sensor or valve silent for longer than this is offline; a window contact, which speaks only when it opens or closes, after {contacts}. A mains Zigbee device counts as offline after {mains} unavailable, a device of another integration after {integrations}.', {
            mains: fmtDur(v.offline.mainsMin),
            contacts: fmtDur(v.offline.contactMin),
            integrations: fmtDur(v.offline.integrationMin),
          })}
          hint={t('mains devices {mains} · contacts {contacts} · integrations {integrations}', {
            mains: fmtDur(v.offline.mainsMin),
            contacts: fmtDur(v.offline.contactMin),
            integrations: fmtDur(v.offline.integrationMin),
          })}
          disabled={!canEdit}
          onChange={(enabled) => set({ offline: { ...v.offline, enabled } })}
          trailing={
            <NumPill
              canEdit={canEdit}
              text={fmtDur(v.offline.batteryMin)}
              ariaLabel={t('No connection for longer than')}
              min={15}
              max={720}
              step={15}
              unit={t('min')}
              value={v.offline.batteryMin}
              onChange={(batteryMin) => set({ offline: { ...v.offline, batteryMin } })}
            />
          }
        />
        <CheckboxRow
          checked={v.trvUnconfirmed.enabled}
          title={t('A radiator valve did not confirm the target after')}
          hint={t('one attempt every {dur}', { dur: fmtDur(Math.round(v.trvUnconfirmed.ackTimeoutSec / 60)) })}
          disabled={!canEdit}
          onChange={(enabled) => set({ trvUnconfirmed: { ...v.trvUnconfirmed, enabled } })}
          trailing={
            <NumPill
              canEdit={canEdit}
              text={t('{count} attempts', { count: v.trvUnconfirmed.attempts })}
              ariaLabel={t('A radiator valve did not confirm the target after')}
              min={1}
              max={10}
              step={1}
              value={v.trvUnconfirmed.attempts}
              onChange={(attempts) => set({ trvUnconfirmed: { ...v.trvUnconfirmed, attempts } })}
            />
          }
        />
        <CheckboxRow
          checked={v.weakSignal.enabled}
          title={t('Signal steadily below')}
          hint={t('median over {h} h; clears at LQI {clear}', { h: v.weakSignal.windowH, clear: v.weakSignal.clearAt })}
          info={t('LQI is the Zigbee link quality, from 0 to 255, as the nearest router hears the device; about 100 and above is fine. A single low reading is normal — the median over {h} h counts. A plug or relay on mains between the device and the coordinator usually helps.', {
            h: v.weakSignal.windowH,
          })}
          disabled={!canEdit}
          onChange={(enabled) => set({ weakSignal: { ...v.weakSignal, enabled } })}
          trailing={
            <NumPill
              canEdit={canEdit}
              text={t('LQI {lqi}', { lqi: v.weakSignal.lqiBelow })}
              ariaLabel={t('Signal steadily below')}
              min={20}
              max={120}
              step={5}
              value={v.weakSignal.lqiBelow}
              onChange={(lqiBelow) => set({ weakSignal: { ...v.weakSignal, lqiBelow, clearAt: Math.max(v.weakSignal.clearAt, lqiBelow + 5) } })}
            />
          }
        />
        <Link to={paths.notifications()} variant="muted">
          {t('Where and when to send — on the «Notifications» page.')}
        </Link>
      </Stack>
    </Section>
  );
}
