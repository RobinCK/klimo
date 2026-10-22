import { Body, Controller, Delete, HttpCode, HttpStatus, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { notFound } from '../common/http';
import { CurrentActor } from '../common/user.middleware';
import { parse } from '../common/validate';
import type { Actor, IConfigStore, IRoomActions, RoomConfig, RoomState, TargetCommandResult, TargetPreview } from '../shared/model';
import { CONFIG_STORE, ROOM_ACTIONS } from '../tokens';
import {
  airingRequest,
  boostRequest,
  reqIdOnly,
  roomOffRequest,
  roomProfileRequest,
  setTargetRequest,
  undoRequest,
  windowIgnoreRequest,
} from './schemas';
import { ApiRefs, found, ReqIdCache } from './support';

/**
 * Everyday control of a room — open to every household member. Each action is idempotent per `reqId`
 * (the card and the UI retry with the same id) and answers with the room state after an immediate
 * evaluation, so the page shows the consequence at once.
 */
@Controller('api/rooms/:id')
export class RoomActionsController {
  constructor(
    @Inject(CONFIG_STORE) private readonly config: IConfigStore,
    @Inject(ROOM_ACTIONS) private readonly actions: IRoomActions,
    @Inject(ReqIdCache) private readonly once: ReqIdCache,
    @Inject(ApiRefs) private readonly refs: ApiRefs,
  ) {}

  /** «Переслати цілі»: every TRV of the room gets its desired value again. */
  @Post('trvs/resync')
  @HttpCode(HttpStatus.ACCEPTED)
  resync(@Param('id') idOrSlug: string): void {
    const room = this.room(idOrSlug);
    this.refs.requireEngine().resend({ roomId: room.id });
  }

  /** «Повторити зараз» for one TRV head or zone actuator. */
  @Post('devices/:deviceId/resend')
  @HttpCode(HttpStatus.ACCEPTED)
  resend(@Param('id') idOrSlug: string, @Param('deviceId') deviceId: string): void {
    const room = this.room(idOrSlug);
    const device = this.config.get('emitterDevices', deviceId);
    if (!device || device.roomId !== room.id) throw notFound('Device');
    this.refs.requireEngine().resend({ entityId: device.entityId });
  }

  /** What a target change would do («Почне гріти · ~25 хв»), without doing it. */
  @Post('target/preview')
  @HttpCode(HttpStatus.OK)
  preview(@Param('id') idOrSlug: string, @Body() body: unknown): TargetPreview {
    return this.actions.preview(this.room(idOrSlug).id, parse(body, setTargetRequest));
  }

  /** Clamped to the room limits; `forever` writes the value into the governing profile instead. */
  @Post('target')
  @HttpCode(HttpStatus.OK)
  setTarget(@Param('id') idOrSlug: string, @Body() body: unknown, @CurrentActor() actor: Actor): Promise<TargetCommandResult> {
    const room = this.room(idOrSlug);
    const req = parse(body, setTargetRequest);
    return this.once.run(`target:${room.id}`, req.reqId, () => this.actions.setTarget(room.id, req, actor), actor.via);
  }

  /** «Скасувати» within 30 s of a change; later → 409 `revert_expired`. */
  @Post('target/undo')
  @HttpCode(HttpStatus.OK)
  undo(@Param('id') idOrSlug: string, @Body() body: unknown, @CurrentActor() actor: Actor): Promise<TargetCommandResult> {
    const room = this.room(idOrSlug);
    const { revertToken } = parse(body, undoRequest);
    return this.once.run(`undo:${room.id}`, revertToken, () => this.actions.undo(room.id, revertToken, actor));
  }

  /** «Повернути розклад»: drops the room's target override (manual value, boost, off or profile). */
  @Delete('override')
  resume(@Param('id') idOrSlug: string, @Query() query: unknown, @CurrentActor() actor: Actor): Promise<RoomState> {
    const room = this.room(idOrSlug);
    return this.once.run(`resume:${room.id}`, parse(query, reqIdOnly).reqId, () => this.actions.resume(room.id, actor), actor.via);
  }

  @Post('boost')
  @HttpCode(HttpStatus.OK)
  boost(@Param('id') idOrSlug: string, @Body() body: unknown, @CurrentActor() actor: Actor): Promise<RoomState> {
    const room = this.room(idOrSlug);
    const { reqId, ...req } = parse(body, boostRequest);
    return this.once.run(`boost:${room.id}`, reqId, () => this.actions.boost(room.id, req, actor), actor.via);
  }

  @Delete('boost')
  cancelBoost(@Param('id') idOrSlug: string, @Query() query: unknown, @CurrentActor() actor: Actor): Promise<RoomState> {
    const room = this.room(idOrSlug);
    return this.once.run(`boost-off:${room.id}`, parse(query, reqIdOnly).reqId, () => this.actions.cancelBoost(room.id, actor), actor.via);
  }

  /** «Провітрити»: no heating or cooling for a few minutes, window reactions suppressed. */
  @Post('airing')
  @HttpCode(HttpStatus.OK)
  airing(@Param('id') idOrSlug: string, @Body() body: unknown, @CurrentActor() actor: Actor): Promise<RoomState> {
    const room = this.room(idOrSlug);
    const { reqId, ...req } = parse(body, airingRequest);
    return this.once.run(`airing:${room.id}`, reqId, () => this.actions.airing(room.id, req, actor), actor.via);
  }

  @Delete('airing')
  cancelAiring(@Param('id') idOrSlug: string, @Query() query: unknown, @CurrentActor() actor: Actor): Promise<RoomState> {
    const room = this.room(idOrSlug);
    return this.once.run(`airing-off:${room.id}`, parse(query, reqIdOnly).reqId, () => this.actions.cancelAiring(room.id, actor), actor.via);
  }

  /** «Ігнорувати вікно»: a stuck or misreporting contact stops pausing the room for a while. */
  @Post('window-ignore')
  @HttpCode(HttpStatus.OK)
  ignoreWindow(@Param('id') idOrSlug: string, @Body() body: unknown, @CurrentActor() actor: Actor): Promise<RoomState> {
    const room = this.room(idOrSlug);
    const { reqId, ...req } = parse(body, windowIgnoreRequest);
    return this.once.run(`window-ignore:${room.id}`, reqId, () => this.actions.ignoreWindow(room.id, req, actor), actor.via);
  }

  @Delete('window-ignore')
  cancelIgnoreWindow(@Param('id') idOrSlug: string, @Query() query: unknown, @CurrentActor() actor: Actor): Promise<RoomState> {
    const room = this.room(idOrSlug);
    return this.once.run(`window-ignore-off:${room.id}`, parse(query, reqIdOnly).reqId, () => this.actions.cancelIgnoreWindow(room.id, actor), actor.via);
  }

  /** Room off (frost protection stays); `none` = until switched on again. */
  @Post('off')
  @HttpCode(HttpStatus.OK)
  off(@Param('id') idOrSlug: string, @Body() body: unknown, @CurrentActor() actor: Actor): Promise<RoomState> {
    const room = this.room(idOrSlug);
    const { reqId, ...req } = parse(body, roomOffRequest);
    return this.once.run(`off:${room.id}`, reqId, () => this.actions.off(room.id, req, actor), actor.via);
  }

  @Delete('off')
  on(@Param('id') idOrSlug: string, @Query() query: unknown, @CurrentActor() actor: Actor): Promise<RoomState> {
    const room = this.room(idOrSlug);
    return this.once.run(`on:${room.id}`, parse(query, reqIdOnly).reqId, () => this.actions.on(room.id, actor), actor.via);
  }

  /** The room follows another profile for a while (the HA climate preset). */
  @Put('profile')
  setProfile(@Param('id') idOrSlug: string, @Body() body: unknown, @CurrentActor() actor: Actor): Promise<RoomState> {
    const room = this.room(idOrSlug);
    const { reqId, ...req } = parse(body, roomProfileRequest);
    return this.once.run(`profile:${room.id}`, reqId, () => this.actions.setRoomProfile(room.id, req, actor), actor.via);
  }

  @Delete('profile')
  clearProfile(@Param('id') idOrSlug: string, @Query() query: unknown, @CurrentActor() actor: Actor): Promise<RoomState> {
    const room = this.room(idOrSlug);
    return this.once.run(`profile-off:${room.id}`, parse(query, reqIdOnly).reqId, () => this.actions.clearRoomProfile(room.id, actor), actor.via);
  }

  private room(idOrSlug: string): RoomConfig {
    return found(this.config.room(idOrSlug), 'Room');
  }
}
