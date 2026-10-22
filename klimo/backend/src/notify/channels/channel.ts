import type { ChannelKind, EventKind, Id, IncidentAction, Lang, NotifyTarget, SentKind, Severity } from '../../shared/model';

/** One message, rendered and frozen, on its way to one target. */
export interface OutboundMessage {
  sentKind: SentKind;
  incidentId: Id | null;
  eventKind: EventKind | null;
  severity: Severity | null;
  title: string;
  body: string;
  /** Buttons under the message; «open» is added by each channel in its own way. */
  actions: { action: IncidentAction; label: string }[];
  openLabel: string;
  /** Critical with «крізь Не турбувати»: alarm sound on iOS and Android. */
  critical: boolean;
  /** Recovery messages and digests: no sound. */
  silent: boolean;
  /** Phone notifications with the same tag replace each other (repeats, the recovery). */
  tag: string | null;
  lang: Lang;
}

/** A channel adapter: sends to one target or throws with a readable reason. */
export interface ChannelAdapter {
  readonly kind: ChannelKind;
  deliver(target: NotifyTarget, msg: OutboundMessage): Promise<void>;
  /** Takes back what is still showing for an incident that is over (no recovery message wanted). */
  withdraw?(target: NotifyTarget, incidentId: Id): Promise<void>;
}

/** `notify.mobile_app_phone` → ['notify', 'mobile_app_phone']. */
export function splitService(service: string | null): [string, string] {
  const s = (service ?? '').trim();
  const dot = s.indexOf('.');
  if (dot <= 0 || dot === s.length - 1) throw new Error(`invalid notify service "${s}"`);
  return [s.slice(0, dot), s.slice(dot + 1)];
}

/** Button action ids on phones: `KLIMO_<ACTION>_<incidentId>`. */
export function mobileActionId(action: IncidentAction, incidentId: Id): string {
  return `KLIMO_${action.toUpperCase()}_${incidentId}`;
}

const ACTIONS: readonly IncidentAction[] = [
  'ack', 'snooze', 'snooze_until_morning', 'unsnooze', 'dismiss', 'exclude_sensor', 'include_sensor', 'retry_trv',
  'ignore_window', 'airing', 'resume_schedule', 'open',
];

export function isIncidentAction(v: unknown): v is IncidentAction {
  return typeof v === 'string' && (ACTIONS as readonly string[]).includes(v);
}

/** Parses `KLIMO_<ACTION>_<id>`; null for anything that is not ours. */
export function parseMobileAction(raw: unknown): { action: IncidentAction; incidentId: Id } | null {
  if (typeof raw !== 'string' || !raw.startsWith('KLIMO_')) return null;
  const rest = raw.slice(6);
  // incident ids are uuids (no underscores), so the id is everything after the last one
  const cut = rest.lastIndexOf('_');
  if (cut <= 0) return null;
  const action = rest.slice(0, cut).toLowerCase();
  const incidentId = rest.slice(cut + 1);
  if (!isIncidentAction(action) || !/^[0-9a-f-]{8,64}$/i.test(incidentId)) return null;
  return { action, incidentId };
}

/** Telegram callback data of the HA integration: `/klimo <action> <id>`. */
export function parseIntegrationCallback(raw: unknown): { action: IncidentAction; incidentId: Id } | null {
  if (typeof raw !== 'string') return null;
  const m = /^\/klimo\s+([a-z_]+)\s+([0-9a-f-]{8,64})\s*$/i.exec(raw.trim());
  if (!m) return null;
  const action = m[1].toLowerCase();
  return isIncidentAction(action) ? { action, incidentId: m[2] } : null;
}

/** Callback data of Klimo's own bot: `k|<id>|<action>` (Telegram allows 64 bytes). */
export function ownCallbackData(incidentId: Id, action: IncidentAction): string {
  return `k|${incidentId}|${action}`;
}

export function parseOwnCallback(raw: unknown): { action: IncidentAction; incidentId: Id } | null {
  if (typeof raw !== 'string') return null;
  const parts = raw.split('|');
  if (parts.length !== 3 || parts[0] !== 'k') return null;
  const [, incidentId, action] = parts;
  if (!isIncidentAction(action) || !/^[0-9a-f-]{8,64}$/i.test(incidentId)) return null;
  return { action, incidentId };
}
