# Deploying to test.gokesari.com

Copy-paste steps to get this running on your Hostinger staging domain.

Two things this session could not do for you, and why:

- **Push to GitHub** — the sandbox's git proxy only serves repositories in its
  pre-authorised set, and `sanjaymorankar-debug/GoKesari` is not in it. Step 2 is
  yours to run.
- **Call the Hostinger API** — `developers.hostinger.com` is blocked at the
  sandbox's network proxy, so hPanel steps are manual.

Everything else is prepared: schema, migrations, seed, CI, and the app itself.

---

## Step 1 — Create the database (~3 minutes)

Hostinger's Web/Cloud plans, including Node.js Web Apps, **do not support
PostgreSQL** — MySQL only. PostgreSQL needs a VPS or an external provider. The
app needs nothing but a connection string, so an external managed Postgres is
the least-effort path.

1. Sign up at **https://neon.tech** (free tier is ample for staging).
2. Create a project — pick the region closest to your users (Singapore or
   Mumbai for India).
3. Copy the connection string. It looks like:

```
postgresql://user:password@ep-xxxx-yyyy.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
```

Keep it handy — it becomes `DATABASE_URL` in step 4.

> Neon gives you a **pooled** and a **direct** connection string. Use the
> **direct** one for migrations (step 5) and either for the app; the code reads
> `sslmode` from the URL and enables TLS automatically.

---

## Step 2 — Push the code to GitHub

This repository **is** the app — `sanjaymorankar-debug/GoKesari`. If you are
working in a clone of it, there is nothing to do in this step; go to step 3.

Only if you are starting from a delivered archive rather than a clone:

```bash
cd dairy-bakery

# This repo, not bkesari: bkesari.com is the separate Milk & Dairy site.
git remote remove origin 2>/dev/null
git remote add origin https://github.com/sanjaymorankar-debug/GoKesari.git

git branch -M main
git push -u origin main

# Staging branch — this is what test.gokesari.com deploys from
git checkout -b staging
git push -u origin staging
```

**Never `--force` these pushes.** An earlier version of this file pointed at
`sanjaymorankar-debug/bkesari` and force-pushed, from when this app lived in
that repo and was overwriting a throwaway scaffold. Both repositories now carry
real history, and a force-push would destroy it — bkesari especially, which is
a different site and not yours to overwrite from here.

If git asks for a password, paste your Personal Access Token (not your GitHub
password).

---

## Step 3 — Point the Hostinger app at the right branch

In hPanel → your Node.js Web App for `test.gokesari.com`:

- Confirm the connected repository is `sanjaymorankar-debug/GoKesari`
- Confirm the branch is **`staging`**
- Build command: `npm run build` · Start command: `npm start` (usually
  auto-detected for Next.js)

---

## Step 4 — Set environment variables

In hPanel → your app → Environment variables. Generate the two secrets first:

```bash
openssl rand -base64 32   # AUTH_SECRET
openssl rand -hex 32      # CRON_SECRET
```

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | the Neon string from step 1 |
| `DATABASE_POOL_MAX` | `10` |
| `AUTH_SECRET` | output of `openssl rand -base64 32` |
| `AUTH_URL` | `https://test.gokesari.com` |
| `AUTH_GOOGLE_ID` | from Google Cloud Console (step 6) |
| `AUTH_GOOGLE_SECRET` | from Google Cloud Console (step 6) |
| `CRON_SECRET` | output of `openssl rand -hex 32` |
| `BOOTSTRAP_ADMIN_EMAILS` | `agtcipl@gmail.com` |
| `APP_TIMEZONE` | `Asia/Kolkata` |
| `SUBSCRIPTION_CUTOFF_HOUR` | `20` |

Leave the `CASHFREE_*` variables **unset on staging** — the app then runs in
mock payment mode, so you can exercise the full wallet flow without moving real
money. Set real keys only on production. (`CASHFREE_APP_ID`, `CASHFREE_SECRET_KEY`,
`CASHFREE_ENV=sandbox|production`.)

