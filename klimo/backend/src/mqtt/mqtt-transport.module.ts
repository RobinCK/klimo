import { Global, Module } from '@nestjs/common';
import { MQTT_TRANSPORT } from '../tokens';
import { MqttJsTransport } from './transport';

/** The MQTT client (MQTT_TRANSPORT). It connects once MqttService has found a broker. */
@Global()
@Module({
  providers: [MqttJsTransport, { provide: MQTT_TRANSPORT, useExisting: MqttJsTransport }],
  exports: [MQTT_TRANSPORT],
})
export class MqttTransportModule {}
