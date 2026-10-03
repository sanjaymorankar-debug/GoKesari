# Gokesari — deploy runbook

**Scope:** promoting the Phases A–J release plus dispute cases, login by
mobile/email and the product category master (migrations `0025`–`0039`) to an environment that is still on `0024`. Written 3 Oct 2026.

This is the step-by-step companion to [DEPLOYMENT.md](../../DEPLOYMENT.md), which
remains the reference for environment variables, Cashfree setup, backups and
monitoring. Where the two disagree, DEPLOYMENT.md is the authority on *what* and
this file is the authority on *the order for this release*.

> The old `DEPLOY_NOW.md` was deleted in PR #33 because it was a runbook for a
> different brand's domain. Do not resurrect it.

---

## 0. Why the order matters

Every migration from `0025` to `0039` is **additive** — no `DROP TABLE`, no
`DROP COLUMN` (verified across all fifteen files). The single non-additive
statement is in `0029`:

```sql
ALTER TABLE "delivery_partner_earnings" ALTER COLUMN "delivery_order_id" DROP NOT NULL;
```

Additive means the *previous* release tolerates the new schema: you can migrate
before you deploy and the running app ignores the new columns. The reverse is
not true, and it is worse than "the new features don't work".

**Verified, not assumed.** A database was built at exactly `0024` (25
migrations) and this release's code run against it. What happens:

| | Observed |
|---|---|
| **Sign-in** | **Broken for everyone.** Every user lookup selects `users.phone_e164` and `phone_verified_at`, added in `0025`. The query fails, Auth.js returns `CallbackRouteError`, and nobody — customer, shop owner, operator, admin — can log in. |
| **The storefront** | **`/` returns 500.** Serviceability selects `shops.delivery_pincodes`, added in `0026`: `column "delivery_pincodes" does not exist`. The public home page, `/shops` and checkout go down with it. |
| Everything behind a login | Unreachable, because sign-in is broken — pages redirect to `/signin`, which cannot complete. |

So this is not a partial degradation where new screens fail and the shop keeps
trading. **An unmigrated deploy is a full outage**, including for customers who
never touch the new features.

So: **migrate first, deploy second.** Always.

---

## 1. Before you touch anything

```bash
# Confirm which environment you are pointed at. Do this every time.
psql "$DATABASE_URL" -c "select current_database(), inet_server_addr();"

# What is already applied? 25 rows = on 0024. 40 rows = fully migrated
# (42 on the test database: see "0038 and 0039 run twice on test" below).
psql "$DATABASE_URL" -c "select count(*) from drizzle.__drizzle_migrations;"
```

Staging and production have **separate databases** (DEPLOYMENT.md §3). Running
this against the wrong one is the most expensive mistake available here, and the
two connection strings look almost identical.

---

## 2. Back up — not optional

Wallet balances are money.

```bash
pg_dump "$DATABASE_URL" -Fc -f ~/gokesari_pre_0037_$(date +%F_%H%M).dump
ls -lh ~/gokesari_pre_0037_*.dump   # confirm it is not 0 bytes
```

If the provider offers point-in-time recovery, note the timestamp you are
starting from. A backup you have not seen the size of is a hypothesis.

Run the ledger integrity checks from DEPLOYMENT.md §7 **now**, before migrating,
so that if they fail afterwards you know this release caused it:

```sql
SELECT id FROM wallet_transactions
WHERE new_balance_paise <> previous_balance_paise + amount_paise;   -- expect 0 rows

SELECT w.id FROM wallets w
LEFT JOIN wallet_transactions t ON t.wallet_id = w.id
GROUP BY w.id, w.balance_paise
HAVING w.balance_paise <> COALESCE(SUM(t.amount_paise), 0);          -- expect 0 rows
```

---

## 3. Apply migrations

```bash
npm ci                 # the runner needs devDependencies (tsx, drizzle-kit)
npm run db:migrate
# → "Migrations applied."
```

`drizzle` applies the fifteen files in journal order and records each in
`drizzle.__drizzle_migrations`. It is resumable: a re-run applies only what is
missing, so an interrupted migration is safe to repeat.

**`0030` adds an enum value** (`notification_channel` += `WHATSAPP`). PostgreSQL
cannot add an enum value and use it in the same transaction; drizzle already
runs it as its own statement, so this needs nothing from you — but if you are
applying the SQL by hand instead of with the runner, do not wrap `0030` in a
transaction with anything else.

