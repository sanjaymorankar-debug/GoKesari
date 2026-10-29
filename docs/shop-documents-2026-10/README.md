# Shop documents before the fee, the 30-day promise, and the 1st / 15th follow-up

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
