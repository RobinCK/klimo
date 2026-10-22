import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ApiException } from '../common/http';
import type {
  ChannelKind,
  ClockPort,
  Detection,
  EpochMs,
  EventKind,
  IConfigStore,
  INotify,
  NotificationPreviewDto,
  NotificationsDto,
  NotifyTarget,
  RoutingCell,
  SentMessage,
  Severity,
  TelegramPairDto,
  TelegramPairStatusDto,
  TestNotificationRequest,
  TestNotificationResponse,
  WatchRuleDto,
} from '../shared/model';
import { CHANNEL_KINDS, EVENT_SEVERITY } from '../shared/model';
import { CLOCK, CONFIG_STORE } from '../tokens';
import { actionsFor, EVENT_CATALOGUE } from './catalogue';
import { ChannelHealth } from './channels/health';
import { HaPersistentChannel } from './channels/ha-persistent.channel';
import { actionLabel, renderIncident, sampleIncident, sampleNames, textContext } from './messages';
import { NotifyRouter } from './router.service';
import { TelegramBotService } from './telegram-bot.service';
import { TextsService } from './texts.service';
import { WatchService } from './watch.service';

/** Phones show at most three buttons, one of them «Відкрити». */
const PUSH_BUTTONS = 2;

/** Derived scope pill of a matrix column. */
export function targetScope(t: NotifyTarget, routing: readonly RoutingCell[]): NotificationsDto['targets'][number]['scope'] {
  const on = routing.filter((c) => c.targetId === t.id && c.on);
  if (!on.length || !on.every((c) => EVENT_SEVERITY[c.kind] === 'critical')) return 'by_matrix';
  return t.isEscalation ? 'critical_and_escalation' : 'critical_only';
}

/**
 * `INotify`: what the Notifications page and the engine shell ask of notifications — settings with
 * live channel status, tests, previews from the real templates, the delivery log, Telegram pairing and
 * the watch rules.
 */
@Injectable()
export class NotifyService implements INotify {
  constructor(
    @Inject(CONFIG_STORE) private readonly config: IConfigStore,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(NotifyRouter) private readonly router: NotifyRouter,
    @Inject(WatchService) private readonly watch: WatchService,
    @Inject(TelegramBotService) private readonly bot: TelegramBotService,
    @Inject(ChannelHealth) private readonly health: ChannelHealth,
    @Inject(HaPersistentChannel) private readonly persistent: HaPersistentChannel,
    @Inject(TextsService) private readonly texts: TextsService,
  ) {}

  settings(): NotificationsDto {
    const settings = this.config.singleton('notify');
    const targets = this.config.list('targets');
    const routing = this.config.routing();
    return {
      settings,
      targets: targets.map((t) => ({ ...t, scope: targetScope(t, routing) })),
      routing,
      catalogue: EVENT_CATALOGUE.map((e) => ({ ...e, defaultRoute: { ...e.defaultRoute }, defaultParams: { ...e.defaultParams }, actions: [...e.actions] })),
      events: this.config.eventParams(),
      channels: CHANNEL_KINDS.map((kind) => this.channel(kind, targets)),
      telegramTokenPresent: this.bot.configured(),
    };
  }

  private channel(kind: ChannelKind, targets: NotifyTarget[]): NotificationsDto['channels'][number] {
    const mine = targets.filter((t) => t.channel === kind);
    const live = this.health.status(kind);
    const extra: Partial<NotificationsDto['channels'][number]> = {};
    if (kind === 'ha_persistent') extra.openCount = this.persistent.openCount();
    if (kind === 'telegram') extra.botUsername = this.bot.botUsername ?? this.config.singleton('notify').telegram.botUsername;
    if (kind === 'telegram' && this.config.singleton('notify').telegram.mode === 'own' && !this.bot.configured()) {
      return { channel: kind, status: 'unconfigured', detail: 'no_token', lastOkAt: live.lastOkAt, ...extra };
    }
    if (!mine.length) return { channel: kind, status: 'unconfigured', detail: null, lastOkAt: live.lastOkAt, ...extra };
    if (!mine.some((t) => t.enabled)) return { channel: kind, status: 'disabled', detail: null, lastOkAt: live.lastOkAt, ...extra };
    return { channel: kind, ...live, ...extra };
  }

  test(req: TestNotificationRequest): Promise<TestNotificationResponse> {
    return this.router.test(req);
  }

  /** «Як це виглядатиме»: the real templates with the demo house's facts. */
  preview(kind: EventKind): NotificationPreviewDto {
    const lang = this.texts.lang();
    const now = this.clock.now();
    const ctx = textContext(lang, now, this.clock.tz(), sampleNames(lang));
    const inc = sampleIncident(kind, now);
    const text = renderIncident(inc, ctx);
    const actions = actionsFor(kind, EVENT_SEVERITY[kind]).filter((a) => a !== 'open');
    const labels = actions.map((a) => actionLabel(a, lang));
    const open = actionLabel('open', lang);
    const rows: string[][] = [];
    for (let i = 0; i < labels.length; i += 2) rows.push(labels.slice(i, i + 2));
    rows.push([open]);
    return {
      kind,
      push: { title: text.title, body: text.body, actions: [...labels.slice(0, PUSH_BUTTONS), open] },
      telegram: { text: `${text.title}\n${text.body}`, buttons: rows },
    };
  }

  log(q: { before?: EpochMs; limit?: number; kind?: EventKind; severity?: Severity }): Promise<SentMessage[]> {
    return this.router.logPage(q);
  }

  telegramVerify(): Promise<{ ok: boolean; botUsername: string | null; error: string | null }> {
    return this.bot.verify();
  }

  async telegramPair(): Promise<TelegramPairDto> {
    const mode = this.config.singleton('notify').telegram.mode;
    if (mode === 'own') {
      if (!this.bot.configured()) throw new ApiException(HttpStatus.CONFLICT, 'unsupported', 'No Telegram bot token in the add-on options');
      if (!this.bot.botUsername) await this.bot.verify();
    }
    return this.bot.createPair();
  }

  telegramPairStatus(code: string): TelegramPairStatusDto {
    return this.bot.pairStatus(code);
  }

  watchRules(filter?: 'all' | 'problems' | 'manual', q?: string): WatchRuleDto[] {
    return this.watch.list(filter ?? 'all', q);
  }

  watchDetections(now: EpochMs): Detection[] {
    return this.watch.watchDetections(now);
  }
}
