
const express = require('express');
const Database = require('better-sqlite3');
const PDFDocument = require('pdfkit');
const path = require('path');
const crypto = require('crypto');
const { z } = require('zod');
const pino = require('pino');

// ── Logger ───────────────────────────────────────────────────────────────────
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
});

const app = express();
app.disable('x-powered-by');
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'shifts.db');
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days

// ── Database Init ────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Migration system
db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);

function getDbVersion() {
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'db_version'`).get();
  return row ? parseInt(row.value, 10) : 0;
}

function setDbVersion(v) {
  db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('db_version', ?)`).run(String(v));
}

function migrate() {
  const version = getDbVersion();
  const migrations = [
    // v1: original shifts table + users + sessions
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS shifts (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          date        TEXT    NOT NULL,
          hourly_rate REAL    NOT NULL,
          hours_worked REAL   NOT NULL,
          tip_mode    TEXT    NOT NULL,
          tip_input   REAL    NOT NULL,
          total_tips  REAL    NOT NULL,
          wage_total  REAL    NOT NULL,
          grand_total REAL    NOT NULL,
          notes       TEXT    DEFAULT '',
          created_at  TEXT    DEFAULT (datetime('now'))
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          username      TEXT    NOT NULL UNIQUE,
          display_name  TEXT    NOT NULL,
          password_hash TEXT    NOT NULL,
          is_admin      INTEGER NOT NULL DEFAULT 0,
          color         TEXT    NOT NULL DEFAULT '#f5a623',
          created_at    TEXT    DEFAULT (datetime('now'))
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          token_hash TEXT    NOT NULL UNIQUE,
          expires_at TEXT    NOT NULL,
          created_at TEXT    DEFAULT (datetime('now'))
        )
      `);
      // Add user_id to shifts if not present
      const cols = db.prepare(`PRAGMA table_info(shifts)`).all().map(c => c.name);
      if (!cols.includes('user_id')) {
        db.exec(`ALTER TABLE shifts ADD COLUMN user_id INTEGER REFERENCES users(id)`);
      }
      if (!cols.includes('deleted_at')) {
        db.exec(`ALTER TABLE shifts ADD COLUMN deleted_at TEXT DEFAULT NULL`);
      }
      if (!cols.includes('job_id')) {
        db.exec(`ALTER TABLE shifts ADD COLUMN job_id INTEGER REFERENCES jobs(id)`);
      }
    },
    // v2: jobs table
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS jobs (
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          name                TEXT    NOT NULL,
          default_rate        REAL    DEFAULT 0,
          color               TEXT    NOT NULL DEFAULT '#f5a623',
          archived            INTEGER NOT NULL DEFAULT 0,
          overtime_threshold  REAL    DEFAULT 40,
          overtime_multiplier REAL    DEFAULT 1.5,
          created_at          TEXT    DEFAULT (datetime('now'))
        )
      `);
    },
    // v3: templates table
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS templates (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          name         TEXT    NOT NULL,
          job_id       INTEGER REFERENCES jobs(id),
          hourly_rate  REAL    NOT NULL DEFAULT 0,
          hours_worked REAL    NOT NULL DEFAULT 0,
          tip_mode     TEXT    NOT NULL DEFAULT 'total',
          tip_input    REAL    NOT NULL DEFAULT 0,
          notes        TEXT    DEFAULT '',
          created_at   TEXT    DEFAULT (datetime('now'))
        )
      `);
    },
    // v4: goals table
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS goals (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          period        TEXT    NOT NULL DEFAULT 'weekly',
          target_amount REAL    NOT NULL DEFAULT 0,
          active        INTEGER NOT NULL DEFAULT 1,
          created_at    TEXT    DEFAULT (datetime('now'))
        )
      `);
    },
    // v5: tax_config table + pay period defaults
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS tax_config (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          key         TEXT    NOT NULL UNIQUE,
          label       TEXT    NOT NULL,
          rate        REAL    NOT NULL DEFAULT 0,
          flat_amount REAL    NOT NULL DEFAULT 0,
          enabled     INTEGER NOT NULL DEFAULT 1,
          sort_order  INTEGER NOT NULL DEFAULT 0
        )
      `);
      // Insert default tax items
      const insert = db.prepare('INSERT OR IGNORE INTO tax_config (key, label, rate, flat_amount, enabled, sort_order) VALUES (?,?,?,?,?,?)');
      insert.run('federal', 'Federal Income Tax', 0.22, 0, 1, 0);
      insert.run('state', 'State Income Tax', 0.05, 0, 1, 1);
      insert.run('social_security', 'Social Security', 0.062, 0, 1, 2);
      insert.run('medicare', 'Medicare', 0.0145, 0, 1, 3);
      insert.run('tip_tax', 'Tip Tax (Self-Employment)', 0.153, 0, 1, 4);
      // Set default pay period type
      db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('pay_period_type', 'weekly')").run();
      db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('pay_period_anchor', '')").run();
    },
    // v6: tip_payment column on jobs
    () => {
      const cols = db.prepare('PRAGMA table_info(jobs)').all().map(c => c.name);
      if (!cols.includes('tip_payment')) {
        db.exec("ALTER TABLE jobs ADD COLUMN tip_payment TEXT NOT NULL DEFAULT 'cash'");
      }
    },
    // v7: paychecks table for tracking real paycheck data
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS paychecks (
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          pay_date            TEXT    NOT NULL,
          gross_pay           REAL    NOT NULL DEFAULT 0,
          federal_withholding REAL    NOT NULL DEFAULT 0,
          state_withholding   REAL    NOT NULL DEFAULT 0,
          social_security     REAL    NOT NULL DEFAULT 0,
          medicare            REAL    NOT NULL DEFAULT 0,
          net_pay             REAL    NOT NULL DEFAULT 0,
          notes               TEXT    DEFAULT '',
          created_at          TEXT    DEFAULT (datetime('now'))
        )
      `);
    },
    // v8: user-scoped jobs, templates, goals, and per-user tax_config
    () => {
      const jobCols = db.prepare('PRAGMA table_info(jobs)').all().map(c => c.name);
      if (!jobCols.includes('user_id')) {
        db.exec('ALTER TABLE jobs ADD COLUMN user_id INTEGER REFERENCES users(id)');
      }
      const tplCols = db.prepare('PRAGMA table_info(templates)').all().map(c => c.name);
      if (!tplCols.includes('user_id')) {
        db.exec('ALTER TABLE templates ADD COLUMN user_id INTEGER REFERENCES users(id)');
      }
      const goalCols = db.prepare('PRAGMA table_info(goals)').all().map(c => c.name);
      if (!goalCols.includes('user_id')) {
        db.exec('ALTER TABLE goals ADD COLUMN user_id INTEGER REFERENCES users(id)');
      }
      const taxCols = db.prepare('PRAGMA table_info(tax_config)').all().map(c => c.name);
      if (!taxCols.includes('user_id')) {
        db.exec('ALTER TABLE tax_config ADD COLUMN user_id INTEGER REFERENCES users(id)');
      }
    },
    // v9: households feature
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS households (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          name        TEXT    NOT NULL,
          created_by  INTEGER REFERENCES users(id),
          invite_code TEXT    NOT NULL UNIQUE,
          created_at  TEXT    DEFAULT (datetime('now'))
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS household_members (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
          user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          joined_at    TEXT    DEFAULT (datetime('now')),
          UNIQUE(household_id, user_id)
        )
      `);
    },
    // v10: fix tax_config UNIQUE constraint to allow per-user rows (key+user_id unique)
    () => {
      // Guard: if user_id column was not yet added by v8 (e.g. on a db that went through v7=paychecks but not v8 yet), add it first
      const taxCols = db.prepare('PRAGMA table_info(tax_config)').all().map(c => c.name);
      if (!taxCols.includes('user_id')) {
        db.exec('ALTER TABLE tax_config ADD COLUMN user_id INTEGER REFERENCES users(id)');
      }
      // Recreate tax_config with composite unique constraint
      db.exec(`
        CREATE TABLE IF NOT EXISTS tax_config_new (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          key         TEXT    NOT NULL,
          label       TEXT    NOT NULL,
          rate        REAL    NOT NULL DEFAULT 0,
          flat_amount REAL    NOT NULL DEFAULT 0,
          enabled     INTEGER NOT NULL DEFAULT 1,
          sort_order  INTEGER NOT NULL DEFAULT 0,
          user_id     INTEGER REFERENCES users(id),
          UNIQUE(key, user_id)
        )
      `);
      // Copy existing rows (all will have user_id=NULL from old schema)
      db.exec(`INSERT OR IGNORE INTO tax_config_new (id, key, label, rate, flat_amount, enabled, sort_order, user_id)
               SELECT id, key, label, rate, flat_amount, enabled, sort_order, user_id FROM tax_config`);
      db.exec('DROP TABLE tax_config');
      db.exec('ALTER TABLE tax_config_new RENAME TO tax_config');
    },
    // v11: repair missing user_id columns on older databases that may have skipped v8
    () => {
      const tableFixes = [
        ['jobs', 'ALTER TABLE jobs ADD COLUMN user_id INTEGER REFERENCES users(id)'],
        ['templates', 'ALTER TABLE templates ADD COLUMN user_id INTEGER REFERENCES users(id)'],
        ['goals', 'ALTER TABLE goals ADD COLUMN user_id INTEGER REFERENCES users(id)'],
        ['tax_config', 'ALTER TABLE tax_config ADD COLUMN user_id INTEGER REFERENCES users(id)'],
      ];
      for (const [tableName, alterSql] of tableFixes) {
        const cols = db.prepare(`PRAGMA table_info(${tableName})`).all().map(c => c.name);
        if (!cols.includes('user_id')) {
          db.exec(alterSql);
        }
      }
    },
    // v12: audit_log and password_history tables
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS audit_log (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          actor_id    INTEGER NOT NULL REFERENCES users(id),
          target_id   INTEGER NOT NULL REFERENCES users(id),
          action      TEXT    NOT NULL,
          detail      TEXT    DEFAULT '',
          created_at  TEXT    DEFAULT (datetime('now'))
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS password_history (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          password_hash TEXT    NOT NULL,
          created_at    TEXT    DEFAULT (datetime('now'))
        )
      `);
    },
    // v13: assign legacy NULL user_id rows to the first admin user
    // Shifts, jobs, templates, and goals created before user accounts existed have user_id = NULL.
    // Assigning them to the first admin prevents them leaking into every user's data views.
    () => {
      const admin = db.prepare('SELECT id FROM users WHERE is_admin = 1 ORDER BY id ASC LIMIT 1').get();
      if (admin) {
        db.prepare('UPDATE shifts    SET user_id = ? WHERE user_id IS NULL').run(admin.id);
        db.prepare('UPDATE jobs      SET user_id = ? WHERE user_id IS NULL').run(admin.id);
        db.prepare('UPDATE templates SET user_id = ? WHERE user_id IS NULL').run(admin.id);
        db.prepare('UPDATE goals     SET user_id = ? WHERE user_id IS NULL').run(admin.id);
      }
    },
  ];

  const tx = db.transaction(() => {
    for (let i = version; i < migrations.length; i++) {
      logger.info(`Running migration v${i + 1}`);
      migrations[i]();
      setDbVersion(i + 1);
    }
  });
  tx();
}

migrate();

// ── User Filter Helpers ───────────────────────────────────────────────────────

// Returns all user IDs visible to the given user: their own plus any household members.
function getVisibleUserIds(userId) {
  const rows = db.prepare(`
    SELECT DISTINCT hm2.user_id
    FROM household_members hm1
    JOIN household_members hm2 ON hm1.household_id = hm2.household_id
    WHERE hm1.user_id = ?
  `).all(userId);
  const ids = rows.map(r => r.user_id);
  return [...new Set([userId, ...ids])];
}

// Returns an array of user IDs to filter by, or null to show all users' data.
// Non-admins always see their own + household members' data.
// Admins can pass user_id=all (all data) or user_id=<id> (specific user).
// Omitting user_id defaults to current user for both roles.
function resolveUserFilter(req) {
  const param = req.query.user_id;
  if (req.user && req.user.is_admin) {
    if (param === 'all') return null;
    if (param) return [parseInt(param, 10) || req.user.id];
    return [req.user.id];
  }
  if (!req.user) return null;
  return getVisibleUserIds(req.user.id);
}

