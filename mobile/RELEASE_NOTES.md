# GoKesari app — release notes

## 1.10.0 (Android versionCode 11, iPhone build 11) — 20 Nov 2026

GoKesari Health (docs/health at the repository root).

For the Play Store "What's new" / App Store "What's New in This Version":

> My Health: one health record for you and your family. Book verified doctors,
> get prescriptions on your phone and by e-mail, send them to a nearby medical
> store for pickup or home delivery, book nurses and physiotherapists at home,
> and rent medical equipment. Doctors get a live clinic dashboard and an
> e-prescription pad.

Changes in the app itself:
- Android App Links / iOS associated domains: `/health` (My Health, doctors,
  prescriptions, medicine orders, home care, equipment) and `/rx` (prescription
  QR verification) open in the app when tapped outside it. Clinic, store and
  provider screens (`/shop/health…`) are already covered by `/shop`.
- Nothing native changed: every Health screen is a website page, live in every
  installed version once the website is deployed; live updates use the WebView's
  EventSource; printing uses the system print / share sheet from the PDF.
- The in-app update check offers 1.10.0 once `MOBILE_APP_ANDROID_LATEST` /
  `MOBILE_APP_IOS_LATEST` are set to 1.10.0 on the server after the store release.

## 1.9.0 (Android versionCode 10, iPhone build 10) — 20 Nov 2026

One build carries two website modules: Consultant appointments and Puja Samagri.

### Consultant appointments

Consultant appointments (docs/consult-booking-2026-11 at the repository root).

For the Play Store "What's new" / App Store "What's New in This Version":

> Book doctors, lawyers, CAs, tutors, salons and home-service experts near you:
> pick a free time, pay online or at the visit, get reminders, and manage your
> appointments. Consultants get a calendar for their whole team.

Changes in the app itself:
- Android App Links: `/consult` (Find a Consultant, consultant pages, appointment
  pages) opens in the app when tapped outside it. Inside the app nothing native
  changed — the booking screens, calendar and reminders are website pages, live
  in every installed version as soon as the website is deployed; booking pushes
  open their page through the existing notification tap handling.

### Puja Samagri & Temple Supplies

Puja Samagri & Temple Supplies (docs/puja-samagri-2026-11 at the repository root).

For the Play Store "What's new" / App Store "What's New in This Version":

> New: Puja Samagri. Agarbatti, diye, kapur, havan samagri, kumkum, murti,
> puja kits and festival items from shops near you — search in English, हिंदी
> or मराठी, filter by festival, price or loose / packed, and ask the price of
> loose flowers and items. Puja shop owners: take the full puja catalogue in
> one go, add your own products and manage stock from the app.

Changes in the app itself:
- `/puja` opens in the app from shared links (Android App Links intent filter;
  iOS Universal Links already cover every path).
- Every screen of the feature — the customer Puja page and tile, Nearby's
  Puja filter, the shop owner's Puja Samagri screen (catalogue, product types,
  bulk Excel / CSV, inline stock and price grid) and the admin / operator
  screens — is the website inside the app, so 1.8.x apps get it too, without
  an update.
- No new permissions, no new native modules. The in-app update check
  (`/api/app/version`) offers 1.9.0 once `MOBILE_APP_ANDROID_LATEST` /
  `MOBILE_APP_IOS_LATEST` are set to 1.9.0 on the server after the store
  release; 1.8.0 stays the minimum (no forced update).

## 1.8.0 (Android versionCode 9, iPhone build 9) — 7 Nov 2026

Payments through Cashfree's own mobile SDK (docs/payments-cashfree-audit-2026-11
at the repository root).

For the Play Store "What's new" / App Store "What's New in This Version":

> Faster, more reliable payments: pay by card, by any UPI app on your phone
> (Google Pay, PhonePe, Paytm, BHIM …) or by wallet in Cashfree's secure
> checkout, and come straight back to GoKesari.

Changes in the app itself:
- `react-native-cashfree-pg-sdk` 3.0.0 (Android `com.cashfree.pg:api` 2.6.0,
  iOS `CashfreePG` 2.5.2) and `cashfree-pg-api-contract` 2.2.0. The website asks
  the app (`__gokesariApp.cashfreeCheckout`, capability
  `cashfree-native-checkout`) to take a payment it has already created on its
  server; the app opens Cashfree's checkout (cards, UPI, wallets, net banking)
  or its UPI-intent checkout (the phone's UPI apps) and tells the page when the
  flow ends. The page then asks its server, which asks Cashfree — the phone's
  answer is never taken as proof of payment. The app holds no Cashfree key.
- The production app takes only production payments and the test app only
  sandbox ones (a mismatched request is refused).
- Android: `<queries>` for the `upi:` intent (Android 11+ package visibility),
  so Cashfree can list the installed UPI apps. iOS:
  `LSApplicationQueriesSchemes` for upi, phonepe, tez, gpay, paytmmp, paytm,
  bhim, credpay, amazonpay, mobikwik, myairtel, navipay, kiwi, popclubapp,
  super, simplypayupi and whatsapp.
- Older builds keep Cashfree's web checkout inside the WebView, unchanged.
- Version 1.7.0 → 1.8.0, versionCode / build 8 → 9. No new permissions.
- **Production payments from the app need the store build** (Play Store /
  TestFlight): Cashfree's integrity check refuses production payments from a
  sideloaded APK. Whitelist `com.gokesari.app` in Cashfree (Developers →
  Whitelisting → App) before release.

## 1.7.0 (Android versionCode 8, iPhone build 8) — 2 Nov 2026

Dealer network (TIERED commission) and shop-refers-shop
(docs/dealer-programme/TIERED_COMMISSION.md at the repository root).

For the Play Store "What's new" / App Store "What's New in This Version":

> Dealers and their team leads and agents: see your team, what you earned by
> type and level, each shop's progress to its trading milestone, and your
> monthly statement with gross, TDS and net. Shop owners: share your shop's own
> referral link and earn a reward when another shop joins with it.

Changes in the app itself:
- The dealer portal (`/dealer`) and Add my shop (`/shop/register`) are
  deep-link routes (App Links on Android, Universal Links on iPhone): a shop's
  referral link `https://gokesari.com/r/SHOP…` opens the app, which lands on
  Add my shop with the code filled in (the `/r/` route was already linked).
- Push notifications for commission earned, commission reversed, payouts paid
  and shop-referral rewards / reversals open the dealer portal or the shop
  wallet in the app (the website sends them on the push channel).
- The team tree, earnings, TRADING progress, the referral code field in shop
  registration and the shop's share card are website pages, so they need no
  native change; older builds (1.6.0 and before) show them too, and only miss
  the new deep-link routes (those links open in the browser instead).
- Version 1.6.0 → 1.7.0, versionCode / build 7 → 8. No new permissions.

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
