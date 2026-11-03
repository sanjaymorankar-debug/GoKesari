# Gap report — referrals, 3-level dealer commission, payouts and TDS

**Prepared:** 02-Nov-2026, 22.27 IST · **Brief:** owner prompt of 2 Nov 2026, 21.33 IST
(Parts 0, A, B, C, D, mobile) · **Code read:** commit `7c4bf638` (branch
`fix/billing-v2-d118-d119`) · **Nothing was changed** while preparing this report.

## How to read this report

| Mark | Meaning |
|---|---|
| **EXISTS-WORKING** | In committed code and does what the brief asks. |
| **EXISTS-NEEDS-CORRECTION** | In committed code, but something is wrong or short; the wrong part is stated. |
| **MISSING** | Not in committed code. |
| **IP** | *In progress, uncommitted:* another running session ("Dealer referral commissions and shop rewards", PR 325) is building this in the same checkout right now. It is not counted as existing; where it already differs from the brief, the difference is listed as **IP-DIFFERS**. |

**Important — work already under way.** At 22.27 IST the working tree holds about 40
modified and new files from that session. They cover most of A1–A9 and B1–B6 and part of
C and D:
- `src/server/dealers/tiered.ts` (new, about 1,450 lines);
- `src/lib/dealer-tiers.ts`;
- migrations `drizzle/0136_dealer_tiered_commission.sql` and `0137_shop_referrals.sql`, with `scripts/rollback-0136.sql` and `scripts/rollback-0137.sql`;
- the services `shop-referrals.ts` and `shop-wallet.ts`;
- the admin and `/dealer` screens;
- mobile 1.7.0;
- tests;
- `docs/dealer-programme/TIERED_COMMISSION.md`;
- decision-log entries **DT-01 … DT-17**.

That session works from an earlier version of this brief (21.21 IST). The build should
therefore be **one effort, not two**: finish it in that session (or after it is
committed), and use this report as the checklist for what it still lacks.

Line numbers refer to the committed copy (`git show HEAD:<path>`) unless marked IP.

---

## Part 0 — Customer referrals (F11): verify only

**Rule state**
- **Default**, `src/server/config/rules.ts:251-270`: `enabled: false`, ₹50 to each side (5000 paise), `maxRewardsPerReferrer` 20, `applyWithinDays` 30.
- **Test** (read from Admin settings on test.gokesari.com, 02-Nov-2026 22.0x IST): **ON**, with the defaults (₹50 / ₹50 / 20 / 30). `customerSignupReferral` is also on (required from 2026-10-09).
- **Prod** (gokesari.com): **not confirmed**. This session has no production sign-in; QA runs on production are guest-only by design (`tests/qa/lib/actors.ts:38`), and no document records it. Because the default is off, it is off unless someone switched it on. Owner: please check Admin → Settings → `customerReferrals` on gokesari.com.

