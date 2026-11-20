# GoKesari Franchise — free dealership (Model A) and Pune PMR paid areas (Model B)

Owner brief: **20-Nov-2026, 22.50 IST** ("Franchise dealer module (free + paid) and Pune PMR area booking"). It replaces
earlier dealer, territory-fee and franchise briefs. Built on 20/21-Nov-2026 on branch `feat/franchise-pmr-2026-11`.

- Gap analysis: [gap-analysis.md](gap-analysis.md).
- Decisions and defaults: [DECISIONS.md](DECISIONS.md).
- Territory master: [pune_pmr_91_zones_seed.csv](pune_pmr_91_zones_seed.csv), built by
  `scripts/franchise/build-zone-seed.py` from the owner's workbook. The validation output is in the testing report.
- Migration: `drizzle/0157_franchise_pmr.sql`. Rollback: `scripts/rollback-0157.sql`.
- Testing report: [docs/testing/franchise-pmr/TESTING_REPORT.md](../testing/franchise-pmr/TESTING_REPORT.md).

---

## Part 1 — Owner guide (plain words)

### Model A — free dealer, team lead, agent

- **Joining**: anyone can join free at `/dealer/apply`. This is the existing application: mobile OTP, PAN, a bank
  check, KYC documents, and admin approval.
- **Codes**: new codes are issued as `GKD-xxxxxx` (dealer), `GKT-xxxxxx` (team lead) and `GKA-xxxxxx` (agent).
  Older 8-letter codes keep working.
- **Commission on every activated shop** is a percentage of the registration fee without GST:

| Who registered the shop | Registering person | One level up | Two levels up |
|---|---:|---:|---:|
| Dealer himself | Dealer 20% | — | — |
| Agent directly under the dealer | Agent 20% | Dealer **4%** | — |
| Agent under a team lead | Agent 20% | Team lead 4% | Dealer 3% |
| Team lead himself | Team lead 20% | Dealer **4%** | — |

  The two bold 4% cells are new: until now the dealer got 3% in those cases. A shop pays according to the team on
  the day it is activated, and earlier shops never change.
- **Team rules**:
  - A deactivated team lead's agents now move straight under the dealer.
  - The same mobile number or bank account cannot appear twice in one team. PAN was already blocked.
  - Moving a person to another dealer is done by an admin, and is logged.
- **Upgrade**: a free dealer can buy paid areas from the same account. The "Upgrade to Paid Franchise" button is on
  `/dealer`.

### Model B — paid area in Pune

**Booking**

- **Where**: `/franchise` explains the offer; `/franchise/book` lists the 91 areas.
  - The areas are grouped into 7 clusters, with search, filters, sorting, a list view and a map view.
  - Each area shows its estimated business, with the disclosure.
- **Fee**: ₹1,50,000 per area for 12 months, plus GST, paid 100% online.
- **Capacity**: at most **2 owners per area**, and one owner can hold only one of an area's two slots.
- **Holding a slot**: choosing areas holds a slot for 15 minutes while the owner pays. All the areas in one booking
  are taken together, or none are.
- **Validity**: an area runs from the moment the payment is verified until 23:59:59 IST the day before its one-year
  anniversary.
- **Launch offer**: open to the first 25 owners or 25 areas, whichever is reached first. The public page shows how
  many launch places are left. Once the offer closes, booking shows "new terms coming soon" until you set new prices.
  No future price is ever shown before that.

**Codes and earnings**

- **Franchise code**: each owner gets one `GKF-xxxxxx` code.
  - A shop that registers with it must be **on the map inside one of the owner's active areas**; otherwise it is
    refused. The PIN code alone is not used, because 411002, for example, belongs to 8 areas.
  - Team members can get their own tracking codes. Their shops count for the owner, and only the owner is paid.
- **Earnings**:
  - 25% of each activated shop's fee without GST: ₹250 on a ₹1,000 retail shop, ₹625 on a ₹2,500 wholesale shop.
  - Every month, 25% of GoKesari's actual 2% commission on the completed orders of those shops, net of refunds.
  - A performance bonus of 0 to 5 points on top. It stays 0% until you publish a bonus formula.
  - Everything is paid on the 5th with the dealer payout, after TDS, with a statement.

