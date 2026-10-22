/**
 * The «i» explanations of a source's Home Assistant bindings: for each role what it is, how the
 * add-on uses it, what to pick and what happens when it stays empty. The numbers come from the
 * source itself (its guards, energy, relay timer), so the text matches what the engine does.
 */
import type { InfoHintContent, InfoHintParagraph } from '@ui';
import type { SourceAdapter, SourceEnergy, SourceGuards, SourceKind } from '@api/model';
import { brand } from '@brand';
import { adapterLabel, fmtDur, fmtKw, t } from '@i18n';
import { roleLabel } from './bindings';

/** What a hint needs to know about the source (a saved one or the draft of a new one). */
export interface HintSource {
  kind: SourceKind;
  adapter: SourceAdapter;
  energy: SourceEnergy;
  guards: SourceGuards;
}

const pick = (text: string): InfoHintParagraph => ({ lead: t('Pick:'), text });
const empty = (text: string): InfoHintParagraph => ({ lead: t('If empty:'), text });

const isBoiler = (k: SourceKind) => k === 'gas_boiler' || k === 'electric_boiler';
const isHeater = (k: SourceKind) => k === 'electric_radiator' || k === 'electric_floor' || k === 'ir_panel';

/** «котел», «обігрівач»… — the same form fits both «X лишиться» and «вимкне X». */
function noun(k: SourceKind): string {
  if (isBoiler(k)) return t('the boiler');
  if (isHeater(k)) return t('the heater');
  if (k === 'heat_pump') return t('the heat pump');
  if (k === 'ac') return t('the air conditioner');
  return t('the source');
}

function commandHint(s: HintSource): InfoHintContent {
  const product = brand.productName;
  const g = s.guards;
  const title =
    s.kind === 'gas_boiler'
      ? t('The relay that starts the boiler — usually wired to its room-thermostat (dry contact) terminals.')
      : s.kind === 'electric_boiler'
        ? t('The relay or contactor of the boiler’s first stage.')
        : isHeater(s.kind)
          ? t('The smart plug or relay that powers the heater.')
          : t('The switch that turns the source on and off.');
  const example = s.kind === 'gas_boiler' ? 'switch.boiler_relay' : isHeater(s.kind) ? 'switch.bedroom_heater_plug' : 'switch.boiler_contactor';
  return {
    title,
    text: [
      t('{product} switches it on when a room needs this source and off when the demand ends, keeping the minimum run and pause.', { product }),
      t('A start counts once the switch reads back «on». No «on» within {confirm}, or unavailable for {unavailable}, is a fault: the next source in the chain takes over.', {
        confirm: fmtDur(g.startConfirmTimeoutMin),
        unavailable: fmtDur(g.unavailableAfterMin),
      }),
      pick(t('a switch, input_boolean, light, valve or fan — e.g. {example}.', { example })),
      empty(t('the source cannot be switched and stays out of use.')),
    ],
  };
}

function stageHint(s: HintSource): InfoHintContent {
  return {
    title: t('The relay of one more heating element; stage 1 is «{first}».', { first: roleLabel('command') }),
    text: [
      t('{product} adds the next stage when a served room stays cold for {dur} and the energy budget allows it, and drops stages once every room is comfortable or the budget is exceeded. Each stage counts in the budget with its own power.', {
        product: brand.productName,
        dur: fmtDur(s.guards.stageUpAfterMin),
      }),
      pick(t('the switch of that element’s relay or contactor — e.g. switch.boiler_stage_2.')),
      empty(t('the stage is removed; the boiler runs with the stages left.')),
    ],
  };
}

function watchdogHint(s: HintSource): InfoHintContent {
  const product = brand.productName;
  const wd = s.adapter.type === 'relay' && s.adapter.watchdog.kind === 'countdown_number' ? s.adapter.watchdog : null;
  // a new timer gets 15 min, renewed every 5 (see setRole)
  const min = fmtDur(wd?.minutes ?? 15);
  const every = fmtDur(wd?.rearmEveryMin ?? 5);
  return {
    title: t('Hardware fail-safe: the relay’s own countdown that switches it off by itself.'),
    text: [
      t('While {what} should run, {product} sets the countdown to {min} and renews it every {every}. If {product} or Home Assistant stops, nobody renews it and the relay switches {what} off within {min}.', {
        what: noun(s.kind),
        product,
        min,
        every,
      }),
      pick(t('a number of the same relay that counts in minutes — e.g. number.boiler_relay_countdown («countdown», «auto off»). A counter in seconds would switch off almost at once.')),
      empty(t('if {product} or Home Assistant stops, the relay stays in its last state and {what} keeps running.', { product, what: noun(s.kind) })),
    ],
  };
}

