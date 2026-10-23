import { BRAND } from '../common/brand';
import type {
  CardTextKey,
  EpochMs,
  EventKind,
  Incident,
  IncidentAction,
  IssueCode,
  JournalCode,
  JournalEntry,
  Lang,
  Reason,
  ReasonCode,
  ReasonParams,
  RoomIssue,
} from '../shared/model';
import { EVENT_KINDS, EVENT_SEVERITY } from '../shared/model';
import { CARDS } from './texts/cards';
import { ACTION_RESULT, EVENTS, REPORT_TEXTS, SYSTEM_TEXTS } from './texts/events';
import type { EventTexts } from './texts/events';
import {
  clip,
  fmtClock,
  fmtDuration,
  minutesSince,
  MINUTE_MS,
  NO_NAMES,
  render,
  renderRow,
} from './texts/format';
import type { NameResolver, Row, TextContext, Vars } from './texts/format';
import { ISSUES } from './texts/issues';
import { JOURNAL } from './texts/journal';
import { ACTION_LABEL, EVENT_LABEL, enumLabel, labelOf } from './texts/labels';
import { REASONS } from './texts/reasons';

/**
 * The backend's only place that turns codes into words: notifications, Lovelace card texts, reports
 * and journal exports. Every table is [en, uk] and exhaustive over its code union, so a code added to
 * the model without wording here fails to compile. Pure: time, time zone and names come in the context.
 */

export { fmtClock, fmtDate, fmtDelta, fmtDuration, fmtNumber, fmtPct, fmtSeconds, fmtTemp, plural, render, escapeHtml, clip } from './texts/format';
export type { NameResolver, Row, TextContext, Tpl, Vars } from './texts/format';
export { ACTION_LABEL, EVENT_LABEL } from './texts/labels';

export type SystemTextKey = keyof typeof SYSTEM_TEXTS;
export type ReportTextKey = keyof typeof REPORT_TEXTS;

export function textContext(lang: Lang, now: EpochMs, tz: string, names: NameResolver = NO_NAMES): TextContext {
  return { lang, now, tz, names, label: enumLabel };
}

const withBrand = (vars: Vars): Vars => ({ brand: BRAND.productName, ...vars });

/* ── codes the SPA also renders ─────────────────────────────────────────────────────────────── */

export function renderReason(r: Reason, ctx: TextContext): string {
  const row = REASONS[r.code];
  return row ? renderRow(row, r.params ?? {}, ctx) : r.code;
}

export function renderIssue(i: Pick<RoomIssue, 'code' | 'params'>, ctx: TextContext): string {
  const row = ISSUES[i.code];
  return row ? renderRow(row, i.params ?? {}, ctx) : i.code;
}

/** A journal line; the entry's subject is available to the template as {room} {source} {device} {pump}. */
export function renderJournal(e: JournalEntry, ctx: TextContext): string {
  const row = JOURNAL[e.code];
  if (!row) return e.code;
  const p = e.params ?? {};
  const first = e.entityIds[0] ?? null;
  const entityName = first ? (ctx.names.entity(first) ?? first) : null;
  const pumpId = typeof p.pumpId === 'string' ? p.pumpId : null;
  const vars: Vars = {
    ...p,
    room: e.roomId ? (ctx.names.room(e.roomId) ?? e.roomId) : null,
    source: e.sourceId ? (ctx.names.source(e.sourceId) ?? e.sourceId) : null,
    device: (e.deviceKey ? ctx.names.device(e.deviceKey) : null) ?? entityName ?? e.deviceKey,
    pump: (pumpId ? ctx.names.pump(pumpId) : null) ?? entityName ?? labelOf(['Pump', 'Насос'], ctx.lang),
  };
  return renderRow(row, vars, ctx);
}

/** Lovelace card text; may contain the card's own `{t}` / `{d}` placeholders. */
export function renderCard(key: CardTextKey, vars: ReasonParams, ctx: TextContext): string {
  const row = CARDS[key];
  return row ? renderRow(row, vars, ctx) : key;
}

/* ── incidents ──────────────────────────────────────────────────────────────────────────────── */

