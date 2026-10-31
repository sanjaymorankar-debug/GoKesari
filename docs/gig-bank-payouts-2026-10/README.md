# Rider bank account, withdrawals and monthly payout (Oct 2026)

Brief: bank account integration for gig workers (customers and delivery
partners). Audit first: [FINDINGS.md](FINDINGS.md). Branch
`feat/gig-bank-payouts`, migration `0123_rider_bank_payouts`.

## Owner decisions (31 Oct 2026)

| Question | Decision |
|---|---|
| Customer wallet → bank | **No.** Riders only. The customer wallet stays a closed prepaid wallet (published wallet terms, RBI PPI rules); customers keep the existing refund-to-bank path. |
| Weekly vs monthly | **Both.** Weekly rider batches carry on unchanged; the 5th pays whatever is still unpaid for the previous month. |
| Limits and fee | Withdrawal ₹100–₹10,000 each, ₹10,000 a day, **no fee**. Monthly minimum ₹100 (less is carried forward). 3 retries, then finance. |
| TDS | s.194C: 1% (20% without PAN) once a rider's payments in the financial year pass ₹1,00,000 — on the year's total, less TDS already deducted — or on a single payment above ₹30,000. |

All values are rule `riderPayouts` (Admin → Settings), so finance can change
them without a release. Any other money number needs the owner.

## What reuses what

- **Bank account** — the user's personal `bank_accounts` row (the one customers
  already add for refunds): one primary account per user whatever their roles,
  encrypted, last 4 digits only, ₹1 / bank-check verification, all existing.
  New: a delivery partner's **verified** account changes or is removed only
  after an emailed code (`/api/gig/bank-account/reauth`, 10-minute single-use
  grant). Customers are never asked.
- **Paying** — each payment is a `rider_payouts` row (the weekly lifecycle,
  finance ledger `RIDER_PAYOUT`/`REVERSAL`) that claims the rider's unpaid
  `delivery_partner_earnings` and pending rider `financial_adjustments` exactly
  as the weekly batch does, so nothing is paid twice. One `rider_bank_transfers`
  row carries the bank transfer.
- **Bank transfer** — the existing payout provider contract (`src/server/payouts`):
  SANDBOX (never on gokesari.com), Cashfree Payouts, RazorpayX; their signed
  webhooks arrive on the existing `/api/webhooks/payouts/[provider]`.
- **Codes** — the existing OTP service (new purposes `RIDER_BANK_CHANGE`,
  `RIDER_WITHDRAWAL`), sent to the account's email.
- **Mobile apps** — the Android and iPhone apps show the website (`mobile/`),
  so the new screens and notifications are in both apps with no store build.

## Flows

**Withdrawal** (`/gig/wallet`, flags `rider_bank_account_enabled` + `rider_withdrawal_enabled`):
amount → quote (fee, TDS, net, account, "usually within 30 minutes (IMPS)") →
emailed code → the claim commits (shown as "on its way") → provider call outside
the transaction, idempotency key per attempt → webhook: **paid** (UTR, payout
PAID, ledger) or **refused** (claim released at once: payout CANCELLED,
earnings unpaid again, rider told). Provider unreachable = outcome unknown: not
retried or released blind; it waits for finance. A partial withdrawal carries
the rest forward as a −rest / +rest pair of rider adjustments.

**Monthly payout** (flag `rider_monthly_payout_enabled`): the hourly cron
(`rider-monthly-payout`, runs at :17) acts on the 5th from 09:00 IST (a missed
day catches up later in the month). Per rider: APPROVED + verified account +
≥ ₹100 unpaid from before the month's end → NEFT payment; otherwise carried
forward with a notification (KYC_INCOMPLETE / BANK_NOT_VERIFIED /
BELOW_MINIMUM). `rider_payout_runs` has one row per month (its id is the batch
id): a re-run reports "already paid"; a stopped run is resumed (unique index
run + rider; unsent transfers sent). Failed transfers retry 3 times (60, 120,
180 min), then **needs a decision** in Admin → Rider payouts: Retry or Return to
balance.

