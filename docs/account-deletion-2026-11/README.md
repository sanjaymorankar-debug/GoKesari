# Module 7 — Self-service account deletion (23-Nov-2026)

Owner brief 23-Nov-2026, Module 7. Branch `feat/m7-account-deletion`, migration **0191**,
feature flag **`account_self_deletion_enabled` (seeded OFF)**.

> **Changed 23-Nov-2026 (owner) — migration 0199: 90-day cooling-off.** Confirming no longer deletes at once.
> The account is hidden for 3 months (admins see it "Under cooling period until <date>" with the reason), the
> person can restore it by signing in, and the daily job anonymises it afterwards. See
> [Cooling-off period (0199)](#cooling-off-period-0199) and [Retention as per law](#retention-as-per-law).
> Steps 3–4 under "How it works" below describe the anonymisation, which now runs at the end of the period.

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
| 1. Table `account_deletion_requests` | DEVELOPED (0191) |
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

## Cooling-off period (0199)

Owner, 23-Nov-2026: *"There should be 3 months of cooling-off period where the account will be hidden to all but
will be visible to admin with a comment 'under cooling period' for the specific reason."*

| Requirement | Status |
|---|---|
| Confirm → COOLING_OFF, `purge_after` = now + `accountDeletion.coolingOffDays` (90), reason required | DEVELOPED |
| Account hidden (`users.status` = `PENDING_DELETION`), every session signed out | DEVELOPED |
| Restore at sign-in ("Restore my account / Keep deletion") | DEVELOPED |
| Daily purge job, blocker at purge time → BLOCKED + ops alert | DEVELOPED |
| Admin page badge, reason, name/email (admins only), ADMIN cancel with note | DEVELOPED |
| Retention table + rule `accountDeletion.retentionYears` | DEVELOPED (documentation + rule; no purge job) |
| Profile page copy | DEVELOPED (English; the page does not use `tr()`) |

**Confirming** (`deleteAccount`, same checks, code and typed DELETE): the reason is now **required** — one of
`ACCOUNT_DELETION_REASONS` (not using any more, privacy, too many messages, bad experience, another account,
**Other** = own words, at least 3 characters). Then, in one transaction on the locked account row (checks re-run):
live subscriptions cancelled; `users.status` → **`PENDING_DELETION`**; push tokens deleted; a rider profile
DEACTIVATED (its previous status kept in the request's `hidden_state`); the request → **COOLING_OFF** with
`reason_code`, `reason`, `cooling_started_at`, `purge_after`; audit `account.deletion_cooling_off`. After commit:
rider set offline; email "Your GoKesari account will be deleted on <date>" with how to restore.

Why a new status and not SUSPENDED: an admin suspension (`services/users.ts`) and its **reinstate** use SUSPENDED;
a reinstate would silently undo the person's own deletion request. `PENDING_DELETION` is additive (0199).

**Hidden** means:
- signed out on every device (`auth-sessions.ts readSession` drops PENDING_DELETION like DELETED); `getCurrentUser`,
  the Auth.js `signIn` callback (Google) and the OTP ticket provider refuse any non-ACTIVE account, so it cannot
  get a session, call an API or open a page;
- the sign-in code flow emails a code, but `verifyLoginOtp` refuses the account everywhere except the main
  `/signin` page, which shows the restore screen instead of signing in;
- not offered to anyone: rider profile DEACTIVATED + offline (no dispatch, not in rider lists); no push
  notifications; society dashboard members and riders lists skip it (`services/societies.ts`).
  Shop owners must have closed their shop and staff must have been removed before deleting (existing blockers),
  so shop pages and staff lists cannot show them. Ratings show no reviewer names. Not filtered (by design or cost):
  past orders' records seen by the shop that served them (order history is kept as a legal record); admin screens
  (admins should see it); dealer/referral admin lists (admin-only).

**Restore** (`/account/restore`): after a correct code on `/signin` the page sets a 15-minute signed httpOnly
cookie (`gk_account_restore`, path `/account/restore`, HMAC with AUTH_SECRET) and shows *"Your account is
scheduled for deletion on <date>"* with **Restore my account** / **Keep deletion**. Restore → `restoreAccount`:
users ACTIVE, rider profile back to its earlier status (still offline), request **CANCELLED**
(`cancelled_at`, `cancelled_by`, `cancel_note`), audit `account.deletion_restored`, "account restored" email, then
a normal session is opened. Keep deletion → cookie removed, home page. Cancelled subscriptions are not restarted.
Other sign-in screens (shop registration card) answer "This account is scheduled for deletion. To restore it, sign
in on the main Sign in page …". Google sign-in shows the "suspended or closed" note, which now mentions restoring.

**Daily purge** (`cron/schedule.ts` DAILY `account-deletion-purge` → `runDueAccountPurges`, 05:00 IST): every
COOLING_OFF (or purge-time BLOCKED) request with `purge_after <= now`, each in its own transaction with the request
and account rows locked: the checks run again. Clear → subscriptions still live cancelled, `anonymiseInTx`
(the anonymisation in "How it works" step 3), request **COMPLETED**, audit `account.deleted` (system actor);
after commit the completion email to the **original** address. A blocker appeared (e.g. a refund landed in the
wallet, an order was placed by an admin) → request **BLOCKED** with the blockers, audit
`account.deletion_purge_blocked`, one alert email to `SUPER_ADMIN_EMAIL` (first time only), nothing purged, the
account stays hidden; the job retries every day and completes once the blocker is gone, or an admin cancels it.

**Admin** (`/admin/consents/account-deletions`, CONSENT_VIEW): COOLING_OFF rows show the badge
**"Under cooling period until <date>"**, the reason, and — for ADMIN (`USER_SUSPEND`) only — the name and email.
An ADMIN can **Cancel deletion (restore account)** with a required note (server action guarded by
`requirePermission(USER_SUSPEND)`, re-checked in `adminCancelDeletion`); audited as `account.deletion_restored`
with the admin as actor, and the person is emailed. Purge-time BLOCKED rows say "Held at purge time" and can be
cancelled the same way.

**Flag**: still `account_self_deletion_enabled` (OFF). With it OFF nobody can enter the cooling-off period, so the
job and the restore page have nothing to do — the app behaves as before. If the flag is turned OFF while accounts
are hidden, they can still be restored and are still purged when due (a person who asked must not be stuck).
Rule `accountDeletion.coolingOffDays` (1–365, default 90) is editable by admins in the rules screen.

## Retention as per law

Rule `accountDeletion.retentionYears` (per record class, admin-editable, default **8 years**). Records below keep
the user id but no longer resolve to a name, email or phone after the purge.

| Record class (rule key) | Tables | Default | Legal basis |
|---|---|---|---|
| `TAX_GST_INVOICES` | invoices, platform invoices, billing documents, credit notes, GST data | 8 y | CGST Act s.36 / Rule 56: 72 months from the due date of the annual return; Income-tax Act s.44AA + Rule 6F |
| `PAYMENTS_WALLET` | payments, payment_intents, refunds, bank_refund_requests, wallets, wallet_transactions | 8 y | Books of account (s.44AA / Rule 6F); RBI PA-PG directions (payment records) |
| `TDS_TCS_LEDGERS` | TDS (194C, 194-O) / TCS records, ledgers, accounting entries | 8 y | Income-tax Act s.44AA + Rule 6F; reassessment window |
| `RIDER_KYC_TDS` | delivery_partners (personal fields, PAN), rider KYC documents, earnings, payouts, rider_bank_transfers | 8 y | Rider KYC is used for TDS u/s 194C: kept with the TDS records |
| `ORDERS_CONSUMER` | orders (+ address snapshots), order_items, return_requests, order_disputes, grievances | 8 y | Consumer Protection (E-Commerce) Rules 2020; kept with the invoices they support |
| `AUDIT_CONSENT` | audit_logs, user_consents, account_deletion_requests | 8 y | Proof of consent and of the erasure (DPDP Act 2023 s.6 / s.8) |

"8 years" = the longer of Income-tax (books kept 6 years from the end of the relevant assessment year, i.e. about
8 years from the transaction year end, Rule 6F) and GST (72 months from the annual return due date). DPDP Act 2023
s.8(7): personal data must be erased once its purpose is served **unless a law requires retention** — that
exception is what keeps these records; nothing else from them is used after deletion.

Rider personal details and KYC are **kept as per law** after deletion (owner, 23-Nov-2026): the rider profile is
deactivated, the account anonymised, the KYC / PAN / earnings kept for `RIDER_KYC_TDS` years.

**Not built (follow-up, needs owner / legal sign-off):** an automatic purge or anonymisation of these retained
records when their period ends. The rule only records the periods today.

## Files

- `drizzle/0191_account_self_deletion.sql`, `drizzle/meta/_journal.json`, `scripts/rollback-0191.sql`
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
- 0199 cooling-off: `drizzle/0199_account_deletion_cooling_off.sql`, `scripts/rollback-0199.sql`, journal entry;
  `schema.ts` (enum value, request columns); `config/rules.ts` (`accountDeletion`); `services/account-deletion.ts`
  (cooling-off, restore, admin cancel, purge job, restore ticket); `services/audit.ts` (3 actions);
  `cron/schedule.ts` (daily job); `otp/service.ts` (code for a hidden account, `allowPendingDeletion`);
  `auth-sessions.ts`, `auth.ts` (type); `app/signin/page.tsx`; `app/account/restore/page.tsx` (new);
  `app/profile/delete/page.tsx`, `components/account-deletion-flow.tsx` (copy, required reason);
  `app/admin/consents/account-deletions/page.tsx`; `services/societies.ts` (hidden accounts skipped);
  `services/feature-flags.ts` (hint)

## Migration 0199

Additive and safe to re-run: `user_status` gains `PENDING_DELETION`; `account_deletion_requests` gains
`reason_code`, `cooling_started_at`, `purge_after`, `hidden_state` (jsonb), `cancelled_at`, `cancelled_by`,
`cancel_note`, the status CHECK is widened with `COOLING_OFF`, index `(status, purge_after)`. No flag row (the
module's flag is from 0191). Rollback: `scripts/rollback-0199.sql` — hidden accounts back to ACTIVE, their requests
CANCELLED, columns dropped; the enum value stays (PostgreSQL cannot drop one).

## Migration 0191

Additive and safe to re-run: new table `account_deletion_requests` (no FK to users, so it survives as the record
of honoured requests), two indexes, a status CHECK, and the flag row OFF. `login_otps.purpose` is plain text,
so the new value needs no DB change. Rollback: `scripts/rollback-0191.sql` (accounts already deleted stay
anonymised — that cannot be undone).

## Flag

`account_self_deletion_enabled` — OFF: no section on My Profile, `/profile/delete` is 404, the three APIs answer
404, no link on Admin → Consent record. The admin list page itself is reachable by URL (read-only,
CONSENT_VIEW) so past requests stay visible if the flag is turned off again.

## API

- `GET /api/profile/delete` → `{ precheck: { canDelete, blockers[], subscriptionsToCancel, promotionalForfeitPaise, maskedEmail }, latestRequest }`
- `POST /api/profile/delete/code` → `{ maskedEmail, resendAfterSeconds, expiryMinutes, requestId }`; 409 with `details.blockers` when blocked
- `POST /api/profile/delete` `{ code, confirmText: "DELETE", reasonCode, reason? }` → `{ scheduled: true, requestId, purgeAfter, subscriptionsCancelled }` (0199; was `{ deleted: true, … }`); 422 wrong word / code / missing reason; 409 with blockers
- `/account/restore` (page with two server actions; needs the restore cookie from `/signin`)

All require a signed-in ACTIVE user (`requireUser`); a user can only act on their own account.

## Tests

- `tests/unit/account-deletion.test.ts` — 15 tests: every blocker, promotional credit, roles, placeholder email,
  subscriptions, anonymisation patch, flag OFF (service + all three APIs 404), typed word, sign-in required. Pass.
- 0199 unit additions: required reason, 90-day end date, restore ticket (signature, expiry, other account),
  admin-only cancel with note — `tests/unit/account-deletion.test.ts` now 20 tests. Pass.
- `tests/integration/account-deletion.test.ts` — real PostgreSQL (run locally 24-Nov-2026 on a fresh database
  migrated to 0199): cooling-off (hidden, reason, sessions, push tokens, email, admin list with/without personal
  data), a hidden account cannot act (session, second request, sign-in refused except the restore path), restore
  at sign-in (rider switched back, CANCELLED, audit, email), admin cancel (operator refused), daily purge with a
  fake clock (nothing at day 89; anonymised + COMPLETED + email + fresh sign-up after day 90), blocker at purge
  time (BLOCKED, one ops alert, retried, completes once cleared), wrong word / missing reason / wrong code,
  wallet blocker. 9 tests, pass.

## Still open / for the owner

- Customer-facing text on the new page is English only (the surrounding My Profile screen is English).
- Shop owners: a shop must be closed first; the closed shop's wallet / settlements / bank account are kept and
  settled as usual. Shop delivery staff (`shop_delivery_staff`) are not checked.
- Rider KYC documents and the rider profile's personal fields are kept (tax / KYC retention); only the account
  is anonymised and the rider profile deactivated. Owner to confirm the retention period.
- No scheduled purge of retained records after their legal period — a later job, needs owner / legal sign-off
  (periods are recorded in rule `accountDeletion.retentionYears`).
- ~~No "undo" window~~ — done in 0199 (90-day cooling-off, restore at sign-in, admin cancel).
- Purge-time ops alert goes by email to `SUPER_ADMIN_EMAIL` (no notification-catalog entry was added).
- Mobile app: the restore screen is a web page; the app's in-app code sign-in path was not changed (a hidden
  account is refused there with "scheduled for deletion … sign in on the main Sign in page").
- Not covered by the hiding: records of past orders seen by the shop that served them (kept legal records).