| Requirement | Mark | Evidence |
|---|---|---|
| Every customer has a code and link | EXISTS-WORKING | Code created on first use, GK + 6 characters: `customer-referrals.ts:45-55`. `/r/CODE` sets a 30-day cookie: `src/app/r/[code]/route.ts:11-28`. The `/refer` page: `src/app/refer/page.tsx:28-41`. Staging 25 Oct: every role got its own code and link (`docs/four-features-2026-10/TEST_RESULTS.md:221`). |
| Applied within `applyWithinDays` and before the first order | EXISTS-WORKING | `ineligibility()` `customer-referrals.ts:60-71` (age of account, any earlier order, an earlier referral); unique index `customer_referrals_referee_uq`; also at signup, `customer-signup-referrals.ts:128`. Staging: an existing customer was refused (TEST_RESULTS.md:191). |
| First DELIVERED order: ₹50 promotional credit to both; referrer capped | EXISTS-WORKING (small gap) | Hook in `orders.ts:1054` (savepoint); credit logic `customer-referrals.ts:157-274`; idempotency key `referral:{id}:{who}`; reversed rewards still count toward the cap. **Gap:** the cap is counted (`:212`) without locking the referrer, so two friends' deliveries committing at the same instant could both pass the last slot. CLAUDE.md asks for `touchSellerRow`/a gate row for exactly this "last slot" case. Low severity. |
| Guard: own code | EXISTS-WORKING | `:95` plus the check constraint `customer_referrals_not_self`; refusals feed the REFERRAL_ABUSE risk rule. |
| Guard: same mobile | EXISTS-WORKING | Checked when the code is applied (`:104`) and again at reward time (`:181`). |
| Guard: referrer's address | EXISTS-NEEDS-CORRECTION (weak) | `:189-198` compares only address line 1 (normalised) plus PIN code. Line 2 and the map coordinates are ignored, so the same flat written differently passes. |
| Guard: mobile already rewarded | EXISTS-WORKING | `:182-188` plus the partial unique index `customer_referrals_rewarded_phone_uq`. |
| Admin reversal (D-25) | EXISTS-NEEDS-CORRECTION | `reverseCustomerReferral` `:284-374`; API `api/admin/customer-referrals/[id]/route.ts:17`; screen `admin/customer-referrals/page.tsx`. **Three defects below.** |

**Part 0 defects found** (reported here first; nothing changed):
1. **P0-1, reversal can take the customer's own money.** The reversal takes `min(reward, wallet.balancePaise)` from the *whole* balance (`customer-referrals.ts:307`). A REVERSAL debit draws the promotional balance first and then customer-funded money (`wallet.ts:219-223`). If the ₹50 promo credit is already spent, the reversal debits up to ₹50 of money the customer topped up. Suggested fix: limit `take` to the unspent promotional balance, and record the rest as unrecovered (as shop referrals do in DT-15). **Needs owner OK.**
2. **P0-2, permission mismatch.** The admin page allows `role === "ADMIN"` only (`page.tsx:15`). The API allows any role with `WALLET_ADJUST`. Pick one; suggested: the permission on both.
3. **P0-3, D-25 follow-up not done.** The defect note asks for risk flags on both customers after a reversal (TC-MKT-017, `docs/testing/qa-defects.json:346-356`, "Fixed – awaiting retest"). No risk flag is raised. D-25 is also missing from `docs/decision-log.md` (it lives only in qa-defects.json).
4. **P0-4, cap race:** see the table above.

**Not yet verified on Test.** Staging round 3 (24 Oct) **skipped** TC-MKT-014…017 and SC-35.
Every later staging run covers only TC-MKT-013, an access check. The reward on first
delivery and the reversal have therefore **never been run on test.gokesari.com**. They
pass locally on both database layouts (24 Oct runs). The verification runs in the QA
phase: delivered first order → both credited; cap; each guard; reversal.

---

## Part A — Shop registration: 3-level dealer commission (TIERED)

### What exists today (committed)
- **Model:** `dealer_commission_settings` (schema `:10793`): `commissionModel` BASE_PERCENT, `basePercentBp` 4000 (40 %), `ratingStepBp` 100, cap ₹999 per shop, `payoutDayOfMonth` 5, `autoApproveAtMonthEnd` true.
- **Fee basis:** `feeBasePaise` (`commission.ts:361`) is the fee before GST and after the coupon; a waived fee gives 0 (`feeWaived` `:355`).
- **Per-dealer override:** `dealers.commission_percent_bp` / `rating_step_bp`, set by `setDealerCommissionRates` (`commission.ts:425`; admin only, reason required, audited).
- **Rating adjustment:** (rating − 5) × step, under flag `dealer_rating_bonus_enabled` by district (`:374-414`).
- **Milestones:** REGISTERED / VERIFIED_CATALOGUE / ACTIVATED (`checkCommissionMilestones` `:504`). BASE_PERCENT earns only at ACTIVATED.
- **Cap:** per shop, net of reversals; the part above the cap is a PENDING `aboveCap` entry for an admin.
- **Reversals and carry-forward:** `reverseAccruals` `:655`, `reverseShopCommission` `:692`; a negative net is carried by `createPayoutBatch` `:892` / `monthly-payout.ts:148-159`.
- **Sales team:** `dealer_salespeople` (schema `:10346`), a flat list (no role, no parent, not a payee). Mobiles are masked by `maskMobile` (`service.ts:200`).
- **Tests:** `tests/integration/dealer-step1…8-*.test.ts`, `dealer-base-commission.test.ts`, `dealer-monthly-payout.test.ts`, `dealer-all-india.test.ts`.

