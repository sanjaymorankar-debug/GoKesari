# Flow spec v3 — wave 3

F4 shop onboarding, F5 licence reminders, F6 shop subscription. Owner decisions of 27-Nov-2026.

Everything new is behind a feature flag. With a flag off the site behaves exactly as before: no existing rule
default changes. Wave 3's switches live in a new rule group, `shopFlowsV3`, read only while the matching flag is on
(`src/server/flows/wave3-rules.ts`).

## What onboarding v2 already covered (reused, not rebuilt)

Migration 0220 and `src/server/onboarding-v2/` already carry these owner decisions, so wave 3 adds nothing for them:

- Fee: the turnover slabs ₹999 / ₹4,999 / ₹9,999 + GST (rule `registrationFeeByTurnover`), paid straight after
  GST / PAN verification (v2 order).
- Every licence, FSSAI included, may be "upload later" in v2; the deadline is `shopDocumentFollowUp.promiseDays`
  (90 days, unchanged); the follow-up suspends at the deadline and `document-reactivation.ts` reinstates the shop
  automatically once the documents are in (no admin step). The original wizard keeps FSSAI as a must-have for food.
- Seller agreement accepted at registration without an OTP (`signature_method = REGISTRATION_ACCEPT`); the OTP stays
  for a later review from the dashboard.
- The documents follow-up already counts licences given at a v2 registration (`registration_licence_entries`
  VERIFIED / PENDING_OPERATOR).
- Shop Act stays PROMISE and Udyam OPTIONAL (Admin → Shop document rules). "Ready for product upload" e-mail is
  wave 2 (`flow_f13`). The mobile-code fallback without SMS is left to `dual_auth`.

## Flags (migration 0222)

Seeded **ON** on the staging database (`gokesari_test`) and **OFF** everywhere else
(`enabled = current_database() = 'gokesari_test'`, `ON CONFLICT DO NOTHING`). The migration has no table changes.

| Flag | What it switches on |
|---|---|
| `flow_f4` | The v2 agreement step offers two optional fields: the shop's WhatsApp number (`shops.whatsapp_number`) and its payment QR (read and checked as a UPI payment QR, kept in `inv_settings.banner_upi_qr`, printed on the welcome-kit banner). The accepted agreement is e-mailed at acceptance in English, Marathi and Hindi: the signed PDFs when the agreements engine made them (sent at once if the shop is not live yet; a live shop's welcome kit already carries them), otherwise one text e-mail in the three languages with links to the Seller Terms (document type `SELLER_TERMS_ACCEPTED`). |
| `flow_f5` | Licences entered, uploaded or scanned at a v2 registration are copied into the shop's licence register (`shop_legal_documents`, with number, expiry, issuing authority and file): SUBMITTED while the team checks it, APPROVED once verified, REJECTED with the team's reason. Done at shop creation, after the team's decision in the registration-licences queue, and by the daily documents follow-up (back-fill for older shops). A decision taken on the copy in the legal-documents queue updates the registration entry. "What is on file" (`requirementsOnFile`) also counts registration entries, Shop Act / Udyam included. A licence promised at registration and given later is marked given (VERIFIED once approved; while checked it keeps PROMISED with a note). |
| `flow_f6` | A new shop's first 12-month registration period starts on its first go-live day, not on the fee payment day (time added on top, e.g. a referral month, is kept). Shops already live keep their dates. Expiry reminders (in-app, push, e-mail with the payment link) and online renewal run even if rule `shopMembership` has them off. |

## Rule `shopFlowsV3` (Admin → Business rules)

| Field | Default | Flag | Source |
|---|---|---|---|
| `askContactAtRegistration` | true | `flow_f4` | owner |
| `agreementEmailOnAcceptance` | true | `flow_f4` | owner |
| `registrationLicencesToRegister` | true | `flow_f5` | owner |
| `subscriptionStartsAtGoLive` | true | `flow_f6` | owner |
| `remindersAndRenewalOn` | true | `flow_f6` | DEFAULT – confirm with Sanjay (switch off to leave reminders and renewal to rule `shopMembership`) |

## How it works

- Copy rule (F5): a register row counts as a registration copy when its `submitted_at` equals the entry's
  `created_at`. A licence the owner sent again from the Documents page has a later `submitted_at` and is never
  overwritten; a row the legal-documents sweep created as "required" (NOT_SUBMITTED) is filled in. The bytes of the
  file are copied as they are (both tables use the same encryption).
- Go-live (F6): `approveShopTransaction` calls `anchorSubscriptionAtGoLive` inside the same transaction, only on a
  shop's first approval and only when the shop has exactly one active REGISTRATION period that starts before go-live.
- E-mails are queued in the document-email outbox after the commit; nothing external runs inside a transaction.

## Files

- `drizzle/0222_flows_v3_wave3.sql` — flag seeds.
- `src/server/flows/wave3-rules.ts`, `f4-onboarding.ts`, `f5-licences.ts`, `f6-subscription.ts`.
- `src/app/api/shops/registration-draft/v2/contact/route.ts` — POST JSON `{ whatsappNumber }` or multipart
  (`whatsappNumber`, `qr`); 404 while `flow_f4` is off.
- Hooks: `onboarding-v2/shop-flow.ts` (shop created, team decision, acceptance), `onboarding-v2/shop-view.ts`
  (`contact` in the v2 view), `onboarding-v2/document-reactivation.ts`, `services/legal-documents.ts`,
  `services/shop-document-rules.ts`, `services/shop-document-follow-up.ts`, `services/shops.ts`,
  `services/shop-membership-renewal.ts`, `services/shop-registration-subscription.ts`, `documents/email.ts`.
- Tests: `tests/integration/flows-v3-wave3.test.ts` (each item with its flag on and off).

## Not built in wave 3

- WhatsApp number and payment QR in the **original** wizard: only the v2 path asks them (the original path is
  replaced by v2 when `onboarding_v2` goes on in production). Both can still be set in My shop as before.
- An admin list of unpaid v2 drafts, and a commission test for v2 shops (audit items 12–13): not owner decisions
  for this wave.
- The signed-PDF branch of the acceptance e-mail is covered by the existing seller-agreements tests' engine; it needs
  the PDF libraries installed to run locally.