// Appends an IN-clause user_id filter to a SQL string and params array.
// filterUser: null (no filter) or array of user IDs.
// column: the column expression to filter on (default 'user_id').
function appendUserFilter(sql, params, filterUser, column = 'user_id') {
  if (filterUser === null) return sql;
  const placeholders = filterUser.map(() => '?').join(',');
  params.push(...filterUser);
  return sql + ` AND ${column} IN (${placeholders})`;
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '100kb' }));

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // X-Frame-Options kept for older browser compatibility; frame-ancestors 'none' in CSP takes precedence in modern browsers
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    // unsafe-inline is required because index.html uses inline <script> and <style> blocks.
    // A future refactor to external files + nonces would allow removing these directives.
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; " +
    "img-src 'self' data:; " +
    "connect-src 'self'; " +
    "frame-ancestors 'none';"
  );
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.info({ method: req.method, url: req.originalUrl, status: res.statusCode, ms: Date.now() - start });
  });
  next();
});

// ── Auth Helpers ─────────────────────────────────────────────────────────────
const USER_COLORS = ['#f5a623','#3ecf8e','#7ecee3','#ff5e5e','#c084fc','#f472b6','#facc15','#fb923c'];

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('hex');
    crypto.scrypt(password, salt, 64, (err, key) => {
      if (err) reject(err);
      resolve(salt + ':' + key.toString('hex'));
    });
  });
}

function verifyPassword(password, hash) {
  return new Promise((resolve, reject) => {
    const [salt, key] = hash.split(':');
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) reject(err);
      resolve(crypto.timingSafeEqual(Buffer.from(key, 'hex'), derivedKey));
    });
  });
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function signCookie(value) {
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
  return value + '.' + sig;
}

function verifyCookie(signed) {
  if (!signed) return null;
  const idx = signed.lastIndexOf('.');
  if (idx < 0) return null;
  const value = signed.substring(0, idx);
  const sig = signed.substring(idx + 1);
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return value;
}

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach(part => {
    const [k, ...v] = part.trim().split('=');
    if (k) cookies[k.trim()] = decodeURIComponent(v.join('='));
  });
  return cookies;
}

function getUserCount() {
  return db.prepare('SELECT COUNT(*) as c FROM users').get().c;
}

// Check if a plaintext password matches any of the last 5 stored hashes for a user
async function isPasswordInHistory(userId, plaintext) {
  const history = db.prepare('SELECT password_hash FROM password_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 5').all(userId);
  for (const h of history) {
    if (await verifyPassword(plaintext, h.password_hash)) return true;
  }
  return false;
}

// Keep only the 5 most recent password history entries for a user
function prunePasswordHistory(userId) {
  db.prepare(`DELETE FROM password_history WHERE user_id = ? AND id NOT IN (
    SELECT id FROM password_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 5
  )`).run(userId, userId);
}

// Simple in-memory rate limiter (no extra dependencies).
// windowMs: sliding window in ms. maxRequests: max allowed per window per IP.
function createRateLimiter(windowMs, maxRequests) {
  const hits = new Map();
  // Prune stale entries periodically to prevent unbounded memory growth
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, timestamps] of hits) {
      const fresh = timestamps.filter((t) => t > cutoff);
      if (fresh.length === 0) hits.delete(key);
      else hits.set(key, fresh);
    }
  }, windowMs).unref();

  return (req, res, next) => {
    const forwarded = req.headers['x-forwarded-for'];
    const ip = (forwarded ? forwarded.split(',')[0].trim() : null)
      || req.socket.remoteAddress
      || 'unknown';
    const now = Date.now();
    const cutoff = now - windowMs;
    const timestamps = (hits.get(ip) || []).filter((t) => t > cutoff);
    if (timestamps.length >= maxRequests) {
      return res.status(429).json({ error: 'Too many requests, please try again later' });
    }
    timestamps.push(now);
    hits.set(ip, timestamps);
    next();
  };
}

// Rate limiters for sensitive auth endpoints
const authRateLimit = createRateLimiter(15 * 60 * 1000, 20); // 20 requests per 15 min
const passwordChangeRateLimit = createRateLimiter(15 * 60 * 1000, 5); // 5 password changes per 15 min
// General API rate limiter
const apiRateLimit = createRateLimiter(60 * 1000, 120); // 120 requests per minute per IP

// Safe error response — never leak internal error details in production
function internalError(res, err) {
  logger.error(err);
  const msg = process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message;
  res.status(500).json({ error: msg });
}

// Auth middleware
function authMiddleware(req, res, next) {
  // If no users exist, skip auth (first-run setup)
  if (getUserCount() === 0) {
    req.user = null;
    return next();
  }

  // Accept Bearer token (mobile) or signed session cookie (web)
  let token = null;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else {
    const cookies = parseCookies(req.headers.cookie);
    token = verifyCookie(cookies.sl_session);
  }
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  const tokenH = hashToken(token);
  const session = db.prepare(`
    SELECT s.*, u.id as uid, u.username, u.display_name, u.is_admin, u.color
    FROM sessions s JOIN users u ON s.user_id = u.id
    WHERE s.token_hash = ? AND s.expires_at > datetime('now')
  `).get(tokenH);

  if (!session) return res.status(401).json({ error: 'Session expired' });

  req.user = {
    id: session.uid,
    username: session.username,
    display_name: session.display_name,
    is_admin: !!session.is_admin,
    color: session.color,
  };
  next();
}

function adminOnly(req, res, next) {
  if (!req.user || !req.user.is_admin) return res.status(403).json({ error: 'Admin only' });
  next();
}

// ── Zod Schemas ──────────────────────────────────────────────────────────────
const ShiftSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  hourly_rate: z.number().min(0),
  hours_worked: z.number().min(0),
  tip_mode: z.enum(['total', 'per_hour']),
  tip_input: z.number().min(0),
  notes: z.string().optional().default(''),
  job_id: z.number().int().nullable().optional().default(null),
});

const JobSchema = z.object({
  name: z.string().min(1).max(100),
  default_rate: z.number().min(0).optional().default(0),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().default('#f5a623'),
  overtime_threshold: z.number().min(0).optional().default(40),
  overtime_multiplier: z.number().min(1).optional().default(1.5),
  tip_payment: z.enum(['cash', 'paycheck']).optional().default('cash'),
});

const TemplateSchema = z.object({
  name: z.string().min(1).max(100),
  job_id: z.number().int().nullable().optional().default(null),
  hourly_rate: z.number().min(0).optional().default(0),
  hours_worked: z.number().min(0).optional().default(0),
  tip_mode: z.enum(['total', 'per_hour']).optional().default('total'),
  tip_input: z.number().min(0).optional().default(0),
  notes: z.string().optional().default(''),
});

const GoalSchema = z.object({
  period: z.enum(['weekly', 'monthly']),
  target_amount: z.number().min(0),
  active: z.boolean().optional().default(true),
});

const PaycheckSchema = z.object({
  pay_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'pay_date must be YYYY-MM-DD'),
  gross_pay: z.number().positive(),
  federal_withholding: z.number().nonnegative().default(0),
  state_withholding: z.number().nonnegative().default(0),
  social_security: z.number().nonnegative().default(0),
  medicare: z.number().nonnegative().default(0),
  net_pay: z.number().nonnegative(),
  notes: z.string().max(500).optional().default(''),
});

const RegisterSchema = z.object({
  username: z.string().min(2).max(50).regex(/^[a-zA-Z0-9_]+$/),
  password: z.string().min(4).max(200),
  display_name: z.string().min(1).max(100),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

const LoginSchema = z.object({
  username: z.string(),
  password: z.string(),
});

const ChangePasswordSchema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(8).max(200)
    .regex(/[A-Za-z]/, 'must contain at least one letter')
    .regex(/[0-9!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~]/, 'must contain at least one number or special character'),
});

const AdminResetPasswordSchema = z.object({
  new_password: z.string().min(8).max(200)
    .regex(/[A-Za-z]/, 'must contain at least one letter')
    .regex(/[0-9!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~]/, 'must contain at least one number or special character'),
});

function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: 'Validation failed', details: result.error.flatten().fieldErrors });
    }
    req.validated = result.data;
    next();
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const fmt = (d) => d.toISOString().split('T')[0];

function getPayWeekStartDay() {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'pay_week_start_day'").get();
  return row ? parseInt(row.value, 10) : 1; // default Monday (1)
}

function getPeriodBounds() {
  const now = new Date();
  const startDay = getPayWeekStartDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const today = now.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const daysSinceStart = (today - startDay + 7) % 7;

  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - daysSinceStart);
  weekStart.setHours(0, 0, 0, 0);

  const lastWeekEnd = new Date(weekStart);
  lastWeekEnd.setDate(lastWeekEnd.getDate() - 1);
  const lastWeekStart = new Date(lastWeekEnd);
  lastWeekStart.setDate(lastWeekEnd.getDate() - 6);

  const biweekStart = new Date(weekStart);
  biweekStart.setDate(biweekStart.getDate() - 7);

  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
  const ytdStart = new Date(now.getFullYear(), 0, 1);

  return { now, weekStart, lastWeekStart, lastWeekEnd, biweekStart, monthStart, lastMonthStart, lastMonthEnd, ytdStart };
}

// ── Auth Routes ──────────────────────────────────────────────────────────────

// Apply general rate limit to all API routes
app.use('/api', apiRateLimit);