**Corrections found in the committed model** (they affect BASE_PERCENT as well, so they are owner decisions):
- **A-C1, "actually paid" is not checked at activation.** ACTIVATED is reached on `shop.status === "APPROVED"` alone (`commission.ts:521`); only REGISTERED checks `feePaymentStatus === "PAID"`. The amount is read from the shop's fee columns, not from `shop_payments`. Today shops are approved only after paying (wizard: live after payment), so this is a latent gap, not a seen fault. Suggested fix: also require PAID for ACTIVATED commission. The IP `accrueTieredActivation` has the same gap.
- **A-C2, the cap is below 28 %.** The ₹999 per-shop cap is lower than 28 % of the ₹4,999 slab (₹1,399.72) and the ₹9,999 slab (₹2,799.72). With "keep the existing per-shop cap", TIERED shops on those slabs would always stop at ₹999, and the rest would wait PENDING for an admin. **Owner decision** (IP decision DT-03 raises the same point).
- **A-C3, the ledger's unique index allows one accrual per (shop, milestone).** That cannot hold three levels' entries for one shop. Schema change required; IP replaces it with `accrual_key`.

### Item by item

| Item | Committed | IP status / what still differs from the brief |
|---|---|---|
| **A1** 3 levels, 4th refused by database and service | MISSING | IP: `team_role`, `depth` 2/3, a composite parent foreign key and checks (database refusal), and `assertPlacement`/`placeNewMember` (`tiered.ts` ~898/918). Built on `dealer_salespeople`, as the brief allows. |
| **A1** agents request sub-agents, admin approves | MISSING | IP: `requestSubAgent` / `decideTeamRequest` (`tiered.ts:1074/1111`), table `dealer_team_requests`. |
| **A2** 20 / 5 / 3 %, missing level unpaid, max 28 %, admin default + per-dealer override, rating on direct only | MISSING | IP: rule `dealerTieredCommission` (2000/500/300 bp), `setDealerTierRates` (`tiered.ts:1307`), `placementFor` (`:207`). **IP-DIFFERS:** none seen apart from A-C2 (cap). |
| **A3** 60 % at ACTIVATED; 40 % + overrides at TRADING (10 delivered in 90 days); lapse with ledger note | MISSING | IP: `checkTradingMilestone`/`settleTrading`, a lapse as a zero entry with a note, `runTieredDaily` cron, a delivered-order hook in `orders.ts`. |
| **A4** renewal R % (10 %), can be switched off | MISSING (renewal payments exist: `shop_payments` RENEWAL, `recordPayment` `shop-payments.ts:128/203`) | IP: `accrueRenewalCommission` (`tiered.ts:688`), before GST. |
| **A5** promotion at 10 activated shops (override with reason), takes his recruits, 1 % development bonus for 6 months | MISSING | IP: `promoteToTeamLead` (`tiered.ts:976`), `dealer_team_developments`. **IP-DIFFERS:** paid at TRADING with the overrides (DT-05); when the promoted agent had no former lead, nothing is paid. Owner to confirm. |
| **A6** monthly target bonuses, OFF by default | MISSING | IP: `accrueTargetBonuses` (`tiered.ts:760`) at the month close. |
| **A7** reversal of all levels, negative carry-forward | EXISTS-WORKING for single-level | IP: reversal entries keep type/payee/level; `reversePlan`. **Check in QA** that a development bonus and an affected target bonus are reversed too. |
| **A8** only paid registration/renewal earns; versioned agreement with timestamp before earning | Dealer agreement exists (`dealers.agreement_version`/`_accepted_at`, `service.ts:534`); member agreement MISSING | IP: `AGENT_AGREEMENT_VERSION`, `acceptAgentAgreement`, earnings ON_HOLD until accepted (DT-10). **IP-DIFFERS:** only the latest version and time are kept on the member row (overwritten); there is **no acceptance history**. Suggested: a `dealer_agreement_acceptances` table (version, text hash, time, IP/device). "No joining fee / stock / recruiting pay" is satisfied by design: no such charge exists anywhere. |
| **A9** admin team tree with counts and drill-down | MISSING | IP: `teamTree` (`tiered.ts:848`) on the admin tiered page. **Check:** per-node registered/activated/TRADING/active-30-days counts, commission this month/all time, and the click-through shop list (name, ID, PIN, signing agent, code, date, status). |
| **A9** Team mapping table, filters, CSV export | MISSING | **MISSING in IP too.** |
| **A9** mapping history (date, actor, reason) | MISSING | **IP-DIFFERS:** only audit rows `DEALER_TEAM_CHANGED`; no history table that can be queried. |
| **A9** commission follows the mapping **on the shop's registration date** | MISSING | **IP-DIFFERS:** the mapping is frozen **at activation** (DT-04, `placementFor` uses the tree at activation). A reassignment between registration and activation would pay the new lead. Needs the history table above, read "as of registration date". |
| **A9** reassign an agent to another lead (reason); only new shops follow | MISSING | IP: `setMemberPlacement` (`tiered.ts:931`). Correct once the point above is fixed. |
| **A9** `/dealer` role-scoped views, masked mobiles | Dealer portal exists (single level) | IP: `MemberPortal`. **IP defect:** a team lead's tree is filtered to his own row only (`members.filter(m => m.id === member.id)`), so he does not see his agents. Mobiles are left out of the tree rather than masked. |

