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
  browser. Powers the Geocoding API call in `geocoding.ts` only.

Neither key should have more APIs enabled on it than it actually uses —
enabling Routes/Route Matrix on either key now would be enabling a service
Phase 1 never calls.

## Deferred to Phase 2

Real road-distance/travel-time routing (Google Routes / Route Matrix) is
explicitly **not** used in Phase 1. Rider assignment and delivery-window
feasibility checks use Haversine straight-line distance
(`src/lib/geo/haversine.ts`, pure math, zero cost) on stored coordinates.
Routing only earns its cost once Phase 2's multi-order batching needs actual
route sequencing — see the delivery-system plan's "Explicitly NOT in this
plan" section.
