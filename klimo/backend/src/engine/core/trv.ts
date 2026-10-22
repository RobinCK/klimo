import { round1 } from '../../shared/model';
import type {
  ActuatorRecord,
  CommandProgress,
  DesiredActuator,
  DesiredValue,
  EmitterDevice,
  EntityId,
  EntitySnap,
  EpochMs,
  Id,
  RoomConfig,
  SafetySettings,
  TrvActivity,
  TrvCapabilities,
  TrvState,
} from '../../shared/model';
import { DEFAULT_TRV_CAPABILITIES } from '../../shared/defaults';
import { batteryOf, lqiOf, trvLocalTemp } from './aggregate';
import { clamp, roundStep } from './util';

/* =====================================================================================================
 * Radiator heads. Setpoints are aligned with Klimo's latch, never set to the bare target: an open valve
 * gets T + above (it stays open until Klimo's OFF threshold), a satisfied one max(T − below, frost floor)
 * (the head only opens itself where Klimo would), a blocked one the frost floor. So a source never runs
 * against valves the heads have already closed, and a paused room cannot re-open its own valve.
 * ===================================================================================================== */

/** Where the head stands this tick. */
export type TrvStatus = 'open' | 'satisfied' | 'blocked' | 'frost';

/** Exercise setpoint: fully open for the anti-seize run. */
const EXERCISE_SETPOINT_C = 30;
/** External temperature changes this large are sent at once, past the battery saver. */
const EXTERNAL_IMMEDIATE_DELTA_C = 1.0;
const CALIBRATION_DEADBAND_C = 0.3;
const CALIBRATION_EVERY_SEC = 600;
const CONFIG_EVERY_SEC = 600;
const TRV_SPACING_SEC = 5;

/* ── shared actuator plumbing (also used for zone valves and the dehumidifier) ───────────────────────── */

/** A Z2M pseudo entity `z2m:<base>/<friendly_name>[:<property>]` → topic and property. */
export function parseZ2m(id: string, defaultProp: string): { topic: string; prop: string; key: string } | null {
  if (!id.startsWith('z2m:')) return null;
  const rest = id.slice(4);
  const slash = rest.lastIndexOf('/');
  const colon = rest.lastIndexOf(':');
  const path = colon > slash ? rest.slice(0, colon) : rest;
  const prop = colon > slash ? rest.slice(colon + 1) : defaultProp;
  return { topic: `${path}/set`, prop, key: `z2m:${path}:${prop}` };
}

export function progressOf(rec: ActuatorRecord | undefined, maxAttempts: number): CommandProgress {
  if (!rec) return { status: 'idle', attempt: 0, maxAttempts, commandId: null, reqId: null, sentAt: null, confirmedAt: null };
  return {
    status: rec.status,
    attempt: rec.attempts,
    maxAttempts,
    commandId: rec.commandId,
    reqId: rec.reqId,
    sentAt: rec.commandedAt,
    confirmedAt: rec.confirmedAt,
  };
}

export function commandedNumber(rec: ActuatorRecord | undefined): number | null {
  const c = rec?.commanded;
  if (!c) return null;
  if (c.kind === 'number') return c.value;
  if (c.kind === 'climate') return c.temperature;
  if (c.kind === 'z2m') {
    const v = Object.values(c.payload)[0];
    return typeof v === 'number' ? v : null;
  }
  return null;
}

export interface ActOptions {
  urgency?: DesiredActuator['urgency'];
  confirm?: DesiredActuator['confirm'];
  ackTimeoutSec?: number;
  maxAttempts?: number;
  backgroundRetryMin?: number;
  minIntervalSec?: number;
  deadband?: number;
  refreshEverySec?: number | null;
  userSetpointAttr?: DesiredActuator['userSetpointAttr'];
  reqId?: string | null;
}

