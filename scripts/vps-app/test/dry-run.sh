#!/usr/bin/env bash
# Dry run of the web-layer kit against a temporary folder, with systemctl,
# systemd-run, caddy, git, curl, useradd, runuser, flock, ufw and certbot replaced by
# the stubs in test/stubs. Nothing is installed and nothing leaves this machine.
#
#   bash scripts/vps-app/test/dry-run.sh        (bash 4 or newer; on a Mac: Homebrew's bash)
#
# Needs: node (json_get without jq), ssh-keygen, tar. Prints PASS/FAIL per check.
set -uo pipefail
[ "${BASH_VERSINFO[0]}" -ge 4 ] || { echo "Needs bash 4+ (on a Mac: /opt/homebrew/bin/bash $0)"; exit 2; }

KIT=$(cd "$(dirname "$0")/.." && pwd)
T=$(mktemp -d "${TMPDIR:-/tmp}/gk-app-dry.XXXXXX")
export GK_APP_ROOT=$T/root GK_APP_KIT=$KIT GK_DB_KIT=$KIT/../vps-db
export GK_TEST_LOG=$T/calls.log GK_TEST_STATE=$T/state
export GK_HEALTH_WAIT=6 GK_DRAIN_SECONDS=60
BASH_BIN=$BASH
export PATH="$KIT/test/stubs:$(dirname "$BASH_BIN"):$PATH"
mkdir -p "$GK_APP_ROOT" "$GK_TEST_STATE/units" "$GK_APP_ROOT/etc/gokesari-db/secrets" "$GK_APP_ROOT/run/lock"
touch "$GK_TEST_LOG" "$GK_TEST_STATE/units/caddy.service.active"

# Fake secrets: role passwords as the database kit makes them, a ping key, site values.
PW_STAGING=StagingRolePw0123456789abcdefghijABCDEFGH
PW_PROD=ProdRolePw0123456789abcdefghijABCDEFGHIJ
printf '%s\n' "$PW_STAGING" > "$GK_APP_ROOT/etc/gokesari-db/secrets/gokesari_test_app"
printf '%s\n' "$PW_PROD" > "$GK_APP_ROOT/etc/gokesari-db/secrets/gokesari_app"
printf 'HcPingKey_0123456789ab\n' > "$GK_APP_ROOT/etc/gokesari-db/secrets/hc-ping-key"
SECRETS=("$PW_STAGING" "$PW_PROD" "CronSecretValue-7c1d" "AuthSecretValue-99x" "sk_live_PasteValue_42" "it's a 'quoted' \$value with \\backslash and \`tick\`" "LINE-TWO-OF-PEM")
# The healthchecks.io ping key is in the URL that the database kit's hc_ping passes to curl
# (reused here as it is); it is checked separately: never printed, never in a site's files.
HC_KEY=HcPingKey_0123456789ab
# The owner has added staging's deploy key in GitHub, not production's yet.
export GK_STUB_GIT_FAIL_KEY=gokesari-prod.deploykey

