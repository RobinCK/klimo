import { Controller, HttpCode, Inject, Logger, OnModuleDestroy, Post } from '@nestjs/common';
import { LoopbackOnly } from '../common/admin.guard';
import { errorText } from '../common/logger';
import { MemoryStore } from '../config/memory.store';
import { Db } from './database';

/** SQLite's own default. */
const AUTOCHECKPOINT_PAGES = 1000;
/** Same bound as the memory pause: a backup that never reports back does not stop checkpoints for good. */
const PAUSE_MAX_MS = 10 * 60_000;

/**
 * Called by `/app/backup-hook.sh` (the add-on's `backup_pre` / `backup_post`), which the Supervisor
 * runs inside the container. Before a backup everything is flushed, the write-behind pauses (at most
 * 10 min) and the SQLite WAL is folded into the main file so the copied database is complete. Writes
 * that cannot wait (journal, incidents, settings) still land in the WAL; automatic checkpoints are off
 * until the backup is done, so the main file does not change while the Supervisor copies it.
 */
@Controller('api/system/backup')
export class BackupController implements OnModuleDestroy {
  private readonly log = new Logger('Backup');
  private resumeTimer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(MemoryStore) private readonly memory: MemoryStore,
  ) {}

  onModuleDestroy(): void {
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
  }

  @Post('pre')
  @HttpCode(204)
  @LoopbackOnly()
  async pre(): Promise<void> {
    await this.memory.pauseForBackup();
    if (this.db.isSqlite) {
      try {
        await this.db.exclusive(async () => {
          await this.db.ds.query('PRAGMA wal_checkpoint(TRUNCATE)');
          await this.db.ds.query('PRAGMA wal_autocheckpoint = 0');
        });
        if (this.resumeTimer) clearTimeout(this.resumeTimer);
        this.resumeTimer = setTimeout(() => void this.resumeCheckpoints(), PAUSE_MAX_MS);
        this.resumeTimer.unref();
      } catch (e) {
        this.log.warn(`WAL checkpoint failed: ${errorText(e)}`);
      }
    }
    this.log.log('ready for backup: memory flushed, writes paused');
  }

  @Post('post')
  @HttpCode(204)
  @LoopbackOnly()
  async post(): Promise<void> {
    this.memory.resume();
    await this.resumeCheckpoints();
    this.log.log('backup finished: writes resumed');
  }

  private async resumeCheckpoints(): Promise<void> {
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
    if (!this.db.isSqlite) return;
    try {
      await this.db.exclusive(() => this.db.ds.query(`PRAGMA wal_autocheckpoint = ${AUTOCHECKPOINT_PAGES}`));
    } catch (e) {
      this.log.warn(`WAL checkpoints not resumed: ${errorText(e)}`);
    }
  }
}
