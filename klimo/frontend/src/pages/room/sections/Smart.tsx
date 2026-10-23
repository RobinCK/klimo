import type { RoomNotifyPrefs } from '@api/model';
import { api } from '@api/endpoints';
import { useAutosave, useMutation, useResource } from '@data';
import { CheckboxRow, Link, Stack, ValuePill } from '@ui';
import { paths } from '@app';
import { fmtDelta, fmtDur, fmtRate, fmtTemp, t, weekdayLong } from '@i18n';
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
  const release = roomFrost != null && safety ? roomFrost + Math.max(0, safety.frostReleaseC - safety.frostC) : null;
  // the weather-compensation example: −10° outside, a 21° target, this room's own tolerance
  const tol = room.config.tolerance.heat;
  const shift = s.weatherComp.perFrostC > 0 ? Math.floor(10 / s.weatherComp.perFrostC) * s.weatherComp.shiftC : 0;
  const compOn = Math.min(21 - tol.below + shift, 21 + tol.above - 0.1);
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
        info={t('Before a schedule slot with a higher target, the room starts as early as it needs: the missing degrees divided by how fast it warms. From {from} to {to} at {rate} — {lead} ahead. At most {max} early; until it has learned, 1°/h is assumed.', {
          from: fmtTemp(18, { decimals: 0 }),
          to: fmtTemp(21, { decimals: 0 }),
          rate: fmtRate(1, { sign: false }),
          lead: fmtDur(180),
          max: fmtDur(s.optimalStart.maxLeadMin),
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
        info={t('Below {t} the room heats whatever the mode — the room off in its profile, the whole house off — with the first source that can, and stops at {release}. The value for the whole house is in the system protections ({house}); here a room can only raise it.', {
          t: fmtTemp(roomFrost),
          release: fmtTemp(release),
          house: fmtTemp(houseFrost),
        })}
        trailing={
          houseFrost != null && roomFrost != null && p.canEdit ? (
            <ValuePill
              text={fmtTemp(roomFrost)}
              ariaLabel={t('Frost protection')}
              editor={{ kind: 'number', min: houseFrost, max: 12, step: 0.5, unit: '°', format: (x) => fmtTemp(x) }}
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
        info={t('The threshold is the temperature at which heating switches on. In frost the room cools faster, so it starts a little sooner. With {target} and a tolerance of −{below}, at {out} outside heating starts at {on} instead of {plain}.', {
          target: fmtTemp(21, { decimals: 0 }),
          below: fmtDelta(tol.below),
          out: fmtTemp(-10, { decimals: 0 }),
          on: fmtTemp(compOn),
          plain: fmtTemp(21 - tol.below),
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