export type IncidentLike = Pick<Incident, 'kind' | 'roomId' | 'sourceId' | 'entityId' | 'deviceKey' | 'facts' | 'progress' | 'openedAt'>;

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Everything an alert template may refer to: the facts of the detection plus names and derived
 * values. Durations and «last seen» are computed against `ctx.now`, so a sent message freezes them.
 */
export function incidentVars(i: IncidentLike, ctx: TextContext, extra: Vars = {}): Vars {
  const f = i.facts ?? {};
  const { names } = ctx;
  const roomId = i.roomId ?? str(f.roomId);
  const sourceId = i.sourceId ?? str(f.sourceId);
  const entity = i.entityId ?? str(f.entityId);
  const fallbackId = str(f.fallbackId);
  const circuitId = str(f.circuitId);
  const instanceId = str(f.instanceId);
  const label = str(f.name);
  const name = label ?? (entity ? names.entity(entity) : null) ?? (i.deviceKey ? names.device(i.deviceKey) : null) ?? entity;
  // two sensors both called «Температура» in one room read the same: the entity id tells them apart
  const subject = name && entity && f.showEntity === true && name !== entity ? `${name} (${entity})` : name;
  // likewise two air conditioners both called «Кондиціонер» in one room
  const sourceName = sourceId ? (names.source(sourceId) ?? sourceId) : null;
  const since = num(f.since);
  const minutes = num(f.minutes) ?? (since !== null ? minutesSince(since, ctx.now) : minutesSince(i.openedAt, ctx.now));
  const lastAt = num(f.lastAt) ?? num(f.lastReportedAt) ?? (num(f.minutes) !== null ? ctx.now - (num(f.minutes) as number) * MINUTE_MS : null);
  const vars: Record<string, Vars[string]> = {
    ...f,
    room: roomId ? (names.room(roomId) ?? roomId) : null,
    source: sourceName && entity && f.sourceShared === true ? `${sourceName} (${entity})` : sourceName,
    sourceName,
    fallback: fallbackId ? (names.source(fallbackId) ?? fallbackId) : null,
    circuit: circuitId ? (names.circuit(circuitId) ?? circuitId) : null,
    instance: instanceId ? (names.instance(instanceId) ?? label ?? instanceId) : label,
    entity,
    sensor: subject,
    device: subject,
    deviceName: name,
    duration: minutes,
    sinceAt: since ?? (num(f.minutes) !== null ? ctx.now - (num(f.minutes) as number) * MINUTE_MS : null),
    lastAt,
  };
  if (i.progress) {
    vars.attempt ??= i.progress.attempt;
    vars.of ??= i.progress.of;
  }
  return { ...vars, ...extra };
}

export interface IncidentText {
  title: string;
  body: string;
  short: string;
}

export function eventTexts(kind: EventKind): EventTexts {
  return EVENTS[kind];
}

const TITLE_MAX = 60;

export function renderEventTexts(kind: EventKind, vars: Vars, ctx: TextContext): IncidentText {
  const t = EVENTS[kind];
  let title = renderRow(t.title, vars, ctx);
  let body = renderRow(t.body, vars, ctx);
  // an entity id would push the state off a lock screen: the title keeps the name, the body says which entity
  const withId = vars.device !== vars.deviceName || vars.source !== vars.sourceName;
  if (title.length > TITLE_MAX && typeof vars.entity === 'string' && withId) {
    title = renderRow(t.title, { ...vars, device: vars.deviceName, sensor: vars.deviceName, source: vars.sourceName }, ctx);
    if (!body.includes(vars.entity)) body = `${renderRow(SYSTEM_TEXTS.entityRef, { entity: vars.entity }, ctx)} ${body}`;
  }
  return { title: clip(title, TITLE_MAX), body, short: renderRow(t.short, vars, ctx) };
}

export function renderIncident(i: IncidentLike, ctx: TextContext, extra: Vars = {}): IncidentText {
  return renderEventTexts(i.kind, incidentVars(i, ctx, extra), ctx);
}

/** The short silent message sent when a notified problem is over. */
export function renderResolved(i: IncidentLike, ctx: TextContext, extra: Vars = {}): string {
  return renderRow(EVENTS[i.kind].resolved, incidentVars(i, ctx, extra), ctx);
}

