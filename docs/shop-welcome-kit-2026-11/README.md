# Shop welcome kit: printable banner with QR code (owner request, 20-Nov-2026)

**Status (20-Nov-2026): PR #431 into `staging` — see the test report for staging / production results.**

## What the owner asked for

1. Every shop gets its own QR code so customers reach the shop directly, without
   searching on GoKesari or on Google.
2. The owner's banner design ("We are available on GoKesari.com", the shop's name and
   "Scan QR Code of Your Shop") is filled in automatically for each shop.
3. As soon as a shop's registration is complete, the fee is received and the shop is
   live, the owner gets an automatic **congratulations / welcome e-mail** with the banner.
4. The e-mail tells the owner to **print the banner in colour** (on a colour page) and put
   it up at the shop.
5. The banner comes in **two languages: English and the shop's local language**.
6. The owner (and operations) can download the banners again at any time from Seller Central.
7. Shops that were already live are **not** e-mailed automatically; an admin can send them the
   kit (one shop, or a city / district), off by default.

## What was built

| Piece | File |
|---|---|
| Banner renderer (template + shop name + QR of `/shops/<slug>`, PNG / JPEG / A4 PDF) | `src/server/shop-banner/render.ts` |
| Templates: English (owner's design, placeholders cleared), Marathi, Hindi | `src/server/shop-banner/assets/template*.png` |
| Generator for the Marathi / Hindi templates (re-run after changing the English one) | `scripts/shop-banner/make-local-templates.py` |
| Font (Latin + Devanagari), SIL OFL 1.1, and the fontconfig file that makes sharp use it | `src/server/shop-banner/assets/Poppins-Bold.ttf`, `OFL.txt`, `fonts.conf` |
| One-page PDF holding a JPEG | `src/lib/image-pdf.ts` |
| Welcome e-mail (text + HTML with both banners inline, 2 PDFs attached) | `src/server/shop-banner/welcome-kit.ts` |
| Outbox type `SHOP_WELCOME_KIT` (+ optional HTML body; inline images via Content-ID) | `src/server/documents/email.ts`, `src/server/email/transport.ts` |
| Trigger: every go-live path | `approveShopTransaction` (`src/server/services/shops.ts`: admin / operator approval, automatic approval, instant GST/PAN approval) and `approveRegistration` (`src/server/registration/service.ts`: paid self-registration) |
| Download again (owner / operations; another owner 403, signed out 401) | `GET /api/shops/<id>/banner?lang=en|local&format=pdf|png`, buttons on **Seller Central → Marketing** (named "English" and "Marathi" / "Hindi") |
| Existing live shops: admin "Send welcome kit" (one shop, or bulk by city / district with a preview) | `src/server/shop-banner/admin-send.ts`, `GET/POST /api/admin/shops/welcome-kit`, page **Admin → Shops → Send welcome kit** (`/admin/shops/welcome-kit`), feature flag `shop_welcome_kit_admin_send_enabled` (off) |
| Tests | `tests/unit/shop-welcome-kit.test.ts`, `tests/integration/shop-welcome-kit.test.ts`, QA checks `tests/qa/{guest,signed-in,local}/sellers-welcome-kit.spec.ts` (cases TC-WKIT-001 … 013, journey SC-WKIT-01 in `test-cases.xlsx`) |

## How it behaves

- **When:** queued in the same database transaction that makes the shop `APPROVED`, sent
  right after commit by the document-email outbox; a failed send is retried with backoff
  (the every-minute cron is the safety net). No SMTP, or the owner has only a placeholder
  e-mail → `SKIPPED` (the owner can still download from Marketing).
- **Once per shop, ever:** the outbox row is unique per shop and recipient, and
  `queueShopWelcomeKit` also refuses when the shop already has a row for any recipient — a
  shop suspended and approved again, or one that changed hands, is not welcomed twice.
  Queuing runs in a savepoint and never blocks or rolls back an approval; a failed send is
  retried with backoff (60 s → 6 h, 5 tries) by the outbox sweep.
- **Local language:** Marathi for Maharashtra and Goa, Hindi elsewhere; with no state, PIN
  codes 40xxxx–44xxxx count as Maharashtra / Goa. The shop name is printed as registered
  (no transliteration). Other scripts (Gujarati, Kannada, Tamil, Telugu, Bengali, …) need a
  template and a font: add them to `BANNER_LANGUAGES`, `localBannerLanguage` and the
  generator script.
- **QR target:** `<site>/shops/<slug>` (test.gokesari.com on staging, gokesari.com on
  production). Opens the shop in the mobile app when installed (deep link `/shops/`).
- **Print instructions in the e-mail:** print in COLOUR on a colour page (not black and
  white); A4 landscape "Fit to page", or a print shop sticker / flex; scan the QR first;
  put it at the counter or entrance at eye level; laminate. One line repeats the key
  instruction in the local language.
- **Existing live shops** are not e-mailed by this change (no back-fill). They can download
  their banners from Marketing. An ADMIN can send them the kit from **Admin → Shops → Send
  welcome kit** once the feature flag **Send welcome kit to existing shops**
  (`shop_welcome_kit_admin_send_enabled`) is on — it is off on both sites by default:
  - *One shop:* search by name or registration number → **Send welcome kit** (sent within a
    minute). A shop that already had it cannot get it again.
  - *Bulk:* a city and/or a district → **Preview** (how many live shops never had it) →
    tick "The owner knows about this bulk run" → **Send**. At most 200 shops per run; the
    e-mails are not sent at once but by the outbox sweep (50 per run), so the mail server is
    never flooded. **On gokesari.com, tell the owner before any bulk run.**
  - Every send is audited (`shop.welcome_kit_sent`, `shop.welcome_kit_bulk_sent`).
- **Fonts:** sharp draws the name with the bundled Poppins Bold only when fontconfig can load
  it. `render.ts` points `FONTCONFIG_FILE` at `assets/fonts.conf` (which keeps the system's
  own config) and `PANGOCAIRO_BACKEND` at `fc`, unless the process set them. Without this
  the name fell back to Helvetica on a Mac, and a Hindi / Marathi name could print as boxes
  on a server without Devanagari fonts (found and fixed 20-Nov-2026).

## Adding another language (Gujarati, Kannada, Tamil, Telugu, Bengali, …)

Each script needs its own template and a font that covers it. For example, Gujarati:

1. **Font.** Poppins covers Latin and Devanagari only. Add a bold font for the script under
   `src/server/shop-banner/assets/` with its licence (SIL OFL fonts from Google Fonts:
   Gujarati — *Noto Sans Gujarati* or *Hind Vadodara*; Kannada — *Noto Sans Kannada*;
   Tamil — *Noto Sans Tamil* or *Hind Madurai*; Telugu — *Noto Sans Telugu* or *Hind
   Guntur*; Bengali — *Noto Sans Bengali* or *Hind Siliguri*). `fonts.conf` already loads
   every font in that folder.
2. **Template.** In `scripts/shop-banner/make-local-templates.py` add the language to
   `TEXTS` (ribbon, three labels, QR heading, bottom line — translated and checked by a
   native speaker) and point it at the new font; run the script; look at
   `template-<lang>.png` and commit it. Positions are shared with the English template.
3. **Code.** In `src/server/shop-banner/render.ts` add the code to `BANNER_LANGUAGES` and
   `BANNER_LANGUAGE_LABEL`, and the state rule to `localBannerLanguage` (e.g. `gujarat` →
   `gu`; PIN codes 36–39 for Gujarat when no state is set). If the shop *name* may be
   written in that script, pass the script's font family in `renderShopBanner` (Pango picks
   it for those characters automatically once the font is in the folder).
