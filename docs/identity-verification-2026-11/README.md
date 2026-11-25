# One-time identity verification: customers and shop owners (24-Nov-2026)

Branch `feat/identity-verification-2026-11-24`, migration `drizzle/0201_identity_verification.sql`.
**Legal advice is pending.** Keep both switches off on gokesari.com until a lawyer has reviewed the
consent wording, the retention period and the gates.

## What it does

- **Customers** verify their identity **once, before their first order**. Checkout refuses the order
  (409, `needsIdentityVerification`) and the cart sends them to `/profile/verify-identity?next=/cart`,
  then back. Once VERIFIED they are never asked again.
- **Shop owners** verify **before a shop goes live**: every way a shop is approved (admin, operator,
  automatic, instant government-verification approval) goes through `approveShopTransaction`, which
  refuses while the owner is not verified. When the owner is verified later, their pending shops are
  re-tried for automatic approval.
- **Existing shop owners** are asked at their next Seller Central visit (banner in the seller shell,
  `src/components/seller/identity-grace-banner.tsx`). They have **`sellerGraceDays` (default 30)** from
  that first prompt. After that their shops take **no new orders** (checkout refuses the shop, and the
  shop cannot accept a CONFIRMED order). Orders already accepted carry on.
- Methods: **Aadhaar through DigiLocker** (default, voluntary) and **PAN** (always offered unless the
  rule says `aadhaar_only`). Driving licence and voter ID are **not available** (see the table below):
  no adapter checks them, and the existing upload mechanisms (rider documents, shop documents) are
  tied to riders / shops and would store an image of the card — which this feature must not do.

The page is **`/profile/verify-identity`** (not `/account/…`): a new top-level path would have to be added
to the Android app's App Link prefixes (a native change and a new app build); under `/profile` it opens
in the app already.

## Admin: switches, review queue, counts

**Admin → Settings → Identity verification** (`/admin/identity-verification`, admins only; operators and
others are sent home, the APIs answer 401/403):

| Tab | What |
|---|---|
| Settings | Two switches, each with its state, last change (who, when in IST, reason) and a required reason: **"Customers: verify identity before first checkout"** (`identity_verification_customers_enabled`) and **"Shop owners: verify identity before going live / accepting orders"** (`identity_verification_shop_owners_enabled`). Saved through `PUT /api/admin/feature-flags` → `setFeatureFlag`, so every change is logged and audited, and waits for a second admin while `rbac_v2_four_eye_admin` is on. Also shows rule `identityVerification` (allowed methods, grace days, name-match threshold, provider). |
| Review queue | Checks in `NAME_MISMATCH_REVIEW` (name below the threshold, identity already verified on another account, unreadable document, provider could not decide). Approve / Reject with a note; audited (`identity.verification_decided`) and the person is told. |
| Status | Attempts by audience × method × status. |

The admin users list (`/admin/console/users`) has an identity status badge per user and an identity
filter (verified / in review / not started / not verified).

### Switching on and off

- Each switch gates **only its own audience**: customer checkout ↔ customers switch; go-live, order
  acceptance, the seller banner and the grace period ↔ shop owners switch.
- **Off lifts the requirement at once** (no blocking, no banner, the APIs answer 404) and **keeps** the
  stored verifications. A person verified once stays verified when it is switched back on.
- **Back on (shop owners)**: the grace period starts again from the first prompt *after* the switch was
  turned back on. A prompt recorded before the most recent off → on change in the flag's change log is
  ignored, and the next prompt overwrites `first_prompted_at`. (When the flag was set without a change-log
  entry — seeded or set directly in the database — existing prompts count.)

Both flags are seeded **OFF** by the migration.

## Rule `identityVerification` (Admin → Settings → rules)

| Field | Default | Meaning |
|---|---|---|
| `allowedMethods` | `aadhaar_or_alternative` | `aadhaar_only` hides PAN. Aadhaar use must be voluntary: keep the default unless a lawyer says otherwise. |
| `sellerGraceDays` | 30 | Days an existing shop owner has from the first prompt. |
| `nameMatchThreshold` | 80 | 0–100 (`lib/kyc/name-match.ts`). Below it → review queue. |
| `provider` | `kyc_provider` | `kyc_provider` = KYC_PROVIDER's adapter; `mock` is refused on gokesari.com. |

### Staging: always the mock

`identityProviderSource()` returns **`mock` on every site that is not production** (`isProductionSite()`),
whatever the rule says — test.gokesari.com never sends a real Aadhaar or PAN to a vendor, even though its
KYC keys are live. The mock DigiLocker page is `/mobile-auth/digilocker-mock` (Approve / Approve in
another name / Deny / Expire / Down). Mock PAN: digits 6–9 of the PAN pick the scenario (`…7777…`
mismatched name, `…0000…` not found, `…9999…` timeout), e.g. `ABCPE1234F` verifies.

## Consent and what is kept

Consent screen (`src/components/identity-verification-form.tsx`, text in `src/lib/kyc/identity.ts`,
version `IDENTITY_CONSENT_VERSION`): purpose; what is kept; what is never kept; retention
(`IDENTITY_RETENTION_TEXT`: while the account is open, then deleted except where a law requires a
longer record); Aadhaar is voluntary and PAN is the alternative; an **unticked** checkbox. Consent time,
version, IP and user agent are stored on the attempt.

