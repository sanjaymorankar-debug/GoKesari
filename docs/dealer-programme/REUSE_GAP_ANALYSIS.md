# Dealer & Merchant Acquisition Programme — reuse / gap analysis (Phase 0)

28 Oct 2026. Inputs: the owner's build prompt ("FINAL Build Prompt — Gokesari
Authorized Dealer & Merchant Acquisition Programme") and the strategy document
`Doc_GoKesari/Marketing/Delear Strategy.docx`. Where the two differ, the prompt
wins. Audit done read-only against `staging` @ 257777e (= `main`).

Status key: **Present** = reuse as is · **Partial** = extend · **Missing** = build.

---

## 1. Headline findings (things the prompt assumes that are not true today)

| # | Prompt assumes | What the code actually has | Decision |
|---|---|---|---|
| F1 | "Sales-executive personal referral codes with commission per shop / shop type" | **No sales-executive concept anywhere** (no role, table or column). Shop referral codes live in `referral_codes` (0002/0071), owned by free-text `referrer_name`, an optional `referrer_user_id`, and an optional `distributor_id`. Commission is per **distributor** (`distributors` / `distributor_types`, 0071), FLAT or PERCENT of the fee — not per shop type. | **Owner, 28 Oct:** a distributor *is* a dealer and keeps its code; the distributor's employees are recognised by an **optional Employee ID / name field** at registration, for their individual commission. Migration plan in §4. |
| F2 | Registration fee ₹1,000 shop / ₹2,500 wholesale | **No fee by shop type.** One global `registration_fees` row for Add my shop / operator paths; self-registration (`/shop/join`) uses `registration_fee_tiers` (BASIC…INDUSTRY, admin-set, not linked to shop type). | **Owner, 28 Oct:** admin creates any number of **fee slabs**, sets each slab's amount and assigns shop types to slabs. Built on `registration_fee_tiers` (admin may add slabs beyond the five) plus a shop-type → slab mapping, used only when `dealer_programme_enabled`; with the flag off the current fee resolution is unchanged. A wholesale slab of ₹2,500 and a standard slab of ₹1,000 are offered as the starting values, not hard-coded. |
| F3 | Auto-approval "on payment match, otherwise pending admin approval" exists | Two different paths: (a) `/shop/join` self-registration approves on **payment alone** (`approveRegistration`, registration/service.ts:458) with **no document, GST, PAN or FSSAI checks**; (b) `/shop/register` + operator paths create `PENDING_APPROVAL` and `autoApproveShopIfReady` (shops.ts:698) approves when fee PAID + mandatory documents verified, behind rule `sellerVerification.autoApproveShop` (default **off**). | GKS-SH-004 extends path (b) — the gate lives in `autoApproveShopIfReady` / `approveShopTransaction`. Path (a) is left byte-for-byte as is with the new flag off; with the flag on, `/shop/join` registrations are routed through the GST/PAN gate as well (see §3.4). |
| F4 | Government GST/PAN verification may exist | **Present, real-provider capable**: `src/server/kyc` adapter interface (`KycAdapter`), providers `mock` and `gridlines` (Gridlines endpoints written from docs, **never called live**), name-match score, GSTIN↔PAN linkage, retry sweep. Selected by `KYC_PROVIDER`. | Reuse. **Owner, 28 Oct:** keys (`KYC_PROVIDER`, `GRIDLINES_API_KEY`) to be set on Hostinger. Until one live call is proven, GKS-SH-004 runs on the mock and stays off on Prod. |
| F5 | ₹1 bank verification exists | Present as a ₹1 debit-and-refund through Cashfree PG + Cashfree BAV v2 check. Keyed to `{userId, shopId}`, `holderType` CUSTOMER/SHOP only. | Extend with `holderType = DEALER` and a per-dealer "current account" index. |
| F6 | Event-driven handlers | The event bus (`emitEvent` / `catalog.ts`) maps events to **notifications only** — there are no code subscribers. | Commission accrual and rating recalculation are called **directly from the services** that change shop status (same transaction), and an event is emitted for notifications. This is "event-driven" in the sense required (no cron), and matches how the code already works. |
| F7 | "15-theme support" | Only one theme exists (Theme 1 Tile Board). | New screens use the Tile Board components; nothing to do for other themes. |
| F8 | Android and iOS apps need feature work | Both apps are an **Expo WebView wrapper** around the website (`mobile/src/App.tsx`). No native screens, no role code. | All features reach the apps through the website. Only native change: add `/dealer` and `/support/services` to `APP_LINK_PATH_PREFIXES` (mobile/app.config.ts) → one rebuild of each app. QR **scan** in registration uses the existing `jsqr` web scanner (camera permission already granted to the WebView? — to verify on device). |
| F9 | Release candidates built here | This Mac has no Java, Android SDK or full Xcode. | Builds come only from the GitHub workflows `mobile-apk.yml` (APK artifact; **not Play-signed** — no keystore step) and `mobile-ios.yml` (EAS → TestFlight, needs `EXPO_TOKEN`). |
| F10 | "Shop owner registers for others" | Not found. Only admin/operator (no owner OTP) and OPERATOR_LIMITED (owner OTP by e-mail) register on behalf. | Dealer-assisted registration is modelled on the OPERATOR_LIMITED flow (`operator-limited.ts`), with the dealer as actor and the owner OTP **by SMS to the owner's mobile** (prompt 3.3). |
| F11 | Commission milestones (registration / verification+catalogue / activation) | No `shop.registered`, "catalogue completed" or "ready for orders" event. Manual approval emits no event. Only marker: `shops.profile_completed_at`. | Add three milestone hooks (§3.5) at: shop created (registration completed), verification VERIFIED + first N products live (catalogue completed, N configurable, default 10), shop APPROVED and accepting orders (activation). |
| F12 | Down-migrations | Convention `scripts/rollback-NNNN.sql`; **0088–0097 have none**. | Every new migration ships its `rollback-NNNN.sql`; adding the missing 0088–0097 rollbacks is out of scope (noted as a gap). |
| F13 | Operators may edit commission today | `/api/admin/distributor-types` and `/api/admin/distributors` (which carry commission rates) need `REFERRAL_MANAGE`, which **operators hold**. | Prompt 3.5 says admin only. With `dealer_programme_enabled` on, new commission rules are admin-only. The legacy distributor-rate endpoints are **left as they are** (no-regression rule); recommendation in §6 to tighten them separately. |

