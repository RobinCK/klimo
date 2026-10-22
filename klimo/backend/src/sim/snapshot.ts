import { walkCondition } from '../config/refs';
import type { ConditionNode, EngineConfig, EntitySnap, EpochMs, HaStateObj, Id, InputSnapshot } from '../shared/model';
import { evaluateTemplate, TemplateError, type TemplateHost } from './jinja-lite';

/* =====================================================================================================
 * The engine's view of the fake HA during the warm-up: the same `InputSnapshot` the live shell builds,
 * assembled from the fake's states, the warm-up's own outdoor and room-temperature history and the
 * templates rendered on the spot.
 * ===================================================================================================== */

const UNAVAILABLE = new Set(['unavailable', 'unknown']);

export function entitySnap(s: HaStateObj): EntitySnap {
  const n = Number(s.state);
  const available = !UNAVAILABLE.has(s.state);
  return {
    entityId: s.entity_id,
    state: s.state,
    num: available && s.state.trim() !== '' && Number.isFinite(n) ? n : null,
    attrs: s.attributes,
    available,
    lastChanged: Date.parse(s.last_changed),
    lastReported: Date.parse(s.last_reported ?? s.last_updated),
    context: { id: s.context?.id ?? null, userId: s.context?.user_id ?? null, parentId: s.context?.parent_id ?? null },
  };
}

/** Every template condition of the configuration, keyed the way the engine looks them up. */
export function templateNodes(cfg: EngineConfig): { key: string; template: string }[] {
  const out: { key: string; template: string }[] = [];
  const collect = (owner: string, node: ConditionNode | null | undefined) =>
    walkCondition(node, (n) => {
      if (n.op === 'template' && n.id) out.push({ key: `${owner}#${n.id}`, template: n.template });
    });
  for (const t of cfg.triggers) collect(`trigger:${t.id}`, t.condition);
  for (const r of cfg.rules) {
    collect(`rule:${r.id}`, r.when);
    collect(`rule:${r.id}`, r.stopWhen);
  }
  for (const s of cfg.sources) for (const item of s.conditions.items) collect(`source:${s.id}:${item.id}`, item.node);
  collect('energy', cfg.energy.activeWhen);
  for (const w of cfg.watchRules) if (w.condition.type === 'custom') collect(`watch:${w.id}`, w.condition.node);
  return out;
}

function asBoolean(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v !== 0 : null;
  if (v === null || v === undefined) return null;
  const s = String(v).trim().toLowerCase();
  if (['true', 'on', 'yes', '1', 'open', 'home'].includes(s)) return true;
  if (['false', 'off', 'no', '0', '', 'closed', 'not_home'].includes(s)) return false;
  return null;
}

export function renderTemplates(cfg: EngineConfig, host: TemplateHost): InputSnapshot['templateResults'] {
  const out: InputSnapshot['templateResults'] = {};
  for (const t of templateNodes(cfg)) {
    try {
      out[t.key] = { value: asBoolean(evaluateTemplate(t.template, host).value), error: null };
    } catch (e) {
      out[t.key] = { value: null, error: e instanceof TemplateError ? e.message : String(e) };
    }
  }
  return out;
}

export interface SnapshotInputs {
  now: EpochMs;
  tz: string;
  states: HaStateObj[];
  host: TemplateHost;
  roomTempHistory: Record<Id, [EpochMs, number][]>;
  outdoor: InputSnapshot['outdoor'];
  humidHours24h: InputSnapshot['humidHours24h'];
  calendarEvents: InputSnapshot['calendarEvents'];
  forecasts: InputSnapshot['forecasts'];
  prev: InputSnapshot['prev'];
}

export function buildSnapshot(cfg: EngineConfig, i: SnapshotInputs): InputSnapshot {
  const entities: Record<string, EntitySnap> = {};
  for (const s of i.states) entities[s.entity_id] = entitySnap(s);
  return {
    now: i.now,
    tz: i.tz,
    haConnected: true,
    blind: false,
    dryRun: false,
    entities,
    roomTempHistory: i.roomTempHistory,
    outdoor: i.outdoor,
    templateResults: renderTemplates(cfg, i.host),
    calendarEvents: i.calendarEvents,
    forecasts: i.forecasts,
    z2mBridgeOnline: { z2m1: true, z2m2: true },
    humidHours24h: i.humidHours24h,
    haTempUnit: '°C',
    simulated: false,
    prev: i.prev,
  };
}
