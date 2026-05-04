# Mobile App Feature Gap

**Identified:** 2026-05-04 via graphify knowledge graph analysis  
**Priority:** Low — mobile app is not a current focus

## Summary

The React Native mobile app (`mobile/`) only covers basic shift CRUD (log shift, edit shift, view list). It is missing significant features that are available in the web frontend.

## Missing Features

| Feature | Web | Mobile |
|---------|-----|--------|
| Jobs management | ✓ | ✗ |
| Employers management | ✓ | ✗ |
| Templates (quick-log) | ✓ | ✗ |
| Goals & goal progress | ✓ | ✗ |
| Fixed recurring income | ✓ | ✗ |
| Tax configuration | ✓ | ✗ |
| Paycheck estimate | ✓ | ✗ |
| Analytics / trend charts | ✓ | ✗ |
| Dashboard summary cards | ✓ | ✗ |
| PDF / CSV export | ✓ | ✗ |
| Household management | ✓ | ✗ |
| Settings | ✓ | ✗ |

## Current Mobile Screens

- `LoginScreen` — auth (login only; no signup flow exposed in navigation)
- `SignupScreen` — exists but may not be wired into the nav stack
- `HomeScreen` — shift list with basic summary
- `AddShiftScreen` — create a shift (no job selector — job_id is not populated)
- `EditShiftScreen` — edit a shift

## Notes

- The graph flagged Community 7 (mobile screens) as poorly connected — mobile screens share no graph edges with Jobs, Templates, Goals, or other domain entities, confirming the feature gap.
- `ShiftCard` component exists in `HomeScreen.js` but is not a separate file, making it hard to reuse.
- When implementing job support, the `AddShiftScreen` and `EditShiftScreen` will need a job picker backed by `GET /api/jobs`.
