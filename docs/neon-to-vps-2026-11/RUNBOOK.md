# GoKesari database server: runbook

**Written 16-Nov-2026, 17.05 IST.** Plan: [PLAN.md](PLAN.md). Scripts: [scripts/vps-db/](../../scripts/vps-db/README.md).

- **Part 1** builds the server (Phase 1).
- **Part 2** is for running it.
- **Part 3** points to what comes after.

Times are IST. Never paste a password or key into a chat or a commit. Public keys and IP addresses are fine.

**Status of the owner's decisions** (plan §11):

| # | Decision | Status |
|---|---|---|
| 1 | Hostinger VPS, Mumbai, 24 months | **Bought: KVM 4**, 16-Nov-2026 21.16 IST (decided as KVM 2; the owner chose the larger plan). Moved from Kuala Lumpur to Mumbai at 21.44 IST; IPv4 189.72.155.162 |
| 2 | Staging on the same server | Built as recommended |
| 3 | Off-site backups | **Changed**, 16-Nov-2026 about 22.00 IST: **VPS only for now**, no R2 ("Keep R2" at 21.53, then "keep the database on local VPS server only"). Leave `R2_ACCOUNT_ID` empty; add R2 later with "Adding R2 later" (Part 2) |
| 4 | WireGuard | Built as recommended |
| 5 | Where alerts go | **OPEN.** `ALERT_DESTINATION` placeholder in `config.env`; step 17 waits for it |
| 6 | Names `gokesari` / `gokesari_test` | Built as recommended |
| 7 | Staging cron back to every minute | As recommended, applied at the staging cut-over (Part 3) |
| 8 | Production cut-over window | **OPEN.** Placeholder in Part 3 |
| 9 | Keep Neon 14 days (staging) and 30 days (production) | As recommended (Part 3) |

---

## Part 1: Phase 1, building the server

### Gates

