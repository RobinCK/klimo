import { newId, ID_PREFIX } from '../common/ids';
import type { ConditionNode, EntityId, Id, ServiceCallSpec, SourceConfig, UsageRef } from '../shared/model';
import type { ConfigGraph } from './graph';

/* =====================================================================================================
 * Who references what. Condition trees, source bindings and chains point at triggers, sources, rooms
 * and HA entities; these walkers answer "where is X used" (delete dialogs, pickers' «вже в …»), build
 * the set of HA entities the engine must watch, and rewrite references when something is removed.
 * ===================================================================================================== */

export function childrenOf(node: ConditionNode): ConditionNode[] {
  if (node.op === 'all' || node.op === 'any') return node.items ?? [];
  if (node.op === 'not') return node.item ? [node.item] : [];
  return [];
}

export function walkCondition(node: ConditionNode | null | undefined, visit: (n: ConditionNode) => void): void {
  if (!node) return;
  visit(node);
  for (const c of childrenOf(node)) walkCondition(c, visit);
}

/** Rebuilds a tree bottom-up; `fn` may return a replacement for any node. */
export function mapCondition(node: ConditionNode, fn: (n: ConditionNode) => ConditionNode): ConditionNode {
  let next: ConditionNode = node;
  if (node.op === 'all' || node.op === 'any') next = { ...node, items: node.items.map((c) => mapCondition(c, fn)) };
  else if (node.op === 'not') next = { ...node, item: mapCondition(node.item, fn) };
  return fn(next);
}

/** Every node gets a stable id (the key of its latch/timer memory). */
export function ensureNodeIds(node: ConditionNode): ConditionNode {
  const seen = new Set<string>();
  return mapCondition(node, (n) => {
    if (n.id && !seen.has(n.id)) {
      seen.add(n.id);
      return n;
    }
    const id = newId(ID_PREFIX.conditionNode);
    seen.add(id);
    return { ...n, id };
  });
}

export function conditionEntities(node: ConditionNode | null | undefined): EntityId[] {
  const out: EntityId[] = [];
  walkCondition(node, (n) => {
    if (n.op === 'state' || n.op === 'weather') out.push(n.entityId);
    else if (n.op === 'numeric') {
      out.push(n.entityId);
      if (n.minus) out.push(n.minus);
    } else if (n.op === 'time' && n.tariffEntityId) out.push(n.tariffEntityId);
  });
  return out.filter(Boolean);
}

export function conditionTriggers(node: ConditionNode | null | undefined): Id[] {
  const out: Id[] = [];
  walkCondition(node, (n) => {
    if (n.op === 'trigger') out.push(n.triggerId);
  });
  return out;
}

export function conditionSources(node: ConditionNode | null | undefined): Id[] {
  const out: Id[] = [];
  walkCondition(node, (n) => {
    if (n.op === 'source') out.push(n.sourceId);
  });
  return out;
}

export function conditionRooms(node: ConditionNode | null | undefined): Id[] {
  const out: Id[] = [];
  walkCondition(node, (n) => {
    if (n.op === 'room_deficit' && Array.isArray(n.roomIds)) out.push(...n.roomIds);
    else if (n.op === 'room_below_target') out.push(n.roomId);
  });
  return out;
}

/** A removed reference reads as a constant false (the safe value: nothing gets allowed by it). */
export function dropRefs(node: ConditionNode, drop: { triggerId?: Id; sourceId?: Id; roomId?: Id }): ConditionNode {
  return mapCondition(node, (n) => {
    if (drop.triggerId && n.op === 'trigger' && n.triggerId === drop.triggerId) return { op: 'const', value: false, id: n.id };
    if (drop.sourceId && n.op === 'source' && n.sourceId === drop.sourceId) return { op: 'const', value: false, id: n.id };
    if (drop.roomId && n.op === 'room_below_target' && n.roomId === drop.roomId) return { op: 'const', value: false, id: n.id };
    if (drop.roomId && n.op === 'room_deficit' && Array.isArray(n.roomIds) && n.roomIds.includes(drop.roomId)) {
      const roomIds = n.roomIds.filter((r) => r !== drop.roomId);
      return roomIds.length ? { ...n, roomIds } : { op: 'const', value: false, id: n.id };
    }
    return n;
  });
}

