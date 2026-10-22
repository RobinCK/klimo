import { Inject, Injectable } from '@nestjs/common';
import { BRAND } from '../../common/brand';
import type { HaPort, Id, ISupervisor, NotifyTarget } from '../../shared/model';
import { HA_PORT, SUPERVISOR } from '../../tokens';
import { mobileActionId, splitService } from './channel';
import type { ChannelAdapter, OutboundMessage } from './channel';

/** Android shows at most three buttons under a notification. */
const MAX_BUTTONS = 3;

/**
 * Home Assistant companion app push (`notify.mobile_app_*`). One notification per incident: the tag
 * makes repeats and the recovery replace it instead of piling up; buttons come back as the
 * `mobile_app_notification_action` event.
 */
@Injectable()
export class HaMobileChannel implements ChannelAdapter {
  readonly kind = 'ha_mobile' as const;

  constructor(
    @Inject(HA_PORT) private readonly ha: HaPort,
    @Inject(SUPERVISOR) private readonly supervisor: ISupervisor,
  ) {}

  /** The service-call payload (also what the preview and tests look at). */
  payload(msg: OutboundMessage): Record<string, unknown> {
    const panel = this.supervisor.panelPath();
    const data: Record<string, unknown> = { group: 'klimo' };
    if (msg.tag) data.tag = msg.tag;
    if (panel) {
      data.url = panel;
      data.clickAction = panel;
    }
    const buttons: Record<string, unknown>[] = [];
    if (msg.incidentId) {
      const room = panel ? MAX_BUTTONS - 1 : MAX_BUTTONS;
      for (const a of msg.actions.slice(0, room)) buttons.push({ action: mobileActionId(a.action, msg.incidentId), title: a.label });
    }
    if (panel) buttons.push({ action: 'URI', title: msg.openLabel, uri: panel });
    if (buttons.length) data.actions = buttons;
    if (msg.critical) {
      // iOS reads `push.sound`, Android the channel/importance keys; each ignores the other's
      data.push = { sound: { name: 'default', critical: 1, volume: 1.0 } };
      data.channel = 'klimo_critical';
      data.importance = 'high';
      data.priority = 'high';
      data.ttl = 0;
    } else if (msg.silent) {
      data.push = { 'interruption-level': 'passive' };
      data.channel = 'klimo_info';
      data.importance = 'low';
    }
    // a one-line message (a recovery) goes as the text under the product name
    return msg.body ? { title: msg.title, message: msg.body, data } : { title: BRAND.productName, message: msg.title, data };
  }

  async deliver(target: NotifyTarget, msg: OutboundMessage): Promise<void> {
    const [domain, service] = splitService(target.service);
    await this.ha.callService(domain, service, undefined, this.payload(msg));
  }

  async withdraw(target: NotifyTarget, incidentId: Id): Promise<void> {
    const [domain, service] = splitService(target.service);
    await this.ha.callService(domain, service, undefined, { message: 'clear_notification', data: { tag: incidentId } });
  }
}
