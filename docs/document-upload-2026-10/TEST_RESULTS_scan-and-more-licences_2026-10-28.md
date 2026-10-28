# Test results — Scan a document, and more licences (28 Oct 2026)

Feature: docs/document-upload-2026-10/README.md, "Scan a document, and more licences".
Run on the owner's Mac, local PostgreSQL. Not yet run on test.gokesari.com.

## Automated

| Suite | Layout | Result |
|---|---|---|
| `tests/unit/document-extract.test.ts` (22 existing + 14 new) | — | 36 / 36 passed |
| `tests/integration/more-licences.test.ts` (new) | one database | 8 / 8 passed |
| same | two-database split (`test-layout.ts`, `DB_SPLIT_MODE=split`) | 8 / 8 passed |
| `document-uploads`, `legal-documents` (existing) | one database | passed |
| `document-uploads`, `legal-documents`, `db-split-ownership` | two-database split | passed (46 / 46 with the new file) |
| `split-migrate`, `migrate-on-build`, `migration-journal` | one database | passed |
| All unit tests | — | 865 / 867 — the 2 failures (`pmd-sources`, `product-import-parser`, xlsx fixtures) fail the same way without this change |

New cases:

| # | Case | Result |
|---|---|---|
| 1 | Detect trade / health / eating-house licence, legal metrology, fire NOC, seeds / fertiliser / pesticide licence from their wording | Pass |
| 2 | The heading nearest the top wins (trade licence quoting an FSSAI number; FSSAI quoting a trade licence) | Pass |
| 3 | PAN, FSSAI, Shop Act still detected | Pass |
| 4 | No wording: falls back to GSTIN (checksum), Udyam, PAN number; nothing found → none | Pass |
| 5 | Number, name, expiry read off a trade licence and a fire NOC | Pass |
| 6 | Optional licences need no expiry; an expired one is refused | Pass |
| 7 | Other licence name checked and keyed by name | Pass |
| 8 | Scan → trade licence filed under Trade licence, shown on its card (optional, More licences) | Pass |
| 9 | Scan → PAN card filed under PAN | Pass |
| 10 | Scan of an unrecognised document stores nothing and says to use the card | Pass |
| 11 | Scan of a drug licence at a non-pharmacy gives it an optional card | Pass |
| 12 | Trade licence submitted → register SUBMITTED, in the review queue; rejecting it never restricts the shop | Pass |
| 13 | Several named Other licences side by side; the same name replaces its copy | Pass |
| 14 | Other licence without a name refused; upload released for a retry | Pass |
| 15 | `otherRequirements` makes a trade licence mandatory for a shop type: approval blocked until submitted | Pass |
| 16 | Migration 0112 applies, and `rollback-0112.sql` restores the old unique key | Pass |

## In the browser (local dev server, demo shop "Kesari Dairy Farm")

| # | Step | Result |
|---|---|---|
| B1 | `/shop/documents` shows "Scan a document" above the cards | Pass |
| B2 | A picture of a Pune Municipal Corporation trade licence given to Scan → read in the browser (engine `browser-tesseract`) → "This is your Trade licence (municipal)." | Pass |
| B3 | "More licences" opens; the Trade licence card shows number PMC/TL/2026/012345, name, address, valid up to 31/03/2027, no flags, "Issued by" field | Pass |
| B4 | Issued by + consent + Verify & Approve → card "Submitted · valid until 2027-03-31"; database: `shop_legal_documents` TRADE_LICENCE SUBMITTED, authority and expiry stored; upload CONFIRMED, no fields corrected | Pass |
| B5 | Phone width (375 px): no sideways scrolling, Scan card fits | Pass |

Not tested here: a real phone camera photo of a paper licence, and test.gokesari.com.