/** One desired value; Z2M pseudo entities become an MQTT `…/set` publish of `{prop: value}`. */
export function actuator(
  entityId: EntityId,
  value: DesiredValue,
  owner: DesiredActuator['owner'],
  o: ActOptions,
  z2mProp?: { prop: string; payload: unknown },
): DesiredActuator {
  const z = z2mProp ? parseZ2m(entityId, z2mProp.prop) : null;
  const base = {
    urgency: o.urgency ?? 'normal',
    owner,
    ackTimeoutSec: o.ackTimeoutSec ?? 120,
    maxAttempts: o.maxAttempts ?? 3,
    backgroundRetryMin: o.backgroundRetryMin ?? 15,
    minIntervalSec: o.minIntervalSec ?? 0,
    deadband: o.deadband ?? 0,
    refreshEverySec: o.refreshEverySec ?? null,
    userSetpointAttr: o.userSetpointAttr ?? null,
    reqId: o.reqId ?? null,
  } as const;
  if (z && z2mProp) {
    return { ...base, key: z.key, entityId: null, value: { kind: 'z2m', topic: z.topic, payload: { [z.prop]: z2mProp.payload } }, confirm: { kind: 'none' } };
  }
  return { ...base, key: entityId, entityId, value, confirm: o.confirm ?? { kind: 'state_equals' } };
}

function snapNum(snap: EntitySnap | undefined): number | null {
  return snap && snap.available ? snap.num : null;
}

