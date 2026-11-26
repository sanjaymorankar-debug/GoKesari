# Shop documents before the fee, the 30-day promise, and the 1st / 15th follow-up

> **Current rules (24-Nov-2026) — the registration gate below is superseded; the 1st / 15th follow-up and suspension still run (rule `shopDocumentFollowUp`).** Shops register only
> through the identity-first wizard ([BRIEF.md](../shop-onboarding-identity-first-2026-11/BRIEF.md); decision log DI-01 … DI-14,
> DF-08, DF-09): sign in → referral code and GSTIN / PAN on the first screen, checked online before anything else (no
> "upload later") → owner name if missing → address → **map pin before payment** → shop name, type and turnover slab
> → documents screen → pay → **live on payment, in every district**, once the must-haves below are on file (instant approval, DI-11 / DI-13). The
> old one-page form and the switches `shop_onboarding_wizard_enabled` / `gov_verification_auto_approval_enabled` are
> retired (DI-11). **Must-have before go-live:** a verified GSTIN or PAN, and the FSSAI licence for a food shop
> (owner, 21-Nov-2026 23.30 IST, DF-08 — this reverses DI-14 / DF-05 for FSSAI). **Every other document** (Shop Act,
> drug licence, medical / professional registration) may follow on the owner's ticked promise: 90 days
> (`shopDocumentFollowUp.promiseDays`), e-mail reminders on the 1st and 15th, automatic suspension after the date.
> Since 22-Nov-2026 an admin sets each document to must-have, on the promise or optional per shop type (or for all
> shops, food shops, doctors) in Admin → Shops → **Document rules** (DF-09, PR #471). The admin's "Approve without
> documents" (30 days) is the only exception to a must-have (DF-06).
>
> **Onboarding v2 (owner, confirmed 27-Nov-2026 00.30 IST: "Yes, FSSAI can be uploaded later"; flag `onboarding_v2`):**
> for a shop registered through the v2 flow, **every** licence — must-have ones and FSSAI for food included — may be
> uploaded later within the same promise period. The shop goes live on GST/PAN verified + fee paid; at the deadline
> the follow-up suspends it, and it is reactivated automatically once the documents are provided — no admin or
> operator approval in any of these steps (docs/onboarding-v2-2026-11/README.md, PR #642). Only the GSTIN / PAN
> stays a before-live check. The 21-Nov must-have rule above still applies to the original wizard (flag off).

> **29 Oct 2026, later the same day:** shops registered through the onboarding wizard no longer use
> this gate — they pay once their GSTIN / PAN is checked and go live on a verified GSTIN / PAN + payment
> ([BRIEF_REDESIGN.md](../shop-onboarding-wizard-2026-10/BRIEF_REDESIGN.md), decision D-B01). The
> gate below still applies to the long form and staff registrations; the 1st / 15th follow-up applies
> to every live shop.

Owner decision, 29 Oct 2026:

> Payment option must be after all the documents are verified; at least one document is
> mandatory. If no document is provided there should be an option that the user ticks "I will
> provide all relevant documents within 30 days", and it should be flagged for admin / operator
> for inspection and approval. Check every month whether any shop is without documents and send an
> email on every 1st and 15th of each month to the shop owner to submit the documents, else the
> shop will be suspended: after the 3rd reminder suspend the shop automatically and send the
> suspension email to the shop owner.

This replaces owner decision B (28 Oct 2026, "go live before the Shop Act review"), which is
withdrawn.

## 1. The rule

| | |
|---|---|
| **Mandatory documents** | PAN; GSTIN (or the "not GST-registered" declaration); Shop Act; FSSAI for a food shop. Udyam stays optional. Same list as before (`isMandatory`, `shop_kyc_complete`). |
| **Before the fee** | The registration fee can be paid only when **at least one** document is VERIFIED, and every other mandatory document is VERIFIED **or** the owner ticked *"I will provide all relevant documents within 30 days"*. |
| **"Verified"** | A `seller_verifications` row with status VERIFIED. A document still being checked (PENDING / MANUAL_REVIEW — e.g. a Maharashtra Shop Act, which has no online check) is not verified yet, so it needs the promise. The no-GST declaration is the team's to review, not a document the owner can give, so it never needs the promise — but it still keeps the shop from going live automatically. |
| **Promise** | Stored on the shop (`documents_promised_at`, `documents_due_at` = +30 days, rule `shopDocumentFollowUp.promiseDays`). Given once; a second tick keeps the first date. Audit `shop.documents_promised`. |
| **Approval** | A shop with every document verified and the fee paid goes live as before (instant approval / auto-approval rules). A shop with a promise is **never approved automatically**: it shows in the approval queue with the badge *"documents promised by &lt;date&gt;"* (red once overdue) and an **Approve on promise** button for admins **and operators**. That approval writes a `shop_document_waivers` row ("Owner promised the documents by …; approved after inspection") and the audit `shop.approved_without_documents` with `documentsPromise: true`. FSSAI is still enforced at approval for food shops (`assertFssaiAllowsApproval`): a food shop cannot go live on a promise alone. |
| **Follow-up** | Daily cron job `shop-document-follow-up` (05:00 IST); it acts only on the days in `shopDocumentFollowUp.reminderDaysOfMonth` (default **1 and 15**, India date). For every **live** shop (APPROVED, not closed) with a mandatory document the **owner** must provide (never given, or FAILED / EXPIRED): reminder 1, 2, 3 (e-mail + in-app, type `shop.documents_follow_up`). At the run after the 3rd reminder — and not before a promised date — the shop is **suspended automatically** (`suspendShopWithPolicy`, no person; orders: the automated policy, never cancel-and-refund) and the owner gets the suspension e-mail. Both e-mails are sent **even if the owner switched shop e-mails off** (`notify({ mandatory: true })`). |
| **Not chased** | A document waiting for GoKesari's check (PENDING / MANUAL_REVIEW, the no-GST declaration included). A shop whose missing documents are all verified or with the team has its reminder count cleared; a suspended shop that is reinstated starts again from reminder 1. |
| **Existing shops** | Live shops already missing documents are included from the first reminder day after release — including shops an admin approved without documents (0109), whose dealer commission already waits for the documents. Switch the whole follow-up off with rule `shopDocumentFollowUp.enabled = false`. |

## 2. Where it is

| Part | Code |
|---|---|
| Gate, promise | `src/server/services/shop-document-gate.ts` (`shopDocumentGate`, `assertDocumentsAllowPayment`, `promiseShopDocuments`); checked in `startRegistrationFeeCheckout` |
| Fee page (long form) | `src/app/shop/registration-fee/page.tsx` + `src/components/documents-promise-form.tsx`; `POST /api/shops/[id]/documents-promise` |
| Wizard | `src/server/services/shop-registration-wizard.ts` (`WizardView.documents`, `submitDraftForPayment({ promiseDocuments })`); Shop Act and FSSAI may be answered "not now"; review step lists verified / missing / in review with the promise box |
| Approval | `approveShop(..., { acceptDocumentsPromise: true })` in `src/server/services/shops.ts`; route `POST /api/shops/[id]/approve` body `acceptDocumentsPromise: true`; queue `src/components/shop-approval-panel.tsx` |
| Follow-up | `src/server/services/shop-document-follow-up.ts`; cron `src/server/cron/schedule.ts` (DAILY); table `shop_document_reminders` (seller DB, one row per shop per reminder day) |
| Admin list | **Shops → Shops missing documents** (`/admin/shops/missing-documents`, permission SHOP_APPROVE): live / suspended / awaiting approval, with the missing documents, the reminders sent, the last one and the promised date |
| Rule | `shopDocumentFollowUp` `{ enabled: true, reminderDaysOfMonth: [1, 15], remindersBeforeSuspension: 3, promiseDays: 30 }` (admin → Settings → rules) |
| Migration | `drizzle/0115_shop_document_promise.sql` (`-- split: seller`, additive); rollback `scripts/rollback-0115.sql` |

## 3. Timeline example

Shop approved on its promise on 5 Nov (due 3 Dec):

| Date | What happens |
|---|---|
| 15 Nov | Reminder 1 of 3 |
| 1 Dec | Reminder 2 of 3 |
| 15 Dec | Reminder 3 of 3 — "last reminder: if they are still missing on 1 Jan 2027, your shop will be suspended automatically" |
| 1 Jan | Still missing → suspended; suspension e-mail with the documents to upload |

## 4. Tests

- `tests/integration/onboarding-wizard-step2.test.ts` — wizard: refused without a verified document, the promise required for a missing / in-review document, all verified → live, promised → paid but pending, "not now" for Shop Act and FSSAI, the long form's fee gate.
- `tests/integration/shop-document-follow-up.test.ts` — approval on promise (operator, admin; customer and unpromised refused; never automatic), reminders 1–3 on the 1st / 15th with the opt-out ignored, suspension at the next run, promise date respected, in-review not chased, count cleared, food shop FSSAI, closed / pending shops left alone.
- `tests/integration/registration-fee-*.test.ts` — the checkout refuses before the documents.
- Both database layouts (single and seller / customer split).

## 5. Open points for the owner

1. ⚖ Lawyer / CA: listing a seller on a promise for up to ~45 days before its Shop Act / GSTIN is verified (`docs/seller-verification/COMPLIANCE.md` §8).
2. A Shop Act in MANUAL_REVIEW ("upload your certificate") counts as *with the team*, so it is not chased by the follow-up. If the team needs the certificate file and the owner never uploads it, the shop is not suspended by this job — the reviewer rejects it (FAILED), and the reminders then start.
3. Production release: the first reminder day after release e-mails every live shop on gokesari.com still missing documents. Check the "Shops missing documents" list first, or switch the rule off until ready.
