import type {
  ConditionMemory,
  Decision,
  Detection,
  EngineConfig,
  EngineMemory,
  EpochMs,
  EvaluateTriggersFn,
  Id,
  Mode,
  PlantState,
  Reason,
  RuleOverlay,
  RuleState,
  Season,
  SpanEvent,
  Trigger,
  TriggerRule,
  TriggerState,
  UsageRef,
} from '../../shared/model';
import { defaultConditionMemory } from '../../shared/defaults';
import { firstUnknownEntity, nextTimeChange, referencedTriggers, runCondition, walkNodes, type ConditionScratch, type PlantConditionCtx } from './conditions';
import { clamp } from './util';

/* =====================================================================================================
 * Triggers are named live booleans over HA; rules act while their trigger holds. Triggers run in
 * dependency order so «Сонце при блекауті» sees this tick's «Блекаут». A rule's `stopWhen` latches it off
 * until `when` has been false once, so a battery hovering between 90 and 95 % cannot flap the rule. The
 * active rules fold into one overlay the rooms and the plant read.
 * ===================================================================================================== */

const MIN_MS = 60_000;
/** Longest gap counted as one interval when integrating a rule's energy (ticks are 10 s apart). */
const MAX_ENERGY_DT_MS = 5 * MIN_MS;
/** The energy gate keeps its last known value this long when its input becomes unknown. */
const ENERGY_HOLD_MS = 30 * MIN_MS;

export function emptyOverlay(): RuleOverlay {
  return {
    targetOffsets: {},
    onlySources: null,
    forbidSources: [],
    allowSources: [],
    disabledCarriers: [],
    powerCapKw: null,
    powerCapBudget: false,
    pumpsDemandOnly: false,
    sourceRequires: [],
    preheatSourceIds: [],
    activeRuleIds: [],
  };
}

/** Triggers ordered so every referenced trigger comes first; members of a cycle keep their config order. */
export function triggerOrder(triggers: readonly Trigger[]): Trigger[] {
  const byId = new Map(triggers.map((t) => [t.id, t]));
  const sorted = [...triggers].sort((a, b) => a.order - b.order);
  const out: Trigger[] = [];
  const state = new Map<Id, 'visiting' | 'done'>();
  const visit = (t: Trigger) => {
    const s = state.get(t.id);
    if (s === 'done' || s === 'visiting') return;
    state.set(t.id, 'visiting');
    for (const dep of referencedTriggers(t.condition)) {
      const d = byId.get(dep);
      if (d) visit(d);
    }
    state.set(t.id, 'done');
    out.push(t);
  };
  for (const t of sorted) visit(t);
  return out;
}

/** HA entities a trigger reads (they also tell two triggers' journal lines apart). */
function triggerEntities(t: Trigger): string[] {
  const out = new Set<string>();
  walkNodes(t.condition, (n) => {
    if (n.op === 'state' || n.op === 'weather') out.add(n.entityId);
    else if (n.op === 'numeric') {
      out.add(n.entityId);
      if (n.minus) out.add(n.minus);
    } else if (n.op === 'time' && n.tariffEntityId) out.add(n.tariffEntityId);
  });
  return [...out].filter(Boolean).sort();
}

/** Rooms with an enabled trigger-role emitter: the rooms «Накопичити тепло» warms. */
export function triggerRooms(cfg: EngineConfig): Id[] {
  return cfg.rooms
    .filter((r) => (cfg.emittersByRoom[r.id] ?? []).some((e) => e.enabled && (e.roles.heat === 'trigger' || e.roles.cool === 'trigger')))
    .map((r) => r.id);
}

