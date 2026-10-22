import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { AdminOnly } from '../common/admin.guard';
import { notFound, validationError } from '../common/http';
import { CurrentActor } from '../common/user.middleware';
import { parse } from '../common/validate';
import type {
  Actor,
  ClockPort,
  CreateRoomReport,
  DurationOption,
  Emitter,
  EmitterDevice,
  HaPort,
  IConfigStore,
  IEntitySearch,
  IHistory,
  Id,
  IReadModels,
  IRoomActions,
  IRoomSetup,
  RoomConfig,
  RoomDayDto,
  RoomDetailDto,
  RoomSensor,
  RoomSummary,
  SparkDto,
  ValidationResult,
} from '../shared/model';
import { CLOCK, CONFIG_STORE, ENTITY_SEARCH, HA_PORT, HISTORY, READ_MODELS, ROOM_ACTIONS, ROOM_SETUP } from '../tokens';
import { emitterName } from './names';
import {
  createRoomRequest,
  dateQuery,
  emitterCreateRequest,
  emitterDeviceCreateRequest,
  emitterDevicePatch,
  emitterPatch,
  orderRequest,
  profileTargetRequest,
  releaseQuery,
  roomPatch,
  sensorCreateRequest,
  sensorOrderRequest,
  sensorPatch,
  stepParam,
  validateRoomRequest,
} from './schemas';
import { found, localToday } from './support';

/**
 * Rooms: the list, the add-room wizard, the room page and everything on room settings (sensors,
 * emitters and their devices, per-profile targets). `:id` is the room id or its slug.
 */
@Controller('api/rooms')
export class RoomsController {
  constructor(
    @Inject(CONFIG_STORE) private readonly config: IConfigStore,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(HA_PORT) private readonly ha: HaPort,
    @Inject(ENTITY_SEARCH) private readonly search: IEntitySearch,
    @Inject(HISTORY) private readonly history: IHistory,
    @Inject(READ_MODELS) private readonly readModels: IReadModels,
    @Inject(ROOM_SETUP) private readonly setup: IRoomSetup,
    @Inject(ROOM_ACTIONS) private readonly actions: IRoomActions,
  ) {}

  /* ── list and wizard (fixed paths first: they would otherwise read as a room id) ─────────────── */

  @Get()
  list(): RoomSummary[] {
    return this.readModels.roomSummaries();
  }

  /** Six-hour sparklines of every room (cached by the history service for a minute). */
  @Get('sparks')
  sparks(): Promise<Record<Id, SparkDto>> {
    return this.history.sparks();
  }

  /** Wizard «Далі»: problems of one step and live hints (method values, TRV strategy). */
  @Post('validate')
  @HttpCode(HttpStatus.OK)
  validate(@Body() body: unknown): ValidationResult {
    return this.setup.validate(parse(body, validateRoomRequest));
  }

  /** Creates the room with everything the wizard collected; steps stream as WS `wizard.report`. */
  @Post()
  @AdminOnly()
  create(@Body() body: unknown, @CurrentActor() actor: Actor): Promise<CreateRoomReport> {
    return this.setup.create(parse(body, createRoomRequest), actor);
  }

  @Get('reports/:reportId')
  report(@Param('reportId') reportId: string): CreateRoomReport {
    return found(this.setup.report(reportId), 'Report');
  }

  @Post('reports/:reportId/retry/:step')
  @HttpCode(HttpStatus.OK)
  @AdminOnly()
  retry(@Param('reportId') reportId: string, @Param('step') step: string, @CurrentActor() actor: Actor): Promise<CreateRoomReport> {
    return this.setup.retry(reportId, parse(step, stepParam), actor);
  }

  @Put('order')
  @AdminOnly()
  async reorder(@Body() body: unknown, @CurrentActor() actor: Actor): Promise<RoomSummary[]> {
    await this.config.reorder('rooms', parse(body, orderRequest).ids, actor);
    return this.readModels.roomSummaries();
  }

  /* ── one room ──────────────────────────────────────────────────────────────────────────────── */

  @Get(':id')
  detail(@Param('id') idOrSlug: string): RoomDetailDto {
    return found(this.readModels.roomDetail(idOrSlug), 'Room');
  }

  /** Room settings autosave (the page debounces edits by 400 ms). */
  @Patch(':id')
  @AdminOnly()
  async patch(@Param('id') idOrSlug: string, @Body() body: unknown, @CurrentActor() actor: Actor): Promise<RoomDetailDto> {
    const room = this.room(idOrSlug);
    await this.config.update('rooms', room.id, parse(body, roomPatch) as Partial<RoomConfig>, actor);
    return this.detailOf(room.id);
  }

  /** Deletes the room; its TRVs are handed back to their own regulation first unless told otherwise. */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @AdminOnly()
  async remove(@Param('id') idOrSlug: string, @Query() query: unknown, @CurrentActor() actor: Actor): Promise<void> {
    const room = this.room(idOrSlug);
    const { releaseTrvs } = parse(query, releaseQuery);
    await this.setup.remove(room.id, { releaseTrvs: releaseTrvs ?? true }, actor);
  }

