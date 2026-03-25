# Admin Guide

This page covers features available only to users with the **admin** role.

---

## Roles

ShiftLedger has two roles:

- **Admin** — full access: manage users, edit/delete any shift, access all settings, view audit log
- **Regular** — can log/edit/delete their own shifts, view the shared dashboard, export data

The first account created during [[Getting Started|first-run setup]] is always an admin.

---

## User Management

Admins access user management from the **Settings** view (view 5).

### Creating a New User

1. Go to **Settings**
2. In the **User Management** section, fill in:
   - **Username** — alphanumeric and underscores, 2–50 characters, must be unique
   - **Display Name** — shown on shifts and in the UI
   - **Password** — minimum 4 characters
   - **Color** — optional; a color from the palette is auto-assigned if omitted
3. Click **Create User**

New users are created as **regular** (non-admin) by default. To promote a user to admin, use the API:

```bash
curl -X PUT http://localhost:3000/api/users/<USER_ID> \
  -H "Content-Type: application/json" \
  -H "Cookie: sl_session=<YOUR_SESSION>" \
  -d '{"is_admin": true}'
```

### Self-Registration

If you want users to create their own accounts, they can use `POST /api/auth/signup` without admin involvement. This is primarily used by the mobile app. The first signup is granted admin status; all subsequent signups are regular users.

### Resetting a User's Password

Admins can reset any user's password without knowing the current one:

```bash
curl -X POST http://localhost:3000/api/users/<USER_ID>/reset-password \
  -H "Content-Type: application/json" \
  -H "Cookie: sl_session=<YOUR_SESSION>" \
  -d '{"new_password": "newpassword"}'
```

### Editing a User

Admins can update any user's:
- Display name
- Color
- Password
- Admin status (`is_admin: true/false`)

Regular users can only update their own display name, color, and password.

### Deleting a User