**`0037` creates a sequence by hand.** `dispute_case_seq` backs the
`DSP-000001…` case numbers, the same pattern as `grievance_ticket_seq`.
drizzle-kit cannot emit a sequence, so the `CREATE SEQUENCE` is written at the
top of the migration — if you ever regenerate that file, put it back or the
first dispute insert fails on a missing sequence.

**`0038` and `0039` run twice on test.** On `staging` they were numbered `0037`
(login profile) and `0038` (category master) until the merge with `main`'s
`0037_dispute_cases`. drizzle does not track migrations by name: it runs every
journal entry whose `when` is later than the newest `created_at` in
`drizzle.__drizzle_migrations`. So the two were re-timestamped to sort after
`0037_dispute_cases`, which means:

* a database migrated from `main` (on `0037_dispute_cases`) picks up both;
* the test database, which ran them under their old numbers, runs
  `0037_dispute_cases` and then runs both again. Both are written to be no-ops
  the second time, and their one-off data steps (the profile backfill, the
  shop-category links) run only in the run that creates the column or table,
  so links an admin has removed since are not restored.

The test database therefore ends with 42 rows rather than 40; the newest
`created_at` is `1791030174408` on every fully migrated database.

Verify:

```bash
psql "$DATABASE_URL" -c "select count(*), max(created_at) from drizzle.__drizzle_migrations;"   # 40 (42 on test), 1791030174408
psql "$DATABASE_URL" -c "\d platform_settings"                                 # exists
psql "$DATABASE_URL" -c "select unnest(enum_range(null::notification_channel));"  # includes WHATSAPP
psql "$DATABASE_URL" -c "select sequencename from pg_sequences where sequencename='dispute_case_seq';"  # one row
```

Nothing needs backfilling. Every new column is nullable or has a default, and
existing rows keep their values.

---

## 4. Environment variables

**This release adds no environment variables and makes none newly required** —
`src/lib/env.ts` gained no mandatory key, so an environment that boots today
still boots. What it does is make three existing *optional* ones matter more
than they did:

| Variable | Effect if unset in this release |
|---|---|
| `AUTH_EMAIL_FROM`, `AUTH_EMAIL_SERVER` | Mobile-number login is **hidden** (the OTP is emailed, so no SMTP means no mobile login). Email notifications are skipped, not failed. Google and email-link sign-in are unaffected. |
| `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | Address search in the location picker falls back to manual entry. Not fatal. |
| `PAN_ENCRYPTION_KEY` | Unchanged from before: a rider application including a PAN is refused rather than stored in plaintext. |

`GOOGLE_MAPS_SERVER_API_KEY` is a *separate* key from the `NEXT_PUBLIC_` one and
should be IP-restricted, not domain-restricted — it is never sent to a browser.

---

## 5. Deploy the app

Branch mapping (DEPLOYMENT.md §3):

| Branch | Environment | Domain |
|---|---|---|
| `staging` | staging | `test.gokesari.com` |
| `main` | production | `gokesari.com` |

Promotion to production is a merge of `staging` into `main`, which is also the
human approval gate. In the hosting panel, trigger the rebuild for the branch
you just migrated the database for.

The build runs `next build --webpack`. Both `dev` and `build` pass `--webpack`
deliberately — see the comment on the `webpack()` hook in `next.config.ts`. Do
not drop the flag from one without the other.

---

## 6. Schedule the crons

**Two are new in this release.** All six authenticate with
`Authorization: Bearer $CRON_SECRET`, and all are idempotent, so a retried or
duplicated run is harmless.

```bash
# NEW in this release — sends queued email and retries failures.
# Without it, email queued inside a transaction waits for the next unrelated send.
* * * * * curl -fsS -X POST https://test.gokesari.com/api/cron/notifications \
  -H "Authorization: Bearer $CRON_SECRET" >> /var/log/gk-notifications.log 2>&1

# Existing — now ALSO sweeps return pickups, so it matters more than before.
*/2 * * * * curl -fsS -X POST https://test.gokesari.com/api/cron/delivery-dispatch \
  -H "Authorization: Bearer $CRON_SECRET" >> /var/log/gk-dispatch.log 2>&1

