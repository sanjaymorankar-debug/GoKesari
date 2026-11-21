# GoKesari Franchise — free dealership (Model A) and paid zone franchise (Model B)

Current brief: the owner's **final brief of 21-Nov-2026, 08.06 IST** ("Dealer Charging Structure, Commission and
Franchise Zone Creation"). It replaces the earlier dealer, territory, 5 km area and zone-list briefs (20-Nov 22.50 IST
and 21-Nov 00.30 IST). Branch `feat/franchise-pmr-2026-11`.

- Decisions and defaults: [DECISIONS.md](DECISIONS.md) (final brief: G-01 … G-19).
- Gap analysis: [gap-analysis.md](gap-analysis.md).
- Zone data: [data/](data/) — the owner's seed (`GoKesari_Pune_Franchise_Zones_Seed.csv`), the "50 Clusters" and
  "Pune Areas" sheets (`pune_clusters.csv`, `pune_areas.csv`, with approximate coordinates and PIN codes for the
  registration suggestion). `scripts/franchise/build-zone-seed.py` checks them and writes the migration's seed.
- Migration: `drizzle/0157_franchise_pmr.sql` (DDL head in `scripts/franchise/sql/`). Rollback: `scripts/rollback-0157.sql`.
- Testing report: [docs/testing/franchise-pmr/TESTING_REPORT.md](../testing/franchise-pmr/TESTING_REPORT.md).

---

## Part 1 — Owner guide (plain words)

**Same work, same pay — and GoKesari pays everyone directly.** An agent or team lead earns the same in a free team and
in a franchise team. The franchise owner earns more only for what he paid for: his zone, recurring commission and the
monthly bonus. Everybody is paid by GoKesari on the 5th, after TDS, into his own verified bank account.

### Who earns what when a shop is activated (fee without GST)

| Case | Who registered the shop | Registering person | Team lead | Top person |
|---|---|---:|---:|---:|
| A1 | Free dealer himself | — | — | Dealer 20% |
| A2 | Agent directly under the dealer | Agent 20% | — | Dealer 4% |
| A3 | Agent under a team lead | Agent 20% | 4% | Dealer 3% |
| A4 | Team lead himself | Team lead 20% | — | Dealer 4% |
| B1 | Franchise owner himself | — | — | Owner 25% |
| B2 | Agent directly under the owner | Agent 20% | — | Owner 5% |
| B3 | Agent under a team lead | Agent 20% | 4% | Owner 5% |
| B4 | Team lead himself | Team lead 20% | — | Owner 5% |

Model B applies to shops the owner's team registers **inside his paid zone(s)**; anywhere else his team follows
Model A. A free team may register shops inside a paid zone: it earns its normal Model A commission, the owner gets no
one-time share, and the shop is attached to the zone's franchise for recurring commission. The live chart is public at
`/dealer/commission-chart`.

### Recurring commission (paid franchise only)

- 25% of GoKesari's 2% on every delivered order of the shops attached to the franchise, plus a monthly bonus of up to
  5% (100 base points = 1%, shown to one decimal: 30 points → 25.3%). Base points: 1 per new shop above the target of
  60 a month, and 1 per ₹5,000 of business above the baseline (opening shops × ₹1 lakh).
- Two owners in one zone share a free team's shop 50/50. A zone with no owner: its shops attach to the next franchise
  sold.
- If an owner stops renewing, he keeps recurring on his own team's shops for 2 more years; the zone's other shops move
  to the next active owner.

### Zones and fees

- 50 Pune zones (`GKZ-PUN-01`–`50`), one per cluster of areas, at most 2 franchises each, 1-year term.
- Fee by business: **Premier** (more than 10% above the Pune average) and **Emerging** (more than 10% below) pay
  ₹1,50,000 × (1 + difference); **Standard** pays ₹1,50,000. GST extra. The fee is locked for the term; a renewal pays
  the zone's fee at that time.
- The business index in the seed is a **provisional estimate**. Before selling, import the actual annual business
  per zone (Admin → Franchise → Fees), check the preview and publish. Until then the booking page says "Fees being
  finalised" (unless you switch on "Allow zone sale at provisional fees").
- These fees and rates are the launch offer for the first 25 franchise dealers; later terms are never shown.

### What needs you before booking opens

1. Import and publish the actual business figures (or allow sale at provisional fees).
2. Set the zones you want to sell to **Available** (they start as Coming Soon), and switch booking on.
3. Optionally correct area map points / PIN codes (approximate today) and draw zone shapes for the map.
4. Confirm TDS / GST rates with the CA (unchanged from the dealer payouts).

---

## Part 2 — Admin guide

Console: **Admin → Franchise** (`/admin/franchise`). Operators can read; only admins change anything; every change asks
for a reason and is audited.

