import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { randomInt } from 'crypto';
import { errorText } from '../common/logger';
import { Db } from '../db/database';
import { env } from '../env';
import type { Actor, ClockPort, EpochMs, IBus, IConfigStore, Id, NotifyTarget, TelegramPairDto, TelegramPairStatusDto } from '../shared/model';
import { DEFAULT_TARGET } from '../shared/defaults';
import { BUS, CLOCK, CONFIG_STORE } from '../tokens';
import { ChannelHealth } from './channels/health';
import { clip, systemText } from './messages';
import { TextsService } from './texts.service';

export interface TgChat {
  id: number;
  type: string;
  title?: string;
  first_name?: string;
  last_name?: string;
  username?: string;
}
export interface TgMessage {
  message_id: number;
  date: number;
  chat: TgChat;
  text?: string;
}
export interface TgCallbackQuery {
  id: string;
  from: { id: number; first_name?: string; last_name?: string; username?: string };
  message?: TgMessage;
  data?: string;
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}
export interface TgButton {
  text: string;
  callback_data: string;
}

/** The HTTP client (global `fetch`); tests replace it. */
export type HttpFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export class TelegramError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Pair {
  expiresAt: EpochMs;
  status: 'pending' | 'paired';
  targetId: Id | null;
}

const API = 'https://api.telegram.org';
const POLL_TIMEOUT_SEC = 50;
const PAIR_TTL_MS = 10 * 60_000;
/** After a 409 or a webhook the other side may go away; look again this often. */
const RECHECK_MS = 10 * 60_000;
const OFFSET_KEY = 'telegram.offset';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_TEXT = 4000;

const SYSTEM_ACTOR = (name: string | null): Actor => ({ via: 'telegram', userId: null, userName: name, contextId: null });

/**
 * Klimo's own Telegram bot (token from the add-on options, never stored in the database): sends
 * messages with inline buttons and long-polls for button presses and `/start <code>` pairing. It
 * needs no Home Assistant, so it is the one channel that can say «HA не на зв’язку». A webhook on the
 * token or another poller (HA's `telegram_bot` with the same token → 409) stops polling; sending
 * keeps working and the channel shows why buttons do not.
 */
