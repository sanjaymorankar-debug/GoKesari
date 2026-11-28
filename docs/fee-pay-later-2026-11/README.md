# Registration fee: Pay later (28-Nov-2026)

Owner request, 28-Nov-2026: a shop owner may choose **"I will pay later"** for the shop registration fee. An
administrator approves it, the shop goes live and can upload products, the owner is reminded every week, and the
fee is taken out of the shop's payouts until it is paid. The owner sees a statement of what was deducted and
what GoKesari earned in commission.

Migration **0229** · feature flag **`shop_fee_pay_later_enabled`** (ON on test.gokesari.com from the migration,
OFF on gokesari.com until the owner switches it on) · service `src/server/services/fee-pay-later.ts`.

## Flow

| Step | Who | What happens |
|---|---|---|
| 1. Ask | Shop owner | Registration wizard, fee step: **I will pay later** (optional note). Or, for a shop that already exists and owes its fee: **Pay later** on *Registration fee* (`/shop/registration-fee`). The fee is quoted exactly as for a payment (turnover band, coupon, GST). Open checkouts end. |
| 2. Carry on | Shop owner | The wizard moves past the fee step: shop type, licences, address, pin, seller agreement. The shop is created owing the fee and waits (*Your shop is with GoKesari's team — waiting for GoKesari to approve paying the fee later*). No fee reminders while the request waits. |
| 3. Told | The dealer / franchise whose referral code the shop used (else administrators) | In-app + push + e-mail: *Pay-later request from your shop: <shop>* (dealer), or *Pay-later request: <shop>* (admins). |
| 4. Decide | **Owner, 28-Nov-2026: the dealer / franchise whose referral code the shop registered with** — a dealer or salesperson code → its dealer; a franchise code (GKF-) → the franchise owner. Administrators (`REGISTRATION_FEE_MANAGE`) only when no such dealer, or that dealer is no longer APPROVED. | Dealer: **dealer portal → Pay-later requests** (`/dealer/pay-later`, also linked from My franchise, with a "waiting" banner). Admin: **Admin → Shops → Pay-later requests** shows every request and who decides it; Approve / Reject only on the admin's own. A reason is required to reject and is shown to the owner. Nobody else may decide (403). |
| 5a. Approved | — | The fee no longer holds the shop back. If the shop exists and nothing else blocks it, it goes live at once through the instant approval. A **dealer's** approval clears only the fee: if anything else is open the shop waits in GoKesari's normal approval queue (Admin → Shops), where the fee no longer blocks it. An **admin's** approval also tries the normal approval, then the approval on the owner's documents promise. If the owner has not finished registering, it goes live as soon as the seller agreement is accepted. If something else blocks it (e.g. a duplicate GSTIN), the admin is told what, and approves it under Admin → Shops once resolved. The owner is told by in-app + push + e-mail. |
| 5b. Rejected | — | The owner is told the reason. A registration in progress goes back to the fee step (later steps are kept); an existing shop pays from *Registration fee* as before. |
| 6. Reminders | — | Every 7 days from the approval (09.00 IST, the existing registration-fee reminder job): in-app + push + e-mail, English + Marathi, with a Pay now link, saying the fee is being taken from payouts. |
| 7. Recovery | — | Every payout — the payout cycle (rule `payouts` on) or the weekly settlement (off) — first pays the fee: **the whole fee when the payout is larger** (the rest is paid out), **all of the payout when it is smaller** (the rest from the next payouts). Shown as the line *Registration fee (pay later)* on the payout statement (`REGISTRATION_FEE_RECOVERY`), or in the settlement's adjustments. Each deduction is a fee payment on the shop's ledger (method `PAYOUT_DEDUCTION`), so membership, registration status and GoKesari's fee invoice follow as for any payment. The owner is told what was taken and what is left. |
| 8. Done | — | Paid in full (from payouts, online, or recorded by hand): the request ends (`SETTLED`). Paying online before a decision cancels the request. |

## Statement (owner)

*Registration fee* page, below the fee: registration fee, taken from your payouts, paid by you, **still to pay**,
**GoKesari's commission on your orders so far** (and delivered orders / value), and every deduction (date,
amount, payout before the deduction, receipt reference).

## Data (0229)

- `shop_fee_pay_later` — `referral_code`, `approver_dealer_id`, `approver_user_id` (who decides, fixed when asked); one open request (REQUESTED / APPROVED) per draft and per shop; REJECTED, CANCELLED,
  SETTLED kept as history.
- `shop_fee_recoveries` — one row per payout cycle / weekly settlement and shop (unique), with the payout before
  the deduction and the ledger payment.
- `shop_registration_drafts.fee_deferred_at` — the draft passed the fee step by asking to pay later.
- `shop_payment_method` + `PAYOUT_DEDUCTION`.
- `status_transition_rules` + SHOP `PAYMENT_PENDING → ACTIVE`: a shop with verified documents and the fee owed may
  go live. The application still refuses that for every unpaid shop except one with an approved request
  (`assertRegistrationFeeSettled`, `shops.ts`).
- Rollback: `scripts/rollback-0229-fee-pay-later.sql`.

## Defaults chosen (owner may change)

| # | Default | Why |
|---|---|---|
| D1 | The code's dealer approves alone (no second approval). Requests without a dealer code, or whose dealer is no longer active, go to one administrator. | Owner, 28-Nov-2026: the dealer decides, not the admin. |
| D2 | No deadline / automatic suspension for an unpaid pay-later fee: weekly reminders and payout deductions continue until paid. An admin can still suspend a shop. | The owner did not ask for one. |
| D3 | Only payouts are used for recovery; the shop's prepaid wallet is not debited. A shop whose customers all pay cash (no payouts) is recovered only through the reminders. | Wallet money is meant for commission and delivery charges. |
| D4 | The deduction is taken before the wallet top-up and the minimum-payout check; a payout reduced to ₹0 is held (`NOT_POSITIVE`) and carried, as any ₹0 payout. A shop whose bank account is not verified still has the fee taken (the money stays with GoKesari either way). | The owner asked for "all the amount" from the first payouts. |
| D5 | GoKesari's tax invoice for the fee is issued in the payout cycle after the deduction, as for any fee payment ("already paid"). | Existing invoicing. |

## Tests

- `tests/integration/fee-pay-later.test.ts` (14; PL-30–32: dealer routing, dealer-only decision, fee-only approval, admin fallback): request, admin notice, permissions, reject reason, pending shop
  approved → live, flag off, payout smaller / larger than the fee, no approval → no deduction, weekly settlement,
  paying another way ends it, recovery rule, weekly reminder schedule.
- `tests/integration/onboarding-v2-shop.test.ts` (+4): wizard ask → finish → admin approves → live; approved before
  finishing → live at the agreement; rejected → back to the fee step; paid online after asking → cancelled; flag off.
