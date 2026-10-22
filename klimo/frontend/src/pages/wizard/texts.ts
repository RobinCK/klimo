/**
 * Words of the add-room wizard: the device rows' details and the server's step checks in plain
 * language (the generic field texts cover the rest).
 */
import type { ApiErrorIssue, CreateRoomRequest, CreateRoomStep, DiscoveryCandidate, EntityRolePreset, WizardDeviceRole } from '@api/model';
import { fmtKw, fmtTemp, issueText, renderReason, t, type CodeContext } from '@i18n';

const FEATURE: Partial<Record<DiscoveryCandidate['features'][number], () => string>> = {
  external_sensor: () => t('ext. sensor ✓'),
  calibration: () => t('offset ✓'),
  child_lock: () => t('lock ✓'),
  valve_position: () => t('valve position ✓'),
};

/** «SONOFF TRVZB · зовн. датчик ✓ · замок ✓ · LQI 115». */
export function candidateMeta(c: DiscoveryCandidate, roomName: (id: string) => string): string {
  const parts: string[] = [];
  if (c.model) parts.push(c.model);
  for (const f of c.features) {
    const text = FEATURE[f]?.();
    if (text) parts.push(text);
  }
  if (c.powerKw != null && c.powerKw > 0) parts.push(fmtKw(c.powerKw));
  if (c.lqi != null) parts.push(`LQI ${c.lqi}`);
  if (c.takenByRoomId) parts.push(t('now in «{room}» — will be moved', { room: roomName(c.takenByRoomId) }));
  return parts.join(' · ');
}

const INTEGRATION: Record<string, string> = {
  zigbee2mqtt: 'Zigbee2MQTT',
  zha: 'ZHA',
  mqtt: 'MQTT',
  modbus: 'Modbus',
  zwave_js: 'Z-Wave JS',
  esphome: 'ESPHome',
  shelly: 'Shelly',
  tuya: 'Tuya',
  xiaomi_miio: 'Xiaomi',
  sonoff: 'SONOFF',
};

/** Home Assistant reports integrations by their domain; people know them by the product name. */
export function integrationName(domain: string): string {
  return INTEGRATION[domain] ?? domain;
}

/** The live value on the right of a device row. */
export function candidateValue(c: Pick<DiscoveryCandidate, 'role' | 'state' | 'valueC'>): string {
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

/** The entity search preset for a role picked with «+ Знайти інший пристрій». */
export const ROLE_PRESET: Record<WizardDeviceRole, EntityRolePreset> = {
  trv: 'trv',
  temperature: 'temperature',
  humidity: 'humidity',
  temp_humidity: 'temperature',
  window: 'contact',
  door: 'contact',
  ac: 'ac',
  heater: 'switchable',
  floor_zone: 'switchable',
  floor_probe: 'temperature',
  dehumidifier: 'switchable',
};

function deviceOf(req: CreateRoomRequest, path: string): string {
  const m = /^devices\.(\d+)/.exec(path);
  const d = m ? req.devices[Number(m[1])] : undefined;
  return d ? d.name || d.entityId : '';
}

/** A step check in words. */
export function wizardIssue(issue: ApiErrorIssue, req: CreateRoomRequest): string {
  const p = issue.params ?? {};
  const path = issue.path;
  const device = deviceOf(req, path);
  if (path === 'name') {
    if (issue.code === 'required') return t('Give the room a name.');
    if (issue.code === 'unique') return t('A room with this name already exists.');
    if (issue.code === 'length') return t('The name is up to 40 characters.');
  }
  if (path === 'emitterKinds' && issue.code === 'min_items') return t('Choose at least one thing that heats or cools the room.');
  if (path === 'haAreaId' && issue.code === 'not_found') return t('This area no longer exists in Home Assistant.');
  if (path === 'devices') {
    if (issue.code === 'needs_temperature') return t('Pick a temperature sensor, or a radiator valve that measures the room.');
    if (issue.code === 'required') {
      if (p.role === 'trv') return t('Pick at least one radiator valve.');
      if (p.role === 'ac') return t('Pick the air conditioner.');
      if (p.role === 'heater') return t('Pick the heater.');
    }
  }
  if (path.startsWith('devices.')) {
    if (issue.code === 'bound_elsewhere') return t('«{device}» belongs to «{room}» — tick it to move it here.', { device, room: String(p.room ?? '') });
    if (issue.code === 'in_use') return t('«{device}» is used by the source «{source}».', { device, source: String(p.source ?? '') });
    if (issue.code === 'unexpected') return t('«{device}» does not fit what heats or cools the room.', { device });
    if (issue.code === 'not_found') return t('«{device}» is not in Home Assistant.', { device });
    if (issue.code === 'domain') return t('«{device}» is the wrong kind of entity for its role.', { device });
    if (issue.code === 'unique') return t('«{device}» is picked twice.', { device });
  }
  if (path.startsWith('circuits.')) {
    if (issue.code === 'required') return t('Choose the floor circuit, or the pump of a new one.');
    if (issue.code === 'unique') return t('This pump already drives another circuit.');
    if (issue.code === 'not_found') return t('This circuit or pump no longer exists.');
  }
  if (path === 'method' && issue.code === 'needs_sensor') return t('«Main sensor» needs a temperature sensor.');
  if (path.startsWith('heatTolerance') || path.startsWith('coolTolerance')) return t('The tolerance is from 0.1° to 1.0°.');
  if (path === 'trvStrategy' && issue.code === 'unsupported') return t('{entity} cannot be controlled this way.', { entity: String(p.entityId ?? '') });
  return issueText(issue);
}

/** One line of the result list after «Створити кімнату». */
export function stepWords(s: CreateRoomStep, ctx: CodeContext): { title: string; text: string } {
  const entity = s.entityId ?? '';
  const failed = s.status === 'failed';
  const pending = s.status === 'pending';
  const why = s.error ? renderReason(s.error, ctx) : '';
  switch (s.kind) {
    case 'room_created':
      return { title: t('The room is created'), text: entity };
    case 'trv_target':
      if (pending) return { title: t('Sending the target to the valve…'), text: entity };
      if (failed) return { title: t('The valve did not confirm the target'), text: why || entity };
      return {
        title: t('The valve got the target {t}', { t: fmtTemp(s.valueC) }),
        text: s.latencySec != null ? t('{entity} confirmed in {s} s', { entity, s: Math.round(s.latencySec) }) : entity,
      };
    case 'external_sensor':
      if (pending) return { title: t('Connecting the external sensor…'), text: entity };
      if (failed) return { title: t('The external sensor is not connected'), text: why || entity };
      return {
        title: t('The external sensor is connected'),
        text:
          s.valueC != null && s.trvOwnC != null ? t('the valve gets {t} instead of its own {own}', { t: fmtTemp(s.valueC), own: fmtTemp(s.trvOwnC) }) : entity,
      };
    case 'child_lock':
      if (pending) return { title: t('Locking the valve buttons…'), text: entity };
      if (failed) return { title: t('The child lock is not on'), text: why || entity };
      return { title: t('The child lock is on'), text: entity };
    case 'ha_entity':
      if (pending) return { title: t('Creating the entity in Home Assistant…'), text: entity };
      if (failed) return { title: t('The entity did not appear in Home Assistant'), text: why || entity };
      return { title: t('The entity is created in Home Assistant'), text: entity };
    case 'ac_mode':
      if (pending) return { title: t('Setting up the air conditioner…'), text: entity };
      if (failed) return { title: t('The air conditioner did not answer'), text: why || entity };
      return { title: t('The air conditioner is ready'), text: entity };
  }
}
