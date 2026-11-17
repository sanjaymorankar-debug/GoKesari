# Plan: run the GoKesari website code on our own server (VPS)

**Written:** 17-Nov-2026, 06.18 IST. **Times:** IST (UTC + 5:30). **Status:** plan only. Nothing has changed yet.

**Owner's request (17-Nov-2026, about 06.20 IST):**
- "write the plan to move code to VPS";
- "make a plan in such a way that I should be able to host few more websites".

## 1. Summary

- **Since 17-Nov-2026 (06.06 IST), both GoKesari databases run on our own server.** The VPS is `gk-db-1`: Hostinger KVM 4, Mumbai, 189.72.155.162. The record is in [docs/neon-to-vps-2026-11/](../neon-to-vps-2026-11/).
- **The website code** (the Next.js app for gokesari.com and test.gokesari.com) **still runs on Hostinger web hosting.** It reaches the database over TLS, about 3 ms away.
- **This plan moves the website code onto the same VPS**, as two apps:
  - `gokesari-prod` serves gokesari.com;
  - `gokesari-staging` serves test.gokesari.com.
  - **Caddy** sits in front of both. It handles HTTPS with automatic certificates and HTTP/2/3.
- **Each site gets its own slot:** a Linux user, a folder, a systemd service, CPU and memory limits, an env file and a Caddy block. A later site is added the same way, by running `gk-site add` (section 5).
- **Builds and deploys run on the VPS**, by a deploy agent that follows the `staging` and `main` branches.
  - They no longer depend on Hostinger's auto-deploy. That missed two staging builds on 16–17 Nov.
  - They don't depend on GitHub Actions minutes either. The GitHub bill is overdue, due 22-Nov.
- **Switching is a DNS change.** Both hosts use the same database, so the switch needs no freeze and no read-only window.
  - Rollback means pointing DNS back. The TTL is 60 s today.
  - The Hostinger sites stay deployed for 14 days as the fallback.
- **E-mail stays on Hostinger Email.** gokesari.com's MX records point at `mx1/mx2.hostinger.com`, and sign-in codes are sent through its SMTP.
- **Main gains:**
  - deploys we control, and a site served next to its database;
  - the database ports can be closed to the internet completely;
  - one server for everything GoKesari runs.
- **Main costs:**
  - one server becomes a single point of failure for the site **and** the data;
  - we lose Hostinger's CDN and its DDoS screening (section 9).

## 2. What we have today (checked 17-Nov-2026, 06.15 IST)

| | Today |
|---|---|
| App | Next.js 16.4.1 (webpack build), Node 24. `npm run build` = `migrate-on-build.mjs` (always skips outside GitHub Actions) + `next build`. Start: `next start`. `images.unoptimized` (no image server). `sharp` is installed. `tesseract.js` and `unpdf` are server-external packages. |
| Hosting | Hostinger web hosting, account `u879099820`, server `in-mum-web1497`. Outgoing IPv4 93.127.208.167. Builds start from Git pushes (`staging` → test, `main` → production) with Hostinger's stored build settings. |
| In front | Hostinger CDN: `www.gokesari.com` is a CNAME to `*.cdn.hstgr.net`, and the apex A/AAAA records are Hostinger's edge addresses. TTL 60 s. DNS at Hostinger (`ns1/ns2.dns-parking.com`). |
| Uploaded files | **In the database** (`MEDIA_DIR` is not set on either site; `src/server/media/blob-store.ts`, `src/server/accounts/files.ts`). Nothing on Hostinger's disk to move. |
| Settings | About 45 environment variables on test and 33 on production in hPanel. Their values are masked in the API (section 7, step B5). |
| Scheduled jobs | 6 hPanel cron lines (UTC): production every minute, hourly at :17 UTC (:47 IST) and daily 23.30 UTC (05.00 IST); the same three for staging. Each `curl`s `/api/cron/<job>` with a bearer secret. |
| E-mail | Hostinger Email (MX `mx1/mx2.hostinger.com`), SMTP in `AUTH_EMAIL_SERVER`. |
| VPS now | 4 vCPU, 15 GiB RAM (1 GiB used), 193 GB disk (4 % used), load 0.00. PostgreSQL 18 production + staging, backups, WireGuard. |

