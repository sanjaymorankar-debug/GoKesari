# Consultant appointments — testing report

Owner brief 20-Nov-2026 09.37 IST · PR #425 (`feat/consultant-booking` → `staging`) · all times IST.
Owner instruction 20-Nov-2026 (mid-build): **"all module should be tested together"** — every run below
that says "full suite" runs every module's tests in one run, not only the new ones.

## Runs

| Run | When (IST) | Where | Scope | Result |
|---|---|---|---|---|
| R1 | 20-Nov-2026 10.08 | Local, PostgreSQL 18.6 (scratch DB) | Consultant unit (19) + integration (26) | **45 / 45 passed** |
| R2 | 20-Nov-2026 10.26 → 11.06 | Local, PostgreSQL 18.6 | **Full suite, all modules** (`npx vitest run`, 287 files) | **3,587 / 3,591 passed**. 4 failures, none a product defect: D-CB-03 (consult test data reused between runs; fixed) and 3 `migrate-on-build` timeouts while the dev server and browser ran on the same machine — that file passes **7 / 7** on its own (11.00). Re-run of the consult + touched files at 11.08: **105 / 105** |
| R3 | 20-Nov-2026 10.33–10.52 | Local dev server (port 3310), demo data | Browser walkthrough: customer, consultant, admin; phone width | **Pass** — 1 display defect found and fixed (D-CB-01), 1 loading-state defect fixed (D-CB-02) |
| R4 | 20-Nov-2026 10.49 | Local dev server | QA guest tier `tests/qa/guest/consult.spec.ts` | **4 / 4 passed** |
| R5 | — | GitHub CI on PR #425 | Lint, typecheck, full unit + integration suite | pending |
| R6 | — | test.gokesari.com | Migration 0153 by the Test database workflow; QA suite all tiers (all modules) + TC-CON signed-in checks | pending (staging queue) |
| R7 | — | gokesari.com | Production database workflow (snapshot first), release, post-deploy check, guest QA tier | pending (owner approval) |

## R1 — what the consultant tests prove

| Area | Checks |
|---|---|
| Slot engine | sessions, buffer, leave / holiday / block / extra hours, notice, window, group capacity, multi-person slots, team picking, load-balanced "any member", next free time, utilisation, IST helpers |
| Policy and money | early / late / consultant cancellation refunds, no-show refund, reschedule limits, GST-inclusive split, settlement and commission |
| Setup | publish blocked without the council certificate; verification PENDING → VERIFIED; shop must be approved; only owner / staff change setup |
| Booking | free → CONFIRMED with reminders; **3 concurrent requests for one time → exactly 1 succeeds**; the exclusion constraint refuses an overlapping row inserted directly; any-member; team (2 members); group capacity 3 |
| Online payment | hold ≥ 9 min, second customer refused while held, sandbox success → CONFIRMED / PAID / receipt `GKC/2026-27/000001`; failure → EXPIRED / FAILED and the time is free; hold lapse → released; **late capture after the time was taken → full refund** |
| Consultant actions | advance online + balance at the visit; completion too early refused; wrong code refused and counted; customer sees the code, consultant does not; completed → settlement +₹500 credit, −₹40 commission (2% of ₹2,000); rating updates the profile |
| Cancel / reschedule | customer early → full refund; late → 50%; consultant → full with a reason; reschedule twice then refused; reassign to another member; manual approval → decline refunds in full; no-show keeps the payment (Standard policy) |
| Privacy | other customer refused; firm and staff looks logged; team member sees only their own calendar; files stored encrypted, signed link bound to the viewer, other customer refused |
| Disputes, admin, discovery | ticket category BOOKING linked to the firm, second dispute refused; staff list, report, category with commission and RCI; search near / far, category, language, mode, fee, name, date; rule off refuses bookings |

## R3 — browser walkthrough (local)

Evidence: `Test_Cases_Tracking/Evidence/consult-booking-2026-11-20/local/` (9 screenshots).

| Step | Result |
|---|---|
| Find a Consultant (desktop and 375 px phone) | Pass — 2 demo firms, modes, fee, next free time; no sideways scroll |
| Consultant page: services, modes, any available / members, day strip, morning / afternoon / evening slots (IST) | Pass |
| Visitor details, notes, policy summary, consent; "Pay ₹400 and book" | Pass |
| Sandbox gateway page → Pay (success) → back on the booking | Pass — CONFIRMED, code shown, ₹400 paid, receipt GKC/2026-27/000001, auto-assigned Dr Neha Rao |
| Seller Central → Orders → Appointments | Pass — tiles (today, upcoming, to accept, earnings ₹400, utilisation), team side by side, colour legend |
| Booking drawer (consultant) | Pass — payment, office map pin, ICS / Google Calendar, visitor details, no completion code |
| Admin → Consultants → Verification | Pass — certificate via signed link (200 PDF; forged signature 403), Verify → clinic and both doctors VERIFIED, owner notified; access log rows written |

## Defects

| ID | Found | Severity | Defect | Fix | Status |
|---|---|---|---|---|---|
| D-CB-01 | R3, 10.42 | Low | Booking page showed "Paid at visit: Free" for ₹0 | Amounts paid / due / refunded show ₹0; only prices say "Free" | Fixed (165670ce → 13c482cd) |
| D-CB-02 | R3, 10.50 | Low | Admin verification list showed "Nothing here" while still loading | "Loading…" until the first answer | Fixed (13c482cd) |
| D-CB-03 | R2, 10.30 | Low (test) | Category test failed on a second run: categories outlive the test reset | Unique category name per run | Fixed |
| D-CB-04 | Review, 10.45 | Medium | `/operator/consult` and `/shop/consult` answered 404 to a guest while the module was off (guest-access sweep expects sign-in first) | Sign-in check before the module switch | Fixed (71f10461) |
| D-CB-05 | Review, 10.45 | Low | Firm and booking action routes validated the action before checking access | Access checked first (404 to outsiders) | Fixed (71f10461) |
