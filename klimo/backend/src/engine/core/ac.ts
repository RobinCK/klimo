import type { ClimateAdapter, DesiredActuator, EmitterRole, EpochMs, InputSnapshot, SourceConfig, SourceMemory, SourceMode, Urgency } from '../../shared/model';
import { snapOf } from './conditions';
import type { RoomView } from './selection';
import { hhmmToMinute, inWindow, toLocal } from './time';
import { clamp, roundStep } from './util';

/* =====================================================================================================
 * Room air conditioners. The AC's own sensor sits under the ceiling, so in `target` control Klimo asks
 * for the room target plus the learned difference between the AC's reading and the room (at most ±3°,
 * moved at most 1° per 5 minutes). `onoff` drives fixed setpoints by Klimo's latch; `asis` hands the room
 * target to the AC and lets it regulate. At night the fan goes to its quietest mode.
 * ===================================================================================================== */

const MIN_MS = 60_000;
/** Fan modes from quietest, as manufacturers name them. */
const QUIET_PREFERENCE = ['quiet', 'silent', 'low', 'min', '1', 'auto'];

export interface AcInput {
  inputs: InputSnapshot;
  now: EpochMs;
  room: RoomView | null;
  /** Emitter role the room asked with (a trigger role stores heat above the target). */
  emitterRole: EmitterRole | null;
  /** Correction applied last time and when it last moved (rate limit). */
  applied: { valueC: number; at: EpochMs } | null;
  urgency: Urgency;
  reqId: string | null;
}

export interface AcOutput {
  desired: DesiredActuator;
  /** Correction now applied on top of the target (stored back into the room memory). */
  applied: { valueC: number; at: EpochMs } | null;
  setpointC: number | null;
}

function numAttr(attrs: Record<string, unknown>, key: string): number | null {
  const v = attrs[key];
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

export function hvacModeFor(a: ClimateAdapter, mode: SourceMode): string {
  return a.modeMap[mode] ?? (mode === 'fan' ? 'fan_only' : mode);
}

/** Night: the quietest fan the unit offers; day: `auto` when supported, else leave the fan alone. */
export function fanModeFor(a: ClimateAdapter, room: RoomView | null, attrs: Record<string, unknown>, now: EpochMs, tz: string): string | null {
  const modes = Array.isArray(attrs.fan_modes) ? (attrs.fan_modes as unknown[]).map(String) : [];
  const quiet = room?.room.ac.quietNight;
  let night = false;
  if (quiet?.enabled) {
    try {
      const lt = toLocal(now, tz);
      hhmmToMinute(quiet.from);
      night = inWindow(lt.minute, lt.dow, { from: quiet.from, to: quiet.to });
    } catch {
      night = false;
    }
  }
  if (night) {
    if (quiet?.fanMode) return quiet.fanMode;
    if (a.quietFanMode) return a.quietFanMode;
    for (const p of QUIET_PREFERENCE) {
      const hit = modes.find((m) => m.toLowerCase() === p);
      if (hit) return hit;
    }
    return null;
  }
  return modes.includes('auto') ? 'auto' : null;
}

export function acDesired(s: SourceConfig, m: SourceMemory, x: AcInput): AcOutput {
  const a = s.adapter as ClimateAdapter;
  const entity = a.climate as string;
  const room = x.room;
  const attrs = snapOf(x.inputs, entity)?.attrs ?? {};
  const base: Omit<DesiredActuator, 'value'> = {
    key: entity,
    entityId: entity,
    urgency: x.urgency,
    owner: { type: 'local', id: s.id, roomId: room?.id ?? s.roomId },
    confirm: { kind: 'climate', tolerance: 0.05 },
    ackTimeoutSec: 60,
    maxAttempts: 3,
    backgroundRetryMin: 15,
    minIntervalSec: 0,
    deadband: 0.5,
    refreshEverySec: null,
    userSetpointAttr: 'temperature',
    reqId: x.reqId,
  };
  const off = (): AcOutput => ({
    desired: { ...base, value: { kind: 'climate', hvacMode: a.modeMap.off, temperature: null, targetLow: null, targetHigh: null, fanMode: null } },
    applied: x.applied,
    setpointC: null,
  });
  if (!m.on || !m.mode || !room) return off();

  const mode = m.mode;
  const control = room.room.ac.control;
  const ac = room.room.ac;
  let target: number | null = mode === 'heat' ? room.heatC : mode === 'cool' || mode === 'dry' ? room.coolC : null;
  if (mode === 'heat' && target !== null && x.emitterRole === 'trigger') {
    // heat storage: the AC keeps heating up to the storage ceiling
    const e = room.emitters.find((em) => em.sourceId === s.id);
    target += e?.trigger?.heatStoreAboveTargetC ?? 1.5;
  }

  let setpoint: number | null = null;
  let applied = x.applied;
  if (mode !== 'fan') {
    if (control === 'onoff') setpoint = mode === 'heat' ? ac.onoffSetpoints.heatC : ac.onoffSetpoints.coolC;
    else if (control === 'asis' || mode === 'dry') setpoint = target;
    else if (target !== null) {
      // the correction drifts toward the learned offset at most maxStepC per everyMin; target changes apply at once
      const learned = room.ev.memory.learned.acOffsetC[s.id];
      const wanted = learned && learned.minutes >= 30 ? clamp(learned.value, -ac.correction.maxOffsetC, ac.correction.maxOffsetC) : 0;
      let corr = wanted;
      if (applied) {
        if (x.now - applied.at < ac.correction.everyMin * MIN_MS) corr = applied.valueC;
        else corr = applied.valueC + clamp(wanted - applied.valueC, -ac.correction.maxStepC, ac.correction.maxStepC);
      }
      if (!applied || corr !== applied.valueC) applied = { valueC: Math.round(corr * 10) / 10, at: x.now };
      setpoint = target + applied.valueC;
    }
  }
  if (setpoint !== null) {
    const step = numAttr(attrs, 'target_temp_step') ?? 0.5;
    setpoint = roundStep(setpoint, step, 'nearest');
    const lo = numAttr(attrs, 'min_temp');
    const hi = numAttr(attrs, 'max_temp');
    if (lo !== null) setpoint = Math.max(lo, setpoint);
    if (hi !== null) setpoint = Math.min(hi, setpoint);
  }
  const fanMode = fanModeFor(a, room, attrs, x.now, x.inputs.tz);
  return {
    desired: { ...base, value: { kind: 'climate', hvacMode: hvacModeFor(a, mode), temperature: setpoint, targetLow: null, targetHigh: null, fanMode } },
    applied,
    setpointC: setpoint,
  };
}
