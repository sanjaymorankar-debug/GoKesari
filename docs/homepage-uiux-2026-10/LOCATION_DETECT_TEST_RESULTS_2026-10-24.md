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
