/**
 * Energy prices: what a kWh of electricity and a m³ (or a kWh) of gas cost, the currency they
 * are shown in, and the calorific value of the gas, which turns cubic metres into kilowatt-hours.
 * The consumption of sources with meters shows its cost with these. Every field saves by itself.
 */
import type { EnergyTariffs, GasPriceUnit, SettingsBundle } from '@api/model';
import { GAS_PRICE_UNITS } from '@api/model';
import { api } from '@api/endpoints';
import { useAutosave } from '@data';
import { AutosaveStatus, NumberField, Section, SegmentedControl, Stack, TextField } from '@ui';
import { brand } from '@brand';
import { t } from '@i18n';

export function TariffsSection({ bundle, onSaved, canEdit }: { bundle: SettingsBundle; onSaved: (b: SettingsBundle) => void; canEdit: boolean }) {
  const auto = useAutosave<EnergyTariffs>(bundle.general.tariffs, async (tariffs) => onSaved(await api.settings.patchGeneral({ tariffs })), { debounceMs: 600 });
  const v = auto.value;
  const set = (p: Partial<EnergyTariffs>) => auto.set((prev) => ({ ...prev, ...p }));
  const currency = v.currency.trim();
  const perUnit = (unit: string) => (currency ? t('{currency} per {unit}', { currency, unit }) : t('per {unit}', { unit }));
  const unitName = (u: GasPriceUnit) => (u === 'kWh' ? t('kWh') : t('m³'));
  return (
    <Section
      title={t('Energy prices')}
      icon="bolt"
      subtitle={t('For the cost of what sources with meters used.')}
      action={<AutosaveStatus state={auto.state} retry={auto.retry} />}
    >
      <Stack gap="lg">
        <TextField
          label={t('Currency')}
          value={v.currency}
          onChange={(c) => set({ currency: c })}
          maxLength={8}
          placeholder={t('€, ₴, UAH')}
          help={t('As it is written next to an amount: a sign or a code.')}
          disabled={!canEdit}
        />
        <NumberField
          label={t('Electricity')}
          unit={perUnit(t('kWh'))}
          value={v.electricityPerKwh}
          min={0}
          max={100}
          step={0.01}
          precision={0.0001}
          placeholder={t('not set')}
          onChange={(electricityPerKwh) => set({ electricityPerKwh })}
          onClear={() => set({ electricityPerKwh: null })}
          disabled={!canEdit}
          hint={{
            title: t('The price of one kWh from the grid, as on the bill.'),
            text: [
              t('Electric sources with a meter or a power sensor show their cost with it. With a day and a night price, enter the one most of the heating runs at.'),
              t('Empty: the cost of electricity is not shown.'),
            ],
          }}
        />
        <Stack gap="xs">
          <NumberField
            label={t('Gas')}
            unit={perUnit(unitName(v.gasPriceUnit))}
            value={v.gasPrice}
            min={0}
            max={10000}
            step={0.01}
            precision={0.0001}
            placeholder={t('not set')}
            onChange={(gasPrice) => set({ gasPrice })}
            onClear={() => set({ gasPrice: null })}
            disabled={!canEdit}
            hint={{
              title: t('The price of gas, per m³ or per kWh — as the supplier bills it.'),
              text: [
                t('Gas sources with a meter show their cost with it. A meter in m³ with a price per kWh (or the other way round) is converted with the calorific value below.'),
                t('Empty: the cost of gas is not shown.'),
              ],
            }}
          />
          <SegmentedControl<GasPriceUnit>
            size="xs"
            ariaLabel={t('Gas is billed')}
            value={v.gasPriceUnit}
            options={GAS_PRICE_UNITS.map((u) => ({ value: u, label: t('per {unit}', { unit: unitName(u) }), disabled: !canEdit }))}
            onChange={(gasPriceUnit) => set({ gasPriceUnit })}
          />
        </Stack>
        <NumberField
          label={t('Calorific value of the gas')}
          unit={t('kWh per m³')}
          value={v.gasKwhPerM3}
          min={5}
          max={15}
          step={0.01}
          onChange={(gasKwhPerM3) => set({ gasKwhPerM3 })}
          disabled={!canEdit}
          hint={{
            title: t('How much energy one cubic metre of the gas holds.'),
            text: [
              t('Natural gas holds about 10.5 kWh per m³; the supplier prints the exact value on the bill (often 9.5–11).'),
              t('{product} uses it to price gas billed per kWh from a meter in m³, and for a boiler’s efficiency: heat delivered ÷ the energy of the gas burnt.', { product: brand.productName }),
            ],
          }}
        />
      </Stack>
    </Section>
  );
}
