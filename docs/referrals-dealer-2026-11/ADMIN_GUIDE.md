# Admin guide — dealer network, shop referrals, payouts, TDS

03-Nov-2026. Owner view: [OWNER_GUIDE.md](OWNER_GUIDE.md). TIERED details: [TIERED_COMMISSION.md](../dealer-programme/TIERED_COMMISSION.md).
Switch everything on **test.gokesari.com first**. Every change asks for a reason and is audited.

## 1. Rules (Admin → Settings)

| Rule | Field | Default | Meaning |
|---|---|---|---|
| `dealerTieredCommission` | `enabled` | false | TIERED model available; see TIERED_COMMISSION.md for every value |
| `shopReferrals` | `enabled`, modes and amounts | false, DISCOUNT 10%, WALLET_CREDIT ₹200, 20 a year | Shop-refers-shop rewards (not `shopReferral`, the operator-issued codes) |
| `dealerPayouts` | `enforcePayeeChecks` | false | On: a **dealer** is paid only with PAN + verified bank (+ agreement on TIERED). Team members are always checked |
| | `minPayoutPaise` | 0 | Below it the month is carried forward |
| | `reminderEnabled` | true | Held payees are told at the month's close what to add |
| `dealerAutoPayout` | `enabled`, `provider`, `mode`, `maxRetries`, `retryBackoffMinutes` | false, SANDBOX, IMPS, 3, 60 | Automatic bank transfer after approval |
| `dealerPayoutTds` | `enabled` | false | TDS by the dated rows (Admin → TDS on commission) |
| `customerReferrals` | as before | — | Customer referrals (Part 0) |

## 2. Dealer network (Admin → Dealers → Commission → TIERED model)

Choose the dealer → *Move this dealer to TIERED* → build the team (*Add member*, role and lead) →
*Link account* (their email) → PAN / bank (*Mark bank verified*) → each accepts the agent agreement.

* **Team mapping**: per person registered / activated / trading / active 30 days and commission;
  filter by role; *Download CSV* (mobiles masked); *Shops* drills into a person's shops;
  *Mapping history* shows every move with date and reason.
* Commission follows the team **as it was on the shop's registration date**: moving an agent
  changes only shops registered afterwards.
* *Promote to team lead* (10 activated shops, or *Promote anyway* with a reason). Sub-agent requests
  are approved or declined here.

## 3. Payouts (Admin → Dealers → Commission → Ledger & payouts)

1. On the 5th the month closes: target bonuses, auto-approval, **one draft per PAN**. Held and
   below-minimum payees are listed in the *Pending payees* report.
2. **Approve** (an admin other than the one who drafted it; the monthly job counts as the drafter).
   With `dealerAutoPayout` on, it goes to the bank at once; the UTR comes back by webhook.
3. Without automatic payout: download the **Bank file**, pay, then *Mark paid* with the UTR.
4. **Failed transfers** are retried automatically, then flagged *needs review*: *Retry transfer*, pay
   by hand, or cancel.
5. Reports: *Payout summary*, *Ledger lines*, *Pending payees*, *Failed transfers* — CSV or XLSX.

## 4. TDS (Admin → TDS on commission, also the CA)

While `dealerPayoutTds` is on, a payout taxed under a row the CA has not confirmed shows
*TDS: unconfirmed rate* and cannot be approved or paid. Ask the CA to confirm the row, or use
*Override (admin)* in Exceptions with a reason (kept on the payout).

## 5. Shop referrals (Admin → Shop-refers-shop rewards)

Every referral with its outcome; *Reverse reward* takes back the unspent promotional credit (never
the shop's own money) or the membership extension.

## 6. Customer referrals (Admin → Customer referrals)

Now open to anyone with the wallet-adjust permission (as the reversal API). A reversal takes back
only unspent promotional credit and flags both customers (Admin → Risk, rule REFERRAL_REVERSED).

## 7. Rollback

Rules off first. Migrations 0136–0142 each have `scripts/rollback-01NN.sql` with the checks to run
before them (paid entries, challans and Form 16A are records — export first).
