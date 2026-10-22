import type { EmitterDevice, EpochMs, Id, InputSnapshot, Latch, PlantState, RoomMemory } from '../../shared/model';
import { ENGINE_DEFAULTS } from '../../shared/defaults';
import { trvLocalTemp } from './aggregate';
import { ewma, slopePerHour } from './util';

/* =====================================================================================================
 * What a room teaches Klimo about itself: how fast it heats and cools (ETA, optimal start), how fast it
 * drifts when idle, and how far each radiator head's or AC's own sensor reads from the room (the fallback
 * when every room sensor is gone, the AC setpoint correction). Samples are only taken from clean episodes.
 * ===================================================================================================== */

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;
/** Longest gap between ticks that still counts as joint data (a restart is not 6 hours of agreement). */
const MAX_LEARN_DT_MS = 5 * MIN_MS;
const EPISODE_MIN_MS = 15 * MIN_MS;
const EPISODE_SKIP_MS = 10 * MIN_MS;
const IDLE_MIN_MS = 60 * MIN_MS;
const MIN_RATE = 0.05;
const MAX_RATE = 5;

export type Learned = RoomMemory['learned'];

/** Sensor-offset EWMA with a 6-hour time constant over irregular ticks. */
function offsetStep(prev: { value: number; minutes: number } | undefined, sample: number, dtMs: number): { value: number; minutes: number } {
  const tauMs = ENGINE_DEFAULTS.learning.trvOffsetTauH * HOUR_MS;
  if (!prev) return { value: sample, minutes: dtMs / MIN_MS };
  const k = 1 - Math.exp(-dtMs / tauMs);
  return { value: prev.value + (sample - prev.value) * k, minutes: prev.minutes + dtMs / MIN_MS };
}

export interface OffsetInput {
  /** Unrounded room aggregate from the room's own sensors; null while in fallback or without data. */
  roomRawC: number | null;
  trvs: { device: EmitterDevice; snap: InputSnapshot['entities'][string] | undefined }[];
  acs: { sourceId: Id; snap: InputSnapshot['entities'][string] | undefined }[];
  dtMs: number;
}

/** TRV and AC sensor offsets against the room, learned only while the room's own sensors work. */
export function learnOffsets(learned: Learned, x: OffsetInput): Learned {
  if (x.roomRawC === null || x.dtMs <= 0) return learned;
  const dt = Math.min(x.dtMs, MAX_LEARN_DT_MS);
  const trvOffsetC = { ...learned.trvOffsetC };
  for (const t of x.trvs) {
    const local = trvLocalTemp(t.snap);
    if (local !== null) trvOffsetC[t.device.id] = offsetStep(trvOffsetC[t.device.id], local - x.roomRawC, dt);
  }
  const acOffsetC = { ...learned.acOffsetC };
  for (const a of x.acs) {
    const local = trvLocalTemp(a.snap);
    if (local !== null) acOffsetC[a.sourceId] = offsetStep(acOffsetC[a.sourceId], local - x.roomRawC, dt);
  }
  return { ...learned, trvOffsetC, acOffsetC };
}

export interface EpisodeInput {
  mode: 'heat' | 'cool';
  /** The latch before this tick (ON) and that it just turned OFF. */
  prev: Latch;
  history: [EpochMs, number][] | undefined;
  rawC: number | null;
  /** A window reaction happened during the episode. */
  windowSince: EpochMs | null;
  /** The heat (cool) target changed by ≥ 0.5 during the episode. */
  targetChanged: boolean;
  /** A source serving the room was confirmed for ≥ 80 % of the episode. */
  served: boolean;
}

function slopeBetween(history: [EpochMs, number][] | undefined, rawC: number | null, from: EpochMs, to: EpochMs): number | null {
  const pts = (history ?? []).filter(([ts]) => ts >= from && ts <= to);
  if (rawC !== null && (!pts.length || pts[pts.length - 1][0] < to)) pts.push([to, rawC]);
  if (pts.length < 5 || pts[pts.length - 1][0] - pts[0][0] < 10 * MIN_MS) return null;
  return slopePerHour(pts);
}

/**
 * A finished heating (cooling) episode: ≥ 15 min, window closed, target steady, source confirmed most of
 * the time. Rate = least-squares slope from start + 10 min to the end, accepted between 0.05 and 5 °C/h.
 */
export function learnEpisode(learned: Learned, x: EpisodeInput, now: EpochMs): Learned {
  const start = x.prev.since;
  if (now - start < EPISODE_MIN_MS || x.targetChanged || !x.served) return learned;
  if (x.windowSince !== null && x.windowSince >= start) return learned;
  const slope = slopeBetween(x.history, x.rawC, start + EPISODE_SKIP_MS, now);
  if (slope === null) return learned;
  const r = x.mode === 'heat' ? slope : -slope;
  if (!(r > MIN_RATE && r < MAX_RATE)) return learned;
  const alpha = ENGINE_DEFAULTS.learning.alpha;
  if (x.mode === 'heat') return { ...learned, heatRateCPerH: ewma(learned.heatRateCPerH, r, alpha), heatSamples: learned.heatSamples + 1 };
  return { ...learned, coolRateCPerH: ewma(learned.coolRateCPerH, r, alpha), coolSamples: learned.coolSamples + 1 };
}

/** Idle drift from an idle period of ≥ 60 min that just ended (a latch turned ON), window closed. */
export function learnDrift(
  learned: Learned,
  x: { idleSince: EpochMs; history: [EpochMs, number][] | undefined; rawC: number | null; windowSince: EpochMs | null },
  now: EpochMs,
): Learned {
  if (now - x.idleSince < IDLE_MIN_MS) return learned;
  if (x.windowSince !== null && x.windowSince >= x.idleSince) return learned;
  const slope = slopeBetween(x.history, x.rawC, Math.max(x.idleSince, now - IDLE_MIN_MS), now);
  if (slope === null || Math.abs(slope) >= MAX_RATE) return learned;
  return { ...learned, driftCPerH: ewma(learned.driftCPerH, slope, ENGINE_DEFAULTS.learning.alpha) };
}

/**
 * «Source confirmed for ≥ 80 % of the episode», read from the plant: a serving source that has been
 * running and confirmed since early enough in the episode.
 */
export function servedThroughout(prevPlant: PlantState | null, sourceIds: Set<Id>, start: EpochMs, now: EpochMs): boolean {
  if (!prevPlant) return false;
  const latest = start + 0.2 * (now - start);
  return prevPlant.sources.some((s) => sourceIds.has(s.sourceId) && s.on && s.confirm === 'confirmed' && s.since !== null && s.since <= latest);
}
