import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { ConfigStore } from '../config/config.store';
import { MemoryStore } from '../config/memory.store';
import { OverrideStore } from '../config/override.store';
import { env } from '../env';
import { JournalService } from '../journal/journal.service';
import { SpanStore } from '../journal/span.store';
import type { ClockPort, IBus, IEvents } from '../shared/model';
import { BUS, CLOCK, CONFIG_STORE, DATA_SOURCE, EVENTS, JOURNAL, MEMORY_STORE, OVERRIDE_STORE, SPAN_STORE } from '../tokens';
import { BackupController } from './backup.controller';
import { createDataSource, Db } from './database';
import { RetentionService } from './retention.service';
import { SeedService } from './seed';

/**
 * The database and everything stored in it: configuration, control memory, overrides, the decision
 * journal and run spans. The stores are created loaded (async factories, in dependency order), so
 * whoever injects them — in any module, at any lifecycle stage — reads real data, never an empty store.
 * Memory is flushed before the connection closes.
 */
@Global()
@Module({
  controllers: [BackupController],
  providers: [
    { provide: DATA_SOURCE, useFactory: () => createDataSource({ db: env.db, dataDir: env.dataDir }) },
    { provide: Db, useFactory: (ds: DataSource) => new Db(ds), inject: [DATA_SOURCE] },
    {
      provide: OverrideStore,
      useFactory: async (db: Db, clock: ClockPort) => {
        const s = new OverrideStore(db, clock);
        await s.load();
        return s;
      },
      inject: [Db, CLOCK],
    },
    { provide: OVERRIDE_STORE, useExisting: OverrideStore },
    {
      provide: ConfigStore,
      useFactory: async (db: Db, clock: ClockPort, bus: IBus, events: IEvents, overrides: OverrideStore, moduleRef: ModuleRef) => {
        const s = new ConfigStore(db, clock, bus, events, overrides, moduleRef);
        await s.load();
        return s;
      },
      inject: [Db, CLOCK, BUS, EVENTS, OverrideStore, ModuleRef],
    },
    { provide: CONFIG_STORE, useExisting: ConfigStore },
    {
      provide: MemoryStore,
      useFactory: async (db: Db, clock: ClockPort, config: ConfigStore, bus: IBus) => {
        const s = new MemoryStore(db, clock, config, bus);
        await s.load();
        return s;
      },
      inject: [Db, CLOCK, ConfigStore, BUS],
    },
    { provide: MEMORY_STORE, useExisting: MemoryStore },
    JournalService,
    { provide: JOURNAL, useExisting: JournalService },
    {
      provide: SpanStore,
      useFactory: async (db: Db, events: IEvents) => {
        const s = new SpanStore(db, events);
        await s.load();
        return s;
      },
      inject: [Db, EVENTS],
    },
    { provide: SPAN_STORE, useExisting: SpanStore },
    RetentionService,
    SeedService,
  ],
  exports: [DATA_SOURCE, Db, OVERRIDE_STORE, CONFIG_STORE, MEMORY_STORE, JOURNAL, SPAN_STORE, MemoryStore, SeedService],
})
export class PersistenceModule implements OnApplicationShutdown {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(MemoryStore) private readonly memory: MemoryStore,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.memory.flushNow();
    await this.db.destroy();
  }
}
