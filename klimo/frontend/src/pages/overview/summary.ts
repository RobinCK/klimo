/**
 * A room summary as the overview shows it: the card's target line, its quiet facts, the one
 * issue it has room for, and the compact phone row. The texts follow the target's origin, so a
 * value is never shown without saying where it comes from.
 */
import type { EpochMs, IconName, RoomSummary, SparkDto } from '@api/model';
import type { RoomCardProps } from '@ui';
import { paths } from '@app';
import { fmtDur, fmtPct, fmtRate, fmtSince, fmtTemp, fmtUntil, renderIssue, roomStateLabel, t, type CodeContext } from '@i18n';

type Source = RoomCardProps['source'];

const profileName = (s: RoomSummary, ctx: CodeContext) => (s.src.profileId ? (ctx.profile?.(s.src.profileId) ?? s.src.profileId) : '');

function targetText(s: RoomSummary): string {
  if (s.range) return `${fmtTemp(s.range.lo)}–${fmtTemp(s.range.hi)}`;
  return fmtTemp(s.src.valueC ?? s.targetC);
}

function left(until: EpochMs | null, now: EpochMs): string {
  return until == null ? '' : fmtDur(Math.max(1, (until - now) / 60000));
}

/** The card's target line («Ціль 20.0° · Дома до 23:00»). */
export function sourceLine(s: RoomSummary, ctx: CodeContext, now: EpochMs): Source {
  const profile = profileName(s, ctx);
  const until = fmtUntil(s.src.until, now);
  const tt = targetText(s);
  // manual control and «off» have no end: the line names the mode, not «до скасування»
  if (s.control.mode === 'manual' && (s.src.kind === 'manual' || s.src.kind === 'range')) return { kind: 'manual', text: t('Manual control · {t}', { t: tt }) };
  if (s.control.mode === 'off' && s.src.kind === 'off') return { kind: 'off', text: t('Off · frost protection stays') };
  switch (s.src.kind) {
    case 'schedule':
      return { kind: 'schedule', text: profile ? t('Target {t} · {profile} {until}', { t: tt, profile, until }) : t('Target {t}', { t: tt }) };
    case 'profile_updated':
      return { kind: 'profile_updated', text: t('Target {t} · {profile} (updated) {until}', { t: tt, profile, until }) };
    case 'manual':
      return { kind: 'manual', text: t('Manually {t} · {until}', { t: tt, until }) };
    case 'range':
      return { kind: 'range', text: t('Manually {t} · {until}', { t: tt, until }) };
    case 'boost': {
      const cool = s.state === 'cool' || (s.src.deltaC ?? 0) < 0;
      return {
        kind: 'boost',
        tone: cool ? 'cool' : 'heat',
        text: t('Boost to {t} · {left} more', { t: tt, left: left(s.src.until, now) }),
      };
    }
    case 'window':
      return { kind: 'window', text: s.src.since ? t('Paused · window open for {dur}', { dur: fmtSince(s.src.since, now) }) : t('Paused · window open') };
    case 'airing':
      return { kind: 'airing', text: s.src.until ? t('Airing · {left} more', { left: left(s.src.until, now) }) : t('Airing') };
    case 'off':
      return { kind: 'off', text: profile ? t('Off in «{profile}»', { profile }) : t('Off {until}', { until }) };
    case 'monitor':
      return { kind: 'monitor', text: t('Monitoring only') };
    case 'frost':
      return { kind: 'frost', text: t('Frost protection · {t}', { t: tt }) };
    case 'presence':
      return { kind: 'presence', text: t('Target {t} · {profile} · by presence', { t: tt, profile }) };
    case 'calendar':
      return { kind: 'calendar', text: t('Target {t} · {profile} by the calendar {until}', { t: tt, profile, until }) };
    case 'room_profile':
      return { kind: 'room_profile', text: t('Profile «{profile}» {t} · {until}', { t: tt, profile, until }) };
    case 'preheat':
      return { kind: 'preheat', text: t('Preheating to {t} · {profile}', { t: tt, profile }) };
    case 'no_data':
      return { kind: 'no_data', text: t('No temperature data') };
  }
}

/** The short line of the phone row: «Гріє · Дома до 23:00», or the full text where the state says it all. */
function compactSub(s: RoomSummary, ctx: CodeContext, now: EpochMs, full: string): string {
  const state = roomStateLabel(s.state);
  const profile = profileName(s, ctx);
  const until = fmtUntil(s.src.until, now);
  if (s.control.mode === 'manual' && (s.src.kind === 'manual' || s.src.kind === 'range')) return `${state} · ${t('manual control')}`;
  switch (s.src.kind) {
    case 'schedule':
    case 'calendar':
    case 'presence':
      return profile ? `${state} · ${t('{profile} {until}', { profile, until })}` : state;
    case 'profile_updated':
      return `${state} · ${t('{profile} (updated) {until}', { profile, until })}`;
    case 'manual':
    case 'range':
      return `${state} · ${t('manually {until}', { until })}`;
    default:
      return full;
  }
}

