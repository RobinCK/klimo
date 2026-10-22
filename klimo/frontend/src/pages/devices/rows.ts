/**
 * How a device reads on the Devices page: its row in the table, its problem cards and the words
 * for kinds, places and transports. The backend sends codes and numbers; everything a person
 * reads is built here.
 */
import type { DeviceHealth, DeviceHealthSettings, DeviceKind, DeviceProblem, DeviceProblemType, EpochMs, IconName, Tone } from '@api/model';
import { fmtAgo, fmtDateTime, fmtDur, fmtSince, fmtTemp, integrationName, renderReason, t, type CodeContext } from '@i18n';

/** Kinds in the order the table and the filter list them. */
export const KIND_ORDER: readonly DeviceKind[] = ['trv', 'sensor', 'window', 'relay', 'pump', 'source', 'entity'];

const PROBLEM_ORDER: readonly DeviceProblemType[] = [
  'z2m_offline',
  'offline',
  'entity_missing',
  'trv_failed',
  'trv_unconfirmed',
  'relay_mismatch',
  'actuator_conflict',
  'manual_knob',
  'battery_low',
  'weak_signal',
];

export const PROBLEM_ICON: Readonly<Record<DeviceProblemType, IconName>> = {
  trv_unconfirmed: 'sync',
  trv_failed: 'sync',
  offline: 'offline',
  battery_low: 'battery',
  weak_signal: 'signal',
  relay_mismatch: 'plug',
  entity_missing: 'anyEntity',
  z2m_offline: 'zigbee',
  manual_knob: 'hand',
  actuator_conflict: 'swap',
};

export function kindIcon(d: DeviceHealth): IconName {
  switch (d.kind) {
    case 'trv':
      return 'radiator';
    case 'sensor':
      return d.location === 'outdoor' ? 'sun' : 'thermometer';
    case 'window':
      return d.state.code === 'dev.contact_open' ? 'windowOpen' : 'windowClosed';
    case 'relay':
      return 'plug';
    case 'pump':
      return 'pumps';
    case 'source':
      // a source inside a room is an air conditioner or a heater; the plant room holds the big ones
      return d.roomId ? 'ac' : 'heatPump';
    case 'entity':
      return 'anyEntity';
  }
}

/** Filter pill labels (plural, as a category). */
export function kindPlural(kind: DeviceKind): string {
  switch (kind) {
    case 'trv':
      return t('Radiator valves');
    case 'sensor':
      return t('Sensors');
    case 'window':
      return t('Windows');
    case 'relay':
      return t('Relays');
    case 'pump':
      return t('Pumps');
    case 'source':
      return t('Sources');
    case 'entity':
      return t('Other entities');
  }
}

/** «6 головок», «13 датчиків» … for the summary tile. */
export function kindCount(kind: DeviceKind, count: number): string {
  switch (kind) {
    case 'trv':
      return t('{count} radiator valves', { count });
    case 'sensor':
      return t('{count} sensors', { count });
    case 'window':
      return t('{count} windows', { count });
    case 'relay':
      return t('{count} relays', { count });
    case 'pump':
      return t('{count} pumps', { count });
    case 'source':
      return t('{count} sources', { count });
    case 'entity':
      return t('{count} other entities', { count });
  }
}

export function problemTypeShort(type: DeviceProblemType): string {
  switch (type) {
    case 'offline':
    case 'z2m_offline':
      return t('connection');
    case 'trv_unconfirmed':
    case 'trv_failed':
    case 'relay_mismatch':
      return t('confirmation');
    case 'battery_low':
      return t('battery');
    case 'weak_signal':
      return t('signal');
    case 'entity_missing':
      return t('missing entity');
    case 'manual_knob':
      return t('changed by hand');
    case 'actuator_conflict':
      return t('changed elsewhere');
  }
}

export interface Names extends CodeContext {
  room?: (id: string) => string | undefined;
  instance?: (id: string) => string | undefined;
}

export function placeOf(d: DeviceHealth, ctx: Names): string {
  if (d.roomId) return ctx.room?.(d.roomId) ?? d.roomId;
  switch (d.location) {
    case 'plant_room':
      return t('Boiler room');
    case 'outdoor':
      return t('Outdoors');
    default:
      return '—';
  }
}

