import { Inject, Injectable } from '@nestjs/common';
import type { DeviceTransport, EntityId, HaEntityDto, HaPort, HaRegistries, HaStateObj, IConfigStore, Id, UsageRef } from '../shared/model';
import { CONFIG_STORE, HA_PORT } from '../tokens';
import { type EntityFacts, propertyKey } from './classify';
import { domainOf, isAvailableState, systemTempUnit, type TempUnit } from './units';

export type RegistryEntity = HaRegistries['entities'][number];
export type RegistryDevice = HaRegistries['devices'][number];

/** One HA entity with its registry entry (if any), device and effective area. */
export interface EntityRecord {
  entityId: EntityId;
  domain: string;
  key: string;
  reg: RegistryEntity | null;
  device: RegistryDevice | null;
  /** Entity area, else the device's area. */
  areaId: string | null;
}

interface Index {
  records: EntityRecord[];
  byEntity: Map<EntityId, EntityRecord>;
  byDevice: Map<string, EntityRecord[]>;
  devices: Map<string, RegistryDevice>;
  areas: Map<string, string>;
}

/** Network label of integrations that are not Zigbee (Devices «Modbus», «Wi‑Fi»). */
const NETWORK: Record<string, string> = {
  modbus: 'Modbus',
  zwave_js: 'Z-Wave',
  matter: 'Matter',
  knx: 'KNX',
  esphome: 'Wi‑Fi',
  shelly: 'Wi‑Fi',
  tuya: 'Wi‑Fi',
  tasmota: 'Wi‑Fi',
  tplink: 'Wi‑Fi',
  wled: 'Wi‑Fi',
  broadlink: 'Wi‑Fi',
  xiaomi_miio: 'Wi‑Fi',
  midea_ac_lan: 'Wi‑Fi',
  gree: 'Wi‑Fi',
  daikin: 'Wi‑Fi',
  sensibo: 'Wi‑Fi',
  mobile_app: 'Wi‑Fi',
};

const Z2M_DEVICE = /^zigbee2mqtt_(0x[0-9a-f]+)$/i;

/**
 * Joins the state cache with the entity, device and area registries. Rebuilt lazily when HA
 * reconnects, a registry changes or an entity appears/disappears; states themselves are read live.
 */
@Injectable()
export class RegistryService {
  private index: Index | null = null;

  constructor(
    @Inject(HA_PORT) private readonly ha: HaPort,
    @Inject(CONFIG_STORE) private readonly config: IConfigStore,
  ) {
    const invalidate = () => {
      this.index = null;
    };
    ha.onRegistriesUpdated(invalidate);
    ha.onConnection(invalidate);
    ha.onStateChanged((_id, next, prev) => {
      if (!next || !prev) invalidate();
    });
  }

  private build(): Index {
    if (this.index) return this.index;
    const regs = this.ha.registries();
    const devices = new Map(regs.devices.map((d) => [d.id, d]));
    const areas = new Map(regs.areas.map((a) => [a.area_id, a.name]));
    const byEntity = new Map<EntityId, EntityRecord>();
    const add = (entityId: EntityId, reg: RegistryEntity | null) => {
      const device = reg?.device_id ? devices.get(reg.device_id) ?? null : null;
      byEntity.set(entityId, {
        entityId,
        domain: domainOf(entityId),
        key: propertyKey(entityId, reg?.unique_id ?? null),
        reg,
        device,
        areaId: reg?.area_id ?? device?.area_id ?? null,
      });
    };
    for (const e of regs.entities) add(e.entity_id, e);
    // entities without a registry entry (YAML, templates without unique_id) are still pickable
    for (const s of this.ha.allStates()) if (!byEntity.has(s.entity_id)) add(s.entity_id, null);
    const byDevice = new Map<string, EntityRecord[]>();
    for (const r of byEntity.values()) {
      if (!r.device) continue;
      const list = byDevice.get(r.device.id);
      if (list) list.push(r);
      else byDevice.set(r.device.id, [r]);
    }
    this.index = { records: [...byEntity.values()], byEntity, byDevice, devices, areas };
    return this.index;
  }

  records(): EntityRecord[] {
    return this.build().records;
  }

  record(entityId: EntityId): EntityRecord | null {
    return this.build().byEntity.get(entityId) ?? null;
  }

  device(deviceId: string): RegistryDevice | null {
    return this.build().devices.get(deviceId) ?? null;
  }

  /** Other entities on the same HA device. */
  siblings(r: EntityRecord): EntityRecord[] {
    if (!r.device) return [];
    return (this.build().byDevice.get(r.device.id) ?? []).filter((x) => x.entityId !== r.entityId);
  }

  deviceEntities(deviceId: string): EntityRecord[] {
    return this.build().byDevice.get(deviceId) ?? [];
  }

  areas(): { areaId: string; name: string }[] {
    return [...this.build().areas.entries()].map(([areaId, name]) => ({ areaId, name }));
  }

