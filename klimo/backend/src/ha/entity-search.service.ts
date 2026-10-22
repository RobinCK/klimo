import { Inject, Injectable, Logger } from '@nestjs/common';
import { errorText } from '../common/logger';
import type {
  AreaDiscoveryDto,
  DeviceTransport,
  DiscoveryCandidate,
  EntityId,
  HaAreaDto,
  HaEntityDetailDto,
  HaEntityDto,
  HaEntityQuery,
  HaPort,
  IConfigStore,
  IEntitySearch,
  NotifyServiceDto,
  UsageRef,
  WizardRoleHint,
} from '../shared/model';
import { CONFIG_STORE, HA_PORT } from '../tokens';
import {
  DISCOVERY_ROLE_ORDER,
  discoveryGuess,
  fanModes,
  hvacModes,
  isHumiditySensor,
  isPowerSensor,
  isTemperatureSensor,
  isValvePosition,
  looksLikeTrv,
  matchesRole,
  setpointStepC,
  type DeviceContext,
  type EntityFacts,
  type SiblingRef,
  siblingRole,
  trvCapabilities,
  trvSiblings,
  trvStrategies,
  wizardRoles,
} from './classify';
import { type EntityRecord, RegistryService } from './registry.service';
import { haSlug, matchScore, SCORE, searchKey } from './search-text';
import { isAvailableState, parseNumber, powerKw, stateValue, tempAttr, tempUnit, type TempUnit } from './units';

const NUMBER_DOMAINS = new Set(['number', 'input_number']);

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const PRESELECT_CONFIDENCE = 0.7;
/** In the add-room wizard the room's area outranks a better-worded match elsewhere, not an exact id. */
const NEAR_AREA = 25;
/** Wizard search for a role: the entities whose likeliest role it is come first. */
const ROLE_FIRST = 15;
const ROLE_ALSO = 8;
/** The plant's own equipment (a source, a pump, a circuit sensor) is rarely a room device: last. */
const PLANT_LAST = 20;
/** Another room's device can move here, but the free ones come first. */
const OTHER_ROOM = 5;
/** Devices «Не використовуються в Klimo» lists only what is clearly a climate device. */
const UNASSIGNED_CONFIDENCE = 0.5;

/** `get_services` is not part of the port (the simulator has no service registry); used when present. */
interface ServiceRegistry {
  services(): Promise<Record<string, Record<string, unknown>>>;
}

function hasServiceRegistry(ha: HaPort): ha is HaPort & ServiceRegistry {
  return typeof (ha as Partial<ServiceRegistry>).services === 'function';
}

/** Consonant skeleton: HA slugs Cyrillic device names with its own transliteration (г → g, KMU says h). */
function skeleton(slug: string): string {
  return slug.replace(/kh/g, 'h').replace(/[gh]/g, 'h').replace(/[aeiouy_]/g, '');
}

/**
 * Entity pickers, area discovery for the add-room wizard, TRV/AC heuristics with sibling
 * classification, notify services, persons and calendars — everything the UI asks about HA entities.
 */
@Injectable()
export class EntitySearchService implements IEntitySearch {
  private readonly log = new Logger('EntitySearch');

  constructor(
    @Inject(HA_PORT) private readonly ha: HaPort,
    @Inject(CONFIG_STORE) private readonly config: IConfigStore,
    @Inject(RegistryService) private readonly registry: RegistryService,
  ) {}

  /* ── pickers ───────────────────────────────────────────────────────────────────────────────── */

