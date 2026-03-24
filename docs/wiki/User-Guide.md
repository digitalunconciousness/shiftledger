# User Guide

ShiftLedger is a single-page app with five main views accessible from the sidebar (or hamburger menu on mobile).

---

## 1. Log Shift

The default view for recording a new shift.

### Fields

- **Date** — defaults to today; use the date picker to backfill
- **Job** — select from your configured jobs (see [[Admin Guide]] for creating jobs). When a job is selected, the hourly rate auto-fills from the job's default rate.
- **Hourly Rate** — your base pay rate for this shift
- **Hours Worked** — total hours (supports decimals, e.g. `6.5`)
- **Tip Mode** — toggle between:
  - **Night Total** — enter the total tips earned for the entire shift
  - **Per Hour** — enter your tip rate per hour; total tips = rate × hours
- **Tip Amount** — the value corresponding to the selected tip mode
- **Notes** — optional free-text field

### Live Preview

As you type, the preview panel updates in real-time showing:
- **Wages**: hourly rate × hours
- **Tips**: calculated based on mode
- **Grand Total**: wages + tips

### Templates

- **Load Template** — select a saved template from the dropdown to pre-fill all fields
- **Save as Template** — after filling in a shift, click to save the configuration for reuse (give it a name)
- Templates are shared across all users

### Submitting

Click **Save Shift** or press `Ctrl+Enter`. On success, a confirmation toast appears and the form resets.

---

## 2. Dashboard

The analytics overview with multiple summary sections.

### Summary Cards

- **This Week / Last Week / Biweekly / This Month / YTD / All Time** — each card shows total earnings, total hours, and shift count
- Cards for the current period include a **% change arrow** comparing to the previous equivalent period (e.g., this week vs last week)

### Overtime Card

Shows your weekly hours against the overtime threshold. Displays regular hours, overtime hours, the threshold, and the OT multiplier. Turns amber when overtime is triggered.

### Tax Estimate Card

Displays estimated YTD tax liability broken down by:
- Wage tax (default 22%)
- Tip tax (default 15.3% — self-employment estimate)
- Combined total

### Paycheck Estimate Card

Shows your estimated paycheck for the current pay period (weekly, biweekly, semimonthly, or monthly — configurable in Settings).

- **Paycheck Gross** — wages + paycheck tips (excludes cash tips you already received nightly)
- **Est. Taxes** — all tax deductions applied to total earnings including cash tips, since they are reported income
- **Est. Net Paycheck** — paycheck gross minus taxes. May be lower than expected when you have cash tips, because tip taxes are withheld from the paycheck
- **💵 Cash Tips (already received)** — shown when you have cash-tip jobs; this is money you took home nightly
- **Total Earnings** — net paycheck + cash tips = your actual take-home for the period
- **Projected** — extrapolation to end of period based on your current earning pace

Expand the **Tax Breakdown** section to see itemized deductions (federal, state, Social Security, Medicare, tip tax, custom).

> Configure pay period type and tax rates in **Settings → Pay Period** and **Settings → Tax & Deduction Rates**. Configure whether tips are cash or paycheck in **Settings → Jobs** (per-job setting).

### Goal Progress

If you have active goals set (weekly and/or monthly), a progress bar shows how far you are toward each target in the current period.

### Day-of-Week Heatmap

A 7-cell heatmap (Mon–Sun) showing average earnings per day, with color intensity based on relative performance. Helps identify your highest-earning days.

### Best/Worst Shifts

Displays your top 5 highest and lowest earning shifts of all time with date, job, and total.

### Trend Charts

Four selectable chart views (powered by Chart.js):
- **Earnings** — total earnings per period
- **Wages vs Tips** — stacked bar chart
- **Tip %** — tip earnings as a percentage of total
- **Effective Rate** — actual earnings per hour worked

Each chart has a period selector: **12 Weeks**, **12 Months**, or **3 Years**.

### User Filter

If multiple users exist, a dropdown at the top lets you filter the dashboard to a specific user or view combined data for all users.

---

## 3. History

A table of all logged shifts with full CRUD capabilities.

### Columns

- Date
- Job (with color indicator)
- User (with color dot)
- Hours
- Rate
- Wages
- **Tips/Hr** — total tips divided by hours worked
- **Total Tips** — the absolute tip amount for the shift
- Grand Total
- Notes
- Actions (Edit / Delete)

### Filtering

- **Date range** — pick a start and end date to narrow results
- **User filter** — show shifts from a specific user or all users

### Editing

Click the **Edit** button on any shift row. The row becomes an inline edit form with all fields editable. Press **Save** to confirm or **Cancel** to discard.

Permissions:
- You can edit your own shifts
- Admins can edit any user's shifts

### Deleting (Soft Delete)

Click **Delete** on a shift. The shift is soft-deleted (not permanently removed). An **Undo** toast appears for a few seconds, allowing you to restore it immediately. Soft-deleted shifts are excluded from all queries and analytics.

Admins can also restore any soft-deleted shift via the API (`POST /api/shifts/:id/restore`).

---

## 4. Reports

Export your data in PDF or CSV format.

### PDF Export

Generates a styled PDF report containing:
- Header with report title and date range
- **Summary grid** — total shifts, hours, wages, tips, avg tips/hr, grand total
- **Shift detail table** — every shift with Date, Job, Hours, Rate, Wages, Tips/Hr, Total Tips, Grand Total, Notes
- Totals row at the bottom

The PDF uses a dark-header design with alternating row shading and automatic page breaks.

### CSV Export

Downloads a `.csv` file with columns: Date, Job, User, Hours, Rate, Wages, Tips/Hr, Total Tips, Grand Total, Tip Mode, Notes.

### CSV Import

Upload a `.csv` file (up to 5 MB) matching the export format. The importer:
- Skips the header row
- Validates date format (`YYYY-MM-DD`)
- Assigns imported shifts to the logged-in user
- Reports how many rows were imported vs how many had errors

---

## 5. Settings

User-specific settings and (for admins) system management. See [[Admin Guide]] for admin-specific features.

All users can:
- View their profile (username, display name, color)
- Change their password
- Change their display name and color

---

## Theme Toggle

Click the **☀/🌙** button in the top bar to switch between dark and light themes. The preference is saved to `localStorage` and persists across sessions.

---

## Keyboard Shortcuts

Press `?` at any time to see the shortcut overlay.

| Key | Action |
|-----|--------|
| `1` | Switch to Log Shift view |
| `2` | Switch to Dashboard view |
| `3` | Switch to History view |
| `4` | Switch to Reports view |
| `5` | Switch to Settings view |
| `Ctrl+Enter` | Save the current shift form |
| `?` | Toggle keyboard shortcut help |

Shortcuts are disabled when a text input or textarea is focused (except `Ctrl+Enter`).

---

## PWA / Mobile App

ShiftLedger is a Progressive Web App. On supported browsers:

1. Visit the app in Chrome/Edge/Safari
2. Look for the **"Install"** or **"Add to Home Screen"** prompt
3. Once installed, ShiftLedger appears as a standalone app with its own icon

The service worker caches the app shell (HTML, manifest, icon) so the UI loads even when offline. API calls use a network-first strategy — if offline, they return a JSON error rather than crashing.

---

## Mobile Layout

On screens narrower than 900px:
- The sidebar collapses and is accessible via the **☰ hamburger button** in the top bar
- All tables become horizontally scrollable
- The shift form and dashboard stack vertically
