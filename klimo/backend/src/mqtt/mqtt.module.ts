import { Global, Module } from '@nestjs/common';
import { CardDeployService } from '../card/card-deploy.service';
import { CARD_DEPLOY, MQTT } from '../tokens';
import { CommandsService } from './commands.service';
import { MqttService } from './mqtt.service';
import { MqttPorts } from './ports';
import { Z2mService } from './z2m.service';

/**
 * MQTT discovery, the Lovelace card transport and commands, the Zigbee2MQTT listener and the card
 * deployment (MQTT, CARD_DEPLOY). The transport itself comes from MqttTransportModule or the simulator.
 */
@Global()
@Module({
  providers: [
    MqttPorts,
    Z2mService,
    CommandsService,
    MqttService,
    { provide: MQTT, useExisting: MqttService },
    CardDeployService,
    { provide: CARD_DEPLOY, useExisting: CardDeployService },
  ],
  exports: [MQTT, CARD_DEPLOY],
})
export class MqttModule {}
