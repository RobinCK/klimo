/**
 * An incident as a line of the inbox: «Кухня · датчик не на зв’язку 1 год 40 хв» over the
 * evidence, with the buttons a notification carries. The words match the overview's attention
 * cards (same texts), so a problem reads the same wherever it shows up.
 */
import type { EpochMs, EventKind, IncidentAction, IncidentDto, ReasonParams } from '@api/model';
import { eventKindLabel, fmtDur, fmtPct, fmtSince, fmtTemp, fmtTime, incidentActionLabel, sourceFaultLabel, t, type CodeContext } from '@i18n';
import { paths } from '@app';

type Facts = ReasonParams;
interface Words {
  /** After «Кімната ·»: what is wrong, short. */
  short: string;
  /** The evidence and what happens meanwhile. */
  text: string;
}

const num = (f: Facts, k: string): number | null => (typeof f[k] === 'number' && Number.isFinite(f[k]) ? (f[k] as number) : null);
const str = (f: Facts, k: string): string | null => (f[k] == null || f[k] === '' ? null : String(f[k]));

function duration(i: IncidentDto, f: Facts, now: EpochMs): string {
  const minutes = num(f, 'minutes');
  return minutes != null ? fmtDur(minutes) : fmtSince(i.openedAt, now);
}

function device(i: IncidentDto, f: Facts, ctx: CodeContext): string {
  return str(f, 'name') ?? (i.deviceKey ? ctx.device?.(i.deviceKey) : undefined) ?? (i.entityId ? (ctx.entity?.(i.entityId) ?? i.entityId) : t('Device'));
}

function source(i: IncidentDto, f: Facts, ctx: CodeContext, key = 'sourceId'): string {
  const id = str(f, key) ?? i.sourceId;
  return id ? (ctx.source?.(id) ?? id) : t('Source');
}

type Render = (i: IncidentDto, f: Facts, ctx: CodeContext, now: EpochMs) => Words;

