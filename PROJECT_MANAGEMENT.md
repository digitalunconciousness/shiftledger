# ShiftLedger — Project Management

## Current Status

- **Database schema**: v17 (migrations run at startup)
- **Backend**: `server.js` — monolithic Express app, ~3000+ lines
- **Frontend**: Vanilla JS PWA (`public/index.html`)
- **Mobile**: React Native / Expo (`mobile/`) — basic shift CRUD only; see [issues/mobile-app-feature-gap.md](issues/mobile-app-feature-gap.md)

## Active Issues

See the [`issues/`](issues/) folder for tracked work items:
- [`issues/mobile-app-feature-gap.md`](issues/mobile-app-feature-gap.md) — mobile app is missing Jobs, Templates, Goals, Tax, and Analytics features
- [`issues/mobile-site-upgrades.md`](issues/mobile-site-upgrades.md) — mobile web UX improvements
- [`issues/1`](issues/1) — issue tracker root

## Key Architecture Constraints

- Do **not** split `server.js` into separate files unless explicitly requested
- Do **not** add npm packages without approval
- Do **not** add TypeScript, build tools, or frontend frameworks
- New DB migrations go in the `migrate()` array as the next entry (currently v17)
- All inputs must be validated with Zod before hitting the DB
- Always scope queries with `resolveUserFilter()` + `appendUserFilter()`

## Deployment Target

- Proxmox LXC (Debian 12, 1 core, 512MB RAM, 4GB disk)
- Exposed via Cloudflare Tunnel
- Managed by systemd (`shiftledger.service`)
- Daily backups via `backup.sh` cron job

## Tech Stack Summary

| Layer | Technology |
|---|---|
| Runtime | Node.js 20 |
| Backend | Express.js (monolithic `server.js`) |
| Database | SQLite via `better-sqlite3` (WAL mode) |
| Validation | Zod |
| Logging | Pino |
| PDF Export | PDFKit |
| Frontend | Vanilla JS + Chart.js (CDN) |
| Auth | scrypt passwords + signed session cookies / Bearer tokens |
| Mobile | React Native (Expo 50) + Zustand + Axios |
