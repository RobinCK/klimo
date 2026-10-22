import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { AdminOnly } from '../common/admin.guard';
import { CurrentActor } from '../common/user.middleware';
import { parse } from '../common/validate';
import { deepClone } from '../shared/defaults';
import type {
  Actor,
  ActivationRule,
  IConfigStore,
  Id,
  IHouseActions,
  IReadModels,
  PriorityKey,
  Profile,
  ProfileDto,
  Reason,
} from '../shared/model';
import { CONFIG_STORE, HOUSE_ACTIONS, READ_MODELS } from '../tokens';
import { copyName, newProfileName, uniqueName } from './names';
import {
  activationRuleConfig,
  activationRulePatch,
  orderRequest,
  priorityRequest,
  profileCreateRequest,
  profileDeleteRequest,
  profilePatch,
  profileTargetRequest,
} from './schemas';
import { found } from './support';

const PROFILE_NAME_MAX = 24;

/** Drops keys whose value is `undefined` (a create must not carry "unset" over a default). */
function defined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Profiles («Дома», «Еко», own ones), their room values and activation rules, and the priority order. */
@Controller('api')
export class ProfilesController {
  constructor(
    @Inject(CONFIG_STORE) private readonly config: IConfigStore,
    @Inject(READ_MODELS) private readonly readModels: IReadModels,
    @Inject(HOUSE_ACTIONS) private readonly house: IHouseActions,
  ) {}

  @Get('profiles')
  list(): ProfileDto[] {
    return this.readModels.profiles();
  }

  /** «Новий профіль»: a copy of `copyFrom` (default «Дома») with the next free colour and icon. */
  @Post('profiles')
  @AdminOnly()
  async create(@Body() body: unknown, @CurrentActor() actor: Actor): Promise<ProfileDto> {
    const { copyFrom, ...req } = parse(body, profileCreateRequest);
    const source = found(this.config.get('profiles', copyFrom ?? 'home'), 'Profile');
    const lang = this.config.singleton('settings').notificationLanguage;
    const name = req.name ?? uniqueName(newProfileName(lang), this.names(), PROFILE_NAME_MAX);
    const created = await this.copy(source, { heatC: source.heatC, coolC: source.coolC, frostOnly: source.frostOnly, ...defined(req), name }, false, actor);
    return this.dto(created.id);
  }

  @Patch('profiles/:id')
  @AdminOnly()
  async patch(@Param('id') id: Id, @Body() body: unknown, @CurrentActor() actor: Actor): Promise<ProfileDto> {
    await this.config.update('profiles', id, parse(body, profilePatch), actor);
    return this.dto(id);
  }