---

## 2. Capability table

### 2.1 Capabilities the prompt expects to exist

| Capability | Status | Maps to | Extension point |
|---|---|---|---|
| Sales-exec / referral codes with commission | **Partial** (see F1) | `referral_codes`, `referral_redemptions`, `distributors`, `distributor_types`, `referral_commissions`; `services/referrals.ts`, `registration/admin.ts` | New `dealer_codes` table points at `referral_codes.id` so one code string space serves both; `resolveUsableCode` gains a dealer-status check |
| Mandatory / optional referral toggle | **Present** | `referral_settings`, `isReferralRequired` (referral-settings.ts:91), `assertRegistrationReferralCode` (referral-requests.ts:48), `checkJoinReferral` | None — dealer and salesperson codes are rows in `referral_codes`, so the same checks apply |
| "Request a referral code" | **Present** | `referral_code_requests` (0064), `createReferralRequest`, e-mail to `shopReferral.notifyEmails` (default referrals@gokesari.com) | With the flag on, after insert: find active dealers whose localities cover the PIN/area and create a `dealer_lead_offers` row + notification for each. E-mail unchanged |
| Registration fee + payment + auto-approval / pending | **Partial** (F2, F3) | `registration_fees`, `registration_fee_tiers`, `registration_payments`, `approveRegistration`, `autoApproveShopIfReady`, `approveShopTransaction` | Fee by shop type (new table); GST/PAN gate inside `autoApproveShopIfReady` |
| Admin/operator register on behalf with owner auth | **Present** (OPERATOR_LIMITED) | `operator-limited.ts`, `shop_onboarding_sessions` (0082) | Copy the session pattern into `dealer_onboarding_sessions` (seller DB) with SMS OTP |
| ₹1 bank verification | **Partial** (F5) | `bank-accounts.ts`, `bank-account-check.ts` | `holderType = DEALER`, `dealer_id` column |
| Legal documents by shop type, upload/storage | **Present** | `legal-documents.ts`, `document-uploads.ts`, `seller_document_uploads`, encrypted bytea | Dealer documents reuse the upload + encryption helpers in a new `dealer_documents` table; shop-type rules untouched |
| Shop / product duplicate check | **Partial** | `shop-duplicates.ts` — Shop Act key; PAN / Udyam at same PIN; same owner + name + PIN. **No GSTIN, no phone, no geo-proximity**; not run on `/shop/join` | Add `findLikelyDuplicates` (normalised phone, GSTIN, PAN, name trigram + ≤150 m) used for attribution / commission eligibility and to block GST auto-approval (scenario 28). Existing blocking rules unchanged |
| Notifications, e-mail, dispute → ticket | **Present** | `notify()` + `notification_deliveries` outbox with retry (`deliverPending`); `support_tickets` help desk; `disputes.ts` | New notification types + templates; attribution disputes and support services are help-desk tickets with new categories |
| Shop owner prepaid wallet | **Present** | `applyShopWalletEntry` (shop-wallet.ts:181), `INSUFFICIENT_BALANCE` error | New enum values `SUPPORT_SERVICE_CHARGE` (debit) and `SUPPORT_SERVICE_REFUND` (credit) + direction CHECK |
| GST/PAN validation | **Present** (F4) | `kyc/*`, `seller-verification*.ts`, `applyDocumentChecks` | Read the stored verification result in the auto-approval gate; no new provider code unless Gridlines fails a live call |
| Roles and admin/operator screens | **Partial** | `user_role` enum, `user_role_grants`, `permissions.ts`, `src/lib/board/menus.ts` | Add `DEALER` enum value (migration, OPERATOR_LIMITED precedent); salesperson as a **sub-role row** (like `shop_staff`) granted `DEALER` access scoped to one dealer |
| Shop geo-location, Nearby | **Present** | `shops.latitude/longitude`, `nearby-shops.ts` (Haversine) | Coverage map and duplicate proximity reuse the same SQL |

