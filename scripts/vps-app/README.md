# GoKesari web-layer kit (gate H1)

These scripts run the GoKesari website code (the Next.js app) on our own server, `gk-db-1`, next to its databases. The server is a Hostinger KVM 4 in Mumbai (189.72.155.162).

- **Plan:** [docs/app-to-vps-2026-11/PLAN.md](../../docs/app-to-vps-2026-11/PLAN.md), sections 3–7. This kit is gate **H1**: it builds the web layer and changes no live site.
- **Database kit:** [scripts/vps-db](../vps-db/README.md). This kit sources its `lib.sh` (IST log times, `need_root`, `use_env`, `read_secret`, `hc_ping`) and reads its `/etc/gokesari-db/config.env`.
- **Written:** 17-Nov-2026. **Times:** IST.

**Nothing here runs by itself.** It changes no DNS, no Hostinger site and no GitHub setting. Every step below is run by hand, as root on the server, with the owner's OK for H1.

**No secrets in the repository, and none printed.**
- Site settings go into `/etc/sites/<site>.env` (root, mode 600) through hidden prompts or a pipe (decision 4).
- Only systemd reads that file. The site's own user never can.
- The tools print key names, never values. No secret is ever put on a command line that `ps` shows.

## Files

Run in this order, as root, from `/opt/gokesari-app`. Each is safe to re-run.

| File | What it does |
|---|---|
| [lib.sh](lib.sh) | Shared settings and helpers: paths, build limits (4G, 150 % CPU, nice 10, 20 min), health paths, the cron preset, the env drop lists, the Caddy block writer, the UTC→IST cron conversion. Sources the database kit's `lib.sh`. |
| [10-install.sh](10-install.sh) | Node.js **24** from NodeSource (major pinned with an apt preference), Caddy from its official apt repository, `git` and `jq`. Writes `/etc/caddy/Caddyfile` (admin API on localhost only, logs, HTTP/1.1, 2 and 3; imports `acme.caddy` and `sites/*.caddy`). Makes `/srv/sites`, `/etc/sites` (700) and `/var/lib/gk-app`. Links the commands into `/usr/local/sbin` and installs the systemd templates. **Leaves the deploy and health timers off.** |
| [20-web-firewall.sh](20-web-firewall.sh) | ufw: 80/tcp, 443/tcp and 443/udp from anywhere. `acme.caddy`: plain-HTTP site for `db` / `db-test.gokesari.com` that serves only `/.well-known/acme-challenge/*` from `/var/lib/gk-app/acme` (404 otherwise, no redirect). Moves certbot's `gokesari-db` certificate to that webroot (see below), runs `certbot renew --cert-name gokesari-db --dry-run`, and prints the Hostinger firewall rules to add. |
| [github_known_hosts](github_known_hosts) | github.com's host keys from `api.github.com/meta` (17-Nov-2026), pinned for the deploy agent. Fingerprints are in the file. |
| [templates/](templates/) | `site@.service` (one colour of one site), `gk-cron@.service` / `.timer`, `gk-deploy.service` / `.timer` (every minute), `gk-app-health.service` / `.timer` (every 5 minutes). |
| [test/dry-run.sh](test/dry-run.sh) | The local dry run: every tool against a temporary folder, with `systemctl`, `systemd-run`, `caddy`, `git`, `curl`, `useradd`, `runuser`, `flock`, `ufw` and `certbot` replaced by [test/stubs](test/stubs/). |
| [test/db-socket.sh](test/db-socket.sh) | The DATABASE_URL that `env db` writes, against a throwaway PostgreSQL, through the app's own `src/server/db` and `src/server/pmd/db`. |

Commands installed in `/usr/local/sbin` (from [bin/](bin/)):

| Command | What it does |
|---|---|
| `gk-site` | Site slots: `add`, `env paste/set/unset/keys/db`, `deploy-key`, `tls internal/acme`, `cron on/off/status`, `status`, `list` |
| `gk-deploy` | The deploy agent: `run` (timer), `now <site>`, `restart <site>`, `rollback <site>`, `status` |
| `gk-app-health` | Each deployed site through Caddy on this machine; one healthchecks.io ping per site |
| `gk-cron-call` | One cron call, run by a site's `gk-cron@<site>-<job>` timer as the site's user |