/** Every condition tree in the configuration, with its owner and a setter for rewriting. */
export interface ConditionSite {
  owner: UsageRef;
  node: ConditionNode;
  set(next: ConditionNode): void;
}

export function conditionSites(g: ConfigGraph): ConditionSite[] {
  const sites: ConditionSite[] = [];
  for (const t of g.triggers.values()) {
    sites.push({ owner: { type: 'trigger', id: t.id, label: t.name }, node: t.condition, set: (n) => (t.condition = n) });
  }
  for (const r of g.rules.values()) {
    sites.push({ owner: { type: 'rule', id: r.id, label: r.name }, node: r.when, set: (n) => (r.when = n) });
    const stop = r.stopWhen;
    if (stop) sites.push({ owner: { type: 'rule', id: r.id, label: r.name }, node: stop, set: (n) => (r.stopWhen = n) });
  }
  for (const s of g.sources.values()) {
    for (const item of s.conditions.items) {
      sites.push({ owner: { type: 'source', id: s.id, label: s.name }, node: item.node, set: (n) => (item.node = n) });
    }
  }
  sites.push({ owner: { type: 'energy', id: null, label: '' }, node: g.energy.activeWhen, set: (n) => (g.energy.activeWhen = n) });
  for (const w of g.watchRules.values()) {
    const cond = w.condition;
    if (cond.type === 'custom') sites.push({ owner: { type: 'watch', id: w.id, label: w.name }, node: cond.node, set: (n) => (w.condition = { type: 'custom', node: n }) });
  }
  return sites;
}

function callEntities(calls: readonly ServiceCallSpec[] | null | undefined): EntityId[] {
  const out: EntityId[] = [];
  for (const c of calls ?? []) {
    const e = c.target?.entity_id;
    if (Array.isArray(e)) out.push(...e);
    else if (e) out.push(e);
  }
  return out;
}

/** HA entities a source is bound to (adapter, confirmation, watchdog, power meter). */
export function sourceEntities(s: SourceConfig): EntityId[] {
  const out: (EntityId | null | undefined)[] = [s.energy.powerEntityId];
  const a = s.adapter;
  switch (a.type) {
    case 'relay':
      out.push(a.command, ...a.stages.map((x) => x.entityId), a.flowSetpoint?.entityId);
      if (a.watchdog.kind === 'countdown_number') out.push(a.watchdog.entityId);
      if (a.watchdog.kind === 'service') out.push(...callEntities([a.watchdog.call]));
      break;
    case 'climate':
      out.push(a.climate, a.defrostEntityId, a.errorEntityId, a.copEntityId, a.supplyTempEntityId);
      break;
    case 'flow':
      out.push(a.enable, a.flowSetpoint, a.actualFlow, a.modeSelect?.entityId);
      break;
    case 'script':
      out.push(...Object.values(a.on), a.off);
      break;
    case 'custom':
      for (const calls of Object.values(a.on)) out.push(...callEntities(calls));
      out.push(...callEntities(a.off), ...callEntities(a.setpoint));
      break;
  }
  const c = a.confirm;
  if (c.kind === 'entity_on' || c.kind === 'power_above' || c.kind === 'state_in') out.push(c.entityId);
  return out.filter((e): e is EntityId => typeof e === 'string' && e.length > 0);
}

