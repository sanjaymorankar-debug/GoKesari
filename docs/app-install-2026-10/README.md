# App install prompt and automatic app updates (31 Oct 2026)

Owner brief, 31 Oct 2026: the site asked once to install the app, and after a
"No" never asked again. It must ask on every visit until the app is
installed, never block the page, stop for good once the app is installed, and
the installed app must pick up new versions by itself.

**Why it stopped before.** The site had no install prompt of its own. What
people saw was Chrome's built-in "Add GoKesari to Home screen" bar, which
Chrome decides on: after a dismissal Chrome hides it for months. The site now
holds Chrome's install event (so Chrome's own bar no longer shows) and offers
the install in its own sheet, on its own rules.

## Behaviour

| Situation | What the visitor sees |
|---|---|
| First visit, app not installed | Bottom sheet "Get the GoKesari app" with **Install** and **Not now** (and a close ✕). No backdrop: the page stays usable. |
| **Not now** / ✕ | The sheet closes for this page view. The decline is counted (localStorage `gk_app_install_declines`; for a signed-in person also on the account) and **never** stops the prompt. |
| Next page load, next visit, visit 3 … | The sheet shows again, until the app is installed. (Moving between pages inside the site without a full load keeps it closed.) |
| Android Chrome / Edge / Samsung Internet | **Install** opens the browser's own install dialog (`beforeinstallprompt`). |
| Android browser that has not offered the install (yet) | **Install** shows a three-step guide: ⋮ menu → Install app → Install. |
| iPhone / iPad | **Install** shows the picture guide: Share → Add to Home Screen → Add. |
| A store listing is configured (`MOBILE_APP_ANDROID_URL` = a Play link, `MOBILE_APP_IOS_URL` = an App Store link) | The button is **Get it** and opens the listing. |
| Computers | Only where the browser itself can install (Chrome, Edge); no instructions otherwise. |
| App installed | No prompt: inside the native app (user agent `GoKesariApp/…`), in the installed web app (display mode standalone / iOS `navigator.standalone`), when Chrome reports the installed web app (`getInstalledRelatedApps`, manifest `related_applications`), when this device recorded an install (`gk_app_installed`, set on `appinstalled`, on an accepted dialog and on any launch of the installed app), or when the signed-in account has an install on the same platform. |
| Installed, then removed (Android) | Chrome offers the install again; the site sees that, clears its "installed" record and starts prompting again. |

**Signed-in record** (`app_install_states`, core / platform table, migration
0121): decline count, last decline, platforms installed on. `GET` / `POST
/api/app-install`. On iPhone the home-screen app keeps its own storage, so
opening it once while signed in is what tells Safari (same account) to stop
prompting; a signed-out iPhone visitor who added the app is still prompted in
Safari — iOS gives a website no way to see the home-screen app.

## Updates

**Installed web app (Android "Install app", iPhone "Add to Home Screen").**
`/sw.js` (src/app/sw.js/route.ts) is the service worker. Every build has its
own `GK_BUILD_VERSION` (next.config.ts), so each deploy is a new worker the
browser installs by itself when the app is opened or a page loads (and every
30 minutes while open, and when it returns to the screen). The page then shows
"A new version of GoKesari is ready — **Reload**". Without Reload, the new
version takes over on the next launch. Caches are named `gk-static-<version>`
and the old one is deleted when the new version takes over. Only the build's
static files and icons are cached: pages and API calls always come from the
network, so prices, stock, orders and sign-in are never stale.

**Native app (mobile/, version 1.4.0).** The pages inside the app are the live
website, so most changes reach it with no app update. For a new native build,
the app checks at launch and when it comes back to the screen (at most every
6 hours) — `mobile/src/app-update.ts`:

- asks `GET /api/app/version` for its platform: `latest`, `minimum`, `url`,
  from the server environment `MOBILE_APP_{ANDROID,IOS}_{LATEST,MINIMUM,URL}`;
- on iPhone, once `MOBILE_APP_IOS_URL` is an App Store link, Apple's own
  lookup (`itunes.apple.com/lookup?bundleId=…`) gives the version;
- newer build → "A new version of GoKesari is ready" (Later / Update); below
  `minimum` → "Update GoKesari to continue" (Update only). Update opens the
  Play Store app (`market://`), the App Store, or the APK link; the new build
  installs over the old one, signed in.

Not built: Google Play's **In-App Updates API** (download inside the app). It
works only for apps installed from Play, needs a native module and a store
build; the app is not on Play yet. The version check above covers Play, the
App Store and APK installs; the Play API can replace the Android dialog once
the app is listed.

## Settings (server environment, both sites)

| Variable | Meaning | Until set |
|---|---|---|
| `MOBILE_APP_ANDROID_URL` | Play listing (`https://play.google.com/…`) — also used by the install sheet — or an APK download link (update check only) | Install sheet uses Chrome's install / the guide; no update offered |
| `MOBILE_APP_ANDROID_LATEST` / `_MINIMUM` | `x.y.z` | No update offered / none required |
| `MOBILE_APP_IOS_URL` | App Store listing (`https://apps.apple.com/…`) | Install sheet shows the Add to Home Screen guide; no update offered |
| `MOBILE_APP_IOS_LATEST` / `_MINIMUM` | `x.y.z` (the App Store answer wins once listed) | as above |
| `GK_BUILD_VERSION` | optional build label; default the commit or the build time | — |

Set a version only once that build can actually be installed from the URL.

## Files

| Piece | File |
|---|---|
| Rules (who sees what, versions) | `src/lib/app-install.ts` |
| Install sheet (Tile Board style) | `src/components/app-install/install-prompt.tsx` |
| Reload bar + worker registration | `src/components/app-install/update-prompt.tsx` |
| Service worker | `src/app/sw.js/route.ts` |
| Account record | `src/server/services/app-install.ts`, `src/app/api/app-install/route.ts`, `drizzle/0121_app_install_states.sql` |
| Native update endpoint | `src/app/api/app/version/route.ts` |
| Native app | `mobile/src/app-update.ts`, `mobile/src/app-update-policy.ts` |
| Tests | `tests/unit/app-install.test.ts`, `tests/integration/app-install.test.ts`, `mobile/src/__tests__/app-update.test.ts`, `tests/qa/guest/app-install.spec.ts`, `tests/qa/signed-in/app-install.spec.ts` (TC-APP-001 … 013) |

Both database layouts: `app_install_states` is classified `platform` (core);
no seller table is touched.
