# GoKesari load testing

k6 and Lighthouse scripts for test.gokesari.com and gokesari.com.
Latest results: [reports/PERFORMANCE_REPORT_2026-11-01.md](reports/PERFORMANCE_REPORT_2026-11-01.md).

```
bin/k6                 k6 v2.3.0 (macOS arm64; Homebrew's folder is not writable here)
scripts/lib.js         base URL, sessions, Pune points, helpers
scripts/flows.js       journeys: guest, buyer, shop owner, admin/operator
scripts/load.js        PROFILE=smoke | load | stress | baseline
scripts/checkout.js    order placement on TEST (orders are cancelled at once)
scripts/run-guarded.sh runs k6 and stops it if gokesari.com slows down
scripts/lighthouse.sh  Lighthouse, mobile and desktop
scripts/analyze.py     per-endpoint and per-30 s tables from k6's CSV
reports/test, reports/prod, reports/raw
```

All commands run from this folder. If the shell has a proxy set
(`HTTPS_PROXY`), unset it first: k6's TLS check fails through it, and it skews
the timings.

```bash
./bin/k6 run -e PROFILE=smoke scripts/load.js
```

```bash
scripts/run-guarded.sh test-load -e PROFILE=load -e PEAK=50 scripts/load.js
```

```bash
scripts/run-guarded.sh test-stress -e PROFILE=stress -e PEAK=150 scripts/load.js
```

```bash
./bin/k6 run -e ORDERS=8 scripts/checkout.js
```

```bash
scripts/run-guarded.sh prod-baseline -e BASE=https://gokesari.com -e PROFILE=baseline -e PEAK=10 scripts/load.js
```

```bash
python3 -I scripts/analyze.py reports/raw/test-load-metrics.csv.gz
```

```bash
scripts/lighthouse.sh test
```

Rules:
- **Production** gets `smoke` and `baseline` only (`load.js` refuses anything
  else there), and is guest-only and read-only.
- **Stress** goes to TEST, through `run-guarded.sh`.
- **The Hostinger CDN** blocks this machine for ~6 minutes when ~100 users hit
  from one IP; wait for it to clear before the next run.
- **Signed-in sessions** expire. Refresh them with `scripts/qa/signin-staging.ts`
  (skill `gokesari-qa-signin`).
