import { round1 } from '../../shared/model';
import type { Decision, Detection, EpochMs, Latch, RoomConfig, RoomMemory, SafetySettings, Severity } from '../../shared/model';
import { ENGINE_DEFAULTS } from '../../shared/defaults';

/* =====================================================================================================
 * Room safety latches. Frost protection runs in every house mode, season, profile and window state —
 * and, when the room has no temperature at all, on the coldest radiator head. Overheat closes the heat
 * even under a manual target. Too cold / too hot are facts for the alerts, never control.
 * ===================================================================================================== */

const MIN_MS = 60_000;

export interface LatchResult {
  latch: Latch;
  flipped: boolean;
}

function flip(prev: Latch, on: boolean, now: EpochMs): LatchResult {
  return prev.on === on ? { latch: prev, flipped: false } : { latch: { on, since: now }, flipped: true };
}

/** Temperature frost protection watches: the room value, else the coldest reachable TRV. */
export function frostProbe(tempC: number | null, trvTemps: number[]): number | null {
  if (tempC !== null) return tempC;
  return trvTemps.length ? Math.min(...trvTemps) : null;
}

/** ON below the floor F, OFF at F + (frostRelease − frost) (7 → 8 by default). Unknown holds. */
export function stepFrost(prev: Latch, t: number | null, floorC: number, safety: SafetySettings, now: EpochMs): LatchResult {
  if (t === null) return { latch: prev, flipped: false };
  const release = floorC + Math.max(0, safety.frostReleaseC - safety.frostC);
  if (!prev.on && t < floorC) return flip(prev, true, now);
  if (prev.on && t >= round1(release)) return flip(prev, false, now);
  return { latch: prev, flipped: false };
}

/** ON above `overheatC`, OFF at ≤ `overheatReleaseC`; only while the room may heat at all. */
export function stepOverheat(prev: Latch, t: number | null, enabled: boolean, heatRelevant: boolean, safety: SafetySettings, now: EpochMs): LatchResult {
  if (!enabled || !heatRelevant || t === null) return flip(prev, false, now);
  if (!prev.on && t > safety.overheatC) return flip(prev, true, now);
  if (prev.on && t <= safety.overheatReleaseC) return flip(prev, false, now);
  return { latch: prev, flipped: false };
}

/** Floor probe at its maximum stops floor heating until it is 1° below. */
export function stepFloorLimit(prev: Latch, floorC: number | null, maxFloorC: number, now: EpochMs): LatchResult {
  if (floorC === null) return flip(prev, false, now);
  if (!prev.on && floorC >= maxFloorC) return flip(prev, true, now);
  if (prev.on && floorC <= maxFloorC - 1) return flip(prev, false, now);
  return { latch: prev, flipped: false };
}

export interface ComfortAlertInput {
  /** Controlled, the mode active, no window/airing, temperature known. */
  watching: boolean;
  t: number | null;
  heatC: number | null;
  coolC: number | null;
  heatActive: boolean;
  coolActive: boolean;
}

export interface ComfortAlerts {
  tooColdSince: EpochMs | null;
  tooHotSince: EpochMs | null;
  tooCold: { active: boolean; deltaC: number | null; minutes: number };
  tooHot: { active: boolean; deltaC: number | null; minutes: number };
}

/**
 * «Холодно / жарко» timers: t < T_heat − 2 for 60 min opens the alert; it stays until the room is back within
 * 1°. Before the alert has opened, any return above T − 2 restarts the timer.
 */
