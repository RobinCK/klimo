import { round1 } from '../../shared/model';
import type { Band, EpochMs, ModeOrNone, Reason, RoomEta, RoomMemory } from '../../shared/model';
import { ENGINE_DEFAULTS } from '../../shared/defaults';
import { round5min } from './util';

/* =====================================================================================================
 * «≈ 25 хв до 20.2°»: the time to the latch's stop point (T + above heating, T − below cooling) at the
 * learned rate, or 1 °C/h until three clean episodes have been seen (then the UI drops the «≈»).
 * ===================================================================================================== */

const MIN_MS = 60_000;
const CONFIDENT_SAMPLES = 3;

export function rateOf(learned: RoomMemory['learned'], mode: 'heat' | 'cool'): { rate: number; confident: boolean } {
  const r = mode === 'heat' ? learned.heatRateCPerH : learned.coolRateCPerH;
  const n = mode === 'heat' ? learned.heatSamples : learned.coolSamples;
  return { rate: r ?? ENGINE_DEFAULTS.learning.defaultRateCPerH, confident: r !== null && n >= CONFIDENT_SAMPLES };
}

/** Minutes for a change of `deltaC` at `rate` °C/h: max(5, round5(Δ / rate · 60)). */
export function etaMinutes(deltaC: number, rate: number): number {
  return Math.max(5, round5min((Math.abs(deltaC) / Math.max(rate, 0.05)) * 60));
}

/** ETA to the stop point while the room is asking for heat or cold; null when there is nothing to reach. */
export function etaOf(
  demand: ModeOrNone,
  t: number | null,
  target: { heatC: number | null; coolC: number | null },
  tol: { heat: Band; cool: Band },
  learned: RoomMemory['learned'],
  now: EpochMs,
): RoomEta | null {
  if (t === null || demand === 'none') return null;
  const T = demand === 'heat' ? target.heatC : target.coolC;
  if (T === null) return null;
  const toC = round1(demand === 'heat' ? T + tol.heat.above : T - tol.cool.below);
  const delta = demand === 'heat' ? toC - t : t - toC;
  if (delta <= 0) return null;
  const { rate, confident } = rateOf(learned, demand);
  const minutes = etaMinutes(delta, rate);
  return { toC, minutes, at: now + minutes * MIN_MS, rateCPerH: Math.round(rate * 100) / 100, confident };
}

/** «Остигає / прогрівається приблизно на N°/год» for an idle room with a learned drift. */
export function idleDrift(learned: RoomMemory['learned']): Reason | null {
  const d = learned.driftCPerH;
  if (d === null || Math.abs(d) < 0.05) return null;
  return d < 0 ? { code: 'why.eta.cooling_down', params: { rate: round1(-d) } } : { code: 'why.eta.warming_up', params: { rate: round1(d) } };
}