  /** Blocks, rules, overrides and settings that used the profile switch to `replaceWith` (system profiles stay). */
  @Delete('profiles/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @AdminOnly()
  async remove(@Param('id') id: Id, @Body() body: unknown, @Query() query: unknown, @CurrentActor() actor: Actor): Promise<void> {
    // DELETE bodies are dropped by some proxies; the query string carries the same field
    const hasBody = !!body && typeof body === 'object' && Object.keys(body).length > 0;
    const { replaceWith } = parse(hasBody ? body : query, profileDeleteRequest);
    await this.config.remove('profiles', id, actor, { replaceWith });
  }

  /** «Дублювати»: «{name} (копія)» in the next free colour, same room values, its rules copied switched off. */
  @Post('profiles/:id/duplicate')
  @AdminOnly()
  async duplicate(@Param('id') id: Id, @CurrentActor() actor: Actor): Promise<ProfileDto> {
    const source = found(this.config.get('profiles', id), 'Profile');
    const lang = this.config.singleton('settings').notificationLanguage;
    const name = uniqueName(copyName(source.name, lang, PROFILE_NAME_MAX), this.names(), PROFILE_NAME_MAX);
    const created = await this.copy(source, { name, heatC: source.heatC, coolC: source.coolC, frostOnly: source.frostOnly }, true, actor);
    return this.dto(created.id);
  }

  @Put('profiles/order')
  @AdminOnly()
  async reorder(@Body() body: unknown, @CurrentActor() actor: Actor): Promise<ProfileDto[]> {
    await this.config.reorder('profiles', parse(body, orderRequest).ids, actor);
    return this.readModels.profiles();
  }

  @Put('profiles/:id/rooms/:roomId')
  @AdminOnly()
  async setRoom(@Param('id') id: Id, @Param('roomId') roomIdOrSlug: string, @Body() body: unknown, @CurrentActor() actor: Actor): Promise<ProfileDto> {
    const room = found(this.config.room(roomIdOrSlug), 'Room');
    await this.config.setProfileRoom(id, room.id, parse(body, profileTargetRequest), actor);
    return this.dto(id);
  }

  /** «Коли вмикається сам»: presence, calendar or vacation rule of the profile. */
  @Post('profiles/:id/rules')
  @AdminOnly()
  async addRule(@Param('id') id: Id, @Body() body: unknown, @CurrentActor() actor: Actor): Promise<ProfileDto> {
    found(this.config.get('profiles', id), 'Profile');
    const rule: Omit<ActivationRule, 'id' | 'order'> = { profileId: id, enabled: true, config: parse(body, activationRuleConfig) };
    await this.config.create('activationRules', rule as Omit<ActivationRule, 'id'>, actor);
    return this.dto(id);
  }

  @Patch('activation-rules/:ruleId')
  @AdminOnly()
  async patchRule(@Param('ruleId') ruleId: Id, @Body() body: unknown, @CurrentActor() actor: Actor): Promise<ProfileDto> {
    found(this.config.get('activationRules', ruleId), 'Activation rule');
    const updated = await this.config.update('activationRules', ruleId, parse(body, activationRulePatch), actor);
    return this.dto(updated.profileId);
  }

  @Delete('activation-rules/:ruleId')
  @AdminOnly()
  async removeRule(@Param('ruleId') ruleId: Id, @CurrentActor() actor: Actor): Promise<ProfileDto> {
    const rule = found(this.config.get('activationRules', ruleId), 'Activation rule');
    await this.config.remove('activationRules', ruleId, actor);
    return this.dto(rule.profileId);
  }

  /** «Перевірити»: would the rule switch its profile on right now, and why (nothing changes). */
  @Post('activation-rules/:ruleId/test')
  @HttpCode(HttpStatus.OK)
  testRule(@Param('ruleId') ruleId: Id): { wouldActivate: boolean; reason: Reason | null } {
    found(this.config.get('activationRules', ruleId), 'Activation rule');
    return this.house.activationRuleTest(ruleId);
  }

  @Get('priority')
  priority(): PriorityKey[] {
    return this.config.singleton('house').priority;
  }

  /** Frost and window protection keep ranks 1–2; the household orders the rest. */
  @Put('priority')
  @AdminOnly()
  async setPriority(@Body() body: unknown, @CurrentActor() actor: Actor): Promise<PriorityKey[]> {
    const house = await this.config.patchSingleton('house', { priority: parse(body, priorityRequest).order }, actor);
    return house.priority;
  }

  /* ── helpers ───────────────────────────────────────────────────────────────────────────────── */

  private names(): string[] {
    return this.config.list('profiles').map((p) => p.name);
  }

  private dto(id: Id): ProfileDto {
    return found(
      this.readModels.profiles().find((p) => p.id === id),
      'Profile',
    );
  }

  /** A new custom profile with the room values of `source` (and its activation rules, switched off). */
  private copy(source: Profile, values: Partial<Omit<Profile, 'id' | 'kind' | 'order'>>, withRules: boolean, actor: Actor): Promise<Profile> {
    return this.config.transaction(async (tx) => {
      const created = await tx.create('profiles', { ...values, kind: 'custom' } as Omit<Profile, 'id'>, actor);
      for (const row of tx.profileRooms().filter((r) => r.profileId === source.id)) {
        await tx.setProfileRoom(created.id, row.roomId, { mode: row.mode, heatC: row.heatC, coolC: row.coolC }, actor);
      }
      if (withRules) {
        for (const rule of tx.list('activationRules').filter((a) => a.profileId === source.id)) {
          await tx.create('activationRules', { profileId: created.id, enabled: false, config: deepClone(rule.config) } as Omit<ActivationRule, 'id'>, actor);
        }
      }
      return created;
    });
  }
}
