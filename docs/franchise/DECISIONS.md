# Franchise module — decisions and defaults (20/21-Nov-2026)

The brief (§0 rule 3) says: where a business rule is open, build the stated default, make it admin-configurable, log
it here, and carry on. Every value below can be changed in **Admin → Dealers → Franchise areas → Settings**, a
versioned change with an effective time. The only exceptions are the items marked *code*.

## Brief decisions D1–D9, as built

| # | Decision | Built | Where to change it |
|---|---|---|---|
| D1 | Launch offer closes on 25 owners or 25 areas? | Both counters; it closes on whichever comes first (`launchCloseRule = first_limit_reached`), counted on verified payment time. Unpaid reservations also hold places, so the 25th place is never sold twice | `launchMaxOwners`, `launchMaxAreas`, `launchCloseRule` |
| D2 | Performance bonus formula | The engine is built. The bonus is 0% until an admin publishes a formula, and the dashboard says so. No thresholds were invented | Bonus formula tab |
| D3 | One-time commission on wholesale shops (₹2,500) | 25% of the fee without GST (₹625), the same rate for every shop type | `oneTimeBp` |
| D4 | 3-year tail | `fixed_end_of_year_3`: the end of year 3 from the first activation, never before the area itself expires. The alternative `years_after_lapse` uses `tailYears` | `tailMode`, `tailYears` |
| D5 | Free dealers in zones with paid owners | Allowed. The franchise owner earns nothing on a shop registered with someone else's code | `freeDealerInFranchisedZone` (`allow`, `allow_and_notify_franchise`, `block`) |
| D7 | Post-launch fee and commissions | Blank, so booking closes once the launch offer closes ("new terms coming soon" plus the WhatsApp/call contact). No future figure is shown | `postLaunchFeePaise`, `postLaunchOneTimeBp`, `postLaunchRecurringBp` |
| D8 | TDS and GST rates | GST on the franchise fee is `gstRateBp` (default 18%, CA to confirm). TDS uses the existing dealer payout TDS rows (`commission_tds_rates`, CA-confirmed flag), unchanged | `gstRateBp`; Admin → Dealers → Commission → TDS |
| D9 | Zones larger than 5 km | Approving a boundary larger than 5 km is refused and the zone is marked `NEEDS_SPLIT` (not bookable). An admin splits it into `66-1`, `66-2` …, dividing the estimate by the shop counts entered, and every split is logged | `maxAreaRadiusKm`; Zones tab → Split |

## Decisions made while building (F-xx)

| # | Point | Default built | Why |
|---|---|---|---|
| F-01 | `GKD-` / `GKT-` / `GKA-` codes for existing dealers | Codes **issued from now on** use the prefixes. Existing 8-letter codes stay as they are and keep working (no mass re-issue). An admin can replace a code to get a prefixed one | Codes already printed on QR stickers and shared in the field keep working; this is the smallest change that meets the brief |
| F-02 | Existing TIERED extras: shop-renewal commission 10/2/1 for 3 years, the 10% monthly target bonus, and the 1% development bonus (owner, 05-Nov) | **Left unchanged.** The brief says "no recurring commission in Model A" and does not mention these explicitly | Owner to confirm whether they stop |
| F-03 | Duplicate shops in Model A | The existing rule is kept: a likely DUPLICATE earns nothing and goes to the attribution-claims queue. For franchise shops, a likely duplicate is **held** for an admin review (release or reverse), as the brief asks | The Model A behaviour existed and works |
| F-04 | Moving existing dealers to Model A (§13) | `scripts/franchise/migrate-model-a.ts`, a dry run by default, moves approved STANDARD dealers to TIERED from now on. History is never recalculated, because each shop's plan is frozen. **Not run on production** until the owner says so | Changes future earnings for existing dealers |
| F-05 | Old pincode "territory dealer" data (PR #419) | Not migrated. Production has none; staging has one QA territory. Pincodes cannot be mapped to zones one-to-one (411002 is in 8 zones). Rule `territoryDealer` stays off | Superseded by Model B |
| F-06 | "Super-admin" for maximum owners per area | Admin e-mails listed in `FRANCHISE_SUPER_ADMIN_EMAILS`. The list is empty by default, so nobody can change it. The database also refuses more than 2 | No super-admin role existed |
| F-07 | Main dealer's override by distance (Model A cases 2 and 4) | New rule field `dealerTieredCommission.overrideByDistance = true`. When the signer reports directly to the dealer, the dealer gets the first override (4%); otherwise the second (3%). Setting it to false restores the earlier 3% | Brief §2.3 supersedes DT-23 for those two cases |
| F-08 | Franchise code used in the old `/shop/join` flow (no map location before payment) | Not blocked there. The shop is recorded but **not paid**: the audit shows `franchise_code_outside_active_zone`. The registration wizard and "Add my shop" check the location before payment | That legacy flow takes no location before payment |
| F-09 | Recurring base "net of refunds in the month" | Each month = commission on orders delivered in the month − commission on refunds **recorded** in the month, per shop. A negative month is written as a negative adjustment | The brief's own words (§8.2) |
| F-10 | Bank holiday on the 5th | `payoutOnNextWorkingDay` and a `bankHolidays` list (dates) are configurable. The payout date shown to owners skips Sundays and the listed holidays. The existing close job still runs on the 5th | The holiday list must come from finance |
| F-11 | Ticket-response compliance (rating metric) | The metric is in the engine but returns 100% until tickets record franchise response times | No per-franchise ticket timing exists yet |
| F-12 | Test clock (brief §15: time travel on the test server) | `clockOffsetDays` in the settings shifts franchise "now". It is refused on gokesari.com | Expiry, renewal and tail tests on staging |
