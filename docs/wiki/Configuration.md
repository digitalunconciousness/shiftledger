# Configuration

ShiftLedger is configured through environment variables, typically set in the systemd unit file.

---

## Environment Variables

### Core

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP listen port |
| `DB_PATH` | `./shifts.db` (relative to working dir) | Full path to the SQLite database file |
| `SESSION_SECRET` | Random (generated at runtime) | Secret key for signing session cookies. **Must be set to a stable value in production** — if it changes, all sessions are invalidated. |
| `LOG_LEVEL` | `info` | Pino log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal` |
| `NODE_ENV` | _(unset)_ | Set to `production` to disable pretty-printed logs |

### Overtime

| Variable | Default | Description |
|----------|---------|-------------|
| `OT_THRESHOLD` | `40` | Default weekly overtime threshold in hours. Per-job thresholds (set in the job config) override this. |
| `OT_MULTIPLIER` | `1.5` | Default overtime pay multiplier. Per-job multipliers override this. |

### Tax Estimation

| Variable | Default | Description |
|----------|---------|-------------|
| `TAX_RATE_WAGES` | `0.22` | Estimated tax rate on hourly wages (22%) |
| `TAX_RATE_TIPS` | `0.153` | Estimated tax rate on tips (15.3% — covers self-employment tax estimate) |

> **Note:** These are rough estimates for budgeting purposes, not tax advice. Adjust to match your local tax situation.

---

## Setting Variables in systemd

The installer creates a unit file at `/etc/systemd/system/shiftledger.service`. To change settings:

1. Edit the unit file:
```bash
sudo systemctl edit shiftledger --full
```

2. Add or modify `Environment=` lines in the `[Service]` section:
```ini
[Service]
Environment=PORT=3000
Environment=DB_PATH=/opt/shiftledger/shifts.db
Environment=SESSION_SECRET=your-secret-here
Environment=NODE_ENV=production
Environment=LOG_LEVEL=warn
Environment=OT_THRESHOLD=35
Environment=TAX_RATE_WAGES=0.25
```

3. Reload and restart:
```bash
sudo systemctl daemon-reload
sudo systemctl restart shiftledger
```

---

## Setting Variables for Manual Runs

If running directly without systemd:

```bash
PORT=8080 DB_PATH=./mydata.db SESSION_SECRET=mysecret node server.js
```

Or use a `.env`-style approach (ShiftLedger doesn't read `.env` files natively, but you can source one):

```bash
export PORT=8080
export SESSION_SECRET=mysecret
node server.js
```

---

## Session Secret

The `SESSION_SECRET` is critical for security:

- It's used to HMAC-sign session cookies (`sl_session`)
- If changed, all existing sessions become invalid (users must log in again)
- The installer auto-generates a 64-character hex string
- **Never commit this value to version control**

Generate a new one:
```bash
openssl rand -hex 32
```

---

## Database Path

- Default: `shifts.db` in the server's working directory
- The installer sets it to `/opt/shiftledger/shifts.db`
- SQLite uses WAL (Write-Ahead Logging) mode for better concurrent read performance
- The database file must be writable by the service user
- Foreign keys are enforced (`PRAGMA foreign_keys = ON`)

---

## Log Levels

Pino log levels in order of verbosity:

1. `trace` — extremely detailed (includes every internal operation)
2. `debug` — debugging information
3. `info` — request logs, startup messages, migration events (default)
4. `warn` — potential issues
5. `error` — errors that don't crash the app
6. `fatal` — unrecoverable errors

In production, `warn` or `error` is recommended to reduce log volume.

When `NODE_ENV` is not `production`, logs are pretty-printed via `pino-pretty`. In production, logs are JSON (optimized for log aggregation tools).
