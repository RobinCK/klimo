/**
 * «Енергія під час блекауту»: so heating does not drain the battery or overload the inverter.
 * A power budget for heat and cold, a pause between starts, what to switch off first when
 * power runs short, and the Home Assistant entities the add-on learns about energy from.
 */
import { useState } from 'react';
import type { EnergyDto, EnergyPolicy, EnergySetupRequest, Id } from '@api/model';
import { api } from '@api/endpoints';
import { useAutosave, useEntitySearch, useMutation } from '@data';
import { brand } from '@brand';
import { AutoGrid, Button, CheckboxRow, Dialog, EntityPicker, FallbackNote, KeyValueList, Section, SortableList, Stack, StatusBanner, Stepper } from '@ui';
import { fmtKw, fmtPct, renderReason, t } from '@i18n';
import type { SystemData } from '../shared';
import type { StrategyData } from './data';

function banner(dto: EnergyDto, d: SystemData): { tone: 'ok' | 'warn' | 'err' | 'event'; text: string } {
  const s = dto.state;
  if (!s.configured) return { tone: 'warn', text: t('Energy is not set up — choose where the grid and battery state come from.') };
  if (s.grid === 'unknown') return { tone: 'warn', text: t('No data about the grid.') };
  switch (s.phase) {
    case 'normal':
      return { tone: 'ok', text: s.restrictionsActive ? t('Restrictions are active.') : t('The grid is on now — no restrictions apply.') };
    case 'blackout':
      return { tone: 'warn', text: t('Blackout — heat and cold use {used} of {budget}.', { used: fmtKw(s.usedKw, 1), budget: fmtKw(s.budgetKw, 1) }) };
    case 'economy':
      return { tone: 'err', text: s.note ? renderReason(s.note, d.ctx) : t('Economy — battery {pct}.', { pct: fmtPct(s.batteryPct) }) };
    case 'critical':
      return { tone: 'err', text: s.note ? renderReason(s.note, d.ctx) : t('The battery is critically low — frost protection only.') };
  }
}

export function EnergySection({ d, s, embedded }: { d: SystemData; s: StrategyData; embedded?: boolean }) {
  const dto = s.energy.data as EnergyDto;
  const { setData } = s.energy;
  const [setup, setSetup] = useState(false);
  const policy = useAutosave(dto.policy, (p) => {
    const { budgetKw, staggerSec, shedOrder, shedOrderCustom } = p;
    return api.energy.patch({ budgetKw, staggerSec, shedOrder, shedOrderCustom }).then(setData);
  });
  const p = policy.value;
  const b = banner(dto, d);
  const kwOf = (id: Id) => {
    const src = d.sources.data?.find((x) => x.config.id === id);
    return src ? t('up to {kw}', { kw: fmtKw(src.config.energy.maxPowerKw) }) : '';
  };
  const exempt = p.exempt.sourceIds.map(d.nameOf);
  // outside the sentence's own t(): the string extractor misses a t() nested in another call
  const pumpsWord = t('the pumps');
  const st = dto.state;
  const e = p.entities;
  const live = {
    grid: st.grid === 'present' ? t('grid is on') : st.grid === 'absent' ? t('no grid') : '—',
    pv: st.pvKw != null ? fmtKw(st.pvKw) : '—',
    load: st.houseLoadKw != null ? fmtKw(st.houseLoadKw) : '—',
    soc: st.batteryPct != null ? fmtPct(st.batteryPct) : '—',
  };
  const row = (key: string, entity: string | null, value: string) => ({ key, value: entity ? `${entity} · ${value}` : t('not set'), mono: Boolean(entity) });
  return (
    <Section
      variant={embedded ? 'plain' : 'card'}
      title={embedded ? undefined : t('Energy during a blackout')}
      subtitle={t('So heating neither drains the battery nor overloads the inverter.')}
    >
      <Stack gap="lg">
        <StatusBanner
          tone={b.tone}
          icon={b.tone === 'ok' ? 'checkCircle' : 'bolt'}
          text={b.text}
          action={!st.configured && d.canEdit ? { label: t('Set up energy'), onClick: () => setSetup(true) } : undefined}
        />
        <AutoGrid min={200} gap="sm">
          <Stepper
            variant="tile"
            label={t('Budget for heat and cold')}
            hint={t('While the energy restrictions are on (by default during a blackout), all electric heat and cold together may draw at most this much. A start that does not fit waits; a load over it by {over} for 30 s switches off the first source of the list below. A gas boiler counts only its electronics. Default: {def}.', {
              over: fmtKw(0.2),
              def: fmtKw(4),
            })}
            value={p.budgetKw}
            text={fmtKw(p.budgetKw, 1)}
            min={1}
            max={15}
            step={0.5}
            disabled={!d.canEdit}
            onChange={(budgetKw) => policy.set((x) => ({ ...x, budgetKw }))}
            ariaDec={t('Smaller budget')}
            ariaInc={t('Larger budget')}
          />
          <Stepper
            variant="tile"
            label={t('Start one by one, pause')}
            hint={t('Sources start one at a time with this pause between them, the most important first, so an inverter never sees two compressors start together. Default: 30 s.')}
            value={p.staggerSec}
            text={t('{s} s', { s: p.staggerSec })}
            min={0}
            max={120}
            step={10}
            disabled={!d.canEdit}
            onChange={(staggerSec) => policy.set((x) => ({ ...x, staggerSec }))}
            ariaDec={t('Shorter pause')}
            ariaInc={t('Longer pause')}
          />
        </AutoGrid>
        <Section
          variant="plain"
          level={3}
          title={t('What to switch off first when power runs short')}
          hint={t('The top of the list goes first; the bottom is the most important and also starts first. Over {em} of the budget a source is switched off at once, even before its minimum run time is over.', {
            em: fmtPct(125),
          })}
        >
          <Stack gap="sm">
            <SortableList
              numbered
              size="sm"
              ariaLabel={t('Shedding order')}
              items={p.shedOrder.map((id) => ({ id, title: d.nameOf(id), trailing: kwOf(id), locked: !d.canEdit }))}
              onReorder={(ids) => policy.set((x) => ({ ...x, shedOrder: ids, shedOrderCustom: true }))}
            />
            <FallbackNote
              icon="info"
              text={
                exempt.length || p.exempt.pumps
                  ? t('{list} work always while the battery is above {pct}.', {
                      list: [...exempt, ...(p.exempt.pumps ? [pumpsWord] : [])].join(', '),
                      pct: fmtPct(p.exempt.whileSocAbovePct),
                    })
                  : t('Below {pct} only frost protection works.', { pct: fmtPct(p.criticalSocPct) })
              }
            />
          </Stack>
        </Section>
        <Section
          variant="plain"
          level={3}
          title={t('Where {product} learns about energy', { product: brand.productName })}
          action={
            d.canEdit ? (
              <Button variant="link" size="sm" onClick={() => setSetup(true)}>
                {t('Change')}
              </Button>
            ) : undefined
          }
        >
          <KeyValueList
            rows={[
              row(t('Grid'), e.gridOffline, live.grid),
              row(t('Sun'), e.pvPower, live.pv),
              row(t('Consumption'), e.houseLoad, live.load),
              row(t('Battery'), e.batterySoc, live.soc),
              ...(e.tariff ? [row(t('Tariff'), e.tariff, '')] : []),
            ]}
          />
        </Section>
      </Stack>
      {setup ? <EnergySetupDialog s={s} policy={dto.policy} onClose={() => setSetup(false)} /> : null}
    </Section>
  );
}

