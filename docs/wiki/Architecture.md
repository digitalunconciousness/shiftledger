# Architecture

An overview of ShiftLedger's internals for developers and contributors.

---

## Tech Stack

- **Runtime**: Node.js 20+
- **Framework**: Express 4
- **Database**: SQLite via `better-sqlite3` (synchronous, fast, single-file)
- **Validation**: Zod — runtime schema validation for all API inputs
- **Logging**: Pino — structured JSON logging (with `pino-pretty` for development)
- **PDF Generation**: PDFKit — server-side PDF rendering
- **Auth**: Node.js `crypto` module — scrypt hashing, HMAC-SHA256 cookie signing
- **Frontend**: Vanilla JavaScript single-page app (no build step)
- **Charts**: Chart.js 4 (loaded from CDN)
- **Fonts**: IBM Plex Mono + Syne (Google Fonts CDN)
- **Mobile**: React Native with Expo 50, Zustand for state, Axios for HTTP

---

## Project Structure

```
shiftledger/
├── server.js           # Express server — all backend logic (~2,600 lines)
├── package.json        # Backend dependencies and metadata
├── install.sh          # Automated installer script (Debian/Proxmox LXC)
├── backup.sh           # SQLite backup script
├── public/
│   ├── index.html      # Entire frontend SPA (~1,850 lines)
│   ├── manifest.json   # PWA manifest
│   ├── sw.js           # Service worker
│   ├── icon-192.svg    # App icon (192×192)
│   └── icon-512.svg    # App icon (512×512)
├── mobile/             # React Native companion app
│   ├── App.js          # Root navigation (auth stack / app stack)
│   ├── package.json    # Mobile dependencies
│   ├── eas.json        # Expo Application Services config
│   └── app/
│       ├── api/
│       │   └── client.js       # Axios client with Bearer token interceptor
│       ├── screens/
│       │   ├── LoginScreen.js
│       │   ├── SignupScreen.js
│       │   ├── HomeScreen.js
│       │   ├── AddShiftScreen.js
│       │   └── EditShiftScreen.js
│       └── store/
│           ├── authStore.js    # Zustand: auth state, token persistence
│           └── shiftStore.js   # Zustand: shift CRUD operations
├── shifts.db           # SQLite database (created at runtime)
├── README.md           # Project documentation
└── .gitignore
```

There is no build step, transpilation, or bundling. The backend is a single `server.js`; the frontend is a single `index.html`.

---

## Database Schema

ShiftLedger uses SQLite with WAL mode and foreign keys enabled. The schema is managed through a versioned migration system (currently at **v14**).

### Tables

**`meta`** — Tracks schema version and runtime settings
- `key` TEXT PRIMARY KEY
- `value` TEXT

**`users`** — User accounts
- `id` INTEGER PRIMARY KEY
- `username` TEXT UNIQUE
- `display_name` TEXT
- `password_hash` TEXT — format: `salt:derivedKey` (scrypt)
- `is_admin` INTEGER (0 or 1)
- `color` TEXT — hex color for UI identification
- `created_at` TEXT

**`sessions`** — Active login sessions
- `id` INTEGER PRIMARY KEY
- `user_id` INTEGER → `users(id)` ON DELETE CASCADE
- `token_hash` TEXT UNIQUE — SHA-256 hash of the session token
- `expires_at` TEXT
- `created_at` TEXT

**`shifts`** — Shift earnings records
- `id` INTEGER PRIMARY KEY
- `date` TEXT — `YYYY-MM-DD`
- `hourly_rate` REAL
- `hours_worked` REAL
- `tip_mode` TEXT — `'total'` or `'per_hour'`
- `tip_input` REAL — raw user input
- `total_tips` REAL — computed: `tip_input × hours` (if per_hour) or `tip_input`
- `wage_total` REAL — computed: `hourly_rate × hours_worked`
- `grand_total` REAL — computed: `wage_total + total_tips`
- `notes` TEXT
- `job_id` INTEGER → `jobs(id)` (nullable)
- `user_id` INTEGER → `users(id)` (nullable)
- `deleted_at` TEXT — null = active, timestamp = soft-deleted
- `created_at` TEXT

**`jobs`** — Employers / work locations
- `id` INTEGER PRIMARY KEY
- `name` TEXT
- `default_rate` REAL
- `color` TEXT
- `archived` INTEGER (0 or 1)
- `overtime_threshold` REAL (default 40)
- `overtime_multiplier` REAL (default 1.5)
- `tip_payment` TEXT — `'cash'` or `'paycheck'`
- `user_id` INTEGER → `users(id)` — owner (nullable for legacy rows)
- `created_at` TEXT

**`templates`** — Reusable shift configurations
- `id` INTEGER PRIMARY KEY
- `name` TEXT
- `job_id` INTEGER → `jobs(id)` (nullable)
- `hourly_rate` REAL
- `hours_worked` REAL
- `tip_mode` TEXT
- `tip_input` REAL
- `notes` TEXT
- `user_id` INTEGER → `users(id)` — owner
- `created_at` TEXT

