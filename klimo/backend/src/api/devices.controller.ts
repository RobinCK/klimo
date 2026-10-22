import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { AdminOnly } from '../common/admin.guard';
import { CurrentActor } from '../common/user.middleware';
import { parse } from '../common/validate';
import type {
  Actor,
  DeviceDetailDto,
  DeviceHealth,
  DevicesDto,
  IConfigStore,
  Id,
  IDeviceHealth,
  IHaInputs,
  IJournal,
  Z2mInstance,
  Z2mInstanceDto,
} from '../shared/model';
import { CONFIG_STORE, DEVICE_HEALTH, HA_INPUTS, JOURNAL } from '../tokens';
import { deviceMetaPatch, deviceReplaceRequest, devicesQuery, z2mCreateRequest, z2mPatch } from './schemas';
import { ApiRefs, found } from './support';

/**
 * Devices: every sensor, TRV, relay and pump Klimo uses, with battery, signal and availability, plus
 * the Zigbee2MQTT instances whose restarts make Klimo resend what the heads lost.
 */
@Controller('api')
export class DevicesController {
  constructor(
    @Inject(CONFIG_STORE) private readonly config: IConfigStore,
    @Inject(DEVICE_HEALTH) private readonly devices: IDeviceHealth,
    @Inject(HA_INPUTS) private readonly inputs: IHaInputs,
    @Inject(JOURNAL) private readonly journal: IJournal,
    @Inject(ApiRefs) private readonly refs: ApiRefs,
  ) {}

  @Get('devices')
  list(@Query() query: unknown): DevicesDto {
    const q = parse(query, devicesQuery);
    return this.devices.list(q.filter, q.q);
  }

  /** One device with 7 days of battery, signal and outages and its TRV command log. */
  @Get('devices/:key')
  async detail(@Param('key') key: string): Promise<DeviceDetailDto> {
    return found(await this.devices.detail(key), 'Device');
  }

  /** Label, battery type, «не стежити». */
  @Patch('devices/:key')
  @AdminOnly()
  async patch(@Param('key') key: string, @Body() body: unknown, @CurrentActor() actor: Actor): Promise<DeviceHealth> {
    const patch = parse(body, deviceMetaPatch);
    await this.device(key);
    await this.config.setDeviceMeta(key, patch, actor);
    return this.device(key);
  }

  /** «Повторити зараз»: every desired value of the device is sent again. */
  @Post('devices/:key/resend')
  @HttpCode(HttpStatus.ACCEPTED)
  async resend(@Param('key') key: string, @CurrentActor() actor: Actor): Promise<void> {
    await this.device(key);
    this.devices.resend(key, actor);
  }

  /** «Замінити пристрій»: the new entity takes over every binding of the old one. */
  @Post('devices/:key/replace')
  @HttpCode(HttpStatus.OK)
  @AdminOnly()
  replace(@Param('key') key: string, @Body() body: unknown, @CurrentActor() actor: Actor): Promise<DeviceHealth> {
    return this.devices.replace(key, parse(body, deviceReplaceRequest), actor);
  }

  /* ── Zigbee2MQTT instances ─────────────────────────────────────────────────────────────────── */

  @Get('z2m/instances')
  async instances(): Promise<Z2mInstanceDto[]> {
    const list = this.config.list('z2m');
    const restarts = await this.lastRestarts();
    const devices = list.length ? this.devices.list().devices : [];
    const online = this.inputs.z2mBridges();
    return list.map((z) => this.instanceDto(z, devices, online, restarts));
  }

  @Post('z2m/instances')
  @AdminOnly()
  async createInstance(@Body() body: unknown, @CurrentActor() actor: Actor): Promise<Z2mInstanceDto> {
    const created = await this.config.create('z2m', parse(body, z2mCreateRequest) as Omit<Z2mInstance, 'id'>, actor);
    return this.instance(created.id);
  }

  @Patch('z2m/instances/:id')
  @AdminOnly()
  async patchInstance(@Param('id') id: Id, @Body() body: unknown, @CurrentActor() actor: Actor): Promise<Z2mInstanceDto> {
    await this.config.update('z2m', id, parse(body, z2mPatch), actor);
    return this.instance(id);
  }

  @Delete('z2m/instances/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @AdminOnly()
  async removeInstance(@Param('id') id: Id, @CurrentActor() actor: Actor): Promise<void> {
    await this.config.remove('z2m', id, actor);
  }

  /** Resends the desired state of every device behind this bridge (what a bridge restart does by itself). */
  @Post('z2m/instances/:id/resync')
  @HttpCode(HttpStatus.ACCEPTED)
  resync(@Param('id') id: Id): void {
    found(this.config.get('z2m', id), 'Zigbee2MQTT instance');
    this.refs.requireEngine().resend({ z2mInstanceId: id });
  }

  /* ── helpers ───────────────────────────────────────────────────────────────────────────────── */

  private async device(key: string): Promise<DeviceHealth> {
    const listed = this.devices.list().devices.find((d) => d.key === key);
    if (listed) return listed;
    return found(await this.devices.detail(key), 'Device').device;
  }

  private async instance(id: Id): Promise<Z2mInstanceDto> {
    const z = found(this.config.get('z2m', id), 'Zigbee2MQTT instance');
    return this.instanceDto(z, this.devices.list().devices, this.inputs.z2mBridges(), await this.lastRestarts());
  }

  private instanceDto(z: Z2mInstance, devices: DeviceHealth[], online: Record<Id, boolean | null>, restarts: Map<Id, number>): Z2mInstanceDto {
    return {
      config: z,
      online: online[z.id] ?? null,
      deviceCount: devices.filter((d) => d.transport.type === 'z2m' && d.transport.instanceId === z.id).length,
      lastRestartAt: restarts.get(z.id) ?? null,
    };
  }

  /** Newest `z2m.restart` journal entry per instance. */
  private async lastRestarts(): Promise<Map<Id, number>> {
    const out = new Map<Id, number>();
    const page = await this.journal.page({ category: 'dev', codes: ['z2m.restart'], limit: 200 });
    for (const e of page.items) {
      const instanceId = e.params.instanceId;
      if (typeof instanceId === 'string' && e.ts > (out.get(instanceId) ?? 0)) out.set(instanceId, e.ts);
    }
    return out;
  }
}
