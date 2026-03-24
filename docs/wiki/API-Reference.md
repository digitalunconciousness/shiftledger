# API Reference

All API endpoints return JSON. Authenticated endpoints require either:
- A valid `sl_session` cookie (set automatically by the browser on login), **or**
- An `Authorization: Bearer <token>` header (for mobile clients and API access)

Unauthorized requests return `401`. Admin-only endpoints return `403` for non-admin users.

---

## Authentication

### `GET /api/health`

Public health check. Returns `{"status":"ok","db":"ok"}`. No authentication required.

### `GET /api/auth/status`

Check the current auth state.

**Response:**
- `{"status": "setup"}` — no users exist, first-run setup needed
- `{"status": "login"}` — users exist but no valid session
- `{"status": "authenticated", "user": {...}}` — logged in; includes user object

### `POST /api/auth/setup`

Create the first admin account. Only works when no users exist.

**Body:**
```json
{
  "username": "admin",
  "display_name": "Admin User",
  "password": "secret",
  "color": "#f5a623"
}
```

- `username` — 2–50 chars, alphanumeric + underscores (required)
- `display_name` — 1–100 chars (required)
- `password` — 4–200 chars (required)
- `color` — hex color, optional (auto-assigned if omitted)

**Response:** `200` with user object and `token`. Sets `sl_session` cookie.

**Errors:** `400` if setup already completed.

### `POST /api/auth/login`

**Body:**
```json
{
  "username": "admin",
  "password": "secret"
}
```

**Response:** `200` with user object and `token`. Sets `sl_session` cookie (30-day expiry).

**Errors:** `401` invalid credentials.

### `POST /api/auth/logout`

Clears the session cookie and deletes the server-side session record.

**Response:** `{"success": true}`

### `POST /api/auth/signup`

Self-registration endpoint. Allows users to create their own accounts without admin intervention. If no users exist, the first signup is granted admin.

**Body:** Same as `/api/auth/setup`.

**Response:** `200` with user object and `token`. Sets `sl_session` cookie.

**Errors:** `409` if username already taken; `429` if rate limit exceeded.

### `POST /api/auth/register` _(admin only)_

Create a new user as an admin. Same body format as `/api/auth/setup`.

**Response:** `200` with new user object.

**Errors:** `409` if username already taken. `403` if not admin.

### `POST /api/auth/refresh`

Rotate the current session token. Issues a new token and invalidates the old one. Used by mobile clients for token rotation.

**Response:** `{"token": "<new_token>", "user": {...}}`

**Errors:** `401` if the current session is invalid or expired.

### `POST /api/auth/change-password`

Change the authenticated user's own password.

**Body:**
```json
{
  "current_password": "old-secret",
  "new_password": "new-secret"
}
```

**Errors:** `401` if `current_password` is wrong; `400` if the new password was used recently (password history check).

---

## Users & Profile

### `GET /api/profile`

Return the authenticated user's profile, including household memberships.

**Response:** User object with an additional `households` array:
```json
{
  "id": 1,
  "username": "alice",
  "display_name": "Alice",
  "is_admin": true,
  "color": "#f5a623",
  "created_at": "...",
  "households": [
    { "id": 1, "name": "Family", "member_count": 3 }
  ]
}
```

### `GET /api/users` _(admin only)_

List all users. Returns id, username, display_name, is_admin, color, created_at.

### `GET /api/users/:id`

Get a specific user. Admins can fetch any user; regular users can only fetch themselves.

**Response:** User object with `households` array.

### `PUT /api/users/:id`

Update a user. Admins can update any user; regular users can only update themselves.

**Body** (all fields optional):
```json
{
  "display_name": "New Name",
  "color": "#3ecf8e",
  "password": "newpass",
  "is_admin": true
}
```

`is_admin` can only be changed by an admin.

### `DELETE /api/users/:id` _(admin only)_

Permanently delete a user and all their sessions.

**Errors:** `400` if trying to delete yourself.

### `POST /api/users/:id/reset-password` _(admin only)_

Reset another user's password without knowing the current one.

**Body:**
```json
{ "new_password": "resetpassword" }
```

**Response:** `{"success": true}`

### `GET /api/audit-log` _(admin only)_

Retrieve the audit log for sensitive operations.

**Response:** Array of audit log entries, newest first:
```json
[
  {
    "id": 42,
    "user_id": 1,
    "username": "admin",
    "action": "change_password",
    "target_id": 2,
    "meta": "{}",
    "created_at": "2026-03-24T04:00:00.000Z"
  }
]
```

