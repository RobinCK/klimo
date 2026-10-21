/**
 * Names for the ids that codes carry (rooms, sources, profiles, triggers …), so the renderers
 * in @i18n can say «Тепловий насос гріє» instead of «s_hp01 гріє». Rooms come from the live
 * store; the other lists are shared resources reloaded when their config changes.
 */
import { useMemo } from 'react';
import type { Id } from '@api/model';
import { api } from '@api/endpoints';
import { nowMs, type CodeContext } from '@i18n';
import { useLive } from './hooks';
import { useResource } from './resource';

type Named = { id: Id; name: string };

function index<T>(list: readonly T[] | undefined, pick: (x: T) => Named): Map<Id, string> {
  const m = new Map<Id, string>();
  for (const x of list ?? []) {
    const n = pick(x);
    m.set(n.id, n.name);
  }
  return m;
}

export interface NameDirectory extends CodeContext {
  ready: boolean;
}

/**
 * A code-rendering context with names resolved. Lists load on first use and are cached for
 * the whole app, so calling this from many components costs one request per list.
 */
export function useCodeContext(): NameDirectory {
  const rooms = useLive((s) => s.rooms);
  const profiles = useResource('names:profiles', api.profiles.list, { reloadOn: ['profile'] });
  const sources = useResource('names:sources', api.sources.list, { reloadOn: ['source'] });
  const circuits = useResource('names:circuits', api.circuits.list, { reloadOn: ['circuit'] });
  const pumps = useResource('names:pumps', api.pumps.list, { reloadOn: ['pump'] });
  const triggers = useResource('names:triggers', api.triggers.list, { reloadOn: ['trigger'] });
  const rules = useResource('names:rules', api.rules.list, { reloadOn: ['rule'] });
  const z2m = useResource('names:z2m', api.z2m.list, { reloadOn: ['z2m_instance'] });

  return useMemo(() => {
    const roomNames = new Map<Id, string>();
    for (const r of rooms.values()) {
      roomNames.set(r.id, r.name);
      roomNames.set(r.slug, r.name);
    }
    const profileNames = index(profiles.data, (p) => p);
    const sourceNames = index(sources.data, (s) => s.config);
    const circuitNames = index(circuits.data, (c) => ({ id: c.config.id, name: c.config.name }));
    const pumpNames = index(pumps.data, (p) => p);
    const triggerNames = index(triggers.data, (x) => x.config);
    const ruleNames = index(rules.data, (x) => x.config);
    const z2mNames = index(z2m.data, (x) => x.config);
    // emitter devices are named in the room detail; a device key falls back to its id
    return {
      ready: Boolean(profiles.settled && sources.settled),
      room: (id) => roomNames.get(id),
      profile: (id) => profileNames.get(id),
      source: (id) => sourceNames.get(id),
      circuit: (id) => circuitNames.get(id),
      pump: (id) => pumpNames.get(id),
      trigger: (id) => triggerNames.get(id),
      rule: (id) => ruleNames.get(id),
      instance: (id) => z2mNames.get(id),
      get now() {
        return nowMs();
      },
    } satisfies NameDirectory;
  }, [rooms, profiles.data, profiles.settled, sources.data, sources.settled, circuits.data, pumps.data, triggers.data, rules.data, z2m.data]);
}