**Admin → Rider payouts** (`/admin/rider-payouts`, FINANCE_VIEW; actions
FINANCE_PREPARE, "Run now" ADMIN): transfers needing a decision, monthly runs
(batch id, status, paid / riders, failed, carried, gross, TDS, net), each run's
payments and who was carried forward, recent withdrawals.

## Flags (all seeded OFF)

| Flag | Turns on |
|---|---|
| `rider_bank_account_enabled` | `/gig/wallet`, the re-auth rule on a rider's verified account, admin page and menu |
| `rider_withdrawal_enabled` | withdrawals (needs the one above) |
| `rider_monthly_payout_enabled` | the monthly run on the 5th |

With all three off, every new route answers 404 and nothing existing behaves
differently (tested).

## Migration and rollback

- `drizzle/0123_rider_bank_payouts.sql` (`-- split: core`): four new tables
  (`rider_payout_runs`, `rider_bank_transfers`, `rider_transfer_events`,
  `rider_security_grants`) and three flag rows. Additive only, idempotent, no
  foreign key to a seller table.
- Applies through the usual "Test database" workflow on a push to `staging`,
  and "Production database" by hand before merging to `main`.
- Rollback: `scripts/rollback-0123.sql` (flags off and the previous code live
  first; it refuses nothing by itself, so run its in-flight check query first).
- Renumbered 0121 → 0123 on 31 Oct 2026: the gig-worker flow (#306) and the app-install prompt (#307) merged into `staging` first with 0121 and 0122.

## Changes to existing files (and why)

| File | Change | Why |
|---|---|---|
| `src/server/db/schema.ts` | +3 flag keys; +2 OTP purposes in the `login_otps.purpose` type; new tables appended at the end | new tables / flags (TS types only for the enums: the columns are plain text) |
| `src/server/db/split/ownership.ts` | +4 table entries (platform) | required by the split rule |
| `drizzle/meta/_journal.json` | +1 entry | migration registry |
| `src/server/services/feature-flags.ts`, `src/components/feature-flags-panel.tsx` | labels / hints / type union for the 3 flags | the admin flag screen lists every key |
| `src/server/config/rules.ts` | new rule group `riderPayouts` | limits, schedule, TDS, provider |
| `src/server/otp/service.ts` | +2 purposes, +2 exported functions | emailed codes for bank change and withdrawals |
| `src/server/services/audit.ts` | +5 audit actions | audit trail |
| `src/server/notifications/types.ts`, `templates.ts` | +4 types and templates | rider notifications |
| `src/server/payouts/batches.ts` (1 line) | a webhook with no shop payout item is handed to the rider transfer handler | one webhook URL per provider |
| `src/server/cron/schedule.ts` | +1 hourly job | the 5th 09:00 IST run and retries |
| `src/app/api/bank-account/route.ts` (2 lines) | `consumeBankChangeGrant` before saving | re-auth for a rider's verified account (no-op otherwise) |
| `src/app/gig/profile/page.tsx` | "My wallet" button while the flag is on | entry point |
| `src/lib/board/menus.ts` (1 line) | Admin → Finance → Rider payouts, behind the flag | entry point |
| `docs/cron-schedule.md` | the new job | schedule reference |

## Open points

- Production payouts need the **Cashfree Payouts** (or RazorpayX) keys and
  rule `riderPayouts.provider` set; until then production cannot send rider
  transfers (the sandbox never runs on gokesari.com) and withdrawals show "not
  available".
- TDS: the CA should confirm s.194C (vs s.194-O) for riders, the threshold
  treatment, the quarterly 26Q filing and Form 16A — the code records TDS per
  payment (`rider_bank_transfers.tds_paise`) but does not file it. Weekly
  batches finance pays by hand deduct no TDS; the next withdrawal or monthly
  payment catches up the year's TDS.
- Code on Social Security 2020 aggregator contribution (1–2% of turnover) is
  not part of this change.
- "KYC complete" means the partner is APPROVED; tighten `kycComplete()` when
  the new rider KYC (PAN / Aadhaar) lands.
