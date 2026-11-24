# Module 4 — Delivery signature and navigation (23-Nov-2026)

Owner brief of 23-Nov-2026, gap completion. Branch `feat/m4-delivery-signature`, migration **0196**.
Everything new is behind admin rule fields that are **off by default**; with them off the rider, customer,
shop and admin screens behave exactly as before.

## What already existed (not rebuilt)

- Customer delivery code (rule `deliveryOtp.required`), photo proof at the door (rule `deliveryProof.photoRequired`,
  `POST /api/delivery-orders/[id]/proof`, `services/delivery-proofs.ts`, private images with `canViewDeliveryProof`).
- Failed delivery (`markDeliveryFailed`, free-text reason), live tracking and ETA.
- Road routing (rule `routing`) and in-app turn-by-turn navigation (rule `riderNavigation`, providers mock / google /
  osrm, off-route recalculation, "Open in Google Maps" fallback) at `/delivery-partner/navigate/[deliveryId]`.
- Rider batching / trips (rule `batching`, `services/delivery-trips.ts`).

## Gaps closed

| # | Requirement | Status |
|---|---|---|
| 1 | Customer signature capture | DEVELOPED — `src/components/signature-pad.tsx`; proof kind `SIGNATURE`; rule fields `signatureEnabled`, `signatureRequired` |
| 2 | GPS at delivery / failure | DEVELOPED — rule field `captureGps`; admin order view only |
| 3 | Fixed failed-delivery reasons | DEVELOPED — rule field `failureReasons`; free text still accepted |
| 4 | Multi-stop navigation | DEVELOPED — rule field `riderNavigation.multiStop` (needs `batching.enabled`); routes to the next stop, no waypoints |
| 5 | MAPS_USAGE.md stale "Phase 2" section | ENHANCED — replaced by a "Road routing" section |

### 1. Signature

- **Pad** (`src/components/signature-pad.tsx`): pointer events (finger, stylus with pressure, mouse), `touch-action: none`,
  pointer capture, Undo and Clear, redraws on resize/rotation (strokes are kept relative to the box). Exports a fixed
  600 × 240 PNG on white (`signatureToPngBlob`), whatever the screen size. Labelled drawing area, real buttons, a polite
  live region ("Signature drawn." / "No signature yet.").
- **Rider screen**: with `deliveryProof.signatureEnabled` on, a "Customer signature" step (pad + optional name of the
  person signing + "Save signature") appears after the door photo and before "Mark delivered". With
  `signatureRequired` also on, "Mark delivered" stays disabled until a signature is saved.
- **Upload**: the existing proof endpoint with `kind=SIGNATURE`, optional `signerName` (trimmed, max 80). Same private
  storage (`stored_images`, purpose `DELIVERY_PROOF`), same image checks, same audit action
  (`DELIVERY_PROOF_UPLOADED`, with `kind` and `signerName`), same viewers (the order's customer and shop, the rider,
  operations). Refused with 404 while `signatureEnabled` is off; only the rider holding the picked-up delivery.
- **Enforcement**: `assertDeliveryProof` (called by `markDelivered`) refuses with 409 "Take the customer's signature…"
  when `signatureEnabled` and `signatureRequired` are both on and no signature exists. `signatureRequired` alone does
  nothing (the rider could not satisfy it).
- **Views**: "Signature at delivery · <date, time IST>" next to "Photo at delivery" on the customer's orders page (in
  English, Hindi and Marathi), the shop's orders page and Admin → Order Monitoring (which also shows the signer's name
  and the photo's time).

### 2. GPS at delivery / failure

- `PATCH /api/delivery-orders/[id]` actions `deliver` and `fail` accept optional `latitude`, `longitude`, `accuracyM`.
  The proof upload accepts optional `latitude` / `longitude` form fields.
- Stored only while `deliveryProof.captureGps` is on (`gpsToKeep` in `delivery-assignment.ts`; invalid or out-of-range
  points are dropped): `delivery_orders.delivered_latitude / delivered_longitude / delivered_accuracy_m`,
  `failed_latitude / failed_longitude`, `delivery_proofs.latitude / longitude`.
- The rider's phone asks `getCurrentPosition` (high accuracy, 6 s timeout, 30 s old fix accepted) just before
  delivering / failing / saving a signature. Permission refused or no fix: the action goes ahead without a position.
- Shown on **Admin → Order Monitoring only** ("Delivered at …, … (±n m)" / "Failed at …" with a Google Maps link).
  Customer and shop views never read these columns. The audit row records only `gps: true`, not the point.

### 3. Failed-delivery reasons

- `src/lib/delivery/failure-reasons.ts`: `CUSTOMER_NOT_AVAILABLE`, `WRONG_ADDRESS`, `REFUSED`, `PHONE_UNREACHABLE`,
  `OTHER` (+ note, required for Other).
