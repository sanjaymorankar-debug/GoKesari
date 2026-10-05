# Seller verification (PAN, GSTIN, Udyam, FSSAI, Shop Act)

Status: **Parts 2 and 3 built against a mock vendor** — architecture,
per-document flows, seller and admin screens, and the daily re-verification
job. Part 4 (legal/compliance build-in) follows.

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
| Submission pipeline, admin review | `src/server/services/seller-verification.ts` |
| Per-document rules, consistency score | `src/server/services/seller-verification-checks.ts` |
| Name matching | `src/lib/kyc/name-match.ts` |
| Daily job | `src/server/services/seller-verification-jobs.ts`, `POST /api/cron/seller-verification` |
| Seller screen | `/shop/verification` |
| Admin review queue | `/admin/seller-verification` |
| Tables | `drizzle/0040_seller_verifications.sql`, `drizzle/0041_seller_verification_files.sql` (rollback: `scripts/rollback-0040.sql`) |

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

## How each document is decided (Part 3)

A document is **VERIFIED without a person** only when the vendor says it is
active *and* every rule below passes *and* the shop's cross-document
consistency score is at least `consistencyAutoApprove` (80). Anything else
goes to **MANUAL_REVIEW** with a reason code; nothing ever turns a vendor
failure into a pass.

| Document | Needed | Checks |
|---|---|---|
| PAN | Always | Active; name on record matches the owner, legal or shop name (score ≥ 85) |
| GSTIN | Always — or a reviewed "not GST-registered" declaration | Active; the PAN inside it is the shop's PAN; name; state (GST code vs PIN code) |
| Udyam | Optional | Active; enterprise or owner name |
| FSSAI | Food shops (food shop type, or any food-aisle category) | Active; expiry date present; premises PIN code is the shop's; name |
| Shop Act | Always (confirm with a lawyer for non-MH / home sellers) | Certificate or Form G receipt upload required. Vendor asked first; where it can't check (Maharashtra today) an admin compares the upload with the typed number |

**Consistency score** (0–100): average name match (weight 40), GSTIN↔PAN
linkage (25), PIN code agreement (20), state agreement (15). Components with
no evidence are left out and the rest re-weighted.

**Name matching** ignores "M/s", "Shri", punctuation, word order and
"Pvt Ltd"/"Private Limited"; it accepts initials and small typos. Same-name
variants score 87–100; different people or businesses score below 60.

**Write-through**: a verified GSTIN (and legal name, if empty) and FSSAI
number are copied to the shop's public seller details, so the shop page
shows what was verified.

**Admin queue** (`/admin/seller-verification`, admins and operators with
GST/PAN verify rights): approve, reject with a reason the seller sees, or
re-check with the vendor. Opening an uploaded certificate is recorded in the
audit log.

**Thresholds are settings, not code** (`sellerVerification` rule, editable in
admin settings): name-match and consistency thresholds, GST re-check
interval (30 days), expiry warning (30 days), pending retry (15 minutes),
paid checks per shop per hour (10), auto-suspend on lapse (on) and its grace
period (0 days).

## Daily job

Schedule `POST /api/cron/seller-verification` once a day (06:30 IST works),
with `Authorization: Bearer $CRON_SECRET`, the same way as the other cron
routes. It:

1. retries documents a vendor outage left PENDING;
2. re-checks verified GSTINs every 30 days;
3. warns sellers 30 days before an FSSAI or Shop Act expiry (once per date);
4. marks documents past expiry EXPIRED;
5. takes an approved shop offline (SUSPENDED) when a mandatory document has
   expired or been cancelled at source. **Open orders are held for an
   operator, never refunded automatically.** The shop owner is told what to
   submit; an admin reinstates the shop from Shop suspensions after the
   document is verified.

At most 50 vendor calls per step per run, so an outage can't turn one run
into thousands of paid calls. The response reports counts and `errors`;
alert when `errors` is non-empty.

## Resilience summary

Timeouts (8 s) with 2 retries and backoff; an idempotency key per attempt; a
row lock so a double click makes one paid call; a verified, unexpired number
is served from the stored result; at most 10 seller-triggered paid checks
per shop per hour; a vendor outage leaves documents PENDING (the seller is
never failed for it) and the daily job retries them.

## Not included

- **Reading the number off an uploaded certificate (OCR).** The seller types
  the number; the admin compares it with the upload.
- **The IDfy adapter.** Built only if needed; the flows won't change.
- **Shop approval.** Verification doesn't approve or reject a shop
  registration by itself; admins see verification status when approving.
