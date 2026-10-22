import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Patch, Post, Put } from '@nestjs/common';
import { AdminOnly } from '../common/admin.guard';
import { CurrentActor } from '../common/user.middleware';
import { parse } from '../common/validate';
import { applyEnergySetup } from '../config/energy-setup';
import type { Actor, CoolStrategy, EnergyDto, EnergyPolicy, HeatStrategy, IConfigStore, IReadModels, StrategyDto } from '../shared/model';
import { CONFIG_STORE, READ_MODELS } from '../tokens';
import { chainRequest, coolStrategyPatch, energyPatch, energySetupRequest, heatStrategyPatch, seasonPatch } from './schemas';

/**
 * Strategy: which sources heat and cool in what order, bivalence and lag, the season machine, and the
 * blackout energy policy. Changing the bivalent point rewrites the «Мороз» trigger in the same write.
 */
@Controller('api')
export class StrategyController {
  constructor(
    @Inject(CONFIG_STORE) private readonly config: IConfigStore,
    @Inject(READ_MODELS) private readonly readModels: IReadModels,
  ) {}

  @Get('strategy')
  strategy(): StrategyDto {
    return this.readModels.strategy();
  }

  @Patch('strategy/heat')
  @AdminOnly()
  async patchHeat(@Body() body: unknown, @CurrentActor() actor: Actor): Promise<StrategyDto> {
    await this.config.patchSingleton('heat', parse(body, heatStrategyPatch) as Partial<HeatStrategy>, actor);
    return this.readModels.strategy();
  }

  /** Central heat-capable sources in order; the first two form the bivalent pair. */
  @Put('strategy/heat/chain')
  @AdminOnly()
  async setHeatChain(@Body() body: unknown, @CurrentActor() actor: Actor): Promise<StrategyDto> {
    await this.config.patchSingleton('heat', { chain: parse(body, chainRequest).chain }, actor);
    return this.readModels.strategy();
  }

  @Patch('strategy/cool')
  @AdminOnly()
  async patchCool(@Body() body: unknown, @CurrentActor() actor: Actor): Promise<StrategyDto> {
    await this.config.patchSingleton('cool', parse(body, coolStrategyPatch) as Partial<CoolStrategy>, actor);
    return this.readModels.strategy();
  }

  /** Room ACs (as one group) and central cool-capable sources in order. */
  @Put('strategy/cool/chain')
  @AdminOnly()
  async setCoolChain(@Body() body: unknown, @CurrentActor() actor: Actor): Promise<StrategyDto> {
    await this.config.patchSingleton('cool', { chain: parse(body, chainRequest).chain }, actor);
    return this.readModels.strategy();
  }

  @Patch('strategy/season')
  @AdminOnly()
  async patchSeason(@Body() body: unknown, @CurrentActor() actor: Actor): Promise<StrategyDto> {
    await this.config.patchSingleton('season', parse(body, seasonPatch), actor);
    return this.readModels.strategy();
  }

  @Get('energy')
  energy(): EnergyDto {
    return this.readModels.energy();
  }

  /** A custom shed order stops the automatic one until `shedOrderCustom: false` restores it. */
  @Patch('energy')
  @AdminOnly()
  async patchEnergy(@Body() body: unknown, @CurrentActor() actor: Actor): Promise<EnergyDto> {
    await this.config.patchSingleton('energy', parse(body, energyPatch) as Partial<EnergyPolicy>, actor);
    return this.readModels.energy();
  }

  /** «Налаштувати енергію»: binds the grid/PV/battery/tariff entities and arms the seeded triggers and rules. */
  @Post('energy/setup')
  @HttpCode(HttpStatus.OK)
  @AdminOnly()
  async setupEnergy(@Body() body: unknown, @CurrentActor() actor: Actor): Promise<EnergyDto> {
    await applyEnergySetup(this.config, parse(body, energySetupRequest).entities, actor);
    return this.readModels.energy();
  }
}