## On the server

| Path | What |
|---|---|
| `/opt/gokesari-app` | This kit (root-owned copy), next to `/opt/gokesari-db` |
| `/etc/sites/<site>.conf` | The slot's settings, written by `gk-site` (no secrets) |
| `/etc/sites/<site>.env` | The site's environment. Root, 600; read by systemd. |
| `/etc/sites/<site>.deploykey` | The read-only GitHub deploy key's private half (root, 600). The public half is `.pub`. |
| `/srv/sites/<site>/` | `releases/<commit>/` (last 5 kept), `current-blue` and `current-green` (symlinks), `shared/build-<commit>.log`, `shared/npm-cache`, `repo.git` (root-only mirror), `deployed.json` |
| `/etc/caddy/sites/<site>.caddy` | The site's Caddy block. `gk-deploy` moves its `reverse_proxy` line; `gk-site tls` changes its `tls` line. |
| `/etc/caddy/acme.caddy` | Certificate challenges for `db` / `db-test` |
| `/var/lib/gk-app/` | `acme/` (certbot's webroot), `certbot-before/` (the renewal file as it was) |
| `/var/log/caddy/site-<site>.log` | One access log per site, kept 14 days |
| `/etc/systemd/system/site@<site>-<colour>.service.d/10-slot.conf` | User, env file, port, working folder, limits |
| `/etc/systemd/system/gk-cron@<site>-<job>.{service,timer}.d/` | The job's command and its schedule (IST) |

## How it works

### Slots (`gk-site add`)

`gk-site add <site> --domain <d> [--domain <d2>] --repo <owner/repo> --branch <b> --port-base <n> [--mem <GiB>] [--cpu <percent>] [--db-socket-port 5432|5433] [--cron-preset gokesari | --cron '<job>=<UTC cron line>' ...]`

It creates or updates:
- the user `gk-<site>` (system user, no login shell);
- `/srv/sites/<site>/{releases,shared}`;
- an empty env file;
- the deploy key (if there is none);
- `/etc/sites/<site>.conf`;
- two colours: blue on port n+1, green on n+2, each with `MemoryMax`, `MemoryHigh` (90 %) and `CPUQuota`;
- the Caddy block, in **internal TLS** (preview) mode;
- the cron timers, **disabled**;
- the healthchecks.io checks `gk-app-<site>` and `gk-deploy-<site>`. They are created with a "log" event, so they stay "new" (no alerts) until their first real ping.

Re-running `add` keeps the key, the env file, the TLS mode and anything not given again. It refuses a port or domain that another site already has.

### One colour (`site@<site>-<colour>.service`)

```
/usr/bin/node node_modules/next/dist/bin/next start -p ${GK_SLOT_PORT} -H 127.0.0.1
```
- It runs as `gk-<site>`, in `current-<colour>` (→ `releases/<commit>`), with `NODE_ENV=production`.
- The port comes from the drop-in (`GK_SLOT_PORT`), so a `PORT` in the env file cannot move it.
- Sandbox:
  - `ProtectSystem=strict`, with only the release's `.next/cache` writable;
  - `ProtectHome`, `PrivateTmp`, `PrivateDevices`, `NoNewPrivileges`;
  - no capabilities.
- `Restart=on-failure`; `TasksMax=512`; `OOMScoreAdjust=300`, so the database survives memory pressure first.
- `SuccessExitStatus=143`: `next start` exits with 143 when it is stopped (SIGTERM). Without it, the idle colour shows `failed` after every switch; since 18-Nov-2026 it shows `inactive`.
- **Changing a template on the server.** Copy the file into `/opt/gokesari-app/templates/`, `install -m 644` it into `/etc/systemd/system/`, then `systemctl daemon-reload`. Running colours keep serving; the change applies at their next start or stop. A colour left `failed` by an earlier stop is cleared with `systemctl reset-failed 'site@*'`.

### Deploys (`gk-deploy`)

`gk-deploy.timer` runs `gk-deploy run` every minute. **One global lock:** one deploy on the whole server at a time; a run that finds it taken does nothing.

For each site:
1. **Detect.** `git ls-remote` with the site's deploy key:
   - `GIT_SSH_COMMAND` with `IdentitiesOnly`, no agent, `BatchMode`;
   - `StrictHostKeyChecking` against the pinned `github_known_hosts`.

   Nothing happens when the head is serving already, was rolled back from, or failed before. A new commit, or `gk-deploy now`, tries again.
2. **Fetch.** A shallow fetch into the root-only `repo.git`. Then `git archive | runuser -u gk-<site> -- tar -x` into `releases/<commit>`, so the files belong to the site's user.
3. **Build** (`npm ci --no-audit --no-fund && npm run build`) in a transient unit:
   - `systemd-run --uid gk-<site> -p EnvironmentFile=/etc/sites/<site>.env -p MemoryMax=4G -p CPUQuota=150% -p RuntimeMaxSec=20min --nice=10 --wait --pipe`;
   - sandboxed like the service; writable: the release, `shared/npm-cache`, `shared/home`;
   - `GK_BUILD_VERSION` = the commit's first 12 characters, so `/sw.js`'s `VERSION` changes with every build (the staging queue's post-deploy check watches it);
   - log in `shared/build-<commit>.log`. On success the webpack cache is removed, since it is never reused.
4. **Switch** (zero downtime):
   1. Point `current-<idle colour>` at the release and start that colour.
   2. Wait for **200** on `/`, `/shops` and `/api/shops?limit=1` on `127.0.0.1:<port>` (60 s).
   3. Rewrite the site's Caddy block to that port and run `caddy reload`. The reload is graceful: no connection is dropped, and if Caddy refuses the configuration it keeps the old one.
   4. Check `https://<domain>/` through Caddy (for information only).
   5. Stop and disable the old colour **60 s later**.
5. **Record and report.** Write `deployed.json`:
   - `sha`, `colour`, `port`, `release`, `time`, `result`;
   - `previous_*` (the rollback target);
   - `last_attempt_*`;
   - `hold_sha`.

   Ping `gk-deploy-<site>`: start, then ok or fail. The ping never includes the build log.
6. **Failures** (fetch, build, health check, Caddy):
   - the old colour keeps serving;
   - the idle colour goes back to the release it had;
   - `last_attempt_*` says why, and `gk-deploy-<site>` gets a fail ping.
7. **Housekeeping:** the last 5 releases are kept, plus both colours' releases and the rollback target. Build logs are kept for 30 days.

The other commands:

| Command | What it does |
|---|---|
| `gk-deploy now <site>` | A fresh build of the branch head now, even if it is serving already (then into `releases/<commit>-<time>`). Ignores holds and earlier failures. |
| `gk-deploy restart <site>` | The serving release on the other colour, with the same health check and switch, and no build. Use it after `gk-site env` changes. `NEXT_PUBLIC_*` changes need `now`, because they are fixed at build time. |
| `gk-deploy rollback <site>` | Back to `previous_release` on the other colour, with no build. The commit rolled back from is held: the timer skips it until a newer commit arrives. Run `rollback` again to go forward. |
| `gk-deploy status` | Per site: the serving commit and colour, the last attempt, the hold. |

### Settings (`gk-site env`)

| Command | What it does |
|---|---|
| `env paste <site> [--nul] [--only K1,K2]` | Merges `KEY=VALUE` input into the env file; the input wins. Prints each key with `set`, `replaced` or `unchanged`. |
| `env set <site> <KEY>` | One value, typed hidden, or one line on stdin |
| `env unset <site> <KEY>` | Removes a key |
| `env keys <site>` | Key names only |
| `env db <site> [socket\|tcp]` | Writes `DATABASE_URL` (see below) from `/etc/gokesari-db/secrets/<role>` |

How `env paste` reads its input:
- **Typed:** hidden; end with a line holding only `.`, or Ctrl-D.
- **Piped:** read to the end, no prompt. Prompts go to stderr, never into the data.
- **Lines:** blank lines and `#` comments are skipped; a leading `export` is allowed; surrounding quotes, a trailing CR and trailing blanks are stripped. A malformed line is refused by its line number, and then nothing is saved. Values are never shown.
- **`--nul`:** NUL-separated records, as in `/proc/<pid>/environ`. Values are taken verbatim, so multi-line PEM keys survive.

Keys `env paste` never takes from the input:

| Kind | Keys |
|---|---|
| Retired | `SELLER_DATABASE_URL`, `DB_SPLIT_MODE`, `PROD_SELLER_DATABASE_URL`, `PROD_CUSTOMER_DATABASE_URL`, `TEST_DATABASE_URL`, `TEST_DATABASE_HOST`, `TEST_DATABASE_NAME`, `TEST_NEON_API_KEY` |
| Written by `env db` | `DATABASE_URL`, `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `PGSSLMODE`. After a paste, `env db` always rewrites them when the site has `--db-socket-port`. |
| Shell and process noise | `PATH`, `HOME`, `PWD`, `OLDPWD`, `SHLVL`, `_`, `HOSTNAME`, `USER`, `LOGNAME`, `SHELL`, `MAIL`, `LANG`, `LANGUAGE`, `TERM`, `INIT_CWD`, `LS_COLORS`, `PORT`, `TMPDIR`, and by prefix `NODE_*` (except `NODE_ENV`), `npm_*`, `LC_*`, `LSNODE_*`, `LSAPI_*`, `PASSENGER_*` |

How the env file is written:
- Each value is in single quotes, verbatim, and may span lines.
- A value that contains a single quote is in double quotes, with `\ " ` $` escaped.
- This is the format systemd's `EnvironmentFile=` reads.

### The database connection (`gk-site env db`)

```
DATABASE_URL=postgresql:///gokesari_test
PGHOST=/var/run/postgresql
PGPORT=5433
PGUSER=gokesari_test_app
PGPASSWORD=<from /etc/gokesari-db/secrets/gokesari_test_app>
```
For production it is `gokesari` on 5432 as `gokesari_app`.

**Why this form.** The app's driver, postgres.js 3.4.9, takes no Unix socket from the URL's query string:
- `postgresql://…@localhost/db?host=/var/run/postgresql&port=5432` makes it connect over TCP to `localhost`;
- it also sends `host` and `port` to the server as session settings, which the server refuses (`unrecognized configuration parameter "host"`, tested);
- `user:pw@/db` (an empty host with a password) is not a valid URL at all.

With an empty host (`postgresql:///db`), postgres.js falls back to `PGHOST`, `PGPORT`, `PGUSER` and `PGPASSWORD`. A `PGHOST` containing a `/` is a socket directory.

Both of the app's clients pass the URL through unchanged:
- `src/server/db/index.ts`;
- `src/server/pmd/db.ts`, whose `openableUrl` keeps it as it is.

`resolveSsl()` gives `false`, because the URL has no `sslmode`.

**It needs one `pg_hba.conf` line per instance:** `local <db> <app role> scram-sha-256`.
- `scripts/vps-db/access.sh` now writes it.
- Re-run `access.sh` on the server **before** the first deploy, or the app's connections are refused.

`env db <site> tcp` is the fallback: `postgresql://<role>:<pw>@127.0.0.1:<port>/<db>` without TLS. It needs a `host … 127.0.0.1/32` line, which `access.sh` does not write.

### What `next build` needs at build time (tested 17-Nov-2026 on this branch, Next 16.4.1)

**With no variables at all, the build fails** in "Collecting page data":
```
Invalid environment configuration:
  - DATABASE_URL … - AUTH_SECRET … - CRON_SECRET …
```
`src/lib/env.ts` validates at import, and `src/server/db/index.ts` calls it at module load.

**With only those three variables** (any non-empty values, and a `DATABASE_URL` pointing at no server), the build succeeds:
- all 83 static pages are generated;
- there is no database connection at build time.

So the build needs the site's env file, which it gets (step 3), but **not a working database.**

Two values are fixed into the bundle at build time:
- **`NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`**: without it, the map picker falls back to manual entry. A changed value needs `gk-deploy now`.
- **`GK_BUILD_VERSION`**: the agent sets it to the commit.

Two more points:
- **The build type-checks** (it runs TypeScript, about 40 s), because `npm ci` installs `typescript`. Hostinger installs production dependencies only and skips that step. To build as Hostinger does, set `SITE_BUILD_CMD="npm ci --omit=dev --no-audit --no-fund && npm run build"` in `/etc/sites/<site>.conf`; it is kept across `gk-site add`.
- **The migrator never runs:** `scripts/migrate-on-build.mjs` skips outside GitHub Actions.

### Cron (`gk-cron@<site>-<job>.timer`)

The hPanel lines (UTC) become systemd timers on the server's IST clock. They are **made disabled**.

| hPanel (UTC) | Timer (IST) | `--max-time` |
|---|---|---|
| `* * * * *` every-minute | `*-*-* *:*:00` | 55 |
| `17 * * * *` hourly | `*-*-* *:47:00 Asia/Kolkata` | 300 |
| `30 23 * * *` daily | `*-*-* 05:00:00 Asia/Kolkata` | 300 |
| `0 */6 * * *` (staging every-minute in docs/crontab.txt since 16-Nov) | `*-*-* 05,11,17,23:30:00 Asia/Kolkata` | 55 |

The +5:30 shift keeps the 5-, 10- and 15-minute multiples that `dueEveryMinute` relies on.

Each run is `gk-cron-call <site> <job> <max-time> <first domain>`, as the site's user:
- systemd loads the env file, so `CRON_SECRET` arrives in the environment;
- the `Authorization: Bearer …` header goes to `curl --config -` on stdin;
- `flock -n -E 0`: a run still going makes the next one a quiet no-op, as on hPanel;
- `curl -fsS --max-time <n> -X POST -H "Host: <domain>" http://127.0.0.1:<serving port>/api/cron/<job>`.

`gk-site cron <site> on|off|status`. Turn a site's timers on in the same minute as its hPanel lines go off (plan, C3 / D3). Avoid :47 and 05.00 IST.

`--cron-preset gokesari` is docs/crontab.txt's schedule, used by **both** sites since 17-Nov-2026 (owner, decision D7: staging every minute again). The staging-only `0 */6` every-minute line (16-Nov-2026, a Neon cost cut) is history; if ever needed again: `--cron 'every-minute=0 */6 * * *' --cron 'hourly=17 * * * *' --cron 'daily=30 23 * * *'`.

### TLS

| Mode | When | What Caddy does |
|---|---|---|
| `internal` (made by `add`) | Before DNS points here | Caddy's own CA issues the site's certificates (preview) |
| `acme` (`gk-site tls <site> acme`) | After the A/AAAA records point at 189.72.155.162 | Let's Encrypt; Caddy renews 30 days ahead |

`gk-site tls <site> acme` refuses while DNS still points elsewhere. `--force` overrides that check.

### The database certificate (20-web-firewall.sh)

Until now:
- certbot ran its own server on port 80 (`authenticator = standalone`);
- its pre/post hooks opened and closed 80/tcp in ufw.

Caddy holds port 80 now, so:
- `/etc/letsencrypt/renewal/gokesari-db.conf` is rewritten to `authenticator = webroot`, `webroot_path = /var/lib/gk-app/acme,`, and a `[[webroot_map]]` for both names;
- `pre_hook` and `post_hook` are removed;
- `renew_hook = /usr/local/sbin/gk-cert-deploy` (the deploy hook into PostgreSQL) stays.

Then `certbot renew --cert-name gokesari-db --dry-run` must pass. The old file is kept in `/var/lib/gk-app/certbot-before/`. Restoring it would not help, because standalone cannot bind port 80 while Caddy holds it. A failed dry run therefore stops the script for a person to fix; the certificate itself is untouched.

The database kit follows:
- `scripts/vps-db/40-tls.sh` uses the webroot once `/etc/caddy/acme.caddy` exists;
- `access.sh` keeps 80/443 in ufw and lists them for hPanel.

## H1, step by step (as root on gk-db-1)

1. **Copy the kits.** Copy `scripts/vps-app` to `/opt/gokesari-app`, and the updated `scripts/vps-db` to `/opt/gokesari-db`, the same way the database kit was copied. Then `chown -R root:root`.
2. `/opt/gokesari-app/10-install.sh`
   - Compare the NodeSource and Caddy key fingerprints it prints with the ones those projects publish.
   - Re-run with `NODESOURCE_FINGERPRINT=… CADDY_FINGERPRINT=…` to pin them.
3. `/opt/gokesari-db/access.sh`: adds `local <db> <app role> scram-sha-256` to both instances' `pg_hba.conf`.
4. `/opt/gokesari-app/20-web-firewall.sh`, then add its printed rules in Hostinger's VPS firewall (TCP 443, UDP 443).
5. **Make the two slots:**
   ```
   gk-site add gokesari-staging --domain test.gokesari.com --domain www.test.gokesari.com \
     --repo sanjaymorankar-debug/GoKesari --branch staging --port-base 3200 --mem 2 --cpu 100 \
     --db-socket-port 5433 --cron-preset gokesari
   gk-site add gokesari-prod --domain gokesari.com --domain www.gokesari.com \
     --repo sanjaymorankar-debug/GoKesari --branch main --port-base 3100 --mem 4 --cpu 200 \
     --db-socket-port 5432 --cron-preset gokesari
   ```
   Each prints its deploy key's public half.
6. **Owner's two jobs.** They are below.
7. **Check the settings:**
   - `gk-site env keys gokesari-staging` (and `-prod`);
   - `gk-site status`.
8. **First deploys:**
   - `gk-deploy now gokesari-staging`, then `gk-deploy now gokesari-prod`;
   - watch `shared/build-<commit>.log`;
   - check with `gk-deploy status`.
9. **Turn the timers on:** `systemctl enable --now gk-deploy.timer gk-app-health.timer`. Set the healthchecks.io checks:
   - `gk-app-<site>`: period 5 min, grace 10 min;
   - `gk-deploy-<site>`: period 30 days, grace 1 day; it matters for its fail pings.
10. **Preview** (below):
    - staging: guest QA;
    - production: **read-only checks only**, because the database is the live one.
11. **Leave the cron timers off.** They are switched at H2 (staging) and H3 (production), together with hPanel's lines.

## The owner's two jobs

1. **Deploy keys.** Run `gk-site deploy-key <site>` for each site. The two keys are different and read-only.
   - In GitHub, open `sanjaymorankar-debug/GoKesari` → Settings → Deploy keys → Add deploy key.
   - Use the title `gk-db-1 gokesari-staging` (and `gk-db-1 gokesari-prod`).
   - Paste the `ssh-ed25519 …` line, and leave **"Allow write access" off**.
   - Until a key is added, the timer only logs "Repository not found" for that site.
2. **Settings.** Pipe each site's settings from its running Hostinger app, as in the next section. To type them instead, run `sudo gk-site env paste <site>` and paste; the input is hidden.

### Mac one-liner: settings from Hostinger straight into the server

The running Hostinger Node process holds the site's settings in `/proc/<pid>/environ` (NUL-separated). The one-liner pipes them from Hostinger's SSH into `gk-site env paste --nul` on the VPS:
- nothing is written on the Mac, and nothing shows on screen;
- the VPS prints only key names;
- the WireGuard tunnel must be up.

> **VERIFY ON THE SERVER FIRST: the process-finding part.** It was not tested; this kit cannot reach Hostinger. Run the left half alone with key names only. It must print the right process and a list of names like `AUTH_SECRET`, `CRON_SECRET`, …:
> ```
> ssh -p 65002 u879099820@93.127.208.167 'for p in $(pgrep -u "$(id -u)" -f "node|next"); do d=$(readlink /proc/$p/cwd 2>/dev/null); case "$d" in "$HOME/domains/test.gokesari.com"|"$HOME/domains/test.gokesari.com/"*) echo "pid $p cwd $d" >&2; tr "\0" "\n" < /proc/$p/environ | cut -d= -f1; exit 0;; esac; done; echo "no Node process found for test.gokesari.com" >&2; exit 1'
> ```
> Things to check:
> - Hostinger's processes may not be visible from the SSH shell (CageFS). The app may run under LiteSpeed's `lsnode`, or with its working folder elsewhere (for example `public_html` or `nodejs` below the domain folder).
> - `/proc/<pid>/environ` shows the settings the process **started** with. Restart the app in hPanel first if its settings changed since.
>
> Adjust the `pgrep` pattern or the folder until this prints the right names.

**test.gokesari.com → gokesari-staging:**
```
ssh -p 65002 u879099820@93.127.208.167 'for p in $(pgrep -u "$(id -u)" -f "node|next"); do case "$(readlink /proc/$p/cwd 2>/dev/null)" in "$HOME/domains/test.gokesari.com"|"$HOME/domains/test.gokesari.com/"*) cat /proc/$p/environ; exit 0;; esac; done; echo "no Node process found for test.gokesari.com" >&2; exit 1' \
  | ssh -i ~/.ssh/gokesari_db_admin gkadmin@10.66.0.1 'sudo gk-site env paste gokesari-staging --nul'
```

**gokesari.com → gokesari-prod:**
```
ssh -p 65002 u879099820@93.127.208.167 'for p in $(pgrep -u "$(id -u)" -f "node|next"); do case "$(readlink /proc/$p/cwd 2>/dev/null)" in "$HOME/domains/gokesari.com"|"$HOME/domains/gokesari.com/"*) cat /proc/$p/environ; exit 0;; esac; done; echo "no Node process found for gokesari.com" >&2; exit 1' \
  | ssh -i ~/.ssh/gokesari_db_admin gkadmin@10.66.0.1 'sudo gk-site env paste gokesari-prod --nul'
```

What happens next:
- The VPS drops the retired keys, the shell and process noise, and the database keys. It then writes `DATABASE_URL` with `env db`.
- If the left side finds nothing, the right side receives nothing and changes nothing ("No settings to save").
- `--only KEY1,KEY2` takes just those keys, for example to refresh one value later.

## Preview before DNS moves (internal TLS)

1. **Hostinger's VPS firewall** must allow TCP 443 (step 4).
2. **On the Mac,** add to `/etc/hosts` (`sudo nano /etc/hosts`):
   ```
   189.72.155.162  test.gokesari.com www.test.gokesari.com
   ```
   Add `gokesari.com www.gokesari.com` only for read-only production checks. Remove the lines afterwards.
3. **Trust Caddy's preview CA on the Mac.**
   - gokesari.com sends `Strict-Transport-Security; includeSubDomains`. A browser that has visited it will not let you click through a certificate warning.
   - The CA's root certificate is public, not a secret: `/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt`.
   - Copy it to the Mac, open it in Keychain Access, and set it to "Always Trust" for SSL. Remove it after the switch.
   - Without the root: `curl --resolve test.gokesari.com:443:189.72.155.162 -k https://test.gokesari.com/`.
4. **The same database is behind the preview.** On staging, run guest QA and the sandbox payment workflow. On production, run **read-only checks only.**

## Adding a later site (generic)

The full checklist is plan section 5. The kit side:
1. Check the headroom first (plan section 5): 30 % CPU and 4 GiB RAM free at the busiest hour.
2. `gk-site add <site> --domain <its domain> --repo <owner/repo> --branch <branch> --port-base <free n, e.g. 3300> --mem <GiB> --cpu <percent>`. Add no `--db-socket-port` unless the site uses one of this server's instances. A site with its own database role or instance sets `DATABASE_URL` with `gk-site env set`, plus a `pg_hba.conf` line for it.
3. Add the printed deploy key to that repository (read-only).
4. `gk-site env paste <site>`, then `gk-deploy now <site>`, then a preview with the hosts file.
5. Point the site's DNS here, then `gk-site tls <site> acme`.
6. Cron jobs, if it has any: `--cron '<job>=<UTC cron line>'`, then `gk-site cron <site> on`.

Two limits:
- **The slot runs a Next.js app** (`next start`). Another kind of app needs its own `ExecStart=` in the colour drop-ins and its own health paths (`GK_HEALTH_PATHS`).
- **The build command** is `SITE_BUILD_CMD` in `/etc/sites/<site>.conf`.

## What was tested, and what was not

Tested on 17-Nov-2026 on the owner's Mac (bash 5.3, Node 24.21):

| Test | Result |
|---|---|
| `test/dry-run.sh` (204 checks, all passing) | See below |
| `test/db-socket.sh` against a throwaway PostgreSQL 18.6, socket only | `pg_hba.conf` parses with 0 errors. Both of the app's clients connect over the socket as `gokesari_test_app` with `ssl = false`; `resolveSsl` gives `false`. The query-string form is refused by the server (`unrecognized configuration parameter "host"`), and so is a wrong password. |
| `next build` with no variables | Fails: needs `DATABASE_URL`, `AUTH_SECRET`, `CRON_SECRET` |
| `next build` with only those three and an unreachable database | Succeeds: 83 static pages, no database connection |
| `bash -n` on every script | Passes. shellcheck is not installed on the Mac and was not run. |

The dry run covered:
- **The cron conversion:** UTC → IST for every line above, and a refusal for day-of-month lines.
- **`gk-site add`:**
  - users, folders, modes, drop-ins, the Caddy block and the cron units (disabled);
  - re-runs that keep the key;
  - port and domain clashes refused.
- **`env paste`:**
  - piped lines: comments, quotes, `export`, CRLF, trailing blanks;
  - malformed lines refused by number with nothing saved;
  - empty input; `--only`;
  - `--nul` from a fake environ: noise, retired keys, a multi-line PEM, a value with `'`, `"`, `$`, `` ` ``, `\` and `=`, round-tripped byte for byte;
  - typed into a pseudo-terminal: the prompt shows and the value is not echoed.
- **`env set`, `unset`, `keys`, `db`** (socket and tcp).
- **`gk-deploy`:**
  - first deploy; no-op on the same commit; the next commit (blue → green, 60 s drain, old colour stopped and disabled);
  - a failed build, which is not retried; a failed health check, where the idle colour goes back to its release; Caddy refusing the switch, where the block is restored;
  - rollback, the hold, rollback again, restart, `now` on the serving commit;
  - housekeeping (at most 5 releases);
  - a deploy key GitHub does not know, and GitHub unreachable.
- **`gk-cron-call`:** the secret on stdin, never on a command line.
- **The other tools and scripts:**
  - `gk-site cron`, `tls`, `status`;
  - `gk-app-health`, ok and fail;
  - `20-web-firewall.sh` on a sample standalone renewal file (idempotent);
  - `10-install.sh` with apt stubbed.
- **No secret** in any command line, log or output, except as noted below.

**Not tested before the real server.** Anything that needs Ubuntu itself:
- apt, NodeSource, the Caddy package, real Caddy (the Caddyfile and blocks were not parsed by Caddy);
- systemd (units, drop-ins, `EnvironmentFile=` quoting, `systemd-run` properties, sandboxing with Next.js);
- ufw, certbot's real webroot renewal, GitHub with a deploy key, and a real `next build` / `next start` under the limits.

The first run on the server is H1 itself. Each step checks its own result and stops on the first problem.

**Known exceptions:**
- **The healthchecks.io ping key** is in the URL that the database kit's `hc_ping` passes to curl, as `gk-db-health` already does every 5 minutes. This kit's own `hc_log` passes its URL on stdin.
- **The Hostinger one-liner's process-finding part** is unverified (see above).