const RENDER: Record<EventKind, Render> = {
  source_failed: (i, f, ctx) => {
    const code = str(f, 'code');
    const what =
      code && ['no_confirm', 'unavailable', 'device_error', 'relay_mismatch', 'not_turned_off'].includes(code) ? sourceFaultLabel(code as 'no_confirm') : null;
    const fallback = str(f, 'fallbackId');
    return {
      short: t('{source}: fault', { source: source(i, f, ctx) }),
      text: [
        what ? `${what.charAt(0).toUpperCase()}${what.slice(1)}.` : '',
        fallback ? t('{source} took over — the rooms stay warm.', { source: source(i, f, ctx, 'fallbackId') }) : t('No reserve — the start is retried.'),
      ]
        .filter(Boolean)
        .join(' '),
    };
  },
  source_unavailable: (i, f, ctx, now) => ({
    short: t('{source} does not respond', { source: source(i, f, ctx) }),
    text: t('Unavailable in Home Assistant for {dur}.', { dur: duration(i, f, now) }),
  }),
  frost_risk: (_i, f) => ({
    short: t('frost risk'),
    text:
      num(f, 't') != null
        ? t('{t} — below the frost limit. Heating runs whatever the settings.', { t: fmtTemp(num(f, 't')) })
        : t('Check the boiler and the circulation.'),
  }),
  z2m_offline: (i, f, _ctx, now) => ({
    short: t('Zigbee2MQTT offline'),
    text: t('Offline for {dur}. Valves and sensors get no commands; everything is resent once it is back.', { dur: duration(i, f, now) }),
  }),
  room_no_data: (i, f, _ctx, now) => ({
    short: t('no temperature data'),
    text:
      num(f, 'safeC') != null
        ? t('No sensor reports for {dur}. The radiator valves hold a safe {t}.', { dur: duration(i, f, now), t: fmtTemp(num(f, 'safeC')) })
        : t('No sensor reports for {dur}. The radiator valves regulate on their own.', { dur: duration(i, f, now) }),
  }),
  ha_disconnected: (i, f, _ctx, now) => ({
    short: t('Home Assistant offline'),
    text: t('No connection for {dur}. Nothing is switched until it is back.', { dur: duration(i, f, now) }),
  }),
  energy_critical: (_i, f) => ({
    short: t('battery {pct}', { pct: fmtPct(num(f, 'soc')) }),
    text: t('No grid and the battery is low. Only frost protection works.'),
  }),
  sensor_offline: (i, f, ctx, now) => {
    const left = num(f, 'left');
    const name = device(i, f, ctx);
    return {
      short: t('sensor offline {dur}', { dur: duration(i, f, now) }),
      text:
        left == null
          ? t('{sensor} sends no data.', { sensor: name })
          : left > 0
            ? t('{sensor}. The temperature is counted from the {count} other sensors.', { sensor: name, count: left })
            : t('{sensor}. No other sensors — the radiator valves’ own readings are used.', { sensor: name }),
    };
  },
  trv_not_confirmed: (i, f, ctx) => {
    const attempt = i.progress?.attempt ?? num(f, 'attempt');
    const of = i.progress?.of ?? num(f, 'of');
    const value = num(f, 'valueC') ?? num(f, 'targetC');
    const lqi = num(f, 'lqi');
    const parts = [
      value != null
        ? t('{device} did not confirm {t}.', { device: device(i, f, ctx), t: fmtTemp(value) })
        : t('{device} did not confirm the target.', { device: device(i, f, ctx) }),
    ];
    if (attempt != null && of != null) parts.push(t('Retry {attempt} of {of}.', { attempt, of }));
    if (lqi != null) parts.push(t('Signal LQI {lqi}.', { lqi }));
    return { short: t('valve did not confirm the target'), text: parts.join(' ') };
  },
  battery_low: (i, f, ctx) => {
    const days = num(f, 'estDays');
    return {
      short: t('battery {pct}', { pct: fmtPct(num(f, 'pct')) }),
      text:
        days != null
          ? t('{device}. At this rate about {dur} left.', { device: device(i, f, ctx), dur: fmtDur(days * 1440) })
          : t('{device}. Replace the battery soon.', { device: device(i, f, ctx) }),
    };
  },
  window_open_long: (i, f, _ctx, now) => ({
    short: t('window open {dur}', { dur: num(f, 'since') != null ? fmtSince(num(f, 'since'), now) : duration(i, f, now) }),
    text: str(f, 'reaction') === 'notify' ? t('Only a reminder — heating works as usual.') : t('The room is paused; it resumes after the window is closed.'),
  }),
  humidity_high: (_i, f) => ({
    short: t('humidity {rh}', { rh: fmtPct(num(f, 'rh')) }),
    text:
      num(f, 'dewC') != null
        ? t('Dew point {dew} — condensation may form on cold glass. Air the room for 5–10 min.', { dew: fmtTemp(num(f, 'dewC')) })
        : t('Air the room for 5–10 min.'),
  }),
  condensation_risk: (_i, f) => ({
    short: t('condensation risk'),
    text: t('Humidity {rh} — the glass is close to the dew point. Air the room.', { rh: fmtPct(num(f, 'rh')) }),
  }),
  dew_point_guard: (_i, f) => ({
    short: t('dew point guard'),
    text: t('Dew point {dew} — the floor supply is kept warmer so it stays dry.', { dew: fmtTemp(num(f, 'dewC')) }),
  }),
  signal_weak: (i, f, ctx) => ({
    short: t('weak signal'),
    text: t('{device}: LQI {lqi}. A Zigbee router nearby would help.', { device: device(i, f, ctx), lqi: num(f, 'lqi') ?? '—' }),
  }),
  entity_unavailable: (i, f, ctx, now) => ({
    short: t('{device} unavailable', { device: device(i, f, ctx) }),
    text: t('{entity} unavailable for {dur}.', { entity: i.entityId ?? device(i, f, ctx), dur: duration(i, f, now) }),
  }),
  entity_missing: (i, f, ctx) => ({
    short: t('{device} is missing', { device: device(i, f, ctx) }),
    text: t('{entity} is gone from Home Assistant. Pick a replacement on the devices page.', { entity: i.entityId ?? device(i, f, ctx) }),
  }),
  overheat: (_i, f) => ({
    short: t('overheating {t}', { t: fmtTemp(num(f, 't')) }),
    text: t('Heating in the room is closed, even with a manual target.'),
  }),
  relay_mismatch: (i, f, ctx) => ({
    short: t('{device}: relay does not follow', { device: device(i, f, ctx) }),
    text: t('The relay did not follow the command. Check its power and connection.'),
  }),
  actuator_conflict: (i, f, ctx) => ({
    short: t('{device}: changed by something else', { device: device(i, f, ctx) }),
    text: t('Another automation or a person keeps changing it. Control backed off for a while.'),
  }),
  room_too_cold: (i, f, _ctx, now) => ({
    short: t('too cold'),
    text: t('{t} with a target of {T} for {dur}. Check the source, the windows and the valves.', {
      t: fmtTemp(num(f, 't')),
      T: fmtTemp(num(f, 'T')),
      dur: duration(i, f, now),
    }),
  }),
  room_too_hot: (i, f, _ctx, now) => ({
    short: t('too hot'),
    text: t('{t} with a target of {T} for {dur}. Check the sun, the windows and the cooling.', {
      t: fmtTemp(num(f, 't')),
      T: fmtTemp(num(f, 'T')),
      dur: duration(i, f, now),
    }),
  }),
  mqtt_offline: (i, f, _ctx, now) => ({
    short: t('MQTT offline'),
    text: t('The broker is unreachable for {dur}. Control works; Home Assistant entities and cards do not update.', { dur: duration(i, f, now) }),
  }),
  channel_failed: () => ({
    short: t('notification channel failed'),
    text: t('Messages are not delivered. Check the channel settings.'),
  }),
  source_fallback: (i, f, ctx) => ({
    short: t('switched to {source}', { source: source(i, f, ctx, 'to') }),
    text: t('{source} works instead.', { source: source(i, f, ctx, 'to') }),
  }),
  source_recovered: (i, f, ctx) => ({ short: t('{source} works again', { source: source(i, f, ctx) }), text: t('The fault is cleared.') }),
  trigger_fired: (i) => ({ short: eventKindLabel(i.kind), text: '' }),
  rule_activated: (i) => ({ short: eventKindLabel(i.kind), text: '' }),
  house_profile_changed: (i) => ({ short: eventKindLabel(i.kind), text: '' }),
  house_mode_changed: (i) => ({ short: eventKindLabel(i.kind), text: '' }),
  season_changed: (i) => ({ short: eventKindLabel(i.kind), text: '' }),
  manual_override: (i) => ({ short: eventKindLabel(i.kind), text: '' }),
  budget_shed: (i, f, ctx) => ({ short: t('{source}: shed by the budget', { source: source(i, f, ctx) }), text: t('It waits until power frees up.') }),
  report_daily: (i) => ({ short: eventKindLabel(i.kind), text: '' }),
  report_weekly: (i) => ({ short: eventKindLabel(i.kind), text: '' }),
};

