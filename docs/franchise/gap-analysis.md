# Franchise dealer module — gap analysis

> **Superseded in part (24-Nov-2026):** this is the gap analysis as written on 20/21-Nov-2026. Since then: the
> owner's share on team shops is 4% one level up / 3% two levels up (not 5%) and recurring is 20% (not 25%) (G-25,
> G-26); the territory dealer (B32) is **retired**, not just superseded (G-28, migration 0160); paid buyers pay first
> and finish KYC within 30 days ([FREE_OR_PAID_FLOW.md](FREE_OR_PAID_FLOW.md)); and new free dealers start on Free
> Dealership v2 under the scheme platform ([../dealer-platform/README.md](../dealer-platform/README.md)). Current
> rules: [README.md](README.md).

## Final brief of 21-Nov-2026 08.06 IST — gap analysis (current)

Read against this branch at `e9ae2e01`'s parent (the 20-Nov / 00.30 build) on 21-Nov-2026 08.15 IST. Status:
**EXISTS** (reused unchanged), **PARTIAL** (smallest change made in place), **MISSING** (built new). Decisions: G-xx in
[DECISIONS.md](DECISIONS.md).

| # | Brief item | Before | Built |
|---|---|---|---|
| F1 | Team structure, codes, PAN / mobile / bank once per team, moves by admin, TL deactivated → agents under the top person (§2) | EXISTS (Model A, 20-Nov work) | Reused for franchise owners too; owners with an active franchise can manage a team even where the free programme flag is off |
| F2 | One-time A1–A4 (§3.1) | EXISTS (dealer 4% one level up since 21-Nov owner decision) | Unchanged |
| F3 | One-time B1–B4, GoKesari pays the team directly (§3.2) | PARTIAL (owner 25% only, team paid by owner) | Team plan decides Model B by the shop's zone; owner 25% / 5%, agent 20%, TL 4%; plan stores model, case, franchise, zone |
| F4 | Parity rule (§3.4) | MISSING | One agent and one TL field (rule `dealerTieredCommission`); save refused if owner < free dealer |
| F5 | Recurring 25% of 2% + bonus ≤ 5%, one decimal (§4, §4.1) | PARTIAL (per dealer code, two decimals) | Per franchise; free-team shops attached by zone, 50/50 split; one decimal |
| F6 | Renewal, 2 per zone, reminders with CEO copy, tail of own-team shops, buy-back (§4.2) | PARTIAL | Renewal at current fee with reason; tail only for own-team shops; free-team shops move to next owner |
| F7 | 50 zones, area master, unzoned areas, shop → area → zone, admin correction, zone sets (§5.1) | MISSING (91 zones by PIN / 5 km circles) | New tables and seed from the owner's sheet; area picker at registration; corrections by period |
| F8 | Tier and fee rule, display names, colours, min / max (§5.2) | MISSING | `src/lib/franchise-zones.ts`, versioned fees, settings |
| F9 | Provisional seed, import → preview → publish, provisional-sale switch (§5.3) | MISSING | Fees tab, `franchise_zone_business`, `allowProvisionalSale` |
| F10 | Zone description (§5.4) | MISSING | Generated from data, positive wording for every tier |
| F11 | Booking map by tier, filters, cart, 15-min hold, 100% upfront, fee locked (§5.5) | PARTIAL (flat fee, cluster filters) | Per-zone fees, tier map and filters, cart with coupon and GST |
| F12 | Zone status Admin control, scheduled, Reserved, Sold Out auto, Inactive (§5.6) | PARTIAL (BOOKABLE / PAUSED / RETIRED) | Six statuses, bulk + scheduled changes, history, notices |
| F13 | Coupons (§5.7) | MISSING | Coupons, assignments, redemptions, report |
| F14 | Free teams in a paid zone, upgrade (§6, §7) | PARTIAL | Zone attachment for recurring; upgrade attaches earlier team shops |
| F15 | Payouts on the 5th, TDS, reversals, notifications (§8) | EXISTS (dealer payouts, TDS rows, ledger reversals, payee notices) | Reused; Model B reversal also ends the franchise attachment |
| F16 | Screens (§9) | PARTIAL | Commission chart page, zone pages, admin tabs (zones, status, fees, areas, coupons) |
| F17 | Mobile apps | EXISTS (WebView shell) | Links for the new pages, 1.12.0 |

---

## Earlier briefs (20-Nov 22.50 IST, 21-Nov 00.30 IST) — kept for the record

