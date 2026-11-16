# GoKesari: moving the databases off Neon onto our own PostgreSQL server (VPS)

**Plan, 16-Nov-2026, 13.45 IST.** Scope: gokesari.com (production) and test.gokesari.com (staging) only.
Owner's copy: `Doc_GoKesari/Devlopment_Trackers/GOKESARI_NEON_TO_VPS_PLAN_2026-11-16.md`.

**This is the plan, not the move.** Nothing has been bought, created, changed or deleted. The only commands run against the databases were read-only queries (section 2). Each of these steps waits for the owner's explicit OK when it is reached:
- buying the VPS;
- changing any site's settings;
- touching production;
- deleting a Neon project.

**Updated 16-Nov-2026, 16.45 IST:**
- **Decision 1 is made.** The owner said "Yes, KVM 2" at about 15.45 IST.
- **KVM 2 prices are confirmed** from Hostinger's catalogue (sections 1, 3.2, 9 and 11).
- **The Phase 1 build kit is written:** `scripts/vps-db/` and [RUNBOOK.md](RUNBOOK.md).
- **Two findings, added to sections 4.6 and 7 A3:**
  - `copy.sh` refuses to copy into a database with a different name;
  - "Copy shops" needs a fourth WireGuard key.

**Updated 16-Nov-2026, 21.30 IST:**
- **Decision 1 changed:** the owner bought **KVM 4** instead of KVM 2:
  - 4 vCPU, 16 GB, 200 GB NVMe;
  - ₹26,376 for 24 months, about ₹31,123 with GST;
  - renews at ₹2,399 a month.
- **Why:** the GoKesari app can move onto the same server later. Sizing: `Doc_GoKesari/Devlopment_Trackers/GOKESARI_VPS_SIZING_KVM2_vs_KVM4_2026-11-16.md`.
- **Unchanged:** the kit and the PostgreSQL settings. Sections 1, 3.2, 9 and 11 still show the KVM 2 figures.
- **Location:** the VPS was first set up in **Kuala Lumpur**. The owner moved it to **Mumbai** while it was empty; checked at 21.44 IST. New IPv4: 189.72.155.162.

---

## 1. Summary

- **Recommendation:** one **Hostinger KVM 2 VPS in Mumbai**.
  - Hardware: 2 vCPU, 8 GB RAM, 100 GB NVMe.
  - Software: Ubuntu 24.04 LTS and **PostgreSQL 18**.
  - Layout: **two separate PostgreSQL instances**, production on port 5432 and staging on port 5433. Each has its own settings, users, backups and limits.
- **Cost** (confirmed 16-Nov-2026, 15.45 IST):
  - **₹779 a month** on a 24-month term: ₹18,696 for the 24 months, about **₹22,061 with 18 % GST**, paid upfront.
  - Renewal: ₹28,776 per 2 years, which is ₹1,199 a month, plus GST.
  - Neon costs about **₹1,900–2,250 a month** today.
  - Saving: **about ₹1,120–1,470 a month** for the first two years, and about ₹700–1,050 a month after renewal.
- **Side benefits:**
  - The database sits in Mumbai next to the app, not in Singapore. A query round trip should drop from about 55–65 ms to a few ms (to be measured in Phase 1). Pages that run many queries one after another will get faster.
  - The data stays in India.
- **What it costs us in effort:** we run the server ourselves: backups, updates, monitoring and security.
  - Routine work: about 1 hour of the owner's time a month. Claude sessions do the hands-on work from scripts and a runbook.
  - The move itself: about 4–6 hours of the owner's time.
- **Order of work:**
  1. Owner decisions (section 11).
  2. Buy and build the server.
  3. Staging cut-over.
  4. 7 days of watching staging.
  5. Production cut-over.
  6. Keep the Neon projects frozen for 14 days (staging) and 30 days (production).
  7. Delete them, each on the owner's OK.
- **Expected production downtime:**
  - About **20–30 minutes read-only**. Browsing works; new orders, payments, sign-ups and sign-ins wait.
  - **Under 1 minute** fully down, while the app restarts.

---

## 2. What we have today

Read-only checks on 16-Nov-2026, 13.29 IST, on the two GoKesari Neon projects only:
- production: GoKesari-prod-sg `lively-frost-99365966`, endpoint `ep-calm-salad-ao1homrr`;
- staging: GoKesari-test-sg `curly-night-16641982`, endpoint `ep-hidden-star-b3k0l6ih`.

The staging query woke staging's compute for its usual 5 minutes, which cost well under ₹1.