| Tab | What you do there |
|---|---|
| Overview | Booking and provisional-sale switches, launch counters, counts by tier and status, area summary |
| Zones | Zone master (tier, Provisional tag, fee, % vs average, business, status, max franchises, owners); max 1 or 2; map shapes |
| Zone status | Change one zone or many: Available, Coming Soon, Reserved (dealer + expiry), On Hold, Inactive; schedule for an IST time; history; cancel a scheduled change. Sold Out is set by the system |
| Fees | Import business (CSV: zone code, ₹ Cr, source, as-of), preview old vs new, publish or discard; recalculate after changing the standard fee / band / min-max |
| Areas | Area master and area-to-zone mapping (Unzoned included); move an area; edit its map point and PIN codes; correct one shop's area |
| Coupons | Create / edit / pause coupons, assign private ones to dealers, uses report, Excel export |
| Franchises | Every franchise; suspend, resume, terminate; refund a booking (then refund the money in the gateway) |
| Commission & bonus | Owner rates (parity-checked), bonus settings with change log |
| Monthly points | Recalculate, lock, Excel |
| Settings, Expiring, Attribution, Send log | As before |

**Production end-to-end test:** create the hidden test zone `T-QA1` (one test area in the sea), book it with an internal
admin account (`test: true`), then void it. Test bookings never count toward the launch offer.

### Data

| Table | What it holds |
|---|---|
| `franchise_zone_sets` | A city's zone set (`PUN` Pune); another city is imported as a new set and tiered against its own average |
| `franchise_zones` | Zone code, cluster no, name, region, civic body, reason, status, reserved-for dealer and expiry, max franchises |
| `franchise_areas` (+ `franchise_area_zone_history`) | The area master and each area's zone (null = Unzoned) |
| `franchise_shop_area_periods` | Each shop's area and zone over time (corrections open a new period) |
| `franchise_zone_business` | Business figures (provisional index or ₹ Cr) with source and as-of; DRAFT batches, PUBLISHED |
| `franchise_zone_fee_versions` | Tier, % vs average and fee per zone, versioned |
| `franchise_zone_status_history` | Every status change and scheduled change |
| `franchise_coupons`, `franchise_coupon_assignments`, `franchise_coupon_redemptions` | Coupons, private assignments, uses (HELD / USED / RELEASED) |
| `franchise_bookings` | A cart or renewal: list fees, discount, coupon, taxable, GST, total, hold, payment intent |
| `franchise_allocations` (+ `_renewals`) | One owner's slot in one zone: list fee locked for the term, discount, tier, dates, tail end |
| `franchise_codes` | One `GKF-` code per franchise (alias of the owner's code) |
| `franchise_shop_attributions` (+ `_history`) | The owner's own-team shops (TEAM) and shops attached on an upgrade (UPGRADE) |
| `franchise_monthly_snapshots`, `franchise_calc_runs` | The monthly bonus calculation per franchise |
| `dealer_tier_shop_plans` | Each shop's frozen one-time plan, now with `model`, `case_code`, `franchise_allocation_id`, `franchise_zone_id` |
| `dealer_commission_ledger` | The existing ledger (one-time per person; recurring lines to the owner) |

Capacity: partial unique indexes on `(zone_id, slot_no)` and `(zone_id, owner_dealer_id)` while a franchise is held.

### Jobs

The `franchise` job runs every 5 minutes: expired holds (and their coupon uses) released; scheduled zone status changes
and Reserved expiries applied; franchises past expiry expired (codes closed, Sold Out re-checked); renewal reminders at
30 / 15 days then daily from 10:00 IST with the renewal fee (and why it changed), copied to ceo@agtci.com; Inactive-zone
notice; the 09:00 IST digest; month calculation on days 1–3, statements on the 4th at 10:00, lock on the 5th.

### API (new or changed)

| Endpoint | Who | What |
|---|---|---|
| `GET /api/franchise/zones` | public | Zones with tier, fee, description, status, slots; filters region / tier / slots / fee range |
| `GET /api/franchise/zones/[zoneId]` | public | One zone with its areas |
| `GET /api/franchise/boundaries` | public | Zones as GeoJSON coloured by tier (shape, or a point at the centre of its areas) |
| `GET /api/franchise/areas` | public | Area suggestions (PIN, location) and the area list |
| `GET /api/franchise/commission-chart` | public | The live commission chart |
| `POST /api/franchise/cart` | signed in | Cart preview with coupon, GST and total |
| `POST /api/franchise/bookings` | owner | Reserve `{ zoneIds, couponCode? }` |
| `POST /api/franchise/allocations/[id]/renew` | owner | Renew `{ couponCode? }` at the zone's current fee |
| `POST /api/shops/registration-draft/area` | shop owner | The wizard's area choice |
| `/api/admin/franchise/zones/status`, `/fees`, `/areas`, `/shops/[id]/area`, `/coupons`, `/coupons/[id]`, `/bookings/[id]/refund` | admin (read: operator) | As in the tabs above |

### Mobile apps

WebView shell: every page is in the apps once the website is deployed. 1.12.0 (versionCode 13, build 13) adds links
for `/franchise/zones/…` and `/dealer/commission-chart`. Store builds need the owner's EAS, Play and App Store access.

### Rollback

1. Close booking. 2. Deploy the previous release. 3. Run `scripts/rollback-0157.sql` (it refuses while franchise ledger
entries or `FRANCHISE_FEE` payments exist). 4. Delete the `0157` row from `drizzle.__drizzle_migrations`.
