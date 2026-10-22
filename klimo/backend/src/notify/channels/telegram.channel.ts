import { Inject, Injectable } from '@nestjs/common';
import type { HaPort, IConfigStore, NotifyTarget } from '../../shared/model';
import { CONFIG_STORE, HA_PORT } from '../../tokens';
import { escapeHtml } from '../messages';
import { TelegramBotService } from '../telegram-bot.service';
import type { TgButton } from '../telegram-bot.service';
import { ownCallbackData, splitService } from './channel';
import type { ChannelAdapter, OutboundMessage } from './channel';

/** Telegram message body: the title in bold, then the text. */
export function telegramHtml(msg: Pick<OutboundMessage, 'title' | 'body'>): string {
  const body = msg.body.trim();
  return body ? `<b>${escapeHtml(msg.title)}</b>\n${escapeHtml(body)}` : `<b>${escapeHtml(msg.title)}</b>`;
}

/** Two buttons per row, then «Відкрити Klimo» on its own row (as in the preview). */
export function telegramRows(msg: OutboundMessage): { text: string; action: OutboundMessage['actions'][number]['action'] }[][] {
  if (!msg.incidentId) return [];
  const rows: { text: string; action: OutboundMessage['actions'][number]['action'] }[][] = [];
  const buttons = msg.actions.map((a) => ({ text: a.label, action: a.action }));
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  rows.push([{ text: msg.openLabel, action: 'open' }]);
  return rows;
}

/**
 * Telegram chats, in either mode: Klimo's own bot (Bot API, buttons as callback queries) or Home
 * Assistant's `telegram_bot` integration (buttons come back as the `telegram_callback` event).
 */
@Injectable()
export class TelegramChannel implements ChannelAdapter {
  readonly kind = 'telegram' as const;

  constructor(
    @Inject(HA_PORT) private readonly ha: HaPort,
    @Inject(CONFIG_STORE) private readonly config: IConfigStore,
    @Inject(TelegramBotService) private readonly bot: TelegramBotService,
  ) {}

  /** Own-bot mode, or the only way left while Home Assistant is down. */
  usesOwnBot(): boolean {
    return this.bot.configured() && (this.config.singleton('notify').telegram.mode === 'own' || !this.ha.connected);
  }

  async deliver(target: NotifyTarget, msg: OutboundMessage): Promise<void> {
    if (!target.chatId) throw new Error('the target has no chat id');
    const text = telegramHtml(msg);
    const rows = telegramRows(msg);
    if (this.usesOwnBot()) {
      const keyboard: TgButton[][] = rows.map((r) => r.map((b) => ({ text: b.text, callback_data: ownCallbackData(msg.incidentId as string, b.action) })));
      await this.bot.send(target.chatId, text, keyboard, { silent: msg.silent });
      return;
    }
    if (this.config.singleton('notify').telegram.mode === 'own') throw new Error('no bot token in the add-on options');
    const [domain, service] = splitService(this.config.singleton('notify').telegram.haService ?? 'telegram_bot.send_message');
    const data: Record<string, unknown> = {
      target: [chatTarget(target.chatId)],
      message: text,
      parse_mode: 'html',
    };
    if (rows.length) data.inline_keyboard = rows.map((r) => r.map((b) => `${b.text.replace(/[,:]/g, ' ')}:/klimo ${b.action} ${msg.incidentId}`).join(', '));
    if (msg.silent) data.disable_notification = true;
    await this.ha.callService(domain, service, undefined, data);
  }
}

/** HA's telegram_bot wants numbers; ids beyond 2^53 stay strings. */
export function chatTarget(chatId: string): number | string {
  const n = Number(chatId);
  return Number.isSafeInteger(n) ? n : chatId;
}
