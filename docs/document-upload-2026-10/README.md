# Shop documents: upload, auto-read, review (Tasks 2, 3 and 6)

Status, 13 Oct 2026: built and tested. Ships **on** (rule `documentUpload`).

## What the shop owner does

1. **Registration → "Upload your documents"** (`/shop/documents`). New shops
   land here straight after `/shop/register`; self-registered shops reach it
   from *Complete your profile*; it is also in Seller Central's menu
   (*Upload documents*).
2. One card per document the shop needs: PAN, GSTIN (or the "not
   GST-registered" declaration on the Verification page), Shop Act, **FSSAI
   for food shops**, drug licence / medical registration where the
   legal-documents rule asks for them, Udyam optional.
3. For each: **Upload file** (PDF, JPEG, PNG, WebP) or **Take photo** —
   - phone browser and the Android/iPhone app: opens the phone's camera;
   - computer: opens the webcam inside the page, with *Capture*, and a
     "choose a photo instead" fallback if the camera is blocked.
   Large phone photos are shrunk in the browser (long side 2400 px) before
   upload.
4. The server reads the document and returns the fields **pre-filled**:
   number, name, address, valid from, valid until (plus issuing council for a
   medical registration). The owner checks them, corrects anything misread,
   ticks the consent for this check, and clicks **Verify & Approve**.
5. Problems are flagged on the card:

   | Flag | When | Effect |
   |---|---|---|
   | UNREADABLE | too little text, or a low-confidence read with no number | **Re-upload required** (Verify is hidden) |
   | WRONG_DOCUMENT | the wording is another document's (e.g. a PAN card in the FSSAI slot) and the expected number isn't on it | **Re-upload required** |
   | EXPIRED | valid-until is before today | **Refused** — upload the renewed document (a misread date can be corrected; the correction is recorded for the admin) |
   | NAME_MISMATCH | the name scores below `nameMatchWarnBelow` (70) against the owner / legal / shop / GST trade name | warning, recorded; the vendor check and admin review decide |
   | NUMBER_NOT_FOUND / NUMBER_INVALID | number missing or fails the document's own format rule (PAN pattern, GSTIN checksum, 14-digit FSSAI, Udyam pattern) | the owner types / fixes it; the server re-checks |
   | NO_EXPIRY | FSSAI or drug licence without a readable expiry | the owner must enter it (required) |
| NOT_READ | the reader was unavailable or took longer than `DOCUMENT_OCR_TIMEOUT_MS` | warning; the owner types the details; the server checks them as usual |
   | EXPIRING_SOON | expires within `sellerVerification.expiryWarningDays` (30) | warning |
   | LOW_QUALITY | picture smaller than 600 px | warning |
   | AADHAAR_HIDDEN | an Aadhaar number was on the page | it is dropped before parsing and never stored (Aadhaar Act s.29) |

6. **Verify & Approve** hands the document to the existing flows — nothing
   about how documents are decided changed:
   - PAN, GSTIN, Udyam, Shop Act, FSSAI → **seller verification** (vendor
     check through Gridlines / the mock on test, consistency score, admin
     review queue);
   - FSSAI, drug licence, medical registration → **legal-documents register**
     (submitted with expiry; operations approve or reject).
   The uploaded file moves to that flow's encrypted file table, where admins
   and operators already open it.

## Reading the document (OCR)

`src/server/kyc/document-reader.ts`:

| Engine | Used for | Notes |
|---|---|---|
| `pdf-text` | PDFs with a text layer (most e-certificates: GST REG-06, Udyam, FoSCoS FSSAI) | exact and instant (`unpdf`) |
| `tesseract` | photos and scanned images — **the default** | runs on our server (`tesseract.js` + the English model shipped in `node_modules/@tesseract.js-data/eng`); no outside service, no key, nothing leaves the server. Photos are auto-rotated, greyscaled, normalised and resized first (`sharp`). ~1 s per page; one worker per server, freed after a minute idle |
| `claude` | optional, better on poor photos and scanned PDFs | only with `DOCUMENT_OCR_PROVIDER=claude` and `ANTHROPIC_API_KEY`. **Sends the document to Anthropic** — turn on only after deciding that is acceptable for KYC data (DPA / privacy notice). Falls back to tesseract on any error |

A scanned PDF (no text layer) with the default engine is flagged UNREADABLE
with "take a photo instead".

**If the reader is slow or unavailable** on a server (it has
`DOCUMENT_OCR_TIMEOUT_MS`, default 25 s, to finish), the upload still
succeeds: the card shows NOT_READ — "type the details exactly as printed" —
with empty fields, nothing blocked, and the server checks what is typed as
usual. A hung OCR worker is dropped so the next upload starts a fresh one.

**Health check:** `GET /api/admin/document-reader` (admins/operators with
document-review rights) reads a small generated image on that server and
reports each stage — load image library, render, find the language model,
load the OCR engine, start the worker, recognise — with its time, or the
stage that failed.

Field extraction is pure and unit-tested: `src/lib/kyc/document-extract.ts`
(type detection by wording, number patterns with OCR letter/digit fixes —
`O→0`, `I→1`, `S→5`, `B→8` in digit positions and the reverse — and GSTIN
checksum, labelled names and addresses, Indian date formats, validity ranges).

## Task 3 — FSSAI mandatory for food shops

A shop **sells food** when its type is a food type (grocery/kirana,
supermarket, convenience store, fruits & vegetables, dairy, bakery, meat,
sweets, poultry, restaurant, fast food, café …: `FOOD_SHOP_TYPE_KEYS`) or it
carries any food-aisle category — the same rule seller verification already
uses.

With `documentUpload.fssaiMandatoryForFood` on (default), a food shop
**cannot complete registration** without an FSSAI licence on file that has
not expired:

- **Admin approval** (`/shop/register` path): `approveShop` refuses with
  "A shop that sells food needs a valid FSSAI licence…"
  (`assertFssaiAllowsApproval`, after the existing document and fee gates).
- **Self-registration** (`/shop/join` path, approved on payment): the profile
  stays incomplete ("FSSAI licence" in *Still needed*) until it is on file.
- **Expired licences are blocked** at upload (EXPIRED flag), at submit
  (server re-check), and an expired licence on file doesn't count.

"On file" = the seller-verification FSSAI is verified / being checked /
under review, or the legal-documents FSSAI is submitted / approved — with an
expiry date today or later. Switch the rule off to go back to the earlier
"remind only" behaviour. Shops already approved are not re-checked by this
gate (nothing is revoked retroactively); the existing daily job still
suspends a live shop whose mandatory FSSAI lapses.

## Storage and access

- Table `seller_document_uploads` (migration 0075, seller-owned in the
  database split; rollback `scripts/rollback-0075.sql`).
- The file is AES-GCM encrypted (`PAN_ENCRYPTION_KEY`, same as PAN/KYC). The
  read fields and the confirmed fields are stored **encrypted** too; `flags`
  hold only codes and messages. The audit log records flag codes, never a
  number, name or address.
- After *Verify & Approve* the file moves to `seller_verification_files` /
  `shop_legal_document_files` and is removed from the upload row.
- Uploads never submitted are erased after `draftRetentionDays` (7) by the
  daily `POST /api/cron/seller-verification`.
- **Admins and operators** (`SHOP_GST_PAN_VERIFY`): `/admin/document-uploads`
  shows each upload — read vs confirmed fields side by side, fields the
  owner changed highlighted, flags, and the file. Decisions stay on
  *Seller verification* and *Legal documents*. Every file view by someone
  other than the owner is audited.

## Settings (`documentUpload` rule, Admin → Settings)

| Key | Default | |
|---|---|---|
| `enabled` | true | the upload screen |
| `fssaiMandatoryForFood` | true | Task 3 gate |
| `nameMatchWarnBelow` | 70 | name-mismatch flag threshold |
| `maxUploadBytes` | 10 MB | per file |
| `maxUploadsPerShopPerHour` | 30 | reads per shop |
| `draftRetentionDays` | 7 | erase unsubmitted uploads |

Env: `DOCUMENT_OCR_PROVIDER` (`tesseract` default, `claude`, `off`),
`DOCUMENT_OCR_TIMEOUT_MS` (25000),
`DOCUMENT_OCR_LANG_PATH` (override the bundled model path),
`DOCUMENT_OCR_CLAUDE_MODEL`, `ANTHROPIC_API_KEY` (only for `claude`).

## Task 6 — Android and iPhone apps

The apps show the website in a WebView (`mobile/`), so **every change in this
release reaches both apps as soon as the website is deployed — no app update
and no store release**:

- logo, tagline and footer: website pages;
- document upload: the file input opens the system picker; *Take photo*
  uses `capture="environment"`, which the Android WebView file chooser and
  iOS WKWebView hand to the phone's camera app. The iOS build already
  declares `NSCameraUsageDescription` / `NSPhotoLibraryUsageDescription`;
  Android needs no camera permission for the camera-app hand-off
  (`mobile/app.config.ts`).

**Nothing in this release needs a new native binary.** Expo over-the-air
updates are not set up (`expo-updates` is not installed) and are not needed
while the app's UI is the website. A store build would only become necessary
for an in-app camera screen (live `getUserMedia` inside the WebView, which
would need `android.permission.CAMERA` and WebView media-capture settings) —
not used here.

## Tests

- `tests/unit/document-extract.test.ts` — 21 cases: FSSAI, PAN (with OCR
  misreads and split tokens), GSTIN (checksum), Udyam, Shop Act Form G, date
  formats, validity ranges, Aadhaar never extracted, every flag, server-side
  validation.
- `tests/integration/document-uploads.test.ts` — 14 cases on real
  PostgreSQL: read → review → Verify & Approve into both flows, encrypted
  storage, double-click safety, corrections recorded, admin view and access
  control, expired / unreadable / wrong-name / wrong-file handling, the FSSAI
  gate on approval and on profile completion, non-food shops unaffected, the
  rule switch, and the **real** local OCR engine on a rendered licence image
  and the PDF text reader.
