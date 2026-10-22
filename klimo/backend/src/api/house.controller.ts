import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Post, Put, Query } from '@nestjs/common';
import { CurrentActor } from '../common/user.middleware';
import { parse } from '../common/validate';
import type { Actor, HouseControl, HouseControlResult, HouseModePreview, HouseProfileDto, HouseProfilePreview, IHouseActions, SeasonState } from '../shared/model';
import { HOUSE_ACTIONS } from '../tokens';
import { houseControlRequest, houseModeRequest, houseProfileRequest, reqIdOnly, undoRequest } from './schemas';
import { ApiRefs, ReqIdCache } from './support';

/**
 * The house profile and the house mode: control actions open to every panel user, journaled with the
 * person who changed them, each with a preview of what would happen.
 */
@Controller('api/house')
export class HouseController {
  constructor(
    @Inject(HOUSE_ACTIONS) private readonly house: IHouseActions,
    @Inject(ReqIdCache) private readonly once: ReqIdCache,
    @Inject(ApiRefs) private readonly refs: ApiRefs,
  ) {}

  @Get('profile')
  profile(): HouseProfileDto {
    return this.house.profile();
  }

  @Post('profile/preview')
  @HttpCode(HttpStatus.OK)
  previewProfile(@Body() body: unknown): HouseProfilePreview {
    return this.house.preview(parse(body, houseProfileRequest));
  }

  /** Picking the scheduled profile «до кінця слоту» clears the override instead of creating one. */
  @Put('profile')
  setProfile(@Body() body: unknown, @CurrentActor() actor: Actor): Promise<HouseProfileDto> {
    const req = parse(body, houseProfileRequest);
    return this.once.run('house-profile', req.reqId, () => this.house.setProfile(req, actor), actor.via);
  }

  /** «Повернути розклад». */
  @Delete('profile')
  clearProfile(@Query() query: unknown, @CurrentActor() actor: Actor): Promise<HouseProfileDto> {
    return this.once.run('house-profile-clear', parse(query, reqIdOnly).reqId, () => this.house.clearProfile(actor), actor.via);
  }

  @Post('profile/undo')
  @HttpCode(HttpStatus.OK)
  undo(@Body() body: unknown, @CurrentActor() actor: Actor): Promise<HouseProfileDto> {
    const { revertToken } = parse(body, undoRequest);
    return this.once.run('house-undo', revertToken, () => this.house.undo(revertToken, actor));
  }

  @Get('control')
  control(): HouseControl {
    return this.house.control();
  }

  /**
   * manual pauses the house schedule on the current profile; schedule resumes the whole house — the
   * house override and every room's manual or temporary change (rooms switched off stay off).
   */
  @Put('control')
  setControl(@Body() body: unknown, @CurrentActor() actor: Actor): Promise<HouseControlResult> {
    const req = parse(body, houseControlRequest);
    return this.once.run('house-control', req.reqId, () => this.house.setControl(req, actor), actor.via);
  }

  @Get('mode')
  mode(): SeasonState {
    return this.refs.requireEngine().season();
  }

  @Post('mode/preview')
  @HttpCode(HttpStatus.OK)
  previewMode(@Body() body: unknown): HouseModePreview {
    return this.house.previewMode(parse(body, houseModeRequest).mode);
  }

  @Put('mode')
  setMode(@Body() body: unknown, @CurrentActor() actor: Actor): Promise<SeasonState> {
    const { mode, reqId } = parse(body, houseModeRequest);
    return this.once.run('house-mode', reqId, () => this.house.setMode(mode, actor), actor.via);
  }
}
