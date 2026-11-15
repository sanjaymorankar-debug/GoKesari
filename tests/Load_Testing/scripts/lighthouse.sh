#!/usr/bin/env bash
# Lighthouse (mobile and desktop) for GoKesari's key pages.
#   scripts/lighthouse.sh test     → reports/test/lighthouse
#   scripts/lighthouse.sh prod     → reports/prod/lighthouse
# Signed-in pages (TEST only) use the saved staging session as a cookie header.
set -u
cd "$(dirname "$0")/.."
ENV=${1:-test}
if [ "$ENV" = prod ]; then BASE=https://gokesari.com; else BASE=https://test.gokesari.com; fi
OUT=reports/$ENV/lighthouse
mkdir -p "$OUT"
export npm_config_cache=$PWD/.npm-cache
export CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

# A shop and a product that exist on this site (first shop near central Pune).
read -r SLUG SHOP_ID < <(curl -s "$BASE/api/shops/nearby?lat=18.52&lng=73.85&radiusKm=10" |
  python3 -c "import json,sys;d=json.load(sys.stdin);s=d['shops'][0];print(s['slug'],s['id'])")
PRODUCT=$(curl -s "$BASE/api/shops/$SHOP_ID/products" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d[0]['productId'] if d else '')")

PAGES="home=/ nearby=/shops/nearby search=/search?q=milk shop=/shops/$SLUG signin=/signin"
[ -n "$PRODUCT" ] && PAGES="$PAGES product=/products/$PRODUCT"

token() { python3 -c "import json;print([c['value'] for c in json.load(open('../../.e2e-auth/staging-$1.json'))['cookies'] if 'session-token' in c['name']][0])"; }

run() { # name path form [cookie]
  local name=$1 path=$2 form=$3 cookie=${4:-}
  local args=(--quiet --chrome-flags="--headless=new --no-sandbox" --output=json --output=html
    --output-path="$OUT/$name-$form" --only-categories=performance,accessibility,best-practices,seo)
  [ "$form" = desktop ] && args+=(--preset=desktop)
  [ -n "$cookie" ] && args+=("--extra-headers={\"Cookie\":\"__Secure-authjs.session-token=$cookie\"}")
  echo "lighthouse $ENV $name ($form) $BASE$path"
  npx --yes lighthouse@12.8.2 "$BASE$path" "${args[@]}" || echo "  failed: $name $form"
}

for entry in $PAGES; do
  name=${entry%%=*}; path=${entry#*=}
  run "$name" "$path" mobile
  run "$name" "$path" desktop
done
if [ "$ENV" = test ]; then
  run shop-dashboard /shop desktop "$(token shop)"
  run admin-dashboard /admin/dashboard desktop "$(token admin)"
  run cart /cart mobile "$(token customer)"
fi

# One summary line per report.
python3 - "$OUT" <<'PY'
import glob, json, os, sys
rows = []
for f in sorted(glob.glob(os.path.join(sys.argv[1], "*.report.json"))):
    r = json.load(open(f)); a = r["audits"]; c = r["categories"]
    num = lambda k: a.get(k, {}).get("numericValue")
    rows.append({
        "page": os.path.basename(f).replace(".report.json", ""),
        "url": r["finalDisplayedUrl"],
        **{k: round((c[k]["score"] or 0) * 100) for k in ("performance", "accessibility", "best-practices", "seo") if k in c},
        "fcp_ms": num("first-contentful-paint"), "lcp_ms": num("largest-contentful-paint"),
        "tbt_ms": num("total-blocking-time"), "cls": num("cumulative-layout-shift"),
        "si_ms": num("speed-index"), "ttfb_ms": num("server-response-time"),
        "bytes": num("total-byte-weight"), "js_unused_bytes": a.get("unused-javascript", {}).get("details", {}).get("overallSavingsBytes"),
    })
json.dump(rows, open(os.path.join(sys.argv[1], "summary.json"), "w"), indent=1)
for x in rows:
    print(f"{x['page']:<26} perf {x.get('performance')!s:>3}  LCP {x['lcp_ms'] or 0:>7.0f} ms  TBT {x['tbt_ms'] or 0:>6.0f} ms  CLS {x['cls'] or 0:.3f}  TTFB {x['ttfb_ms'] or 0:>5.0f} ms  {int((x['bytes'] or 0)/1024)} KB")
PY