pass=0; fail=0
ok() { pass=$((pass + 1)); printf 'PASS  %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf 'FAIL  %s\n' "$1"; [ -z "${2:-}" ] || printf '      %s\n' "$2"; }
check() { local name=$1; shift; if "$@" >/dev/null 2>&1; then ok "$name"; else bad "$name"; fi; }
has() { grep -qF -- "$2" "$1"; }
hasnt() { ! grep -qF -- "$2" "$1"; }
eq() { [ "$1" = "$2" ] || { echo "got [$1] want [$2]" >&2; return 1; }; }
jget() { node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=j[process.argv[2]];console.log(v===undefined?"":v)' "$1" "$2"; }
site=$KIT/bin/gk-site
deploy=$KIT/bin/gk-deploy
OUT=$T/out.txt
run() { "$@" > "$OUT" 2>&1; }
no_secrets_in() { # no_secrets_in <file...>: none of the fake secrets appears
  local s f
  for f in "$@"; do for s in "${SECRETS[@]}"; do grep -qF -- "$s" "$f" && { echo "secret found in $f" >&2; return 1; }; done; done
  return 0
}

echo "== Cron: UTC hPanel lines -> OnCalendar on the IST clock"
cron_case() {
  local got
  got=$("$BASH_BIN" -c '. "$GK_APP_KIT/lib.sh"; cron_to_oncalendar "$1" | paste -sd"|" -' _ "$1" 2>&1)
  if [ "$got" = "$2" ]; then ok "cron '$1' -> $2"; else bad "cron '$1'" "got '$got', want '$2'"; fi
}
cron_case '* * * * *' '*-*-* *:*:00'
cron_case '17 * * * *' '*-*-* *:47:00 Asia/Kolkata'
cron_case '30 23 * * *' '*-*-* 05:00:00 Asia/Kolkata'
cron_case '0 */6 * * *' '*-*-* 05,11,17,23:30:00 Asia/Kolkata'
cron_case '*/15 * * * *' '*-*-* *:00,15,30,45:00 Asia/Kolkata'
cron_case '45 20 * * *' '*-*-* 02:15:00 Asia/Kolkata'
cron_case '0,30 18 * * *' '*-*-* 00:00:00 Asia/Kolkata|*-*-* 23:30:00 Asia/Kolkata'
if "$BASH_BIN" -c '. "$GK_APP_KIT/lib.sh"; cron_to_oncalendar "0 0 1 * *"' >/dev/null 2>&1; then bad "cron with a day of month is refused"; else ok "cron with a day of month is refused"; fi

echo "== gk-site add"
run "$site" add gokesari-staging --domain test.gokesari.com --domain www.test.gokesari.com \
  --repo sanjaymorankar-debug/GoKesari --branch staging --port-base 3200 --mem 2 --cpu 100 \
  --db-socket-port 5433 --cron-preset gokesari
if [ $? -eq 0 ]; then ok "add gokesari-staging"; else bad "add gokesari-staging" "$(tail -3 "$OUT")"; fi
run "$site" add gokesari-prod --domain gokesari.com --domain www.gokesari.com \
  --repo sanjaymorankar-debug/GoKesari --branch main --port-base 3100 --mem 4 --cpu 200 \
  --db-socket-port 5432 --cron-preset gokesari
if [ $? -eq 0 ]; then ok "add gokesari-prod"; else bad "add gokesari-prod" "$(tail -3 "$OUT")"; fi
check "prod: deploy key's public half printed" has "$OUT" "ssh-ed25519 "
E=$GK_APP_ROOT/etc
U=$E/systemd/system
check "env file exists, mode 600" eq "$(ls -l "$E/sites/gokesari-staging.env" | cut -c1-10)" "-rw-------"
check "deploy key exists, mode 600" eq "$(ls -l "$E/sites/gokesari-staging.deploykey" | cut -c1-10)" "-rw-------"
check "conf: ports 3201/3202" has "$E/sites/gokesari-staging.conf" "SITE_PORT_GREEN=3202"
check "conf: TLS internal" has "$E/sites/gokesari-staging.conf" "SITE_TLS=internal"
D=$U/site@gokesari-staging-green.service.d/10-slot.conf
check "drop-in: user" has "$D" "User=gk-gokesari-staging"
check "drop-in: env file" has "$D" "EnvironmentFile=/etc/sites/gokesari-staging.env"
check "drop-in: port 3202" has "$D" "Environment=GK_SLOT_PORT=3202 PORT=3202"
check "drop-in: working dir" has "$D" "WorkingDirectory=/srv/sites/gokesari-staging/current-green"
check "drop-in: .next/cache writable" has "$D" "ReadWritePaths=-/srv/sites/gokesari-staging/current-green/.next/cache"
check "drop-in: limits" has "$D" "MemoryMax=2G"
check "drop-in: CPU" has "$D" "CPUQuota=100%"
check "prod drop-in: 4G / 200%" has "$U/site@gokesari-prod-blue.service.d/10-slot.conf" "MemoryMax=4G"
C=$E/caddy/sites/gokesari-staging.caddy
check "caddy: both names" has "$C" "test.gokesari.com, www.test.gokesari.com {"
check "caddy: tls internal" has "$C" "tls internal"
check "caddy: upstream blue 3201" has "$C" "reverse_proxy 127.0.0.1:3201"
check "cron: hourly at :47 IST" has "$U/gk-cron@gokesari-prod-hourly.timer.d/10-schedule.conf" "OnCalendar=*-*-* *:47:00 Asia/Kolkata"
check "cron: daily at 05:00 IST" has "$U/gk-cron@gokesari-prod-daily.timer.d/10-schedule.conf" "OnCalendar=*-*-* 05:00:00 Asia/Kolkata"
check "cron: every minute" has "$U/gk-cron@gokesari-prod-every-minute.timer.d/10-schedule.conf" "OnCalendar=*-*-* *:*:00"
check "cron: service runs gk-cron-call as the site user, max-time 55" has "$U/gk-cron@gokesari-prod-every-minute.service.d/10-job.conf" "ExecStart=/usr/local/sbin/gk-cron-call gokesari-prod every-minute 55 gokesari.com"
check "cron: daily max-time 300" has "$U/gk-cron@gokesari-prod-daily.service.d/10-job.conf" "gk-cron-call gokesari-prod daily 300 gokesari.com"
check "cron: timers made disabled" hasnt "$GK_TEST_LOG" "enable --now gk-cron@"
check "healthchecks: slugs made (log event)" has "$GK_TEST_STATE/hc.log" "HC gk-deploy-gokesari-prod/log"
check "user gk-gokesari-staging made" test -f "$GK_TEST_STATE/users/gk-gokesari-staging"
key_before=$(cat "$E/sites/gokesari-staging.deploykey.pub")
run "$site" add gokesari-staging --mem 3
check "re-run add: keeps the key" eq "$(cat "$E/sites/gokesari-staging.deploykey.pub")" "$key_before"
check "re-run add: new memory limit" has "$U/site@gokesari-staging-blue.service.d/10-slot.conf" "MemoryMax=3G"
check "re-run add: domains kept" has "$E/sites/gokesari-staging.conf" "test.gokesari.com\\ www.test.gokesari.com"
run "$site" add gokesari-staging --mem 2
if "$site" add other-site --domain example.org --repo a/b --branch main --port-base 3199 > "$OUT" 2>&1; then bad "port clash refused"; else check "port clash refused" has "$OUT" "already gokesari-staging's"; fi
if "$site" add other-site --domain gokesari.com --repo a/b --branch main --port-base 3300 > "$OUT" 2>&1; then bad "domain clash refused"; else check "domain clash refused" has "$OUT" "already gokesari-prod's"; fi
check "no slot left behind by refused adds" test ! -e "$E/sites/other-site.conf"

echo "== gk-site env paste (piped, lines)"
ENVF=$E/sites/gokesari-staging.env
cat > "$T/paste.txt" <<EOF
# a comment line
export AUTH_SECRET="AuthSecretValue-99x"
CRON_SECRET='CronSecretValue-7c1d'

CASHFREE_SECRET_KEY=sk_live_PasteValue_42
DATABASE_URL=postgresql://user:pw@db.gokesari.com:5433/gokesari_test?sslmode=verify-full
SELLER_DATABASE_URL=postgresql://old
PATH=/usr/bin
NODE_OPTIONS=--max-old-space-size=4096
NODE_ENV=production
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=AIzaStubBrowserKey
EOF
printf 'WITH_CRLF=crlf-value\r\n' >> "$T/paste.txt"
run "$site" env paste gokesari-staging < "$T/paste.txt"
if [ $? -eq 0 ]; then ok "paste accepted"; else bad "paste accepted" "$(tail -3 "$OUT")"; fi
check "paste: prints key names" has "$OUT" "CRON_SECRET"
check "paste: values never printed" no_secrets_in "$OUT"
check "paste: retired key ignored" has "$OUT" "Ignored (retired settings): SELLER_DATABASE_URL"
check "paste: DATABASE_URL ignored, written by env db" has "$OUT" "Ignored (written by gk-site env db): DATABASE_URL"
check "paste: process noise ignored" has "$OUT" "Ignored (shell and process settings): PATH NODE_OPTIONS"
check "paste: NODE_ENV kept" has "$ENVF" "NODE_ENV='production'"
check "paste: double quotes stripped" has "$ENVF" "AUTH_SECRET='AuthSecretValue-99x'"
check "paste: single quotes stripped" has "$ENVF" "CRON_SECRET='CronSecretValue-7c1d'"
check "paste: trailing blanks dropped" has "$ENVF" "CASHFREE_SECRET_KEY='sk_live_PasteValue_42'"
check "paste: CR dropped" has "$ENVF" "WITH_CRLF='crlf-value'"
check "paste: retired key not saved" hasnt "$ENVF" "SELLER_DATABASE_URL"
check "paste: env db ran (socket URL)" has "$ENVF" "DATABASE_URL='postgresql:///gokesari_test'"
check "paste: env file still 600" eq "$(ls -l "$ENVF" | cut -c1-10)" "-rw-------"
run "$site" env paste gokesari-staging < "$T/paste.txt"
check "paste again: unchanged" has "$OUT" "AUTH_SECRET                          unchanged"
sum_before=$(cksum < "$ENVF")
printf 'GOOD_KEY=1\nthis line is wrong sk_live_PasteValue_42\nALSO=ok\n=novalue\n' > "$T/bad.txt"
if "$site" env paste gokesari-staging < "$T/bad.txt" > "$OUT" 2>&1; then bad "malformed lines refused"; else ok "malformed lines refused"; fi
check "malformed: line numbers named" has "$OUT" "line 2 line 4"
check "malformed: value not shown" no_secrets_in "$OUT"
check "malformed: nothing saved" eq "$(cksum < "$ENVF")" "$sum_before"
if printf '' | "$site" env paste gokesari-staging > "$OUT" 2>&1; then bad "empty input refused"; else ok "empty input refused"; fi
printf 'AUTH_SECRET=AuthSecretValue-99x\nNEW_ONE=x\nOTHER=y\n' | "$site" env paste gokesari-staging --only NEW_ONE,MISSING_ONE > "$OUT" 2>&1
check "--only: takes only the listed key" has "$OUT" "NEW_ONE                              set"
check "--only: others counted, not listed" has "$OUT" "Ignored (not in --only): 2 keys"
check "--only: missing key named" has "$OUT" "Not in the input: MISSING_ONE"

echo "== gk-site env paste --nul (from /proc/<pid>/environ)"
{
  printf 'PATH=/usr/local/bin:/usr/bin\0HOME=/home/u879099820\0PWD=/home/u879099820/domains/test.gokesari.com/public_html\0'
  printf 'SHLVL=1\0_=/usr/bin/node\0HOSTNAME=in-mum-web1497\0USER=u879099820\0LANG=C.UTF-8\0TERM=xterm\0OLDPWD=/\0'
  printf 'NODE_PATH=/opt/alt/nodejs\0npm_config_cache=/tmp/x\0npm_lifecycle_event=start\0INIT_CWD=/x\0LS_COLORS=rs=0\0PORT=3000\0'
  printf 'NODE_ENV=production\0TEST_DATABASE_URL=postgresql://t\0TEST_NEON_API_KEY=napi_x\0DB_SPLIT_MODE=off\0'
  printf 'CASHFREE_VERIFICATION_PUBLIC_KEY=-----BEGIN PUBLIC KEY-----\nLINE-TWO-OF-PEM\n-----END PUBLIC KEY-----\0'
  printf '%s\0' "ODD_VALUE=it's a 'quoted' \$value with \\backslash and \`tick\`"
  printf 'EQUALS_IN_VALUE=a=b=c\0EMPTY_VALUE=\0'
} > "$T/environ.bin"
run "$site" env paste gokesari-staging --nul < "$T/environ.bin"
if [ $? -eq 0 ]; then ok "nul paste accepted"; else bad "nul paste accepted" "$(tail -3 "$OUT")"; fi
check "nul: values never printed" no_secrets_in "$OUT"
check "nul: noise ignored incl. PORT and npm_*" has "$OUT" "PATH HOME PWD SHLVL _ HOSTNAME USER LANG TERM OLDPWD NODE_PATH npm_config_cache npm_lifecycle_event INIT_CWD LS_COLORS PORT"
check "nul: retired keys ignored" has "$OUT" "Ignored (retired settings): TEST_DATABASE_URL TEST_NEON_API_KEY DB_SPLIT_MODE"
check "nul: multi-line value kept verbatim" has "$ENVF" "LINE-TWO-OF-PEM"
check "nul: '=' inside a value kept" has "$ENVF" "EQUALS_IN_VALUE='a=b=c'"
check "nul: value with a single quote double-quoted and escaped" has "$ENVF" 'ODD_VALUE="it'"'"'s a '"'"'quoted'"'"' \$value with \\backslash and \`tick\`"'
run "$site" env paste gokesari-staging --nul < "$T/environ.bin"
check "nul again: every key unchanged (file reads back exactly)" bash -c '! grep -E " (set|replaced)$" "$1" | grep -v -E "^  PG|DATABASE_URL"' _ "$OUT"
# The env file is also valid shell; compare what a shell reads with the originals.
got=$( set -a; . "$ENVF"; printf '%s|%s' "$ODD_VALUE" "$CASHFREE_VERIFICATION_PUBLIC_KEY" )
want=$(printf '%s|%s' "it's a 'quoted' \$value with \\backslash and \`tick\`" $'-----BEGIN PUBLIC KEY-----\nLINE-TWO-OF-PEM\n-----END PUBLIC KEY-----')
check "env file values read back byte for byte" eq "$got" "$want"

echo "== gk-site env paste (typed, hidden; a pseudo-terminal)"
if script -q /dev/null true >/dev/null 2>&1; then
  # Typed after the prompt, as a person would (the terminal echoes anything sent earlier).
  { /bin/sleep 2; printf 'TYPED_KEY=TypedSecret-ZZ9\n'; /bin/sleep 1; printf '.\n'; /bin/sleep 1; } \
    | script -q /dev/null "$site" env paste gokesari-staging > "$T/tty.txt" 2>&1
  check "typed: prompt shown" has "$T/tty.txt" "Paste KEY=VALUE lines (not shown)"
  check "typed: key saved" has "$ENVF" "TYPED_KEY='TypedSecret-ZZ9'"
  check "typed: value not echoed on the terminal" hasnt "$T/tty.txt" "TypedSecret-ZZ9"
else
  echo "SKIP  typed paste: no pseudo-terminal here (script: openpty refused)"
fi

echo "== gk-site env set / unset / keys"
printf 'SetValue-123\n' | "$site" env set gokesari-staging SINGLE_KEY > "$OUT" 2>&1
check "env set from stdin" has "$ENVF" "SINGLE_KEY='SetValue-123'"
check "env set: value not printed" hasnt "$OUT" "SetValue-123"
"$site" env unset gokesari-staging SINGLE_KEY > "$OUT" 2>&1
check "env unset" hasnt "$ENVF" "SINGLE_KEY"
"$site" env keys gokesari-staging > "$OUT" 2>&1
check "env keys: names" has "$OUT" "CASHFREE_VERIFICATION_PUBLIC_KEY"
check "env keys: no values" no_secrets_in "$OUT"

echo "== gk-site env db"
run "$site" env db gokesari-staging
check "env db: password not printed" no_secrets_in "$OUT"
check "env db: URL with empty host" has "$ENVF" "DATABASE_URL='postgresql:///gokesari_test'"
check "env db: socket dir" has "$ENVF" "PGHOST='/var/run/postgresql'"
check "env db: staging port" has "$ENVF" "PGPORT='5433'"
check "env db: role" has "$ENVF" "PGUSER='gokesari_test_app'"
check "env db: password from the db kit's secret" has "$ENVF" "PGPASSWORD='$PW_STAGING'"
check "env db: no sslmode" hasnt "$ENVF" "sslmode"
run "$site" env db gokesari-staging tcp
check "env db tcp: loopback URL" has "$ENVF" "DATABASE_URL='postgresql://gokesari_test_app:$PW_STAGING@127.0.0.1:5433/gokesari_test'"
check "env db tcp: PG* removed" hasnt "$ENVF" "PGHOST="
run "$site" env db gokesari-staging
printf 'AUTH_SECRET=AuthSecretValue-99x\nCRON_SECRET=CronSecretValue-7c1d\n' | "$site" env paste gokesari-prod > /dev/null 2>&1
check "prod env db: port 5432, gokesari" has "$E/sites/gokesari-prod.env" "PGPORT='5432'"
cp "$ENVF" "$T/staging.env.for-postgres-test"

echo "== gk-deploy: first deploy (happy path)"
SHA1=1111111111111111111111111111111111111111
SHA2=2222222222222222222222222222222222222222
SHA3=3333333333333333333333333333333333333333
SHA4=4444444444444444444444444444444444444444
SHA5=5555555555555555555555555555555555555555
S=$GK_APP_ROOT/srv/sites/gokesari-staging
ST=$S/deployed.json
export GK_STUB_HEAD=$SHA1
: > "$GK_TEST_STATE/hc.log"
run "$deploy" now gokesari-staging
if [ $? -eq 0 ]; then ok "now: deploy $SHA1"; else bad "now: deploy" "$(tail -5 "$OUT")"; fi
check "release unpacked and built" test -s "$S/releases/$SHA1/.next/BUILD_ID"
check "built marker" test -f "$S/releases/$SHA1/.gk-built"
check "webpack cache dropped" test ! -e "$S/releases/$SHA1/.next/cache/webpack"
check ".next/cache kept for the runtime" test -d "$S/releases/$SHA1/.next/cache"
check "current-blue -> release" eq "$(readlink "$S/current-blue")" "releases/$SHA1"
check "state: sha" eq "$(jget "$ST" sha)" "$SHA1"
check "state: blue 3201 ok" eq "$(jget "$ST" colour) $(jget "$ST" port) $(jget "$ST" result)" "blue 3201 ok"
check "state: valid JSON with every field" node -e 'const j=require(process.argv[1]); if(!("hold_sha" in j && "last_attempt_reason" in j)) process.exit(1)' "$ST"
check "caddy upstream 3201" has "$C" "reverse_proxy 127.0.0.1:3201"
check "blue running and enabled" test -f "$GK_TEST_STATE/units/site@gokesari-staging-blue.service.enabled"
check "build log written" test -s "$S/shared/build-$SHA1.log"
B=$(grep '^systemd-run' "$GK_TEST_LOG" | tail -1)
check "build: env file loaded by systemd" eq "$(grep -c 'EnvironmentFile=/etc/sites/gokesari-staging.env' <<< "$B")" 1
check "build: as the site user" grep -q -- "--uid=gk-gokesari-staging" <<< "$B"
check "build: 4G / 150% / nice 10 / 20 min" grep -q -- "--nice=10 -p EnvironmentFile=/etc/sites/gokesari-staging.env -p WorkingDirectory=/srv/sites/gokesari-staging/releases/$SHA1 -p MemoryMax=4G -p CPUQuota=150% -p RuntimeMaxSec=20min" <<< "$B"
check "build: GK_BUILD_VERSION = commit" grep -q -- "--setenv=GK_BUILD_VERSION=111111111111" <<< "$B"
check "build: npm ci + npm run build" grep -q -- "npm ci --no-audit --no-fund && npm run build" <<< "$B"
check "git: deploy key, IdentitiesOnly, pinned known_hosts" has "$GK_TEST_LOG" "ssh -i $GK_APP_ROOT/etc/sites/gokesari-staging.deploykey -o IdentitiesOnly=yes -o IdentityAgent=none -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$KIT/github_known_hosts"
check "healthchecks: start then ok" eq "$(cut -d' ' -f2 "$GK_TEST_STATE/hc.log" | paste -sd, -)" "gk-deploy-gokesari-staging/start,gk-deploy-gokesari-staging"
check "no secret on any command line" no_secrets_in "$GK_TEST_LOG"

n_builds=$(grep -c '^systemd-run' "$GK_TEST_LOG")
run "$deploy" run
check "run, same commit: nothing to do" eq "$(grep -c '^systemd-run' "$GK_TEST_LOG")" "$n_builds"

echo "== gk-deploy: next commit (blue -> green, old colour drained)"
export GK_STUB_HEAD=$SHA2
run "$deploy" run
check "run: deployed $SHA2" eq "$(jget "$ST" sha) $(jget "$ST" colour)" "$SHA2 green"
check "caddy upstream 3202" has "$C" "reverse_proxy 127.0.0.1:3202"
check "drained 60 s, then blue stopped" has "$GK_TEST_LOG" "sleep 60"
check "blue stopped" test ! -f "$GK_TEST_STATE/units/site@gokesari-staging-blue.service.active"
check "blue disabled" test ! -f "$GK_TEST_STATE/units/site@gokesari-staging-blue.service.enabled"
check "green running" test -f "$GK_TEST_STATE/units/site@gokesari-staging-green.service.active"
check "previous = $SHA1" eq "$(jget "$ST" previous_sha)" "$SHA1"
check "prod untouched (sites deployed one by one, prod head = same stub)" true

echo "== gk-deploy: failed build"
export GK_STUB_HEAD=$SHA3 GK_STUB_BUILD_FAIL=1
: > "$GK_TEST_STATE/hc.log"
run "$deploy" now gokesari-staging
check "failed build: exit non-zero" test "$(grep -c FAILED "$OUT")" -ge 1
check "failed build: still serving $SHA2 on green" eq "$(jget "$ST" sha) $(jget "$ST" colour)" "$SHA2 green"
check "failed build: attempt recorded" eq "$(jget "$ST" last_attempt_sha) $(jget "$ST" last_attempt_result)" "$SHA3 fail"
check "failed build: reason names the log" grep -q "build failed" <<< "$(jget "$ST" last_attempt_reason)"
check "failed build: caddy unchanged" has "$C" "reverse_proxy 127.0.0.1:3202"
check "failed build: green still running" test -f "$GK_TEST_STATE/units/site@gokesari-staging-green.service.active"
check "failed build: healthchecks fail ping" grep -q "gk-deploy-gokesari-staging/fail" "$GK_TEST_STATE/hc.log"
check "failed build: build log kept" has "$S/shared/build-$SHA3.log" "simulated build failure"
unset GK_STUB_BUILD_FAIL
n_builds=$(grep -c '^systemd-run' "$GK_TEST_LOG")
run "$deploy" run
check "failed commit not retried by the timer" eq "$(grep -c '^systemd-run' "$GK_TEST_LOG")" "$n_builds"

echo "== gk-deploy: failed health check"
export GK_STUB_HEAD=$SHA4 GK_STUB_HEALTH_FAIL_PORT=3201
run "$deploy" run
check "failed health: still $SHA2 on green" eq "$(jget "$ST" sha) $(jget "$ST" colour)" "$SHA2 green"
check "failed health: reason" grep -q "health check: / answered 503" <<< "$(jget "$ST" last_attempt_reason)"
check "failed health: blue stopped again" test ! -f "$GK_TEST_STATE/units/site@gokesari-staging-blue.service.active"
check "failed health: blue back on its previous release" eq "$(readlink "$S/current-blue")" "releases/$SHA1"
check "failed health: caddy unchanged" has "$C" "reverse_proxy 127.0.0.1:3202"
unset GK_STUB_HEALTH_FAIL_PORT

echo "== gk-deploy: Caddy refuses the switch"
export GK_STUB_HEAD=$SHA5 GK_STUB_CADDY_FAIL=1
run "$deploy" run
check "caddy refused: still $SHA2" eq "$(jget "$ST" sha)" "$SHA2"
check "caddy refused: block restored" has "$C" "reverse_proxy 127.0.0.1:3202"
check "caddy refused: reason" grep -q "Caddy refused" <<< "$(jget "$ST" last_attempt_reason)"
unset GK_STUB_CADDY_FAIL

echo "== gk-deploy: rollback"
export GK_STUB_HEAD=$SHA2
run "$deploy" rollback gokesari-staging
if [ $? -eq 0 ]; then ok "rollback ran"; else bad "rollback ran" "$(tail -3 "$OUT")"; fi
check "rollback: $SHA1 on blue" eq "$(jget "$ST" sha) $(jget "$ST" colour) $(jget "$ST" port)" "$SHA1 blue 3201"
check "rollback: caddy upstream 3201" has "$C" "reverse_proxy 127.0.0.1:3201"
check "rollback: $SHA2 held" eq "$(jget "$ST" hold_sha)" "$SHA2"
check "rollback: green stopped after drain" test ! -f "$GK_TEST_STATE/units/site@gokesari-staging-green.service.active"
n_builds=$(grep -c '^systemd-run' "$GK_TEST_LOG")
run "$deploy" run
check "held commit not redeployed by the timer" eq "$(jget "$ST" sha)" "$SHA1"
run "$deploy" rollback gokesari-staging
check "rollback again: back to $SHA2 on green (built, no new build)" eq "$(jget "$ST" sha) $(jget "$ST" colour) $(grep -c '^systemd-run' "$GK_TEST_LOG")" "$SHA2 green $n_builds"

echo "== gk-deploy: restart (same release, other colour)"
run "$deploy" restart gokesari-staging
check "restart: $SHA2 on blue, no build" eq "$(jget "$ST" sha) $(jget "$ST" colour) $(grep -c '^systemd-run' "$GK_TEST_LOG")" "$SHA2 blue $n_builds"
check "restart: caddy 3201" has "$C" "reverse_proxy 127.0.0.1:3201"
check "restart: rollback target unchanged" eq "$(jget "$ST" previous_sha)" "$SHA1"

echo "== gk-deploy: now on the serving commit (fresh build in a new folder)"
run "$deploy" now gokesari-staging
check "now on serving commit: new folder $SHA2-<time>" bash -c 'ls "$1/releases" | grep -q "^$2-[0-9]*$"' _ "$S" "$SHA2"
check "now: serving on green" eq "$(jget "$ST" colour)" "green"

echo "== gk-deploy: housekeeping keeps 5 releases"
for i in 6 7 8 9; do
  /bin/sleep 1   # releases are ordered by time; real deploys are minutes apart
  export GK_STUB_HEAD=$(printf "$i%.0s" $(seq 1 40))
  "$deploy" run > /dev/null 2>&1
done
n=$(ls "$S/releases" | wc -l | tr -d ' ')
check "at most 5 releases kept (have $n)" test "$n" -le 5
check "serving release kept" test -d "$S/releases/$(jget "$ST" release)"
check "rollback target kept" test -d "$S/releases/$(jget "$ST" previous_release)"

echo "== gk-deploy: deploy key missing / GitHub unreachable"
export GK_STUB_GIT_FAIL=1
run "$deploy" run
check "timer run: unreachable GitHub only logged" has "$OUT" "git ls-remote failed"
if "$deploy" now gokesari-staging > "$OUT" 2>&1; then bad "now: unreachable GitHub is an error"; else ok "now: unreachable GitHub is an error"; fi
unset GK_STUB_GIT_FAIL

echo "== gk-cron-call"
cron_secret='Cron"Secret\with-quote'
export GK_TEST_CRON_SECRET_ESCAPED='Cron\"Secret\\with-quote'
port=$(jget "$ST" port)
CRON_SECRET=$cron_secret "$KIT/bin/gk-cron-call" gokesari-staging hourly 300 test.gokesari.com > "$OUT" 2>&1
check "cron call: ran" grep -q "CRON port=$port job=hourly host=test.gokesari.com auth=match" "$GK_TEST_STATE/cron.log"
check "cron call: secret not on curl's command line" bash -c '! grep "^curl" "$1" | grep -qF "$2"' _ "$GK_TEST_LOG" "Secret"
check "cron call: POST, max-time 300, flock" has "$GK_TEST_LOG" "flock -n -E 0"
check "cron call: max-time 300" bash -c 'grep "^curl" "$1" | tail -1 | grep -q -- "--max-time 300"' _ "$GK_TEST_LOG"
if env -u CRON_SECRET "$KIT/bin/gk-cron-call" gokesari-staging hourly 300 test.gokesari.com > "$OUT" 2>&1; then bad "cron call without CRON_SECRET refused"; else ok "cron call without CRON_SECRET refused"; fi

echo "== gk-site cron / tls / status"
"$site" cron gokesari-prod on > "$OUT" 2>&1
check "cron on: three timers enabled" has "$GK_TEST_LOG" "systemctl enable --now gk-cron@gokesari-prod-every-minute.timer gk-cron@gokesari-prod-hourly.timer gk-cron@gokesari-prod-daily.timer"
"$site" cron gokesari-prod status > "$OUT" 2>&1
check "cron status: schedule shown" has "$OUT" "*-*-* 05:00:00 Asia/Kolkata"
"$site" cron gokesari-prod off > "$OUT" 2>&1
check "cron off" has "$GK_TEST_LOG" "systemctl disable --now gk-cron@gokesari-prod-every-minute.timer"
if "$site" tls gokesari-staging acme > "$OUT" 2>&1; then bad "tls acme refused while DNS is elsewhere"; else ok "tls acme refused while DNS is elsewhere"; fi
"$site" tls gokesari-staging acme --force > "$OUT" 2>&1
check "tls acme: no 'tls internal'" hasnt "$C" "tls internal"
check "tls acme: upstream kept" has "$C" "reverse_proxy 127.0.0.1:$(jget "$ST" port)"
check "tls acme: recorded" has "$E/sites/gokesari-staging.conf" "SITE_TLS=acme"
"$site" tls gokesari-staging internal > "$OUT" 2>&1
check "tls internal again" has "$C" "tls internal"
"$site" status > "$OUT" 2>&1
check "status: deployed line" has "$OUT" "deployed"
check "status: memory" has "$OUT" "300 MiB"
check "status: no values" no_secrets_in "$OUT"
"$deploy" status > "$OUT" 2>&1
check "gk-deploy status" has "$OUT" "gokesari-staging"

echo "== gk-app-health"
: > "$GK_TEST_STATE/hc.log"
"$KIT/bin/gk-app-health" > "$OUT" 2>&1
check "health: staging ok ping" grep -q "gk-app-gokesari-staging |" "$GK_TEST_STATE/hc.log"
check "health: prod not deployed, skipped" has "$OUT" "gokesari-prod: not deployed yet"
check "health: through Caddy with --resolve and -k" bash -c 'grep "^curl" "$1" | grep -q -- "-k --resolve test.gokesari.com:443:127.0.0.1 https://test.gokesari.com/api/shops?limit=1"' _ "$GK_TEST_LOG"
rm -f "$GK_TEST_STATE"/units/site@gokesari-staging-*.active "$GK_TEST_STATE"/port-32*
: > "$GK_TEST_STATE/hc.log"
"$KIT/bin/gk-app-health" > "$OUT" 2>&1
check "health: down site -> fail ping with reason" grep -q "gk-app-gokesari-staging/fail | .*is not running" "$GK_TEST_STATE/hc.log"

echo "== 20-web-firewall.sh (certbot renewal moved to Caddy's webroot)"
mkdir -p "$GK_APP_ROOT/etc/letsencrypt/renewal"
cat > "$GK_APP_ROOT/etc/letsencrypt/renewal/gokesari-db.conf" <<'EOF'
# renew_before_expiry = 30 days
version = 2.9.0
archive_dir = /etc/letsencrypt/archive/gokesari-db
cert = /etc/letsencrypt/live/gokesari-db/cert.pem
privkey = /etc/letsencrypt/live/gokesari-db/privkey.pem
chain = /etc/letsencrypt/live/gokesari-db/chain.pem
fullchain = /etc/letsencrypt/live/gokesari-db/fullchain.pem

# Options used in the renewal process
[renewalparams]
account = 0123456789abcdef0123456789abcdef
pre_hook = ufw allow 80/tcp
post_hook = ufw delete allow 80/tcp
renew_hook = /usr/local/sbin/gk-cert-deploy
authenticator = standalone
server = https://acme-v02.api.letsencrypt.org/directory
key_type = ecdsa
EOF
run "$KIT/20-web-firewall.sh"
if [ $? -eq 0 ]; then ok "20-web-firewall.sh ran"; else bad "20-web-firewall.sh ran" "$(tail -5 "$OUT")"; fi
RC=$GK_APP_ROOT/etc/letsencrypt/renewal/gokesari-db.conf
check "renewal: webroot" has "$RC" "authenticator = webroot"
check "renewal: webroot_path" has "$RC" "webroot_path = /var/lib/gk-app/acme,"
check "renewal: map for db" has "$RC" "db.gokesari.com = /var/lib/gk-app/acme"
check "renewal: map for db-test" has "$RC" "db-test.gokesari.com = /var/lib/gk-app/acme"
check "renewal: pre/post hooks gone" bash -c '! grep -Eq "^(pre_hook|post_hook)" "$1"' _ "$RC"
check "renewal: standalone gone" hasnt "$RC" "standalone"
check "renewal: deploy hook kept" has "$RC" "renew_hook = /usr/local/sbin/gk-cert-deploy"
check "renewal: account kept" has "$RC" "account = 0123456789abcdef0123456789abcdef"
check "renewal: backup kept" bash -c 'ls "$1"/var/lib/gk-app/certbot-before/gokesari-db.conf.* >/dev/null' _ "$GK_APP_ROOT"
check "acme.caddy: http only, challenge folder" has "$E/caddy/acme.caddy" "http://db.gokesari.com, http://db-test.gokesari.com {"
check "acme.caddy: everything else 404" has "$E/caddy/acme.caddy" "respond 404"
check "ufw: 80/tcp 443/tcp 443/udp" bash -c 'grep -q "^ufw allow 80/tcp" "$1" && grep -q "^ufw allow 443/tcp" "$1" && grep -q "^ufw allow 443/udp" "$1"' _ "$GK_TEST_LOG"
check "certbot dry run called" has "$GK_TEST_LOG" "certbot renew --cert-name gokesari-db --dry-run"
check "Hostinger rules printed" has "$OUT" "Accept  UDP   443"
cp "$RC" "$T/renewal.once"
run "$KIT/20-web-firewall.sh"
check "20-web-firewall.sh re-run: same renewal file" eq "$(cksum < "$RC")" "$(cksum < "$T/renewal.once")"

echo "== 10-install.sh (packages stubbed)"
run "$KIT/10-install.sh"
if [ $? -eq 0 ]; then ok "10-install.sh ran"; else bad "10-install.sh ran" "$(tail -5 "$OUT")"; fi
CF=$E/caddy/Caddyfile
check "Caddyfile: admin on localhost" has "$CF" "admin localhost:2019"
check "Caddyfile: imports acme.caddy" has "$CF" "import /etc/caddy/acme.caddy"
check "Caddyfile: imports sites" has "$CF" "import /etc/caddy/sites/*.caddy"
check "NodeSource 24.x pinned" has "$E/apt/sources.list.d/nodesource.list" "node_24.x nodistro main"
check "Caddy repo" has "$E/apt/sources.list.d/caddy-stable.list" "dl.cloudsmith.io/public/caddy/stable"
check "commands linked in /usr/local/sbin" test -L "$GK_APP_ROOT/usr/local/sbin/gk-deploy"
check "templates installed" test -f "$U/site@.service"
check "acme.caddy kept on re-run" has "$E/caddy/acme.caddy" "respond 404"
check "timers not enabled by the install" hasnt "$GK_TEST_LOG" "enable --now gk-deploy.timer"

echo "== Nothing secret in any log or command line"
check "no secret in the calls log" no_secrets_in "$GK_TEST_LOG" "$GK_TEST_STATE/hc.log"
check "ping key: not in any site file or state" bash -c '! grep -rqF "$1" "$2/etc/sites" "$2/srv" "$2/etc/caddy" "$2/etc/systemd"' _ "$HC_KEY" "$GK_APP_ROOT"
check "ping key: hc_log passes the URL on stdin" bash -c '! grep "^curl.*--config -" "$1" | grep -qF "$2"' _ "$GK_TEST_LOG" "$HC_KEY"
check "production never deployed (its key is not in GitHub yet)" test ! -e "$GK_APP_ROOT/srv/sites/gokesari-prod/deployed.json"

echo
echo "$pass passed, $fail failed. Test folder: $T"
cp "$T/staging.env.for-postgres-test" "${GK_TEST_ENV_OUT:-/dev/null}" 2>/dev/null || true
[ "$fail" -eq 0 ]
