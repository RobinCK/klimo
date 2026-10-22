import type {
  ActuatorRecord,
  Circuit,
  DesiredActuator,
  DesiredValue,
  EntityId,
  EpochMs,
  Id,
  ModeOrNone,
  Pump,
  ServiceCallSpec,
  SourceConfig,
  SourceMemory,
  Urgency,
} from '../../shared/model';
import { hvacModeFor } from './ac';
import { roundStep } from './util';

/* =====================================================================================================
 * Desired values of the plant's actuators. Every source, pump and mixing valve states ON or OFF
 * explicitly each tick; the reconciler sends only differences. A relay with a device watchdog is
 * re-armed every few minutes while ON, so a dead Klimo lets the boiler drop on its own. Flow setpoints
 * move only by ≥ 0.5° and at most every 10 minutes, so a heat pump is not nudged every tick.
 * ===================================================================================================== */

const SETPOINT_STEP_C = 0.5;
const SETPOINT_EVERY_SEC = 600;
/** A source still drawing power after OFF is told again this often. */
const RECOMMAND_OFF_SEC = 60;

type Owner = DesiredActuator['owner'];

function base(key: string, entityId: EntityId | null, owner: Owner, urgency: Urgency, extra: Partial<DesiredActuator> = {}): Omit<DesiredActuator, 'value'> {
  return {
    key,
    entityId,
    urgency,
    owner,
    confirm: { kind: 'state_equals' },
    ackTimeoutSec: 60,
    maxAttempts: 3,
    backgroundRetryMin: 15,
    minIntervalSec: 0,
    deadband: 0,
    refreshEverySec: null,
    userSetpointAttr: null,
    reqId: null,
    ...extra,
  };
}

/** ON/OFF of any switchable entity a pump or relay may be (switch, input_boolean, light, fan, valve). */
export function onOffValue(entityId: EntityId, on: boolean): DesiredValue {
  const domain = entityId.split('.')[0];
  if (domain === 'valve') return { kind: 'valve', open: on, position: null };
  if (domain === 'fan') return { kind: 'fan', on, percentage: null };
  return { kind: 'switch', on };
}

/** Keeps the setpoint last sent unless it moves by ≥ 0.5° and the last write is ≥ 10 minutes old. */
function stableSetpoint(rec: ActuatorRecord | undefined, value: number | null, now: EpochMs): number | null {
  if (value === null) return null;
  const v = roundStep(value, 0.1, 'nearest');
  const sent = rec?.commanded;
  const prev = sent?.kind === 'climate' ? sent.temperature : sent?.kind === 'number' ? sent.value : null;
  if (prev === null || prev === undefined || rec?.commandedAt === null || rec?.commandedAt === undefined) return v;
  if (Math.abs(v - prev) < SETPOINT_STEP_C || now - rec.commandedAt < SETPOINT_EVERY_SEC * 1000) return prev;
  return v;
}

/** `{{mode}}`, `{{setpoint}}`… substituted in service data; a value that is exactly one placeholder keeps its type. */
export function substitute(calls: readonly ServiceCallSpec[], vars: Record<string, string | number | null>): ServiceCallSpec[] {
  const one = /^\{\{\s*(\w+)\s*\}\}$/;
  const any = /\{\{\s*(\w+)\s*\}\}/g;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const whole = one.exec(v);
      if (whole && whole[1] in vars) return vars[whole[1]];
      return v.replace(any, (m, k: string) => (k in vars && vars[k] !== null ? String(vars[k]) : m));
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return calls.map((c) => ({ ...c, ...(c.target ? { target: walk(c.target) as ServiceCallSpec['target'] } : {}), ...(c.data ? { data: walk(c.data) as Record<string, unknown> } : {}) }));
}

export interface SourceActuation {
  now: EpochMs;
  ledger: Record<string, ActuatorRecord>;
  urgency: Urgency;
  /** Setpoint for this run: flow (curve or dew-safe supply), room target, or fixed. */
  setpointC: number | null;
  flowC: number | null;
  roomTempC: number | null;
  roomTargetC: number | null;
  /** Commanded OFF but still drawing: re-send OFF every minute. */
  stillDrawing: boolean;
}

