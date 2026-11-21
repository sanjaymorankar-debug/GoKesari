# Franchise module — decisions and defaults (20/21-Nov-2026)

> **Current model: the owner's final brief of 21-Nov-2026 08.06 IST** (section "Final brief" below). It replaces the
> 5 km area definition, the 91-zone list and "the owner pays his own team". Older rows that it supersedes are kept
> for the record and marked *superseded*.

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
| F-07 | Main dealer's override by distance (Model A cases 2 and 4) | Rule field `dealerTieredCommission.overrideByDistance`, **default true — owner decision 21-Nov-2026**: the dealer earns 4% when the signer reports to him directly (a team lead's own shop, or an agent placed straight under him) and 3% two levels up. Applies to shops activated after the deploy (rates are frozen per shop). Setting it to false gives 3% on every member's shop | Decided |
| F-08 | Franchise code used in the old `/shop/join` flow (no map location before payment) | Not blocked there. The shop is recorded but **not paid**: the audit shows `franchise_code_outside_active_zone`. The registration wizard and "Add my shop" check the location before payment | That legacy flow takes no location before payment |
| F-09 | Recurring base "net of refunds in the month" | Each month = commission on orders delivered in the month − commission on refunds **recorded** in the month, per shop. A negative month is written as a negative adjustment | The brief's own words (§8.2) |
| F-10 | Bank holiday on the 5th | `payoutOnNextWorkingDay` and a `bankHolidays` list (dates) are configurable. The payout date shown to owners skips Sundays and the listed holidays. The existing close job still runs on the 5th | The holiday list must come from finance |
| F-11 | Ticket-response compliance (rating metric) | The metric is in the engine but returns 100% until tickets record franchise response times | No per-franchise ticket timing exists yet |
| F-12 | Test clock (brief §15: time travel on the test server) | `clockOffsetDays` in the settings shifts franchise "now". It is refused on gokesari.com | Expiry, renewal and tail tests on staging |

## Brief of 21-Nov-2026 00.30 IST (dealer code per area, monthly bonus) — as built

It supersedes the matching points of the 20-Nov brief.

