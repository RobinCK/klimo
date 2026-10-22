import type { RoomNotifyPrefs } from '@api/model';
import { api } from '@api/endpoints';
import { useAutosave, useMutation, useResource } from '@data';
import { CheckboxRow, Link, Stack, ValuePill } from '@ui';
import { paths } from '@app';
import { fmtDelta, fmtRate, fmtTemp, t, weekdayLong } from '@i18n';
import type { SectionDef, SectionProps } from './types';

function useSafety() {
  return useResource('settings', api.settings.get, { reloadOn: ['settings', 'safety'] }).data?.safety ?? null;
}

function SmartBody(p: SectionProps) {
  const { room } = p;
  const smart = useAutosave(room.config.smart, (v) => p.save({ smart: v }));
  const frost = useAutosave(room.config.frostC, (v) => p.save({ frostC: v }));
  const sunny = useMutation((on: boolean) => p.save({ sunnySide: on, smart: { ...smart.value, solarGain: { ...smart.value.solarGain, enabled: on } } }));
  const safety = useSafety();
  const s = smart.value;
  const houseFrost = safety?.frostC ?? null;
  const roomFrost = frost.value ?? houseFrost;
  const rate = room.thermostat.rate.heat;
  const ex = safety?.valveExercise;
  return (
    <Stack gap="xs">
      <CheckboxRow
        variant="divided"
        checked={s.optimalStart.enabled}
        disabled={!p.canEdit}
        title={t('Optimal start')}
        hint={t('Learns how fast the room warms up (now ≈ {rate}) and starts early, so the target is reached on time.', {
          rate: fmtRate(rate, { sign: false }),
        })}
        onChange={(on) => smart.set((x) => ({ ...x, optimalStart: { ...x.optimalStart, enabled: on } }))}
      />
      <CheckboxRow
        variant="divided"
        checked={s.overheat.enabled}
        disabled={!p.canEdit}
        title={t('Overheating protection')}
        hint={t('Above {t} — close the valves even with a manual target.', { t: fmtTemp(safety?.overheatC ?? null) })}
        onChange={(on) => smart.set((x) => ({ ...x, overheat: { enabled: on } }))}
      />
      <CheckboxRow
        variant="divided"
        checked
        locked={{ reason: t('Always on') }}
        title={t('Frost protection')}
        hint={t('Even when the room is off, keep at least {t}.', { t: fmtTemp(roomFrost) })}
        trailing={
          houseFrost != null && roomFrost != null && p.canEdit ? (
            <ValuePill
              text={fmtTemp(roomFrost)}
              ariaLabel={t('Frost protection')}
              editor={{ kind: 'number', min: houseFrost, max: 12, step: 0.5, unit: '°' }}
              value={roomFrost}
              onChange={(v: number) => frost.set(v <= houseFrost ? null : v)}
            />
          ) : undefined
        }
        onChange={() => undefined}
      />
      <CheckboxRow
        variant="divided"
        checked={s.valveExercise.enabled}
        disabled={!p.canEdit}
        title={t('Valve exercise in summer')}
        hint={
          ex
            ? t('Every {day} at {time}: open and close, so the valve does not seize.', { day: weekdayLong(ex.dow).toLowerCase(), time: ex.time })
            : t('Once a week: open and close, so the valve does not seize.')
        }
        onChange={(on) => smart.set((x) => ({ ...x, valveExercise: { enabled: on } }))}
      />
      <CheckboxRow
        variant="divided"
        checked={s.weatherComp.enabled}
        disabled={!p.canEdit}
        title={t('Weather compensation')}
        hint={t('In frost start earlier: for every {per} of frost the threshold rises by {shift}.', {
          per: fmtDelta(s.weatherComp.perFrostC),
          shift: fmtDelta(s.weatherComp.shiftC),
        })}
        onChange={(on) => smart.set((x) => ({ ...x, weatherComp: { ...x.weatherComp, enabled: on } }))}
      />
      <CheckboxRow
        variant="divided"
        checked={room.config.sunnySide && s.solarGain.enabled}
        disabled={!p.canEdit || sunny.pending}
        title={t('Sun in the windows')}
        hint={t('On the sunny side start cooling a little earlier in the day.')}
        onChange={(on) => void sunny.run(on)}
      />
    </Stack>
  );
}

const NOTIFY_KEYS: (keyof RoomNotifyPrefs)[] = ['sensorStale', 'trvFailed', 'batteryLow', 'humidity', 'windowLeftOpen', 'tooCold', 'tooHot'];

function notifyTitle(k: keyof RoomNotifyPrefs): string {
  switch (k) {
    case 'sensorStale':
      return t('A sensor stops reporting');
    case 'trvFailed':
      return t('A radiator valve does not confirm its target');
    case 'batteryLow':
      return t('A battery is low');
    case 'humidity':
      return t('High humidity or a condensation risk');
    case 'windowLeftOpen':
      return t('A window is left open');
    case 'tooCold':
      return t('The room stays colder than its target');
    case 'tooHot':
      return t('The room stays warmer than its target');
  }
}

function NotifyBody(p: SectionProps) {
  const notify = useAutosave(p.room.config.notify, (v) => p.save({ notify: v }));
  return (
    <Stack gap="xs">
      {NOTIFY_KEYS.map((k) => (
        <CheckboxRow
          key={k}
          variant="divided"
          checked={notify.value[k]}
          disabled={!p.canEdit}
          title={notifyTitle(k)}
          onChange={(on) => notify.set((x) => ({ ...x, [k]: on }))}
        />
      ))}
      <Link to={paths.notifications()} variant="muted">
        {t('Where the notifications go is set on the notifications page')}
      </Link>
    </Stack>
  );
}

export const smartSection: SectionDef = {
  key: 'smart',
  icon: 'sparkle',
  title: () => t('Smart functions'),
  summary: (p) => {
    const s = p.room.config.smart;
    const on = [
      s.optimalStart.enabled,
      s.overheat.enabled,
      true,
      s.valveExercise.enabled,
      s.weatherComp.enabled,
      p.room.config.sunnySide && s.solarGain.enabled,
    ].filter(Boolean).length;
    return t('{on} of {total} on', { on, total: 6 });
  },
  Body: SmartBody,
};

export const notifySection: SectionDef = {
  key: 'notify',
  icon: 'bell',
  title: () => t('Room notifications'),
  subtitle: () => t('What to tell about this room.'),
  summary: (p) => {
    const n = p.room.config.notify;
    return t('{on} of {total} on', { on: NOTIFY_KEYS.filter((k) => n[k]).length, total: NOTIFY_KEYS.length });
  },
  Body: NotifyBody,
};