function confirmHint(s: HintSource): InfoHintContent {
  const test = t('Test for 2 min');
  const type = s.adapter.type;
  const how =
    type === 'script' || type === 'custom'
      ? t('Scripts give no read-back, so a start counts only when this signal shows the source runs; nothing within {dur} is a fault, and the next source takes over.', {
          dur: fmtDur(s.guards.startConfirmTimeoutMin),
        })
      : type === 'climate'
        ? t('Day to day a start counts once the climate shows the commanded mode. This signal proves the unit really works: «{test}» passes only on it.', { test })
        : t('Day to day a start counts once the switch reads back «on». This signal proves the source really works: «{test}» passes only on it.', { test });
  return {
    title: t('A signal that the source really works, not only that its switch is on.'),
    text: [
      how,
      t('A power sensor here also catches a source still drawing power 2 minutes after «off»: it is reported and gets «off» again every minute.'),
      pick(
        s.kind === 'gas_boiler'
          ? t('a flame or burner binary_sensor — e.g. binary_sensor.boiler_flame — or a power sensor of the boiler (above 50 W counts as running).')
          : t('a power sensor of the device or its plug (above 50 W counts as running), or a binary_sensor that is «on» while it runs.'),
      ),
      empty(
        type === 'script' || type === 'custom'
          ? t('a start counts at once, without any proof.')
          : s.kind === 'gas_boiler'
            ? t('only the relay read-back is checked — a boiler that is on but does not fire (no gas, a lockout) goes unnoticed.')
            : t('only the read-back of the switch is checked — a source that is on but does not really run goes unnoticed.'),
      ),
    ],
  };
}

function powerExample(k: SourceKind): string {
  if (isBoiler(k)) return 'sensor.boiler_plug_power';
  if (isHeater(k)) return 'sensor.bedroom_heater_plug_power';
  if (k === 'heat_pump') return 'sensor.heat_pump_power';
  if (k === 'ac') return 'sensor.bedroom_ac_power';
  return 'sensor.source_power';
}

function powerHint(s: HintSource): InfoHintContent {
  const e = s.energy;
  const how =
    e.carrier === 'gas'
      ? t('A gas boiler counts in the energy budget with its electronics only ({kw}), so this reading is for information.', { kw: fmtKw(e.auxPowerKw) })
      : e.countsInBlackoutBudget
        ? t('While the source runs, the energy budget (blackout, battery) counts this measured power instead of the nominal {kw}, and the source shows it.', { kw: fmtKw(e.maxPowerKw) })
        : t('This source is not in the blackout budget, so the reading is only shown.');
  return {
    title: t('The measured electric power of the source, in W or kW.'),
    text: [
      how,
      pick(t('a power sensor of the same device or of its smart plug — e.g. {example}.', { example: powerExample(s.kind) })),
      empty(
        e.carrier !== 'gas' && e.countsInBlackoutBudget
          ? t('the budget uses the nominal power from «{energy}» ({kw}).', { energy: t('Energy'), kw: fmtKw(e.maxPowerKw) })
          : t('nothing changes for control.'),
      ),
    ],
  };
}

function climateHint(s: HintSource): InfoHintContent {
  const title =
    s.kind === 'heat_pump'
      ? t('The climate entity of the heat pump in Home Assistant.')
      : s.kind === 'ac'
        ? t('The climate entity of the air conditioner in Home Assistant.')
        : t('The climate entity of the source in Home Assistant.');
  return {
    title,
    text: [
      t('{product} sets its HVAC mode by «{modes}» and its target by «{given}»; the target moves only by 0.5° or more and at most every 10 minutes.', {
        product: brand.productName,
        modes: t('Modes'),
        given: t('What it is given'),
      }),
      t('A start counts once it shows the commanded mode; not within {dur} — a fault, and the next source takes over.', { dur: fmtDur(s.guards.startConfirmTimeoutMin) }),
      pick(t('a climate entity — e.g. climate.heat_pump or climate.bedroom_ac.')),
      empty(t('the source cannot be switched and stays out of use.')),
    ],
  };
}

