import { HttpStatus, Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ApiException } from '../common/http';
import { errorText } from '../common/logger';
import { lazyRef } from '../common/refs';
import type { Actor, ClockPort, EpochMs, HaPort, IAttribution, IConfigStore, Id, IncidentAction, IncidentActionRequest } from '../shared/model';
import { ATTRIBUTION, CLOCK, CONFIG_STORE, HA_PORT } from '../tokens';
import { parseIntegrationCallback, parseMobileAction, parseOwnCallback } from './channels/channel';
import { HaPersistentChannel } from './channels/ha-persistent.channel';
import { chatTarget } from './channels/telegram.channel';
import { IncidentService } from './incidents.service';
import { actionResult, escapeHtml, systemText } from './messages';
import { TelegramBotService } from './telegram-bot.service';
import type { TgCallbackQuery } from './telegram-bot.service';
import { TextsService } from './texts.service';

const MIN = 60_000;
const SNOOZE_BUTTON_MIN = 30;
const IGNORE_WINDOW_MIN = 30;
const AIRING_MIN = 10;

type EventContext = { id: string | null; user_id: string | null; parent_id: string | null };

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : typeof v === 'number' ? String(v) : null);

/**
 * Buttons pressed under a notification: phone actions (`mobile_app_notification_action`), Telegram
 * buttons through HA (`telegram_callback`) or Klimo's own bot, and `/start <code>` pairing. Only known
 * chats and configured phones are listened to; every action is idempotent and old buttons
 * (`actionTtlH`) only say «застаріло».
 */
@Injectable()
export class InboundService implements OnModuleInit {
  private readonly log = new Logger('NotifyActions');
  private readonly attribution: () => IAttribution | null;
  private readonly pending = new Set<Promise<void>>();

  constructor(
    @Inject(HA_PORT) private readonly ha: HaPort,
    @Inject(CONFIG_STORE) private readonly config: IConfigStore,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(IncidentService) private readonly incidents: IncidentService,
    @Inject(TelegramBotService) private readonly bot: TelegramBotService,
    @Inject(TextsService) private readonly texts: TextsService,
    @Inject(HaPersistentChannel) private readonly persistent: HaPersistentChannel,
    @Optional() moduleRef?: ModuleRef,
  ) {
    this.attribution = lazyRef<IAttribution>(moduleRef, ATTRIBUTION);
  }

  onModuleInit(): void {
    this.ha.onEvent((type, data, ctx) => {
      const p = this.onHaEvent(type, data, ctx).catch((e) => this.log.warn(`${type} not handled: ${errorText(e)}`));
      this.pending.add(p);
      void p.finally(() => this.pending.delete(p));
    });
    this.bot.onCallback((q) => this.onOwnCallback(q));
    // `/start <code>` through HA's telegram_bot (integration mode pairing)
    void this.ha.subscribeEvents('telegram_command').catch((e) => this.log.debug(`telegram_command not subscribed: ${errorText(e)}`));
  }

  /** Resolves when every button press received so far has been handled. */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  async onHaEvent(type: string, data: Record<string, unknown>, ctx: EventContext): Promise<void> {
    switch (type) {
      case 'mobile_app_notification_action':
        await this.onMobileAction(data, ctx);
        return;
      case 'telegram_callback':
        await this.onIntegrationCallback(data, ctx);
        return;
      case 'telegram_command':
        await this.onIntegrationCommand(data);
        return;
      case 'call_service': {
        const sd = rec(data.service_data);
        // closing Klimo's HA notification by hand is not an «I see it», only bookkeeping
        if (data.domain === 'persistent_notification' && data.service === 'dismiss' && this.persistent.owns(sd.notification_id)) {
          await this.persistent.forget(sd.notification_id);
        }
        return;
      }
      default:
        return;
    }
  }

  /* ── phones ───────────────────────────────────────────────────────────────────────────────── */

