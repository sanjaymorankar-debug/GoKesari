# Module 7 — Self-service account deletion (23-Nov-2026)

Owner brief 23-Nov-2026, Module 7. Branch `feat/m7-account-deletion`, migration **0183**,
feature flag **`account_self_deletion_enabled` (seeded OFF)**.

## What existed before

- `users.status` already had the value `DELETED` and `users.deleted_at` existed, but nothing ever wrote them.
- `getCurrentUser` refuses any non-ACTIVE account, and every request re-reads the account row
  (`auth-sessions.ts readSession`, `auth.ts` callbacks).
- Per-session sign-out (`revokeSession`, `revoked_sessions`).
- The OTP service (`src/server/otp/service.ts`): hashed codes, expiry, attempt cap, cooldown, per-email /
  per-account / per-IP limits, audit. `requestAccountActionOtp` / `verifyAccountActionOtp` (rider bank change).
- Shop closure (`services/shop-closure.ts`), wallet + refunds to bank (`bank-refunds.ts`), `cancelSubscription`.
- Health's `data_requests` (not changed).

Nothing let a normal customer delete their own account.

## What this module adds

| Requirement | Status |
|---|---|
| 1. Table `account_deletion_requests` | DEVELOPED (0183) |
| 2. Service `src/server/services/account-deletion.ts` (precheck, code, delete, admin list) | DEVELOPED |
| 3. APIs `GET/POST /api/profile/delete`, `POST /api/profile/delete/code` | DEVELOPED |
| 4. UI: My Profile section + `/profile/delete` page | DEVELOPED |
| 5. Admin read-only list | DEVELOPED (`/admin/consents/account-deletions`) |
| 6. Deleted email cannot sign in silently; original email can register fresh | DEVELOPED + documented below |
| Flag OFF = today's behaviour | DEVELOPED |

### How it works

1. **Checks** (`deletionPrecheck`). Blockers, each with a link to where it is sorted out:
   - role is not CUSTOMER / SHOP_OWNER / DELIVERY_PARTNER (staff, dealer, society admin → closed by an admin);
   - no real email (mobile-only placeholder account) — the code cannot be sent;
   - orders not yet delivered / refunded (`OPEN_ORDER_STATUSES` + `REFUND_PENDING`, `DISPUTED`; unpaid `PENDING`
     does not block);
   - the customer's **own** wallet money > 0 (balance minus promotional credit) → "refund it to your bank from
     the wallet page" (`/wallet`, the existing refunds-to-bank flow). Promotional credit alone does not block;
     the page says it lapses;
   - a refund to bank still REQUESTED / PROCESSING;
   - returns or disputes still open;
   - owns a shop that is not closed (INACTIVE) or rejected → close it permanently first (`/shop/manage/hours`);
   - active shop staff membership → ask the owner to remove you;
   - rider: a delivery in progress (ACCEPTED / PICKED_UP), earnings not yet in a payout, or a payout
     PENDING / ELIGIBLE / PROCESSING / FAILED.
   Live **subscriptions do not block**: the page says they will be cancelled, and they are.
2. **Code** (`requestAccountDeletionCode`): re-runs the checks (a refusal is stored as a BLOCKED request and
   audited `account.deletion_blocked`), then emails a code with OTP purpose **ACCOUNT_DELETE** to the account's
   own address through the existing OTP provider, under the existing OTP rules (cooldown, window, per-account
   and per-IP limits in the database, plus per-IP / per-account limits on the route). A REQUESTED row is
   written (one open row per person; a resend refreshes it) and audited `account.deletion_requested`.
3. **Delete** (`deleteAccount`): the typed word must be `DELETE`; the code is verified (bound to the user);
   the checks run again; live subscriptions are cancelled through the normal `cancelSubscription` (its own
   audit, event, notification). Then **one transaction**: the account row is locked `FOR UPDATE`, the checks
   run a third time inside the transaction, any subscription still live is cancelled, and:
   - `users`: name, phone, phoneE164, phoneVerifiedAt, image, gender, emailVerified → null;
     email → `deleted+<id>@deleted.invalid` (column is NOT NULL + unique); emailPlaceholder true;
     status `DELETED`; deletedAt now;
   - `addresses`: soft-deleted and stripped (line1 `[deleted]`, recipient, phone, line2, area, landmark,
     instructions, coordinates removed; city / PIN kept because the columns are NOT NULL);
   - `push_tokens`: deleted;
   - the customer's own `bank_accounts` (shop_id NULL): deleted, except one a bank refund or rider transfer
     points at — that one is retired (isCurrent false), because the payment record must stay;
   - `delivery_partners`: status DEACTIVATED (stops getting work; KYC and earnings kept);
   - the request row → COMPLETED (with the optional reason); audit `account.deleted` in the same transaction.
   After commit: an online rider is set offline, and a completion email goes to the **original** address.
4. **Sessions**: `readSession` now drops any session whose account is DELETED, so every device is signed out on
   its next request. The "account deleted" screen's button signs the browser out (which also lists that session
   in `revoked_sessions`).

### What is kept (legal retention) — not touched