Common `action` values: `login`, `logout`, `register`, `setup`, `change_password`, `reset_password`, `delete_user`, `create_household`, `leave_household`.

---

## Households

Households allow multiple users to pool their data — combined shifts appear on the shared dashboard, and jobs/templates are visible across members.

### `GET /api/households`

List all households the authenticated user belongs to.

**Response:** Array of household objects with `member_count`.

### `GET /api/households/:id/members`

List members of a household. The caller must be a member.

**Response:** Array of `{ user_id, username, display_name, color, role, joined_at }`.

### `POST /api/households`

Create a new household. The creator is automatically added as an admin member and an `invite_code` is generated.

**Body:**
```json
{ "name": "My Family" }
```

**Response:** Household object including `invite_code`.

### `POST /api/households/join`

Join a household using its invite code.

**Body:**
```json
{ "invite_code": "ABC12345" }
```

**Errors:** `404` if code is invalid; `409` if already a member.

### `PUT /api/households/:id`

Update a household's name. The caller must be a household admin member.

**Body:** `{ "name": "New Name" }`

### `DELETE /api/households/:id`

Delete a household. The caller must be a household admin member. Removes all memberships and invitations.

### `DELETE /api/households/:id/leave`

Leave a household. If the caller is the last admin, the household is deleted.

### `DELETE /api/households/:id/members/:userId`

Remove another member from a household. The caller must be a household admin.

**Errors:** `403` if not a household admin.

### `POST /api/households/:id/invite`

Send an invitation to another user by username.

**Body:**
```json
{ "username": "bob" }
```

**Errors:** `404` if username not found; `409` if already a member or invitation is pending.

**Response:** Invitation object.

### `GET /api/households/:id/invitations`

List pending invitations sent for a specific household. The caller must be a household admin.

### `GET /api/households/invitations/mine`

List all pending invitations received by the authenticated user.

**Response:** Array of `{ id, household_id, household_name, inviter_username, status, created_at }`.

### `POST /api/households/invitations/:id/accept`

Accept a pending invitation. Adds the user to the household.

**Errors:** `404` if invitation not found or not addressed to the caller.

### `POST /api/households/invitations/:id/decline`

Decline a pending invitation.

---

## Shifts

### `POST /api/shifts`

Create a new shift.

**Body:**
```json
{
  "date": "2026-03-10",
  "hourly_rate": 15.00,
  "hours_worked": 8.0,
  "tip_mode": "total",
  "tip_input": 120.00,
  "notes": "Busy Saturday night",
  "job_id": 1
}
```

- `date` — `YYYY-MM-DD` format (required)
- `hourly_rate` — non-negative number (required)
- `hours_worked` — non-negative number (required)
- `tip_mode` — `"total"` or `"per_hour"` (required)
- `tip_input` — non-negative number (required)
- `notes` — string, optional (default `""`)
- `job_id` — integer or null, optional (default `null`)

Server computes: `total_tips`, `wage_total`, `grand_total`.

**Response:** `{"id": 1, "total_tips": 120, "wage_total": 120, "grand_total": 240}`

### `GET /api/shifts`

List shifts. Soft-deleted shifts are excluded.

**Query params:**
- `from` — start date (`YYYY-MM-DD`)
- `to` — end date (`YYYY-MM-DD`)
- `user_id` — filter by user (admin can pass any user_id; non-admins can only filter within their household)

Returns shifts joined with user display name/color and job name/color. Ordered by date DESC.

### `PUT /api/shifts/:id`

Update a shift. Same body as POST. You must own the shift or be an admin.

### `DELETE /api/shifts/:id`

Soft-delete a shift (sets `deleted_at` timestamp). You must own it or be an admin.

### `POST /api/shifts/:id/restore`

Restore a soft-deleted shift (clears `deleted_at`).

---

## Jobs

### `GET /api/jobs`

List all jobs visible to the current user, ordered by name ascending. Includes `tip_payment` and `archived` fields.

### `POST /api/jobs`

**Body:**
```json
{
  "name": "Restaurant ABC",
  "default_rate": 15.00,
  "color": "#3ecf8e",
  "overtime_threshold": 40,
  "overtime_multiplier": 1.5,
  "tip_payment": "cash"
}
```

- `name` — 1–100 chars (required)
- `default_rate` — non-negative number (default `0`)
- `color` — hex color (default `#f5a623`)
- `overtime_threshold` — weekly hours before OT (default `40`)
- `overtime_multiplier` — OT pay multiplier (default `1.5`)
- `tip_payment` — `"cash"` or `"paycheck"` (default `"cash"`)
  - `"cash"` — tips received nightly in cash; excluded from paycheck gross but still taxed
  - `"paycheck"` — tips included in the paycheck

