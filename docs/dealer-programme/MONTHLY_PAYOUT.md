# Dealer commission — monthly payout on the 5th (28 Oct 2026)

Owner request: dealer commission is released monthly, on the 5th of each month, with a detailed
report of the registrations each dealer brought.

## How it works

1. **Earning is unchanged.** Commission is still recorded per shop milestone (registered with the fee
   paid, verified + catalogue, activated) under the rules in Admin → Dealers → Commission.
2. **The close (the 5th, 05:00 IST).** The daily job `dealer-monthly-payout` (in `/api/cron/daily`)
   closes the previous calendar month once:
   - **"Approve at the month's close"** is on by default (owner, 29 Oct 2026): that month's earned
     commission is approved first, so no admin approval is needed before the payout. Switched off,
     only what an admin approved goes in. Commission above the per-shop cap and commission on hold
     are never included, either way.
   - One **draft payout per dealer**: every approved entry up to the end of the month (anything
     approved late from earlier months included), netted with reversals not yet settled. A dealer who
     owes money back (net ≤ 0) gets no payout; the amount is carried to the next month.
   - Each dealer is sent their **statement** in the app and by email.
   A missed run (site down on the 5th) catches up on the next daily run in that month. The month
   cannot be closed twice (`dealer_commission_months`).
3. **Paying.** An admin makes the bank transfers and records each UTR (Admin → Dealers → Commission →
   Ledger & payouts → Mark paid). The dealer is told "Commission paid: ₹X (bank reference …)". Money
   never moves automatically. A cancelled draft's entries go into the next month's payout.
4. **Close early.** An admin can close last month before the payout day ("Close <month> now").
5. **Settings** (admin, audited with a reason): payout day 1–28 (default 5) and approval at the close
   (default on).

## The dealer's statement

On the dealer page (`/dealer`, "Monthly statements"; the notice links to `/dealer?statement=YYYY-MM`)
and as CSV (`/api/dealer/commission/statement?month=YYYY-MM`):

- shops registered that month (date, shop, shop ID, PIN, employee, counted or reversed, shop status);
- shops activated; commission earned; awaiting approval; on hold; above the cap; reversed;
- the month's payout (status, amount, UTR once paid) and the entries in it;
- the amount owed back and carried forward, if any.

The current month is shown "so far". A dealer sees only their own statement.

## Data

Migration 0115 (`-- split: seller`, rollback `scripts/rollback-0115.sql`):
`dealer_commission_settings.payout_day_of_month` / `auto_approve_at_month_end`,
`dealer_payout_batches.period_month` (and `created_by` nullable — the job has no admin),
`dealer_commission_months`. (Renumbered from 0113: staging took 0113 for the onboarding wizard and 0114 for the all-India states.)

## For the owner to decide

- ~~Should approval at the month's close be on?~~ Decided 29 Oct 2026: **on**. Earned commission is
  approved automatically at the close; an admin still checks the drafts and makes the bank transfer.
- ⚖ CA: **TDS u/s 194H** on commission (deduct, deposit, Form 16A) and **GST** on the dealer's invoice
  for the commission (registered dealers invoice GoKesari). Not handled: the statement shows gross
  commission. The payout amount should become net of TDS once the CA confirms the rate and threshold.
- Which bank transfer method the finance team uses (bulk upload file from the drafts could be added).

## Tests

`tests/integration/dealer-monthly-payout.test.ts` — on both database layouts.
