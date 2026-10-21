import { Global, Module } from '@nestjs/common';

/** The MQTT client (provides MQTT_TRANSPORT). */
@Global()
@Module({})
export class MqttTransportModule {}
