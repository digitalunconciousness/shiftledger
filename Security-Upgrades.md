## Overview
Implement a comprehensive security hardening initiative across code, infrastructure, and deployment processes. This is a high-level epic to identify, assess, and implement security best practices across all layers of the application. 

## Objectives
- [x] Conduct code security review and implement improvements
- [ ] Harden infrastructure and deployment practices
- [ ] Establish ongoing security monitoring and best practices

## Code Security
- [x] Review authentication and authorization mechanisms
  - Auth uses scrypt password hashing with random salt (crypto.scrypt)
  - Sessions use HMAC-signed cookies (HttpOnly, SameSite=Lax)
  - Bearer token support for mobile clients stored as SHA-256 hash
  - Timing-safe comparison for cookie signatures and password verification
- [x] Audit input validation and sanitization across all user-facing endpoints
  - All write endpoints validated with Zod schemas
  - SQL queries use prepared statements with `?` placeholders (no raw string interpolation)
- [x] Implement secure password handling and storage practices
  - scrypt with 16-byte random salt; 64-byte derived key
- [x] Review and harden API security (rate limiting, CORS, etc.)
  - Auth endpoints: 20 requests / 15 min per IP
  - General API: 120 requests / min per IP (added in this pass)
  - JSON body size capped at 100 KB to prevent DoS (added in this pass)
- [ ] Conduct dependency audit and update vulnerable packages
- [x] Implement security headers (CSP, X-Frame-Options, etc.) — added in this pass
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: SAMEORIGIN`
  - `X-XSS-Protection: 0` (modern browsers: disable legacy XSS filter)
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `Permissions-Policy: camera=(), microphone=(), geolocation=()`
  - `Content-Security-Policy` restricting scripts, styles, fonts, and connections
  - `X-Powered-By` header disabled (removed Express fingerprint)
- [x] Review and improve error handling (avoid information disclosure) — added in this pass
  - All 500 responses now go through `internalError()` helper
  - In `NODE_ENV=production`, generic "Internal server error" message is returned
  - Internal error details are logged server-side only
  - Global Express error handler added to catch unhandled synchronous exceptions
- [x] Implement secure session management
  - 30-day sessions, token hash stored in DB, signed cookies
  - Logout deletes session from DB (token invalidation)
  - `/api/auth/refresh` supports token rotation for mobile clients

## Infrastructure & Deployment Security
- [ ] Review environment variable management and secrets handling
  - SESSION_SECRET defaults to a random value per process start (set it explicitly in production)
- [ ] Implement secure CI/CD pipeline practices
- [ ] Enable security scanning in build process (SAST/DAST)
- [ ] Audit database access controls and encryption
  - SQLite WAL mode + foreign keys enabled; file permissions are OS-controlled
- [x] Review logging practices (ensure sensitive data isn't logged)
  - Request logger logs method, URL, status, and duration only (no body/passwords)
  - Errors logged via pino at `error` level without exposing to clients in production
- [x] Implement health checks and monitoring — added in this pass
  - `GET /api/health` returns `{ status: "ok", uptime: <seconds> }` (no auth required)
- [ ] Document security configuration for production deployments

## General Best Practices
- [ ] Create or update security policy documentation
- [ ] Implement vulnerability disclosure process
- [ ] Set up security alerts for dependencies
- [ ] Document security architecture decisions
- [ ] Plan for regular security audits

## Success Criteria
- All items assessed and prioritized
- Critical vulnerabilities identified and documented
- Roadmap established for incremental improvements
- Team has clear understanding of current security posture

## Notes
- Start with code review and dependency audit
- Prioritize based on risk assessment
- Create follow-up issues for specific implementations
- Consider external security audit if resources allow

## Production Deployment Recommendations

1. **Set `SESSION_SECRET`** to a long random value via environment variable (e.g., `openssl rand -hex 32`). If unset, a new secret is generated on each restart, invalidating all sessions.
2. **Set `NODE_ENV=production`** so that internal error messages are not exposed in API responses.
3. **Run behind a reverse proxy** (nginx / Cloudflare Tunnel) that enforces TLS. Add `Strict-Transport-Security` at the proxy layer.
4. **Restrict database file permissions** so only the app user can read `shifts.db`.
5. **Keep dependencies updated** — run `npm audit` regularly and apply patches promptly.
6. **Monitor `/api/health`** with an uptime checker (e.g., UptimeRobot, Cloudflare Health Checks).
