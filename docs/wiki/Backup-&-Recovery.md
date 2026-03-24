# Backup & Recovery

ShiftLedger uses a single SQLite database file (`shifts.db`), making backups simple — it's just a file copy.

---

## Automated Backups

The installer sets up a daily cron job that runs at **3:00 AM**:

```
0 3 * * * /opt/shiftledger/backup.sh /opt/shiftledger/shifts.db /opt/shiftledger/backups
```

### What the Backup Script Does

1. Copies `shifts.db` to `backups/shifts-YYYYMMDD-HHMMSS.db`
2. Prunes backups older than **30 days**
3. Logs the backup file path and size

### Verify Cron is Set Up

```bash
crontab -l | grep shiftledger
```

### Check Existing Backups

```bash
ls -lh /opt/shiftledger/backups/
```

---

## Manual Backup

Run the backup script directly at any time:

```bash
/opt/shiftledger/backup.sh
```

Or with custom paths:

```bash
/opt/shiftledger/backup.sh /opt/shiftledger/shifts.db /path/to/custom/backup/dir
```

### Quick One-Liner

```bash
cp /opt/shiftledger/shifts.db /opt/shiftledger/shifts-$(date +%Y%m%d).db
```

---

## Off-Site Backup

For added safety, copy backups to another machine:

```bash
# rsync to another server
rsync -av /opt/shiftledger/backups/ user@backup-server:/backups/shiftledger/

# Or use scp
scp /opt/shiftledger/backups/latest.db user@backup-server:/backups/
```

Consider adding an rsync command to the cron job or running a separate cron for off-site copies.

---

## Restoring from Backup

### 1. Stop the Service

```bash
sudo systemctl stop shiftledger
```

### 2. Replace the Database

```bash
# Move the current (possibly corrupted) database aside
mv /opt/shiftledger/shifts.db /opt/shiftledger/shifts.db.broken

# Copy the backup in
cp /opt/shiftledger/backups/shifts-20260310-030001.db /opt/shiftledger/shifts.db

# Fix ownership
chown shiftledger:shiftledger /opt/shiftledger/shifts.db
```

### 3. Clean Up WAL Files

SQLite WAL (Write-Ahead Log) files should be removed when restoring:

```bash
rm -f /opt/shiftledger/shifts.db-wal /opt/shiftledger/shifts.db-shm
```

### 4. Restart

```bash
sudo systemctl start shiftledger
```

Migrations will run automatically if the backup is from an older version.

---

## Verifying a Backup

You can inspect any backup without affecting the live database:

```bash
# Check integrity
sqlite3 /opt/shiftledger/backups/shifts-20260310-030001.db "PRAGMA integrity_check;"

# Count records
sqlite3 /opt/shiftledger/backups/shifts-20260310-030001.db "SELECT COUNT(*) FROM shifts WHERE deleted_at IS NULL;"

# Check schema version
sqlite3 /opt/shiftledger/backups/shifts-20260310-030001.db "SELECT value FROM meta WHERE key = 'db_version';"
```

---

## Retention Policy

The default backup script retains backups for **30 days**. To change this, edit `backup.sh` and modify the `RETENTION_DAYS` variable:

```bash
RETENTION_DAYS=30  # change to your preferred number
```

---

## Disaster Recovery Checklist

If the server is completely lost and you have a backup of `shifts.db`:

1. Set up a new server following the [[Deployment Guide]]
2. Run the installer
3. Stop the service: `sudo systemctl stop shiftledger`
4. Replace the empty database with your backup: `cp backup.db /opt/shiftledger/shifts.db`
5. Fix ownership: `chown shiftledger:shiftledger /opt/shiftledger/shifts.db`
6. Start the service: `sudo systemctl start shiftledger`
7. All data, users, and sessions will be restored (users may need to log in again if the `SESSION_SECRET` changed)