/** Where a trigger is used (sources, rules, energy, other triggers, watch rules, the bivalent point). */
export function triggerUsages(cfg: EngineConfig, triggerId: Id): UsageRef[] {
  const out: UsageRef[] = [];
  const uses = (node: Parameters<typeof walkNodes>[0]) => {
    let hit = false;
    walkNodes(node, (n) => {
      if (n.op === 'trigger' && n.triggerId === triggerId) hit = true;
    });
    return hit;
  };
  for (const s of cfg.sources) {
    if (s.conditions.items.some((i) => uses(i.node))) out.push({ type: 'source', id: s.id, label: s.name });
  }
  for (const r of cfg.rules) {
    const requires = r.effects.some((e) => e.type === 'source_requires' && e.triggerId === triggerId);
    if (uses(r.when) || uses(r.stopWhen) || requires) out.push({ type: 'rule', id: r.id, label: r.name });
  }
  if (uses(cfg.energy.activeWhen)) out.push({ type: 'energy', id: null, label: '' });
  for (const t of cfg.triggers) if (t.id !== triggerId && uses(t.condition)) out.push({ type: 'trigger', id: t.id, label: t.name });
  for (const w of cfg.watchRules) if (w.condition.type === 'custom' && uses(w.condition.node)) out.push({ type: 'watch', id: w.id, label: w.name });
  const t = cfg.triggers.find((x) => x.id === triggerId);
  if (t?.system?.boundTo === 'heat.bivalence') out.push({ type: 'heat_chain', id: null, label: '' });
  return out;
}

function memoryOf(memory: EngineMemory, ownerKey: string, now: EpochMs): ConditionMemory {
  return memory.conditions[ownerKey] ?? defaultConditionMemory(ownerKey, now);
}

/** The season a condition should see: the forced one of the house mode, else the stored auto season. */
function effectiveSeason(cfg: EngineConfig, memory: EngineMemory): Season {
  if (cfg.house.mode === 'heat') return 'heating';
  if (cfg.house.mode === 'cool') return 'cooling';
  return memory.season.season;
}

/** Value of a trigger whose condition is unknown, by its `whenUnknown` policy. */
function unknownValue(t: Trigger, mem: ConditionMemory, unknownSince: EpochMs, now: EpochMs): boolean {
  switch (t.whenUnknown) {
    case 'false':
      return false;
    case 'true':
      return true;
    case 'hold_false':
    case 'hold_true': {
      const fallback = t.whenUnknown === 'hold_true';
      if (mem.lastKnownValue === null) return fallback;
      return now - unknownSince < t.holdMaxMin * MIN_MS ? mem.lastKnownValue : fallback;
    }
  }
}

function liveReason(t: Trigger, st: Omit<TriggerState, 'live' | 'usedBy'>, ctx: PlantConditionCtx): Reason {
  if (!t.enabled) return { code: 'trigger.live.disabled', params: {} };
  if (st.status === 'error') return { code: 'trigger.live.error', params: { error: st.eval.error ?? null } };
  if (st.status === 'unknown') return { code: 'trigger.live.unknown', params: { entityId: firstUnknownEntity(t.condition, ctx) } };
  if (st.active) return { code: 'trigger.live.since', params: { since: st.since } };
  if (st.nextChangeAt !== null) return { code: 'trigger.live.next_change', params: { at: st.nextChangeAt } };
  if (typeof st.value === 'number') {
    const top = t.condition;
    const unit = top.op === 'outdoor' ? '°C' : top.op === 'numeric' ? unitOf(ctx, top.entityId) : null;
    return { code: 'trigger.live.value', params: { value: st.value, unit } };
  }
  return { code: 'trigger.live.inactive', params: {} };
}

function unitOf(ctx: PlantConditionCtx, entityId: string): string | null {
  const u = ctx.inputs.entities[entityId]?.attrs.unit_of_measurement;
  return typeof u === 'string' ? u : null;
}

/** Sources whose power a rule is credited with (what it allowed or required). */
function ruleSourceIds(rule: TriggerRule): Id[] {
  const out = new Set<Id>();
  for (const e of rule.effects) {
    if (e.type === 'allow_sources' || e.type === 'only_sources' || e.type === 'preheat_to_next_slot') for (const id of e.sourceIds) out.add(id);
  }
  return [...out];
}