**Permissions.** There are no named dealer permissions. Services check `actor.role !== "ADMIN"`
inline (`commission.ts` ~104; `service.ts:110, 651, 708, 750, 892, 970`). This satisfies
"checked in services", but it blocks the CA role in Part D. See D4.

---

## Part B — Shop-refers-shop (rule `shopReferrals`, OFF)

**Nothing is committed.** The whole of Part B is IP (`shop-referrals.ts`, migration 0137,
`admin/shop-referrals`, `promo_balance_paise` on shop wallets).

**Name clash to note:** an existing rule `shopReferral` (singular) already means
*operator-issued codes required to register a shop* (feature F4; on for Test, `required: true`).
The new `shopReferrals` (plural) is a different thing. Suggested: label it "Shop-refers-shop
rewards" on every screen.

| Item | Committed | IP status / differences |
|---|---|---|
| **B1** code + share link per APPROVED shop, on the manage page | MISSING | IP: `SHOP` + 5 characters, `/r/SHOP…` → `/shop/register?ref=` (DT-12), a card on the manage page. |
| **B2** one code per registration, first wins and locks | **EXISTS-NEEDS-CORRECTION:** today `answerDraftReferral` overwrites the code freely (`shop-registration-wizard.ts:434-447`) | IP: REFERRAL_CODE_LOCKED, while the rule is on. |
| **B3** referred shop: X % fee discount or welcome wallet credit | MISSING | IP: discount after the coupon (DT-14). |
| **B4** referrer: ₹200 promo credit or M-month extension, at ACTIVATED + first DELIVERED order; spend only on commission/delivery; never to bank | MISSING (the shop wallet has no promotional balance; no withdrawal path exists) | IP: `rewardShopReferralOnDelivery`, `promo_balance_paise` spent first and refused for other debits (DT-15). |
| **B5** guards: PAN, GSTIN, mobile, bank, owner, BRANCH/duplicate; 20 per year; idempotent; reversal | Reusable: `findLikelyDuplicate` (`dealers/attribution.ts:96-160`) gives DUPLICATE/BRANCH (mobile, GSTIN, PAN, name nearby), but saves its result only for dealer-attributed shops | IP: all guards (bank numbers compared), 12-month rolling cap (DT-16), idempotency keys, reversal. |
| **B6** admin list with outcomes and reversal | MISSING | IP: `admin/shop-referrals`. |