`orders` (and their address snapshots), `order_items`, invoices / platform invoices / billing documents,
`payments`, `payment_intents`, refunds, `wallets` and `wallet_transactions`, `bank_refund_requests`,
ledgers and accounting entries, TDS / TCS / GST records, `return_requests`, `order_disputes`, `grievances`,
rider `delivery_partner_earnings`, `rider_payouts`, `rider_bank_transfers`, rider KYC / documents,
shop records (`shops`, settlements, shop wallets, shop bank accounts), `audit_logs`, `user_consents`
(kept as history), `login_otps` (purged by the existing housekeeping job) and `account_deletion_requests`.
Reasons: GST Act s.36 / CGST Rule 56 (books, 72 months), Income-tax Act (TDS 194C records), RBI / PA-PG
payment records, Consumer Protection (E-Commerce) Rules. These rows keep the user id but no longer resolve to
a name, email or phone.

### Signing in again with the same email (requirement 6)

- The deleted row's email is `deleted+<id>@deleted.invalid`, so the original address is free and the unique
  index cannot collide. Sign-in looks accounts up by email with `deleted_at IS NULL`
  (`findLiveUserByEmail`); Google sign-in (`auth.ts signIn`) also looks up by email.
- So the original email **cannot reach the deleted account**: it signs up as a **brand-new, empty account**,
  and like any new account must tick the Terms box (`TERMS_REQUIRED`). Nothing from the old account (orders,
  wallet, addresses) is linked to it. The phone number is released too (set to null).
- A session issued before the deletion stops working on its next request (`readSession`).

## Files

- `drizzle/0183_account_self_deletion.sql`, `drizzle/meta/_journal.json`, `scripts/rollback-0183.sql`
- `src/server/db/schema.ts` — `accountDeletionRequests`, `ACCOUNT_DELETION_STATUSES`, flag key, OTP purpose
- `src/server/services/account-deletion.ts` (new)
- `src/server/services/feature-flags.ts`, `src/components/feature-flags-panel.tsx` — flag label / hint / type
- `src/server/services/audit.ts` — `ACCOUNT_DELETION_REQUESTED`, `ACCOUNT_DELETION_BLOCKED`, `ACCOUNT_DELETED`
- `src/server/otp/service.ts` — purpose `ACCOUNT_DELETE` for the account-action code
- `src/server/auth-sessions.ts` — a DELETED account's sessions are dropped
- `src/app/api/profile/delete/route.ts`, `src/app/api/profile/delete/code/route.ts` (new)
- `src/app/profile/page.tsx` (section, flag-gated), `src/app/profile/delete/page.tsx`,
  `src/components/account-deletion-flow.tsx` (new)
- `src/app/admin/consents/page.tsx` (link, flag-gated), `src/app/admin/consents/account-deletions/page.tsx` (new)
- `tests/unit/account-deletion.test.ts`, `tests/integration/account-deletion.test.ts` (new)

## Migration 0183

Additive and safe to re-run: new table `account_deletion_requests` (no FK to users, so it survives as the record
of honoured requests), two indexes, a status CHECK, and the flag row OFF. `login_otps.purpose` is plain text,
so the new value needs no DB change. Rollback: `scripts/rollback-0183.sql` (accounts already deleted stay
anonymised — that cannot be undone).

## Flag

`account_self_deletion_enabled` — OFF: no section on My Profile, `/profile/delete` is 404, the three APIs answer
404, no link on Admin → Consent record. The admin list page itself is reachable by URL (read-only,
CONSENT_VIEW) so past requests stay visible if the flag is turned off again.

## API

- `GET /api/profile/delete` → `{ precheck: { canDelete, blockers[], subscriptionsToCancel, promotionalForfeitPaise, maskedEmail }, latestRequest }`
- `POST /api/profile/delete/code` → `{ maskedEmail, resendAfterSeconds, expiryMinutes, requestId }`; 409 with `details.blockers` when blocked
- `POST /api/profile/delete` `{ code, confirmText: "DELETE", reason? }` → `{ deleted: true, requestId, subscriptionsCancelled }`; 422 wrong word / code; 409 with blockers

All require a signed-in ACTIVE user (`requireUser`); a user can only act on their own account.

## Tests

- `tests/unit/account-deletion.test.ts` — 15 tests: every blocker, promotional credit, roles, placeholder email,
  subscriptions, anonymisation patch, flag OFF (service + all three APIs 404), typed word, sign-in required. Pass.
- `tests/integration/account-deletion.test.ts` — real PostgreSQL: full delete (anonymised row, addresses, push
  tokens, request COMPLETED, audits, sessions dropped, completion email to the old address, the old email
  signing up as a new account), wrong word / wrong code, wallet blocker. **Not run locally** (no
  `TEST_DATABASE_URL` / PostgreSQL on this Mac); runs in CI.

## Still open / for the owner

- Customer-facing text on the new page is English only (the surrounding My Profile screen is English).
- Shop owners: a shop must be closed first; the closed shop's wallet / settlements / bank account are kept and
  settled as usual. Shop delivery staff (`shop_delivery_staff`) are not checked.
- Rider KYC documents and the rider profile's personal fields are kept (tax / KYC retention); only the account
  is anonymised and the rider profile deactivated. Owner to confirm the retention period.
- No scheduled purge of retained records after their legal period — a later job.
- No "undo" window: deletion is immediate once confirmed (the brief did not ask for a cooling-off period).
