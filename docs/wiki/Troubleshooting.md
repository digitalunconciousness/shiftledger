# Troubleshooting

A guide to diagnosing and resolving common ShiftLedger issues.

---

## Service Won't Start

### Symptoms
- `systemctl status shiftledger` shows `failed` or `inactive`
- App unreachable at `http://localhost:3000`

### Diagnosis

```bash
# Check service status
systemctl status shiftledger

# View recent logs
journalctl -u shiftledger --no-pager -n 50
```

### Common Causes

**Port already in use:**
```
Error: listen EADDRINUSE: address already in use :::3000
```
Another process is using port 3000. Find and kill it:
```bash
lsof -i :3000
kill <PID>
sudo systemctl restart shiftledger
```
Or change the port in the systemd unit file (see [[Configuration]]).

**Node.js not found:**
```
ExecStart=/usr/bin/node: No such file or directory
```
Node.js isn't installed or is installed at a different path:
```bash
which node        # find the actual path
node -v           # verify it works
```
Update the `ExecStart` path in the service file if needed.

**Permission denied on database:**
```
SqliteError: unable to open database file
```
The `shiftledger` user can't read/write the database:
```bash
ls -la /opt/shiftledger/shifts.db
chown shiftledger:shiftledger /opt/shiftledger/shifts.db
chmod 644 /opt/shiftledger/shifts.db
```

**Missing npm dependencies:**
```
Error: Cannot find module 'express'
```
Dependencies weren't installed:
```bash
cd /opt/shiftledger
sudo -u shiftledger npm install --omit=dev
sudo systemctl restart shiftledger
```

---

## Database Locked / Busy

### Symptoms
- `SqliteError: database is locked`
- API returns 500 errors intermittently

### Causes

SQLite allows only one writer at a time. This can happen if:
1. A backup is running while the app is writing
2. Multiple Node.js processes are accessing the same database
3. The WAL file is corrupted

### Solutions

**Check for multiple processes:**
```bash
ps aux | grep "node.*server.js"
# There should be exactly one process
```

If there are duplicates, kill the extras:
```bash
sudo systemctl stop shiftledger
pkill -f "node.*server.js"
sudo systemctl start shiftledger
```

**Reset WAL:**
```bash
sudo systemctl stop shiftledger
sqlite3 /opt/shiftledger/shifts.db "PRAGMA wal_checkpoint(TRUNCATE);"
sudo systemctl start shiftledger
```

**Nuclear option — rebuild WAL:**
```bash
sudo systemctl stop shiftledger
sqlite3 /opt/shiftledger/shifts.db "VACUUM;"
sudo systemctl start shiftledger
```

---

## Authentication Issues

### "Not authenticated" on Every Request

**Possible causes:**
1. **SESSION_SECRET changed** — if the secret was regenerated (e.g., service restarted without a stable secret in the unit file), all existing session cookies become invalid.
   - Fix: Ensure `SESSION_SECRET` is set to a stable value in the systemd unit file.
   - Users will need to log in again.

2. **Cookie not being sent** — if accessing via a different domain/port than expected, the browser may not send the cookie.
   - Check browser dev tools → Application → Cookies for `sl_session`.

3. **Session expired** — sessions last 30 days. After that, users must log in again.

### "Setup already completed" Error

You're hitting `POST /api/auth/setup` but an admin already exists. Use `POST /api/auth/login` instead.

### Forgot Admin Password

There's no password reset UI. Reset via the database directly:

```bash
# Generate a new hash (using Node.js)
node -e "
const crypto = require('crypto');
const salt = crypto.randomBytes(16).toString('hex');
crypto.scrypt('newpassword', salt, 64, (err, key) => {
  console.log(salt + ':' + key.toString('hex'));
});
"

# Update the database
sudo systemctl stop shiftledger
sqlite3 /opt/shiftledger/shifts.db "UPDATE users SET password_hash = '<hash_from_above>' WHERE username = 'admin';"
sudo systemctl start shiftledger
```

### Locked Out Completely (No Users)

If you need to start fresh with authentication:

```bash
sudo systemctl stop shiftledger
sqlite3 /opt/shiftledger/shifts.db "DELETE FROM sessions; DELETE FROM users;"
sudo systemctl start shiftledger
# Visit the app — you'll see the first-run setup screen again
```

> **Warning:** This deletes all user accounts. Shifts are preserved but will show "Unknown" for the user.

---

## Migration Errors

### Symptoms
- App crashes on startup with SQL errors
- Log shows `Running migration v<N>` followed by an error