- With `deliveryProof.failureReasons` on, the rider picks a reason (radio list) and may add a note. Stored as
  `failure_reason` = "Label" or "Label — note" (so every existing screen and notification still reads well) and
  `failure_reason_code` = the code. The audit row carries `reasonCode`.
- API: `fail` takes `reasonCode` (optional) and `reason` (now optional when a code is sent). A free-text `reason`
  (3+ characters) alone works exactly as before. While the rule is off the server ignores `reasonCode`.

### 4. Multi-stop navigation

- With `riderNavigation.multiStop` and `batching.enabled` on and the rider on a trip (`getRiderTrip`), the navigation
  response gets `trip: { stops, nextStop }` and the screen lists the stops in order (done stops struck through, the
  current route's stop marked, ETAs, "late" flags), with a "Next stop" link when the trip's next stop belongs to
  another order.
- Opening navigation for a stop that is already finished redirects to the trip's next stop.
- **Waypoints**: none of the three providers (mock, google, osrm) takes waypoints in this codebase today, so the route
  always goes to the next stop only (allowed by the brief). Single-delivery navigation is unchanged.

## Rules (Admin → Settings), all default off

| Rule | Field | Effect |
|---|---|---|
| `deliveryProof` | `signatureEnabled` | Shows the signature step; allows `kind=SIGNATURE` uploads |
| `deliveryProof` | `signatureRequired` | With `signatureEnabled`: no "Mark delivered" without a signature |
| `deliveryProof` | `captureGps` | Records the rider's position at delivery / failure / proof upload |
| `deliveryProof` | `failureReasons` | Fixed reason list for failed deliveries |
| `riderNavigation` | `multiStop` | Trip stop list and "Next stop" (also needs `batching.enabled`) |

These extend existing rule groups (the area already uses rules), so no `feature_flags` row is added. Stored rule
values from before this change merge with the new defaults (`getRule` merges defaults first).

## Migration 0196 (`drizzle/0196_delivery_signature_gps.sql`)

Additive and safe to re-run: `delivery_proofs_kind_check` now allows `SIGNATURE`; new nullable columns
`delivery_proofs.signer_name, latitude, longitude`; `delivery_orders.failure_reason_code` (checked against the list),
`delivered_latitude, delivered_longitude, delivered_accuracy_m, failed_latitude, failed_longitude`.
Rollback: `scripts/rollback-0196.sql` (deletes SIGNATURE rows first, then drops the columns).

## Files changed

- New: `src/components/signature-pad.tsx`, `src/lib/delivery/failure-reasons.ts`, `drizzle/0196_delivery_signature_gps.sql`,
  `scripts/rollback-0196.sql`, `tests/unit/delivery-signature-navigation.test.ts`, this README.
- Changed: `src/server/config/rules.ts`, `src/server/db/schema.ts`, `drizzle/meta/_journal.json`,
  `src/server/services/delivery-proofs.ts`, `src/server/services/delivery-assignment.ts`,
  `src/server/services/rider-navigation.ts`, `src/app/api/delivery-orders/[id]/route.ts`,
  `src/app/api/delivery-orders/[id]/proof/route.ts`, `src/app/delivery-partner/navigate/[deliveryId]/page.tsx`,
  `src/components/delivery-partner-dashboard.tsx`, `src/components/rider-navigation.tsx`,
  `src/components/order-monitoring-table.tsx`, `src/components/shop-order-manager.tsx`, `src/app/orders/page.tsx`,
  `src/app/shop/orders/page.tsx`, `src/app/admin/orders/page.tsx`, `MAPS_USAGE.md`.

## Tests

`tests/unit/delivery-signature-navigation.test.ts` (22 cases, TC-M4-001…062; database and settings stubbed): rule
defaults off; failure-reason composition; pad helpers (ink detection, undo, pressure, export drawing); signature
rules and `assertDeliveryProof` with rules off / on; signature upload refused when off, for another rider, or before
pickup; signer-name and position cleaning; GPS kept only with `captureGps`; multi-stop trip off by default / without
batching / on; stop-list rendering; rider dashboard unchanged with rules off and the signature step gating
"Mark delivered" with them on.

`tests/integration/delivery-signature-gps.test.ts` (7 cases, TC-M4-I01…I30, real PostgreSQL with migration 0196):
rules off (signature upload 404, no GPS kept, reason code ignored, free text as before); required signature blocks
"Mark delivered" until uploaded, signer name / position stored, viewers limited; GPS stored at delivery and failure
and read back for the admin view, invalid point dropped; listed reason stored as label + code, Other needs a note.

## Not done / still open

- `tests/unit/migration-journal.test.ts` fails on this branch alone because 0190–0193 belong to other module branches;
  it passes once those are merged ahead of 0196.
- The rider screen strings are English, as the rest of the rider dashboard is today; only the customer's
  "Signature at delivery" link is translated.
- Waypoint routing through several stops in one route (Google `intermediates`, OSRM multi-coordinate) is not built.
- Owner to decide whether to switch the rules on, on staging first.
