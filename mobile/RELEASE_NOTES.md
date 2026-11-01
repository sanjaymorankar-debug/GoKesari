# GoKesari app — release notes

## 1.6.0 (Android versionCode 7, iPhone build 7) — 31 Oct 2026

Aadhaar by DigiLocker for delivery partners (docs/gig-worker-2026-10 at the
repository root, "KYC provider"). Sandbox.co.in discontinued the Aadhaar OTP
check (UIDAI stopped offline e-KYC); partners now share their Aadhaar from
DigiLocker.

For the Play Store "What's new" / App Store "What's New in This Version":

> Delivery partners: verify your Aadhaar with DigiLocker — sign in with the OTP
> sent to your Aadhaar-linked mobile, allow GoKesari to see your Aadhaar, and
> you're back in the app. GoKesari keeps only your name and the last four
> digits.

Changes in the app itself:
- The KYC page's "Verify with DigiLocker" asks the app (bridge:
  `__gokesariApp.openDigiLocker(url)`) to open DigiLocker in the in-app
  browser — ASWebAuthenticationSession on iPhone, a Custom Tab on Android —
  the same way as Google sign-in. Only DigiLocker's own pages (and, on the
  test site, the website's mock consent page) are opened this way.
- When the partner finishes or declines, the website's return link hands back
  to `gokesari://digilocker-return` (`gokesari-preview://…` for the test
  build); the browser closes and the KYC page re-checks the result. Closing the
  browser early is handled the same way (the page shows Pending, with
  "Continue in DigiLocker").
- The bridge also tells the page the app's URL scheme, so the website starts
  the DigiLocker session with a return link for this build.
- Older builds (1.5.0 and before) still work: without `openDigiLocker` the page
  opens DigiLocker inside the app's WebView and DigiLocker returns to the
  website's KYC page there.
- The Sandbox DigiLocker SDK is not used (it needs separate SDK sessions and a
  native module); no new native dependency — expo-web-browser was already in.
- Version 1.5.0 → 1.6.0, versionCode / build 6 → 7. No new permissions.

## 1.5.0 (Android versionCode 6, iPhone build 6) — 31 Oct 2026

Automatic update check, docs/app-install-2026-10 at the repository root.

For the Play Store "What's new" / App Store "What's New in This Version":

> GoKesari now tells you when a new version is available and takes you
> straight to the update — you stay signed in.

Changes in the app itself:
- At launch and whenever the app comes back to the screen (at most every 6
  hours) it asks the website (`/api/app/version`) — and on iPhone the App
  Store, once listed — for the newest build, and offers Later / Update; below
  the minimum version only Update. Update opens the Play Store, App Store or
  the APK link and installs over this build.
- Version 1.4.0 → 1.5.0, versionCode / build 5 → 6. No new permissions.

## 1.4.0 (Android versionCode 5, iPhone build 5) — 31 Oct 2026

Gig worker (delivery partner) flow, docs/gig-worker-2026-10 at the repository
root. The screens are the website's pages, so they reach both apps as soon as
the site is deployed; this build adds the permission wording and the version.

### Android — GoKesari 1.4.0 (5) and GoKesari Test 1.4.0 (5)

For the Play Store "What's new" box:

> Delivery partners: register with your current location, verify your PAN and
> Aadhaar with an OTP, upload your police verification form and character
> certificate (PDF or photo), and switch between Offline, Active and Ready.
> Add an optional photo when you pick up an order. Shop owners: see which
> societies authorise or block each delivery partner. Customers and shops get a
> "Completed" confirmation when an order is delivered.

Changes in the app itself:
- Location permission text names registration and the Active / Ready states.
- Version 1.3.0 → 1.4.0, versionCode 4 → 5.

### iPhone — GoKesari 1.4.0 (5) and GoKesari Test 1.4.0 (5)

For App Store Connect "What's New in This Version": the same text as Android.

Changes in the app itself:
- Location (`NSLocationWhenInUseUsageDescription`), camera and photo library
  descriptions name the new uses: location at registration and while Active /
  Ready; pickup photo; police verification documents.
- Version 1.3.0 → 1.4.0, buildNumber 4 → 5.

### Checked

- `mobile/src/__tests__/gig-worker-flow.test.ts`: the registration, KYC,
  documents, shop Delivery partners and admin Rider verification pages open
  inside the app, from links and notification taps; the shop's Call link opens
  the dialler; the KYC and document APIs never open as pages.
- `npm test` (41 tests), `npm run typecheck`, `npx eslint src app.config.ts`.
- `npx expo config` for both variants: 1.4.0 / build 5.
