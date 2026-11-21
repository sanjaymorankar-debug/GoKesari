# Franchise module — testing report

> **Current: section 0 (final brief of 21-Nov-2026 08.06 IST).** Sections 1–7 are the earlier briefs' runs, kept for
> the record; their 91-zone / 5 km cases were replaced by section 0.

**Report time:** 21-Nov-2026 (IST; see the times in the table).

- **Branch:** `feat/franchise-pmr-2026-11`.
- **PR:** [#446](https://github.com/sanjaymorankar-debug/GoKesari/pull/446), into `staging`.
- **Brief:** owner prompt of 20-Nov-2026 22.50 IST, §15 (testing) and M3.

| Environment | State |
|---|---|
| Local (PostgreSQL 18, databases `gk_franchise_test` / `gk_franchise_full` / `gk_franchise_dev`) | **Run — results below** |
| Test server (test.gokesari.com) | **Not yet**: runs when the staging queue merges PR #446 (CI, migration, deploy, post-deploy check, guest QA), then the franchise checks below on staging |
| Production (gokesari.com) | **Not started**: the release needs the owner's OK (one release at a time; 23.00 IST window) |

## 0. Final brief of 21-Nov-2026 08.06 IST — local runs, 21-Nov-2026 (IST)

| Environment | State |
|---|---|
| Local (PostgreSQL, `gk_franchise_test`, `gk_franchise_dev`) | **Run — results below** |
| Test server (test.gokesari.com) | **Not yet**: PR #446 goes back into the staging queue (CI, migration, deploy, post-deploy check, guest QA); then the franchise checks on staging |
| Production (gokesari.com) | **Not started**: needs the owner's OK (one release at a time, 23.00 IST window) |

### 0.1 Zone data checks (`scripts/franchise/build-zone-seed.py`, 21-Nov-2026 08.40 IST)

| Check | Result |
|---|---|
| 50 zones, 50 clusters, 196 areas read from the owner's files | PASS |
| Every clustered area maps to exactly one known area (short names → full names) | PASS — 189 mapped |
| Unzoned = Koregaon Bhima, Sanaswadi, Shikrapur, Ranjangaon, Saswad, Khed Shivapur, Rajgurunagar (Khed) | PASS |
| Average of the provisional index | 99.4 |
| Fee rule reproduces every fee and tier of §5.3 | PASS — 20 Premier, 12 Standard, 18 Emerging |
| Migration applies on a copy of the test database; rollback leaves no franchise table | PASS |

### 0.2 Automated tests (local)

| Suite | Cases | Result | Time (IST) |
|---|---:|---|---|
| `tests/integration/franchise-pmr.test.ts` (§11: zones, areas, fees, status, booking, coupons, 8 cases × 2 fees, parity, free teams, split, recurring, upgrade, tail, month end, reminders, team rules) | 34 | **34 passed** | 21-Nov-2026 10.05 |
| `tests/unit/franchise-zones.test.ts` (tier boundaries ±10% / 10.1%, rounding, seed reproduction, description, coupon maths, cases A1–B4, parity) | 21 | **21 passed** | 21-Nov-2026 10.10 |
| `tests/unit/franchise-bonus.test.ts` (TC1–TC6 at one decimal, 30 points → 25.3%, cap, downgrade) | 15 | **15 passed** | 21-Nov-2026 10.10 |
| `tests/unit/franchise-lib.test.ts` | 25 | **25 passed** | 21-Nov-2026 10.10 |
| Mobile (`mobile/`, incl. new zone / chart links) | 61 | **61 passed** | 21-Nov-2026 (UI helper) |
| `npx tsc --noEmit`, eslint on changed files | — | clean | 21-Nov-2026 10.15 |
| Regression: all unit tests + franchise, dealer, registration, wizard, onboarding, referral, settings and cron integration tests (131 files) | 1,712 | **1,712 passed** | 21-Nov-2026 09.04 IST |

### 0.3 Browser checks (local dev server, localhost:3720)

| Page | Check | Result |
|---|---|---|
| `/franchise/book` | 50 zones; tier chips 20 / 12 / 18; filters region / tier / availability / fee; cards with tier, Provisional tag, fee + GST, % vs average, business + source + as-of, areas, description, slots; "Bookings open soon" while booking is off | PASS |
| `/franchise/book` at 375 px | No horizontal scroll; filters stack (evidence `docs/franchise/evidence/10-final-book-phone.jpg`) | PASS |
| `/dealer/commission-chart` | A1–A4 and B1–B4 rates and ₹ amounts on ₹1,000 / ₹2,500 exactly as §3.3; recurring rules | PASS |
| Admin console tabs | Built and type-checked; not clicked through (needs an admin session) | To check on staging |

### 0.4 Defects found and fixed during the build

| # | Defect | Fix |
|---|---|---|
| D-F1 | Zone reference tables had a foreign key to dealers (reserved-for), so emptying users in tests would have emptied the zones | Plain id, checked by the service |
| D-F2 | The as-of date showed as 21-11-2026 | Shown as 21-Nov-2026 |
| D-F3 | The local browser served the old booking page from the service-worker cache | Not a code defect (cache cleared) |

## 1. Territory import validation (brief §5)

Run with `scripts/franchise/build-zone-seed.py` against `Pune_PMR_Restructured_Zones_Max_5K_Cr.xlsx` on
20-Nov-2026 at 22.58 IST. **ALL PASS:**

| Check | Expected | Result |
|---|---|---|
| Rows / unique Zone IDs | 91 / 91 | 91 / 91 ✅ |
| Clusters | 7 | 7 ✅ |
| Original + split | 52 + 39 | 52 + 39 ✅ |
| Estimated shops | 2,49,900 | 2,49,900 ✅ |
| Largest zone | Zone 43, ₹4,914 Cr | 43, ₹4,914.00 Cr ✅ |
| Smallest zone | Zone 68, ₹1,188 Cr | 68, ₹1,188.00 Cr ✅ |
| Any zone ≥ ₹5,000 Cr | none | none ✅ |
| C1…C7 zones / shops / ₹ Cr / largest | brief §5 table | all 7 rows match ✅ |
| Total annual | ₹3,01,655 Cr | ₹3,01,654.80 Cr (₹3,01,655 rounded) ✅ |
| Workbook defects (headers, TOTAL row, summary missing row 96) | not copied | only input columns are read; money is computed in the app ✅ |

After migration `0157`, the database holds:

- 91 zones in 7 clusters;
- 2,49,900 estimated shops;
- ₹3,01,654.80 Cr annual area business;
- 60 distinct PIN codes, with 411002 in 8 zones, 411014 in 6 and 411017 in 5.

## 2. Automated test cases (local)

| ID | Area | Case | Expected | Actual | Result | Executed (IST) |
|---|---|---|---|---|---|---|
| FR-IMP-01 | Import | 91 zones, 52 + 39, cluster table, min / max, < ₹5,000 Cr | brief §5 | as expected | PASS | 21-Nov-2026 00.0x |
| FR-IMP-02 | Import | 411002 resolves to 8 zones | 1A,1B,2A,2B,2C,3A,3B,7A | as expected | PASS | 〃 |
| FR-REG-01 | Pune only | Region not enabled → no zones | 0 zones | 0 | PASS | 〃 |
| FR-BND-01 | Boundary | Unapproved zone "Coming soon", reserve refused | refused | "coming soon (boundary not yet approved)" | PASS | 〃 |
| FR-BND-02 | Boundary | 9 km circle refused, NEEDS_SPLIT, split 66 → 66-1 / 66-2 | refused, split | as expected; shop totals enforced | PASS | 〃 |
| FR-BND-03 | Boundary | Overlap refused; point in exactly one zone | "It overlaps zone 4." | as expected | PASS | 〃 |
| FR-CAP-01 | Capacity | 10 parallel bookings of one zone | exactly 2 (slots 1, 2) | 2; a 3rd insert refused by the DB | PASS | 〃 |
| FR-CAP-02 | Capacity | Same owner, second slot of the same zone | refused | "already hold" | PASS | 〃 |
| FR-CAP-03 | Capacity | Cart [10, 4] with 4 full → nothing reserved | all-or-nothing | 10 still free; 4 named | PASS | 〃 |
| FR-CAP-04 | Capacity | Expired hold free at read time and by the job; cancel frees | freed | as expected | PASS | 〃 |
| FR-PAY-01 | Payment | Payment failed → slots released | PAYMENT_FAILED | as expected | PASS | 〃 |
| FR-PAY-02 | Payment | Duplicate capture webhook | one activation, one code | as expected | PASS | 〃 |
| FR-PAY-03 | Dates | Expiry = activation + 12 m − 1 day 23:59:59 IST; tail = end of year 3; GKF code | as expected | as expected | PASS | 〃 |
| FR-LAU-01 | Launch | first_limit_reached at 2 areas; closed → no price, payment refused; post-launch fee resumes | as expected | as expected | PASS | 〃 |
| FR-LAU-02 | Launch | owners_only closes at 1 owner | closed | closed | PASS | 〃 |
| FR-LAU-03 | Launch | Pending reservation holds the last place | refused | "being paid for" | PASS | 〃 |
| FR-COD-01 | Code | GKF inside zone OK; outside refused; no location refused | as expected | as expected | PASS | 〃 |
| FR-COM-01 | Commission | One-time 25%: ₹1,000 → ₹250, ₹2,500 → ₹625, owner only, no Model A attribution; refund reverses | as expected | as expected | PASS | 〃 |
| FR-COM-02 | Commission | Monthly 25% of the actual 2%: ₹1,00,000 → ₹2,000 → ₹500; idempotent; bonus 0% "No performance formula" | as expected | as expected | PASS | 〃 |
| FR-COM-03 | Bonus | Published formula, tier 9 pp capped at 5 pp → ₹500 + ₹100; explanation | as expected | as expected | PASS | 〃 |
| FR-COM-04 | Monthly run | Month not over → skipped | skipped | skipped | PASS | 〃 |
| FR-EXP-01 | Reminders | 30 / 15 / daily; once a day; not before 10:00 IST; copy to ceo@agtci.com; in-app / push / SMS / WhatsApp logged | as expected | as expected | PASS | 〃 |
| FR-EXP-02 | Renewal | Refused 31+ days out; opens within 30 days; +12 months, same slot | as expected | as expected | PASS | 〃 |
| FR-EXP-03 | Expiry | EXPIRED; renewal refused; code refused "This franchise area has expired." in that zone, valid in the other; CEO + admin alert; rebook = new allocation | as expected | as expected | PASS | 〃 |
| FR-EXP-04 | Expiry | Last area expires → code closed completely | SUSPENDED | as expected | PASS | 〃 |
| FR-EXP-05 | Tail | Earns after expiry until tail end, then stops | as expected | as expected | PASS | 〃 |
| FR-EXP-06 | Digest | 09:00 IST digest once a day to the CC list | 1 row | 1 | PASS | 〃 |
| FR-MA-01 | Model A | Four cases on ₹1,000: D 200; A 200 + D 40; A 200 + TL 40 + D 30; TL 200 + D 40 | as brief §2.3 | as expected | PASS | 〃 |
| FR-MA-02 | Model A | Four cases on ₹2,500: 500; 500 + 100; 500 + 100 + 75; 500 + 100 | as brief §2.3 | as expected | PASS | 〃 |
| FR-MA-03 | Model A | TL deactivated → agent under the dealer; earlier shop 4/3, later shop 4 to the dealer | as expected | as expected | PASS | 〃 |
| FR-MA-04 | Model A | TL adds an agent (never a TL); same mobile in a team refused; GKT- / GKA- codes | as expected | as expected | PASS | 〃 |
| FR-MA-05 | Model A | Transfer to another dealer: admin only; old place inactive; new GKA- code; same PAN | as expected | as expected | PASS | 〃 |
| FR-UNIT-* | Helpers | 26 unit cases: IST dates (month ends), reminders (17 per area), tail modes, launch rules, badges, geometry (5 km, bow-tie, overlap, GeoJSON), payout day | as expected | as expected | PASS | 20-Nov-2026 23.02 |

Evidence:

- `tests/integration/franchise-pmr.test.ts` (32 cases);
- `tests/unit/franchise-lib.test.ts` (26 cases).

## 2b. Brief of 21-Nov-2026 00.30 IST — run 21-Nov-2026 00.50–01.00 IST (local)

| ID | Case | Result |
|---|---|---|
| TC1 | January, first month: 0 opening, 70 new → 10 points → 0.10% → 25.10%, rating 5.10 | PASS (unit) |
| TC2 | February: 70 opening (₹70L), 75 new, ₹1 Cr → 615 points → capped 5% → 30%, rating 10.0; 30% on all shops; 75 × ₹250 | PASS (unit) |
| TC3 | March: opening 145 → baseline ₹1.45 Cr; a deactivated shop leaves next month's opening | PASS (unit) |
| TC4 | 120 opening, 45 new, ₹1.1 Cr → 0 points, 25%, rating 5.0 | PASS (unit) |
| TC5 | Refund after payout → next month's adjustment (−₹200 on a ₹40,000 refund at 25%) | PASS (unit + integration, locked month unchanged) |
| TC6 | Slot ₹50K → 75 points → 25.75%; a change saved now applies from the 1st of next month; other settings now | PASS (unit + integration) |
| FR-B-01 | One code per area: area 4's code refused in area 10 and the other way round; shop tagged to area 10 | PASS |
| FR-B-02 | Admin override tags a shop outside its area; reason and admin logged; a second tag refused (permanent) | PASS |
| FR-B-03 | Live month: ₹1,00,000 delivered → ₹500 at 25%; first month baseline ₹0 | PASS |
| FR-B-04 | Past month: DRAFT rerunnable → lock writes the ledger line inside the month → locked month never recalculated | PASS |
| FR-B-05 | Statement PDF built (%PDF) and e-mailed once to the dealer and ceo@agtci.com | PASS |
| FR-B-06 | Expired area: no bonus, 25% continues in the tail, nothing after the tail end | PASS |
| FR-B-07 | 5 km areas overlap by default; the no-overlap rule still works when switched back | PASS |

Totals: franchise integration 37/37, franchise unit 39/39 (TC1–TC6 13), dealer / cron / referral / unit regression 1,418/1,418 (111 files).

## 3. Browser checks (local dev server, localhost:3720)

The booking checks used a desktop width and phone width (375 px).

| ID | Check | Result | Evidence |
|---|---|---|---|
| FR-UI-01 | `/franchise`: Pune-only badge, "25 of 25 launch places left", fee, illustration with its disclosure, cluster table matching brief §5, rules, free-dealer section | PASS | page text, 20-Nov-2026 23.38 IST |
| FR-UI-02 | `/franchise/book`: cluster chips (All 91, C1 22 … C7 9), filters, sort, zone cards with badges and the disclosure | PASS | `docs/franchise/evidence/01-book-desktop.jpg` |
| FR-UI-03 | Select 2 areas → sticky bar "2 areas selected · ₹3,00,000 + GST"; C5 chip → "7 of 91 areas" | PASS | `docs/franchise/evidence/02-book-phone-c5-cart.jpg` |
| FR-UI-04 | Phone width 375 px: no sideways scroll (scrollWidth 375) | PASS | 〃 |
| FR-UI-05 | Public APIs: zones (C5, Zone ID order, badges), offer (₹1,50,000, 25 places), boundaries (4 features) | PASS | JS check |
| FR-UI-06 | Guest gets 401 on `/api/franchise/me`, `POST /api/franchise/bookings` and `/api/admin/franchise`; `/franchise/my` redirects to sign-in | PASS | JS check, redirect seen |
| FR-UI-07 | Admin boundary approval refuses the overlapping 9A versus 4 (dev data) | PASS | seed output |

## 4. Regression

Each run was against the branch with the franchise changes.

| Suite | Result |
|---|---|
| Dealer, cron, referral and unit tests (110 files) | 1,402 passed, 3 failed, then fixed: `cron-schedule` ×2 (new job added) and 1 TIERED case changed on purpose by brief case 4 (team lead's own shop now pays the dealer 4%) |
| Mobile app tests | 59 / 59 passed |
| TypeScript (`tsc --noEmit`) | clean |
| ESLint on changed files | clean |
| Full Vitest suite (all integration + unit) on a fresh migrated database | 3,775 / 3,779 passed; the 4 failures are environmental (§6) |

## 5. Defects

| # | Severity | Found | State |
|---|---|---|---|
| FD-1 | Medium | Dates passed raw into SQL fragments failed in postgres-js (`ERR_INVALID_ARG_TYPE`) | Fixed in the branch: cast with `::timestamptz` |
| FD-2 | Low | Reminder count was 0 when e-mail is disabled locally (the count was of deliveries) | Fixed: it counts sends attempted; delivery status is in the log |
| — | — | Pre-existing, not franchise: `health-core.test.ts` "books, checks in …" fails near midnight IST ("That time was just taken"). It fails the same way on the Health branch's own code. | Not caused by this PR; for the Health owner |

Open: none known in the franchise code.

## 6. Full suite

Run on 20/21-Nov-2026, finished about 00.00 IST, against a fresh migrated database: **301 files, 3,779 tests — 3,775 passed, 4 failed**. None of the 4 is caused by this PR; each fails the same way on the Health branch without the franchise code:

| File | Failed | Cause |
|---|---|---|
| `health-core.test.ts` | 1 | Booking-slot test near midnight IST ("That time was just taken") |
| `migrate-on-build.test.ts` | 3 | `CONNECT_TIMEOUT 127.0.0.1:5432` and timeouts creating scratch databases on the busy local Postgres; CI runs these on its own service |

## 7. Still to do (M3)

1. **Test server**, after the queue merges #446:
   - check the migration and deploy;
   - on staging, as admin, open booking, approve two zone boundaries (circle) and book with the staging test dealer account through the Sandbox payment page;
   - run a shop registration with the GKF code inside and outside the zone;
   - check reminders using `clockOffsetDays`, then set it back to 0;
   - run the guest QA.
2. **Production**, after the owner's OK:
   - smoke-test the new pages and APIs, plus login, shop registration, an order and a payment;
   - book the hidden zone `T-QA1` once with an internal account, then void it;
   - verify the 91 zones and totals on production;
   - check the apps against production.
3. **Apps**: signed builds 1.11.0 (12) and store submission. These need the owner's EAS, Play Console and App Store Connect access.

## Sign-off

The franchise module passes every local check: import, capacity (DB-enforced), payment handling, launch counters,
codes and geo, commission, expiry, renewal, tail, and the Model A cases. It is **not yet tested on test.gokesari.com
or gokesari.com**.
