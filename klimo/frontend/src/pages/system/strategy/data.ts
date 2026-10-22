/**
 * The strategy screen's data: the heating/cooling strategy with its live chain states,
 * triggers, rules and the blackout energy policy, plus short texts shared by its cards.
 */
import type { ChainEntry, SourceRole, SourceStateKind, Tone } from '@api/model';
import { api } from '@api/endpoints';
import { useResource } from '@data';
import { sourceStateLabel, t } from '@i18n';

export function useStrategyData() {
  const strategy = useResource('strategy', api.strategy.get, { reloadOn: ['strategy', 'source', 'trigger', 'emitter', 'energy'] });
  const triggers = useResource('names:triggers', api.triggers.list, { reloadOn: ['trigger', 'strategy', 'source', 'rule', 'energy'] });
  const rules = useResource('names:rules', api.rules.list, { reloadOn: ['rule', 'trigger'] });
  const energy = useResource('energy', api.energy.get, { reloadOn: ['energy', 'source', 'trigger'] });
  return { strategy, triggers, rules, energy };
}

export type StrategyData = ReturnType<typeof useStrategyData>;

/** The chip of a chain entry: «зараз гріє», «резерв», «чекає тригер»… */
export function chainChip(rt: { role: SourceRole; state: SourceStateKind; tone: Tone } | undefined, entry: ChainEntry): { tone: Tone; label: string } {
  if (!entry.enabled) return { tone: 'off', label: t('switched off') };
  if (!rt) return { tone: 'off', label: '—' };
  switch (rt.state) {
    case 'heating':
      return { tone: 'heat', label: t('heating now') };
    case 'cooling':
    case 'drying':
      return { tone: 'cool', label: t('cooling now') };
    case 'defrost':
    case 'starting':
      return { tone: rt.tone === 'cool' ? 'cool' : 'heat', label: sourceStateLabel(rt.state).toLowerCase() };
    case 'waiting_trigger':
      return { tone: 'warn', label: t('waits for a trigger') };
    case 'waiting_season':
      return { tone: 'hold', label: t('out of season') };
    case 'fault':
    case 'unavailable':
      return { tone: 'err', label: sourceStateLabel(rt.state).toLowerCase() };
    case 'disabled':
    case 'paused':
      return { tone: 'off', label: sourceStateLabel(rt.state).toLowerCase() };
    default:
      return rt.role === 'reserve' ? { tone: 'hold', label: t('reserve') } : { tone: 'hold', label: t('not needed now') };
  }
}

/** «травень – вересень», «увесь рік», «вимкнено на весь рік»; the year wraps (листопад – лютий). */
export function monthsSummary(months: readonly boolean[], name: (m: number) => string): string {
  const on = months.map((x, i) => (x ? i : -1)).filter((i) => i >= 0);
  if (!on.length) return t('off for the whole year');
  if (on.length === 12) return t('the whole year');
  if (on.length === 1) return name(on[0] + 1).toLowerCase();
  // a single run of months, possibly over the new year
  const start = on.find((i) => !months[(i + 11) % 12]);
  const runs = months.filter((x, i) => x && !months[(i + 11) % 12]).length;
  if (runs === 1 && start != null) {
    const end = (start + on.length - 1) % 12;
    return `${name(start + 1).toLowerCase()} – ${name(end + 1).toLowerCase()}`;
  }
  return t('{count} months a year', { count: on.length });
}
