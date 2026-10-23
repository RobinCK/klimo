/**
 * Words of how a room is heated, shared by the add-room wizard and the room settings: the heating
 * kinds, the house circuit a room joins, the device groups and what taking a device away does to it.
 */
import type { ApiErrorIssue, CircuitKind, CircuitMode, HaEntityDto, IconName, RoomBinding, RoomHeatingKind, WizardDeviceRole } from '@api/model';
import { t } from './core';
import { fmtTemp } from './format';
import { wizardDeviceRoleLabel } from './labels';

/* ---------------- heating kinds ---------------- */

export const HEATING_KIND_ORDER: readonly RoomHeatingKind[] = ['trv', 'radiator_plain', 'floor', 'ac', 'local'];

/** The device roles that bring a heating kind with them (adding one ticks it). */
export const ROLE_HEATING_KIND: Partial<Record<WizardDeviceRole, RoomHeatingKind>> = {
  trv: 'trv',
  ac: 'ac',
  heater: 'local',
  floor_zone: 'floor',
  floor_probe: 'floor',
};

export const HEATING_KIND_ICON: Record<RoomHeatingKind, IconName> = {
  trv: 'radiator',
  radiator_plain: 'radiator',
  floor: 'floor',
  ac: 'ac',
  local: 'convector',
};

/** A heating kind as a choice: its name and one line on what it means for the room. */
export function heatingKindWords(k: RoomHeatingKind, product: string): { title: string; hint: string } {
  switch (k) {
    case 'trv':
      return { title: t('Radiators with smart heads'), hint: t('Zigbee or Wi-Fi heads and thermostats: {product} turns each one to the room’s target.', { product }) };
    case 'radiator_plain':
      return {
        title: t('Radiators with ordinary valves'),
        hint: t('Hand valves or mechanical thermostatic heads, no device needed: {product} switches the boiler or heat pump and the radiator pump by the room temperature.', { product }),
      };
    case 'floor':
      return { title: t('Underfloor heating'), hint: t('The room joins the house floor circuit; a zone valve of its own only if the floor is split into zones.') };
    case 'ac':
      return { title: t('Air conditioner'), hint: t('Cools, and can top up the heat.') };
    case 'local':
      return { title: t('Own heater'), hint: t('An electric heater on a relay, a plug or its own thermostat.') };
  }
}

/* ---------------- house circuits ---------------- */

/** How a house circuit runs, in the words of the system page. */
export function circuitModeWords(mode: CircuitMode, kind: CircuitKind, runOnMin: number | null): { title: string; hint: string } {
  const runOn = runOnMin ?? (kind === 'floor' ? 10 : 3);
  if (kind === 'floor') {
    return mode === 'zoned'
      ? {
          title: t('By zones — a valve in each room'),
          hint: t('A room colder than its target opens its zone valve; the floor pump runs while any zone is open and {min} min after the last one closes.', { min: runOn }),
        }
      : {
          title: t('The whole floor — together with the source'),
          hint: t('The floor pump runs whenever the boiler or heat pump runs, and {min} min after it stops. A room colder than its target starts the source.', { min: runOn }),
        };
  }
  return mode === 'zoned'
    ? { title: t('By the rooms'), hint: t('The radiator pump runs while a room asks for heat, and {min} min after.', { min: runOn }) }
    : { title: t('Together with the source'), hint: t('The radiator pump runs whenever the boiler or heat pump runs, and {min} min after it stops.', { min: runOn }) };
}

/** «Насос «Насос підлоги» · також гріє: Кухня, Ванна». */
export function circuitLine(pumpNames: readonly string[], otherRooms: readonly string[]): string {
  const parts = [
    pumpNames.length ? t('pump: {pumps}', { pumps: pumpNames.join(', ') }) : t('no pump of its own — the source runs the water'),
    otherRooms.length ? t('also on it: {rooms}', { rooms: otherRooms.join(', ') }) : t('no other rooms on it yet'),
  ];
  return parts.join(' · ');
}

/* ---------------- device groups ---------------- */

/** The blocks devices are listed in (the wizard's device step and room settings). */
export type DeviceGroup = 'trv' | 'temp' | 'window' | 'ac' | 'heater' | 'floor' | 'dehum';

export const DEVICE_GROUP_ORDER: readonly DeviceGroup[] = ['trv', 'temp', 'window', 'ac', 'heater', 'floor', 'dehum'];

