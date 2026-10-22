import { useState } from 'react';
import type { SourceDemandPolicy } from '@api/model';
import { useAutosave } from '@data';
import { AutoGrid, RadioCardList, Section, SegmentedControl, Stack, Stepper, ToleranceBar } from '@ui';
import { demandPolicyLabel, fmtDelta, fmtDur, fmtTemp, minRequestHint, t, toleranceHint } from '@i18n';
import { lockable, SettingPill } from './readonly';
import type { SectionDef, SectionProps } from './types';

type Mode = 'heat' | 'cool';

/** The target the band is drawn around: the effective one, else the profile's. */
function targetOf(p: SectionProps, mode: Mode): number | null {
  const tg = p.state.target;
  return mode === 'heat' ? (tg.heatC ?? p.room.thermostat.t ?? null) : (tg.coolC ?? null);
}

function demandHint(policy: SourceDemandPolicy): string {
  switch (policy) {
    case 'call':
      return t('The room starts the heat pump or boiler by itself when it is cold.');
    case 'piggyback':
      return t('Heats only while the source already runs for other rooms.');
    case 'never':
      return t('Never asks the central sources; only its own devices work.');
  }
}

function Body(p: SectionProps) {
  const [mode, setMode] = useState<Mode>(p.state.activeModes.cool && !p.state.activeModes.heat ? 'cool' : 'heat');
  const tol = useAutosave(p.room.config.tolerance, (v) => p.save({ tolerance: v }), { debounceMs: 600 });
  const demand = useAutosave(p.room.config.demand, (v) => p.save({ demand: v }));
  const band = tol.value[mode];
  const target = targetOf(p, mode);
  const cur = p.state.tempC;
  const on = target == null ? null : mode === 'heat' ? target - band.below : target + band.above;
  const off = target == null ? null : mode === 'heat' ? target + band.above : target - band.below;
  const sentence =
    target == null
      ? mode === 'heat'
        ? t('Starts heating {below} below the target and stops {above} above it.', { below: fmtDelta(band.below), above: fmtDelta(band.above) })
        : t('Starts cooling {above} above the target and stops {below} below it.', { below: fmtDelta(band.below), above: fmtDelta(band.above) })
      : mode === 'heat'
        ? t('Starts heating at {on} and stops at {off}.', { on: fmtTemp(on), off: fmtTemp(off) })
        : t('Starts cooling at {on} and stops at {off}.', { on: fmtTemp(on), off: fmtTemp(off) });
  const setBand = (k: 'below' | 'above', v: number) => tol.set((x) => ({ ...x, [mode]: { ...x[mode], [k]: Math.round(v * 10) / 10 } }));
  const below = (
    <Stepper
      key="below"
      variant="square"
      label={mode === 'heat' ? t('Below the target — switch on') : t('Below the target — switch off')}
      sub={p.phone ? (mode === 'heat' ? t('when to switch on') : t('when to switch off')) : undefined}
      labelTone={mode === 'heat' ? 'heat' : 'hold'}
      value={band.below}
      text={`−${fmtDelta(band.below)}`}
      min={0.1}
      max={1}
      step={0.1}
      disabled={!p.canEdit}
      onChange={(v) => setBand('below', v)}
      ariaDec={t('Narrower below the target')}
      ariaInc={t('Wider below the target')}
    />
  );
  const above = (
    <Stepper
      key="above"
      variant="square"
      label={mode === 'heat' ? t('Above the target — switch off') : t('Above the target — switch on')}
      sub={p.phone ? (mode === 'heat' ? t('when to switch off') : t('when to switch on')) : undefined}
      labelTone={mode === 'cool' ? 'cool' : 'hold'}
      value={band.above}
      text={`+${fmtDelta(band.above)}`}
      min={0.1}
      max={1}
      step={0.1}
      disabled={!p.canEdit}
      onChange={(v) => setBand('above', v)}
      ariaDec={t('Narrower above the target')}
      ariaInc={t('Wider above the target')}
    />
  );
  return (
    <Stack gap="lg">
      <SegmentedControl<Mode>
        value={mode}
        options={[
          { value: 'heat', label: t('Space heating') },
          { value: 'cool', label: t('Space cooling') },
        ]}
        onChange={setMode}
        full={p.phone}
        ariaLabel={t('Which tolerance to edit')}
      />
      <Section variant="well" level={3} title={sentence} hint={toleranceHint(tol.value.heat, targetOf(p, 'heat'))} />
      <AutoGrid min={220} gap="md">
        {mode === 'heat' ? [below, above] : [above, below]}
      </AutoGrid>
      {target != null ? (
        <ToleranceBar
          mode={mode}
          target={target}
          below={band.below}
          above={band.above}
          current={cur}
          active={mode === 'heat' ? p.state.demand.latched.heat : p.state.demand.latched.cool}
          labels={{
            on: mode === 'heat' ? t('on at ≤ {t}', { t: fmtTemp(on) }) : t('on at ≥ {t}', { t: fmtTemp(on) }),
            off: mode === 'heat' ? t('off at ≥ {t}', { t: fmtTemp(off) }) : t('off at ≤ {t}', { t: fmtTemp(off) }),
            target:
              mode === 'heat'
                ? t('target {t} · now {now}', { t: fmtTemp(target), now: fmtTemp(cur) })
                : t('cooling target {t} · now {now}', { t: fmtTemp(target), now: fmtTemp(cur) }),
          }}
        />
      ) : null}
      <Stack gap="sm">
        <RadioCardList<SourceDemandPolicy>
          value={demand.value.policy}
          compact={p.phone}
          options={lockable(
            (['call', 'piggyback', 'never'] as const).map((v) => ({ value: v, title: demandPolicyLabel(v), hint: demandHint(v) })),
            p.canEdit,
          )}
          onChange={(v) => demand.set((x) => ({ ...x, policy: v }))}
          ariaLabel={t('Whether the room may start a source')}
        />
        <Section
          variant="plain"
          level={3}
          subtitle={t('The shortest request, so a source is not switched on and off: {dur}.', { dur: fmtDur(demand.value.minRequestMin) })}
          hint={minRequestHint(demand.value.minRequestMin)}
          action={
            <SettingPill
              readOnly={!p.canEdit}
              text={fmtDur(demand.value.minRequestMin)}
              ariaLabel={t('Shortest request')}
              editor={{ kind: 'number', min: 0, max: 30, step: 1, unit: t('min') }}
              value={demand.value.minRequestMin}
              onChange={(v: number) => demand.set((x) => ({ ...x, minRequestMin: v }))}
            />
          }
        />
      </Stack>
    </Stack>
  );
}

function summary(p: SectionProps): string {
  const tol = p.room.config.tolerance;
  const h = targetOf(p, 'heat');
  const c = targetOf(p, 'cool');
  const heat = h != null ? `${fmtTemp(h - tol.heat.below)}–${fmtTemp(h + tol.heat.above)}` : `−${fmtDelta(tol.heat.below)}/+${fmtDelta(tol.heat.above)}`;
  const cool = c != null ? `${fmtTemp(c - tol.cool.below)}–${fmtTemp(c + tol.cool.above)}` : `−${fmtDelta(tol.cool.below)}/+${fmtDelta(tol.cool.above)}`;
  return t('heat {heat} · cold {cool}', { heat, cool });
}

export const toleranceSection: SectionDef = {
  key: 'tol',
  icon: 'range',
  title: () => t('Tolerance'),
  subtitle: () => t('Hysteresis: so a source does not switch on for every tenth of a degree.'),
  summary,
  Body,
};