function defrostHint(): InfoHintContent {
  return {
    title: t('Shows that the heat pump is defrosting its outdoor unit.'),
    text: [
      t('While it defrosts, the heat pump counts as running and confirmed — no fault — and the «heat pump cannot keep up» timer that calls the reserve pauses.'),
      pick(t('a binary_sensor of the same unit that is «on» while defrosting — e.g. binary_sensor.heat_pump_defrost.')),
      empty(t('defrosting is recognised only when the climate reports hvac_action «defrosting».')),
    ],
  };
}

function errorHint(s: HintSource): InfoHintContent {
  const ok = s.adapter.type === 'climate' ? s.adapter.errorOkValues : ['0', 'ok', 'none', ''];
  const list = ok.map((v) => (v === '' ? t('empty') : `«${v}»`)).join(', ');
  return {
    title: t('The error code the device reports.'),
    text: [
      t('While the source runs, any value other than {list} is a fault: the next source takes over and this one is retried after {dur}. The code is shown on the source.', {
        list,
        dur: fmtDur(s.guards.faultRetryMin),
      }),
      pick(t('a sensor with the code — e.g. sensor.heat_pump_error_code. Not an on/off problem sensor: its «off» would read as an error.')),
      empty(t('device errors are not detected; a stopped unit is noticed only when it stops showing the commanded mode.')),
    ],
  };
}

function copHint(): InfoHintContent {
  return {
    title: t('The heat pump’s current efficiency: heat delivered per unit of electricity.'),
    text: [
      t('Shown on the source while it runs; {product} makes no decisions by it.', { product: brand.productName }),
      pick(t('a sensor of the same unit — e.g. sensor.heat_pump_cop.')),
      empty(t('only the figure is missing.')),
    ],
  };
}

function supplyHint(s: HintSource): InfoHintContent {
  if (s.adapter.type === 'climate')
    return {
      title: t('The water temperature leaving the heat pump (its flow).'),
      text: [
        t('Shown on the source and the schema; {product} does not control by it.', { product: brand.productName }),
        pick(t('a temperature sensor of the unit — e.g. sensor.heat_pump_flow_temperature.')),
        empty(t('the flow sensor of a circuit it feeds is shown instead, if there is one.')),
      ],
    };
  return {
    title: t('The flow temperature the source actually delivers.'),
    text: [
      t('Its value is shown in this table to compare with the setpoint; {product} does not control by it.', { product: brand.productName }),
      pick(t('a temperature sensor of the boiler or heat pump — e.g. sensor.boiler_flow_temperature.')),
      empty(t('only the comparison is missing.')),
    ],
  };
}

function flowSetpointHint(s: HintSource): InfoHintContent {
  const product = brand.productName;
  const relay = s.adapter.type === 'relay';
  return {
    title: t('A number entity with the flow (supply water) temperature setpoint of the boiler or heat pump.'),
    text: [
      relay
        ? t('While the boiler runs and the curve is on, {product} writes the flow temperature from the weather curve below into it; it moves only by 0.5° or more and at most every 10 minutes.', { product })
        : t('While the source runs, {product} writes the flow temperature from the weather curve below (in cooling, the dew-safe flow); it moves only by 0.5° or more and at most every 10 minutes.', { product }),
      pick(t('a number in °C — e.g. number.boiler_flow_setpoint.')),
      empty(relay ? t('the boiler keeps its own flow setting.') : t('the source cannot be given its flow temperature.')),
    ],
  };
}

function enableHint(s: HintSource): InfoHintContent {
  return {
    title: t('The switch that allows the boiler or heat pump to heat («heating enabled», OpenTherm CH enable).'),
    text: [
      t('{product} turns it on while the source should run and off otherwise. A start counts once it reads back «on»; not within {dur} — a fault, and the next source takes over.', {
        product: brand.productName,
        dur: fmtDur(s.guards.startConfirmTimeoutMin),
      }),
      pick(t('a switch or input_boolean — e.g. switch.boiler_ch_enable.')),
      empty(t('the source cannot be switched and stays out of use.')),
    ],
  };
}

