import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { AdminOnly } from '../common/admin.guard';
import { conflict, forbidden, notFound } from '../common/http';
import { CurrentActor, CurrentUser, type RequestUser } from '../common/user.middleware';
import { parse } from '../common/validate';
import { env } from '../env';
import { EVENT_CATALOGUE, isLockedCell } from '../shared/defaults';
import type {
  Actor,
  ChannelKind,
  EventKind,
  HaPort,
  IconName,
  IConfigStore,
  Id,
  IIncidents,
  INotify,
  InboxDto,
  NotificationPreviewDto,
  NotificationsDto,
  NotifySettings,
  NotifyTarget,
  PersonalPrefs,
  SentMessage,
  TelegramPairDto,
  TelegramPairStatusDto,
  TestNotificationResponse,
  WatchRule,
  WatchRuleDto,
} from '../shared/model';
import { CONFIG_STORE, HA_PORT, INCIDENTS, NOTIFY } from '../tokens';
import {
  eventKindParam,
  eventParamsPatch,
  notifySettingsPatch,
  notifyTargetCreateRequest,
  notifyTargetPatch,
  orderRequest,
  personalPrefsPatch,
  routeRequest,
  routingBulkRequest,
  sentLogQuery,
  testNotificationRequest,
  watchQuery,
  watchRuleCreateRequest,
  watchRulePatch,
} from './schemas';
import { found } from './support';

const CHANNEL_ICON: Record<ChannelKind, IconName> = {
  ha_mobile: 'phone',
  ha_notify: 'bell',
  telegram: 'send',
  ha_persistent: 'home',
  ha_event: 'bolt',
};

/** Personal settings of requests without an HA user (simulator, development). */
const LOCAL_USER = 'local';

/**
 * Notification settings: targets (matrix columns), routing, per-kind thresholds, Telegram pairing,
 * previews and tests, watch rules, the sent log, the bell inbox and each person's own preferences.
 */
@Controller('api/notifications')
export class NotificationsController {
  constructor(
    @Inject(CONFIG_STORE) private readonly config: IConfigStore,
    @Inject(NOTIFY) private readonly notify: INotify,
    @Inject(INCIDENTS) private readonly incidents: IIncidents,
    @Inject(HA_PORT) private readonly ha: HaPort,
  ) {}

  @Get()
  settings(): NotificationsDto {
    return this.notify.settings();
  }

  @Patch('settings')
  @AdminOnly()
  async patchSettings(@Body() body: unknown, @CurrentActor() actor: Actor): Promise<NotificationsDto> {
    await this.config.patchSingleton('notify', parse(body, notifySettingsPatch) as Partial<NotifySettings>, actor);
    return this.notify.settings();
  }

  /* ── Telegram ──────────────────────────────────────────────────────────────────────────────── */

  /** «Перевірити бота»: Telegram `getMe` with the token from the add-on options. */
  @Post('telegram/verify')
  @HttpCode(HttpStatus.OK)
  @AdminOnly()
  verifyTelegram(): Promise<{ ok: boolean; botUsername: string | null; error: string | null }> {
    return this.notify.telegramVerify();
  }

  /** A 10-minute pairing code («/start <code>» in the chat adds it as a target). */
  @Post('telegram/pair')
  @HttpCode(HttpStatus.OK)
  @AdminOnly()
  pairTelegram(): Promise<TelegramPairDto> {
    return this.notify.telegramPair();
  }

  @Get('telegram/pair/:code')
  @AdminOnly()
  pairStatus(@Param('code') code: string): TelegramPairStatusDto {
    return this.notify.telegramPairStatus(code);
  }

  /* ── targets and routing ───────────────────────────────────────────────────────────────────── */

  /** A new column gets its preset routing (primary phone, other phone, personal chat, family group…). */
  @Post('targets')
  @AdminOnly()
  async addTarget(@Body() body: unknown, @CurrentActor() actor: Actor): Promise<NotificationsDto> {
    const req = parse(body, notifyTargetCreateRequest);
    const channel = req.channel ?? 'ha_mobile';
    const target: Partial<NotifyTarget> = { icon: CHANNEL_ICON[channel], ...req, channel };
    await this.config.create('targets', target as Omit<NotifyTarget, 'id'>, actor);
    return this.notify.settings();
  }

