import { Global, Module } from '@nestjs/common';
import { HA_PORT } from '../tokens';
import { HaService } from './ha.service';

/** The WebSocket connection to Home Assistant (HA_PORT). The simulator provides its own fake instead. */
@Global()
@Module({
  providers: [HaService, { provide: HA_PORT, useExisting: HaService }],
  exports: [HA_PORT, HaService],
})
export class HaConnectionModule {}
