/**
 * The «i» explanations of a circuit's Home Assistant bindings and pump settings: what each one is,
 * how the add-on uses it, what to pick and what happens without it — as the pump and circuit
 * logic of the engine actually behaves.
 */
import type { CircuitKind } from '@api/model';
import type { InfoHintContent, InfoHintParagraph } from '@ui';
import { brand } from '@brand';
import { fmtDur, fmtTemp, t } from '@i18n';

const pick = (text: string): InfoHintParagraph => ({ lead: t('Pick:'), text });
const empty = (text: string): InfoHintParagraph => ({ lead: t('If empty:'), text });

/** The pump entity: when it is switched besides the circuit's mode. */
export function pumpHint(minOnSec: number | null, modeLabel: string): InfoHintContent {
  const product = brand.productName;
  return {
    title: t('The switch, plug or relay that powers the circulation pump of this circuit.'),
    text: [
      t('{product} switches it as «{mode}» says and, once on, keeps it on for at least {min}.', {
        product,
        mode: modeLabel,
        min: minOnSec != null && minOnSec % 60 !== 0 ? t('{n} s', { n: minOnSec }) : fmtDur((minOnSec ?? 60) / 60),
      }),
      {
        lead: t('In any mode it is also on:'),
        text: t('for frost in a room of the circuit; when a running boiler or heat pump has no other pump moving water; while a source finishes its minimum run or waits to start; during a source test; for the weekly anti-seize run, if it is on.'),
      },
      pick(t('a switch, input_boolean, fan, valve or light — e.g. switch.floor_pump.')),
      empty(t('the circuit has no pump: {product} moves no water for it, and its sources start without a pump run first.', { product })),
    ],
  };
}

/** What the two modes of a circuit do, in the order the pump, the valves and the source act. */
export function circuitModeHint(kind: CircuitKind): InfoHintContent {
  if (kind === 'floor') {
    return {
      title: t('How the floor pump, the zone valves and the heat source work together.'),
      text: [
        {
          lead: t('The whole floor:'),
          text: t('the usual «floor pump with the boiler». The pump runs whenever a source that feeds the floor runs, and the run-on after it stops. The rooms only ask for heat: one colder than its target starts the source. No zone valves are needed.'),
        },
        {
          lead: t('By zones:'),
          text: t('every room has its own valve or floor thermostat. A room colder than its target opens its zone, the pump starts unless another zone already runs it, and the source is asked for heat. A warm room closes its zone; after the last zone closes the pump runs on and stops.'),
        },
        t('A source never pushes water against closed zones: without a bypass, the zones open while a boiler finishes its minimum run. Frost protection runs the pump in either mode.'),
      ],
    };
  }
  return {
    title: t('When the radiator pump runs.'),
    text: [
      {
        lead: t('By the rooms:'),
        text: t('while a room of the circuit asks for heat — its smart heads open, or a room with ordinary radiators is colder than its target — and the run-on after the last one is warm.'),
      },
      {
        lead: t('With the source:'),
        text: t('whenever a source that feeds the radiators runs, and the run-on after it stops.'),
      },
      t('A room with ordinary radiators works like a room thermostat in either mode: below its target it starts the source and this pump. Frost protection runs the pump in either mode.'),
    ],
  };
}

/** Who is on a circuit and what that means for a room. */
export function circuitRoomsHint(kind: CircuitKind): InfoHintContent {
  const product = brand.productName;
  return kind === 'floor'
    ? {
        title: t('The rooms whose floor hangs on this loop.'),
        text: [
          t('Each room asks for heat by its own temperature. On a zoned floor its valve opens only for it; without a valve its floor gets water whenever the pump runs.'),
          t('Taking a room off stops its floor heating from here; the room keeps its other heating.'),
        ],
      }
    : {
        title: t('The rooms whose radiators hang on this loop.'),
        text: [
          t('With smart heads {product} turns each head; with ordinary valves the room switches the source and this pump by its temperature.', { product }),
          t('Taking a room off: its heads get their own setpoints back, and it no longer starts the source or the pump.'),
        ],
      };
}

export function runOnHint(): InfoHintContent {
  return {
    title: t('How long the pump keeps running after the source stops (the whole floor) or after the last room is warm (by zones or rooms).'),
    text: [
      t('The heat left in the boiler and the pipes still reaches the rooms. A new demand during the run-on simply keeps the pump on; run-ons do not add up.'),
      t('New pumps get 3 min for radiators and 10 min for a floor. 0 — the pump stops at once (after its minimum on time).'),
    ],
  };
}

export function bypassHint(): InfoHintContent {
  return {
    title: t('A bypass valve, or a loop that is never fully shut, lets water circulate while every zone is closed.'),
    text: [
      t('Without one, while a source must keep running (its minimum run, a check run), {product} opens all zones so the pump never pushes against closed valves.', { product: brand.productName }),
      t('Tick it only when the bypass is really there.'),
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
