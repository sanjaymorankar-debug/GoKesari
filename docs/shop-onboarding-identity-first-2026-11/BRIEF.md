# Shop onboarding: identity first (owner brief, 08-Nov-2026)

**Status:** built on branch `feat/onboarding-identity-first`, tested locally. Staging and production
results: [TEST_RESULTS.md](TEST_RESULTS.md). Decisions: [decision-log.md, DI-01 … DI-10](../decision-log.md).

> **Current rules (24-Nov-2026).** This is the registration flow on both sites (the only one since DI-11; the
> wizard is always on, in every district). Changed since this brief:
> - **Email** step (`EMAIL`) after the first screen, for an account with no e-mail (DI-08).
> - **Documents screen** (`DOCUMENTS`) between "Create my shop" and payment (DF-07, made required by DF-08,
>   21-Nov-2026 23.30 IST). **Must-have before payment:** the verified GSTIN or PAN and, for a food shop, the FSSAI
>   licence (`FSSAI_REQUIRED`) — this reverses DI-14 / DF-05 for FSSAI. **Everything else** (Shop Act, drug licence,
>   medical / professional registration) may follow on the owner's ticked promise (`DOCUMENTS_PROMISE_NEEDED`):
>   90 days, reminders on the 1st / 15th, automatic suspension after the date.
> - **Admin document rules** (DF-09, 22-Nov-2026, PR #471): Admin → Shops → Document rules sets each document to
>   must-have, on the promise or optional for all shops, food shops, doctors or one shop type. GSTIN / PAN stays a
>   fixed must-have.
> - Paid and verified means live at once (DI-13); "Approve without documents" (admin, 30 days) is the only way past
>   a missing must-have (DF-06).

## Problem (owner's words, summarised)

The wizard asked for the shop name, owner address and map pin first, and the PAN / GST last, so
owners typed what the government record already knows, and verification came too late.

Found on 08-Nov-2026: **gokesari.com had the wizard switched off** (`shop_onboarding_wizard_enabled`),
so sellers there used the old one-page form, where PAN / GST really is last. test.gokesari.com ran
the wizard, which checked GST / PAN before the details but behind three screens (referral, shop
email, "documents handy?" with "upload later"), with the map pin after payment.

**08-Nov-2026 17.50 IST — one flow (DI-11):** the old one-page form and the two switches
(`shop_onboarding_wizard_enabled`, `gov_verification_auto_approval_enabled`) are retired; the wizard
below is the only registration flow, always on.

## The new order

| # | Screen (wording from the brief) | What fills it | Server step |
|---|---|---|---|
| — | Sign in with email (code by email) | — | (sign-in page) |
| 1 | **Verify your business** — referral code; "Do you have a GST number?" [Yes] [No]; "Enter your 15-digit GSTIN" / "Enter your 10-character PAN" | Yes: GSTIN → PAN (characters 3–12, never typed), legal / trade name, owner name, address. No: PAN → name (and address where the source gives one) | `IDENTITY` |
| 1b | Owner name — only when the record named no owner (a company's GSTIN) | — | `OWNER` |
| 2 | **Confirm your shop address** — pre-filled, "Verified from GST / PAN"; editable | GST / PAN record | `ADDRESS` |
| 3 | **Mark your shop location on the map** — search, current location or drag the pin | existing map integration | `PIN` |
| 4 | Your shop name — pre-filled from the GST trade / legal name; type, mobile, turnover slab | GST record | `SHOP` (+ `FSSAI` for a food shop) |
| 4b | *(added 21-Nov-2026; shown after `REVIEW` creates the shop, before `PAYMENT`)* Upload your documents: must-haves, or tick the promise for the rest | — | `DOCUMENTS` |
| 5 | Check and pay — the registration fee (existing yearly slabs) | — | `REVIEW` → `PAYMENT` |
| 6 | "Your onboarding is complete. Your shop is now live and accepting orders." + "Add your products now so customers can find them and place orders with you." + **[Add Products]**; same words by email | — | `LIVE` → `CATEGORY` → `PRODUCTS` |

Payment failed or pending: the shop stays pending, not live; the owner can still shop as a customer
(unchanged).

**Flow 2 — an existing customer clicks Sell:** already signed in, so the wizard opens at screen 1.
A registration with no step for 7 days is discarded and starts afresh at screen 1; a newer one
resumes where it was (Back never loses verified data).

**Validation:** GSTIN 15 characters, PAN `AAAAA9999A`, checked on the screen and on the server
before any paid call; the PAN is taken from the GSTIN's characters 3–12; a GSTIN or PAN held by
another account's live shop is refused with that shop's status.

## Where it lives

- Server: `src/server/services/shop-registration-wizard.ts` (step order, owner / address / shop
  saves), `shop-registration-draft.ts` (verified-only, duplicates, PAN address, abandoned drafts)
- Routes: `src/app/api/shops/registration-draft/{owner,address}` (new), `details` (address optional)
- Screens: `src/components/registration/onboarding-wizard.tsx` (Theme 1 Tile Board, 7 tiles)
- Email: `SHOP_READY_FOR_PRODUCT_UPLOAD` in `src/server/notifications/templates.ts`
- Mobile: the Android / iOS apps load `/shop/register` in their WebView — no app change.
- Tests: `tests/integration/shop-registration-flow.test.ts` (Flow 1 GST / PAN, Flow 2, duplicates,
  payment success / failure), `onboarding-wizard-step1.test.ts`, `onboarding-wizard-step2.test.ts`