  private async onMobileAction(data: Record<string, unknown>, ctx: EventContext): Promise<void> {
    const parsed = parseMobileAction(data.action);
    if (!parsed) return;
    const phones = this.config.list('targets').filter((t) => t.channel === 'ha_mobile' && t.enabled);
    if (!phones.length) {
      this.log.warn('a phone action arrived but no phone is configured for notifications');
      return;
    }
    // the press comes with the HA user of the phone; a phone owned by someone else is not trusted
    if (ctx.user_id && phones.every((t) => t.ownerUserId !== null && t.ownerUserId !== ctx.user_id)) {
      this.log.warn(`action from an unknown phone user ${ctx.user_id} ignored`);
      return;
    }
    if (this.expired(parsed.incidentId, null)) {
      this.log.log(`an expired button (${parsed.action}) was pressed`);
      return;
    }
    const actor: Actor = { via: 'notification', userId: ctx.user_id, userName: this.userName(ctx.user_id), contextId: ctx.id };
    const result = await this.perform(parsed.incidentId, parsed.action, actor);
    this.log.log(`phone: ${parsed.action} → ${result}`);
  }

  /* ── Telegram through HA ──────────────────────────────────────────────────────────────────── */

  private knownChat(chatId: string | null): boolean {
    return !!chatId && this.config.list('targets').some((t) => t.channel === 'telegram' && t.chatId === chatId);
  }

  private async onIntegrationCallback(data: Record<string, unknown>, ctx: EventContext): Promise<void> {
    const parsed = parseIntegrationCallback(data.data);
    if (!parsed) return;
    const message = rec(data.message);
    const chatId = str(data.chat_id) ?? str(rec(message.chat).id);
    const callbackId = str(data.id);
    const answer = async (text: string) => {
      if (!callbackId) return;
      await this.ha.callService('telegram_bot', 'answer_callback_query', undefined, { callback_query_id: callbackId, message: text }).catch(() => undefined);
    };
    const t = this.texts.context();
    if (!this.knownChat(chatId)) {
      await answer(systemText('unknownChat', {}, t));
      return;
    }
    const messageId = typeof message.message_id === 'number' ? message.message_id : null;
    const dropButtons = async () => {
      if (messageId === null || !chatId) return;
      await this.ha
        .callService('telegram_bot', 'edit_replymarkup', undefined, { message_id: messageId, chat_id: chatTarget(chatId), inline_keyboard: [] })
        .catch(() => undefined);
    };
    if (this.expired(parsed.incidentId, typeof message.date === 'number' ? message.date * 1000 : null)) {
      await answer(systemText('expired', {}, t));
      await dropButtons();
      return;
    }
    const name = [str(data.from_first), str(data.from_last)].filter(Boolean).join(' ') || null;
    const actor: Actor = { via: 'telegram', userId: ctx.user_id, userName: name, contextId: ctx.id };
    const result = await this.perform(parsed.incidentId, parsed.action, actor);
    await answer(result);
    if (parsed.action !== 'open') await dropButtons();
  }

  private async onIntegrationCommand(data: Record<string, unknown>): Promise<void> {
    if (this.config.singleton('notify').telegram.mode !== 'integration') return;
    const command = str(data.command);
    if (!command || !/^\/start(@\w+)?$/.test(command)) return;
    const chat = rec(data.chat);
    const chatId = str(data.chat_id) ?? str(chat.id);
    if (!chatId) return;
    const args = Array.isArray(data.args) ? data.args : [];
    const code = typeof args[0] === 'string' ? args[0] : null;
    const title = str(chat.title) ?? ([str(data.from_first), str(data.from_last)].filter(Boolean).join(' ') || chatId);
    const group = chat.type === 'group' || chat.type === 'supergroup' || chatId.startsWith('-');
    await this.bot.pairChat(chatId, title, code, group, async (text) => {
      await this.ha.callService('telegram_bot', 'send_message', undefined, { target: [chatTarget(chatId)], message: text });
    });
  }

  /* ── Klimo's own bot ──────────────────────────────────────────────────────────────────────── */