# Existing — subscriptions. The most damaging outage in the system: a silent
# failure means customers simply stop receiving milk.
0 5 * * * curl -fsS -X POST https://test.gokesari.com/api/cron/daily-orders \
  -H "Authorization: Bearer $CRON_SECRET" >> /var/log/gk-daily-orders.log 2>&1

# Existing — risk rules, hourly.
17 * * * * curl -fsS -X POST https://test.gokesari.com/api/cron/risk-rules \
  -H "Authorization: Bearer $CRON_SECRET" >> /var/log/gk-risk.log 2>&1

# NEW in this release — escalates dispute cases past the age limit (GS-058).
# Hourly is enough: the limit is in hours. Without it, the amount trigger still
# escalates at open, but a case nobody touches never rises to an administrator.
23 * * * * curl -fsS -X POST https://test.gokesari.com/api/cron/dispute-escalation \
  -H "Authorization: Bearer $CRON_SECRET" >> /var/log/gk-disputes.log 2>&1

# Existing — weekly finance batches.
30 2 * * 1 curl -fsS -X POST https://test.gokesari.com/api/cron/finance-weekly \
  -H "Authorization: Bearer $CRON_SECRET" >> /var/log/gk-finance.log 2>&1
```

Five of the six also answer `GET` with a readiness probe, so you can confirm
wiring without causing a run — `daily-orders`, `delivery-dispatch`,
`notifications`, `risk-rules` and `dispute-escalation`. **`finance-weekly` is POST-only**, so there is
no way to test its wiring without running it; check it by its log output after
the first Monday.

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://test.gokesari.com/api/cron/notifications
```

**Alert on `daily-orders` returning a non-empty `errors`, or `generated: 0` on a
day you expect deliveries.**

---

## 7. Smoke test — in this order

Rows 1–5 are pages that fail outright on an unmigrated database, so getting
through them is itself the migration check. Rows 6–10 exercise what this release
actually changed. Sign in as an admin first — if that fails, stop and re-check
§3, because broken sign-in is the signature of an unmigrated database.

| # | Do this | Expect |
|---|---|---|
| 1 | Open `/` and `/shops` | 200, shops listed |
| 2 | Open `/admin/settings` | The nine rule groups render (`otp`, `dispatch`, `riderEarnings`, `returns`, `images`, `notifications`, `suspension`, `mrp`, `externalPrices`) |
| 3 | Open `/admin/consents` | Counts render; search a customer by email; opening their record writes a `consent.history_viewed` audit row |
| 4 | Open `/admin/exceptions` | The twelve-category operations queue renders |
| 5 | Open `/admin/rider-earnings` | Slots/incentives screen; use the "try a delivery" calculator |
| 6 | Place an order end to end | Checkout → shop accepts → pick/pack → READY → rider offered |
| 7 | While that order is live, open `/orders` as the customer | **The tracking panel appears** under the delivery line (this is new; it was built but unmounted until `80980f1`) |
| 8 | Open `/admin/orders`, click **Track** on the live row | Tracking panel expands for that one order |
| 9 | Request a return on a delivered order | `/orders/{id}/return` → appears in `/returns` and `/shop/returns` |
| 10 | Approve a pending shop with an unpaid registration fee | **Refused**, naming the amount outstanding (this is new — see §8) |
| 11 | Open a dispute on a delivered order, then work it at `/admin/disputes` | Case gets a `DSP-` number; triage → investigate → propose → resolve; a refund outcome credits the wallet and shows a finance adjustment |
| 12 | Open a dispute for more than the review limit (default ₹2,000) | Opens **already escalated** to L2, and an operator cannot take it forward — only an administrator |

---

## 8. Behaviour changes to brief support on

These are intentional, and each will generate a "the system is broken" report
from somebody if support has not been told:

1. **A shop cannot be approved until its registration fee is settled.**
   `feePaymentStatus` must be `PAID`. Record the payment, or set the fee to zero
   to waive it — a zero fee is written as `PAID` at registration, so waiving is
   the supported escape hatch. Shops already approved are untouched.
2. **Checkout refuses a paused shop, and an order below a shop's minimum.**
3. **A suspended shop cannot accept orders**, and orders held by the suspension
   policy are neither advanced by the shop nor dispatched.
4. **A shop price above a *verified* MRP is refused** everywhere a price is written.
5. **Hand-edited stock now writes the inventory ledger** and re-checks alerts.
6. **Ordering from a closed shop is now possible** behind an explicit customer
   confirmation, and the shop gets an alert immediately and again when it opens.