// GET /api/health — simple liveness check (no auth required)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// GET /api/auth/status — check if setup needed or logged in
app.get('/api/auth/status', (req, res) => {
  const userCount = getUserCount();
  if (userCount === 0) return res.json({ status: 'setup' });

  const cookies = parseCookies(req.headers.cookie);
  const token = verifyCookie(cookies.sl_session);
  if (!token) return res.json({ status: 'login' });

  const tokenH = hashToken(token);
  const session = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.is_admin, u.color
    FROM sessions s JOIN users u ON s.user_id = u.id
    WHERE s.token_hash = ? AND s.expires_at > datetime('now')
  `).get(tokenH);

  if (!session) return res.json({ status: 'login' });
  return res.json({ status: 'authenticated', user: session });
});

// POST /api/auth/setup — create first admin user
app.post('/api/auth/setup', authRateLimit, validate(RegisterSchema), async (req, res) => {
  try {
    if (getUserCount() > 0) return res.status(400).json({ error: 'Setup already completed' });
    const { username, password, display_name, color } = req.validated;
    const pw = await hashPassword(password);
    const assignedColor = color || USER_COLORS[0];
    const result = db.prepare(`INSERT INTO users (username, display_name, password_hash, is_admin, color) VALUES (?,?,?,1,?)`)
      .run(username, display_name, pw, assignedColor);

    const token = generateToken();
    const expires = new Date(Date.now() + SESSION_MAX_AGE).toISOString();
    db.prepare(`INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (?,?,?)`).run(result.lastInsertRowid, hashToken(token), expires);
    res.setHeader('Set-Cookie', `sl_session=${signCookie(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE / 1000}`);
    res.json({ success: true, token, user: { id: result.lastInsertRowid, username, display_name, is_admin: true, color: assignedColor } });
  } catch (e) {
    internalError(res, e);
  }
});

// POST /api/auth/login
app.post('/api/auth/login', authRateLimit, validate(LoginSchema), async (req, res) => {
  try {
    const { username, password } = req.validated;
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = generateToken();
    const expires = new Date(Date.now() + SESSION_MAX_AGE).toISOString();
    db.prepare(`INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (?,?,?)`).run(user.id, hashToken(token), expires);
    res.setHeader('Set-Cookie', `sl_session=${signCookie(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE / 1000}`);
    res.json({ success: true, token, user: { id: user.id, username: user.username, display_name: user.display_name, is_admin: !!user.is_admin, color: user.color } });
  } catch (e) {
    internalError(res, e);
  }
});

// POST /api/auth/logout
app.post('/api/auth/logout', authRateLimit, (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  } else {
    const cookies = parseCookies(req.headers.cookie);
    const token = verifyCookie(cookies.sl_session);
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  }
  // Always clear the session cookie (harmless if it was never set)
  res.setHeader('Set-Cookie', 'sl_session=; Path=/; HttpOnly; Max-Age=0');
  res.json({ success: true });
});

// POST /api/auth/register — admin creates new user
app.post('/api/auth/register', authMiddleware, adminOnly, validate(RegisterSchema), async (req, res) => {
  try {
    const { username, password, display_name, color } = req.validated;
    const existingCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
    const assignedColor = color || USER_COLORS[existingCount % USER_COLORS.length];
    const pw = await hashPassword(password);
    const result = db.prepare(`INSERT INTO users (username, display_name, password_hash, is_admin, color) VALUES (?,?,?,0,?)`)
      .run(username, display_name, pw, assignedColor);
    res.json({ success: true, user: { id: result.lastInsertRowid, username, display_name, is_admin: false, color: assignedColor } });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Username already taken' });
    internalError(res, e);
  }
});

// POST /api/auth/signup — self-registration (requires at least one admin to exist)
app.post('/api/auth/signup', authRateLimit, validate(RegisterSchema), async (req, res) => {
  try {
    if (getUserCount() === 0) return res.status(400).json({ error: 'No admin account exists; use /api/auth/setup first' });
    const { username, password, display_name, color } = req.validated;
    const existingCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
    const assignedColor = color || USER_COLORS[existingCount % USER_COLORS.length];
    const pw = await hashPassword(password);
    const result = db.prepare(`INSERT INTO users (username, display_name, password_hash, is_admin, color) VALUES (?,?,?,0,?)`)
      .run(username, display_name, pw, assignedColor);

    const token = generateToken();
    const expires = new Date(Date.now() + SESSION_MAX_AGE).toISOString();
    db.prepare(`INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (?,?,?)`).run(result.lastInsertRowid, hashToken(token), expires);
    res.status(201).json({ success: true, token, user: { id: result.lastInsertRowid, username, display_name, is_admin: false, color: assignedColor } });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Username already taken' });
    internalError(res, e);
  }
});

// POST /api/auth/refresh — extend session expiry and return new token
app.post('/api/auth/refresh', authRateLimit, (req, res) => {
  let token = null;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else {
    const cookies = parseCookies(req.headers.cookie);
    token = verifyCookie(cookies.sl_session);
  }
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  const tokenH = hashToken(token);
  const session = db.prepare(`
    SELECT s.*, u.id as uid, u.username, u.display_name, u.is_admin, u.color
    FROM sessions s JOIN users u ON s.user_id = u.id
    WHERE s.token_hash = ? AND s.expires_at > datetime('now')
  `).get(tokenH);
  if (!session) return res.status(401).json({ error: 'Session expired' });

  const newToken = generateToken();
  const expires = new Date(Date.now() + SESSION_MAX_AGE).toISOString();
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenH);
  db.prepare(`INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (?,?,?)`).run(session.uid, hashToken(newToken), expires);
  res.setHeader('Set-Cookie', `sl_session=${signCookie(newToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE / 1000}`);
  res.json({ success: true, token: newToken, user: { id: session.uid, username: session.username, display_name: session.display_name, is_admin: !!session.is_admin, color: session.color } });
});

// ── User Management Routes ───────────────────────────────────────────────────

app.get('/api/users', authMiddleware, adminOnly, (req, res) => {
  const users = db.prepare('SELECT id, username, display_name, is_admin, color, created_at FROM users').all();
  res.json(users);
});

// GET /api/profile — current user's profile + household membership
app.get('/api/profile', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT id, username, display_name, is_admin, color, created_at FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const households = db.prepare(`
    SELECT h.id, h.name, h.invite_code, h.created_by,
           (SELECT COUNT(*) FROM household_members WHERE household_id = h.id) as member_count
    FROM households h
    JOIN household_members hm ON h.id = hm.household_id
    WHERE hm.user_id = ?
  `).all(req.user.id);
  res.json({ ...user, households });
});

app.put('/api/users/:id', authMiddleware, async (req, res) => {
  try {
    const targetId = parseInt(req.params.id, 10);
    const isOwnProfile = req.user && req.user.id === targetId;
    const isAdmin = req.user && req.user.is_admin;
    if (!isOwnProfile && !isAdmin) return res.status(403).json({ error: 'Forbidden' });

    const { display_name, color, is_admin } = req.body;
    if (display_name) db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(display_name, targetId);
    if (color) db.prepare('UPDATE users SET color = ? WHERE id = ?').run(color, targetId);
    if (isAdmin && is_admin !== undefined) {
      db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(is_admin ? 1 : 0, targetId);
    }
    res.json({ success: true });
  } catch (e) {
    internalError(res, e);
  }
});

app.delete('/api/users/:id', authMiddleware, adminOnly, (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  if (req.user.id === targetId) return res.status(400).json({ error: 'Cannot delete yourself' });
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(targetId);
  db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
  res.json({ success: true });
});

// ── Household Routes ─────────────────────────────────────────────────────────

const HouseholdSchema = z.object({
  name: z.string().min(1).max(100),
});

// GET /api/households — list households the current user belongs to
app.get('/api/households', authMiddleware, (req, res) => {
  const households = db.prepare(`
    SELECT h.id, h.name, h.invite_code, h.created_by, h.created_at,
           (SELECT COUNT(*) FROM household_members WHERE household_id = h.id) as member_count
    FROM households h
    JOIN household_members hm ON h.id = hm.household_id
    WHERE hm.user_id = ?
    ORDER BY h.name ASC
  `).all(req.user.id);
  res.json(households);
});

// GET /api/households/:id/members — list members of a household
app.get('/api/households/:id/members', authMiddleware, (req, res) => {
  const householdId = parseInt(req.params.id, 10);
  const membership = db.prepare('SELECT * FROM household_members WHERE household_id = ? AND user_id = ?').get(householdId, req.user.id);
  if (!membership && !req.user.is_admin) return res.status(403).json({ error: 'Not a member of this household' });
  const members = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.color, hm.joined_at
    FROM household_members hm
    JOIN users u ON hm.user_id = u.id
    WHERE hm.household_id = ?
    ORDER BY hm.joined_at ASC
  `).all(householdId);
  res.json(members);
});

// POST /api/households — create a new household (creator auto-joins)
app.post('/api/households', authMiddleware, validate(HouseholdSchema), (req, res) => {
  try {
    const { name } = req.validated;
    const inviteCode = crypto.randomBytes(6).toString('hex');
    const result = db.prepare('INSERT INTO households (name, created_by, invite_code) VALUES (?,?,?)')
      .run(name, req.user.id, inviteCode);
    const householdId = result.lastInsertRowid;
    db.prepare('INSERT INTO household_members (household_id, user_id) VALUES (?,?)').run(householdId, req.user.id);
    res.json({ id: householdId, name, invite_code: inviteCode, created_by: req.user.id, member_count: 1 });
  } catch (e) {
    logger.error(e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/households/join — join a household via invite code
app.post('/api/households/join', authMiddleware, (req, res) => {
  try {
    const { invite_code } = req.body;
    if (!invite_code) return res.status(400).json({ error: 'invite_code required' });
    const household = db.prepare('SELECT * FROM households WHERE invite_code = ?').get(invite_code.trim());
    if (!household) return res.status(404).json({ error: 'Invalid invite code' });
    const existing = db.prepare('SELECT * FROM household_members WHERE household_id = ? AND user_id = ?').get(household.id, req.user.id);
    if (existing) return res.status(409).json({ error: 'Already a member of this household' });
    db.prepare('INSERT INTO household_members (household_id, user_id) VALUES (?,?)').run(household.id, req.user.id);
    const memberCount = db.prepare('SELECT COUNT(*) as c FROM household_members WHERE household_id = ?').get(household.id).c;
    res.json({ success: true, household: { id: household.id, name: household.name, member_count: memberCount } });
  } catch (e) {
    logger.error(e);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/households/:id/leave — leave a household
app.delete('/api/households/:id/leave', authMiddleware, (req, res) => {
  const householdId = parseInt(req.params.id, 10);
  const membership = db.prepare('SELECT * FROM household_members WHERE household_id = ? AND user_id = ?').get(householdId, req.user.id);
  if (!membership) return res.status(404).json({ error: 'Not a member of this household' });
  db.prepare('DELETE FROM household_members WHERE household_id = ? AND user_id = ?').run(householdId, req.user.id);
  // If no members left, delete the household
  const remaining = db.prepare('SELECT COUNT(*) as c FROM household_members WHERE household_id = ?').get(householdId).c;
  if (remaining === 0) db.prepare('DELETE FROM households WHERE id = ?').run(householdId);
  res.json({ success: true });
});

// DELETE /api/households/:id — delete a household (creator or admin only)
app.delete('/api/households/:id', authMiddleware, (req, res) => {
  const householdId = parseInt(req.params.id, 10);
  const household = db.prepare('SELECT * FROM households WHERE id = ?').get(householdId);
  if (!household) return res.status(404).json({ error: 'Household not found' });
  if (household.created_by !== req.user.id && !req.user.is_admin) {
    return res.status(403).json({ error: 'Only the household creator or an admin can delete it' });
  }
  db.prepare('DELETE FROM households WHERE id = ?').run(householdId);
  res.json({ success: true });
});

// PUT /api/households/:id — rename a household (creator or admin only)
app.put('/api/households/:id', authMiddleware, validate(HouseholdSchema), (req, res) => {
  const householdId = parseInt(req.params.id, 10);
  const household = db.prepare('SELECT * FROM households WHERE id = ?').get(householdId);
  if (!household) return res.status(404).json({ error: 'Household not found' });
  if (household.created_by !== req.user.id && !req.user.is_admin) {
    return res.status(403).json({ error: 'Only the household creator or an admin can rename it' });
  }
  const { name } = req.validated;
  db.prepare('UPDATE households SET name = ? WHERE id = ?').run(name, householdId);
  res.json({ success: true });
});

// DELETE /api/households/:id/members/:userId — remove a member (creator or admin only)
app.delete('/api/households/:id/members/:userId', authMiddleware, (req, res) => {
  const householdId = parseInt(req.params.id, 10);
  const targetUserId = parseInt(req.params.userId, 10);
  const household = db.prepare('SELECT * FROM households WHERE id = ?').get(householdId);
  if (!household) return res.status(404).json({ error: 'Household not found' });
  if (household.created_by !== req.user.id && !req.user.is_admin && req.user.id !== targetUserId) {
    return res.status(403).json({ error: 'Not authorized to remove this member' });
  }
  db.prepare('DELETE FROM household_members WHERE household_id = ? AND user_id = ?').run(householdId, targetUserId);
  const remaining = db.prepare('SELECT COUNT(*) as c FROM household_members WHERE household_id = ?').get(householdId).c;
  if (remaining === 0) db.prepare('DELETE FROM households WHERE id = ?').run(householdId);
  res.json({ success: true });
});

// POST /api/auth/change-password — authenticated user changes their own password
app.post('/api/auth/change-password', authMiddleware, passwordChangeRateLimit, validate(ChangePasswordSchema), async (req, res) => {
  try {
    const { current_password, new_password } = req.validated;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const valid = await verifyPassword(current_password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

    if (await isPasswordInHistory(user.id, new_password)) {
      return res.status(400).json({ error: 'Cannot reuse a recent password' });
    }

    const newHash = await hashPassword(new_password);
    db.prepare('INSERT INTO password_history (user_id, password_hash) VALUES (?, ?)').run(user.id, user.password_hash);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, user.id);
    prunePasswordHistory(user.id);

    // Invalidate all sessions for this user
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);

    res.setHeader('Set-Cookie', 'sl_session=; Path=/; HttpOnly; Max-Age=0');
    res.json({ success: true, message: 'Password changed. Please log in again.' });
  } catch (e) {
    logger.error(e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/users/:id/reset-password — admin resets another user's password
app.post('/api/users/:id/reset-password', authMiddleware, adminOnly, passwordChangeRateLimit, validate(AdminResetPasswordSchema), async (req, res) => {
  try {
    const targetId = parseInt(req.params.id, 10);
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
    if (!target) return res.status(404).json({ error: 'User not found' });

    const { new_password } = req.validated;

    if (await isPasswordInHistory(targetId, new_password)) {
      return res.status(400).json({ error: 'Cannot reuse a recent password for this user' });
    }

    const newHash = await hashPassword(new_password);
    db.prepare('INSERT INTO password_history (user_id, password_hash) VALUES (?, ?)').run(targetId, target.password_hash);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, targetId);
    prunePasswordHistory(targetId);

    // Invalidate all sessions for the target user
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(targetId);

    // Log admin action
    db.prepare('INSERT INTO audit_log (actor_id, target_id, action, detail) VALUES (?, ?, ?, ?)').run(
      req.user.id, targetId, 'admin_password_reset',
      `Admin ${req.user.username} reset password for user ${target.username}`
    );
    logger.info({ actor: req.user.username, target: target.username, action: 'admin_password_reset' });

    res.json({ success: true, message: `Password reset for ${target.username}. Their sessions have been invalidated.` });
  } catch (e) {
    logger.error(e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/audit-log — admin views audit log
app.get('/api/audit-log', authMiddleware, adminOnly, authRateLimit, (req, res) => {
  const rows = db.prepare(`
    SELECT al.id, al.action, al.detail, al.created_at,
           a.username as actor_username, a.display_name as actor_display_name,
           t.username as target_username, t.display_name as target_display_name
    FROM audit_log al
    JOIN users a ON al.actor_id = a.id
    JOIN users t ON al.target_id = t.id
    ORDER BY al.created_at DESC LIMIT 100
  `).all();
  res.json(rows);
});

// ── Shift Routes (all require auth) ─────────────────────────────────────────

app.post('/api/shifts', authMiddleware, validate(ShiftSchema), (req, res) => {
  try {
    const { date, hourly_rate, hours_worked, tip_mode, tip_input, notes, job_id } = req.validated;
    const total_tips = tip_mode === 'per_hour' ? tip_input * hours_worked : tip_input;
    const wage_total = hourly_rate * hours_worked;
    const grand_total = wage_total + total_tips;
    const userId = req.user ? req.user.id : null;

    const result = db.prepare(`
      INSERT INTO shifts (date, hourly_rate, hours_worked, tip_mode, tip_input, total_tips, wage_total, grand_total, notes, job_id, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(date, hourly_rate, hours_worked, tip_mode, tip_input, total_tips, wage_total, grand_total, notes, job_id, userId);

    res.json({ id: result.lastInsertRowid, total_tips, wage_total, grand_total });
  } catch (e) {
    internalError(res, e);
  }
});

app.get('/api/shifts', authMiddleware, (req, res) => {
  const { from, to } = req.query;
  const filterUser = resolveUserFilter(req);
  let query = 'SELECT s.*, u.display_name as user_name, u.color as user_color, j.name as job_name, j.color as job_color FROM shifts s LEFT JOIN users u ON s.user_id = u.id LEFT JOIN jobs j ON s.job_id = j.id WHERE s.deleted_at IS NULL';
  const params = [];

  if (from && to) { query += ' AND s.date >= ? AND s.date <= ?'; params.push(from, to); }
  else if (from) { query += ' AND s.date >= ?'; params.push(from); }
  query = appendUserFilter(query, params, filterUser, 's.user_id');
  query += ' ORDER BY s.date DESC, s.id DESC';

  res.json(db.prepare(query).all(...params));
});

app.put('/api/shifts/:id', authMiddleware, validate(ShiftSchema), (req, res) => {
  try {
    const shift = db.prepare('SELECT * FROM shifts WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
    if (!shift) return res.status(404).json({ error: 'Shift not found' });
    if (req.user && shift.user_id !== req.user.id && !req.user.is_admin) {
      return res.status(403).json({ error: 'Not your shift' });
    }

    const { date, hourly_rate, hours_worked, tip_mode, tip_input, notes, job_id } = req.validated;
    const total_tips = tip_mode === 'per_hour' ? tip_input * hours_worked : tip_input;
    const wage_total = hourly_rate * hours_worked;
    const grand_total = wage_total + total_tips;

    db.prepare(`
      UPDATE shifts SET date=?, hourly_rate=?, hours_worked=?, tip_mode=?, tip_input=?,
      total_tips=?, wage_total=?, grand_total=?, notes=?, job_id=? WHERE id=?
    `).run(date, hourly_rate, hours_worked, tip_mode, tip_input, total_tips, wage_total, grand_total, notes, job_id, req.params.id);

    res.json({ success: true, total_tips, wage_total, grand_total });
  } catch (e) {
    internalError(res, e);
  }
});

// Soft delete
app.delete('/api/shifts/:id', authMiddleware, (req, res) => {
  const shift = db.prepare('SELECT * FROM shifts WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!shift) return res.status(404).json({ error: 'Shift not found' });
  if (req.user && shift.user_id !== req.user.id && !req.user.is_admin) {
    return res.status(403).json({ error: 'Not your shift' });
  }
  db.prepare("UPDATE shifts SET deleted_at = datetime('now') WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// Restore
app.post('/api/shifts/:id/restore', authMiddleware, (req, res) => {
  db.prepare('UPDATE shifts SET deleted_at = NULL WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ── Jobs Routes ──────────────────────────────────────────────────────────────

app.get('/api/jobs', authMiddleware, (req, res) => {
  // Return the user's own jobs plus global (user_id IS NULL) jobs
  if (!req.user) return res.json(db.prepare('SELECT * FROM jobs WHERE user_id IS NULL ORDER BY name ASC').all());
  const visibleIds = getVisibleUserIds(req.user.id);
  const placeholders = visibleIds.map(() => '?').join(',');
  res.json(db.prepare(
    `SELECT * FROM jobs WHERE (user_id IS NULL OR user_id IN (${placeholders})) ORDER BY name ASC`
  ).all(...visibleIds));
});

app.post('/api/jobs', authMiddleware, validate(JobSchema), (req, res) => {
  try {
    const { name, default_rate, color, overtime_threshold, overtime_multiplier, tip_payment } = req.validated;
    const userId = req.user ? req.user.id : null;
    const result = db.prepare('INSERT INTO jobs (name, default_rate, color, overtime_threshold, overtime_multiplier, tip_payment, user_id) VALUES (?,?,?,?,?,?,?)')
      .run(name, default_rate, color, overtime_threshold, overtime_multiplier, tip_payment, userId);
    res.json({ id: result.lastInsertRowid, name, default_rate, color, tip_payment, user_id: userId });
  } catch (e) {
    internalError(res, e);
  }
});

app.put('/api/jobs/:id', authMiddleware, validate(JobSchema), (req, res) => {
  try {
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    // Only owner or admin can edit; global jobs (user_id IS NULL) admin-only
    if (job.user_id !== null && job.user_id !== req.user.id && !req.user.is_admin) {
      return res.status(403).json({ error: 'Not your job' });
    }
    if (job.user_id === null && !req.user.is_admin) {
      return res.status(403).json({ error: 'Only admins can edit global jobs' });
    }
    const { name, default_rate, color, overtime_threshold, overtime_multiplier, tip_payment } = req.validated;
    db.prepare('UPDATE jobs SET name=?, default_rate=?, color=?, overtime_threshold=?, overtime_multiplier=?, tip_payment=? WHERE id=?')
      .run(name, default_rate, color, overtime_threshold, overtime_multiplier, tip_payment, req.params.id);
    res.json({ success: true });
  } catch (e) {
    internalError(res, e);
  }
});

app.delete('/api/jobs/:id', authMiddleware, (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.user_id !== null && job.user_id !== req.user.id && !req.user.is_admin) {
    return res.status(403).json({ error: 'Not your job' });
  }
  if (job.user_id === null && !req.user.is_admin) {
    return res.status(403).json({ error: 'Only admins can delete global jobs' });
  }
  db.prepare('UPDATE jobs SET archived = 1 WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ── Settings Routes ───────────────────────────────────────────────────────────

app.get('/api/settings', authMiddleware, (req, res) => {
  const rows = db.prepare("SELECT key, value FROM meta WHERE key IN ('pay_week_start_day','pay_period_type','pay_period_anchor')").all();
  const settings = {};
  rows.forEach(r => { settings[r.key] = r.value; });
  if (!settings.pay_week_start_day) settings.pay_week_start_day = '1';
  if (!settings.pay_period_type) settings.pay_period_type = 'weekly';
  if (!settings.pay_period_anchor) settings.pay_period_anchor = '';
  res.json(settings);
});

app.put('/api/settings', authMiddleware, adminOnly, (req, res) => {
  try {
    const { pay_week_start_day, pay_period_type, pay_period_anchor } = req.body;
    if (pay_week_start_day !== undefined) {
      const day = parseInt(pay_week_start_day, 10);
      if (isNaN(day) || day < 0 || day > 6) return res.status(400).json({ error: 'Invalid day (0-6)' });
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('pay_week_start_day', ?)").run(String(day));
    }
    if (pay_period_type !== undefined) {
      const valid = ['weekly', 'biweekly', 'semimonthly', 'monthly'];
      if (!valid.includes(pay_period_type)) return res.status(400).json({ error: 'Invalid pay period type' });
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('pay_period_type', ?)").run(pay_period_type);
    }
    if (pay_period_anchor !== undefined) {
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('pay_period_anchor', ?)").run(pay_period_anchor);
    }
    res.json({ success: true });
  } catch (e) {
    internalError(res, e);
  }
});

// ── Tax Profile Presets ───────────────────────────────────────────────────────
// Effective federal tax rates are practical budgeting presets (not filing-grade
// tax prep values). Social Security (6.2%) and Medicare (1.45%) are flat
// employee rates. State rates are national-average placeholders.
//
// This app can auto-refresh baseline tax_config rates every six months
// (Jan 1 and Jul 1) from the year table below.

const TAX_BASELINE_BY_YEAR = {
  // Keep 2025 rates for historical compatibility.
  2025: {
    federal: 0.22,
    state: 0.05,
    social_security: 0.062,
    medicare: 0.0145,
    tip_tax: 0.153,
  },
  // Current-year baseline (can be updated each year as needed).
  2026: {
    federal: 0.22,
    state: 0.05,
    social_security: 0.062,
    medicare: 0.0145,
    tip_tax: 0.153,
  },
};

function getApplicableTaxBaseline(year = new Date().getFullYear()) {
  const availableYears = Object.keys(TAX_BASELINE_BY_YEAR).map(Number).sort((a, b) => a - b);
  const fallbackYear = availableYears[availableYears.length - 1];
  const selectedYear = availableYears.filter(y => y <= year).pop() || fallbackYear;
  return { year: selectedYear, rates: TAX_BASELINE_BY_YEAR[selectedYear] };
}

function getNextSemiAnnualDate(fromDate = new Date()) {
  const y = fromDate.getFullYear();
  const jan = new Date(y, 0, 1, 0, 0, 0, 0);
  const jul = new Date(y, 6, 1, 0, 0, 0, 0);
  if (fromDate < jan) return jan;
  if (fromDate < jul) return jul;
  return new Date(y + 1, 0, 1, 0, 0, 0, 0);
}

function applyBaselineTaxRates(rates) {
  const updateRate = db.prepare('UPDATE tax_config SET rate = ? WHERE key = ? AND user_id IS NULL');
  const keyAliases = {
    federal_tax: 'federal',
    state_tax: 'state',
    social_security_tax: 'social_security',
    medicare_tax: 'medicare',
    tip_tax: 'tip_tax',
  };
  const tx = db.transaction(() => {
    for (const [baselineKey, rate] of Object.entries(rates)) {
      const key = keyAliases[baselineKey] || baselineKey;
      updateRate.run(rate, key);
    }
  });
  tx();
}

function autoRefreshTaxRates(force = false) {
  // Admins can disable auto refresh by setting meta key to 0.
  const enabledRow = db.prepare("SELECT value FROM meta WHERE key = 'tax_auto_refresh_enabled'").get();
  const enabled = enabledRow ? enabledRow.value !== '0' : true;
  if (!enabled && !force) return { refreshed: false, reason: 'disabled' };

  const now = new Date();
  const nextRow = db.prepare("SELECT value FROM meta WHERE key = 'tax_auto_refresh_next'").get();
  const nextAt = nextRow ? new Date(nextRow.value) : null;
  const due = force || !nextAt || Number.isNaN(nextAt.getTime()) || now >= nextAt;

  if (!due) {
    return { refreshed: false, reason: 'not_due', next_at: nextAt.toISOString() };
  }

  const baseline = getApplicableTaxBaseline(now.getFullYear());
  applyBaselineTaxRates(baseline.rates);

  const nextRefresh = getNextSemiAnnualDate(new Date(now.getTime() + 24 * 60 * 60 * 1000));
  const setMeta = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
  const tx = db.transaction(() => {
    setMeta.run('tax_auto_refresh_last', now.toISOString());
    setMeta.run('tax_auto_refresh_next', nextRefresh.toISOString());
    setMeta.run('tax_profile_year_active', String(baseline.year));
    // Ensure the switch exists for future admin control.
    setMeta.run('tax_auto_refresh_enabled', enabled ? '1' : '0');
  });
  tx();

  logger.info({ year: baseline.year, nextRefresh: nextRefresh.toISOString() }, 'Tax rates auto-refreshed');
  return { refreshed: true, year: baseline.year, next_at: nextRefresh.toISOString() };
}

const TAX_PROFILES = [
  // ── Single filer, no dependents ─────────────────────────────────────────
  {
    id: 'single_25k',
    filing_status: 'Single',
    income_range: '~$20k–$30k/yr',
    label: 'Single, ~$25k/yr – no dependents',
    approx_annual_income: 25000,
    description: 'Single filer, no dependents. Est. $25,000 annual gross income.',
    // Taxable: $25k − $15k deduction = $10k  →  10% × $10k = $1,000  →  eff. 4%
    rates: { federal: 0.04, state: 0.05, social_security: 0.062, medicare: 0.0145 },
  },
  {
    id: 'single_35k',
    filing_status: 'Single',
    income_range: '~$30k–$42k/yr',
    label: 'Single, ~$35k/yr – no dependents',
    approx_annual_income: 35000,
    description: 'Single filer, no dependents. Est. $35,000 annual gross income.',
    // Taxable: $20k  →  10%×$11,925 + 12%×$8,075 = $2,161  →  eff. 6%
    rates: { federal: 0.06, state: 0.05, social_security: 0.062, medicare: 0.0145 },
  },
  {
    id: 'single_50k',
    filing_status: 'Single',
    income_range: '~$42k–$60k/yr',
    label: 'Single, ~$50k/yr – no dependents',
    approx_annual_income: 50000,
    description: 'Single filer, no dependents. Est. $50,000 annual gross income.',
    // Taxable: $35k  →  10%×$11,925 + 12%×$23,075 = $3,962  →  eff. ~8%
    rates: { federal: 0.08, state: 0.05, social_security: 0.062, medicare: 0.0145 },
  },
  {
    id: 'single_65k',
    filing_status: 'Single',
    income_range: '~$60k–$75k/yr',
    label: 'Single, ~$65k/yr – no dependents',
    approx_annual_income: 65000,
    description: 'Single filer, no dependents. Est. $65,000 annual gross income.',
    // Taxable: $50k  →  ... + 22%×$1,525 = $5,914  →  eff. ~9%
    rates: { federal: 0.09, state: 0.05, social_security: 0.062, medicare: 0.0145 },
  },
  // ── Head of Household (single with dependents) ───────────────────────────
  {
    id: 'hoh_30k',
    filing_status: 'Head of Household',
    income_range: '~$25k–$38k/yr',
    label: 'Head of Household, ~$30k/yr',
    approx_annual_income: 30000,
    description: 'Head of household (single with dependents). Est. $30,000 annual gross income.',
    // Taxable: $30k − $22,500 deduction = $7,500  →  10% × $7,500 = $750  →  eff. ~3%
    rates: { federal: 0.03, state: 0.05, social_security: 0.062, medicare: 0.0145 },
  },
  {
    id: 'hoh_45k',
    filing_status: 'Head of Household',
    income_range: '~$38k–$55k/yr',
    label: 'Head of Household, ~$45k/yr',
    approx_annual_income: 45000,
    description: 'Head of household (single with dependents). Est. $45,000 annual gross income.',
    // Taxable: $22,500  →  10%×$16,550 + 12%×$5,950 = $2,369  →  eff. ~5%
    rates: { federal: 0.05, state: 0.05, social_security: 0.062, medicare: 0.0145 },
  },
  // ── Married Filing Jointly ───────────────────────────────────────────────
  {
    id: 'mfj_50k',
    filing_status: 'Married Filing Jointly',
    income_range: '~$40k–$65k/yr combined',
    label: 'Married Filing Jointly, ~$50k/yr combined',
    approx_annual_income: 50000,
    description: 'Married filing jointly. Est. $50,000 combined annual gross income.',
    // Taxable: $50k − $30k deduction = $20k  →  10% × $20k = $2,000  →  eff. 4%
    rates: { federal: 0.04, state: 0.05, social_security: 0.062, medicare: 0.0145 },
  },
  {
    id: 'mfj_80k',
    filing_status: 'Married Filing Jointly',
    income_range: '~$65k–$100k/yr combined',
    label: 'Married Filing Jointly, ~$80k/yr combined',
    approx_annual_income: 80000,
    description: 'Married filing jointly. Est. $80,000 combined annual gross income.',
    // Taxable: $50k  →  10%×$23,850 + 12%×$26,150 = $5,523  →  eff. ~7%
    rates: { federal: 0.07, state: 0.05, social_security: 0.062, medicare: 0.0145 },
  },
];

// Metadata about the preset rate data
function getTaxProfilesMeta() {
  const activeYearRow = db.prepare("SELECT value FROM meta WHERE key = 'tax_profile_year_active'").get();
  const lastRow = db.prepare("SELECT value FROM meta WHERE key = 'tax_auto_refresh_last'").get();
  const nextRow = db.prepare("SELECT value FROM meta WHERE key = 'tax_auto_refresh_next'").get();

  return {
    tax_year: activeYearRow ? parseInt(activeYearRow.value, 10) : getApplicableTaxBaseline().year,
    last_updated: lastRow ? lastRow.value : null,
    next_auto_refresh: nextRow ? nextRow.value : null,
    refresh_policy: 'Automatically refreshes baseline rates every 6 months (Jan 1 / Jul 1).',
    sources: [
      'App-maintained baseline rate table in server.js (TAX_BASELINE_BY_YEAR)',
      'Update this table when new annual IRS/state guidance is published.',
    ],
    note: 'State rates shown are approximate national averages. Adjust to your state.',
  };
}

// Ensure baseline rates are current on boot.
autoRefreshTaxRates(false);

app.get('/api/tax-profiles', authMiddleware, (req, res) => {
  res.json({ profiles: TAX_PROFILES, meta: getTaxProfilesMeta() });
});

app.post('/api/tax-profiles/refresh', authMiddleware, adminOnly, (req, res) => {
  try {
    const result = autoRefreshTaxRates(true);
    res.json({ success: true, ...result, meta: getTaxProfilesMeta() });
  } catch (e) {
    internalError(res, e);
  }
});

app.post('/api/tax-profiles/apply/:profileId', authMiddleware, (req, res) => {
  const profile = TAX_PROFILES.find(p => p.id === req.params.profileId);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });

  const userId = req.user.id;
  const isAdmin = req.user.is_admin;

  const tx = db.transaction(() => {
    const results = {};
    for (const [key, rate] of Object.entries(profile.rates)) {
      if (isAdmin) {
        // Admin: update global (user_id IS NULL) entries
        const info = db.prepare('UPDATE tax_config SET rate = ? WHERE key = ? AND user_id IS NULL').run(rate, key);
        results[key] = info.changes > 0 ? 'updated' : 'not_found';
      } else {
        // User: upsert their own per-user entry for each key
        const existing = db.prepare('SELECT * FROM tax_config WHERE key = ? AND user_id = ?').get(key, userId);
        if (existing) {
          db.prepare('UPDATE tax_config SET rate = ? WHERE id = ?').run(rate, existing.id);
          results[key] = 'updated';
        } else {
          const global = db.prepare('SELECT * FROM tax_config WHERE key = ? AND user_id IS NULL').get(key);
          const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM tax_config WHERE user_id = ?').get(userId).m || 0;
          db.prepare('INSERT INTO tax_config (key, label, rate, flat_amount, enabled, sort_order, user_id) VALUES (?,?,?,?,?,?,?)')
            .run(key, global ? global.label : key, rate, global ? global.flat_amount : 0, 1, maxOrder + 1, userId);
          results[key] = 'created';
        }
      }
    }
    return results;
  });
  const results = tx();
  res.json({ success: true, profile: profile.id, applied: results });
});

// ── Tax Config Routes ─────────────────────────────────────────────────────────

app.get('/api/tax-config', authMiddleware, (req, res) => {
  // Return user-specific entries if they exist, otherwise fall back to global defaults
  const userId = req.user ? req.user.id : null;
  if (!userId || req.user.is_admin) {
    // Admin sees global config
    return res.json(db.prepare('SELECT * FROM tax_config WHERE user_id IS NULL ORDER BY sort_order ASC').all());
  }
  // For regular users: merge global defaults with user overrides
  const globalRows = db.prepare('SELECT * FROM tax_config WHERE user_id IS NULL ORDER BY sort_order ASC').all();
  const userRows = db.prepare('SELECT * FROM tax_config WHERE user_id = ? ORDER BY sort_order ASC').all(userId);
  const userMap = {};
  userRows.forEach(r => { userMap[r.key] = r; });
  // Override global with user-specific entries; append user-only entries
  const globalKeys = new Set(globalRows.map(r => r.key));
  const merged = globalRows.map(r => userMap[r.key] || r);
  const userOnly = userRows.filter(r => !globalKeys.has(r.key));
  res.json([...merged, ...userOnly]);
});

app.put('/api/tax-config/:id', authMiddleware, (req, res) => {
  try {
    const { label, rate, flat_amount, enabled } = req.body;
    const id = parseInt(req.params.id, 10);
    if (rate !== undefined && (isNaN(rate) || rate < 0 || rate > 1)) return res.status(400).json({ error: 'Rate must be 0-1' });
    if (flat_amount !== undefined && (isNaN(flat_amount) || flat_amount < 0)) return res.status(400).json({ error: 'Flat amount must be >= 0' });
    const row = db.prepare('SELECT * FROM tax_config WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Tax config not found' });
    // Only admin can edit global (user_id IS NULL) entries; users can edit their own
    if (row.user_id === null && !req.user.is_admin) {
      return res.status(403).json({ error: 'Only admins can edit global tax rates' });
    }
    if (row.user_id !== null && row.user_id !== req.user.id && !req.user.is_admin) {
      return res.status(403).json({ error: 'Not your tax rate' });
    }
    db.prepare('UPDATE tax_config SET label=?, rate=?, flat_amount=?, enabled=? WHERE id=?')
      .run(label ?? row.label, rate ?? row.rate, flat_amount ?? row.flat_amount, enabled !== undefined ? (enabled ? 1 : 0) : row.enabled, id);
    res.json({ success: true });
  } catch (e) { internalError(res, e); }
});

app.post('/api/tax-config', authMiddleware, (req, res) => {
  try {
    const { key, label, rate, flat_amount } = req.body;
    if (!key || !label) return res.status(400).json({ error: 'Key and label required' });
    const userId = req.user.is_admin ? null : req.user.id;
    const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM tax_config WHERE user_id IS ?').get(userId).m || 0;
    const result = db.prepare('INSERT INTO tax_config (key, label, rate, flat_amount, enabled, sort_order, user_id) VALUES (?,?,?,?,1,?,?)')
      .run(key, label, rate || 0, flat_amount || 0, maxOrder + 1, userId);
    res.json({ id: result.lastInsertRowid });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Key already exists' });
    internalError(res, e);
  }
});

app.delete('/api/tax-config/:id', authMiddleware, (req, res) => {
  const row = db.prepare('SELECT * FROM tax_config WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Tax config not found' });
  if (row.user_id === null && !req.user.is_admin) {
    return res.status(403).json({ error: 'Only admins can delete global tax rates' });
  }
  if (row.user_id !== null && row.user_id !== req.user.id && !req.user.is_admin) {
    return res.status(403).json({ error: 'Not your tax rate' });
  }
  db.prepare('DELETE FROM tax_config WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ── Paycheck History Routes ───────────────────────────────────────────────────

app.get('/api/paychecks', authMiddleware, (req, res) => {
  try {
    const rows = db.prepare(
      'SELECT * FROM paychecks WHERE user_id = ? ORDER BY pay_date DESC LIMIT 50'
    ).all(req.user.id);
    res.json(rows);
  } catch (e) { logger.error(e); res.status(500).json({ error: e.message }); }
});

app.post('/api/paychecks', authMiddleware, validate(PaycheckSchema), (req, res) => {
  try {
    const d = req.validated;
    const result = db.prepare(
      `INSERT INTO paychecks (user_id, pay_date, gross_pay, federal_withholding, state_withholding, social_security, medicare, net_pay, notes)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(req.user.id, d.pay_date, d.gross_pay, d.federal_withholding, d.state_withholding, d.social_security, d.medicare, d.net_pay, d.notes || '');
    res.status(201).json({ id: result.lastInsertRowid });
  } catch (e) { logger.error(e); res.status(500).json({ error: e.message }); }
});

app.delete('/api/paychecks/:id', authMiddleware, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const row = db.prepare('SELECT * FROM paychecks WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Paycheck not found' });
    if (row.user_id !== req.user.id && !req.user.is_admin) return res.status(403).json({ error: 'Forbidden' });
    db.prepare('DELETE FROM paychecks WHERE id = ?').run(id);
    res.json({ success: true });
  } catch (e) { logger.error(e); res.status(500).json({ error: e.message }); }
});

// Apply the effective tax rates from a paycheck entry to the tax_config table
app.post('/api/paychecks/:id/apply-rates', authMiddleware, adminOnly, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const row = db.prepare('SELECT * FROM paychecks WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Paycheck not found' });
    if (row.gross_pay <= 0) return res.status(400).json({ error: 'Gross pay must be > 0 to calculate rates' });

    const rates = {
      federal: Math.round(row.federal_withholding / row.gross_pay * 10000) / 10000,
      state: Math.round(row.state_withholding / row.gross_pay * 10000) / 10000,
      social_security: Math.round(row.social_security / row.gross_pay * 10000) / 10000,
      medicare: Math.round(row.medicare / row.gross_pay * 10000) / 10000,
    };

    const update = db.prepare('UPDATE tax_config SET rate = ? WHERE key = ? AND user_id IS NULL');
    const tx = db.transaction(() => {
      const applied = {};
      for (const [key, rate] of Object.entries(rates)) {
        const info = update.run(rate, key);
        applied[key] = info.changes > 0 ? rate : null;
      }
      return applied;
    });
    const applied = tx();
    res.json({ success: true, applied });
  } catch (e) { logger.error(e); res.status(500).json({ error: e.message }); }
});

// ── Paycheck Estimate ────────────────────────────────────────────────────────

function getPayPeriodBounds() {
  const now = new Date();
  const meta = {};
  db.prepare("SELECT key, value FROM meta WHERE key IN ('pay_period_type','pay_period_anchor','pay_week_start_day')").all()
    .forEach(r => { meta[r.key] = r.value; });

  const periodType = meta.pay_period_type || 'weekly';
  const startDay = parseInt(meta.pay_week_start_day || '1', 10);
  const anchor = meta.pay_period_anchor || '';

  let periodStart, periodEnd, prevStart, prevEnd, periodLabel;

  if (periodType === 'weekly') {
    const daysSince = (now.getDay() - startDay + 7) % 7;
    periodStart = new Date(now); periodStart.setDate(now.getDate() - daysSince); periodStart.setHours(0,0,0,0);
    periodEnd = new Date(periodStart); periodEnd.setDate(periodEnd.getDate() + 6);
    prevStart = new Date(periodStart); prevStart.setDate(prevStart.getDate() - 7);
    prevEnd = new Date(periodStart); prevEnd.setDate(prevEnd.getDate() - 1);
    periodLabel = 'Weekly';
  } else if (periodType === 'biweekly') {
    let anchorDate;
    if (anchor && /^\d{4}-\d{2}-\d{2}$/.test(anchor)) {
      anchorDate = new Date(anchor + 'T00:00:00');
    } else {
      // Default: use the most recent start-day as anchor
      const daysSince = (now.getDay() - startDay + 7) % 7;
      anchorDate = new Date(now); anchorDate.setDate(now.getDate() - daysSince); anchorDate.setHours(0,0,0,0);
    }
    const diffDays = Math.floor((now - anchorDate) / 86400000);
    const cycleDay = ((diffDays % 14) + 14) % 14;
    periodStart = new Date(now); periodStart.setDate(now.getDate() - cycleDay); periodStart.setHours(0,0,0,0);
    periodEnd = new Date(periodStart); periodEnd.setDate(periodEnd.getDate() + 13);
    prevStart = new Date(periodStart); prevStart.setDate(prevStart.getDate() - 14);
    prevEnd = new Date(periodStart); prevEnd.setDate(prevEnd.getDate() - 1);
    periodLabel = 'Bi-Weekly';
  } else if (periodType === 'semimonthly') {
    const day = now.getDate();
    if (day <= 15) {
      periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
      periodEnd = new Date(now.getFullYear(), now.getMonth(), 15);
      const pm = new Date(now.getFullYear(), now.getMonth(), 0);
      prevStart = new Date(pm.getFullYear(), pm.getMonth(), 16);
      prevEnd = pm;
    } else {
      periodStart = new Date(now.getFullYear(), now.getMonth(), 16);
      periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      prevStart = new Date(now.getFullYear(), now.getMonth(), 1);
      prevEnd = new Date(now.getFullYear(), now.getMonth(), 15);
    }
    periodLabel = 'Semi-Monthly';
  } else {
    // monthly
    periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
    periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    prevEnd = new Date(now.getFullYear(), now.getMonth(), 0);
    periodLabel = 'Monthly';
  }

  const totalDays = Math.round((periodEnd - periodStart) / 86400000) + 1;
  const elapsed = Math.round((now - periodStart) / 86400000) + 1;
  const remaining = Math.max(0, totalDays - elapsed);

  return { periodStart, periodEnd, prevStart, prevEnd, periodLabel, totalDays, elapsed, remaining };
}

app.get('/api/paycheck-estimate', authMiddleware, (req, res) => {
  try {
    const pp = getPayPeriodBounds();
    const from = fmt(pp.periodStart), to = fmt(pp.periodEnd);
    const prevFrom = fmt(pp.prevStart), prevTo = fmt(pp.prevEnd);

    const filterUser = resolveUserFilter(req);
    let sumBase = 'FROM shifts WHERE date >= ? AND date <= ? AND deleted_at IS NULL';
    const userWhere = filterUser !== null
      ? ` AND user_id IN (${filterUser.map(() => '?').join(',')})`
      : '';
    const userParam = filterUser !== null ? filterUser : [];

    // Sum all shifts in the period
    const sumQuery = `SELECT COALESCE(SUM(wage_total),0) as wages, COALESCE(SUM(total_tips),0) as tips,
      COALESCE(SUM(grand_total),0) as gross, COALESCE(SUM(hours_worked),0) as hours, COUNT(*) as shifts
      ${sumBase}${userWhere}`;

    const current = db.prepare(sumQuery).get(from, to, ...userParam);
    const previous = db.prepare(sumQuery).get(prevFrom, prevTo, ...userParam);

    // Split tips by payment method (cash vs paycheck) based on each shift's job setting
    const tipSplitWhere = filterUser !== null
      ? ` AND s.user_id IN (${filterUser.map(() => '?').join(',')})`
      : '';
    const tipSplitQuery = `SELECT
      COALESCE(SUM(CASE WHEN COALESCE(j.tip_payment,'cash')='cash' THEN s.total_tips ELSE 0 END),0) as cash_tips,
      COALESCE(SUM(CASE WHEN COALESCE(j.tip_payment,'cash')='paycheck' THEN s.total_tips ELSE 0 END),0) as paycheck_tips
      FROM shifts s LEFT JOIN jobs j ON s.job_id = j.id
      WHERE s.date >= ? AND s.date <= ? AND s.deleted_at IS NULL${tipSplitWhere}`;

    const tipSplit = db.prepare(tipSplitQuery).get(from, to, ...userParam);

    // Paycheck gross = wages + paycheck tips (cash tips already received nightly)
    const paycheckGross = current.wages + tipSplit.paycheck_tips;

    // Get tax config — use user-specific entries if available, fall back to global
    let taxes;
    if (req.user && !req.user.is_admin) {
      const userId = req.user.id;
      const globalRows = db.prepare('SELECT * FROM tax_config WHERE user_id IS NULL AND enabled = 1 ORDER BY sort_order ASC').all();
      const userRows = db.prepare('SELECT * FROM tax_config WHERE user_id = ? AND enabled = 1 ORDER BY sort_order ASC').all(userId);
      const userMap = {};
      userRows.forEach(r => { userMap[r.key] = r; });
      const globalKeys = new Set(globalRows.map(r => r.key));
      const merged = globalRows.map(r => userMap[r.key] || r);
      const userOnly = userRows.filter(r => !globalKeys.has(r.key));
      taxes = [...merged, ...userOnly];
    } else {
      taxes = db.prepare('SELECT * FROM tax_config WHERE user_id IS NULL AND enabled = 1 ORDER BY sort_order ASC').all();
    }

    // Calculate itemized taxes — taxes apply to ALL income (including cash tips)
    let totalTax = 0;
    const taxBreakdown = taxes.map(t => {
      let taxable = t.key === 'tip_tax' ? current.tips : current.wages;
      if (['federal', 'state', 'social_security', 'medicare'].includes(t.key)) {
        taxable = current.gross; // wages + all tips
      }
      const amount = Math.round((taxable * t.rate + t.flat_amount) * 100) / 100;
      totalTax += amount;
      return { key: t.key, label: t.label, rate: t.rate, flat_amount: t.flat_amount, amount };
    });

    // Net paycheck = paycheck gross minus all taxes (taxes cover cash tips too)
    const netPay = Math.round((paycheckGross - totalTax) * 100) / 100;

    // Projection: extrapolate if mid-period
    let projectedGross = paycheckGross, projectedNet = netPay;
    let projectedCashTips = tipSplit.cash_tips;
    if (pp.elapsed < pp.totalDays && pp.elapsed > 0) {
      const pace = paycheckGross / pp.elapsed;
      projectedGross = Math.round(pace * pp.totalDays * 100) / 100;
      projectedCashTips = Math.round(tipSplit.cash_tips / pp.elapsed * pp.totalDays * 100) / 100;
      const projectedTotalGross = projectedGross + projectedCashTips;
      const projTax = taxes.reduce((sum, t) => {
        const allTips = current.tips / pp.elapsed * pp.totalDays;
        const base = t.key === 'tip_tax' ? allTips : projectedTotalGross;
        const taxBase = ['federal','state','social_security','medicare'].includes(t.key) ? projectedTotalGross : base;
        return sum + taxBase * t.rate + t.flat_amount;
      }, 0);
      projectedNet = Math.round((projectedGross - projTax) * 100) / 100;
    }

    res.json({
      period: {
        type: pp.periodLabel,
        start: from,
        end: to,
        total_days: pp.totalDays,
        elapsed_days: pp.elapsed,
        remaining_days: pp.remaining,
      },
      current: {
        wages: current.wages,
        tips: current.tips,
        cash_tips: tipSplit.cash_tips,
        paycheck_tips: tipSplit.paycheck_tips,
        gross: current.gross,
        paycheck_gross: paycheckGross,
        hours: current.hours,
        shifts: current.shifts,
      },
      previous: {
        gross: previous.gross,
        hours: previous.hours,
        shifts: previous.shifts,
      },
      taxes: taxBreakdown,
      total_tax: Math.round(totalTax * 100) / 100,
      net_pay: netPay,
      projected_gross: projectedGross,
      projected_net: projectedNet,
      projected_cash_tips: projectedCashTips,
    });
  } catch (e) {
    internalError(res, e);
  }
});

// ── Templates Routes ─────────────────────────────────────────────────────────

app.get('/api/templates', authMiddleware, (req, res) => {
  if (!req.user) return res.json([]);
  const visibleIds = getVisibleUserIds(req.user.id);
  const placeholders = visibleIds.map(() => '?').join(',');
  res.json(db.prepare(
    `SELECT t.*, j.name as job_name FROM templates t LEFT JOIN jobs j ON t.job_id = j.id
     WHERE t.user_id IS NULL OR t.user_id IN (${placeholders}) ORDER BY t.name ASC`
  ).all(...visibleIds));
});

app.post('/api/templates', authMiddleware, validate(TemplateSchema), (req, res) => {
  try {
    const { name, job_id, hourly_rate, hours_worked, tip_mode, tip_input, notes } = req.validated;
    const userId = req.user ? req.user.id : null;
    const result = db.prepare('INSERT INTO templates (name, job_id, hourly_rate, hours_worked, tip_mode, tip_input, notes, user_id) VALUES (?,?,?,?,?,?,?,?)')
      .run(name, job_id, hourly_rate, hours_worked, tip_mode, tip_input, notes, userId);
    res.json({ id: result.lastInsertRowid });
  } catch (e) {
    internalError(res, e);
  }
});

app.delete('/api/templates/:id', authMiddleware, (req, res) => {
  const tpl = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id);
  if (!tpl) return res.status(404).json({ error: 'Template not found' });
  if (tpl.user_id !== null && tpl.user_id !== req.user.id && !req.user.is_admin) {
    return res.status(403).json({ error: 'Not your template' });
  }
  db.prepare('DELETE FROM templates WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ── Goals Routes ─────────────────────────────────────────────────────────────

app.get('/api/goals', authMiddleware, (req, res) => {
  if (!req.user) return res.json([]);
  // Users see their own goals + global (user_id IS NULL) goals
  const userId = req.user.id;
  res.json(db.prepare(
    'SELECT * FROM goals WHERE user_id IS NULL OR user_id = ? ORDER BY created_at DESC'
  ).all(userId));
});

app.post('/api/goals', authMiddleware, validate(GoalSchema), (req, res) => {
  try {
    const { period, target_amount, active } = req.validated;
    const userId = req.user ? req.user.id : null;
    // Deactivate other goals of same period for this user
    if (active) db.prepare('UPDATE goals SET active = 0 WHERE period = ? AND user_id IS ?').run(period, userId);
    const result = db.prepare('INSERT INTO goals (period, target_amount, active, user_id) VALUES (?,?,?,?)').run(period, target_amount, active ? 1 : 0, userId);
    res.json({ id: result.lastInsertRowid });
  } catch (e) {
    internalError(res, e);
  }
});

app.put('/api/goals/:id', authMiddleware, validate(GoalSchema), (req, res) => {
  try {
    const goal = db.prepare('SELECT * FROM goals WHERE id = ?').get(req.params.id);
    if (!goal) return res.status(404).json({ error: 'Goal not found' });
    if (goal.user_id !== null && goal.user_id !== req.user.id && !req.user.is_admin) {
      return res.status(403).json({ error: 'Not your goal' });
    }
    const { period, target_amount, active } = req.validated;
    const userId = goal.user_id;
    if (active) db.prepare('UPDATE goals SET active = 0 WHERE period = ? AND id != ? AND user_id IS ?').run(period, req.params.id, userId);
    db.prepare('UPDATE goals SET period=?, target_amount=?, active=? WHERE id=?').run(period, target_amount, active ? 1 : 0, req.params.id);
    res.json({ success: true });
  } catch (e) {
    internalError(res, e);
  }
});

app.delete('/api/goals/:id', authMiddleware, (req, res) => {
  const goal = db.prepare('SELECT * FROM goals WHERE id = ?').get(req.params.id);
  if (!goal) return res.status(404).json({ error: 'Goal not found' });
  if (goal.user_id !== null && goal.user_id !== req.user.id && !req.user.is_admin) {
    return res.status(403).json({ error: 'Not your goal' });
  }
  db.prepare('DELETE FROM goals WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.get('/api/goals/history', authMiddleware, (req, res) => {
  try {
    const userId = req.user ? req.user.id : null;
    const activeGoals = userId
      ? db.prepare('SELECT * FROM goals WHERE active = 1 AND (user_id IS NULL OR user_id = ?)').all(userId)
      : db.prepare('SELECT * FROM goals WHERE active = 1 AND user_id IS NULL').all();
    if (!activeGoals.length) return res.json([]);

    const filterUser = resolveUserFilter(req);
    const userWhere = filterUser !== null
      ? ` AND user_id IN (${filterUser.map(() => '?').join(',')})`
      : '';
    const filterParams = filterUser !== null ? filterUser : [];

    const shiftWhere = `deleted_at IS NULL${userWhere}`;

    const startDay = getPayWeekStartDay();
    const now = new Date();
    const results = [];

    const firstShiftRow = db.prepare(`SELECT MIN(date) as min_date FROM shifts WHERE ${shiftWhere}`).get(...filterParams);
    const firstShiftDate = firstShiftRow && firstShiftRow.min_date
      ? new Date(firstShiftRow.min_date + 'T00:00:00')
      : null;

    const weeklyEarnedStmt = db.prepare(
      `SELECT COALESCE(SUM(grand_total),0) as earned FROM shifts WHERE date >= ? AND date <= ? AND ${shiftWhere}`
    );

    for (const goal of activeGoals) {
      const periods = [];

      if (goal.period === 'weekly') {
        const daysSinceStart = (now.getDay() - startDay + 7) % 7;
        const thisWeekStart = new Date(now);
        thisWeekStart.setDate(now.getDate() - daysSinceStart);
        thisWeekStart.setHours(0, 0, 0, 0);

        let oldestWeekStart = new Date(thisWeekStart);
        if (firstShiftDate) {
          oldestWeekStart = new Date(firstShiftDate);
          const offset = (oldestWeekStart.getDay() - startDay + 7) % 7;
          oldestWeekStart.setDate(oldestWeekStart.getDate() - offset);
          oldestWeekStart.setHours(0, 0, 0, 0);
        }

        for (let weekStart = new Date(thisWeekStart); weekStart >= oldestWeekStart; weekStart.setDate(weekStart.getDate() - 7)) {
          const weekEnd = new Date(weekStart);
          weekEnd.setDate(weekEnd.getDate() + 6);
          const from = fmt(weekStart), to = fmt(weekEnd);
          const data = weeklyEarnedStmt.get(from, to, ...filterParams);
          periods.push({ from, to, earned: data.earned, achieved: data.earned >= goal.target_amount });
        }
      } else if (goal.period === 'monthly') {
        const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        thisMonthStart.setHours(0, 0, 0, 0);

        let oldestMonthStart = new Date(thisMonthStart);
        if (firstShiftDate) {
          oldestMonthStart = new Date(firstShiftDate.getFullYear(), firstShiftDate.getMonth(), 1);
          oldestMonthStart.setHours(0, 0, 0, 0);
        }

        const monthlyEarnedStmt = db.prepare(
          `SELECT COALESCE(SUM(grand_total),0) as earned FROM shifts WHERE date >= ? AND date <= ? AND ${shiftWhere}`
        );

        for (let monthStart = new Date(thisMonthStart); monthStart >= oldestMonthStart; monthStart.setMonth(monthStart.getMonth() - 1)) {
          const monthEnd = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0);
          const from = fmt(monthStart), to = fmt(monthEnd);
          const data = monthlyEarnedStmt.get(from, to, ...filterParams);
          periods.push({ from, to, earned: data.earned, achieved: data.earned >= goal.target_amount });
        }
      }

      results.push({ goal_id: goal.id, period: goal.period, target_amount: goal.target_amount, history: periods });
    }

    res.json(results);
  } catch (e) {
    internalError(res, e);
  }
});

// ── Summary ──────────────────────────────────────────────────────────────────

app.get('/api/summary', authMiddleware, (req, res) => {
  const { now, weekStart, lastWeekStart, lastWeekEnd, biweekStart, monthStart, lastMonthStart, lastMonthEnd, ytdStart } = getPeriodBounds();
  const filterUser = resolveUserFilter(req);

  const sum = (from, to) => {
    let q = `SELECT COUNT(*) as shifts, COALESCE(SUM(hours_worked),0) as total_hours,
      COALESCE(SUM(wage_total),0) as total_wages, COALESCE(SUM(total_tips),0) as total_tips,
      COALESCE(SUM(grand_total),0) as grand_total, COALESCE(AVG(grand_total),0) as avg_shift,
      COALESCE(SUM(total_tips)/NULLIF(SUM(hours_worked),0),0) as avg_tips_per_hour
      FROM shifts WHERE date >= ? AND date <= ? AND deleted_at IS NULL`;
    const params = [from, to];
    q = appendUserFilter(q, params, filterUser);
    return db.prepare(q).get(...params);
  };

  res.json({
    this_week: sum(fmt(weekStart), fmt(now)),
    last_week: sum(fmt(lastWeekStart), fmt(lastWeekEnd)),
    biweekly: sum(fmt(biweekStart), fmt(now)),
    this_month: sum(fmt(monthStart), fmt(now)),
    last_month: sum(fmt(lastMonthStart), fmt(lastMonthEnd)),
    ytd: sum(fmt(ytdStart), fmt(now)),
    all_time: sum('2000-01-01', fmt(now)),
  });
});

// ── Trends ───────────────────────────────────────────────────────────────────

app.get('/api/trends', authMiddleware, (req, res) => {
  const { period } = req.query;
  const now = new Date();
  let groupFmt, dateFilter;

  if (period === 'week') {
    const s = new Date(now); s.setDate(now.getDate() - 83);
    dateFilter = fmt(s);
    groupFmt = "strftime('%Y-W%W', date)";
  } else if (period === 'year') {
    const s = new Date(now); s.setFullYear(now.getFullYear() - 2);
    dateFilter = fmt(s);
    groupFmt = "strftime('%Y-%m', date)";
  } else {
    const s = new Date(now.getFullYear(), now.getMonth() - 11, 1);
    dateFilter = fmt(s);
    groupFmt = "strftime('%Y-%m', date)";
  }

  const filterUser = resolveUserFilter(req);
  let trendWhere = 'date >= ? AND deleted_at IS NULL';
  const trendParams = [dateFilter];
  trendWhere = appendUserFilter(trendWhere, trendParams, filterUser);

  const data = db.prepare(`
    SELECT ${groupFmt} as period, COUNT(*) as shifts, SUM(hours_worked) as total_hours,
      SUM(wage_total) as total_wages, SUM(total_tips) as total_tips, SUM(grand_total) as grand_total,
      SUM(total_tips)/NULLIF(SUM(hours_worked),0) as tips_per_hour,
      SUM(grand_total)/NULLIF(SUM(hours_worked),0) as effective_rate
    FROM shifts WHERE ${trendWhere}
    GROUP BY period ORDER BY period ASC
  `).all(...trendParams);

  res.json(data);
});

// ── Analytics ────────────────────────────────────────────────────────────────

app.get('/api/analytics/effective-rate', authMiddleware, (req, res) => {
  const filterUser = resolveUserFilter(req);
  let where = 'deleted_at IS NULL AND hours_worked > 0';
  const params = [];
  where = appendUserFilter(where, params, filterUser);
  const data = db.prepare(`
    SELECT CAST(strftime('%w', date) AS INTEGER) as dow,
      AVG((wage_total + total_tips) / NULLIF(hours_worked, 0)) as avg_effective_rate,
      COUNT(*) as shift_count
    FROM shifts WHERE ${where}
    GROUP BY dow ORDER BY dow
  `).all(...params);
  res.json(data);
});

app.get('/api/analytics/extremes', authMiddleware, (req, res) => {
  const count = parseInt(req.query.count, 10) || 5;
  const filterUser = resolveUserFilter(req);
  let where = 's.deleted_at IS NULL';
  const userParams = [];
  where = appendUserFilter(where, userParams, filterUser, 's.user_id');
  const baseQuery = `SELECT s.*, u.display_name as user_name, j.name as job_name FROM shifts s LEFT JOIN users u ON s.user_id=u.id LEFT JOIN jobs j ON s.job_id=j.id WHERE ${where}`;
  const best = db.prepare(baseQuery + ' ORDER BY s.grand_total DESC LIMIT ?').all(...userParams, count);
  const worst = db.prepare(baseQuery + ' ORDER BY s.grand_total ASC LIMIT ?').all(...userParams, count);
  res.json({ best, worst });
});

app.get('/api/analytics/tip-ratio', authMiddleware, (req, res) => {
  const filterUser = resolveUserFilter(req);
  let where = 'deleted_at IS NULL';
  const params = [];
  where = appendUserFilter(where, params, filterUser);
  const data = db.prepare(`
    SELECT strftime('%Y-%m', date) as period,
      SUM(total_tips) as total_tips, SUM(grand_total) as grand_total,
      CASE WHEN SUM(grand_total) > 0 THEN ROUND(SUM(total_tips) * 100.0 / SUM(grand_total), 1) ELSE 0 END as tip_pct
    FROM shifts WHERE ${where}
    GROUP BY period ORDER BY period ASC
  `).all(...params);
  res.json(data);
});

// ── Overtime ─────────────────────────────────────────────────────────────────

app.get('/api/overtime', authMiddleware, (req, res) => {
  const { now, weekStart } = getPeriodBounds();
  const defaultThreshold = parseFloat(process.env.OT_THRESHOLD) || 40;
  const defaultMultiplier = parseFloat(process.env.OT_MULTIPLIER) || 1.5;
  const filterUser = resolveUserFilter(req);

  let otWhere = 's.date >= ? AND s.date <= ? AND s.deleted_at IS NULL';
  const otParams = [fmt(weekStart), fmt(now)];
  otWhere = appendUserFilter(otWhere, otParams, filterUser, 's.user_id');

  const weekShifts = db.prepare(`
    SELECT s.*, j.name as job_name, j.overtime_threshold, j.overtime_multiplier
    FROM shifts s LEFT JOIN jobs j ON s.job_id = j.id
    WHERE ${otWhere}
    ORDER BY s.date ASC
  `).all(...otParams);

  let totalHours = 0;
  weekShifts.forEach(s => { totalHours += s.hours_worked; });

  const threshold = weekShifts[0]?.overtime_threshold || defaultThreshold;
  const multiplier = weekShifts[0]?.overtime_multiplier || defaultMultiplier;
  const overtimeHours = Math.max(0, totalHours - threshold);
  const regularHours = totalHours - overtimeHours;

  res.json({
    total_hours: totalHours,
    threshold,
    multiplier,
    regular_hours: regularHours,
    overtime_hours: overtimeHours,
    is_overtime: overtimeHours > 0,
  });
});

// ── Tax Estimate ─────────────────────────────────────────────────────────────

app.get('/api/tax-estimate', authMiddleware, (req, res) => {
  const wageRate = parseFloat(process.env.TAX_RATE_WAGES) || 0.22;
  const tipRate = parseFloat(process.env.TAX_RATE_TIPS) || 0.153;
  const { period } = req.query;
  const bounds = getPeriodBounds();
  let from, to;

  if (period === 'month') { from = fmt(bounds.monthStart); to = fmt(bounds.now); }
  else { from = fmt(bounds.ytdStart); to = fmt(bounds.now); }

  const filterUser = resolveUserFilter(req);
  let taxWhere = 'date >= ? AND date <= ? AND deleted_at IS NULL';
  const taxParams = [from, to];
  taxWhere = appendUserFilter(taxWhere, taxParams, filterUser);

  const data = db.prepare(`
    SELECT COALESCE(SUM(wage_total),0) as wages, COALESCE(SUM(total_tips),0) as tips, COALESCE(SUM(grand_total),0) as total
    FROM shifts WHERE ${taxWhere}
  `).get(...taxParams);

  res.json({
    period: period || 'ytd',
    wages: data.wages,
    tips: data.tips,
    total: data.total,
    est_wage_tax: Math.round(data.wages * wageRate * 100) / 100,
    est_tip_tax: Math.round(data.tips * tipRate * 100) / 100,
    est_total_tax: Math.round((data.wages * wageRate + data.tips * tipRate) * 100) / 100,
    wage_rate: wageRate,
    tip_rate: tipRate,
  });
});

// ── CSV Export ────────────────────────────────────────────────────────────────

app.get('/api/export/csv', authMiddleware, (req, res) => {
  const { from, to } = req.query;
  const filterUser = resolveUserFilter(req);
  let query = 'SELECT s.*, j.name as job_name, u.display_name as user_name FROM shifts s LEFT JOIN jobs j ON s.job_id=j.id LEFT JOIN users u ON s.user_id=u.id WHERE s.deleted_at IS NULL';
  const params = [];
  if (from && to) { query += ' AND s.date >= ? AND s.date <= ?'; params.push(from, to); }
  query = appendUserFilter(query, params, filterUser, 's.user_id');
  query += ' ORDER BY s.date ASC';

  const shifts = db.prepare(query).all(...params);
  const header = 'Date,Job,User,Hours,Rate,Wages,Tips/Hr,Total Tips,Grand Total,Tip Mode,Notes\n';
  const rows = shifts.map(s => {
    const tipsPerHour = s.hours_worked > 0 ? (s.total_tips / s.hours_worked).toFixed(2) : '0.00';
    return [
      s.date, `"${(s.job_name || '').replace(/"/g, '""')}"`, `"${(s.user_name || '').replace(/"/g, '""')}"`,
      s.hours_worked.toFixed(2), s.hourly_rate.toFixed(2), s.wage_total.toFixed(2),
      tipsPerHour, s.total_tips.toFixed(2), s.grand_total.toFixed(2),
      s.tip_mode, `"${(s.notes || '').replace(/"/g, '""')}"`
    ].join(',');
  }).join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="shiftledger-${from || 'all'}-${to || 'present'}.csv"`);
  res.send(header + rows);
});

// ── CSV Import ───────────────────────────────────────────────────────────────

app.post('/api/import/csv', authMiddleware, express.text({ type: '*/*', limit: '5mb' }), (req, res) => {
  try {
    const lines = req.body.split('\n').filter(l => l.trim());
    if (lines.length < 2) return res.status(400).json({ error: 'Empty CSV' });

    const userId = req.user ? req.user.id : null;
    let imported = 0, errors = 0;

    const insert = db.prepare(`
      INSERT INTO shifts (date, hourly_rate, hours_worked, tip_mode, tip_input, total_tips, wage_total, grand_total, notes, user_id)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `);

    const tx = db.transaction(() => {
      for (let i = 1; i < lines.length; i++) {
        try {
          const cols = lines[i].match(/(".*?"|[^,]+)/g) || [];
          const clean = (s) => (s || '').replace(/^"|"$/g, '').replace(/""/g, '"').trim();
          const date = clean(cols[0]);
          const hours = parseFloat(clean(cols[3])) || 0;
          const rate = parseFloat(clean(cols[4])) || 0;
          const tipMode = clean(cols[9]) || 'total';
          const totalTips = parseFloat(clean(cols[7])) || 0;
          const tipInput = tipMode === 'per_hour' && hours > 0 ? totalTips / hours : totalTips;
          const wages = rate * hours;
          const grand = wages + totalTips;
          const notes = clean(cols[10]);

          if (!date.match(/^\d{4}-\d{2}-\d{2}$/)) { errors++; continue; }
          insert.run(date, rate, hours, tipMode, tipInput, totalTips, wages, grand, notes, userId);
          imported++;
        } catch { errors++; }
      }
    });
    tx();

    res.json({ imported, errors });
  } catch (e) {
    internalError(res, e);
  }
});

// ── PDF Export ────────────────────────────────────────────────────────────────

app.get('/api/export/pdf', authMiddleware, (req, res) => {
  const { from, to, label } = req.query;
  const filterUser = resolveUserFilter(req);
  let query = 'SELECT s.*, j.name as job_name, u.display_name as user_name FROM shifts s LEFT JOIN jobs j ON s.job_id=j.id LEFT JOIN users u ON s.user_id=u.id WHERE s.deleted_at IS NULL';
  const params = [];
  if (from && to) { query += ' AND s.date >= ? AND s.date <= ?'; params.push(from, to); }
  query = appendUserFilter(query, params, filterUser, 's.user_id');
  query += ' ORDER BY s.date ASC';

  const shifts = db.prepare(query).all(...params);
  const totals = shifts.reduce((a, s) => ({
    hours: a.hours + s.hours_worked,
    wages: a.wages + s.wage_total,
    tips: a.tips + s.total_tips,
    grand: a.grand + s.grand_total,
  }), { hours: 0, wages: 0, tips: 0, grand: 0 });

  const doc = new PDFDocument({ margin: 50, size: 'LETTER' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="shiftledger-${from || 'all'}-${to || 'present'}.pdf"`);
  doc.pipe(res);

  // Header
  doc.rect(0, 0, 612, 80).fill('#0d0d0d');
  doc.fontSize(24).font('Helvetica-Bold').fillColor('#f5a623').text('SHIFTLEDGER', 50, 22);
  doc.fontSize(10).font('Helvetica').fillColor('#888')
    .text(`Earnings Report  ·  ${label || (from && to ? `${from} → ${to}` : 'All Time')}`, 50, 52);
  doc.moveDown(3);

  // Summary
  doc.fontSize(11).font('Helvetica-Bold').fillColor('#0d0d0d').text('SUMMARY', 50);
  doc.moveDown(0.4);
  const summaryY = doc.y;
  const cols = [[50, 180], [200, 330], [360, 490]];
  const avgTipsPerHour = totals.hours > 0 ? (totals.tips / totals.hours).toFixed(2) : '0.00';
  const summaryItems = [
    ['Total Shifts', shifts.length.toString()],
    ['Total Hours', totals.hours.toFixed(2) + ' hrs'],
    ['Hourly Wages', '$' + totals.wages.toFixed(2)],
    ['Total Tips', '$' + totals.tips.toFixed(2)],
    ['Avg Tips/Hr', '$' + avgTipsPerHour],
    ['Grand Total', '$' + totals.grand.toFixed(2)],
  ];
  summaryItems.forEach(([k, v], i) => {
    const [x1] = cols[i % 3];
    const rowY = summaryY + Math.floor(i / 3) * 30;
    doc.rect(x1 - 5, rowY - 4, 140, 24).fill('#f5f5f5');
    doc.fontSize(8).font('Helvetica').fillColor('#666').text(k, x1, rowY);
    doc.fontSize(13).font('Helvetica-Bold').fillColor('#0d0d0d').text(v, x1, rowY + 9);
  });
  doc.y = summaryY + 80;
  doc.moveDown(1);

  if (shifts.length === 0) {
    doc.fontSize(12).fillColor('#888').text('No shifts recorded for this period.', { align: 'center' });
    doc.end(); return;
  }

  // Table
  doc.fontSize(11).font('Helvetica-Bold').fillColor('#0d0d0d').text('SHIFT DETAILS');
  doc.moveDown(0.4);

  const th = doc.y;
  doc.rect(45, th, 522, 18).fill('#0d0d0d');
  const hCols = [50, 105, 145, 185, 230, 275, 325, 375, 435];
  const hLabels = ['Date', 'Job', 'Hours', 'Rate', 'Wages', 'Tips/Hr', 'Tips', 'Total', 'Notes'];
  hLabels.forEach((h, i) => {
    doc.fontSize(7).font('Helvetica-Bold').fillColor('#f5a623')
      .text(h, hCols[i], th + 5, { width: (hCols[i + 1] || 570) - hCols[i] - 4 });
  });
  doc.y = th + 22;

  const drawTableHeader = () => {
    const th2 = doc.y;
    doc.rect(45, th2, 522, 18).fill('#0d0d0d');
    hLabels.forEach((h, i) => {
      doc.fontSize(7).font('Helvetica-Bold').fillColor('#f5a623')
        .text(h, hCols[i], th2 + 5, { width: (hCols[i + 1] || 570) - hCols[i] - 4 });
    });
    doc.y = th2 + 22;
  };

  shifts.forEach((s, idx) => {
    if (doc.y > 700) { doc.addPage(); drawTableHeader(); }
    const ry = doc.y;
    if (idx % 2 === 0) doc.rect(45, ry, 522, 16).fill('#fafafa');
    const tipsPerHour = s.hours_worked > 0 ? (s.total_tips / s.hours_worked).toFixed(2) : '0.00';
    const row = [
      s.date, s.job_name || '—', s.hours_worked.toFixed(2), '$' + s.hourly_rate.toFixed(2),
      '$' + s.wage_total.toFixed(2), '$' + tipsPerHour, '$' + s.total_tips.toFixed(2),
      '$' + s.grand_total.toFixed(2), s.notes || '',
    ];
    row.forEach((v, i) => {
      doc.fontSize(7).font('Helvetica').fillColor('#222')
        .text(v, hCols[i], ry + 3, { width: (hCols[i + 1] || 570) - hCols[i] - 4, ellipsis: true });
    });
    doc.y = ry + 18;
  });

  // Totals row
  doc.moveDown(0.3);
  const ty = doc.y;
  doc.rect(45, ty, 522, 20).fill('#f5a623');
  const totRow = ['TOTAL', '', totals.hours.toFixed(2), '', '$' + totals.wages.toFixed(2), '$' + avgTipsPerHour, '$' + totals.tips.toFixed(2), '$' + totals.grand.toFixed(2), ''];
  totRow.forEach((v, i) => {
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#0d0d0d')
      .text(v, hCols[i], ty + 5, { width: (hCols[i + 1] || 570) - hCols[i] - 4 });
  });

  doc.fontSize(8).font('Helvetica').fillColor('#aaa')
    .text(`Generated by ShiftLedger · ${new Date().toLocaleString()}`, 50, 740, { align: 'center', width: 512 });
  doc.end();
});

// ── Global Error Handler ──────────────────────────────────────────────────────
// Catches any unhandled errors thrown synchronously in route handlers.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  if (res.headersSent) return _next(err);
  internalError(res, err);
});

// ── Start ────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, '0.0.0.0', () => {
  logger.info(`ShiftLedger running → http://0.0.0.0:${PORT}`);
});

// Graceful shutdown
function shutdown(signal) {
  logger.info(`${signal} received, shutting down...`);
  server.close(() => {
    db.close();
    logger.info('Server closed');
    process.exit(0);
  });
  setTimeout(() => { process.exit(1); }, 5000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
