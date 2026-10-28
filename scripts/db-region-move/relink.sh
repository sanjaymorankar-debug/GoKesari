#!/usr/bin/env bash
# Database region move (docs/db-region-move-2026-10/PLAN.md): after copy.sh,
# points the core database's seller link (foreign server gk_seller and its
# user mapping) at the NEW seller database. The dump carries the old host and
# the old password; without this the new core would still read the old seller.
#
#   CORE_URL=<new core database> SELLER_URL=<new seller database> scripts/db-region-move/relink.sh
#
# Checks afterwards that a seller table reads through the link, and that the
# link answers from the new seller database (not the old one).
set -euo pipefail

fail() { echo "ERROR: $1" >&2; exit 1; }

[ -n "${CORE_URL:-}" ] || fail "CORE_URL is not set."
[ -n "${SELLER_URL:-}" ] || fail "SELLER_URL is not set."
CORE_URL=$(printf '%s' "$CORE_URL" | tr -d '\r\n')
SELLER_URL=$(printf '%s' "$SELLER_URL" | tr -d '\r\n')

# Split the seller URL into the server's and the mapping's options; handed to psql through the environment.
eval "$(node -e '
  const u = new URL(process.argv[1]);
  const q = (s) => "\x27" + s.replace(/\x27/g, "\x27\\\x27\x27") + "\x27";
  const out = {
    LINK_HOST: u.hostname,
    LINK_PORT: u.port || "5432",
    LINK_DB: decodeURIComponent(u.pathname.replace(/^\//, "")),
    LINK_USER: decodeURIComponent(u.username || "postgres"),
    LINK_PASSWORD: decodeURIComponent(u.password),
  };
  for (const [k, v] of Object.entries(out)) console.log(`export ${k}=${q(v)}`);
' "$SELLER_URL")"
[ -n "$LINK_PASSWORD" ] || fail "SELLER_URL has no password."

direct=$(psql "$SELLER_URL" -X -v ON_ERROR_STOP=1 -tAc "select count(*) from public.shops") \
  || fail "Cannot read public.shops in the seller database ($LINK_DB on $LINK_HOST)."

echo "Core:   $(node -e 'const u = new URL(process.argv[1]); console.log(`${decodeURIComponent(u.pathname.slice(1))} on ${u.hostname}`)' "$CORE_URL")"
echo "Seller: $LINK_DB on $LINK_HOST"

has_server=$(psql "$CORE_URL" -X -v ON_ERROR_STOP=1 -tAc "select count(*) from pg_foreign_server where srvname = 'gk_seller'") \
  || fail "Cannot connect to the core database."
[ "$has_server" = "1" ] || fail "This database has no foreign server gk_seller. Is it the core database, copied with copy.sh?"

psql "$CORE_URL" -X -v ON_ERROR_STOP=1 -q <<'SQL'
\getenv host LINK_HOST
\getenv port LINK_PORT
\getenv dbname LINK_DB
\getenv user LINK_USER
\getenv password LINK_PASSWORD
begin;
alter server gk_seller options (set host :'host', set port :'port', set dbname :'dbname');
select count(*) = 1 as has_mapping from pg_user_mappings where srvname = 'gk_seller' and usename = current_user \gset
\if :has_mapping
  alter user mapping for current_user server gk_seller options (set user :'user', set password :'password');
\else
  create user mapping for current_user server gk_seller options (user :'user', password :'password');
\endif
commit;
SQL

# The link must now carry exactly the new seller database's address and login, and a seller table must answer.
# (Row counts alone cannot tell the old seller from its copy.)
want="$LINK_HOST|$LINK_PORT|$LINK_DB|$LINK_USER"
linked=$(psql "$CORE_URL" -X -v ON_ERROR_STOP=1 -tAc "
  select concat_ws('|', o.host, o.port, o.dbname, (select option_value from pg_options_to_table(m.umoptions) where option_name = 'user'))
    from pg_foreign_server s
    join pg_user_mappings m on m.srvid = s.oid and m.usename = current_user,
    lateral (select max(option_value) filter (where option_name = 'host') as host,
                    max(option_value) filter (where option_name = 'port') as port,
                    max(option_value) filter (where option_name = 'dbname') as dbname
               from pg_options_to_table(s.srvoptions)) o
   where s.srvname = 'gk_seller'")
[ "$linked" = "$want" ] || fail "gk_seller is $linked, expected $want."
shops=$(psql "$CORE_URL" -X -v ON_ERROR_STOP=1 -tAc "select count(*) from public.shops") \
  || fail "Reading public.shops through the link failed (wrong password?)."
[ "$shops" = "$direct" ] || fail "Through the link: $shops shops; in the seller database: $direct."
echo "Linked: gk_seller → $LINK_DB on $LINK_HOST:$LINK_PORT as $LINK_USER ($shops shops read through the link)."