Admins can delete any user **except themselves** (self-deletion is blocked to prevent lockout). Deleting a user:
- Removes all their active sessions (logs them out immediately)
- Permanently deletes the user record
- **Does not** delete their shifts — shifts remain in the database with a `user_id` reference that no longer resolves (they'll show "Unknown" in the UI)

---

## Managing Jobs

Jobs represent roles or work locations. Any authenticated user can create jobs, and jobs are visible to household members through shared data visibility.

### Creating a Job

1. In **Settings → Jobs**, fill in the Add Job form:
   - **Name** — the employer/location name (required)
   - **Default Rate** — auto-fills the hourly rate when this job is selected
   - **Color** — used for the job indicator dot in the history table
   - **Tips Paid As** — how tips are received for this job:
     - **Cash (Nightly)** — tips are given in cash at the end of each shift (default)
     - **On Paycheck** — tips are included in the paycheck
2. Click **Add Job**

When selecting a job on the Log Shift form, the hourly rate auto-fills from the job's default rate.

### Editing a Job

Click **Edit** on any job in the jobs list to open the Edit Job modal. All fields are editable:
- Job Name, Default Rate, Color
- OT Threshold — weekly hours before overtime kicks in (default: 40)
- OT Multiplier — pay multiplier for overtime hours (default: 1.5×)
- Tips Paid As — Cash (Nightly) or On Paycheck
- Employer link (optional) — associates the job to an Employer record
- Tip calculator rounding toggle — controls whether team tip splits are rounded for that job

### Tip Payment Method

The **Tips Paid As** setting controls how the paycheck estimator treats tips for shifts logged under this job:

- **Cash (Nightly)** — tips are excluded from the paycheck gross (you already received them), but tip taxes are still applied since cash tips are reported income. This means your estimated paycheck will be lower because it covers taxes on money you already took home.
- **On Paycheck** — tips are included in the paycheck gross alongside wages.

This is configured per-job, so if you have multiple jobs with different tip policies, each is handled correctly.

### Archiving a Job

Deleting a job actually **archives** it (sets `archived = 1`). Archived jobs no longer appear in the job dropdown but historical shifts retain their job association.

---

## Managing Employers

Employers are separate records you can link to jobs and fixed recurring income entries.

From **Settings → Employers**:
1. Add an employer name.
2. Optionally enable **No Tax** for tax-exempt employers.
3. Save.

When **No Tax** is enabled, earnings tied to that employer are excluded from taxable-income calculations in the app's tax/paycheck logic.

Deleting an employer archives it and automatically clears any employer links from related jobs and fixed incomes.

---

## Managing Fixed Recurring Income

Use **Settings → Fixed Income** to track recurring income that is not logged as shifts (for example stipends, retainers, or guaranteed monthly payments).

Each fixed income entry supports:
- Optional employer link
- Amount
- Recurrence: weekly, biweekly, semimonthly, monthly, or custom
- Optional notes

For custom recurrence, provide either an interval (in days) from an anchor date or explicit custom dates.

Archived fixed incomes are hidden from active calculations and lists.

---

## Managing Households

Households allow multiple users to pool their data and see each other's shifts on a shared dashboard.

### Creating a Household

1. Go to **Settings → Households**
2. Click **Create Household** and enter a name
3. The new household is created and you are automatically added as an admin member
4. An **invite code** (8-character alphanumeric) is generated — share this with users who should join

### Inviting Members

Two ways to add members:

**By invite code** — share the code with the user; they enter it in Settings → Households → Join Household

**By username invitation** — send a direct invitation from the household settings:
1. Open the household's member list
2. Enter the target user's username and click **Invite**
3. The user will see a pending invitation in their Settings → Households panel
4. They can accept or decline

### Household Roles

- **Admin** — can rename the household, invite/remove members, and delete the household
- **Member** — can view combined data; cannot manage the household

The household creator is automatically set as an admin. Admins can promote other members.

### Removing Members

A household admin can remove any member from the household. The removed user's data is no longer visible to the household, but their own shifts are unaffected.

### Leaving a Household

Any member can leave a household at any time. If the last admin leaves, the household is deleted automatically.

### Data Visibility

When users share a household:
- The Dashboard shows combined shifts from all members
- The History view can be filtered by individual user or shows all combined
- Jobs and templates are shared across household members
- Each user's shifts remain owned by that user — only data visibility is shared

---

## Managing Goals

Goals are income targets that display as progress bars on the Dashboard.

### Creating a Goal

From the Dashboard, set a goal with:
- **Period** — `weekly` or `monthly`
- **Target Amount** — the dollar amount you're aiming for

Only one goal per period can be active at a time. Creating a new active goal for the same period automatically deactivates the previous one.

---

## Pay Period Configuration

Configure your pay period type in **Settings → Pay Period**:

- **Weekly** — resets every week on your configured start day
- **Biweekly** — every two weeks from an anchor date
- **Semimonthly** — 1st–15th and 16th–end of month
- **Monthly** — full calendar month

The pay week start day is also configurable (default: Monday).

---

## Tax & Deduction Rates

Configure tax rates in **Settings → Tax & Deduction Rates**. Default items:

| Key | Label | Default Rate |
|---|---|---|
| `federal` | Federal Income Tax | 22% |
| `state` | State Income Tax | 5% (national avg) |
| `social_security` | Social Security | 6.2% |
| `medicare` | Medicare | 1.45% |
| `tip_tax` | Tip Tax (Self-Employment) | 15.3% |

You can adjust rates, add custom deductions with flat per-period amounts, enable/disable individual items, and delete items you don't need. These rates drive the Paycheck Estimate card on the Dashboard.

> **Note:** These are rough estimates for budgeting purposes, not tax advice.

---

## Tax Profile Presets

Presets are pre-calculated effective tax rate bundles based on **2026 IRS brackets** and national-average state rates. They are designed for fast setup without needing to manually calculate rates.

Find them in **Settings → Tax Profile Presets**.

### Applying a preset

1. Choose a **Filing Status** (Single, Head of Household, Married Filing Jointly).
2. Choose your **Income Range** from the dropdown.
3. Preview the rates shown below the dropdown.
4. Click **Apply Preset** — this overwrites your Federal, State, Social Security, and Medicare rates in Tax & Deduction Rates. Your Tip Tax and any custom deductions are not changed.

### Automatic baseline refresh

The app automatically refreshes the baseline `tax_config` rates twice a year — on **January 1** and **July 1** — based on an internal year-indexed rate table. This keeps the defaults current without manual intervention.

The last refresh time, next scheduled refresh, and active tax year are visible in the meta line below the preset selector.

### Force refresh (admin)

To apply the latest baseline rates immediately:

1. Go to **Settings → Tax Profile Presets**.
2. Click **Refresh Baseline Now**.
3. Confirm the prompt — this overwrites Federal, State, Social Security, Medicare, and Tip Tax rates.

The status line below the button shows the exact time the refresh ran and when the next automatic refresh is due.

> To disable automatic refreshes, set the `tax_auto_refresh_enabled` key to `0` in the `meta` database table.

---

## Audit Log

The audit log records sensitive operations across the application. View it at **Settings → Audit Log** (admin only).

Logged events include:
- User logins and logouts
- Account creation (setup, register, signup)
- Password changes and admin resets
- User deletions
- Household creation and membership changes

Each entry records the **actor** (who performed the action), the **action type**, the **target** (affected user or resource ID), and a timestamp.

To view via API:
```bash
curl http://localhost:3000/api/audit-log \
  -H "Cookie: sl_session=<YOUR_SESSION>"
```

---

## Shift Ownership

- Every shift is tagged with the `user_id` of who created it
- Regular users can only edit/delete their own shifts
- Admins can edit/delete **any** user's shifts
- The History view shows a colored dot next to each shift indicating which user logged it
- Dashboard and History both support a user filter dropdown to view one user's data or all combined (including household members)

---

## Session Management

- Sessions are stored server-side in the `sessions` table
- Each session has a 30-day expiration
- Session tokens are signed with HMAC-SHA256 using the `SESSION_SECRET`
- Tokens are stored as SHA-256 hashes in the database (the raw token is never persisted)
- Deleting a user invalidates all their sessions immediately
- Logging out deletes the specific session from the database
- Mobile clients use Bearer tokens and can rotate them via `POST /api/auth/refresh`