  async onOwnCallback(q: TgCallbackQuery): Promise<void> {
    const t = this.texts.context();
    const chatId = q.message ? String(q.message.chat.id) : null;
    const answer = (text: string) => this.bot.answerCallback(q.id, text).catch((e) => this.log.debug(`answerCallbackQuery: ${errorText(e)}`));
    if (!this.knownChat(chatId)) {
      await answer(systemText('unknownChat', {}, t));
      return;
    }
    const parsed = parseOwnCallback(q.data);
    if (!parsed || !chatId) {
      await answer('…');
      return;
    }
    const finish = async (line: string) => {
      if (!q.message) return;
      await this.bot
        .finishMessage(chatId, q.message.message_id, `${originalHtml(q.message.text ?? '')}\n\n${escapeHtml(line)}`)
        .catch((e) => this.log.debug(`editMessageText: ${errorText(e)}`));
    };
    if (this.expired(parsed.incidentId, q.message ? q.message.date * 1000 : null)) {
      const text = systemText('expired', {}, t);
      await answer(text);
      await finish(text);
      return;
    }
    const name = [q.from.first_name, q.from.last_name].filter(Boolean).join(' ') || (q.from.username ? `@${q.from.username}` : null);
    const actor: Actor = { via: 'telegram', userId: null, userName: name, contextId: null };
    const result = await this.perform(parsed.incidentId, parsed.action, actor);
    await answer(result);
    if (parsed.action !== 'open') await finish(`✓ ${result}`);
  }

  /* ── shared ───────────────────────────────────────────────────────────────────────────────── */

  /** Runs the action and says what happened, in the house's notification language. */
  async perform(incidentId: Id, action: IncidentAction, actor: Actor): Promise<string> {
    const ctx = this.texts.context();
    if (action === 'open') return systemText('openHint', {}, ctx);
    const now = this.clock.now();
    try {
      const dto = await this.incidents.act(incidentId, request(action), actor);
      const until =
        action === 'ignore_window' ? now + IGNORE_WINDOW_MIN * MIN : action === 'airing' ? now + AIRING_MIN * MIN : (dto.snoozedUntil ?? null);
      return actionResult(action, { at: dto.ackAt ?? now, by: actor.userName, until }, ctx);
    } catch (e) {
      if (e instanceof ApiException && e.getStatus() === HttpStatus.NOT_FOUND) return systemText('expired', {}, ctx);
      if (e instanceof ApiException && e.getStatus() === HttpStatus.CONFLICT && (action === 'snooze' || action === 'snooze_until_morning' || action === 'dismiss')) {
        return systemText('criticalAckOnly', {}, ctx);
      }
      this.log.warn(`${action} on ${incidentId} failed: ${errorText(e)}`);
      return systemText('failed', { error: e instanceof ApiException ? e.code : errorText(e) }, ctx);
    }
  }

  /**
   * Buttons expire after `actionTtlH`: the message date tells for Telegram; phones only carry the
   * incident, so its last notification counts.
   */
  private expired(incidentId: Id, sentAt: EpochMs | null): boolean {
    const s = this.config.singleton('notify');
    const ttl = Math.max(1, s.actionTtlH) * 60 * MIN;
    const now = this.clock.now();
    if (sentAt !== null) return now - sentAt > ttl;
    const inc = this.incidents.snapshot(incidentId);
    if (!inc) return false;
    const last = (inc.notifiedAt ?? inc.openedAt) + inc.repeatCount * Math.max(1, s.repeatCritical.everyMin) * MIN;
    return now - last > ttl;
  }

  private userName(userId: string | null): string | null {
    if (!userId) return null;
    try {
      return this.attribution()?.userName(userId) ?? null;
    } catch {
      return null;
    }
  }
}

function request(action: IncidentAction): IncidentActionRequest {
  return action === 'snooze' ? { action, minutes: SNOOZE_BUTTON_MIN } : { action };
}

/** The pressed message as it was (title in bold), before the result line is appended. */
function originalHtml(text: string): string {
  const [first, ...rest] = text.split('\n');
  const head = first ? `<b>${escapeHtml(first)}</b>` : '';
  return [head, ...rest.map(escapeHtml)].join('\n').trim();
}