Brief: owner prompt of **20-Nov-2026, 22.50 IST**: "Franchise dealer module (free + paid) and Pune PMR area booking".
Read against `origin/staging` at `000b73ad`, 20-Nov-2026 22.55 IST. The website, APIs and admin were read, and so was
the mobile app (`mobile/`) and the database schema (`src/server/db/schema.ts`, migrations to `0156_health`).

**Status values:**

- **EXISTS**: works as the brief says. It is reused and not touched.
- **PARTIAL**: exists but needs the smallest change listed, made inside the existing file.
- **MISSING**: new files, tables or screens that plug into the existing ones.

Two facts shape everything below:

1. **One database.** Seller and customer tables are in the same database (CLAUDE.md, Nov 2026), so the brief's
   "seller DB" / "customer DB" are the same `DATABASE_URL`. The new tables go there, with no foreign keys
   to customer tables.
2. **The mobile apps are a WebView shell.** The Android and iOS apps (`mobile/src/App.tsx`, Expo + `react-native-webview`)
   show the website. There are no native dealer screens today. Every new web page therefore also appears in both
   apps. The app change is limited to:
   - deep-link paths: `/franchise` in `mobile/app.config.ts`, `mobile/src/deep-links.ts` and the AASA / assetlinks routes;
   - a version bump;
   - the store builds.

## Model A — free dealership (Dealer → Team Lead → Agent)

