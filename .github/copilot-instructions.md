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

There is no build step. The server runs directly from `server.js`. There are no automated tests — manually verify changes by running the server and exercising the affected feature.

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DB_PATH` | `./shifts.db` (dev) | SQLite database path |
| `SESSION_SECRET` | Random (generated) | Cookie signing secret |
| `LOG_LEVEL` | `info` | Pino log level |
| `OT_THRESHOLD` | `40` | Fallback weekly overtime threshold (hrs); per-job config takes precedence |
| `OT_MULTIPLIER` | `1.5` | Fallback overtime rate multiplier |
| `TAX_RATE_WAGES` | `0.22` | Fallback wage tax rate; per-user `tax_config` table takes precedence |
| `TAX_RATE_TIPS` | `0.153` | Fallback tip tax rate |

---

## Architecture and Code Conventions

### Backend (`server.js`)

`server.js` is 3000+ lines. All routes, middleware, helpers, and DB logic live here intentionally — do not split unless explicitly asked. The file is organized top-to-bottom: DB init → migrations → helpers → middleware → Zod schemas → routes.

**Route middleware order** — always follow this signature pattern:
```js
app.METHOD('/api/path', authMiddleware, adminOnly?, rateLimiter, validate(Schema)?, handler)
```

**After `validate(Schema)` middleware**, use `req.validated` (not `req.body`) — the schema parse result with defaults applied is stored there.

**User scoping in queries** — use the two helpers for every read endpoint:
```js
const filterUser = resolveUserFilter(req); // null = all, array = specific user IDs (includes household members)
let sql = 'SELECT * FROM table WHERE deleted_at IS NULL';
const params = [];
sql = appendUserFilter(sql, params, filterUser); // mutates params array
const rows = db.prepare(sql).all(...params);
```

**Rate limiters** — apply the appropriate named limiter:
- `apiRateLimit` — applied globally to all `/api/*` routes
- `authRateLimit` — login, logout, setup, refresh (20 req/15 min)
- `passwordChangeRateLimit` — password change/reset (5 req/15 min)
- `profileRateLimit` — user/employer/job/settings endpoints (60 req/15 min)
- `householdRateLimit` — household mutation endpoints (30 req/15 min)

**Database migrations** — currently at **v17**. Add new migrations as the next array entry; `migrate()` runs outstanding entries in a transaction at startup.

**SQLite booleans** — stored as `INTEGER` (0/1). Use `!!row.field` when reading, `value ? 1 : 0` when writing.

**Soft Deletes** — shifts use `deleted_at`. Always filter `WHERE deleted_at IS NULL` for active shifts.

**500 errors** — use `internalError(res, err)` (logs + hides details in production), not raw `res.status(500)`.

**Date formatting** — use `fmt(dateObject)` to produce `YYYY-MM-DD` strings for SQL. Use `getPeriodBounds()` to get pre-computed week/month/YTD date ranges.

**First-run flow** — when the `users` table is empty, `authMiddleware` sets `req.user = null` and calls `next()` (allows the `/api/auth/setup` endpoint to work unauthenticated).

**Logging**: Use `logger.info/warn/error()`. Never `console.log`.

**Error Responses**: `{ error: 'message' }` with: 400 validation, 401 unauthenticated, 403 non-admin, 404 not found, 500 server error.

### Frontend (`public/`)

- **Vanilla JS only**: No frontend frameworks or bundlers. All UI logic is in `public/index.html` inline `<script>` blocks.
- **No external JS imports**: Chart.js (via cdnjs) and Google Fonts are already loaded — do not add more CDN dependencies.
- **CSS Variables**: Use existing custom properties (`--bg`, `--surface`, `--accent`, etc.). Do not hardcode colors.
- **Theme Support**: All new UI must work in both dark and light themes via the CSS variable system.
- **PWA**: If adding new static assets, add them to the cache list in `public/sw.js`.
- **CSP constraint**: `unsafe-inline` is required for inline scripts/styles (see comment in security headers middleware). Do not move to external files without updating the CSP.

### Mobile App (`mobile/`)

React Native (Expo) app targeting the same backend API. Uses:
- **Zustand** for state (`mobile/app/store/`) — `authStore` (JWT tokens, login/logout) and `shiftStore` (shifts + jobs CRUD)
- **Axios** via `mobile/app/api/client.js` — all API calls go through this single client which reads the Bearer token from `AsyncStorage`
- **Auth**: Bearer token (not cookie) — `Authorization: Bearer <token>` header on every request
- The mobile app shares all `/api/*` endpoints with the web frontend

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

- **Shift**: One work session — `date`, `hourly_rate`, `hours_worked`, `tip_mode` (`total`|`per_hour`), `tip_input`, computed `total_tips`, `wage_total`, `grand_total`. Soft-deleted via `deleted_at`.
- **Job**: Named employer/client; per-job `overtime_threshold`, `overtime_multiplier`, `tip_payment` (`cash`|`paycheck`), optional `employer_id`.
- **Employer**: Company-level record; `no_tax` flag suppresses tax estimation for linked jobs.
- **Template**: Saved shift config (rate, hours, job) for quick re-use.
- **Goal**: Weekly or monthly income target with progress tracking.
- **Fixed Income**: Recurring non-shift income (salary, etc.) with flexible recurrence (`weekly`, `biweekly`, `semimonthly`, `monthly`, `custom`). Counted via `countFixedIncomeOccurrences()` for period summaries.
- **Household**: Group of users who can see each other's shifts. `getVisibleUserIds(userId)` returns self + all household co-members.
- **Tax Config**: Per-user table of named tax line items (federal, state, SS, medicare, tip tax) with `rate` and `flat_amount`. Falls back to env var defaults when no user-specific rows exist.
- **Paycheck**: Real paycheck record for reconciling estimated vs actual withholding.
- **Audit Log**: Admin-visible log of user management actions (password resets, role changes, etc.).

---

## What to Avoid

- Do not refactor the monolithic `server.js` into separate files unless explicitly requested.
- Do not add TypeScript, build tools, or frontend frameworks.
- Do not add a test runner or CI pipeline unless explicitly requested.
- Do not add new npm packages without approval.
- Do not hardcode user IDs, ports, or file paths — use environment variables and existing constants.
- Do not use `console.log` — use the `logger` instance.
- Do not write raw SQL strings with user-supplied data — always use prepared statements.
- Do not read from `req.body` after a `validate()` middleware — use `req.validated` instead.
- Do not query user-owned data without calling `resolveUserFilter` + `appendUserFilter`.
