import { Global, Module } from '@nestjs/common';

/** MQTT discovery, Lovelace card transport and card deployment (provides MQTT, CARD_DEPLOY). */
@Global()
@Module({})
export class MqttModule {}
