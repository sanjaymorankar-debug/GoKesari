# Module 6: Hindi and Marathi for inner pages (23-Nov-2026)

Branch `feat/m6-hindi-marathi`, migration **0194**. No feature flag: the language switch (EN / हिं / मरा) is the
control. With English selected, every screen and every notification reads exactly as before.

## What already existed
- Inline labels `L(en, hi, mr)` read with `tr(text, lang)` in `src/lib/board/i18n.ts`. If the Hindi or Marathi text is
  blank, the English text is shown.
- The `gk_lang` cookie, set by `setLanguageAction` (`src/server/language-action.ts`) and read by `getBoardLang()`
  (`src/server/board-lang.ts`).
- The switch in the board header and the home account menu.
- About 680 `tr()` calls covering the board, home, the search screens and part of the shop screens. Most inner pages
  were English only.

## What this module adds
1. **Inner pages.** Strings are wrapped in `tr(L(...))` using the existing style: a local `T = { … }` table in each
   file. Client components get an optional `lang` prop that defaults to `"en"`, so screens that do not pass it stay
   English. Brand names, order numbers, SKUs, product and shop names, units, amounts and codes are not translated.
   There are now **1,826 `tr()` calls** in `src`, up from 678.
2. **Common customer errors** (`src/lib/board/error-text.ts`):
   - About 40 exact API and screen error messages in Hindi and Marathi, for example "out of stock", "shop not open",
     "does not deliver to", "below minimum", "invalid or expired coupon", "insufficient wallet balance", "payment not
     verified", "wrong code" and "please wait N seconds".
   - Patterns for messages that contain a shop name or an amount. The name and amount are kept as they are.
   - A general line for codes whose meaning needs no detail: `RATE_LIMITED`, `UNAUTHENTICATED`, `FORBIDDEN`,
     `INSUFFICIENT_BALANCE`, `OUT_OF_STOCK`, `PAYMENT_VERIFICATION_FAILED` and `INTERNAL`.
   - Screens call `errorText(message, lang, code)` when they display an error. The server's strings and codes are
     unchanged. An unknown message stays in English rather than being guessed.
3. **Saved language** (migration `drizzle/0194_users_preferred_lang.sql`):
   - Adds `users.preferred_lang`, a text column that allows `NULL`, `en`, `hi` or `mr` (enforced by a CHECK constraint).
   - `setLanguageAction` also saves the choice for a signed-in person.
   - `getBoardLang()` checks the cookie first, then `preferred_lang`, then falls back to English. A new phone opens in
     the person's language.
   - Helpers are in `src/server/preferred-lang.ts`.
   - Rollback: `scripts/rollback-0194.sql`.
4. **Notifications** (`src/server/notifications/templates.ts`, `src/server/services/notifications.ts`):
   - `notify()` takes an optional `lang`. With `"auto"` it uses the person's `preferred_lang`.
   - Hindi and Marathi wording exists for these events: order placed or confirmed, accepted, out for delivery,
     delivered, cancelled, payment refunded, return refund started and return refund completed.
   - The e-mail button and footer follow the language only when the body was translated.
   - English is kept when no language is set, when the person chose English, when the event has no translation, or
     when a variable the translation needs is missing.
   - Only the customer-side messages pass `lang: "auto"`: `forBuyer` in `events/catalog.ts`, checkout in `orders.ts`
     and `payments/order-payments.ts`, and the two return refunds in `returns.ts`. Shop and rider notices stay English.
5. **Tests**
   - `tests/unit/hindi-marathi-i18n.test.ts` checks that every `L(...)` in `src` is three string literals and that
     none of the three texts is empty. It also checks that whole English sentences were not copied into the Hindi or
     Marathi slot, and it tests the error map and the notification wording.
   - `tests/integration/preferred-lang.test.ts` tests saving and reading the language, the CHECK constraint, `notify`
     with and without a language, and the confirmation and cancellation messages in Hindi and Marathi. It also checks
     that the shop owner still gets English.

## Coverage per area (files that use the language; before → after)

