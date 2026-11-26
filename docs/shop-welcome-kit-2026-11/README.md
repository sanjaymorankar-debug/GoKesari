# Shop welcome kit: printable banner with QR code (owner request, 20-Nov-2026)

**Status (20-Nov-2026): PR #431 into `staging` — see the test report for staging / production results.**
**26-Nov-2026: personalised banner + e-mail — see the next section.**

## 26-Nov-2026: personalised banner and welcome e-mail (owner brief, 26-Nov-2026 10.50 IST)

The brief: "Welcome e-mail with a personalised shop banner (shop name + owner name) for every registered shop".
Built on branch `feat/welcome-kit-personalised-2026-11-26` (PR into `staging`, migration 0214).

### What already worked before this change (checked 26-Nov-2026 11.00 IST)

| | Status before |
|---|---|
| Banner (EN + Marathi / Hindi) with shop name and an "Order online" QR of `/shops/<slug>`, PNG + A4 PDF | ✅ `render.ts` |
| Welcome e-mail with both banners inline + PDFs, colour-print, scan-first, eye level, laminate, local-language line, Add products / Marketing / Help links | ✅ `welcome-kit.ts` |
| Queued in the go-live transaction (savepoint, never blocks), once per shop ever, retried 60 s → 6 h | ✅ |
| Every go-live path ends in `approveShopTransaction` or `approveRegistration`: wizard + checkout, dealer fee link, admin payment link, admin "mark as paid", staff / admin / dealer on the owner's behalf, automatic and instant GST/PAN approval (all fee captures call `autoApproveShopIfReady`) | ✅ (traced 26-Nov) |
| Marketing download (owner + operations), admin send to one shop or a city / district (flag `shop_welcome_kit_admin_send_enabled`, off) | ✅ |
| Shop QR opens the app (Android app links, fingerprint set on both sites 20-Nov) | ✅ |

### Gaps found against the brief, and what closed them

| # | Gap | Done |
|---|---|---|
| G1 | No owner name on the banner | "Owner: …" / "मालक: …" / "मालिक: …" under the shop name, both auto-fitted (Poppins: Latin + Devanagari) |
| G2 | Headline was "We are available on GoKesari.com" | "This shop is now live on GoKesari.com" (Marathi "हे दुकान आता लाइव्ह आहे", Hindi "यह दुकान अब लाइव है" — native-speaker check pending) on all three templates (`scripts/shop-banner/set-ribbon.ts en|mr|hi`) |
| G3 | No UPI QR | "Pay here (UPI)" QR beside the shop QR, from `inv_settings.upi_vpa`, payee = shop name, no amount; left out without a UPI ID (the e-mail says how to add one). The shop QR's heading is now "Order online — Scan this QR" so the two cannot be confused |
| G4 | Owner could not use an existing payment QR | Optional upload on Seller Central → Marketing: the QR is read (jsQR), must be `upi://pay` with a valid payee and no fixed amount; its text is kept (`inv_settings.banner_upi_qr`, 0214), the photo is not |
| G5 | E-mail not personalised; no phone; no company line | "Dear <owner>, congratulations! <shop> is now live on GoKesari.com"; "Questions? Write to support@gokesari.com or call +91 91751 93009"; footer "gokesari.com is a unit of ASMY GLOBAL TRADING & CONSULTANCY INDIA PRIVATE LIMITED" |
| G6 | Not every path had a test that the kit is queued | One test per path (TC-WKIT-025 … 038) |
| G7 | No safety net if a go-live path ever skipped the kit | Cron `welcome-kit-safety-net` (every 15 min): live shops approved since rule `shopWelcomeKit.safetyNetFrom` (= when 0214 ran) without a kit get it |
| G8 | Shops that had the 20-Nov kit cannot get the new banner by e-mail | Admin → Shops → Send welcome kit → **Resend updated banner** (one shop; own outbox type `SHOP_BANNER_UPDATE`, no second congratulations, 10-minute guard, audited) |
| G9 | Bulk send needed a city or district | "All live shops" option (≤ 200 per run; run again until none remain) |
| G10 | "Make the India map clearly visible" | **Dropped (owner, 26-Nov-2026 12.07 IST: "Leave the map out")** — the templates have no India map and none is added |

### Decisions

- **Owner name source: `shops.owner_name`** — the name entered for *this* shop at registration (the wizard fills it
  from the PAN holder's name; staff type it when registering on the owner's behalf). Not `users.name`, which can be
  blank, a nickname or an e-mail address and is shared by every shop one mobile owns. Cleaned by `bannerOwnerName()`:
  no line for blank, "null" / "undefined" / "N/A" / "Owner" placeholders, an e-mail address or a number; a name in
  capitals (as PAN gives it) is printed in title case.
