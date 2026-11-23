# HDMS — test execution and defect report (23-Nov-2026)

Run locally against real PostgreSQL 17 (Postgres.app, database `gk_hdms_test`, all migrations to 0190),
Node 24, vitest 4. Partner calls go to the in-process sandbox simulator (MOCK); no real delivery partner API
is reachable or integrated. Screens checked by hand on a local dev server (`gk_hdms_dev`) as an admin.

## Mandatory scenarios

| # | Scenario | Result | Evidence |
|---|---|---|---|
| 1 | Shop-owned rider delivery | PASSED | `hdms-delivery.test.ts` "prefers an available shop rider"; existing `fulfilment-options` suite (own delivery, customer code) in regression |
| 2 | GoKesari rider delivery | PASSED | "offers a free GoKesari rider before any partner"; existing `delivery-assignment*` suites |
| 3 | Shadowfax sandbox booking | **BLOCKED – EXTERNAL DEPENDENCY** | no public API, no sandbox keys or agreement. Same flow PASSED against the sandbox simulator ("books the sandbox partner…") |
| 4 | Provider serviceability failure | PASSED | "records a serviceability failure and leaves the order ready" |
| 5 | API timeout | PASSED | "times out a slow partner quote, logs it" |
| 6 | Duplicate booking prevention | PASSED | "prevents duplicate bookings when two allocations race" (one row, one partner call) |
| 7 | Duplicate webhook prevention | PASSED | "…duplicates and late events change nothing" |
| 8 | Rider allocation failure | PASSED | "falls back to a partner from the rider search when no GoKesari rider is free"; circuit-breaker test |
| 9 | Customer cancellation | PASSED | "customer cancellation cancels the partner booking" |
| 10 | Shop cancellation | PASSED | "shop cancellation cancels the partner booking" |
| 11 | Provider cancellation | PASSED | "partner cancels before pickup: order back to ready and the engine tries again" |
| 12 | Failed delivery | PASSED | "failed delivery after pickup, then return to shop" |
| 13 | Return to shop | PASSED | same test (order RETURNED) |
| 14 | OTP verification | PASSED (existing) / NOT APPLICABLE (partners) | existing `shop-wallet-delivery-otp`, `fulfilment-options` suites; a partner's rider is verified by the partner's own door check once integrated |
| 15 | Incorrect OTP | PASSED (existing) | existing `shop-wallet-delivery-otp` suite |
| 16 | Delivery pricing calculation | PASSED | `hdms-engine.test.ts` pricing (min, km, kg, express, peak IST incl. midnight, cap, promo) |
| 17 | Shop-sponsored delivery | PASSED | unit "shop pays" + "charges the shop its share … through the existing shop wallet" |
| 18 | GoKesari-sponsored delivery | PASSED | unit "GoKesari sponsored, fully and capped", "free above basket value" |
| 19 | Provider reconciliation | PASSED | "reconciles a partner invoice against delivered bookings" (mismatch → disputed, clean → reconciled → paid) |
| 20 | Live tracking | PASSED | "polling advances a sandbox booking"; route test "customer sees partner tracking with a masked rider number" |
| 21 | Unauthorized shop access | PASSED | `hdms-delivery-routes.test.ts` "a shop cannot touch another shop's rider or order"; customers refused on admin routes |
| 22 | API credential security | PASSED | credentials stored `v1:` encrypted, never in responses or audit; https-only base URL; unintegrated partner cannot be enabled; non-integrated webhooks 401 |
| 23 | Multiple shops and multiple providers | PASSED (shops) / PARTLY BLOCKED (providers) | multiple shops in route tests; multi-partner ranking unit-tested; a live multi-partner run needs a second integrated partner |
| 24 | Scheduled dairy delivery | PASSED | "leaves scheduled (subscription / slot) orders to the scheduled workflow"; existing subscription suites in regression |
| 25 | Existing marketplace regression | see "Regression" | full vitest suite |

Also checked by hand (local dev server, admin): dashboard figures, active list, booking detail, simulate
PICKED_UP → order PICKED_UP, simulate DELIVERED on a COD order → order DELIVERED through the existing
completion path (no server errors), all 15 sections render (HTTP 200), phone width 375 px without page-level
horizontal scroll. Migration 0190 re-run (no error, no duplicate seed rows); rollback script then re-apply.

## Regression

REGRESSION_RESULT_PLACEHOLDER

## Defect register

| ID | Description | Severity | Root cause | Fix | Retest |
|---|---|---|---|---|---|
| D-01 | Every partner allocation failed with "argument must be of type string … Date" | Critical | `Date` interpolated into a raw `sql` template in `pricingRuleFor` (postgres-js does not serialise it there) | use drizzle `lte` / `gt` operators | PASSED |
| D-02 | Stored fee split did not add up (customer + shop + GoKesari ≠ total) | High | booking overwrote the rule's total with the partner's quote but kept the rule's shares | keep the rule's split; partner cost stays in `quoted_fee_paise` | PASSED |
| D-03 | A partner jumping from ASSIGNED straight to DELIVERED (missed webhook) was ignored; order stuck ASSIGNED | High | booking machine allowed only step-by-step moves | forward jumps allowed (never backward) | PASSED |
| D-04 | Route test expected 400 for an invalid base URL | Low (test) | the project answers 422 for validation | test corrected | PASSED |
| D-05 | Admin pages failed lint (`Date.now()` during render) | Low | time window computed in the component | moved into the read-model functions | PASSED |

Risk R-1 (not a defect, documented): drizzle applies only migrations whose journal `when` is above the last one
applied. 0190 uses 1793270000000; any branch merged later must use a higher value (the dealer-platform
migrations 0177–0181 use lower ones — if PR #503 merges after this PR, its timestamps must be raised first).