| # | Point | Built |
|---|---|---|
| B-01 | Area = all shops within 5 km of the area's centre (§1.1) | Each area's approved boundary is a circle around its centre (up to `maxAreaRadiusKm` = 5 km); polygons still possible. Neighbouring areas may overlap (`allowOverlappingAreas` true): the dealer code decides the area |
| B-02 | Map before and after booking (§1.2) | The booking summary shows the chosen areas on the map; `/franchise/my` shows the dealer's areas |
| B-03 | One dealer code per dealer per area (§1.4) | `franchise_codes.allocation_id`: each activated area gets its own GKF code; a renewal keeps it; a re-booking after expiry gets a new code (old shops not restored) |
| B-04 | Outside the area: blocked, admin override logged (§1.5) | Registration wizard and Add my shop refuse it before payment. Admin → Franchise → Attribution → "Tag a shop outside its area" records `override_reason` / `override_by` and an audit entry. Tags are permanent |
| B-05 | Bonus formula (§3) | `src/lib/franchise-bonus.ts` exactly as §3: registration points over the target 60, business points per ₹5,000 above the baseline (opening shops × ₹1,00,000; 0 in a first month), main points ÷ 100 (2 decimals, never rounded up), 1% a main point up to 5%, rate 25% + bonus, rating 5.0 + bonus %. Replaces D2's "0% until a formula is published" |
| B-06 | Recurring payout | Rate × GoKesari's 2% (`gokesariCommissionBp`) × delivered order value (goods) of **all** the code's shops in the month, net of refunds on the month's orders, worked out per shop |
| B-07 | Onboarding | 25% of the shop registration fee **actually paid, excluding GST** (₹250 on ₹1,000), earned at activation and shown on the month's statement |
| B-08 | Settings: admin only, audited, from next month (§2) | Money settings saved now take effect on the 1st of next month (IST); other settings apply at once (one save can make two versions). The audit log shows who, old and new value and IST time |
| B-09 | Month-end (§5) | Days 1–3 from 02:00 IST: calculate last month (hourly, rerunnable; opening shops frozen at the first run). 4th at 10:00 IST: statement PDF + summary to the dealer and ceo@agtci.com (once each). 5th: lock (writes the per-shop ledger lines dated in the month), then the existing payout close pays them; payout approval stays in Dealers → Commission → Payouts. After the lock, corrections go to the next month's adjustments (TC5) |
| B-10 | Expired / not renewed (§6) | Code closed for new shops; no bonus; base 25% continues **up to 2 years after expiry** (`tailMode = years_after_lapse`, `tailYears = 2`; replaces D4) |
| B-11 | Shop deactivated by admin | Leaves the opening shops from the next month (opening = approved and tagged shops at the month's first run) |
| B-12 | Model A | Unchanged apart from F-07 (dealer 4% one level up, owner 21-Nov-2026). Franchise owners pay their own staff; team members' tracking codes earn only the owner |
| B-13 | Production `territoryDealer` rule | The other session switched it on at gokesari.com on 21-Nov 00.11 IST (0 territories). Model B replaces it for paid areas. **Owner, 21-Nov-2026: leave it on** |

## Final brief of 21-Nov-2026 08.06 IST — as built (G-xx)

| # | Point | Built |
|---|---|---|
| G-01 | Zones (§5.1) | 50 zones `GKZ-PUN-01`…`50`, one per cluster of the owner's "Pune Areas List" sheet, with region and civic body. Area master of 196 areas; 189 mapped to exactly one zone, 7 **Unzoned** (Koregaon Bhima, Sanaswadi, Shikrapur, Ranjangaon, Saswad, Khed Shivapur, Rajgurunagar (Khed)). Short cluster names mapped to full names and kept as aliases. Data: `docs/franchise/data/` |
| G-02 | Shop → area → zone | The owner confirms the area at the wizard's pin step (suggested from the PIN code, then the nearest area). An API registration without an area gets the best suggestion. Registration is never blocked. Admin / operator corrections open a new period, so earlier commission keeps the old zone |
| G-03 | Area coordinates and PIN codes | **Approximate** (for the suggestion only, which the user confirms); `location_source = APPROXIMATE` until an admin edits them in Admin → Franchise → Areas |
| G-04 | Tier and fee (§5.2) | Exact rule: +10.0% / −10.0% Standard; fee = ₹1,50,000 × (1 + difference), nearest ₹1,000; optional min / max off. The seed reproduces every fee and tier of §5.3 (average 99.4; 20 / 12 / 18), all marked **Provisional** |
| G-05 | Going on sale | Zones are seeded **Coming Soon**; booking also needs `bookingOpen`; zones with provisional fees can be bought only when "Allow zone sale at provisional fees" is on (off) — otherwise "Fees being finalised" |
| G-06 | Business import (§5.3) | CSV (zone code, ₹ Cr, source, as-of) must cover **every active zone** of the set (one unit for the average). Preview old vs new → publish (reason) or discard. "Recalculate" re-tiers the published figures under changed settings. Active franchises keep the fee they paid; renewals use the published fee |
| G-07 | Zone status (§5.6) | Admin-only (operators read). Sold Out is set and cleared by the system. Reserved needs a dealer and an expiry and returns to Available by itself; when the named dealer buys, the zone returns to Available (or Sold Out). Scheduled changes are applied by the 5-minute job. Every change: reason, history, in-app + e-mail to the zone's owners, e-mail to ceo@agtci.com |
| G-08 | Max franchises per zone | 1 or 2, set by an admin, never below the active or reserved franchises (the super-admin list of F-06 is no longer used) |
| G-09 | Coupons (§5.7) | Limits count used **and live held** uses, so the last use is never sold twice; a held use is released when the hold runs out, the payment fails or the booking is fully refunded. The code is checked at checkout and again when the payment starts — a code no longer valid releases the reservation with the reason. "Launch-offer dealers only" = the launch offer is still open for the dealer. % cap and flat amounts are shared in proportion to the eligible fees; remainders go to the largest line; no fee below ₹1 |
| G-10 | Refund of a franchise booking | Admin → Franchises → "Refund booking": the franchise(s) are voided, codes closed, slots freed and the coupon use released. The money is refunded in the gateway by the admin |
| G-11 | One-time commission (§3) | Model B = the dealer holds an active franchise in the shop's zone when the shop is activated; it runs through the existing team plan (cases B1–B4: owner 25% own shop, 5% on each team shop; agent 20%, team lead 4%), so GoKesari pays each person directly on the 5th. Each plan stores the model, case, franchise and zone (hierarchy snapshot). Outside his paid zones the owner's team follows Model A (§7) |
| G-12 | Parity (§3.4) | One agent-direct and one team-lead field (rule `dealerTieredCommission`) for both models. Saving owner rates below the free dealer's (20% / 4% / 3%) — or free-dealer rates above the owner's — is refused with a message |
| G-13 | Programme flag | Model B shops earn even where the free-dealer programme flag is off; Model A keeps needing the flag |
| G-14 | Free teams in a paid zone (§6) | The shop attaches, order by order, to the franchises active in its zone when the order is delivered: 50/50 with two owners (or the nearest owner by the owner's PIN area, setting `recurringSplitMode`); none active → no recurring until one is sold |
| G-15 | Tail (§4.2) | The owner's own-team shops (Model B, and earlier shops attached on an upgrade) stay his — 100% — while his franchise is active and for 2 years after it lapses. Free-team shops move to the zone's active owner(s). After the tail, or on a buy-back after a gap, the old shops are not restored as his own: they attach like any shop of the zone |
| G-16 | Bonus (§4.1) | Main points floored to one decimal (30 base points → 0.3 → 25.3%; 75 → 0.7). Business points use the whole business of the opening shops; recurring pays the franchise's share. Rating (5 + bonus %) kept on the statement |
| G-17 | Franchise codes | One `GKF-` code per franchise is kept as an alias of the owner's own code and closes at expiry. Team members' franchise tracking codes are removed: members use their own `GKT-` / `GKA-` codes and are paid directly |
| G-18 | Removed | The 5 km circles, the "outside the area" block and its admin override, area splitting, the 91-zone seed, the cluster summary |
| G-19 | Production rule `territoryDealer` | Left on (owner, 21-Nov-2026) |

## Owner, 21-Nov-2026 09.20 IST — launch settings (G-20 …)

| # | Point | Built |
|---|---|---|
| G-20 | Promotional fee | `promoFeePaise` = ₹1,50,000 (default): every zone sells at ₹1,50,000 + GST while the launch offer is open (first 25 franchise dealers); the fee paid is locked for the 12-month term. Each zone also shows its **regular (post-promotional) rate** from its tier on the same card / page. After the launch offer closes the regular rate applies; renewals pay the zone's regular rate then |
| G-21 | Zones on sale | Pune (50), Mumbai (Konkan) (38) and Nashik (11) zone sets, every zone **Available**; booking switched on by default |
| G-22 | Mumbai (Konkan) and Nashik zones | No owner sheet existed: drafted from the standard local areas (Mumbai City, suburbs, Thane, Navi Mumbai, Palghar, Raigad, Ratnagiri, Sindhudurg; Nashik city and district). Files `docs/franchise/data/mumbai_konkan_zones.csv`, `nashik_zones.csv`. Area points / PINs approximate. Regular rates provisional (index 100 → Standard ₹1,50,000) until business data is published. **Owner to review** the zone lists in Admin → Franchise → Areas |
| G-23 | Apps | No Play / App Store access yet: Android installs from **gokesari.com/app** (APK served by the site, `MOBILE_APP_ANDROID_APK_PATH` on the server); iPhone uses Add to Home Screen. Footer links "Franchise" and "Get the app" |

## Owner, 21-Nov-2026 evening — two dealer models, every rate admin-editable (G-24 …)

| # | Topic | Decision as built |
|---|---|---|
| G-24 | Model 1 — free dealership (no upfront fee) | One-time commission only, on each shop's registration fee: **20% / 4% / 3%** (the signer 20%, one level up 4%, two levels up 3%). No recurring. Admin → Dealer tiers (rule `dealerTieredCommission`) |
| G-25 | Model 2 — franchise (zone bought upfront), one-time | Owner's own shop **25%** (`ownerSelfBp`). Team shops keep the **same 20 / 4 / 3 flow**: agent or team lead 20%, the owner **4%** one level up (`ownerOverrideBp`, was a flat 5%), **3%** two levels up when an agent works under a team lead (`ownerSecondOverrideBp`, new). B3 now totals 27%, the same as A3 |
| G-26 | Model 2 — franchise, recurring | **20%** of GoKesari's order commission (`recurringBaseBp`, was 25%), plus the monthly bonus of up to 5% (`bonusMaxBp`), on delivered orders of the shops attached to the zone |
| G-27 | Admin control | Every value above is editable by an admin: Model 1 in Admin → Dealer tiers; Model 2 in Admin → Franchise → Settings ("Commission and bonus settings"). Parity still holds: a franchise owner's rate may never be lower than the free dealer's matching rate. Saved changes apply from the 1st of next month (IST); this owner change itself was applied at once by migration 0160 (a new settings version, effective on deploy) |
