# Staging test: dealer commission structure of 5 Nov 2026 (PR #347)

05-Nov-2026, 14.10 IST · test.gokesari.com · build of `staging` deployed 13.05 IST (PR #347 merged 13.04 IST,
service-worker version `2026-11-05T07:35:14Z`) · migration 0144 applied by the "Test database" workflow
(153 recorded, newest `0144_dealer_commission_no_cap`).

## Result in one line

**The 20 / 4 / 2 structure works end to end on staging:** a shop registered with an agent's code, paid
₹999 + GST and was approved; the agent, the team lead and the main dealer each got exactly their share,
all of it at once, with no order wait and no cap. Two findings for the release, one cosmetic defect.

## Findings

| # | Finding | Effect | Action |
|---|---|---|---|
| F1 | **A saved rule keeps its old values.** On staging `dealerTieredCommission` had been saved in Admin → Settings on 03-Nov with the 02-Nov values (20/5/3, 60 % at activation, 10 orders in 90 days). The new code defaults apply only where the rule was never saved. | On any site where the rule was saved, the release alone does **not** switch to 20/4/2. | Before the release: check the saved value on production (read-only). After it: set 20/4/2, first part 100 %, TRADING orders 0 in Admin → Settings, or reset the rule to its defaults (DELETE `/api/admin/settings?key=dealerTieredCommission`), then switch it on. On staging it was set by hand for this test (below). |
| F2 | **The documents-later hold (D-F06) holds only the direct share.** The agent's 20 % was held with "shop approved without its documents"; the lead's 4 % and the main dealer's 2 % were not. | The lead and main dealer can be paid on a shop whose documents are still missing. | Owner to confirm: should D-F06 hold every level? |
| D-147 | Dealer portal still shows a tile **"Waiting (above cap) ₹0"** (`src/components/dealer/dealer-earnings.tsx:103`). Nothing is above a cap any more; the tile shows commission waiting for the month-close approval. | Misleading wording; amounts correct. | Rename to "Waiting for approval" (Low). |

Observation, not caused by this release: on staging the dealer month list shows only 2026-09 closed
(30-Oct, by hand). October was not closed by the daily job at 05:00 IST today (payout day 5). Worth a
look before 5-Dec on production; not checked further here.

## Steps and results

