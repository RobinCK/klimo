/**
 * Words of the notifications page that the shared label tables do not have: what each alert is
 * about (the grey line under it in the matrix), target scopes, watch roles and conditions, and
 * the names of the per-alert thresholds.
 */
import type { EventKind, NotificationsDto, Severity, Tone, WatchCondition } from '@api/model';
import { fmtDur, t } from '@i18n';

export type Target = NotificationsDto['targets'][number];

/** The grey line under an alert in the routing matrix: when it fires, in a few words. */
export function kindSub(kind: EventKind): string | undefined {
  switch (kind) {
    case 'source_failed':
      return t('did not start, reports a fault or does not switch off');
    case 'source_unavailable':
      return t('longer than its threshold — see «Watched entities»');
    case 'frost_risk':
      return t('a room below the frost limit or the supply below 10°');
    case 'z2m_offline':
      return t('radiator valves and sensors get no commands');
    case 'room_no_data':
      return t('no temperature from any sensor of a room');
    case 'ha_disconnected':
      return t('only through the own Telegram bot');
    case 'energy_critical':
      return t('blackout and the home battery almost empty');
    case 'sensor_offline':
      return t('counted from the remaining sensors meanwhile');
    case 'trv_not_confirmed':
      return t('after every retry');
    case 'battery_low':
      return t('sensors, radiator valves, buttons');
    case 'window_open_long':
      return t('while the room is heated or cooled');
    case 'humidity_high':
      return t('above 65% for a while');
    case 'condensation_risk':
      return t('the glass is close to the dew point');
    case 'dew_point_guard':
      return t('floor cooling held back');
    case 'signal_weak':
      return t('Zigbee link quality steadily low');
    case 'entity_unavailable':
      return t('triggers, energy, pumps and valves');
    case 'entity_missing':
      return t('renamed or removed in Home Assistant');
    case 'overheat':
      return t('the valves are closed anyway');
    case 'relay_mismatch':
      return t('the relay state differs from the command');
    case 'actuator_conflict':
      return t('an automation or a person keeps changing it');
    case 'room_too_cold':
      return t('well below the target for an hour');
    case 'room_too_hot':
      return t('well above the target for an hour');
    case 'mqtt_offline':
      return t('the dashboard cards stop updating');
    case 'channel_failed':
      return t('a channel failed several times in a row');
    case 'source_fallback':
      return t('for example heat pump → gas boiler');
    case 'source_recovered':
      return t('goes to whoever got the failure');
    case 'trigger_fired':
      return t('blackout, «Sun during a blackout», night tariff');
    case 'rule_activated':
      return t('a rule of a trigger took effect');
    case 'house_profile_changed':
      return t('by hand, by presence or by the calendar');
    case 'house_mode_changed':
      return t('auto, heating only, cooling only, off');
    case 'season_changed':
      return t('heating ↔ cooling');
    case 'manual_override':
      return t('who, in which room and until when');
    case 'budget_shed':
      return t('the blackout power budget held a source back');
    case 'report_daily':
      return t('cycles, running hours, energy, problems');
    case 'report_weekly':
      return t('compared with the previous week');
  }
}

export function severityGroup(s: Severity): { title: string; sub?: string; tone: Tone } {
  switch (s) {
    case 'critical':
      return { title: t('Critical'), sub: t('· always arrive, even at night'), tone: 'err' };
    case 'warning':
      return { title: t('Warnings'), sub: t('· wait for the end of quiet hours'), tone: 'warn' };
    case 'event':
      return { title: t('Events'), sub: t('· for information'), tone: 'event' };
    case 'report':
      return { title: t('Reports'), tone: 'off' };
  }
}

export function scopeLabel(scope: Target['scope']): string {
  switch (scope) {
    case 'by_matrix':
      return t('by the table');
    case 'critical_only':
      return t('critical only');
    case 'critical_and_escalation':
      return t('critical and escalations');
  }
}

/** Matrix column header: short and recognisable. */
export function columnLabel(target: Target): string {
  return target.shortName ?? target.name;
}

export function watchRoleLabel(role: string): string {
  switch (role) {
    case 'source.primary':
      return t('source · main');
    case 'source.reserve_relay':
      return t('source · relay');
    case 'source.confirm':
      return t('confirms the source runs');
    case 'z2m.bridge':
      return t('bridge to the radiator valves');
    case 'outdoor':
      return t('outdoor temperature');
    case 'room.sensor':
      return t('room temperature');
    case 'room.trv':
      return t('radiator valve');
    case 'room.contact':
      return t('window or door');
    case 'trigger':
      return t('trigger');
    case 'energy':
      return t('blackout energy');
    case 'pump':
      return t('pump or valve');
    case 'manual':
      return t('added by hand');
    default:
      return role;
  }
}