4. **E-mail.** Add the one-line instruction to `LOCAL_PRINT_LINE` in `welcome-kit.ts`, and
   the language name to the Marketing page and the admin page.
5. **Tests.** Extend the `localBannerLanguage` and banner cases in
   `tests/unit/shop-welcome-kit.test.ts`.

## Wording to check with a native speaker before production

The Marathi and Hindi texts are in `TEXTS` in `scripts/shop-banner/make-local-templates.py`
(the templates) and `LOCAL_PRINT_LINE` in `src/server/shop-banner/welcome-kit.ts` (the
e-mail line). Owner action: have a Marathi and a Hindi speaker read the two templates and
the e-mail line; send corrections and re-run the generator.

| | Marathi | Hindi |
|---|---|---|
| Ribbon ("We are available on") | आमचे दुकान आता ऑनलाइन | हमारी दुकान अब ऑनलाइन |
| Trusted & Secure | विश्वासार्ह व सुरक्षित | भरोसेमंद और सुरक्षित |
| Delivered with Care | काळजीपूर्वक डिलिव्हरी | सावधानी से डिलीवरी |
| For Everyone, Everywhere | सर्वांसाठी, सर्वत्र | सबके लिए, हर जगह |
| Scan QR Code of Your Shop | आमच्या दुकानाचा QR कोड स्कॅन करा | हमारी दुकान का QR कोड स्कैन करें |
| Grow Your Business with GoKesari | GoKesari सोबत तुमचा व्यवसाय वाढवा | GoKesari के साथ अपना व्यापार बढ़ाएँ |