| Step | What was done | Result | Status |
|---|---|---|---|
| 1 | Staging build and database | Site build 07:35 UTC after the #347 merge; 0144 applied | PASS |
| 2 | Rule `dealerTieredCommission` before the test | `enabled` on, but **20 / 5 / 3, firstPart 60 %, tradingOrders 10** (saved 03-Nov) | F1 |
| 3 | Rule set to the 05-Nov values on staging (`PUT /api/admin/settings`) | 20 / 4 / 2, firstPart 100 %, tradingOrders 0, developmentMinShopsPerMonth 100, renewal 10 % | PASS |
| 4 | "QA Staging Test Dealer" moved to TIERED; team lead "QA Team Lead 05-Nov" (QA-LEAD-0511) added; agent E01 placed under him | Tree: main dealer → lead (level 2) → agent (level 3) | PASS |
| 5 | Shop registered by the QA customer account with agent code `GKS-FE-WD6WN9` (employee E01) | "QA Tiered Stationery 0511", BKS-000042, fee ₹999 + 18 % GST = ₹1,178.82, attribution ACTIVE to E01 | PASS |
| 6 | PAN check | Staging vendor (Sandbox.co) answered `config_unexpected_response` → MANUAL_REVIEW; admin approved the test PAN | PASS (vendor not configured on staging) |
| 7 | Documents promise, fee paid on the built-in test payment page ("Pay (success)") | Fee PAID ₹1,178.82 | PASS |
| 8 | Admin approves (GREEN, documents promise accepted) | APPROVED 08:42 UTC | PASS |
| 9 | Commission | Agent DIRECT ₹199.80 · lead OVERRIDE ₹39.96 · main dealer OVERRIDE ₹19.98 (= 20 / 4 / 2 % of ₹999). Plan TRADING at once (0 orders needed), part 2 ₹0 | PASS |
| 10 | Holds | All three ON_HOLD: "agent agreement is not accepted yet"; the agent's also "shop approved without its documents" | PASS (by design) / F2 |
| 11 | Main dealer accepts the agent agreement (version 2026-11-02) from his own account | `released: 1` — the main dealer's ₹19.98 → EARNED; lead and agent stay held | PASS |
| 12 | No cap | No entry `aboveCap`; Admin → Commission: "There is no per-shop cap"; TIERED page: "No per-shop cap" | PASS |
| 13 | Screens at 1280 and 390 px: Admin → Dealers → Commission, → TIERED, dealer portal `/dealer` | All 200, no sideways scroll; TIERED and portal state 20 % / 4 % / 2 % "all of it when the shop pays and is approved" | PASS, D-147 |
| 14 | Month close and the 100-shop development bonus | Not run on staging: closing November early would close the staging month for everyone, and 100 shops cannot be made on staging. Proven by `tests/integration/dealer-tiered-commission.test.ts` and `dealer-monthly-payout.test.ts` (CI passed on #347) | Not run |

## Test data left on staging

| Item | State | Undo |
|---|---|---|
| Rule `dealerTieredCommission` | 05-Nov values, on (was the 02-Nov values, on) | Admin → Settings |
| QA Staging Test Dealer | TIERED; agent agreement accepted 05-Nov | Admin → Dealers → Commission → TIERED |
| QA Team Lead 05-Nov (QA-LEAD-0511, code WRE8GH8U) | ACTIVE, level 2 | — |
| Agent E01 | now under the QA team lead (was straight under the main dealer) | placeMember |
| Shop "QA Tiered Stationery 0511" (BKS-000042, `ead37228-2ce0-4c30-bbf8-8f6c90641254`), owner QA Customer One | APPROVED, fee paid, PAN verified, GSTIN / Shop Act promised to 03-Feb-2027 | — |
| Ledger | 3 TIERED entries above | — |

No real card, UPI or bank data was used. Production was not touched.

## Step 2 — production checks (read-only), 05-Nov-2026 15.05 IST

| Check | Result |
|---|---|
| "Production database" workflow, action verify, source staging (run 42002862161) | Passed. Newest applied `1793176160000`; **only `0144_dealer_commission_no_cap` is missing** |
| Saved dealer rules on production (`platform_settings`) | None saved: `dealerTieredCommission`, `dealerPayoutTds`, `shopReferrals` use the code defaults, so the release brings 20 / 4 / 2 as it is (F1 does not apply to production) |
| Feature flags on production | `dealer_programme_enabled`, `dealer_rating_bonus_enabled`, `gov_verification_auto_approval_enabled` all **off** |
| Dealers / ledger on production | 1 dealer, 0 TIERED, 0 commission rows, 0 months closed |
| Rows migration 0144 would change | **0** |

## Step 3 — production migration, 05-Nov-2026 15.04 IST

"Production database" workflow, action migrate, source staging (run 42003356948): passed. Restore point
**2026-11-05 09:33:51 UTC, LSN 0/22F1DC50** (Neon console → production project → Restore, PROD_DB.md).
Applied 1 migration (`0144_dealer_commission_no_cap`); production now has 145 recorded, newest
`1793176170000`, nothing missing. Checked afterwards: 0 dealer commission rows (nothing changed). The live
code (main) is unaffected: 0144 only updates rows.

**Site check after the migration:** about 2 minutes after it (≈09:36 UTC) the gokesari.com home page
answered slowly (60 s, 57 s, 19 s, 4 s) while `/robots.txt` answered in 0.8 s; from ≈09:37 UTC it was
back to under 1 s, and `scripts/release/post-deploy-check.sh https://gokesari.com` passed 5 rounds in a row
(09:37–09:41 UTC). Cause not established — 0144 changed no rows. To watch during the code release.

## #348 on staging — renewal, % target bonus, promotion rule, team performance (DT-18 to DT-22), 05-Nov-2026 18.55 IST

Staging build 10:12 UTC (service-worker `2026-11-05T10:12:03.469Z`), commit `883a8c97`; CI full suite passed on it (run 42008637940).

| Step | What was done | Result | Status |
|---|---|---|---|
| 1 | Saved rule `dealerTieredCommission` on staging | Still had the old saved values (promotion 10 shops, target bonuses off, ₹1,000/₹2,500/₹5,000 targets) — F1 again. Set to the code defaults, kept `enabled` on: renewal 10/2/1 for 3 years, promotion 50 shops + 3 agents, targets 50 shops each role, bonus 10 % | PASS (set by hand) |
| 2 | `GET /api/dealer/team?view=performance` as the main dealer (month so far) | Main dealer ₹19.98, lead ₹39.96, agent ₹199.80, 1 shop each counted, target 1 of 50, 49 to go, bonus 10 % — matches the ledger | PASS |
| 3 | `period=DAY` / `WEEK`, `format=csv` | Yesterday 04-Nov and last week 26-Oct–01-Nov returned; CSV with all columns and the 3 people | PASS |
| 4 | Admin `GET /api/admin/dealer-tiers?dealerId=&view=performance`; same URL as a non-admin | 200 for admin; 403 for the customer account | PASS |
| 5 | Admin promotes agent E01 without override | 409 "Not eligible yet: 1 of 50 activated shops, 0 of 3 ready agents" — nothing changed | PASS |
| 6 | Screens `/dealer` and Admin → TIERED (QA dealer) at 1280 and 390 px | 200, no script errors, no sideways scroll; "team performance" card with This month / Yesterday / Last week; rule text shows renewal 10/2/1, promotion 50 + 3 | PASS |
| 7 | Renewal commission, month-end target bonus, daily / weekly report e-mails | Not run on staging (needs a renewal payment, a month close, or the cron run). Covered by `tests/integration/dealer-tiered-commission.test.ts` and `cron-schedule.test.ts` (CI passed) | Not run |

No new defects. Release PR #349 (staging → main, `883a8c97`, carries #346, #347, #348) CI green; merge pending the owner.
