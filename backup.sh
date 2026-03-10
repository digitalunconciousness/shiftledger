#!/usr/bin/env bash
# ShiftLedger — SQLite Backup Script
# Usage: ./backup.sh [DB_PATH] [BACKUP_DIR]
# Cron example: 0 3 * * * /opt/shiftledger/backup.sh

DB="${1:-/opt/shiftledger/shifts.db}"
BACKUP_DIR="${2:-/opt/shiftledger/backups}"
RETENTION_DAYS=30

mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
DEST="$BACKUP_DIR/shifts-$TIMESTAMP.db"

if [ -f "$DB" ]; then
  cp "$DB" "$DEST"
  echo "Backup created: $DEST ($(du -h "$DEST" | cut -f1))"
else
  echo "ERROR: Database not found at $DB"
  exit 1
fi

# Prune old backups
DELETED=$(find "$BACKUP_DIR" -name "shifts-*.db" -mtime +$RETENTION_DAYS -delete -print | wc -l)
if [ "$DELETED" -gt 0 ]; then
  echo "Pruned $DELETED backup(s) older than $RETENTION_DAYS days"
fi
