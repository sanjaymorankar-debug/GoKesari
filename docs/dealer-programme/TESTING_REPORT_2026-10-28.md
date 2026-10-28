# Dealer Programme — Testing Report

GoKesari Authorized Dealer & Merchant Acquisition Programme · 28 Oct 2026 · branch `staging`

**Summary**

- All eight build steps are done and on `staging` (latest dealer commit `f588580`).
- **Automated tests:** 86 of 86 dealer-programme tests pass. With the approval, document,
  onboarding-wizard, seller-verification and split checks run beside them, 209 of 209 pass.
- **CI on GitHub:** the full suite passes on the one-database and the two-database layouts, up to
  `c89cf0b`. Runs for the later commits were still queued when this report was written.
- **Staging (test.gokesari.com):** 45 cases — 21 passed, 1 failed (fixed since), 23 blocked.
  The blocked cases need signed-in operator, shop-owner and dealer test accounts, and a Cashfree
  sandbox payment; see §4.
- **Production:** not released. All four feature flags stay **off** there.

---

## 1. What was tested

| Step | Module(s) | Automated tests | Result |
|---|---|---|---|
| 1 | Feature flags, geo areas, DEALER role, fee slabs | 10 | Pass |
| 2 | Dealer registration, documents, codes / link / QR, employees, legacy distributors | 14 | Pass |
| 3 | Attribution, leads, dealer-assisted registration, duplicates, `?ref=`, Employee ID | 14 | Pass |
| 4 | Instant approval on GST/PAN + gateway fee, ready-for-upload e-mail | 14 | Pass |
| 5 | Commission rules, ledger, cap, payouts, reversals, rating and bonus | 13 | Pass |
| 6 | Dealer board, admin dealer overview, document requirements | 3 | Pass |
| 7 | Support services: charges, quote, wallet / online pay, tickets, cancel / refund | 13 | Pass |
| 8 | Coverage map and targets, performance score, activation and 30-day activity | 5 | Pass |
| | **Total** | **86** | **86 pass** |

Each test file states the build-prompt scenarios it covers (for example step 7: scenarios 57–67).
Tests run against real PostgreSQL. CI runs them on both database layouts: one database, and the
seller / customer split.

**Checked in the browser (local), desktop and 375 px phone width:**
- Support services: live price (120 products = ₹1,766.46); a wallet shortfall message; a free
  request opening ticket TKT-000001; the admin charges page.
- Coverage map, performance score (matches a hand calculation, 72.9) and the activation tab.
- The dealer board's link to a shop's Support services page.

---

## 2. Changes made after review

| Change | Commit |
|---|---|
| Instant approvals: "Pending" lists only shops still waiting (a shop approved by an admin without documents no longer shows there) | `6db91cd` |
| Owner decision: a shop approved without its documents holds the dealer's activation commission and rating credit until the documents are verified | `9e3e1b7` |
| Dealer board links each shop to its Support services page (build prompt §3.10) | `c9ea939` |
| Admin → Dealers: the "All" filter lists every dealer (staging defect D-1) | `f588580` |

The other session's approval-flow changes (admin approval without documents, deferred follow-ups,
document reminders) and the onboarding wizard step 1 were reviewed against the dealer programme.
No conflict remains; the dealer tests pass together with theirs.

---

## 3. Staging pass — test.gokesari.com

Full table: [STAGING_TEST_RESULTS_2026-10-28.md](STAGING_TEST_RESULTS_2026-10-28.md).

| Area | Pass | Fail | Blocked |
|---|---|---|---|
| Setup (flags on) | 1 | 0 | 0 |
| Step 1 | 5 | 0 | 1 |
| Step 2 | 3 | 1 | 4 |
| Step 3 | 3 | 0 | 3 |
| Step 4 | 1 | 0 | 1 |
| Step 5 | 1 | 0 | 2 |
| Step 6 | 1 | 0 | 2 |
| Step 7 | 1 | 0 | 6 |
| Step 8 | 3 | 0 | 1 |
| Flags off | 1 | 0 | 1 |
| Phone width | 1 | 0 | 2 |
| **Total** | **21** | **1** | **23** |

**Passed on staging:**
- The feature-flags page and its change log.
- Geo areas, and the Pune-only district limit.
- These admin pages load at desktop and phone width: commission, instant approvals, support
  services, claims, document requirements and all three analytics tabs.
- Area targets: set, rejected when invalid, removed.
- The `?ref=` link pre-fills the code and shows the Employee ID field.
- With the flags off, the dealer and support APIs answer "not available".

**Defect D-1** (the "All" dealer filter showed no dealers): fixed in `f588580`.

**Observations (not defects):**
- At phone width the analytics tables scroll sideways inside their box; nothing hints that more
  columns are off to the side.
- The Google map on `/shop/register` did not load in headless Chrome. Check it in a normal browser.

**Feature flags on staging:** all four are on for Pune (`MH-PUN`) only, since 28 Oct 16:36 UTC.

---

## 4. Still to test on staging

| What | Needs |
|---|---|
| Operator is refused on flags, commission and area targets | An operator session on staging (sign-in code by e-mail) |
| Dealer application → approval → code, link, QR, employees | A dealer-applicant account and its mobile OTP; the owner's go-ahead to approve a test dealer on staging |
| Shop registered through a dealer: attribution, leads, duplicates, dealer-assisted | The test dealer above and a shop-owner session |
| Instant approval with a gateway-paid fee | A shop-owner session and a payment through the "Sandbox payment" workflow (Cashfree sandbox data only) |
| Commission ledger, rating, dealer board | The flows above |
| Support services from the shop side: wallet pay, ticket, cancel and refund, online pay | A shop-owner session, a shop-wallet credit, and the "Sandbox payment" workflow |
| `/dealer` and `/shop/support-services` at phone width | Dealer and shop-owner sessions |

No real cards, UPI IDs or bank accounts were used. No money moved.

---

## 5. Release status

| Environment | Code | Flags | Database |
|---|---|---|---|
| Local | All steps | Tests switch them per case | Migrations 0101–0111 |
| Staging | All steps | All on, Pune only | 0101–0111 applied (Test database run on `ea7eecb`) |
| Production | Not released | All off | Not migrated |

**Production release** goes staging → main as one release, with a post-deploy check, in an
owner-approved window. Staging also carries other work that would ship with it: the approval
queue, the onboarding wizard step 1, registration-fee changes and the region-move documents.
After release the flags stay off; switching them on (Pune first) is a separate owner decision.

---

## 6. Documents

- [ADMIN_GUIDE.md](ADMIN_GUIDE.md) — admin and operator guide
- [DEALER_ONBOARDING_GUIDE.md](DEALER_ONBOARDING_GUIDE.md) — guide for dealers and their employees
- [REUSE_GAP_ANALYSIS.md](REUSE_GAP_ANALYSIS.md) — design, decisions and build sequence
- `DEALER_PROGRAMME_TRACKER_2026-10-28.xlsx` — product tracker (module status per environment)
