# Deep links — activation (F15.2.3, NEW-044)

Links to gokesari.com / test.gokesari.com (shared on WhatsApp, SMS, email,
push) open the GoKesari app when it is installed, and the website when it is
not. The website already serves both association files; they carry
**placeholders** until you paste in two values below. A placeholder is safe:
Android and Apple simply fail verification, so links keep opening in the
browser exactly as today.

| File | URL | Until set |
|---|---|---|
| Android App Links | `https://gokesari.com/.well-known/assetlinks.json` (and on test.gokesari.com) | fingerprint `REPLACE_WITH_SHA256_SIGNING_FINGERPRINT` |
| iOS Universal Links | `https://gokesari.com/.well-known/apple-app-site-association` (no extension, `application/json`) | app id `REPLACE_WITH_APPLE_TEAM_ID.com.gokesari.app` |

Both files are host-aware: gokesari.com lists the store app
`com.gokesari.app`, test.gokesari.com the preview app `com.gokesari.app.preview`.

## 1. Android — the SHA-256 signing fingerprint

Where to get it:

- **Store app (gokesari.com):** Play Console → the app → *Test and release →
  App integrity → App signing* → **App signing key certificate → SHA-256
  certificate fingerprint**. If you also install APKs signed with the upload
  key, add the **Upload key certificate** SHA-256 too.
- **Preview app (test.gokesari.com) or any EAS-signed build:**
  `npx eas-cli@latest credentials` → Android → the profile (`preview` /
  `production`) → *Keystore* → SHA-256 fingerprint.

Where to paste it — Hostinger → the site → *Environment variables* (one per site):

| Variable | gokesari.com | test.gokesari.com |
|---|---|---|
| `MOBILE_ANDROID_CERT_SHA256` | `AB:CD:…` (Play app signing key; comma-separate several) | `AB:CD:…` (EAS preview keystore) |
| `MOBILE_ANDROID_PACKAGE` | optional — defaults to `com.gokesari.app` by host | optional — defaults to `com.gokesari.app.preview` by host |

The value is read on every request: no rebuild is needed, only a restart if
Hostinger requires one for new variables.

## 2. iOS — the Apple Team ID

Find it at developer.apple.com → *Account → Membership details → Team ID*
(10 characters, e.g. `ABCDE12345`).

| Where | Value |
|---|---|
| Hostinger, gokesari.com: `MOBILE_IOS_APP_IDS` | `<TEAMID>.com.gokesari.app` |
| Hostinger, test.gokesari.com: `MOBILE_IOS_APP_IDS` | `<TEAMID>.com.gokesari.app.preview` |
| GitHub → Settings → Secrets → Actions: `APPLE_TEAM_ID` | `<TEAMID>` (used by the "iPhone app" workflow, `.github/workflows/mobile-ios.yml`) |

The app side is already in place: `associatedDomains: applinks:<host>` for
both builds and Android intent filters with `autoVerify` in
`mobile/app.config.ts`. Universal Links need a new iPhone build only if the
Team ID changes.

## 3. Which links open in the app (route map)

| What | Path | Android filter | iOS |
|---|---|---|---|
| Product | `/products/<id>` | `/products` | all pages except `/api/*`, `/mobile-auth/*`, `/.well-known/*` |
| Shop | `/shops/<slug>` | `/shop` | 〃 |
| Order | `/orders/<id>` | `/orders` | 〃 |
| Invite / referral | `/r/<code>`, `/refer`, `/referral` | `/r/`, `/refer` | 〃 |
| Notification | `/notifications/<id>` (marks it read, opens its page) | `/notifications` | 〃 |
| Help-desk ticket | `/support/tickets/<id>` | `/support/tickets/` | 〃 |

The lists live in `src/lib/deep-links.ts` (website), `mobile/src/deep-links.ts`
and `mobile/app.config.ts` (`APP_LINK_PATH_PREFIXES`, `DEEP_LINK_ROUTE_PREFIXES`);
`tests/unit/batch-f-deep-links.test.ts` checks they agree. Inside the app,
incoming links and tapped push notifications are routed into the app's own
page view only for the site's host and these pages; anything else is ignored.

## 4. Verify

1. Both files answer JSON with your values:
   `curl -s https://gokesari.com/.well-known/assetlinks.json` and
   `curl -sI https://gokesari.com/.well-known/apple-app-site-association` (look for `content-type: application/json`).
2. **Google's Statement List tester:**
   `https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://gokesari.com&relation=delegate_permission/common.handle_all_urls`
   — must list `com.gokesari.app` with your fingerprint (repeat with `https://test.gokesari.com`).
3. **On an Android phone** with the app installed (USB debugging on):
   `adb shell pm verify-app-links --re-verify com.gokesari.app`, then
   `adb shell pm get-app-links com.gokesari.app` — `gokesari.com: verified`.
   Test: `adb shell am start -a android.intent.action.VIEW -d "https://gokesari.com/orders"`.
4. **Apple's CDN copy** (what iPhones actually read, refreshed within ~24 h):
   `https://app-site-association.cdn-apple.com/a/v1/gokesari.com` (and `/a/v1/test.gokesari.com`).
   Then on an iPhone with the app: long-press a gokesari.com link in Notes → "Open in GoKesari".

Not installed? Nothing to do: an https link simply opens the website.
