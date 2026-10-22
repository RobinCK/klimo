import { Global, Module } from '@nestjs/common';
import { INCIDENTS, NOTIFY, TEXTS } from '../tokens';
import { HaEventChannel } from './channels/ha-event.channel';
import { HaMobileChannel } from './channels/ha-mobile.channel';
import { HaNotifyChannel } from './channels/ha-notify.channel';
import { HaPersistentChannel } from './channels/ha-persistent.channel';
import { ChannelHealth } from './channels/health';
import { TelegramChannel } from './channels/telegram.channel';
import { InboundService } from './inbound.service';
import { IncidentService } from './incidents.service';
import { NotifyService } from './notify.service';
import { ReportsService } from './reports.service';
import { NotifyRouter } from './router.service';
import { TelegramBotService } from './telegram-bot.service';
import { TextsService } from './texts.service';
import { WatchService } from './watch.service';

/**
 * Incidents and everything that tells people about them: routing, channels (HA app, notify services,
 * the HA sidebar, Telegram, the automation event), the own Telegram bot, button actions, watch rules,
 * reports, and the texts of notifications and Lovelace cards.
 */
@Global()
@Module({
  providers: [
    TextsService,
    { provide: TEXTS, useExisting: TextsService },
    IncidentService,
    { provide: INCIDENTS, useExisting: IncidentService },
    ChannelHealth,
    HaMobileChannel,
    HaNotifyChannel,
    HaPersistentChannel,
    HaEventChannel,
    TelegramBotService,
    TelegramChannel,
    NotifyRouter,
    WatchService,
    ReportsService,
    InboundService,
    NotifyService,
    { provide: NOTIFY, useExisting: NotifyService },
  ],
  exports: [INCIDENTS, NOTIFY, TEXTS],
})
export class NotifyModule {}