function attrNum(snap: EntitySnap | undefined, ...keys: string[]): number | null {
  if (!snap) return null;
  for (const k of keys) {
    const v = snap.attrs[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

/* ── the head ─────────────────────────────────────────────────────────────────────────────────────── */

export interface TrvRoomInput {
  room: RoomConfig;
  safety: SafetySettings;
  now: EpochMs;
  /** Room temperature Klimo controls by (null = no data). */
  t: number | null;
  /** The room temperature comes from the heads themselves (all room sensors lost). */
  fallbackTrv: boolean;
  heatC: number | null;
  heatAllowed: boolean;
  frost: boolean;
  frostFloorC: number;
  /** Window pause, airing, room/profile off or overheat. */
  blocked: boolean;
  overheat: boolean;
  exercise: boolean;
  /** Learned head-minus-room offset (fallback mode). */
  offsetOf: (deviceId: Id) => number | null;
  /** PI integrator per head ('valve' strategy) and the minutes since the last tick. */
  valveIntegral: Record<Id, number>;
  dtMin: number;
  reqId: string | null;
}

export interface TrvOutput {
  desired: DesiredActuator[];
  state: TrvState;
  status: TrvStatus;
  valveIntegral: number | null;
}

/** D.16.1 setpoint of a head for its status, on its step grid and inside its range. */
export function trvSetpoint(status: TrvStatus, x: Pick<TrvRoomInput, 'room' | 'safety' | 'heatC' | 'frostFloorC'>, caps: TrvCapabilities): number {
  const step = caps.setpointStep > 0 ? caps.setpointStep : 0.5;
  const tol = x.room.tolerance.heat;
  const F = x.frostFloorC;
  let sp: number;
  if (status === 'frost') sp = roundStep(F + Math.max(0, x.safety.frostReleaseC - x.safety.frostC) + tol.above, step, 'ceil');
  else if (status === 'blocked' || x.heatC === null) sp = roundStep(F, step, 'ceil');
  else if (status === 'open') sp = roundStep(x.heatC + tol.above, step, 'ceil');
  else sp = roundStep(Math.max(x.heatC - tol.below, F), step, 'floor');
  return clamp(sp, caps.setpointRange[0], caps.setpointRange[1]);
}

export function trvStatusOf(open: boolean, x: Pick<TrvRoomInput, 'frost' | 'blocked' | 'heatAllowed' | 'heatC'>): TrvStatus {
  if (x.frost) return 'frost';
  if (x.blocked || !x.heatAllowed || x.heatC === null) return 'blocked';
  return open ? 'open' : 'satisfied';
}

export function trvActuation(
  device: EmitterDevice,
  open: boolean,
  entities: Record<EntityId, EntitySnap>,
  ledger: Record<string, ActuatorRecord>,
  x: TrvRoomInput,
): TrvOutput {
  const caps = device.capabilities ?? DEFAULT_TRV_CAPABILITIES;
  const sib = device.siblings;
  const cfg = x.room.trv;
  const snap = entities[device.entityId];
  const owner: DesiredActuator['owner'] = { type: 'trv', id: device.id, roomId: x.room.id };
  const ack = { ackTimeoutSec: cfg.ack.timeoutSec, maxAttempts: cfg.ack.attempts, backgroundRetryMin: cfg.ack.backgroundRetryMin };
  const desired: DesiredActuator[] = [];
  const status = trvStatusOf(open, x);
  const noData = x.t === null;
  const local = trvLocalTemp(snap);

  // the head regulates on the room sensor (external) unless the room has no temperature of its own
  const useExternal = !noData && !x.fallbackTrv;
  let setpoint: number;
  let valvePct: number | null = null;
  let integral: number | null = null;
  const strategy = cfg.strategy;
  const openish = status === 'open' || status === 'frost' || x.exercise;
  if (x.exercise) setpoint = clamp(EXERCISE_SETPOINT_C, caps.setpointRange[0], caps.setpointRange[1]);
  else if (noData && status !== 'frost') {
    // without a room temperature every head regulates itself to a safe value on its own sensor
    setpoint = clamp(roundStep(x.safety.noDataTrvSetpointC, caps.setpointStep || 0.5, 'nearest'), caps.setpointRange[0], caps.setpointRange[1]);
  } else if (strategy === 'onoff' || strategy === 'valve') {
    setpoint = strategy === 'valve' || openish ? cfg.onoffSetpoints.openC : cfg.onoffSetpoints.closedC;
    setpoint = clamp(setpoint, caps.setpointRange[0], caps.setpointRange[1]);
  } else {
    setpoint = trvSetpoint(status, x, caps);
    // on its own sensor the head reads the learned offset higher than the room
    const o = x.fallbackTrv ? x.offsetOf(device.id) : null;
    if (o !== null && (status === 'open' || status === 'satisfied')) {
      const step = caps.setpointStep || 0.5;
      setpoint = clamp(roundStep(setpoint + o, step, status === 'open' ? 'ceil' : 'floor'), caps.setpointRange[0], caps.setpointRange[1]);
    }
  }

  const hvacMode = x.heatAllowed || x.frost || x.exercise ? 'heat' : 'off';
  const safety = x.frost || x.overheat;
  desired.push(
    actuator(device.entityId, { kind: 'climate', hvacMode, temperature: setpoint, targetLow: null, targetHigh: null, fanMode: null }, owner, {
      ...ack,
      urgency: safety ? 'safety' : 'normal',
      confirm: { kind: 'climate', tolerance: 0.05 },
      minIntervalSec: TRV_SPACING_SEC,
      deadband: 0.1,
      userSetpointAttr: 'temperature',
      reqId: x.reqId,
    }),
  );

  const background = { ...ack, urgency: 'background' as const, minIntervalSec: CONFIG_EVERY_SEC };
  if (strategy === 'external' && sib?.sensorSelect) {
    const option = useExternal ? 'external' : 'internal';
    desired.push(actuator(sib.sensorSelect, { kind: 'select', option }, owner, background, { prop: 'temperature_sensor_select', payload: option }));
  }
  let externalSent: number | null = null;
  if (strategy === 'external' && sib?.externalTemp) {
    const key = parseZ2m(sib.externalTemp, 'external_temperature_input')?.key ?? sib.externalTemp;
    externalSent = commandedNumber(ledger[key]);
    if (useExternal && x.t !== null) {
      const value = round1(x.t);
      const saver = cfg.batterySaver;
      const immediate = externalSent === null || Math.abs(value - externalSent) >= EXTERNAL_IMMEDIATE_DELTA_C || !saver.enabled;
      desired.push(
        actuator(
          sib.externalTemp,
          { kind: 'number', value },
          owner,
          {
            ...ack,
            urgency: immediate ? 'normal' : 'background',
            confirm: { kind: 'number_equals', tolerance: 0.05 },
            minIntervalSec: immediate ? 0 : saver.minIntervalMin * 60,
            deadband: saver.enabled ? saver.minDeltaC : 0.05,
            refreshEverySec: saver.keepAliveMin * 60,
          },
          { prop: 'external_temperature_input', payload: value },
        ),
      );
    }
  }
  if (strategy === 'calibration' && sib?.calibration) {
    const calSnap = entities[sib.calibration];
    const current = snapNum(calSnap) ?? 0;
    const range = caps.calibrationRange ?? [-10, 10];
    let value: number | null = null;
    if (noData) value = 0;
    else if (local !== null && x.t !== null) value = clamp(round1(x.t - local + current), range[0], range[1]);
    if (value !== null) {
      desired.push(
        actuator(
          sib.calibration,
          { kind: 'number', value },
          owner,
          { ...ack, urgency: 'background', confirm: { kind: 'number_equals', tolerance: 0.1 }, minIntervalSec: CALIBRATION_EVERY_SEC, deadband: CALIBRATION_DEADBAND_C },
          { prop: 'local_temperature_calibration', payload: value },
        ),
      );
    }
  }
  if (strategy === 'valve' && sib?.valveOpening) {
    const pi = cfg.valvePi;
    let I = x.valveIntegral[device.id] ?? 0;
    let u: number;
    if (status === 'frost' || x.exercise || noData) u = pi.maxPct;
    else if (status === 'open' && x.t !== null && x.heatC !== null && pi.kp > 0) {
      const e = x.heatC - x.t;
      const lim = 100 / pi.kp;
      I = clamp(I + (e * x.dtMin) / Math.max(pi.tiMin, 1), -lim, lim);
      u = clamp(pi.kp * (e + I), pi.minPct, pi.maxPct);
    } else {
      u = 0;
      I = 0.5 * I;
    }
    u = Math.round(u);
    integral = I;
    valvePct = u;
    const last = commandedNumber(ledger[parseZ2m(sib.valveOpening, 'valve_opening_degree')?.key ?? sib.valveOpening]);
    // opening from or closing to zero is a state change, not a trim: send it at once
    const edge = last === null || (last === 0) !== (u === 0);
    desired.push(
      actuator(
        sib.valveOpening,
        { kind: 'number', value: u },
        owner,
        {
          ...ack,
          urgency: edge ? 'normal' : 'background',
          confirm: { kind: 'number_equals', tolerance: 1 },
          minIntervalSec: edge ? 0 : pi.everyMin * 60,
          deadband: edge ? 0 : pi.minStepPct,
        },
        { prop: 'valve_opening_degree', payload: u },
      ),
    );
  } else if (sib?.valveOpening && sib.valveClosing) {
    // per-room hydraulic balancing is out of scope: the valve travels fully in both directions
    desired.push(actuator(sib.valveOpening, { kind: 'number', value: 100 }, owner, { ...background, confirm: { kind: 'number_equals', tolerance: 1 } }, { prop: 'valve_opening_degree', payload: 100 }));
    desired.push(actuator(sib.valveClosing, { kind: 'number', value: 100 }, owner, { ...background, confirm: { kind: 'number_equals', tolerance: 1 } }, { prop: 'valve_closing_degree', payload: 100 }));
  }
  if (sib?.childLock && !sib.childLock.startsWith('lock.')) {
    const on = cfg.childLock;
    desired.push(actuator(sib.childLock, { kind: 'switch', on }, owner, background, { prop: 'child_lock', payload: on ? 'LOCK' : 'UNLOCK' }));
  }
  if (sib?.windowDetection) {
    const on = !x.room.windows.disableTrvBuiltinDetection;
    desired.push(actuator(sib.windowDetection, { kind: 'switch', on }, owner, background, { prop: 'window_detection', payload: on ? 'ON' : 'OFF' }));
  }

  const available = !!snap && snap.available;
  let activity: TrvActivity;
  if (!available) activity = 'offline';
  else if (x.exercise) activity = 'exercise';
  else if (status === 'frost') activity = 'frost';
  else if (noData) activity = 'safe_mode';
  else if (hvacMode === 'off') activity = 'off';
  else if (status === 'open') activity = 'heating';
  else if (status === 'blocked') activity = 'closed';
  else activity = 'idle';

  const rec = ledger[device.entityId];
  const posSnap = sib?.valvePosition ? entities[sib.valvePosition] : undefined;
  const batSnap = sib?.battery ? entities[sib.battery] : undefined;
  const lqiSnap = sib?.linkquality ? entities[sib.linkquality] : undefined;
  const state: TrvState = {
    deviceId: device.id,
    emitterId: device.emitterId,
    entityId: device.entityId,
    name: device.name,
    activity,
    commandedSetpointC: commandedNumber(rec),
    reportedSetpointC: attrNum(snap, 'temperature'),
    localTempC: local,
    deltaToRoomC: local !== null && x.t !== null ? round1(local - x.t) : null,
    valvePct: snapNum(posSnap) ?? attrNum(snap, 'valve_position', 'position', 'pi_heating_demand') ?? valvePct,
    externalTempSentC: externalSent,
    batteryPct: snapNum(batSnap) ?? batteryOf(snap),
    lqi: snapNum(lqiSnap) ?? lqiOf(snap),
    lastSeenAt: snap ? snap.lastReported : null,
    available,
    sync: progressOf(rec, cfg.ack.attempts),
  };
  return { desired, state, status, valveIntegral: integral };
}

/** Values a head is left with when its room is deleted or the head removed: its own sensor, 20°. */
export function trvReleaseDesired(device: EmitterDevice, room: RoomConfig): DesiredActuator[] {
  const owner: DesiredActuator['owner'] = { type: 'trv', id: device.id, roomId: room.id };
  const out = [
    actuator(device.entityId, { kind: 'climate', hvacMode: 'heat', temperature: room.trv.releaseSetpointC, targetLow: null, targetHigh: null, fanMode: null }, owner, {
      urgency: 'normal',
      confirm: { kind: 'climate', tolerance: 0.05 },
    }),
  ];
  const sib = device.siblings;
  if (sib?.sensorSelect) out.push(actuator(sib.sensorSelect, { kind: 'select', option: 'internal' }, owner, {}, { prop: 'temperature_sensor_select', payload: 'internal' }));
  if (sib?.childLock && !sib.childLock.startsWith('lock.')) out.push(actuator(sib.childLock, { kind: 'switch', on: false }, owner, {}, { prop: 'child_lock', payload: 'UNLOCK' }));
  return out;
}

/**
 * Graceful stop: heads go back to their own sensor at the current heat target (the frost floor when the
 * room is not heating), so they keep regulating while Klimo is away. Boot re-asserts the external sensor.
 */
export function trvHandbackDesired(device: EmitterDevice, room: RoomConfig, heatC: number | null, frostFloorC: number): DesiredActuator[] {
  const caps = device.capabilities ?? DEFAULT_TRV_CAPABILITIES;
  const owner: DesiredActuator['owner'] = { type: 'trv', id: device.id, roomId: room.id };
  const sp = clamp(roundStep(heatC ?? frostFloorC, caps.setpointStep || 0.5, 'nearest'), caps.setpointRange[0], caps.setpointRange[1]);
  const out = [
    actuator(device.entityId, { kind: 'climate', hvacMode: 'heat', temperature: sp, targetLow: null, targetHigh: null, fanMode: null }, owner, {
      urgency: 'safety',
      confirm: { kind: 'climate', tolerance: 0.05 },
    }),
  ];
  const sib = device.siblings;
  if (room.trv.strategy === 'external' && sib?.sensorSelect) {
    out.push(actuator(sib.sensorSelect, { kind: 'select', option: 'internal' }, owner, { urgency: 'safety' }, { prop: 'temperature_sensor_select', payload: 'internal' }));
  }
  return out;
}
