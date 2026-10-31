# Gig worker (delivery partner) flow — 31 Oct 2026

Eleven features for delivery partners and the shop owner and customer screens
they touch. Audit of what existed: [AUDIT_2026-10-31.md](AUDIT_2026-10-31.md).
Test report: [TESTING_REPORT_GIG_WORKER.md](TESTING_REPORT_GIG_WORKER.md).

## What the partner does

1. **Register** — `/delivery-partner/register`: name, mobile, email, date of
   birth (18+), gender, address, vehicle type and number, emergency contact,
   and the phone's current location (the form can't be sent without it).
   One partner per mobile number.
2. **KYC** — `/delivery-partner/kyc`: tick the consent, verify the PAN, then the
   Aadhaar with an OTP to the Aadhaar-linked mobile. Each shows Verified,
   Pending or Failed.
3. **Documents** — `/delivery-partner/documents`: police verification form and
   character certificate (PDF, JPG or PNG).
4. **Approval** — an admin approves the application as before
   (Admin → Riders), then reviews KYC and documents at
   **Admin → Rider verification** (`/admin/rider-verification`).
5. **Offline / Active / Ready** — on `/delivery-partner`. Active and Ready need
   PAN and Aadhaar Verified and both documents Approved, unless an admin
   overrides the gate for that partner. Only **Ready** partners get new offers.
6. **Deliveries** — offers come only when the partner's live location is within
   the zone of both the shop and the customer. Pickup with the shop's code and
   an optional photo; delivery with the customer's code (or without, if the
   rule says so) and the photo at the door when that rule is on.
7. **Completed** — once the delivery is confirmed, the order shows Completed
   and the customer and the shop each get an in-app message, a push
   notification and an SMS.

## Settings (Admin → Settings)

| Rule | Field | Default | What it does |
|---|---|---|---|
| `riderVerification` | `gateAvailability` | on | Active / Ready need KYC + police verification (admin can override per partner) |
| | `requireCharacterCertificate` | on | The character certificate is part of the gate |
| | `maxDocumentBytes` | 5 000 000 | Largest police verification / character certificate file |
| | `aadhaarOtpMaxAttempts` | 3 | Wrong Aadhaar OTPs before a new one is needed |
| `riderZoning` | `enabled` | on | Zone check on pickup **and** drop (off: shop-only radius of before) |
| | `radiusKm` | 5 (3–5) | Zone radius around the partner's live location |
| | `maxLocationAgeMinutes` | 15 | Older location = not live; no new offers until a fresh one |
| `deliveryOtp` | `required` | on | Off: no delivery code is issued or asked for |
| `deliveryProof` | `photoRequired` | off | (existing) photo at the door before Delivered |
| `orderCompletion` | `enabled`, `push`, `sms` | on, on, on | Completion stamp and its push / SMS confirmations |

Push is sent only while rule `push` is on; SMS only through a configured SMS
provider (`SMS_PROVIDER`; the mock outbox on test.gokesari.com).

## Data

Migration `drizzle/0121_gig_worker_flow.sql` (`-- split: core`, additive,
rollback `scripts/rollback-0121.sql`):

- `delivery_partners`: gender, address, emergency contact, registration
  location time, `availability` (OFFLINE / ACTIVE / READY; online partners
  start READY), gate override columns.
- `delivery_partner_kyc_checks` (platform): one PAN and one Aadhaar check per
  partner. The **Aadhaar number is never stored** — only `number_masked` and a
  keyed token (`number_token`, HMAC under `PAN_ENCRYPTION_KEY`); a database
  check refuses an Aadhaar row with a stored number. The PAN is AES-256-GCM
  ciphertext. Consent version, time and IP are kept with each check.
- `delivery_partner_background_docs` (platform): the file encrypted in the row
  (no public bucket, no public link); admin-only, audited opening.
- `society_partner_access` (customer): admin's AUTHORISED / BLOCKED per
  society and partner.
- `delivery_proofs.kind` (PICKUP / DELIVERY), `orders.completed_at`.

The order status stays **DELIVERED** after completion; returns, ratings,
invoices and refunds keep working off it. "Completed" is `completed_at`.

## KYC provider

`KYC_PROVIDER` as for sellers (docs/seller-verification/README.md). PAN goes
through the existing adapters (`verifyDocument`).

### Aadhaar: DigiLocker (since 31 Oct 2026)

Sandbox.co.in discontinued Aadhaar offline e-KYC (the OTP check) after UIDAI
stopped it. Partners now **share their Aadhaar from DigiLocker** through
Sandbox's DigiLocker API (developer.sandbox.co.in/api-reference/kyc/digilocker).
Rule **`riderVerification.aadhaarMethod`**: `digilocker` (default) or
`okyc_legacy` (the old OTP path, kept but unreachable unless chosen). Checks
already Verified stay valid either way.

Flow:
1. The partner ticks the consent (version `2026-10-31-digilocker`, time and IP
   stored) and taps **Verify with DigiLocker**.
2. `POST /api/delivery-partner/me/kyc/aadhaar/digilocker` starts a session
   (`POST /kyc/digilocker/sessions/init`, `doc_types: ["aadhaar"]`, consent
   valid 2 h so the link opens for about an hour) and returns DigiLocker's link.
   A second tap hands out the same link while it still opens.
