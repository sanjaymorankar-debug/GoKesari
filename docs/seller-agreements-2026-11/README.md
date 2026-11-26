# Seller agreements: personalised, OTP-signed SLA (26-Nov-2026)

Owner brief of 26-Nov-2026, 09.40 IST. Shop owners sign a **personalised** copy of the
**Seller Service Level Agreement** (every shop) and, for medical shops, the **Merchant Onboarding &
Authorisation Agreement – Medical Shop**. The copy is built from the shop's own registration data and every
licence on file. It is shown and signed in English, मराठी and हिंदी, using a typed name, a designation and an
SMS code. The signed PDFs and an acceptance certificate are stored, can be verified by hash, and are e-mailed
to the owner with a copy to ceo@agtci.com.

**Switched off by default:** feature flag `seller_agreements_enabled` (Admin → Feature flags). Per the
standing owner rule, production stays off until the owner says otherwise.

## Owner decisions (26-Nov-2026, about 10.00 IST)

| Question | Decision |
|---|---|
| The brief ends at "Retry" (section 7) | Nothing more. Failed e-mails are retried after 5 min, 30 min and 2 h, then admins are alerted. |
| Medical agreement clause 13 (non-judicial stamp paper) vs OTP e-signing | Keep the text. The admin must confirm a lawyer reviewed it before publishing, and must set who bears the stamp duty. |
| Payment step already has Seller Terms + undertaking ticks | The new Agreements step replaces the Seller Terms tick. The goods-undertaking tick stays. |
| Platform signatory | Sonali Sanjay Morankar, Director (admin-editable). The e-seal image is uploaded by the admin. |
| PDF engine | A Chromium bundled as an npm package (`@sparticuz/chromium`, driven by `puppeteer-core`). Nothing is installed with apt on gk-db-1. |
| 2 % (SLA) vs 3 % (medical) commission | Never picked by the system: a blocking warning on publishing (see "Publishing checks"). **Owner decided 26-Nov-2026, 11.10 IST: option A, 2 % platform commission for every shop, medical shops included.** The medical agreement v1.0 now states 2 % (`sourceValues.commissionPct`), so the two documents agree. Admin → Finance must hold a 2 % default and no different rate for the PHARMACY shop type; otherwise publishing shows a warning. |

Not as written in the brief:
- **Database:** the brief says "Neon, seller DB". Since 17-Nov both sites use one database on gk-db-1. This feature adds ordinary tables to it (migration 0212).
- **Column names:** the brief names `created_at_ist` / `accepted_at_ist`. The columns are `timestamptz`, which store an absolute instant. Every screen, PDF, CSV and e-mail shows them in IST. This is the project's existing convention.

## Pieces

| Piece | Where |
|---|---|
| Migration (tables, immutability triggers, flag) | `drizzle/0212_seller_agreements.sql`, rollback `scripts/rollback-0212.sql` |
| Schema | `src/server/db/legal-agreements-schema.ts` |
| Templates v1.0 (EN master; MR / HI drafts pending legal review) | `src/server/legal-agreements/templates/{seller-sla,medical-onboarding}/v1.0.{en,mr,hi}.html` |
| Translation review notes for the lawyer | [TRANSLATION_REVIEW.md](TRANSLATION_REVIEW.md) |
| Template language (strict merge fields) | `src/server/legal-agreements/template-engine.ts` |
| Shop data snapshot | `snapshot.ts` (database) and `data.ts` (pure) |
| Tables built in code (Annexure A, Schedule of Licences, signature blocks, certificate) | `partials.ts`, `render.ts`, `i18n.ts` |
| PDF printing (letterhead, watermark, page numbers, Noto Sans + Noto Sans Devanagari embedded) | `pdf/browser.ts`, `pdf/html-to-pdf.ts`, `assets/` |
| Registry: versions, publishing checks, publish / retire, change notice | `registry.ts`, `notices.ts` |
| What a shop must sign; grace period; order gate; licence blockers | `requirements.ts` |
| Preview, OTP, signing, owner links | `signing.ts` |
| Signed-copy e-mail, SMS / WhatsApp notice, download links | `email.ts` |
| Admin views: acceptance record, CSV, pending, e-seal, verification | `admin.ts` |
| Settings | rule `sellerAgreements` (Admin → Settings) |