- **One renderer**: PNG, PDF, the e-mail and the Marketing download all come from `shopBannerFiles()` → `renderShopBanner()`, so they match.
- **When**: on go-live (as before). A shop whose fee is paid but which still waits for an admin (missing documents,
  rule off) gets the kit when it goes live: before that its QR page does not open.
- **Existing shops** are never e-mailed automatically (the safety net starts at the 0214 release time). Admin bulk send, in batches, after staging verification.
- **One e-mail with #600**: PR #600 (seller agreements, flag `seller_agreements_enabled`, off) e-mails new shops their
  signed agreements with the banners from `onRegistrationFeePaid`. Owner rule: one welcome mail per shop. Merging the
  two (this e-mail carrying the signed PDFs when that flag is on) is done after #600 lands on `staging` — see "Follow-up with #600" below.
- **Mobile apps**: no change needed — the shop QR opens `/shops/<slug>` (claimed by the apps), a scanned UPI QR is
  handled by the phone's camera / UPI app (and `upi:` links in the app open the UPI app), Marketing downloads and the
  QR upload work in the WebView (Android native download, iOS share sheet). App 1.15.0 (staging) — no EAS update.

### Follow-up with #600 (after it is merged into `staging`)

With `seller_agreements_enabled` on, `onRegistrationFeePaid` sends a `SELLER_AGREEMENTS` mail with the banners, and
this kit sends `SHOP_WELCOME_KIT` on go-live: two mails. The merge: when the flag is on, the welcome kit's renderer
attaches the signed SLA PDFs (from `legal_signed_files`) and #600's fee-paid mail leaves the banners out (and is not
sent for a new shop whose kit carries them). Until then the flag stays off on both sites, so each shop gets one mail.

### Preview (26-Nov-2026)

