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
through the existing adapters. Aadhaar uses the adapter's new `aadhaar` half:

- `mock` (local, CI, test.gokesari.com until sandbox keys): any well-formed
  Aadhaar sends an "OTP"; **123456** verifies, 000000 has expired, anything
  else is wrong. Numbers ending 9999 time out, 5555 can't be checked online.
- `sandboxco`: `POST /kyc/aadhaar/okyc/otp`, `POST /kyc/aadhaar/okyc/otp/verify`
  (offline e-KYC). Only the name on the record is kept.
- `gridlines`: no Aadhaar OTP adapter yet — the check stays Pending for an
  admin to decide by hand.

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