function modeSelectHint(): InfoHintContent {
  return {
    title: t('A select entity with the heat pump’s operating mode.'),
    text: [
      t('While the source runs, {product} picks the option set for heating or for cooling (e.g. «heat» / «cool»).', { product: brand.productName }),
      pick(t('a select — e.g. select.heat_pump_mode.')),
      empty(t('the mode stays as it is set on the device.')),
    ],
  };
}

function scriptOnHint(): InfoHintContent {
  return {
    title: t('A Home Assistant script that starts the source in this mode.'),
    text: [
      t('{product} runs it once at every start in this mode, with the variables mode and setpoint. Scripts give no read-back, so also choose «{proof}».', {
        product: brand.productName,
        proof: roleLabel('confirm'),
      }),
      pick(t('a script — e.g. script.ac_heat.')),
      empty(t('the source cannot run in this mode.')),
    ],
  };
}

function scriptOffHint(): InfoHintContent {
  return {
    title: t('A Home Assistant script that stops the source.'),
    text: [
      t('{product} runs it once at every stop.', { product: brand.productName }),
      pick(t('a script — e.g. script.ac_off.')),
      empty(t('the source cannot be switched off and stays out of use.')),
    ],
  };
}

/** The explanation of one binding role of a source (rows of the «Entities» table). */
export function bindingHint(role: string, s: HintSource): InfoHintContent | undefined {
  if (/^stage\d+$/.test(role)) return stageHint(s);
  if (role.startsWith('on_')) return scriptOnHint();
  switch (role) {
    case 'command':
      return commandHint(s);
    case 'watchdog':
      return watchdogHint(s);
    case 'confirm':
      return confirmHint(s);
    case 'power':
      return powerHint(s);
    case 'climate':
      return climateHint(s);
    case 'defrost':
      return defrostHint();
    case 'error':
      return errorHint(s);
    case 'cop':
      return copHint();
    case 'supply':
    case 'actual_flow':
      return supplyHint(s);
    case 'flow':
      return flowSetpointHint(s);
    case 'enable':
      return enableHint(s);
    case 'mode':
    case 'mode_select':
      return modeSelectHint();
    case 'off':
      return scriptOffHint();
    default:
      return undefined;
  }
}

/** «Режими»: how the add-on's modes map onto the climate's HVAC modes. */
export function modesHint(): InfoHintContent {
  return t('Which HVAC mode of the climate entity {product} sets for each of its modes. Filled in from the modes the device offers when the climate entity is chosen.', {
    product: brand.productName,
  });
}

/** «Що задавати»: the setpoint the climate entity gets while running. */
export function setpointHint(adapter: SourceAdapter): InfoHintContent | undefined {
  if (adapter.type !== 'climate') return undefined;
  const product = brand.productName;
  switch (adapter.setpoint) {
    case 'flow_curve':
      return t('The flow temperature from the weather curve below: the colder outside, the warmer the water.');
    case 'room_target':
      return t('The target of the rooms it serves — the highest one when heating, the lowest when cooling. A room air conditioner also gets a learned correction for its own sensor under the ceiling (at most ±3°).');
    case 'fixed':
      return t('A fixed setpoint for heating and one for cooling.');
    case 'none':
      return t('No setpoint: {product} only switches it on and off, and the unit keeps its own target.', { product });
  }
}

/** «Працює» for a climate entity: its hvac_action. */
export function hvacProofHint(): InfoHintContent {
  return t('The climate’s hvac_action (heating, cooling, drying, fan, defrosting) shows the unit really runs; «{test}» passes only on it. Day to day a start counts once the climate shows the commanded mode.', {
    test: t('Test for 2 min'),
  });
}

/** «Керування з Home Assistant»: the ways of control. */
export function controlHint(): InfoHintContent {
  return {
    title: t('How the add-on reaches the device'),
    bullets: [
      t('{name} — one switch turns the source on and off (dry contact, smart plug, contactor).', { name: adapterLabel('relay') }),
      t('{name} — the climate entity gets the mode and the target (heat pump, air conditioner).', { name: adapterLabel('climate') }),
      t('{name} — an enable switch plus a flow-temperature number (a boiler or heat pump with a flow setpoint).', { name: adapterLabel('flow') }),
      t('{name} — your Home Assistant scripts per mode and for off.', { name: adapterLabel('script') }),
    ],
  };
}
