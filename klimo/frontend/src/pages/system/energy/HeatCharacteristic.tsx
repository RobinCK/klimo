/**
 * «Теплова характеристика» on System → Consumption: day by day over the last 30 days, the heat the
 * sources gave against the difference between the rooms and the outdoors, the line through them, and
 * what it says about the house — its heat loss in W/K, the heat it needs in a frost and the outdoor
 * temperature above which it needs none.
 */
import { api } from '@api/endpoints';
import { useResource } from '@data';
import { paths } from '@app';
import { AutoGrid, HeatLossChart, Link, Section, Stack, StatTile, Text } from '@ui';
import { fmtNum, fmtTemp, t } from '@i18n';

export function HeatCharacteristic() {
  const res = useResource('heat-loss', api.energy.heatLoss, { reloadOn: ['source', 'room', 'settings'] });
  const d = res.data;
  if (!d || !d.configured) return null;
  const fit = d.fit;
  const points = d.days.filter((x) => x.used && x.deltaK != null && x.heatKwh != null).map((x) => ({ x: x.deltaK as number, y: x.heatKwh as number }));
  return (
    <Section
      variant="plain"
      level={3}
      title={t('Heat characteristic')}
      subtitle={t('the heat the sources gave each day against the difference between the rooms and the outdoors, over the last 30 days: the steeper the line, the more heat the house loses')}
    >
      <Stack gap="md">
        {d.recorder === 'unavailable' ? <Text variant="caption">{t('Home Assistant’s recorder did not answer — try again later.')}</Text> : null}
        {fit ? (
          <AutoGrid min={150} gap="sm">
            <StatTile variant="well" title={t('Heat loss of the house')} value={t('{value} W/K', { value: fmtNum(fit.wPerK, 0) })} sub={t('fits {pct} of the days', { pct: `${fmtNum(fit.r2 * 100, 0)} %` })} />
            <StatTile variant="well" title={t('Needed at {t}', { t: fmtTemp(-10, { decimals: 0 }) })} value={t('{value} kW', { value: fmtNum(fit.loadKw.minus10, 1) })} sub={t('at {t} inside', { t: fmtTemp(d.indoorC) })} />
            <StatTile variant="well" title={t('Needed at {t}', { t: fmtTemp(-20, { decimals: 0 }) })} value={t('{value} kW', { value: fmtNum(fit.loadKw.minus20, 1) })} sub={t('at {t} inside', { t: fmtTemp(d.indoorC) })} />
            <StatTile variant="well" title={t('No heating needed above')} value={`≈ ${fmtTemp(fit.balanceC)}`} sub={t('outdoors')} />
          </AutoGrid>
        ) : (
          <Text>{t('Not enough heating days yet: {n} of 5. The line shows once there are more, in different weather.', { n: d.used })}</Text>
        )}
        {points.length ? (
          <HeatLossChart
            points={points}
            fit={fit ? { a: fit.interceptKwh, b: fit.slopeKwhPerK } : null}
            ariaLabel={t('Heat a day against the temperature difference over {n} days', { n: points.length })}
            xUnit="K"
            yUnit={t('kWh')}
            formatX={(v) => fmtNum(v, 0)}
            formatY={(v) => fmtNum(v, 0)}
          />
        ) : null}
        <Text variant="caption">
          {t('Heat from gas: {kwh} kWh per m³ × the boiler’s efficiency {pct} %; heat pumps by their heat meters. Electric heaters and air conditioners without a heat meter are not counted.', {
            kwh: fmtNum(d.gasKwhPerM3, 1),
            pct: fmtNum(d.boilerEfficiencyPct, 0),
          })}{' '}
          <Link to={paths.settings()} variant="inline">
            {t('Energy prices')}
          </Link>
        </Text>
      </Stack>
    </Section>
  );
}
