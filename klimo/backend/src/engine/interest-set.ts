import { walkNodes } from './core/conditions';
import type { ConditionNode, EngineConfig, EntityId } from '../shared/model';

/* =====================================================================================================
 * What the engine looks at. A house in Home Assistant has thousands of entities; the engine captures
 * only those the configuration names (sensors, heads and their siblings, sources, pumps, triggers,
 * energy, presence, calendars, watch rules) plus the few HA entities conditions read implicitly. State
 * changes outside this set never wake an evaluation.
 * ===================================================================================================== */

/** Entities conditions read without naming them. */
function implicitEntities(cfg: EngineConfig): EntityId[] {
  const out: EntityId[] = [];
  const visit = (node: ConditionNode | null | undefined) =>
    walkNodes(node, (n) => {
      if (n.op === 'sun') out.push('sun.sun');
      else if (n.op === 'grid' && cfg.energy.entities.gridOffline) out.push(cfg.energy.entities.gridOffline);
    });
  for (const t of cfg.triggers) visit(t.condition);
  for (const r of cfg.rules) {
    visit(r.when);
    visit(r.stopWhen);
  }
  for (const s of cfg.sources) for (const item of s.conditions.items) visit(item.node);
  visit(cfg.energy.activeWhen);
  for (const w of cfg.watchRules) if (w.condition.type === 'custom') visit(w.condition.node);
  // presence compares people against the home zone even when the setting names none
  if (cfg.settings.presence.enabled) out.push(cfg.settings.presence.homeZoneEntityId ?? 'zone.home');
  return out;
}

/** The interest set: every entity the configuration references, Z2M pseudo entities excluded. */
export function interestSet(cfg: EngineConfig, referenced: readonly EntityId[]): Set<EntityId> {
  const out = new Set<EntityId>();
  for (const id of [...referenced, ...implicitEntities(cfg)]) if (id && !id.startsWith('z2m:') && id.includes('.')) out.add(id);
  return out;
}

/** One HA-rendered template condition: `key` is how the core looks its result up. */
export interface TemplateNode {
  key: string;
  template: string;
}

/** Template nodes of one tree, keyed by owner and node id (or the node's path when it has no id). */
function collect(owner: string, node: ConditionNode | null | undefined, root: string, out: TemplateNode[]): void {
  const visit = (n: ConditionNode, path: string) => {
    const key = n.id ?? path;
    if (n.op === 'template') out.push({ key: `${owner}#${key}`, template: n.template });
    else if (n.op === 'all' || n.op === 'any') n.items.forEach((c, i) => visit(c, `${key}.${i}`));
    else if (n.op === 'not') visit(n.item, `${key}.0`);
  };
  if (node) visit(node, root);
}

/** Every template condition of the configuration, keyed exactly as the condition evaluator reads them. */
export function templateNodes(cfg: EngineConfig): TemplateNode[] {
  const out: TemplateNode[] = [];
  for (const t of cfg.triggers) collect(`trigger:${t.id}`, t.condition, '$', out);
  for (const r of cfg.rules) {
    // a rule evaluates both trees under one owner, told apart by their root paths
    collect(`rule:${r.id}`, r.when, '$w', out);
    collect(`rule:${r.id}`, r.stopWhen, '$s', out);
  }
  for (const s of cfg.sources) for (const item of s.conditions.items) collect(`source:${s.id}:${item.id}`, item.node, '$', out);
  collect('energy', cfg.energy.activeWhen, '$', out);
  for (const w of cfg.watchRules) if (w.condition.type === 'custom') collect(`watch:${w.id}`, w.condition.node, '$', out);
  return out;
}