## 3. Target layout on the VPS

```
Internet ── 80/443 ──► Caddy (HTTPS for every site; HTTP/2 and HTTP/3)
                        ├─ gokesari.com, www  ──► 127.0.0.1:3101 / :3102  gokesari-prod (blue/green)
                        ├─ test.gokesari.com  ──► 127.0.0.1:3201 / :3202  gokesari-staging (blue/green)
                        └─ (a later site)     ──► its own ports, user, limits
PostgreSQL 18:  5432 production · 5433 staging   ← apps connect locally (Unix socket)
WireGuard 51820: owner's Mac and GitHub jobs (unchanged)
```

- **One Linux user per site** (`gk-prod`, `gk-staging`), with no login shell. Each owns only `/srv/sites/<site>/`:
  - `releases/<commit>/`: each build;
  - `current` and `previous`: symlinks;
  - `shared/`: logs;
  - the env file is `/etc/sites/<site>.env` (root, mode 600), read by systemd.
- **One systemd service per colour per site** (`site@gokesari-prod-blue`, `…-green`):
  - `MemoryMax`, `CPUQuota` and `TasksMax`;
  - sandboxing: `ProtectSystem=strict`, `NoNewPrivileges`, `PrivateTmp`, read-only code;
  - restarts on failure.
- **Limits** (starting values, adjusted after a week of measurements):

| Slot | CPU | Memory | Notes |
|---|---|---|---|
| PostgreSQL production | — | — | Keeps priority; `shared_buffers` as today. |
| gokesari-prod | 200 % (2 vCPU) | 4 GiB | Two colours run only for a minute during a deploy. |
| gokesari-staging | 100 % | 2 GiB | |
| Builds (`gk-build`) | 150 %, `nice 10` | 4 GiB | One build at a time across all sites. |
| A later site | from what is left | | See section 5 for the headroom rule. |

- **Zero-downtime deploys (blue/green):**
  1. The new build starts on the idle colour's port.
  2. The agent waits for its health check (`/`, `/shops`, `/api/shops?limit=1`).
  3. Caddy's upstream switches to it (`caddy reload`: no dropped connections).
  4. The old colour stops after 60 s.
- **The database connection becomes local.** `DATABASE_URL` uses the Unix socket (`host=/var/run/postgresql`, port 5432/5433, role as today). There is no TLS hop, and after the switch **public 5432/5433 can be closed** (section 7, E3).

## 4. Builds and deploys (replaces Hostinger's auto-deploy)

- **`gk-deploy` agent:** a systemd timer every minute, plus `gk-deploy now <site>` by hand.
  1. It compares the site's branch head (`git ls-remote` with a **read-only deploy key**) with the deployed commit.
  2. On a new commit it fetches that commit into `releases/<sha>` and runs `npm ci` and `npm run build` as the site's user, inside `gk-build` limits.
  3. It then does the blue/green switch.
  4. It writes `deployed.json` (commit, time, result) and pings healthchecks.io (`gk-deploy-<site>`). A failed build changes nothing: the old release keeps serving.
- **One deploy at a time on the whole server** (a lock). This holds CLAUDE.md's "one production release at a time" by design: the 25-Oct-2026 incident was two overlapping deploys.
- **The staging queue and post-deploy checks keep working unchanged.** They watch `/sw.js`'s `VERSION`, which every new build changes. `scripts/release/post-deploy-check.sh` is unchanged.
- **Migrations stay in the GitHub workflows** (`test-db.yml`, `prod-db.yml`, over WireGuard), as today. The build never migrates. `migrate-on-build.mjs` already skips outside GitHub Actions.
- **PR previews** (Hostinger builds one per pull request) stop when the Hostinger sites are retired. Optional later: `pr-<n>.test.gokesari.com` previews on the VPS, with the same slot rules and limits.
- **Keeping old releases:** the last 5 per site, for an instant rollback with `gk-deploy rollback <site>`, which repoints `current` to `previous`.

