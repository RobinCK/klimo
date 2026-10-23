/**
 * Words about the whole house: the headline («Гріють 3 з 7 кімнат»), the line under it, the
 * date, and what the system tiles say about sources, circuits, the weather and energy.
 */
import type { EpochMs, HouseState, IconName, PlantState, SourceDto, SourceKind, SourceState, Tone } from '@api/model';
import type { NameDirectory } from '@data';
import {
  fmtClock,
  fmtKw,
  fmtPct,
  fmtTemp,
  fmtTime,
  fmtUntil,
  houseModeLabel,
  locale,
  renderReason,
  sourceRoleLabel,
  sourceStateLabel,
  t,
  timeZone,
  type CodeContext,
} from '@i18n';

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

export const isRunning = (s: SourceState) => s.on && RUNNING.has(s.state);

/** «Гріють 3 з 7 кімнат», or what the house does when nothing runs. */
export function headline(house: HouseState): string {
  const { counts, season } = house;
  if (counts.total === 0) return t('No rooms yet');
  if (season.houseMode === 'off') return t('The house is switched off');
  // the verb agrees with the rooms that work, so the plural form follows `count` = active
  if (house.verb === 'heat' && counts.active > 0)
    return counts.capable === 1 ? t('The room is heating') : t('{count} of {total} rooms are heating', { count: counts.active, total: counts.capable });
  if (house.verb === 'cool' && counts.active > 0)
    return counts.capable === 1 ? t('The room is cooling') : t('{count} of {total} rooms are cooling', { count: counts.active, total: counts.capable });
  if (season.season === 'heating') return t('No room needs heat right now');
  if (season.season === 'cooling') return t('No room needs cooling right now');
  return t('Between seasons — heating and cooling rest');
}

/** «Тепловий насос гріє з 19:04 · профіль «Дома» до 23:00 · надворі 4.2°». */
export function subline(house: HouseState, plant: PlantState | null, ctx: CodeContext): string {
  const parts: string[] = [];
  const lead = plant?.sources.find((s) => s.sourceId === house.leadSourceId) ?? plant?.sources.find(isRunning) ?? null;
  if (lead && isRunning(lead)) {
    const name = ctx.source?.(lead.sourceId) ?? lead.sourceId;
    const since = lead.since != null ? fmtTime(lead.since) : null;
    if (lead.state === 'cooling')
      parts.push(since ? t('{source} cooling since {time}', { source: name, time: since }) : t('{source} cooling', { source: name }));
    else if (lead.state === 'heating' || lead.state === 'defrost')
      parts.push(since ? t('{source} heating since {time}', { source: name, time: since }) : t('{source} heating', { source: name }));
    else parts.push(`${name} · ${sourceStateLabel(lead.state).toLowerCase()}`);
  }
  const p = house.profile;
  const profile = ctx.profile?.(p.activeProfileId) ?? p.activeProfileId;
  if (p.layer === 'house_manual' && house.control.mode === 'manual') parts.push(t('profile «{profile}», the schedule is paused', { profile }));
  else if (p.layer === 'house_manual') parts.push(t('profile «{profile}» set by hand', { profile }));
  else if (p.scheduledUntil != null && p.layer === 'house_schedule')
    parts.push(t('profile «{profile}» {until}', { profile, until: fmtUntil(p.scheduledUntil, house.now) }));
  else parts.push(t('profile «{profile}»', { profile }));
  if (house.season.outdoorC != null) parts.push(t('outdoor {t}', { t: fmtTemp(house.season.outdoorC) }));
  return parts.join(' · ');
}

function fmtParts(now: EpochMs, opts: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat(locale(), { ...opts, timeZone: timeZone() }).format(new Date(now));
  } catch {
    // an unknown time zone name: the browser's own zone is the best guess
    return new Intl.DateTimeFormat(locale(), opts).format(new Date(now));
  }
}

/**
 * «Середа, 21 жовтня · 19:10» in the Home Assistant time zone. The weekday is formatted on its
 * own: Ukrainian Intl puts it in the accusative («середу») when it is joined with a date.
 */
export function dateLine(now: EpochMs): string {
  const weekday = fmtParts(now, { weekday: 'long' });
  const date = fmtParts(now, { day: 'numeric', month: 'long' });
  return `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)}, ${date} · ${fmtTime(now)}`;
}

/** How the house profile is chosen right now («за розкладом до 23:00 → Ніч», «вручну до 21:10»). */
export function profileOrigin(house: HouseState, ctx: CodeContext): string {
  const p = house.profile;
  const next = p.nextProfileId ? (ctx.profile?.(p.nextProfileId) ?? p.nextProfileId) : null;
  switch (p.layer) {
    case 'house_manual': {
      const until = p.override?.until ?? null;
      if (until != null) return t('by hand {until}', { until: fmtUntil(until, house.now) });
      const since = house.control.since;
      return since != null
        ? t('manual since {time} · the schedule is paused', { time: fmtClock(since, house.now) })
        : t('manual · the schedule is paused');
    }
    case 'calendar':
      return p.scheduledUntil != null ? t('by the calendar {until}', { until: fmtUntil(p.scheduledUntil, house.now) }) : t('by the calendar');
    case 'presence':
      return t('by presence');
    case 'house_schedule':
      if (p.scheduledUntil == null) return t('by schedule');
      return next
        ? t('by schedule {until} → {next}', { until: fmtUntil(p.scheduledUntil, house.now), next })
        : t('by schedule {until}', { until: fmtUntil(p.scheduledUntil, house.now) });
    case 'default':
      return t('default profile');
  }
}