// an entity id («climate.heat_pump») stays as Home Assistant spells it
const capital = (s: string) => (/^[a-z_]+\.[a-z0-9_]+/.test(s) ? s : `${s.charAt(0).toUpperCase()}${s.slice(1)}`);

/** Title and text of an incident, with the room in front when it belongs to one. */
export function incidentWords(i: IncidentDto, ctx: CodeContext, now: EpochMs): { title: string; text: string } {
  const w = RENDER[i.kind](i, i.facts ?? {}, ctx, now);
  const room = i.roomId ? (ctx.room?.(i.roomId) ?? null) : null;
  // a text may open with a device's own label («рушникосушка: …»)
  return { title: room ? `${room} · ${w.short}` : capital(w.short), text: capital(w.text) };
}

/** Where «Відкрити» leads for an incident. */
export function incidentLink(i: IncidentDto): string {
  const { page, id } = i.link;
  switch (page) {
    case 'room':
      return id ? paths.room(id) : paths.overview();
    case 'device':
      return id ? paths.device(id) : i.deviceKey ? paths.device(i.deviceKey) : paths.devices();
    case 'source':
      return id ? paths.source(id) : paths.sources();
    case 'strategy':
      return paths.strategy();
    case 'notifications':
      return paths.notifications();
    case 'system':
      return paths.system();
  }
}