### 2.2 Modules in the strategy document and the prompt

| Module | Status | Reuse | Build |
|---|---|---|---|
| GKS-DR-001 Dealer registration & profile | Missing | OTP (`registration/otp.ts`), e-mail verify (`auth-email.ts`) | `dealers` table, application wizard `/dealer/apply`, lifecycle Draft→Pending→Approved→Suspended/Rejected/Terminated, agreement acceptance with dates |
| GKS-DR-002 Dealer documents & approval | Missing | `pan-crypto.ts` encryption + blind index, masking helpers, `revealPanForAdmin` pattern, bank ₹1 check | `dealer_document_requirements` (per dealer type), `dealer_documents`, admin queue `/admin/dealers` with reasons |
| GKS-DR-003 Dealer code engine | Partial | `referral_codes` unique index, `GKS`+alphabet generator (referral-requests.ts:339), `qrcode` lib, rate-limit presets | `GKS-MH-<REGION>-<6>` generator using `crypto.randomInt`, alphabet without 0/O/1/I/L, `dealer_codes` lifecycle (active/suspended/replaced/retired) + audit; QR SVG + `wa.me` share link |
| GKS-DR-004 Salespeople & subcodes | Missing | `shop_staff` sub-role pattern | `dealer_salespeople`, `GKS-FE-<6>` codes, activate/deactivate |
| GKS-SH-001 Self-registration | Present | all existing paths | Attribution hook only |
| GKS-SH-002 Dealer-assisted registration | Missing | OPERATOR_LIMITED session flow | `/dealer/shops/new`, SMS OTP to owner, owner pays via existing payment link / checkout |
| GKS-SH-003 Shop identity & duplicates | Partial | `shop-duplicates.ts` | Phone/GSTIN/geo matching, canonical shop + `parent_shop_id` for branches, branch commission rule |
| GKS-SH-004 Auto-approval on GST/PAN + payment | Partial | `autoApproveShopIfReady`, seller verification, payment webhooks (signature-checked) | Gate + evidence row `shop_auto_approval_log`, "ready for product upload" e-mail, retry via existing verification sweep |
| GKS-RA-001 Attribution & conflicts | Missing | `referral_redemptions`, help-desk tickets | `dealer_leads` (30-day window, open-lead cap), `shop_attributions`, dispute category |
| GKS-CM-001 Commission rules | Partial | `distributor_types` FLAT/PERCENT idea | `dealer_commission_rules` (fixed / % / both; shop type × district × milestone; effective dates; versioned), admin-only |
| GKS-CM-002 Ledger & payouts | Partial | `referral_commissions` states | `dealer_commission_ledger` (earned→pending→approved→paid, reversed, negative carry-forward), `dealer_payout_batches`, statement CSV. **No real money moves** — payouts record an external bank reference |
| GKS-CM-003 Rating & bonus | Missing | — | `dealer_rating_slabs`, `dealer_rating_history`, bonus calc per prompt 3.6 |
| GKS-DB-001 Dealer dashboard | Missing | Tile Board components, `board-data.ts` loaders | `/dealer` one-screen board |
| GKS-GEO-001 Territory & coverage | Missing | Haversine SQL, PIN→state | `geo_areas` hierarchy (Maharashtra→Region→District→Taluka/City→Locality, seeded for Pune pilot), `dealer_territories`; drawn coverage map (same fallback renderer as Nearby) |
| GKS-AN-001 Dealer performance score | Missing | `analytics.ts` | Weighted score, admin-set weights |
| GKS-AN-002 Activation & 30-day activity | Missing | orders tables | Per dealer / salesperson report |
| GKS-SP-001 Support Services | Partial | help desk (`createTicket`, status events, reopen), payment intents, shop wallet, platform invoices | `support_service_types` + versioned charges, quota, purpose `SUPPORT_SERVICE` on `payment_intents`, ticket categories, refund rule |