/** Every (entity, user) pair in the configuration. */
export function entityRefs(g: ConfigGraph): { entityId: EntityId; usage: UsageRef }[] {
  const out: { entityId: EntityId; usage: UsageRef }[] = [];
  const add = (entityId: EntityId | null | undefined, usage: UsageRef) => {
    if (entityId && !entityId.startsWith('z2m:')) out.push({ entityId, usage });
  };
  const roomRef = (roomId: Id): UsageRef => ({ type: 'room', id: roomId, label: g.rooms.get(roomId)?.name ?? '' });

  for (const r of g.rooms.values()) if (r.humidity.dehumidifier) add(r.humidity.dehumidifier.entityId, roomRef(r.id));
  for (const s of g.sensors.values()) add(s.entityId, roomRef(s.roomId));
  for (const d of g.emitterDevices.values()) {
    add(d.entityId, roomRef(d.roomId));
    if (d.siblings) for (const v of Object.values(d.siblings)) add(v, roomRef(d.roomId));
  }
  for (const s of g.sources.values()) for (const e of sourceEntities(s)) add(e, { type: 'source', id: s.id, label: s.name });
  for (const m of g.manifolds.values()) {
    add(m.supplySensorEntityId, { type: 'circuit', id: m.id, label: m.name });
    add(m.returnSensorEntityId, { type: 'circuit', id: m.id, label: m.name });
  }
  for (const c of g.circuits.values()) {
    const u: UsageRef = { type: 'circuit', id: c.id, label: c.name };
    add(c.supply.sensorEntityId, u);
    add(c.supply.returnEntityId, u);
    add(c.mixingValve?.entityId, u);
  }
  for (const p of g.pumps.values()) {
    add(p.entityId, { type: 'pump', id: p.id, label: p.name });
    add(p.speed?.entityId, { type: 'pump', id: p.id, label: p.name });
  }
  for (const site of conditionSites(g)) for (const e of conditionEntities(site.node)) add(e, site.owner);
  const energy: UsageRef = { type: 'energy', id: null, label: '' };
  for (const e of Object.values(g.energy.entities)) add(e, energy);
  const settings: UsageRef = { type: 'settings', id: null, label: '' };
  add(g.settings.outdoor.sensorEntityId, settings);
  add(g.settings.outdoor.weatherEntityId, settings);
  if (g.settings.presence.enabled) {
    for (const p of g.settings.presence.personEntityIds) add(p, settings);
    add(g.settings.presence.homeZoneEntityId, settings);
    add(g.settings.presence.proximityEntityId, settings);
  }
  for (const a of g.activationRules.values()) {
    if (a.config.type === 'calendar') add(a.config.calendarEntityId, { type: 'settings', id: a.profileId, label: g.profiles.get(a.profileId)?.name ?? '' });
  }
  for (const z of g.z2m.values()) add(z.bridgeEntityId, { type: 'settings', id: z.id, label: z.name });
  for (const w of g.watchRules.values()) add(w.entityId, { type: 'watch', id: w.id, label: w.name });
  return out;
}

export function referencedEntities(g: ConfigGraph): EntityId[] {
  return [...new Set(entityRefs(g).map((r) => r.entityId))].sort();
}

