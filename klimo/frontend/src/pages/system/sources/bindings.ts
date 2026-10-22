/**
 * How a source is wired to Home Assistant, as rows a person can read and fill: each role of
 * an adapter («Увімкнення», «Підтвердження роботи», «Температура подачі»…) with the entity
 * that plays it. Picking an entity writes it into the adapter; entities of the same HA device
 * (power, error code, defrost, COP, flame, relay timer) are suggested for the empty roles.
 */
import type {
  AdapterType,
  EntityId,
  EntityRolePreset,
  HaEntityDetailDto,
  SourceAdapter,
  SourceBinding,
  SourceConfig,
  SourceEnergy,
  SourceMode,
} from '@api/model';
import { sourceModeLabel, t } from '@i18n';

export function roleLabel(role: string): string {
  if (/^stage\d+$/.test(role)) return t('Stage {n}', { n: role.slice(5) });
  switch (role) {
    case 'command':
      return t('Switching on');
    case 'confirm':
      return t('Proof it runs');
    case 'watchdog':
      return t('Relay timer');
    case 'climate':
      return t('Thermostat');
    case 'defrost':
      return t('Defrosting');
    case 'error':
      return t('Error code');
    case 'cop':
      return t('COP');
    case 'supply':
      return t('Flow temperature');
    case 'power':
      return t('Power');
    case 'flow':
      return t('Flow setpoint');
    case 'enable':
      return t('Enable');
    case 'actual_flow':
      return t('Actual flow');
    case 'mode_select':
      return t('Heat pump mode');
    case 'on_heat':
      return t('Script: heat');
    case 'on_cool':
      return t('Script: cool');
    case 'on_dry':
      return t('Script: dry');
    case 'on_fan':
      return t('Script: fan');
    case 'off':
      return t('Script: off');
    default:
      return role;
  }
}

/** What to search for when picking the entity of a role. */
export function rolePreset(role: string): { role: EntityRolePreset | null; domain?: string[] } {
  if (/^stage\d+$/.test(role) || role === 'command' || role === 'enable') return { role: 'switchable' };
  switch (role) {
    case 'climate':
      return { role: 'climate_source' };
    case 'defrost':
    case 'confirm':
      return { role: 'binary' };
    case 'supply':
    case 'actual_flow':
      return { role: 'temperature' };
    case 'power':
      return { role: 'power' };
    case 'flow':
    case 'watchdog':
      return { role: 'number' };
    case 'mode_select':
      return { role: 'select' };
    case 'error':
    case 'cop':
      return { role: null, domain: ['sensor'] };
    default:
      return role.startsWith('on_') || role === 'off' ? { role: 'script' } : { role: null };
  }
}

export function emptyAdapter(type: AdapterType): SourceAdapter {
  switch (type) {
    case 'relay':
      return { type: 'relay', command: null, invert: false, stages: [], confirm: { kind: 'readback' }, watchdog: { kind: 'none' }, flowSetpoint: null };
    case 'climate':
      return {
        type: 'climate',
        climate: null,
        modeMap: { heat: 'heat', cool: 'cool', off: 'off' },
        setpoint: 'room_target',
        fixedSetpoint: null,
        quietFanMode: null,
        confirm: { kind: 'hvac_action' },
        defrostEntityId: null,
        errorEntityId: null,
        errorOkValues: ['0', 'ok', 'none', ''],
        copEntityId: null,
        supplyTempEntityId: null,
      };
    case 'flow':
      return { type: 'flow', enable: null, flowSetpoint: null, actualFlow: null, modeSelect: null, confirm: { kind: 'readback' } };
    case 'script':
      return { type: 'script', on: {}, off: null, confirm: { kind: 'none' } };
    case 'custom':
      return { type: 'custom', on: {}, off: [], setpoint: null, confirm: { kind: 'none' } };
  }
}

