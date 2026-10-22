import type { Decision, Detection, HouseMode, Reason, Season, SeasonConfig, SeasonMemory, SeasonState, StepSeasonFn } from '../../shared/model';
import { seasonByMonth } from '../../shared/defaults';
import { toLocal } from './time';

/* =====================================================================================================
 * The season decides which comfort is allowed at all: no central heating in summer, no cooling in
 * winter. In `auto` it follows the N-day outdoor mean with a 1° hysteresis, a 6-hour confirmation and a
 * 24-hour minimum dwell, inside the month gates. A month gate closing ends its season at once. Frost
 * protection ignores all of this.
 * ===================================================================================================== */

const HOUR_MS = 3_600_000;

type Gates = Pick<SeasonState, 'heatAllowed' | 'coolAllowed'>;

/** What each season (or forced house mode) lets run: central = circuits, local = room-scope sources. */
export function seasonGates(houseMode: HouseMode, season: Season): Gates {
  if (houseMode === 'off') return { heatAllowed: { central: false, local: false, coldGuardOnly: false }, coolAllowed: { central: false, local: false } };
  const effective = houseMode === 'heat' ? 'heating' : houseMode === 'cool' ? 'cooling' : season;
  switch (effective) {
    case 'heating':
      return { heatAllowed: { central: true, local: true, coldGuardOnly: false }, coolAllowed: { central: false, local: false } };
    case 'cooling':
      return { heatAllowed: { central: false, local: false, coldGuardOnly: false }, coolAllowed: { central: true, local: true } };
    case 'neutral':
      return { heatAllowed: { central: false, local: true, coldGuardOnly: true }, coolAllowed: { central: false, local: true } };
  }
}

/** The season the mean asks for, starting from the current one (hysteresis keeps it where it is). */
function candidate(cur: Season, avg: number, sc: SeasonConfig, heatMonth: boolean, coolMonth: boolean): Season {
  switch (cur) {
    case 'heating':
      if (avg >= sc.heatBelowC + sc.hysteresisC) return avg > sc.coolAboveC && coolMonth ? 'cooling' : 'neutral';
      return 'heating';
    case 'cooling':
      if (avg <= sc.coolAboveC - sc.hysteresisC) return avg < sc.heatBelowC && heatMonth ? 'heating' : 'neutral';
      return 'cooling';
    case 'neutral':
      if (avg < sc.heatBelowC && heatMonth) return 'heating';
      if (avg > sc.coolAboveC && coolMonth) return 'cooling';
      return 'neutral';
  }
}

export const stepSeason: StepSeasonFn = (cfg, inputs, memory) => {
  const now = inputs.now;
  const sc = cfg.season;
  const mode = cfg.house.mode;
  const month = toLocal(now, inputs.tz).month;
  const heatMonth = !!sc.heatingMonths[month - 1];
  const coolMonth = !!sc.coolingMonths[month - 1];
  const avg = inputs.outdoor.avgNC;
  const decisions: Decision[] = [];
  const detections: Detection[] = [];

  let m: SeasonMemory = { ...memory };
  let gateClosed: Season | null = null;
  const switchTo = (to: Season) => {
    const from = m.season;
    m = { ...m, season: to, since: now, pending: null };
    // the derived season changes quietly while the house mode forces one
    if (mode === 'auto') {
      decisions.push({ code: 'season.changed', category: 'system', tone: 'event', params: { from, to, avgC: avg } });
      detections.push({ kind: 'season_changed', dedupKey: `season_changed:${now}`, active: true, facts: { from, to, avgC: avg } });
    }
  };

  if (avg === null) {
    if (m.bootstrap) {
      // first boot without outdoor statistics: by month, the dwell counting from boot
      const byMonth = seasonByMonth(sc, month);
      if (byMonth !== m.season) switchTo(byMonth);
    } else if ((m.season === 'heating' && !heatMonth) || (m.season === 'cooling' && !coolMonth)) {
      gateClosed = m.season;
      switchTo('neutral');
    }
  } else {
    m = { ...m, bootstrap: false, avgC: avg, avgComputedAt: now };
    if ((m.season === 'heating' && !heatMonth) || (m.season === 'cooling' && !coolMonth)) {
      gateClosed = m.season;
      switchTo('neutral');
    } else {
      const cand = candidate(m.season, avg, sc, heatMonth, coolMonth);
      if (cand !== m.season) {
        const pending = m.pending?.to === cand ? m.pending : { to: cand, since: now };
        m = { ...m, pending };
        if (now - pending.since >= sc.confirmH * HOUR_MS && now - m.since >= sc.minDwellH * HOUR_MS) switchTo(cand);
      } else if (m.pending) m = { ...m, pending: null };
    }
  }

  const derived = m.season;
  const season: Season = mode === 'heat' ? 'heating' : mode === 'cool' ? 'cooling' : derived;
  const gates = seasonGates(mode, derived);
  const pending =
    mode === 'auto' && m.pending
      ? { to: m.pending.to, since: m.pending.since, eligibleAt: Math.max(m.pending.since + sc.confirmH * HOUR_MS, m.since + sc.minDwellH * HOUR_MS) }
      : null;

  let reason: Reason;
  if (mode !== 'auto') reason = { code: 'season.forced', params: { mode } };
  else if (pending) reason = { code: 'season.pending', params: { to: pending.to, eligibleAt: pending.eligibleAt } };
  else if (avg === null) reason = { code: 'season.no_data', params: {} };
  else if (gateClosed) reason = { code: 'season.months_gate', params: { season: gateClosed } };
  else if (derived === 'neutral' && avg < sc.heatBelowC && !heatMonth) reason = { code: 'season.months_gate', params: { season: 'heating' } };
  else if (derived === 'neutral' && avg > sc.coolAboveC && !coolMonth) reason = { code: 'season.months_gate', params: { season: 'cooling' } };
  else reason = { code: 'season.auto', params: { season: derived, avgC: avg } };

  const state: SeasonState = {
    houseMode: mode,
    season,
    derived,
    auto: mode === 'auto',
    since: mode === 'auto' ? m.since : Math.max(cfg.house.modeChangedAt, 0),
    avgC: avg ?? m.avgC,
    outdoorC: inputs.outdoor.nowC,
    outdoor10C: inputs.outdoor.avg10C,
    outdoorSource: inputs.outdoor.source,
    rule: { heatBelowC: sc.heatBelowC, coolAboveC: sc.coolAboveC, hysteresisC: sc.hysteresisC, avgDays: sc.avgDays },
    pending,
    heatAllowed: gates.heatAllowed,
    coolAllowed: gates.coolAllowed,
    reason,
  };
  return { state, memory: m, decisions, detections };
};
