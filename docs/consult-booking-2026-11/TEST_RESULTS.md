# Consultant appointments — testing report

Owner brief 20-Nov-2026 09.37 IST · PR #425 (`feat/consultant-booking` → `staging`) · all times IST.
Owner instruction 20-Nov-2026 (mid-build): **"all module should be tested together"** — every run below
that says "full suite" runs every module's tests in one run, not only the new ones.

## Runs

| Run | When (IST) | Where | Scope | Result |
|---|---|---|---|---|
| R1 | 20-Nov-2026 10.08 | Local, PostgreSQL 18.6 (scratch DB) | Consultant unit (19) + integration (26) | **45 / 45 passed** |
| R2 | 20-Nov-2026 10.26 → 11.06 | Local, PostgreSQL 18.6 | **Full suite, all modules** (`npx vitest run`, 287 files) | **3,587 / 3,591 passed**. 4 failures, none a product defect: D-CB-03 (consult test data reused between runs; fixed) and 3 `migrate-on-build` timeouts while the dev server and browser ran on the same machine — that file passes **7 / 7** on its own (11.00). Re-run of the consult + touched files at 11.08: **105 / 105** |
| R2b | 20-Nov-2026 13.05 | Local, PostgreSQL 18.6 — fresh test DB, all 154 migrations | After merging `staging` (newspaper subscriptions #423 took migration 0152, so this module's is now **0153**): migration journal, tile board, mobile app, cron schedule, consultant unit + integration, newspaper unit + integration | **135 / 135 passed**. Typecheck clean apart from `@zxing/browser` (barcode scanner), which the shared local `node_modules` lacks — not this change; CI installs it |
| R3 | 20-Nov-2026 10.33–10.52 | Local dev server (port 3310), demo data | Browser walkthrough: customer, consultant, admin; phone width | **Pass** — 1 display defect found and fixed (D-CB-01), 1 loading-state defect fixed (D-CB-02) |
| R4 | 20-Nov-2026 10.49 | Local dev server | QA guest tier `tests/qa/guest/consult.spec.ts` | **4 / 4 passed** |
| R5 | 20-Nov-2026 13.07 → 13.29 | GitHub CI on PR #425 (merge commit 76a19dd2); again on fix PR #433 (34 min) | Lint, typecheck, full unit + integration suite (all modules), mobile app, Android APK (preview + production) | **All passed** |
| R6 | 20-Nov-2026 13.41 → 14.29 | test.gokesari.com (staging queue) | #425 merged 13.41 IST and deployed (consult pages and APIs answer; rule off); guest QA tier, all modules | **Failed: 1 check, TC-QA-001** — 4 cases (TC-CON-006, 019, 020, 026) and 2 journeys were in the plan but not declared in the suite (D-CB-06). Fix PR "Fix #425" (staging-fix); everything else in the guest tier passed |
| R6b | 20-Nov-2026 15.11 → 15.55 | test.gokesari.com (staging queue) | Fix PR #433 merged and deployed; CI, migration, deploy, post-deploy check, guest QA tier (all modules, incl. TC-QA-001) | **Passed — staging-verified 15.55 IST**; queue resumed |
| R7 | 20-Nov-2026 15.58 → 16.02 | test.gokesari.com | Rule `consultBooking` switched on (15.58, Admin settings). Consultant guest + signed-in checks, two runs | Run 1 (15.58): 19 passed, 1 failed (TC-CON-022), 11 blocked — all three causes were the test, not the app (D-CB-07, D-CB-08, CB-24). Run 2 (16.02) after the fix: **22 / 22 automatable checks passed** on desktop + 1 on phone; 4 online-payment checks need the Cashfree sandbox (R8); 4 manual |
| R8 | 20-Nov-2026 16.02 → 16.15 | test.gokesari.com, Cashfree **sandbox** via the "Sandbox payment" workflow (test UPI only) | TC-CON-015, TC-CON-016, TC-CON-010 (refund), SC-51 | **Passed** — paid → CONFIRMED with receipt; early cancel → full refund settled; failed attempt → time released at the hold's end. 1 defect: D-CB-09 (fixed) |
| R9 | 20-Nov-2026 16.03 → 17.20, re-runs 17.28 → 18.09 | test.gokesari.com | **Full suite, all modules** (guest + signed-in; local-only checks not run on staging by rule), then re-runs of the affected files after the test wallets were refilled | **656 passed, 12 failed rows (8 IDs), 194 blocked, 697 not run by rule. No new product defect.** Every consultant check passes. The 12 failed rows: known test data (2 old COD orders, E-16; returns list 13 pages long; one shared order delivered before its phone repeat), known defects D-152 and D-78 / D-144, and SD-06 (check already corrected in #426) — see R9 below |
| R10 | 20-Nov-2026 22.01 → 23.37 | gokesari.com | Release #440 (everything on staging up to `000b73ad`: newspapers #423, consultants #425/#433, Puja #427, Health #429, dealers, tagline #430, welcome kit #431), run by the Health session on the owner's 21.58 IST instruction: database restore point, migrations 0150–0156, release, post-deploy check; then the consultant guest checks TC-CON-001..004 | **Passed** — restore point 22.01, 7 migrations applied, live 23.32, post-deploy check 23.35; TC-CON-001..004 desktop 4/4 + TC-CON-001 phone, 23.37. #434 (D-CB-09) not in this release |

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

## R7 — consultant checks on test.gokesari.com (16.02 IST, run 2)

Test consultant: "QA Test Clinic" on shop A (CB-24), two consultants, all-day hours. Desktop project; the phone project repeats the checks marked for phones.

| Case | Result | Seen |
|---|---|---|
| TC-CON-001..004 (guest) | Pass | finder shown; 13 booking / firm / admin APIs answer 401 without a session; private file link 401 |
| TC-CON-005, 021 | Pass | LIVE with 6 services and 2 consultants; found by name; near me 60 m, none from Delhi |
| TC-CON-007, 024 | Pass | free booking CONFIRMED at once, both sides notified |
| TC-CON-008 | Pass | two customers, same time, same moment: 201 and 409 |
| TC-CON-009 | Pass | another customer: 404 / 404; consultant sees the note, not the code |
| TC-CON-010, 011 | Pass | moved twice, third move refused (409), cancelled, time offered again |
| TC-CON-012, 014 | Pass | pay at the visit, payment recorded, receipt GKC/2026-27/…; calendar and dashboard list it |
| TC-CON-013 | Pass | wrong code 422, right code → COMPLETED, rated 5 |
| TC-CON-017, 018 | Pass | admin: 5 views 200; customer and shop owner 403 on GET and POST |
| TC-CON-022 | Pass | 3 of 3 places taken; the 4th refused |
| TC-CON-023 | Pass | team held both; "any available" got the assistant |
| TC-CON-025 | Pass | ticket TKT-000029; a second dispute 409 |
| SC-50 | Pass | found → booked (pay at visit) → paid GKC/2026-27/000003 → COMPLETED with the code → rated 5 |
| TC-CON-015, 016, SC-51 | Blocked in the suite (Cashfree) | done in R8 |
| TC-CON-006, 019, 020, 026 | Manual | integration / unit tests; app needs a phone |

## R8 — online payment on test.gokesari.com (Cashfree sandbox, test UPI)

The site's checkout opens a Cashfree sandbox session (`/orders/pay/session/…`). The session was paid on a GitHub runner by the "Sandbox payment" workflow (CLAUDE.md: this machine cannot reach Cashfree). Only Cashfree sandbox test instruments were used; no card, UPI or bank details were typed into the site.

| Step (IST) | Booking | Result |
|---|---|---|
| 16.02 book online ₹1, 21-Nov 18.05 | CB2611-000029 | PENDING_PAYMENT, time held |
| 16.03 workflow run 44720170104, `upi-success` | CB2611-000029 | **CONFIRMED, PAID ₹1, receipt GKC/2026-27/000004**; events PAID_ONLINE → CONFIRMED |
| 16.05 customer cancels (26 h ahead, early) | CB2611-000029 | CANCELLED by customer, refund ₹1 requested; 18.05 offered again |
| 16.10 Cashfree refund webhook | CB2611-000029 | refund SUCCESS, **REFUNDED ₹1** |
| 16.03 book online ₹1, 21-Nov 22.05; workflow run 44720205711, `upi-failure` | CB2611-000030 | Cashfree keeps the session open for a retry, so the booking waits |
| 16.13 hold lapses (10 min); every-minute job | CB2611-000030 | **EXPIRED, 22.05 offered again** — but payment still "PENDING" and no message to the customer → D-CB-09 |

## R9 — full suite on test.gokesari.com, all modules (owner: "all modules should be tested together")

Suite: this branch (staging 0bc9144 + PR #434's checks). First pass 16.03 → 17.20 IST (2,358 tests, 1 h 17 min) while the staging queue deployed #426 and #427. Re-runs: 17.28 → 18.08 (10 spec files, after a ₹10,000 sandbox top-up of customer 1's test wallet) and 18.09 (2 checks). The latest result of each check counts.

| | Pass | Fail | Blocked | Not run here by rule |
|---|---|---|---|---|
| Desktop | 538 | 8 | 161 | 669 |
| Phone (Pixel 7) | 118 | 4 | 33 | 28 |
| **Total rows** | **656** | **12** | **194** | **697** |

(This morning's staging regression, same suite before the consultant module: 566 / 39 / 217 / 697.)

| Failed check | Why | Class |
|---|---|---|
| TC-COD-001, 002 (desktop + phone), 012 | Customer 1 already has 2 cash-on-delivery orders on the way | Test data (E-16) |
| TC-RET-010, TC-FLD-098 | The refund works (₹70.50 stored as 7050 paise and credited); only the last step fails: after the reload the completed return is no longer on page 1 of shop A's returns (13 pages of test returns) | Test data volume; the check should open the case by number |
| TC-CART-018 (phone) | The shared order of the run was already delivered by later desktop checks; the desktop check passes | Run-order artefact |
| TC-RPAY-001 (desktop + phone) | Rider bank account text | Known defect D-152 |
| TC-FLD-056 | No logo upload | Known defect D-78 / D-144 |
| SD-06 | Staging shop owner has a shop waiting for approval; #426 already makes this check record *blocked* | Check fixed in #426 (E-27) |

Fixed during the run (test data, not the site): **customer 1's test wallet** ran out twice (the suite's own wallet orders spend about ₹6,000 a pass; E-33) — refilled through the "Sandbox payment" workflow (Cashfree sandbox, test UPI: ₹5,000 at 16.20, ₹10,000 at 17.28 IST); **shop owner A's own wallet** (B2B buyer) ₹0 → ₹3,000 the same way (17.15). Shop A / B prepaid wallets were healthy (₹4,928.91 / ₹5,000). Two transient failures during queue deploys (TC-RBAC-004 TLS disconnect, TC-FLD-126) pass on re-run.

Blocked (194) are preconditions staging does not have: shop B / rider 2 sessions (codes go to a mailbox the QA agent does not read), a verified society, features not on staging yet, the Cashfree checkout (4 consultant checks, done in R8), SMS / WhatsApp providers, and checks that wait on an earlier step.

## R10 — production, gokesari.com (release #440)

| Step | When (IST) | Result |
|---|---|---|
| Restore point before migrating ("Production database" run 44774049266, `vps-db-snapshot`) | 22.01 | `prod-db-migrate-2026-11-20-1631-run58` (+ `.dump`) on the database server |
| Migrations | 22.01 | 7 applied (0150–0156, including **0153_consult_bookings** and 0156_health, which switches `consultBooking` on); 157 recorded |
| Release #440 merged into `main` (`release/2026-11-20`, pinned to staging `000b73ad`) | 23.26 | Live (`cf0069d0`) at 23.32 |
| Post-deploy check | 23.35 | Passed |
| TC-CON-001 `/consult` for a guest | 23.37 | Pass, desktop and phone: 200, "Find a Consultant" finder shown, 0 consultants yet, no sideways scroll |
| TC-CON-002 public search | 23.37 | Pass: 0 consultants (none registered on production yet); filtered search answers; bad mode → 422 |
| TC-CON-003 guest refused | 23.37 | Pass: 13 calls (book, my bookings, consultant and admin APIs), all 401 |
| TC-CON-004 private file link | 23.37 | Pass: 401 without a session |

Only guest checks ran on production: no sign-in on gokesari.com and no real-money bookings (those stay with the owner).
Screenshots: `Test_Cases_Tracking/Evidence/consult-booking-2026-11-20/prod/R10-TC-CON-001-consult-{desktop,phone}.png`.
Not in this release: **#434** (D-CB-09 lapsed hold → payment failed + customer told; QA fixes), still in the staging queue; it goes out in a later release.

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
| D-CB-06 | R6, 14.29 | Medium (queue paused) | TC-QA-001: TC-CON-006, 019, 020, 026 and the journeys SC-CON-01 / SC-CON-02 were not declared in the QA suite; the check only recognises `SC-<number>` journey IDs | Journeys renamed **SC-50** / **SC-51** (#426 holds SC-48 / 49); SC-50 is a new signed-in check (find → book, pay at the visit → payment recorded → completed with the code → rated); SC-51 joins the online-payment check, which now also checks the time is offered again; TC-CON-006 / 019 / 020 / 026 declared with `manual()` and the reason (proved by the integration and unit tests, or needs a phone). Local: TC-QA-001 and the guest checks 12 / 12 passed (1 skipped) | Fixed — #433, staging-verified 15.55 |
| D-CB-07 | R7, 15.58 | Low (test) | TC-CON-013, SC-50, TC-CON-025 blocked "no free time": the test consultant on staging (shop A) kept the shop's own hours (10–13, 17–20 IST, Mon–Sat); the set-up only wrote hours when a member had fewer than 7 rows | Set-up always gives both test consultants all-day hours | Fixed (41fb396a, PR #434) — passed in R7 run 2 |
| D-CB-08 | R7, 15.58 | Low (test) | TC-CON-022 failed: the 4th person was accepted into a full group session. Correct behaviour: with "any available" the next person goes to a colleague's session at the same time (`pickMembers`), so capacity is per consultant | The check books one consultant's session | Fixed (41fb396a, PR #434) — passed in R7 run 2 |
| D-CB-09 | R8, 16.15 | Low | After a failed Cashfree attempt the booking expires when its hold lapses (Cashfree keeps the session open for a retry), but its payment stayed "PENDING" and the customer was not told; the gateway's later "expired" found no waiting booking, so nothing corrected it | Hold lapse now sets a PENDING payment to FAILED and sends "Payment for … did not go through — the time was released" (as a refused payment already did). Integration test extended. Local: 45 / 45 consultant tests passed (16.16) | Fixed — PR #434 (staging queue; not yet on gokesari.com) |