### `PUT /api/jobs/:id`

Update a job. Same body as POST.

### `DELETE /api/jobs/:id`

Archive a job (sets `archived = 1`). Does not delete associated shifts.

---

## Templates

### `GET /api/templates`

List all templates visible to the current user, with joined job name.

### `POST /api/templates`

**Body:**
```json
{
  "name": "Weeknight Shift",
  "job_id": 1,
  "hourly_rate": 15.00,
  "hours_worked": 6.0,
  "tip_mode": "total",
  "tip_input": 80.00,
  "notes": ""
}
```

### `DELETE /api/templates/:id`

Permanently delete a template.

---

## Goals

### `GET /api/goals`

List all goals, newest first.

### `GET /api/goals/history`

Return historical goal performance — past periods with target and actual amounts.

**Response:** Array of `{ period, period_type, target_amount, actual_amount, achieved }`.

### `POST /api/goals`

**Body:**
```json
{
  "period": "weekly",
  "target_amount": 1000.00,
  "active": true
}
```

- `period` — `"weekly"` or `"monthly"`
- `target_amount` — non-negative number
- `active` — boolean, optional (default `true`)

Setting `active: true` deactivates any other goal with the same period.

### `PUT /api/goals/:id`

Update a goal. Same body as POST.

### `DELETE /api/goals/:id`

Permanently delete a goal.

---

## Settings

### `GET /api/settings`

Returns all settings from the `meta` table as key-value pairs, including:
- `pay_week_start_day` — 0 (Sun) through 6 (Sat), default 1 (Mon)
- `pay_period_type` — `weekly`, `biweekly`, `semimonthly`, or `monthly`
- `pay_period_anchor` — anchor date for biweekly periods

### `PUT /api/settings` _(admin only)_

Update settings. Body is a flat object of key-value pairs:
```json
{
  "pay_week_start_day": "1",
  "pay_period_type": "biweekly",
  "pay_period_anchor": "2026-01-06"
}
```

---

## Tax Configuration

### `GET /api/tax-config`

List all tax/deduction items for the current user, ordered by `sort_order`.

### `PUT /api/tax-config/:id`

Update a single tax config item by ID.

**Body:** `label`, `rate` (0–1 decimal), `flat_amount`, `enabled`.

### `POST /api/tax-config`

Add a new tax/deduction item.

**Body:** `key` (unique slug), `label`, `rate` (0–1), `flat_amount`.

### `DELETE /api/tax-config/:id`

Remove a tax/deduction item.

---

## Tax Profile Presets

Preset rate bundles based on 2026 IRS brackets and national-average state rates. Designed for quick setup — **not** a substitute for tax advice.

### `GET /api/tax-profiles`

List all presets and current tax metadata.

**Response:**
```json
{
  "profiles": [
    {
      "id": "single_50k",
      "filing_status": "Single",
      "income_range": "~$42k–$60k/yr",
      "label": "Single, ~$50k/yr – no dependents",
      "approx_annual_income": 50000,
      "description": "...",
      "rates": {
        "federal": 0.08,
        "state": 0.05,
        "social_security": 0.062,
        "medicare": 0.0145
      }
    }
  ],
  "meta": {
    "tax_year": 2026,
    "last_updated": "2026-03-16T06:23:13.567Z",
    "next_auto_refresh": "2026-07-01T05:00:00.000Z",
    "refresh_policy": "Automatically refreshes baseline rates every 6 months (Jan 1 / Jul 1).",
    "note": "State rates shown are approximate national averages. Adjust to your state."
  }
}
```

Filing statuses available: `Single`, `Head of Household`, `Married Filing Jointly`.

### `POST /api/tax-profiles/apply/:profileId` _(admin only)_

Apply a preset to `tax_config`, overwriting Federal, State, Social Security, and Medicare rates.

**Response:** `{ "success": true, "profile": "single_50k", "applied": { "federal": "updated", ... } }`

### `POST /api/tax-profiles/refresh` _(admin only)_

Force an immediate baseline rate refresh, bypassing the normal six-month schedule.

**Response:**
```json
{
  "success": true,
  "refreshed": true,
  "year": 2026,
  "next_at": "2026-07-01T05:00:00.000Z",
  "meta": { ... }
}
```

> The auto-refresh can be disabled by setting the `tax_auto_refresh_enabled` meta key to `0` in the database.

---

## Paychecks

### `GET /api/paychecks`

List recorded paychecks for the current user, newest first.

