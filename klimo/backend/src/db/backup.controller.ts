import { Controller, HttpCode, Inject, Logger, Post } from '@nestjs/common';
import { LoopbackOnly } from '../common/admin.guard';
import { errorText } from '../common/logger';
import { MemoryStore } from '../config/memory.store';
import { Db } from './database';

/**
 * Called by `/app/backup-hook.sh` (the add-on's `backup_pre` / `backup_post`), which the Supervisor
 * runs inside the container. Before a backup everything is flushed, the write-behind pauses (at most
 * 10 min) and the SQLite WAL is folded into the main file so the copied database is complete.
 */
@Controller('api/system/backup')
export class BackupController {
  private readonly log = new Logger('Backup');

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(MemoryStore) private readonly memory: MemoryStore,
  ) {}

  @Post('pre')
  @HttpCode(204)
  @LoopbackOnly()
  async pre(): Promise<void> {
    await this.memory.pauseForBackup();
    if (this.db.isSqlite) {
      try {
        await this.db.exclusive(() => this.db.ds.query('PRAGMA wal_checkpoint(TRUNCATE)'));
      } catch (e) {
        this.log.warn(`WAL checkpoint failed: ${errorText(e)}`);
      }
    }
    this.log.log('ready for backup: memory flushed, writes paused');
  }

  @Post('post')
  @HttpCode(204)
  @LoopbackOnly()
  post(): void {
    this.memory.resume();
    this.log.log('backup finished: writes resumed');
  }
}