## QR code → the app (Android / iOS)

The QR code opens `https://<site>/shops/<slug>`. The apps (1.9.0) already claim `/shops/`
links: Android intent filter with `autoVerify` and iOS `applinks:<host>` in
`mobile/app.config.ts`, and `/shops/` in the app's route map (`mobile/src/deep-links.ts`).
The apps are WebView apps, so the Marketing download buttons work inside them too (Android
downloads natively; iOS opens the share sheet). **No app update is needed.**

What decides whether the phone opens the app or the browser is the two association files,
which on 20-Nov-2026 still carry placeholders on **both** sites
(`REPLACE_WITH_APPLE_TEAM_ID…`, `REPLACE_WITH_SHA256_SIGNING_FINGERPRINT`): until the owner
sets `MOBILE_ANDROID_CERT_SHA256` and `MOBILE_IOS_APP_IDS` on each server
([docs/deep-links-activation.md](../deep-links-activation.md)), a scanned QR opens the shop
in the phone's browser. It still lands on the shop's page; nothing else changes once the
values are set (no rebuild).

**Android, found 20-Nov-2026:** the APKs built by the "Android APK" workflow
(`.github/workflows/mobile-apk.yml`: "GoKesari Test" for test.gokesari.com, "GoKesari" for
gokesari.com) are release builds signed with the debug key of Expo's project template
(`expo-template-bare-minimum@sdk-57`, `android/app/debug.keystore`, alias `androiddebugkey`),
whose SHA-256 is

    FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C

Owner action, per server (`gk-site env set`, then `gk-deploy restart`; no rebuild):

| Server | `MOBILE_ANDROID_CERT_SHA256` | Note |
|---|---|---|
| test.gokesari.com (`gokesari-staging`) | the value above | the preview APK then opens scanned QR codes |
| gokesari.com (`gokesari-prod`) | the value above, **owner decision** | that key is public: any sideloaded app named `com.gokesari.app` and signed with it could claim the links. Add the Play Store app-signing SHA-256 (comma-separated) when the app is on Play, and drop this one then |

**iOS:** no iPhone build is distributed yet (TestFlight on hold, PLT-017), so there is nothing
to open; set `MOBILE_IOS_APP_IDS` with the Team ID when it is.

## Known limits

- The template is 1536 × 1024 px: sharp up to about A5 / 13–15 cm wide; acceptable on A4.
  For large stickers or flex boards, replace `template.png` with a higher-resolution or
  vector export of the same layout (positions are fractions, no code change) and re-run the
  generator.
- The design's own text "For Everyone, At Everywhere" is kept as in the owner's design
  (suggested wording: "For Everyone, Everywhere").
