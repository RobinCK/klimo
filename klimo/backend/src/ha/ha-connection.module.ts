import { Global, Module } from '@nestjs/common';

/** Home Assistant WebSocket connection (provides HA_PORT). */
@Global()
@Module({})
export class HaConnectionModule {}
