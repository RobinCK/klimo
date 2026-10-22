import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { errorText } from '../../common/logger';
import { lazyRef } from '../../common/refs';
import type { HaPort, KlimoEventPayload, MqttTransport } from '../../shared/model';
import { HA_PORT, MQTT_TRANSPORT } from '../../tokens';

export const EVENT_TYPE = 'klimo_event';
export const EVENTS_TOPIC = 'klimo/events';

/**
 * «Подія для автоматизацій»: the same payload on the HA bus (`klimo_event`) and on MQTT
 * (`klimo/events`, QoS 1, not retained), so automations and Node-RED react even while one of the two
 * links is down. Delivered when at least one of them took it.
 */
@Injectable()
export class HaEventChannel {
  readonly kind = 'ha_event' as const;
  private readonly log = new Logger('KlimoEvent');
  private readonly transport: () => MqttTransport | null;

  constructor(
    @Inject(HA_PORT) private readonly ha: HaPort,
    @Optional() moduleRef?: ModuleRef,
  ) {
    this.transport = lazyRef<MqttTransport>(moduleRef, MQTT_TRANSPORT);
  }

  async emit(payload: KlimoEventPayload): Promise<void> {
    const errors: string[] = [];
    let delivered = false;
    if (this.ha.connected) {
      try {
        await this.ha.fireEvent(EVENT_TYPE, payload as unknown as Record<string, unknown>);
        delivered = true;
      } catch (e) {
        errors.push(`HA: ${errorText(e)}`);
      }
    } else {
      errors.push('HA: not connected');
    }
    const mqtt = this.transport();
    if (mqtt?.connected) {
      try {
        await mqtt.publish(EVENTS_TOPIC, JSON.stringify(payload), { retain: false, qos: 1 });
        delivered = true;
      } catch (e) {
        errors.push(`MQTT: ${errorText(e)}`);
      }
    }
    if (!delivered) throw new Error(errors.join('; ') || 'no link to Home Assistant or MQTT');
    this.log.debug(`${payload.kind} ${payload.state}`);
  }
}
