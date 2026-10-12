# Seller Central — test results (2026-10-12)

Run in a cloud session against a local PostgreSQL 16 test database with all
migrations applied. Belongs in `/Users/agtci/Documents/Doc_GoKesari/Test_Cases_Tracking`.

## Automated checks

| Check | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | Pass |
| Lint (changed files) | `npx eslint src/app/shop src/app/sell src/components/seller src/lib/seller src/components/board tests/unit/seller-central.test.ts` | Pass |
| Full unit and integration suite | `npm test` | **133 files, 1702 tests passed** |
| New tests | `tests/unit/seller-central.test.ts` | 5 passed |

The new unit tests check that:
- every shop owner menu sits in exactly one sidebar group;
- a shop owner sees all 16 menus, in group order;
- menus the role may not see are dropped, along with any group left empty;
- every Seller Central label exists in English, Hindi and Marathi;
- the status pill shows the right wording for each shop status.

`tests/unit/mobile-app.test.ts` checks that every top-level page opens in the
Android app. It caught the new `/sell` page, which is now added to
`mobile/app.config.ts`.

## Manual checks (dev server on seeded demo data, Chromium)

| # | Case | Viewport | Result |
|---|---|---|---|
| 1 | `/sell` signed out: hero, benefits, how it works, tools, shop types, register options, FAQ, footer; shopping header hidden | 1366 × 900 | Pass |
| 2 | `/sell` on a phone: every section stacks, no sideways scrolling | 390 × 844 | Pass |
| 3 | `/shop` as an approved owner (Kesari Dairy Farm): seller top bar with "Live" pill, sidebar groups, dashboard sections, all-tools grid | 1440 × 900 | Pass |
| 4 | `/shop` on a phone: the approved tile board, full screen with its own header (no seller top bar), page height exactly one screen | 390 × 844 | Pass |
| 4a | `/shop` on a tablet: tile board, one screen | 820 × 1180 | Pass |
| 4b | Tile board → Orders tile: `/shop/orders` opens in Seller Central with ☰ and the shop line | 390 × 844 | Pass |
| 5 | ☰ on a seller page → Inventory: opens `/shop/inventory` and the drawer closes | 390 × 844 | Pass |
| 6 | `/shop/orders`: Orders highlighted in the sidebar with New / Packing / Ready / Out underneath | 1440 × 900 | Pass |
| 7 | Find a tool, typing "gst": lists "GST (Finance)" and "GST & PAN (My Shop)" | 1440 × 900 | Pass |
| 8 | `/shop` for a shop pending approval: "Pending approval" pill; Action required shows the approval stage and next step | 1366 × 900 | Pass |
| 9 | `/shop` for a signed-in user with no shop: "Welcome to Seller Central" with the registration options, no sidebar | 1366 × 900 | Pass |
| 10 | Browser console on `/shop`, `/shop/orders` and `/sell` | both | No errors |

Self-registration (the referral-code and online-payment path) is switched off
in the demo data, so cases 1 and 9 show only the "Register with documents"
option. With the `selfRegistration` rule on, the "Quick registration" card
shows first.