## 5. Room for more websites (generic, per the owner's request)

The server is set up so that **any later website is added as one more slot**, without touching GoKesari's slots:

1. **`gk-site add <name> --domain <d> [--domain <d2>] --repo <owner/repo> --branch <b> --node <ver> --mem <GiB> --cpu <percent>`** creates:
   - the user and `/srv/sites/<name>`;
   - the systemd units and the env file (empty, mode 600);
   - the Caddy block (certificates are automatic once DNS points here);
   - the deploy-agent entry and the healthchecks.io slugs.
2. **A database, if the site needs one:**
   - Its own **PostgreSQL role and database**, with no rights on GoKesari's databases; or, for full separation, its own **instance on its own port**, as staging has today.
   - Its backups join pgBackRest and the nightly dumps the same way.
3. **Its own WireGuard peer and SSH command** if a workflow needs them (the `gk-peer` table).
4. **The site's own owner checklist:** DNS records, e-mail, payment-gateway domain and IP whitelists.

**Rules for sharing the server:**
- **Headroom:** keep at least **30 % CPU and 4 GiB RAM free** at the busiest hour, measured over a week (section 8), before adding a site. If not, move to a bigger VPS (Hostinger's KVM 8 is a resize, not a rebuild) or a second VPS.
- **Isolation:**
  - A site can read only its own folder, env file and database.
  - Caddy keeps one access log per site.
  - One site's crash, memory leak or build can't take GoKesari's memory (`MemoryMax`) or block GoKesari's deploys (the agent serves sites in turn, so a site stuck building gives up after 20 min).
- **Shared fate:** every site on the server goes down with the server. That risk is accepted per site by its owner.
- **Planning a specific site happens in that project's own chat**, using these steps. Per CLAUDE.md's scope rule, this GoKesari plan covers no other project's site.

## 6. Monitoring, logs and backups

- **healthchecks.io (e-mail, decision 5):**
  - `gk-app-<site>`: an HTTP check every 5 minutes from the VPS, on the home page and an API.
  - `gk-deploy-<site>`: each deploy's success or failure.
- **An outside view:** a free external uptime monitor (for example UptimeRobot), which the owner creates. It warns when the whole VPS is unreachable, which the VPS can't report itself.
- **Logs:**
  - journald for each service, kept 14 days;
  - Caddy access logs per site, rotated daily, kept 14 days.
- **Backups:**
  - The apps hold no data of their own: files are in the database, and the code is in GitHub.
  - The env files are copied, age-encrypted, with the nightly dump (the Mac pulls them).
  - The databases keep their existing backups and drills.
- **`gk-db-health`** gains: free memory per slot, build failures, Caddy certificate expiry (Caddy renews 30 days ahead).

## 7. Steps

**Gates (each needs the owner's OK at the time, as for the database move):** H1 build the web layer, H2 staging switch, H3 production switch, H4 retire Hostinger's app hosting.

### Phase A: decisions (owner)
Section 11 lists them. The main ones: the CDN, the Hostinger plan (because of e-mail), and the windows.

### Phase B: build the web layer (no site changes) — gate H1
1. Node 24 (NodeSource, pinned), Caddy (official repo), `git`. Users, folders, limits, units: `scripts/vps-app/` (a new kit like `scripts/vps-db/`).
2. Firewall: allow **80/443** from anywhere (ufw and Hostinger's VPS firewall).
   - Today port 80 is opened only during certificate renewals.
   - The `db`/`db-test` certificate moves to Caddy's ACME, or certbot switches to Caddy's webroot.
3. A read-only GitHub **deploy key** for the repository (owner adds it in GitHub → Settings → Deploy keys).
4. `gk-site add gokesari-staging …` and `gk-site add gokesari-prod …`.
5. **Env files.** API reads come back masked (`********`), so the values must come from the owner. Options:
   - (a) The owner pastes each value into a hidden prompt on the server: `sudo gk-site env set <site> <KEY>`, the same way the healthchecks key was entered.
   - (b) The owner runs, on the hosting server, a one-line export of the running app's environment, piped over SSH straight into the VPS file. Never through chat or GitHub.
   - Then `DATABASE_URL` becomes the local socket form.
   - Retired split-era keys are left out: `SELLER_DATABASE_URL`, `DB_SPLIT_MODE`, `PROD_*_DATABASE_URL`, `TEST_DATABASE_*` and `TEST_NEON_API_KEY`.
6. First build of each site on the VPS. Test it through a temporary name, `vps-test.gokesari.com`, or a hosts-file entry. **The same database is behind it**, so on production only read-only checks are run.
7. Move the 6 cron lines into systemd timers on the VPS, created **disabled**. They're switched over at each site's cut-over (step C3, D3), so each job runs in one place only.

### Phase C: staging switch — gate H2 (about 30 min, no read-only time)
1. Guest + signed-in QA against the VPS build through the temporary name. Cashfree sandbox payment (`sandbox-pay.yml`).
2. DNS: `test.gokesari.com` A → 189.72.155.162, AAAA → 2a02:4780:63:ebe::1 (TTL 60). Caddy gets its certificate within a minute.
3. Staging cron: hPanel's three test lines off, the VPS timers on.
4. Post-deploy check; the staging queue's next PR proves the deploy path.
5. Watch for 3 days: deploy success, memory, response times.

### Phase D: production switch — gate H3 (about 30 min, no read-only time)
**Before:**
- Third-party allowlists include the VPS's outgoing IP **189.72.155.162**:
  - Cashfree Payouts two-factor IP whitelist (only if payouts use Cashfree);
  - Cashfree Verification (not needed while `CASHFREE_VERIFICATION_PUBLIC_KEY` signing is used);
  - HDFC SmartGateway, if it allowlists IPs;
  - Sandbox.co.in KYC, if it does;
  - the Google Maps server key, if it is IP-restricted.
- Cashfree's domain whitelist (`gokesari.com`, `www`) is unchanged.

**Steps:**
1. Last build of `main` on the VPS; read-only checks through the temporary name.
2. DNS: `gokesari.com` A/AAAA → the VPS; `www` CNAME → an A/AAAA record. Avoid :47 and 05.00 IST.
3. Production cron: hPanel's lines off, the VPS timers on (same minute).
4. Post-deploy check (5 rounds), guest QA, one small real order by the owner, the first Cashfree webhook landing.
5. The mobile apps call `https://gokesari.com/api/…` and follow DNS. Nothing to release.
6. Watch for 24 hours closely, then for 14 days.

### Phase E: retire Hostinger's app hosting — gate H4 (14 days after D)
1. Stop the Hostinger Node.js apps; keep a final copy of their environment variables encrypted on the Mac.
2. Decide the hosting plan: keep it for e-mail, or move e-mail to a Hostinger Email-only plan. **Don't cancel anything that carries the mailboxes.**
3. **Close public 5432/5433** (ufw, Hostinger firewall, `pg_hba.conf`). The apps are local now, and the Mac and GitHub use WireGuard. Remove the 93.127.208.167 rules.
4. Docs: CLAUDE.md (release rules: "Hostinger build" → "VPS deploy"), DEPLOYMENT.md, the staging-queue README, this plan's record.

## 8. Capacity check (before H3, and before any later site)

- **Measure:** a week of production on the VPS. Peak CPU, memory per slot, p95 response time (Caddy logs), database connections.
- **Load test:** `tests/Load_Testing/` against the **staging** slot only, never production. Confirm production keeps its p95 while staging is under load.
- **Upgrade trigger:** sustained CPU over 70 %, or under 4 GiB free RAM at peak → resize to KVM 8 (a Hostinger plan change; short reboot), or put the apps on a second VPS.

## 9. Risks

| Risk | Effect | Mitigation |
|---|---|---|
| **One server for app + data** | Server lost → site and data down together | Hostinger weekly VPS backup; nightly encrypted dumps on the Mac; rebuild kit (`scripts/vps-db`, `scripts/vps-app`); restore 1–2 h. Optional later: a second small VPS as a warm standby. |
| **No CDN / DDoS screen** | Traffic spikes or attacks reach the VPS directly | Caddy rate limits on login and OTP routes. Decision 1: Cloudflare (free) in front. Hostinger VPS firewall. |
| Build starves the database | Slow site during a deploy | `gk-build` CPU and memory limits, `nice`, one build at a time. |
| Masked env values | Can't copy settings by API | Owner-entered (B5); checked by a test build before the switch. |
| Third-party IP allowlists | A payout or KYC call refused after the switch | Phase D "before" list; the admin bank-check card shows the outbound IP. |
| E-mail tied to the hosting plan | Mailboxes lost if the plan is cancelled | Phase E step 2: decide before cancelling anything. |
| Cron runs twice or not at all | Duplicate or missed jobs | Switch them in the same minute as DNS; `flock` on both sides; avoid :47 and 05.00. |

## 10. Rollback

- **Phases C and D:** point DNS back to Hostinger's records (written down before the change), and switch the cron lines back. The Hostinger sites kept deploying from GitHub the whole time, so they run the same code. There is no data to move: both used the same database. About 5 minutes.
- **After E:** the Hostinger apps are stopped. Rollback means restarting them (they keep their files) and pointing DNS back. Keep them for 14 days before stopping.

## 11. Decisions for the owner

**Decided by the owner, 17-Nov-2026, about 06.20 IST:**

| # | Decision |
|---|---|
| 1 | **No CDN.** |
| 2 | **Keep the Hostinger web hosting plan** (e-mail stays on it). |
| 3 | **Builds on the VPS.** |
| 4 | **Env values exported once per site, piped straight from the running Hostinger app into the server's root-only env file** (owner's change at about 06.34 IST; first chosen: hidden prompts, 4a). Values never shown, saved on the Mac or put in chat; only key names are printed. |
| 5 | Windows: *not yet given*. |
| 6 | **Outside uptime monitor: yes, as soon as possible** (UptimeRobot free; the owner creates the account). |
| 7 | **Later sites: yes, each planned in its own project's chat.** |

The options as first written:

1. **CDN:** none for now (simplest; users in India, VPS in Mumbai), or **Cloudflare free** in front (DDoS screen, caching; DNS moves to Cloudflare). *Recommended:* none at first, Cloudflare if traffic or attacks call for it.
2. **Hostinger web hosting plan after the move:** keep it (e-mail stays as is, about the same cost) or switch to e-mail-only. *Recommended:* keep until a separate e-mail decision.
3. **Builds:** on the VPS (recommended; independent of Hostinger and of GitHub Actions minutes), or in GitHub Actions with the result shipped to the VPS.
4. **Env values:** typed into hidden prompts on the server (4a), or exported from the hosting server by the owner (4b).
5. **Windows:** staging switch (H2) and production switch (H3); a quiet hour with the owner present.
6. **Outside uptime monitor:** UptimeRobot (free) or none.
7. **Later sites:** each one planned in its own project's chat, using section 5.

## 12. Effort

| Phase | Session time | Owner time |
|---|---|---|
| B: web layer + kit + first builds | about half a day | deploy key; env values (about 30 min) |
| C: staging switch + watch | 30 min, then 3 days of watching | DNS change (or the session with OK) |
| D: production switch | 30 min | allowlists; DNS; a small real order |
| E: retire | 30 min after 14 days | hosting-plan decision |
