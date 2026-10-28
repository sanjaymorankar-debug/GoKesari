# Shop onboarding wizard — plan (approved by the owner 28 Oct 2026)

One guided screen at `/shop/register` that takes a shop owner from sign-in to
"onboarding complete" in this order. It replaces the single long form; the
government checks, map picker, fee payment, instant approval and "ready"
email that already exist are reused, not rebuilt.

## Owner decisions (28 Oct 2026)

| Question | Decision |
|---|---|
| No GSTIN | Ask for PAN instead, plus the "not GST-registered" declaration (an admin reviews it, as today) |
| PAN when GSTIN is verified | Take the PAN out of the GSTIN and check it with the government in the background (one extra paid call, no typing) |
| Shop Act (Maharashtra cannot be checked online) | Shop goes live after payment; an admin checks the Shop Act upload afterwards and can suspend the shop |
| FSSAI | "Do you have FSSAI?" asked of every shop; compulsory for food shops |

## Steps

| # | Step | What happens | Reuses |
|---|---|---|---|
| 1 | Sign in | Mobile OTP or Google account; unsigned visitors are sent to `/signin` and back | `/signin`, `src/server/auth.ts` |
| 2 | GSTIN | Owner types GSTIN → government check. On success: shop / entity name (trade name, else legal name), legal name, address, state and PIN are filled from the GST record; GSTIN marked VERIFIED; the PAN inside it is checked silently and marked VERIFIED. "I don't have a GSTIN" → step 2b | `verifyDocument()`, `seller-verification.ts` |
| 2b | PAN (no GSTIN) | Owner types PAN → government check; name on PAN used as owner name; declaration ticked | same |
| 3 | Shop details | Shop type, categories, phone, turnover (sets the fee slab), referral code / dealer employee. Name and address come pre-filled from step 2 | fields from `shop-register-form.tsx` |
| 4 | Udyam | "Do you have Udyam?" → number → government check | same |
| 5 | FSSAI | "Do you have FSSAI?" → number → government check (expiry, premises PIN). Cannot be skipped for food shops | same |
| 6 | Shop Act | Number → vendor check where it works; otherwise upload of the certificate / Form G receipt, left for admin review | `/shop/documents` upload |
| 7 | Location | Google Maps pin on the shop; address and PIN confirmed | `MapPicker` |
| 8 | Payment | Registration fee through Cashfree | `/shop/registration-fee`, gateway webhook |
| 9 | Done | On the signature-checked payment webhook: shop approved, onboarding marked complete, "registration successful" email (in-app + email, via the notification outbox) | `gov-auto-approval.ts`, `shop-ready-email.ts` |

Until step 3 creates the shop, the registration in progress lives in its own
table, `shop_registration_drafts` (seller database, migration 0111) — not as a
half-filled `shops` row, which would need phone, shop type, fee and address up
front and a new shop status every status filter would have to learn. When the
shop is created, the draft's GSTIN and PAN results are copied to
`seller_verifications` with the vendor's reference, so the instant approval
sees government-verified rows and the daily job retries any still PENDING; the owner can leave and resume at the first unfinished step. A
step whose government source is down shows "we'll keep checking" and lets
the owner continue; the daily job retries it, and approval waits for it.

## Changes needed beyond the screen

1. **Silent PAN check from GSTIN** — new service call; the PAN row is VERIFIED only by the PAN source, never copied from the GST answer.
2. **GST record → shop fields** — the adapter already returns trade/legal name, address, state, PIN; write them to the draft shop (owner may edit the shop name, not the legal name).
3. **Shop Act after go-live** — migration 0051's onboarding rule and `missingMandatoryDocuments` currently require Shop Act VERIFIED before approval. New migration (`-- split: seller` / `both` as the tables require) lets an *uploaded, awaiting-review* Shop Act count for approval; the daily job and admin queue suspend the shop if the review rejects it (existing auto-suspend path). Needs sign-off in `docs/seller-verification/COMPLIANCE.md` (lawyer / CA).
4. **Onboarding complete** — set on approval (lifecycle VERIFIED → live), with the completed-at time; the email goes from `sendReadyForProductUpload` after commit, never inside the transaction.
5. **Instant approval on by default for this flow** — today it runs only where flag `gov_verification_auto_approval_enabled` covers the district. Either turn the flag on per district (no code) or make the wizard path approve regardless — to confirm.
6. Old `/shop/join` and long form stay reachable for operators until the wizard has run on staging.

## Rules this must follow

- Works on both database layouts (one database, and the seller / customer split); verification tables are seller-side.
- No vendor call, payment call or email inside `db.transaction`.
- Mock vendor on test.gokesari.com until Gridlines sandbox keys arrive (`KYC_PROVIDER=mock`, numbers in `docs/seller-verification/README.md`); Cashfree sandbox data for the payment step.

## Testing

- Integration tests per step, incl. no-GSTIN, food shop, vendor timeout, Shop Act upload-only, payment failure and resume.
- `test-split` CI job; then a full run on test.gokesari.com with the mock vendor and the "Sandbox payment" workflow; results to `Test_Cases_Tracking`.

## Build order

1. Server: draft shop + GSTIN-first step with silent PAN and record fill (with tests).
2. Wizard screen steps 1–7 with resume.
3. Shop Act rule change (migration) + payment → complete + email.
4. Staging run, QA register update.

## Status

| Build step | State |
|---|---|
| 1. Draft + GSTIN-first with silent PAN + GST record fill | **Built** (branch `claude/onboarding-wizard-step1`): migration 0111 (rollback `scripts/rollback-0111.sql`), `src/server/services/shop-registration-draft.ts`, `GET /api/shops/registration-draft`, `POST /api/shops/registration-draft/gstin`, `POST /api/shops/registration-draft/pan`; tests `tests/integration/onboarding-wizard-step1.test.ts` on both layouts. The mock vendor's GSTIN answer now carries an address and constitution so staging shows the fill. |
| 2. Wizard screen steps 1–7, resume, draft → shop (copy checks to `seller_verifications`) | Not started |
| 3. Shop Act rule change + payment → complete + email | Not started |
| 4. Staging run, QA register | Not started |

Step 1 API, for the screen:

- `GET /api/shops/registration-draft` → the owner's open draft or `null`.
- `POST …/gstin` `{ gstin, consent: true }` → GSTIN checked; if verified, the PAN inside it is checked too. Returns statuses (masked numbers), `prefill` (shop name = GST trade name else legal name, legal name, owner name for a proprietor, constitution, address, state code, PIN) and `canContinue`.
- `POST …/pan` `{ pan, declaration: true, consent: true }` → no-GSTIN route.
- `canContinue` is true for VERIFIED, and for PENDING (government source down — re-checked later) or MANUAL_REVIEW (an admin checks it); false for FAILED / EXPIRED. 409 `DUPLICATE_SHOP` when a live shop already has the GSTIN; `RATE_LIMITED` after the hourly limit (`sellerVerification.maxChecksPerShopPerHour`).
