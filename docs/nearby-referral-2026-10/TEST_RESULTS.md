# Test results — Nearby shops and referral settings (10 Oct 2026)

**Where:** test.gokesari.com, staging build 7df5506 (PR #133), deployed 19:11 UTC.
Migration 0074 applied by the "Test database" workflow (run 38078656508: backup
`gokesari_test_2026-10-10_1909_run23.dump` → migrate → verify; newest applied
`0074_referral_settings`, 77 migrations recorded). Production results: §6.

**How:** a real browser (Chromium via Playwright) against the live test site —
Android (Pixel 7), iPhone (iPhone 14) and desktop (1366 px) emulation; GPS
positions emulated by the browser; sign-in with the real emailed codes read
from the owner's mailbox; payments in Cashfree **sandbox** only ("Sandbox
payment" workflow). Accounts: `sanjaymorankar+gk-admin / gk-ops / gk-shop / gk-cust`,
and four new customers `+gk-ref1 … +gk-ref4` created during the run.

Automated tests: 1,695 unit and integration tests (132 files) pass locally on
PostgreSQL 16, including 19 new referral-settings tests and 14 new nearby
tests; CI green on PR #133. Typecheck, lint and production build pass.

## 1. Summary

| Area | Result |
|---|---|
| F1 Nearby — permission allowed | **Pass** — Android, iPhone, desktop: "kharadi, Pune 411014 · accurate to about 15 m", shops nearest first |
| F1 — each radius (1 / 3 / 5 / 10 km) | **Pass** — 2 / 4 / 4 / 6 shops, counts on the chips match |
| F1 — distance text | **Pass** — 540 m, 830 m, 1.7 km, 2.2 km, 6.1 km, 8.9 km |
| F1 — distance accuracy (6 shops) | **Pass** — within 0.1–28 m (≤ 0.5 %) of an independent WGS-84 geodesic (§3) |
| F1 — open / closed | **Pass** — "Closed" shown for every test shop (opening hours, evening IST) |
| F1 — Directions (desktop and phones) | **Pass** — `https://www.google.com/maps/dir/?api=1&origin=18.5515%2C73.9348&destination=…`, new tab; see note N-3 |
| F1 — Map view | **Pass** — Google map (browser key works on test), blue "You are here" dot, radius ring, 6 shop pins; tapping a pin opens name, "540 m away · Closed", **Directions** (phone and desktop) |
| F1 — permission denied | **Pass** — "Location permission is off … enter a PIN code or area below" + PIN box |
| F1 — manual PIN / area | **Pass** — 411014 → 4 shops (380 m …); "Kharadi" → same place; 999999 → "We couldn't find that PIN code or area…" |
| F1 — no shops in range | **Pass** — 3 km: "No shops found within 3 km · 1 shop within 5 km · Widen to 5 km" → EcoMed 4.0 km; Nagpur: "No shops found within 5 km · none within 10 km either · See all shops" |
| F1 — prompt never answered | **Fixed** (S-1) — waited forever; now offers the PIN box after 12 s |
| F1 — shops without coordinates | **Pass** — left out of Nearby; Admin → Shops without location lists 9 (operator 200, customer and shop owner sent home), CSV download; coordinates pasted for 4 shops → saved, report drops them, they appear in Nearby; bad input refused |
| F1 — backfill from address | **Blocked on test by the key** (N-1): Google refuses the server key; nothing written, every shop told why |
| F1 — home board | **Pass** — the "Nearby" chip links to `/shops/nearby` |
| F1 — page errors | **Pass** — 0 JavaScript errors across all Nearby runs |
| F2 — default | **Pass** — both settings Optional after migration |
| F2 — admin only | **Pass** — operator, shop owner, customer: page sends them home, GET/PUT 403; signed out 401 |
| F2 — toggles and log | **Pass** — 6 changes made through the switches; each shows "Last change: Optional → Mandatory by …gk-admin… on 11 Oct 2026, 12:56 am IST"; change log lists all 6 |
| F2 — 4 combinations × shop × blank / invalid / valid | **Pass** (§4) |
| F2 — 4 combinations × customer × blank / invalid / valid | **Pass** (§4) |
| F2 — existing users unaffected | **Pass** — `gk-cust` never needed a code in any combination |
| F2 — self-registration with payment, no code | **Not run on test** (N-2: no SMS provider on test); covered by integration tests |
| Regression — login, orders, shop dashboard, admin | **Pass** — 18 pages × 4 roles, same as before the deploy (N-4) |
| Regression — payments | **Pass** — ₹10 wallet top-up, Cashfree sandbox UPI `testsuccess@gocash` (sandbox-pay run 38080594690) → site verified with Cashfree → balance ₹30 → ₹40 |

## 2. Nearby, step by step (UTC)

| Time | Step | Result |
|---|---|---|
| 19:12 | Shops without location as customer / shop owner / operator | `/` · `/` · 9 rows |
| 19:13 | Admin: CSV download; "Fill all from address" | CSV with 9 shops; each shop: "API keys with referer restrictions cannot be used with this API." — nothing saved (N-1) |
| 19:13 | Admin pastes coordinates for Agtci, Chikan Shop, E2E Four Features Stationery, EcoMed Solutions | "Saved." ×4; "hello" → "Paste latitude, longitude — for example …"; 5 left |
| 19:14 | Android, GPS 18.5515, 73.9348 | location "kharadi, Pune 411014"; 1 km: Chikan Shop 540 m, Agtci 830 m; 3 km: + Samarth tea center 1.7 km, Asmy Exports 2.2 km; 10 km: + EcoMed Solutions 6.1 km, E2E Four Features Bakery 8.9 km |
| 19:14 | iPhone, same | same lists and distances |
| 19:15 | Desktop, same | same |
| 19:15 | Map view, tap Chikan Shop (phone, desktop) | bubble "Chikan Shop · 540 m away · Closed · Directions" → `…origin=18.5515%2C73.9348&destination=18.54684%2C73.93618` |
| 19:20 | Location blocked in the browser | message + PIN box |
| 19:20 | PIN 411014 / "Kharadi" / 999999 | results / results / clear error |
| 19:20 | Nagpur (21.1458, 79.0882) | "No shops found within 5 km" + widen / see all |
| 19:20 | 18.48, 73.90, radius 3 km | "1 shop within 5 km · Widen to 5 km" → EcoMed Solutions 4.0 km |
| 19:20 | Home board | Nearby chip → `/shops/nearby` |

## 3. Distance accuracy

The server's Haversine distance (6371 km sphere) for the six test shops from
18.5515, 73.9348, against an independent ellipsoidal (WGS-84, Vincenty)
geodesic:

| Shop | GoKesari | WGS-84 geodesic | Difference | Shown |
|---|---|---|---|---|
| Chikan Shop | 0.538 km | 0.536 km | 2 m | 540 m |
| Agtci | 0.830 km | 0.831 km | 1 m | 830 m |
| Samarth tea center | 1.690 km | 1.690 km | 0 m | 1.7 km |
| Asmy Exports | 2.248 km | 2.251 km | 3 m | 2.2 km |
| EcoMed Solutions | 6.104 km | 6.076 km | 28 m (0.46 %) | 6.1 km |
| E2E Four Features Bakery | 8.931 km | 8.936 km | 5 m | 8.9 km |

Google Maps' "Measure distance" is a straight line on a sphere of radius
6378.137 km, i.e. 0.11 % longer than these figures (Chikan Shop 539 m,
Asmy Exports 2.25 km). This environment cannot open Google Maps itself
(N-3), so the comparison is with the geodesic and Google's published formula
rather than its screen. Road distance in Directions is longer than the straight
line, as expected.

## 4. Referral settings — all four combinations

Valid code: `E2ENEARBY1` (created by admin for this run). Invalid: `NOPE-E2E-999`.
Shop registrations through Add my shop (`POST /api/shops`, as `gk-shop`);
self-registration checks through `/shop/join`'s referral check and OTP steps;
customers are new accounts signed up after each switch.

| Customer / Shop | Shop: blank | Shop: invalid | Shop: valid | /shop/register label | /shop/join blank / OTP | Customer label | Customer blank | Customer invalid | Customer valid |
|---|---|---|---|---|---|---|---|---|---|
| Optional / Optional | 201 BKS-000026 | 422 "does not exist" | 201 BKS-000027 | "Referral code (optional)" | ok, plans shown | "(optional)" | needsCode false | 422, still false | 200, false |
| Optional / Mandatory | 422 "required" | 422 | 201 BKS-000028 | "Referral code \*" | refused; OTP 422, no SMS | "(optional)" | false | 422 | 200 |
| Mandatory / Optional | 201 BKS-000029 | 422 | 201 BKS-000030 | "(optional)" | ok | "Referral code" | **true** | 422, still true | 200, false |
| Mandatory / Mandatory | 422 | 422 | 201 BKS-000031 | "\*" | refused; OTP 422 | "Referral code" | **true** — cart: "A referral code is needed for your first order" | 422, true | 200, false — cart block gone |

"Request a referral code" stays on both shop forms in every combination. The
existing customer `gk-cust` had `needsCode: false` in all four. Both settings
were returned to **Optional** at the end (log entries 5 and 6).

## 5. Issues found

| # | What | Status |
|---|---|---|
| S-1 | Nearby waited forever when the location prompt was never answered (the browser's timeout only starts after an answer) | **Fixed**: after 12 s the screen says "Waiting for your location … or enter a PIN code" and shows the PIN box; checked locally |
| N-1 | `GOOGLE_MAPS_SERVER_API_KEY` on test.gokesari.com is restricted by HTTP referrer, so Google refuses every server call ("API keys with referer restrictions cannot be used with this API"). This is why "Confirm location" failed on test before, and why "Fill from address" cannot work there. The map picker now keeps the pin anyway | **Owner action**: in Google Cloud Console give the server key an **IP-address** restriction (or none) instead of HTTP referrers, with the Geocoding API enabled. Check production's key the same way |
| N-2 | test.gokesari.com has no SMS provider (`SMS_PROVIDER=none`, test outbox off), so `/shop/join` cannot send its code and no self-registration can be completed there | Pre-existing. Covered by the integration tests (registration without a code while Optional → paid → approved, no redemption) |
| N-3 | This test environment cannot reach `www.google.com` or `maps.gstatic.com`, so the Directions page could not be opened here and Google's pin images show as broken here only | Not a site issue: the site's CSP allows them; links verified by their exact URL and `target=_blank`. Worth one tap on a real phone |
| N-4 | `/wallet` and `/admin/orders` log React error #418 (a text hydration mismatch) | Pre-existing: identical before the deploy; pages work |
| N-5 | Admin → Referral codes shows "0 shops" for every code (the count's subquery compares the redemption with itself) | Pre-existing, not changed here |

## 6. Production

See the release notes added after the production release.