function EnergySetupDialog({ s, policy, onClose }: { s: StrategyData; policy: EnergyPolicy; onClose: () => void }) {
  const [entities, setEntities] = useState<EnergySetupRequest['entities']>(policy.entities);
  const [critical, setCritical] = useState(policy.criticalSocPct);
  const [exemptSoc, setExemptSoc] = useState(policy.exempt.whileSocAbovePct);
  const [pumps, setPumps] = useState(policy.exempt.pumps);
  const binary = useEntitySearch('binary');
  const power = useEntitySearch('power');
  const any = useEntitySearch(null, { domain: ['sensor'] });
  const select = useEntitySearch(null, { domain: ['sensor', 'select', 'input_select'] });
  const save = useMutation(
    async () => {
      await api.energy.setup({ entities });
      return api.energy.patch({ criticalSocPct: critical, exempt: { ...policy.exempt, whileSocAbovePct: exemptSoc, pumps } });
    },
    {
      onSuccess: (dto) => {
        s.energy.setData(dto);
        onClose();
      },
      okToast: t('Energy settings saved'),
    },
  );
  const set = (p: Partial<EnergySetupRequest['entities']>) => setEntities((x) => ({ ...x, ...p }));
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={t('Energy')}
      actions={[
        { label: t('Cancel'), onClick: onClose, variant: 'secondary' },
        { label: t('Save'), onClick: () => void save.run(), loading: save.pending },
      ]}
    >
      <Stack gap="md">
        <Section variant="plain" level={3} subtitle={t('Grid')}>
          <EntityPicker
            ariaLabel={t('Grid')}
            placeholder={t('Grid off: a binary sensor that is on without the grid')}
            clearable
            value={entities.gridOffline}
            search={binary}
            onChange={(gridOffline) => set({ gridOffline })}
          />
        </Section>
        <Section variant="plain" level={3} subtitle={t('Sun')}>
          <EntityPicker
            ariaLabel={t('Sun')}
            placeholder={t('Solar power')}
            clearable
            value={entities.pvPower}
            search={power}
            onChange={(pvPower) => set({ pvPower })}
          />
        </Section>
        <Section variant="plain" level={3} subtitle={t('Consumption')}>
          <EntityPicker
            ariaLabel={t('Consumption')}
            placeholder={t('House load')}
            clearable
            value={entities.houseLoad}
            search={power}
            onChange={(houseLoad) => set({ houseLoad })}
          />
        </Section>
        <Section variant="plain" level={3} subtitle={t('Battery')}>
          <EntityPicker
            ariaLabel={t('Battery')}
            placeholder={t('Battery charge, %')}
            clearable
            value={entities.batterySoc}
            search={any}
            onChange={(batterySoc) => set({ batterySoc })}
          />
        </Section>
        <Section variant="plain" level={3} subtitle={t('Tariff')}>
          <EntityPicker
            ariaLabel={t('Tariff')}
            placeholder={t('Tariff (optional)')}
            clearable
            value={entities.tariff}
            search={select}
            onChange={(tariff) => set({ tariff })}
          />
        </Section>
        <Stepper
          variant="compact"
          label={t('Boiler and pumps keep working while the battery is above')}
          value={exemptSoc}
          text={fmtPct(exemptSoc)}
          min={5}
          max={90}
          step={5}
          onChange={setExemptSoc}
          ariaDec={t('Less')}
          ariaInc={t('More')}
        />
        <CheckboxRow checked={pumps} title={t('Pumps are always allowed')} onChange={setPumps} />
        <Stepper
          variant="compact"
          label={t('Frost protection only below')}
          value={critical}
          text={fmtPct(critical)}
          min={5}
          max={50}
          step={5}
          onChange={setCritical}
          ariaDec={t('Less')}
          ariaInc={t('More')}
        />
      </Stack>
    </Dialog>
  );
}
