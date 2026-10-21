import { Global, Module } from '@nestjs/common';

/** The simulator: a fake Home Assistant with a thermal model (provides HA_PORT, CLOCK, MQTT_TRANSPORT, SIM_CONTROL). */
@Global()
@Module({})
export class SimModule {}