@Injectable()
export class TelegramBotService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('TelegramBot');
  http: HttpFn = (url, init) => fetch(url, init);
  token: string = env.telegramToken;
  botUsername: string | null = null;
  private polling = false;
  private abort: AbortController | null = null;
  private loopDone: Promise<void> | null = null;
  private recheck: NodeJS.Timeout | null = null;
  private offset: number | null = null;
  private readonly pairs = new Map<string, Pair>();
  private callbackHandler: ((q: TgCallbackQuery) => Promise<void>) | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    @Inject(CONFIG_STORE) private readonly config: IConfigStore,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(Db) private readonly db: Db,
    @Inject(BUS) private readonly bus: IBus,
    @Inject(ChannelHealth) private readonly health: ChannelHealth,
    @Inject(TextsService) private readonly texts: TextsService,
  ) {}

  onApplicationBootstrap(): void {
    this.unsubscribe = this.bus.on('config.changed', (e) => {
      if (e.entity === 'notify_settings' || e.op === 'imported') void this.reconcile();
    });
    void this.reconcile();
  }

  async onModuleDestroy(): Promise<void> {
    this.unsubscribe?.();
    await this.stop();
  }

  configured(): boolean {
    return this.token.trim() !== '';
  }

  ownMode(): boolean {
    return this.config.singleton('notify').telegram.mode === 'own';
  }

  /** Button presses of the own bot go here (the inbound action handler). */
  onCallback(handler: (q: TgCallbackQuery) => Promise<void>): void {
    this.callbackHandler = handler;
  }

  /** Starts or stops polling to match the settings. */
  async reconcile(): Promise<void> {
    if (this.configured() && this.ownMode()) {
      this.start();
    } else {
      await this.stop();
      this.health.setCondition('telegram', null);
    }
  }

  isPolling(): boolean {
    return this.polling;
  }

  private start(): void {
    if (this.polling) return;
    this.polling = true;
    this.abort = new AbortController();
    this.loopDone = this.loop().catch((e) => this.log.error(`polling stopped: ${errorText(e)}`));
  }

  async stop(): Promise<void> {
    this.polling = false;
    this.abort?.abort();
    if (this.recheck) clearTimeout(this.recheck);
    this.recheck = null;
    await this.loopDone;
    this.loopDone = null;
  }

  private async loop(): Promise<void> {
    const me = await this.verify();
    if (!me.ok) {
      this.polling = false;
      if (!this.health.condition('telegram')) this.retryLater();
      return;
    }
    if (!(await this.checkWebhook())) {
      this.polling = false;
      this.retryLater();
      return;
    }
    let backoff = 5_000;
    this.log.log(`@${this.botUsername ?? '?'}: listening for button presses`);
    while (this.polling) {
      const r = await this.pollOnce();
      if (r === 'conflict') {
        this.polling = false;
        this.retryLater();
        return;
      }
      if (r === 'fatal' || r === 'stopped') {
        this.polling = false;
        return;
      }
      if (r === 'error') {
        await this.pause(backoff);
        backoff = Math.min(backoff * 2, 60_000);
      } else {
        backoff = 5_000;
      }
    }
  }

  private retryLater(): void {
    if (this.recheck) clearTimeout(this.recheck);
    this.recheck = setTimeout(() => {
      this.recheck = null;
      void this.reconcile();
    }, RECHECK_MS);
    this.recheck.unref?.();
  }

  private pause(ms: number): Promise<void> {
    const signal = this.abort?.signal;
    return new Promise((resolve) => {
      const onAbort = () => {
        clearTimeout(t);
        resolve();
      };
      const t = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      t.unref?.();
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /* ── Bot API ──────────────────────────────────────────────────────────────────────────────── */

  /** One Bot API request; `signal` ties a long poll to the polling loop (sends never are). */
  async call<T>(method: string, body: Record<string, unknown>, timeoutMs = 15_000, signal?: AbortSignal): Promise<T> {
    if (!this.configured()) throw new TelegramError(0, 'no bot token in the add-on options');
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (signal) signals.push(signal);
    const res = await this.http(`${API}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.any(signals),
    });
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      // a proxy error page: the status says enough
    }
    const r = (parsed && typeof parsed === 'object' ? parsed : {}) as { ok?: boolean; result?: unknown; description?: string; error_code?: number };
    if (res.status >= 400 || r.ok !== true) {
      throw new TelegramError(r.error_code ?? res.status, r.description ?? `HTTP ${res.status}`);
    }
    return r.result as T;
  }

  /** getMe: checks the token and learns the bot's @name (deep links, the channel card). */
  async verify(): Promise<{ ok: boolean; botUsername: string | null; error: string | null }> {
    if (!this.configured()) return { ok: false, botUsername: null, error: 'no_token' };
    try {
      const me = await this.call<{ username?: string }>('getMe', {});
      this.botUsername = me.username ?? null;
      if (this.health.condition('telegram') === 'token_rejected') this.health.setCondition('telegram', null);
      const settings = this.config.singleton('notify');
      if (this.botUsername && settings.telegram.botUsername !== this.botUsername) {
        await this.config.patchSingleton('notify', { telegram: { ...settings.telegram, botUsername: this.botUsername } }, SYSTEM_ACTOR(null));
      }
      return { ok: true, botUsername: this.botUsername, error: null };
    } catch (e) {
      const error = errorText(e);
      if (e instanceof TelegramError && (e.status === 401 || e.status === 404)) this.health.setCondition('telegram', 'token_rejected', error);
      this.log.warn(`getMe failed: ${error}`);
      return { ok: false, botUsername: this.botUsername, error };
    }
  }

  /** A webhook on the token means updates go elsewhere: polling would only fight it. */
  async checkWebhook(): Promise<boolean> {
    try {
      const info = await this.call<{ url?: string }>('getWebhookInfo', {});
      if (info.url) {
        this.health.setCondition('telegram', 'webhook_set', info.url);
        this.log.warn('a webhook is set for this bot — button presses go there, not to Klimo');
        return false;
      }
      if (this.health.condition('telegram') === 'webhook_set') this.health.setCondition('telegram', null);
      return true;
    } catch (e) {
      this.log.warn(`getWebhookInfo failed: ${errorText(e)}`);
      return true;
    }
  }

  /** One long poll; the offset is saved so a restart never handles a button press twice. */
  async pollOnce(): Promise<'ok' | 'conflict' | 'fatal' | 'error' | 'stopped'> {
    if (this.offset === null) {
      const stored = Number(await this.db.kvGet(OFFSET_KEY));
      this.offset = Number.isFinite(stored) && stored > 0 ? stored : 0;
    }
    try {
      const updates = await this.call<TgUpdate[]>(
        'getUpdates',
        { timeout: POLL_TIMEOUT_SEC, offset: this.offset, allowed_updates: ['callback_query', 'message'] },
        (POLL_TIMEOUT_SEC + 15) * 1000,
        this.abort?.signal,
      );
      if (this.health.condition('telegram') === 'polling_conflict') this.health.setCondition('telegram', null);
      let next = this.offset;
      for (const u of Array.isArray(updates) ? updates : []) {
        next = Math.max(next, u.update_id + 1);
        try {
          await this.handleUpdate(u);
        } catch (e) {
          this.log.warn(`update ${u.update_id} not handled: ${errorText(e)}`);
        }
      }
      if (next !== this.offset) {
        this.offset = next;
        await this.db.kvSet(OFFSET_KEY, String(next));
      }
      return 'ok';
    } catch (e) {
      if (this.abort?.signal.aborted && !this.polling) return 'stopped';
      if (e instanceof TelegramError && e.status === 409) {
        this.health.setCondition('telegram', 'polling_conflict', e.message);
        this.log.warn('another client polls this bot (409): sending works, button presses go to the other one');
        return 'conflict';
      }
      if (e instanceof TelegramError && (e.status === 401 || e.status === 404)) {
        this.health.setCondition('telegram', 'token_rejected', e.message);
        return 'fatal';
      }
      this.log.warn(`getUpdates failed: ${errorText(e)}`);
      return 'error';
    }
  }

  private async handleUpdate(u: TgUpdate): Promise<void> {
    if (u.callback_query) {
      if (this.callbackHandler) await this.callbackHandler(u.callback_query);
      else await this.answerCallback(u.callback_query.id, '…');
      return;
    }
    const m = u.message;
    const start = m?.text ? /^\/start(?:@\w+)?(?:\s+(\S+))?/.exec(m.text.trim()) : null;
    if (!m || !start) return;
    const chat = m.chat;
    const group = chat.type === 'group' || chat.type === 'supergroup';
    await this.pairChat(String(chat.id), chatTitle(chat), start[1] ?? null, group, (text) => this.send(String(chat.id), text).then(() => undefined));
  }

  async send(chatId: string, html: string, keyboard: TgButton[][] = [], opts: { silent?: boolean } = {}): Promise<number> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text: clip(html, MAX_TEXT),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    };
    if (keyboard.length) body.reply_markup = { inline_keyboard: keyboard };
    if (opts.silent) body.disable_notification = true;
    const msg = await this.call<{ message_id: number }>('sendMessage', body);
    return msg.message_id;
  }

  async answerCallback(callbackId: string, text: string): Promise<void> {
    await this.call('answerCallbackQuery', { callback_query_id: callbackId, text: clip(text, 190) });
  }

  /** Replaces the text and drops the buttons (a pressed message keeps only its result line). */
  async finishMessage(chatId: string, messageId: number, html: string): Promise<void> {
    await this.call('editMessageText', { chat_id: chatId, message_id: messageId, text: clip(html, MAX_TEXT), parse_mode: 'HTML' });
  }

  /* ── pairing ──────────────────────────────────────────────────────────────────────────────── */

  createPair(): TelegramPairDto {
    const now = this.clock.now();
    this.prunePairs(now);
    let code = '';
    do {
      code = Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
    } while (this.pairs.has(code));
    const expiresAt = now + PAIR_TTL_MS;
    this.pairs.set(code, { expiresAt, status: 'pending', targetId: null });
    const bot = this.botUsername ?? this.config.singleton('notify').telegram.botUsername;
    return { code, deepLink: bot && this.ownMode() ? `https://t.me/${bot}?start=${code}` : null, expiresAt };
  }

  pairStatus(code: string): TelegramPairStatusDto {
    const p = this.pairs.get(code.trim().toUpperCase());
    if (!p) return { status: 'expired', target: null };
    if (p.status === 'paired' && p.targetId) return { status: 'paired', target: this.config.get('targets', p.targetId) ?? null };
    return { status: this.clock.now() > p.expiresAt ? 'expired' : 'pending', target: null };
  }

  /**
   * `/start <code>` from a chat: a valid code turns the chat into a notification target (title from
   * Telegram; the first messaging target becomes the primary one). Used by both bot modes.
   */
  async pairChat(chatId: string, title: string, code: string | null, group: boolean, reply: (text: string) => Promise<void>): Promise<NotifyTarget | null> {
    const ctx = this.texts.context();
    const now = this.clock.now();
    const pair = code ? this.pairs.get(code.trim().toUpperCase()) : undefined;
    if (!pair) {
      await reply(systemText('pairUnknown', {}, ctx)).catch(() => undefined);
      return null;
    }
    if (pair.status === 'pending' && now > pair.expiresAt) {
      await reply(systemText('pairExpired', {}, ctx)).catch(() => undefined);
      return null;
    }
    const targets = this.config.list('targets');
    let target = targets.find((t) => t.channel === 'telegram' && t.chatId === chatId) ?? null;
    if (!target) {
      const name = clip(title || (group ? 'Telegram group' : 'Telegram'), 40);
      const { id: _id, ...base } = DEFAULT_TARGET();
      target = await this.config.create(
        'targets',
        {
          ...base,
          channel: 'telegram',
          name,
          shortName: clip(`Telegram · ${title || chatId}`, 24),
          icon: group ? 'users' : 'send',
          chatId,
          chatTitle: title || null,
          isPrimary: !targets.some((t) => t.isPrimary),
          order: targets.length,
        },
        SYSTEM_ACTOR(title || null),
      );
      this.log.log(`paired ${group ? 'group' : 'chat'} «${title}»`);
    }
    pair.status = 'paired';
    pair.targetId = target.id;
    await reply(systemText('pairDone', {}, ctx)).catch(() => undefined);
    return target;
  }

  private prunePairs(now: EpochMs): void {
    for (const [code, p] of this.pairs) if (now - p.expiresAt > PAIR_TTL_MS) this.pairs.delete(code);
  }
}

export function chatTitle(chat: Pick<TgChat, 'title' | 'first_name' | 'last_name' | 'username'>): string {
  if (chat.title) return chat.title;
  const name = [chat.first_name, chat.last_name].filter(Boolean).join(' ');
  return name || (chat.username ? `@${chat.username}` : '');
}
