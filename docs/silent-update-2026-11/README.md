# Silent updates — no "new version is ready" prompt (26-Nov-2026)

Owner brief: 26-Nov-2026 09.55 IST. Remove the "A new version of GoKesari is
ready. [Reload]" bar for good; every update installs silently; every page and
sign-in shows fresh data from the server. Applies to gokesari.com,
test.gokesari.com, the installed web app and the Android / iPhone apps.

## Root cause (found 26-Nov-2026 10.05–10.16 IST)

The bar was `src/components/app-install/update-prompt.tsx` (docs/app-install-2026-10),
mounted on every page from `src/app/layout.tsx`.

| # | Possible cause from the brief | Applies? | Evidence |
|---|---|---|---|
| a | Service worker in "prompt" mode / new worker waits for a click | **Yes — the cause** | `src/app/sw.js/route.ts`: the `install` handler did nothing ("Wait for the page's Reload"), so every new worker sat in `waiting` and the page showed the bar until "Reload" sent `SKIP_WAITING`. |
| b | Version not deterministic | **Partly** | On the server the version is the commit (`gk-deploy` sets `GK_BUILD_VERSION` = first 12 characters), so a rebuild of the same commit gives the same `/sw.js`. But every merged PR is a new commit, so every deploy was a "new version" — and the fallback in `next.config.ts` (no env, no `GITHUB_SHA`) was `new Date().toISOString()`, a timestamp. |
| c | Version poll too often | No | Every 30 minutes plus when the tab comes back to view — reasonable. The bar showed often because deploys are frequent, not because of polling. |
| d | sw.js / HTML / manifest cached by hosting | No | Checked 26-Nov 10.16 IST (table below): `/sw.js` and pages are `no-store`; hashed files `immutable`. Hostinger/LiteSpeed no longer serves the sites (both on our own server, Caddy → Next.js, since 17-Nov), so there is no LiteSpeed cache or `.htaccess` to purge. |
| e | "Reload" did not activate the new worker | No | `SKIP_WAITING` handler and `clients.claim()` were present; `controllerchange` reloaded. |
| f | Worker caches API or HTML | No | It cached only `/_next/static/*` and `/pwa/*`; pages and `/api` always went to the network. |
| g | Test and prod share cache / scope | No | Different origins: service-worker scope and Cache Storage are per origin, so they can never collide. |

**Deploy frequency (first-parent commits = deploys, IST, 20–26 Nov 2026):**

| Day | test.gokesari.com (`staging`) | gokesari.com (`main`) |
|---|---|---|
| 20-Nov | 18 | 1 |
| 21-Nov | 18 | 6 |
| 22-Nov | 16 | 5 |
| 23-Nov | 15 | 5 |
| 24-Nov | 14 | 2 |
| 25-Nov | 19 | 15 |
| 26-Nov (to 10.16) | 5 | 2 |

So anyone with a tab open for an hour or two on staging, or for part of a busy
release day on production, saw the bar.

## The fix

| Part | File | What |
|---|---|---|
| Bar removed | `src/components/app-install/update-prompt.tsx` (deleted), `src/lib/board/i18n.ts` | Component and its two strings gone. |
| Silent switch | `src/components/app-install/app-auto-update.tsx` (new), `src/app/layout.tsx` | Registers the worker; checks on start, when the tab comes back (at most once a minute) and every 30 minutes. When a new version takes over, the page switches at a safe moment: the next page change, the tab being hidden, or 5 idle minutes. |
| Never mid-action | `src/lib/app-update-policy.ts` (new) | No switch on `/cart`, `/checkout`, `/orders/pay`, `/orders/payment-return`, `/wallet`, `/onboarding`, `/sell`, `/subscribe`, `/franchise`, `/shop/billing`, `/signin`, `/mobile-auth`; nor after anything was typed, picked or a file chosen on the page; nor with a Cashfree window open. Cart, wishlist, sign-in and drafts stay (cookies / server / localStorage are untouched by a reload). |
| Worker | `src/app/sw.js/route.ts` | `skipWaiting()` on install + `clients.claim()`; pages network-first with a small offline page only when there is no network; `/api` never touched; static files from any version's cache, and the previous version's cache is kept so an open tab still finds its files after a deploy. |
| Deterministic version | `next.config.ts` | Fallback is now the git commit (`git rev-parse HEAD`), then `"dev"` — never a time. |
| Stale chunks | `src/lib/app-update-policy.ts`, `src/app/error.tsx`, `app-auto-update.tsx` | `ChunkLoadError` / "Failed to fetch dynamically imported module" / "Importing a module script failed": one silent reload, guarded by `sessionStorage` (`gk_chunk_reload_at`, 5 minutes), logged with `console.warn("[gk-update] …")`; a second failure shows the normal error page — no loop. |
| Fresh data per account | `app-auto-update.tsx` | Pages and the header (cart, wallet, notifications) are rendered on the server on every request (`no-store`), and there is no client data cache (no React Query / SWR / persisted store). The only per-person browser data — recent searches (`gk_recent_searches`) and guest favourites (`gk_favourites`) — is cleared when a signed-in person signs out or another account signs in on the same device. The guest cart is kept (it moves into the account on sign-in). The shop billing (POS) offline queue is never cleared (unsynced sales). |
| Android / iPhone app 1.16.0 | `mobile/src/app-update.ts`, `mobile/app.config.ts`, `mobile/package.json`, `mobile/RELEASE_NOTES.md` | No "A new version of GoKesari is ready — Later / Update" popup. The app shows the live website (no bundled web code, no service worker), so website changes need no app update. Only a build below the owner-set minimum (`MOBILE_APP_ANDROID_MINIMUM` / `MOBILE_APP_IOS_MINIMUM`) still asks, with "Update" alone. |

### Not done, and why

- **Play In-App Updates (flexible)**: the app is not yet on the Play Store (it is
  installed from the website's APK link), and the Play Core API works only for
  Play-installed apps. Store auto-update covers it once listed.
- **Live-update of web bundles in the app**: not needed — the app has no bundled
  web code; it opens the live site, whose pages are `no-store`.
- **LiteSpeed cache purge / `.htaccess` / nginx**: the sites are served by Caddy
  → Next.js on `gk-db-1` (no LiteSpeed, no nginx). Headers are set by the app
  and were already correct.

## Response headers (curl -I)

Before (26-Nov-2026 10.16 IST) — identical on both sites:

| Path | Cache-Control |
|---|---|
| `/` (page) | `private, no-cache, no-store, max-age=0, must-revalidate` |
| `/sw.js` | `no-cache, no-store, must-revalidate` |
| `/manifest.webmanifest` | `public, max-age=0, must-revalidate` |
| `/_next/static/chunks/webpack-….js` | `public, max-age=31536000, immutable` |
| `/api/cart` (user data) | `private, no-store` |
| `/api/app/version` (public, no user data) | `public, max-age=300` |

After: see TEST_RESULTS.md in this folder.