---

## Part C — Automatic monthly payout for every earner

**Exists:**
- **Dealer monthly close on the 5th** (`monthly-payout.ts` `closeCommissionMonth` `:105`, `runMonthlyDealerPayout`, cron `dealer-monthly-payout`): auto-approve, one draft per dealer, statement, CSV, manual mark-paid with UTR (`markPayoutPaid` `commission.ts:921`).
- **Shop payout providers** (`src/server/payouts/`): SANDBOX / RAZORPAYX / CASHFREE adapters, maker-checker, retries with backoff, signed webhooks, BANK_FILE export, manual mark paid/failed.
- The adapters are payee-agnostic. The batch tables are shop-only (`payout_items.shop_id` NOT NULL).
- Riders already reuse the adapters through their own transfers table (`rider-wallet/transfers.ts`); **that is the pattern to copy for dealers.**

| Item | Mark | Detail |
|---|---|---|
| **C1** every main dealer / lead / agent / distributor a payee | MISSING (IP partial) | IP: per member (`payee_member_id`, `member_id`). **IP-DIFFERS:** grouped by dealer/member, **not by PAN**, so one person in two roles gets two payouts. "Distributor" is not a payee type. |
| **C1** Module 3 `referral_commissions` into the same ledger, keeping history | MISSING | Table at schema `:6484-6514` ("nothing is paid out by the system"), written by `registration/service.ts:591`, screen `/admin/referral-commissions`. Needs a data migration (e.g. entry type `LEGACY_DISTRIBUTOR`, key `RC:<id>`). The earlier note `REUSE_GAP_ANALYSIS.md:132-141` deliberately kept them apart to avoid double pay. **Owner to confirm the move.** |
| **C2** PAN, verified bank, agreement, minimum payout; hold and carry; monthly reminder | MISSING (IP partial) | IP checks PAN + bank only at mark-paid (`payeeNotReady`). Missing: a dealer minimum payout, automatic hold/carry on a failed condition, the monthly reminder. |
| **C3** close extended to every payee, reversals subtracted, negative carry | EXISTS-WORKING for dealers | IP extends it to members. **Needs correction:** the carry is matched by dealer id only (`monthly-payout.ts:362`); it must match the payee (PAN). A positive amount below the minimum is not carried. |
| **C4** auto transfer, rule `dealerAutoPayout` OFF, webhook UTR, maker-checker, retries + admin flag, BANK_FILE, manual fallback | MISSING (manual fallback exists) | The dealer batch has only DRAFT/PAID/CANCELLED: no APPROVED, attempts, provider reference, webhook link or bank file. Build it on the rider-transfers pattern. |
| **C5** statement in app, email, CSV; lines by type; gross/TDS/net | EXISTS-NEEDS-CORRECTION | App + CSV exist. The email is a plain notice with no attachment (shops get PDF + CSV). IP adds lines by type and gross/TDS/net. |
| **C6** admin payout reports (month, main dealer, role, status), CSV + XLSX | EXISTS-NEEDS-CORRECTION | `GET /api/admin/dealer-commission` filters only by dealer and status; no export. Helpers exist: `integrations/tabular.ts` `toCsv`/`toXlsx`. The four reports (month summary, ledger lines, pending payees, failed transfers) are MISSING. |
| **C7** notices (in-app, email, push): statement ready, paid with UTR, reversal | Partly exists | `DEALER_PAYOUT_PAID`, `DEALER_COMMISSION_STATEMENT` committed; IP adds EARNED/REVERSED. A failed-transfer notice is MISSING. |
| **C8** customer and shop rewards stay wallet credits | EXISTS-WORKING / IP | Nothing to do beyond keeping them out of the payout. |

