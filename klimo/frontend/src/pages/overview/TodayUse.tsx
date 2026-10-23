/**
 * Today's gas and electricity across the sources with meters, for the energy tile: amounts, the
 * cost, and the change against yesterday up to the same time. Read from Home Assistant's
 * statistics by the server; refreshed every five minutes while the overview is open.
 */
import { useEffect } from 'react';
import type { HouseConsumptionDto } from '@api/model';
import { api } from '@api/endpoints';
import { useResource } from '@data';
import { LegendSwatch, RelativeTime, Row, Stack } from '@ui';
import { fmtAmount, fmtChange, fmtMoney, t } from '@i18n';

const FIVE_MIN = 5 * 60_000;

export function useTodayUse(): HouseConsumptionDto | null {
  const res = useResource('house-consumption', api.energy.consumption, { reloadOn: ['source', 'settings'] });
  const reload = res.reload;
  useEffect(() => {
    const id = window.setInterval(() => void reload(), FIVE_MIN);
    return () => window.clearInterval(id);
  }, [reload]);
  return res.data ?? null;
}

/** «● 1.54 m³ gas · ● 29.1 kWh electricity», then «used today … €10.35» (the change against yesterday on hover). */
export function TodayUse({ use }: { use: HouseConsumptionDto | null }) {
  if (!use || !use.configured || use.recorder !== 'ok') return null;
  const gas = use.units.gas != null && use.gas != null;
  const elec = use.units.electricity != null && use.electricity != null;
  if (!gas && !elec) return null;
  const total = use.cost != null ? fmtMoney(use.cost, use.units.currency) : null;
  const change = use.cost != null ? fmtChange(use.cost, use.previous.cost) : null;
  return (
    <Stack gap="xs">
      <Row gap="md" wrap>
        {gas ? <LegendSwatch series="gas" label={t('{amount} gas', { amount: fmtAmount(use.gas, use.units.gas) })} /> : null}
        {elec ? <LegendSwatch series="electricity" label={t('{amount} electricity', { amount: fmtAmount(use.electricity, use.units.electricity) })} /> : null}
      </Row>
      <Row justify="between">
        <RelativeTime text={t('used today')} title={t('Since midnight, by the sources with meters')} />
        {total ? <RelativeTime text={total} title={change ? t('{change} vs yesterday at this time', { change }) : t('Cost today')} /> : null}
      </Row>
    </Stack>
  );
}
