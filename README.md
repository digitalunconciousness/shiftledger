# ShiftLedger

A self-hosted, multi-user shift earnings tracker with tips dashboard, analytics, trend graphs, goal tracking, and PDF/CSV export.
Designed to run as a Proxmox LXC container and exposed via Cloudflare Tunnel.

---

## Features

- **Multi-user auth** — admin-managed accounts with password hashing (scrypt), signed session cookies, and role-based access
- **Log shifts** — hourly rate × hours worked, plus tips (enter as night total *or* per-hour rate); assign to jobs
- **Employers + jobs** — manage multiple employers, assign jobs to employers, and mark employers as no-tax
- **Fixed recurring income** — track recurring non-shift income (weekly, bi-weekly, semi-monthly, monthly, or custom schedules)
- **Live preview** — wages / tips / grand total update as you type
- **Shift templates** — save and load recurring shift configurations
- **Dashboard** — summary cards with period comparisons (% change arrows), day-of-week earnings heatmap, goal progress bars
- **Trend charts** — earnings, wages vs tips, tip %, and effective hourly rate — selectable by 12 weeks, 12 months, or 3 years
- **Shift history** — filterable by date range and user, with dual tip columns (Tips/Hr + Total Tips), inline edit, soft-delete with undo
- **Overtime tracking** — configurable per-job thresholds, weekly hours card on dashboard
- **Tax estimation** — YTD estimated tax liability on wages + tips
- **Goals & budgeting** — set weekly/monthly income targets with progress bars
- **PDF export** — styled reports with summary grid, job + dual-tip columns, and itemized shift table
- **CSV import/export** — data portability for all shifts
- **Dark/light theme** — toggle in topbar, persisted to localStorage
- **PWA support** — installable as a mobile app with offline shell caching
- **Keyboard shortcuts** — `1-5` for views, `[`/`]` to cycle views, `Ctrl+Enter` to save, `?` for help overlay
- **Mobile-responsive** — hamburger sidebar, touch-friendly

---

## Quick Start

### Proxmox LXC Setup

1. Create a Debian 12 LXC (1 core, 512MB RAM, 4GB disk)
2. Copy project files to the LXC
3. Run the installer:

```bash
chmod +x install.sh
sudo ./install.sh
```

The installer will:
- Install Node.js 20 and npm dependencies
- Create a `shiftledger` service user
- Deploy to `/opt/shiftledger/`
- Generate a session secret
- Register and start a systemd service
- Set up daily backups at 3 AM via cron
- Optionally install nginx reverse proxy
- Optionally install `cloudflared` for Cloudflare Tunnel

4. Visit `http://<LXC-IP>:3000` — the first visit prompts admin account creation.

---


## Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DB_PATH` | `/opt/shiftledger/shifts.db` | SQLite database path |
| `SESSION_SECRET` | Random (generated at install) | Cookie signing secret |
| `LOG_LEVEL` | `info` | Pino log level |
| `OT_THRESHOLD` | `40` | Default weekly overtime threshold (hrs) |
| `OT_MULTIPLIER` | `1.5` | Default overtime rate multiplier |
| `TAX_RATE_WAGES` | `0.22` | Estimated tax rate on wages (22%) |
| `TAX_RATE_TIPS` | `0.153` | Estimated tax rate on tips (15.3%) |

Override in `/etc/systemd/system/shiftledger.service`, then:
```bash
systemctl daemon-reload && systemctl restart shiftledger
```

---

## Management

```bash
systemctl status shiftledger      # check status
systemctl restart shiftledger     # restart
journalctl -u shiftledger -f      # live logs
```

### Database backup

Automatic daily backups run at 3 AM. Manual backup:
```bash
/opt/shiftledger/backup.sh
```

Backups stored in `/opt/shiftledger/backups/`, pruned after 30 days.

---

## Keyboard Shortcuts

Press `?` in the app to open the shortcuts overlay at any time.

| Key | Action |
|---|---|
| `1` | Log Shift view |
| `2` | Dashboard view |
| `3` | Shift History view |
| `4` | Reports view |
| `5` | Settings view |
| `[` | Previous view |
| `]` | Next view |
| `Ctrl+Enter` | Save shift (on Log Shift view) |
| `Esc` | Close modal / overlay |
| `?` | Toggle this shortcuts overlay |

> **Note:** Shortcuts are disabled when focus is inside a text input, textarea, or select field.

---

## API Endpoints

**Auth**: `GET /api/auth/status`, `POST /api/auth/setup`, `POST /api/auth/login`, `POST /api/auth/logout`, `POST /api/auth/register` (admin)

**Users**: `GET /api/users`, `PUT /api/users/:id`, `DELETE /api/users/:id` (admin)

**Shifts**: `GET /api/shifts`, `POST /api/shifts`, `PUT /api/shifts/:id`, `DELETE /api/shifts/:id`, `POST /api/shifts/:id/restore`

**Employers**: `GET /api/employers`, `POST /api/employers`, `PUT /api/employers/:id`, `DELETE /api/employers/:id`

**Fixed Income**: `GET /api/fixed-incomes`, `POST /api/fixed-incomes`, `PUT /api/fixed-incomes/:id`, `DELETE /api/fixed-incomes/:id`

**Jobs**: `GET /api/jobs`, `POST /api/jobs`, `PUT /api/jobs/:id`, `DELETE /api/jobs/:id`

**Templates**: `GET /api/templates`, `POST /api/templates`, `DELETE /api/templates/:id`

**Goals**: `GET /api/goals`, `POST /api/goals`, `PUT /api/goals/:id`, `DELETE /api/goals/:id`

**Analytics**: `GET /api/summary`, `GET /api/trends`, `GET /api/overtime`, `GET /api/tax-estimate`, `GET /api/analytics/effective-rate`, `GET /api/analytics/extremes`, `GET /api/analytics/tip-ratio`

**Export**: `GET /api/export/pdf`, `GET /api/export/csv`, `POST /api/import/csv`

---

## Stack

- **Backend**: Node.js + Express + Zod + Pino
- **Database**: SQLite via `better-sqlite3`
- **Auth**: `crypto.scrypt` + signed session cookies
- **PDF**: PDFKit
- **Frontend**: Vanilla JS + Chart.js (PWA)
- **Fonts**: IBM Plex Mono + Syne (Google Fonts)

---

## Project Management

See [PROJECT_MANAGEMENT.md](PROJECT_MANAGEMENT.md) for architecture constraints, active issues, and deployment info.