- **G1 (owner):** the VPS is bought: [G1_OWNER_CHECKLIST.md](G1_OWNER_CHECKLIST.md). The R2 account is skipped while decision 3 is "VPS only".
- **G2 (owner's OK, in words, before step 3).** The OK covers:
  - running this kit as root on the new VPS;
  - adding the DNS records `db` and `db-test` (new names; nothing that exists changes);
  - accepting Let's Encrypt's subscriber agreement;
  - adding new GitHub environment secrets, which nothing uses until Phase 2;
  - setting hPanel's VPS firewall.

**Phase 1 does not change** gokesari.com, test.gokesari.com, their settings, `main`, `staging` or Neon.

On the Mac, every command below uses the admin key made at G1: `~/.ssh/gokesari_db_admin`.

### Steps

**1. Mac tools.** With the owner's OK to install them:
- `brew install wireguard-tools age`;
- the **WireGuard** app from the Mac App Store.

**2. Dump encryption key** (owner, on the Mac, about 1 minute):
```bash
mkdir -p ~/.config/gokesari && age-keygen -o ~/.config/gokesari/age-dumps.key
```
- It prints `Public key: age1…`. That line goes into `config.env` as `DUMP_AGE_RECIPIENT`.
- Copy the file's contents into the password manager as "GoKesari DB dump key": `pbcopy < ~/.config/gokesari/age-dumps.key`, then paste.
- This key never goes on the server.

**3. Copy the kit to the server** (session). `<IP>` is the VPS address from G1. The first login is as root, with the admin key added at purchase:
```bash
rsync -a --delete -e "ssh -i ~/.ssh/gokesari_db_admin" scripts/vps-db/ root@<IP>:/opt/gokesari-db/
```
```bash
ssh -i ~/.ssh/gokesari_db_admin root@<IP> 'chown -R root:root /opt/gokesari-db && install -d -m 755 /etc/gokesari-db && cp -n /opt/gokesari-db/config.example.env /etc/gokesari-db/config.env'
```

**4. Fill in `/etc/gokesari-db/config.env`** (session, on the server). Set:
- `VPS_PUBLIC_IP`;
- `ADMIN_SSH_PUBKEY` (the `.pub` from G1);
- `R2_ACCOUNT_ID`: **leave empty** while decision 3 is "VPS only"; every backup then stays on this server;
- `DUMP_AGE_RECIPIENT` (step 2);
- `LETSENCRYPT_EMAIL`: the owner's choice, or empty.

Leave `APP_IPS_*` empty until step 18. Leave `ALERT_DESTINATION` as the placeholder until decision 5.

**5. Preflight:** `/opt/gokesari-db/00-preflight.sh`. It stops unless this is Ubuntu 24.04 on a KVM 2 or larger, with that IP address. Before it, the session checks through the Hostinger API that the VPS is in Mumbai (data centre 23, `mum2`).

**6. Base system:** `/opt/gokesari-db/10-os.sh`.

**7. Admin login check.** Keep the root session open. From a **new** Mac terminal:
```bash
ssh -i ~/.ssh/gokesari_db_admin gkadmin@<IP> 'sudo -n true && echo admin-ok'
```
From here on, log in as `gkadmin` and use `sudo`.

**8. WireGuard:** `sudo /opt/gokesari-db/20-wireguard.sh`. It prints the server's public key and endpoint. Then set up the owner's Mac:
1. In the Mac's WireGuard app: **Add Empty Tunnel…**, named `gokesari-db`. The app makes the Mac's private key and shows its **public key**.
2. Paste in the rest from `sudo gk-peer client-config owner-mac`. Keep the app's own `PrivateKey` line.
3. On the server: `sudo gk-peer set-wg owner-mac <the app's public key>`.
4. Activate the tunnel. Check with `ssh -i ~/.ssh/gokesari_db_admin gkadmin@10.66.0.1 'echo tunnel-ok'`.

From here on, use `gkadmin@10.66.0.1`.

**9. PostgreSQL:** `sudo /opt/gokesari-db/30-postgres.sh`. It ends by printing both instances: version, checksums on, collation `C.UTF-8`, time zone GMT.

**10. DNS** (owner in hPanel, or a session with the G2 OK). In the gokesari.com zone, add two records:

| Type | Name | Points to | TTL |
|---|---|---|---|
| A | `db` | the VPS IP | 300 |
| A | `db-test` | the VPS IP | 300 |

**11. Certificate:** `sudo /opt/gokesari-db/40-tls.sh`. It stops until both names resolve to the VPS. It ends with a renewal dry run and each instance's certificate subject and expiry.

**12. Roles and databases:** `sudo /opt/gokesari-db/50-roles.sh`.

**13. R2 key.** **Skip this step while `R2_ACCOUNT_ID` is empty** (decision 3, "VPS only"). With R2, the **owner** runs it in their own Mac Terminal, so no session sees it:
```bash
ssh -t -i ~/.ssh/gokesari_db_admin gkadmin@10.66.0.1 sudo gk-db-secret set-r2
```
Paste the **write** token's Access Key ID and Secret Access Key from the password manager. The input is hidden.

Then the session:
1. Runs `sudo gk-db-secret cipher`.
2. Runs `scripts/vps-db/mac/copy-secret.sh pgbackrest-cipher-pass`.
3. The owner pastes it into the password manager as "GoKesari DB pgBackRest passphrase" and says "saved". Without this passphrase the R2 backups can never be read.

**14. Backups:** `sudo /opt/gokesari-db/60-pgbackrest.sh` (with R2: add `--cipher-saved`). It:
- creates both stanzas;
- runs `check`, which proves the WAL reaches this disk (and R2, when set);
- takes the first full backups of both instances.

**15. Workflow keys and passwords** (session, with the G2 OK):
1. Run `scripts/vps-db/mac/make-github-keys.sh`. It puts each private key straight into a GitHub secret:
   - `test` environment: `VPS_WG_KEY_TEST_DB`, `VPS_SSH_KEY_TEST_DB`, `VPS_WG_KEY_COPY_SHOPS_EXPORT`;
   - `production` environment: `VPS_WG_KEY_PROD_DB`, `VPS_SSH_KEY_PROD_DB`, `VPS_WG_KEY_COPY_SHOPS`, `VPS_SSH_KEY_COPY_SHOPS`.
2. It prints `sudo gk-peer set-wg …` and `sudo gk-peer set-ssh …` lines. Run them on the server.
3. `sudo gk-peer list` should then show every peer with its keys.
4. For each of these, run `scripts/vps-db/mac/copy-secret.sh <name>` and have the owner save it in the password manager:
   - `gokesari_app`
   - `gokesari_ro`
   - `gokesari_test_app`
   - `gokesari_test_ro`

   They go into hPanel and GitHub only at the cut-overs.

**16. Schedules:** `sudo /opt/gokesari-db/70-schedules.sh`. It lists the six timers.

**17. Alerts: waits for decision 5.** Until then the checks only write to the server's journal: **nobody is alerted**, so the staging cut-over (G3) must wait for this step. When decided:
1. The owner creates a free healthchecks.io account, with a project "GoKesari DB".
2. The owner adds the integration (e-mail and/or Telegram) and copies the project's **ping key** (Settings → API Access → Ping key).
3. The owner, in their own Terminal:
   ```bash
   ssh -t -i ~/.ssh/gokesari_db_admin gkadmin@10.66.0.1 sudo gk-db-secret set-healthchecks
   ```
4. The checks appear on their first ping. Set each one's period and grace:

| Check | Period | Grace | Means |
|---|---|---|---|
| `gk-health` | 5 min | 10 min | Act now: an instance is down, archiving is stuck, disk is over 85 %, or the app has had no connection for 15 min |
| `gk-warn` | 5 min | 10 min | Look today: disk over 70 %, memory, CPU, connections over 70 %, failed logins |
| `gk-backup-prod`, `gk-backup-staging` | 1 day | 2 h | Nightly pgBackRest (alerts if no success by about 04.30 IST) |
| `gk-dump-prod`, `gk-dump-staging` | 1 day | 2 h | Nightly dump (to R2 when set, otherwise kept on this disk) |
| `gk-cert` | 1 day | 6 h | Certificate has 14+ days left |
| `gk-drill` | 31 days | 7 days | Monthly restore drill done and passed |
| `gk-setup` | (delete after the first ping) | | Test ping from `set-healthchecks` |

Also set up a free uptime monitor on https://gokesari.com (healthchecks.io does not check websites). UptimeRobot is one example; the owner chooses.

**18. Step B2: the app servers' outgoing address.**
1. In hPanel → each site → **SSH access** → terminal:
   ```bash
   curl -s https://ifconfig.me; echo
   ```
2. Put the addresses in `config.env`: gokesari.com's in `APP_IPS_PROD`, test.gokesari.com's in `APP_IPS_STAGING`.
3. Run `sudo /opt/gokesari-db/access.sh`.
4. Then, from each site's terminal (no password needed):
   ```bash
   curl -so /dev/null -w 'TCP connect %{time_connect}s\n' telnet://db.gokesari.com:5432 </dev/null
   ```
   ```bash
   openssl s_client -starttls postgres -connect db.gokesari.com:5432 -servername db.gokesari.com </dev/null 2>/dev/null | grep -E 'subject=|Verify return code'
   ```
   On test.gokesari.com use `db-test.gokesari.com:5433`. **Target: TCP connect under 0.005 s** (plan §3.3). Over 0.015 s: stop and report.
5. Optional login check (owner, pasting the read-only URL from the password manager), in the deployed app's folder:
   ```bash
   U='<read-only URL>' node -e "const s=require('postgres')(process.env.U,{ssl:'require'});s\`select inet_client_addr()::text a\`.then(r=>{console.log(r[0]);return s.end()})"
   ```

**19. First restore drills.** Backups are only minutes old, so use `--latest`:
```bash
sudo gk-db-restore-drill staging --latest
```
```bash
sudo gk-db-restore-drill prod --latest
```
Both must end `PASS`. Record the result lines in `Doc_GoKesari/Test_Cases_Tracking/GOKESARI_DB_RESTORE_DRILLS.xlsx` (make it on the first drill).

**20. Lockdown.** Logged in over the tunnel (`gkadmin@10.66.0.1`), run `sudo /opt/gokesari-db/90-lockdown.sh`. Then:
- From a new terminal, check that `ssh … gkadmin@10.66.0.1` still works.
- Check that `ssh … gkadmin@<IP>` (public) and `root@…` are refused.

**21. hPanel VPS firewall** (owner, or a session with the G2 OK):
1. Print the rules: `sudo /opt/gokesari-db/access.sh --hostinger`.
2. Enter them in hPanel → VPS → Security → Firewall. Drop everything else.
3. Check again: WireGuard still connects, and step 18's TCP test still works.

**22. Report.** Write `GOKESARI_DB_SERVER_PHASE1_<date>.md` in `Doc_GoKesari/Devlopment_Trackers` (owner's Mac). It records:
- each step's result and time;
- the measured connect time;
- the drill lines;
- anything that differed.

Then tell the owner Phase 1 is done.

**Phase 1 is done when:**
- [ ] Both instances run PostgreSQL 18 with checksums, TLS (Let's Encrypt) and the plan's settings.
- [ ] pgBackRest `check` passes for both; the first full backups are in repo1 (and R2, when set).
- [ ] Both drills `PASS`.
- [ ] Every peer is in `gk-peer list` with its keys; the GitHub secrets exist.
- [ ] SSH works only over the tunnel; ufw and hPanel's firewall match `access.sh --hostinger`.
- [ ] The app servers' addresses are allowed, and the connect time is measured.
- [ ] Six timers are listed.
- [ ] Alerts reach the owner. **Waits for decision 5; needed before G3.**
- [ ] The owner has these in the password manager:
  - the root password;
  - with R2 only: both R2 keys and the pgBackRest passphrase;
  - the dump key;
  - the four role passwords.

---

## Part 2: Running it

**Log in:** WireGuard tunnel on, then `ssh -i ~/.ssh/gokesari_db_admin gkadmin@10.66.0.1`.

**Status at a glance:**
```bash
sudo gk-db-health; pg_lsclusters; sudo -u postgres pgbackrest info; sudo gk-peer list; systemctl list-timers 'gk-db-*' --no-pager
```

### When an alert arrives

| Message | Do this |
|---|---|
| `prod (5432) is DOWN` | Run `sudo systemctl status postgresql@18-main` and `sudo tail -50 /var/log/postgresql/postgresql-18-main.log`. If it stopped, run `sudo systemctl start postgresql@18-main`. If it will not start, the log says why; disk full is the usual cause (next row). |
| `Disk … over 85 %` | Run `sudo du -xh /var/lib --max-depth=3 \| sort -h \| tail`. If WAL is piling up (`pg_wal`), fix archiving first (next row). In an emergency, `sudo rm /var/lib/postgresql/ballast` frees 2 GB at once; recreate it later with `fallocate -l 2G`. Larger disk: hPanel resize to KVM 4 (owner). |
| `WAL archiving stuck` / `last WAL archive attempt failed` | Look at `sudo -u postgres pgbackrest --stanza=prod check` and `/var/log/pgbackrest/`. The usual causes are an R2 key that was rotated or revoked (`gk-db-secret set-r2`) or the network to R2. pgBackRest drops WAL beyond 4 GB to protect the disk, so point-in-time restore then has a gap. Take a new full backup once fixed (`sudo gk-db-backup prod full`). |
| `no app connection … for 15 min` | Is gokesari.com up? If the site shows database errors, Hostinger's outgoing IP has probably changed: run step 18.1 again, put the new address in `config.env`, run `access.sh`, then update hPanel's firewall (step 21). The old rule is listed for removal. Five minutes. |
| `failed login(s)` | Only the app servers and tunnel peers can reach PostgreSQL, so this is a wrong password in a setting or workflow. The line names the role and address. |
| `connections in use` | `select usename, client_addr, state, count(*) from pg_stat_activity group by 1,2,3 order by 4 desc;` A deploy overlap is normal for minutes. |
| `gk-backup-*` / `gk-dump-*` late or failed | `journalctl -u gk-db-backup-prod -n 100` (or `-dump-`). Re-run by hand: `sudo gk-db-backup prod` / `sudo gk-db-dump prod`. |
| `gk-cert` | `sudo certbot renew --cert-name gokesari-db`; check that hPanel's firewall still lets 80/tcp in. |

### Restores

- **Look at old data without touching anything:**
  - Run `sudo gk-db-restore-drill prod --repo 1 --minutes-ago <N>`.
  - It restores the database as it was N minutes ago into a scratch instance and prints row counts.
  - It removes the scratch copy at the end. To keep a copy open for queries, a session runs the same `pgbackrest restore` by hand instead.
- **Undo a bad migration or a bad data change on production.** This is destructive, needs the **owner's OK**, and the site goes read-only, then down, for about 15–30 minutes:
  1. Freeze: `alter database gokesari set default_transaction_read_only = on;`.
  2. Find the restore point the workflow printed (`restore_point=…`), or a time.
  3. Run:
     ```bash
     sudo systemctl stop postgresql@18-main
     sudo -u postgres pgbackrest --stanza=prod --delta --type=name --target=<restore point> --target-action=promote restore
     ```
     or, for a time: `--type=time --target="YYYY-MM-DD HH:MM:SS+05:30"`.
  4. Then:
     ```bash
     sudo systemctl start postgresql@18-main
     ```
  5. Check; then unfreeze; then take a new full backup.
- **From a workflow snapshot:**
  1. `sudo ls -lt /var/lib/gokesari-db/snapshots/prod`.
  2. Restore it into a new database (`createdb -p 5432 restore_check; pg_restore -p 5432 -d restore_check --no-owner <file>`), compare, and copy back only what is needed.
- **Server lost:**
  1. New KVM 4 in Mumbai (owner).
  2. Part 1 steps 3–12.
  3. Restore from R2: the R2 **restore-only** key goes into `/etc/pgbackrest/conf.d/secrets.conf`, then `pgbackrest --stanza=prod --repo=2 restore` into the stopped, empty cluster.
  4. Point the DNS names at the new IP.

  1–2 hours; up to 5 minutes of data lost.

  **Without R2** (decision 3, "VPS only"), step 3 is instead the newer of:
  - Hostinger's weekly VPS backup, restored in hPanel;
  - the newest encrypted dump on the Mac (`mac/pull-dumps.sh` folder): `age -d`, then `pg_restore` into the empty database.

  Everything written since that copy is lost: up to 7 days, less if the Mac pulled a dump more recently.

### Monthly window (first Monday; drill at 11.00 IST)

1. **Restore drill:**
   - Run `sudo gk-db-restore-drill prod` (R2 when set, otherwise this disk; 1 hour ago), then `staging`.
   - Record both lines in `GOKESARI_DB_RESTORE_DRILLS.xlsx`.
   - Quarterly, also restore from R2 on a machine that is not the VPS, with the **restore-only** key. Without R2: restore the newest Mac dump on the Mac instead.
2. **Updates:**
   - Run `sudo apt-get update && apt list --upgradable`.
   - **PostgreSQL minor releases:** staging first (`sudo apt-get install --only-upgrade postgresql-18 postgresql-client-18`, then `sudo systemctl restart postgresql@18-staging`); production the next day. About 10 seconds of reconnects each.
   - **Kernel:** reboot only if `/var/run/reboot-required` exists, Sunday 03.00–03.30 IST.
3. **Review:**
   - `sudo journalctl -u 'gk-db-*' --since -31d | grep -iE 'error|warn' | tail`;
   - failed logins;
   - `sudo ufw status numbered` against `access.sh`;
   - `select query, calls, mean_exec_time from pg_stat_statements order by total_exec_time desc limit 15;`.
4. **30 days after each cut-over:** set `log_connections = off` in `templates/postgresql.conf.tmpl` and on the server, then reload.
5. **Weekly copy to the Mac:** `scripts/vps-db/mac/pull-dumps.sh`.

### Keys and passwords

- **Role password:**
  1. Delete the secret file (`sudo rm /etc/gokesari-db/secrets/<role>`).
  2. Run `sudo /opt/gokesari-db/50-roles.sh` (it makes a new one).
  3. Then, with the owner's OK, update hPanel's `DATABASE_URL` or the GitHub secret, and redeploy.

  The old password stops working at once, so do it in that order.
- **Workflow keys:** run `scripts/vps-db/mac/make-github-keys.sh --rotate`, then the printed `gk-peer` lines.
- **A lost or departed Mac:** run `sudo gk-peer remove owner-mac`, set up a new Mac (Part 1 step 8), and rotate the role passwords it knew.
- **Adding R2 later** (decision 3 changed back):
  1. The owner does G1 checklist section C.
  2. Set `R2_ACCOUNT_ID` in `/etc/gokesari-db/config.env`.
  3. Part 1 step 13: the R2 write key, then the pgBackRest passphrase.
  4. `sudo /opt/gokesari-db/60-pgbackrest.sh --cipher-saved`. It adds repo2 and takes a full backup into it.
  5. `sudo gk-db-backup check`, then `sudo gk-db-restore-drill staging --repo 2 --latest`.
  6. Optional: copy the existing encrypted dumps to R2 with `rclone`.
- **R2 key:** make a new token in Cloudflare, `gk-db-secret set-r2`, `sudo gk-db-backup check`, then delete the old token. **Never change the pgBackRest passphrase**: R2 backups made with it would become unreadable.

### Locked out of SSH

The usual cause is a broken WireGuard tunnel after lockdown.
1. Check the Mac's tunnel: the WireGuard app shows a handshake.
2. If the server side is broken, use hPanel → VPS: the **browser terminal** or **recovery mode**. Check the exact names in hPanel during Phase 1 and note them here.
3. From there:
   ```bash
   rm /etc/ssh/sshd_config.d/05-gokesari-lockdown.conf; systemctl reload ssh; ufw limit 22/tcp
   ```
4. Then fix WireGuard, and run `90-lockdown.sh` again.

---

## Part 3: After Phase 1

These follow the plan; each step needs its own gate.

- **Phase 2, the tooling PR** (plan §7 A): needs
  - `test-db.yml` provider-aware, with its WireGuard and snapshot steps;
  - the guards also checking the port;
  - `copy.sh` copying `neondb` into the new names (decision 6; plan §7 A3);
  - checksums;
  - `verify-full`;
  - CI on `postgres:18`.

  The workflows use the secret names from step 15 and two non-secret variables:
  - `VPS_WG_SERVER_PUBLIC_KEY`;
  - `VPS_WG_ENDPOINT` = `<IP>:51820`.
- **G3, the staging cut-over** (plan §8.3): needs step 17 (alerts) done first. At the cut-over:
  - set `APP_LIVE_STAGING="yes"` in `config.env`;
  - put staging's every-minute cron line back to every minute (decision 7; plan §7 C2).
- **G4, the production cut-over** (plan §8.4): **window: `<decision 8: date and IST time, not decided>`.** About 20–30 minutes read-only. Afterwards set `APP_LIVE_PROD="yes"`.
- **G5, retiring Neon** (plan §8.7): keep each frozen Neon project at least **14 days (staging)** and **30 days (production)** after its cut-over (decision 9). Delete only on the owner's OK at the time.
