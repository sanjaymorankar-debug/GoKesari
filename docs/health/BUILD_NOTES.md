# GoKesari Health — build notes for contributors (20-Nov-2026)

Working tree: `/Users/agtci/GoKesari/.claude/worktrees/health` (branch `feat/gokesari-health`, based on
`feat/consultant-booking`, PR #425). Owner brief: the GoKesari Health build prompt of 20-Nov-2026 10.51 IST.

## Ground rules

- **Additive only.** New files, routes and screens. Do not change existing behaviour. Shared files
  (`src/server/db/schema.ts`, `src/server/db/health-schema.ts`, `drizzle/*`, `src/server/config/rules.ts`,
  `src/server/notifications/*`, `src/server/authz/permissions.ts`, `src/server/services/audit.ts`,
  `src/lib/board/*`, `src/server/payments/*`, `src/server/services/scheduled-notices.ts`,
  `src/server/consult/*`) are edited **only by the lead**. If you need a change there, write it in your
  final report (exact snippet) instead.
- **One database** (CLAUDE.md): ordinary single-database code, `ON CONFLICT` is fine. External side
  effects (gateway, SMS, e-mail, push) never inside `db.transaction` — after commit.
- All times stored UTC, shown IST (`ist()` in `src/components/health/api.ts`, `formatSlot` in
  `src/lib/consult/time.ts`).
- No clinical text in logs, URLs, events or audit rows (ids and statuses only).
- NMC ethics: never pay or credit a doctor for a referral / suggestion; doctors never see prices or
  commissions of what they suggested.

## What exists (read these first)

| Area | File |
|---|---|
| Tables (schema `health`) | `drizzle/0154_health.sql`, Drizzle: `src/server/db/health-schema.ts` (exported from `@/server/db/schema`) |
| Vocabulary / labels | `src/lib/health/constants.ts` |
| Rule `health` (switch + settings: storeResponseMinutes, rxCommissionBp, rentalCommissionBp, careCommissionBp, primeGstBp, primeGraceDays, primeTermDiscountBp, payPerBooking, feePerBookingPaise, telephonyProvider, freeListingManualApproval …) | `src/server/config/rules.ts` → `getRule("health")` |
| Access, consent checks, access log, doctor status | `src/server/health/access.ts` (`requireHealthEnabled`, `requirePatientAccess`, `patientAudience`, `doctorStatus`, `logRecordAccess`, `firmUserIds`, `shopsOfUser`, `isHealthStaff`, `canBreakGlass`) |
| Events + live push | `src/server/health/events.ts` (`publishHealthEvent({name, userIds, shopId, subjectId, payload}, client)`; names in `HEALTH_EVENT_NAMES`) |
| Live stream / client hook | `src/app/api/health/stream/route.ts`, `src/components/health/live.tsx` (`useHealthLive`, `<LiveRefresh/>`, `chime()`) |
| Timeline + number series | `src/server/health/timeline.ts` (`addTimeline(client, {...})`, `nextNumber(client, series)`) |
| Patients, family, notice | `src/server/health/patients.ts` |
| Consent | `src/server/health/consent.ts` |
| Doctors, clinic settings, `toJpeg()` | `src/server/health/doctors.ts` |
| Consultations, check-in | `src/server/health/consultations.ts` |
| Prescriptions (issue / amend / view / PDF / verify), `prescriptionAccess` (PATIENT / DOCTOR / STORE) | `src/server/health/prescriptions.ts` |
| Health booking (patient + share choice + suggestion), Today, queue, walk-in | `src/server/health/booking.ts` (`createHealthBooking` calls `care.onHealthBookingCreated` and `prime.onHealthBookingCreated`) |
| Timed jobs | `src/server/health/scheduled.ts` dispatches scheduled_notices kinds `HEALTH_RX_EXPIRY` → `rx-orders.expireRxOrderNotice`, `HEALTH_RENTAL_DUE` → `rentals.sendRentalDueNotice`, `HEALTH_PRIME_RENEWAL` / `HEALTH_PRIME_EXPIRY` → `prime.sendPrimeRenewalNotice` / `applyPrimeExpiryNotice`. Schedule with `scheduledNotices` insert (see `src/server/consult/notify.ts` `scheduleReminders`). |
| Payments | purposes `HEALTH_RX_ORDER`, `HEALTH_RENTAL`, `HEALTH_PRIME` are wired in `src/server/payments/purpose-handlers.ts` / `ended-handlers.ts` to `rx-orders.ts` / `rentals.ts` / `prime.ts` (`on…PaymentCaptured(intent, client, afterCommit)`, `on…PaymentEnded(intent, to, client)`). Pattern to copy: `src/server/consult/payments.ts` (`startBookingPayment`, `refundBookingMoney`, `settleBooking` → `financial_adjustments`). Sandbox checkout in tests: `simulateSandboxCheckout` (`src/server/payments/sandbox-checkout.ts`). |
| Notifications | `notify({userId, type: NOTIFICATION_TYPES.HEALTH_*, title, body, actionUrl, channels: ["PUSH"], metadata})` — types already added (`HEALTH_RX_*`, `HEALTH_CARE_*`, `HEALTH_RENTAL*`, `HEALTH_PRIME*`, `HEALTH_CALL_MISSED`, `HEALTH_VERIFICATION`, `HEALTH_BREAK_GLASS`). |
| Support tickets | `createTicket` in `src/server/aftercare/support-tickets.ts` (see `raiseDispute` in `src/server/consult/bookings.ts`, category `BOOKING`) |
| Consultant engine (bookings, members, categories, verification, files) | `src/server/consult/*`, `docs/consult-booking-2026-11/README.md` |
| UI conventions | `src/components/consult/*` (client components, `api()` helper, `Panel`, `Tile`, `Chip`), pages `src/app/consult/**`, `src/app/shop/consult/**`, `src/components/ui.tsx` (`PageHeader`). Mobile-first, large touch targets (min-h-11), Tailwind tokens `kesari-*`, `ink-*`, `leaf-*`, `var(--gk-line)`. Add `data-testid` on key controls. |
| API route pattern | `route()`, `ok()`, `parseBody` from `src/server/api/handler.ts`; `requireUser()` from `src/server/authz/guards.ts`; `enforceRateLimit(key, RATE_LIMITS.MUTATION)`; see `src/app/api/consult/**`. |

## Tests

- Integration tests run against real PostgreSQL. Each contributor has their **own** local database
  (do not use another's — tests truncate tables):
  `TEST_DATABASE_URL=postgresql://agtci@localhost:5432/gk_health_<x> npx vitest run tests/integration/<file>`
  (needs the sandbox off for localhost:5432). Fixture helpers: `tests/helpers/fixtures.ts`
  (`resetDatabase`, `createUser`, `createShop`), rules: `setRule` / `clearRuleCache` from
  `@/server/services/settings`. A verified doctor fixture: copy the `beforeEach` of
  `tests/integration/consult-bookings.test.ts` + `verifyProfile(...)` + `saveDoctorProfile(...)`.
- `npx tsc --noEmit -p tsconfig.json` must stay clean (ignore the pre-existing `barcode-scanner.tsx` error).