**`goals`** — Income targets
- `id` INTEGER PRIMARY KEY
- `period` TEXT — `'weekly'` or `'monthly'`
- `target_amount` REAL
- `active` INTEGER (0 or 1)
- `user_id` INTEGER → `users(id)` — owner
- `created_at` TEXT

**`tax_config`** — Tax and deduction items per user
- `id` INTEGER PRIMARY KEY
- `key` TEXT — unique slug per user (e.g. `federal`, `state`, `tip_tax`)
- `label` TEXT
- `rate` REAL — 0–1 decimal fraction
- `flat_amount` REAL — optional fixed per-period deduction
- `enabled` INTEGER (0 or 1)
- `sort_order` INTEGER
- `user_id` INTEGER → `users(id)`
- UNIQUE constraint on `(key, user_id)`

**`paychecks`** — Actual paycheck records
- `id` INTEGER PRIMARY KEY
- `user_id` INTEGER → `users(id)`
- `period_start` TEXT — `YYYY-MM-DD`
- `period_end` TEXT — `YYYY-MM-DD`
- `gross_amount` REAL
- `net_amount` REAL
- `notes` TEXT
- `created_at` TEXT

**`households`** — Named groups of users for shared data access
- `id` INTEGER PRIMARY KEY
- `name` TEXT
- `invite_code` TEXT UNIQUE — 8-character alphanumeric code for joining
- `created_by` INTEGER → `users(id)`
- `created_at` TEXT

**`household_members`** — Membership mapping (many-to-many)
- `id` INTEGER PRIMARY KEY
- `household_id` INTEGER → `households(id)` ON DELETE CASCADE
- `user_id` INTEGER → `users(id)`
- `role` TEXT — `'admin'` or `'member'`
- `joined_at` TEXT
- UNIQUE constraint on `(household_id, user_id)`

**`household_invitations`** — Pending invitations to join a household
- `id` INTEGER PRIMARY KEY
- `household_id` INTEGER → `households(id)` ON DELETE CASCADE
- `inviter_id` INTEGER → `users(id)`
- `invitee_id` INTEGER → `users(id)`
- `status` TEXT — `'pending'`, `'accepted'`, or `'declined'`
- `created_at` TEXT

**`audit_log`** — Log of sensitive operations
- `id` INTEGER PRIMARY KEY
- `user_id` INTEGER → `users(id)` — actor
- `action` TEXT — e.g. `login`, `register`, `change_password`, `delete_user`
- `target_id` INTEGER — the affected resource ID (nullable)
- `meta` TEXT — JSON string with additional context
- `created_at` TEXT

**`password_history`** — Previous password hashes to prevent reuse
- `id` INTEGER PRIMARY KEY
- `user_id` INTEGER → `users(id)` ON DELETE CASCADE
- `password_hash` TEXT
- `created_at` TEXT

---

## Migration System

Migrations are defined as an array of functions in `server.js`. Each function runs the SQL needed to upgrade from the previous version.

| Version | Changes |
|---------|---------|
| v1 | `shifts`, `users`, `sessions` tables; `user_id`, `deleted_at`, `job_id` columns on shifts |
| v2 | `jobs` table |
| v3 | `templates` table |
| v4 | `goals` table |
| v5 | `tax_config` table; pay period default meta values |
| v6 | `tip_payment` column on `jobs` |
| v7 | `paychecks` table |
| v8 | `user_id` column on `jobs`, `templates`, `goals`, and `tax_config` (user-scoped data) |
| v9 | `households` and `household_members` tables; `invite_code` on households |
| v10 | Fix `tax_config` UNIQUE constraint to `(key, user_id)` for per-user rows |
| v11 | Repair missing `user_id` columns on older databases that skipped v8 |
| v12 | `audit_log` and `password_history` tables |
| v13 | Assign legacy NULL `user_id` rows to the first admin user |
| v14 | `household_invitations` table; `role` column on `household_members` |

### How It Works

1. On startup, read `db_version` from the `meta` table (default: 0)
2. Run all migration functions from the current version to the latest
3. Each migration increments `db_version`
4. All migrations run inside a single transaction — if any fails, everything rolls back

### Safety Features

- `CREATE TABLE IF NOT EXISTS` prevents conflicts on re-runs
- Column additions check `PRAGMA table_info()` before running `ALTER TABLE`
- Migrations are idempotent by design

---

## Authentication Flow

### Password Storage

1. Generate 16-byte random salt
2. Derive 64-byte key using `crypto.scrypt(password, salt, 64)`
3. Store as `salt:derivedKey` (both hex-encoded)

Password history is checked on change to prevent reuse of recent passwords.

### Session Management (web)