Table `identity_verifications` (one row per attempt; at most one VERIFIED and one PENDING per user):
`method`, `status` (PENDING / VERIFIED / NAME_MISMATCH_REVIEW / REJECTED / FAILED), `masked_id` (last
four only — a database check refuses more than four digits), `id_token` (keyed blind index of the
DigiLocker account id or PAN, to spot the same identity on two accounts), `provider`, `provider_ref`,
`verified_name`, `compared_name`, `name_match_score` / `name_match_result`, consent fields, review fields,
timestamps (UTC). Table `identity_verification_prompts`: `first_prompted_at` per shop owner.

**Never stored:** the Aadhaar number, any OTP, the e-KYC XML / document, photo, date of birth or address,
the full PAN. Identity numbers are masked in logs and errors: `src/lib/kyc/identity-mask.ts`
(`redactIdentityNumbers`, `redactForLog`), also applied to the server's unhandled-error log
(`src/lib/errors.ts`).

## DigiLocker: shared with the rider flow

The session handling moved to `src/server/kyc/digilocker-session.ts` and is used by both
`services/rider-kyc.ts` and `services/identity-verification.ts`: one return link
(`/mobile-auth/digilocker-return?k=…` — the route tries the rider check, then the identity attempt),
one webhook (`/api/webhooks/sandbox-co/digilocker` — same order), the same app hand-back
(`<scheme>://digilocker-return?result=verified|pending|failed`; in review → pending, rejected → failed).

**Mobile app:** no change and **no version bump needed** — the page calls the existing bridge
`__gokesariApp.openDigiLocker(url)` (app 1.6.0+), the URL allow-list (`mobile/src/digilocker.ts`) already
covers DigiLocker and the site's mock page, and the callback is the same. A test was added in
`mobile/src/__tests__/digilocker.test.ts`.

## Adapter support (from the code, 24-Nov-2026)

| Adapter | DigiLocker Aadhaar | Aadhaar OKYC (OTP) | PAN | Driving licence | Voter ID |
|---|---|---|---|---|---|
| `sandbox-co` (Sandbox.co.in) | Yes (`/kyc/digilocker/sessions/*`) | Legacy only (`/kyc/aadhaar/okyc/*`, discontinued by Sandbox; rider rule `okyc_legacy`) | Yes (`/kyc/pan/search/lite`) | No | No |
| `gridlines` | No | No | Yes (`/pan-api/fetch-detailed`, endpoints "confirm in sandbox") | No | No |
| `cashfree` (Verification Suite) | No | No | No (used for FSSAI only here) | No | No |
| `mock` | Yes (fake page) | Yes (fake OTP 123456) | Yes | No | No |

So: Aadhaar → DigiLocker through Sandbox.co.in; PAN → Sandbox.co.in (or Gridlines); **driving licence
and voter ID → not available** (shown as such on the page). Adding them needs an adapter method (Sandbox
and others sell DL / voter ID lookups — to confirm) and a decision on whether to allow manual upload.

## Cost per check and activation

What the repository says (no prices are recorded anywhere in `docs/`):

- KYC provider in use: **Sandbox.co.in, live keys, for PAN / GST / Aadhaar** (owner, 09-Nov-2026);
  Cashfree Secure ID is used for the bank-account check only.
- Sandbox.co.in DigiLocker session: **price per session — to confirm with the provider.**
- Sandbox.co.in PAN lookup (`search/lite`): **price per call — to confirm with the provider.**
- Gridlines: "no upfront charges published; sandboxes are free; live use is prepaid credits, amount per
  the quote" (`docs/seller-verification/README.md`); per-call prices **to confirm with the provider**.
- Activation: DigiLocker on Sandbox needs the DigiLocker product enabled on the live account and the
  webhook (`SANDBOX_CO_WEBHOOK_SECRET`) — already in place for riders; **confirm with Sandbox that the
  existing DigiLocker consent purpose covers customer / shop owner identity checks** (the rider flow's
  purpose was delivery partner KYC).

Cost control in the code: one verified check per person ever; rate limits (10 DigiLocker starts and
5 PAN checks per hour per user); an open DigiLocker link is reused rather than a new session started.

## Files

| Piece | File |
|---|---|
| Migration | `drizzle/0201_identity_verification.sql` (journal idx 187) |
| Tables, flags | `src/server/db/schema.ts` (`identityVerifications`, `identityVerificationPrompts`, two flag keys) |
| Rule | `src/server/config/rules.ts` `identityVerification` |
| Service | `src/server/services/identity-verification.ts` |
| Shared DigiLocker | `src/server/kyc/digilocker-session.ts` (+ `verifyDocument(…, { source })` in `src/server/kyc/index.ts`) |
| Masking | `src/lib/kyc/identity-mask.ts`; wording `src/lib/kyc/identity.ts` |
| Gates | `services/orders.ts` (checkout, accept), `services/shops.ts` (go-live) |
| APIs | `/api/account/identity` (GET), `/digilocker`, `/digilocker/sync`, `/pan` (POST); `/api/admin/identity-verifications` (GET), `/[id]/decision` (POST) |
| Pages | `/profile/verify-identity`, `/admin/identity-verification`, cart prompt, seller banner, admin users column |
| Tests | `tests/integration/identity-verification.test.ts`, `tests/unit/identity-mask.test.ts`, `tests/qa/guest/identity-verification.spec.ts` (TC-IDV-001), mobile `digilocker.test.ts` |

## Not done / open

- Legal review of the wording, retention and gates (owner / lawyer).
- Provider prices and confirmation that Sandbox's DigiLocker purpose covers this use.
- Driving licence / voter ID (no adapter).
- No reminder notifications during the grace period beyond the banner and the page (could be a cron job).
- Self-service shop registrations (Module 3, `registration/service.ts`) create the shop already live; with
  the shop owners switch on, those owners get the grace period like existing shops rather than a go-live block.