---

## 3. Design decisions per module

### 3.1 Where the new tables live (seller / customer split)

Classify every new table in `src/server/db/split/ownership.ts`:

- **seller:** `geo_areas`, `geo_area_pincodes`, `dealers`, `dealer_documents`, `dealer_document_requirements`, `dealer_codes`, `dealer_salespeople`, `dealer_territories`, `geo_areas`, `dealer_onboarding_sessions`, `dealer_leads`, `shop_attributions`, `dealer_commission_rules`, `dealer_commission_ledger`, `dealer_payout_batches`, `dealer_rating_slabs`, `dealer_rating_history`, `shop_auto_approval_log`, `shop_type_registration_fees`. Reason: they hang off shops, referral codes and payouts, all of which are seller tables, so foreign keys stay inside one database.
- **core (platform):** `feature_flags`, `feature_flag_changes`, `support_service_types`, `support_service_charges`, `support_service_requests`. Reason: support requests join `support_tickets`, `payment_intents` and the wallet ledger, which are on the core. The link from a support request to a shop is checked in the service (`integrity.ts`), not by a foreign key.

All writes to seller tables use `upsertRow` / target-less `onConflictDoNothing`. Commission accrual locks the dealer row and calls `touchSellerRow` because it counts other ledger rows against the cap (CLAUDE.md gate rule). E-mails and notifications go after commit through `notify()`'s outbox.

### 3.2 Feature flags

No generic flag mechanism exists. Added `feature_flags` (key, enabled, `district_codes` text[] — NULL = every district —, updated_by/at) and `feature_flag_changes` (old, new, **reason**, who, when), admin-only through `/admin/settings/feature-flags`, read live (no cache, like `referral_settings`), every change audited. Flags: `dealer_programme_enabled` (with districts), `gov_verification_auto_approval_enabled`, `dealer_rating_bonus_enabled`, `paid_support_services_enabled`. All seeded **off**. With a flag off, every new route answers `404 {code:"FEATURE_NOT_AVAILABLE"}` and no existing code path changes.

District of a shop: shops have no district column, and none is added. The district comes from the shop's PIN code through `geo_area_pincodes` (longest prefix wins: a locality's 6-digit PIN beats the district's "411"). A shop whose PIN is not mapped counts as "not in an enabled district". Seeded: Maharashtra, its 6 divisions and 36 districts (each with the 3-letter short code used in dealer codes), Pune's 3 cities/talukas and 10 localities, and PIN prefix 411 → Pune. Admins add more areas and PIN prefixes (`POST /api/geo-areas`).

### 3.3 Attribution priority (also written into `src/server/dealers/attribution.ts`)

