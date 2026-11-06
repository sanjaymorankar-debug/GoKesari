# Shop onboarding — Phase 2, Wave 1: what was built

06-Nov-2026, IST. Branch `feat/onboarding-phase-2-wave1` (from `staging` at `916575d7`). Owner's go-ahead
"Start Wave 1", 06-Nov-2026. Plan: [screens-flow-and-implementation-plan.md](screens-flow-and-implementation-plan.md)
(work packages WP1–WP5); owner answers Q1–Q9 in [flow-analysis.md](flow-analysis.md) §12.

## 1. What changed

| WP | Change | Where |
|---|---|---|
| WP1 Starter shelf (F1, F2) | **Ranking** = orders of the product on GoKesari in the last 90 days, then shops stocking it, then photo, then name (Q1). **Publish in one transaction**: categories linked, every listing in one insert, **opening stock written to the stock ledger** (`inventory_movements`, source `starter_shelf`), one audit row; bad rows (above MRP, a stock figure the product's kind does not allow, already listed, unavailable) are refused on their own before the write. Was: one product at a time, ≈ 6 queries each, no ledger rows | `services/starter-shelf.ts`, `services/audit.ts` |
| WP2 Barcode scan | **"📷 Scan a barcode"** on the starter shelf. Camera scanner: the browser's BarcodeDetector (Android), **ZXing for iPhone / iOS app** (loaded only there), and a box to type the number. A known code adds the product to the list, ticked, at MRP; already listed or waiting for approval is said plainly; an **unknown code becomes the owner's own product**, on sale once our team approves it (Q9), with the code kept for review | `components/barcode-scanner.tsx`, `components/registration/starter-shelf.tsx`, `services/barcode-lookup.ts`, `api/shops/[id]/barcode-lookup`, `api/products` (`barcode`), `catalogue.ts`; dependency `@zxing/browser@0.2.1` |
| WP3 Get paid + How you deliver (F3) | Wizard's last screen offers **Get paid** (bank account) and **How you deliver**. New page `/shop/setup/delivery`: own staff / GoKesari delivery partners / pickup only, radius 1–10 km, in EN / HI / MR. Choice stored on the shop (`shops.delivery_choice`, migration **0146**); pickup only turns delivery off and **now completes the checklist line** (was: never). Checklist delivery line links to the new page | `lib/shop-delivery-choice.ts`, `components/seller/delivery-choice-form.tsx`, `app/shop/setup/delivery`, `shops.ts`, `api/shops/[id]`, `shop-setup-checklist.ts`, `lib/board/i18n.ts`, wizard |
| WP4 Unfinished registrations | **Reminders at 24 h and 72 h** after the owner's last step (Q3), in-app + e-mail with a resume link; at 72 h the dealer whose code they used is told. Each step moves the reminder; paying / going live cancels it. New table `scheduled_notices` (migration **0147**): written by the owner's own steps, **sent by the existing every-minute notification job — no new cron**. Admin → Onboarding funnel: **"Unfinished registrations to call"** (owner, phone, e-mail, step, code, idle time, reminders sent) | `services/scheduled-notices.ts`, `shop-registration-wizard.ts`, `cron/schedule.ts`, `notifications/types.ts` + `templates.ts`, `onboarding-funnel.ts`, `app/admin/onboarding-funnel` |
| WP5 Progress (F4) | Minutes per tile now add up to the targets: **about 5 min to go live**, **about 3 min to first products** (was "about 12 min") | `onboarding-wizard.tsx` |

Migrations: `0146_shop_delivery_choice` and `0147_scheduled_notices`, each with a rollback script in
`scripts/`. Neither has a foreign key, so the release rollback chain is unchanged.

## 2. Not done in Wave 1 (and why)

- **Category step on product categories (part of WP1):** the shelf already maps the chosen shop categories
  and the shop type to product categories; replacing the Category screen itself is left for Wave 2 with the
  translation work, to avoid two rewrites of the same screen.
- **Removing the unused `DOCS_READY` step (F7):** old registrations still carry it in the funnel table; kept.
- **Instant bank check (pennyless):** already built (`bankAccountCheck` rule); it needs the Cashfree
  verification keys (owner action A5) and the rule switched on.
- **`ABANDONED` status:** not written — an abandoned draft must stay resumable (the wizard only resumes
  OPEN drafts). "Abandoned" is shown from idle time and reminders instead.

## 3. Mobile apps

The apps are a WebView shell of the website, so every screen ships with the web release. The scanner uses
the camera inside the WebView (permissions already declared in `mobile/app.config.ts`; the WebView grants
same-host camera requests). No native code changed → no store version bump.

## 4. Testing

See [WAVE1_TEST_RESULTS_2026-11-06.md](WAVE1_TEST_RESULTS_2026-11-06.md).
