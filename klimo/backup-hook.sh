#!/bin/sh
# Home Assistant runs this inside the add-on before and after a backup (backup_pre / backup_post).
# "pre" flushes Klimo's control memory, pauses its writes and folds the SQLite WAL into the database
# file so the backup holds a complete copy; "post" resumes writing. A failure never blocks the backup.
wget -q -O - --post-data='' "http://127.0.0.1:8099/api/system/backup/$1" || true