  search(q: HaEntityQuery): HaEntityDto[] {
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(q.limit ?? DEFAULT_LIMIT)));
    const query = (q.q ?? '').trim();
    const referenced = new Set(this.config.referencedEntities());
    const nearArea = q.nearRoomId ? this.config.room(q.nearRoomId)?.haAreaId ?? null : null;
    const domains = q.domain?.length ? new Set(q.domain) : null;
    const classes = q.deviceClass?.length ? new Set(q.deviceClass) : null;

    const hits: { r: EntityRecord; score: number; name: string; wizard: WizardRoleHint | null }[] = [];
    for (const r of this.registry.records()) {
      if (this.registry.isOwn(r) || r.reg?.disabled_by) continue;
      if (domains && !domains.has(r.domain)) continue;
      if (q.areaId && r.areaId !== q.areaId) continue;
      if (q.unassigned && referenced.has(r.entityId)) continue;
      const f = this.registry.facts(r);
      if (classes && !(f.deviceClass && classes.has(f.deviceClass))) continue;
      if (q.role && !matchesRole(q.role, f, this.siblingRefs(r).map((s) => s.role))) continue;
      const wizard = q.wizard ? this.wizardHint(r, f) : null;
      if (q.wizard && (!wizard || (q.wizard !== 'any' && !wizard.possible.includes(q.wizard)))) continue;

      let score = 0;
      if (query) {
        score = matchScore(query, {
          entityId: r.entityId,
          name: f.name,
          areaName: f.areaName,
          deviceName: this.registry.deviceName(r.device),
          extra: [f.model, r.device?.manufacturer ?? null, this.registry.integration(r)],
        });
        if (!score) continue;
        // hidden entities appear only when the query names them
        if (r.reg?.hidden_by && score < SCORE.idPrefix) continue;
      } else if (r.reg?.hidden_by) continue;
      if (isAvailableState(f.state?.state)) score += SCORE.available;
      if (nearArea && r.areaId === nearArea) score += SCORE.nearRoom;
      if (q.nearAreaId && r.areaId === q.nearAreaId) score += NEAR_AREA;
      if (wizard && q.wizard && q.wizard !== 'any') score += wizard.suggested[0] === q.wizard ? ROLE_FIRST : wizard.suggested.includes(q.wizard) ? ROLE_ALSO : 0;
      if (wizard && referenced.has(r.entityId)) {
        const uses = this.config.usages({ type: 'entity', id: r.entityId });
        score -= uses.some((u) => u.type === 'source' || u.type === 'pump' || u.type === 'circuit') ? PLANT_LAST : uses.some((u) => u.type === 'room') ? OTHER_ROOM : 0;
      }
      hits.push({ r, score, name: f.name, wizard });
    }
    hits.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'uk') || a.r.entityId.localeCompare(b.r.entityId));
    const haUnit = this.registry.haUnit();
    return hits.slice(0, limit).map((h) => {
      const dto = this.registry.toDto(h.r, this.usedBy(h.r.entityId, referenced), h.score);
      if (h.wizard) {
        dto.wizard = h.wizard;
        dto.valueC = this.valueC(h.r, haUnit);
      }
      return dto;
    });
  }

  /** What an entity can be in the add-room wizard, judged with its device's other entities. */
  private wizardHint(r: EntityRecord, f: EntityFacts): WizardRoleHint | null {
    return wizardRoles(f, this.deviceContext(r));
  }

  private deviceContext(r: EntityRecord): DeviceContext {
    const siblingFacts = this.registry.siblings(r).map((s) => this.registry.facts(s));
    return {
      siblingRoles: this.siblingRefs(r).map((s) => s.role),
      hasClimate: siblingFacts.some((s) => s.domain === 'climate'),
      hasTemperature: siblingFacts.some(isTemperatureSensor),
      hasHumidity: siblingFacts.some(isHumiditySensor),
    };
  }

  private valueC(r: EntityRecord, haUnit: TempUnit): number | null {
    const f = this.registry.facts(r);
    if (r.domain === 'climate') return tempAttr(f.state, 'current_temperature', haUnit);
    return isTemperatureSensor(f) || (NUMBER_DOMAINS.has(r.domain) && tempUnit(f.unit) !== null) ? stateValue(f.state, haUnit) : null;
  }

  private usedBy(entityId: EntityId, referenced: Set<EntityId>): UsageRef[] {
    return referenced.has(entityId) ? this.config.usages({ type: 'entity', id: entityId }) : [];
  }

  /* ── detail ────────────────────────────────────────────────────────────────────────────────── */

  private siblingRefs(r: EntityRecord): SiblingRef[] {
    return this.registry.siblings(r).map((s) => {
      const f = this.registry.facts(s);
      return { role: siblingRole(f), valvePosition: isValvePosition(f), entityId: s.entityId, state: f.state };
    });
  }

  detail(entityId: EntityId): HaEntityDetailDto | null {
    const r = this.registry.record(entityId);
    const state = this.ha.getState(entityId);
    if (!r && !state) return null;
    const rec = r ?? { entityId, domain: entityId.split('.')[0], key: entityId.split('.')[1] ?? '', reg: null, device: null, areaId: null };
    const referenced = new Set(this.config.referencedEntities());
    const siblings = this.siblingRefs(rec);
    const f = this.registry.facts(rec);
    const haUnit = this.registry.haUnit();

    let trv: HaEntityDetailDto['trv'] = null;
    if (looksLikeTrv(f, siblings.map((s) => s.role))) {
      const sib = trvSiblings(siblings);
      const capabilities = trvCapabilities(state, sib, siblings, haUnit);
      trv = { capabilities, siblings: sib, strategies: trvStrategies(capabilities) };
    }
    const climate: HaEntityDetailDto['climate'] =
      rec.domain === 'climate'
        ? {
            hvacModes: hvacModes(state),
            fanModes: fanModes(state),
            minTemp: tempAttr(state, 'min_temp', haUnit),
            maxTemp: tempAttr(state, 'max_temp', haUnit),
            step: setpointStepC(state, haUnit),
          }
        : null;
    return {
      entity: this.registry.toDto(rec, this.usedBy(entityId, referenced)),
      attributes: { ...(state?.attributes ?? {}) },
      siblings: siblings.map((s) => ({ role: s.role, entityId: s.entityId })),
      trv,
      climate,
    };
  }

  /* ── areas and discovery ───────────────────────────────────────────────────────────────────── */

  areas(): HaAreaDto[] {
    const devicesByArea = new Map<string, Set<string>>();
    for (const r of this.registry.records()) {
      if (!r.areaId || this.registry.isOwn(r) || r.reg?.disabled_by) continue;
      const set = devicesByArea.get(r.areaId) ?? new Set<string>();
      set.add(this.registry.deviceKey(r));
      devicesByArea.set(r.areaId, set);
    }
    return this.registry
      .areas()
      .map((a) => ({ areaId: a.areaId, name: a.name, deviceCount: devicesByArea.get(a.areaId)?.size ?? 0 }))
      .sort((a, b) => a.name.localeCompare(b.name, 'uk'));
  }

  discoverArea(areaId: string): AreaDiscoveryDto {
    const records = this.registry.records().filter((r) => r.areaId === areaId);
    const candidates = this.classify(records, true);
    const integrations = [...new Set(records.flatMap((r) => (candidates.some((c) => c.entityId === r.entityId) ? [this.registry.integration(r)] : [])))]
      .filter((x): x is string => !!x);
    return { areaId, areaName: this.registry.areaName(areaId) ?? areaId, integrations, candidates };
  }

  unassigned(): DiscoveryCandidate[] {
    const referenced = new Set(this.config.referencedEntities());
    const free = this.registry.records().filter((r) => !referenced.has(r.entityId));
    return this.classify(free, false).filter((c) => c.confidence >= UNASSIGNED_CONFIDENCE);
  }

  private classify(records: EntityRecord[], wizard: boolean): DiscoveryCandidate[] {
    const referenced = new Set(this.config.referencedEntities());
    const haUnit = this.registry.haUnit();
    const out: DiscoveryCandidate[] = [];
    for (const r of records) {
      if (this.registry.isOwn(r) || r.reg?.disabled_by || r.reg?.hidden_by) continue;
      const f = this.registry.facts(r);
      const siblings = this.siblingRefs(r);
      const ctx = this.deviceContext(r);
      const guess = discoveryGuess(f, ctx);
      if (!guess) continue;
      const possible = wizardRoles(f, ctx)?.possible ?? [];

      const available = isAvailableState(f.state?.state);
      const confidence = Math.round((available ? guess.confidence : guess.confidence * 0.8) * 100) / 100;
      const takenByRoomId = referenced.has(r.entityId)
        ? this.config.usages({ type: 'entity', id: r.entityId }).find((u) => u.type === 'room')?.id ?? null
        : null;
      const features: DiscoveryCandidate['features'] = [];
      const roles = new Set(siblings.map((s) => s.role));
      if (roles.has('external_temp')) features.push('external_sensor');
      if (roles.has('calibration')) features.push('calibration');
      if (roles.has('child_lock')) features.push('child_lock');
      if (roles.has('window_detection')) features.push('window_detection');
      if (siblings.some((s) => s.valvePosition)) features.push('valve_position');
      const power = siblings.find((s) => s.role === 'power');
      if (power) features.push('power_sensor');
      const lqi = siblings.find((s) => s.role === 'linkquality');

      out.push({
        role: guess.role,
        entityId: r.entityId,
        name: f.name,
        model: r.device?.model ?? null,
        lqi: lqi ? parseNumber(lqi.state?.state) : null,
        features,
        state: f.state?.state ?? null,
        valueC: r.domain === 'climate' ? tempAttr(f.state, 'current_temperature', haUnit) : isTemperatureSensor(f) ? stateValue(f.state, haUnit) : null,
        powerKw: isPowerSensor(f) ? powerKw(f.state) : power ? powerKw(power.state) : null,
        confidence,
        preselected: wizard && confidence >= PRESELECT_CONFIDENCE && takenByRoomId === null,
        takenByRoomId: wizard ? takenByRoomId : null,
        possibleRoles: [guess.role, ...possible.filter((x) => x !== guess.role)],
      });
    }
    const rank = (role: DiscoveryCandidate['role']) => DISCOVERY_ROLE_ORDER.indexOf(role);
    return out.sort((a, b) => rank(a.role) - rank(b.role) || b.confidence - a.confidence || a.name.localeCompare(b.name, 'uk'));
  }

  /* ── notify services, persons, calendars ───────────────────────────────────────────────────── */

  async notifyServices(): Promise<NotifyServiceDto[]> {
    const mobileDevices = this.ha.registries().devices.filter((d) => d.identifiers.some(([domain]) => domain === 'mobile_app'));
    let names: string[];
    if (hasServiceRegistry(this.ha) && this.ha.connected) {
      try {
        names = Object.keys((await this.ha.services()).notify ?? {});
      } catch (e) {
        this.log.warn(`get_services failed: ${errorText(e)}`);
        names = this.derivedNotifyNames(mobileDevices);
      }
    } else {
      names = this.derivedNotifyNames(mobileDevices);
    }
    const userByTracker = this.userByDeviceTracker();
    return names
      .filter((n) => n !== 'notify' && n !== 'send_message' && n !== 'persistent_notification')
      .map((n) => {
        const mobile = n.startsWith('mobile_app_');
        const device = mobile ? this.mobileDevice(n.slice('mobile_app_'.length), mobileDevices) : null;
        const deviceName = device ? this.registry.deviceName(device) : null;
        let haUserId: string | null = null;
        if (device) {
          for (const e of this.registry.deviceEntities(device.id)) {
            if (e.domain === 'device_tracker' && userByTracker.has(e.entityId)) haUserId = userByTracker.get(e.entityId) ?? null;
          }
        }
        return { service: `notify.${n}`, name: deviceName ?? humanize(n), deviceName, haUserId, mobile };
      })
      .sort((a, b) => Number(b.mobile) - Number(a.mobile) || a.service.localeCompare(b.service));
  }

  /** Without a service registry, mobile app services follow from the device registry. */
  private derivedNotifyNames(mobileDevices: { name: string | null }[]): string[] {
    return mobileDevices.filter((d) => d.name).map((d) => `mobile_app_${haSlug(d.name ?? '')}`);
  }

  private mobileDevice<D extends { name: string | null }>(slug: string, devices: D[]): D | null {
    return (
      devices.find((d) => d.name && haSlug(d.name) === slug) ??
      devices.find((d) => d.name && skeleton(haSlug(d.name)) === skeleton(slug)) ??
      (devices.length === 1 ? devices[0] : null)
    );
  }

  private userByDeviceTracker(): Map<EntityId, string> {
    const out = new Map<EntityId, string>();
    for (const p of this.ha.allStates()) {
      if (!p.entity_id.startsWith('person.')) continue;
      const user = p.attributes.user_id;
      const trackers = p.attributes.device_trackers;
      if (typeof user !== 'string' || !Array.isArray(trackers)) continue;
      for (const t of trackers) if (typeof t === 'string') out.set(t, user);
    }
    return out;
  }

  persons(): { entityId: EntityId; name: string; state: string; userId: string | null }[] {
    return this.ha
      .allStates()
      .filter((s) => s.entity_id.startsWith('person.'))
      .map((s) => ({
        entityId: s.entity_id,
        name: typeof s.attributes.friendly_name === 'string' ? s.attributes.friendly_name : s.entity_id,
        state: s.state,
        userId: typeof s.attributes.user_id === 'string' ? s.attributes.user_id : null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'uk'));
  }

  calendars(): { entityId: EntityId; name: string }[] {
    return this.ha
      .allStates()
      .filter((s) => s.entity_id.startsWith('calendar.'))
      .map((s) => ({ entityId: s.entity_id, name: typeof s.attributes.friendly_name === 'string' ? s.attributes.friendly_name : s.entity_id }))
      .sort((a, b) => a.name.localeCompare(b.name, 'uk'));
  }

  deviceOf(entityId: EntityId): { key: string; name: string; model: string | null; manufacturer: string | null; areaId: string | null; transport: DeviceTransport } | null {
    const r = this.registry.record(entityId);
    if (!r) return null;
    return {
      key: this.registry.deviceKey(r),
      name: this.registry.deviceName(r.device) ?? this.registry.name(r),
      model: r.device?.model ?? null,
      manufacturer: r.device?.manufacturer ?? null,
      areaId: r.areaId,
      transport: this.registry.transport(r),
    };
  }
}

function humanize(service: string): string {
  const words = searchKey(service.replace(/^mobile_app_/, '')).split(' ').filter(Boolean);
  const text = words.join(' ');
  return text ? text[0].toUpperCase() + text.slice(1) : service;
}
