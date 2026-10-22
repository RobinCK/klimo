/**
 * Sentences of the room page: where the target comes from, why the room heats or not, what
 * the devices confirmed. Every target is shown with its origin; every number with its unit.
 */
import type { EffectiveTarget, EpochMs, RoomDetailDto, RoomState, RoomSyncState } from '@api/model';
import type { IconName, Tone } from '@ui';
import { aggregationLabel, fmtDelta, fmtDur, fmtSince, fmtTemp, fmtTime, fmtUntil, renderReason, t, type CodeContext } from '@i18n';

const left = (until: EpochMs | null, now: EpochMs) => (until == null ? '' : fmtDur(Math.max(1, (until - now) / 60000)));

/** The value the room heads for in the active mode («20.0°», «20.0–25.0°»). */
export function targetValueText(tg: EffectiveTarget): string {
  if (tg.mode === 'dual') return `${fmtTemp(tg.heatC)}–${fmtTemp(tg.coolC)}`;
  return fmtTemp(tg.displayC ?? tg.heatC ?? tg.coolC);
}

/** «→ Ніч 18.0°» — the next change, when the schedule knows it. */
function nextText(tg: EffectiveTarget, ctx: CodeContext): string {
  const n = tg.next;
  if (!n) return '';
  const name = ctx.profile?.(n.profileId) ?? n.profileId;
  const value = tg.mode === 'cool' ? n.coolC : (n.heatC ?? n.coolC);
  return value != null ? ` → ${name} ${fmtTemp(value)}` : ` → ${name}`;
}

/** The line under the target: «Дома за розкладом · до 23:00 → Ніч 18.0°», «Вручну · до 20:10, потім розклад». */
export function sourceText(state: RoomState, ctx: CodeContext, now: EpochMs): string {
  const tg = state.target;
  const profile = tg.profileId ? (ctx.profile?.(tg.profileId) ?? tg.profileId) : '';
  const until = tg.until != null ? fmtUntil(tg.until, now) : '';
  const next = nextText(tg, ctx);
  switch (tg.display) {
    case 'schedule':
      return until ? t('{profile} by schedule · {until}{next}', { profile, until, next }) : t('{profile} by schedule', { profile });
    case 'profile_updated':
      return until ? t('{profile} (updated) · {until}{next}', { profile, until, next }) : t('{profile} (updated)', { profile });
    case 'manual':
      return tg.until != null ? t('Manually · {until}, then the schedule', { until }) : t('Manually · until changed back');
    case 'range':
      return tg.until != null
        ? t('Manual range {range} · {until}', { range: targetValueText(tg), until })
        : t('Manual range {range}', { range: targetValueText(tg) });
    case 'boost':
      return t('Boost to {t} · {left} more', { t: targetValueText(tg), left: left(tg.until, now) });
    case 'window':
      return state.window.openSince != null ? t('Paused · window open for {dur}', { dur: fmtSince(state.window.openSince, now) }) : t('Paused · window open');
    case 'airing':
      return tg.until != null ? t('Airing · {left} more', { left: left(tg.until, now) }) : t('Airing');
    case 'off':
      if (tg.layer === 'room_off') return tg.until != null ? t('Off {until}', { until }) : t('Off until switched on');
      return profile
        ? t('Off in «{profile}» · frost protection {t}', { profile, t: fmtTemp(tg.frostFloorC) })
        : t('Off · frost protection {t}', { t: fmtTemp(tg.frostFloorC) });
    case 'monitor':
      return t('Monitoring only — nothing to control');
    case 'frost':
      return t('Frost protection · keeps {t}', { t: fmtTemp(tg.frostFloorC) });
    case 'presence':
      return t('{profile} by presence', { profile });
    case 'calendar':
      return until ? t('{profile} by the calendar · {until}', { profile, until }) : t('{profile} by the calendar', { profile });
    case 'room_profile':
      return until ? t('Room profile «{profile}» · {until}', { profile, until }) : t('Room profile «{profile}»', { profile });
    case 'preheat':
      return tg.preheat
        ? t('Preheating for {profile} at {time}', { profile, time: fmtTime(tg.preheat.forBlockAt) })
        : t('Preheating for {profile}', { profile });
    case 'no_data':
      return t('No temperature data');
  }
}

/** Phone header status («Дома за розкладом», «вручну 20.5° · до 23:00»). */
export function phoneSubtitle(state: RoomState, ctx: CodeContext, now: EpochMs): { icon: IconName; text: string; strong?: boolean } {
  const tg = state.target;
  const profile = tg.profileId ? (ctx.profile?.(tg.profileId) ?? tg.profileId) : '';
  switch (tg.display) {
    case 'schedule':
      return { icon: 'clock', text: t('{profile} by schedule', { profile }) };
    case 'manual':
    case 'range':
      return { icon: 'hand', text: t('manually {t} · {until}', { t: targetValueText(tg), until: fmtUntil(tg.until, now) }), strong: true };
    case 'profile_updated':
      return {
        icon: 'clock',
        text: tg.until != null ? t('{profile} (updated) · {until}', { profile, until: fmtUntil(tg.until, now) }) : t('{profile} (updated)', { profile }),
      };
    case 'boost':
      return { icon: 'bolt', text: sourceText(state, ctx, now), strong: true };
    case 'window':
    case 'airing':
      return { icon: 'pause', text: sourceText(state, ctx, now), strong: true };
    case 'off':
      return { icon: 'power', text: sourceText(state, ctx, now) };
    case 'no_data':
      return { icon: 'alert', text: t('No temperature data'), strong: true };
    default:
      return { icon: 'clock', text: sourceText(state, ctx, now) };
  }
}

