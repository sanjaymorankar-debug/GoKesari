# GoKesari performance, load and stress test — 01-Nov-2026

Run 01-Nov-2026, 23.00–23.50 IST, from the owner's Mac (Pune, one IP address).
TEST = https://test.gokesari.com · PROD = https://gokesari.com.
Tools: k6 v2.3.0, Lighthouse 12.8.2 with Chrome 156.
Details: [test/REPORT.md](test/REPORT.md), [prod/REPORT.md](prod/REPORT.md).
Endpoint inventory: [../ENDPOINTS.md](../ENDPOINTS.md).

## Verdict

| | TEST | PROD |
|---|---|---|
| **Correctness under load** | 0 errors up to 50 concurrent users | 0 errors (10 browsing users, read-only) |
| **Throughput ceiling** | **~10 requests/s**. It stops rising at ~24 users, whatever the load. | Not stress-tested (see note). Handled 9 req/s with p95 0.62 s. |
| **Response time at 50 users** | median 3.0 s, **p95 10.0 s**, max 20.7 s | — |
| **Breaking point** | ~100 users: Hostinger's CDN returned **403** to everything for ~6 minutes | — |
| **Front-end (Lighthouse)** | 92–100 performance; ~300 KB a page | 98–100 performance; ~300 KB a page |
| **Slowest single-user actions** | checkout **8.6 s**, cancel **5.2 s**, admin dashboard **5.5 s** | not measured (signed-in flows are TEST only) |

**In one line:** the pages in the browser are fast. The time is spent on the
server, which runs a long chain of database calls one after another, each
from Mumbai (Hostinger) to Singapore (Neon) and back. That limits the site to
about 10 requests a second. One person checking out waits 8.6 s. At 50
people, ordinary pages take up to 10 s.

For scale: 10 req/s is roughly 1–2 orders a minute plus normal browsing. That
is enough for the Pune pilot, but not for city-wide or all-India traffic,
festival peaks, or a marketing push.

## 1000-user stress test on TEST — 06-Nov-2026, 12.47–13.03 IST

