import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { BRAND } from '../../common/brand';
import { errorText } from '../../common/logger';
import { Db } from '../../db/database';
import type { HaPort, Id, NotifyTarget } from '../../shared/model';
import { HA_PORT } from '../../tokens';
import type { ChannelAdapter, OutboundMessage } from './channel';

const KV_KEY = 'notify.persistent';
const PREFIX = 'klimo_';

/**
 * Persistent notifications in the HA sidebar, visible to every household member. Klimo dismisses its
 * own when the problem is over; which ones are still open is remembered across restarts so the
 * channel card can say «2 відкриті».
 */
@Injectable()
export class HaPersistentChannel implements ChannelAdapter, OnModuleInit {
  readonly kind = 'ha_persistent' as const;
  private readonly log = new Logger('PersistentNotifications');
  private readonly openIds = new Set<string>();

  constructor(
    @Inject(HA_PORT) private readonly ha: HaPort,
    @Inject(Db) private readonly db: Db,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      const raw = await this.db.kvGet(KV_KEY);
      const ids: unknown = raw ? JSON.parse(raw) : [];
      if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string') this.openIds.add(id);
    } catch (e) {
      this.log.warn(`open notifications not restored: ${errorText(e)}`);
    }
  }

  static notificationId(key: string): string {
    return `${PREFIX}${key}`;
  }

  async deliver(_target: NotifyTarget, msg: OutboundMessage): Promise<void> {
    const id = HaPersistentChannel.notificationId(msg.incidentId ?? msg.tag ?? msg.sentKind);
    await this.ha.callService('persistent_notification', 'create', undefined, { notification_id: id, title: msg.body ? msg.title : BRAND.productName, message: msg.body || msg.title });
    if (!this.openIds.has(id)) {
      this.openIds.add(id);
      await this.save();
    }
  }

  async withdraw(_target: NotifyTarget, incidentId: Id): Promise<void> {
    await this.dismiss(HaPersistentChannel.notificationId(incidentId));
  }

  async dismiss(notificationId: string): Promise<void> {
    if (!this.openIds.has(notificationId)) return;
    await this.ha.callService('persistent_notification', 'dismiss', undefined, { notification_id: notificationId });
    await this.forget(notificationId);
  }

  /** Someone closed it in the HA sidebar (that is not an «I see it»). */
  async forget(notificationId: string): Promise<void> {
    if (!this.openIds.delete(notificationId)) return;
    await this.save();
  }

  owns(notificationId: unknown): notificationId is string {
    return typeof notificationId === 'string' && notificationId.startsWith(PREFIX);
  }

  openCount(): number {
    return this.openIds.size;
  }

  private async save(): Promise<void> {
    try {
      await this.db.kvSet(KV_KEY, JSON.stringify([...this.openIds]));
    } catch (e) {
      this.log.warn(`open notifications not saved: ${errorText(e)}`);
    }
  }
}