export function conditionText(c: WatchCondition): string {
  switch (c.type) {
    case 'unavailable':
      return t('unavailable for longer than {dur}', { dur: fmtDur(c.forMin) });
    case 'stale':
      return t('no updates for {dur}', { dur: fmtDur(c.noUpdateMin) });
    case 'offline':
      return t('offline for longer than {dur}', { dur: fmtDur(c.forMin) });
    case 'not_confirmed':
      return t('did not confirm {count} times', { count: c.attempts });
    case 'no_confirmation_after_demand':
      return t('no confirmation {dur} after a request', { dur: fmtDur(c.forMin) });
    case 'custom':
      return t('own condition');
  }
}

/** The number a watch condition is tuned by, and its range (minutes or attempts). */
export function conditionAmount(c: WatchCondition): { value: number; min: number; max: number; step: number; unit: 'min' | 'times' } | null {
  switch (c.type) {
    case 'unavailable':
    case 'offline':
      return { value: c.forMin, min: 0, max: 1440, step: 1, unit: 'min' };
    case 'stale':
      return { value: c.noUpdateMin, min: 1, max: 1440, step: 5, unit: 'min' };
    case 'not_confirmed':
      return { value: c.attempts, min: 1, max: 20, step: 1, unit: 'times' };
    case 'no_confirmation_after_demand':
      return { value: c.forMin, min: 1, max: 120, step: 1, unit: 'min' };
    case 'custom':
      return null;
  }
}

export function withAmount(c: WatchCondition, n: number): WatchCondition {
  switch (c.type) {
    case 'unavailable':
    case 'offline':
      return { ...c, forMin: n };
    case 'stale':
      return { ...c, noUpdateMin: n };
    case 'not_confirmed':
      return { ...c, attempts: n };
    case 'no_confirmation_after_demand':
      return { ...c, forMin: n };
    case 'custom':
      return c;
  }
}

/** A threshold of an alert kind: what it means, how it is shown, its range. */
export interface ParamSpec {
  label: string;
  min: number;
  max: number;
  step: number;
  unit?: string;
}

export function paramSpec(key: string): ParamSpec | null {
  switch (key) {
    case 'openAfterSec':
      return { label: t('Wait before raising it'), min: 0, max: 3600, step: 30, unit: t('s') };
    case 'resolveAfterSec':
      return { label: t('Calm for this long to clear'), min: 0, max: 3600, step: 30, unit: t('s') };
    case 'forMin':
      return { label: t('For longer than'), min: 1, max: 1440, step: 1, unit: t('min') };
    case 'pumpForMin':
      return { label: t('Pumps and valves: for longer than'), min: 1, max: 1440, step: 1, unit: t('min') };
    case 'criticalBelowOutdoorC':
      return { label: t('Critical when it is colder outside than'), min: -20, max: 25, step: 1, unit: '°' };
    case 'resolveSocPct':
      return { label: t('Clears when the battery is above'), min: 0, max: 100, step: 1, unit: '%' };
    case 'resolvePct':
      return { label: t('Clears below'), min: 0, max: 100, step: 1, unit: '%' };
    case 'moldHours':
      return { label: t('Damp hours a day before warning'), min: 1, max: 24, step: 1, unit: t('h') };
    case 'cooldownH':
      return { label: t('Not more often than every'), min: 1, max: 72, step: 1, unit: t('h') };
    case 'resolveMarginC':
      return { label: t('Clears with a margin of'), min: 0, max: 10, step: 0.5, unit: '°' };
    case 'attempts':
      return { label: t('After attempts'), min: 1, max: 20, step: 1 };
    case 'resolveMin':
      return { label: t('Clears after a calm of'), min: 1, max: 1440, step: 1, unit: t('min') };
    case 'deltaC':
      return { label: t('Off the target by'), min: 0.5, max: 10, step: 0.5, unit: '°' };
    case 'resolveC':
      return { label: t('Clears within'), min: 0.1, max: 5, step: 0.1, unit: '°' };
    case 'failures':
      return { label: t('Failures in a row'), min: 1, max: 20, step: 1 };
    default:
      return null;
  }
}

export function severityChip(s: 'critical' | 'warning'): { tone: Tone; label: string } {
  return s === 'critical' ? { tone: 'err', label: t('critical') } : { tone: 'warn', label: t('warning') };
}