`preview-2026-11-26/`: with UPI (EN / MR / HI), without UPI (MR), without owner name or UPI (EN). Both QRs decode
from a blurred 1000-px "phone photo" of the banner in all three languages (unit test TC-WKIT-021).

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
| Brand tagline under the logo on all three templates ("Everything for Everyone, Everywhere", the site's tagline since 20-Nov-2026, PR #430; re-run after the generator) | `scripts/shop-banner/set-tagline.ts` |
| Third feature label "Everything For Everyone, Everywhere" (Marathi / Hindi as owner-approved, 21-Nov-2026) | `scripts/shop-banner/set-everywhere-label.ts` |
| Marathi ribbon line "आपले दुकान आता ऑनलाइन" (owner's correction of "आमचे …", 21-Nov-2026) | `scripts/shop-banner/set-ribbon.ts` |
| Font (Latin + Devanagari), SIL OFL 1.1, and the fontconfig file that makes sharp use it | `src/server/shop-banner/assets/Poppins-Bold.ttf`, `OFL.txt`, `fonts.conf` |
| One-page PDF holding a JPEG | `src/lib/image-pdf.ts` |
| Welcome e-mail (text + HTML with both banners inline, 2 PDFs attached) | `src/server/shop-banner/welcome-kit.ts` |
| Outbox type `SHOP_WELCOME_KIT` (+ optional HTML body; inline images via Content-ID) | `src/server/documents/email.ts`, `src/server/email/transport.ts` |
| Trigger: every go-live path | `approveShopTransaction` (`src/server/services/shops.ts`: admin / operator approval, automatic approval, instant GST/PAN approval) and `approveRegistration` (`src/server/registration/service.ts`: paid self-registration) |
| Download again (owner / operations; another owner 403, signed out 401) | `GET /api/shops/<id>/banner?lang=en|local&format=pdf|png`, buttons on **Seller Central → Marketing** (named "English" and "Marathi" / "Hindi") |
| Existing live shops: admin "Send welcome kit" (one shop, or bulk by city / district with a preview) | `src/server/shop-banner/admin-send.ts`, `GET/POST /api/admin/shops/welcome-kit`, page **Admin → Shops → Send welcome kit** (`/admin/shops/welcome-kit`), feature flag `shop_welcome_kit_admin_send_enabled` (off) |
| Tests | `tests/unit/shop-welcome-kit.test.ts`, `tests/integration/shop-welcome-kit.test.ts`, QA checks `tests/qa/{guest,signed-in,local}/sellers-welcome-kit.spec.ts` (cases TC-WKIT-001 … 013, journey SC-52 in `test-cases.xlsx`) |

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
   native speaker) and point it at the new font; run the script, then
   `node --import tsx scripts/shop-banner/set-tagline.ts`; look at
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
| Ribbon ("This shop is now live on", 26-Nov-2026; was "We are available on") | हे दुकान आता लाइव्ह आहे | यह दुकान अब लाइव है |
| Shop QR heading ("Order online / Scan this QR", 26-Nov) | ऑनलाइन ऑर्डर करा / हा QR स्कॅन करा | ऑनलाइन ऑर्डर करें / यह QR स्कैन करें |
| UPI panel ("Pay here (UPI) / Scan with any UPI app", 26-Nov) | येथे पैसे द्या (UPI) / कोणत्याही UPI ॲपने स्कॅन करा | यहाँ भुगतान करें (UPI) / किसी भी UPI ऐप से स्कैन करें |
| Owner line ("Owner: …", 26-Nov) | मालक: … | मालिक: … |
| Trusted & Secure | विश्वासार्ह व सुरक्षित | भरोसेमंद और सुरक्षित |
| Delivered with Care | काळजीपूर्वक डिलिव्हरी | सावधानी से डिलीवरी |
| Everything For Everyone, Everywhere | सर्वांसाठी सर्व काही, सर्वत्र | सबके लिए सब कुछ, हर जगह |
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
| test.gokesari.com (`gokesari-staging`) | the value above — **set 20-Nov-2026 16.45 IST** (owner's request), live from the next staging deploy | the preview APK then opens scanned QR codes |
| gokesari.com (`gokesari-prod`) | the value above — **set 20-Nov-2026 17.18 IST** (owner's decision), live from the next production deploy | that key is public: any sideloaded app named `com.gokesari.app` and signed with it could claim the links. Add the Play Store app-signing SHA-256 (comma-separated) when the app is on Play, and drop this one then |

**iOS:** no iPhone build is distributed yet (TestFlight on hold, PLT-017), so there is nothing
to open; set `MOBILE_IOS_APP_IDS` with the Team ID when it is.

## Known limits

- The template is 1536 × 1024 px: sharp up to about A5 / 13–15 cm wide; acceptable on A4.
  For large stickers or flex boards, replace `template.png` with a higher-resolution or
  vector export of the same layout (positions are fractions, no code change) and re-run the
  generator, then `set-tagline.ts`.
- The tagline under the logo was "Everything for Everyone." in the owner's design; on
  20-Nov-2026 it was changed on all three templates to the site's new tagline
  "Everything for Everyone, Everywhere" (`set-tagline.ts`, same orange, Poppins Bold).
- The third feature label (under the people icon) was "For Everyone, At Everywhere" in the
  owner's design; on 21-Nov-2026 the owner chose "Everything For Everyone, Everywhere"
  (Marathi "सर्वांसाठी सर्व काही, सर्वत्र", Hindi "सबके लिए सब कुछ, हर जगह"), written on all three
  templates by `scripts/shop-banner/set-everywhere-label.ts`.

## One e-mail for a new shop: the kit carries the signed agreements (26-Nov-2026)

Owner rule: a new shop gets **one** e-mail. With seller agreements on (`seller_agreements_enabled`, docs/seller-agreements-2026-11), the welcome kit attaches the shop's signed REGISTRATION agreements (certified PDFs, EN/MR/HI) and is CC'd to `sellerAgreements.ccEmails`; no separate "signed agreements" e-mail goes out.

- `onRegistrationFeePaid` / `afterSigning` (src/server/legal-agreements/email.ts → `deliverNewShopAgreements`): kit still to be sent (queued / retrying, or the shop not live yet) → the kit carries them; live shop with no kit row → the kit is queued now; kit already sent (the owner signed after go-live, e.g. staff registered the shop) → the signed copy is sent alone, **without** banners.
- The renderer (`renderShopWelcomeKit` → `agreementsForWelcomeKit`) attaches them at send time and writes the SIGNED_COPY row in `legal_agreement_emails`, so My Agreements' send log shows the kit's status. Over `sellerAgreements.maxEmailBytes` (after the banners) only the English PDFs are attached; the others become 30-day secure links.
- The banner update ("Resend updated banner") and existing shops' kits never carry agreements.
- A shop that pays but is never approved gets its signed copy with the go-live kit only; until then it is in My Agreements (and admins can "Resend signed copy").
- Tests: tests/integration/welcome-kit-one-mail.test.ts (TC-WKIT-039…042).
