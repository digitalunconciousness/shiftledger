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

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
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

// Auth middleware
function authMiddleware(req, res, next) {
  // If no users exist, skip auth (first-run setup)
  if (getUserCount() === 0) {
    req.user = null;
    return next();
  }

  const cookies = parseCookies(req.headers.cookie);
  const token = verifyCookie(cookies.sl_session);
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
app.post('/api/auth/setup', validate(RegisterSchema), async (req, res) => {
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
    res.json({ success: true, user: { id: result.lastInsertRowid, username, display_name, is_admin: true, color: assignedColor } });
  } catch (e) {
    logger.error(e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/auth/login
app.post('/api/auth/login', validate(LoginSchema), async (req, res) => {
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
    res.json({ success: true, user: { id: user.id, username: user.username, display_name: user.display_name, is_admin: !!user.is_admin, color: user.color } });
  } catch (e) {
    logger.error(e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/auth/logout
app.post('/api/auth/logout', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const token = verifyCookie(cookies.sl_session);
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
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
    logger.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ── User Management Routes ───────────────────────────────────────────────────

app.get('/api/users', authMiddleware, (req, res) => {
  const users = db.prepare('SELECT id, username, display_name, is_admin, color, created_at FROM users').all();
  res.json(users);
});

app.put('/api/users/:id', authMiddleware, async (req, res) => {
  try {
    const targetId = parseInt(req.params.id, 10);
    const isOwnProfile = req.user && req.user.id === targetId;
    const isAdmin = req.user && req.user.is_admin;
    if (!isOwnProfile && !isAdmin) return res.status(403).json({ error: 'Forbidden' });

    const { display_name, color, password, is_admin } = req.body;
    if (display_name) db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(display_name, targetId);
    if (color) db.prepare('UPDATE users SET color = ? WHERE id = ?').run(color, targetId);
    if (password) {
      const pw = await hashPassword(password);
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(pw, targetId);
    }
    if (isAdmin && is_admin !== undefined) {
      db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(is_admin ? 1 : 0, targetId);
    }
    res.json({ success: true });
  } catch (e) {
    logger.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/users/:id', authMiddleware, adminOnly, (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  if (req.user.id === targetId) return res.status(400).json({ error: 'Cannot delete yourself' });
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(targetId);
  db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
  res.json({ success: true });
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
    logger.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/shifts', authMiddleware, (req, res) => {
  const { from, to, user_id: filterUser } = req.query;
  let query = 'SELECT s.*, u.display_name as user_name, u.color as user_color, j.name as job_name, j.color as job_color FROM shifts s LEFT JOIN users u ON s.user_id = u.id LEFT JOIN jobs j ON s.job_id = j.id WHERE s.deleted_at IS NULL';
  const params = [];

  if (from && to) { query += ' AND s.date >= ? AND s.date <= ?'; params.push(from, to); }
  else if (from) { query += ' AND s.date >= ?'; params.push(from); }
  if (filterUser) { query += ' AND s.user_id = ?'; params.push(filterUser); }
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
    logger.error(e);
    res.status(500).json({ error: e.message });
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
  res.json(db.prepare('SELECT * FROM jobs ORDER BY name ASC').all());
});

app.post('/api/jobs', authMiddleware, validate(JobSchema), (req, res) => {
  try {
    const { name, default_rate, color, overtime_threshold, overtime_multiplier, tip_payment } = req.validated;
    const result = db.prepare('INSERT INTO jobs (name, default_rate, color, overtime_threshold, overtime_multiplier, tip_payment) VALUES (?,?,?,?,?,?)')
      .run(name, default_rate, color, overtime_threshold, overtime_multiplier, tip_payment);
    res.json({ id: result.lastInsertRowid, name, default_rate, color, tip_payment });
  } catch (e) {
    logger.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/jobs/:id', authMiddleware, validate(JobSchema), (req, res) => {
  try {
    const { name, default_rate, color, overtime_threshold, overtime_multiplier, tip_payment } = req.validated;
    db.prepare('UPDATE jobs SET name=?, default_rate=?, color=?, overtime_threshold=?, overtime_multiplier=?, tip_payment=? WHERE id=?')
      .run(name, default_rate, color, overtime_threshold, overtime_multiplier, tip_payment, req.params.id);
    res.json({ success: true });
  } catch (e) {
    logger.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/jobs/:id', authMiddleware, (req, res) => {
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
    logger.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ── Tax Config Routes ─────────────────────────────────────────────────────────

app.get('/api/tax-config', authMiddleware, (req, res) => {
  res.json(db.prepare('SELECT * FROM tax_config ORDER BY sort_order ASC').all());
});

app.put('/api/tax-config/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    const { label, rate, flat_amount, enabled } = req.body;
    const id = parseInt(req.params.id, 10);
    if (rate !== undefined && (isNaN(rate) || rate < 0 || rate > 1)) return res.status(400).json({ error: 'Rate must be 0-1' });
    if (flat_amount !== undefined && (isNaN(flat_amount) || flat_amount < 0)) return res.status(400).json({ error: 'Flat amount must be >= 0' });
    const row = db.prepare('SELECT * FROM tax_config WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Tax config not found' });
    db.prepare('UPDATE tax_config SET label=?, rate=?, flat_amount=?, enabled=? WHERE id=?')
      .run(label ?? row.label, rate ?? row.rate, flat_amount ?? row.flat_amount, enabled !== undefined ? (enabled ? 1 : 0) : row.enabled, id);
    res.json({ success: true });
  } catch (e) { logger.error(e); res.status(500).json({ error: e.message }); }
});

app.post('/api/tax-config', authMiddleware, adminOnly, (req, res) => {
  try {
    const { key, label, rate, flat_amount } = req.body;
    if (!key || !label) return res.status(400).json({ error: 'Key and label required' });
    const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM tax_config').get().m || 0;
    const result = db.prepare('INSERT INTO tax_config (key, label, rate, flat_amount, enabled, sort_order) VALUES (?,?,?,?,1,?)')
      .run(key, label, rate || 0, flat_amount || 0, maxOrder + 1);
    res.json({ id: result.lastInsertRowid });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Key already exists' });
    logger.error(e); res.status(500).json({ error: e.message });
  }
});

app.delete('/api/tax-config/:id', authMiddleware, adminOnly, (req, res) => {
  db.prepare('DELETE FROM tax_config WHERE id = ?').run(req.params.id);
  res.json({ success: true });
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

    // Sum all shifts in the period
    const sumQuery = `SELECT COALESCE(SUM(wage_total),0) as wages, COALESCE(SUM(total_tips),0) as tips,
      COALESCE(SUM(grand_total),0) as gross, COALESCE(SUM(hours_worked),0) as hours, COUNT(*) as shifts
      FROM shifts WHERE date >= ? AND date <= ? AND deleted_at IS NULL`;

    const current = db.prepare(sumQuery).get(from, to);
    const previous = db.prepare(sumQuery).get(prevFrom, prevTo);

    // Split tips by payment method (cash vs paycheck) based on each shift's job setting
    const tipSplitQuery = `SELECT
      COALESCE(SUM(CASE WHEN COALESCE(j.tip_payment,'cash')='cash' THEN s.total_tips ELSE 0 END),0) as cash_tips,
      COALESCE(SUM(CASE WHEN COALESCE(j.tip_payment,'cash')='paycheck' THEN s.total_tips ELSE 0 END),0) as paycheck_tips
      FROM shifts s LEFT JOIN jobs j ON s.job_id = j.id
      WHERE s.date >= ? AND s.date <= ? AND s.deleted_at IS NULL`;

    const tipSplit = db.prepare(tipSplitQuery).get(from, to);

    // Paycheck gross = wages + paycheck tips (cash tips already received nightly)
    const paycheckGross = current.wages + tipSplit.paycheck_tips;

    // Get tax config
    const taxes = db.prepare('SELECT * FROM tax_config WHERE enabled = 1 ORDER BY sort_order ASC').all();

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
    logger.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ── Templates Routes ─────────────────────────────────────────────────────────

app.get('/api/templates', authMiddleware, (req, res) => {
  res.json(db.prepare('SELECT t.*, j.name as job_name FROM templates t LEFT JOIN jobs j ON t.job_id = j.id ORDER BY t.name ASC').all());
});

app.post('/api/templates', authMiddleware, validate(TemplateSchema), (req, res) => {
  try {
    const { name, job_id, hourly_rate, hours_worked, tip_mode, tip_input, notes } = req.validated;
    const result = db.prepare('INSERT INTO templates (name, job_id, hourly_rate, hours_worked, tip_mode, tip_input, notes) VALUES (?,?,?,?,?,?,?)')
      .run(name, job_id, hourly_rate, hours_worked, tip_mode, tip_input, notes);
    res.json({ id: result.lastInsertRowid });
  } catch (e) {
    logger.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/templates/:id', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM templates WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ── Goals Routes ─────────────────────────────────────────────────────────────

app.get('/api/goals', authMiddleware, (req, res) => {
  res.json(db.prepare('SELECT * FROM goals ORDER BY created_at DESC').all());
});

app.post('/api/goals', authMiddleware, validate(GoalSchema), (req, res) => {
  try {
    const { period, target_amount, active } = req.validated;
    // Deactivate other goals of same period
    if (active) db.prepare('UPDATE goals SET active = 0 WHERE period = ?').run(period);
    const result = db.prepare('INSERT INTO goals (period, target_amount, active) VALUES (?,?,?)').run(period, target_amount, active ? 1 : 0);
    res.json({ id: result.lastInsertRowid });
  } catch (e) {
    logger.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/goals/:id', authMiddleware, validate(GoalSchema), (req, res) => {
  try {
    const { period, target_amount, active } = req.validated;
    if (active) db.prepare('UPDATE goals SET active = 0 WHERE period = ? AND id != ?').run(period, req.params.id);
    db.prepare('UPDATE goals SET period=?, target_amount=?, active=? WHERE id=?').run(period, target_amount, active ? 1 : 0, req.params.id);
    res.json({ success: true });
  } catch (e) {
    logger.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/goals/:id', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM goals WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.get('/api/goals/history', authMiddleware, (req, res) => {
  try {
    const activeGoals = db.prepare('SELECT * FROM goals WHERE active = 1').all();
    if (!activeGoals.length) return res.json([]);

    const startDay = getPayWeekStartDay();
    const now = new Date();
    const results = [];

    for (const goal of activeGoals) {
      const periods = [];
      const count = goal.period === 'weekly' ? 52 : 12;

      if (goal.period === 'weekly') {
        const daysSinceStart = (now.getDay() - startDay + 7) % 7;
        const thisWeekStart = new Date(now);
        thisWeekStart.setDate(now.getDate() - daysSinceStart);
        thisWeekStart.setHours(0, 0, 0, 0);

        for (let i = 1; i <= count; i++) {
          const weekStart = new Date(thisWeekStart);
          weekStart.setDate(weekStart.getDate() - i * 7);
          const weekEnd = new Date(weekStart);
          weekEnd.setDate(weekEnd.getDate() + 6);
          const from = fmt(weekStart), to = fmt(weekEnd);
          const data = db.prepare(
            'SELECT COALESCE(SUM(grand_total),0) as earned FROM shifts WHERE date >= ? AND date <= ? AND deleted_at IS NULL'
          ).get(from, to);
          periods.push({ from, to, earned: data.earned, achieved: data.earned >= goal.target_amount });
        }
      } else if (goal.period === 'monthly') {
        for (let i = 1; i <= count; i++) {
          const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
          const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);
          const from = fmt(monthStart), to = fmt(monthEnd);
          const data = db.prepare(
            'SELECT COALESCE(SUM(grand_total),0) as earned FROM shifts WHERE date >= ? AND date <= ? AND deleted_at IS NULL'
          ).get(from, to);
          periods.push({ from, to, earned: data.earned, achieved: data.earned >= goal.target_amount });
        }
      }

      results.push({ goal_id: goal.id, period: goal.period, target_amount: goal.target_amount, history: periods });
    }

    res.json(results);
  } catch (e) {
    logger.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ── Summary ──────────────────────────────────────────────────────────────────

app.get('/api/summary', authMiddleware, (req, res) => {
  const { now, weekStart, lastWeekStart, lastWeekEnd, biweekStart, monthStart, lastMonthStart, lastMonthEnd, ytdStart } = getPeriodBounds();
  const filterUser = req.query.user_id;

  const sum = (from, to) => {
    let q = `SELECT COUNT(*) as shifts, COALESCE(SUM(hours_worked),0) as total_hours,
      COALESCE(SUM(wage_total),0) as total_wages, COALESCE(SUM(total_tips),0) as total_tips,
      COALESCE(SUM(grand_total),0) as grand_total, COALESCE(AVG(grand_total),0) as avg_shift,
      COALESCE(SUM(total_tips)/NULLIF(SUM(hours_worked),0),0) as avg_tips_per_hour
      FROM shifts WHERE date >= ? AND date <= ? AND deleted_at IS NULL`;
    const params = [from, to];
    if (filterUser) { q += ' AND user_id = ?'; params.push(filterUser); }
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

  const data = db.prepare(`
    SELECT ${groupFmt} as period, COUNT(*) as shifts, SUM(hours_worked) as total_hours,
      SUM(wage_total) as total_wages, SUM(total_tips) as total_tips, SUM(grand_total) as grand_total,
      SUM(total_tips)/NULLIF(SUM(hours_worked),0) as tips_per_hour,
      SUM(grand_total)/NULLIF(SUM(hours_worked),0) as effective_rate
    FROM shifts WHERE date >= ? AND deleted_at IS NULL
    GROUP BY period ORDER BY period ASC
  `).all(dateFilter);

  res.json(data);
});

// ── Analytics ────────────────────────────────────────────────────────────────

app.get('/api/analytics/effective-rate', authMiddleware, (req, res) => {
  const data = db.prepare(`
    SELECT CAST(strftime('%w', date) AS INTEGER) as dow,
      AVG((wage_total + total_tips) / NULLIF(hours_worked, 0)) as avg_effective_rate,
      COUNT(*) as shift_count
    FROM shifts WHERE deleted_at IS NULL AND hours_worked > 0
    GROUP BY dow ORDER BY dow
  `).all();
  res.json(data);
});

app.get('/api/analytics/extremes', authMiddleware, (req, res) => {
  const count = parseInt(req.query.count, 10) || 5;
  const best = db.prepare(`SELECT s.*, u.display_name as user_name, j.name as job_name FROM shifts s LEFT JOIN users u ON s.user_id=u.id LEFT JOIN jobs j ON s.job_id=j.id WHERE s.deleted_at IS NULL ORDER BY s.grand_total DESC LIMIT ?`).all(count);
  const worst = db.prepare(`SELECT s.*, u.display_name as user_name, j.name as job_name FROM shifts s LEFT JOIN users u ON s.user_id=u.id LEFT JOIN jobs j ON s.job_id=j.id WHERE s.deleted_at IS NULL ORDER BY s.grand_total ASC LIMIT ?`).all(count);
  res.json({ best, worst });
});

app.get('/api/analytics/tip-ratio', authMiddleware, (req, res) => {
  const data = db.prepare(`
    SELECT strftime('%Y-%m', date) as period,
      SUM(total_tips) as total_tips, SUM(grand_total) as grand_total,
      CASE WHEN SUM(grand_total) > 0 THEN ROUND(SUM(total_tips) * 100.0 / SUM(grand_total), 1) ELSE 0 END as tip_pct
    FROM shifts WHERE deleted_at IS NULL
    GROUP BY period ORDER BY period ASC
  `).all();
  res.json(data);
});

// ── Overtime ─────────────────────────────────────────────────────────────────

app.get('/api/overtime', authMiddleware, (req, res) => {
  const { now, weekStart } = getPeriodBounds();
  const defaultThreshold = parseFloat(process.env.OT_THRESHOLD) || 40;
  const defaultMultiplier = parseFloat(process.env.OT_MULTIPLIER) || 1.5;

  const weekShifts = db.prepare(`
    SELECT s.*, j.name as job_name, j.overtime_threshold, j.overtime_multiplier
    FROM shifts s LEFT JOIN jobs j ON s.job_id = j.id
    WHERE s.date >= ? AND s.date <= ? AND s.deleted_at IS NULL
    ORDER BY s.date ASC
  `).all(fmt(weekStart), fmt(now));

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

  const data = db.prepare(`
    SELECT COALESCE(SUM(wage_total),0) as wages, COALESCE(SUM(total_tips),0) as tips, COALESCE(SUM(grand_total),0) as total
    FROM shifts WHERE date >= ? AND date <= ? AND deleted_at IS NULL
  `).get(from, to);

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
  let query = 'SELECT s.*, j.name as job_name, u.display_name as user_name FROM shifts s LEFT JOIN jobs j ON s.job_id=j.id LEFT JOIN users u ON s.user_id=u.id WHERE s.deleted_at IS NULL';
  const params = [];
  if (from && to) { query += ' AND s.date >= ? AND s.date <= ?'; params.push(from, to); }
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
    logger.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ── PDF Export ────────────────────────────────────────────────────────────────

app.get('/api/export/pdf', authMiddleware, (req, res) => {
  const { from, to, label } = req.query;
  let query = 'SELECT s.*, j.name as job_name, u.display_name as user_name FROM shifts s LEFT JOIN jobs j ON s.job_id=j.id LEFT JOIN users u ON s.user_id=u.id WHERE s.deleted_at IS NULL';
  const params = [];
  if (from && to) { query += ' AND s.date >= ? AND s.date <= ?'; params.push(from, to); }
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