---

## Part D — TDS on commission

**Exists:**
- **Admin → Statutory** (`server/statutory/rates.ts`, `statutory_rates`, `/admin/statutory`): dated rows, the previous row is closed on add, legal reference, CA confirmation (by whom, when), and the confirmation is withdrawn on edit.
- Rate keys are a fixed list (`rates.ts:29-36`) with **no commission-TDS key**.
- **`confirmedByCa` is display-only.** Nothing in `src/server` outside `rates.ts` reads it, so an unconfirmed row blocks nothing today.
- **Patterns to reuse:**
  - shop TDS lines that store the statutory row, section and rate (`payouts/cycle.ts:407`);
  - `buildTdsStatement` by PAN (`tax/compliance.ts:293`);
  - rider 194C `computeTds` with FY catch-up (`rider-wallet/rules.ts:15-63`).
- **IP:** a flat rule `dealerPayoutTds` (rate + threshold, catch-up only, OFF) and `tdsForPayout`.

| Item | Mark | Detail |
|---|---|---|
| **D1** dated "TDS on commission" rows (payee type, PAN status, rate bp, threshold, free-text section, from/to, CA-confirmed) | MISSING | **IP-DIFFERS:** the flat rule has no dates, payee type, PAN status, section text or CA flag. Should be statutory rows (new key or a sibling table in the `rates.ts` pattern). Start values (2 % / 20 % / ₹20,000) **unconfirmed**. |
| **D2** lower/nil certificate per payee | MISSING | — |
| **D3** per PAN per FY; CATCH_UP / EXCESS_ONLY; rate row on each line; reversal within FY or flag to CA; block when unconfirmed (admin override with reason) | MISSING | **IP-DIFFERS:** per dealer/member (not PAN), catch-up only, rate only on the batch, no reversal handling, no block. |
| **D4** CA role: statutory:manage, certificates, read-only payouts/ledger/reports, exports; not approve/manage/rules | MISSING | Roles are a fixed enum (`authz/permissions.ts:548-559`). `STATUTORY_MANAGE` exists but only ADMIN has it. `RBAC_PLAN.md` has no CA. Dealer screens check `role === "ADMIN"`, not permissions, so read-only CA access needs **named dealer permissions** (`dealers:read`, `payouts:read`, …) first. |
| **D5** monthly TDS per payee; 26Q quarterly data with challan fields; Form 16A tracker with PDF upload, visible to payee; exceptions | MISSING for commission | The shop side has Form 140 CSV and `statutory_filings`; `MONTHLY_PAYOUT.md:52-54` already lists 194H / Form 16A as a CA item. |
| **D6** payee view: PAN status, rate, TDS this FY, 16A downloads | MISSING (IP: gross/TDS/net on the statement only) | — |

**Section reference:** the brief notes that sections changed under the Income-tax Act 2025.
The shop side already uses the new numbering (s.393 for old 194-O). Commission TDS (old
194H) needs the CA to give the new section; it is kept as free text.

---

## Mobile (Android and iOS)