/** Write `entityId` into the role of the adapter (or the energy power sensor). */
export function setRole(
  adapter: SourceAdapter,
  energy: SourceEnergy,
  role: string,
  entityId: EntityId | null,
): { adapter: SourceAdapter; energy: SourceEnergy } {
  if (role === 'power') return { adapter, energy: { ...energy, powerEntityId: entityId } };
  if (role === 'confirm') {
    const c = adapter.confirm;
    const confirm =
      entityId == null
        ? adapter.type === 'climate'
          ? ({ kind: 'hvac_action' } as const)
          : ({ kind: 'readback' } as const)
        : c.kind === 'power_above'
          ? { ...c, entityId }
          : entityId.startsWith('sensor.')
            ? { kind: 'power_above' as const, entityId, thresholdW: 50 }
            : c.kind === 'state_in'
              ? { ...c, entityId }
              : { kind: 'entity_on' as const, entityId };
    return { adapter: { ...adapter, confirm } as SourceAdapter, energy };
  }
  const a = adapter;
  switch (a.type) {
    case 'relay': {
      if (role === 'command') return { adapter: { ...a, command: entityId }, energy };
      if (role === 'flow') return { adapter: { ...a, flowSetpoint: entityId ? { entityId, useCurve: a.flowSetpoint?.useCurve ?? true } : null }, energy };
      if (role === 'watchdog')
        return {
          adapter: { ...a, watchdog: entityId ? { kind: 'countdown_number', entityId, minutes: 15, rearmEveryMin: 5 } : { kind: 'none' } },
          energy,
        };
      const m = /^stage(\d+)$/.exec(role);
      if (m) {
        const i = Number(m[1]) - 2;
        const stages = a.stages.map((s, k) => (k === i && entityId ? { ...s, entityId } : s)).filter((s, k) => k !== i || entityId);
        return { adapter: { ...a, stages }, energy };
      }
      return { adapter: a, energy };
    }
    case 'climate': {
      const map: Record<string, keyof typeof a> = {
        climate: 'climate',
        defrost: 'defrostEntityId',
        error: 'errorEntityId',
        cop: 'copEntityId',
        supply: 'supplyTempEntityId',
      };
      const key = map[role];
      return key ? { adapter: { ...a, [key]: entityId }, energy } : { adapter: a, energy };
    }
    case 'flow': {
      if (role === 'enable') return { adapter: { ...a, enable: entityId }, energy };
      if (role === 'flow') return { adapter: { ...a, flowSetpoint: entityId }, energy };
      if (role === 'actual_flow') return { adapter: { ...a, actualFlow: entityId }, energy };
      if (role === 'mode_select')
        return {
          adapter: { ...a, modeSelect: entityId ? { entityId, heat: a.modeSelect?.heat ?? 'heat', cool: a.modeSelect?.cool ?? 'cool' } : null },
          energy,
        };
      return { adapter: a, energy };
    }
    case 'script': {
      if (role === 'off') return { adapter: { ...a, off: entityId }, energy };
      if (role.startsWith('on_')) {
        const mode = role.slice(3) as SourceMode;
        const on = { ...a.on };
        if (entityId) on[mode] = entityId;
        else delete on[mode];
        return { adapter: { ...a, on }, energy };
      }
      return { adapter: a, energy };
    }
    case 'custom':
      return { adapter: a, energy };
  }
}

/** The binding rows of an adapter that is not saved yet (no live values). */
export function draftRows(adapter: SourceAdapter, caps: SourceConfig['capabilities'], powerEntityId: EntityId | null): SourceBinding[] {
  const rows: SourceBinding[] = [];
  const add = (role: string, entityId: EntityId | null | undefined, required: boolean) =>
    rows.push({ role, entityId: entityId ?? null, required, live: null, status: entityId ? 'ok' : 'unset' });
  const a = adapter;
  switch (a.type) {
    case 'relay':
      add('command', a.command, true);
      a.stages.forEach((s, i) => add(`stage${i + 2}`, s.entityId, true));
      if (a.flowSetpoint) add('flow', a.flowSetpoint.entityId, true);
      add('watchdog', a.watchdog.kind === 'countdown_number' ? a.watchdog.entityId : null, false);
      break;
    case 'climate':
      add('climate', a.climate, true);
      add('defrost', a.defrostEntityId, false);
      add('error', a.errorEntityId, false);
      add('cop', a.copEntityId, false);
      add('supply', a.supplyTempEntityId, false);
      break;
    case 'flow':
      add('enable', a.enable, true);
      add('flow', a.flowSetpoint, true);
      add('actual_flow', a.actualFlow, false);
      break;
    case 'script':
      for (const m of ['heat', 'cool', 'dry', 'fan'] as const) if (caps[m] || a.on[m]) add(`on_${m}`, a.on[m], caps[m]);
      add('off', a.off, true);
      break;
    case 'custom':
      break;
  }
  const c = a.confirm;
  add('confirm', c.kind === 'entity_on' || c.kind === 'state_in' || c.kind === 'power_above' ? c.entityId : null, false);
  add('power', powerEntityId, false);
  return rows;
}