| | Production | Staging |
|---|---|---|
| PostgreSQL | 18 (Neon build "18.7") | 18 (same) |
| Database | `neondb`, **56 MB** (about 24 MB of our data; the rest is PostgreSQL's own catalogue) | `neondb`, **141 MB** (about 111 MB of our data) |
| `pg_dump -Fc` size | 4.1 MB | 18 MB |
| Tables | 451 | 462 |
| Schemas | `public`, `pmd`, `drizzle` | the same, plus two old `backup_*` schemas (272 KB) |
| Biggest tables | document uploads (1.1 MB), rider documents, shops, audit log | notification deliveries (14 MB), notifications, audit log (11 MB each), domain events, stored images |
| Extensions | `btree_gin` 1.3, `pg_stat_statements` 1.12, `pg_trgm` 1.6, `plpgsql`, `postgres_fdw` 1.2 (installed, **unused**: no foreign servers) | the same |
| Encoding, collation | UTF8, `C.UTF-8` (libc) | the same |
| Server time zone | GMT | GMT |
| Login role the app uses | `neondb_owner` (owns every object) | the same |
| Neon's own roles (not moved) | `cloud_admin`, `neon_service`, `neon_superuser`, `token_roles` | the same |
| App connections now | 4–6 (`postgres.js`), direct (not through Neon's pooler) | 0 (asleep) |
| Load | about 5 transactions/s on average (123,188 commits in 6 h 49 min). Compute stays at Neon's 0.25 CU floor, that is under ¼ of a CPU. | low, bursts during tests |
| Row-level security, event triggers, publications | none | none |

**Where the app runs: Mumbai.**
- Both sites answer through Hostinger's CDN edge in Mumbai (`x-hcdn-request-id … -mum-edge15` / `-mum-edge10`).
- Their public addresses all belong to Hostinger (AS47583) in Mumbai:
  - gokesari.com: 91.108.106.180 and 93.127.173.160;
  - test.gokesari.com: 93.127.173.15 and 147.79.69.112.
- The 28-Oct region-move record ([docs/db-region-move-2026-10/PLAN.md](../db-region-move-2026-10/PLAN.md)) also says the Node.js app runs on Hostinger in Mumbai.
- These CDN addresses are **not** the address the app server connects out from. The firewall needs that address; step B2 finds it.

---

## 3. The server

### 3.1 Size

| Need | Today | Room for growth |
|---|---|---|
| CPU | production uses under 0.25 vCPU around the clock | 2 vCPU: production gets the whole server, staging is capped at 1 vCPU |
| Memory | both databases together are about 200 MB | 8 GB: production's whole database stays in memory for years |
| Disk | about 200 MB of data, plus WAL and local backups | 100 GB NVMe. A generous year-1 estimate is 1–5 GB of data, mostly shop documents and images, which are stored in the database. Local backups and WAL add 5–15 GB. Alert at 70 % full. |

KVM 1 (1 vCPU, 4 GB, 50 GB) would carry today's load. KVM 2 costs about ₹180 a month more and gives room for:
- staging on the same server;
- load tests (`tests/Load_Testing`);
- backups running beside live traffic;
- a year or two of growth without a resize.

### 3.2 Options and prices

All prices are per month, excluding 18 % GST, at ₹87 to the dollar (the rate the 16-Nov cost-cut report used).

**Chosen: KVM 2, 24-month term.** The owner decided on 16-Nov-2026 ("Yes, KVM 2").

KVM 2 prices were confirmed from Hostinger's catalogue on 16-Nov-2026 at 15.45 IST (item `hostingerin-vps-kvm2-inr-2y`; Mumbai is VPS data centre id 23, `mum2`). All exclude 18 % GST:

| Term | First term | Renewal |
|---|---|---|
| **24 months (chosen)** | **₹18,696** (₹779 a month); with GST about **₹22,061**, paid upfront | ₹28,776 per 2 years (₹1,199 a month) |
| 12 months | ₹11,148 (₹929 a month) | ₹16,788 a year (₹1,399 a month) |
| Monthly | ₹1,299 for the first month | ₹2,099 a month |

The other options below were not re-checked on 16-Nov at 15.45 IST.

| Option | Specs | Where | ₹ a month | Notes |
|---|---|---|---|---|
| **Hostinger KVM 2 (chosen)** | 2 vCPU, 8 GB, 100 GB NVMe | Mumbai | **₹779** on a 24-month term; **₹1,199** on renewal | Same provider and city as the app. Free weekly VPS backup and a snapshot are included. Paid upfront: ₹18,696 + GST ₹3,365 = **₹22,061**. |
| Hostinger KVM 1 | 1 vCPU, 4 GB, 50 GB | Mumbai | ₹599 → about ₹999 | Enough today, little headroom |
| Hostinger KVM 4 | 4 vCPU, 16 GB, 200 GB | Mumbai | ₹1,099 → about ₹2,399 | More than needed |
| AWS Lightsail 2 GB | 2 vCPU burstable (20 % baseline), 2 GB, 60 GB | Mumbai | $12 ≈ ₹1,044 | Hourly billing, no upfront payment |
| AWS Lightsail 4 GB | 2 vCPU burstable, 4 GB, 80 GB | Mumbai | $24 ≈ ₹2,088 | As much as Neon today |
| DigitalOcean Basic | 2 vCPU, 4 GB, 80 GB | Bengaluru | $24 + $4.80 weekly backups ≈ ₹2,506 | Not Mumbai (about 15–25 ms away). No saving. |

Hostinger's India prices change often, and different sources quote different renewal figures. The KVM 2 figures come from Hostinger's own catalogue. The others are the most widely quoted figures (see Sources).

### 3.3 Region

Use **Hostinger VPS, India (Mumbai)**, picked when the VPS is created. Hostinger says the location is fixed once the VPS is set up.

In Phase 1, measure the round trip from the Hostinger SSH shell to the VPS:
- **target: under 5 ms**;
- over 15 ms: stop and reconsider before going on.

### 3.4 Staging: same server or a separate one

| Option | Cost a month | For | Against |
|---|---|---|---|
| **A. Same VPS, separate PostgreSQL instance (recommended)** | ₹0 extra | Staging runs exactly the production setup (version, settings, firewall, backups, workflows), so staging tests the move and every later change. Neon's charges stop altogether. | A heavy staging test could slow production. Prevented by capping staging (1 vCPU, 2 GB memory, its own connection limit). |
| B. Keep staging on Neon | about $2–6 ≈ ₹170–520 | No work for staging; Neon branches stay | The Neon bill is not zero. Staging no longer matches production, so production's move gets no full rehearsal. `test-db.yml` keeps two code paths. |
| C. Separate small VPS | +₹599–999 | Full isolation | More cost, two servers to patch and watch |
| D. Neon Free plan | ₹0 | Fits staging's size and hours | A Neon plan covers a whole Neon organisation, so staging would need a free organisation of its own and a project transfer. Neon stays in the stack, staging no longer matches production, and the free plan has a shorter restore window. Not recommended. |

**Why staging used to be put to sleep:** on Neon, staging's every-minute cron kept the compute awake and billed. On our own server there is no per-minute compute charge. Staging's every-minute cron line can go back to every minute, so tests no longer wait up to 6 hours for timeouts and retries (decision 7).

---

## 4. PostgreSQL setup

### 4.1 Software

- **Ubuntu 24.04 LTS**, minimal install.
- **PostgreSQL 18** from the PostgreSQL project's own apt repository (apt.postgresql.org), latest 18.x minor release. Ubuntu's own packages stop at 16.
- `pg_trgm`, `btree_gin`, `pg_stat_statements` and `postgres_fdw` all come with the server package.
- **pgBackRest** from the same repository, for backups.
- New PostgreSQL 18 data directories have **data checksums on** by default; keep that.

### 4.2 Two instances on one server

Created with Ubuntu's `pg_createcluster`:

| | Production (`18/main`) | Staging (`18/staging`) |
|---|---|---|
| Port | 5432 | 5433 |
| Host name (DNS A record → the VPS) | `db.gokesari.com` | `db-test.gokesari.com` |
| Database | `gokesari` (decision 6; or keep `neondb`) | `gokesari_test` |
| App login role | `gokesari_app` | `gokesari_test_app` |
| Memory: `shared_buffers` / `effective_cache_size` | 1 GB / 4 GB | 256 MB / 1 GB |
| `max_connections` | 100 | 60 |
| Limits (systemd drop-in for `postgresql@18-staging`) | none | `CPUQuota=100%` (1 vCPU), `MemoryMax=2G` |
| WAL archiving | on, `archive_timeout = 300 s` | on, `archive_timeout = 600 s` |

**Why two host names for one server.** `scripts/prod-db/guard.sh` refuses to run when the production host is the test host. Distinct names keep that guard working with no code change. Section 7 also adds the port to the check.

The names keep `DATABASE_URL` independent of the server's IP address: moving to another server later is a DNS change.

### 4.3 Settings

**Must match Neon, so the app behaves the same:**

| Setting | Value | Why |
|---|---|---|
| Encoding / locale | `UTF8`, `C.UTF-8` | Same sort order and text handling as now |
| `timezone` | `GMT` | Neon runs in GMT; date maths in SQL must not shift |
| `log_timezone` | `Asia/Kolkata` | Log lines in IST for the owner; does not affect queries |
| `default_transaction_isolation` | `read committed` | As Neon |
| `idle_in_transaction_session_timeout` | 5 min | As Neon |
| `statement_timeout` | 0 | As Neon |
| `shared_preload_libraries` | `pg_stat_statements` | Neon has it; slow-query reports use it |

**Tuning for this server** (production instance):
- `work_mem` 8 MB;
- `maintenance_work_mem` 256 MB;
- `random_page_cost` 1.1 and `effective_io_concurrency` 200 (NVMe);
- `max_wal_size` 2 GB, `min_wal_size` 256 MB;
- `checkpoint_completion_target` 0.9;
- `wal_compression` zstd;
- `tcp_keepalives_idle` 60 s, so dead connections from Hostinger are noticed;
- `temp_file_limit` 5 GB;
- logging: `log_min_duration_statement` 500 ms, `log_lock_waits` on, connections logged for the first 30 days.

### 4.4 Extensions

- Create `pg_trgm`, `btree_gin` and `pg_stat_statements` in each new database **before** the copy. `scripts/db-region-move/copy.sh` restores everything except extensions, and it stops if the target lacks any extension the source has.
- `pg_trgm` and `btree_gin` are also created by migrations 0015 and 0087 (`IF NOT EXISTS`), so CI and new databases get them anyway.
- **`postgres_fdw`:** left over from the retired seller/customer split; nothing uses it (no foreign servers, no foreign tables). Two ways to handle it:
  - **Recommended:** drop it on both Neon databases before the move, in a one-line migration through the staging queue (`DROP EXTENSION IF EXISTS postgres_fdw;`). Then every environment matches and `compare.sh` passes.
  - Otherwise: create it on the VPS too and drop it later.

### 4.5 Roles

| Role | Instance | Rights | Used by |
|---|---|---|---|
| `postgres` | both | Superuser. **Local socket only** (`peer`), never over the network | Server admin, pgBackRest |
| `gokesari_app` | production | Owns database `gokesari` and every object in it. Not superuser; cannot create roles or databases. Connection limit 60. `EXECUTE` on `pg_create_restore_point` | The app (`DATABASE_URL`), `prod-db.yml`, `copy-shops.yml` |
| `gokesari_test_app` | staging | The same, for `gokesari_test`; limit 40 | Staging app, `test-db.yml` |
| `gokesari_ro` / `gokesari_test_ro` | each | `pg_read_all_data`, limit 5 | Owner's own queries, reports, QA checks |
| `monitor` | each | `pg_monitor`, local socket only | Health-check script |

- Like `neondb_owner` today, the app's role owns the schema. The migrations run with `DATABASE_URL`, so the app needs to own the objects. Splitting the app and migration roles would need code and workflow changes; it is not part of this move.
- The copy restores with `--no-owner --no-privileges` while connected as the new owner role, so it ends up owning everything.
- `BYPASSRLS` is not needed: no table uses row-level security.

### 4.6 Network, firewall and TLS

**Firewall:** Hostinger's VPS firewall (network level) plus `ufw` on the server, the same rules in both. Everything not listed is closed.

| Port | Open to | For |
|---|---|---|
| 5432/tcp | the Hostinger app server's outgoing IP address(es) only | gokesari.com → production |
| 5433/tcp | the same | test.gokesari.com → staging |
| 51820/udp | anywhere | WireGuard VPN. It does not answer packets without a valid key, so the port looks closed. |
| 22/tcp (SSH) | the WireGuard network only | Admin. If WireGuard breaks, use Hostinger's browser terminal. |
| 80/tcp | nobody; opened for about a minute by the certificate-renewal hook | Let's Encrypt |

**GitHub Actions:**
- Cannot be allowed by IP address. GitHub-hosted runners use thousands of shared, changing Azure address ranges, and GitHub advises against allow-listing them.
- Instead, each workflow job that touches a database starts with a **WireGuard step** using a key of its own, kept as a secret on its GitHub environment (`test` or `production`). There are four such jobs, because `copy-shops.yml` has two: "export" reads the test database in the `test` environment, and "copy" writes production in the `production` environment.
- On the server, each key may reach only its own instance, plus SSH for the restricted snapshot command:
  - the `test-db` key: port 5433, plus SSH;
  - the `copy-shops` export key: port 5433 only;
  - the `prod-db` and `copy-shops` copy keys: port 5432, plus SSH.
- The addresses and ports are in [scripts/vps-db/lib.sh](../../scripts/vps-db/lib.sh).
- The runner adds `/etc/hosts` lines, so the URLs keep their public names (`db.gokesari.com`, `db-test.gokesari.com`). TLS names and the host guards then still match.
- The owner's Mac gets its own WireGuard key, for `psql`, TablePlus or pgAdmin. These replace Neon's SQL editor.

**`pg_hba.conf`** for production (staging is the same with its own names):
```
# TYPE   DATABASE  USER          ADDRESS               METHOD
local    all       postgres                            peer
local    all       monitor                             peer
hostssl  gokesari  gokesari_app  <hostinger-ip>/32     scram-sha-256
hostssl  gokesari  gokesari_app  10.66.0.0/24          scram-sha-256   # WireGuard: GitHub peers, owner's Mac
hostssl  gokesari  gokesari_ro   10.66.0.0/24          scram-sha-256
# No plain "host" lines: every network connection must use TLS.
```

**Passwords:**
- `scram-sha-256` (`password_encryption = scram-sha-256`), 32+ random characters.
- Kept in the owner's password manager, Hostinger's environment variables and GitHub secrets only.

**TLS:**
- A Let's Encrypt certificate for both names, `ssl_min_protocol_version = TLSv1.2`.
- A renewal hook copies the certificate to both instances and reloads them.
- **Today `sslmode=require` encrypts the connection but does not check the certificate.** postgres.js treats `require` as "encrypt, don't verify" (`node_modules/postgres/src/connection.js`). Recommended small change (section 7, item A4): accept `sslmode=verify-full` in the app. The app will then refuse a server that is not really `db.gokesari.com`.

**Finding the Hostinger outgoing IP (step B2):**
1. In hPanel's SSH terminal for each site, run `curl -s https://ifconfig.me`. Both sites share one hosting account, so it is probably one address. Check both.
2. Confirm from the same shell, using the deployed app's own `postgres` package, with a one-off `node -e` that connects to the VPS and prints `inet_client_addr()`. This also proves that the firewall, TLS and password work before any site setting changes.

If Hostinger ever changes that address (for example after moving the account to another server), the site loses its database until the firewall is updated. A rejected-connection alert and a 5-minute runbook step cover it (section 6.1).

### 4.7 Connections and pgBouncer

- **Today:** 4–6 app connections on production.
- **Pools per Node.js process:**
  - main pool: up to `DATABASE_POOL_MAX` (default 10);
  - product-master pool (`src/server/pmd/db.ts`): up to 5.
- **Worst case:** about 30 connections per site while two app processes overlap during a deploy, plus workflows, backups and monitoring.
- **Limits:**
  - production: `max_connections` 100, `gokesari_app` limited to 60;
  - staging: 60 and 40;
  - `superuser_reserved_connections` 3 on each.
- **pgBouncer: not needed.** Reasons:
  - The app already pools.
  - Connection counts are small and bounded.
  - pgBouncer's transaction mode would break the migrator's session lock (`pg_advisory_lock` in `src/server/db/migrate.ts`) and the optional prepared statements (`DATABASE_PREPARED_STATEMENTS`).
  - Revisit only if connections pass about 150 or the app runs many instances.
- **`DATABASE_IDLE_TIMEOUT_SECONDS`:** tuned for Neon's sleep and billing. On our server, idle connections cost nothing.
  - The 60 s code default is fine.
  - The Hostinger variable can be removed, or raised to 300 to keep the pool warm. Optional.

---

## 5. Backups and restore

This replaces Neon's branches and restore history.

### 5.1 Layers

| # | What | When (IST) | Where | Kept |
|---|---|---|---|---|
| 1 | **pgBackRest + continuous WAL archiving (point-in-time restore).** Full backup weekly, differential daily; WAL archived continuously. | Full: Sunday 02.30. Differential: other days 02.30. WAL: every change, at least every 5 min on production. | **repo1:** the VPS's own disk (`/var/lib/pgbackrest`). **repo2:** off-site in Cloudflare R2 (decision 3), **encrypted** by pgBackRest (`aes-256-cbc`). | repo1: 2 full backups ≈ **14 days**. repo2: 5 full backups ≈ **35 days**, restorable to any second inside them. |
| 2 | **Nightly `pg_dump -Fc`** of each database. Portable and readable with `pg_restore --list`. | Production 02.15, staging 02.45 | VPS disk, plus R2 encrypted with `age`. The key that can read them is **only** in the owner's password manager and on the Mac, not on the VPS. | VPS: 7 days. R2: daily dumps 35 days, monthly (1st) dumps 12 months. Staging: 14 days. |
| 3 | **Before every migration:** a dump of that database, made on the VPS, plus a named restore point (`pg_create_restore_point('<run name>')`). It replaces Neon's `auto-backup-*` branches. | Each `test-db.yml` / `prod-db.yml` / `copy-shops.yml` change run | VPS disk, through a restricted SSH command (below). No data goes to GitHub. | Newest **5** per database, as today |
| 4 | **Weekly copy to the owner's Mac** of the latest production and staging dumps | Monday morning | `Doc_GoKesari/Devlopment_Trackers/neon_backups/`, or a new `db_backups/` folder | Owner's choice |
| 5 | Hostinger's free weekly VPS backup | Weekly (Hostinger) | Hostinger | Last resort only: same provider as the server |

**The restricted SSH command (layer 3):** each workflow has an SSH key that can run only one command, for example `gk-db-snapshot test <name>`. The `authorized_keys` options are `command=…,no-pty,no-port-forwarding`. The command dumps that one database on the VPS and keeps the newest 5. "Production data never leaves the database" ([PROD_DB.md](../event-driven-2026-10/PROD_DB.md)) stays true.

**Off-site storage size:** production's full backup is about 5–10 MB compressed, and WAL at a 5-minute switch is roughly 30 MB a day compressed. Production and staging fit well inside R2's free 10 GB.

### 5.2 How much data a failure can lose, and how long recovery takes

| Event | Data lost | Time to recover |
|---|---|---|
| Bad migration or wrong data written | none: restore to the restore point or the minute before | 15–30 min |
| PostgreSQL crash | none | minutes (restarts on its own) |
| VPS or its disk lost | **≤ 5 minutes** (the last WAL not yet archived) | **1–2 hours:** new VPS from the build scripts, restore from R2, change the DNS |
| Hostinger Mumbai outage | none | The app is down too. Wait, or restore elsewhere in 1–2 hours. |
| R2 lost or its key leaked | none | Rotate the key, rebuild repo2 at the next full backup |

### 5.3 Restore drills

**Monthly, first Monday, 11.00 IST.** A session runs `scripts/vps-db/restore-drill.sh`:
1. Restore production from **repo2 (R2)** to the time "1 hour ago", into a scratch instance on port 5499 on the VPS.
2. Run `pg_amcheck` and the wallet-ledger checks in [DEPLOYMENT.md §7](../../DEPLOYMENT.md). Both must return no rows.
3. Count the rows of the main tables and compare them with the live database.
4. Restore the latest `pg_dump` into a scratch database.
5. Record the backup's age, how long the restore took and the result in `Doc_GoKesari/Test_Cases_Tracking/GOKESARI_DB_RESTORE_DRILLS.xlsx`.
6. Drop the scratch copies.

**Quarterly:** the same from R2 only, onto a machine that is not the VPS (the owner's Mac, or a Lightsail instance rented for an hour or two, a few rupees). This proves the backups survive losing the server.

**Gate:** the first drill must pass on staging, and then on a rehearsal copy of production, **before** the production cut-over.

### 5.4 What we lose compared with Neon, and what replaces it

| Neon | Replacement |
|---|---|
| Instant branches (a copy of the data in seconds) | Restore the newest dump into a scratch database on the VPS: seconds for 4–18 MB |
| Point-and-click restore to a time | `pgbackrest restore --type=time`, from the runbook. A session runs it. |
| Console SQL editor | `psql`, TablePlus or pgAdmin on the Mac, over WireGuard |
| Neon looks after the server | We do (section 6) |

---

## 6. Running it

### 6.1 Monitoring and alerts

The checks report to **healthchecks.io**. Its free plan has 20 checks; each alerts when a ping is late or reports a failure. Alerts go to email and/or Telegram (decision 5).

| Check | How often | Alerts when |
|---|---|---|
| Both instances up | every 5 min, from `scripts/vps-db/healthcheck.sh` | `pg_isready` or `select 1` fails |
| WAL archiving | the same | `pg_stat_archiver.failed_count` rises, or the last archive is over 15 min old |
| Disk | the same | over 70 % (warning) or over 85 % (urgent) |
| Memory, CPU | the same | over 90 % for 15 min |
| Connections | the same | over 70 % of `max_connections`; any connection rejected by `pg_hba` or the firewall (catches a changed Hostinger IP) |
| Nightly dump, pgBackRest backup (production and staging) | each run pings on success | no ping by 04.00 IST |
| TLS certificate | daily | under 14 days to expiry |
| Site | `scripts/release/post-deploy-check.sh` after deploys, as today; plus a free uptime monitor on https://gokesari.com | page down |

Slow queries go to the PostgreSQL log (over 500 ms) and `pg_stat_statements`. A session reviews them monthly.

### 6.2 Updates

- **Ubuntu security updates:** daily, automatic (`unattended-upgrades`), **without** automatic reboot.
- **PostgreSQL minor releases** (usually February, May, August and November): held back from automatic updates.
  - A session applies them in the monthly window: staging first, then production a day later.
  - About 10 seconds of reconnects per instance.
- **Reboots** (kernel updates): monthly window, Sunday 03.00–03.30 IST, only if needed; about 1–2 minutes down. Not the 02.15–03.00 backup slot, and not the 05.00 IST daily cron.
- **Major upgrade** (PostgreSQL 19): not before 19.2. Staging first, with `pg_upgrade`. Planned as a separate change.

### 6.3 Disk-full protection

- Alerts at 70 % and 85 % full.
- WAL can pile up when archiving fails. That is the usual way a PostgreSQL disk fills, so it alerts within 15 minutes, and pgBackRest's queue limit (`archive-push-queue-max` 4 GB) lets PostgreSQL keep running even then. Point-in-time restore would have a gap, and the alert says so.
- `max_wal_size` 2 GB; `temp_file_limit` 5 GB per session.
- Logs rotate daily, kept 14 days; the system journal is capped at 500 MB.
- A 2 GB spare file (`/var/lib/postgresql/ballast`) can be deleted in an emergency to free space at once.
- Local backups are pruned by retention. The 5 migration snapshots are pruned by count.

### 6.4 Security

- SSH: keys only, no root login, reachable only over WireGuard. `fail2ban` watches SSH and PostgreSQL login failures.
- PostgreSQL: TLS only; `scram-sha-256`; no superuser over the network; one role per purpose, each with a connection limit.
- Firewall rules as in section 4.6, in both Hostinger's firewall and `ufw`.
- Backups encrypted before leaving the server. The dump key is not on the server.
- Monthly: a session reviews login failures, firewall rejections and `pg_stat_statements`.
- Passwords are rotated:
  - when someone with access leaves;
  - after any suspected leak;
  - otherwise yearly.

### 6.5 Who does what

| Task | Owner | Claude session | Hostinger |
|---|---|---|---|
| Decisions, budget, buying and renewing the VPS, R2 account | **does** | prepares | |
| DNS records, environment variables and restarts in hPanel | **does**, or OKs a session doing it | prepares exact values | |
| Building the server from the scripts | OKs | **does** (SSH over WireGuard) | |
| Cut-overs | OKs the time, present for production | **does** the steps, reports in IST | |
| Alerts | **receives** first; can restart the VPS in hPanel | diagnoses and fixes, from the runbook | hardware, network |
| Monthly updates, drill, review | reads the 1-page result | **does** | |
| Passwords and keys | **keeps** them in the password manager | never stores them in the repository | |

Owner's time: about **1 hour a month** routine, plus **4–6 hours** across the move. A night-time alert still needs someone to act, which is the main operational risk (section 10).

---

## 7. What in the repository depends on Neon, and what changes

**None of these changes is made in this docs PR.** Each lands later in its own PR through the staging queue, at the phase shown.

### A. Tooling, before the staging cut-over

One PR into `staging` (Phase 2). Each workflow change works **with Neon and with the VPS**, so it can merge before anything moves.

| # | File | Today | Change |
|---|---|---|---|
| A1 | `.github/workflows/test-db.yml` | Lines 26–27 and the step "Back up (Neon branch)" (≈151–206). It creates `auto-backup-<date>-run<N>` branches through the Neon API (secret `TEST_NEON_API_KEY`, variable `TEST_NEON_PROJECT_ID`, default `curly-night-16641982`) and keeps 5. Migrations use `TEST_DATABASE_URL`. | Back up the provider's way: Neon branch while `TEST_DATABASE_HOST` ends in `.neon.tech`; otherwise WireGuard + `gk-db-snapshot test <name>` + `pg_create_restore_point`. Add a WireGuard step before any database step. Update the header comments. **Order matters:** the staging queue needs this workflow to pass (`docs/staging-queue/README.md`, row 4). Without this change, the run fails as soon as `TEST_DATABASE_HOST` points at the VPS, and the queue stops. |
| A2 | `scripts/test-db/guard.sh`, `scripts/prod-db/guard.sh`, `scripts/prod-db/tested-on-test.sh` | Compare the host name only | Also compare the port. Refuse when production and test have the same host, port and database. Both databases share one IP address. |
| A3 | `scripts/db-region-move/copy.sh`, `compare.sh` | Written for Neon → Neon (comments; `neon_auth` skipped). **`copy.sh` stops when the database names differ** ("The plan keeps every name"). | Reused for the copy and the comparison, with these changes:<ul><li>Let `copy.sh` copy `neondb` into `gokesari` / `gokesari_test` (decision 6), for example with `ALLOW_RENAME=yes`. Without it, the copy stops at step S3.</li><li>Add `CHECKSUM=yes` to `compare.sh` (an md5 of every table's rows, in order), or a new `scripts/db-vps-move/checksum.sh`.</li><li>Update the comments.</li></ul> |
| A4 | `src/server/db/index.ts` (`resolveSsl`, comments lines 16, 35–37), `src/server/pmd/db.ts` (`resolveSsl`) | `sslmode` maps to `"require"` or `false`; the certificate is never checked | Map `sslmode=verify-full` / `verify-ca` to postgres.js `"verify-full"`. Tests in `tests/integration/pmd-db-url.test.ts`, plus one for the main client. Recommended. |
| A5 | New: `scripts/vps-db/` | — | The server build and operations scripts. No secrets in them. They cover: <ul><li>OS hardening;</li><li>PostgreSQL 18 instances and their `postgresql.conf` / `pg_hba.conf` templates;</li><li>`pgbackrest.conf`;</li><li>WireGuard;</li><li>certificate hook;</li><li>`gk-db-snapshot`;</li><li>nightly dump;</li><li>`healthcheck.sh`;</li><li>`restore-drill.sh`.</li></ul> Plus a runbook, `docs/neon-to-vps-2026-11/RUNBOOK.md`. |
| A6 | New migration (optional) | `postgres_fdw` installed, unused | `DROP EXTENSION IF EXISTS postgres_fdw;` (section 4.4) |
| A7 | `.github/workflows/ci.yml` (line 61), `.github/workflows/qa.yml` (line 100) | `postgres:16` service | `postgres:18`, so CI tests the same major version as production |

### B. Production workflows, released to `main` before the production cut-over

These go through the normal staging → main release, one at a time per CLAUDE.md.

| # | File | Today | Change |
|---|---|---|---|
| B1 | `.github/workflows/prod-db.yml` | Header lines 16–18 and step "Restore point" (≈line 123): "To undo: Neon console → … Restore". Uses `PROD_DATABASE_URL`. | Add a WireGuard step. Before migrating: `gk-db-snapshot prod <run>` + `pg_create_restore_point`. "To undo" points at the runbook's pgBackRest restore. Works with either provider. |
| B2 | `.github/workflows/copy-shops.yml` | Lines 11, 26, 133, 181: "Neon console → SQL editor", "Neon … Restore" | Add a WireGuard step. "SQL" mode tells you to run the SQL with `psql` over WireGuard. Restore text as in B1. |

### C. Text, after each cut-over (docs PRs)

| # | File | Change |
|---|---|---|
| C1 | `CLAUDE.md`: "Neon compute and cron" (lines 47–62); "One database" (`neondb`) | Replace with a "Database server (VPS)" section: hosts, ports, instances, backups, the runbook, what not to change without the owner. Staging's cron line, per decision 7. New database name. |
| C2 | `docs/crontab.txt` (lines 23–26, 36–41, 60–62) | Staging's every-minute line back to `* * * * *` if decision 7 is yes, and the reason |
| C3 | `DEPLOYMENT.md`: §1 Provision PostgreSQL (lines 7–23); §2 `DATABASE_IDLE_TIMEOUT_SECONDS` note (31–33); §4 test-database backup description; line 324 "Neon SQL editor"; §7 Backups (450–470); checklist (531) | The VPS, pgBackRest + R2 + drills, `psql` over WireGuard |
| C4 | `docs/event-driven-2026-10/DB_AUTOMATION.md` (lines 21–28, 69–99) and `PROD_DB.md` (lines 25–26, 43, 51, 77–106) | Secret setup with the VPS host names; backup and restore by snapshot and pgBackRest instead of Neon branches and restore |
| C5 | `scripts/copy-shops/copy-shops.sql.tpl` (lines 5–6, 388), `scripts/copy-shops/to-sql.ts` (lines 3, 46), `scripts/shop-duplicate-report.sql` (line 7), `scripts/rollback-0038.sql` (line 6) | "Neon console / SQL editor / Neon restore" → `psql` over WireGuard; the runbook's restore |
| C6 | `src/lib/env.ts` (comments lines 19, 32–34, 42), `vitest.config.ts` (line 17) | Comments only: no longer Neon |
| C7 | `docs/neon-cost-cut-2026-11/README.md`, `docs/decision-log.md` | "Superseded by the VPS move", and the decision entry |

### D. Settings outside the repository (owner, or a session with the owner's OK)

| Where | Change |
|---|---|
| GitHub `test` environment | `TEST_DATABASE_URL` (secret), `TEST_DATABASE_HOST` = `db-test.gokesari.com`, `TEST_DATABASE_NAME`. New: the WireGuard key for `test-db` and the snapshot SSH key. After retirement: remove `TEST_NEON_API_KEY` and `TEST_NEON_PROJECT_ID`. |
| GitHub `production` environment (and repository level, where set) | `PROD_DATABASE_URL`, `PROD_DATABASE_HOST` = `db.gokesari.com`, `PROD_DATABASE_NAME`, `TEST_DATABASE_HOST`. New: WireGuard keys for `prod-db` and `copy-shops`, the snapshot SSH key. Remove `NEON_API_KEY` and `NEON_PROJECT_ID`, plus the split-era secrets the 16-Nov record already lists. |
| hPanel → each site → environment variables | `DATABASE_URL`. `DATABASE_IDLE_TIMEOUT_SECONDS`: remove or keep (section 4.7). Plus the unused split-era variables already listed on 16-Nov. |
| hPanel → DNS | A records `db` and `db-test` → the VPS's IP address (TTL 300) |
| hPanel → cron (test.gokesari.com) | Every-minute line, per decision 7 |
| Owner's Mac | WireGuard client; `psql` 18 (already 18.6); optionally TablePlus or pgAdmin |

### E. Left as they are

These are historical records: `docs/db-split-2026-10/`, `docs/db-region-move-2026-10/`, `docs/db-fdw-removal-2026-11/`, the `docs/gokesari-audit/` reports, test reports and `docs/testing/qa-runs/*.json`, `RBAC_PLAN.md`, `scripts/pmd/local-pg.ps1`.

`scripts/db-url.mjs` also stays: it strips Neon's `channel_binding`, which is harmless elsewhere.

---

## 8. Cut-over: staging first, then production

### 8.0 Gates (each needs the owner's OK at the time)

| Gate | Before |
|---|---|
| G1 | Buying the VPS and creating the R2 account (owner does both; [G1_OWNER_CHECKLIST.md](G1_OWNER_CHECKLIST.md)) |
| G2 | Building the server (Phase 1) |
| G3 | The staging cut-over (date and time) |
| G4 | The production cut-over (date and time), after 7 good days on staging and a passed drill |
| G5 | Deleting each Neon project |

### 8.1 Phase 1: build the server (no site changes)

Step by step, with the commands: [RUNBOOK.md](RUNBOOK.md) Part 1. The scripts are in [scripts/vps-db/](../../scripts/vps-db/).

1. Owner buys the VPS in Mumbai (Ubuntu 24.04) and adds the `db` and `db-test` DNS records. Owner creates the R2 bucket with two keys: one that can write, and one for restores, kept in the password manager.
2. A session hardens the OS and installs:
   - PostgreSQL 18 with its two instances;
   - pgBackRest with both repositories;
   - WireGuard, with peers for the owner's Mac and the three workflows;
   - the TLS certificate;
   - the health checks.
3. **Step B2:** find and confirm the Hostinger outgoing IP (section 4.6). Measure the round trip; the target is under 5 ms.
4. First backups and the first restore drill, on an empty test database.

### 8.2 Phase 2: tooling PR

The section 7A changes go into `staging` through the queue. Then:
- set the new GitHub secrets for WireGuard and the snapshot keys;
- run "Test database → verify" while still on Neon. The new steps must not break anything.

### 8.3 Phase 3: staging cut-over

Booked window: 60 minutes.

| Step | What | Who |
|---|---|---|
| S0 (day before) | **Rehearsal:** copy live Neon staging to the VPS without freezing it, compare, time each step, then drop and recreate the empty `gokesari_test`. | session |
| S1 | Pause the staging queue (no `ready-for-staging` labels in the window). Check that no test.gokesari.com deploy is running. | session |
| S2 | **Freeze Neon staging:** `alter database neondb set default_transaction_read_only = on;` and end the app's connections. The site turns read-only. | session (Neon, staging only) |
| S3 | Copy, running on the VPS (Singapore → Mumbai): `REQUIRE_FROZEN=yes scripts/db-region-move/copy.sh`. About 2–3 min for 18 MB. | session |
| S4 | `compare.sh` (row counts, sequences, objects, extensions) plus checksums: **must be identical** | session |
| S5 | Freeze the VPS copy too (read-only) until the checks below pass | session |
| S6 | GitHub `test` environment: the new `TEST_DATABASE_URL`, `TEST_DATABASE_HOST`, `TEST_DATABASE_NAME`. Production environment: `TEST_DATABASE_HOST`. | owner, or session with OK |
| S7 | hPanel → test.gokesari.com: `DATABASE_URL` → `db-test.gokesari.com:5433`; redeploy | owner, or session with OK |
| S8 | `scripts/release/post-deploy-check.sh https://test.gokesari.com`. On the VPS: app connections come from the Hostinger IP. On Neon: none. | session |
| S9 | **Open writes** on the VPS and end the app's connections, so its pool reconnects writable | session |
| S10 | Actions → "Test database" → `backup` and then `verify`. This tests the new snapshot path. | session |
| S11 | QA on staging: guest and signed-in suites; a Cashfree sandbox payment through `sandbox-pay.yml`; the shop registration-fee sandbox page; each cron entry point called once by hand | session (gokesari-qa) |
| S12 | Resume the staging queue. The next PR with a migration tests `test-db.yml`'s migrate path on the VPS. | session |

**Then 7 days of watching.** The production gate needs all of these:
- every backup green, 7 out of 7;
- no WAL archive failures;
- the restore drill passed from R2;
- no unexpected rejected connections;
- CPU, memory and disk within limits;
- the round trip measured;
- QA results in `Test_Cases_Tracking`.

### 8.4 Phase 4: production cut-over

**Before:**
- [ ] Section 7B is live on `main`, released the usual way (one release at a time).
- [ ] [CLAUDE.md "Production releases"](../../CLAUDE.md) check: no open PR into `main` is being merged, and the latest "Post-deploy check" run and the latest Hostinger build for gokesari.com are finished.
- [ ] Staging queue paused for the window. No merges into `main` or `staging`.
- [ ] Rehearsal copy of live production into the VPS (not frozen), compared, timed, then dropped. The production drill passed on it.
- [ ] The owner has typed the new `DATABASE_URL` into a note, ready to paste into hPanel. The GitHub values are ready.
- [ ] The window avoids the 05.00 IST daily cron, the :47 IST hourly cron and the 02.15–03.00 IST backups. A quiet weekday afternoon (for example 15.00 IST), with the owner present, is suggested.
- [ ] Shops told in advance (owner's choice of wording and channel).

**Steps** (T = start; the times are what the rehearsal should confirm):

| Time | Step |
|---|---|
| T+0 | **Freeze Neon production** (read-only) and end the app's connections. The site turns read-only: browsing works; orders, payments, sign-ins and sign-ups fail with an error. |
| T+1 | Copy, running on the VPS (`REQUIRE_FROZEN=yes`). 4 MB, about 1–2 min. |
| T+3 | `compare.sh` + checksums: identical. Wallet-ledger checks (DEPLOYMENT.md §7) on the copy: no rows. |
| T+5 | Freeze the VPS copy too. Owner pastes `DATABASE_URL` in hPanel and redeploys. The build takes about 4 min; the old build keeps serving read-only from Neon until the switch. |
| T+12 | `post-deploy-check.sh https://gokesari.com` (5 healthy rounds). App connections on the VPS come from the Hostinger IP; none on Neon. |
| T+15 | **Open writes** on the VPS and end the app's connections so they reconnect writable. Check that the every-minute cron's writes land on the VPS. |
| T+20 | Guest QA against gokesari.com (read-only checks; no test data on production). The owner may place one small real order. Watch the first real Cashfree webhook land. |
| T+30 | Window closed. GitHub production values updated; "Production database → verify" passes. Unpause the staging queue. Watch closely for 24 hours. |

Cashfree webhooks that arrive during the read-only window fail and are retried by Cashfree. The every-5-minute `payments-reconcile` job catches any that are still missing.

### 8.5 Rollback

| When | How | Data lost | Time |
|---|---|---|---|
| Before writes open on the VPS (up to T+15) | Put the old `DATABASE_URL` back in hPanel and redeploy. Unfreeze Neon (`alter database neondb reset default_transaction_read_only;`) and end the connections. | **none**: nothing was written to the VPS | about 10 min |
| After writes opened, while Neon is still kept | Freeze the VPS. Copy VPS → a new empty database on the kept Neon project (the same `copy.sh` + `compare.sh`). Switch `DATABASE_URL` back. Point GitHub back. | none: the VPS writes are carried back | about 30–40 min read-only |
| After Neon is deleted | No rollback to Neon. Recover on the VPS or a new server from the backups (section 5.2). | ≤ 5 min | 1–2 h |

### 8.6 Expected downtime

| | Staging | Production |
|---|---|---|
| Read-only (browse yes; orders, payments, sign-ins no) | 30–45 min | **20–30 min** |
| Completely down (app restart) | under 1 min | **under 1 min** |
| Booked window | 60 min | 60 min |

### 8.7 Phase 5: retiring the Neon projects

- **After each cut-over:** the old Neon project stays **frozen**. On production (with the owner's OK at G4), turn scale-to-zero back on, so the old project sleeps and costs only storage, a few rupees a month. GoKesari's Neon compute charge stops on the day of each cut-over.
- **Staging:** at least **14 days** after its cut-over with no rollback:
  1. a final `pg_dump` to the Mac and R2;
  2. **owner's OK (G5)**;
  3. delete `curly-night-16641982`.
- **Production:** at least **30 days** after its cut-over:
  1. the same final dump;
  2. **owner's OK (G5)**;
  3. delete `lively-frost-99365966`.
- Neon can recover a deleted project for 7 days afterwards (`recover_project`).
- **Then** remove the Neon secrets and variables (section 7D) and the Neon branch path in `test-db.yml` (one small PR).
- The Neon account itself, its plan and any other projects in it are outside GoKesari's scope. This plan does not change them.

---

## 9. Cost

| | ₹ a month, excl. GST | incl. 18 % GST |
|---|---|---|
| **Neon today** (GoKesari, after the 16-Nov cost cut) | **₹1,900–2,250** | (as billed) |
| Hostinger KVM 2, 24-month term (₹18,696 for 24 months) | **₹779** | ₹919 |
| The same after renewal (from month 25; ₹28,776 per 2 years) | ₹1,199 | ₹1,415 |
| Off-site backups (Cloudflare R2, free up to 10 GB) | ₹0 | ₹0 |
| WireGuard, Let's Encrypt, healthchecks.io free plan | ₹0 | ₹0 |
| **Saving against Neon** | **₹1,120–1,470 a month (≈ ₹13,500–17,600 a year)** for 2 years; ₹700–1,050 a month after | |

- **Paid upfront:** ₹22,061 for 24 months, including GST (₹18,696 + ₹3,365). Prices confirmed 16-Nov-2026, 15.45 IST.
- **Shorter terms on Hostinger:**
  - 12 months: ₹11,148, then ₹16,788 a year.
  - Monthly: ₹1,299, then ₹2,099 a month.
- **Monthly-billed alternative elsewhere:** Lightsail 2 GB at about ₹1,044 + GST, cancel any time.
- **During the move:** about 3 weeks of paying for both, about ₹600 one-time. After that, frozen Neon storage costs only a few rupees until deletion.
- **Not in the table:** the owner's time (section 6.5).

---

## 10. Risks

| Risk | Likelihood | Effect | What reduces it |
|---|---|---|---|
| **One server:** hardware or VPS failure | low–medium | Site down until restored; ≤ 5 min of data lost | Off-site point-in-time backups at a different company (Cloudflare). Scripted rebuild. DNS names, so a move is a DNS change. Drills quarterly. Later, a standby replica (+₹600–1,200 a month) once revenue justifies it. |
| App and database with the same provider in the same city | low | A Hostinger Mumbai outage takes both down (the app alone would already be down) | Backups held outside Hostinger |
| **No autoscaling** | low today | Slow at a peak | About 8× today's CPU need. Resizing KVM 2 → KVM 4 in hPanel takes a reboot of a few minutes. CPU alerts. |
| **Security:** the database is on the internet | medium | Data breach | Allow-list firewall, VPN for everything else, TLS (verify-full after A4), scram passwords, no network superuser, fail2ban, patching, encrypted backups, monthly review |
| Hostinger changes the app's outgoing IP | low–medium | Site loses its database until the firewall is updated | Rejected-connection alert, 5-minute runbook step, monthly check of the address |
| Backups fail silently | medium | Cannot restore when needed | A healthchecks.io ping per job, monthly drill, quarterly off-site drill |
| Disk fills | low–medium | Database stops accepting writes | Section 6.3 |
| **Owner's time and night-time alerts** | high | Slower response than Neon's staff | Sessions do the work from scripts and the runbook. Alerts go to the phone. A paid on-call service later if needed. |
| Renewal price jump | certain | ₹779 → ₹1,199 a month (₹28,776 per 2 years) | Still below Neon. Or move to another VPS at renewal (DNS names make it easy). |
| A mistake during the cut-over | low | Data loss or a longer outage | Staging first, rehearsals, freeze, checksums, a written rollback, Neon kept 30 days |
| Losing Neon's conveniences | certain | Ad-hoc tasks take longer | Section 5.4 replacements, runbook |

---

## 11. Decisions for the owner

1. **VPS: DECIDED** by the owner on 16-Nov-2026, about 15.45 IST ("Yes, KVM 2").
   - Hostinger **KVM 2** in Mumbai on a **24-month term**.
   - ₹18,696 (₹779 a month), about ₹22,061 with GST, paid upfront; renews at ₹28,776 per 2 years.
   - The owner buys it at gate G1: [G1_OWNER_CHECKLIST.md](G1_OWNER_CHECKLIST.md).
   - **Changed 16-Nov-2026, 21.16 IST:** the owner bought **KVM 4** instead.
     - Same city and term.
     - ₹26,376, about ₹31,123 with GST; renews at ₹2,399 a month.
2. **Staging:** a separate instance on the **same VPS** (recommended), a separate VPS, or stay on Neon.
3. **Off-site backups:** **Cloudflare R2** (free up to 10 GB; recommended) or Backblaze B2. The owner creates the account.
   - **DECIDED** 16-Nov-2026, 21.55 IST: "Keep R2". A copy only on the VPS was ruled out: it is lost with the server.
4. **Access for GitHub and the Mac:** **WireGuard** (recommended; free, no third party) or Tailscale (easier setup, third-party service).
5. **Alerts go to:** which email address and/or Telegram.
6. **Database names:** `gokesari` / `gokesari_test` (recommended), or keep `neondb`.
7. **Staging cron:** put staging's every-minute line back to every minute once staging is on the VPS? *Recommended: yes* (no compute bill any more).
8. **Production cut-over window:** a date and IST time, and OK for about 20–30 minutes read-only.
9. **How long to keep Neon after each cut-over:** staging 14 days, production 30 days. Deletion still needs your OK at the time.

---

## 12. Sources and checks

**Read-only database checks** (16-Nov-2026, 13.29–13.32 IST), on the two GoKesari projects only: `version()`, database sizes, extensions, roles, schemas, table counts and biggest tables, connections by application, `pg_stat_database`, `pg_stat_statements`, settings. Nothing was written.

**Where the app runs:**
- DNS (dns.google);
- response headers of https://gokesari.com and https://test.gokesari.com (`server: hcdn`, `x-hcdn-request-id …-mum-edge…`);
- ipinfo.io for the four addresses;
- [docs/db-region-move-2026-10/PLAN.md](../db-region-move-2026-10/PLAN.md).

**Prices** (checked 16-Nov-2026):
- **KVM 2: Hostinger's catalogue, through Hostinger's API.**
  - Checked by the session that started this plan, on 16-Nov-2026 at 15.45 IST.
  - Item `hostingerin-vps-kvm2-inr-2y`, plus its 12-month and monthly prices.
  - Mumbai is VPS data centre id 23 (`mum2`). The account had no VPS yet.
- Hostinger VPS India: [hostinger.com/vps/servers/india](https://www.hostinger.com/vps/servers/india), [Zoutons, Hostinger India VPS deals 2026](https://zoutons.com/news/hostinger-india-vps-hosting-deals-june-2026-plans-from-599mo), [ideepakrajput.in, Hostinger KVM VPS price & specs 2026](https://ideepakrajput.in/blogs/hostinger-vps-hosting-review), [softwarecrafting.in, Hostinger VPS pricing 2026](https://softwarecrafting.in/blog/hostinger-vps-hosting-review), [HostAdvice, Hostinger India pricing](https://hostadvice.com/hosting-company/hostinger-reviews/hostinger-india-pricing/)
- Hostinger data-centre locations: [Hostinger support, where are the servers](https://support.hostinger.com/en/articles/1583267-where-are-your-servers-located), [Hostinger blog, India data centre](https://www.hostinger.com/blog/hostinger-newly-launched-data-center-location-in-india)
- AWS Lightsail: [Lightsail bundles](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-bundles.html), [Lightsail pricing](https://aws.amazon.com/lightsail/pricing/), [Lightsail data transfer (Mumbai gets half the allowance)](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-faq-data-transfer-allowance.html)
- DigitalOcean: [Droplet pricing](https://www.digitalocean.com/pricing/droplets), [Backups pricing](https://docs.digitalocean.com/products/backups/details/pricing/)

**Neon today:**
- [docs/neon-cost-cut-2026-11/README.md](../neon-cost-cut-2026-11/README.md);
- `GOKESARI_NEON_COST_CUT_REPORT_2026-11-16.md` (owner's folder).
