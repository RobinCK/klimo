import { Global, Module } from '@nestjs/common';

/** The engine shell: evaluation cadence, reconciler and command bus (provides ENGINE, EVALUATE, CORE). */
@Global()
@Module({})
export class EngineModule {}
