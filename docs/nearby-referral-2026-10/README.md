# Nearby shops from the real location, and referral code by admin toggle (10 Oct 2026)

Two additive features. Test on test.gokesari.com first; test results are in
[TEST_RESULTS.md](TEST_RESULTS.md).

## Feature 1 — Nearby shops based on my real location

The "Nearby" chip on the customer home board (Shops tile) now opens
**`/shops/nearby`** (before: the plain shop list `/shops`, which is unchanged).

| Requirement | How |
|---|---|
| Ask for location, show where | The browser (or the app's location bridge) is asked with `enableHighAccuracy`. The top card shows the area / city / PIN for the position — taken from the nearest shop or saved address within 2 km (no cost); Google reverse geocoding only when nothing is known nearby and the server key is set — with the accuracy and **Refresh location**. |
| Shops near the position | `GET /api/shops/nearby`: shops with status `APPROVED`, not deleted, with a usable saved latitude/longitude. Distance is Haversine (6371 km sphere) computed in PostgreSQL (no PostGIS on this database), nearest first. |
| Card | Shop name, shop type, Open now / Closed (opening hours, IST), "Not taking orders" when paused / wallet / legal documents block it, distance — metres below 1 km (to 10 m), otherwise km to one decimal. |
| Radius | 1 / 3 / 5 / 10 km chips, default 5 km; each chip shows how many shops it would list. |
| Directions | `https://www.google.com/maps/dir/?api=1&origin=LAT,LNG&destination=LAT,LNG`, opens in a new tab (the Maps app on phones). |
| Map view | List / Map view toggle. With the browser Maps key: a Google map with a blue "you" dot, the radius ring and a pin per shop; tapping a pin opens a bubble with name, distance, open/closed and **Directions**. Without the key (or if Google fails to load): a drawn map — you in the centre, distance rings, pins to scale — and tapping a pin shows the shop card with Directions. |
| Permission denied / unavailable / timeout / not HTTPS | A clear message for each case and a PIN code / area box; the search then runs from the centre of the shops and saved addresses in that PIN code / area (Google geocoding only when GoKesari has no data for it and the server key is set). Unknown place: "We couldn't find that PIN code or area…". |
| No shops in range | "No shops found within X km" with **Widen to Y km** (the next radius that has shops), or "See all shops" when there are none within 10 km. |
| Shops without coordinates | Left out of Nearby and listed in **Admin → Shops → Shops without location** (`/admin/shops/missing-location`, operators and admin, CSV download). Fix by pasting coordinates, **From address** / **Fill all from address** (Google geocoding of the shop's address — only accepted inside the shop's own PIN code; saved as `MANUAL_ENTRY`, not verified), or the owner pins it. Script: `scripts/backfill-shop-coordinates.ts` (dry run; `--apply`). |
| Capture at registration / profile | Already there: Add my shop and My shop → Location have the map pin and "Use my current location". Added: the same picker on the self-registered shop's **Complete your profile** page. The map picker now keeps the pin when the server cannot look up its address (test has no server Maps key, so "Confirm location" used to fail there). |
| HTTPS | Browsers only share location on secure pages; the page checks `isSecureContext` and says so instead of failing. Both domains are HTTPS. |

No Google call on the browse path: the list and distances use stored coordinates
only (MAPS_USAGE.md). Google is called only for a typed place GoKesari has no
data for, a position with nothing known within 2 km, the Map view's map load,
and the location backfill — each logged in `maps_api_call_log` and remembered
for a day by the server.

## Feature 2 — Referral code controlled by admin toggle

| Requirement | How |
|---|---|
| Two settings in the database | Table `referral_settings`: `referral_required_customer`, `referral_required_shop`, each `MANDATORY` or `OPTIONAL`. Migration 0074 seeds both **OPTIONAL**. Read live (no cache). |
| Admin section | **Admin → Settings → Referral settings** (`/admin/referral-settings`): one switch per setting, the last change under each, and the change log. Admin only: the page sends anyone else home; the API answers 403; the service refuses a non-admin actor too. |
| Registration forms | **Shop**: Add my shop (`/shop/register`) and self-registration (`/shop/join`) show "Referral code \*" or "Referral code (optional)"; "Request a referral code" stays. **Customer**: first-time setup shows "Referral code" or "Referral code (optional)"; My referral code (`/referral`) keeps "ask us for a code". |
| Mandatory | Shop: registration refused without a valid code (both paths). Customer: as before — the code is asked at setup and the first order / subscription is refused without one (`409 needsReferralCode`). |
| Optional | Blank is fine; an entered code must still be valid (422 on the field). |
| Auto-approval | Self-registration with a blank code while Optional is approved by the payment webhook like any other (payment and amount checks unchanged; no referral redemption or distributor commission without a code). Mandatory keeps "valid code + payment". A registration made without a code is not charged if the setting has since become Mandatory. |
| Server-side on every path | `POST /api/shops`, `POST /api/shop-registrations/referral-check`, `/otp`, `POST /api/shop-registrations`, `POST /api/me/signup-referral`, checkout and subscriptions. The app uses the same endpoints. |
| Log | `referral_setting_changes` (who, their email and role, old, new, time) + the audit log (`referral_setting.changed`). |
| No effect on existing users / shops | Registered shops keep their status. A Mandatory customer setting applies only to customers who joined at or after the moment it was switched to Mandatory. |

These settings replace the `required` switches of the business rules
`shopReferral` and `customerSignupReferral` (and `customerSignupReferral.enabled`:
the code is now always asked, as Mandatory or Optional). Those rules keep their
other values (notify emails, duplicate windows, `requiredFrom`).

## Database changes (migration 0074, additive)

- `referral_settings` (new, 2 rows seeded OPTIONAL)
- `referral_setting_changes` (new)
- `shop_registrations.referral_code_id` now nullable (a self-registration without a code)

Rollback: `scripts/rollback-0074.sql` (refuses while a code-less registration exists).
No change for Nearby: shops already had `latitude` / `longitude`.

## Files

| Added | |
|---|---|
| `drizzle/0074_referral_settings.sql`, `scripts/rollback-0074.sql` | migration |
| `src/server/services/referral-settings.ts` | settings, admin-only change, log |
| `src/app/api/admin/referral-settings/route.ts`, `src/app/api/referral-settings/route.ts` | admin and public API |
| `src/app/admin/referral-settings/page.tsx`, `src/components/referral-settings-panel.tsx` | admin section |
| `src/lib/geo/nearby.ts` | radii, distance text, directions link |
| `src/server/services/nearby-shops.ts` | Haversine query, shops without location |
| `src/server/services/place-lookup.ts` | place label, PIN / area search, address geocoding |
| `src/server/services/shop-location-backfill.ts`, `scripts/backfill-shop-coordinates.ts` | backfill |
| `src/app/api/shops/nearby/route.ts`, `src/app/shops/nearby/page.tsx` | Nearby API and screen |
| `src/components/nearby-shops.tsx`, `src/components/nearby-map.tsx` | Nearby list and map |
| `src/app/admin/shops/missing-location/page.tsx`, `src/app/api/admin/shops/missing-location/route.ts`, `src/components/shops-missing-location.tsx` | admin report |
| `tests/integration/referral-settings.test.ts`, `tests/integration/nearby-shops.test.ts` | tests |

| Changed (additive) | |
|---|---|
| `src/server/db/schema.ts` | two tables; `shop_registrations.referral_code_id` nullable |
| `src/server/services/referral-requests.ts` | shop code check reads `referral_required_shop`; entered codes always checked |
| `src/server/registration/service.ts`, `admin.ts` | self-registration without a code when Optional; approval without redemption; left join in the list |
| `src/server/services/customer-signup-referrals.ts`, `customer-referral-requests.ts` | customer code reads `referral_required_customer`; asked always |
| `src/app/api/shop-registrations/{referral-check,otp}/route.ts` | blank code by the setting |
| `src/components/shop-register-form.tsx`, `src/components/registration/join-form.tsx`, `src/app/shop/{register,join}/page.tsx` | "(optional)" label, request button on /shop/join |
| `src/app/referral/page.tsx`, `src/app/layout.tsx`, `src/server/board-header-data.ts`, `src/app/admin/referral-requests/page.tsx` | read the new settings |
| `src/server/config/rules.ts` | descriptions say which switches are superseded |
| `src/server/services/audit.ts` | `REFERRAL_SETTING_CHANGED` |
| `src/lib/board/menus.ts` | Nearby chip → `/shops/nearby`; Referral settings (admin); Shops without location (admin, operator) |
| `src/components/map-picker.tsx` | keeps the pin when the server lookup is unavailable |
| `src/server/registration/profile.ts`, `src/components/registration/profile-setup-form.tsx` | shop pin on Complete your profile |
| `API.md` | the new routes |
| tests: `referral-codes`, `customer-referral-requests`, `customer-signup-referrals` | drive the new settings instead of the old rule switches |

## Releasing to production

1. Back up the production database; apply migration 0074 (both settings start Optional — which is
   the requested default, so referral codes become optional on gokesari.com at release).
2. Merge `staging` into `main`.
3. Admin → Settings → Referral settings: set the values wanted for production.
4. Admin → Shops → Shops without location: fix the live shops listed there.