export const DEVICE_GROUP_ROLES: Record<DeviceGroup, readonly WizardDeviceRole[]> = {
  trv: ['trv'],
  temp: ['temp_humidity', 'temperature', 'humidity'],
  window: ['window', 'door'],
  ac: ['ac'],
  heater: ['heater'],
  floor: ['floor_zone', 'floor_probe'],
  dehum: ['dehumidifier'],
};

export function deviceGroupOf(role: WizardDeviceRole): DeviceGroup {
  return (Object.keys(DEVICE_GROUP_ROLES) as DeviceGroup[]).find((k) => DEVICE_GROUP_ROLES[k].includes(role)) ?? 'temp';
}

/** What a block's own search looks for. */
export const DEVICE_GROUP_SEARCH: Record<DeviceGroup, WizardDeviceRole> = {
  trv: 'trv',
  temp: 'temperature',
  window: 'window',
  ac: 'ac',
  heater: 'heater',
  floor: 'floor_zone',
  dehum: 'dehumidifier',
};

/** What «Додати пристрій» searches for in a block: a floor that runs as a whole takes a floor probe only. */
export function deviceGroupSearchRoles(k: DeviceGroup, floorZoned = true): WizardDeviceRole[] {
  return k === 'floor' && !floorZoned ? ['floor_probe'] : [...DEVICE_GROUP_ROLES[k]];
}

/** The role a found entity takes in a block: its own likeliest one that fits, else the block's own. */
export function roleInGroup(e: HaEntityDto, k: DeviceGroup, floorZoned = true): WizardDeviceRole {
  const fits = (r: WizardDeviceRole) => deviceGroupSearchRoles(k, floorZoned).includes(r);
  return e.wizard?.suggested.find(fits) ?? e.wizard?.possible.find(fits) ?? (k === 'floor' && !floorZoned ? 'floor_probe' : DEVICE_GROUP_SEARCH[k]);
}

/** A source's own climate or relay cannot be a room's head, AC, heater or zone valve too (the server refuses it). */
export function sourceBlockText(e: HaEntityDto, role: WizardDeviceRole): string | null {
  const source = e.usedBy.find((u) => u.type === 'source');
  if (!source || !(['trv', 'ac', 'heater', 'floor_zone'] as WizardDeviceRole[]).includes(role)) return null;
  return t('the source «{source}» switches it — it cannot be a room device too', { source: source.label });
}

export const DEVICE_ROLE_ICON: Record<WizardDeviceRole, IconName> = {
  trv: 'radiator',
  temperature: 'thermometer',
  humidity: 'droplet',
  temp_humidity: 'thermometer',
  window: 'windowClosed',
  door: 'windowClosed',
  ac: 'ac',
  heater: 'convector',
  floor_zone: 'floor',
  floor_probe: 'floor',
  dehumidifier: 'droplet',
};

/** What a device is, on chips and in «Use as…». */
export function deviceRoleLabel(role: WizardDeviceRole): string {
  return wizardDeviceRoleLabel(role);
}

/** A device block: its title, the quiet tag beside it, what belongs in it and what it is called in «Що це» of «Додати пристрій». */
export function deviceGroupWords(k: DeviceGroup): { title: string; tag: string; hint: string; what: string } {
  switch (k) {
    case 'trv':
      return {
        title: t('Smart radiator heads'),
        tag: t('a smart head or a thermostat'),
        hint: t('A Zigbee or Wi-Fi head on the radiator, or the thermostat that drives it.'),
        what: t('Smart radiator head or thermostat'),
      };
    case 'temp':
      return {
        title: t('Temperature and humidity'),
        tag: t('for the calculation'),
        hint: t('A sensor away from the radiator and the window measures the room best.'),
        what: t('Temperature or humidity sensor'),
      };
    case 'window':
      return {
        title: t('Windows and doors'),
        tag: t('optional'),
        hint: t('A contact sensor pauses heating while the window is open.'),
        what: t('Window or door sensor'),
      };
    case 'ac':
      return {
        title: t('Air conditioner'),
        tag: t('cold and top-up heat'),
        hint: t('The climate entity of the split unit.'),
        what: t('Air conditioner'),
      };
    case 'heater':
      return {
        title: t('Heater'),
        tag: t('a relay or a plug'),
        hint: t('A relay, a smart plug or the climate entity of an electric heater.'),
        what: t('Heater, relay or plug'),
      };
    case 'floor':
      return {
        title: t('Underfloor heating'),
        tag: t('the house floor circuit'),
        hint: t('A floor probe or, on a floor split into zones, the zone valve of this room.'),
        what: t('Floor zone valve or floor probe'),
      };
    case 'dehum':
      return {
        title: t('Dehumidifier'),
        tag: t('optional'),
        hint: t('A dehumidifier entity, or the plug it hangs on.'),
        what: t('Dehumidifier'),
      };
  }
}