- **Shape:** one Expo app (`mobile/`), a WebView wrapper. There are **no native dealer, referral or payout screens**; `/dealer`, `/refer` and `/r/<code>` are web pages inside the app. There is no committed `android/` or `ios/` folder; EAS generates them (`mobile/eas.json`).
- **Deep links:** `mobile/app.config.ts` (schemes, iOS associated domains, Android intent filters from `DEEP_LINK_ROUTE_PREFIXES`), `mobile/src/deep-links.ts`, server mirror `src/lib/deep-links.ts`, `.well-known` routes. **IP** adds `/dealer` and `/shop/register`.
- **Push:** Expo (`mobile/src/push.ts`, `App.tsx:215-221` opens the notice's `actionUrl`). Server side in `src/server/notifications/push/*`.
- **Versions:** `app.config.ts` version / iOS buildNumber / Android versionCode. **IP** bumps them from 1.6.0 (7) to 1.7.0 (8). Store "latest/minimum" comes from `MOBILE_APP_*` environment variables.
- **Consequence:** most "mobile" items in the brief are delivered by the web pages. The app needs only the deep links, push routing and a version bump, which IP covers. **Building for both platforms** runs on EAS and needs the owner's Expo account; this session cannot do it.

---

## Summary of corrections to committed code (owner OK needed before any change)

| # | Where | Correction |
|---|---|---|
| P0-1 | `customer-referrals.ts:307` | A reversal must take back only unspent promotional credit, never the customer's own money. |
| P0-2 | `admin/customer-referrals/page.tsx:15` | Same permission on the page and the API. |
| P0-3 | reversal | Raise the risk flags D-25 asked for; add D-25 to the decision log. |
| P0-4 | `customer-referrals.ts:212` | Lock the referrer (gate row) before counting the cap. |
| P0-5 | `customer-referrals.ts:189-198` | Address guard: compare line 1 + line 2 (and/or coordinates). |
| A-C1 | `commission.ts:521` | ACTIVATED commission only when the fee is PAID. |
| A-C2 | settings | ₹999 cap vs 28 % of ₹4,999 / ₹9,999: owner to decide. |
| A-C3 | ledger unique index | One accrual per shop+milestone blocks multi-level (IP fixes). |
| B2 | `shop-registration-wizard.ts:434-447` | First code entered is locked (IP fixes, rule-gated). |
| C3 | `monthly-payout.ts:362` | Carry-forward per payee (PAN), and below-minimum carry. |
| C5/C6 | statement email, admin API | Attach CSV/PDF to the email; filters and CSV/XLSX exports. |
| D (all) | `statutory/rates.ts` | `confirmedByCa` must gate payouts once TDS rows exist. |

## Still missing even after the in-progress work

1. **Team mapping table** with filters and CSV, and a **mapping history** table; commission by the mapping **on the registration date** (IP uses activation).
2. **Acceptance history** for the agent agreement (IP keeps only the latest).
3. **Team lead view** in `/dealer` shows only himself (IP defect); masked mobiles in the tree.
4. **Pay by PAN**: one payout per person per month across roles; distributor as a payee; **Module 3 migration**.
5. **Payout conditions:** minimum payout, automatic hold and carry, monthly reminder.
6. **Automatic transfer** (`dealerAutoPayout`) on the shop payout providers: maker-checker, webhook UTR, retries, BANK_FILE.
7. **Admin payout reports** (4 reports, CSV + XLSX) and failed-transfer notices.
8. **All of Part D except a flat rate:** dated TDS rows, certificates, PAN/FY aggregation with two modes, rate row per line, reversal TDS, the unconfirmed-row block, the CA role with named permissions, 26Q / 16A / exception reports, and the payee TDS view.
9. **Part 0 verification on Test** (never run on staging) and the Prod rule state.

## Decisions waiting on the owner or the CA

- **Owner**
  - Cap vs 28 % (A-C2).
  - P0-1 reversal behaviour.
  - Moving Module 3 into the dealer ledger.
  - IP decisions DT-01 (members paid directly), DT-02, DT-05 (development bonus when there is no former lead).
  - Mapping on the registration date vs activation (IP differs from the brief).
  - Whether to merge both efforts into the one session already running.
- **CA**
  - TDS rates (2 % / 20 %).
  - Threshold ₹20,000 and mode (CATCH_UP vs EXCESS_ONLY).
  - Section reference under the 2025 Act.
  - GST on dealer invoices.
  - Treatment of a reversal that crosses a financial year.
- **Owner's Expo account** for the Android and iOS builds; **production sign-in or owner check** for the Prod rule state.