Then redeploy so the app picks the variables up.

---

## Step 5 — Create the schema

Run from your own machine, pointed at Neon. Nothing here touches Hostinger.

```bash
cd dairy-bakery
npm install

export DATABASE_URL="postgresql://...neon.tech/neondb?sslmode=require"

npm run db:migrate              # creates all 28 tables
npm run db:seed -- --minimal    # roles, permissions, dairy + bakery catalogue
```

`--minimal` seeds reference data only. Drop the flag on staging if you want the
five demo shops to browse:

```bash
npm run db:seed                 # adds demo shops and products
```

Verify:

```bash
psql "$DATABASE_URL" -c "SELECT count(*) FROM products;"   # expect 40
```

---

## Step 6 — Google OAuth

Google Cloud Console → APIs & Services → Credentials → Create OAuth 2.0 Client
ID (Web application):

- Authorised JavaScript origin: `https://test.gokesari.com`
- Authorised redirect URI: `https://test.gokesari.com/api/auth/callback/google`

Copy the Client ID and Secret into `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`, then
redeploy.

> Until this is set, the sign-in page shows a message rather than a Google
> button — the app runs, but nobody can sign in.

---

## Step 7 — Schedule the daily order engine

**Without this, no subscription orders generate and no wallets are debited.**
It is the single most important post-deploy step.

In hPanel → Cron Jobs, daily at 05:00 IST:

```bash
curl -fsS -X POST https://test.gokesari.com/api/cron/daily-orders \
  -H "Authorization: Bearer YOUR_CRON_SECRET"
```

Verify wiring without generating anything:

```bash
curl -H "Authorization: Bearer YOUR_CRON_SECRET" \
  https://test.gokesari.com/api/cron/daily-orders
# {"status":"ready","timezone":"Asia/Kolkata"}
```

The job is idempotent — a duplicate or retried run cannot double-charge.

---

## Step 8 — Verify the deployment

```bash
curl -o /dev/null -w "%{http_code}\n" https://test.gokesari.com/          # 200
curl https://test.gokesari.com/api/cart                                   # 401
curl -X POST https://test.gokesari.com/api/cron/daily-orders              # 403
```

Then in a browser:

1. Sign in with Google as `agtcipl@gmail.com` → you land as **Administrator**
2. `/admin` → approve a shop and set its Kesari/Green classification
3. `/wallet` → add money (mock mode on staging)
4. Browse `/dairy` → subscribe to Cow Milk at 2 L/day
5. Trigger the cron manually → confirm ₹140 leaves your wallet
6. `/subscriptions/{id}` → change tomorrow to 3 L → confirm the calendar updates

Once verified, remove `BOOTSTRAP_ADMIN_EMAILS` and redeploy.

---

## Step 9 — Promote to production

When staging looks right:

```bash
git checkout main
git merge staging
git push origin main
```

Before production, in addition to the above:

- A **separate** Neon database (never share one with staging)
- Real `CASHFREE_APP_ID` / `CASHFREE_SECRET_KEY` with `CASHFREE_ENV=production`
  — confirm the app is not in mock payment mode
- `AUTH_URL=https://gokesari.com` and the matching Google redirect URI
- Backups and the ledger-integrity checks from `DEPLOYMENT.md §7`

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Build fails on `DATABASE_URL is required` | Env vars not set before build | Set them in hPanel, redeploy |
| 500 on every page | Migrations not run | Step 5 |
| `ECONNREFUSED` / SSL errors | Missing `?sslmode=require` | Append it to `DATABASE_URL` |
| Sign-in shows a message, no Google button | OAuth not configured | Step 6 |
| `redirect_uri_mismatch` from Google | URI doesn't match exactly | Must be `https://test.gokesari.com/api/auth/callback/google` |
| Subscriptions never deliver | Cron not scheduled | Step 7 — check it actually ran |
| Intermittent DB connection failures | Pool exceeds Neon's cap | Lower `DATABASE_POOL_MAX` |
