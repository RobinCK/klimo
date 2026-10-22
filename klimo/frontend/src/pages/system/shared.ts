/**
 * What every system screen shares: the data (sources, circuits, plant, settings), names for
 * sources as people know them («Кондиціонер · Вітальня»), icons and state chips.
 */
import type { IconName, Id, SourceConfig, SourceDto, SourceKind, SourceState, Tone } from '@api/model';
import { api } from '@api/endpoints';
import { useCodeContext, useHouse, useMe, useNow, usePlant, useResource, useRoomSummaries } from '@data';
import { fmtTime, renderReason, sourceStateLabel, t, type CodeContext } from '@i18n';

export const SOURCE_ICON: Record<SourceKind, IconName> = {
  gas_boiler: 'boiler',
  electric_boiler: 'electricBoiler',
  heat_pump: 'heatPump',
  ac: 'ac',
  electric_radiator: 'convector',
  electric_floor: 'floor',
  ir_panel: 'irBlaster',
  custom: 'anyEntity',
};

const RUNNING = new Set<SourceState['state']>(['heating', 'cooling', 'drying', 'fan', 'defrost', 'starting']);

export const isRunning = (s: SourceState | null | undefined) => Boolean(s && RUNNING.has(s.state));

/** A room source is named with its room («Кондиціонер · Вітальня») unless the name already says it. */
export function sourceName(cfg: Pick<SourceConfig, 'name' | 'roomId' | 'scope'>, roomName: (id: Id) => string | undefined): string {
  if (cfg.scope !== 'room' || !cfg.roomId) return cfg.name;
  const room = roomName(cfg.roomId);
  return room && !cfg.name.includes(room) ? `${cfg.name} · ${room}` : cfg.name;
}

/** The state chip of a source: a fault or a lost connection wins over the state's own tone. */
export function sourceChip(s: SourceState | null | undefined): { tone: Tone; label: string } {
  if (!s) return { tone: 'off', label: '—' };
  if (s.fault || s.state === 'fault') return { tone: 'err', label: sourceStateLabel('fault') };
  if (!s.available || s.state === 'unavailable') return { tone: 'err', label: sourceStateLabel('unavailable') };
  const tone: Tone = s.tone === 'wait' ? 'warn' : s.tone === 'idle' ? 'hold' : s.tone;
  return { tone, label: sourceStateLabel(s.state) };
}

/** One line under a source: what it does now («подача 38° · 2.1 кВт · COP 3.1») or its role. */
export function sourceMeta(dto: SourceDto, ctx: CodeContext): string {
  const s = dto.state;
  const tel = s.telemetry;
  if (isRunning(s)) {
    const parts: string[] = [];
    if (s.since) parts.push(t('since {time}', { time: fmtTime(s.since) }));
    if (tel.supplyC != null) parts.push(t('flow {t}', { t: `${tel.supplyC.toFixed(0)}°` }));
    if (tel.powerKw != null) parts.push(t('{kw} kW', { kw: tel.powerKw.toFixed(1) }));
    if (tel.cop != null) parts.push(t('COP {cop}', { cop: tel.cop.toFixed(1) }));
    if (parts.length > 1) return parts.join(' · ');
  }
  if (s.blockers.length) return renderReason(s.blockers[0], ctx);
  return renderReason(s.roleReason, ctx);
}

export function useSystemData() {
  const sources = useResource('names:sources', api.sources.list, { reloadOn: ['source', 'strategy', 'trigger', 'rule', 'energy', 'circuit'] });
  const circuits = useResource('names:circuits', api.circuits.list, { reloadOn: ['circuit', 'pump', 'manifold', 'source'] });
  const settings = useResource('settings', api.settings.get, { reloadOn: ['settings', 'safety', 'house'] });
  const plant = usePlant();
  const house = useHouse();
  const rooms = useRoomSummaries();
  const me = useMe();
  const ctx = useCodeContext();
  const now = useNow(30_000);
  const canEdit = me?.canEditConfig ?? false;
  const roomName = (id: Id) => rooms.find((r) => r.id === id || r.slug === id)?.name ?? ctx.room?.(id);
  // a running source's state comes from the live plant, its config from the list
  const liveState = (id: Id): SourceState | null =>
    plant?.sources.find((s) => s.sourceId === id) ?? sources.data?.find((s) => s.config.id === id)?.state ?? null;
  const nameOf = (id: Id) => {
    const dto = sources.data?.find((s) => s.config.id === id);
    return dto ? sourceName(dto.config, roomName) : (ctx.source?.(id) ?? id);
  };
  return { sources, circuits, settings, plant, house, rooms, ctx, now, canEdit, roomName, liveState, nameOf };
}

export type SystemData = ReturnType<typeof useSystemData>;
