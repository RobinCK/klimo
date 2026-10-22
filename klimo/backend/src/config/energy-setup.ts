import {
  batteryLowCondition,
  blackoutCondition,
  economyRule,
  nightTariffCondition,
  preheatNightRule,
  seedTriggers,
  solarCondition,
  storeHeatRule,
  type EnergyBindings,
  type RuleSourceSets,
} from '../shared/defaults';
import type { Actor, ConditionNode, EnergyPolicy, IConfigStore, Lang, SourceConfig, Trigger, TriggerRule } from '../shared/model';
import { mapCondition, walkCondition } from './refs';

/* =====================================================================================================
 * «Налаштувати енергію»: binds the grid / PV / load / battery / tariff entities and brings the seeded
 * blackout machinery to life — the triggers get their entities and are enabled once they can be
 * evaluated, the rules learn which sources are gas boilers, heat pumps and electric heaters. Running
 * it again with the same entities changes nothing; thresholds the household tuned are kept.
 * ===================================================================================================== */

export function ruleSourceSets(sources: readonly SourceConfig[]): RuleSourceSets {
  return {
    gasBoilers: sources.filter((s) => s.kind === 'gas_boiler').map((s) => s.id),
    heatPumps: sources.filter((s) => s.kind === 'heat_pump').map((s) => s.id),
    electricHeat: sources.filter((s) => s.energy.carrier === 'electric' && s.capabilities.heat).map((s) => s.id),
  };
}

/** The canonical tree with entities bound, keeping thresholds the user tuned on nodes with the same id. */
export function rebind(existing: ConditionNode | null | undefined, canonical: ConditionNode): ConditionNode {
  const old = new Map<string, ConditionNode>();
  walkCondition(existing, (n) => {
    if (n.id) old.set(n.id, n);
  });
  return mapCondition(canonical, (n) => {
    const prev = n.id ? old.get(n.id) : undefined;
    if (n.op === 'numeric' && prev?.op === 'numeric') return { ...n, cmp: prev.cmp, value: prev.value, exitAt: prev.exitAt, forSec: prev.forSec };
    if (n.op === 'time' && prev?.op === 'time') return { ...n, windows: prev.windows, tariffStates: prev.tariffStates ?? n.tariffStates };
    return n;
  });
}

function bindings(e: EnergyPolicy['entities']): EnergyBindings {
  return { gridOffline: e.gridOffline, pvPower: e.pvPower, houseLoad: e.houseLoad, batterySoc: e.batterySoc, tariff: e.tariff };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export async function applyEnergySetup(config: IConfigStore, entities: EnergyPolicy['entities'], actor: Actor): Promise<EnergyPolicy> {
  return config.transaction(async (tx) => {
    // a seeded trigger or rule the household deleted comes back with its English seed name
    const lang: Lang = 'en';
    const e = bindings(entities);
    const energy = tx.singleton('energy');
    const sets = ruleSourceSets(tx.list('sources'));

    await tx.patchSingleton(
      'energy',
      {
        entities: { ...entities },
        activeWhen: rebind(energy.activeWhen, { op: 'trigger', triggerId: 'blackout', id: 'energy_blackout' }),
        exempt: { ...energy.exempt, sourceIds: [...new Set([...energy.exempt.sourceIds, ...sets.gasBoilers])] },
      },
      actor,
    );

    const seeded = new Map(seedTriggers(lang).map((t) => [t.id, t]));
    const upsertTrigger = async (id: string, condition: ConditionNode, enable: boolean | null) => {
      const cur = tx.get('triggers', id);
      const next = rebind(cur?.condition, condition);
      if (!cur) {
        const base = seeded.get(id) as Trigger;
        await tx.create('triggers', { ...base, condition: next, enabled: enable ?? base.enabled }, actor);
        return;
      }
      const patch: Partial<Trigger> = {};
      if (!same(cur.condition, next)) patch.condition = next;
      if (enable !== null && cur.enabled !== enable) patch.enabled = enable;
      if (Object.keys(patch).length) await tx.update('triggers', id, patch, actor);
    };
    await upsertTrigger('blackout', blackoutCondition(e), !!e.gridOffline);
    await upsertTrigger('solar', solarCondition(e), !!(e.gridOffline && e.pvPower && e.houseLoad && e.batterySoc));
    await upsertTrigger('battery_low', batteryLowCondition(e), !!(e.gridOffline && e.batterySoc));
    // the night tariff is a choice, not a consequence of wiring: only a bound tariff entity switches it on
    await upsertTrigger('night_tariff', nightTariffCondition(e), e.tariff ? true : null);

    const upsertRule = async (rule: TriggerRule, enable: boolean | null) => {
      const cur = tx.get('rules', rule.id);
      if (!cur) {
        await tx.create('rules', { ...rule, enabled: enable ?? rule.enabled }, actor);
        return;
      }
      const patch: Partial<TriggerRule> = {};
      const when = rebind(cur.when, rule.when);
      const stopWhen = rule.stopWhen ? rebind(cur.stopWhen, rule.stopWhen) : null;
      if (!same(cur.when, when)) patch.when = when;
      if (!same(cur.stopWhen, stopWhen)) patch.stopWhen = stopWhen;
      // source lists follow the configured sources; offsets and caps stay as the household tuned them
      const effects = rule.effects.map((x) => {
        const prev = cur.effects.find((p) => p.type === x.type);
        return prev && (x.type === 'target_offset' || x.type === 'power_cap' || x.type === 'disable_carrier') ? prev : x;
      });
      if (!same(cur.effects, effects)) patch.effects = effects;
      if (enable !== null && cur.enabled !== enable) patch.enabled = enable;
      if (Object.keys(patch).length) await tx.update('rules', rule.id, patch, actor);
    };
    // economy needs a fuel that works without the grid and a battery level to react to
    await upsertRule(economyRule(lang, sets, false), sets.gasBoilers.length > 0 && !!e.batterySoc);
    await upsertRule(storeHeatRule(lang, sets, e.batterySoc), null);
    await upsertRule(preheatNightRule(lang, sets), null);

    return tx.singleton('energy');
  });
}
