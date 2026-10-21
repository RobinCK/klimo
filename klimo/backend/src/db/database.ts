import { Logger } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';
import * as fs from 'fs';
import * as path from 'path';
import { DataSource, DataSourceOptions, EntityManager } from 'typeorm';
import type { DbOptions } from '../env';
import { errorText } from '../common/logger';
import { ENTITIES, KvRow } from './entities';

const RETRIES = 10;
const RETRY_DELAY_MS = 3_000;

export interface DataSourceSettings {
  db: DbOptions;
  dataDir: string;
  retries?: number;
  retryDelayMs?: number;
}

function options(s: DataSourceSettings): DataSourceOptions {
  const { db } = s;
  if (db.driver === 'mariadb' || db.driver === 'postgres') {
    return {
      type: db.driver === 'mariadb' ? 'mysql' : 'postgres',
      host: db.host,
      port: db.port ?? (db.driver === 'mariadb' ? 3306 : 5432),
      database: db.name ?? 'klimo',
      username: db.user,
      password: db.password,
      entities: ENTITIES,
      synchronize: true,
      ...(db.driver === 'mariadb' ? { charset: 'utf8mb4' } : {}),
    } as DataSourceOptions;
  }
  fs.mkdirSync(s.dataDir, { recursive: true });
  return {
    type: 'better-sqlite3',
    database: path.join(s.dataDir, 'klimo.sqlite'),
    entities: ENTITIES,
    synchronize: true,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Opens the database (sqlite in /data by default, covered by HA backups; or an external MariaDB /
 * Postgres). An external server may still be starting when the add-on boots, so the connection is
 * retried 10 × 3 s before giving up.
 */
export async function createDataSource(s: DataSourceSettings): Promise<DataSource> {
  const log = new Logger('Database');
  const retries = s.retries ?? RETRIES;
  let lastError: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const ds = new DataSource(options(s));
    try {
      await ds.initialize();
      if (s.db.driver === 'sqlite') {
        // WAL keeps readers off the writer's back; NORMAL is safe with WAL and much cheaper on SD cards
        await ds.query('PRAGMA journal_mode = WAL');
        await ds.query('PRAGMA busy_timeout = 5000');
        await ds.query('PRAGMA synchronous = NORMAL');
      }
      log.log(`${s.db.driver} ready${attempt > 1 ? ` after ${attempt} attempts` : ''}`);
      return ds;
    } catch (e) {
      lastError = e;
      if (ds.isInitialized) await ds.destroy().catch(() => undefined);
      if (attempt < retries) {
        log.warn(`${s.db.driver} not reachable (${errorText(e)}), retry ${attempt}/${retries - 1}`);
        await sleep(s.retryDelayMs ?? RETRY_DELAY_MS);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Serialises writes. better-sqlite3 runs on a single connection shared by every query runner, so two
 * async transactions would otherwise interleave on it and commit or roll back each other's statements.
 * Every write of the add-on goes through `tx()`; a write issued while the current async context already
 * holds the lock (a store calling another store inside its transaction) joins it instead of deadlocking.
 */
export class Db {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly als = new AsyncLocalStorage<symbol>();
  private holder: symbol | null = null;

  constructor(readonly ds: DataSource) {}

  get isSqlite(): boolean {
    return this.ds.options.type === 'better-sqlite3';
  }

  get manager(): EntityManager {
    return this.ds.manager;
  }

  /** Runs `fn` alone: no other `exclusive`/`tx` starts until it settles. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const mine = this.als.getStore();
    if (mine && mine === this.holder) return fn();
    const run = this.chain.then(async () => {
      const token = Symbol('db-lock');
      this.holder = token;
      try {
        return await this.als.run(token, fn);
      } finally {
        this.holder = null;
      }
    });
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** One database transaction under the write lock. */
  tx<T>(fn: (em: EntityManager) => Promise<T>): Promise<T> {
    return this.exclusive(() => this.ds.transaction(fn));
  }

  async kvGet(key: string): Promise<string | null> {
    const row = await this.ds.getRepository(KvRow).findOneBy({ key });
    return row ? row.value : null;
  }

  async kvSet(key: string, value: string | null): Promise<void> {
    await this.tx(async (em) => {
      if (value === null) await em.delete(KvRow, { key });
      else await em.upsert(KvRow, { key, value }, ['key']);
    });
  }

  async destroy(): Promise<void> {
    await this.exclusive(async () => {
      if (this.ds.isInitialized) await this.ds.destroy();
    });
  }
}