### Screens

- **Registration wizard:** a new step, AGREEMENTS, comes after DOCUMENTS and before PAYMENT. With the flag on, the Payment step drops the Seller Terms tick.
- **Seller Central → Legal docs → My Agreements** (`/shop/agreements`): sign, download the signed PDFs, verify.
- **Blocking screen** in Seller Central for existing shops. It can be postponed for the day during the grace period, but not after it.
- **Owner signing link** (`/agreements/sign/<token>`): used when staff or a dealer registered the shop.
- **Public verification** (`/agreements/verify/<code>`): the PDF is hashed in the browser and only the hash is sent.
- **Admin → Shops → More → Seller agreements** (`/admin/agreements`). Tabs:
  - **Templates:** upload, edit a draft, publishing checks, sample-shop preview (HTML / PDF) in each language, legal-review confirmation, publish, retire.
  - **Acceptances:** filter by shop, document, version and IST dates; open the PDFs; CSV export; e-mail log; resend the signed copy.
  - **Pending shops**
  - **Settings:** the e-seal.

## Templates and merge fields

A template is HTML with the following tags:

- `{{field.path}}`: a value, HTML-escaped.
- `{{#if field}} … {{else}} … {{/if}}`: optional text.
- `{{> block}}`: a table or block built in code, worded for the template's language.

The engine is strict. A field that is missing or empty is never printed as "null" or left blank. It is
reported instead, and that document cannot be published, previewed or signed.

Fields:
- `seller.legalName`, `seller.tradeName`, `seller.tradeNameDiffers`, `seller.constitution`, `seller.address`, `seller.pincode`, `seller.sellerId`, `seller.shopTypes`
- `owner.name`, `owner.designation`, `owner.mobileMasked`, `owner.email`
- `agreement.effectiveDateLong` (the date of acceptance), `agreement.place` (Pune)
- `fees.registrationFee`, `fees.medicalRegistrationFee`, `fees.wholesaleRegistrationFee`, `fees.commissionPct`, `fees.settlementDays`, `fees.acceptMinutes`, `fees.walletMinimum`, `fees.medicineShelfLifeMonths`, `fees.perOrderCommission`, `fees.billingManagementFee`
- `sla.lateReadyCharge`, `sla.sellerCancelCharge`, `sla.lateThenCancelCharge`, `sla.defectCharge`, `sla.medicineBreachCharge`
- `platform.signatoryName`, `platform.signatoryDesignation`, `platform.boardResolutionDate`, `platform.stampDutyBorneBy`

Blocks:
- `signatures`
- `seller_details` (Annexure A)
- `licence_schedule` ("Schedule of Licences held by the Seller")
- `medical_particulars`
- `declaration_signature`

### Where the figures come from

Fees, commission, settlement days and penalties are read from configuration, not from the template text:

| Figure | Source |
|---|---|
| Registration fee | Admin → Finance (the active flat fee) |
| Commission | Admin → Finance (shop, then shop type, then default) |
| Settlement days | `settlement.holdDays` |
| Accept minutes | `shopAcceptance.acceptMinutes` |
| Wallet minimum | `shopWallet.minBalancePaise` |
| Wholesale fee, medicine shelf life, per-order commission, billing management fee, SLA charges (₹15 / ₹30 / ₹45 / ₹30 / ₹500 by default) | rule `sellerAgreements` |

### The shop data

- **Licence schedule:** built from every licence the shop holds:
  - `shop_legal_documents` rows that are submitted or approved: drug licence (retail Form 20/21, or wholesale 20B/21B when the number says so), FSSAI, medical registration, trade licence, legal metrology, fire NOC, agri-input, other;
  - GSTIN, PAN, Shop Act, Udyam;
  - the registered pharmacist.