  @Put('targets/order')
  @AdminOnly()
  async reorderTargets(@Body() body: unknown, @CurrentActor() actor: Actor): Promise<NotificationsDto> {
    await this.config.reorder('targets', parse(body, orderRequest).ids, actor);
    return this.notify.settings();
  }

  /** Critical alerts must keep reaching exactly one primary target (409 otherwise). */
  @Patch('targets/:id')
  @AdminOnly()
  async patchTarget(@Param('id') id: Id, @Body() body: unknown, @CurrentActor() actor: Actor): Promise<NotificationsDto> {
    await this.config.update('targets', id, parse(body, notifyTargetPatch), actor);
    return this.notify.settings();
  }

  /** Removing the primary hands it to the next phone (or chat), or is refused when none is left. */
  @Delete('targets/:id')
  @AdminOnly()
  async removeTarget(@Param('id') id: Id, @CurrentActor() actor: Actor): Promise<NotificationsDto> {
    await this.config.remove('targets', id, actor);
    return this.notify.settings();
  }

  /** Level toggles («КУДИ / ПРО ЩО»): many kinds × targets at once; locked critical cells stay on. */
  @Put('routing/bulk')
  async routeBulk(@Body() body: unknown, @CurrentUser() user: RequestUser, @CurrentActor() actor: Actor): Promise<NotificationsDto> {
    const req = parse(body, routingBulkRequest);
    const targets = req.targetIds.map((id) => found(this.config.get('targets', id), 'Notification target'));
    // household members tune their own phone and chat («КУДИ / ПРО ЩО»); everything else is configuration
    if (!this.canEditConfig(user) && targets.some((t) => !user.userId || t.ownerUserId !== user.userId)) {
      throw forbidden('Only your own notification targets can be changed');
    }
    const kinds: EventKind[] = EVENT_CATALOGUE.filter((e) => (!req.kinds || req.kinds.includes(e.kind)) && (!req.severity || e.severity === req.severity)).map((e) => e.kind);
    await this.config.transaction(async (tx) => {
      for (const t of targets) {
        for (const kind of kinds) {
          // a level switched off leaves the locked critical cells on
          if (!req.on && isLockedCell(kind, t)) continue;
          await tx.setRoute(kind, t.id, req.on, actor);
        }
      }
    });
    return this.notify.settings();
  }

  /** One matrix cell; critical cells of the primary are locked on (409 `locked_cell`). */
  @Put('routing/:kind/:targetId')
  @AdminOnly()
  async route(@Param('kind') kindRaw: string, @Param('targetId') targetId: Id, @Body() body: unknown, @CurrentActor() actor: Actor): Promise<NotificationsDto> {
    const kind = parse(kindRaw, eventKindParam);
    await this.config.setRoute(kind, targetId, parse(body, routeRequest).on, actor);
    return this.notify.settings();
  }

  /** Thresholds of one event kind (shared with the Devices, Room and Sources screens) or switching it off. */
  @Patch('events/:kind')
  @AdminOnly()
  async patchEvent(@Param('kind') kindRaw: string, @Body() body: unknown, @CurrentActor() actor: Actor): Promise<NotificationsDto> {
    await this.config.setEventParams(parse(kindRaw, eventKindParam), parse(body, eventParamsPatch), actor);
    return this.notify.settings();
  }

  /** What a message of this kind looks like on a phone and in Telegram (real templates, sample facts). */
  @Get('preview/:kind')
  preview(@Param('kind') kindRaw: string): NotificationPreviewDto {
    return this.notify.preview(parse(kindRaw, eventKindParam));
  }

  /** «Надіслати тест»: ignores quiet hours and grouping. */
  @Post('test')
  @HttpCode(HttpStatus.OK)
  test(@Body() body: unknown): Promise<TestNotificationResponse> {
    const req = parse(body, testNotificationRequest);
    if (req.targetId) found(this.config.get('targets', req.targetId), 'Notification target');
    return this.notify.test(req);
  }

  /* ── watch rules ───────────────────────────────────────────────────────────────────────────── */

  @Get('watch')
  watch(@Query() query: unknown): WatchRuleDto[] {
    const q = parse(query, watchQuery);
    return this.notify.watchRules(q.filter, q.q);
  }