/** Title of a grouped message («3 датчики не на зв’язку»), with the places it is about after a dot. */
export function renderGroupTitle(kind: EventKind, count: number, ctx: TextContext, places: readonly string[] = []): string {
  const row = EVENTS[kind].group ?? SYSTEM_TEXTS.groupDefault;
  const head = renderRow(row, { n: count, kind }, ctx);
  return places.length ? clip(`${head} · ${places.join(', ')}`, 80) : head;
}

/** One incident among several (a grouped message, the morning digest): place, device, state, what Klimo does. */
export function renderLine(i: IncidentLike, ctx: TextContext, extra: Vars = {}): string {
  const t = EVENTS[i.kind];
  return renderRow(t.line ?? t.title, incidentVars(i, ctx, extra), ctx);
}

/** Where an incident is, for the title of a grouped message: its room, «Надворі», or its source. */
function placeOf(i: IncidentLike, ctx: TextContext, extra: Vars): string | null {
  const v = incidentVars(i, ctx, extra);
  if (typeof v.room === 'string') return v.room;
  if (v.outdoor === true || v.role === 'outdoor') return labelOf(['Outdoors', 'Надворі'], ctx.lang);
  // the bare name: two same-named sources are one place, their lines below tell them apart
  return typeof v.sourceName === 'string' ? v.sourceName : typeof v.source === 'string' ? v.source : null;
}

/**
 * Lines for several incidents, one each. Two lines that would read the same (two unnamed sensors of one
 * room) get their entity ids, so no two devices ever share a line.
 */
export function renderLines(items: readonly { incident: IncidentLike; extra?: Vars }[], ctx: TextContext): string[] {
  const lines = items.map(({ incident, extra }) => renderLine(incident, ctx, extra));
  const seen = new Map<string, number>();
  for (const l of lines) seen.set(l, (seen.get(l) ?? 0) + 1);
  return lines.map((l, k) => {
    if ((seen.get(l) ?? 0) < 2) return l;
    const i = items[k].incident;
    const ref = i.entityId ?? str(i.facts?.entityId) ?? i.deviceKey;
    return ref && !l.includes(ref) ? `${l} (${ref})` : l;
  });
}

/** A grouped message: «2 датчики не на зв’язку · Кухня, Ванна» over one line per incident. */
export function renderGroup(kind: EventKind, items: readonly { incident: IncidentLike; extra?: Vars }[], ctx: TextContext): { title: string; body: string } {
  const places = [...new Set(items.map(({ incident, extra }) => placeOf(incident, ctx, extra ?? {})).filter((p): p is string => !!p))];
  return {
    title: renderGroupTitle(kind, items.length, ctx, places),
    body: renderLines(items, ctx)
      .map((l) => `• ${l}`)
      .join('\n'),
  };
}

export function eventLabel(kind: EventKind, lang: Lang): string {
  return labelOf(EVENT_LABEL[kind], lang);
}

export function actionLabel(action: IncidentAction, lang: Lang): string {
  return labelOf(ACTION_LABEL[action], lang);
}

export function actionResult(action: IncidentAction, vars: Vars, ctx: TextContext): string {
  return renderRow(ACTION_RESULT[action], withBrand(vars), ctx);
}

export function systemText(key: SystemTextKey, vars: Vars, ctx: TextContext): string {
  return renderRow(SYSTEM_TEXTS[key], withBrand(vars), ctx);
}

export function reportText(key: ReportTextKey, vars: Vars, ctx: TextContext): string {
  return renderRow(REPORT_TEXTS[key], vars, ctx);
}

/* ── helpers the ports expose ───────────────────────────────────────────────────────────────── */

export function duration(minutes: number, lang: Lang): string {
  return fmtDuration(minutes, lang);
}

export function clock(ts: EpochMs, ctx: Pick<TextContext, 'now' | 'tz' | 'lang'>): string {
  return fmtClock(ts, ctx.now, ctx.tz, ctx.lang);
}

/* ── catalogues for tests and previews ──────────────────────────────────────────────────────── */

