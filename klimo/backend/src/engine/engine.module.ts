import { Global, Module } from '@nestjs/common';
import type { ICoreFns } from '../shared/model';
import { CORE, ENGINE, EVALUATE } from '../tokens';
import { CommandBus } from './command-bus';
import { evalCondition } from './core/conditions';
import { flowFromCurve } from './core/curves';
import { durationUntil } from './core/durations';
import { evaluate } from './core/evaluate';
import { previewTarget } from './core/preview';
import { resolveHouseProfile } from './core/targets';
import { EngineService } from './engine.service';
import { ReconcilerService } from './reconciler.service';
import { RuntimeCache } from './runtime.cache';
import { SnapshotService } from './snapshot.service';

/** The pure core as the engine services call it (they never import the core files of other areas). */
const CORE_FNS: ICoreFns = { evaluate, durationUntil, previewTarget, evalCondition, flowFromCurve, resolveHouseProfile };

/**
 * The engine shell: evaluation cadence, snapshots of HA, the reconciler and its command bus, warm
 * start and graceful stop (ENGINE), plus the pure evaluation (EVALUATE) and core functions (CORE).
 */
@Global()
@Module({
  providers: [
    SnapshotService,
    CommandBus,
    ReconcilerService,
    RuntimeCache,
    EngineService,
    { provide: ENGINE, useExisting: EngineService },
    { provide: EVALUATE, useValue: evaluate },
    { provide: CORE, useValue: CORE_FNS },
  ],
  exports: [ENGINE, EVALUATE, CORE],
})
export class EngineModule {}
