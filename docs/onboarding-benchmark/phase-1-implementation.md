# Shop onboarding — Phase 1 (quick wins): what was built

06-Nov-2026, 00.40 IST. Branch `feat/onboarding-phase-b-2026-11` (from `staging` at 883a8c97).
Owner approval: "go with phase 1 and above answers", 05-Nov-2026, 23.30 IST (answers in
[gap-analysis.md §3](gap-analysis.md)). Plan: [proposed-flow.md](proposed-flow.md).

## 1. Gaps closed

| Gap | What changed | Where |
|---|---|---|
| G13 Payment return | A paid wizard shop is sent from the fee page back into the wizard (waiting, map pin, category, products) | `wizardContinuePath` in `shop-registration-wizard.ts`; `app/shop/registration-fee/page.tsx` |
| G2 Customer profile diversion | Signing in from shop registration goes straight back to it — no customer profile screens, no customer referral-code diversion | `app/onboarding/page.tsx` |
| G3 + D3 Fewer screens | No "documents now?" screen: the GST/PAN window opens directly and has **Add documents later**. Shop email = the account email, shown as one line with **Change** on Confirm details (a code is emailed only when changed; mobile-only accounts still get the email screen) | `toWizardView`, `onboarding-wizard.tsx` |
| G5 GST prefill | City and state filled from the GST record; State field added | `cityFromAddress`, `toDraftView` |
| G11 + D1 Fee transparency | "What you pay" card before payment: fee + GST, **covers 12 months, renews every year**, commission per Seller Terms, payouts after bank verification. "One-time" wording replaced by "yearly" on the fee page and slab picker | `WhatYouPay`; `registration-fee/page.tsx` |
| G21 Progress | 8 tiles (was 10) with "Step X of 8 · about N min to go live / to your first products" | `TileSteps` |
| G16 + D2 Starter shelf | Products from the shop type's catalogue category and the chosen categories, most-stocked first, **100 products, stock 100**, MRP as price (loose goods need a price), "% below MRP for all", one Publish. Price above MRP refused per item | `services/starter-shelf.ts`, `api/shops/[id]/starter-shelf`, `registration/starter-shelf.tsx`; rule `starterShelf` |
| G20 Finish set-up | Checklist with live status: map pin, categories, 10 products, bank, delivery area, GST/PAN for payouts, share link. Wide screens: full card on Seller Central; phones: one board line → `/shop/setup` | `shop-setup-checklist.ts`, `seller/setup-checklist.tsx`, `app/shop/setup` |
| D4 Bank before payout | Rule `bankAccounts` defaults: `enabled` and `requireVerifiedForShopPayouts` **on**. Red banner on every Seller Central visit: "Bank account not set — payouts are on hold" (amber while verification is pending) | `rules.ts`; `app/shop/page.tsx`; EN/HI/MR strings |
| G14 Paid but pending | Admins get "Paid shop waiting for approval" (in-app + e-mail) | `catalog.ts` (`shop.registration_fee_paid`) |
| B2 First products | Owner and the dealer are told when the first products go live | `shop-onboarding-events.ts` |
| G10 Copy | Ready e-mail no longer says "GST/PAN verified" for "add documents later" shops and asks for GST/PAN before the first payout; support notice and the wizard flag's admin hint brought up to date | `shop-ready-email.ts`, `templates.ts`, `feature-flags.ts` |
| G24 Another shop | "Register another shop" on the success screen (`/shop/register?new=1`) | `register/page.tsx` |
| B3 Funnel | New table `shop_onboarding_steps` (migration 0145, rollback script) records when each registration first reached each step. Admin → Shops → **Onboarding funnel**: started → GST/PAN checked → paid → live → first product → first order, by source (self / dealer / operator), median minutes to go live and to first product, where open registrations stopped | `onboarding-funnel.ts`, `app/admin/onboarding-funnel` |
| G29 Accessibility | Alerts announced to screen readers (`role="alert"` for errors, `status` otherwise); tile labels 12 px (were 11) | `ui.tsx`, wizard |

**Correction to the audit:** the "auto-add at stock 100" exists for *product* categories added in
Seller Central (`fillInventoryFromCategory`). The wizard's Category step sets *shop* categories, so it
listed nothing; the starter shelf now bridges the two.

## 2. Before / after (GST-registered, non-food shop, wizard on)

| Measure | Before | After |
|---|---|---|
| Screens to "shop live", signed in | 9 | **5** (referral, GST/PAN, confirm, review & pay, gateway) |
| Screens to "shop live", new owner (from sign-in) | ≈ 12 | **6** (+ sign-in card) |
| Screens to first products | ≈ 13 | **8** (+ map pin, category, starter shelf) |
| Required owner inputs before payment | ≈ 10 | ≈ 7 (email and "documents now?" gone; city/state pre-filled) |
| Time to list 10 products | 10–15 min, one by one | under 1 min when the catalogue has MRPs (tick, Publish) |
| After payment | stuck on the fee page | back in the wizard at the next step |

Time to go live is now measured by the funnel; target ≤ 5 min from the first sign-in screen (D5).

## 3. Testing so far (local)

| Run | Result |
|---|---|
| New tests `tests/integration/onboarding-phase-b.test.ts` | 8 / 8 pass |
| Wizard tests (`shop-registration-flow`, `onboarding-wizard-step1/2`), updated for the new flow | 59 / 59 pass |
| Whole suite, local Postgres 18 | 3,338 / 3,343 pass. 5 failures: `bank-accounts` (assumed the old default — test updated, passes), `migrate-on-build` ×3 (needed the 0145 rollback — added, 7 / 7 pass), `product-import-parser` (known; recorded as failing before this work in TEST_RESULTS_flow_2026-10-30.md, untouched here) |
| Typecheck, lint | clean |
| Browser, local, 375 × 812 | new owner: sign-in → straight to registration → GSTIN (mock) → confirm with Pune / Maharashtra filled → What you pay → sandbox "Pay (success)" → back in the wizard at Map pin → category → starter shelf (19 products) → Publish 2 → "Registration successful" + "Register another shop"; Seller Central shows the bank banner and "Finish setting up 3 / 6"; `/shop/setup` |

Screenshots: `screenshots/p1-*.jpg`. Not checked in a browser: the admin funnel page (no local admin
account; its query is covered by the integration test).

**Still to do:** test.gokesari.com through the staging queue, then gokesari.com in an owner-approved
release window.

## 4. Mobile apps (Android, iOS)

The apps are a WebView shell of the website, so every change above reaches both apps with the web
release; no native code changed, so no store version bump is needed. Phone screens were checked at
375 px in the browser; a run on a real device is part of the staging test.

## 5. Before production — owner actions

1. **Bank rule (D4) has a side effect:** with the new defaults, existing live shops without a verified
   bank account will have payouts held from the release. Count them before the production release
   (admin → bank accounts) and tell those shops, or switch `requireVerifiedForShopPayouts` off in Admin
   → Rules until they have added one. Customers are also prompted (never blocked) to add a bank account
   for refunds — the existing behaviour of that rule.
2. Production KYC provider and keys, and whether `shop_onboarding_wizard_enabled` is on (D6 — pending).
3. Staging Google Maps key: add `https://test.gokesari.com/*` (open since 30-Oct).

## 6. Left for Phase 2 (another session, "Shop onboarding flow audit")

Barcode scan, bank and delivery as wizard steps, abandoned-draft reminders, Hindi/Marathi for the
whole wizard, DigiLocker, SMS/WhatsApp OTP, one assisted mode for dealers.
