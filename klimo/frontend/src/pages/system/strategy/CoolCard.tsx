/**
 * «Охолодження» as complete as heating: the order of cooling sources, how a shared heat pump
 * picks heating or cooling, the dew-point margin for floor cooling, the options and the months
 * when cooling is allowed at all. «Сезон» holds the thresholds of the automatic season.
 */
import type { ChainEntry, CoolStrategy, HpModeSelection, SeasonConfig, StrategyDto } from '@api/model';
import { api } from '@api/endpoints';
import { useAutosave, useMutation } from '@data';
import { AutoGrid, CheckboxRow, MonthToggleGrid, Section, SegmentedControl, SortableList, Stack, Stepper } from '@ui';
import { fmtDelta, fmtDur, fmtPct, fmtTemp, monthLong, monthShort, t } from '@i18n';
import type { SystemData } from '../shared';
import { monthsSummary, type StrategyData } from './data';
import { chainItems, Extras } from './HeatCard';

const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);
const deg = (v: number) => fmtTemp(v, { decimals: 0 });

export function CoolCard({ d, s, embedded }: { d: SystemData; s: StrategyData; embedded?: boolean }) {
  const dto = s.strategy.data as StrategyDto;
  const cool = dto.cool;
  const { setData } = s.strategy;
  const opts = useAutosave<CoolStrategy>(cool, (c) => {
    const { chain: _chain, ...rest } = c;
    return api.strategy.patchCool(rest).then(setData);
  });
  const months = useAutosave(dto.season.coolingMonths, (m) => api.strategy.patchSeason({ coolingMonths: m }).then(setData));
  const reorder = useMutation((chain: ChainEntry[]) => api.strategy.setCoolChain({ chain }), { onSuccess: setData, onError: () => void s.strategy.reload() });
  const c = opts.value;
  const set = (p: Partial<CoolStrategy>) => opts.set((x) => ({ ...x, ...p }));
  const avg = dto.season;
  const hint =
    c.hpModeSelection === 'demand'
      ? t('The heat pump switches to cooling when most floor rooms ask for cooling, and back.')
      : t('The heat pump heats while the {days}-day average is below {heat}, cools above {cool}; in between it rests.', {
          days: avg.avgDays,
          heat: deg(avg.heatBelowC),
          cool: deg(avg.coolAboveC),
        });
  return (
    <Section
      variant={embedded ? 'plain' : 'card'}
      accent={embedded ? undefined : 'cool'}
      icon={embedded ? undefined : 'snow'}
      title={embedded ? undefined : t('Cool')}
      subtitle={t('As complete as heating: its own source order, guards and conditions.')}
    >
      <Stack gap="xl">
        <SortableList
          numbered
          ariaLabel={t('Cooling order')}
          items={chainItems(cool.chain, dto.runtime.coolChain, d, () => null)}
          onReorder={(ids) => {
            const next = ids.map((id) => cool.chain.find((e) => e.id === id) as ChainEntry);
            setData({ ...dto, cool: { ...cool, chain: next } });
            void reorder.run(next);
          }}
        />
        <Section variant="plain" level={3} title={t('The heat pump mode is chosen')}>
          <SegmentedControl<HpModeSelection>
            ariaLabel={t('How the heat pump picks its mode')}
            value={c.hpModeSelection}
            options={[
              { value: 'demand', label: t('By the rooms’ requests'), disabled: !d.canEdit },
              { value: 'weather', label: t('By the weather'), disabled: !d.canEdit },
            ]}
            onChange={(hpModeSelection) => set({ hpModeSelection })}
            hint={hint}
          />
        </Section>
        <AutoGrid min={170} gap="sm">
          <Stepper
            variant="tile"
            label={t('Margin above the dew point')}
            sub={t('so no condensation forms on the floor')}
            value={c.dewMarginC}
            text={fmtDelta(c.dewMarginC, { sign: true, decimals: 0 })}
            min={1}
            max={5}
            step={1}
            disabled={!d.canEdit}
            onChange={(dewMarginC) => set({ dewMarginC })}
            ariaDec={t('Smaller margin')}
            ariaInc={t('Larger margin')}
          />
          <Stepper
            variant="tile"
            label={t('The heat pump changes mode')}
            sub={t('not more often than once per')}
            value={c.changeoverMinH}
            text={t('{h} h', { h: c.changeoverMinH })}
            min={1}
            max={12}
            step={1}
            disabled={!d.canEdit}
            onChange={(changeoverMinH) => set({ changeoverMinH })}
            ariaDec={t('More often')}
            ariaInc={t('Less often')}
          />
          <Stepper
            variant="tile"
            label={t('Gap between targets in «Auto»')}
            sub={t('between «not colder» and «not warmer»')}
            value={c.autoMinGapC}
            text={t('from {d}', { d: fmtDelta(c.autoMinGapC, { sign: false, decimals: 0 }) })}
            min={1}
            max={5}
            step={1}
            disabled={!d.canEdit}
            onChange={(autoMinGapC) => set({ autoMinGapC })}
            ariaDec={t('Smaller gap')}
            ariaInc={t('Larger gap')}
          />
        </AutoGrid>
        <Stack gap="xs">
          <CheckboxRow
            variant="divided"
            checked={c.dryInsteadOfCool.enabled}
            disabled={!d.canEdit}
            title={t('Drying instead of cooling')}
            hint={t('Humidity above {pct} while the temperature is fine — the air conditioner switches to drying.', {
              pct: fmtPct(c.dryInsteadOfCool.abovePct),
            })}
            onChange={(enabled) => set({ dryInsteadOfCool: { ...c.dryInsteadOfCool, enabled } })}
          />
          <CheckboxRow
            variant="divided"
            checked={c.floorExcludeAbovePct != null}
            disabled={!d.canEdit}
            title={t('No floor cooling in humid rooms')}
            hint={t('A room above {pct} humidity is left out — condensation would form on the tiles.', { pct: fmtPct(c.floorExcludeAbovePct ?? 65) })}
            onChange={(on) => set({ floorExcludeAbovePct: on ? 65 : null })}
          />
          <CheckboxRow
            variant="divided"
            checked={c.solarPrecool.enabled}
            disabled={!d.canEdit}
            title={t('Sun in the windows')}
            hint={t('Rooms on the sunny side start cooling {dur} earlier, by the forecast.', { dur: fmtDur(c.solarPrecool.leadMin) })}
            onChange={(enabled) => set({ solarPrecool: { ...c.solarPrecool, enabled } })}
          />
          <CheckboxRow
            variant="divided"
            checked={c.singleRoomCentralStart}
            disabled={!d.canEdit}
            title={t('Start the heat pump for a single room')}
            hint={t('Off: a room that has its own air conditioner is cooled by it, not by the central heat pump.')}
            onChange={(singleRoomCentralStart) => set({ singleRoomCentralStart })}
          />
        </Stack>
        <MonthToggleGrid
          title={t('When cooling is allowed')}
          accent="cool"
          value={months.value}
          labels={MONTHS.map((m) => monthShort(m))}
          fullLabels={MONTHS.map((m) => monthLong(m))}
          summary={monthsSummary(months.value, monthLong)}
          onChange={(m) => d.canEdit && months.set(m)}
        />
        <Extras d={d} dto={dto} mode="cool" />
      </Stack>
    </Section>
  );
}

