# Seller verification — deployment (Deliverable 5)

Order: **test.gokesari.com first, then gokesari.com.** Hostinger deploys
`staging` to test and `main` to production automatically on push, so merging
to `main` is the production release. Database: Neon, a separate database for
each site.

Two rules for hPanel environment variables:
- Change them only through **Deployments → Redeploy → "Settings and
  redeploy"**. Never use "Change repository": it wiped 16 variables once.
- Before any change, copy the full variable list into the password manager.

## Stage 1 — test.gokesari.com on the mock vendor (no keys needed)

1. **Back up** the test database (Neon branch or `pg_dump -Fc`).
2. **Merge the PR into `staging`.** Hostinger builds and deploys test.
3. **Migrate** from a machine that can reach the test database, naming the
   target explicitly. The app's `.env` points at Neon, so never rely on it:
   ```bash
   DATABASE_URL=<test database URL> npm run db:migrate
   ```
   This applies 0040 and 0041. Both are additive, so the old build keeps
   working if it runs first.
4. **Settings:** none needed. Without them the app uses `KYC_PROVIDER=mock`,
   `KYC_ENV=sandbox`. Confirm `PAN_ENCRYPTION_KEY` is already set on test; it
   is reused for document numbers and certificates.
5. **Schedule the daily sweep** in hPanel → test.gokesari.com → Cron Jobs, as
   a custom command:
   ```bash
   curl -fsS -X POST https://test.gokesari.com/api/cron/seller-verification -H "Authorization: Bearer <test CRON_SECRET>"
   ```
   Daily, e.g. 06:30 IST (01:00 UTC). Check the wiring first with a GET to
   the same URL, which should return `{"status":"ready"}`.
6. **Smoke test** with a test shop owner account:
   - Shop dashboard → **Verify documents** → run PAN-1, GST-8 (declaration),
     FSS-1 and SHA-1 from `TEST_CASES.md`.
   - Admin → **Seller document verification → Open review queue** → accept
     the GST declaration, open the SHA-1 certificate, approve it.
   - The shop's **Seller information** page shows "Verified by Gokesari: PAN,
     FSSAI…".
   - Admin dashboard → compliance shows "Running against the mock vendor".
7. Run the rest of `TEST_CASES.md` and note any differences.

## Stage 2 — test.gokesari.com on Gridlines sandbox (when keys arrive)

1. **Find the outgoing server IP.** If Gridlines requires approved IPs:
   - check which address the app actually calls out from (see the Part 1
     notes on Hostinger plans);
   - on a Business plan, set up the egress proxy first (small VPS or
     QuotaGuard). This needs an extra adapter change, so ask before relying on it.
2. **Settings** (Settings and redeploy):
   `KYC_PROVIDER=gridlines`, `KYC_ENV=sandbox`, `GRIDLINES_API_KEY=<sandbox key>`,
   and `GRIDLINES_BASE_URL` only if Gridlines gives a separate sandbox host.
3. **Confirm the adapter** with Gridlines' test values for each row of
   `TEST_CASES.md`. Correct `GRIDLINES_ENDPOINTS` and the field lists in
   `src/server/kyc/adapters/gridlines.ts` where needed (PR → `staging`), and
   repeat until every row matches.
4. **Watch for a week:**
   - the daily cron output: `errors` should be `[]`;
   - the compliance dashboard row "Seller document verification";
   - the review queue for unexpected `config_*` reasons.

## Stage 3 — production (gokesari.com)

**Before:**
- [ ] Every item in `COMPLIANCE.md` §8 that blocks launch is done. At minimum: lawyer sign-off on the consent and declaration wording, the data processing agreement with Gridlines, and Gokesari's FSSAI e-commerce licence if food sellers will be live.
- [ ] Gridlines live account: business KYC done, credits bought, low-balance alert set, live key named `gokesari-prod`, production IP approved if required.
- [ ] Stage 2 ran clean for at least a week.
- [ ] The production `PAN_ENCRYPTION_KEY` is set and backed up in the password manager. It must be the production key, not the test one.

**Release:**
1. **Back up** the production database.
2. **Migrate** production: `DATABASE_URL=<production URL> npm run db:migrate`.
3. **Settings** on gokesari.com (Settings and redeploy):
   `KYC_PROVIDER=gridlines`, `KYC_ENV=production`, `GRIDLINES_API_KEY=<live key>`.
   The app refuses a live key on any host other than gokesari.com and a
   mock or sandbox setting on gokesari.com. Check that `AUTH_URL` is
   `https://gokesari.com`.
4. **Open a PR `staging` → `main`** and merge it. Hostinger deploys
   production.
5. **Schedule the daily sweep** on gokesari.com (as in Stage 1, with the
   production `CRON_SECRET`).
6. **Smoke test** with one real shop you control:
   - PAN and GSTIN → Verified;
   - the review queue opens;
   - the compliance dashboard says "Documents are checked with gridlines (production)".
7. **Existing shops:** the compliance row "Seller documents verified" counts
   approved shops missing a mandatory document. Notify those sellers to
   complete verification. Nothing is suspended for documents never
   submitted — only for ones that expire or are cancelled.

## Settings you may want to change later (admin settings, no deploy)

`sellerVerification` rule:
- `nameMatchAutoApprove` (85) and `consistencyAutoApprove` (80);
- `gstRecheckDays` (30);
- `expiryWarningDays` (30);
- `pendingRetryMinutes` (15);
- `maxChecksPerShopPerHour` (10);
- `autoSuspendOnLapse` (on);
- `suspendGraceDays` (0);
- `retentionDaysAfterClosure` (1,095 — set by your lawyer/CA).

## Rollback

- **Code:** revert the merge on `staging` or `main` and push; Hostinger
  redeploys the previous build. The new tables are ignored by older code, so
  the migrations don't need undoing.
- **To pause verification without a code change:** set `KYC_PROVIDER` to
  something the guard refuses on that host — for example, on test, set
  `KYC_ENV=production`. Documents then wait as PENDING and the dashboard
  shows "Verification is paused". Undo it to resume; the daily job retries
  them.
- **Full removal:** back up, then `scripts/rollback-0040.sql` (drops both
  tables and all verification data).