### Diagnosis

Check the current schema version:
```bash
sqlite3 /opt/shiftledger/shifts.db "SELECT value FROM meta WHERE key = 'db_version';"
```

### Common Issues

**Table already exists:**
All migrations use `CREATE TABLE IF NOT EXISTS`, so this shouldn't happen. If it does, the `meta` table's version number may be wrong:
```bash
# Check actual tables
sqlite3 /opt/shiftledger/shifts.db ".tables"

# Manually set version if tables exist
sqlite3 /opt/shiftledger/shifts.db "INSERT OR REPLACE INTO meta (key, value) VALUES ('db_version', '4');"
```

**Column already exists:**
The v1 migration uses `PRAGMA table_info()` to check before adding columns, but if manually altered:
```bash
sqlite3 /opt/shiftledger/shifts.db "PRAGMA table_info(shifts);"
# Verify the columns match what the migration expects
```

### Recovery

If migrations are broken, the safest approach is:
1. Back up the database: `cp shifts.db shifts.db.backup`
2. Delete the database: `rm shifts.db`
3. Restart ShiftLedger — it will create a fresh database
4. Import your data from CSV backup (if available)

---

## Performance Issues

### Slow API Responses

SQLite should handle thousands of shifts without any perceptible delay. If things are slow:

1. **Check database size:**
```bash
ls -lh /opt/shiftledger/shifts.db
```

2. **Check for WAL bloat:**
```bash
ls -lh /opt/shiftledger/shifts.db-wal
# If this is very large (>100 MB), checkpoint it:
sqlite3 /opt/shiftledger/shifts.db "PRAGMA wal_checkpoint(TRUNCATE);"
```

3. **Optimize the database:**
```bash
sudo systemctl stop shiftledger
sqlite3 /opt/shiftledger/shifts.db "VACUUM; ANALYZE;"
sudo systemctl start shiftledger
```

4. **Check system resources:**
```bash
free -h          # memory
df -h            # disk space
top -b -n 1 | head -20  # CPU/memory usage
```

### High Memory Usage

The Node.js process typically uses 30–50 MB. If it's much higher:
- Check for a memory leak with `node --inspect server.js`
- Restart the service as a workaround: `sudo systemctl restart shiftledger`

---

## PDF Export Issues

### Blank or Corrupt PDF

- Ensure `pdfkit` is installed: `npm ls pdfkit` in `/opt/shiftledger`
- Check logs for errors during PDF generation
- Try exporting a smaller date range

### PDF Doesn't Include All Shifts

- PDF respects the date range filters — make sure `from` and `to` query params are correct
- Soft-deleted shifts are excluded from exports

---

## CSV Import Problems

### "Empty CSV" Error

The file needs at least 2 lines (header + one data row).

### Many Errors During Import

- Check date format — must be `YYYY-MM-DD`
- Verify column order matches the export format
- Ensure numeric fields don't have currency symbols (`$15.00` won't parse — use `15.00`)
- Check for encoding issues (UTF-8 required)

### Imported Shifts Show Wrong User

All imported shifts are assigned to the currently logged-in user. There's no way to import as a different user through the UI.

---

## Browser / Frontend Issues

### Theme Doesn't Persist

- Check that localStorage is enabled in your browser
- Try clearing localStorage: browser dev tools → Application → Local Storage → Clear

### Charts Not Rendering

- Chart.js is loaded from CDN. Check browser console for network errors.
- If offline, charts won't load (the CDN script isn't cached by the service worker)

### PWA Won't Install

- Ensure you're accessing via HTTPS (required for PWA installation, except on localhost)
- Check that `manifest.json` is accessible: visit `/manifest.json` in the browser
- Clear the service worker: browser dev tools → Application → Service Workers → Unregister

### Keyboard Shortcuts Not Working

- Shortcuts are disabled when a text input or textarea is focused
- Check that no browser extensions are intercepting the key combinations
- Press `?` to verify the shortcut overlay appears

---

## Getting More Help

### Collect Diagnostic Info

When reporting an issue, include:

```bash
# App version
cat /opt/shiftledger/package.json | grep version

# Node version
node -v

# OS info
cat /etc/os-release

# Service status
systemctl status shiftledger

# Recent logs (last 100 lines)
journalctl -u shiftledger --no-pager -n 100

# Database version
sqlite3 /opt/shiftledger/shifts.db "SELECT * FROM meta;"

# Database size
ls -lh /opt/shiftledger/shifts.db*
```
