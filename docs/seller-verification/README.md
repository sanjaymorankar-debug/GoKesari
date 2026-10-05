# Seller verification (PAN, GSTIN, Udyam, FSSAI, Shop Act)

Status: **Part 2 (architecture) built against a mock vendor.** Part 3
(per-document flows, onboarding and admin screens, re-verification job) and
Part 4 (legal/compliance build-in) follow.

## Vendor decision (Part 1, approved 5 Oct 2026)

- **Primary: Gridlines.** Covers all five documents with one contract; its
  FSSAI result includes licence type, status, validity and premises pincode.
- **Backup: IDfy.** Adapter not built yet; added only if Gridlines is replaced
  or a fallback is needed. The flows don't change either way.
- **Maharashtra Shop Act:** no vendor confirms coverage, and most small shops
  hold a Form G intimation receipt (fewer than 10 workers) rather than a Form B
  certificate. Upload plus admin review is the main path; a vendor check is a
  bonus where it works.
- **Upfront charges:** none published by either vendor; sandboxes are free.
  Live use is prepaid credits, amount per the quote.

Still to confirm with Gridlines in writing before going live: exact FSSAI and
GSTIN response fields, Shop Act state list (and whether Form G is covered),
per-call prices, whether IP whitelisting is mandatory, data retention and DPA.

## Code map

| Piece | File |
|---|---|
| Format checks (client-safe) | `src/lib/kyc/doc-formats.ts` |
| Vendor interface and errors | `src/server/kyc/types.ts` |
| `verifyDocument()` entry point | `src/server/kyc/index.ts` |
| Timeouts, retries, idempotency key | `src/server/kyc/http.ts` |
| Adapters | `src/server/kyc/adapters/{mock,gridlines}.ts` |
| Submission pipeline | `src/server/services/seller-verification.ts` |
| Tables | `drizzle/0040_seller_verifications.sql` (rollback: `scripts/rollback-0040.sql`) |

The Gridlines endpoint paths and field names come from its public docs and
must be confirmed with sandbox keys (`GRIDLINES_ENDPOINTS` in the adapter). A
response the adapter can't read sends the document to manual review; it is
never treated as verified.

## Settings per site

Set in hPanel → the site → environment variables. Never commit them. To apply,
use Deployments → Redeploy → "Settings and redeploy" — never "Change
repository", which has wiped environment variables before.

| Variable | Local / CI | test.gokesari.com | gokesari.com |
|---|---|---|---|
| `KYC_PROVIDER` | `mock` | `mock` until sandbox keys arrive, then `gridlines` | `gridlines` |
| `KYC_ENV` | `sandbox` | `sandbox` | `production` |
| `GRIDLINES_API_KEY` | — | sandbox key | live key |
| `GRIDLINES_BASE_URL` | — | only if Gridlines gives a separate sandbox host | — |
| `PAN_ENCRYPTION_KEY` | test key | already set | already set |

`kycConfigProblem()` in `src/lib/env.ts` refuses live keys anywhere but
gokesari.com, and mock or sandbox on gokesari.com. A refused setting stops
verification (documents wait in PENDING); it does not take the site down.

## Mock vendor test numbers

The mock decides by the number. For PAN and GSTIN the four digits of the PAN
(GSTIN characters 8–11) decide; for the others, the last four digits.

| Ends in | Result |
|---|---|
| `0000` | not found → FAILED |
| `9999` | vendor timeout → PENDING |
| `8888` | inactive / cancelled / expired → FAILED or EXPIRED |
| `7777` | name on record doesn't match (name matching arrives in Part 3) |
| `6666` | FSSAI expiring in 20 days |
| `5555` | vendor can't check this → MANUAL_REVIEW |
| anything else | active → VERIFIED |

Shop Act in Maharashtra returns "can't check" (MANUAL_REVIEW) unless the
number ends in `2222`.