1. A code entered or attached at registration (dealer code, salesperson code, or legacy code).
2. Otherwise a valid, unexpired, consented lead whose normalised phone (or GSTIN) matches — the **earliest** such lead wins.
3. Otherwise no attribution.

When rule 1 applies and an open lead from another dealer exists, that lead is closed with reason `CODE_AT_REGISTRATION` and both dealers are notified. A dealer may open an attribution dispute (help-desk ticket, category `DEALER_ATTRIBUTION`) carrying the lead, code and registration evidence; only an admin resolves it and the resolution is audited. Attribution is never moved silently.

### 3.4 Auto-approval rule and shop-type documents

With `gov_verification_auto_approval_enabled` on, `autoApproveShopIfReady` approves when **all** hold:

- GSTIN `VERIFIED` and active on the portal **or** (no GSTIN and a declaration) PAN `VERIFIED`;
- name match score ≥ rule threshold (reuse `nameMatchAutoApprove`, default 85);
- GSTIN's PAN = shop PAN when both are given (existing blind-index check);
- registration fee confirmed by a **server-side, signature-checked** webhook (`feePaymentStatus = PAID` set only by the webhook handler or a staff-recorded payment — a client "success" never sets it);
- no likely duplicate (GSTIN / PAN / phone already on another shop);
- **the shop-type mandatory documents still pass exactly as today** (`assertLegalDocsAllowApproval`, `assertFssaiAllowsApproval`). So a food shop with verified GST and paid fee but no FSSAI stays pending — the government check never replaces a shop-type licence.

Unlike today's `sellerVerification.autoApproveShop`, it does **not** require every other optional document (Shop Act, Udyam) to be verified. If any condition fails the shop stays `PENDING_APPROVAL` with the current pending message, and the failing reason goes to `shop_auto_approval_log`. A provider timeout leaves the verification `PENDING`; the existing `runSellerVerificationSweep` retries it and, on success, calls `autoApproveShopIfReady` again (scenario 27). E-mail failure never rolls back approval: the e-mail goes through the notification outbox after commit and is retried there (scenario 29).

`/shop/join` self-registration: with the flag off it is unchanged (approve on payment). With the flag on, it creates the shop `PENDING_APPROVAL` instead and hands over to the same gate once the owner completes GST/PAN in the profile step. This is the only behavioural change to an existing flow and it sits behind its flag (prompt §1.2).

### 3.5 Commission and rating

- Milestones: `REGISTERED` (shop created with attribution), `VERIFIED_CATALOGUE` (verification VERIFIED and ≥ N live products, N rule default 10), `ACTIVATED` (shop APPROVED, not paused, accepting orders). Pilot defaults ₹100 / ₹150 / ₹150 for standard shops; wholesale configured separately.
- Amount = fixed ₹ + % × fee actually paid. Rating bonus = (rating − 5.0) percentage points, added to the % for percentage rules; for fixed rules applied to the fee paid (or to the base amount — admin setting).
- Each ledger row stores rule id + version, rating at accrual, milestone, dealer, salesperson, shop, approver. Cap per shop (default ₹999 = below the ₹1,000 fee) blocks accrual above it unless an admin override row exists.
- Rating recount when a shop activates or a commission is reversed: count activated, non-duplicate, non-reversed shops; take the highest slab reached, but never below an admin-set start rating; admin manual downgrade overrides until the next slab is crossed (audited, visible to the dealer). Applies to accruals after the change only.
- Suspended/terminated dealer: no new accruals; existing `earned`/`pending`/`approved` rows move to `on_hold` until an admin decides.

### 3.6 Support services and the managed-billing charge

Existing "managed" charge = `platformInvoicing.billingManagementFeePaise` per payout cycle (default 0); no annual managed-inventory plan exists. Setting `supportServices.freeForManagedBilling` (default true): shops paying a non-zero billing-management fee get Product Upload and Price Update at ₹0.

---

## 4. Legacy referral codes → "Gokesari Direct" (migration plan)

Owner decision (28 Oct): a distributor is a dealer and keeps its code; its employees are identified by an optional Employee ID / name.

