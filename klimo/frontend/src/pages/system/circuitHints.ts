/**
 * The «i» explanations of a circuit's Home Assistant bindings and pump settings: what each one is,
 * how the add-on uses it, what to pick and what happens without it — as the pump and circuit
 * logic of the engine actually behaves.
 */
import type { InfoHintContent, InfoHintParagraph } from '@ui';
import { brand } from '@brand';
import { fmtDur, fmtTemp, t } from '@i18n';

const pick = (text: string): InfoHintParagraph => ({ lead: t('Pick:'), text });
const empty = (text: string): InfoHintParagraph => ({ lead: t('If empty:'), text });

/** The pump entity: when it is switched besides its rule. */
export function pumpHint(minOnSec: number | null): InfoHintContent {
  const product = brand.productName;
  return {
    title: t('The switch, plug or relay that powers the circulation pump of this circuit.'),
    text: [
      t('{product} switches it by the rule «{rule}» and, once on, keeps it on for at least {min}.', {
        product,
        rule: t('The pump runs when'),
        min: minOnSec != null && minOnSec % 60 !== 0 ? t('{n} s', { n: minOnSec }) : fmtDur((minOnSec ?? 60) / 60),
      }),
      {
        lead: t('Whatever the rule, it is also on:'),
        text: t('for frost in a room of the circuit; when a running boiler or heat pump has no other pump moving water; while a source finishes its minimum run or waits to start; during a source test; for the weekly anti-seize run, if it is on.'),
      },
      pick(t('a switch, input_boolean, fan, valve or light — e.g. switch.floor_pump.')),
      empty(t('the circuit has no pump: {product} moves no water for it, and its sources start without a pump run first.', { product })),
    ],
  };
}

/** The three pump rules. */
export function pumpRuleHint(label: { rooms: string; source: string; both: string }): InfoHintContent {
  return {
    bullets: [
      t('«{rule}» — while a room of the circuit has its valve or zone open; with every valve closed the pump stops, even while a source runs.', { rule: label.rooms }),
      t('«{rule}» — while a source feeding the circuit runs, like the usual «pump with the boiler» automation.', { rule: label.source }),
      t('«{rule}» — only while a source runs and a room of the circuit asks.', { rule: label.both }),
    ],
  };
}

export function runOnHint(): InfoHintContent {
  return {
    title: t('How long the pump keeps running after its rule falls.'),
    text: [
      t('The heat left in the boiler and the pipes still reaches the rooms. A new demand during the run-on simply keeps the pump on; run-ons do not add up.'),
      t('New pumps get 3 min for radiators and 10 min for a floor. 0 — the pump stops at once (after its minimum on time).'),
    ],
  };
}

export function flowSensorHint(frostC: number | null, cool: boolean): InfoHintContent {
  const frost = fmtTemp(frostC ?? 10, { decimals: 0 });
  return {
    title: t('The water temperature in the flow pipe of the circuit (after the mixing valve, if there is one).'),
    text: [
      t('Heating: below {frost} for 10 minutes while a source heats — a frost-risk alert. Shown on the schema and on the sources that feed the circuit.', { frost }),
      ...(cool
        ? [
            t('Floor cooling: when the flow comes closer to the dew point than the margin for 2 minutes, cooling stops and the floor rests 30 min; three stops within 2 hours lock cooling until midnight.'),
          ]
        : []),
      pick(t('a temperature sensor on the flow pipe — e.g. sensor.floor_flow_temperature.')),
      empty(
        cool
          ? t('no alert about cold water, and floor cooling is guarded only by the computed flow, not by a measured one.')
          : t('no alert about cold water in the circuit.'),
      ),
    ],
  };
}

export function returnSensorHint(): InfoHintContent {
  return {
    title: t('The water temperature in the return pipe of the circuit.'),
    text: [
      t('Shown on the schema next to the flow, so the difference is visible; {product} does not control by it.', { product: brand.productName }),
      pick(t('a temperature sensor on the return pipe — e.g. sensor.floor_return_temperature.')),
      empty(t('only the flow is shown.')),
    ],
  };
}

export function mixingValveHint(): InfoHintContent {
  return {
    title: t('A number entity with the flow temperature the mixing valve keeps — not its opening in %.'),
    text: [
      t('While the circuit heats, {product} writes «{setting}» into it; while it cools, the flow that stays safely above the dew point.', {
        product: brand.productName,
        setting: t('Valve mixes the heating flow down to'),
      }),
      pick(t('a number in °C of the valve controller — e.g. number.floor_mixing_valve.')),
      empty(t('no mixing: the circuit gets the water as the source makes it.')),
    ],
  };
}

export function mixingHeatHint(): InfoHintContent {
  return t('The flow temperature the valve holds while the circuit heats. It is fixed: the weather curve of the source does not change it.');
}
