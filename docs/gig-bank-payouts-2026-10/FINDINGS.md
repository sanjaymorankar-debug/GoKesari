# Bank accounts, withdrawals and monthly payouts for gig workers — codebase audit

31 Oct 2026. Audit done before any code is written, as the brief asks.
Scope: customers and delivery partners (riders). Shops are out of scope except
where their code can be reused.

## What already exists (reuse, do not rebuild)

| Area | Where | What it does today | Use for this work |
|---|---|---|---|
| Bank account record | `bank_accounts` (migration 0063), `src/server/services/bank-accounts.ts`, `src/lib/bank-accounts.ts` | Holder name, account number + IFSC, or UPI ID. Account number / UPI ID encrypted (AES-256-GCM, `PAN_ENCRYPTION_KEY`), last 4 kept in clear, screens mask. One **current** account per customer and per shop (partial unique indexes); a change writes a new row and needs a fresh verification. Holder types: `CUSTOMER`, `SHOP` only. | Reuse as is. Add holder type `DELIVERY_PARTNER` (the column is plain `text`, no DB check on the value, so this is a code-only, additive change plus one partial unique index). |
| Verification | `bank-accounts.ts` (₹1 payment through Cashfree PG, refunded; payer name matched), `bank-account-check.ts` (Cashfree Verification "BAV" name + account check, penny-less) | Status `PENDING → VERIFIED / FAILED`; name-match score; simulator off production. | Reuse both for riders. Satisfies "verify before active". |
| Customer refunds to bank | `bank-refunds.ts`, `/admin/bank-refunds` | Wallet money that came from a **refund** (not top-ups, not promotional credit) can go to the customer's verified bank account within a window, finance approves. | This is the only legal "wallet → bank" path for customers today (see blocker 1). |
| Customer paying from a bank | Cashfree PG checkout (UPI, net banking, cards) | Customers already pay from their bank through the gateway. | Nothing to build; "link a bank to pay from it" is the checkout. |
| Customer wallet | `wallets`, `wallet_transactions`, `wallet.ts` | Closed-system prepaid ledger, immutable, balance ≥ 0, promotional slice tracked. Statuses on the ledger. | Untouched. |
| Rider bank details | `delivery_partners.bank_*_encrypted`, `delivery-partner-kyc.ts` | Collected at rider registration, encrypted, **never verified, never read** (no reveal path). | Seed for a rider's first `bank_accounts` row (prefill), then verify. |
| Rider KYC | `delivery_partners` status / KYC fields, `delivery-partner-kyc.ts`, `delivery-eligibility.ts` | Approval flow with documents. | Eligibility "KYC complete" = approved partner. |
| Rider earnings | `delivery_partner_earnings`, `rider_earnings_ledger`, `delivery-earnings.ts` | One earning per delivery, itemised ledger, idempotent per delivery. | Source of what each rider is owed. |
| Rider payouts | `rider_payouts`, `finance.ts` `prepareRiderPayouts` + batch actions, `/api/finance/rider-payouts`, cron `finance-weekly` (Mondays) | **Weekly** batch per rider, finance approves and marks paid by hand. No bank transfer, no retries. | Monthly run builds on these rows (same lifecycle) — see decision 2. |
| Bank transfers | `src/server/payouts/` (providers SANDBOX, Cashfree Payouts V2, RazorpayX scaffold, BANK_FILE), `/api/webhooks/payouts/[provider]`, `payout_items`, `payout_events` | Shop payouts: idempotency key per attempt, webhooks, UTRs, retry with backoff, failure → manual. | Reuse the provider contract and retry/webhook pattern for rider transfers and withdrawals. |
| Monthly job on the 5th | cron `dealer-monthly-payout` (docs/dealer-programme) | Closes the previous month once, idempotent, on payout day (default the 5th). | Copy the pattern. |
| Scheduling | `docs/cron-schedule.md`: `/api/cron/daily` at 05:00 IST, `/api/cron/hourly` | All jobs run from two endpoints. | 09:00 IST on the 5th = hourly job, acting only in the 09:00 IST hour of the 5th. |
| OTP | `src/server/otp/service.ts` (emailed codes with purposes) | Sign-in, email change, onboarding. | New purposes `BANK_ACCOUNT_CHANGE`, `WITHDRAWAL`. |
| Feature flags | `feature_flags`, `feature-flags.ts`, `requireFeature` | Seeded OFF, read live, admin-only, audited. | New flags, all OFF. |
| Admin payout views | `/admin/payouts`, `/admin/finance`, `/admin/bank-accounts` | Batches, items, failures for shops. | Add a "Rider payouts (monthly)" view alongside. |
| Mobile apps | `mobile/` (Expo, Android + iOS) | WebView of the site: every web page and push notification is already in both apps; no store build needed for new pages. | New screens are web pages; check them in the apps (no native change expected). |

## Gaps (what has to be built)

1. Riders cannot hold a `bank_accounts` row (holder type) → add `DELIVERY_PARTNER`, screens under `/gig`.
2. OTP / re-authentication before changing a bank account → not there today for any role.
3. Rider earnings → bank transfer: today only manual, weekly. Needs provider transfers, statuses, retries, manual-review flag.
4. Rider "withdraw now" (earnings → bank on demand): not there.
5. Monthly payout on the 5th for riders with eligibility, carry-forward, batch id, retry count, admin view, notification + statement.
6. Feature flags for all of the above.

## Blockers / owner decisions (asked before building)

Answered by the owner on 31 Oct 2026 — see [README.md](README.md#owner-decisions-31-oct-2026):
riders only, weekly + monthly, ₹100–₹10,000 no fee, TDS s.194C. Items 5–6 stay open.

1. **Customer wallet cash-out.** The wallet terms published on the site
   (`/legal/wallet-terms`) say the wallet "cannot be withdrawn as cash" and
   that cash-out will only come "once the appropriate RBI-regulated payment
   framework is in place". GoKesari's wallet is a closed-system prepaid
   instrument; a wallet you can withdraw to a bank is a semi-closed / open
   PPI that needs RBI authorisation. Building customer wallet → bank as a live
   feature would contradict the published terms and likely the RBI PPI rules.
   For riders the money is **earnings owed**, not a prepaid wallet, so paying
   it to their bank is fine.
2. Rider payout schedule: weekly (today) vs monthly on the 5th vs both.
3. Money limits and fees: withdrawal minimum / maximum, fee, payout minimum
   for the monthly run, retry count.
4. Tax: TDS on rider earnings (194C / 194-O / none), and Code on Social
   Security aggregator contribution.
5. Payout provider for riders on production: Cashfree Payouts keys (the shop
   payouts scaffold needs keys too) or BANK_FILE.
6. Production smoke test with real money: Claude does not move real money;
   the owner runs the ₹1–₹10 production checks.