1. For each **distributor**: a `dealers` row (status APPROVED, `legacy_distributor_id` kept). Each of its existing `referral_codes` rows becomes that dealer's code (a `dealer_codes` row of kind `LEGACY` pointing at it).
2. Migration also creates dealer `Gokesari Direct` (type COMPANY, APPROVED, `is_internal = true`, earns nothing — internal dealers are excluded from commission and rating). Each **referral code with no distributor** becomes a Gokesari Direct code; `referrer_name` is kept as the employee name on it.
3. **The `referral_codes` rows themselves are not changed** — code string, status, expiry, max_uses, redemptions and `referral_commissions` stay where they are, so validation and history are untouched.
4. Salespeople: a dealer registers employees with an **Employee ID** (unique within the dealer) and name. At registration (self, dealer-assisted, operator) an **optional** "Employee ID / name" field sits next to the referral code. When it matches one of that dealer's active employees, the shop is attributed to dealer + employee for individual commission reporting; when it is blank or unknown, the shop is attributed to the dealer alone and the typed text is kept for the dealer to correct. Each employee additionally gets a `GKS-FE-…` code (prompt 3.2) that can be shared instead — entering it fills both dealer and employee.
5. Existing distributor commissions keep accruing in `referral_commissions` through the old path (`approveRegistration`). New dealer commission only accrues for codes of kind DEALER / SALESPERSON. No shop is paid twice.
6. Rollback: delete the rows the migration inserted (all tagged `source = 'LEGACY_MIGRATION'`); nothing in the legacy tables to undo.

Note on point 5: once a distributor's code also counts as a dealer code, new registrations under it accrue **dealer** commission (milestones, rules, rating) and no longer the old single distributor commission, so a shop is never paid twice. This switch happens only in districts where `dealer_programme_enabled` is on; elsewhere the old distributor commission continues unchanged.

---

## 5. Existing flows touched and the test that protects each

| Flow | Touched by | Protecting test (exists) | New test to add first |
|---|---|---|---|
| Referral code validation (both endpoints) | dealer-status check in `resolveUsableCode` | `referral-codes.test.ts`, `referral-abuse-risk.test.ts`, `rate-limit-routes.test.ts` | legacy code still resolves with all flags off and on |
| Mandatory/optional toggle | none (codes are `referral_codes` rows) | `referral-settings.test.ts` | — |
| Request a referral code | lead routing after insert | `customer-referral-requests.test.ts` (customer side only) | `referral-request-shop.test.ts`: e-mail + 24 h duplicate window unchanged |
| `/shop/join` self-registration | attribution hook; flag-on pending path | `shop-self-registration.test.ts` | flag-off snapshot of approval outcome |
| Add my shop / operator register | attribution hook; fee by type (flag on) | `registration-fees.test.ts`, `shop-duplicate-registration.test.ts`, `qa-2026-10-24-sellers.test.ts` | fee unchanged with flag off |
| Operator-limited onboarding | none (pattern copied) | `batch-d-operator-limited.test.ts` | — |
| Seller verification + auto-approve | new gate inside `autoApproveShopIfReady` | `seller-verification*.test.ts` (4 files), `legal-documents.test.ts`, `document-uploads.test.ts` | `sellerVerification.autoApproveShop` behaviour with the new flag off |
| GST/PAN legacy columns | read only | `gst-pan-verification.test.ts` | — |
| Bank ₹1 verification | new holder type | `bank-accounts.test.ts`, `bank-account-check.test.ts` | — |
| Payment intents + webhooks | new purpose `SUPPORT_SERVICE` | `batch-a-payments.test.ts`, `payments.test.ts` | existing purposes untouched |
| Shop wallet | new entry types | `shop-wallet-delivery-otp.test.ts`, `wallet.test.ts` | — |
| Help desk | new categories | `batch-c-helpdesk.test.ts` | — |
| Roles / RBAC | new `DEALER` role | `qa-2026-10-24-rbac-order.test.ts`, `tests/qa/local/access-roles.spec.ts` | DEALER cannot reach any admin/operator route |
| Split layout | new tables | `db-split-ownership.test.ts`, `migration-journal.test.ts`, CI `test-split` | — |

---

## 6. Conflicts and decisions taken