**Response:** Array of paycheck objects with `period_start`, `period_end`, `gross_amount`, `net_amount`, `notes`.

### `POST /api/paychecks`

Record an actual paycheck.

**Body:**
```json
{
  "period_start": "2026-03-09",
  "period_end": "2026-03-15",
  "gross_amount": 700.00,
  "net_amount": 560.00,
  "notes": "Spring break week"
}
```

### `DELETE /api/paychecks/:id`

Delete a paycheck record.

### `POST /api/paychecks/:id/apply-rates` _(admin only)_

Recalculate stored net amounts for a paycheck using the current tax config rates.

---

## Paycheck Estimate

### `GET /api/paycheck-estimate`

Returns the estimated paycheck for the current pay period.

**Response:**
```json
{
  "period": {
    "type": "Weekly",
    "start": "2026-03-09",
    "end": "2026-03-15",
    "total_days": 7,
    "elapsed_days": 5,
    "remaining_days": 2
  },
  "current": {
    "wages": 600.00,
    "tips": 400.00,
    "cash_tips": 300.00,
    "paycheck_tips": 100.00,
    "gross": 1000.00,
    "paycheck_gross": 700.00,
    "hours": 40.0,
    "shifts": 5
  },
  "previous": {
    "gross": 950.00,
    "hours": 38.0,
    "shifts": 5
  },
  "taxes": [
    {"key": "federal", "label": "Federal Income Tax", "rate": 0.22, "flat_amount": 0, "amount": 220.00}
  ],
  "total_tax": 350.00,
  "net_pay": 350.00,
  "projected_gross": 980.00,
  "projected_net": 490.00,
  "projected_cash_tips": 420.00
}
```

Key fields:
- `current.gross` — total earnings (wages + all tips)
- `current.cash_tips` — tips from jobs configured as "cash" (already received nightly)
- `current.paycheck_tips` — tips from jobs configured as "paycheck"
- `current.paycheck_gross` — wages + paycheck tips only (what appears on your check)
- `total_tax` — taxes on ALL earnings including cash tips
- `net_pay` — paycheck gross minus total tax (your check amount)
- `projected_cash_tips` — projected cash tips through end of period

---

## Analytics & Summary

### `GET /api/summary`

Returns earnings aggregations for multiple periods.

**Query params:** `user_id` — optional filter.

**Response keys:** `this_week`, `last_week`, `biweekly`, `this_month`, `last_month`, `ytd`, `all_time`

Each contains: `shifts`, `total_hours`, `total_wages`, `total_tips`, `grand_total`, `avg_shift`, `avg_tips_per_hour`.

### `GET /api/trends`

Aggregated time-series data for charts.

**Query params:** `period` — `"week"` (12 weeks), `"month"` (12 months, default), or `"year"` (3 years).

Returns array of: `period`, `shifts`, `total_hours`, `total_wages`, `total_tips`, `grand_total`, `tips_per_hour`, `effective_rate`.

### `GET /api/overtime`

Current-week overtime status.

**Response:** `total_hours`, `threshold`, `multiplier`, `regular_hours`, `overtime_hours`, `is_overtime`.

### `GET /api/tax-estimate`

Estimated tax liability.

**Query params:** `period` — `"month"` or `"ytd"` (default).

**Response:** `wages`, `tips`, `total`, `est_wage_tax`, `est_tip_tax`, `est_total_tax`, `wage_rate`, `tip_rate`.

### `GET /api/analytics/effective-rate`

Average effective hourly rate by day of week (0=Sun through 6=Sat).

### `GET /api/analytics/extremes`

Top and bottom shifts by grand total.

**Query params:** `count` — number of results per list (default 5).

**Response:** `{"best": [...], "worst": [...]}`

### `GET /api/analytics/tip-ratio`

Monthly tip percentage trend.

Returns array of: `period`, `total_tips`, `grand_total`, `tip_pct`.

---

## Export & Import

### `GET /api/export/pdf`

Download a styled PDF report.

**Query params:**
- `from`, `to` — date range (optional; omit for all-time)
- `label` — custom title for the report header

Returns `application/pdf`.

### `GET /api/export/csv`

Download shifts as CSV.

**Query params:** `from`, `to` — date range (optional).

Returns `text/csv`.

### `POST /api/import/csv`

Import shifts from CSV. Send the raw CSV text as the request body with any content type.

**Limits:** 5 MB max.

**Response:** `{"imported": 15, "errors": 2}`

---

## Validation Errors

All endpoints validated by Zod return `400` with:

```json
{
  "error": "Validation failed",
  "details": {
    "field_name": ["Error message"]
  }
}
```