7. **A dispute case is now its own thing** (GS-058), separate from a grievance:
   only one live case per order, only on a delivered order, and an escalated
   case can only be taken forward by an administrator. Escalation is
   **automatic** — at open if the amount is at or above the review limit, and
   by the hourly sweep once a case passes the age limit. Both limits are in
   `/admin/settings` under `disputes`, and setting either to 0 switches that
   trigger off.
8. **Mobile-number login exists** but the code is emailed, not texted — SMS is
   blocked on decision D2 (vendor choice; India needs DLT registration). A number
   is therefore *claimed*, not proven: `phoneVerifiedAt` is only set by an SMS
   code. Whoever links a number first holds it.

---

## 9. Rollback

Because the migrations are additive, **rolling the application back is safe with
the columns left in place** — `0024` code ignores them. Redeploy the previous
build from the hosting panel; do not attempt to reverse the SQL.

There is no automatic down-migration (drizzle generates forward SQL only). The
one statement that would need manual reversal is `0029`'s `DROP NOT NULL`, and
restoring it requires that no return-pickup earnings rows exist:

```sql
-- Only safe if this returns 0.
SELECT count(*) FROM delivery_partner_earnings WHERE delivery_order_id IS NULL;
ALTER TABLE delivery_partner_earnings ALTER COLUMN delivery_order_id SET NOT NULL;
```

If a rollback needs a database restore, put the app in maintenance first —
restoring over a live app loses whatever was written in between.

---

## 10. Known gaps at this release

Not bugs; things deliberately not built, so nobody hunts for them:

- **No per-order gateway payment.** Orders are wallet or COD. Cashfree is wired
  for wallet top-up only. Direct payments, tax invoicing, photo proof of delivery
  and shop accept-timeout are **designed and not built**
  ([DESIGN_PAYMENTS_INVOICING_POD_SLA.md](./DESIGN_PAYMENTS_INVOICING_POD_SLA.md)).
- **Refunds go to the wallet**, including COD refunds. No gateway refund exists
  because no gateway order payment exists.
- **No SMS, push or WhatsApp.** Email and in-app only; the rest are provider
  seams awaiting D2.
- **External reference prices are staff-visible only**, pending the
  licensed-source decision (D7). The customer display is built and switched off
  by the `externalPrices.showToCustomers` rule — flipping it is a settings
  change, not a deploy.
- **Navigation is a Google Maps deep link**, not in-app turn-by-turn. There is no
  road-routing ETA.
- **The in-memory rate limiter is per server instance** — unchanged, and wrong
  if the app is ever run on more than one instance.
- `platform_settings` is edited as JSON on `/admin/settings`, validated
  server-side. There are no per-field forms.

Current status of every feature, with the file each judgement rests on, is in
[GOKESARI_FEATURE_STATUS_REPORT_2026-10-02.xlsx](./GOKESARI_FEATURE_STATUS_REPORT_2026-10-02.xlsx).

---

## 11. Defaults someone should confirm

All live in `platform_settings` and are editable at `/admin/settings` without a
deploy. They were chosen during development, not agreed with the business:

| Rule | Default |
|---|---|
| Return window | 48 h |
| "Changed my mind" returns | Not accepted |
| Who bears a return | Defect reasons → the shop; everything else → the platform |
| Rider return-pickup fee | The base delivery fee |
| Suspension policy | `CONFIRMED` → cancel & refund · `ACCEPTED`/`PREPARING`/`READY`/`ASSIGNED` → hold for review · `PICKED_UP`/`OUT_FOR_DELIVERY` → continue |
| Dispatch retry | 60 s × 10 attempts, 30 min total, +15 min past promised time |
| OTP | 6 digits, 10 min expiry, 5 attempts, 60 s resend cooldown, 5 resends per 60 min, 20 requests per IP per window |
| Images | 2 MB, 8 per product |
| MRP enforcement | Only when the MRP is **verified** |
| Dispute escalation | Automatic: after 48 h open, or at ₹2,000 and above on opening |
| Dispute resolve target | 120 h after escalation, then counted as overdue |

Also unconfirmed: the D10 cancellation treatments for `ACCEPTED`/`ASSIGNED`
(customer blocked) and `PICKED_UP` (goods-only refund) — implemented and tested
as recorded in [D10_VERIFICATION.md](./D10_VERIFICATION.md), still marked pending
confirmation.