- Rows the shop does not have are left out. Columns with nothing to show are left out as well.
- PAN and GSTIN are printed in full. The mobile is masked. Only the last 4 digits of the bank account are shown.
- On the signing screen the signer chooses the business type (constitution) and designation, and types their name. A medical shop without a pharmacy profile also names its registered pharmacist there.

## Publishing checks (Admin → Agreements → open a version)

**Blocking:**
- unsafe HTML;
- template syntax errors;
- unknown fields;
- a field that would be empty with the live configuration, such as the stamp duty setting;
- an unconfirmed legal-review note, such as the medical stamp-duty clause;
- a translation not marked reviewed, or whose English version is not yet published, or whose merge fields differ from English;
- a new version whose effective date is less than `sellerAgreements.noticeDays` (30) after publishing;
- **the commission clash.** Each English version records the figures its text states ("stated figures", for example SLA 2 %, medical 3 %). Two documents a shop can sign together that state different commission block each other until the admin decides. The admin sets the same figure in both drafts and in Admin → Finance. The system never chooses.

**Warnings** (must be acknowledged):
- the configured commission, settlement days, fees or SLA charges differ from the figures the document states (agreements always print the configured value);
- no e-seal uploaded.

Publishing an English version that replaces an earlier one sends the change notice (e-mail and app, in three
languages) to the owners of the shops it applies to. This happens only while the flag is on. Owners are then
asked to accept it after the effective date.

## Signing

1. The Agreements screen shows each document personalised for the shop, in the published languages, with Download PDF. Every tick box starts unticked:
   - one tick box per document, enabled only after that document has been scrolled to the end ("I have read and accept the … (v1.0) prepared for <Shop>");
   - one tick box for the Seller Terms, Terms of Use and Privacy Policy;
   - an optional tick box to record the location.
2. Signing is refused while a licence the shop type requires is missing, rejected or expired. The screen lists what to upload first.
3. **Send code:** an SMS code (purpose `LEGAL_ESIGN`) goes to the owner's verified mobile, or else the mobile the shop was registered with.
4. **Sign and accept:** once the code is known to be right, and before it is used up (so a failure leaves it valid):
   1. The shop data is frozen in a snapshot (JSON, with its SHA-256).
   2. Every published language of every document is printed from that one snapshot. The seller's signature block reads "Digitally signed and accepted via OTP", with the name and the IST time. The Platform block carries the signatory and the e-seal.
   3. Each PDF's SHA-256 is recorded.
   4. An **Electronic Acceptance Certificate** page is appended to each copy. It lists:
      - signer, designation, masked mobile;
      - IST time, IP, platform;
      - OTP reference;
      - version and licence-schedule time;
      - snapshot hash and the hash of every language PDF;
      - the verify link.
5. One transaction then stores the snapshot, the signing request, one **immutable** `legal_acceptances` row per document, the signed files (encrypted) and the Seller Terms consent. The Terms, Privacy and Seller Terms policy acceptances are recorded as well.
6. The SMS / WhatsApp / push notice with the My Agreements link is sent at once. The e-mail goes:
   - at once, for existing shops;
   - when the registration fee is captured, for new shops (with the welcome banners in EN / MR / HI).

**Staff and dealers never sign.** Staff with SHOP_REGISTRATION_MANAGE, or the dealer who registered the shop,
press "Send signing link to the owner". The owner receives an SMS, WhatsApp and e-mail link that is valid for
`linkExpiryDays` (7). They review their own documents and sign with their own OTP. Until then the shop is
"Pending owner acceptance": a new shop cannot pay, and so gets no orders.

### Existing shops and changes

- **Grace period.** The first time an existing shop is found unsigned (Seller Central blocking screen or the daily sweep), it gets `graceDays` (7). After that it can't accept new orders until it signs. The check is in `updateOrderStatus`, CONFIRMED → ACCEPTED / PREPARING. Orders already accepted carry on. The owner is reminded 2 days before the end.
- **Re-confirmation (Annexure A).** A licence added, renewed or changed, or a change to the shop's name, address or owner account, changes the Annexure fingerprint. The owner re-confirms with an OTP, a new version is stored, and the e-mail is sent again. A licence merely approved by the team does not count.
- **Licence expiry** still pauses listings through the existing rules (`legalDocuments`).