**Expiry and renewal**

- **Reminders**: 30 days and 15 days before expiry, then every day from 14 days before up to the last day, at 10:00
  IST.
  - They go by e-mail, in-app message, push, SMS and WhatsApp.
  - Every reminder e-mail is copied to **ceo@agtci.com**.
  - A digest of expiring and expired areas goes to ceo@agtci.com at 09:00 IST.
- **Renewal**: from 30 days before expiry until 23:59:59 IST on the expiry day. It keeps the same slot and adds 12
  months.
- **At expiry**:
  - Renewal closes.
  - The code stops adding shops in that area (it still works in the owner's other active areas).
  - The slot is free for anyone, with no priority.
  - Shops stay live, and their monthly commission continues until the end of year 3 from the first activation.

### What is not automatic (needs you)

- **Area boundaries**: an area is bookable only after an admin approves its boundary. The workbook has PIN codes
  only, no map shapes.
  - The admin can seed reference points by geocoding each area's first locality. These are marked
    "auto – needs review".
  - The admin then draws a circle or polygon of at most 5 km, or imports GeoJSON, and approves it.
  - Large outer areas such as 66, 68, 69 and 70 may need to be split first.
- **Opening booking**: switch it on in Admin → Dealers → Franchise areas → Overview. It is off by default.
- **Bonus formula**: publish one when you decide it (D2).
- **Tax rates**: TDS and GST rates are confirmed by the CA (D8).

---

## Part 2 — Admin guide

The console is at **Admin → Dealers → Franchise areas** (`/admin/franchise`). Operators can read it; only admins can
change anything. Every change asks for a reason and is written to the audit log.

| Tab | What you do there |
|---|---|
| Overview | Open or close booking; see the launch counters and the cluster occupancy; create the hidden test zone `T-QA1` |
| Zones | Seed reference points (geocode); import GeoJSON; for each zone: draft a boundary (reference point plus circle radius or polygon), approve it (5 km and no-overlap checks), pause or resume, split |
| Allocations | Every slot with its owner and dates; suspend, resume, terminate, or void a test allocation |
| Expiring | Areas due in the next 30 days (red at 7 days or fewer); expired areas; the alerts log |
| Attribution | Shops held for review (likely duplicates): release (pays) or reverse (never pays) |
| Settings | The versioned commercial settings as JSON (money in paise, percentages in basis points), with an effective time and a reason |
| Bonus formula | Metrics, weights, targets and score tiers (bonus in basis points, capped at 5 points); draft or publish |
| Reports | CSV downloads: fees collected, occupancy by cluster, shops and GMV by owner, commission payable and paid; run a month now |
| Send log | Every reminder, alert and digest: recipient, channel, time and status |

**Super-admin.** Changing the maximum owners per area is limited to the admin e-mails listed in the environment
variable `FRANCHISE_SUPER_ADMIN_EMAILS` (comma separated). The list is empty by default, so nobody can change it. The
database never allows more than 2 owners per area.

**Production end-to-end test.**

1. Create `T-QA1`. It is hidden from the public: a 1 km circle in the sea, so no real shop can ever fall inside it.
2. Book it with an internal admin account (`reserveZones` with `test: true`).
3. Void the allocation.

Test bookings never count toward the launch offer.

### Data

| Table | What it holds |
|---|---|
| `franchise_regions`, `franchise_clusters`, `franchise_zones`, `franchise_zone_pins` | The territory master (PMR, C1–C7, 91 zones and their PINs) |
| `franchise_zone_estimates` | Shops and GMV per shop for each zone (monthly and annual figures are computed by the app) |
| `franchise_zone_boundaries` | Reference point plus polygon or circle; versioned; one APPROVED row per zone |
| `franchise_config_versions` | Commercial settings, versioned, with an effective time |
| `franchise_bookings` | A cart or renewal: amounts, config version, hold, payment intent |
| `franchise_allocations` | One owner's slot in one zone: status, dates, tail end, launch sequence |
| `franchise_allocation_renewals` | Each renewal: old and new expiry, fee |
| `franchise_campaigns` | The moment the launch offer closed |
| `franchise_codes` | GKF codes (the owner's, and members' tracking codes) linked to `referral_codes` |
| `franchise_shop_attributions` (+ `_history`) | Which owner, allocation and zone a shop earns for, with status ACTIVE, HELD or REVERSED |
| `franchise_rating_formulas`, `franchise_performance_ratings` | The bonus formula and each owner's monthly score, bonus and explanation |
| `franchise_notification_log` | Every reminder, alert and digest. This is also the guard that stops a second send |
| `franchise_compliance_violations` | Warning, recorded, suspension and termination entries |
| `franchise_agreement_acceptances` | Clickwrap: version, text hash, IP address and device |
| `franchise_calc_runs` | Each monthly run |
| `dealer_commission_ledger` | The existing ledger. New entry types `ONE_TIME_FRANCHISE`, `RECURRING_BASE` and `RECURRING_BONUS`, and link columns `franchise_allocation_id`, `franchise_zone_id`, `config_version` and `calc_run_id` |

The two-slot rule is enforced by the database. Partial unique indexes cover `(zone_id, slot_no)` and
`(zone_id, owner_dealer_id)` while the status is RESERVED, PAYMENT_PENDING_VERIFICATION, ACTIVE or SUSPENDED, and a
check constraint keeps `slot_no IN (1,2)`.

### Jobs

The `franchise` job runs every 5 minutes, from the every-minute cron group:

- releases expired holds;
- expires areas whose time has passed (closing their codes for those zones);
- sends reminders from 10:00 IST;
- sends the digest from 09:00 IST;
- on the 1st, from 02:00 IST, runs last month's ratings and recurring commission.

The monthly close on the 5th (`dealer-monthly-payout`) runs the month again first, and only adds what is missing.

### API

| Endpoint | Who | What |
|---|---|---|
| `GET /api/franchise/zones` | public | Zones (search, filter and sort parameters), cluster summary, offer |
| `GET /api/franchise/zones/[zoneId]` | public | One zone card |
| `GET /api/franchise/boundaries` | public | Approved boundaries as GeoJSON |
| `GET /api/franchise/offer` | public | Fee, launch places, rules text and its version |
| `GET /api/franchise/me` | signed in | The owner dashboard |
| `POST /api/franchise/agreement` | signed in | Accept the rules (version, IP, device) |
| `POST /api/franchise/bookings` | owner | Reserve `{ zoneIds }` (all-or-nothing) |
| `POST /api/franchise/bookings/[id]/pay` | owner | Open the gateway payment |
| `DELETE /api/franchise/bookings/[id]` | owner | Cancel a reservation |
| `POST /api/franchise/allocations/[id]/renew` | owner | Renew an area |
| `POST /api/franchise/codes` | owner | Tracking code for a team member |
| `/api/admin/franchise/*` | admin | Overview, config, zones (boundary, approve, status, maxOwners, split), boundaries (import, auto-reference, test zone), allocations, attributions, rating, run, violations, reports |
| `POST /api/admin/dealers/[id]/salespeople/[spId]/transfer` | admin | Move a person to another dealer (Model A) |
| `POST /api/admin/shops/[id]/reverse-commission` | admin | Reverse all commission on a shop |

Payments use the existing payment intents with the new purpose `FRANCHISE_FEE`:

- On capture, the handler activates the areas inside the capture transaction. A duplicate webhook does nothing.
- On a failed or expired payment, the handler releases the slots.

### Mobile apps

The Android and iOS apps are a WebView shell around the website, so every franchise page is in the apps as soon as
the website is deployed. App 1.11.0 (versionCode 12, build 12) adds `/franchise` to App Links and associated domains
and to the notification-tap routes. The store builds and submissions need the owner's EAS, Play Console and App
Store Connect access (see the report).

### Rollback

1. Close booking.
2. Deploy the previous release.
3. Run `scripts/rollback-0157.sql`. It refuses to run while any franchise ledger entries or `FRANCHISE_FEE` payment
   intents exist, because those are real money.
4. Delete the `0157` row from `drizzle.__drizzle_migrations`.
5. Revert the `overrideByDistance` change if needed by setting rule `dealerTieredCommission.overrideByDistance` to
   false. That restores the main dealer's 3% in every case.