export const REASON_CODES = Object.keys(REASONS) as ReasonCode[];
export const JOURNAL_CODES = Object.keys(JOURNAL) as JournalCode[];
export const CARD_KEYS = Object.keys(CARDS) as CardTextKey[];
export const ISSUE_CODES = Object.keys(ISSUES) as IssueCode[];
export const SYSTEM_TEXT_KEYS = Object.keys(SYSTEM_TEXTS) as SystemTextKey[];
export const REPORT_TEXT_KEYS = Object.keys(REPORT_TEXTS) as ReportTextKey[];

export function reasonRow(code: ReasonCode): Row {
  return REASONS[code];
}
export function journalRow(code: JournalCode): Row {
  return JOURNAL[code];
}
export function cardRow(key: CardTextKey): Row {
  return CARDS[key];
}
export function issueRow(code: IssueCode): Row {
  return ISSUES[code];
}

/** Names of the demo house, for previews of messages before anything is configured. */
const SAMPLE: Record<Lang, Record<string, string>> = {
  uk: {
    r_kitchen: 'Кухня',
    r_bath: 'Ванна',
    s_hp: 'Тепловий насос',
    s_boiler: 'Газовий котел',
    c_floor: 'Тепла підлога',
    z2m1: 'Z2M #1',
    blackout: 'Блекаут',
    ru_solar: 'Сонце при блекауті',
    home: 'Дома',
    away: 'Поза домом',
    'sensor.kitchen_shelf_temperature': 'На полиці',
    'climate.bathroom_towel_trv': 'Рушникосушка',
    'sensor.bedroom_button_battery': 'Кнопка в спальні',
    'switch.boiler_relay': 'Реле котла',
    'binary_sensor.grid_offline': 'Мережа',
    'binary_sensor.kitchen_window_contact': 'Вікно біля плити',
  },
  en: {
    r_kitchen: 'Kitchen',
    r_bath: 'Bathroom',
    s_hp: 'Heat pump',
    s_boiler: 'Gas boiler',
    c_floor: 'Floor heating',
    z2m1: 'Z2M #1',
    blackout: 'Blackout',
    ru_solar: 'Sun in a blackout',
    home: 'Home',
    away: 'Away',
    'sensor.kitchen_shelf_temperature': 'Shelf',
    'climate.bathroom_towel_trv': 'Towel rail',
    'sensor.bedroom_button_battery': 'Bedroom button',
    'switch.boiler_relay': 'Boiler relay',
    'binary_sensor.grid_offline': 'Grid',
    'binary_sensor.kitchen_window_contact': 'Stove window',
  },
};

export function sampleNames(lang: Lang): NameResolver {
  const look = (id: string) => SAMPLE[lang][id] ?? null;
  return { room: look, source: look, profile: look, trigger: look, rule: look, circuit: look, pump: look, instance: look, device: look, entity: look };
}