function uniqueRefs(refs: UsageRef[]): UsageRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => {
    const k = `${r.type}|${r.id ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export type UsageQuery = { type: 'room' | 'source' | 'circuit' | 'pump' | 'profile' | 'trigger' | 'rule' | 'target' | 'entity'; id: string };

export function usagesOf(g: ConfigGraph, q: UsageQuery): UsageRef[] {
  const refs: UsageRef[] = [];
  const roomRef = (roomId: Id): UsageRef => ({ type: 'room', id: roomId, label: g.rooms.get(roomId)?.name ?? '' });
  const ruleRef = (id: Id): UsageRef => ({ type: 'rule', id, label: g.rules.get(id)?.name ?? '' });
  switch (q.type) {
    case 'room': {
      for (const s of g.sources.values()) if (s.scope === 'room' && s.roomId === q.id) refs.push({ type: 'source', id: s.id, label: s.name });
      for (const site of conditionSites(g)) if (conditionRooms(site.node).includes(q.id)) refs.push(site.owner);
      for (const r of g.rules.values()) {
        if (r.effects.some((e) => e.type === 'target_offset' && Array.isArray(e.roomIds) && e.roomIds.includes(q.id))) refs.push(ruleRef(r.id));
      }
      break;
    }
    case 'source': {
      for (const e of g.heat.chain) if (e.sourceIds.includes(q.id)) refs.push({ type: 'heat_chain', id: e.id, label: e.label ?? '' });
      for (const e of g.cool.chain) if (e.sourceIds.includes(q.id)) refs.push({ type: 'cool_chain', id: e.id, label: e.label ?? '' });
      for (const r of g.rules.values()) {
        const hit = r.effects.some((e) =>
          (e.type === 'only_sources' || e.type === 'forbid_sources' || e.type === 'allow_sources' || e.type === 'preheat_to_next_slot')
            ? e.sourceIds.includes(q.id)
            : e.type === 'source_requires' && e.sourceId === q.id,
        );
        if (hit) refs.push(ruleRef(r.id));
      }
      for (const site of conditionSites(g)) if (conditionSources(site.node).includes(q.id) && site.owner.id !== q.id) refs.push(site.owner);
      if (g.energy.shedOrder.includes(q.id) || g.energy.exempt.sourceIds.includes(q.id)) refs.push({ type: 'energy', id: null, label: '' });
      for (const e of g.emitters.values()) if (e.sourceId === q.id) refs.push(roomRef(e.roomId));
      for (const c of g.circuits.values()) if (c.sourceIds.includes(q.id)) refs.push({ type: 'circuit', id: c.id, label: c.name });
      for (const s of g.sources.values()) if (s.linkedTo === q.id) refs.push({ type: 'source', id: s.id, label: s.name });
      break;
    }
    case 'circuit': {
      for (const e of g.emitters.values()) if (e.circuitId === q.id) refs.push(roomRef(e.roomId));
      for (const p of g.pumps.values()) if (p.circuitId === q.id) refs.push({ type: 'pump', id: p.id, label: p.name });
      break;
    }
    case 'pump': {
      for (const w of g.watchRules.values()) if (w.ref?.pumpId === q.id) refs.push({ type: 'watch', id: w.id, label: w.name });
      break;
    }
    case 'profile': {
      if (g.settings.defaultProfileId === q.id || g.settings.ecoProfileId === q.id) refs.push({ type: 'settings', id: null, label: '' });
      for (const s of g.schedules.values()) {
        if (!s.days.some((d) => d.some((b) => b.profileId === q.id))) continue;
        refs.push(s.roomId ? roomRef(s.roomId) : { type: 'settings', id: s.id, label: '' });
      }
      for (const x of g.scheduleExceptions.values()) {
        if (!Array.isArray(x.plan) || !x.plan.some((b) => b.profileId === q.id)) continue;
        const s = g.schedules.get(x.scheduleId);
        refs.push(s?.roomId ? roomRef(s.roomId) : { type: 'settings', id: x.scheduleId, label: '' });
      }
      for (const a of g.activationRules.values()) {
        if (a.profileId !== q.id && a.config.type === 'vacation' && a.config.returnProfileId === q.id) refs.push({ type: 'settings', id: a.profileId, label: g.profiles.get(a.profileId)?.name ?? '' });
      }
      for (const o of g.overrides.values()) {
        if ((o.value.kind === 'room_profile' || o.value.kind === 'house_profile') && o.value.profileId === q.id) {
          refs.push(o.scope === 'room' ? roomRef(o.subjectId) : { type: 'settings', id: null, label: '' });
        }
      }
      break;
    }
    case 'trigger': {
      for (const site of conditionSites(g)) if (conditionTriggers(site.node).includes(q.id) && !(site.owner.type === 'trigger' && site.owner.id === q.id)) refs.push(site.owner);
      for (const r of g.rules.values()) if (r.effects.some((e) => e.type === 'source_requires' && e.triggerId === q.id)) refs.push(ruleRef(r.id));
      break;
    }
    case 'rule':
      break;
    case 'target': {
      if (g.notify.escalation.targetId === q.id) refs.push({ type: 'settings', id: null, label: '' });
      for (const p of g.personal.values()) if (p.targetIds.includes(q.id)) refs.push({ type: 'settings', id: p.userId, label: '' });
      break;
    }
    case 'entity': {
      for (const r of entityRefs(g)) if (r.entityId === q.id) refs.push(r.usage);
      break;
    }
  }
  return uniqueRefs(refs);
}
