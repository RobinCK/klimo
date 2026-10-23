/**
 * What a source used, in words: the period being looked at and its neighbours, the axis and
 * tooltip labels of the buckets, the change against the period before, prices, and the «i»
 * explanations of the meters. Dates are the Home Assistant zone's.
 */
import type {
  ConsumptionBucket,
  ConsumptionRange,
  EnergyCarrier,
  EnergyTariffs,
  LocalDate,
  MeterKind,
  SourceConsumptionDto,
  SourceKind,
} from '@api/model';
import type { InfoHintContent, InfoHintParagraph } from '@ui';
import { brand } from '@brand';
import { fmtChange, fmtDate, fmtMoney, fmtTime, monthLong, monthShort, t, unitLabel, weekdayShort, zonedParts } from '@i18n';

/* ---------------- periods ---------------- */

const pad = (n: number) => String(n).padStart(2, '0');

function parts(d: LocalDate): { y: number; m: number; d: number } {
  const [y, m, day] = d.split('-').map(Number);
  return { y, m, d: day };
}

function fromUtc(ms: number): LocalDate {
  const x = new Date(ms);
  return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}`;
}

/** Calendar arithmetic on plain dates (no time zone involved). */
function addDays(d: LocalDate, n: number): LocalDate {
  const p = parts(d);
  return fromUtc(Date.UTC(p.y, p.m - 1, p.d + n));
}

/** First day of the period of `range` that holds `date` (weeks start on Monday, as the server counts them). */
export function periodStart(range: ConsumptionRange, date: LocalDate): LocalDate {
  const p = parts(date);
  if (range === 'day') return date;
  if (range === 'month') return `${p.y}-${pad(p.m)}-01`;
  if (range === 'year') return `${p.y}-01-01`;
  const dow = (new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay() + 6) % 7;
  return addDays(date, -dow);
}

/** The first day of the period after the one starting on `start`. */
export function nextPeriod(range: ConsumptionRange, start: LocalDate): LocalDate {
  const p = parts(start);
  if (range === 'day') return addDays(start, 1);
  if (range === 'week') return addDays(start, 7);
  if (range === 'month') return fromUtc(Date.UTC(p.y, p.m, 1));
  return `${p.y + 1}-01-01`;
}

/** «Today», «Tue, 20 Oct», «This week», «13 Oct – 19 Oct», «October 2026», «2026». */
export function periodLabel(dto: Pick<SourceConsumptionDto, 'range' | 'date' | 'from' | 'to' | 'now'>): string {
  const today = zonedParts(dto.now).date;
  const p = parts(dto.date);
  const current = dto.from <= dto.now && dto.now < dto.to;
  switch (dto.range) {
    case 'day':
      if (dto.date === today) return t('Today');
      if (dto.date === addDays(today, -1)) return t('Yesterday');
      return p.y === parts(today).y ? fmtDate(dto.from, 'weekday') : fmtDate(dto.from, 'long');
    case 'week':
      return current ? t('This week') : `${fmtDate(dto.from)} – ${fmtDate(dto.to - 1)}`;
    case 'month':
      return `${monthLong(p.m)} ${p.y}`;
    case 'year':
      return String(p.y);
  }
}

/** Axis label and full name of a bucket. */
export function bucketLabels(dto: Pick<SourceConsumptionDto, 'range' | 'bucket'>, b: ConsumptionBucket): { label: string; title: string } {
  const z = zonedParts(b.start);
  if (dto.bucket === 'hour') return { label: pad(z.hour), title: `${fmtTime(b.start)}–${fmtTime(b.end)}` };
  if (dto.bucket === 'month') return { label: monthShort(z.month), title: `${monthLong(z.month)} ${z.year}` };
  if (dto.range === 'week') return { label: weekdayShort(z.dow), title: fmtDate(b.start, 'weekday') };
  return { label: String(z.day), title: fmtDate(b.start, 'weekday') };
}

/* ---------------- amounts ---------------- */

/** How the period compares with the one before («+12% vs yesterday at this time»). */
export function changeText(dto: SourceConsumptionDto, kind: MeterKind): string | null {
  // against a period recorded only in part a percentage would mislead (+2653 %)
  if (!dto.previous.complete) return dto.previous.totals[kind] != null ? t('the period before is only partly recorded') : null;
  const pct = fmtChange(dto.totals[kind], dto.previous.totals[kind]);
  if (!pct) return null;
  const running = dto.from <= dto.now && dto.now < dto.to;
  const text = running
    ? {
        day: t('{pct} vs yesterday at this time', { pct }),
        week: t('{pct} vs last week up to the same time', { pct }),
        month: t('{pct} vs last month up to the same day', { pct }),
        year: t('{pct} vs last year up to the same day', { pct }),
      }[dto.range]
    : {
        day: t('{pct} vs the day before', { pct }),
        week: t('{pct} vs the week before', { pct }),
        month: t('{pct} vs the month before', { pct }),
        year: t('{pct} vs the year before', { pct }),
      }[dto.range];
  return text;
}

export function kindLabel(kind: MeterKind): string {
  return kind === 'gas' ? t('Gas') : kind === 'electricity' ? t('Electricity') : t('Heat delivered');
}

export function meterLabel(kind: MeterKind): string {
  return kind === 'gas' ? t('Gas meter') : kind === 'electricity' ? t('Electricity meter') : t('Heat meter');
}

/** The price line under the cost («€1.05 per m³ · €0.30 per kWh»). */
export function priceText(tariffs: EnergyTariffs, kinds: readonly MeterKind[]): string | null {
  const parts: string[] = [];
  if (kinds.includes('gas') && tariffs.gasPrice != null)
    parts.push(t('{price} per {unit}', { price: fmtMoney(tariffs.gasPrice, tariffs.currency), unit: unitLabel(tariffs.gasPriceUnit) }));
  if (kinds.includes('electricity') && tariffs.electricityPerKwh != null)
    parts.push(t('{price} per {unit}', { price: fmtMoney(tariffs.electricityPerKwh, tariffs.currency), unit: unitLabel('kWh') }));
  return parts.length ? parts.join(' · ') : null;
}

/** Whether a price is set for anything the source's meters count. */
export function hasPrice(tariffs: EnergyTariffs, kinds: readonly MeterKind[]): boolean {
  return (kinds.includes('gas') && tariffs.gasPrice != null) || (kinds.includes('electricity') && tariffs.electricityPerKwh != null);
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
