/**
 * The electricity meter of a pump: the energy sensor of the plug or relay it is switched by. Bound
 * on the «Споживання» page and on the pump's card in its circuit; the plug's own energy sensor is
 * offered first.
 */
import { useState } from 'react';
import type { ConsumptionMeterDto, Pump } from '@api/model';
import { api } from '@api/endpoints';
import { useMutation } from '@data';
import { EntityBindingTable, type EntityBindingRow, type InfoHintContent, type InfoHintParagraph } from '@ui';
import { brand } from '@brand';
import { t } from '@i18n';
import { MeterDialog, meterRowStatus } from '../sources/Consumption';

const pick = (text: string): InfoHintParagraph => ({ lead: t('Pick:'), text });
const empty = (text: string): InfoHintParagraph => ({ lead: t('If empty:'), text });

/** What a pump's meter is for and what to pick. */
export function pumpMeterHint(): InfoHintContent {
  return {
    title: t('What this pump draws from the grid: the energy sensor of its smart plug, in kWh, or a power sensor in W.'),
    text: [
      t('{product} keeps no readings of its own: it reads the meter’s long-term statistics in Home Assistant. A power sensor is added up over time, so its amounts are estimates.', { product: brand.productName }),
      pick(t('the energy sensor of the plug the pump is switched by — e.g. sensor.floor_pump_plug_energy. A plug that switches the boiler belongs to the boiler, on its page.')),
      empty(t('the pump’s electricity is not counted.')),
    ],
  };
}

/** The energy sensor on the pump's own device (its plug), else its power sensor. */
async function plugMeter(pump: Pump): Promise<string | null> {
  try {
    const d = await api.ha.entity(pump.entityId);
    return d.siblings.find((s) => s.role === 'energy')?.entityId ?? d.siblings.find((s) => s.role === 'power')?.entityId ?? null;
  } catch {
    return null;
  }
}

/** One row per pump: its meter, its state, «choose» when it has none. `label` names the pump as the page lists it. */
export function PumpMetersTable({
  pumps,
  label,
  live,
  editable,
  onSaved,
}: {
  pumps: Pump[];
  label: (p: Pump) => string;
  /** The meters as the last consumption answer read them (their status); null when not loaded. */
  live: Record<string, ConsumptionMeterDto | undefined> | null;
  editable: boolean;
  onSaved: (p: Pump) => void;
}) {
  const [picking, setPicking] = useState<{ pump: Pump; suggested: string | null } | null>(null);
  const save = useMutation(
    async (pump: Pump, entityId: string | null) => {
      let unit: string | null = null;
      if (entityId) {
        try {
          unit = (await api.ha.entity(entityId)).entity.unit;
        } catch {
          // the server reads the live unit anyway; the stored one is a fallback
        }
      }
      return api.pumps.patch(pump.id, { meter: entityId ? { kind: 'electricity', entityId, unit } : null });
    },
    { onSuccess: onSaved, okToast: t('Meter saved') },
  );
  const open = async (pump: Pump) => setPicking({ pump, suggested: pump.meter ? null : await plugMeter(pump) });
  const rows: EntityBindingRow[] = pumps.map((p) => {
    const m = p.meter;
    const l = m ? live?.[p.id] : undefined;
    const status = m ? (l && l.entityId === m.entityId ? meterRowStatus(l) : { status: 'info' as const }) : { status: 'info' as const, statusLabel: t('optional') };
    return {
      role: label(p),
      value: m?.entityId ?? t('choose an entity'),
      mono: Boolean(m),
      live: l && m && l.entityId === m.entityId ? [l.unit, l.reading === 'power' ? t('power, added up') : null].filter(Boolean).join(' · ') || undefined : undefined,
      ...status,
      onPick: editable ? () => void open(p) : undefined,
      hint: pumpMeterHint(),
    };
  });
  return (
    <>
      <EntityBindingTable ariaLabel={t('Meters of the pumps')} rows={rows} />
      {picking ? (
        <MeterDialog
          kind="electricity"
          value={picking.pump.meter?.entityId ?? null}
          suggested={picking.suggested}
          onClose={() => setPicking(null)}
          onPick={(id) => {
            const pump = picking.pump;
            setPicking(null);
            void save.run(pump, id);
          }}
        />
      ) : null}
    </>
  );
}
