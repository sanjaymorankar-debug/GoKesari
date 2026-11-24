# Dealership & Franchise Platform — Phase 1: scheme foundation (23-Nov-2026)

Owner brief "Unified Dealership & Franchise Management Platform" (23-Nov-2026). Gap analysis:
[GAP_ANALYSIS_2026-11-23.md](GAP_ANALYSIS_2026-11-23.md). Owner, 09.20 IST: **"Yes, use defaults"** for decisions D1–D10.

## Decisions in force (owner's answers, 25-Nov-2026)

The defaults below were accepted on 23-Nov-2026 at 09.20 IST. On 25-Nov-2026 (about 01.30 IST) the owner
answered each one again; migration 0190 applies the changes on both sites.

| # | Decision (25-Nov-2026) | Was (23-Nov default) |
|---|---|---|
| D1 | **Free Dealership: 20% one-time on the shop registration fee, no monthly commission** (version 3). Dealers who joined on version 2 move to version 3 | 20% + 5% of GoKesari's commission monthly for 12 months |
| D2 | **Business Partner and Growth Partner stay switched off** (suspended, no new applicants). The admin can publish them again in Admin → Dealer schemes | Open at the brief's rates |
| D3 | Yes: when they open, 18% GST is added on top (₹12,980 and ₹24,780) | Same |
| D4 | No change: up to 2 franchise owners per zone | Same |
| D5 | No change: current zones; no metro / rural rule | Same |
| D6 | Off: no monthly commission on dealerships (follows D1 and D2) | 5% of GoKesari's 2% = 0.1% of delivered sales |
| D7 | Off: no monthly commission duration needed while Business / Growth are off | 12 months, renewable |
| D8 | Yes: existing dealers stay on Free Dealership version 1, their current terms | Same |
| D9 | Later: the owner assigns people to the new admin roles | Same |
| D10 | OK: through the staging queue, then production | Same |

## What phase 1 adds

Migration `0177_dealer_schemes` (rollback `scripts/rollback-0177.sql`):

- **`dealer_schemes`**: one row per scheme. Its code, name, category (DEALERSHIP / FRANCHISE) and status (DRAFT, SCHEDULED, PUBLISHED, SUSPENDED, EXPIRED or ARCHIVED).
- **`dealer_scheme_versions`**: the terms as JSON, validated by `schemeTermsSchema` (`src/lib/dealer-schemes.ts`).
  - Covers the joining charge and GST, validity, renewal, geography, exclusivity, zone booking, team building, the commission budget and the commission components (one-time, recurring, team, referral, target, renewal, development, performance).
  - The database stores the SHA-256 of the terms.
  - A trigger stops anyone changing or deleting a version once it is published. Its status can move only DRAFT → PUBLISHED / WITHDRAWN, or PUBLISHED → SUPERSEDED.
  - Only one version per scheme can be published at a time.
- **`dealer_scheme_assignments`**: the scheme each dealer is on over time, with a copy of the terms and their hash.
  - Each dealer has one ACTIVE row.
  - A trigger stops rows being deleted. On an active row, only `status`, `ends_at` and `end_reason` can change; an ended row cannot change at all.
- **Triggers that keep assignments right on every code path:**
  - Every new dealer starts on Free Dealership: from an application, a franchise pay-first buyer, an admin, or a legacy import. GoKesari Direct is excluded.
  - When a franchise allocation becomes ACTIVE or SUSPENDED (paid), the dealer moves to Territory Franchise.
  - When his last paid allocation ends (expiry, refund, cancellation), he returns to the dealership scheme **and version** he had before.
- **`dealers.logo_url`**: the dealer's own logo (CF-011 reuse; see below).

Seed:

| Scheme | Version | Status | Calculation |
|---|---|---|---|
| Free Dealership | 1, terms before 23-Nov-2026 | PUBLISHED: all existing and new dealers | LEGACY_DEALER (Dealer commission, unchanged) |
| Free Dealership | 2, brief 20% + 5% monthly | DRAFT until the scheme calculator (phase 3) | SCHEME |
| Business Partner | 1, ₹11,000 + GST, 25% / 15% | DRAFT until registration takes the fee (phase 2) | SCHEME |
| Growth Partner | 1, ₹21,000 + GST, 30% / 25% + team | DRAFT, as above | SCHEME |
| Territory Franchise | 1, franchise config version 2 | PUBLISHED | LEGACY_FRANCHISE (Franchise settings, unchanged) |

**Commission is not changed in phase 1.** Every payout still comes from the existing code. The schemes record the terms, and every dealer has a scheme from now on.

## Screens

- **Admin → Dealers → Schemes** (`/admin/dealers/schemes`): every scheme and version, with its terms in plain words, the number of dealers on each, and a terms fingerprint. Read-only; the scheme builder comes in phase 4.
- **Admin → Dealers → a dealer:** a "Scheme" card showing the current scheme, version, start date and terms, plus the scheme history.
- **Dealer portal** (`/dealer`): a "Your scheme" line, and the **Dealer logo** card.

## Dealer logo (CF-011 reuse; owner 23-Nov-2026 "integrate this with dealer module")

- `POST` / `DELETE /api/dealer/logo` for the signed-in dealer; GoKesari Direct and terminated dealers cannot use it.
  - It stores the image like a product photo (`saveImage`).
  - It records the audit entry `IMAGE_UPLOADED {purpose: "DEALER_LOGO"}`.
  - It sets `dealers.logo_url`.
  - It allows 10 uploads per 10 minutes.
- **Flag:** the same `shop_logo_upload_enabled` as shops, checked for the **dealer's own district** (from his PIN code). A flag limited to some districts therefore reaches only dealers there.
- **Card:** `<ShopLogoUpload endpoint="/api/dealer/logo" heading="Dealer logo" … />` (props from PR #492).

## Tests

`tests/integration/dealer-schemes.test.ts` (8 cases):

- the seed schemes are valid;
- GST totals are right;
- invalid terms are refused;
- a new dealer gets Free v1 and GoKesari Direct gets no scheme;
- published terms and history cannot be changed;
- pay → franchise → refund → back on Free v1, even after Free v2 is published;
- logo: flag off, flag on, district-limited flag, delete, non-dealer.

`tests/integration/migrate-on-build.test.ts`: `rollback-0177` to `rollback-0181` added to the rollback chain (newest first).

## Release

- Built on top of #487 (RBAC 0171–0175) and #492 (logo card props). The PR into `staging` opens once both are on `origin/staging`, after CF-006 (#498, migration 0176), so the dealer platform migrations are 0177–0181.
- **Production:** the owner (via the CF-011 session, 09.26 IST) wants one joint release with the logo work (#489 / #490 / #492) at once after staging-verified.
- **Production database:** the normal `prod-db migrate` step; nothing else is needed. Production has 1 dealer, who is assigned to Free v1.
- **Flags:** `shop_logo_upload_enabled` stays OFF on production (no new flag).
