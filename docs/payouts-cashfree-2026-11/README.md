# Payouts: Cashfree adapter status lookup, webhook matching and reconcile (23-Nov-2026)

Covers shop payouts (`src/server/payouts/batches.ts`), rider bank transfers
(`src/server/rider-wallet/transfers.ts`) and dealer commission payouts
(`src/server/dealers/auto-payout.ts`). No rule or flag is switched on by this
change; the defaults stay `payouts.provider = BANK_FILE`,
`riderPayouts.provider = SANDBOX` and `dealerAutoPayout` off.

## What changed

| Area | Change |
|---|---|
| Adapter (`providers/cashfree.ts`) | `getTransfer()` status lookup; name and remarks cleaned to Cashfree's character sets; IFSC uppercased; amount in rupees with 2 decimals; every V2 status mapped (incl. `MANUALLY_REJECTED`, `REVERSED`); HTTP 429 sent again with the same transfer id; a duplicate transfer id reads the existing transfer; optional 2FA header `X-Cf-Signature` (`CASHFREE_PAYOUT_PUBLIC_KEY`); webhooks older than 5 minutes refused; account notices get ids of their own; `LOW_BALANCE_ALERT` alerts administrators. |
| Transfer ids (migration 0185) | `provider_transfer_id` on `payout_items`, `rider_bank_transfers`, `dealer_payout_batches` (and `dealer_payout_batches.sent_at`), saved when an attempt is claimed, before the request is sent. Webhooks and the reconcile job look rows up by it. |
| Webhooks (`handlePayoutWebhook`) | An event is matched first (shop item, rider transfer, dealer payout), applied, and only then recorded in `payout_events`. An event that matches nothing yet is kept in `payout_webhook_parked` and answered 409 so the provider delivers it again. |
| Reconcile (`payouts/reconcile.ts`, hourly job `payout-reconcile`) | Rows in progress for more than 30 minutes, or waiting for finance, are looked up with the provider and settled through the same outcome code as webhooks. If the provider has no transfer with that id, the same attempt is sent again with the same id. Parked webhooks are replayed for 3 days. |
| Guard (`payouts/guard.ts`) | `CASHFREE` cannot be saved in `payouts`, `riderPayouts` or `dealerAutoPayout`, and no send path uses it, until `CASHFREE_PAYOUTS_CONTRACT_VERIFIED=true` is set on that site. |
| Definite refusals | A provider's definite refusal (4xx) now fails a rider withdrawal or dealer payout straight away instead of waiting for review; a provider's later definite answer also settles a transfer whose outcome was unknown. |

## Environment

| Variable | Where | Purpose |
|---|---|---|
| `CASHFREE_PAYOUT_CLIENT_ID`, `CASHFREE_PAYOUT_CLIENT_SECRET` | each site | Cashfree **Payouts** keys (separate from the payment-gateway keys) |
| `CASHFREE_PAYOUT_ENV` | each site | `sandbox` on test.gokesari.com, `production` on gokesari.com |
| `CASHFREE_PAYOUT_PUBLIC_KEY` | optional | 2FA public key (PEM; one line with `\n` accepted) — instead of IP allow-listing |
| `CASHFREE_PAYOUTS_CONTRACT_VERIFIED` | each site | `true` only after the sandbox contract run (and, for production, the ₹1 live test) |

Webhook URL to register in Cashfree Payouts (V2): `https://<site>/api/webhooks/payouts/cashfree`.

## Tests

- `tests/contract/cashfree-payouts/adapter.test.ts` — body, headers, status map, transfer ids, signature (valid / tampered / stale), each webhook type. No network.
- `tests/contract/cashfree-payouts/flows.test.ts`, `rider-dealer-flows.test.ts` — real database, Cashfree stubbed: early webhook, redelivered unmatched event, reconcile of an unknown outcome, resend with the same id, the guard.
- `tests/contract/cashfree-payouts/live.test.ts` — live against Cashfree's sandbox; skipped unless `CASHFREE_PAYOUTS_LIVE=1`. Run by `.github/workflows/cashfree-payouts-sandbox.yml` (by hand and every Monday) with the repository secrets `CF_PAYOUT_SANDBOX_CLIENT_ID`, `CF_PAYOUT_SANDBOX_SECRET` and `CF_PAYOUT_SANDBOX_PUBLIC_KEY`. Its requests and responses are uploaded as the run's artifact.

## Switching on (owner's decision, in this order)

1. Staging: sandbox Payouts keys and webhook URL on test.gokesari.com; run the sandbox workflow; set `CASHFREE_PAYOUTS_CONTRACT_VERIFIED=true` there; then riders, shops, dealers one at a time.
2. Production: production Payouts keys, webhook URL, IP allow-list or 2FA key, funded account; `CASHFREE_PAYOUTS_CONTRACT_VERIFIED=true`; a ₹1 test transfer; then the rules, one at a time.

Rollback: switch the rule back (no deploy). Keep the keys until every open transfer has a final status — the webhook answers 503 without them.
