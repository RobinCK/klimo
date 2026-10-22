/**
 * Names for the ids that codes carry (rooms, sources, profiles, triggers, devices …), so the
 * renderers in @i18n can say «Тепловий насос гріє» instead of «s_hp01 гріє» and «Рушникосушка»
 * instead of «climate.bathroom_towel_trv». Rooms come from the live store; the other lists are
 * shared resources reloaded when their config changes.
 */
import { useMemo } from 'react';
import type { Id, SourceConfig } from '@api/model';
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

type SourceNaming = Pick<SourceConfig, 'id' | 'name' | 'scope' | 'roomId'>;

/**
 * Source names as lists and diagrams show them. Three air conditioners all called «Кондиціонер»
 * read as «Кондиціонер · Вітальня», «Кондиціонер · Спальня»…: a room source gets its room after
 * the name when another source has the same name, or always with `withRoom` (lists grouped by
 * place). A name that already says the room stays as typed.
 */
export function sourceLabels(list: readonly SourceNaming[], roomName: (id: Id) => string | undefined, withRoom = false): Map<Id, string> {
  const key = (name: string) => name.trim().toLocaleLowerCase();
  const uses = new Map<string, number>();
  for (const s of list) uses.set(key(s.name), (uses.get(key(s.name)) ?? 0) + 1);
  const out = new Map<Id, string>();
  for (const s of list) {
    const room = s.scope === 'room' && s.roomId ? roomName(s.roomId) : undefined;
    const qualify = room && (withRoom || (uses.get(key(s.name)) ?? 0) > 1) && !s.name.includes(room);
    out.set(s.id, qualify ? `${s.name} · ${room}` : s.name);
  }
  return out;
}

export interface NameDirectory extends CodeContext {
  ready: boolean;
  /** The source's name for a list or a diagram: with its room when another source shares the name. */
  sourceLabel: (id: Id) => string | undefined;
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
  const devices = useResource('devices', () => api.devices.list(), { reloadOn: ['device_meta', 'sensor', 'emitter_device', 'source', 'pump'] });

  return useMemo(() => {
    const roomNames = new Map<Id, string>();
    for (const r of rooms.values()) {
      roomNames.set(r.id, r.name);
      roomNames.set(r.slug, r.name);
    }
    const profileNames = index(profiles.data, (p) => p);
    const sourceNames = index(sources.data, (s) => s.config);
    const labels = sourceLabels(
      (sources.data ?? []).map((s) => s.config),
      (id) => roomNames.get(id),
    );
    const circuitNames = index(circuits.data, (c) => ({ id: c.config.id, name: c.config.name }));
    const pumpNames = index(pumps.data, (p) => p);
    const triggerNames = index(triggers.data, (x) => x.config);
    const ruleNames = index(rules.data, (x) => x.config);
    const z2mNames = index(z2m.data, (x) => x.config);
    // a device by its key or by any of its entities, with the label people gave it
    const deviceNames = new Map<string, string>();
    const entityNames = new Map<string, string>();
    for (const d of devices.data?.devices ?? []) {
      const name = d.label ?? d.name;
      deviceNames.set(d.key, name);
      for (const e of d.entityIds) entityNames.set(e, name);
    }
    return {
      ready: Boolean(profiles.settled && sources.settled),
      room: (id) => roomNames.get(id),
      profile: (id) => profileNames.get(id),
      source: (id) => sourceNames.get(id),
      sourceLabel: (id) => labels.get(id),
      circuit: (id) => circuitNames.get(id),
      pump: (id) => pumpNames.get(id),
      trigger: (id) => triggerNames.get(id),
      rule: (id) => ruleNames.get(id),
      instance: (id) => z2mNames.get(id),
      device: (key) => deviceNames.get(key),
      entity: (id) => entityNames.get(id),
      get now() {
        return nowMs();
      },
    } satisfies NameDirectory;
  }, [rooms, profiles.data, profiles.settled, sources.data, sources.settled, circuits.data, pumps.data, triggers.data, rules.data, z2m.data, devices.data]);
}
