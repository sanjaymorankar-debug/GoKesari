# Seller verification follow-ups — owner decisions, 29 Oct 2026

Four points from the PAN / GST / Udyam review of 29 Oct, as decided by the owner.

## 1. Two GST/PAN systems → one source

**Before:** two systems recorded the same documents.
- The older GST/PAN form and the admin GST/PAN queue (`services/gst-pan-verification.ts`)
  wrote to the shop row (`shops.gst_status`, `pan_status`, …).
- The verification page, the onboarding wizard and the reviewers' queue
  (`services/seller-verification.ts`) wrote to `seller_verifications`.

Instant approval, the documents follow-up (1st / 15th reminders, suspension) and the KYC stage
read only `seller_verifications`. Invoices and the shop profile read only the shop row. The impact:
- A PAN or GSTIN approved on the older queue counted as missing: the shop was reminded and could
  be suspended, and it was not approved instantly.
- A PAN verified on the verification page still showed "Not verified" on the shop's GST/PAN card.
- A verified Udyam or Shop Act was never copied onto the shop.

**Now:** `seller_verifications` is the source.
- **Copied onto the shop once verified:**
  - GSTIN → `shops.gstin`, `gst_status` (as before)
  - FSSAI → `fssai_license_number` (as before)
  - **PAN** → `pan_status`, `pan_number_encrypted`, `pan_last4`, `pan_hash` (new)
  - **Udyam** → `udyam_number` (new)
  - **Shop Act** → `shop_act_number` / `shop_act_key` (new; never over another live shop's licence)
- **Older queue:** a decision there (verify / reject GSTIN or PAN) is also recorded as a reviewer's
  decision in `seller_verifications` (`recordLegacyGstPanDecision`).
  - That form never asked for verification consent, so the record keeps only the masked number
    (and, for a GSTIN, the blind index of its PAN). No re-check can send the number to a source.
- **Shop profile:** Shop → Settings → GST / PAN now also shows the Udyam number and the Shop Act
  licence on file.

## 2. Duplicates across shops

| Number | Rule | Why |
|---|---|---|
| PAN | May be on several shops | One owner, several shops (allowed by law) |
| GSTIN | One business. Another owner's account is refused; the same owner may use it for another branch | GST: one registration per PAN per state, and every place of business in that state can be added to it as an additional place of business |
| Shop Act | One establishment, one shop, whoever owns it | A Shop Act registration covers one establishment / premises |
| Udyam | May be on several shops | One enterprise, several units |

**Where the GSTIN and Shop Act rules apply:**
- **At submission:**
  - the verification page;
  - the older GST form;
  - the wizard's GSTIN step. The wizard used to refuse every GSTIN already on a live shop,
    including the same owner's; it now refuses only another owner's.
- **At the check:** a number another shop took meanwhile goes to a reviewer (`gstin_other_owner`,
  `shop_act_other_shop`) instead of verifying.

A number counts as used once it is on a live shop (not deleted, not rejected), or is verified or
being checked for one.

Sources (secondary; check against the CGST Act s.25 and the state's Shops & Establishments Act):
[taxscan](https://www.taxscan.in/top-stories/one-gst-number-for-multiple-businesses-rules-benefits-and-compliance-1448297),
[mondaq](https://www.mondaq.com/india/tax-authorities/1616602/gst-registration-for-branches-in-multiple-states),
[taxguru](https://taxguru.in/?p=665248),
[greytHR — Maharashtra S&E Act](https://www.greythr.com/wiki/acts/maharashtra-shops-commercial-establishments-act/).
A Maharashtra Labour Department circular of 30 Apr 2026 (reported, not verified) says
establishments with 10+ employees register under the OSH Code instead. That doesn't change the
one-licence-one-shop rule for shops that do hold a Shop Act licence.

## 3. Udyam on the shop profile

`shops.udyam_number` (format `UDYAM-XX-00-0000000`), filled when the Udyam check verifies.
It shows on Shop → Settings → GST / PAN, next to the Shop Act licence.

## 4. Shops approved without their documents

Rule `shopDocumentFollowUp`, new setting **`graceDays` = 90**.
- **A shop approved with a waiver, or on the documents promise:**
  - has 3 months, from its latest waiver or from its approval;
  - is reminded on every reminder day until then (1st and 15th, so every 15 days), however many
    reminders that is;
  - is suspended at the first run after the 3 months.
  - A new waiver gives 3 more months.
- **The promise:** now reads "within 90 days" (`promiseDays` 30 → 90).
- **Other live shops missing documents:** unchanged. 3 reminders, then suspended.

Tests: `tests/integration/verification-followups.test.ts` (9) and
`tests/integration/shop-document-follow-up.test.ts` (3 new; the old promise case rewritten).