  /** «Стежити за сутністю»: an own rule for any HA entity. */
  @Post('watch')
  @AdminOnly()
  async addWatch(@Body() body: unknown, @CurrentActor() actor: Actor): Promise<WatchRuleDto> {
    const req = parse(body, watchRuleCreateRequest);
    const entityId = req.entityId ?? '';
    const rule: Omit<WatchRule, 'id'> = {
      origin: 'manual',
      name: req.name ?? this.entityName(entityId),
      role: 'manual',
      ref: null,
      severity: 'warning',
      eventKind: 'entity_unavailable',
      muted: false,
      condition: { type: 'unavailable', forMin: 5 },
      ...req,
      entityId,
    };
    const created = await this.config.create('watchRules', rule, actor);
    return this.watchRule(created.id);
  }

  /** Automatic rules (derived from what Klimo uses) are stored once edited or muted. */
  @Patch('watch/:id')
  @AdminOnly()
  async patchWatch(@Param('id') id: Id, @Body() body: unknown, @CurrentActor() actor: Actor): Promise<WatchRuleDto> {
    const patch = parse(body, watchRulePatch);
    if (this.config.get('watchRules', id)) {
      await this.config.update('watchRules', id, patch, actor);
    } else {
      const derived = this.notify.watchRules('all').find((w) => w.id === id && w.origin === 'auto');
      if (!derived) throw notFound('Watch rule');
      const { status: _status, ...rule } = derived;
      await this.config.create('watchRules', { ...rule, ...patch }, actor);
    }
    return this.watchRule(id);
  }

  /** Own rules only; automatic ones are muted instead. */
  @Delete('watch/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @AdminOnly()
  async removeWatch(@Param('id') id: Id, @CurrentActor() actor: Actor): Promise<void> {
    const rule = this.config.get('watchRules', id);
    if (!rule) {
      if (this.notify.watchRules('all').some((w) => w.id === id)) throw conflict('Automatic watch rules are muted, not deleted');
      throw notFound('Watch rule');
    }
    if (rule.origin !== 'manual') throw conflict('Automatic watch rules are muted, not deleted');
    await this.config.remove('watchRules', id, actor);
  }

  /* ── log, inbox, personal ──────────────────────────────────────────────────────────────────── */

  @Get('log')
  log(@Query() query: unknown): Promise<SentMessage[]> {
    const q = parse(query, sentLogQuery);
    return this.notify.log({ ...q, limit: q.limit ?? 50 });
  }

  /** The bell: open problems and recent events not hidden by the person. */
  @Get('inbox')
  inbox(): InboxDto {
    return { items: this.incidents.list({ scope: 'inbox' }), count: this.incidents.counts().inbox };
  }

  /** «Мої сповіщення»: this person's phone and chat, levels and quiet hours. */
  @Get('me')
  me(@CurrentUser() user: RequestUser): PersonalPrefs {
    return this.config.personalPrefs(this.userIdOf(user));
  }

  @Patch('me')
  patchMe(@CurrentUser() user: RequestUser, @Body() body: unknown): Promise<PersonalPrefs> {
    const userId = this.userIdOf(user);
    const patch = parse(body, personalPrefsPatch);
    if (patch.targetIds && !this.canEditConfig(user)) {
      // a household member picks among their own targets only
      const foreign = patch.targetIds.find((id) => this.config.get('targets', id)?.ownerUserId !== userId);
      if (foreign) throw forbidden('Only your own notification targets can be chosen');
    }
    return this.config.setPersonalPrefs(userId, patch as Partial<Omit<PersonalPrefs, 'userId'>>);
  }

  /* ── helpers ───────────────────────────────────────────────────────────────────────────────── */

  private canEditConfig(user: RequestUser): boolean {
    return user.isAdmin || !this.config.singleton('settings').adminOnlyConfig;
  }

  private userIdOf(user: RequestUser): string {
    if (user.userId) return user.userId;
    if (env.simulate || env.devAdmin) return LOCAL_USER;
    throw forbidden('Personal notification settings need a Home Assistant user');
  }

  private watchRule(id: Id): WatchRuleDto {
    return found(
      this.notify.watchRules('all').find((w) => w.id === id),
      'Watch rule',
    );
  }

  private entityName(entityId: string): string {
    const friendly = this.ha.getState(entityId)?.attributes.friendly_name;
    return typeof friendly === 'string' && friendly.trim() ? friendly.trim().slice(0, 255) : entityId;
  }
}