| Conflict | Decision |
|---|---|
| Prompt: commission only admin. Today: operators can edit distributor commission rates. | New rules admin-only. Legacy endpoints left as is (no-regression). Recommend a separate change to make them admin-only. |
| Prompt: "event-driven, not cron". The event bus has no subscribers. | Direct service calls in the same transaction + event for notifications (F6). The *retry* of a provider outage uses the existing verification sweep cron — that is retry, not the trigger. |
| Prompt: "₹1,000 shop / ₹2,500 wholesale". No such fees exist. | Fee by shop type, only with the dealer flag on (F2). |
| Strategy: salesperson code mandatory for dealer-assisted registration attributed to a salesperson. Prompt: dealer picks the salesperson. | Salesperson optional; when picked, its code is recorded. |
| Prompt: owner OTP. OPERATOR_LIMITED uses e-mail OTP. | Dealer flow uses SMS OTP to the owner's mobile (the prompt says "on their own mobile"); falls back to e-mail OTP only if SMS is not configured on that site, recorded on the session. |
| Prompt §7.2: enable flags on Prod and run scenarios with live verification. CLAUDE.md: production changes in an owner-approved window, one release at a time. | Prod deploy with **all flags off** follows the normal release check. Turning flags on in Prod and any live verification call wait for the owner's explicit go-ahead. No real payouts at any time. |
| Prompt: "full DB backup before any migration". | Test: `test-db.yml` already takes a pg_dump. Prod: `prod-db.yml` records a Neon restore point but makes **no dump** — add a pg_dump step before the Prod migration. |
| Prompt: encrypt verification responses at rest. | Seller verification already stores no raw response (normalised fields only). `gstin_lookups.raw` (GSP mock) is stored in clear — new code never writes there; flagged as a gap. |

---

## 7. Questions for the owner (answered 28 Oct)

Answers: Q1 — distributor = dealer with its code; employees by optional Employee ID / name (§4). Q2 — keys to be set on Hostinger today. Q3 — admin-defined fee slabs with shop types assigned (F2). Q4 — owner sets Play signing and `EXPO_TOKEN`.


1. **Legacy codes:** are the `distributors` (and codes with a referrer name but no distributor) the "sales executives" to move under Gokesari Direct? If there is another list, where is it?
2. **Verification credentials:** is a Gridlines (or other GSP/KYC) account active, and are `KYC_PROVIDER` / `GRIDLINES_API_KEY` set on Hostinger for test and production? Without them GKS-SH-004 ships with the mock and stays off on Prod.
3. **Wholesale fee:** confirm ₹1,000 / ₹2,500 as the dealer-programme fees, and which existing shop types count as "wholesale" (today only `WHOLESALE_STORE`).
4. **Android signing:** the APK workflow is not Play-signed. Is the Play release done elsewhere (EAS)? `EXPO_TOKEN` needed for iOS TestFlight.

---

## 8. Build sequence

| Step | Modules | Migration | Lands on |
|---|---|---|---|
| 1 | Flags, geo areas (Pune pilot seed), `DEALER` role — **done 28 Oct** | 0101 role (both), 0102 flags (core), 0103 geo (seller) | staging |
| 2 | GKS-DR-001…004 (dealers, documents, codes, employees), legacy migration — **done 28 Oct** (`/dealer/apply`, `/dealer`, `/admin/dealers`) | 0104 (seller) | staging |
| 3 | GKS-SH-001…003, GKS-RA-001 (attribution, leads, dealer-assisted with owner code, duplicates, claims, `?ref=` link, optional Employee ID) — **done 28 Oct**; fee slabs stay by turnover (owner, 28 Oct) | 0105 (seller) | staging |
| 4 | GKS-SH-004 auto-approval + e-mail | 0106 | staging |
| 5 | GKS-CM-001…003 (rules, ledger, payouts, rating) | 0107 | staging |
| 6 | GKS-DB-001 dealer board, admin screens | — | staging |
| 7 | GKS-SP-001 support services | 0108 (core) | staging |
| 8 | GKS-GEO-001, GKS-AN-001/002 (P1) | — | staging |
| 9 | App link paths, APK + iOS builds | — | workflows |
| 10 | Full suite on Test, report, tracker; Prod with flags off | — | main (one release) |

Each step: tests first for the touched flow, migration with `-- split:` line and `rollback-NNNN.sql`, ownership entries, unit + integration tests on both layouts, push to staging, check test.gokesari.com.
