# PROD (gokesari.com) — detailed results, 01-Nov-2026

Read-only, signed-out browsing only (no sign-in, no cart, no orders), at night (23.40 IST). Summary and fixes: [../PERFORMANCE_REPORT_2026-11-01.md](../PERFORMANCE_REPORT_2026-11-01.md).

## 1. Smoke — 1 user, 2 rounds

16 requests, 0 errors, median 0.27 s, max 0.56 s.

| Endpoint | Requests | Errors % | p50 ms | p95 ms | p99 ms | Max ms | Status codes |
|---|---:|---:|---:|---:|---:|---:|---|
| page /shops/[slug] | 2 | 0.0 | 555 | 557 | 557 | 557 | 200×2 |
| page / | 2 | 0.0 | 347 | 372 | 374 | 374 | 200×2 |
| api nearby | 2 | 0.0 | 322 | 351 | 354 | 355 | 200×2 |
| api shop products | 2 | 0.0 | 292 | 306 | 307 | 307 | 200×2 |
| page /search | 2 | 0.0 | 215 | 249 | 252 | 253 | 200×2 |
| api search suggest | 2 | 0.0 | 168 | 169 | 170 | 170 | 200×2 |
| api shops list | 2 | 0.0 | 75 | 126 | 131 | 132 | 200×2 |
| page /shops/nearby | 2 | 0.0 | 27 | 29 | 29 | 29 | 200×2 |


## 2. Baseline — 10 browsing users, 4.5 minutes

2,053 requests, 0 errors, 7.4 req/s average (~9 at peak); median 0.28 s, p95 0.62 s, max 1.2 s. Production watchdog: 18 checks, all 200, avg 0.42 s.

| Endpoint | Requests | Errors % | p50 ms | p95 ms | p99 ms | Max ms | Status codes |
|---|---:|---:|---:|---:|---:|---:|---|
| page /shops/[slug] | 247 | 0.0 | 601 | 864 | 985 | 1216 | 200×247 |
| page /products/[id] | 77 | 0.0 | 461 | 615 | 878 | 953 | 200×77 |
| page / | 247 | 0.0 | 308 | 504 | 582 | 659 | 200×247 |
| api shop products | 247 | 0.0 | 322 | 452 | 616 | 672 | 200×247 |
| api nearby | 247 | 0.0 | 293 | 383 | 568 | 643 | 200×247 |
| page /search | 247 | 0.0 | 192 | 287 | 375 | 795 | 200×247 |
| api search suggest | 247 | 0.0 | 177 | 251 | 480 | 625 | 200×247 |
| page /shops/nearby | 247 | 0.0 | 25 | 35 | 82 | 101 | 200×247 |
| api shops list | 247 | 0.0 | 19 | 30 | 151 | 171 | 200×247 |

| t (s) | VUs | req/s | p50 ms | p95 ms | Errors % |
|---:|---:|---:|---:|---:|---:|
| 0 | 1 | 0.2 | 252 | 563 | 0.0 |
| 30 | 6 | 4.0 | 280 | 646 | 0.0 |
| 60 | 10 | 7.7 | 276 | 619 | 0.0 |
| 90 | 10 | 8.7 | 272 | 614 | 0.0 |
| 120 | 10 | 9.2 | 277 | 629 | 0.0 |
| 150 | 10 | 8.8 | 272 | 644 | 0.0 |
| 180 | 10 | 9.2 | 272 | 595 | 0.0 |
| 210 | 10 | 8.8 | 276 | 622 | 0.0 |
| 240 | 10 | 8.8 | 275 | 599 | 0.0 |
| 270 | 8 | 3.1 | 276 | 623 | 0.0 |

## 3. Lighthouse

| Page | Perf | A11y | Best pr. | SEO | FCP ms | LCP ms | TBT ms | CLS | Server ms | KB |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| home-desktop | 100 | 100 | 96 | 100 | 261 | 443 | 0 | 0.000 | 373 | 296 |
| home-mobile | 98 | 100 | 96 | 100 | 934 | 2346 | 87 | 0.000 | 285 | 294 |
| nearby-desktop | 100 | 100 | 96 | 100 | 261 | 421 | 0 | 0.000 | 27 | 316 |
| nearby-mobile | 100 | 100 | 96 | 100 | 925 | 1900 | 20 | 0.000 | 29 | 281 |
| search-desktop | 100 | 100 | 96 | 66 | 266 | 499 | 0 | 0.000 | 215 | 287 |
| search-mobile | 98 | 100 | 96 | 66 | 927 | 2277 | 40 | 0.000 | 246 | 292 |
| shop-desktop | 100 | 100 | 96 | 100 | 261 | 404 | 0 | 0.000 | 548 | 317 |
| shop-mobile | 100 | 100 | 96 | 100 | 929 | 1771 | 38 | 0.000 | 867 | 280 |
| signin-desktop | 100 | 100 | 100 | 100 | 279 | 421 | 0 | 0.000 | 23 | 314 |
| signin-mobile | 100 | 100 | 100 | 100 | 926 | 1764 | 34 | 0.000 | 30 | 263 |

No product page was tested: the first shop near central Pune has no products listed. Full HTML reports: `lighthouse/*.report.html`.

## 4. Not done on production, and why

- No stress or 50-user load: the 25-Oct-2026 production incident, and TEST and PROD may share one Hostinger account.
- No signed-in flows, cart or checkout: no test accounts or test data on production.
- Production nearby search: no shop within 5 km of 18.52, 73.85; 3 within 10 km. The scripts search 10 km.