/** The live value on the right of a device row. */
export function deviceValueText(c: { role: WizardDeviceRole; state: string | null; valueC: number | null }): string {
  if (c.valueC != null && (c.role === 'trv' || c.role === 'temperature' || c.role === 'temp_humidity' || c.role === 'floor_probe')) return fmtTemp(c.valueC);
  const s = c.state;
  if (s == null || s === 'unavailable' || s === 'unknown') return '—';
  if (c.role === 'window' || c.role === 'door') return s === 'on' ? t('open') : t('closed');
  if (s === 'off') return t('off');
  if (s === 'on') return t('on');
  if (s === 'heat') return t('heating');
  if (s === 'cool') return t('cooling');
  if (c.role === 'humidity' && Number.isFinite(Number(s))) return `${s}%`;
  return s;
}

/** The value on the right of a search result: a room temperature where there is one. */
export function entityValueText(e: HaEntityDto): string | null {
  if (!e.available) return null;
  if (e.valueC != null) return fmtTemp(e.valueC);
  const role = e.wizard?.suggested[0];
  return role ? deviceValueText({ role, state: e.state, valueC: null }) : null;
}

/** The room a search result belongs to now: picking it moves it. */
export function entityRoomNote(e: HaEntityDto, roomId?: string): string | null {
  const room = e.usedBy.find((u) => u.type === 'room' && u.id !== roomId);
  return room ? t('now in «{room}» — will be moved', { room: room.label }) : null;
}

/* ---------------- taking a device away ---------------- */

/** What removing a bound device does to it (the confirmation says it before, the toast after). */
export function releaseWords(b: Pick<RoomBinding, 'release' | 'role'>, releaseC: number): string {
  switch (b.release) {
    case 'trv_handback':
      return t('The head gets its own setpoint back ({t}) and regulates by itself again.', { t: fmtTemp(releaseC) });
    case 'switch_off':
      return t('It is switched off now and no longer driven from here.');
    case 'zone_open':
      return t('The zone valve is left open, so this part of the floor keeps getting heat with the rest of the loop.');
    case 'zone_close':
      return t('The zone valve is closed (the loop also cools).');
    case 'none':
      return b.role === 'window' || b.role === 'door'
        ? t('An open window no longer pauses the room.')
        : t('The room stops reading it; the device itself is not changed.');
  }
}

/* ---------------- server checks ---------------- */

/** The heating-model checks in words (the wizard and room settings say them where they belong). */
export function heatingIssueText(issue: ApiErrorIssue): string | null {
  const p = issue.params ?? {};
  switch (issue.code) {
    case 'no_heat_source':
      return t('No boiler or heat pump feeds this radiator circuit, so ordinary radiators would never get warm. Add the heat source on the system page first.');
    case 'needs_call':
      return t('Ordinary radiators heat only when the room may start the boiler or heat pump — tick «Can start the sources».');
    case 'circuit_not_zoned':
      return t('The floor heats as a whole, so a zone valve of one room is not used. Switch the floor circuit to zones on the system page, or leave the valve out.');
    case 'needs_kind':
      return p.kind === 'floor' ? t('Switch on underfloor heating for the room first.') : t('Add what this device belongs to first.');
    case 'last_temperature':
      return t('This is the room’s only temperature: without it the room can neither heat nor protect itself from frost.');
    case 'unexpected':
      return t('This device does not fit what heats or cools the room.');
    case 'needs_temperature':
      return t('The room needs a temperature: add a temperature sensor first.');
    case 'min_items':
      return issue.path === 'kinds' || issue.path === 'emitterKinds' ? t('Something has to heat or cool the room.') : null;
    case 'required':
      if (p.reason === 'choose') return t('The house has several such circuits — choose the one the room is on.');
      if (p.reason === 'setup') return t('The house has no underfloor heating yet — set it up once below.');
      return null;
    default:
      return null;
  }
}
