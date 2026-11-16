# GoKesari database server kit (Phase 1)

These scripts build and run GoKesari's own PostgreSQL 18 server: one Hostinger KVM 4 VPS in Mumbai (KVM 2 or larger works), running Ubuntu 24.04. Production and staging are separate instances on it.

- Plan: [docs/neon-to-vps-2026-11/PLAN.md](../../docs/neon-to-vps-2026-11/PLAN.md).
- Step by step: [RUNBOOK.md](../../docs/neon-to-vps-2026-11/RUNBOOK.md).
- Owner's purchase checklist: [G1_OWNER_CHECKLIST.md](../../docs/neon-to-vps-2026-11/G1_OWNER_CHECKLIST.md).

**Nothing here runs by itself.** Running it needs:
- the VPS (gate G1);
- the owner's OK to build it (gate G2).

The kit never touches gokesari.com, test.gokesari.com or Neon.

**No secrets in the repository.**
- Passwords are made on the server; the owner types the R2 and healthchecks.io keys there.
- Everything secret is kept in `/etc/gokesari-db/secrets` (root only) and in the owner's password manager.
- Public keys and addresses are not secrets.
- Nothing secret is printed unless asked for by name. [mac/copy-secret.sh](mac/copy-secret.sh) sends one straight to the Mac's clipboard.

## Files

Run in this order, as root on the server, from `/opt/gokesari-db`. Each is safe to re-run.

| File | What it does |
|---|---|
| [config.example.env](config.example.env) | Settings, copied to `/etc/gokesari-db/config.env`: IP addresses, host names, database names (decision 6), R2 bucket, and the public keys |
| [lib.sh](lib.sh) | Shared settings and helpers. **The WireGuard peer table** (who may reach which port) is here. |
| [00-preflight.sh](00-preflight.sh) | Checks it is the server that was ordered: Ubuntu 24.04, KVM 2 or larger, the configured IP address |
| [10-os.sh](10-os.sh) | Updates, IST time zone, the admin user (key only), SSH without passwords, automatic security updates (never PostgreSQL, never a reboot), swap, journal cap, fail2ban, firewall in build mode |
| [20-wireguard.sh](20-wireguard.sh) | WireGuard server `wg0` on 10.66.0.1, UDP 51820 |
| [30-postgres.sh](30-postgres.sh) | PostgreSQL 18 from apt.postgresql.org (key fingerprint checked). Clusters `18/main` (5432) and `18/staging` (5433, limited to 1 vCPU, 2 GB and a lower disk priority). Settings from [templates/postgresql.conf.tmpl](templates/postgresql.conf.tmpl). 2 GB spare file. |
| [40-tls.sh](40-tls.sh) | Let's Encrypt certificate for `db.gokesari.com` and `db-test.gokesari.com`, renewed by certbot's timer |
| [50-roles.sh](50-roles.sh) | Roles, empty databases `gokesari` and `gokesari_test`, extensions. Passwords are set as SCRAM hashes. |
| [access.sh](access.sh) | Who may reach what: ufw rules plus each instance's `pg_hba.conf` / `pg_ident.conf`. `--hostinger` prints the rules for hPanel's VPS firewall. |
| [60-pgbackrest.sh](60-pgbackrest.sh) | pgBackRest with two repositories: repo1 on this disk, repo2 in Cloudflare R2, encrypted. Settings from [templates/pgbackrest.conf.tmpl](templates/pgbackrest.conf.tmpl). Runs the first full backups. |
| [70-schedules.sh](70-schedules.sh) | systemd timers: health check every 5 minutes; dumps and backups 02.15–03.00 IST; certificate check 09.00 IST |
| [90-lockdown.sh](90-lockdown.sh) | Last step: SSH only over WireGuard, no root login |

Commands installed in `/usr/local/sbin` (from [bin/](bin/)):

| Command | What it does |
|---|---|
| `gk-db-secret` | Lists, makes or shows the server's secrets; takes the R2 and healthchecks.io keys as hidden input |
| `gk-peer` | Records the WireGuard and snapshot **public** keys of the peers in `lib.sh`; prints a peer's client config |
| `gk-db-backup` | pgBackRest backup into both repositories (full on Sunday, otherwise differential), or `check` |
| `gk-db-dump` | Nightly `pg_dump`, encrypted with `age` for the owner's public key, then uploaded to R2 |
| `gk-db-snapshot` | The restricted SSH command for the workflows: dump, keep the newest 5, set a restore point. Replaces Neon's `auto-backup-*` branches. |
| `gk-db-health` | Health check: instances, WAL archiving, disk, memory, CPU, connections, failed logins, app connections; `--cert` checks the certificate |
| `gk-db-restore-drill` | Monthly drill: restore from R2 into a scratch instance, run `pg_amcheck` and the wallet-ledger checks, compare row counts, restore the latest dump |
| `gk-cert-deploy` | certbot hook: copies the new certificate to both instances and reloads them |

