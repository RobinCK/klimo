/**
 * What a source used, in words: the change against the period before, the meters' names and
 * the «i» explanations of the meters. The periods, the bucket labels and the prices are in
 * @i18n (energy.ts), shared with the house's and a room's consumption.
 */
import type { EnergyCarrier, MeterKind, SourceConsumptionDto, SourceKind } from '@api/model';
import type { InfoHintContent, InfoHintParagraph } from '@ui';
import { brand } from '@brand';
import { changeAgainst, t } from '@i18n';

/* ---------------- amounts ---------------- */

/** How the period compares with the one before («+12% vs yesterday at this time»). */
export function changeText(dto: SourceConsumptionDto, kind: MeterKind): string | null {
  return changeAgainst(dto, dto.totals[kind], dto.previous.totals[kind], dto.previous.complete);
}

export function meterLabel(kind: MeterKind): string {
  return kind === 'gas' ? t('Gas meter') : kind === 'electricity' ? t('Electricity meter') : t('Heat meter');
}

/* ---------------- meters ---------------- */

/** The meter kinds a source offers without asking: gas for a gas source, electricity for an electric one, heat for every one. */
export function naturalKinds(carrier: EnergyCarrier): MeterKind[] {
  if (carrier === 'gas') return ['gas', 'heat'];
  if (carrier === 'electric') return ['electricity', 'heat'];
  return ['heat'];
}

/** The meter a source with no meter is first offered. */
export function firstKind(carrier: EnergyCarrier): MeterKind {
  return carrier === 'gas' ? 'gas' : carrier === 'electric' ? 'electricity' : 'heat';
}

const pick = (text: string): InfoHintParagraph => ({ lead: t('Pick:'), text });
const empty = (text: string): InfoHintParagraph => ({ lead: t('If empty:'), text });

/** What a meter is for, how the add-on reads it and what to pick. */
export function meterHint(kind: MeterKind, source: { kind: SourceKind; carrier: EnergyCarrier }): InfoHintContent {
  const product = brand.productName;
  const reads = t('{product} keeps no readings of its own: it reads the meter’s long-term statistics in Home Assistant for the hours, days and months, and its state history for single runs. A reset or a replaced meter is skipped, not counted as use.', { product });
  if (kind === 'gas')
    return {
      title: t('The gas meter: a counter of the gas used, in m³, ft³ or kWh.'),
      text: [
        reads,
        t('A meter shared with a stove or a water heater: the hours, days and months show all it counted; a single run gets only the gas used while this source ran.'),
        pick(t('a sensor with device class gas and state class total_increasing — e.g. sensor.gas_meter. A pulse counter (ESPHome, Shelly) works once it has a unit and a state class.')),
        empty(t('no gas or cost is shown; the running time still is.')),
      ],
    };
  if (kind === 'electricity')
    return {
      title: t('What this source draws from the grid: an energy counter in kWh, or a power sensor in W or kW.'),
      text: [
        reads,
        t('A power sensor is added up over time, so its amounts are estimates.'),
        pick(
          source.carrier === 'gas'
            ? t('the energy sensor of the boiler’s smart plug — the pump and the electronics, e.g. sensor.boiler_plug_energy.')
            : t('an energy sensor with state class total_increasing — e.g. sensor.heat_pump_energy — or the source’s power sensor.'),
        ),
        empty(t('no electricity or cost is shown for this source.')),
      ],
    };
  return {
    title: t('A heat meter on the flow: the heat this source delivered, in kWh.'),
    text: [
      reads,
      source.carrier === 'gas'
        ? t('With it the efficiency is shown: heat delivered ÷ the energy of the gas (the calorific value is set in Settings).')
        : t('With it the COP is shown: heat delivered ÷ electricity used.'),
      pick(t('the heat energy sensor of the heat meter or of the heat pump — e.g. sensor.heat_pump_heat_energy.')),
      empty(t('no efficiency is shown.')),
    ],
  };
}

/** The COP tile of a heat pump with a heat meter. */
export function copHint(): InfoHintContent {
  return {
    title: t('COP: the heat delivered for each unit of electricity.'),
    text: [
      t('A COP of 3 means 3 kWh of heat for every kWh of electricity. It falls in frost and when the water has to be hotter, so a cold period shows a lower value without anything being wrong.'),
    ],
  };
}

/** The efficiency tile of a gas boiler with a heat meter. */
export function efficiencyHint(): InfoHintContent {
  return {
    title: t('Efficiency: the heat delivered ÷ the energy of the gas burnt.'),
    text: [
      t('The energy of the gas comes from the calorific value in Settings. A condensing boiler gets less out of the gas when the water comes back hot, so a high flow temperature lowers it.'),
    ],
  };
}

/** Heating degree-days, explained once for the tile and the chart; `what` is the counted kind («Газ», «Електрика»). */
export function degreeDayHint(baseC: string, what: string): InfoHintContent {
  return {
    title: t('{what} per degree-day: how much each degree of cold took.', { what }),
    text: [
      t('A degree-day is one degree below {base} outdoors for a whole day; a day at 3° is 15 degree-days. The outdoor temperature is the combined value of the outdoor sensors.', { base: baseC }),
      t('Dividing by degree-days takes the weather out: a lower number means the house or the source got more efficient, not that the month was warmer.'),
    ],
  };
}
