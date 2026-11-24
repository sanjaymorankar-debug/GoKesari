# Payout deductions (migration 0187, flag `payout_deductions`)

With the flag on, every payout path withholds its statutory deductions. The rates come from the tax register: the Accountant proposes them and the CA approves.

| Payout | Deduction | Rate from | Where it shows |
|---|---|---|---|
| Shops — orders | TCS s.52, TDS s.194-O | statutory rows `GST_TCS_SEC52`, `IT_TDS_194O` | Payout cycle lines (as before) |
| Shops — service earnings (appointments `consult:`, rentals `healthrent:`, prescriptions `healthrx:`) | TDS s.194-O on the gross; TCS only if the TCS row has `params.applyToServices = true` | same rows | Payout cycle lines `TDS` / `TCS` with `meta.service = true` |
| Shops — weekly settlement | — | — | Refused while the flag is on: shops are paid through the payout cycle (rule `payouts`) |
| Riders — weekly payout | TDS s.194C (catch-up over the financial year, counting transfers too) | rule `riderPayouts` (tds fields) | `rider_payouts.tds_paise` / `tds_rate_bp`; `amount_paise` is what is paid; Admin → Finance |
| Riders — withdrawals / monthly transfers | TDS s.194C (unchanged) | rule `riderPayouts` | transfer statement |
| Referral commissions | TDS s.194H when marked PAID (year's commissions to the same payee count; PAN from the payee's dealer record) | statutory row `IT_TDS_194H` (added **disabled**) | `referral_commissions.tds_paise` / `tds_rate_bp` / `net_paise` |
| Dealer / team / franchise commission | TDS (unchanged) | TDS on commission rows | dealer statements |

The calculator is shared: `computeTds` in `rider-wallet/rules.ts`. It works over the financial year: once payments pass the annual threshold, TDS is due on the whole year less what was already deducted; a single payment above the single-payment threshold is taxed on its own.

## CA approval

On gokesari.com, a payment whose rate the CA has not approved is **held**: it is not prepared, and the error says why.
- **Rider payouts:** all of `rule:riderPayouts.tds*` must be approved in the register.
- **Referral payouts:** the `IT_TDS_194H` row must be CA-confirmed.

On test.gokesari.com these payments go ahead, so QA can run.

## New statutory rows

`IT_TDS_194H` and `IT_TDS_194J` are added with effect from 1 Apr 2026. Both are **disabled** and not confirmed. The CA confirms or changes them through the tax register (a new row, or "approve current values" after enabling).

## Switch-on

1. The CA approves the rates in the register.
2. Turn on rule `payouts` (payout cycle) for shops.
3. Turn on flag `payout_deductions`.

Rollback: `scripts/rollback-0187.sql`.
