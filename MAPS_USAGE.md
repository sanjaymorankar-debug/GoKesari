# Google Maps Platform Usage (SKU-Conscious Architecture)

**This is not a substitute for Google's official pricing documentation.**
Google Maps Platform bills per-SKU, and pricing changes — the numbers below
are for understanding *what triggers a call*, not for budgeting. Check
[Google's current published pricing](https://mapsplatform.google.com/pricing/)
before estimating cost at any given scale.

## Core principle

**Google is called exactly once per shop location and once per customer
address, at the moment it's confirmed — never again for that same
location.** Everything else reads GoKesari's own stored `latitude`/
`longitude` columns. See `src/server/services/geocoding.ts` for the
rationale in full.

## Feature → service → SKU → frequency

| Feature | Google service | Billing model | Expected frequency |
|---|---|---|---|
| Map display in the location picker | Maps JavaScript API | Per map load/session | Once per "add/edit location" form open — never on browsing, search, or checkout pages |
| Address search-as-you-type | Places API (Autocomplete) | Per session/request, per Google's Autocomplete billing model | Only while a user is actively typing in the picker's search box |
| "Confirm location" | Geocoding API | Per request | **Exactly once** per shop registration, once per shop location edit (only if the pin actually moved), once per customer address save/edit (only if the pin moved) |
| Live delivery tracking map (event layer) | Maps JavaScript API | Per map load | Once each time a customer presses **Track delivery** on a live order; the 5-second position updates move the marker on the already-loaded map (no further loads). Without a browser key, a plain "see where your rider is" link is shown instead |
| Approximate street address of the shopper's detected position — the "Deliver to" text and the Nearby screen's "Your location" (owner decision, 24 Oct 2026: a textual address for the coordinates, no paid service) | — none — OpenStreetMap Nominatim instead (free, no key) | Free | Once per spot (positions rounded to ~11 m), remembered in server memory for a day; "Deliver to" then keeps it in the location cookie for 30 days. Nominatim's usage policy is followed: at most one request a second per server (a request that would wait more than 2 s is skipped and GoKesari's own area name is shown), the app named in the User-Agent, answers cached, "© OpenStreetMap contributors" shown with the address. Not logged in `maps_api_call_log` (no Google cost). `NOMINATIM_URL` points to another Nominatim server, or `off` |
| Nearby screen, typed PIN code / area GoKesari has no shops or addresses for | Geocoding API | Per request | Only for places GoKesari has no data for; remembered for a day. Purpose `nearby_manual_place` |
| Everything else (shop search, order checkout, map markers, admin views, rider assignment) | — none — | — | Zero calls; reads stored coordinates |

## What's logged vs. not

- **Logged** (`maps_api_call_log` table, visible in Admin → Maps & Location
  Usage): every server-side Geocoding API call — service, purpose,
  related entity, success/failure, response time.
- **Not logged**: Maps JS map renders and Places Autocomplete keystrokes.
  These are client-side, billed by Google directly against the
  browser-restricted key, and this app has no way to intercept or count
  them without adding its own tracking overhead that itself burns quota.
  If precise Autocomplete/Maps-load counts are needed, use Google Cloud
  Console's own API usage dashboard for that key.

## Two keys, two restriction types

- `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` — client-side, HTTP-referrer-restricted
  to this app's domains. Powers Maps JS + Places Autocomplete only.
- `GOOGLE_MAPS_SERVER_API_KEY` — server-side, IP-restricted, never sent to a
  browser. Powers the Geocoding API call in `geocoding.ts`, and the Routes
  API when a routing rule uses the `google` provider.

Neither key should have more APIs enabled on it than it actually uses. The
Routes API is needed on the server key only, and only when rule `routing` or
`riderNavigation` uses the `google` provider (see "Road routing" below).

## Road routing (built; every switch off by default)

The "deferred to Phase 2" note that stood here is out of date: road routing
now exists, behind admin rules that are **off by default**. With them off
everything still uses Haversine straight-line distance on stored
coordinates (`src/lib/geo/haversine.ts`, zero cost), as Phase 1 did.

| Feature | Rule | Service | When it is called | Logged as |
|---|---|---|---|---|
| Delivery distance and arrival-time estimates (rider offer, delivery window) | `routing` (`enabled`, `provider` google / osrm) | Google Routes API `computeRoutes` with `GOOGLE_MAPS_SERVER_API_KEY`, or an OSRM server (`osrmBaseUrl`) | When a rider is offered an order (rider → shop, shop → customer) and when the delivery window is estimated; reused between nearby points for `cacheSeconds` | `maps_api_call_log` service `ROUTES`, purposes `delivery_leg`, `delivery_pickup`, `delivery_window_estimate` |
| Rider turn-by-turn navigation (`/delivery-partner/navigate/[deliveryId]`) | `riderNavigation` (`enabled`, `provider` mock / google / osrm) | Same Routes API / OSRM; `mock` is a straight line with no call | When the rider opens the screen, and again when they go more than `offRouteMeters` off the route (at most once per `rerouteCooldownSeconds`); cached for `cacheSeconds` per ~100 m cell | `ROUTES`, purpose `rider_navigation` (google with no key is not logged) |
| Multi-stop trip on the navigation screen (Module 4) | `riderNavigation.multiStop` + `batching.enabled` | No extra call: the stop order comes from GoKesari's own trip planner (`delivery-trips.ts`, straight-line). No waypoints are sent; the route always goes to the next stop | Same as the navigation row above, one route per stop | as above |
| "Open in Google Maps" deep link | always on | None from GoKesari — the rider's phone opens Google Maps | On tap | not logged (no cost to GoKesari) |

Every routing call falls back to the straight-line estimate when the
service fails, times out or has no route, so a missing key or an OSRM
outage never stops a delivery. The public OSRM demo server is rate-limited
and not for production; use a self-hosted OSRM for real traffic.

GPS captured at delivery or at a failed drop (Module 4, rule
`deliveryProof.captureGps`) comes from the rider's phone (browser
Geolocation API) and makes **no** Google call.

If the `google` provider is chosen for either rule, enable the Routes API
on the **server** key only (`GOOGLE_MAPS_SERVER_API_KEY`), never on the
browser key.
