# Silent updates — test results (26-Nov-2026)

Change: PR #599 (`fix/silent-auto-update`), merged into `staging` 26-Nov-2026
11.46 IST (queue batch #606), `staging-verified`. All times IST.

Environments: **Test** = test.gokesari.com, **Prod** = gokesari.com.
Browser: Claude in-app browser (Chromium), desktop and 375×812 phone size.
Real Android / iPhone handsets, Safari and installed apps: see "Not run".

## Before CI / queue

| Check | Result |
|---|---|
| Unit tests `tests/unit/app-update-policy.test.ts` (sensitive pages, dirty form, payment window, chunk-error guard, account switch) | Pass (40/40) |
| Integration `tests/integration/app-install.test.ts` (`/sw.js`: skipWaiting, clients.claim, network-first pages, one `cache.put`, no `/api`, deterministic) | Pass (CI) |
| Typecheck, lint, build, mobile tsc + tests (66/66), Android APK preview + production | Pass (CI) |
| Staging queue: migration, deploy, post-deploy check, guest QA (incl. TC-APP-009 with the new `/sw.js` asserts) | Pass — `staging-verified` |

## Test (test.gokesari.com)

| # | Case | Expected | Actual | Result | Time (IST) |
|---|---|---|---|---|---|
| S-01 | Site serves the change | `/sw.js` version = `staging` head; contains `self.skipWaiting()` | version `decc9134bcaa` = `origin/staging`; skipWaiting present (install + message) | Pass | 13.23 |
| S-02 | Response headers | unchanged, correct (table below) | identical to the "before" table | Pass | 13.23 |
| S-03 | No update bar, desktop | no "new version" text, no `app-update-prompt` | none in HTML or rendered page | Pass | 13.24 |
| S-04 | No update bar, phone (375×812) | same | none; page normal | Pass | 13.25 |
| S-05 | Upgrade from the old prompt-mode worker | an open visitor on the 25-Nov worker (`1ce41f437478`, before the fix) moves to the new worker without any click | browser profile had the old worker; the new page took over and reloaded once while the tab was hidden; no bar; controller now reports `decc9134bcaa`, nothing `waiting` | Pass | 13.23 |
| S-06 | Worker state | one active worker, scope `/`, `updateViaCache: none`, no waiting/installing | as expected | Pass | 13.24 |
| S-07 | Nothing but static files cached | Cache Storage holds only `/_next/static/*` and `/pwa/*` | one cache `gk-static-…`, 15 entries, 0 pages / 0 `/api` | Pass | 13.24 |
| S-08 | ChunkLoadError → one silent reload | page reloads once; `gk_chunk_reload_at` set; `console.warn("[gk-update] …")` | reloaded; guard set; warn logged | Pass | 13.25 |
| S-09 | No reload loop | a second chunk error within 5 min does not reload | page stayed (guard held) | Pass | 13.25 |
| S-10 | Account switch clears previous person's data | `gk_recent_searches`, `gk_favourites` removed when another account was last | both removed; `gk_last_user` = current account | Pass | 13.25 |
| S-11 | Same person keeps their data | recent searches kept across pages | kept | Pass | 13.25 |
| S-12 | Live deploy picked up silently — normal page | tab open on `/` since 13.25 on `decc9134bcaa`; after the staging deploy of `5d74f3f326c3` (live 13.38) the new worker takes over with no prompt, and the page switches at the next page change | worker became `5d74f3f326c3` with nothing waiting; page stayed put while being read; clicking "All categories" loaded `/categories` fully on the new version; no bar at any point; caches = new + previous version | Pass | 13.38–13.39 |
| S-13 | Live deploy — sensitive page holds | tab open on `/cart` is controlled by the new worker but does not reload | worker `5d74f3f326c3`; page never reloaded (marker kept at 13.39); no bar | Pass | 13.39 |

Response headers on Test, 26-Nov 13.23 IST (after = before):

| Path | Cache-Control |
|---|---|
| `/` and other pages | `private, no-cache, no-store, max-age=0, must-revalidate` |
| `/sw.js` | `no-cache, no-store, must-revalidate` |
| `/manifest.webmanifest` | `public, max-age=0, must-revalidate` |
| `/_next/static/…` (hashed) | `public, max-age=31536000, immutable` |
| `/api/cart` | `private, no-store` |
| `/api/app/version` | `public, max-age=300` |

## Prod (gokesari.com)

_Release at the 23.00 IST window; results added after the post-deploy check._

## Not run (and why)

| Case | Why |
|---|---|
| Real Android phone (Chrome, installed web app) | No handset in this session; same Chromium engine covered above. |
| iPhone Safari / Add to Home Screen | No iPhone in this session; WebKit supports `skipWaiting`/`clients.claim` the same way. |
| Android app 1.16.0 on a phone (no optional popup) | APK built by CI (preview + production); installing it needs the owner's phone. |
| iPhone app | Build skipped by owner (26-Nov 10.45 IST); Apple signing key planned later. |
| Offline page | The in-app browser cannot cut its network; covered by the integration test of `/sw.js`. |