/** The season badge of the outdoor tile («авто: опалення нижче 15°»). */
export function seasonBadge(house: HouseState): { tone: Tone; text: string } {
  const s = house.season;
  const deg = (c: number) => fmtTemp(c, { decimals: 0 });
  if (s.houseMode === 'off') return { tone: 'off', text: houseModeLabel('off') };
  if (!s.auto) return { tone: s.season === 'cooling' ? 'cool' : s.season === 'heating' ? 'heat' : 'hold', text: houseModeLabel(s.houseMode) };
  if (s.season === 'heating') return { tone: 'heat', text: t('auto: heating below {t}', { t: deg(s.rule.heatBelowC) }) };
  if (s.season === 'cooling') return { tone: 'cool', text: t('auto: cooling above {t}', { t: deg(s.rule.coolAboveC) }) };
  return { tone: 'hold', text: t('auto: between {lo} and {hi}', { lo: deg(s.rule.heatBelowC), hi: deg(s.rule.coolAboveC) }) };
}

export interface SourcesTile {
  icon: IconName;
  name: string;
  sub: string;
  others: string;
  dot: { tone: Tone; glow: boolean };
  leadId: string | null;
}

/** The lead source in words, and one short phrase for each of the others. */
export function sourcesTile(house: HouseState, plant: PlantState | null, sources: readonly SourceDto[] | undefined, ctx: NameDirectory): SourcesTile {
  const byId = new Map((sources ?? []).map((s) => [s.config.id, s.config] as const));
  const states = plant?.sources ?? [];
  const leadId = house.leadSourceId ?? plant?.lead.heat ?? plant?.lead.cool ?? states.find(isRunning)?.sourceId ?? states[0]?.sourceId ?? null;
  const lead = states.find((s) => s.sourceId === leadId) ?? null;
  const plain = (id: string) => byId.get(id)?.name ?? ctx.source?.(id) ?? id;
  const name = (id: string) => ctx.sourceLabel(id) ?? plain(id);
  if (!lead) {
    return {
      icon: 'heatPump',
      name: t('No sources yet'),
      sub: t('Add the boiler, heat pump or air conditioners'),
      others: '',
      dot: { tone: 'off', glow: false },
      leadId: null,
    };
  }
  const telemetry: string[] = [];
  if (isRunning(lead)) {
    telemetry.push(renderReason(lead.detail, ctx).toLowerCase());
    if (lead.telemetry.supplyC != null && lead.detail.params?.flowC == null)
      telemetry.push(t('supply {t}', { t: fmtTemp(lead.telemetry.supplyC, { decimals: 0 }) }));
    if (lead.telemetry.cop != null) telemetry.push(`COP ${lead.telemetry.cop.toFixed(1)}`);
  } else {
    telemetry.push(lead.fault ? sourceStateLabel('fault').toLowerCase() : sourceStateLabel(lead.state).toLowerCase());
  }
  const others = states
    .filter((s) => s.sourceId !== lead.sourceId && byId.get(s.sourceId)?.enabled !== false)
    .slice(0, 3)
    .map((s) => {
      const what = isRunning(s)
        ? sourceStateLabel(s.state)
        : s.fault
          ? sourceStateLabel('fault')
          : s.role === 'reserve' || s.role === 'assist' || s.role === 'trigger_only'
            ? sourceRoleLabel(s.role)
            : sourceStateLabel(s.state);
      return { id: s.sourceId, what: what.toLowerCase() };
    });
  // air conditioners of the same name doing the same thing read as one phrase without their rooms
  const phrase = (o: { id: string; what: string }) => {
    const alike = others.filter((x) => plain(x.id) === plain(o.id) && x.what === o.what).length > 1;
    return t('{source} — {what}', { source: alike ? plain(o.id) : name(o.id), what: o.what });
  };
  const othersLine = others
    .map(phrase)
    .filter((p, i, all) => all.indexOf(p) === i)
    .join(' · ');
  const kind = byId.get(lead.sourceId)?.kind ?? 'custom';
  return {
    icon: SOURCE_ICON[kind],
    name: name(lead.sourceId),
    sub: telemetry.filter(Boolean).join(' · '),
    others: othersLine,
    dot: { tone: lead.fault ? 'err' : isRunning(lead) ? lead.tone : 'off', glow: isRunning(lead) },
    leadId: lead.sourceId,
  };
}

/** «сонце 0 Вт · батарея 78% · будинок 3.4 кВт». */
export function energyLine(plant: PlantState): string {
  const e = plant.energy;
  const parts: string[] = [];
  if (e.pvKw != null) parts.push(t('sun {v}', { v: fmtKw(e.pvKw) }));
  if (e.batteryPct != null) parts.push(t('battery {v}', { v: fmtPct(e.batteryPct) }));
  if (e.houseLoadKw != null) parts.push(t('house {v}', { v: fmtKw(e.houseLoadKw) }));
  return parts.join(' · ');
}
