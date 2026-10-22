import type { ConditionEval, ConditionNode, ConditionPreviewResult, HaEntityDto } from '@api/model';
import { PROFILE_COLORS } from '../../tokens/base';

/** Entities for the pickers in the gallery (a small fake registry). */
export const GALLERY_ENTITIES: HaEntityDto[] = [
  entity('sensor.living_sofa_temperature', 'Living room sofa temperature', 'sensor', '19.7', '°C', 'Living room', ['Living room']),
  entity('sensor.living_shelf_temperature', 'Living room shelf temperature', 'sensor', '19.8', '°C', 'Living room', []),
  entity('sensor.outdoor_temperature', 'Outdoor temperature', 'sensor', '4.2', '°C', null, ['Settings']),
  entity('binary_sensor.grid_offline', 'Grid offline', 'binary_sensor', 'off', null, null, ['Blackout']),
  entity('climate.heat_pump', 'Heat pump', 'climate', 'heat', null, 'Boiler room', ['Heat pump']),
  entity('switch.radiator_pump', 'Radiator pump', 'switch', 'on', null, 'Boiler room', ['Radiators']),
  entity('sensor.kitchen_shelf_temperature', 'Kitchen shelf temperature', 'sensor', null, '°C', 'Kitchen', ['Kitchen'], false),
  entity('weather.home', 'Home', 'weather', 'cloudy', null, null, []),
];

function entity(
  entityId: string,
  name: string,
  domain: string,
  state: string | null,
  unit: string | null,
  areaName: string | null,
  usedBy: string[],
  available = true,
): HaEntityDto {
  return {
    entityId,
    name,
    domain,
    deviceClass: null,
    unit,
    state,
    available,
    areaId: areaName ? areaName.toLowerCase().replace(/\s+/g, '_') : null,
    areaName,
    deviceId: null,
    deviceName: null,
    model: null,
    manufacturer: null,
    integration: null,
    usedBy: usedBy.map((label) => ({ type: 'room', id: null, label })),
  };
}

/** Registry search: substring over id and name, answered after a short delay like the server. */
export function gallerySearch(q: string): Promise<HaEntityDto[]> {
  const needle = q.trim().toLowerCase();
  const hits = GALLERY_ENTITIES.filter((e) => !needle || e.entityId.includes(needle) || e.name.toLowerCase().includes(needle));
  return new Promise((resolve) => window.setTimeout(() => resolve(hits), 120));
}

const OUTDOOR_C = 4.2;

/** A small stand-in for the server's condition evaluation (outdoor 4.2°, grid present). */
function fakeEval(node: ConditionNode, path: string): ConditionEval {
  const id = node.id ?? path;
  switch (node.op) {
    case 'all':
    case 'any': {
      const children = node.items.map((n, i) => fakeEval(n, `${path}.${i}`));
      const met = node.op === 'all' ? children.length > 0 && children.every((c) => c.met) : children.some((c) => c.met);
      const unknown = children.some((c) => c.status === 'unknown');
      return { id, met, status: unknown && !met ? 'unknown' : 'ok', children };
    }
    case 'not': {
      const child = fakeEval(node.item, `${path}.0`);
      return { id, met: child.status === 'ok' && !child.met, status: child.status, children: [child] };
    }
    case 'outdoor': {
      const v = OUTDOOR_C;
      const met = node.cmp === '<' ? v < node.value : node.cmp === '<=' ? v <= node.value : node.cmp === '>' ? v > node.value : v >= node.value;
      return { id, met, status: 'ok', value: `${v}°` };
    }
    case 'grid':
      return { id, met: node.is === 'present', status: 'ok' };
    case 'const':
      return { id, met: node.value, status: 'ok' };
    case 'state':
    case 'numeric':
    case 'weather': {
      const e = GALLERY_ENTITIES.find((x) => x.entityId === node.entityId);
      if (!e || !e.available) return { id, met: false, status: 'unknown', value: null };
      return { id, met: node.op === 'state' ? node.equals.includes(e.state ?? '') : false, status: 'ok', value: e.state };
    }
    default:
      return { id, met: false, status: 'ok' };
  }
}

export function galleryPreview(node: ConditionNode): Promise<ConditionPreviewResult> {
  const ids = new Set<string>();
  const walk = (n: ConditionNode) => {
    if (n.op === 'all' || n.op === 'any') n.items.forEach(walk);
    else if (n.op === 'not') walk(n.item);
    else if ((n.op === 'state' || n.op === 'numeric' || n.op === 'weather') && n.entityId) ids.add(n.entityId);
  };
  walk(node);
  const entities = [...ids].map((entityId) => {
    const e = GALLERY_ENTITIES.find((x) => x.entityId === entityId);
    return { entityId, state: e?.state ?? null, available: e?.available ?? false };
  });
  return new Promise((resolve) => window.setTimeout(() => resolve({ eval: fakeEval(node, 'root'), entities }), 200));
}

export const GALLERY_CONDITION: ConditionNode = {
  op: 'all',
  items: [
    { op: 'outdoor', cmp: '<', value: 0, exitAt: 2, basis: 'avg10m' },
    { op: 'not', item: { op: 'grid', is: 'absent' } },
    { op: 'state', entityId: 'binary_sensor.grid_offline', equals: ['off'] },
  ],
};

export const GALLERY_PALETTE = PROFILE_COLORS;