function rulePowerKw(rule: TriggerRule, prevPlant: PlantState | null): number {
  if (!prevPlant) return 0;
  let kw = 0;
  for (const id of ruleSourceIds(rule)) {
    const st = prevPlant.sources.find((s) => s.sourceId === id);
    if (!st || !st.on) continue;
    kw += prevPlant.energy.perSourceKw[id] ?? st.telemetry.powerKw ?? 0;
  }
  return kw;
}

/** Folds the active rules (strongest = lowest priority number first) into one overlay. */
export function mergeOverlay(cfg: EngineConfig, active: readonly TriggerRule[]): RuleOverlay {
  const o = emptyOverlay();
  const allRooms = cfg.rooms.map((r) => r.id);
  const trigRooms = triggerRooms(cfg);
  for (const rule of active) {
    o.activeRuleIds.push(rule.id);
    for (const e of rule.effects) {
      switch (e.type) {
        case 'target_offset': {
          const rooms = e.roomIds === 'all' ? allRooms : e.roomIds === 'trigger_rooms' ? trigRooms : e.roomIds;
          const modes: Mode[] = e.mode === 'both' ? ['heat', 'cool'] : [e.mode];
          for (const roomId of rooms) {
            const cur = o.targetOffsets[roomId] ?? { heat: null, cool: null };
            // the strongest rule naming the room wins; offsets never stack
            for (const m of modes) if (cur[m] === null) cur[m] = { deltaC: e.deltaC, ruleId: rule.id };
            o.targetOffsets[roomId] = cur;
          }
          break;
        }
        case 'allow_sources':
          for (const sourceId of e.sourceIds) {
            const mode = e.modes?.[sourceId] ?? null;
            if (!o.allowSources.some((a) => a.sourceId === sourceId && a.mode === mode)) o.allowSources.push({ sourceId, mode, ruleId: rule.id });
          }
          break;
        case 'only_sources':
          o.onlySources = o.onlySources === null ? [...e.sourceIds] : o.onlySources.filter((id) => e.sourceIds.includes(id));
          break;
        case 'forbid_sources':
          for (const id of e.sourceIds) if (!o.forbidSources.includes(id)) o.forbidSources.push(id);
          break;
        case 'disable_carrier':
          if (!o.disabledCarriers.includes(e.carrier)) o.disabledCarriers.push(e.carrier);
          break;
        case 'power_cap':
          if (e.kw === 'budget') o.powerCapBudget = true;
          else o.powerCapKw = o.powerCapKw === null ? e.kw : Math.min(o.powerCapKw, e.kw);
          break;
        case 'preheat_to_next_slot':
          for (const id of e.sourceIds) if (!o.preheatSourceIds.includes(id)) o.preheatSourceIds.push(id);
          break;
        case 'source_requires':
          if (!o.sourceRequires.some((r) => r.sourceId === e.sourceId && r.triggerId === e.triggerId)) o.sourceRequires.push({ sourceId: e.sourceId, triggerId: e.triggerId });
          break;
        case 'pumps_demand_only':
          o.pumpsDemandOnly = true;
          break;
      }
    }
  }
  return o;
}

