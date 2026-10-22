import type { EngineConfig, Id, SourceConfig } from '../shared/model';

type Named = Pick<EngineConfig, 'sources' | 'rooms'>;

const key = (name: string) => name.trim().toLocaleLowerCase();

/**
 * Names that tell sources apart. Three air conditioners all called «Кондиціонер» read as
 * «Кондиціонер · Вітальня», «Кондиціонер · Спальня»…; a name no other source shares stays as it is,
 * and so does one without a room to add.
 */
export function sourceLabels(cfg: Named): Map<Id, string> {
  const count = new Map<string, number>();
  for (const s of cfg.sources) count.set(key(s.name), (count.get(key(s.name)) ?? 0) + 1);
  const rooms = new Map(cfg.rooms.map((r) => [r.id, r.name]));
  const out = new Map<Id, string>();
  for (const s of cfg.sources) {
    const room = s.roomId ? rooms.get(s.roomId) : undefined;
    out.set(s.id, (count.get(key(s.name)) ?? 0) > 1 && room ? `${s.name} · ${room}` : s.name);
  }
  return out;
}

export function sourceLabel(cfg: Named, s: Pick<SourceConfig, 'id' | 'name'>): string {
  return sourceLabels(cfg).get(s.id) ?? s.name;
}
