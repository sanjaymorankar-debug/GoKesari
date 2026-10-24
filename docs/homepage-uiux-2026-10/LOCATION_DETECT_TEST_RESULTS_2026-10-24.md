# Location found by itself — test results (24 Oct 2026)

Change: the shopper's location is found and saved without opening "Deliver
to" (see README, "Finding the location by itself"). Run in a cloud session on
local PostgreSQL 16 and a local dev server; **not yet run on
test.gokesari.com**.

## Automated

| Suite | One database | Split (two databases) |
|---|---|---|
| `tests/unit/device-location.test.ts` (quick fix, GPS retry, refusal final, 0,0 rejected, permission states, save / ifUnset, discovery pages, wording in en / hi / mr) | 9 / 9 pass | 9 / 9 pass |
| `tests/integration/device-location.test.ts` (place name from own data, no Google call, no guessed PIN, searched address kept, ifUnset keeps a PIN or saved address, explicit choice replaces, bad position refused) | 6 / 6 pass | 6 / 6 pass |
| `tests/integration/nearby-shops.test.ts` (unchanged, place lookup regression) | pass | pass |
| `tests/unit/homepage-uiux.test.ts` (unchanged, wording regression) | pass | pass |

Typecheck (`tsc --noEmit`) and ESLint on every changed file: clean.

## In a browser (Playwright, Chromium, local dev server)

| # | Scenario | Result |
|---|---|---|
| A | Location permission given, home page, no tap | "Deliver to: Kharadi, Pune" appears by itself; section becomes "Shops near you"; cookie saved (source DEVICE, no PIN); reload saves nothing again |
| B | Permission refused, tap "Find your location" | "Location is blocked for this site — allow it in your browser or phone settings, or enter a PIN code." + "Enter PIN code" opens the location sheet; nothing saved |
| C | PIN 411001 already chosen, permission given | Stays "PIN 411001" — not overwritten |
| D | Permission given, `/shops`, position with no known place within 2 km | "Current location" saved by itself |
| E | Permission given, `/shops/nearby` | Shops listed; position saved as the delivery location ("Kharadi, Pune") |

## Still to do on staging

- test.gokesari.com in a phone browser and in the app (Android and iPhone):
  first visit asks once, "Deliver to" fills in; refusing leaves "Set location"
  and "Find your location" explains.

## Run 2 — exact address as the location text (24 Oct 2026, later)

Change: "Deliver to" and the Nearby screen show the street address of the
detected position (Google reverse geocoding) instead of "Current location" /
the area name, whenever Google knows it. Same local setup; Google answered by
a stub (this session cannot reach Google), so the real call is **not yet seen
on test.gokesari.com**.

| Suite | One database | Split |
|---|---|---|
| `tests/unit/device-location.test.ts` (+3: address cleaning — plus code and ", India" dropped, 120-character cut; headings keep the area; older cookies still read) | 12 / 12 pass | 12 / 12 pass |
| `tests/integration/device-location.test.ts` (street address + Google's PIN; one call per spot shared with Nearby; Google empty → area / city, no PIN; Google failing → same fallback and asked again next time; no key → no call; nothing known → "Current location"; searched address kept; ifUnset cases) | 10 / 10 pass | 10 / 10 pass |
| `tests/integration/nearby-shops.test.ts`, `tests/unit/homepage-uiux.test.ts` | pass | pass |
| Whole unit suite | 692 pass | — |

Typecheck and ESLint on the changed files: clean.

To check on staging: with the server Maps key set there, "Deliver to" shows
the street address after allowing location; Admin → Maps & Location Usage
lists `position_address` calls.

## Run 3 — free approximate address (OpenStreetMap), replacing Google (24 Oct 2026, later)

Owner: "I don't want paid version, just show textual address of
coordinates". Run 2's Google lookup was replaced by OpenStreetMap
(Nominatim) before merging. OpenStreetMap answered by a stub (this session
cannot reach it); **not yet seen live on test.gokesari.com**.

| Suite | One database | Split |
|---|---|---|
| `tests/unit/device-location.test.ts` (OpenStreetMap address formatting, PIN code check, ", India" dropped, 120-character cut, headings keep the area) | pass | pass |
| `tests/integration/device-location.test.ts` (approximate address saved, no PIN code, never Google; one request per spot shared with Nearby; at most one a second; nothing there / failing → area and city, asked again next time; `NOMINATIM_URL` off and another server; "Current location"; searched address kept; ifUnset cases) | 11 / 11 pass | 11 / 11 pass |
| `tests/integration/nearby-shops.test.ts` (unknown spot asked of OpenStreetMap, not Google) | pass | pass |

38 tests across the three files on each layout. Typecheck and ESLint on the
changed files: clean.