const DAY_MIN = 24 * 60;

/** Long-lived problems (a battery, a weak link) are put off for a day; everything else for 30 minutes. */
export function snoozeMinutes(kind: EventKind): number {
  return kind === 'battery_low' || kind === 'signal_weak' || kind === 'entity_missing' ? DAY_MIN : 30;
}

/** A button of an inbox card: its label, the request it sends and what the card says afterwards. */
export interface InboxButton {
  action: IncidentAction;
  label: string;
  minutes?: number;
  /** «Сховано до 07:00», «Виключено з розрахунку». */
  result: (morning: string) => string;
}

/**
 * The buttons of an incident, as on the phone notification. A critical incident can only be
 * acknowledged; «open» is a link and is handled by the caller.
 */
export function inboxButtons(i: IncidentDto): InboxButton[] {
  if (i.severity === 'critical') {
    return i.status === 'acknowledged' ? [] : [{ action: 'ack', label: incidentActionLabel('ack'), result: () => t('Seen — repeats stopped') }];
  }
  const out: InboxButton[] = [];
  for (const a of i.actions) {
    switch (a) {
      case 'ack':
        if (i.status !== 'acknowledged') out.push({ action: a, label: incidentActionLabel(a), result: () => t('Seen — repeats stopped') });
        break;
      case 'snooze': {
        const minutes = snoozeMinutes(i.kind);
        out.push({
          action: a,
          label: minutes >= DAY_MIN ? t('Remind me tomorrow') : t('Snooze for 30 min'),
          minutes,
          result: () => (minutes >= DAY_MIN ? t('I will remind you tomorrow') : t('Hidden for 30 min')),
        });
        break;
      }
      case 'snooze_until_morning':
        out.push({ action: a, label: t('Ignore until morning'), result: (morning) => t('Hidden until {time}', { time: morning }) });
        break;
      case 'dismiss':
        out.push({ action: a, label: incidentActionLabel(a), result: () => t('Hidden until it happens again') });
        break;
      case 'exclude_sensor':
        out.push({ action: a, label: t('Exclude from the calculation'), result: () => t('Excluded from the calculation') });
        break;
      case 'include_sensor':
        out.push({ action: a, label: t('Count it again'), result: () => t('Counted again') });
        break;
      case 'retry_trv':
        out.push({ action: a, label: incidentActionLabel(a), result: () => t('Sent once more') });
        break;
      case 'ignore_window':
        out.push({ action: a, label: incidentActionLabel(a), result: () => t('The window is ignored for 30 min') });
        break;
      case 'airing':
        out.push({ action: a, label: incidentActionLabel(a), result: () => t('Airing for 10 min — heating waits') });
        break;
      case 'resume_schedule':
        out.push({ action: a, label: incidentActionLabel(a), result: () => t('Back to the schedule') });
        break;
      case 'unsnooze':
      case 'open':
        break;
    }
  }
  return out;
}

/** «07:00» — when quiet hours end, for «Сховано до 07:00». */
export function morningText(quietTo: string | null | undefined, now: EpochMs): string {
  if (quietTo && /^\d{1,2}:\d{2}$/.test(quietTo)) return quietTo.padStart(5, '0');
  return fmtTime(now);
}
