import { isEntityId } from '../common/validate';
import { isLocalDate } from '../engine/core/time';
import { isLockedCell } from '../shared/defaults';
import { SLUG_PATTERN } from '../shared/translit';
import {
  ADAPTER_TYPES,
  AGGREGATION_METHODS,
  CHANNEL_KINDS,
  EMITTER_KINDS,
  EMITTER_ROLES,
  EVENT_KINDS,
  HOUSE_MODES,
  PRIORITY_DEFAULT,
  PRIORITY_LOCKED,
  PUMP_RULES,
  SEASONS,
  SOURCE_KINDS,
  SOURCE_LINKABLE_FIELDS,
  SYSTEM_PROFILE_IDS,
  TRV_STRATEGIES,
  WINDOW_REACTIONS,
} from '../shared/model';
import type {
  ActivationRule,
  ApiErrorIssue,
  ChainEntry,
  Circuit,
  ConditionNode,
  ConfigCollectionName,
  ConfigSingletonName,
  DeviceMeta,
  Emitter,
  EmitterDevice,
  EventParams,
  Id,
  Manifold,
  NotifyTarget,
  PersonalPrefs,
  Profile,
  ProfileRoomSetting,
  Pump,
  RoomConfig,
  RoomSensor,
  RoutingCell,
  RuleEffect,
  Schedule,
  ScheduleException,
  ServiceCallSpec,
  SourceConfig,
  Trigger,
  TriggerRule,
  WatchRule,
  Z2mInstance,
} from '../shared/model';
import type { ConfigGraph } from './graph';
import { conditionTriggers } from './refs';
import { dayIssues, weekIssues } from './schedule-ops';

/* =====================================================================================================
 * Cross-field and cross-entity rules for configuration writes. Every rule reports an issue with a
 * path relative to the object (`tolerance.heat.below`), a machine code the SPA translates and
 * params; the store collects issues of every touched object and rejects the write as a whole.
 * Types are checked as well — imports and internal callers do not pass through request schemas.
 * ===================================================================================================== */

export type Issues = ApiErrorIssue[];

/** What the validators may ask Home Assistant (absent when HA is not connected). */
export interface ValidationEnv {
  entityExists?: (entityId: string) => boolean | undefined;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const join = (path: string, key: string | number) => (path ? `${path}.${key}` : String(key));

/** Issue collector with typed checks. */
class V {
  readonly issues: Issues = [];

  constructor(private readonly env: ValidationEnv = {}) {}

  push(path: string, code: string, params?: Record<string, string | number>): void {
    this.issues.push(params ? { path, code, params } : { path, code });
  }

  num(path: string, v: unknown, min: number, max: number, step?: number): boolean {
    if (!isNum(v)) {
      this.push(path, 'type', { expected: 'number' });
      return false;
    }
    if (v < min - 1e-9 || v > max + 1e-9) {
      this.push(path, 'range', { min, max });
      return false;
    }
    if (step && Math.abs(v / step - Math.round(v / step)) > 1e-6) {
      this.push(path, 'step', { step });
      return false;
    }
    return true;
  }

  numOrNull(path: string, v: unknown, min: number, max: number, step?: number): void {
    if (v !== null) this.num(path, v, min, max, step);
  }

  int(path: string, v: unknown, min: number, max: number): boolean {
    if (!isNum(v) || !Number.isInteger(v)) {
      this.push(path, 'type', { expected: 'integer' });
      return false;
    }
    if (v < min || v > max) {
      this.push(path, 'range', { min, max });
      return false;
    }
    return true;
  }

  str(path: string, v: unknown, min: number, max: number): boolean {
    if (!isStr(v)) {
      this.push(path, 'type', { expected: 'string' });
      return false;
    }
    const len = v.trim().length;
    if (len < min) {
      this.push(path, min === 1 && len === 0 ? 'required' : 'length', { min, max });
      return false;
    }
    if (v.length > max) {
      this.push(path, 'length', { min, max });
      return false;
    }
    return true;
  }

  strOrNull(path: string, v: unknown, max: number): void {
    if (v !== null) this.str(path, v, 0, max);
  }

  bool(path: string, v: unknown): void {
    if (typeof v !== 'boolean') this.push(path, 'type', { expected: 'boolean' });
  }

  oneOf(path: string, v: unknown, values: readonly unknown[]): boolean {
    if (!values.includes(v)) {
      this.push(path, 'enum', { values: values.join('|') });
      return false;
    }
    return true;
  }

  /** An HA entity id; `required` false accepts null; `''` is a placeholder allowed only when `allowEmpty`. */
  entity(path: string, v: unknown, domains?: readonly string[], opts: { required?: boolean; allowEmpty?: boolean; checkExists?: boolean } = {}): void {
    if (v === null || v === undefined || v === '') {
      if (v === '' && opts.allowEmpty) return;
      if (opts.required || v === '') this.push(path, 'required');
      return;
    }
    if (!isEntityId(v)) {
      this.push(path, 'pattern', { expected: 'domain.object_id' });
      return;
    }
    if (domains && !isEntityId(v, domains)) {
      this.push(path, 'domain', { domains: domains.join('|') });
      return;
    }
    if (opts.checkExists && !v.startsWith('z2m:') && this.env.entityExists?.(v) === false) this.push(path, 'not_found');
  }

  hhmm(path: string, v: unknown): void {
    if (!isStr(v) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) this.push(path, 'pattern', { expected: 'HH:MM' });
  }

  color(path: string, v: unknown): void {
    if (!isStr(v) || !/^#[0-9A-Fa-f]{6}$/.test(v)) this.push(path, 'pattern', { expected: '#RRGGBB' });
  }

  exists(path: string, ok: boolean): void {
    if (!ok) this.push(path, 'not_found');
  }

  obj(path: string, v: unknown): v is Record<string, unknown> {
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) return true;
    this.push(path, 'type', { expected: 'object' });
    return false;
  }