const DEVICE_ICON: Record<RoomSummary['device']['kind'], IconName> = {
  trv: 'radiator',
  radiator: 'radiator',
  floor: 'floor',
  trvfloor: 'floor',
  ac: 'ac',
  heater: 'convector',
  none: 'eye',
};

function deviceText(s: RoomSummary): string {
  const d = s.device;
  const counts = d.total > 0 ? ` · ${d.acked}/${d.total}` : '';
  switch (d.kind) {
    case 'trv':
      return `${t('radiators')}${counts}`;
    case 'radiator':
      return t('radiators');
    case 'floor':
      return t('underfloor heating');
    case 'trvfloor':
      return `${t('radiators and floor')}${counts}`;
    case 'ac':
      return t('air conditioner');
    case 'heater':
      return t('heater');
    case 'none':
      return t('nothing to control');
  }
}

/** Up to three facts under the sparkline: humidity, windows, devices. */
export function metaItems(s: RoomSummary, now: EpochMs): NonNullable<RoomCardProps['meta']> {
  const out: NonNullable<RoomCardProps['meta']> = [];
  if (s.humidityPct != null) out.push({ icon: 'droplet', text: fmtPct(s.humidityPct), tone: s.humidityWarn ? 'warn' : undefined });
  if (s.window && s.window.total > 0) {
    if (s.window.open) {
      out.push({
        icon: 'windowOpen',
        text: s.window.openSince ? t('open for {dur}', { dur: fmtSince(s.window.openSince, now) }) : t('open'),
        tone: 'warn',
      });
    } else {
      out.push({ icon: 'windowClosed', text: t('{count} closed', { count: s.window.total }) });
    }
  }
  out.push({ icon: DEVICE_ICON[s.device.kind], text: deviceText(s) });
  return out;
}

export function issueOf(s: RoomSummary, ctx: CodeContext): RoomCardProps['issue'] {
  if (!s.issue) return null;
  const text = renderIssue(s.issue, ctx);
  const more = s.issuesCount > 1 ? ` +${s.issuesCount - 1}` : '';
  return { tone: s.issue.tone, icon: s.issue.icon, text: `${text}${more}` };
}

/** Attention first (errors, then warnings and open windows), then the configured order. */
export function attentionRank(s: RoomSummary): number {
  if (s.state === 'error' || s.issue?.tone === 'err') return 0;
  if (s.issue || s.state === 'window') return 1;
  return 2;
}

/** Rooms the «Увага» filter shows. */
export const needsAttention = (s: RoomSummary) => s.issue != null || s.state === 'window' || s.state === 'error';

function ariaLabel(s: RoomSummary, source: string): string {
  return t('{room}: {temp}, {state}, {source}', { room: s.name, temp: fmtTemp(s.tempC), state: roomStateLabel(s.state).toLowerCase(), source });
}

/** Props of the overview card for one room. */
export function roomCard(s: RoomSummary, ctx: CodeContext, now: EpochMs, spark: SparkDto | undefined): RoomCardProps {
  const source = sourceLine(s, ctx, now);
  return {
    variant: 'card',
    title: s.name,
    state: s.state,
    stateLabel: roomStateLabel(s.state),
    tone: s.tone,
    tempText: fmtTemp(s.tempC),
    trend: s.trendCPerH != null ? { cPerH: s.trendCPerH, text: fmtRate(s.trendCPerH) } : null,
    source,
    spark: spark ? { values: spark.values, target: spark.targets, below: s.tol.below, above: s.tol.above } : null,
    meta: metaItems(s, now),
    issue: issueOf(s, ctx),
    to: paths.room(s.id),
    ariaLabel: ariaLabel(s, source.text),
  };
}

/** Props of the 64 px phone row for one room. */
export function roomRow(s: RoomSummary, ctx: CodeContext, now: EpochMs): RoomCardProps {
  const source = sourceLine(s, ctx, now);
  const target = s.range ? `${fmtTemp(s.range.lo)}–${fmtTemp(s.range.hi)}` : s.targetC != null ? fmtTemp(s.targetC) : null;
  return {
    variant: 'compact',
    title: s.name,
    state: s.state,
    stateLabel: roomStateLabel(s.state),
    tone: s.tone,
    tempText: fmtTemp(s.tempC),
    source,
    subText: compactSub(s, ctx, now, source.text),
    issue: issueOf(s, ctx),
    targetText: target ? `→ ${target}` : undefined,
    to: paths.room(s.id),
    ariaLabel: ariaLabel(s, source.text),
  };
}