  @Get(':id/day')
  day(@Param('id') idOrSlug: string, @Query() query: unknown): Promise<RoomDayDto> {
    const room = this.room(idOrSlug);
    const { date } = parse(query, dateQuery);
    return this.history.roomDay(room.id, date ?? localToday(this.clock));
  }

  /** Duration choices of a target change with their resolved end times. */
  @Get(':id/durations')
  durations(@Param('id') idOrSlug: string): DurationOption[] {
    return this.actions.durations(this.room(idOrSlug).id);
  }

  /* ── sensors ───────────────────────────────────────────────────────────────────────────────── */

  /** 409 when the entity already serves another room in the same role (a door contact may serve two). */
  @Post(':id/sensors')
  @AdminOnly()
  async addSensor(@Param('id') idOrSlug: string, @Body() body: unknown, @CurrentActor() actor: Actor): Promise<RoomDetailDto> {
    const room = this.room(idOrSlug);
    const req = parse(body, sensorCreateRequest);
    if (this.ha.connected && !this.ha.getState(req.entityId) && !this.search.detail(req.entityId)) {
      throw validationError([{ path: 'entityId', code: 'not_found' }]);
    }
    const device = this.search.deviceOf(req.entityId);
    const sensor: Omit<RoomSensor, 'id' | 'order'> = {
      roomId: room.id,
      entityId: req.entityId,
      role: req.role,
      contactKind: req.role === 'contact' ? req.contactKind ?? 'window' : null,
      name: req.name ?? this.entityName(req.entityId),
      model: device?.model ?? null,
      haDeviceId: device && !device.key.startsWith('entity:') ? device.key : null,
      weight: req.weight ?? 1,
      included: true,
      excludedBy: null,
    };
    await this.config.create('sensors', sensor as Omit<RoomSensor, 'id'>, actor);
    return this.detailOf(room.id);
  }

  /** «Порядок» defines «Основний»: the first included temperature sensor. */
  @Put(':id/sensors/order')
  @AdminOnly()
  async reorderSensors(@Param('id') idOrSlug: string, @Body() body: unknown, @CurrentActor() actor: Actor): Promise<RoomDetailDto> {
    const room = this.room(idOrSlug);
    const req = parse(body, sensorOrderRequest);
    const own = this.config.list('sensors').filter((s) => s.roomId === room.id && s.role === req.role);
    const ownIds = new Set(own.map((s) => s.id));
    const unknown = req.ids.findIndex((x) => !ownIds.has(x));
    if (unknown >= 0) throw validationError([{ path: `ids.${unknown}`, code: 'not_found' }]);
    // sensors left out keep their relative order after the listed ones
    const ids = [...new Set(req.ids), ...own.map((s) => s.id).filter((x) => !req.ids.includes(x))];
    await this.config.reorder('sensors', ids, actor);
    return this.detailOf(room.id);
  }

  @Patch(':id/sensors/:sensorId')
  @AdminOnly()
  async patchSensor(@Param('id') idOrSlug: string, @Param('sensorId') sensorId: string, @Body() body: unknown, @CurrentActor() actor: Actor): Promise<RoomDetailDto> {
    const room = this.room(idOrSlug);
    this.sensor(room, sensorId);
    const req = parse(body, sensorPatch);
    const patch: Partial<RoomSensor> = { ...req };
    if (req.included !== undefined) patch.excludedBy = req.included ? null : 'user';
    await this.config.update('sensors', sensorId, patch, actor);
    return this.detailOf(room.id);
  }

  @Delete(':id/sensors/:sensorId')
  @AdminOnly()
  async removeSensor(@Param('id') idOrSlug: string, @Param('sensorId') sensorId: string, @CurrentActor() actor: Actor): Promise<RoomDetailDto> {
    const room = this.room(idOrSlug);
    this.sensor(room, sensorId);
    await this.config.remove('sensors', sensorId, actor);
    return this.detailOf(room.id);
  }

  /* ── emitters and their devices ────────────────────────────────────────────────────────────── */

  @Post(':id/emitters')
  @AdminOnly()
  async addEmitter(@Param('id') idOrSlug: string, @Body() body: unknown, @CurrentActor() actor: Actor): Promise<RoomDetailDto> {
    const room = this.room(idOrSlug);
    const req = parse(body, emitterCreateRequest);
    const lang = this.config.singleton('settings').notificationLanguage;
    const direct = req.kind === 'direct';
    const usesRole = (role: string) => req.roles.heat === role || req.roles.cool === role;
    const emitter: Omit<Emitter, 'id' | 'order'> = {
      roomId: room.id,
      kind: req.kind,
      name: req.name ?? emitterName(req.kind, lang),
      enabled: true,
      // hydronic kinds hang on a circuit, a room device is a room-scope source
      circuitId: direct ? null : req.circuitId ?? null,
      sourceId: direct ? req.sourceId ?? null : null,
      roles: req.roles,
      assist: usesRole('assist') ? { deficitC: 1.5 } : null,
      trigger: usesRole('trigger') ? { heatStoreAboveTargetC: 1.5 } : null,
      excludeFromCooling: false,
      ignoreSeason: false,
    };
    await this.config.create('emitters', emitter as Omit<Emitter, 'id'>, actor);
    return this.detailOf(room.id);
  }