1. On login, generate 32-byte random token
2. Hash token with SHA-256 → store hash in `sessions` table
3. Sign the raw token with HMAC-SHA256 using `SESSION_SECRET`
4. Set signed token as `sl_session` cookie (HttpOnly, SameSite=Lax, 30-day Max-Age)

### Token Authentication (mobile / API clients)

1. `POST /api/auth/login` or `/api/auth/signup` — returns `{ token, user }` in the JSON body
2. Client stores the token and sends it as `Authorization: Bearer <token>` on subsequent requests
3. `POST /api/auth/refresh` rotates the token (issues a new one, invalidates the old one)
4. `authMiddleware` accepts **either** a valid `sl_session` cookie or a valid `Authorization: Bearer` token

### Request Authentication

1. Parse `sl_session` cookie or `Authorization: Bearer` header
2. Verify HMAC signature against `SESSION_SECRET`
3. SHA-256 hash the token
4. Look up hash in `sessions` table, joined with `users`
5. Check `expires_at > now()`
6. Attach user object to `req.user`

### Security Properties

- Raw tokens never stored server-side (only SHA-256 hashes)
- Timing-safe comparison for both password verification and cookie/token verification
- Session tokens are cryptographically random (256-bit)
- Cookies are HttpOnly (no JavaScript access) and SameSite=Lax (CSRF protection)

---

## Household Data Filtering

When a user belongs to one or more households, data queries are expanded to include the combined user IDs of all household members. This allows users to see each other's shifts on the shared dashboard.

The `resolveUserFilter()` helper returns the set of visible user IDs for a given request. Queries use `appendUserFilter()` to inject the correct `WHERE user_id IN (...)` clause based on household membership.

Admins can always filter to any user. Non-admins can view combined household data or filter to just their own.

---

## Rate Limiting

| Limiter | Window | Max Requests |
|---------|--------|-------------|
| Auth (login/logout/setup) | 15 min | 20 per IP |
| Profile endpoints | 15 min | 60 per IP |
| Household mutations | 15 min | 30 per IP |
| Password change | 15 min | 10 per IP |
| General API | 1 min | 120 per IP |

---

## Request Lifecycle

```
Client Request
    │
    ├── express.json() middleware (parse body, 100 KB limit)
    ├── express.static() (serve public/ files)
    ├── Security headers middleware (CSP, X-Frame-Options, etc.)
    ├── Request logger (Pino — logs method, URL, status, duration)
    │
    ├── Route handler
    │   ├── Rate limiter (per-endpoint)
    │   ├── authMiddleware (verify session cookie or Bearer token, attach req.user)
    │   ├── adminOnly (check req.user.is_admin) [if needed]
    │   ├── validate(schema) (Zod validation, attach req.validated) [if needed]
    │   └── Handler logic (DB queries, response)
    │
    └── Response
```

---

## Frontend Architecture

The frontend is a single HTML file containing inline CSS and JavaScript. No build tools, no framework.

### View System

Five views managed by a `showView(n)` function that toggles visibility:
1. **Log** — shift entry form
2. **Dashboard** — analytics and charts
3. **History** — shift table with CRUD
4. **Reports** — export/import UI
5. **Settings** — profile, user management, tax config, jobs, pay period

### State Management

- No formal state library — DOM is the source of truth
- API calls use `fetch()` with credentials
- On view switch, data is re-fetched from the API
- Theme preference stored in `localStorage`

### Chart Rendering

- Chart.js loaded from CDN
- Four chart instances created on dashboard load
- Chart type and data updated when the user selects a different trend view
- Charts destroyed and recreated on each dashboard refresh to prevent memory leaks

### Service Worker

- **Install**: caches the app shell (`/`, `/manifest.json`, `/icon-192.svg`)
- **Fetch strategy**:
  - API calls (`/api/*`): network-first, falls back to `{"error":"Offline"}` JSON
  - Static assets: cache-first, falls back to network (and caches the response)
- **Activate**: cleans up old cache versions

---

## Mobile App Architecture

The React Native (Expo 50) companion app uses the same REST API as the web frontend.

- **Auth**: Bearer token stored in `AsyncStorage`; injected via Axios request interceptor
- **State**: Zustand stores for auth (`authStore`) and shift data (`shiftStore`)
- **Navigation**: React Navigation native stack (auth stack when logged out, app stack when logged in)
- **Token rotation**: calls `POST /api/auth/refresh` to rotate the session token
- **Self-registration**: users can create accounts via `POST /api/auth/signup` without an admin invite
- **API URL**: configured via `EXPO_PUBLIC_API_URL` env variable (defaults to `http://localhost:3000`)

---

## Graceful Shutdown

The server handles `SIGTERM` and `SIGINT`:

1. Stop accepting new connections (`server.close()`)
2. Close the SQLite database connection (`db.close()`)
3. Exit cleanly
4. Forced exit after 5-second timeout if connections don't drain

This ensures clean shutdown when systemd stops the service and prevents database corruption.