/** Desired values of a central or room source with a relay, climate, flow, script or custom adapter. */
export function sourceDesired(s: SourceConfig, m: SourceMemory, x: SourceActuation): DesiredActuator[] {
  const out: DesiredActuator[] = [];
  const a = s.adapter;
  const owner: Owner = { type: 'source', id: s.id, roomId: s.scope === 'room' ? s.roomId : null };
  const on = m.on && m.mode !== null;
  switch (a.type) {
    case 'relay': {
      if (!a.command) break;
      const relayOn = a.invert ? !on : on;
      out.push({ ...base(a.command, a.command, owner, x.urgency, { refreshEverySec: !on && x.stillDrawing ? RECOMMAND_OFF_SEC : null }), value: onOffValue(a.command, relayOn) });
      a.stages.forEach((st, i) => {
        // stage 1 is the command itself; stage k + 1 is stages[k − 1]
        const stageOn = on && m.stage >= i + 2;
        out.push({ ...base(st.entityId, st.entityId, owner, x.urgency), value: onOffValue(st.entityId, a.invert ? !stageOn : stageOn) });
      });
      if (on) {
        const wd = a.watchdog;
        // keep-alive of the device-side countdown; a counting-down number never "matches", so no confirmation
        if (wd.kind === 'countdown_number') {
          out.push({ ...base(wd.entityId, wd.entityId, { type: 'watchdog', id: s.id, roomId: owner.roomId }, 'source', { confirm: { kind: 'none' }, refreshEverySec: wd.rearmEveryMin * 60 }), value: { kind: 'number', value: wd.minutes } });
        } else if (wd.kind === 'service') {
          out.push({
            ...base(`svc:${s.id}:watchdog`, null, { type: 'watchdog', id: s.id, roomId: owner.roomId }, 'source', { confirm: { kind: 'none' }, refreshEverySec: wd.rearmEveryMin * 60 }),
            value: { kind: 'service', calls: [wd.call], runKey: `wd:${m.onSince ?? 0}` },
          });
        }
        if (a.flowSetpoint?.useCurve && x.flowC !== null) {
          out.push({ ...base(a.flowSetpoint.entityId, a.flowSetpoint.entityId, { type: 'aux', id: s.id, roomId: null }, 'source', { confirm: { kind: 'number_equals', tolerance: 0.1 }, deadband: SETPOINT_STEP_C, minIntervalSec: SETPOINT_EVERY_SEC }), value: { kind: 'number', value: x.flowC } });
        }
      }
      break;
    }
    case 'climate': {
      if (!a.climate) break;
      const rec = x.ledger[a.climate];
      const temperature = on && a.setpoint !== 'none' ? stableSetpoint(rec, x.setpointC, x.now) : null;
      out.push({
        ...base(a.climate, a.climate, owner, x.urgency, { confirm: { kind: 'climate', tolerance: 0.05 }, deadband: SETPOINT_STEP_C }),
        value: { kind: 'climate', hvacMode: on ? hvacModeFor(a, m.mode!) : a.modeMap.off, temperature, targetLow: null, targetHigh: null, fanMode: null },
      });
      break;
    }
    case 'flow': {
      if (a.enable) out.push({ ...base(a.enable, a.enable, owner, x.urgency), value: onOffValue(a.enable, on) });
      if (on && a.flowSetpoint && x.setpointC !== null) {
        out.push({ ...base(a.flowSetpoint, a.flowSetpoint, { type: 'aux', id: s.id, roomId: null }, 'source', { confirm: { kind: 'number_equals', tolerance: 0.1 }, deadband: SETPOINT_STEP_C, minIntervalSec: SETPOINT_EVERY_SEC }), value: { kind: 'number', value: roundStep(x.setpointC, 0.1, 'nearest') } });
      }
      if (on && a.modeSelect && (m.mode === 'heat' || m.mode === 'cool')) {
        out.push({ ...base(a.modeSelect.entityId, a.modeSelect.entityId, { type: 'aux', id: s.id, roomId: null }, 'source'), value: { kind: 'select', option: a.modeSelect[m.mode] } });
      }
      break;
    }
    case 'script': {
      const vars = { mode: m.mode, setpoint: x.setpointC };
      if (on) {
        const script = a.on[m.mode!];
        if (script) out.push({ ...base(`svc:${s.id}:on`, script, owner, x.urgency, { confirm: { kind: 'none' } }), value: { kind: 'script', script, variables: vars, runKey: `${m.mode}:${m.onSince ?? 0}` } });
      } else if (a.off) {
        out.push({ ...base(`svc:${s.id}:off`, a.off, owner, x.urgency, { confirm: { kind: 'none' } }), value: { kind: 'script', script: a.off, variables: null, runKey: `off:${m.offSince ?? 0}` } });
      }
      break;
    }
    case 'custom': {
      const vars = { mode: m.mode, setpoint: x.setpointC, flow: x.flowC, room_temp: x.roomTempC, room_target: x.roomTargetC, source_id: s.id };
      if (on) {
        const calls = a.on[m.mode!];
        if (calls?.length) out.push({ ...base(`svc:${s.id}:on`, null, owner, x.urgency, { confirm: { kind: 'none' } }), value: { kind: 'service', calls: substitute(calls, vars), runKey: `${m.mode}:${m.onSince ?? 0}` } });
        if (a.setpoint?.length && x.setpointC !== null) {
          const sp = roundStep(x.setpointC, SETPOINT_STEP_C, 'nearest');
          out.push({
            ...base(`svc:${s.id}:setpoint`, null, owner, 'source', { confirm: { kind: 'none' }, minIntervalSec: SETPOINT_EVERY_SEC }),
            value: { kind: 'service', calls: substitute(a.setpoint, { ...vars, setpoint: sp }), runKey: `sp:${sp}` },
          });
        }
      } else if (a.off.length) {
        out.push({ ...base(`svc:${s.id}:off`, null, owner, x.urgency, { confirm: { kind: 'none' } }), value: { kind: 'service', calls: substitute(a.off, vars), runKey: `off:${m.offSince ?? 0}` } });
      }
      break;
    }
  }
  return out;
}