Run on the owner's Mac ([mac/](mac/); bash 3.2 is fine):

| Script | What it does |
|---|---|
| `make-admin-key.sh` | Makes the admin SSH key at G1 and prints its public key |
| `make-github-keys.sh` | Makes the GitHub jobs' WireGuard and snapshot SSH keys. Each private key goes straight into a GitHub secret; only the public keys are printed. |
| `copy-secret.sh` | Copies one server secret to the clipboard without showing it |
| `pull-dumps.sh` | Weekly: copies the newest encrypted dumps to the Mac |

## On the server

| Path | What |
|---|---|
| `/opt/gokesari-db` | This kit (root-owned copy) |
| `/etc/gokesari-db/config.env` | Settings (no secrets) |
| `/etc/gokesari-db/secrets/` | Passwords and keys, root only |
| `/etc/gokesari-db/peers/` | Peers' public keys |
| `/etc/postgresql/18/{main,staging}/` | `conf.d/90-gokesari.conf`, `pg_hba.conf`, `pg_ident.conf`, `tls/` |
| `/etc/pgbackrest/pgbackrest.conf`, `conf.d/secrets.conf` | pgBackRest; the secrets file holds R2's keys and the passphrase |
| `/var/lib/gokesari-db/{dumps,snapshots,drill,health}` | Nightly dumps, workflow snapshots, drill results (`drill/drills.csv`), health-check state |
| `/var/lib/pgbackrest` | repo1 |

## WireGuard peers and ports

Set in `lib.sh` (plan §4.6). One key per workflow job, so two jobs never share a tunnel.

| Peer | Address | May reach |
|---|---|---|
| owner-mac | 10.66.0.10 | SSH (admin), production, staging |
| gh-test-db | 10.66.0.21 | SSH (snapshot only), staging |
| gh-copy-shops-export | 10.66.0.22 | staging |
| gh-prod-db | 10.66.0.23 | SSH (snapshot only), production |
| gh-copy-shops | 10.66.0.24 | SSH (snapshot only), production |

## Where the kit differs from the plan

1. **Four workflow keys, not three.** `copy-shops.yml` has two jobs in two GitHub environments. Its "export" job reads the test database, so it needs its own tunnel to staging.
2. **`gk-db-snapshot` sets the restore point itself.**
   - So `pg_create_restore_point` is granted to `gksnap` only, not to the app role.
   - The workflows need only the SSH call (plan §7 A1 and B1).
3. **fail2ban watches SSH only.**
   - Only allow-listed addresses can reach PostgreSQL at all.
   - So a PostgreSQL jail could only ever ban the app server.
   - Failed database logins are reported by the health check instead.
4. **PostgreSQL logs keep Debian's rotation** (weekly, 10 kept) rather than daily for 14 days. The logs are small, and Debian's file stays untouched.
5. **`access.sh` adds firewall rules but never deletes them.** It lists rules that are no longer in `config.env`, for a person to remove. A mistyped address can therefore never remove a working rule.
6. **The restore drill has no timer.** A session runs it monthly and records it (plan §5.3). The `gk-drill` check in healthchecks.io alerts if a month passes without one.

## What was tested, and what was not

Tested on 16-Nov-2026 against a throwaway PostgreSQL 18.6 instance on the owner's Mac (local socket only, deleted afterwards):
- **Settings template:** all 38 settings load with no errors (`pg_file_settings`). Checksums, TLS, GMT and zstd WAL compression are on.
- **Access rules:** the generated `pg_hba.conf` (8 rules for production) and `pg_ident.conf` parse with no errors.
- **Roles and database:**
  - `50-roles.sh`'s SQL runs cleanly twice;
  - the app role logs in with its generated SCRAM hash, and a wrong password is refused;
  - the read-only role cannot create tables.
- **Snapshot user:** `gksnap` can `pg_dump` the whole database and set a restore point.
- **Drill:**
  - the wallet-ledger check catches a planted mismatch;
  - the row-count query works;
  - a dump restores into a scratch database.
- **Health check:** its queries run as `monitor`.
- **Firewall and peers** (with `ufw` and root faked, on bash 3.2):
  - `access.sh` issues the expected 14 rules, flags a stale one and refuses a bad IP address;
  - the peer table and the WireGuard key check work.
- **Syntax:** every script passes `bash -n`.

**Not tested before the real server:** anything that needs Ubuntu itself: apt, `pg_createcluster`, ufw, WireGuard, certbot, pgBackRest and R2. The first real run is Phase 1 under gate G2. Each step checks its own result and stops on the first problem.