The owner asked for 1000 concurrent users and chose to run it straight away,
during business hours. It ran on test.gokesari.com only, with the production
watch on (gokesari.com probed every 15 s; three slow or failed probes in a row
stop the test). The code on TEST includes PR 329 and [PR 339](https://github.com/sanjaymorankar-debug/GoKesari/pull/339)
(the checkout speed-up). Mix of users: 60% guests, 25% buyers, 10% shop owners, 5% staff.
Ramp: 170 → 330 → 670 → 1000 users, 3 minutes per step (`-e PROFILE=stress
-e PEAK=1000 -e ABORT=0`, so k6 kept going past its error limits). Raw files:
`reports/raw/test-stress-1000*`, `test-smoke-1000run*`, `test-checkout-fix5*`.

### Result in one line

**The site held up to about 150 users with 0 errors. It did not reach 1000.**
At about 170 users, Hostinger's edge protection started blocking the test,
first with 403 and then by refusing the connection itself (TLS "internal
error"). From then until the end, more than 99% of requests were turned away
before they reached the app, so the 330, 670 and 1000-user steps measure
Hostinger's protection, not GoKesari.

### Step by step (10-second windows)

| Time | Users | Requests/s | Median | p95 | Errors |
|---:|---:|---:|---:|---:|---:|
| 0:10 | 34 | 13.8 | 0.44 s | 1.8 s | 0% |
| 0:20 | 63 | 22.6 | 1.2 s | 2.7 s | 0% |
| 0:30 | 91 | 27.2 | 1.9 s | 3.4 s | 0% |
| 0:40 | 120 | 27.5 | 2.8 s | 4.2 s | 0.7% |
| 0:50 | 147 | 28.9 | 3.3 s | 4.6 s | 0% |
| 1:00 | 171 | 77 | — | 5.3 s | **64%** (blocked) |
| 1:10 → end | 171 → 1000 | 150–500 | — | — | **~100%** (blocked) |

Whole run: 208,395 requests, 1,483 answered by the app (0.7%). The rest got
403 or a refused connection. 0 checkouts or orders were placed by this test.

### What it shows
- **Throughput ceiling is now ~28 requests/s.** It was ~10 on 01-Nov and
  23 on 03-Nov. It is reached at about 90 users. After that, more users only
  make every page slower: the median grows by about 0.6 s for every 30 users.
- **No app errors before the block.** Up to 150 users there were no 500s, no
  timeouts and no failed checks. The app slows down; it does not break.
- **Breaking point: Hostinger, not the app.** At ~170 users from one IP
  address (about 170 requests/s once responses sped up), Hostinger blocked
  the traffic for test.gokesari.com. The site answered normally again as soon
  as the test stopped (13.03 IST: 200 in 5.3 s, then 1.6 s).
- **Production was affected.** gokesari.com answered every probe until 12.53,
  then slowed to 3–5 s at times. Two probes failed (12.58.08 timed out after
  15 s; 12.58.57 failed). It was back to 0.4–0.5 s from 13.01. The guard did
  not stop the test because the failures were never three in a row. Both
  sites share one Hostinger plan, and blocked traffic still uses its
  resources.

### Checkout and cancel (one user, 8 orders, 12.47 IST, before the stress run)

| Action | 03-Nov median (07.04 IST) | 06-Nov median (12.47 IST) | 06-Nov p95 |
|---|---:|---:|---:|
| Checkout | 5.4 s | 6.6 s | 7.5 s |
| Cancel | 4.0 s | 4.2 s | 5.3 s |

All 8 orders were placed and cancelled, with 0 errors. In a local trace, PR 339
cut checkout's database round trips from 28 to 13 and cancel's from ~35 to ~20.
That gain does not show on TEST: this run was at midday, when production
traffic shares the same server. The 03-Nov run was at 07.00. The checkout
code has not changed since PR 339. To compare like with like, repeat the run
at the same early hour.

### What 1000 concurrent users would need
1. **Distributed load test.** Use many source IPs (k6 Cloud or several
   machines), and tell Hostinger beforehand so its protection doesn't block
   the test. One Mac on one IP cannot go past ~170 users.
2. **More server capacity than Hostinger Business shared.** At ~28 req/s the
   app is limited by its database round trips (Mumbai → Singapore, ~140 ms
   each) and by the shared CPU. Options, in order of impact:
   - move Neon to aws-ap-south-1 (Mumbai), close to the app;
   - move to a VPS or cloud plan with dedicated CPU, and put test.gokesari.com
     on separate hosting so tests never touch production;
   - cache guest pages (home, shop lists, search) at the CDN.
3. **Run heavy tests outside business hours.** This run slowed real
   gokesari.com shoppers for a few minutes.

## Re-test after fixes 3 and 4 on TEST — 03-Nov-2026, 07.04–07.16 IST

[PR 329](https://github.com/sanjaymorankar-debug/GoKesari/pull/329), merged into `staging` at 06.58 IST and live on test.gokesari.com from 07.04 IST, changes four things:
- prepared statements now also apply inside database transactions;
- the admin dashboard works out its figures once instead of twice;
- the dashboards run their database queries in parallel;
- each stock update takes one database step instead of two.

Same scripts and settings as the 02-Nov re-test. Raw files: `reports/raw/test-*-fix34*`.

### 50-user load test

| | 01-Nov (no fixes) | 02-Nov (fixes 1, 2) | 03-Nov (fixes 1–4) |
|---|---:|---:|---:|
| Requests in 8 min | 4,177 | 9,706 | 11,162 |
| Throughput | 8.6 req/s | 19.8 req/s | 23.0 req/s |
| Median | 3.0 s | 1.08 s | 0.73 s |
| p95 | 10.0 s | 2.8 s | 2.3 s |
| Max | 20.7 s | 7.0 s | 9.4 s |
| Errors | 0% | 0% | 0% |

Endpoints this change was aimed at, at 50 users (ms):

| Endpoint | p50 02-Nov | p50 03-Nov | p95 02-Nov | p95 03-Nov |
|---|---:|---:|---:|---:|
| page /admin/dashboard | 4,707 | **681** | 6,084 | **2,389** |
| page /shop (dashboard) | 2,219 | 1,530 | 3,126 | 4,425 |
| api cart add | 2,050 | 1,331 | 3,477 | 2,666 |
| page /cart | 2,474 | 2,083 | 3,950 | 3,226 |

The full endpoint table is in `reports/raw/test-load-fix34-analysis.md`.

### One user, 8 orders: checkout and cancel

| Action | 02-Nov median | 03-Nov median | 02-Nov p95 | 03-Nov p95 |
|---|---:|---:|---:|---:|
| Checkout | 7.5 s | **5.4 s** (−28%) | 8.8 s | 7.1 s |
| Cancel | 6.0 s | **4.0 s** (−33%) | 6.6 s | 4.9 s |

All 8 orders were placed and cancelled, with 0 errors. The quick check also had 0 errors (52 requests).

### Findings
- **Admin dashboard fixed.** At 50 users its median went from 4.7 s to 0.7 s (−86%).
- **Checkout and cancel are a quarter to a third faster, but still above the 3 s target.** They are now the slowest actions on the site. The next step is to move notifications and other work that can wait out of the checkout transaction. Each seller-database table it touches also adds about 7 ms of postgres_fdw overhead.
- **Shop dashboard p95 rose from 3.1 s to 4.4 s**, though its median fell. Its 12 queries now run at the same time, so under load one page can hold several database connections at once (`DATABASE_POOL_MAX`). Worth watching. If it persists, cap that page at 3–4 queries in flight at a time.
- **Production slowed while TEST was at peak load.** Between 07.11 and 07.13 IST the 15-second production probe recorded 4.5 s, 10.4 s and 7.7 s. Its average is otherwise 0.5 s, and every answer was 200. No production deploy or CI run was in progress, and gokesari.com was back to 0.46 s right after. Both sites appear to share the Hostinger Business plan's CPU and memory. A load test on TEST can therefore slow production, so either run heavy tests outside business hours or move TEST onto separate hosting.

## Re-test after fixes 1 and 2 on TEST — 02-Nov-2026, 08.50–09.05 IST

On 02-Nov-2026 the owner set `DATABASE_PREPARED_STATEMENTS=on` and
`DATABASE_IDLE_TIMEOUT_SECONDS=300` on test.gokesari.com in hPanel and
restarted the app. Production is unchanged. The same scripts, accounts and
profiles were then re-run. Raw data is in `reports/raw/*-after*`.

**50-user load test:**

| | 01-Nov (before) | 02-Nov (after) | Change |
|---|---:|---:|---|
| Requests in 8 min | 4,177 | 9,706 | 2.3× |
| Throughput (whole run) | 8.6 req/s | 19.8 req/s | 2.3× |
| Throughput at 51 users | 8.1–10.3 req/s | 21.7–23.2 req/s | ceiling at least doubled |
| Median | 3.0 s | 1.08 s | −64% |
| p95 | 10.0 s | 2.8 s | −72% |
| Max | 20.7 s | 7.0 s | −66% |
| Errors | 0% | 0% | — |

At 51 users the after-run held about 22 req/s with p95 2.5–3.0 s. The
before-run had already stopped rising at about 10 req/s from 24 users.

**Per endpoint at 50 users (ms):**

| Endpoint | p50 before | p50 after | p95 before | p95 after |
|---|---:|---:|---:|---:|
| page /admin/dashboard | 14,040 | 4,707 | 19,324 | 6,084 |
| page /cart | 7,676 | 2,474 | 13,141 | 3,950 |
| page / (signed in) | 6,791 | 2,462 | 13,441 | 3,896 |
| page /shop (dashboard) | 7,564 | 2,219 | 13,706 | 3,126 |
| api cart add | 4,125 | 2,050 | 10,983 | 3,477 |
| api nearby | 3,036 | 1,413 | 9,182 | 2,667 |
| page / (guest) | 2,310 | 949 | 9,212 | 2,179 |
| api search suggest | 2,104 | 793 | 8,225 | 2,060 |

**One user at a time** improved much less: about 10–25% on most pages.

| Action | Before | After |
|---|---:|---:|
| Admin dashboard | 5.5 s | 5.4 s |
| Cart page | 2.5 s | 2.1 s |
| Add to cart | 1.5 s | 1.3 s |
| Checkout, median of 8 | 8.5 s | 7.5 s |
| Cancel, median of 8 | 5.2 s | 6.0 s |

Nearby got slower (1.1 s → 1.9 s), but it waits on OpenStreetMap, which is
outside our control.

All 8 new test orders ended REFUNDED, the wallet is back to ₹350, and the cart
is empty. The production watchdog's checks averaged 0.46 s (33 checks) and it
never fired.

**What this means:**
- The two settings removed most of the *queueing*. Connections are reused and
  each statement holds a connection for less time, so the site now serves
  about twice as many people before it slows down.
- They did not shorten the long chains of queries inside a single request.
  Checkout, cancel and the dashboards are still slow even with one user.
- The expected "halves every number" for a single user (fix 1) did not
  happen. The remaining time is the number of sequential steps, not the cost
  of each one.
- Fixes 3 (dashboards) and 4 (checkout and cancel) are now the main lever.
- Fix 1 and the idle-timeout part of fix 2 are proven on TEST and can go to
  production through the normal hPanel change, in a quiet window. Then run
  `scripts/release/post-deploy-check.sh https://gokesari.com`.

## Results (01-Nov-2026, before the fixes)

### TEST — 50-user load (2 min ramp, 5 min hold, 1 min down)
Mix: 60% guests, 25% signed-in buyers (cart), 10% shop owners, 5% admin/operator.

| Concurrent users | req/s | median | p95 | errors |
|---:|---:|---:|---:|---:|
| 12 | 4.8 | 0.39 s | 1.8 s | 0% |
| 24 | 9.8 | 0.68 s | 3.0 s | 0% |
| 38 | 9.9 | 1.9 s | 5.8 s | 0% |
| 51 (held 5 min) | 8.1–10.3 | 2.6–6.1 s | 7.9–13.2 s | 0% |

Between 24 and 51 users, throughput stays flat while response time grows in
step with the number of users. That is a queue: the server works at its
maximum rate and every extra user waits longer.

### TEST — stress (steps of 25 → 50 → 100 → 150 users)

| Step | req/s | median | p95 | errors |
|---:|---:|---:|---:|---:|
| 25 users | 9.3–10.6 | 1.3 s | 4.7 s | 0% |
| 49 users | 9.0–9.3 | 4.2–5.1 s | 7.5–8.5 s | 0% |
| 100 users | 7.3–8.8 | **10.0 s** | **14.7 s** | 0%, then 71–99% |

At 100 users, Hostinger's CDN (`server: hcdn`) blocked this Mac with
`403 Forbidden` pages. They came back in ~15 ms, so the app never saw those
requests. All 929 failures fell in 14 seconds, and the run aborted itself as
designed. The block lasted ~6 minutes and applied to both domains for the k6
client, while curl and Chrome still got through. The 150-user step was not
reached.

### Order placement (TEST, one buyer, 8 orders, each cancelled straight after)

| Step | median | p95 |
|---|---:|---:|
| `POST /api/checkout` (wallet) | 8.5 s | 9.0 s |
| `POST /api/orders/[id]/cancel` | 5.2 s | 5.5 s |
| checkout refused (COD limit reached, 409) | 2.4 s | — |

All 8 orders were refunded. The wallet went back to ₹350 and the cart was cleared.

### Single user (TEST, no other load): slowest pages and APIs

| Endpoint | time |
|---|---:|
| page `/admin/dashboard` | 5.5 s |
| page `/` signed in | 2.7 s |
| page `/shop` (shop-owner dashboard) | 2.3 s |
| page `/cart` | 2.5 s |
| page `/shop/catalogue` | 1.5 s |
| `POST /api/cart` (add to cart) | 1.5 s |
| `GET /api/shops/nearby` | 1.1 s |
| page `/` signed out | 0.5 s |
| `GET /api/search/suggest` | 0.17 s |

### PROD (read-only, guests only, 10 users for 3 minutes)
2,053 requests, 0 errors, 7.4 req/s average (~9 at the peak). Median 0.28 s,
p95 0.62 s, max 1.2 s. The slowest page was the shop page (p95 0.86 s). The
production watchdog's own checks of the home page averaged 0.42 s.

### Lighthouse
Scores were the same on both sites: performance 92–100, accessibility 96–100,
best practices 96. LCP was ~0.4–0.8 s on desktop and 1.8–2.3 s on emulated
mobile, with TBT under 90 ms and CLS 0–0.05. Each page is ~260–350 KB, of
which ~48 KB is unused JavaScript. The only weak numbers are server times:
admin dashboard 4.9 s, cart 2.2 s and shop-owner dashboard 1.5 s.

TEST scores 66 for SEO because staging is marked `noindex`. That is expected.

## Bottlenecks, most important first

1. **Two round trips for every query.** `DATABASE_PREPARED_STATEMENTS` defaults to
   `off` (`src/lib/env.ts:43`), so postgres-js sends each query as describe +
   execute. Each trip from Mumbai to Neon in Singapore takes ~55–65 ms
   (`docs/db-region-move-2026-10/PLAN.md`), so one statement costs ~130 ms.
   This doubles every number above.
2. **Long sequential chains of queries.**
   - **Checkout** runs ~15–20 statements before its transaction and ~25–35
     inside it (`src/server/services/orders.ts:248-867`). Lines and stock
     updates go one at a time (`catalogue.ts:1465-1490`).
   - **Inside the transaction**, `recordAudit`, `emitEvent` and `notify` add 3–4
     statements per recipient.
   - **After commit**, `notifyOpenStockAlerts` and `checkRiskForUser` are still
     awaited.
   - **Cancel** repeats the pattern: a 9-read quote before it locks the order,
     then a restock per line (`orders.ts:1234-1530`).
3. **The admin dashboard computes its KPIs twice, one after the other.**
   `page.tsx` awaits `getMarketplaceKpis` + `getLiveOperations`, then calls
   `getAdminDashboard()`, which runs both again (`dashboards.ts:212-213`).
   `getMarketplaceKpis` is ~16 sequential queries (`analytics.ts:121-362`).
   The shop-owner dashboard `/shop` runs the same KPI function.
4. **Small pool and short idle time.** The pool holds 10 connections
   (`DATABASE_POOL_MAX`) and drops them after 20 s idle
   (`DATABASE_IDLE_TIMEOUT_SECONDS`). Pages that run 10+ queries in parallel
   wait for each other, and a quiet site pays a fresh TCP + TLS handshake to
   Singapore. On top of that, the Neon free plan scales to zero (2–3 s cold
   start), and the split layout has two computes (core and seller) to wake.
5. **No caching of shared reads.** There is no `unstable_cache` anywhere, the
   home page is `force-dynamic`, and the dashboards, shop lists and KPIs are
   rebuilt for every request.
6. **Nearby shops waits on OpenStreetMap first.** The public Nominatim lookup
   is awaited before the shop query runs (`api/shops/nearby/route.ts:44-50`),
   and Nominatim allows one request per second.
7. **Hostinger CDN bot protection.** About 100 busy users from one IP get a
   ~6-minute 403 block. Real shoppers come from many IPs, but people behind
   one NAT (an office, a society Wi-Fi, a mobile carrier's CGNAT) or a partner
   integration could trip it.
8. **The rate limits can be bypassed, and they reset on restart.**
   - `clientKey()` trusts the first `X-Forwarded-For` value the client sends
     (`src/server/api/rate-limit.ts:110-114`). Anyone can rotate that header
     to get around the per-IP limits on nearby, search and sign-in codes.
     These tests did exactly that to act as many visitors.
   - The limits live in memory, so a restart or a second process resets them.

## Recommended fixes

| # | Fix | Effort | Expected effect |
|---|---|---|---|
| 1 | Set `DATABASE_PREPARED_STATEMENTS=on` on both sites (hPanel → Node.js → environment). This is safe because the app connects directly, not through Neon's pooler. Redeploy and re-run `scripts/load.js`. | Minutes | Roughly halves the database wait on every endpoint. Expect checkout ~4–5 s and admin dashboard ~2.5 s. |
| 2 | Set `DATABASE_IDLE_TIMEOUT_SECONDS=300`. Move Neon to a paid plan with scale-to-zero off (min 0.25–0.5 CU) for core and seller on production. | Minutes + cost | Removes 2–5 s cold starts on a quiet site |
| 3 | Admin dashboard: pass the already-loaded `kpis` and `live` into `getAdminDashboard`. `Promise.all` its 7 counts. Run the KPI subqueries in parallel or as one CTE. Cache them for 30–60 s. Use the same cache for `/shop`. | ½ day | 5.5 s → under 1 s |
| 4 | Checkout and cancel: batch the per-line reads and stock moves into one statement each. Write audit, events and notifications as one outbox insert and send them after commit. Stop awaiting `notifyOpenStockAlerts` and `checkRiskForUser`; run them in the background or by cron. Compute the cancel quote from the locked row inside the transaction. | 2–3 days | Checkout 8.6 s → ~1.5–2 s; cancel 5.2 s → ~1 s. Shorter transactions also mean fewer 40001 retries under load. |
| 5 | Nearby: run the OSM lookup and `findNearbyShops` in parallel, or return shops first and fetch the street address on the client. Round the cache key to 3 decimals. | 2 h | 1.1 s → ~0.3 s; less Nominatim traffic |
| 6 | Cache shared public reads with `unstable_cache`/`revalidate` (30–120 s): home sections, shop lists, shop catalogues and category pages. | 1–2 days | Most guest traffic stops touching the database |
| 7 | Raise `DATABASE_POOL_MAX` to 20 once fix 1 is in, after checking Neon's connection limit for the plan. | Minutes | Less queueing on fan-out pages |
| 8 | Rate limits: take the client IP from the header Hostinger's CDN sets (the last trusted hop), not the first `X-Forwarded-For` value. Move the counters to the database or Redis so they survive restarts. | ½ day | Closes a bypass of the sign-in-code and search limits |
| 9 | Ask Hostinger support to allow-list the load-test machine's IP on the CDN for planned test windows, and to confirm the CDN's per-IP thresholds. | Ticket | Load tests can go past ~100 users |
| 10 | Capacity: the Business shared plan gives limited CPU and Node processes. After fixes 1–6, re-test. If one process still tops out under ~30 req/s, plan a move to Hostinger Cloud or a VPS before the all-India roll-out, and add uptime and APM monitoring. | Plan | Headroom for growth |

**Order of work:** 1 and 2 first (configuration only), then re-run the load
test to measure the gain. Then 3 and 5 (small code changes), then 4 and 6.

## How the test was run, and its limits

- Everything ran from one Mac on one IP. Each k6 user sent its own
  `X-Forwarded-For`, so the app's per-IP limits treated it as a separate
  visitor; the Hostinger CDN still saw one IP.
- **Signed-in flows** (TEST only) used the saved staging sessions in
  `.e2e-auth`; no accounts were created. Every buyer user shared one account,
  `+gk-lc14`, which is now a shop owner (shop owners may place personal
  orders). The cart load therefore lands on one cart row.
- **Production:** guests only, read-only, 10 users at night. No stress test,
  because of the 25-Oct production incident and because TEST and PROD may
  share one Hostinger account.
- **A watchdog** checked gokesari.com every 15 s during every TEST run, ready to
  stop k6 after three slow or failed checks. It never fired. Production stayed
  at 0.42–0.47 s on average.
- **Data size:** TEST holds only a few dozen shops and products. Queries that
  scan orders or products will get slower as data grows, and these numbers do
  not show that.
- **Proxy:** k6 ran outside this Mac's sandbox network proxy. The proxy broke
  k6's TLS check and would have distorted the timings.
