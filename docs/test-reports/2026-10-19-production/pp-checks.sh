#!/bin/bash
# Signed-out bulk-upload checks (test report §2.8, PP-01..PP-12). GET/POST without a session; nothing is written.
B=${1:-https://gokesari.com}; J=00000000-0000-4000-8000-000000000000
row(){ echo "{\"id\":\"$1\",\"check\":\"$2\",\"got\":\"$3\",\"result\":\"$4\"}"; }
redir(){ curl -s -o /dev/null -w "%{http_code} %{redirect_url}" "$B$1"; }
code(){ curl -s -o /dev/null -w "%{http_code}" -X "$1" "$B$2"; }
r=$(redir /shop/product-import); [[ $r =~ ^30[1-8].*signin ]] && row PP-01 "/shop/product-import" "$r" PASS || row PP-01 "/shop/product-import" "$r" FAIL
r=$(redir /admin/product-import); [[ $r =~ ^30[1-8].*signin ]] && row PP-02 "/admin/product-import" "$r" PASS || row PP-02 "/admin/product-import" "$r" FAIL
i=3; for spec in "GET /api/v1/product-imports/template" "GET /api/v1/product-imports/shops" "GET /api/v1/shops/$J/product-imports" "GET /api/v1/product-imports/$J" "GET /api/v1/product-imports/$J/rows" "GET /api/v1/product-imports/$J/report" "POST /api/v1/shops/$J/product-imports" "POST /api/v1/product-imports/$J/commit" "POST /api/v1/product-imports/$J/cancel"; do
  set -- $spec; c=$(code $1 $2); id=$(printf "PP-%02d" $i); [ "$c" = 401 ] && row $id "$1 $2" $c PASS || row $id "$1 $2" $c FAIL; i=$((i+1)); done
ok=PASS; got=""; for p in / /shops /signin; do c=$(code GET $p); got="$got $p=$c"; [ "$c" = 200 ] || ok=FAIL; done
r=$(redir /shop); got="$got /shop=$r"; [[ $r =~ ^30[1-8].*signin ]] || ok=FAIL; row PP-12 "existing pages" "${got# }" $ok