export function SeasonCard({ d, s, embedded }: { d: SystemData; s: StrategyData; embedded?: boolean }) {
  const dto = s.strategy.data as StrategyDto;
  const { setData } = s.strategy;
  const season = useAutosave<SeasonConfig>(dto.season, (v) => api.strategy.patchSeason(v).then(setData));
  const cutoff = useAutosave(dto.heat.heatingCutoffOutdoorC, (v) => api.strategy.patchHeat({ heatingCutoffOutdoorC: v }).then(setData));
  const v = season.value;
  const set = (p: Partial<SeasonConfig>) => season.set((x) => ({ ...x, ...p }));
  const tile = (key: keyof SeasonConfig, label: string, sub: string, text: string, min: number, max: number, step: number) => (
    <Stepper
      variant="tile"
      label={label}
      sub={sub}
      value={v[key] as number}
      text={text}
      min={min}
      max={max}
      step={step}
      disabled={!d.canEdit}
      onChange={(x) => set({ [key]: x } as Partial<SeasonConfig>)}
      ariaDec={t('Less')}
      ariaInc={t('More')}
    />
  );
  return (
    <Section
      variant={embedded ? 'plain' : 'card'}
      icon={embedded ? undefined : 'calendar'}
      title={embedded ? undefined : t('Season')}
      subtitle={t('In «Auto» the season follows the {days}-day average outdoor temperature; the months limit it further.', { days: v.avgDays })}
    >
      <Stack gap="lg">
        <AutoGrid min={200} gap="sm">
          {tile('heatBelowC', t('Heating season'), t('when the average is below'), deg(v.heatBelowC), 5, 20, 1)}
          {tile('coolAboveC', t('Cooling season'), t('when the average is above'), deg(v.coolAboveC), Math.max(16, v.heatBelowC + 2), 30, 1)}
          {tile('avgDays', t('Average over'), t('days of outdoor temperature'), t('{count} days', { count: v.avgDays }), 1, 7, 1)}
          {tile('hysteresisC', t('Hysteresis'), t('to leave a season'), fmtDelta(v.hysteresisC, { sign: false }), 0.5, 3, 0.5)}
          {tile('minDwellH', t('Stays at least'), t('before the season can change'), fmtDur(v.minDwellH * 60), 6, 72, 6)}
          {tile('confirmH', t('Must hold for'), t('before the change counts'), fmtDur(v.confirmH * 60), 1, 24, 1)}
          {tile(
            'neutralColdGuardC',
            t('Between seasons'),
            t('central heating still starts for a room colder by'),
            fmtDelta(v.neutralColdGuardC, { sign: false }),
            0.5,
            3,
            0.5,
          )}
          <Stepper
            variant="tile"
            label={t('Heating not needed')}
            sub={t('above this outdoors (10-minute average)')}
            value={cutoff.value ?? 15}
            text={cutoff.value == null ? t('never') : deg(cutoff.value)}
            min={8}
            max={25}
            step={1}
            disabled={!d.canEdit}
            onChange={(x) => cutoff.set(x)}
            ariaDec={t('Lower')}
            ariaInc={t('Higher')}
          />
        </AutoGrid>
        <MonthToggleGrid
          title={t('When heating is allowed')}
          accent="heat"
          value={v.heatingMonths}
          labels={MONTHS.map((m) => monthShort(m))}
          fullLabels={MONTHS.map((m) => monthLong(m))}
          summary={monthsSummary(v.heatingMonths, monthLong)}
          onChange={(heatingMonths) => d.canEdit && set({ heatingMonths })}
        />
      </Stack>
    </Section>
  );
}
