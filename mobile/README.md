# GoKesari — Android and iPhone app

The app shows the GoKesari website inside a native app. Everything the site
does is in the app, for every role: customers, shop owners, delivery partners,
operators and admins. A change deployed to gokesari.com reaches the app straight
away, with no app update. The app adds the native pieces a website can't do well
inside a phone app.

| Feature | In the app |
|---|---|
| Browse, cart, checkout, orders, returns, grievances, referrals, societies | The website's own pages |
| Wallet top-up (Cashfree) | Card, net-banking and 3-D Secure stay in the app. UPI app links open the UPI app (Android shows its app chooser) |
| Sign in with an emailed code | Works in the app |
| Continue with Google | Opens Google in the system browser (Google blocks sign-in inside apps), then returns to the app signed in |
| Sign-in link by email | Hidden in the app: the link would sign in the phone's browser, not the app |
| "Use my location", delivery-partner live location | Phone's location service, one permission prompt |
| Photo uploads (products, proof of delivery, documents) | Camera or gallery picker |
| Invoice PDF, Excel templates | Android: saved to Downloads, with a notification. iPhone: share sheet (Save to Files, WhatsApp, Print…) |
| Print (invoice page) | Native print dialog |
| Share buttons | Native share sheet |
| Phone, email, WhatsApp, Google Maps links | Open the matching app |
| Links to other websites | Open in the browser |
| Links to gokesari.com (WhatsApp, email…) | Open in the app once [deep links](#deep-links) are set up |
| No internet | "Can't reach GoKesari" screen with Try again |
| Android back button | Goes back through pages, then exits |

How it is put together:

| File | What it does |
|---|---|
| `src/App.tsx` | The screen: WebView, links, back button, offline screen, splash |
| `src/navigation-policy.ts` | Decides whether a link stays in the app, opens another app or is blocked |
| `src/bridge-script.ts` | Script injected into the website's pages: share, location, print, downloads, outside links |
| `src/bridge.ts` | The native side of that script |
| `src/google-sign-in.ts` | Google sign-in through the system browser. The website side is `src/server/mobile-auth.ts` and `src/app/mobile-auth/` at the repository root |
| `app.config.ts` | Name, ids, permissions and deep links for both builds |
| `eas.json` | Cloud build profiles |

## The two builds

| Build | Shows | App id | Icon name |
|---|---|---|---|
| `production` | https://gokesari.com | `com.gokesari.app` | GoKesari |
| `preview` | https://test.gokesari.com | `com.gokesari.app.preview` | GoKesari Test |

They can be installed side by side. Use `preview` to try changes against the
test site with Cashfree sandbox payments.

## Before the first build: deploy the website

Google sign-in in the app needs the website's `/mobile-auth/...` pages, which
were added together with the app. Deploy them to test.gokesari.com before
testing the preview build, and to gokesari.com before releasing the store
build. Nothing else on the website changes for people using a browser.

## First-time setup

Builds run in Expo's cloud (EAS), so you don't need Android Studio, Xcode or a
Mac, including for the iPhone build.

1. **Accounts.**
   - Expo (free): https://expo.dev/signup
   - Google Play Console ($25, one-off) to publish on Android.
   - Apple Developer Program ($99 a year) to publish on iPhone, or to install
     test builds on an iPhone.
2. **Install.** Node 22, then:
   ```bash
   cd mobile
   npm ci
   ```
3. **Link the project to Expo.**
   ```bash
   npx eas-cli@latest login
   npx eas-cli@latest init
   ```
   `init` prints a project id. Put it in `app.config.ts`:
   `const EAS_PROJECT_ID = "<the id>";`. Commit that change.

## Try it on a phone

Android: an installable APK, no store account needed.

```bash
npx eas-cli@latest build --profile preview --platform android
```

When the build finishes, open the link it prints on the phone, or scan the QR
code, and install. Android asks once to allow installs from that source.

iPhone: Apple only lets registered devices install test builds. Register the
iPhone, then build:

```bash
npx eas-cli@latest device:create
npx eas-cli@latest build --profile preview --platform ios
```

Alternatively, make a store build and use TestFlight (see below).

## Publish to the stores

```bash
# Android: an .aab for Google Play
npx eas-cli@latest build --profile production --platform android
npx eas-cli@latest submit --profile production --platform android

# iPhone: EAS creates the signing certificates for you
npx eas-cli@latest build --profile production --platform ios
npx eas-cli@latest submit --profile production --platform ios
```

- **Google Play.** Google wants the very first `.aab` uploaded by hand in Play
  Console (download it from the build page). After that, `submit` can upload
  it once you add a Play service-account key (`eas submit` explains each step).
  Play Console also asks for a privacy policy URL
  (https://gokesari.com/legal/privacy-policy), the Data safety form, and
  screenshots.
- **App Store.** `submit` uploads to App Store Connect. The build appears in
  TestFlight for testing, and from there you send it for review.
- Version numbers: `version` in `app.config.ts` is the version people see. Build
  numbers go up automatically with each production build.

### Before sending it for review

These are store rules the website doesn't meet yet. They need a decision from
you, not app code:

- **Account deletion (both stores).** If an app lets people create an
  account, the stores require a way to start deleting that account from inside
  the app. The site has no "delete my account" option yet: the privacy policy
  sends erasure requests through the grievance process. Add a clearly labelled
  way to request deletion (for example on the profile page) before submitting.
- **Sign in with Apple (App Store guideline 4.8).** Apps that offer Google
  sign-in must also offer an equivalent option that protects privacy; Sign in
  with Apple meets that requirement. The emailed code may not count, because it
  is not a way to hide your email. Either add Sign in with Apple to the website,
  or hide Google in the iPhone app so it uses only GoKesari's own sign-in.
- **Minimum functionality (guideline 4.2).** Apple rejects apps that are only a
  website in a frame. This app adds native sign-in, location, camera, sharing,
  printing, downloads and deep links. Push notifications would strengthen it
  further (see [Not included yet](#not-included-yet)).

## Deep links

With this set up, tapping a gokesari.com link in WhatsApp, SMS or email opens
the app (if installed) instead of the browser. It is optional. Without it,
links simply open in the browser. Set it up after the first store build, because
it needs the signing details.

On the website's host (Hostinger), set:

| Variable | gokesari.com | test.gokesari.com |
|---|---|---|
| `MOBILE_ANDROID_PACKAGE` | `com.gokesari.app` (the default) | `com.gokesari.app.preview` |
| `MOBILE_ANDROID_CERT_SHA256` | Play Console → Test and release → App integrity → App signing key certificate, SHA-256 (comma-separate it with the upload key's if you also sideload) | `npx eas-cli@latest credentials` → Android → preview keystore SHA-256 |
| `MOBILE_IOS_APP_IDS` | `<Apple Team ID>.com.gokesari.app` | `<Apple Team ID>.com.gokesari.app.preview` |

Check that https://gokesari.com/.well-known/assetlinks.json and
https://gokesari.com/.well-known/apple-app-site-association return JSON. Links
to `/api/...` and `/mobile-auth/...` always stay in the browser. If the website
gets a new top-level page, add it to `APP_LINK_PATH_PREFIXES` in
`app.config.ts`. A test at the repository root fails until you do.

## Checklist before each release

Run through these on a real Android phone and a real iPhone, on the `preview`
build, against test.gokesari.com:

- [ ] Continue with Google → back in the app, signed in (lands on onboarding or the home page)
- [ ] Sign in with an emailed code
- [ ] Wallet top-up: card (3-D Secure page stays in the app), a UPI app (opens the UPI app; after paying, the wallet updates) and net banking (if Cashfree opens the bank in a new window, the app sends it to the browser — check the wallet still updates afterwards)
- [ ] "Use my location" on the delivery-location picker
- [ ] Delivery partner: go online, location sharing keeps updating with the app open
- [ ] Upload a photo from the camera, and one from the gallery
- [ ] Download an invoice PDF and a shop's Excel price template
- [ ] Print an invoice
- [ ] Share (the "invite a shop" card)
- [ ] Phone, WhatsApp and Google Maps links open their apps
- [ ] Airplane mode → "Can't reach GoKesari" → Try again after reconnecting
- [ ] Android: the back button walks back through pages, then leaves the app
- [ ] Android: a form near the bottom of the screen stays visible above the keyboard
- [ ] Rotate the phone (and an iPad, if you list on iPad)

## Not included yet

- **Push notifications.** The website sends notifications by email and in the
  notification bell (both work in the app). It has a slot for a push channel
  that has no provider yet (`src/server/notifications/channels.ts`). Adding
  push means `expo-notifications` in the app, a table of device tokens and a
  `PUSH` channel provider on the website.
- **Location while the phone is locked.** A delivery partner's live location
  keeps updating while the app is open on screen, as on the website. Updating
  it in the background needs the "allow all the time" location permission,
  which both stores review separately.

## Development

```bash
npm run typecheck
npm run lint
npm test          # URL policy, bridge script, PKCE (no device needed)
npx expo-doctor   # dependency and config checks
```

To run it on a device while developing, make a development build (it shows
test.gokesari.com): `npx expo install expo-dev-client`, then
`npx eas-cli@latest build --profile development`, then `npx expo start`. Expo Go
is not enough: Google sign-in returns to the app through the app's own URL
scheme, which only a real build has.

Only add packages with `npx expo install <package>`, which picks versions that
match the Expo SDK. The `android/` and `ios/` folders are generated at build
time; change native settings in `app.config.ts`, never in those folders.