/** A circulation pump ON/OFF, plus its speed while running. */
export function pumpDesired(p: Pump, on: boolean, mode: ModeOrNone, urgency: Urgency, roomId: Id | null = null): DesiredActuator[] {
  const owner: Owner = { type: 'pump', id: p.id, roomId };
  const out: DesiredActuator[] = [{ ...base(p.entityId, p.entityId, owner, urgency), value: onOffValue(p.entityId, on) }];
  if (on && p.speed && (mode === 'heat' || mode === 'cool')) {
    const v = p.speed[mode];
    const domain = p.speed.entityId.split('.')[0];
    const value: DesiredValue =
      typeof v === 'number' ? (domain === 'fan' ? { kind: 'fan', on: true, percentage: v } : { kind: 'number', value: v }) : { kind: 'select', option: String(v) };
    out.push({ ...base(p.speed.entityId, p.speed.entityId, owner, 'source', { confirm: value.kind === 'number' ? { kind: 'number_equals', tolerance: 0.5 } : { kind: 'state_equals' }, deadband: 1 }), value });
  }
  return out;
}

/** The floor mixing valve: its heating supply while the loop heats, the dew-safe supply while it cools. */
export function mixingDesired(c: Circuit, valueC: number): DesiredActuator | null {
  if (!c.mixingValve) return null;
  const id = c.mixingValve.entityId;
  return { ...base(id, id, { type: 'mixing', id: c.id, roomId: null }, 'source', { confirm: { kind: 'number_equals', tolerance: 0.1 }, deadband: SETPOINT_STEP_C }), value: { kind: 'number', value: roundStep(valueC, 0.1, 'nearest') } };
}