export function viaOf(d: DeviceHealth, ctx: Names): string {
  switch (d.transport.type) {
    case 'z2m':
      return ctx.instance?.(d.transport.instanceId) ?? d.transport.instanceId;
    case 'zha':
      return 'ZHA';
    case 'ha':
      return d.transport.integration ? integrationName(d.transport.integration) : t('HA');
  }
}

/** «Ванна · рушникосушка»: where it is and what it does there. */
export function deviceTitle(d: DeviceHealth, ctx: Names): string {
  const name = d.label ?? d.name;
  const place = d.roomId ? ctx.room?.(d.roomId) : null;
  return place ? `${place} · ${name}` : name;
}

export const capitalize = (s: string): string => (s ? s.charAt(0).toLocaleUpperCase() + s.slice(1) : s);

export const isOffline = (d: DeviceHealth): boolean => !d.available || d.problems.some((p) => p.type === 'offline' || p.type === 'z2m_offline');

export function worstSeverity(d: DeviceHealth): 0 | 1 | 2 {
  if (d.problems.some((p) => p.severity === 'err')) return 2;
  return d.problems.length ? 1 : 0;
}

/** The operational state in the row's chip; an offline device says so whatever it last reported. */
export function stateChip(d: DeviceHealth, ctx: Names, now: EpochMs): { tone: Tone; label: string } {
  if (d.ignored) return { tone: 'off', label: t('Not watched') };
  if (isOffline(d)) {
    // the first minute of an outage has no length worth showing («Немає зв’язку 0 хв»)
    return { tone: 'err', label: d.lastSeenAt && now - d.lastSeenAt >= 60_000 ? t('Offline for {dur}', { dur: fmtSince(d.lastSeenAt, now) }) : t('Offline') };
  }
  const trv = d.problems.find((p) => p.type === 'trv_unconfirmed' || p.type === 'trv_failed');
  if (trv) {
    const attempt = num(trv.facts.attempt);
    const of = num(trv.facts.of);
    return {
      tone: trv.severity === 'err' ? 'err' : 'warn',
      label: attempt != null && of != null ? t('not confirmed · {attempt}/{of}', { attempt, of }) : t('not confirmed'),
    };
  }
  // binary entities report «on»/«off»; say it in words
  const value = d.state.code === 'dev.reading' ? d.state.params?.value : undefined;
  if (value === 'on' || value === 'off') return { tone: d.stateTone, label: value === 'on' ? t('on') : t('off') };
  return { tone: d.stateTone, label: renderReason(d.state, { ...ctx, now }) };
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function signalBars(lqi: number | null): 0 | 1 | 2 | 3 | 4 {
  if (lqi == null) return 0;
  return lqi >= 100 ? 4 : lqi >= 75 ? 3 : lqi >= 55 ? 2 : 1;
}

export interface BatteryView {
  pct: number | null;
  mains: boolean;
  low: boolean;
  stale: boolean;
  label: string;
}

export function batteryView(d: DeviceHealth, health: DeviceHealthSettings | undefined): BatteryView {
  if (d.power.source === 'mains') return { pct: null, mains: true, low: false, stale: false, label: t('mains') };
  if (d.batteryPct == null) return { pct: null, mains: false, low: false, stale: false, label: '—' };
  const threshold = health?.batteryLow.pct ?? 20;
  return { pct: d.batteryPct, mains: false, low: d.batteryPct < threshold, stale: d.batteryStale || isOffline(d), label: `${Math.round(d.batteryPct)}%` };
}

export interface SignalView {
  bars: 0 | 1 | 2 | 3 | 4 | null;
  weak: boolean;
  label: string;
  /** Why there is no number (tooltip). */
  hint?: string;
}

export function signalView(d: DeviceHealth, health: DeviceHealthSettings | undefined): SignalView {
  if (d.transport.type === 'ha') return { bars: null, weak: false, label: d.transport.network ?? d.transport.integration ?? '—' };
  // unknown is not weak: a quiet dash that says where the number would come from
  if (isOffline(d)) return { bars: 0, weak: false, label: '—', hint: t('No connection, so no link quality right now.') };
  if (d.lqi == null) {
    const hint =
      d.transport.type === 'z2m'
        ? t('Link quality unknown: its entity is disabled in Home Assistant and Zigbee2MQTT has not reported it over MQTT.')
        : t('Link quality unknown: its entity is disabled in Home Assistant.');
    return { bars: 0, weak: false, label: '—', hint };
  }
  const lqi = Math.round(d.lqi);
  return { bars: signalBars(lqi), weak: lqi < (health?.weakSignal.lqiBelow ?? 60), label: t('LQI {lqi}', { lqi }) };
}

export function seenView(d: DeviceHealth, now: EpochMs): { text: string; title: string; tone?: Tone } {
  const offline = isOffline(d);
  return {
    // an outage is measured exactly («1 год 40 хв тому»); a live device only needs «4 хв тому»
    text: !d.lastSeenAt ? t('never') : offline && now - d.lastSeenAt >= 60_000 ? t('{dur} ago', { dur: fmtSince(d.lastSeenAt, now) }) : fmtAgo(d.lastSeenAt, now),
    title: d.lastSeenAt ? fmtDateTime(d.lastSeenAt) : t('No reports yet'),
    tone: offline ? 'err' : undefined,
  };
}

/** Problems first (errors before warnings), then by kind, room order and name. */
export function sortDevices(list: readonly DeviceHealth[], roomOrder: (id: string | null) => number): DeviceHealth[] {
  return [...list].sort(
    (a, b) =>
      worstSeverity(b) - worstSeverity(a) ||
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      roomOrder(a.roomId) - roomOrder(b.roomId) ||
      (a.label ?? a.name).localeCompare(b.label ?? b.name),
  );
}

export function sortProblems(list: readonly DeviceProblem[]): DeviceProblem[] {
  return [...list].sort(
    (a, b) => (a.severity === b.severity ? 0 : a.severity === 'err' ? -1 : 1) || PROBLEM_ORDER.indexOf(a.type) - PROBLEM_ORDER.indexOf(b.type),
  );
}

/** The chip of a problem card: what exactly is wrong, with the numbers. */
export function problemChip(p: DeviceProblem, d: DeviceHealth, now: EpochMs): string {
  const f = p.facts;
  switch (p.type) {
    case 'trv_unconfirmed': {
      const target = num(f.targetC);
      const attempt = num(f.attempt);
      const of = num(f.of);
      const head = target != null ? t('Did not confirm {t}', { t: fmtTemp(target) }) : t('Did not confirm the target');
      return attempt != null && of != null ? `${head} · ${t('retry {attempt} of {of}', { attempt, of })}` : head;
    }
    case 'trv_failed': {
      const target = num(f.targetC);
      return target != null ? t('Did not confirm {t}', { t: fmtTemp(target) }) : t('Did not confirm the target');
    }
    case 'offline': {
      const minutes = num(f.minutes);
      return t('No connection for {dur}', { dur: minutes != null ? fmtDur(minutes) : fmtSince(d.lastSeenAt ?? p.since, now) });
    }
    case 'battery_low': {
      const pct = num(f.pct) ?? d.batteryPct;
      const days = num(f.estDays) ?? d.batteryEstDays;
      const head = t('Battery {pct}', { pct: pct != null ? `${Math.round(pct)}%` : '—' });
      return days != null ? `${head} · ${batteryLife(days)}` : head;
    }
    case 'weak_signal': {
      const lqi = num(f.lqi) ?? d.lqi;
      return lqi != null ? t('Weak signal · LQI {lqi}', { lqi: Math.round(lqi) }) : t('Weak signal');
    }
    case 'relay_mismatch':
      return t('The relay does not follow the command');
    case 'entity_missing':
      return t('Gone from Home Assistant');
    case 'z2m_offline':
      return t('Zigbee2MQTT is offline');
    case 'manual_knob': {
      const target = num(f.targetC) ?? num(f.setpointC);
      return target != null ? t('Turned by hand to {t}', { t: fmtTemp(target) }) : t('Turned by hand');
    }
    case 'actuator_conflict':
      return t('Something else keeps changing it');
  }
}

/** «приблизно 2 тижні» from a remaining-life estimate in days. */
export function batteryLife(days: number): string {
  const d = Math.max(0, Math.round(days));
  if (d < 14) return t('about {count} days', { count: Math.max(1, d) });
  return t('about {count} weeks', { count: Math.round(d / 7) });
}
