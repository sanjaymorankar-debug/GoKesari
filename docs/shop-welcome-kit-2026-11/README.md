# Shop welcome kit: printable banner with QR code (owner request, 20-Nov-2026)

**Status: draft PR — not yet on test.gokesari.com or gokesari.com.**

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

## What was built

| Piece | File |
|---|---|
| Banner renderer (template + shop name + QR of `/shops/<slug>`, PNG / JPEG / A4 PDF) | `src/server/shop-banner/render.ts` |
| Templates: English (owner's design, placeholders cleared), Marathi, Hindi | `src/server/shop-banner/assets/template*.png` |
| Generator for the Marathi / Hindi templates (re-run after changing the English one) | `scripts/shop-banner/make-local-templates.py` |
| Font (Latin + Devanagari), SIL OFL 1.1 | `src/server/shop-banner/assets/Poppins-Bold.ttf`, `OFL.txt` |
| One-page PDF holding a JPEG | `src/lib/image-pdf.ts` |
| Welcome e-mail (text + HTML with both banners inline, 2 PDFs attached) | `src/server/shop-banner/welcome-kit.ts` |
| Outbox type `SHOP_WELCOME_KIT` (+ optional HTML body; inline images via Content-ID) | `src/server/documents/email.ts`, `src/server/email/transport.ts` |
| Trigger: every go-live path | `approveShopTransaction` (`src/server/services/shops.ts`: admin / operator approval, automatic approval, instant GST/PAN approval) and `approveRegistration` (`src/server/registration/service.ts`: paid self-registration) |
| Download again (owner / operations) | `GET /api/shops/<id>/banner?lang=en|local&format=pdf|png`, buttons on **Seller Central → Marketing** |
| Tests | `tests/unit/shop-welcome-kit.test.ts`, `tests/integration/shop-welcome-kit.test.ts` |

## How it behaves

- **When:** queued in the same database transaction that makes the shop `APPROVED`, sent
  right after commit by the document-email outbox; a failed send is retried with backoff
  (the every-minute cron is the safety net). No SMTP, or the owner has only a placeholder
  e-mail → `SKIPPED` (the owner can still download from Marketing).
- **Once per shop, ever** (unique `doc_type + doc_id + user_id`): a shop suspended and
  approved again is not welcomed twice. Queuing runs in a savepoint and never blocks an
  approval.
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
  their banners from Marketing; a one-off back-fill needs the owner's OK.

## Known limits

- The template is 1536 × 1024 px: sharp up to about A5 / 13–15 cm wide; acceptable on A4.
  For large stickers or flex boards, replace `template.png` with a higher-resolution or
  vector export of the same layout (positions are fractions, no code change) and re-run the
  generator.
- The design's own text "For Everyone, At Everywhere" is kept as in the owner's design
  (suggested wording: "For Everyone, Everywhere").