/** «Зараз · медіана з 3». */
export function readoutCaption(state: RoomState): string {
  const a = state.aggregation;
  if (a.fallback === 'trv') return t('Now · from the radiator valves');
  if (a.fallback === 'no_data' || a.valueC == null) return t('Now · no data');
  if (a.activeCount <= 1) return t('Now · one sensor');
  return t('Now · {method} of {n}', { method: aggregationLabel(a.method).toLowerCase(), n: a.activeCount });
}

/** Title of the «why» box. */
export function whyTitle(state: RoomState): string {
  switch (state.state) {
    case 'heat':
      return t('Why it heats');
    case 'cool':
      return t('Why it cools');
    case 'wait':
      return t('Why it waits');
    case 'window':
      return t('Why it is paused');
    case 'off':
      return t('Why it is off');
    case 'frost':
      return t('Frost protection');
    case 'error':
      return t('No data');
    case 'monitor':
      return t('Monitoring only');
    case 'hold':
      return state.activeModes.cool && !state.activeModes.heat ? t('Why it does not cool') : t('Why it does not heat');
  }
}

/** The explanation in three parts: the main sentence, the details, the time estimate. */
export function whyText(state: RoomState, ctx: CodeContext): { text: string; eta?: string } {
  const isEta = (code: string) => code.startsWith('why.eta.');
  const main = state.why.filter((r) => !isEta(r.code)).map((r) => renderReason(r, ctx));
  const wait = state.demand.waitReason ? renderReason(state.demand.waitReason, ctx) : '';
  const eta = state.why.find((r) => isEta(r.code));
  return { text: [...main, wait ? `${wait}.` : ''].filter(Boolean).join(' '), eta: eta ? renderReason(eta, ctx) : undefined };
}

/** «надсилаю на 2 головки…» → «1 з 2 підтвердила…» → «обидві підтвердили». */
export function syncText(sync: Pick<RoomSyncState, 'phase' | 'acked' | 'total' | 'attempt' | 'maxAttempts' | 'what'>): string {
  const { phase, acked, total, what } = sync;
  switch (phase) {
    case 'idle':
      return '';
    case 'sending':
      if (what === 'ac') return t('waiting for the air conditioner…');
      if (what === 'trv' && total > 0) return t('sending to {count} radiator valves…', { count: total });
      return total > 0 ? t('sending to {count} devices…', { count: total }) : t('sending…');
    case 'partial':
      return t('{acked} of {total} confirmed…', { acked, total });
    case 'retry':
      return t('no answer — retry {attempt} of {max}…', { attempt: sync.attempt, max: sync.maxAttempts });
    case 'failed':
      return total > 1 ? t('{acked} of {total} confirmed — the rest did not', { acked, total }) : t('not confirmed');
    case 'done':
      if (what === 'ac') return t('the air conditioner confirmed');
      return total === 2 ? t('both confirmed') : total === 1 ? t('confirmed') : t('all {count} confirmed', { count: total });
  }
}

/** What a sync chip on a valve says. */
export function trvSyncChip(
  status: RoomState['trvs'][number]['sync'],
  commanded: number | null,
  now: EpochMs,
): { tone: Tone; icon: IconName; label: string } | null {
  const v = fmtTemp(commanded);
  switch (status.status) {
    case 'confirmed':
      return {
        tone: 'ok',
        icon: 'check',
        label:
          status.confirmedAt != null && now - status.confirmedAt < 60_000
            ? t('target {t} confirmed just now', { t: v })
            : t('target {t} confirmed {time}', { t: v, time: fmtTime(status.confirmedAt) }),
      };
    case 'sending':
    case 'queued':
      return { tone: 'warn', icon: 'sync', label: t('sending {t}', { t: v }) };
    case 'retrying':
      return { tone: 'warn', icon: 'sync', label: t('retry {attempt} of {max}', { attempt: status.attempt, max: status.maxAttempts }) };
    case 'failed':
      return { tone: 'err', icon: 'alert', label: t('did not confirm {t}', { t: v }) };
    case 'backoff':
      return { tone: 'warn', icon: 'swap', label: t('changed by something else') };
    case 'idle':
      return null;
  }
}

/** «Мінімум 18.6° о 16:00». */
export function atText(p: { c: number; at: EpochMs } | null): string {
  return p ? t('{t} at {time}', { t: fmtTemp(p.c), time: fmtTime(p.at) }) : '—';
}

/** «+2.8° до кімнати». */
export function deltaToRoom(d: number | null): string | undefined {
  return d == null ? undefined : t('{delta} to the room', { delta: fmtDelta(d, { sign: true }) });
}

/** The Klimo entity roles shown in «У Home Assistant». */
export function haRoleText(role: RoomDetailDto['haEntities'][number]['role']): string {
  switch (role) {
    case 'climate':
      return t('room thermostat');
    case 'control':
      return t('control: schedule, manual or off');
    case 'temperature':
      return t('calculated temperature');
    case 'humidity':
      return t('calculated humidity');
    case 'target':
      return t('effective target');
    case 'heat_demand':
      return t('the room asks for heat');
    case 'cool_demand':
      return t('the room asks for cooling');
    case 'window':
      return t('a window is open');
    case 'card':
      return t('data for the dashboard cards');
  }
}

/** LQI in words: ≥ 100 good, 50–99 fair, below 50 weak. */
export function lqiWord(lqi: number | null): string {
  if (lqi == null) return '';
  return lqi >= 100 ? t('good') : lqi >= 50 ? t('fair') : t('weak');
}