export const evaluateTriggers: EvaluateTriggersFn = (cfg, inputs, memory, prevPlant, rooms) => {
  const now = inputs.now;
  const decisions: Decision[] = [];
  const detections: Detection[] = [];
  const spans: SpanEvent[] = [];
  const conditions: Record<string, ConditionMemory> = {};
  const triggerStates: Record<Id, TriggerState> = {};
  const ctx: PlantConditionCtx = {
    cfg,
    inputs,
    rooms,
    prevPlant,
    triggers: triggerStates,
    sourceId: null,
    budgetFits: null,
    season: effectiveSeason(cfg, memory),
  };

  /* triggers */
  for (const t of triggerOrder(cfg.triggers)) {
    const ownerKey = `trigger:${t.id}`;
    const mem = memoryOf(memory, ownerKey, now);
    let active = false;
    let status: TriggerState['status'] = 'disabled';
    let next: ConditionMemory;
    const into: ConditionScratch = { latches: {}, timers: {} };
    const r = t.enabled ? runCondition(t.condition, ownerKey, ctx, mem, into) : null;
    if (!r) {
      next = { ...mem, ownerKey, active: false, latches: {}, timers: {}, lastKnownValue: null, unknownSince: null };
    } else if (r.value !== null) {
      active = r.value;
      status = 'ok';
      next = { ...mem, ownerKey, active, latches: into.latches, timers: into.timers, lastKnownValue: r.value, unknownSince: null };
    } else {
      const unknownSince = mem.unknownSince ?? now;
      active = unknownValue(t, mem, unknownSince, now);
      status = r.eval.status === 'error' ? 'error' : 'unknown';
      next = { ...mem, ownerKey, active, latches: into.latches, timers: into.timers, unknownSince };
    }
    const flipped = active !== mem.active;
    next.since = flipped ? now : mem.since;
    next.updatedAt = now;
    conditions[ownerKey] = next;

    if (flipped) {
      decisions.push({ code: active ? 'trigger.on' : 'trigger.off', category: 'system', tone: active ? 'event' : 'idle', params: { triggerId: t.id }, entityIds: triggerEntities(t) });
      spans.push({ subject: 'trigger', subjectId: t.id, kind: 'active', mode: null, edge: active ? 'start' : 'end', at: now });
      if (active && t.notifyOnActivate) {
        detections.push({ kind: 'trigger_fired', dedupKey: `trigger_fired:${t.id}:${now}`, active: true, facts: { triggerId: t.id } });
      }
    }

    const top = t.condition;
    const base = {
      triggerId: t.id,
      active,
      enabled: t.enabled,
      since: active ? next.since : null,
      status,
      value: r && (top.op === 'numeric' || top.op === 'outdoor' || top.op === 'room_deficit') && typeof r.eval.value === 'number' ? r.eval.value : null,
      nextChangeAt: t.enabled && top.op === 'time' ? nextTimeChange(top, now, inputs.tz) : null,
      eval: r ? r.eval : { id: top.id ?? '$', met: false, status: 'ok' as const },
    };
    triggerStates[t.id] = { ...base, live: liveReason(t, base, ctx), usedBy: triggerUsages(cfg, t.id) };
  }

  /* rules, strongest first */
  const ruleStates: RuleState[] = [];
  const activeRules: TriggerRule[] = [];
  const rules = [...cfg.rules].sort((a, b) => a.priority - b.priority);
  for (const rule of rules) {
    const ownerKey = `rule:${rule.id}`;
    const mem = memoryOf(memory, ownerKey, now);
    const prevState = prevPlant?.rules.find((r) => r.ruleId === rule.id) ?? null;
    const into: ConditionScratch = { latches: {}, timers: {} };
    let when = false;
    let stopped = false;
    if (rule.enabled) {
      when = runCondition(rule.when, ownerKey, ctx, mem, into, '$w').value === true;
      const stop = rule.stopWhen ? runCondition(rule.stopWhen, ownerKey, ctx, mem, into, '$s').value === true : false;
      // a stopped rule re-arms only after `when` has read false once
      stopped = mem.stopped && when;
      if (when && !stopped && stop) stopped = true;
    }
    const active = rule.enabled && when && !stopped;
    const flipped = active !== mem.active;
    const since = flipped ? now : mem.since;

    let lastRun = prevState?.lastRun ?? null;
    if (active && flipped) lastRun = { from: now, to: null, energyKwh: 0 };
    else if (active && lastRun) {
      const dtH = clamp(now - mem.updatedAt, 0, MAX_ENERGY_DT_MS) / 3_600_000;
      lastRun = { ...lastRun, energyKwh: Math.round(((lastRun.energyKwh ?? 0) + rulePowerKw(rule, prevPlant) * dtH) * 100) / 100 };
    }
    if (!active && flipped && lastRun) lastRun = { ...lastRun, to: now };

    conditions[ownerKey] = { ...mem, ownerKey, active, since, latches: into.latches, timers: into.timers, stopped, updatedAt: now };
    ruleStates.push({ ruleId: rule.id, active, stopped, since: active ? since : null, lastRun });
    if (active) activeRules.push(rule);

    if (flipped) {
      const energyKwh = lastRun?.energyKwh ?? null;
      decisions.push(
        active
          ? { code: 'rule.on', category: 'system', tone: 'event', params: { ruleId: rule.id } }
          : { code: 'rule.off', category: 'system', tone: 'idle', params: { ruleId: rule.id, energyKwh } },
      );
      spans.push({ subject: 'rule', subjectId: rule.id, kind: 'active', mode: null, edge: active ? 'start' : 'end', at: now, ...(active ? {} : { meta: { energyKwh: energyKwh ?? 0 } }) });
      if (active && rule.notifyOnActivate) {
        detections.push({ kind: 'rule_activated', dedupKey: `rule_activated:${rule.id}:${now}`, active: true, facts: { ruleId: rule.id } });
      }
    }
  }
  const overlay = mergeOverlay(cfg, activeRules);

  /* energy gate: restrictions apply while `activeWhen` holds; an unknown input keeps the last value a while */
  const energyMem = memoryOf(memory, 'energy', now);
  const energyInto: ConditionScratch = { latches: {}, timers: {} };
  const er = runCondition(cfg.energy.activeWhen, 'energy', ctx, energyMem, energyInto);
  let energyActive: boolean;
  let energyUnknownSince: EpochMs | null = null;
  if (er.value !== null) energyActive = er.value;
  else {
    energyUnknownSince = energyMem.unknownSince ?? now;
    energyActive = energyMem.lastKnownValue !== null && now - energyUnknownSince < ENERGY_HOLD_MS ? energyMem.lastKnownValue : false;
  }
  conditions.energy = {
    ...energyMem,
    ownerKey: 'energy',
    active: energyActive,
    since: energyActive !== energyMem.active ? now : energyMem.since,
    latches: energyInto.latches,
    timers: energyInto.timers,
    lastKnownValue: er.value !== null ? er.value : energyMem.lastKnownValue,
    unknownSince: energyUnknownSince,
    updatedAt: now,
  };

  /* custom watch rules */
  for (const w of cfg.watchRules) {
    if (w.condition.type !== 'custom' || w.muted) continue;
    const ownerKey = `watch:${w.id}`;
    const mem = memoryOf(memory, ownerKey, now);
    const into: ConditionScratch = { latches: {}, timers: {} };
    const r = runCondition(w.condition.node, ownerKey, ctx, mem, into);
    const active = r.value === null ? mem.active : r.value;
    conditions[ownerKey] = { ...mem, ownerKey, active, since: active !== mem.active ? now : mem.since, latches: into.latches, timers: into.timers, updatedAt: now };
    detections.push({
      kind: w.eventKind,
      severity: w.severity,
      dedupKey: `watch:${w.id}`,
      active,
      entityId: w.entityId,
      roomId: w.ref?.roomId ?? null,
      sourceId: w.ref?.sourceId ?? null,
      deviceKey: w.ref?.deviceKey ?? null,
      facts: { watchId: w.id, name: w.name },
    });
  }

  // memory of source condition items belongs to the plant step; keep it untouched here
  for (const [key, m] of Object.entries(memory.conditions)) if (key.startsWith('source:') && !(key in conditions)) conditions[key] = m;

  return {
    triggers: cfg.triggers.map((t) => triggerStates[t.id]).filter((t): t is TriggerState => !!t),
    rules: ruleStates,
    overlay,
    energyActive,
    conditions,
    decisions,
    detections,
    spans,
  };
};
