import { Controller, Get, Inject, Optional, Res } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Response } from 'express';
import { lazyRef } from '../common/refs';
import { env } from '../env';
import type { ClockPort, EngineHealth, HaPort, HealthDto, IEngine, IMemoryStore, IMqtt } from '../shared/model';
import { CLOCK, ENGINE, HA_PORT, MEMORY_STORE, MQTT } from '../tokens';

/** The Supervisor watchdog restarts the add-on when this keeps failing, so only a stuck database fails it. */
const DB_DEGRADED_FAIL_MS = 5 * 60_000;

@Controller('api')
export class HealthController {
  private readonly ha: () => HaPort | null;
  private readonly engine: () => IEngine | null;
  private readonly mqtt: () => IMqtt | null;
  private readonly memory: () => IMemoryStore | null;
  private dbDegradedSince: number | null = null;

  constructor(
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Optional() moduleRef?: ModuleRef,
  ) {
    this.ha = lazyRef<HaPort>(moduleRef, HA_PORT);
    this.engine = lazyRef<IEngine>(moduleRef, ENGINE);
    this.mqtt = lazyRef<IMqtt>(moduleRef, MQTT);
    this.memory = lazyRef<IMemoryStore>(moduleRef, MEMORY_STORE);
  }

  @Get('health')
  health(@Res({ passthrough: true }) res: Response): HealthDto {
    const now = this.clock.now();
    const db: HealthDto['db'] = this.memory()?.healthy() === false ? 'degraded' : 'ok';
    if (db === 'degraded') this.dbDegradedSince ??= now;
    else this.dbDegradedSince = null;

    const ha = this.ha()?.connected ?? false;
    const engine = this.engineHealth(ha);
    const body: HealthDto = { ok: db === 'ok', ts: now, ha, mqtt: this.mqttState(), db, engine };
    if (this.dbDegradedSince !== null && now - this.dbDegradedSince > DB_DEGRADED_FAIL_MS) res.status(503);
    return body;
  }

  private engineHealth(haConnected: boolean): EngineHealth {
    const engine = this.engine();
    if (engine) return engine.health();
    // without the engine (detached start-up) report what the UI banner needs: no HA means blind
    return haConnected ? 'starting' : 'blind';
  }

  private mqttState(): HealthDto['mqtt'] {
    const mqtt = this.mqtt();
    if (!mqtt) return env.simulate ? 'simulated' : 'dormant';
    const s = mqtt.status();
    if (s.source === 'simulator') return 'simulated';
    if (s.connected) return 'connected';
    return s.configured ? 'error' : 'dormant';
  }
}