| # | Feature (brief §) | Status | Where today | Change |
|---|---|---|---|---|
| A1 | Free dealer registration: name, mobile OTP, email, address, PAN, bank penny-drop, GST optional, KYC docs (§2.1) | **EXISTS** | `/dealer/apply`, `src/server/dealers/service.ts`, `api/dealer/application/*` | none |
| A2 | Unique dealer code on approval (§2.1) | **PARTIAL** | `issueCode` (`src/server/dealers/codes.ts`); codes are 8-character referral codes | New codes are issued as `GKD-xxxxxx` (dealer), `GKT-xxxxxx` (team lead) and `GKA-xxxxxx` (agent). Existing codes keep working unchanged (decision F-01) |
| A3 | 3-level team, at most 3 levels (§2.2) | **EXISTS** | `dealer_salespeople` (`team_role`, `depth` 2/3, composite FK makes a 4th level impossible) | none |
| A4 | Dealer adds Team Leads and Agents (§2.2) | **EXISTS** | `addSalesperson` (service.ts), `/dealer` team tab | none |
| A5 | Team Lead adds Agents under himself only; cannot add a Team Lead (§2.2) | **EXISTS** | `leadAddsAgent` (tiered.ts:1525) hard-codes AGENT (PR #420) | none |
| A6 | Agent cannot create anyone (§2.2) | **EXISTS** | agents can only *request* a sub-agent, which an admin decides (`requestSubAgent`) | none |
| A7 | Own code per Team Lead / Agent, linked to the Dealer and Team Lead (§2.2) | **EXISTS** | `dealer_codes.salesperson_id` | Prefix only (A2) |
| A8 | Commission 20 / 4 / 3 by **level distance** (§2.3): registering person 20%, one level up 4%, two levels up 3% | **PARTIAL** | `placementFor` / `accrueTieredActivation` (tiered.ts). Today the main dealer always gets `mainOverrideBp` 3%, so Case 2 (agent directly under the dealer) pays the dealer 3% instead of 4%, and Case 4 (team lead registers) pays the dealer 3% instead of 4% | When the direct earner sits directly under the dealer (depth 2), the dealer's override is the first-override rate (`leadOverrideBp`, 4%). New rule field `overrideByDistance` (default **true**) switches it back. Rates are still frozen per shop in `dealer_tier_shop_plans`, so the change applies only to shops activated after the deploy |
| A9 | Base = fee excluding GST (§2.3) | **EXISTS** | `feeBasePaise` (commission.ts:367) | none |
| A10 | Rates admin-configurable and versioned, using the config at activation time (§2.3) | **EXISTS** | rule `dealerTieredCommission` + per-dealer rates; the snapshot is in `dealer_tier_shop_plans`; change history is in `audit_logs` | none |
| A11 | Hierarchy snapshot at activation (§2.3) | **EXISTS** | `dealer_tier_shop_plans` (direct member, lead, main override, bps) | none |
| A12 | No recurring commission in Model A (§2.3) | **EXISTS (with extras)** | TIERED also has: shop-renewal commission 10/2/1 for 3 years, the 10% monthly target bonus, and the 1% development bonus (owner, 05-Nov) | Left unchanged: the brief does not remove them explicitly (decision F-02, owner to confirm) |
| A13 | Team changes apply only to later shops (§2.4) | **EXISTS** | per-shop plan snapshot plus `dealer_team_mapping_history` | none |
| A14 | Team Lead deactivated → his Agents move under the Dealer automatically (§2.4) | **MISSING** | `setSalespersonStatus` leaves the agents under the inactive lead | When a TEAM_LEAD is deactivated, his active agents move to depth 2 under the dealer, with a mapping-history row and an audit entry |
| A15 | Move / promote / deactivate (§2.4) | **EXISTS** | `setMemberPlacement`, `dealerPromotesAgent`, `setSalespersonStatus` | none |
| A16 | Moving to another Dealer needs Admin approval, audit-logged (§2.4) | **PARTIAL** | not supported (members are tied to one dealer by composite FKs) | Admin action "transfer to another dealer": deactivates the member in the old team (code stops) and creates the member in the new team with a new code and the same payee details. Audit-logged |
| A17 | Deactivated code stops immediately; earned commission still paid (§2.4) | **EXISTS** | `setCodesStatus` in the same transaction | none |
| A18 | Same PAN / mobile / bank twice in one team blocked (§2.4) | **PARTIAL** | PAN is unique across all payees (`saveMemberPayee`); mobile and bank are not checked | Mobile and bank account are refused when another member of the same team (or the dealer) has them |
| A19 | Earned on activation: fee paid online, GST/PAN verified, docs accepted (§2.5) | **EXISTS** | `checkCommissionMilestones` (ACTIVATED = shop approved) and `decideGovAutoApproval` | none |
| A20 | Reversal for every person paid on refund (§2.5) | **EXISTS** | `reverseShopCommission` → `reverseAccruals` (every ACCRUAL on the shop) | none |
| A21 | Reversal on fraud / duplicate / revoked verification (§2.5) | **PARTIAL** | only `reverseEntry`, one entry at a time | Admin action "Reverse all commission on this shop" (reason required) calling the existing `reverseShopCommission`, covering both Model A and franchise entries |
| A22 | Duplicate (same GST/PAN/mobile/bank) → hold and Admin review (§2.5) | **EXISTS (differently)** | `findLikelyDuplicate` marks the shop DUPLICATE, so no commission is paid, and the admin queue is `dealer_attribution_disputes` | none (decision F-03) |
| A23 | PAN and verified bank before payout; accrues and is held until then (§2.5) | **EXISTS** | `payeeStatus` → carried "held: …" | none |
| A24 | Dashboards for Dealer, Team Lead and Agent (§2.6) | **EXISTS** | `/dealer` (team tree, earnings by type, statements, code + QR, TDS) | Adds an "Upgrade to Paid Franchise" link |
| A25 | Privacy: nobody sees another person's bank, PAN or earnings (§2.6) | **EXISTS** | masked payee fields; team views show counts | none |
| A26 | Upgrade to paid franchise keeping the same account (§2.7) | **MISSING** | — | Booking uses the existing `dealers` row, so the account and history are kept |
| A27 | Team inside a paid franchise is for tracking only (§2.8) | **MISSING** | — | Franchise team codes (`franchise_codes.member_id`) attribute shops to the owner's allocation, and only the owner is paid |
| A28 | Migration of existing dealers / sales executives into Model A (§13) | **PARTIAL** | dealers are STANDARD or TIERED (admin moves each one) | Script `scripts/franchise/migrate-model-a.ts` (dry run by default) moves STANDARD dealers to TIERED and keeps their codes. History is not recalculated. It runs on staging; production waits for the owner (decision F-04) |

## Model B — paid territory franchise and Pune PMR area booking

| # | Feature (brief §) | Status | Where today | Change |
|---|---|---|---|---|
| B1 | Territory master: 7 clusters, 91 zones, PINs, estimates (§5) | **MISSING** | — | Migration `0157_franchise_pmr` adds `franchise_regions`, `franchise_clusters`, `franchise_zones`, `franchise_zone_pins` and `franchise_zone_estimates`, seeded from `docs/franchise/pune_pmr_91_zones_seed.csv` (built and validated by `scripts/franchise/build-zone-seed.py`) |
| B2 | Area business computed in the app (monthly = shops × GMV ÷ 100, annual × 12) (§5) | **MISSING** | — | `zoneEstimate()` in `src/lib/franchise.ts`; only the inputs are stored |
| B3 | Pune PMR only; regions behind `franchise_regions_enabled` (§4.1) | **MISSING** | — | Config `regionsEnabled: ["PMR"]`; every zone query filters on it |
| B4 | Zone boundaries: reference point, polygon or circle, 5 km rule, no overlap, one zone per point, GeoJSON import, auto reference point "needs review" (§6) | **MISSING** | no polygon support anywhere (only `haversineDistanceKm`) | `franchise_zone_boundaries` plus pure geometry helpers (point-in-polygon, segment intersection, distance) and an admin editor. No PostGIS is needed |
| B5 | `BOUNDARY_PENDING` / `NEEDS_SPLIT` not bookable; split into sub-zones `66-1` (§6) | **MISSING** | — | Zone status plus an admin split action (estimate divided by shop count; audit-logged) |
| B6 | Booking UI: cluster chips, search, filters, sort, map/list, multi-select cart (§4.2–4.3) | **MISSING** | — | `/franchise/book` (web, and so both apps) |
| B7 | Two slots per zone enforced in the DB; one owner never holds both (§4.4) | **MISSING** | — | Partial unique indexes on `franchise_allocations` (`zone_id, slot_no` and `zone_id, owner_dealer_id`) plus `CHECK slot_no IN (1,2)`; `SELECT … FOR UPDATE` on zone rows in Zone ID order; all-or-nothing cart |
| B8 | 15-minute hold, expired holds free at read time and by a job (§4.4) | **MISSING** | — | Expired holds are flipped under the zone lock before a slot is picked, and by the every-minute job |
| B9 | Max owners per zone guarded by super-admin (§4.4) | **MISSING** | — | DB check `max_owners BETWEEN 0 AND 2`. Lowering is an Admin action; raising above 2 is impossible |
| B10 | Payment: server-calculated amount, gateway order, signed webhook, idempotent (§4.5) | **PARTIAL (reuse)** | payment intents (`createPaymentIntent`, `handlePaymentWebhook`, `CAPTURED_HANDLERS`, `PAYMENT_ENDED_HANDLERS`) | New purpose `FRANCHISE_FEE`: a handler on capture (activate) and on fail/expiry (release slots) |
| B11 | Activation dates in IST: expiry = activation + 12 months − 1 day, 23:59:59 IST (§4.5) | **MISSING** | — | `allocationExpiry()` in `src/lib/franchise.ts` |
| B12 | Launch offer: 25 owners / 25 areas, close rule, counted on verified payment time; closed → no payment, no future price (§3.1) | **MISSING** | — | `franchise_campaigns` plus counters at activation; booking closed while `postLaunchFeePaise` is blank |
| B13 | Franchise code `GKF-xxxxxx`, valid only for the owner's active zones (§3.2) | **MISSING** | — | `franchise_codes` linked to `referral_codes`. The zone check runs in the registration wizard (`submitDraftForPayment`, and early in `saveDraftLocation`) and in "Add my shop". Outside the zone: reject (or Model A direct 20%, by setting) |
| B14 | Attribution follows the code; one record and history; disputes held (§7) | **MISSING** | `shop_attributions` exists for Model A | `franchise_shop_attributions` plus history. A franchise code never creates a Model A attribution |
| B15 | Free dealer in a franchised zone: allow / notify / block (§7) | **MISSING** | — | Setting `freeDealerInFranchisedZone` (default `allow`) |
| B16 | One-time 25% of fee excl. GST (₹250 on ₹1,000; D3 ₹625 on ₹2,500) (§3) | **MISSING** | ledger exists | Ledger entry `ONE_TIME_FRANCHISE` on activation, reversed by the existing `reverseShopCommission` |
| B17 | Monthly recurring: 25% (+0–5 pp bonus) of GoKesari's actual commission, net of refunds, on delivered orders of attributed shops while ACTIVE or in tail (§8.2) | **MISSING** | `order_financials` + `financial_adjustments` (as territory income uses them) | `RECURRING_BASE` / `RECURRING_BONUS` entries per shop per month; run at 02:00 IST on the 1st, and again at the monthly close on the 5th |
| B18 | Rating engine, bonus 0% until a formula is published (§8.3) | **MISSING** | territory rating (pincode model) is different | `franchise_rating_formulas` and `franchise_performance_ratings`, with a plain-language explanation |
| B19 | Payout on the 5th, TDS, statements PDF/CSV, Admin approves the batch (§8.4) | **EXISTS (reuse)** | `closeCommissionMonth`, `dealer_payout_batches` (maker-checker, TDS, provider), statements CSV | Franchise entries flow through unchanged. Two additions: new statement lines, and next working day if the 5th is a bank holiday (`bankHolidays` setting) |
| B20 | Renewal: open 30 days before expiry up to 23:59:59 IST on the expiry day; same slot; no auto-charge (§9.3) | **MISSING** | — | RENEWAL booking on the same allocation |
| B21 | Expiry reminders: 30 days, 15 days, then daily from 14 days to the expiry day at 10:00 IST, all channels, CC `ceo@agtci.com` (§9.1) | **MISSING** | `notify()` (in-app, email, push, SMS/WhatsApp mock) + `sendEmail` | `franchise_notification_log` (also the once-only guard) and an hourly job gated to 10:00 IST |
| B22 | Admin expiry panel, "Area expired" emails, 09:00 IST digest (§9.2) | **MISSING** | — | Admin tab "Expiring areas" and an hourly job gated to 09:00 IST |
| B23 | At expiry: EXPIRED, renewal off, code closed for that zone, team codes closed, slot released, shops stay live (§9.4) | **MISSING** | — | Expiry job, plus the same checks at read time |
| B24 | 3-year tail: `fixed_end_of_year_3` default, or `years_after_lapse` (§9.5) | **MISSING** | — | `tail_end_at` on the allocation (`tailEndAt()` helper) |
| B25 | Owner dashboard (§10) | **MISSING** | — | `/franchise/my` |
| B26 | Admin: territory, boundaries, allocations, counters, config, attribution review, reports CSV (§10) | **MISSING** | — | `/admin/franchise` |
| B27 | Versioned commercial config with effective dates (§11) | **MISSING** | rules have no versions (only audit history) | `franchise_config_versions` |
| B28 | Responsibilities and rules accepted by clickwrap with version and IP (§3.3, §4.5) | **MISSING** | `dealer_agreement_acceptances` (agent agreement only) | `franchise_agreement_acceptances` |
| B29 | Violations: warning → recorded → suspension or termination, audit-logged (§3.3) | **MISSING** | — | `franchise_compliance_violations` |
| B30 | Audit of every booking, payment, slot, config, attribution, reversal and payout (§12) | **PARTIAL (reuse)** | `recordAudit`, `AUDIT_ACTIONS` | New `franchise.*` actions |
| B31 | PAN / bank / KYC encrypted and masked (§12) | **EXISTS** | `dealers.pan_enc`, `bank_account_enc` (AES-GCM) | none: owners are `dealers` rows |
| B32 | Old pincode "territory dealer" (PR #419, rule `territoryDealer`) (§13) | **SUPERSEDED** | `dealer_exclusive_territories` (one dealer per pincode) | Left in place, rule off. Staging has one QA territory and production has none. Pincodes cannot be mapped to zones one-to-one (411002 is in 8 zones), so nothing is migrated automatically (decision F-05) |

## Mobile apps (M1)

| # | Feature | Status | Change |
|---|---|---|---|
| M1.1 | Franchise pages in the Android and iOS apps | **EXISTS** (WebView) | The new web pages show in the apps with no native code |
| M1.2 | Deep links / notification taps to `/franchise/*` | **PARTIAL** | Add `/franchise` to `APP_LINK_PATH_PREFIXES`, `DEEP_LINK_ROUTE_PREFIXES` and `deep-links.ts` |
| M1.3 | Version bump, signed builds, store submission | **PARTIAL** | 1.10.0 (versionCode 11, build 11) → 1.11.0 (12 / 12). Building and submitting need the owner's EAS / Play Console / App Store Connect access (see the report) |
| M1.4 | In-app update prompt | **EXISTS** | `MOBILE_APP_*_LATEST` env after the store release |

## Defaults used for open points (logged in [DECISIONS.md](DECISIONS.md))

F-01: prefixed codes for new codes only. F-02: Model A extras (renewal, target and development bonuses) are unchanged.
F-03: duplicates keep the existing DUPLICATE exclusion. F-04: the Model A migration is a script, not SQL.
F-05: no automatic migration of pincode territories. D1–D9 as in the brief §17.