| Area | Files | Before | After | Still English only |
|---|---|---|---|---|
| Rider / delivery partner | 33 | 0 | 28 | 5. All are admin screens: rider change review, earnings rules, KYC review, verification admin, wallet admin actions. |
| Orders (list + detail) | 13 | 1 | 11 | 2: the sandbox pay page (test only) and `order-filters` (admin only). |
| Tracking | 2 | 0 | 2 | 0 |
| Product page + cards | 3 | 0 | 3 | 0 |
| Cart / checkout | 2 | 2 (4 `tr` vs ~21 English lines) | 2 (all strings) | 0 |
| Wallet | 2 | 2 (partial) | 2 (all strings) | 0 |
| Address / profile | 6 | 1 | 5 | 1: `/profile/bank-account`, through `BankAccountManager`, which shop and gig screens share. |
| Shop inner pages | 102 | 32 | 47 | 55. See the list below. |
| Staff | 6 | 1 | 5 | 1: `/staff/accounting`, a back-office accountant desk treated like admin. |
| Onboarding pieces | 4 | 0 | 4 | 0 |
| Admin | 110 | 4 | 4 | 106. Admin stays English by decision. |

**Shop pages still English:**
- `shop/accounts/**` detail pages and the billing components under `components/billing/*`.
- `shop/health/**`.
- consult, puja, legal-documents, `settings/*`, marketing, media-import, changes, join, gst-returns, packing slip,
  product images and media, staff-access, support-services, `manage/[section]`, profile-setup.

**Shared components still English** on translated pages:
- `StatusBadge`, `AvailabilityBadge` and `BankAccountManager`.
- The ticket components.
- `ShopOffersManager`, `PhotoCatalogue`, `StockEditor`, `ShopStaffManager`, `DocumentUploadPanel`,
  `SellerVerificationPanel` and `fulfilment-planner`.

**Text that comes from the database or the server stays as written:** shop and product names, wallet transaction
descriptions, rejection reasons, turn-by-turn route instructions and server reason strings that are not in the error
map. Dates are still formatted as en-IN.

## Native-speaker review: still needed
All Hindi and Marathi text was written by the developer (an AI model) and has **not** been checked by a native speaker.
The owner should name one Hindi and one Marathi reviewer. Points to look at first:
- **Returns:** Marathi "परतावा" is used for both refund and returns. "रिटर्न" may read better for returns.
- **Word choices:** "Default address" is मुख्य. "Landmark" is पहचान का स्थान / खूण. "Acknowledge" (stock alert) is
  देख लिया / पाहिले. "Withdrawal" is निकासी / रक्कम काढणे.
- **Gender:** the rider is addressed in the masculine form, and KYC lines use करूँगा/करूँगी pairs.
- **Consent text:** the KYC consent text is shown translated, but only the English text is recorded by the server.
  The owner should confirm that this is acceptable.
- **Word order:** sentences split around an amount, such as "Add ₹X more" and "Collect ₹X", may read stiffly.

## Known limits and risks
- **Deploy order:** the migration must be applied before this code is deployed. The Drizzle `users` model now
  includes `preferred_lang`, so any full `users` select fails on a database without it. The staging queue applies
  migrations first.
- **Migration numbering:** migrations 0190–0193 belong to other modules. Until they are merged,
  `tests/unit/migration-journal.test.ts` fails its "numbers the entries 0, 1, 2, …" check because the journal jumps
  from 0181 to 0194. It passes once the other modules are merged in order.
- **Side effects of the language switch:**
  - The starter shelf reloads when the language changes, which drops unsaved price edits on it.
  - The pickup-QR camera restarts when the language changes.
- **Not checked visually:** nothing was rendered in a browser. English output was kept identical by reading the code
  and by the lint, type and test checks.

## Staging E2E follow-up (25-Nov-2026)

The flags-on run on test.gokesari.com found English left on customer screens; now translated:
- `/track` lookup form (labels, tabs, buttons, messages) — `src/lib/guest-checkout-i18n.ts`.
- `/orders`: status badges (`src/lib/order-status-i18n.ts`, `StatusBadge` takes an optional `label`), the delivery-slot
  line and the order card (way of delivery, pickup / delivery codes), and "Report a problem".
- `/wallet`: entry types and the known stored descriptions (`src/lib/wallet-i18n.ts`; order numbers, shop names and
  reasons are kept as stored; unknown descriptions are shown unchanged).
- `/cart`: "Save as a list" card and the Kesari / Green badge.

Same PR: `/shop/staff-access` intro no longer says "product photos and descriptions" when staff roles are on, and
Admin → Order Monitoring shows the reason of a failed delivery (`deliveryGpsForOrders` returns `failureReason`).
Tests: `tests/unit/customer-i18n-gaps.test.ts`, `tests/integration/delivery-signature-gps.test.ts` (TC-M4-I20/I21).
