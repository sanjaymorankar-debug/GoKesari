# Mobile UX — testing report (25-Nov-2026)

Brief received 25-Nov-2026 21.10 IST. PR: [#582](https://github.com/sanjaymorankar-debug/GoKesari/pull/582)
(into `staging`, labelled `ready-for-staging` at 21.54 IST). Design notes: [README.md](README.md).

## Summary

* The owner's known issues in Part 2 A (price/stock editor), B (admin phone board),
  C (shop owner navigation) and D (16 px inputs, safe areas) are built and pass on a
  local production build at all five phone widths.
* **Not yet on test.gokesari.com or gokesari.com.** The staging queue was paused
  (20.54 IST, #535's guest test). I opened the fix [#581](https://github.com/sanjaymorankar-debug/GoKesari/pull/581)
  (`staging-fix`, being tested since 21.40 IST). 18 PRs are queued ahead of #582, so
  #582 should reach staging in about 3–4 hours (around 01.00–02.00 IST on 26-Nov). Production releases
  go out once a day at 23.00 IST. The earliest production slot is **26-Nov 23.00 IST**.
* Apps: Android and iPhone show the website in a WebView (`mobile/README.md`). They get
  every change with the web deploy. No store build is needed.

## Runs (IST)

| Run | Where | Start | End | Result |
|---|---|---|---|---|
| Before audit, 8 roles/screens × 8 widths | test.gokesari.com (staging) | 21.27 | 21.34 | 64 screens captured |
| Typecheck, eslint, unit tests | local | 21.20 | 21.23 | clean; 1,701/1,701 unit tests pass |
| Production build | local | 21.45 | 22.00 | compiled, 88/88 pages |
| After audit, 6 screens × 8 widths | local production build | 21.50 | 21.54 | 48 screens; 0 sideways scroll, 0 inputs < 16 px on phones, 0 clipped labels |
| Flow check (Part 3 + tap counts), 9 checks × 5 phone widths | local production build | 21.51 | 21.53 | **45/45 pass** |
| Shop home: today's sales, Accept and Reject from the card (375, 390 px) | local production build | 22.20 | 22.52 | Pass: UX-6/UX-8 accepted, UX-7/UX-8 rejected (database shows ACCEPTED / CANCELLED); "New orders (5)" → "(3)" |
| Customer orders + rider: small-target count and audit, 3 screens × 8 widths | local production build | 21.58 | 22.14 | customer 39 → 0 and rider 2 → 0 small targets on phones; rider tabs: applicant Home · Documents · Account, approved rider all five; Earnings/Payouts scroll to their sections (top at 80 px). Approved riders' "KYC" / "Police verification" alert links (17 px tall) enlarged afterwards — typecheck only, to see on staging |
| Staging run | test.gokesari.com | — | — | waiting in the staging queue |
| Production run | gokesari.com | — | — | waiting for the 26-Nov 23.00 release |

## Issues found and fixed (P1 = blocks or misleads, P2 = slows or confuses, P3 = polish)

| # | Sev | Role | Screen | Problem (before) | Fix | Status |
|---|---|---|---|---|---|---|
| 1 | P1 | Shop owner | My products | Faint peach input borders on cream; empty MRP invisible | White 48 px boxes, 1.5 px slate-500 border (4.7:1), ₹ prefix, amber empty state, focus ring | Fixed (local) |
| 2 | P1 | Shop owner | My products | All 45 rows pre-selected for bulk changes | Nothing selected; bulk tools only after selecting | Fixed (local) |
| 3 | P1 | Shop owner | My products | "Pause selling" red link next to badge, no confirmation | ⋮ menu + confirmation; Resume one tap | Fixed (local) |
| 4 | P1 | Admin, Operator | /admin on phones | Titles and sub-items clipped ("Delivery dashboar…", "Payments", "Settings"); 3 columns | 2-column tiles, full title, scrolls | Fixed (local) |
| 5 | P1 | Shop owner | Seller Central on phones | Orders / products hard to find (only a hamburger and 16 tiles) | Bottom tab bar Home · Orders · Products · Wallet · More; New orders card first | Fixed (local) |
| 6 | P2 | Shop owner | My products | No unsaved state, no Discard, no toast, no leave warning | Sticky "n unsaved · Discard · Save changes (n)", Edited marker, toast, leave warning | Fixed (local) |
| 7 | P2 | Shop owner | My products | MRP not required; errors not tied to boxes | MRP needed for priced packaged goods; inline errors with aria-describedby | Fixed (local) |
| 8 | P2 | Shop owner | My products | "Butter Cookies · 1 g", stock beside unit "g" | "150 g pack" / "Per piece" / "Sold per kg", "Stock (packs)", wrong pack size flagged | Fixed (local); data list below |
| 9 | P2 | Shop owner | My products | No search, sort; tabs start with All | Search, sort, tabs Needs Price · Live · Paused first | Fixed (local) |
| 10 | P2 | Admin, Operator | /admin on phones | "+16 / +8 / +13" unexplained, two badges collide | One labelled count ("17 pending", "42 total") | Fixed (local) |
| 11 | P2 | Admin, Operator | /admin | Shopping footer (Company, Make Money) on the console | Hidden on the consoles | Fixed (local) |
| 12 | P2 | Shop owner | /shop on phones | Tile labels clipped ("Subscribers", "Bills & GST"), "+6" unexplained | Tiles grow to fit; "+6 more" | Fixed (local) |
| 13 | P2 | All | Every page | No `viewport-fit=cover`, so `env(safe-area-inset-*)` was always 0 in Safari | Added; headers and bottom bars pad for notch and home bar | Fixed (local) |
| 14 | P2 | Customer, Shop owner | /orders, desktop seller pages | 2–3 inputs under 16 px (iOS zooms in on tap) | 16 px on every input below 1024 px | Fixed (local) |
| 15 | P3 | Admin hub pages | Menu pages on phones | Sub-actions in 2 narrow columns | One full-width row each below 480 px (≥ 64 px tall) | Fixed (local) |
| 16 | P2 | Customer | /orders on phones | 39 targets under 44 × 44 px: 16 px-tall text links (Bill of supply, Photo at delivery, Signature, Details/refunds/help, Get help), 20 px-wide rating stars, 40 px Submit rating / Cancel order, 38 px language buttons | Links 44 px tall in 14 px text, stars 44 × 44, rating/cancel buttons 44 px, language buttons 44 px | Fixed (local): 39 → 0 at every phone width |
| 17 | P3 | Rider | /delivery-partner | "PAN" link 28 px wide, Reload 40 px, no bottom tab bar | Checklist links ≥ 44 × 44, Reload 44 px; tab bar Home · Earnings · Payouts · Documents · Account (Earnings/Payouts appear once the rider is approved; hidden on apply/register and the navigation map) | Fixed (local): 2 → 0 |
| 18 | P3 | All | Desktop ≥ 1280 px | Chips 36–40 px tall (mouse use; acceptable) | — | Open (by design) |
| 19 | P3 | Shop owner | Phone home | No "today's sales"; Accept/Reject only on the Orders page | "Today's sales" card (₹ total and order count for today, IST; cancelled, unpaid, refunded and returned orders left out) beside the wallet; the New orders card lists the newest two with **Accept** (1 tap) and **Reject** (pick a common reason or type one, then confirm) | Fixed (local): accept and reject checked against the database at 375 and 390 px |

Screenshots (on the Mac, not in the public repo):
`Test_Cases_Tracking/ux-mobile-2026-11-25/shots/before-staging/` (64) and `…/after-local/` (48).
Key pairs: `before-staging_admin_admin_ip15-390.png` ↔ `after-local_admin_admin_ip15-390.png`;
`before-staging_shop_shop_ip15-390.png` ↔ `after-local_shop_shop_se-375.png`;
`before-staging_shop_shop-my-products_se-375.png` ↔ `after-local_shop_shop-my-products-status-NEEDS-PRICE_ip15-390.png`.

## Tap counts and timing (Part 2C)

| Task | Target | Result | Status |
|---|---|---|---|
| Open new orders from home | 1 tap | 1 tap ("New orders (n)" card or the Orders tab) | Pass |
| Accept an order | ≤ 2 taps | **1 tap** (Accept on the home card) | Pass |
| Reach the add-product form | ≤ 2 taps | 1 tap ("+ Add product") | Pass |
| Price 10 products on a phone | < 2 min | Automated run: 10 prices + save in 0.7–0.8 s. Estimate for a person: about 6–8 s per price (tap, type, Next) plus a 2 s save, so **about 1 min 10 s–1 min 30 s** | Pass (estimate). A timed run by a person on a real iPhone is still open |

## Part 3 — product update flow (local production build, test shop "Kesari Dairy Farm", 52 listings)

| Step | 375 | 390 | 430 | 360 | 412 | Time |
|---|---|---|---|---|---|---|
| Home → New orders in 1 tap | Pass | Pass | Pass | Pass | Pass | 0.2–0.5 s |
| Home → add-product form in 1 tap | Pass | Pass | Pass | Pass | Pass | 0.1–0.4 s |
| Tab bar shown with Products badge | Pass | Pass | Pass | Pass | Pass | < 0.1 s |
| Nothing selected; bulk tools hidden | Pass | Pass | Pass | Pass | Pass | < 0.1 s |
| Price > MRP refused inline; Save disabled | Pass | Pass | Pass | Pass | Pass | < 0.1 s |
| Set price on 10 "Needs Price" (keypad Next) and save | Pass | Pass | Pass | Pass | Pass | 0.7–0.8 s |
| Needs Price → Live (count drops by 10) | Pass | Pass | Pass | Pass | Pass | < 0.1 s |
| Pause via ⋮ (confirmation) and Resume | Pass | Pass | Pass | Pass | Pass | 0.4 s |
| Unsaved edit → leaving asks to confirm | Pass | Pass | Pass | Pass | Pass | 0.6 s |
| Customer product page shows the new price (₹69) | Pass (checked once) | | | | | |
| MRP change stays with this shop (shop_listing_details; master MRP unchanged) | Pass (checked once) | | | | | |
| Products appear at stock 100 after adding a category | Not run (local data was seeded directly) | | | | | |
| Photo upload for a product | Not run | | | | | |
| 45+ products on real iPhone Safari / Android Chrome | Not run (no devices here; Playwright WebKit does not start on this Mac) | | | | | |

One defect was found and fixed during the run: the ⋮ menu existed twice in the page (a phone copy and a desktop copy), so its confirmation text appeared twice. It is now one menu.

## Regression

* Unit tests: 1,701/1,701 pass. Typecheck and eslint are clean.
* QA specs updated for "nothing selected at first": `tests/qa/local/sellers-product-setup.spec.ts`
  and `tests/qa/signed-in/sellers-product-setup.spec.ts`. They run in the staging queue.
* Cross-browser: Chromium was used at every width. The Apple sizes used an iPhone user
  agent and touch. Real Safari (iOS) and Edge/Safari desktop are **not run**. This is listed under open items.

## Data-quality list (wrong units / MRP)

From the product master seed (the standard-goods list loaded on both sites). The live
staging/production list needs a server-side query, because this Mac's SSH key is refused on gk-db-1.

* **19 packaged products with a weight/volume unit and no pack size.** They show as
  "1 g" / "1 ml" / "1 kg", which is the owner's "Butter Cookies · 1 g" example. Now flagged in
  the editor. List: `dq-pack-size.psv` (code | name | unit | size | MRP). Examples: P00581 Butter
  Cookies (g), P00585 Butter Khari (g), P00582 Choco Chip Cookies (g), P00555 Fresh Curd (kg),
  P00559 Fresh Paneer (kg), P00568 Badam Milk (ml). None of the 19 has an MRP.
* **509 of 964 packaged products have no master MRP.** Shops must type one before going
  live (now prompted with "Enter MRP").
* 800 packaged "per piece" items have no pack size. They are correct as "Per piece".

## Open items

1. **Staging and production deploy.** The queue resumes after #581, and #582 has 18 PRs ahead of it.
   Production goes out in the 23.00 IST window once #582 is verified (earliest 26-Nov). Prod Part 3
   then runs with test accounts only, followed by cleanup.
2. Real-device check on iPhone SE / 15 / 15 Pro Max and two Android phones (owner or tester).
   This includes the app WebView and the first-visit tour.
4. Fix the 19 pack sizes and decide how master MRPs get filled for the 509 packaged products.
5. Hindi/Marathi: new labels are translated (tab bar, quick actions, tour, admin counts). The
   price editor's own strings are English, as they were before.
6. The local build ended with a Next.js notice: "Your version of Next.js is affected by a
   known security vulnerability" (16.4.1). Server builds are not blocked; both sites serve their
   branch heads. Upgrading Next.js is the owner's decision.