export function stepComfortAlerts(mem: Pick<RoomMemory, 'tooColdSince' | 'tooHotSince'>, a: ComfortAlertInput, now: EpochMs): ComfortAlerts {
  const { tooColdDeltaC, tooHotDeltaC, forMin, resolveC } = ENGINE_DEFAULTS.alerts;
  const forMs = forMin * MIN_MS;
  const t = a.t;

  let coldSince = mem.tooColdSince;
  let coldDelta: number | null = null;
  if (!a.watching || t === null || !a.heatActive || a.heatC === null) coldSince = null;
  else {
    const deficit = round1(a.heatC - t);
    coldDelta = deficit;
    const open = coldSince !== null && now - coldSince >= forMs;
    if (deficit > tooColdDeltaC) coldSince ??= now;
    else if (!open || deficit <= resolveC) coldSince = null;
  }
  const coldActive = coldSince !== null && now - coldSince >= forMs;

  let hotSince = mem.tooHotSince;
  let hotDelta: number | null = null;
  const ref = a.coolActive && a.coolC !== null ? a.coolC : a.heatActive ? a.heatC : null;
  if (!a.watching || t === null || ref === null) hotSince = null;
  else {
    const excess = round1(t - ref);
    hotDelta = excess;
    const open = hotSince !== null && now - hotSince >= forMs;
    if (excess > tooHotDeltaC) hotSince ??= now;
    else if (!open || excess <= resolveC) hotSince = null;
  }
  const hotActive = hotSince !== null && now - hotSince >= forMs;

  return {
    tooColdSince: coldSince,
    tooHotSince: hotSince,
    tooCold: { active: coldActive, deltaC: coldDelta, minutes: coldSince === null ? 0 : Math.floor((now - coldSince) / MIN_MS) },
    tooHot: { active: hotActive, deltaC: hotDelta, minutes: hotSince === null ? 0 : Math.floor((now - hotSince) / MIN_MS) },
  };
}

export interface SafetyEvents {
  decisions: Decision[];
  detections: Detection[];
}

/** Journal entries and detections of the room safety latches for this tick. */
export function safetyEvents(
  room: RoomConfig,
  r: {
    frost: LatchResult;
    frostT: number | null;
    floorC: number;
    overheat: LatchResult;
    t: number | null;
    overheatC: number;
    noData: boolean;
    noDataSince: EpochMs | null;
    noDataBecame: boolean;
    dataBack: boolean;
    heatAllowed: boolean;
    outdoorC: number | null;
    comfort: ComfortAlerts;
  },
  now: EpochMs,
): SafetyEvents {
  const decisions: Decision[] = [];
  const detections: Detection[] = [];
  const roomId = room.id;
  if (r.frost.flipped) {
    decisions.push(
      r.frost.latch.on
        ? { code: 'room.frost_on', category: 'rooms', tone: 'err', params: { t: r.frostT }, roomId }
        : { code: 'room.frost_off', category: 'rooms', tone: 'ok', params: { t: r.frostT }, roomId },
    );
  }
  detections.push({ kind: 'frost_risk', dedupKey: `frost_risk:${roomId}`, active: r.frost.latch.on, roomId, facts: { t: r.frostT, frostC: r.floorC } });

  if (r.overheat.flipped) {
    decisions.push(
      r.overheat.latch.on
        ? { code: 'room.overheat_on', category: 'rooms', tone: 'warn', params: { t: r.t }, roomId }
        : { code: 'room.overheat_off', category: 'rooms', tone: 'ok', params: { t: r.t }, roomId },
    );
  }
  detections.push({ kind: 'overheat', dedupKey: `overheat:${roomId}`, active: r.overheat.latch.on, roomId, facts: { t: r.t, maxC: r.overheatC } });

  if (r.noDataBecame) decisions.push({ code: 'room.no_data', category: 'rooms', tone: 'err', params: {}, roomId });
  if (r.dataBack) decisions.push({ code: 'room.data_back', category: 'rooms', tone: 'ok', params: { t: r.t }, roomId });
  const noDataMin = r.noDataSince === null ? 0 : Math.floor((now - r.noDataSince) / MIN_MS);
  // without a room temperature in the cold season the house can freeze unnoticed: critical
  const cold = r.outdoorC === null || r.outdoorC < 10;
  const severity: Severity = room.controlEnabled && r.heatAllowed && cold ? 'critical' : 'warning';
  detections.push({
    kind: 'room_no_data',
    severity,
    dedupKey: `room_no_data:${roomId}`,
    active: r.noData && noDataMin >= ENGINE_DEFAULTS.alerts.noDataMin,
    roomId,
    facts: { minutes: noDataMin },
  });

  if (room.notify.tooCold) {
    detections.push({
      kind: 'room_too_cold',
      dedupKey: `room_too_cold:${roomId}`,
      active: r.comfort.tooCold.active,
      roomId,
      facts: { t: r.t, deltaC: r.comfort.tooCold.deltaC, minutes: r.comfort.tooCold.minutes },
    });
  }
  if (room.notify.tooHot) {
    detections.push({
      kind: 'room_too_hot',
      dedupKey: `room_too_hot:${roomId}`,
      active: r.comfort.tooHot.active,
      roomId,
      facts: { t: r.t, deltaC: r.comfort.tooHot.deltaC, minutes: r.comfort.tooHot.minutes },
    });
  }
  return { decisions, detections };
}
