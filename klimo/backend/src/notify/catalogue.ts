import type { EventKind, EventParams, IconName, IncidentAction, IncidentDto, Severity } from '../shared/model';
import { catalogueEntry } from '../shared/defaults';

/** The alert catalogue (severity, default routing, thresholds, actions) lives with the other defaults. */
export { EVENT_CATALOGUE, catalogueEntry, defaultRouteOn, isLockedCell, targetPreset } from '../shared/defaults';
export type { TargetPreset } from '../shared/defaults';

/** A numeric threshold of a kind: the edited value, else the catalogue default, else `fallback`. */
export function paramNum(params: readonly EventParams[], kind: EventKind, name: string, fallback: number): number {
  const stored = params.find((p) => p.kind === kind)?.params[name];
  const v = stored ?? catalogueEntry(kind).defaultParams[name];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function kindEnabled(params: readonly EventParams[], kind: EventKind): boolean {
  return params.find((p) => p.kind === kind)?.enabled ?? true;
}

/** Buttons of an incident: the kind's actions; a critical one is only ever acknowledged, never hidden. */
export function actionsFor(kind: EventKind, severity: Severity): IncidentAction[] {
  const actions = [...catalogueEntry(kind).actions];
  if (severity !== 'critical') return actions;
  return [...new Set<IncidentAction>(['ack', ...actions.filter((a) => a !== 'snooze' && a !== 'snooze_until_morning' && a !== 'dismiss')])];
}

/** One-shot kinds are journal-like events: they open and resolve in the same moment. */
export function isOneShot(severity: Severity): boolean {
  return severity === 'event' || severity === 'report';
}

/** Actions that do something besides changing the incident itself. */
export const SIDE_EFFECT_ACTIONS: ReadonlySet<IncidentAction> = new Set<IncidentAction>([
  'exclude_sensor',
  'include_sensor',
  'retry_trv',
  'ignore_window',
  'airing',
  'resume_schedule',
]);

/** Problems with a device or an entity (the Devices page and its badge). */
export const DEVICE_KINDS: ReadonlySet<EventKind> = new Set<EventKind>([
  'sensor_offline',
  'trv_not_confirmed',
  'battery_low',
  'signal_weak',
  'entity_unavailable',
  'entity_missing',
  'z2m_offline',
  'relay_mismatch',
  'actuator_conflict',
  'source_unavailable',
]);

export const KIND_ICON: Record<EventKind, IconName> = {
  source_failed: 'alert',
  source_unavailable: 'offline',
  frost_risk: 'shield',
  z2m_offline: 'zigbee',
  room_no_data: 'alert',
  ha_disconnected: 'offline',
  energy_critical: 'battery_storage',
  sensor_offline: 'offline',
  trv_not_confirmed: 'sync',
  battery_low: 'battery',
  window_open_long: 'windowOpen',
  humidity_high: 'droplet',
  condensation_risk: 'droplet',
  dew_point_guard: 'droplet',
  signal_weak: 'signal',
  entity_unavailable: 'offline',
  entity_missing: 'offline',
  overheat: 'thermometer',
  relay_mismatch: 'plug',
  actuator_conflict: 'swap',
  room_too_cold: 'thermometer',
  room_too_hot: 'thermometer',
  mqtt_offline: 'offline',
  channel_failed: 'bell',
  source_fallback: 'swap',
  source_recovered: 'checkCircle',
  trigger_fired: 'bolt',
  rule_activated: 'bolt',
  house_profile_changed: 'home',
  house_mode_changed: 'power',
  season_changed: 'sun',
  manual_override: 'hand',
  budget_shed: 'gauge',
  report_daily: 'list',
  report_weekly: 'list',
};

/** Alerts whose «hide» means «not now»: they snooze for 30 min instead of hiding until resolved. */
const SNOOZE_DISMISS: ReadonlySet<EventKind> = new Set<EventKind>(['window_open_long', 'humidity_high', 'condensation_risk']);

export function dismissFlavour(kind: EventKind, severity: Severity): IncidentDto['dismiss'] {
  if (severity === 'critical') return 'none';
  return SNOOZE_DISMISS.has(kind) ? 'snooze_30m' : 'hide';
}

const SYSTEM_LINK: ReadonlySet<EventKind> = new Set<EventKind>(['z2m_offline', 'ha_disconnected', 'mqtt_offline', 'season_changed', 'house_mode_changed']);
const STRATEGY_LINK: ReadonlySet<EventKind> = new Set<EventKind>(['trigger_fired', 'rule_activated', 'energy_critical', 'budget_shed']);

/** Where «Відкрити» leads for an incident. */
export function linkOf(i: { kind: EventKind; roomId: string | null; sourceId: string | null; deviceKey: string | null; entityId: string | null }): IncidentDto['link'] {
  if (i.kind === 'channel_failed') return { page: 'notifications', id: null };
  if (STRATEGY_LINK.has(i.kind)) return { page: 'strategy', id: null };
  if (DEVICE_KINDS.has(i.kind) && (i.deviceKey || i.entityId) && i.kind !== 'source_unavailable') {
    return { page: 'device', id: i.deviceKey ?? `entity:${i.entityId}` };
  }
  if (i.roomId) return { page: 'room', id: i.roomId };
  if (i.sourceId) return { page: 'source', id: i.sourceId };
  if (SYSTEM_LINK.has(i.kind)) return { page: 'system', id: null };
  if (i.deviceKey || i.entityId) return { page: 'device', id: i.deviceKey ?? `entity:${i.entityId}` };
  return { page: 'system', id: null };
}
