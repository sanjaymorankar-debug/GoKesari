# Rider App v2 + Rider Pay Plans (25-Nov-2026)

Owner brief: 25-Nov-2026 13.11 IST ("GoKesari — Delivery Partner (Rider) App v2 + Admin Rider Pay Plan").
Migration: `drizzle/0209_rider_app_v2.sql` (additive). Rollback SQL: `scripts/rollback-0209-rider-app-v2.sql`.

## Switches (Admin → Settings), all OFF by default

| Rule | What it turns on | Staging | Production |
|---|---|---|---|
| `riderAppV2.enabled` | Bottom bar (Home · Earnings · My Slots · Refer · More), header (Online/Offline, Help, SOS, tier badge), Home tiles, high-earning banner, incentive ladder, earnings week | ON after verification | OFF until the owner says |
| `riderPayPlans.enabled` | Pay from the pay plan in force; quote shown on the offer and locked on accept | ON after verification | OFF until the owner says |
| `riderJobBoard.enabled` | Available Deliveries list | ON after verification | OFF until the owner says (brief suggests ON) |
| `riderSlotBooking.enabled` | My Slots booking + dispatch priority + 15-min reminder | ON after verification | OFF |
| `riderReferral.enabled` | Refer & Earn (₹500 after 20 deliveries in 30 days by default) | ON after verification | OFF |
| `riderTiers.enabled` | Tier badge (Bronze / Silver / Gold / Kesari Star) | ON after verification | OFF |
| `riderSos.enabled` | SOS button (dials 112, alerts operations) | ON after verification | OFF |
| `riderInsurance.enabled` | Insurance screen ("Coming soon" until an insurer policy is entered) | ON after verification | OFF |

The "production stays off until the owner says" default follows the owner's standing rule of 25-Nov-2026.

## Pay formula

Implemented in `src/lib/rider-pay-plan.ts` (pure, unit-tested in `tests/unit/rider-pay-plan.test.ts`):

```
BasePay      = base fee (covers baseIncluded km of D)
LastMilePay  = Σ slabs of D beyond baseIncluded × slab rate
FirstMilePay = min(max(0, P − free first mile) × rate, cap)
ExtraDropPay = per extra drop: fee + slab pay on its leg (below the first slab: first slab's rate)
LongDist     = bonus when D ≥ threshold
Subtotal     = Base + LastMile + FirstMile + ExtraDrop + LongDist
SurgePay     = Subtotal × (highest multiplier − 1) + Σ flat add-ons   (peak slot, rain, festival, manual)
QUOTE        = min(max(minimum, Subtotal + Surge), cap), rounded UP to ₹1 — locked on accept
FINAL        = max(QUOTE, re-worked pay if the leg grew > reroute tolerance) + wait pay
               + incentives (existing rules) − deductions (existing late penalty);
               failed / cancelled-after-pickup: the rule's % of the QUOTE (wait pay still paid)
```

Worked checks (unit tests): D 5.4 km, P 1.8 km, peak ×1.2 → **₹55**; D 0.6 km → minimum **₹30**.

Notes:
- P (rider → shop) is the straight line from the rider's last reported position at accept time
  (the road-distance service is not called per offer, as in the rest of dispatch). D is the leg
  stored on the delivery (road distance when the routing service answered, straight line otherwise).
- The migration turns the existing flat rate (`delivery_earnings_config`) into version 1 of the
  default plan (one slab from 0 km, no minimum, no cap), so switching `riderPayPlans` on pays the
  same until an admin publishes a new version. Test RV2-002 proves it.
- Tips: GoKesari has no tipping yet; the earnings page shows Tips ₹0.

## Admin

`/admin/rider-pay-plans` (permission `delivery-earnings-config:manage`): plans by scope (zone → city →
default; zones are the HDMS delivery zones), versioned drafts, slab editor with gap/overlap checks and
the plan in words, simulator (last 7 / 30 days of delivered orders, draft vs what was paid, per area),
publish with a mandatory note and optional effective-from (needs a simulator run on the draft as it
is), manual surge switch per city/zone (×1.0–×3.0, flat add-on, reason, auto-end), calculator, and the
admin-only cost view (customer fee, shop charge, rider pay, margin). Every change is audited.
Existing slot and incentive managers (`/admin/rider-earnings`) stay; slots gained "pay-plan surge ×",
"bookable" and "capacity".

Also: `/admin/rider-sos` (acknowledge / close SOS), `/admin/rider-insurance` (policy record).

## Rider screens

Home (tiles, banner, ladder, messages, Available Deliveries, active job on top), Earnings (Mon–Sun
IST, bars, chips, quote vs final, cash in hand apart), My Slots, Refer, More, Insurance, My Zone,
Tier, Emergency contacts, SOS and Help in the header. "You earn ₹X" on the single offer card and on
every job. Copy in English, Hindi and Marathi.

## Privacy

Riders see only their own pay and, on COD, the cash to collect. Never the customer's delivery fee,
the order total, commission, shop charges or other riders' pay; the order total on the active job
is now 0 for prepaid orders. Tests: `findForbiddenRiderKeys` in the integration tests and
`tests/unit/rider-privacy.test.ts`.

## Rollback

1. Turn the rules above off (Admin → Settings) — riders return to the previous screens and the flat
   rate at once; quotes already locked are still paid as locked.
2. If the code must go: `sudo gk-deploy rollback gokesari-prod` (previous release), then, only if
   required, run `scripts/rollback-0209-rider-app-v2.sql` and delete the 0209 row from
   `drizzle.__drizzle_migrations`.

## Parked for the owner

- Insurer contract (policy number, covers, network hospitals) — the screen shows "Coming soon".
- Production values for every switch above, and the final pay-plan numbers (the Pune pilot numbers
  are offered as a starting point in the admin screen, not published).
- Store submission of app 1.14.0 (needs the owner's Play Console / App Store Connect login).
- Loans (Jify-style) are out of scope by the brief.
