import { Inject, Injectable } from '@nestjs/common';
import { BRAND } from '../../common/brand';
import type { HaPort, NotifyTarget } from '../../shared/model';
import { HA_PORT } from '../../tokens';
import { splitService } from './channel';
import type { ChannelAdapter, OutboundMessage } from './channel';

/** Any other `notify.*` service (e-mail, a TV, a smart speaker): plain title and text, no buttons. */
@Injectable()
export class HaNotifyChannel implements ChannelAdapter {
  readonly kind = 'ha_notify' as const;

  constructor(@Inject(HA_PORT) private readonly ha: HaPort) {}

  async deliver(target: NotifyTarget, msg: OutboundMessage): Promise<void> {
    const [domain, service] = splitService(target.service);
    const data = msg.body ? { title: msg.title, message: msg.body } : { title: BRAND.productName, message: msg.title };
    await this.ha.callService(domain, service, undefined, data);
  }
}