3. The partner signs in to DigiLocker (OTP to the Aadhaar-linked mobile) and
   allows the Aadhaar. DigiLocker sends them to
   `/delivery-partner/kyc/digilocker/return?k=<random>`; the key finds the
   check (no sign-in needed — the app's in-app browser has none).
4. The check is settled by whichever comes first, each re-reading the session
   from Sandbox (`GET …/status`, `…/documents/aadhaar`, `…/user/profile`):
   - the **webhook** `POST /api/webhooks/sandbox-co/digilocker` (events
     `in.co.sandbox.kyc.digilocker.session.succeeded` / `.failed`; header
     `x-sandbox-signature` = base64 HMAC-SHA256, secret
     `SANDBOX_CO_WEBHOOK_SECRET`; refused with 503 when the secret is not set,
     401 when the signature is wrong);
   - the **return link**;
   - **polling**: the KYC page re-asks on load (at most every 10 s) and a few
     times after returning; "Check status" asks at once.
   Duplicates are no-ops (the update applies only while the check is Pending on
   that session).
5. Result: **Verified**; **Pending** for an admin when the name doesn't match
   the registered name (score < 80, as for PAN), the Aadhaar can't be read, or
   the provider is down / misconfigured (`vendor_*`, `config_*` — never Failed
   for our outage); **Failed** when consent was declined (`digilocker_denied`),
   the link expired (`digilocker_expired`), no Aadhaar was shared
   (`digilocker_no_aadhaar`) or the same DigiLocker account is verified for
   another partner (`already_used`). Failed can be started again.

Kept: the name on the Aadhaar, the masked number (last four digits from the
UIDAI XML, read in memory), and a keyed token (HMAC) of the DigiLocker account
id to find the same person on another partner. **Never stored:** the Aadhaar
number, photo, the XML/PDF, date of birth, address, mobile or e-mail. The
database check that refuses a stored Aadhaar number is unchanged.

Columns (migration 0123, core): `method` (`digilocker` / `okyc_legacy` /
`manual`), `session_id`, `session_status`, `session_url`, `session_expires_at`,
`session_return_key`. Rollback: `scripts/rollback-0123.sql`.

Providers:
- `sandboxco`: DigiLocker as above. Needs DigiLocker enabled on the Sandbox
  account and the webhook configured in the Sandbox Console.
- `mock` — or rule **`riderVerification.digilockerProvider` = `mock`** on any
  non-production site (refused on gokesari.com): a local fake consent page
  `/kyc-mock/digilocker` with **Approve / Approve – another name / Deny / Let
  the link expire / DigiLocker is down**. Approve verifies with the last four
  digits 4321. Sessions live in the server's memory; a restart forgets them.
- `gridlines`: no DigiLocker — the check stays Pending with `vendor_unsupported`;
  the admin screen says why (decide by hand, or switch to `sandboxco`).

Admin → Rider verification shows per Aadhaar check the method (DigiLocker /
Legacy OTP / Manual), the DigiLocker session status and link expiry, the reason
with what to do, and **Resend DigiLocker link** (a new session on the partner's
recorded consent; the partner gets a notification that opens it). An admin
decision by hand records the method as Manual.

Apps (1.6.0): the page asks the app to open DigiLocker in the in-app browser
(ASWebAuthenticationSession / Custom Tab) and the return link hands back to
`<scheme>://digilocker-return`; older apps open DigiLocker inside the WebView
and come back to the KYC page there (mobile/RELEASE_NOTES.md).

### Aadhaar: legacy OTP (`aadhaarMethod` = `okyc_legacy`)

- `mock`: any well-formed Aadhaar sends an "OTP"; **123456** verifies, 000000
  has expired, anything else is wrong. Numbers ending 9999 time out, 5555 can't
  be checked online.
- `sandboxco`: `POST /kyc/aadhaar/okyc/otp`, `POST /kyc/aadhaar/okyc/otp/verify`
  — **discontinued by Sandbox**; kept only for a vendor that still offers it.
- `gridlines`: no Aadhaar adapter — Pending for an admin.

## Shop owner and customer

- **Shop → Delivery → Delivery partners** (`/shop/delivery-partners`): each
  GoKesari partner who carried the shop's orders in 90 days, with the count of
  authorised and blocked societies; tap a count for the list.
- Shop orders show the partner's name, photo and (while on the way) mobile —
  except where the order's society blocks the partner: then the server sends
  only **"Partner pending assignment"**, and shop notifications say "A delivery
  partner". A blocked partner is also kept off that society's orders.
- Customer and shop order lists show **completed**.

## Operational notes

- With `riderVerification.gateAvailability` on, partners already approved and
  online keep their current state (they start READY), but switching to Active
  or Ready again needs KYC + documents, or an admin override.
- With zoning on, an order whose customer is more than `radiusKm` from the shop
  can only go to a partner between the two; set `riderZoning.enabled` off, or
  keep shop delivery radii within the zone, if orders wait too long.

## Released and open items (31 Oct 2026)

Live on gokesari.com since the staging → main release #302 (31 Oct 2026, 11:43 UTC), with the
verification gate and 5 km zoning on from day one (owner's decision). Still to settle:

- **KYC provider on production** — which one, with Aadhaar OTP switched on (Sandbox.co.in has it;
  the Gridlines adapter has no Aadhaar OTP, so its Aadhaar checks wait for an admin).
- **Completion SMS / push** — an SMS provider (`SMS_PROVIDER`) and rule `push` on.
- **Consent wording** — legal review of `RIDER_KYC_CONSENT_TEXT` (src/lib/gig/kyc.ts).
- **iPhone build** — repository secret `EXPO_TOKEN` (the Android APKs build without it).
