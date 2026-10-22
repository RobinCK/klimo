/**
 * Explanations behind the «i» that more than one page area shows (a room's settings, the add-room
 * wizard, the defaults for new rooms). The numbers are the ones the caller passes, so a hint
 * always speaks of the value on screen; the defaults it names are the engine's own.
 */
import type { InfoHintContent } from '@ui';
import { t } from './core';
import { fmtDelta, fmtDur, fmtDurSec, fmtTemp } from './format';

interface Band {
  below: number;
  above: number;
}

/** Tolerance (hysteresis) of a room, with a worked example on the band shown. */
export function toleranceHint(heat: Band, targetC: number | null = null): InfoHintContent {
  const target = targetC ?? 21;
  return {
    title: t('A band around the target, so a source is not switched on and off for every tenth of a degree.'),
    text: [
      t('With {target} and −{below}/+{above}: heating starts at {on} and stops at {off}; in between the room keeps doing what it did.', {
        target: fmtTemp(target),
        below: fmtDelta(heat.below),
        above: fmtDelta(heat.above),
        on: fmtTemp(target - heat.below),
        off: fmtTemp(target + heat.above),
      }),
      t('Narrower — a steadier temperature, but more starts of the boiler or heat pump; wider — fewer starts, larger swings. Out of the box: ±{heat} for heating, ±{cool} for cooling.', {
        heat: fmtDelta(0.2),
        cool: fmtDelta(0.3),
      }),
    ],
  };
}

/** The shortest request of a room. */
export function minRequestHint(minutes: number): InfoHintContent {
  return t('Once the room asks for heat or cold, the request holds at least {dur}, even if the room reaches its target sooner, so a boiler is never started for just two minutes. An open window, a room switched off or overheating end it at once. Default: 5 min; 0 — no minimum.', {
    dur: fmtDur(minutes),
  });
}

/** How long a room sensor may stay silent before it is left out. */
export function sensorStaleHint(minutes: number): InfoHintContent {
  return t('A sensor that sends nothing for {dur} is left out until it reports again; the room is counted from the other sensors, or from the radiator valves. Battery sensors report rarely while the temperature holds steady, hence the default of 90 min.', {
    dur: fmtDur(minutes),
  });
}

/** The three delays of the window reaction. */
export function windowDelayHints(w: { openDelaySec: number; resumeDelaySec: number; remindAfterMin: number }): {
  open: InfoHintContent;
  resume: InfoHintContent;
  remind: InfoHintContent;
} {
  return {
    open: t('A window or door must stay open {dur} before the room reacts, so walking through a door does not stop the heating. Default: 60 s; 0 — at once.', {
      dur: fmtDurSec(w.openDelaySec),
    }),
    resume: t('After every window is closed again, the room waits {dur} before it heats or cools again, so the cold air at the sensor settles first. Default: 2 min.', {
      dur: fmtDurSec(w.resumeDelaySec),
    }),
    remind: t('One notification per opening when it is still open after {dur} while the room heats or cools. Default: 20 min.', {
      dur: fmtDur(w.remindAfterMin),
    }),
  };
}

/** What the four ways of driving a radiator valve do; `product` is the add-on's name. */
export function trvStrategiesHint(product: string): InfoHintContent {
  return {
    bullets: [
      t('«Room temperature → into the valve» — the valve gets the room temperature from your sensors and regulates by it itself. The smoothest; needs a valve with an external sensor input.'),
      t('«Dynamic offset» — {product} sets the valve’s temperature offset so its own reading matches the room (at most every {min} min, on a change of {step} or more). For valves without that input.', {
        product,
        step: fmtDelta(0.3),
        min: 10,
      }),
      t('«On / off» — {product} decides by the tolerance and sets {open} or {closed}. Works with any valve; the temperature swings more.', {
        product,
        open: fmtTemp(30, { decimals: 0 }),
        closed: fmtTemp(5, { decimals: 0 }),
      }),
      t('«Valve opening, %» — {product} sets how far the valve opens, re-computed every 5 min. The most precise, but more commands drain the battery faster.', { product }),
    ],
  };
}
