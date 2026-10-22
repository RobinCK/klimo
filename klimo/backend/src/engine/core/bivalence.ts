import type { BivalentMode, Decision, EngineConfig, EpochMs, Id, InputSnapshot, Latch, PlantMemory, SourceMemory } from '../../shared/model';

/* =====================================================================================================
 * Heat pump plus a second source. On the 10-minute outdoor mean: below the bivalent point (−10°) the
 * «Мороз» latch is on and stays on until −8°, so the plant does not hop between sources at −9.5°. In
 * `partial` mode a second latch at the HP limit (−15°, back at −13°) stops the heat pump entirely. When
 * the outdoor reading is lost the latches hold, and after 30 minutes the reserve may join — the heat
 * pump is never switched off for missing data. The lag latch («ТН не встигає») lets the reserve join
 * when a room stays more than 1° short for 45 minutes.
 * ===================================================================================================== */

const MIN_MS = 60_000;
/** Outdoor unknown this long → the reserve may join the heat pump. */
const OUTDOOR_UNKNOWN_JOIN_MS = 30 * MIN_MS;
/** The cutoff latch releases this far below the cutoff. */
const CUTOFF_RELEASE_C = 1;

function flip(latch: Latch, on: boolean, now: EpochMs): Latch {
  return latch.on === on ? latch : { on, since: now };
}

/** ON below `onBelow`, OFF at or above `offAtOrAbove`, unchanged in between or when the value is unknown. */
function belowLatch(latch: Latch, v: number | null, onBelow: number, offAtOrAbove: number, now: EpochMs): Latch {
  if (v === null) return latch;
  if (!latch.on && v < onBelow) return flip(latch, true, now);
  if (latch.on && v >= offAtOrAbove) return flip(latch, false, now);
  return latch;
}

export interface PlantLatches {
  plant: PlantMemory;
  /** 10-minute outdoor mean used for bivalence and the cutoff (falls back to the current reading). */
  tout10: number | null;
  /** The outdoor value has been unknown long enough for the reserve to join. */
  outdoorUnknownLong: boolean;
  decisions: Decision[];
}

export function stepPlantLatches(
  cfg: EngineConfig,
  prev: PlantMemory,
  inputs: InputSnapshot,
  pair: { mode: BivalentMode; hpId: Id } | null,
): PlantLatches {
  const now = inputs.now;
  const b = cfg.heat.bivalence;
  const tout10 = inputs.outdoor.avg10C ?? inputs.outdoor.nowC;
  const decisions: Decision[] = [];

  const frost = belowLatch(prev.bivalentFrost, tout10, b.pointC, b.pointC + b.hysteresisC, now);
  const limit = belowLatch(prev.bivalentLimit, tout10, b.hpLimitC, b.hpLimitC + b.hysteresisC, now);

  let cutoff = prev.cutoff;
  const cutoffC = cfg.heat.heatingCutoffOutdoorC;
  if (cutoffC === null) cutoff = flip(cutoff, false, now);
  else if (tout10 !== null) {
    if (!cutoff.on && tout10 > cutoffC) cutoff = flip(cutoff, true, now);
    else if (cutoff.on && tout10 <= cutoffC - CUTOFF_RELEASE_C) cutoff = flip(cutoff, false, now);
  }
  if (cutoff !== prev.cutoff) decisions.push({ code: cutoff.on ? 'cutoff.on' : 'cutoff.off', category: 'src', tone: 'idle', params: { toutC: tout10 } });

  if (pair) {
    // the latch that takes the heat pump out of the chain in this mode
    const gate = pair.mode === 'alt' ? [prev.bivalentFrost, frost, b.pointC] : pair.mode === 'partial' ? [prev.bivalentLimit, limit, b.hpLimitC] : null;
    if (gate) {
      const [before, after, pointC] = gate as [Latch, Latch, number];
      if (!before.on && after.on) decisions.push({ code: 'bivalent.hp_off', category: 'src', tone: 'warn', params: { pointC, toutC: tout10 }, sourceId: pair.hpId });
      if (before.on && !after.on) decisions.push({ code: 'bivalent.hp_on', category: 'src', tone: 'heat', params: { toutC: tout10 }, sourceId: pair.hpId });
    }
  }

  const unknownSince = tout10 === null ? (prev.outdoorUnknownSince ?? now) : null;
  const src = inputs.outdoor.source === 'weather' ? 'weather' : 'sensor';
  const plant: PlantMemory = {
    ...prev,
    bivalentFrost: frost,
    bivalentLimit: limit,
    cutoff,
    outdoorUnknownSince: unknownSince,
    outdoorLast: tout10 !== null ? { valueC: tout10, at: now, source: src } : prev.outdoorLast,
  };
  return { plant, tout10, outdoorUnknownLong: unknownSince !== null && now - unknownSince >= OUTDOOR_UNKNOWN_JOIN_MS, decisions };
}

export interface LagCandidate {
  roomId: Id;
  t: number;
  T: number;
  below: number;
  since: EpochMs | null;
}

export interface LagStep {
  latch: Latch;
  /** Per candidate room: deficit-since for the next tick. */
  since: Record<Id, EpochMs | null>;
  decisions: Decision[];
}

/**
 * «ТН не встигає»: the heat pump runs, is confirmed and past its start grace, yet a room has lacked more
 * than the lag deficit for the lag time. The reserve then joins until every such room is back in band.
 * Timers pause while the heat pump defrosts or Klimo is blind.
 */
export function stepLag(
  cfg: EngineConfig,
  x: { latch: Latch; hp: Id | null; reserve: Id | null; hpMem: SourceMemory | null; defrost: boolean; blind: boolean; dtMs: number; now: EpochMs; candidates: readonly LagCandidate[] },
): LagStep {
  const lag = cfg.heat.lag;
  const { now } = x;
  const paused = x.defrost || x.blind;
  const since: Record<Id, EpochMs | null> = {};
  let longestMs = 0;
  for (const c of x.candidates) {
    let s: EpochMs | null;
    if (c.T - c.t > lag.deficitC) s = paused ? (c.since === null ? null : c.since + x.dtMs) : (c.since ?? now);
    else s = null;
    since[c.roomId] = s;
    if (s !== null) longestMs = Math.max(longestMs, now - s);
  }
  const hp = x.hpMem;
  const raw =
    lag.enabled &&
    !!hp &&
    hp.on &&
    hp.confirm === 'confirmed' &&
    hp.onSince !== null &&
    now - hp.onSince >= lag.graceAfterStartMin * MIN_MS &&
    longestMs >= lag.forMin * MIN_MS;
  const decisions: Decision[] = [];
  let latch = x.latch;
  if (!latch.on && raw) {
    latch = { on: true, since: now };
    decisions.push({ code: 'lag.join', category: 'src', tone: 'warn', params: { sourceId: x.reserve, minutes: Math.round(longestMs / MIN_MS) }, sourceId: x.reserve });
  } else if (latch.on && (!lag.enabled || x.candidates.every((c) => c.t >= c.T - c.below))) {
    latch = { on: false, since: now };
    decisions.push({ code: 'lag.leave', category: 'src', tone: 'idle', params: {}, sourceId: x.reserve });
  }
  return { latch, since, decisions };
}