  arr(path: string, v: unknown, max: number, min = 0): v is unknown[] {
    if (!Array.isArray(v)) {
      this.push(path, 'type', { expected: 'array' });
      return false;
    }
    if (v.length > max) this.push(path, 'max_items', { max });
    if (v.length < min) this.push(path, 'min_items', { min });
    return true;
  }
}

/* ── domains ──────────────────────────────────────────────────────────────────────────────────── */

const SWITCHABLE = ['switch', 'input_boolean', 'light', 'valve', 'fan'];
const NUMBER = ['number', 'input_number'];
const SENSOR_DOMAINS: Record<RoomSensor['role'], string[]> = {
  temperature: ['sensor', 'input_number', 'number', 'climate'], // a climate: its current_temperature
  humidity: ['sensor', 'input_number', 'number'],
  contact: ['binary_sensor', 'input_boolean', 'cover'],
  floor_probe: ['sensor', 'input_number', 'number'],
  glass: ['sensor', 'input_number', 'number'],
};
const HYDRONIC_KINDS: readonly Emitter['kind'][] = ['radiator', 'floor', 'fancoil', 'towel_rail'];

/* ── conditions ───────────────────────────────────────────────────────────────────────────────── */

interface CondCtx {
  g: ConfigGraph;
  /** Placeholders ('' entity) are allowed while the owner is disabled (seeded triggers before setup). */
  enabled: boolean;
  selfTriggerId?: Id;
}

const COND_OPS = ['all', 'any', 'not', 'state', 'numeric', 'template', 'time', 'sun', 'weather', 'trigger', 'outdoor', 'room_deficit', 'room_below_target', 'source', 'season', 'house_mode', 'budget_fits', 'grid', 'const'];

function exitSide(v: V, path: string, cmp: string, value: number, exitAt: unknown): void {
  if (exitAt === undefined) return;
  if (!isNum(exitAt)) return v.push(join(path, 'exitAt'), 'type', { expected: 'number' });
  // hysteresis must widen the condition: "< −10, exit at −8", "> 1500, exit at 1000"
  const ok = cmp === '<' || cmp === '<=' ? exitAt >= value : exitAt <= value;
  if (!ok) v.push(join(path, 'exitAt'), 'exit_side', { value });
}

function conditionInto(v: V, node: unknown, path: string, ctx: CondCtx, depth = 0): void {
  if (!v.obj(path, node)) return;
  if (depth > 12) return v.push(path, 'too_deep', { max: 12 });
  const n = node as Record<string, unknown>;
  if (!v.oneOf(join(path, 'op'), n.op, COND_OPS)) return;
  if (n.id !== undefined && !(isStr(n.id) && /^[A-Za-z0-9_.:-]{1,64}$/.test(n.id))) v.push(join(path, 'id'), 'pattern');
  if (n.forSec !== undefined) v.num(join(path, 'forSec'), n.forSec, 0, 86_400);
  const ent = (key: string, domains?: readonly string[], required = true) =>
    v.entity(join(path, key), n[key], domains, { required, allowEmpty: !ctx.enabled, checkExists: ctx.enabled });
  switch (n.op) {
    case 'all':
    case 'any':
      if (v.arr(join(path, 'items'), n.items, 30)) (n.items as unknown[]).forEach((c, i) => conditionInto(v, c, join(join(path, 'items'), i), ctx, depth + 1));
      break;
    case 'not':
      conditionInto(v, n.item, join(path, 'item'), ctx, depth + 1);
      break;
    case 'state':
      ent('entityId');
      if (n.attribute !== undefined) v.str(join(path, 'attribute'), n.attribute, 1, 80);
      if (v.arr(join(path, 'equals'), n.equals, 20, 1)) (n.equals as unknown[]).forEach((x, i) => v.str(join(join(path, 'equals'), i), x, 0, 255));
      break;
    case 'numeric':
      ent('entityId');
      if (n.minus !== undefined) ent('minus', undefined, false);
      if (n.attribute !== undefined) v.str(join(path, 'attribute'), n.attribute, 1, 80);
      if (v.oneOf(join(path, 'cmp'), n.cmp, ['<', '<=', '>', '>=']) && v.num(join(path, 'value'), n.value, -1e9, 1e9)) {
        exitSide(v, path, n.cmp as string, n.value as number, n.exitAt);
      }
      break;
    case 'template':
      v.str(join(path, 'template'), n.template, 1, 5000);
      break;
    case 'time':
      if (v.arr(join(path, 'windows'), n.windows, 10, 1)) {
        (n.windows as unknown[]).forEach((w, i) => {
          const p = join(join(path, 'windows'), i);
          if (!v.obj(p, w)) return;
          v.hhmm(join(p, 'from'), w.from);
          v.hhmm(join(p, 'to'), w.to);
          if (w.days !== undefined && v.arr(join(p, 'days'), w.days, 7)) (w.days as unknown[]).forEach((d, j) => v.int(join(join(p, 'days'), j), d, 0, 6));
        });
      }
      if (n.tariffEntityId !== undefined) ent('tariffEntityId', undefined, false);
      if (n.tariffStates !== undefined && v.arr(join(path, 'tariffStates'), n.tariffStates, 10)) (n.tariffStates as unknown[]).forEach((x, i) => v.str(join(join(path, 'tariffStates'), i), x, 1, 80));
      break;
    case 'sun':
      if (v.oneOf(join(path, 'is'), n.is, ['above_horizon', 'below_horizon', 'elevation_above', 'elevation_below']) && String(n.is).startsWith('elevation')) {
        v.num(join(path, 'degrees'), n.degrees, -90, 90);
      }
      break;
    case 'weather':
      ent('entityId', ['weather']);
      v.oneOf(join(path, 'field'), n.field, ['condition', 'temperature', 'cloud_coverage', 'forecast_high_today', 'forecast_low_today', 'forecast_high_tomorrow']);
      v.oneOf(join(path, 'cmp'), n.cmp, ['<', '<=', '>', '>=', '==', '!=']);
      if (!isNum(n.value) && !isStr(n.value)) v.push(join(path, 'value'), 'type', { expected: 'number|string' });
      break;
    case 'trigger':
      if (!isStr(n.triggerId) || !ctx.g.triggers.has(n.triggerId)) v.push(join(path, 'triggerId'), 'not_found');
      else if (n.triggerId === ctx.selfTriggerId) v.push(join(path, 'triggerId'), 'cycle');
      break;
    case 'outdoor':
      if (v.oneOf(join(path, 'cmp'), n.cmp, ['<', '<=', '>', '>=']) && v.num(join(path, 'value'), n.value, -50, 60)) exitSide(v, path, n.cmp as string, n.value as number, n.exitAt);
      if (n.basis !== undefined) v.oneOf(join(path, 'basis'), n.basis, ['now', 'avg10m', 'avg3d']);
      break;
    case 'room_deficit':
      if (n.roomIds !== 'served' && v.arr(join(path, 'roomIds'), n.roomIds, 100, 1)) {
        (n.roomIds as unknown[]).forEach((r, i) => v.exists(join(join(path, 'roomIds'), i), isStr(r) && ctx.g.rooms.has(r)));
      }
      v.num(join(path, 'deficitC'), n.deficitC, 0.1, 10);
      if (n.forMin !== undefined) v.num(join(path, 'forMin'), n.forMin, 0, 1440);
      break;
    case 'room_below_target':
      v.exists(join(path, 'roomId'), isStr(n.roomId) && ctx.g.rooms.has(n.roomId));
      v.num(join(path, 'plusC'), n.plusC, -5, 5);
      break;
    case 'source':
      v.exists(join(path, 'sourceId'), isStr(n.sourceId) && ctx.g.sources.has(n.sourceId));
      v.oneOf(join(path, 'is'), n.is, ['running', 'fault', 'unavailable', 'available', 'lagging']);
      break;
    case 'season':
      if (v.arr(join(path, 'in'), n.in, 3, 1)) (n.in as unknown[]).forEach((x, i) => v.oneOf(join(join(path, 'in'), i), x, SEASONS));
      break;
    case 'house_mode':
      if (v.arr(join(path, 'in'), n.in, 4, 1)) (n.in as unknown[]).forEach((x, i) => v.oneOf(join(join(path, 'in'), i), x, HOUSE_MODES));
      break;
    case 'grid':
      v.oneOf(join(path, 'is'), n.is, ['present', 'absent']);
      break;
    case 'const':
      v.bool(join(path, 'value'), n.value);
      break;
  }
}

export function conditionIssues(node: unknown, ctx: CondCtx, env: ValidationEnv = {}): Issues {
  const v = new V(env);
  conditionInto(v, node, '', ctx);
  return v.issues;
}

/* ── sources ──────────────────────────────────────────────────────────────────────────────────── */

function callsInto(v: V, path: string, calls: unknown, min: number): void {
  if (!v.arr(path, calls, 20, min)) return;
  (calls as unknown[]).forEach((c, i) => {
    const p = join(path, i);
    if (!v.obj(p, c)) return;
    const call = c as Partial<ServiceCallSpec>;
    if (!isStr(call.domain) || !/^[a-z_][a-z0-9_]*$/.test(call.domain)) v.push(join(p, 'domain'), 'pattern');
    if (!isStr(call.service) || !/^[a-z_][a-z0-9_]*$/.test(call.service)) v.push(join(p, 'service'), 'pattern');
  });
}

/**
 * Required HA bindings of a source's adapter. A source may only be enabled when this is empty;
 * the add-source wizard shows the same rows («оберіть» / «гаразд»).
 */
export function bindingIssues(adapter: SourceConfig['adapter'], capabilities: SourceConfig['capabilities'], env: ValidationEnv = {}): Issues {
  const v = new V(env);
  if (!v.obj('adapter', adapter) || !v.oneOf('adapter.type', adapter.type, ADAPTER_TYPES)) return v.issues;
  const a = adapter;
  const req = { required: true, checkExists: true };
  switch (a.type) {
    case 'relay':
      v.entity('adapter.command', a.command, SWITCHABLE, req);
      if (v.arr('adapter.stages', a.stages, 5)) {
        a.stages.forEach((s, i) => {
          v.entity(`adapter.stages.${i}.entityId`, s?.entityId, SWITCHABLE, req);
          v.num(`adapter.stages.${i}.powerKw`, s?.powerKw, 0, 50);
        });
      }
      if (a.flowSetpoint) v.entity('adapter.flowSetpoint.entityId', a.flowSetpoint.entityId, NUMBER, req);
      if (a.watchdog?.kind === 'countdown_number') {
        v.entity('adapter.watchdog.entityId', a.watchdog.entityId, [...NUMBER, 'timer'], req);
        if (v.num('adapter.watchdog.minutes', a.watchdog.minutes, 1, 120)) {
          // re-arm well before the device gives up so one missed tick never drops the relay
          if (!isNum(a.watchdog.rearmEveryMin) || a.watchdog.rearmEveryMin <= 0 || a.watchdog.rearmEveryMin > a.watchdog.minutes / 3) {
            v.push('adapter.watchdog.rearmEveryMin', 'range', { min: 1, max: Math.floor(a.watchdog.minutes / 3) });
          }
        }
      } else if (a.watchdog?.kind === 'service') {
        callsInto(v, 'adapter.watchdog.call', [a.watchdog.call], 1);
        v.num('adapter.watchdog.rearmEveryMin', a.watchdog.rearmEveryMin, 1, 60);
      } else if (a.watchdog?.kind === 'device') {
        v.num('adapter.watchdog.minutes', a.watchdog.minutes, 1, 240);
      } else if (a.watchdog?.kind !== 'none') {
        v.push('adapter.watchdog.kind', 'enum', { values: 'none|countdown_number|service|device' });
      }
      break;
    case 'climate': {
      v.entity('adapter.climate', a.climate, ['climate'], req);
      if (v.obj('adapter.modeMap', a.modeMap)) {
        if (!isStr(a.modeMap.off) || !a.modeMap.off) v.push('adapter.modeMap.off', 'required');
        for (const mode of ['heat', 'cool', 'dry', 'fan'] as const) {
          if (capabilities?.[mode] && (!isStr(a.modeMap[mode]) || !a.modeMap[mode])) v.push(`adapter.modeMap.${mode}`, 'required');
        }
      }
      v.oneOf('adapter.setpoint', a.setpoint, ['flow_curve', 'room_target', 'fixed', 'none']);
      if (a.setpoint === 'fixed') {
        if (!a.fixedSetpoint) v.push('adapter.fixedSetpoint', 'required');
        else {
          v.num('adapter.fixedSetpoint.heatC', a.fixedSetpoint.heatC, 5, 75);
          v.num('adapter.fixedSetpoint.coolC', a.fixedSetpoint.coolC, 5, 35);
        }
      }
      for (const k of ['defrostEntityId', 'errorEntityId', 'copEntityId', 'supplyTempEntityId'] as const) v.entity(`adapter.${k}`, a[k], undefined, { checkExists: true });
      break;
    }
    case 'flow':
      v.entity('adapter.enable', a.enable, SWITCHABLE, req);
      v.entity('adapter.flowSetpoint', a.flowSetpoint, NUMBER, req);
      v.entity('adapter.actualFlow', a.actualFlow, undefined, { checkExists: true });
      if (a.modeSelect) {
        v.entity('adapter.modeSelect.entityId', a.modeSelect.entityId, ['select', 'input_select'], req);
        v.str('adapter.modeSelect.heat', a.modeSelect.heat, 1, 80);
        v.str('adapter.modeSelect.cool', a.modeSelect.cool, 1, 80);
      }
      break;
    case 'script': {
      v.entity('adapter.off', a.off, ['script'], req);
      const on = Object.entries(a.on ?? {}).filter(([, e]) => !!e);
      if (!on.length) v.push('adapter.on', 'required');
      for (const [mode, e] of on) v.entity(`adapter.on.${mode}`, e, ['script'], req);
      break;
    }
    case 'custom': {
      callsInto(v, 'adapter.off', a.off, 1);
      const on = Object.entries(a.on ?? {}).filter(([, calls]) => Array.isArray(calls) && calls.length);
      if (!on.length) v.push('adapter.on', 'required');
      for (const [mode, calls] of on) callsInto(v, `adapter.on.${mode}`, calls, 1);
      if (a.setpoint !== null) callsInto(v, 'adapter.setpoint', a.setpoint, 1);
      break;
    }
  }
  const c = a.confirm;
  if (v.obj('adapter.confirm', c)) {
    switch (c.kind) {
      case 'none':
      case 'readback':
        break;
      case 'hvac_action':
        if (a.type !== 'climate') v.push('adapter.confirm.kind', 'unsupported');
        break;
      case 'entity_on':
        v.entity('adapter.confirm.entityId', c.entityId, undefined, req);
        break;
      case 'power_above':
        v.entity('adapter.confirm.entityId', c.entityId, ['sensor', 'input_number', 'number'], req);
        v.num('adapter.confirm.thresholdW', c.thresholdW, 1, 100_000);
        break;
      case 'state_in':
        v.entity('adapter.confirm.entityId', c.entityId, undefined, req);
        if (v.arr('adapter.confirm.values', c.values, 20, 1)) c.values.forEach((x, i) => v.str(`adapter.confirm.values.${i}`, x, 1, 80));
        break;
      default:
        v.push('adapter.confirm.kind', 'enum', { values: 'none|readback|entity_on|power_above|hvac_action|state_in' });
    }
  }
  return v.issues;
}

function curveInto(v: V, s: SourceConfig): void {
  const heat = s.curves?.heat;
  if (heat) {
    if (v.arr('curves.heat.points', heat.points, 4, 2)) {
      heat.points.forEach((p, i) => {
        v.num(`curves.heat.points.${i}.outdoorC`, p?.outdoorC, -40, 40);
        v.num(`curves.heat.points.${i}.flowC`, p?.flowC, 20, 75);
        if (i > 0 && isNum(p?.outdoorC) && isNum(heat.points[i - 1]?.outdoorC) && p.outdoorC <= heat.points[i - 1].outdoorC) {
          v.push(`curves.heat.points.${i}.outdoorC`, 'ascending');
        }
      });
    }
    v.num('curves.heat.shiftC', heat.shiftC, -10, 10);
    if (v.num('curves.heat.minFlowC', heat.minFlowC, 20, 75) && v.num('curves.heat.maxFlowC', heat.maxFlowC, 20, 75) && heat.minFlowC >= heat.maxFlowC) {
      v.push('curves.heat.maxFlowC', 'order', { min: heat.minFlowC });
    }
  }
  const cool = s.curves?.cool;
  if (cool && v.num('curves.cool.flowC', cool.flowC, 12, 24) && v.num('curves.cool.maxFlowC', cool.maxFlowC, 12, 26) && cool.maxFlowC < cool.flowC) {
    v.push('curves.cool.maxFlowC', 'order', { min: cool.flowC });
  }
}

export function validateSource(s: SourceConfig, g: ConfigGraph, env: ValidationEnv = {}): Issues {
  const v = new V(env);
  v.str('name', s.name, 1, 40);
  v.oneOf('kind', s.kind, SOURCE_KINDS);
  v.str('subtype', s.subtype, 0, 80);
  if (v.oneOf('scope', s.scope, ['central', 'room'])) {
    if (s.scope === 'room') v.exists('roomId', !!s.roomId && g.rooms.has(s.roomId));
    else if (s.roomId !== null) v.push('roomId', 'must_be_null');
  }
  v.bool('enabled', s.enabled);
  if (v.obj('capabilities', s.capabilities)) {
    for (const k of ['heat', 'cool', 'dry', 'fan'] as const) v.bool(`capabilities.${k}`, s.capabilities[k]);
    if (!s.capabilities.heat && !s.capabilities.cool && !s.capabilities.dry && !s.capabilities.fan) v.push('capabilities', 'required');
  }
  if (v.obj('energy', s.energy)) {
    v.oneOf('energy.carrier', s.energy.carrier, ['electric', 'gas', 'other']);
    v.num('energy.maxPowerKw', s.energy.maxPowerKw, 0, 100);
    v.num('energy.auxPowerKw', s.energy.auxPowerKw, 0, 10);
    v.entity('energy.powerEntityId', s.energy.powerEntityId, ['sensor', 'input_number', 'number'], { checkExists: s.enabled });
    v.numOrNull('energy.minBatteryPct', s.energy.minBatteryPct, 0, 100);
    v.numOrNull('energy.staggerSec', s.energy.staggerSec, 0, 120);
  }
  const gd = s.guards;
  if (v.obj('guards', gd)) {
    v.num('guards.minRunMin', gd.minRunMin, 0, 60);
    v.num('guards.minOffMin', gd.minOffMin, 0, 60);
    if (gd.maxStartsPerHour !== null) v.int('guards.maxStartsPerHour', gd.maxStartsPerHour, 1, 20);
    v.num('guards.startConfirmTimeoutMin', gd.startConfirmTimeoutMin, 1, 30);
    v.num('guards.unavailableAfterMin', gd.unavailableAfterMin, 0, 60);
    v.num('guards.faultRetryMin', gd.faultRetryMin, 1, 240);
    v.bool('guards.defrostIsNotFault', gd.defrostIsNotFault);
    v.numOrNull('guards.roomMaxC', gd.roomMaxC, 15, 35);
    v.num('guards.stageUpAfterMin', gd.stageUpAfterMin, 1, 60);
    v.numOrNull('guards.changeoverMinH', gd.changeoverMinH, 1, 12);
  }
  curveInto(v, s);
  for (const mode of ['heat', 'cool'] as const) {
    const lim = s.outdoorLimits?.[mode];
    if (!lim) continue;
    v.numOrNull(`outdoorLimits.${mode}.minC`, lim.minC, -40, 50);
    v.numOrNull(`outdoorLimits.${mode}.maxC`, lim.maxC, -40, 50);
    v.num(`outdoorLimits.${mode}.hysteresisC`, lim.hysteresisC, 0, 5);
  }
  if (v.obj('conditions', s.conditions)) {
    v.oneOf('conditions.join', s.conditions.join, ['all', 'any', 'perMode']);
    if (v.arr('conditions.items', s.conditions.items, 20)) {
      const ids = new Set<string>();
      s.conditions.items.forEach((item, i) => {
        const p = `conditions.items.${i}`;
        if (!v.obj(p, item)) return;
        if (!isStr(item.id) || !item.id || ids.has(item.id)) v.push(`${p}.id`, 'unique');
        ids.add(item.id);
        if (item.mode !== null) v.oneOf(`${p}.mode`, item.mode, ['heat', 'cool']);
        v.bool(`${p}.enabled`, item.enabled);
        conditionInto(v, item.node, `${p}.node`, { g, enabled: s.enabled && item.enabled });
      });
    }
  }
  v.oneOf('seasonPolicy.heat', s.seasonPolicy?.heat, ['season', 'always']);
  v.oneOf('seasonPolicy.cool', s.seasonPolicy?.cool, ['season', 'always']);
  if (v.oneOf('failsafe.onStop', s.failsafe?.onStop, ['off', 'leave', 'handback']) && s.failsafe.onStop === 'handback') {
    if (s.adapter?.type !== 'climate' && s.adapter?.type !== 'flow') v.push('failsafe.onStop', 'unsupported');
    if (!s.failsafe.handback) v.push('failsafe.handback', 'required');
    else {
      v.str('failsafe.handback.hvacMode', s.failsafe.handback.hvacMode, 1, 40);
      v.num('failsafe.handback.setpointC', s.failsafe.handback.setpointC, 5, 75);
    }
  }
  if (s.hydronic !== null) {
    if (v.obj('hydronic', s.hydronic)) {
      v.bool('hydronic.requiresFlow', s.hydronic.requiresFlow);
      v.num('hydronic.preRunSec', s.hydronic.preRunSec, 0, 300);
    }
  }
  if (s.linkedTo !== null) {
    const t = g.sources.get(s.linkedTo);
    if (!t) v.push('linkedTo', 'not_found');
    else if (t.id === s.id || t.linkedTo !== null) v.push('linkedTo', 'chain');
    else if (t.kind !== s.kind) v.push('linkedTo', 'kind_mismatch');
  }
  if (v.arr('ownFields', s.ownFields, SOURCE_LINKABLE_FIELDS.length)) s.ownFields.forEach((f, i) => v.oneOf(`ownFields.${i}`, f, SOURCE_LINKABLE_FIELDS));

  // a disabled source may keep half-done bindings, but whatever is bound must be a valid entity
  const binding = bindingIssues(s.adapter, s.capabilities, s.enabled ? env : {});
  if (s.enabled && binding.length) {
    v.push('enabled', 'bindings', { count: binding.length });
    v.issues.push(...binding);
  } else {
    v.issues.push(...binding.filter((x) => x.code !== 'required' && x.code !== 'not_found'));
  }
  return v.issues;
}

/* ── rooms and their parts ────────────────────────────────────────────────────────────────────── */

function bandInto(v: V, path: string, band: unknown): void {
  if (!v.obj(path, band)) return;
  v.num(`${path}.below`, band.below, 0.1, 1.0, 0.1);
  v.num(`${path}.above`, band.above, 0.1, 1.0, 0.1);
}

function roomTrvs(g: ConfigGraph, roomId: Id): EmitterDevice[] {
  return [...g.emitterDevices.values()].filter((d) => d.roomId === roomId && d.kind === 'trv');
}

const STRATEGY_NEEDS: Record<RoomConfig['trv']['strategy'], (c: NonNullable<EmitterDevice['capabilities']>) => boolean> = {
  external: (c) => c.externalSensor,
  calibration: (c) => c.calibration,
  onoff: () => true,
  valve: (c) => c.valvePosition || c.valveLimits,
};

export function validateRoom(r: RoomConfig, g: ConfigGraph): Issues {
  const v = new V();
  v.str('name', r.name, 1, 40);
  if (!isStr(r.slug) || !SLUG_PATTERN.test(r.slug)) v.push('slug', 'pattern', { expected: '[a-z0-9_]{1,40}' });
  const lower = isStr(r.name) ? r.name.trim().toLowerCase() : '';
  for (const o of g.rooms.values()) {
    if (o.id === r.id) continue;
    if (o.name.trim().toLowerCase() === lower) v.push('name', 'unique');
    if (o.slug === r.slug) v.push('slug', 'unique');
  }
  v.int('order', r.order, 0, 10_000);
  v.bool('controlEnabled', r.controlEnabled);
  if (v.obj('tolerance', r.tolerance)) {
    bandInto(v, 'tolerance.heat', r.tolerance.heat);
    bandInto(v, 'tolerance.cool', r.tolerance.cool);
  }
  if (v.obj('demand', r.demand)) {
    v.oneOf('demand.policy', r.demand.policy, ['call', 'piggyback', 'never']);
    v.num('demand.minRequestMin', r.demand.minRequestMin, 0, 30);
  }
  if (r.limits !== null && v.obj('limits', r.limits)) {
    const lim = g.settings.targetLimits;
    v.num('limits.heatMinC', r.limits.heatMinC, lim.heatMinC, lim.heatMaxC);
    v.num('limits.heatMaxC', r.limits.heatMaxC, lim.heatMinC, lim.heatMaxC);
    v.num('limits.coolMinC', r.limits.coolMinC, lim.coolMinC, lim.coolMaxC);
    v.num('limits.coolMaxC', r.limits.coolMaxC, lim.coolMinC, lim.coolMaxC);
    if (r.limits.heatMinC >= r.limits.heatMaxC) v.push('limits.heatMaxC', 'order', { min: r.limits.heatMinC });
    if (r.limits.coolMinC >= r.limits.coolMaxC) v.push('limits.coolMaxC', 'order', { min: r.limits.coolMinC });
  }
  const t = r.temperature;
  if (v.obj('temperature', t)) {
    v.oneOf('temperature.method', t.method, AGGREGATION_METHODS);
    v.num('temperature.outlier.thresholdC', t.outlier?.thresholdC, 0.5, 3.0);
    v.num('temperature.staleAfterMin', t.staleAfterMin, 15, 240);
    v.oneOf('temperature.smoothingMin', t.smoothingMin, [0, 2, 5, 10, 15]);
    if (t.method === 'primary' && ![...g.sensors.values()].some((s) => s.roomId === r.id && s.role === 'temperature')) {
      v.push('temperature.method', 'needs_sensor');
    }
  }
  const h = r.humidity;
  if (v.obj('humidity', h)) {
    v.oneOf('humidity.method', h.method, ['average', 'median', 'max', 'min']);
    if (v.arr('humidity.comfortPct', h.comfortPct, 2, 2) && v.num('humidity.comfortPct.0', h.comfortPct[0], 0, 100) && v.num('humidity.comfortPct.1', h.comfortPct[1], 0, 100) && h.comfortPct[0] >= h.comfortPct[1]) {
      v.push('humidity.comfortPct.1', 'order');
    }
    v.num('humidity.warnAbovePct', h.warnAbovePct, 30, 95);
    v.num('humidity.warnForMin', h.warnForMin, 0, 240);
    v.num('humidity.dewGlassMarginC', h.dewGlassMarginC, 0.5, 10);
    if (h.dehumidifier) {
      v.entity('humidity.dehumidifier.entityId', h.dehumidifier.entityId, [...SWITCHABLE, 'humidifier'], { required: true });
      if (v.num('humidity.dehumidifier.onAbovePct', h.dehumidifier.onAbovePct, 30, 95) && v.num('humidity.dehumidifier.offBelowPct', h.dehumidifier.offBelowPct, 20, 95) && h.dehumidifier.offBelowPct >= h.dehumidifier.onAbovePct) {
        v.push('humidity.dehumidifier.offBelowPct', 'order', { max: h.dehumidifier.onAbovePct });
      }
      v.num('humidity.dehumidifier.minOnMin', h.dehumidifier.minOnMin, 0, 120);
    }
    v.oneOf('humidity.airingHint', h.airingHint, ['notify', 'auto_pause']);
  }
  const w = r.windows;
  if (v.obj('windows', w)) {
    v.oneOf('windows.reaction', w.reaction, WINDOW_REACTIONS);
    v.num('windows.lowerByC', w.lowerByC, 1, 5);
    v.num('windows.openDelaySec', w.openDelaySec, 0, 300);
    v.num('windows.resumeDelaySec', w.resumeDelaySec, 0, 1800);
    v.num('windows.remindAfterMin', w.remindAfterMin, 5, 120);
    v.num('windows.notifyAfterMin', w.notifyAfterMin, 5, 60);
    if (w.tempDrop) {
      v.num('windows.tempDrop.dropC', w.tempDrop.dropC, 0.5, 3);
      v.num('windows.tempDrop.windowMin', w.tempDrop.windowMin, 2, 15);
      v.num('windows.tempDrop.holdMaxMin', w.tempDrop.holdMaxMin, 5, 120);
    }
  }
  const trv = r.trv;
  if (v.obj('trv', trv)) {
    if (v.oneOf('trv.strategy', trv.strategy, TRV_STRATEGIES)) {
      const unsupported = roomTrvs(g, r.id).find((d) => !STRATEGY_NEEDS[trv.strategy](d.capabilities ?? { externalSensor: false, calibration: false, calibrationRange: null, valveLimits: false, valvePosition: false, childLock: false, windowDetection: false, setpointRange: [5, 30], setpointStep: 0.5 }));
      if (unsupported) v.push('trv.strategy', 'unsupported', { device: unsupported.name, deviceId: unsupported.id, strategy: trv.strategy });
    }
    v.oneOf('trv.manualPolicy', trv.manualPolicy, ['slot', 'revert', 'save']);
    v.num('trv.revertAfterSec', trv.revertAfterSec, 0, 3600);
    v.num('trv.onoffSetpoints.openC', trv.onoffSetpoints?.openC, 25, 35);
    v.num('trv.onoffSetpoints.closedC', trv.onoffSetpoints?.closedC, 4, 10);
    v.num('trv.ack.timeoutSec', trv.ack?.timeoutSec, 30, 600);
    v.int('trv.ack.attempts', trv.ack?.attempts, 1, 10);
    v.num('trv.ack.backgroundRetryMin', trv.ack?.backgroundRetryMin, 1, 240);
    v.num('trv.releaseSetpointC', trv.releaseSetpointC, 5, 30);
    v.num('trv.batterySaver.minIntervalMin', trv.batterySaver?.minIntervalMin, 0, 60);
    v.num('trv.batterySaver.minDeltaC', trv.batterySaver?.minDeltaC, 0, 2);
    v.num('trv.batterySaver.keepAliveMin', trv.batterySaver?.keepAliveMin, 5, 240);
  }
  const ac = r.ac;
  if (v.obj('ac', ac)) {
    v.oneOf('ac.control', ac.control, ['target', 'onoff', 'asis']);
    v.num('ac.onoffSetpoints.heatC', ac.onoffSetpoints?.heatC, 16, 30);
    v.num('ac.onoffSetpoints.coolC', ac.onoffSetpoints?.coolC, 16, 30);
    v.hhmm('ac.quietNight.from', ac.quietNight?.from);
    v.hhmm('ac.quietNight.to', ac.quietNight?.to);
    v.num('ac.dry.abovePct', ac.dry?.abovePct, 40, 90);
    v.num('ac.correction.maxOffsetC', ac.correction?.maxOffsetC, 0, 5);
    v.num('ac.correction.maxStepC', ac.correction?.maxStepC, 0.1, 3);
    v.num('ac.correction.everyMin', ac.correction?.everyMin, 1, 60);
  }
  if (v.obj('quick', r.quick)) {
    v.num('quick.boostDeltaC', r.quick.boostDeltaC, 0.5, 3, 0.5);
    v.num('quick.boostMin', r.quick.boostMin, 10, 180);
    v.num('quick.airingMin', r.quick.airingMin, 5, 60);
  }
  if (v.obj('floor', r.floor)) {
    v.num('floor.maxFloorC', r.floor.maxFloorC, 20, 35);
    v.numOrNull('floor.minFloorC', r.floor.minFloorC, 5, 30);
  }
  // a room may only raise the house frost floor
  v.numOrNull('frostC', r.frostC, g.safety.frostC, 15);
  v.bool('sunnySide', r.sunnySide);
  if (v.obj('notify', r.notify)) for (const k of ['sensorStale', 'trvFailed', 'batteryLow', 'humidity', 'windowLeftOpen', 'tooCold', 'tooHot'] as const) v.bool(`notify.${k}`, r.notify[k]);
  return v.issues;
}

export function validateSensor(s: RoomSensor, g: ConfigGraph): Issues {
  const v = new V();
  v.exists('roomId', g.rooms.has(s.roomId));
  if (v.oneOf('role', s.role, ['temperature', 'humidity', 'contact', 'floor_probe', 'glass'])) {
    v.entity('entityId', s.entityId, SENSOR_DOMAINS[s.role], { required: true });
    if (s.role === 'contact') v.oneOf('contactKind', s.contactKind, ['window', 'door']);
    else if (s.contactKind !== null) v.push('contactKind', 'must_be_null');
  }
  v.str('name', s.name, 0, 80);
  v.num('weight', s.weight, 0.1, 2.0, 0.1);
  v.bool('included', s.included);
  if (s.excludedBy !== null) v.oneOf('excludedBy', s.excludedBy, ['user', 'notification']);
  for (const o of g.sensors.values()) {
    if (o.id === s.id || o.entityId !== s.entityId || o.role !== s.role) continue;
    if (o.roomId === s.roomId) v.push('entityId', 'unique');
    // a door contact may serve two rooms; a thermometer reports for one
    else if (s.role !== 'contact') v.push('entityId', 'bound_elsewhere', { roomId: o.roomId, room: g.rooms.get(o.roomId)?.name ?? '' });
  }
  return v.issues;
}

export function validateEmitter(e: Emitter, g: ConfigGraph): Issues {
  const v = new V();
  v.exists('roomId', g.rooms.has(e.roomId));
  v.str('name', e.name, 0, 80);
  v.bool('enabled', e.enabled);
  if (!v.oneOf('kind', e.kind, EMITTER_KINDS)) return v.issues;
  let canHeat = true;
  let canCool = true;
  if (e.kind === 'direct') {
    const s = e.sourceId ? g.sources.get(e.sourceId) : undefined;
    if (!s) v.push('sourceId', e.sourceId ? 'not_found' : 'required');
    else if (s.scope !== 'room' || s.roomId !== e.roomId) v.push('sourceId', 'other_room');
    if (e.circuitId !== null) v.push('circuitId', 'must_be_null');
    canHeat = !!s?.capabilities.heat;
    canCool = !!s?.capabilities.cool;
  } else {
    const c = e.circuitId ? g.circuits.get(e.circuitId) : undefined;
    if (e.circuitId && !c) v.push('circuitId', 'not_found');
    if (!e.circuitId && e.enabled) v.push('circuitId', 'required');
    if (e.sourceId !== null) v.push('sourceId', 'must_be_null');
    // a parked emitter (circuit removed) keeps its roles until it is attached again
    canHeat = c ? c.capabilities.heat : true;
    canCool = c ? c.capabilities.cool : true;
    // radiators and towel rails never carry chilled water
    if (e.kind === 'radiator' || e.kind === 'towel_rail') canCool = false;
  }
  if (v.obj('roles', e.roles)) {
    if (e.roles.heat !== null && v.oneOf('roles.heat', e.roles.heat, EMITTER_ROLES) && !canHeat) v.push('roles.heat', 'unsupported');
    if (e.roles.cool !== null && v.oneOf('roles.cool', e.roles.cool, EMITTER_ROLES) && !canCool) v.push('roles.cool', 'unsupported');
    if ((e.roles.heat === 'assist' || e.roles.cool === 'assist') && !e.assist) v.push('assist', 'required');
    if ((e.roles.heat === 'trigger' || e.roles.cool === 'trigger') && !e.trigger) v.push('trigger', 'required');
  }
  if (e.assist) v.num('assist.deficitC', e.assist.deficitC, 0.5, 5);
  if (e.trigger) v.num('trigger.heatStoreAboveTargetC', e.trigger.heatStoreAboveTargetC, 0, 5);
  v.bool('excludeFromCooling', e.excludeFromCooling);
  v.bool('ignoreSeason', e.ignoreSeason);
  return v.issues;
}

export function validateEmitterDevice(d: EmitterDevice, g: ConfigGraph): Issues {
  const v = new V();
  const e = g.emitters.get(d.emitterId);
  if (!e) v.push('emitterId', 'not_found');
  else {
    if (e.roomId !== d.roomId) v.push('roomId', 'mismatch');
    if (!HYDRONIC_KINDS.includes(e.kind)) v.push('emitterId', 'unsupported');
  }
  if (v.oneOf('kind', d.kind, ['trv', 'zone_valve', 'zone_switch'])) {
    const domains = d.kind === 'trv' ? ['climate'] : d.kind === 'zone_valve' ? ['valve', 'switch', 'number', 'input_number', 'input_boolean'] : ['switch', 'input_boolean', 'light'];
    v.entity('entityId', d.entityId, domains, { required: true });
  }
  v.str('name', d.name, 0, 80);
  v.strOrNull('label', d.label, 80);
  if (v.obj('transport', d.transport)) v.oneOf('transport.type', d.transport.type, ['z2m', 'zha', 'ha']);
  for (const o of g.emitterDevices.values()) if (o.id !== d.id && o.entityId === d.entityId) v.push('entityId', 'bound_elsewhere', { roomId: o.roomId, room: g.rooms.get(o.roomId)?.name ?? '' });
  if (d.siblings) for (const [k, x] of Object.entries(d.siblings)) if (x !== null && !(isStr(x) && (x.startsWith('z2m:') || isEntityId(x)))) v.push(`siblings.${k}`, 'pattern');
  return v.issues;
}

/* ── hydronics ────────────────────────────────────────────────────────────────────────────────── */

export function validateManifold(m: Manifold): Issues {
  const v = new V();
  v.str('name', m.name, 1, 40);
  v.entity('supplySensorEntityId', m.supplySensorEntityId, ['sensor', 'input_number', 'number']);
  v.entity('returnSensorEntityId', m.returnSensorEntityId, ['sensor', 'input_number', 'number']);
  return v.issues;
}

export function validateCircuit(c: Circuit, g: ConfigGraph): Issues {
  const v = new V();
  v.str('name', c.name, 1, 40);
  v.str('shortName', c.shortName, 0, 24);
  v.oneOf('kind', c.kind, ['radiators', 'floor', 'fancoil', 'other']);
  if (c.manifoldId !== null) v.exists('manifoldId', g.manifolds.has(c.manifoldId));
  if (v.arr('sourceIds', c.sourceIds, 20)) {
    const seen = new Set<string>();
    c.sourceIds.forEach((id, i) => {
      const s = g.sources.get(id);
      if (!s) v.push(`sourceIds.${i}`, 'not_found');
      else if (s.scope !== 'central') v.push(`sourceIds.${i}`, 'scope');
      if (seen.has(id)) v.push(`sourceIds.${i}`, 'unique');
      seen.add(id);
    });
  }
  if (v.obj('capabilities', c.capabilities)) {
    v.bool('capabilities.heat', c.capabilities.heat);
    v.bool('capabilities.cool', c.capabilities.cool);
  }
  if (v.obj('supply', c.supply)) {
    v.entity('supply.sensorEntityId', c.supply.sensorEntityId, ['sensor', 'input_number', 'number']);
    v.entity('supply.returnEntityId', c.supply.returnEntityId, ['sensor', 'input_number', 'number']);
    if (v.num('supply.coolC', c.supply.coolC, 15, 24) && v.num('supply.coolMaxC', c.supply.coolMaxC, 15, 26) && c.supply.coolMaxC < c.supply.coolC) {
      v.push('supply.coolMaxC', 'order', { min: c.supply.coolC });
    }
  }
  if (c.mixingValve) {
    v.entity('mixingValve.entityId', c.mixingValve.entityId, [...NUMBER, 'valve', 'climate'], { required: true });
    v.num('mixingValve.heatC', c.mixingValve.heatC, 20, 60);
    v.numOrNull('mixingValve.coolC', c.mixingValve.coolC, 15, 24);
  }
  v.numOrNull('dewMarginC', c.dewMarginC, 1, 5);
  v.oneOf('pumpGroupMode', c.pumpGroupMode, ['all', 'duty_standby']);
  v.bool('flowSafety', c.flowSafety);
  return v.issues;
}

export function validatePump(p: Pump, g: ConfigGraph): Issues {
  const v = new V();
  v.str('name', p.name, 1, 40);
  if ((p.circuitId === null) === (p.manifoldId === null)) v.push('circuitId', 'exactly_one', { of: 'circuitId|manifoldId' });
  if (p.circuitId !== null) v.exists('circuitId', g.circuits.has(p.circuitId));
  if (p.manifoldId !== null) v.exists('manifoldId', g.manifolds.has(p.manifoldId));
  v.entity('entityId', p.entityId, ['switch', 'input_boolean', 'fan', 'valve', 'light'], { required: true });
  for (const o of g.pumps.values()) if (o.id !== p.id && o.entityId === p.entityId) v.push('entityId', 'unique');
  v.oneOf('rule', p.rule, PUMP_RULES);
  v.num('runOnHeatMin', p.runOnHeatMin, 0, 30);
  v.num('runOnCoolMin', p.runOnCoolMin, 0, 30);
  v.num('minOnSec', p.minOnSec, 0, 600);
  v.bool('exercise', p.exercise);
  v.bool('enabled', p.enabled);
  if (p.speed) {
    v.entity('speed.entityId', p.speed.entityId, [...NUMBER, 'select', 'input_select', 'fan'], { required: true });
    if (!isNum(p.speed.heat) && !isStr(p.speed.heat)) v.push('speed.heat', 'type');
    if (!isNum(p.speed.cool) && !isStr(p.speed.cool)) v.push('speed.cool', 'type');
  }
  return v.issues;
}

/* ── profiles, schedules, activation ──────────────────────────────────────────────────────────── */

export function validateProfile(p: Profile, g: ConfigGraph): Issues {
  const v = new V();
  v.str('name', p.name, 1, 24);
  const lower = isStr(p.name) ? p.name.trim().toLowerCase() : '';
  for (const o of g.profiles.values()) if (o.id !== p.id && o.name.trim().toLowerCase() === lower) v.push('name', 'unique');
  v.oneOf('kind', p.kind, ['system', 'custom']);
  if ((SYSTEM_PROFILE_IDS as readonly string[]).includes(p.id) !== (p.kind === 'system')) v.push('kind', 'system_ids');
  v.color('color', p.color);
  v.color('ink', p.ink);
  v.str('icon', p.icon, 1, 24);
  const step = g.settings.targetLimits.stepC;
  const okHeat = v.num('heatC', p.heatC, 5, 30, step);
  const okCool = v.num('coolC', p.coolC, 16, 32, step);
  if (okHeat && okCool && p.coolC - p.heatC < g.cool.autoMinGapC - 1e-9) v.push('coolC', 'gap', { gapC: g.cool.autoMinGapC });
  v.bool('frostOnly', p.frostOnly);
  return v.issues;
}

export function validateProfileRoom(r: ProfileRoomSetting, g: ConfigGraph): Issues {
  const v = new V();
  v.exists('profileId', g.profiles.has(r.profileId));
  const room = g.rooms.get(r.roomId);
  v.exists('roomId', !!room);
  v.oneOf('mode', r.mode, ['own', 'off']);
  if (r.mode === 'own') {
    const lim = room?.limits ?? g.settings.targetLimits;
    const step = g.settings.targetLimits.stepC;
    if (r.heatC !== null) v.num('heatC', r.heatC, lim.heatMinC, lim.heatMaxC, step);
    if (r.coolC !== null) v.num('coolC', r.coolC, lim.coolMinC, lim.coolMaxC, step);
    const p = g.profiles.get(r.profileId);
    const heat = r.heatC ?? p?.heatC;
    const cool = r.coolC ?? p?.coolC;
    if (isNum(heat) && isNum(cool) && cool - heat < g.cool.autoMinGapC - 1e-9) v.push(r.coolC !== null ? 'coolC' : 'heatC', 'gap', { gapC: g.cool.autoMinGapC });
  } else if (r.heatC !== null || r.coolC !== null) {
    v.push('mode', 'values_with_off');
  }
  return v.issues;
}

export function validateActivationRule(a: ActivationRule, g: ConfigGraph): Issues {
  const v = new V();
  v.exists('profileId', g.profiles.has(a.profileId));
  v.bool('enabled', a.enabled);
  v.int('order', a.order, 0, 10_000);
  const c = a.config;
  if (!v.obj('config', c) || !v.oneOf('config.type', c.type, ['presence', 'calendar', 'vacation'])) return v.issues;
  if (c.type === 'presence') {
    v.oneOf('config.trigger', c.trigger, ['all_away', 'someone_home', 'approaching']);
    v.bool('config.optimalStart', c.optimalStart);
  } else if (c.type === 'calendar') {
    v.entity('config.calendarEntityId', c.calendarEntityId, ['calendar'], { required: true });
    v.oneOf('config.match.field', c.match?.field, ['summary', 'description', 'location']);
    v.str('config.match.contains', c.match?.contains, 1, 80);
    v.num('config.preheatMin', c.preheatMin, 0, 240);
  } else {
    if (c.from !== null) v.num('config.from', c.from, 0, 1e15);
    if (c.until !== null) v.num('config.until', c.until, 0, 1e15);
    if (isNum(c.from) && isNum(c.until) && c.until <= c.from) v.push('config.until', 'order');
    v.exists('config.returnProfileId', g.profiles.has(c.returnProfileId));
    v.num('config.returnLeadH', c.returnLeadH, 0, 24);
  }
  return v.issues;
}

export function validateSchedule(s: Schedule, g: ConfigGraph): Issues {
  const v = new V();
  if (v.oneOf('scope', s.scope, ['house', 'room'])) {
    if (s.scope === 'house') {
      if (s.id !== 'house') v.push('id', 'house_id');
      if (s.roomId !== null) v.push('roomId', 'must_be_null');
    } else {
      v.exists('roomId', !!s.roomId && g.rooms.has(s.roomId));
      for (const o of g.schedules.values()) if (o.id !== s.id && o.roomId === s.roomId) v.push('roomId', 'unique');
    }
  }
  v.bool('enabled', s.enabled);
  v.issues.push(...weekIssues(s.days, (id) => g.profiles.has(id)));
  return v.issues;
}

export function validateScheduleException(x: ScheduleException, g: ConfigGraph): Issues {
  const v = new V();
  v.exists('scheduleId', g.schedules.has(x.scheduleId));
  if (!isLocalDate(x.date)) v.push('date', 'pattern', { expected: 'YYYY-MM-DD' });
  for (const o of g.scheduleExceptions.values()) if (o.id !== x.id && o.scheduleId === x.scheduleId && o.date === x.date) v.push('date', 'unique');
  if (Array.isArray(x.plan)) v.issues.push(...dayIssues(x.plan, (id) => g.profiles.has(id)).map((i) => ({ ...i, path: i.path ? `plan.${i.path}` : 'plan' })));
  else if (v.obj('plan', x.plan)) v.int('plan.likeDow', x.plan.likeDow, 0, 6);
  v.strOrNull('note', x.note, 120);
  return v.issues;
}

/* ── strategy, season, energy, triggers, rules ────────────────────────────────────────────────── */

function chainInto(v: V, path: string, chain: ChainEntry[], g: ConfigGraph, mode: 'heat' | 'cool'): void {
  if (!v.arr(path, chain, 20)) return;
  const ids = new Set<string>();
  const used = new Set<string>();
  chain.forEach((e, i) => {
    const p = `${path}.${i}`;
    if (!v.obj(p, e)) return;
    if (!isStr(e.id) || !e.id || ids.has(e.id)) v.push(`${p}.id`, 'unique');
    ids.add(e.id);
    v.strOrNull(`${p}.label`, e.label, 40);
    v.bool(`${p}.enabled`, e.enabled);
    if (!v.arr(`${p}.sourceIds`, e.sourceIds, 20, 1)) return;
    e.sourceIds.forEach((id, j) => {
      const sp = `${p}.sourceIds.${j}`;
      const s = g.sources.get(id);
      if (!s) return v.push(sp, 'not_found');
      if (used.has(id)) v.push(sp, 'unique');
      used.add(id);
      if (!s.capabilities[mode]) v.push(sp, 'capability', { mode });
      // the heat chain feeds circuits (central sources); the cool chain also ranks room ACs
      if (mode === 'heat' && s.scope !== 'central') v.push(sp, 'scope');
    });
  });
}

export function validateHeat(h: ConfigGraph['heat'], g: ConfigGraph): Issues {
  const v = new V();
  chainInto(v, 'chain', h.chain, g, 'heat');
  const b = h.bivalence;
  if (v.obj('bivalence', b)) {
    v.oneOf('bivalence.mode', b.mode, ['alt', 'parallel', 'partial']);
    const okP = v.num('bivalence.pointC', b.pointC, -20, 5);
    v.num('bivalence.hysteresisC', b.hysteresisC, 1, 5);
    if (okP) v.num('bivalence.hpLimitC', b.hpLimitC, -25, b.pointC - 1);
  }
  if (v.obj('lag', h.lag)) {
    v.bool('lag.enabled', h.lag.enabled);
    v.num('lag.deficitC', h.lag.deficitC, 0.5, 3);
    v.num('lag.forMin', h.lag.forMin, 15, 180, 15);
    v.num('lag.graceAfterStartMin', h.lag.graceAfterStartMin, 0, 120);
  }
  v.numOrNull('heatingCutoffOutdoorC', h.heatingCutoffOutdoorC, 10, 25);
  return v.issues;
}

export function validateCool(c: ConfigGraph['cool'], g: ConfigGraph): Issues {
  const v = new V();
  chainInto(v, 'chain', c.chain, g, 'cool');
  v.oneOf('hpModeSelection', c.hpModeSelection, ['demand', 'weather']);
  v.num('dewMarginC', c.dewMarginC, 1, 5);
  v.num('changeoverMinH', c.changeoverMinH, 1, 12);
  v.num('autoMinGapC', c.autoMinGapC, 1, 5);
  if (v.obj('dryInsteadOfCool', c.dryInsteadOfCool)) {
    v.bool('dryInsteadOfCool.enabled', c.dryInsteadOfCool.enabled);
    v.num('dryInsteadOfCool.abovePct', c.dryInsteadOfCool.abovePct, 40, 90);
  }
  v.numOrNull('floorExcludeAbovePct', c.floorExcludeAbovePct, 40, 95);
  if (v.obj('solarPrecool', c.solarPrecool)) v.num('solarPrecool.leadMin', c.solarPrecool.leadMin, 0, 180);
  v.bool('singleRoomCentralStart', c.singleRoomCentralStart);
  return v.issues;
}

export function validateSeason(s: ConfigGraph['season']): Issues {
  const v = new V();
  v.int('avgDays', s.avgDays, 1, 7);
  const okH = v.num('heatBelowC', s.heatBelowC, 0, 30);
  const okC = v.num('coolAboveC', s.coolAboveC, 10, 40);
  if (okH && okC && s.heatBelowC >= s.coolAboveC) v.push('coolAboveC', 'order', { min: s.heatBelowC });
  v.num('hysteresisC', s.hysteresisC, 0.5, 3);
  v.num('minDwellH', s.minDwellH, 0, 72);
  v.num('confirmH', s.confirmH, 0, 24);
  for (const k of ['heatingMonths', 'coolingMonths'] as const) {
    if (v.arr(k, s[k], 12, 12)) s[k].forEach((x, i) => v.bool(`${k}.${i}`, x));
  }
  v.num('neutralColdGuardC', s.neutralColdGuardC, 0, 3);
  return v.issues;
}

export function validateEnergy(e: ConfigGraph['energy'], g: ConfigGraph, env: ValidationEnv = {}): Issues {
  const v = new V(env);
  v.num('budgetKw', e.budgetKw, 1, 15, 0.5);
  v.numOrNull('inverterMaxKw', e.inverterMaxKw, 0.5, 50);
  v.num('staggerSec', e.staggerSec, 0, 120, 10);
  if (v.arr('shedOrder', e.shedOrder, 100)) e.shedOrder.forEach((id, i) => v.exists(`shedOrder.${i}`, g.sources.has(id)));
  v.bool('shedOrderCustom', e.shedOrderCustom);
  if (v.obj('exempt', e.exempt)) {
    if (v.arr('exempt.sourceIds', e.exempt.sourceIds, 100)) e.exempt.sourceIds.forEach((id, i) => v.exists(`exempt.sourceIds.${i}`, g.sources.has(id)));
    v.bool('exempt.pumps', e.exempt.pumps);
    v.num('exempt.whileSocAbovePct', e.exempt.whileSocAbovePct, 0, 100);
  }
  v.num('criticalSocPct', e.criticalSocPct, 5, 50);
  if (v.obj('entities', e.entities)) {
    const opts = { checkExists: true };
    v.entity('entities.gridOffline', e.entities.gridOffline, ['binary_sensor', 'input_boolean', 'switch', 'sensor'], opts);
    v.entity('entities.pvPower', e.entities.pvPower, ['sensor', 'input_number', 'number'], opts);
    v.entity('entities.houseLoad', e.entities.houseLoad, ['sensor', 'input_number', 'number'], opts);
    v.entity('entities.batterySoc', e.entities.batterySoc, ['sensor', 'input_number', 'number'], opts);
    v.entity('entities.tariff', e.entities.tariff, ['sensor', 'select', 'input_select', 'binary_sensor', 'input_boolean'], opts);
  }
  conditionInto(v, e.activeWhen, 'activeWhen', { g, enabled: true });
  return v.issues;
}

export function validateTrigger(t: Trigger, g: ConfigGraph, env: ValidationEnv = {}): Issues {
  const v = new V(env);
  v.str('name', t.name, 1, 40);
  v.str('icon', t.icon, 1, 24);
  v.oneOf('kind', t.kind, ['entity_state', 'numeric', 'template', 'time', 'sun_weather', 'composite']);
  v.bool('enabled', t.enabled);
  conditionInto(v, t.condition, 'condition', { g, enabled: t.enabled, selfTriggerId: t.id });
  if (t.system !== null && (!v.obj('system', t.system) || t.system.boundTo !== 'heat.bivalence')) v.push('system.boundTo', 'enum', { values: 'heat.bivalence' });
  v.oneOf('whenUnknown', t.whenUnknown, ['false', 'true', 'hold_false', 'hold_true']);
  v.num('holdMaxMin', t.holdMaxMin, 0, 1440);
  v.bool('notifyOnActivate', t.notifyOnActivate);
  v.int('order', t.order, 0, 10_000);
  return v.issues;
}

/** Composite triggers must not reference themselves through other triggers. */
export function triggerCycleIds(g: ConfigGraph): Id[] {
  const state = new Map<Id, 'visiting' | 'done'>();
  const inCycle = new Set<Id>();
  const visit = (id: Id, stack: Id[]): void => {
    const st = state.get(id);
    if (st === 'done') return;
    if (st === 'visiting') {
      for (const x of stack.slice(stack.indexOf(id))) inCycle.add(x);
      return;
    }
    state.set(id, 'visiting');
    const t = g.triggers.get(id);
    for (const ref of t ? conditionTriggers(t.condition) : []) visit(ref, [...stack, ref]);
    state.set(id, 'done');
  };
  for (const id of g.triggers.keys()) visit(id, [id]);
  return [...inCycle];
}

function effectInto(v: V, path: string, e: RuleEffect, g: ConfigGraph): void {
  const sources = (p: string, ids: unknown) => {
    if (v.arr(p, ids, 100)) (ids as unknown[]).forEach((id, i) => v.exists(`${p}.${i}`, isStr(id) && g.sources.has(id)));
  };
  switch (e.type) {
    case 'target_offset':
      if (e.roomIds !== 'all' && e.roomIds !== 'trigger_rooms' && v.arr(`${path}.roomIds`, e.roomIds, 100, 1)) {
        e.roomIds.forEach((id, i) => v.exists(`${path}.roomIds.${i}`, g.rooms.has(id)));
      }
      v.num(`${path}.deltaC`, e.deltaC, -5, 5);
      v.oneOf(`${path}.mode`, e.mode, ['heat', 'cool', 'both']);
      break;
    case 'allow_sources':
      sources(`${path}.sourceIds`, e.sourceIds);
      break;
    case 'only_sources':
    case 'forbid_sources':
    case 'preheat_to_next_slot':
      sources(`${path}.sourceIds`, e.sourceIds);
      break;
    case 'disable_carrier':
      v.oneOf(`${path}.carrier`, e.carrier, ['electric', 'gas', 'other']);
      break;
    case 'power_cap':
      if (e.kw !== 'budget') v.num(`${path}.kw`, e.kw, 0.1, 50);
      break;
    case 'source_requires':
      v.exists(`${path}.sourceId`, g.sources.has(e.sourceId));
      v.exists(`${path}.triggerId`, g.triggers.has(e.triggerId));
      break;
    case 'pumps_demand_only':
      break;
    default:
      v.push(`${path}.type`, 'enum');
  }
}

export function validateRule(r: TriggerRule, g: ConfigGraph, env: ValidationEnv = {}): Issues {
  const v = new V(env);
  v.str('name', r.name, 1, 40);
  v.bool('enabled', r.enabled);
  v.int('priority', r.priority, 0, 1000);
  conditionInto(v, r.when, 'when', { g, enabled: r.enabled });
  if (r.stopWhen !== null) conditionInto(v, r.stopWhen, 'stopWhen', { g, enabled: r.enabled });
  if (v.arr('effects', r.effects, 20)) r.effects.forEach((e, i) => (v.obj(`effects.${i}`, e) ? effectInto(v, `effects.${i}`, e, g) : undefined));
  v.bool('notifyOnActivate', r.notifyOnActivate);
  return v.issues;
}

/* ── notifications, devices ───────────────────────────────────────────────────────────────────── */

export function validateTarget(t: NotifyTarget): Issues {
  const v = new V();
  v.oneOf('channel', t.channel, CHANNEL_KINDS);
  v.str('name', t.name, 1, 40);
  v.strOrNull('shortName', t.shortName, 24);
  v.str('icon', t.icon, 1, 24);
  v.bool('enabled', t.enabled);
  if (t.channel === 'ha_mobile' || t.channel === 'ha_notify') {
    if (!isStr(t.service) || !/^notify\.[a-z0-9_]+$/.test(t.service)) v.push('service', t.service ? 'pattern' : 'required', { expected: 'notify.<service>' });
  }
  if (t.channel === 'telegram') {
    // chat ids can exceed 2^53 and groups are negative, so they stay strings of digits
    if (!isStr(t.chatId) || !/^-?\d{1,20}$/.test(t.chatId)) v.push('chatId', t.chatId ? 'pattern' : 'required', { expected: 'digits' });
    v.strOrNull('chatTitle', t.chatTitle, 255);
  }
  v.bool('isPrimary', t.isPrimary);
  v.bool('isEscalation', t.isEscalation);
  if (t.isPrimary && t.channel !== 'ha_mobile' && t.channel !== 'telegram') v.push('isPrimary', 'channel');
  if (t.isEscalation && t.channel === 'ha_event') v.push('isEscalation', 'channel');
  if (t.ownerUserId !== null) v.str('ownerUserId', t.ownerUserId, 1, 64);
  return v.issues;
}

/**
 * Routing invariants: exactly one primary (a phone when any phone exists, else a Telegram chat), at
 * most one escalation target, locked cells on. Violations are 409s, not field errors.
 */
export function notificationInvariantIssues(g: ConfigGraph): Issues {
  const v = new V();
  const targets = [...g.targets.values()];
  const primaries = targets.filter((t) => t.isPrimary);
  const eligible = targets.filter((t) => t.channel === 'ha_mobile' || t.channel === 'telegram');
  if (eligible.length && primaries.length !== 1) v.push('targets', 'primary_count', { count: primaries.length });
  if (primaries.length === 1 && primaries[0].channel !== 'ha_mobile' && targets.some((t) => t.channel === 'ha_mobile')) v.push('targets', 'primary_phone');
  if (targets.filter((t) => t.isEscalation).length > 1) v.push('targets', 'escalation_count');
  const esc = g.notify.escalation.targetId;
  if (esc !== null && !g.targets.has(esc)) v.push('notify.escalation.targetId', 'not_found');
  for (const cell of g.routing.values()) {
    const t = g.targets.get(cell.targetId);
    if (t && !cell.on && isLockedCell(cell.kind, t)) v.push(`routing.${cell.kind}.${cell.targetId}`, 'locked_cell');
  }
  return v.issues;
}

export function validateRoutingCell(c: RoutingCell, g: ConfigGraph): Issues {
  const v = new V();
  v.oneOf('kind', c.kind, EVENT_KINDS);
  v.exists('targetId', g.targets.has(c.targetId));
  v.bool('on', c.on);
  return v.issues;
}

export function validateEventParams(e: EventParams): Issues {
  const v = new V();
  v.oneOf('kind', e.kind, EVENT_KINDS);
  v.bool('enabled', e.enabled);
  if (v.obj('params', e.params)) {
    for (const [k, x] of Object.entries(e.params)) {
      if (isNum(x)) {
        if (x < -1e6 || x > 1e6) v.push(`params.${k}`, 'range', { min: -1e6, max: 1e6 });
      } else if (!isStr(x) && typeof x !== 'boolean') v.push(`params.${k}`, 'type');
    }
    if (e.params.openAfterSec !== undefined) v.num('params.openAfterSec', e.params.openAfterSec, 0, 3600);
  }
  return v.issues;
}

export function validateWatchRule(w: WatchRule, g: ConfigGraph): Issues {
  const v = new V();
  if (v.oneOf('origin', w.origin, ['auto', 'manual'])) {
    if (w.origin === 'auto' && w.id !== `auto:${w.entityId}`) v.push('id', 'pattern', { expected: 'auto:<entity_id>' });
  }
  v.entity('entityId', w.entityId, undefined, { required: true });
  v.str('name', w.name, 0, 255);
  v.str('role', w.role, 1, 32);
  const c = w.condition;
  if (v.obj('condition', c) && v.oneOf('condition.type', c.type, ['unavailable', 'stale', 'offline', 'not_confirmed', 'no_confirmation_after_demand', 'custom'])) {
    switch (c.type) {
      case 'unavailable':
      case 'offline':
      case 'no_confirmation_after_demand':
        v.num('condition.forMin', c.forMin, 0, 1440);
        break;
      case 'stale':
        v.num('condition.noUpdateMin', c.noUpdateMin, 1, 2880);
        break;
      case 'not_confirmed':
        v.int('condition.attempts', c.attempts, 1, 10);
        break;
      case 'custom':
        conditionInto(v, c.node, 'condition.node', { g, enabled: !w.muted });
        break;
    }
  }
  v.oneOf('severity', w.severity, ['critical', 'warning']);
  v.oneOf('eventKind', w.eventKind, EVENT_KINDS);
  v.bool('muted', w.muted);
  return v.issues;
}

export function validatePersonal(p: PersonalPrefs, g: ConfigGraph): Issues {
  const v = new V();
  v.str('userId', p.userId, 1, 64);
  if (v.arr('targetIds', p.targetIds, 50)) p.targetIds.forEach((id, i) => v.exists(`targetIds.${i}`, g.targets.has(id)));
  if (v.obj('levels', p.levels)) {
    // critical alerts cannot be switched off for anyone
    if (p.levels.critical !== true) v.push('levels.critical', 'locked');
    for (const k of ['warning', 'event', 'report'] as const) v.bool(`levels.${k}`, p.levels[k]);
  }
  v.bool('quietHours', p.quietHours);
  return v.issues;
}

export function validateZ2m(z: Z2mInstance, g: ConfigGraph): Issues {
  const v = new V();
  v.str('name', z.name, 1, 40);
  if (!isStr(z.baseTopic) || !/^[A-Za-z0-9_\-/]{1,120}$/.test(z.baseTopic)) v.push('baseTopic', 'pattern');
  for (const o of g.z2m.values()) if (o.id !== z.id && o.baseTopic === z.baseTopic) v.push('baseTopic', 'unique');
  if (z.frontendUrl !== null && !(isStr(z.frontendUrl) && /^https?:\/\/\S+$/.test(z.frontendUrl) && z.frontendUrl.length <= 255)) v.push('frontendUrl', 'pattern', { expected: 'http(s)://…' });
  v.entity('bridgeEntityId', z.bridgeEntityId, ['binary_sensor', 'sensor']);
  v.bool('resendOnRestart', z.resendOnRestart);
  return v.issues;
}

export function validateDeviceMeta(m: DeviceMeta): Issues {
  const v = new V();
  v.str('key', m.key, 1, 255);
  v.strOrNull('label', m.label, 80);
  v.bool('ignored', m.ignored);
  v.strOrNull('batteryType', m.batteryType, 32);
  return v.issues;
}

/* ── singletons ───────────────────────────────────────────────────────────────────────────────── */

export function validateSettings(s: ConfigGraph['settings'], g: ConfigGraph): Issues {
  const v = new V();
  v.str('houseName', s.houseName, 1, 40);
  if (v.obj('outdoor', s.outdoor)) {
    v.entity('outdoor.sensorEntityId', s.outdoor.sensorEntityId, ['sensor', 'input_number', 'number', 'weather']);
    v.entity('outdoor.weatherEntityId', s.outdoor.weatherEntityId, ['weather']);
    v.num('outdoor.staleAfterMin', s.outdoor.staleAfterMin, 5, 240);
    v.num('outdoor.holdMin', s.outdoor.holdMin, 0, 240);
  }
  v.oneOf('units', s.units, ['auto', 'C', 'F']);
  v.oneOf('notificationLanguage', s.notificationLanguage, ['uk', 'en']);
  v.oneOf('uiLanguage', s.uiLanguage, ['auto', 'uk', 'en']);
  v.exists('defaultProfileId', g.profiles.has(s.defaultProfileId));
  v.exists('ecoProfileId', g.profiles.has(s.ecoProfileId));
  const lim = s.targetLimits;
  if (v.obj('targetLimits', lim)) {
    const a = v.num('targetLimits.heatMinC', lim.heatMinC, 5, 30);
    const b = v.num('targetLimits.heatMaxC', lim.heatMaxC, 5, 30);
    const c = v.num('targetLimits.coolMinC', lim.coolMinC, 16, 32);
    const d = v.num('targetLimits.coolMaxC', lim.coolMaxC, 16, 32);
    if (a && b && lim.heatMinC >= lim.heatMaxC) v.push('targetLimits.heatMaxC', 'order', { min: lim.heatMinC });
    if (c && d && lim.coolMinC >= lim.coolMaxC) v.push('targetLimits.coolMaxC', 'order', { min: lim.coolMinC });
    v.oneOf('targetLimits.stepC', lim.stepC, [0.1, 0.5, 1]);
  }
  v.oneOf('haTargetChangeDuration', s.haTargetChangeDuration, ['slot', '1h', '2h', '3h', 'morning', 'until', 'forever']);
  v.bool('adminOnlyConfig', s.adminOnlyConfig);
  v.bool('mqttConfigEntities', s.mqttConfigEntities);
  v.num('glassCoefficient', s.glassCoefficient, 0, 1);
  const p = s.presence;
  if (v.obj('presence', p)) {
    v.bool('presence.enabled', p.enabled);
    if (v.arr('presence.personEntityIds', p.personEntityIds, 50)) p.personEntityIds.forEach((id, i) => v.entity(`presence.personEntityIds.${i}`, id, ['person', 'device_tracker'], { required: true }));
    v.entity('presence.homeZoneEntityId', p.homeZoneEntityId, ['zone'], { required: true });
    v.num('presence.awayDelayMin', p.awayDelayMin, 0, 240);
    v.entity('presence.proximityEntityId', p.proximityEntityId, ['sensor', 'proximity']);
    v.num('presence.approachKm', p.approachKm, 0.1, 100);
  }
  const d = s.defaults;
  if (v.obj('defaults', d)) {
    if (v.obj('defaults.tolerance', d.tolerance)) {
      bandInto(v, 'defaults.tolerance.heat', d.tolerance.heat);
      bandInto(v, 'defaults.tolerance.cool', d.tolerance.cool);
    }
    v.num('defaults.minRequestMin', d.minRequestMin, 0, 30);
    v.num('defaults.staleAfterMin', d.staleAfterMin, 15, 240);
    v.oneOf('defaults.smoothingMin', d.smoothingMin, [0, 2, 5, 10, 15]);
    v.num('defaults.outlierC', d.outlierC, 0.5, 3);
    v.oneOf('defaults.windowReaction', d.windowReaction, WINDOW_REACTIONS);
    v.num('defaults.windowOpenDelaySec', d.windowOpenDelaySec, 0, 300);
    v.num('defaults.windowResumeDelaySec', d.windowResumeDelaySec, 0, 1800);
    v.num('defaults.windowRemindAfterMin', d.windowRemindAfterMin, 5, 120);
  }
  v.bool('onboardingDismissed', s.onboardingDismissed);
  return v.issues;
}

export function validateSafety(s: ConfigGraph['safety']): Issues {
  const v = new V();
  const frost = v.num('frostC', s.frostC, 5, 10);
  if (frost) v.num('frostReleaseC', s.frostReleaseC, s.frostC + 0.1, s.frostC + 3);
  v.num('frostSupplyAlertC', s.frostSupplyAlertC, 5, 20);
  if (v.num('overheatC', s.overheatC, 24, 32)) v.num('overheatReleaseC', s.overheatReleaseC, s.overheatC - 3, s.overheatC - 0.1);
  v.num('noDataTrvSetpointC', s.noDataTrvSetpointC, 10, 22);
  v.num('sourceConfirmDefaultMin', s.sourceConfirmDefaultMin, 2, 15);
  if (v.num('relayWatchdogMin', s.relayWatchdogMin, 5, 30)) v.num('relayRearmEveryMin', s.relayRearmEveryMin, 1, Math.floor(s.relayWatchdogMin / 3));
  v.bool('reconcileOnRestart', s.reconcileOnRestart);
  v.num('haBlindAfterSec', s.haBlindAfterSec, 30, 600);
  v.num('haDisconnectAlertMin', s.haDisconnectAlertMin, 1, 120);
  v.num('startupDryRunSec', s.startupDryRunSec, 0, 120);
  v.bool('trvHandbackOnStop', s.trvHandbackOnStop);
  for (const k of ['pumpExercise', 'valveExercise'] as const) {
    const x = s[k];
    if (!v.obj(k, x)) continue;
    v.bool(`${k}.enabled`, x.enabled);
    v.int(`${k}.dow`, x.dow, 0, 6);
    v.hhmm(`${k}.time`, x.time);
    v.num(`${k}.durationSec`, x.durationSec, 10, 600);
  }
  if (v.obj('commandRate', s.commandRate)) {
    v.num('commandRate.globalPerSec', s.commandRate.globalPerSec, 1, 50);
    v.num('commandRate.burst', s.commandRate.burst, 1, 100);
    v.num('commandRate.zigbeeSpacingMs', s.commandRate.zigbeeSpacingMs, 0, 5000);
    v.num('commandRate.perEntityMinIntervalSec', s.commandRate.perEntityMinIntervalSec, 0, 600);
  }
  if (v.obj('conflict', s.conflict)) {
    v.int('conflict.count', s.conflict.count, 1, 10);
    v.num('conflict.windowMin', s.conflict.windowMin, 5, 240);
    v.num('conflict.backoffMin', s.conflict.backoffMin, 1, 120);
  }
  return v.issues;
}

export function validateHouse(h: ConfigGraph['house']): Issues {
  const v = new V();
  v.oneOf('mode', h.mode, HOUSE_MODES);
  if (v.arr('priority', h.priority, PRIORITY_DEFAULT.length, PRIORITY_DEFAULT.length)) {
    const set = new Set(h.priority);
    if (set.size !== PRIORITY_DEFAULT.length || PRIORITY_DEFAULT.some((k) => !set.has(k))) v.push('priority', 'permutation');
    // frost and open windows always win, whatever the user reorders below them
    if (h.priority[0] !== PRIORITY_LOCKED[0] || h.priority[1] !== PRIORITY_LOCKED[1]) v.push('priority', 'locked_ranks', { first: 'frost', second: 'window' });
  }
  return v.issues;
}

export function validateNotifySettings(n: ConfigGraph['notify'], g: ConfigGraph): Issues {
  const v = new V();
  if (v.obj('telegram', n.telegram)) {
    v.oneOf('telegram.mode', n.telegram.mode, ['own', 'integration']);
    v.strOrNull('telegram.haService', n.telegram.haService, 255);
  }
  v.bool('criticalBypassDnd', n.criticalBypassDnd);
  if (v.obj('quietHours', n.quietHours)) {
    v.bool('quietHours.enabled', n.quietHours.enabled);
    v.hhmm('quietHours.from', n.quietHours.from);
    v.hhmm('quietHours.to', n.quietHours.to);
    v.bool('quietHours.digest', n.quietHours.digest);
  }
  if (v.obj('grouping', n.grouping)) v.num('grouping.windowMin', n.grouping.windowMin, 1, 30);
  if (v.obj('repeatCritical', n.repeatCritical)) {
    v.num('repeatCritical.everyMin', n.repeatCritical.everyMin, 5, 240);
    v.int('repeatCritical.maxTimes', n.repeatCritical.maxTimes, 1, 20);
  }
  if (v.obj('escalation', n.escalation)) {
    v.num('escalation.afterMin', n.escalation.afterMin, 1, 120);
    if (n.escalation.targetId !== null) v.exists('escalation.targetId', g.targets.has(n.escalation.targetId));
  }
  v.bool('recoveryMessages', n.recoveryMessages);
  v.bool('watchAllUsedEntities', n.watchAllUsedEntities);
  if (v.obj('reports', n.reports)) {
    v.hhmm('reports.daily.time', n.reports.daily?.time);
    v.int('reports.weekly.dow', n.reports.weekly?.dow, 0, 6);
    v.hhmm('reports.weekly.time', n.reports.weekly?.time);
  }
  v.num('actionTtlH', n.actionTtlH, 1, 168);
  return v.issues;
}

export function validateDeviceHealth(d: ConfigGraph['deviceHealth']): Issues {
  const v = new V();
  if (v.obj('batteryLow', d.batteryLow)) {
    v.bool('batteryLow.enabled', d.batteryLow.enabled);
    if (v.num('batteryLow.pct', d.batteryLow.pct, 5, 50, 5)) v.num('batteryLow.reminderPct', d.batteryLow.reminderPct, 1, d.batteryLow.pct - 1);
  }
  if (v.obj('offline', d.offline)) {
    v.num('offline.batteryMin', d.offline.batteryMin, 15, 720);
    v.num('offline.contactMin', d.offline.contactMin, 15, 720);
    v.num('offline.mainsMin', d.offline.mainsMin, 1, 720);
    v.num('offline.integrationMin', d.offline.integrationMin, 1, 60);
  }
  if (v.obj('trvUnconfirmed', d.trvUnconfirmed)) {
    v.int('trvUnconfirmed.attempts', d.trvUnconfirmed.attempts, 1, 10);
    v.num('trvUnconfirmed.ackTimeoutSec', d.trvUnconfirmed.ackTimeoutSec, 30, 600);
  }
  if (v.obj('weakSignal', d.weakSignal)) {
    if (v.num('weakSignal.lqiBelow', d.weakSignal.lqiBelow, 20, 120)) v.num('weakSignal.clearAt', d.weakSignal.clearAt, d.weakSignal.lqiBelow, 255);
    v.num('weakSignal.windowH', d.weakSignal.windowH, 1, 48);
    v.int('weakSignal.minSamples', d.weakSignal.minSamples, 1, 100);
  }
  return v.issues;
}

/* ── dispatch ─────────────────────────────────────────────────────────────────────────────────── */

export function validateCollectionItem(c: ConfigCollectionName, value: unknown, g: ConfigGraph, env: ValidationEnv = {}): Issues {
  switch (c) {
    case 'rooms': return validateRoom(value as RoomConfig, g);
    case 'sensors': return validateSensor(value as RoomSensor, g);
    case 'emitters': return validateEmitter(value as Emitter, g);
    case 'emitterDevices': return validateEmitterDevice(value as EmitterDevice, g);
    case 'profiles': return validateProfile(value as Profile, g);
    case 'activationRules': return validateActivationRule(value as ActivationRule, g);
    case 'schedules': return validateSchedule(value as Schedule, g);
    case 'scheduleExceptions': return validateScheduleException(value as ScheduleException, g);
    case 'sources': return validateSource(value as SourceConfig, g, env);
    case 'manifolds': return validateManifold(value as Manifold);
    case 'circuits': return validateCircuit(value as Circuit, g);
    case 'pumps': return validatePump(value as Pump, g);
    case 'triggers': return validateTrigger(value as Trigger, g, env);
    case 'rules': return validateRule(value as TriggerRule, g, env);
    case 'targets': return validateTarget(value as NotifyTarget);
    case 'watchRules': return validateWatchRule(value as WatchRule, g);
    case 'z2m': return validateZ2m(value as Z2mInstance, g);
  }
}

export function validateSingleton(k: ConfigSingletonName, g: ConfigGraph, env: ValidationEnv = {}): Issues {
  switch (k) {
    case 'settings': return validateSettings(g.settings, g);
    case 'safety': return validateSafety(g.safety);
    case 'house': return validateHouse(g.house);
    case 'heat': return validateHeat(g.heat, g);
    case 'cool': return validateCool(g.cool, g);
    case 'season': return validateSeason(g.season);
    case 'energy': return validateEnergy(g.energy, g, env);
    case 'notify': return validateNotifySettings(g.notify, g);
    case 'deviceHealth': return validateDeviceHealth(g.deviceHealth);
  }
}

/** Graph-wide rules that must hold after any write (the seeded system objects still exist, …). */
export function graphIssues(g: ConfigGraph): Issues {
  const v = new V();
  for (const id of SYSTEM_PROFILE_IDS) if (g.profiles.get(id)?.kind !== 'system') v.push(`profiles.${id}`, 'required');
  const house = [...g.schedules.values()].filter((s) => s.scope === 'house');
  if (house.length !== 1) v.push('schedules.house', 'required');
  for (const id of triggerCycleIds(g)) v.push(`triggers.${id}.condition`, 'cycle');
  return v.issues;
}