/** A believable incident of every kind (previews, «Як це виглядатиме», tests). */
export function sampleIncident(kind: EventKind, now: EpochMs): IncidentLike {
  const min = MINUTE_MS;
  const base: IncidentLike = { kind, roomId: null, sourceId: null, entityId: null, deviceKey: null, facts: {}, progress: null, openedAt: now - 3 * min };
  const room = (roomId: string, facts: ReasonParams, entityId: string | null = null): IncidentLike => ({ ...base, roomId, entityId, facts });
  switch (kind) {
    case 'source_failed':
      return { ...base, sourceId: 's_hp', entityId: 'climate.heat_pump', facts: { code: 'no_confirm', minutes: 5, fallbackId: 's_boiler' } };
    case 'source_unavailable':
      return { ...base, sourceId: 's_hp', entityId: 'climate.heat_pump', facts: { minutes: 3, fallbackId: 's_boiler' } };
    case 'frost_risk':
      return room('r_bath', { t: 6.4, frostC: 7 });
    case 'z2m_offline':
      return { ...base, entityId: 'binary_sensor.zigbee2mqtt_bridge_connection_state', facts: { instanceId: 'z2m1', minutes: 2 } };
    case 'room_no_data':
      return room('r_kitchen', { minutes: 12, safeC: 17 });
    case 'ha_disconnected':
      return { ...base, facts: { minutes: 11 } };
    case 'energy_critical':
      return { ...base, facts: { soc: 18 } };
    case 'sensor_offline':
      return room('r_kitchen', { minutes: 100, left: 2, total: 3, roomTemp: 20.9 }, 'sensor.kitchen_shelf_temperature');
    case 'trv_not_confirmed':
      return { ...room('r_bath', { attempts: 3 }, 'climate.bathroom_towel_trv'), progress: { attempt: 3, of: 3 } };
    case 'battery_low':
      return room('r_kitchen', { pct: 12, batteryType: 'CR2032', estDays: 9 }, 'sensor.bedroom_button_battery');
    case 'window_open_long':
      return room('r_kitchen', { minutes: 25, since: now - 25 * min, outdoorC: 4.2, reaction: 'pause', entityId: 'binary_sensor.kitchen_window_contact', openCount: 1 });
    case 'humidity_high':
      return room('r_bath', { rh: 68, minutes: 20 });
    case 'condensation_risk':
      return room('r_bath', { rh: 64, marginC: 2.4 });
    case 'dew_point_guard':
      return { ...base, facts: { circuitId: 'c_floor', dewC: 17.2, supplyC: 19.5 } };
    case 'signal_weak':
      return room('r_bath', { lqi: 54 }, 'climate.bathroom_towel_trv');
    case 'entity_unavailable':
      return { ...base, entityId: 'binary_sensor.grid_offline', facts: { minutes: 6, triggerId: 'blackout', unknownAs: 'false' } };
    case 'entity_missing':
      return { ...base, entityId: 'switch.boiler_relay', facts: {} };
    case 'overheat':
      return room('r_kitchen', { t: 26.4, maxC: 26 });
    case 'relay_mismatch':
      return { ...base, sourceId: 's_boiler', entityId: 'switch.boiler_relay', facts: {} };
    case 'actuator_conflict':
      return { ...base, entityId: 'switch.boiler_relay', facts: { by: 'automation', until: now + 7 * min } };
    case 'room_too_cold':
      return room('r_kitchen', { t: 18.6, T: 21, minutes: 75 });
    case 'room_too_hot':
      return room('r_kitchen', { t: 27.1, T: 24, minutes: 70 });
    case 'mqtt_offline':
      return { ...base, facts: { minutes: 6 } };
    case 'channel_failed':
      return { ...base, facts: { channel: 'telegram', reason: 'polling_conflict' } };
    case 'source_fallback':
      return { ...base, facts: { from: 's_hp', to: 's_boiler', code: 'unavailable', reason: 'failover' } };
    case 'source_recovered':
      return { ...base, sourceId: 's_hp', facts: {} };
    case 'trigger_fired':
      return { ...base, facts: { triggerId: 'blackout' } };
    case 'rule_activated':
      return { ...base, facts: { ruleId: 'ru_solar' } };
    case 'house_profile_changed':
      return { ...base, facts: { profileId: 'away', until: now + 3 * 60 * min, by: 'Оля' } };
    case 'house_mode_changed':
      return { ...base, facts: { from: 'auto', to: 'heat', by: 'Ігор' } };
    case 'season_changed':
      return { ...base, facts: { from: 'neutral', to: 'heating', avgC: 7.8 } };
    case 'manual_override':
      return room('r_bath', { valueC: 23, by: 'Оля', policy: 'slot' }, 'climate.bathroom_towel_trv');
    case 'budget_shed':
      return { ...base, sourceId: 's_hp', facts: { usedKw: 3.6, budgetKw: 4 } };
    case 'report_daily':
    case 'report_weekly':
      return { ...base, facts: { date: '21.10', text: '…' } };
  }
}

/** Every alert kind with its default severity, in catalogue order. */
export const KINDS: readonly { kind: EventKind; severity: (typeof EVENT_SEVERITY)[EventKind] }[] = EVENT_KINDS.map((kind) => ({
  kind,
  severity: EVENT_SEVERITY[kind],
}));

/** Render a template row outside the catalogues (a one-off sentence with the same machinery). */
export function renderText(row: Row, vars: Vars, ctx: TextContext): string {
  return render(row[ctx.lang === 'uk' ? 1 : 0], withBrand(vars), ctx);
}
