# GitHub Copilot Instructions for ShiftLedger

## Project Overview

ShiftLedger is a self-hosted, multi-user shift earnings tracker for gig/service workers. It tracks shifts (hourly wages + tips), provides analytics dashboards, goal tracking, tax estimation, overtime monitoring, and PDF/CSV export. The app is designed to run as a Proxmox LXC container exposed via Cloudflare Tunnel.

---

## Tech Stack

- **Runtime**: Node.js 20
- **Backend**: Express.js (single monolithic `server.js`)
- **Database**: SQLite via `better-sqlite3` with WAL mode and foreign keys enabled
- **Validation**: Zod schemas for all incoming request bodies
- **Logging**: Pino (pretty-print in dev, JSON in production)
- **PDF Export**: PDFKit
- **Frontend**: Vanilla JavaScript, HTML5, CSS with custom properties (no frameworks)
- **Charts**: Chart.js (CDN-loaded)
- **Auth**: Session cookies with scrypt password hashing, 30-day signed sessions
- **PWA**: Service worker (`public/sw.js`) with network-first API / cache-first static strategy

---

## Running and Developing

```bash
# Install dependencies
npm install

# Start the server (development)
npm run dev
# or
node server.js

# The server listens on PORT (default: 3000)
# Visit http://localhost:3000 — first visit creates the admin account
```

There is no build step. The server runs directly from `server.js`.

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DB_PATH` | `./shifts.db` (dev) | SQLite database path |
| `SESSION_SECRET` | Random (generated) | Cookie signing secret |
| `LOG_LEVEL` | `info` | Pino log level |
| `OT_THRESHOLD` | `40` | Default weekly overtime threshold (hrs) |
| `OT_MULTIPLIER` | `1.5` | Overtime rate multiplier |
| `TAX_RATE_WAGES` | `0.22` | Estimated wage tax rate |
| `TAX_RATE_TIPS` | `0.153` | Estimated tip tax rate |

### No Formal Test Suite

There are no automated tests. When making changes, manually verify by running the server and exercising the affected feature. Validate Zod schemas and SQL queries directly in the code before finalizing changes.

---

## Architecture and Code Conventions

### Backend (`server.js`)

- **Monolithic**: All routes, middleware, and logic live in a single `server.js` file. Keep this pattern — do not split into separate modules unless specifically asked.
- **Middleware**: `authMiddleware` enforces session auth on all non-public routes. `adminOnly` restricts admin endpoints. Always apply the correct middleware when adding new routes.
- **Zod Validation**: All route handlers that accept a request body **must** validate with a Zod schema before touching the database. Define schemas near the top of the file with existing schemas.
- **SQL Queries**: Use `better-sqlite3` prepared statements (`db.prepare(...).get()`, `.all()`, `.run()`). Never use string interpolation to build SQL — always use `?` placeholders.
- **User Scoping**: Every query that reads or writes user data **must** filter by `user_id`. Never expose one user's data to another.
- **Database Migrations**: New schema changes go in the `migrate()` function as a new versioned migration. Increment the migration array and `setDbVersion()` accordingly.
- **Soft Deletes**: Shifts use `deleted_at` for soft-delete. Always filter `WHERE deleted_at IS NULL` when querying active shifts.
- **Logging**: Use the `logger` (Pino) instance for all server-side logging. Use `logger.info()`, `logger.warn()`, `logger.error()`. Do not use `console.log`.
- **Error Responses**: Return `{ error: 'message' }` JSON with appropriate HTTP status codes (400 for validation, 401 for auth, 403 for permission, 404 for not found, 500 for server errors).

### Frontend (`public/`)

- **Vanilla JS only**: No frontend frameworks or bundlers. All logic is inline in `index.html` script tags or separate `.js` files in `public/`.
- **No external JS imports**: Do not add new CDN dependencies without strong justification. Chart.js and Google Fonts are already loaded.
- **CSS Variables**: Use existing CSS custom properties (`--bg`, `--surface`, `--accent`, etc.) for all styling. Do not hardcode colors.
- **Theme Support**: All new UI elements must respect both dark and light themes via the existing CSS variable system.
- **PWA**: If adding new static assets, update the service worker cache list in `public/sw.js`.

---

## Security Guidelines

- **Never commit secrets** — no `.env` files, session secrets, or API keys in source code.
- **No new npm dependencies** without explicit approval. The dependency surface is intentionally minimal.
- **Always validate inputs with Zod** before using them in database queries or business logic.
- **SQL injection prevention**: Only use `better-sqlite3` prepared statements with `?` placeholders — never build SQL strings from user input.
- **Authentication**: Do not weaken or bypass `authMiddleware` or `adminOnly` middleware on any route.
- **Session cookies**: Keep `httpOnly: true` and `sameSite: 'lax'` on all cookies. Do not expose the session secret.
- **Password hashing**: Use `crypto.scrypt` with the existing salt/hash format. Do not change the hashing algorithm without a migration plan.
- **User isolation**: Always scope database queries to the authenticated user's `user_id`. Never expose cross-user data.

---

## Domain Concepts

- **Shift**: One work session with `date`, `hourly_rate`, `hours_worked`, tip mode (`total` or `per_hour`), `tip_input`, computed `total_tips`, `wage_total`, and `grand_total`.
- **Job**: A named employer/client that shifts are assigned to. Each user can have multiple jobs.
- **Template**: A saved shift configuration (rate, hours, job) for quick re-use.
- **Goal**: A weekly or monthly income target with a tracked progress bar.
- **Overtime**: Configurable per-job weekly hour threshold with a rate multiplier.
- **Tax Estimation**: YTD estimated tax calculated from `TAX_RATE_WAGES × wages + TAX_RATE_TIPS × tips`.
- **Soft Delete**: Shifts are not hard-deleted — `deleted_at` is set and an undo window is provided.

---

## What to Avoid

- Do not refactor the monolithic `server.js` into separate files unless explicitly requested.
- Do not add TypeScript, build tools, or frontend frameworks.
- Do not add a test runner or CI pipeline unless explicitly requested.
- Do not add new npm packages without approval.
- Do not hardcode user IDs, ports, or file paths — use environment variables and existing constants.
- Do not use `console.log` — use the `logger` instance.
- Do not write raw SQL strings with user-supplied data — always use prepared statements.
