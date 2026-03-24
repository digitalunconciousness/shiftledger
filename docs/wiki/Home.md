# ShiftLedger Wiki

**ShiftLedger** is a self-hosted, multi-user shift earnings tracker built with Node.js, Express, and SQLite. It provides a real-time dashboard, tip analytics, trend graphs, goal tracking, and PDF/CSV export — all in a single lightweight app designed to run on a home server or Proxmox LXC container.

## Key Features

- **Multi-user authentication** with admin-managed accounts, scrypt password hashing, session cookies, and Bearer token support for mobile clients
- **Shift logging** with hourly rate, hours worked, tip entry (total or per-hour), and job assignment
- **Interactive dashboard** with period comparisons, day-of-week heatmaps, and goal progress bars
- **Trend charts** for earnings, wages vs tips, tip percentage, and effective hourly rate
- **Shift history** with date/user filtering, dual tip columns (Tips/Hr + Total Tips), inline edit, and soft-delete with undo
- **Overtime tracking** with configurable per-job thresholds
- **Tax estimation** for YTD wage and tip tax liability
- **Tax profile presets** — one-click setup with 2026 IRS-bracket effective rates by filing status and income range, with automatic six-month baseline refresh
- **Paycheck tracking** — record actual paychecks and estimate the current period's take-home pay
- **Goals & budgeting** with weekly/monthly income targets
- **Household sharing** — group multiple users together to view combined earnings and share job/template data
- **Audit logging** for sensitive operations (admin actions, password changes, user management)
- **PDF & CSV export/import** for data portability
- **PWA support** — installable on mobile with offline shell caching
- **React Native mobile app** (Expo) for iOS and Android
- **Dark/light theme** with keyboard shortcuts

## Wiki Pages

- [[Getting Started]] — Prerequisites, installation, and first-run setup
- [[User Guide]] — How to use every view and feature
- [[Admin Guide]] — User management, households, roles, and permissions
- [[Configuration]] — Environment variables and tuning
- [[Deployment Guide]] — Proxmox LXC, systemd, nginx reverse proxy
- [[Backup & Recovery]] — Automated backups, retention, and restore procedures
- [[API Reference]] — Complete REST API documentation
- [[Architecture]] — Tech stack, database schema, auth flow, and migration system
- [[Mobile App]] — React Native companion app setup and usage
- [[Troubleshooting]] — Common problems and solutions