  @Patch(':id/emitters/:emitterId')
  @AdminOnly()
  async patchEmitter(@Param('id') idOrSlug: string, @Param('emitterId') emitterId: string, @Body() body: unknown, @CurrentActor() actor: Actor): Promise<RoomDetailDto> {
    const room = this.room(idOrSlug);
    this.emitter(room, emitterId);
    await this.config.update('emitters', emitterId, parse(body, emitterPatch) as Partial<Emitter>, actor);
    return this.detailOf(room.id);
  }

  /** TRV heads of the emitter go back to their own regulation before the emitter disappears. */
  @Delete(':id/emitters/:emitterId')
  @AdminOnly()
  async removeEmitter(@Param('id') idOrSlug: string, @Param('emitterId') emitterId: string, @CurrentActor() actor: Actor): Promise<RoomDetailDto> {
    const room = this.room(idOrSlug);
    this.emitter(room, emitterId);
    const devices = this.config.list('emitterDevices').filter((d) => d.emitterId === emitterId);
    for (const d of devices) await this.setup.removeEmitterDevice(room.id, d.id, actor);
    await this.config.remove('emitters', emitterId, actor);
    return this.detailOf(room.id);
  }

  /** Adds a TRV or a zone actuator; a TRV is probed for its capabilities and sibling entities. */
  @Post(':id/emitters/:emitterId/devices')
  @AdminOnly()
  addDevice(@Param('id') idOrSlug: string, @Param('emitterId') emitterId: string, @Body() body: unknown, @CurrentActor() actor: Actor): Promise<RoomDetailDto> {
    const room = this.room(idOrSlug);
    this.emitter(room, emitterId);
    return this.setup.addEmitterDevice(room.id, emitterId, parse(body, emitterDeviceCreateRequest), actor);
  }

  @Patch(':id/devices/:deviceId')
  @AdminOnly()
  async patchDevice(@Param('id') idOrSlug: string, @Param('deviceId') deviceId: string, @Body() body: unknown, @CurrentActor() actor: Actor): Promise<RoomDetailDto> {
    const room = this.room(idOrSlug);
    const device = this.device(room, deviceId);
    const req = parse(body, emitterDevicePatch);
    if (req.siblings && !device.siblings) throw validationError([{ path: 'siblings', code: 'unsupported' }]);
    await this.config.update('emitterDevices', deviceId, req as Partial<EmitterDevice>, actor);
    return this.detailOf(room.id);
  }

  @Delete(':id/devices/:deviceId')
  @AdminOnly()
  removeDevice(@Param('id') idOrSlug: string, @Param('deviceId') deviceId: string, @CurrentActor() actor: Actor): Promise<RoomDetailDto> {
    const room = this.room(idOrSlug);
    this.device(room, deviceId);
    return this.setup.removeEmitterDevice(room.id, deviceId, actor);
  }

  /** The room's own value in a profile; `inherit` removes it. */
  @Put(':id/profile-targets/:profileId')
  @AdminOnly()
  async setProfileTarget(@Param('id') idOrSlug: string, @Param('profileId') profileId: string, @Body() body: unknown, @CurrentActor() actor: Actor): Promise<RoomDetailDto> {
    const room = this.room(idOrSlug);
    await this.config.setProfileRoom(profileId, room.id, parse(body, profileTargetRequest), actor);
    return this.detailOf(room.id);
  }

  /* ── helpers ───────────────────────────────────────────────────────────────────────────────── */

  private room(idOrSlug: string): RoomConfig {
    return found(this.config.room(idOrSlug), 'Room');
  }

  private detailOf(roomId: Id): RoomDetailDto {
    return found(this.readModels.roomDetail(roomId), 'Room');
  }

  private sensor(room: RoomConfig, sensorId: Id): RoomSensor {
    const s = this.config.get('sensors', sensorId);
    if (!s || s.roomId !== room.id) throw notFound('Sensor');
    return s;
  }

  private emitter(room: RoomConfig, emitterId: Id): Emitter {
    const e = this.config.get('emitters', emitterId);
    if (!e || e.roomId !== room.id) throw notFound('Emitter');
    return e;
  }

  private device(room: RoomConfig, deviceId: Id): EmitterDevice {
    const d = this.config.get('emitterDevices', deviceId);
    if (!d || d.roomId !== room.id) throw notFound('Device');
    return d;
  }

  /** The entity's HA name («Датчик біля дивана»), else its id. */
  private entityName(entityId: string): string {
    const friendly = this.ha.getState(entityId)?.attributes.friendly_name;
    if (typeof friendly === 'string' && friendly.trim()) return friendly.trim().slice(0, 80);
    return this.search.detail(entityId)?.entity.name.slice(0, 80) ?? entityId;
  }
}