/**
 * Rows the server reports, plus the optional roles it leaves out while empty (proof of
 * running, a relay timer, a power sensor), so they can be filled from the same table.
 */
export function withOptionalRows(rows: readonly SourceBinding[], adapter: SourceAdapter): SourceBinding[] {
  const out = [...rows];
  const has = (role: string) => out.some((r) => r.role === role);
  if (adapter.type === 'relay' && !has('watchdog')) out.push({ role: 'watchdog', entityId: null, required: false, live: null, status: 'unset' });
  if (adapter.type !== 'climate' && adapter.type !== 'custom' && !has('confirm'))
    out.push({ role: 'confirm', entityId: null, required: false, live: null, status: 'unset' });
  if (!has('power')) out.push({ role: 'power', entityId: null, required: false, live: null, status: 'unset' });
  return out;
}

/** Fill the empty roles from entities of the same device; returns what was filled. */
export function applySiblings(
  adapter: SourceAdapter,
  energy: SourceEnergy,
  detail: HaEntityDetailDto,
): { adapter: SourceAdapter; energy: SourceEnergy; filled: string[] } {
  let a = adapter;
  let e = energy;
  const filled: string[] = [];
  const sib = (role: HaEntityDetailDto['siblings'][number]['role']) => detail.siblings.find((s) => s.role === role)?.entityId ?? null;
  const fill = (role: string, current: EntityId | null, found: EntityId | null) => {
    if (current || !found) return;
    ({ adapter: a, energy: e } = setRole(a, e, role, found));
    filled.push(role);
  };
  fill('power', e.powerEntityId, sib('power'));
  if (a.type === 'climate') {
    fill('defrost', a.defrostEntityId, sib('defrost'));
    fill('error', a.errorEntityId, sib('error'));
    fill('cop', a.copEntityId, sib('cop'));
    fill('supply', a.supplyTempEntityId, sib('supply'));
    const modes = detail.climate?.hvacModes ?? [];
    if (modes.length) {
      const pick = (want: string[]) => want.find((m) => modes.includes(m));
      const map = { ...a.modeMap };
      map.heat = pick(['heat']) ?? map.heat;
      map.cool = pick(['cool']) ?? map.cool;
      map.dry = pick(['dry']) ?? map.dry;
      map.fan = pick(['fan_only', 'fan']) ?? map.fan;
      map.off = pick(['off']) ?? map.off;
      a = { ...(a as Extract<SourceAdapter, { type: 'climate' }>), modeMap: map };
    }
  }
  if (a.type === 'relay') {
    const countdown = sib('countdown');
    if (a.watchdog.kind === 'none' && countdown) {
      ({ adapter: a, energy: e } = setRole(a, e, 'watchdog', countdown));
      filled.push('watchdog');
    }
    const flame = sib('flame');
    if ((a.confirm.kind === 'readback' || a.confirm.kind === 'none') && (flame || e.powerEntityId)) {
      ({ adapter: a, energy: e } = setRole(a, e, 'confirm', flame ?? e.powerEntityId));
      filled.push('confirm');
    }
  }
  return { adapter: a, energy: e, filled };
}

/** The entity id the adapter's main role points at (the one whose device has siblings). */
export function mainEntity(adapter: SourceAdapter): EntityId | null {
  switch (adapter.type) {
    case 'relay':
      return adapter.command;
    case 'climate':
      return adapter.climate;
    case 'flow':
      return adapter.enable;
    default:
      return null;
  }
}

/** «опалення → heat · охолодження → cool · вимк. → off». */
export function modeMapText(adapter: SourceAdapter): string | null {
  if (adapter.type !== 'climate') return null;
  const m = adapter.modeMap;
  const parts = (['heat', 'cool', 'dry', 'fan'] as const).filter((k) => m[k]).map((k) => `${sourceModeLabel(k)} → ${m[k]}`);
  parts.push(`${t('off')} → ${m.off}`);
  return parts.join(' · ');
}

export function setpointText(adapter: SourceAdapter): string | null {
  if (adapter.type !== 'climate') return null;
  switch (adapter.setpoint) {
    case 'flow_curve':
      return t('the flow temperature from the weather curve');
    case 'room_target':
      return t('the room target, corrected by the room’s sensors');
    case 'fixed':
      return t('a fixed setpoint');
    case 'none':
      return t('nothing — only on and off');
  }
}