## E-mail

- **To:** the owner. **CC:** `sellerAgreements.ccEmails` (ceo@agtci.com). On the test site, `EMAIL_REDIRECT_TO` redirects it and drops the CC; the note names both addresses.
- **Subject:** `<Shop> – your signed gokesari.com agreements | आपले स्वाक्षरी केलेले करार | आपके हस्ताक्षरित अनुबंध`.
- **Body** in English, मराठी and हिंदी:
  - congratulations (new shop) or confirmation;
  - the IST signing time;
  - the documents and versions signed;
  - the licences included;
  - the dashboard link and support on +91 91751 93009.
- **Attachments:** the certified PDFs of every document and language (compressed), plus the banners for new shops.
  - If the total would exceed `maxEmailBytes` (10 MB, counted as sent), the English agreements and the banners stay attached. The rest become signed download links, valid for 30 days.
- **Send log:** every send has its status, attempts, sent time, SMTP Message-ID, CC and attachment list in `document_emails` + `legal_agreement_emails`. Admin → Agreements → Acceptances → E-mail log shows it.
  - Retries happen after 5 min, 30 min and 2 h. After that the row is DEAD and every admin is alerted.

## Data model (0212)

**Tables:**
- `legal_documents`: one row per document type, language and version, with status and review state.
- `legal_document_snapshots`
- `legal_signing_requests`
- `legal_acceptances`: as in brief §6, plus certified-copy hashes, template hash and verify code.
- `legal_signed_files`
- `legal_shop_agreement_states`
- `legal_agreement_emails`
- `legal_platform_assets`

**Columns added to `document_emails`:** `message_id`, `cc_addresses`.

**Immutability:** `legal_acceptances`, `legal_signed_files` and `legal_document_snapshots` refuse UPDATE and
DELETE (trigger `legal_records_immutable`).

**Foreign keys:** none to shops or users. The evidence outlives a deleted shop or account.

## Running it on the server

- **Chromium:** `@sparticuz/chromium` unpacks its own Chromium and libraries to `/tmp` on first use. Nothing is installed on gk-db-1. It uses about 250 MB of memory while printing and closes after 1 minute idle.
- **Override:** `LEGAL_PDF_CHROMIUM_PATH` points at another Chromium if ever needed.
- **Check after deploy:** Admin → Agreements → any version → **Sample PDF**. If it downloads, Chromium works on that server.
- **Fonts:** Noto Sans and Noto Sans Devanagari (SIL OFL), bundled in `src/server/legal-agreements/assets/fonts`.

## Switching it on (staging first)

1. Admin → Agreements opens and imports the v1.0 drafts.
2. Settings (rule `sellerAgreements`): stamp duty borne by, signatory, e-seal, board resolution date if any.
3. Commission (decided: 2 % for every shop): check that Admin → Finance has a 2 % default and no other rate for PHARMACY.
4. Publish the SLA (EN). Confirm the stamp-duty review, then publish the medical agreement (EN). Once a lawyer has reviewed the MR / HI drafts, mark them reviewed and publish them.
5. Switch on `seller_agreements_enabled`. It can be limited to districts.

## Tests

- `tests/unit/seller-agreements.test.ts`:
  - template engine and unsafe HTML;
  - bundled templates fill completely in all six language versions, with no "null";
  - translations match English merge fields;
  - figures come from configuration;
  - Annexure fingerprint;
  - blocks and certificate.
- `tests/integration/seller-agreements.test.ts`, against PostgreSQL and a real Chromium:
  - TC-AGR-001: the bundled documents agree (2 %); a draft stating 3 % blocks;
  - TC-AGR-002: stamp duty review;
  - TC-AGR-003: translation review;
  - TC-AGR-010: flag off;
  - TC-AGR-011: licence blocker;
  - TC-AGR-012: full signing — hashes match the stored PDFs, Devanagari font embedded, immutable rows, e-mail with CC and Message-ID, re-confirmation after a licence change;
  - TC-AGR-013: grace period blocks new orders;
  - TC-AGR-014: owner link.