  areaName(areaId: string | null): string | null {
    return areaId ? this.build().areas.get(areaId) ?? null : null;
  }

  state(entityId: EntityId): HaStateObj | undefined {
    return this.ha.getState(entityId);
  }

  haUnit(): TempUnit {
    return systemTempUnit(this.ha.config()?.unit_system.temperature);
  }

  /** Klimo's own MQTT entities never show up in pickers (without a registry entry: by their documented ids). */
  isOwn(r: EntityRecord): boolean {
    if (!r.reg) return r.entityId.slice(r.domain.length + 1).startsWith('klimo_');
    return r.reg.platform === 'mqtt' && !!r.reg.unique_id && r.reg.unique_id.startsWith('klimo_');
  }

  deviceName(d: RegistryDevice | null): string | null {
    return d ? d.name_by_user ?? d.name ?? null : null;
  }

  name(r: EntityRecord): string {
    const friendly = this.state(r.entityId)?.attributes.friendly_name;
    if (typeof friendly === 'string' && friendly.trim()) return friendly;
    if (r.reg?.name) return r.reg.name;
    const device = this.deviceName(r.device);
    if (r.reg?.original_name) return device ? `${device} ${r.reg.original_name}` : r.reg.original_name;
    return device ?? r.entityId;
  }

  /** Zigbee2MQTT devices report 'zigbee2mqtt' (their registry platform is the generic 'mqtt'). */
  integration(r: EntityRecord): string | null {
    if (this.z2mIeee(r.device) !== null) return 'zigbee2mqtt';
    if (r.reg?.platform) return r.reg.platform;
    return r.device?.identifiers[0]?.[0] ?? null;
  }

  private z2mIeee(d: RegistryDevice | null): string | null {
    for (const [domain, id] of d?.identifiers ?? []) {
      const m = domain === 'mqtt' ? Z2M_DEVICE.exec(id) : null;
      if (m) return m[1].toLowerCase();
    }
    return null;
  }

  transport(r: EntityRecord): DeviceTransport {
    const d = r.device;
    const ieee = this.z2mIeee(d);
    if (d && ieee !== null) return { type: 'z2m', instanceId: this.z2mInstanceOf(d), friendlyName: d.name ?? r.entityId, ieee };
    const zha = d?.identifiers.find(([domain]) => domain === 'zha');
    if (zha || r.reg?.platform === 'zha') return { type: 'zha', ieee: zha?.[1] ?? null };
    const integration = this.integration(r);
    return { type: 'ha', integration, network: integration ? NETWORK[integration] ?? null : null };
  }

  /** Which configured Z2M instance a device belongs to: the bridge it hangs off carries the instance's state entity. */
  private z2mInstanceOf(d: RegistryDevice): Id {
    const instances = this.config.list('z2m');
    if (instances.length <= 1) return instances[0]?.id ?? '';
    for (const inst of instances) {
      const bridge = inst.bridgeEntityId ? this.record(inst.bridgeEntityId) : null;
      if (bridge?.device && d.via_device_id === bridge.device.id) return inst.id;
    }
    return instances[0].id;
  }

  /** Devices screen key: the HA device id, or `entity:<id>` for a bare entity. */
  deviceKey(r: EntityRecord): string {
    return r.device?.id ?? `entity:${r.entityId}`;
  }

  facts(r: EntityRecord): EntityFacts {
    const state = this.state(r.entityId);
    const dc = state?.attributes.device_class;
    const unit = state?.attributes.unit_of_measurement;
    return {
      entityId: r.entityId,
      domain: r.domain,
      key: r.key,
      name: this.name(r),
      state,
      deviceClass: typeof dc === 'string' ? dc : null,
      unit: typeof unit === 'string' ? unit : null,
      entityCategory: r.reg?.entity_category ?? null,
      model: r.device?.model ?? null,
      areaName: this.areaName(r.areaId),
    };
  }

  toDto(r: EntityRecord, usedBy: UsageRef[], score?: number): HaEntityDto {
    const s = this.state(r.entityId);
    const dc = s?.attributes.device_class;
    const unit = s?.attributes.unit_of_measurement;
    const dto: HaEntityDto = {
      entityId: r.entityId,
      name: this.name(r),
      domain: r.domain,
      deviceClass: typeof dc === 'string' ? dc : null,
      unit: typeof unit === 'string' ? unit : null,
      state: s?.state ?? null,
      available: isAvailableState(s?.state),
      areaId: r.areaId,
      areaName: this.areaName(r.areaId),
      deviceId: r.device?.id ?? null,
      deviceName: this.deviceName(r.device),
      model: r.device?.model ?? null,
      manufacturer: r.device?.manufacturer ?? null,
      integration: this.integration(r),
      usedBy,
    };
    if (score !== undefined) dto.score = score;
    return dto;
  }
}
