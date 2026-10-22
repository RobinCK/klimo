/**
 * A condition tree in one readable line («sensor.outdoor_temperature < −10° · вихід при −8°»,
 * «щодня 23:00–07:00», «Блекаут і sensor.battery_soc < 40»), for trigger cards and the run
 * conditions of a source.
 */
import type { ConditionNode, Dow, TimeWindow } from '@api/model';
import { fmtDelta, fmtDur, fmtDurSec, fmtTemp, houseModeLabel, seasonShortLabel, t, weekdayShort, type CodeContext } from '@i18n';

const CMP: Record<string, string> = { '<': '<', '<=': '≤', '>': '>', '>=': '≥', '==': '=', '!=': '≠' };

const num = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1)).replace('-', '−');

function days(d: readonly Dow[] | undefined): string {
  if (!d || d.length === 0 || d.length === 7) return t('daily');
  const key = [...d].sort().join('');
  if (key === '01234') return t('on weekdays');
  if (key === '56') return t('at weekends');
  return [...d]
    .sort()
    .map((x) => weekdayShort(x))
    .join(', ');
}

function windowText(w: TimeWindow): string {
  return `${days(w.days)} ${w.from}–${w.to}`;
}

export function conditionText(n: ConditionNode, ctx: CodeContext, depth = 0): string {
  const wrap = (s: string) => (depth > 0 ? `(${s})` : s);
  const debounce = 'forSec' in n && n.forSec ? ` · ${t('for {dur}', { dur: fmtDurSec(n.forSec) })}` : '';
  switch (n.op) {
    case 'all':
      return n.items.length ? wrap(n.items.map((x) => conditionText(x, ctx, depth + 1)).join(` ${t('and')} `)) : t('always');
    case 'any':
      return n.items.length ? wrap(n.items.map((x) => conditionText(x, ctx, depth + 1)).join(` ${t('or')} `)) : t('never');
    case 'not':
      return `${t('not')} ${conditionText(n.item, ctx, depth + 1)}`;
    case 'state':
      return `${n.entityId}${n.attribute ? `.${n.attribute}` : ''} = ${n.equals.join(' / ')}${debounce}`;
    case 'numeric': {
      const left = n.minus ? `${n.entityId} − ${n.minus}` : n.entityId;
      const exit = n.exitAt != null ? ` · ${t('exit at {v}', { v: num(n.exitAt) })}` : '';
      return `${left} ${CMP[n.cmp]} ${num(n.value)}${exit}${debounce}`;
    }
    case 'template':
      return n.template.trim();
    case 'time':
      return n.windows.map(windowText).join(', ') + (n.tariffEntityId ? ` · ${n.tariffEntityId} = ${(n.tariffStates ?? []).join(' / ')}` : '');
    case 'sun':
      switch (n.is) {
        case 'above_horizon':
          return t('the sun is up') + debounce;
        case 'below_horizon':
          return t('the sun is down') + debounce;
        case 'elevation_above':
          return t('sun higher than {deg}°', { deg: n.degrees ?? 0 }) + debounce;
        case 'elevation_below':
          return t('sun lower than {deg}°', { deg: n.degrees ?? 0 }) + debounce;
      }
      return '';
    case 'weather':
      return `${n.entityId} · ${n.field} ${CMP[n.cmp]} ${typeof n.value === 'number' ? num(n.value) : n.value}`;
    case 'trigger':
      return `«${ctx.trigger?.(n.triggerId) ?? n.triggerId}»`;
    case 'outdoor': {
      const basis = n.basis === 'avg10m' ? ` ${t('(10-minute average)')}` : n.basis === 'avg3d' ? ` ${t('(3-day average)')}` : '';
      const exit = n.exitAt != null ? ` · ${t('exit at {v}', { v: fmtTemp(n.exitAt, { decimals: 0 }) })}` : '';
      return `${t('outdoor')}${basis} ${CMP[n.cmp]} ${fmtTemp(n.value, { decimals: 0 })}${exit}${debounce}`;
    }
    case 'room_deficit': {
      const rooms = n.roomIds === 'served' ? t('the rooms it serves') : n.roomIds.map((id) => ctx.room?.(id) ?? id).join(', ');
      return n.forMin
        ? t('{rooms} lack {delta} for longer than {dur}', { rooms, delta: fmtDelta(n.deficitC, { sign: false }), dur: fmtDur(n.forMin) })
        : t('{rooms} lack {delta}', { rooms, delta: fmtDelta(n.deficitC, { sign: false }) });
    }
    case 'room_below_target':
      return t('{room} below its target + {delta}', { room: ctx.room?.(n.roomId) ?? n.roomId, delta: fmtDelta(n.plusC, { sign: false }) });
    case 'source': {
      const name = ctx.source?.(n.sourceId) ?? n.sourceId;
      switch (n.is) {
        case 'running':
          return t('{source} runs', { source: name });
        case 'fault':
          return t('{source} has failed', { source: name });
        case 'unavailable':
          return t('{source} is unavailable', { source: name });
        case 'available':
          return t('{source} is available', { source: name });
        case 'lagging':
          return t('{source} is not keeping up', { source: name });
      }
      return name;
    }
    case 'season':
      return t('season: {list}', { list: n.in.map((s) => seasonShortLabel(s)).join(' / ') });
    case 'house_mode':
      return t('house mode: {list}', { list: n.in.map((m) => houseModeLabel(m)).join(' / ') });
    case 'budget_fits':
      return t('fits the blackout budget');
    case 'grid':
      return n.is === 'present' ? t('grid power is on') : t('no grid power');
    case 'const':
      return n.value ? t('always') : t('never');
  }
}
