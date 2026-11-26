# Seller agreements – test results, 26-Nov-2026

Branch `feat/seller-agreements-esign-2026-11-26`. Run on the owner's Mac against a local PostgreSQL 18 test
database (`gk_sla_test`, all migrations up to 0213) and Playwright's Chromium (macOS). Times are IST.

| Run (IST) | What | Result |
|---|---|---|
| 26-Nov-2026, 10.31 | `tests/unit/seller-agreements.test.ts` + `tests/integration/seller-agreements.test.ts` | 35 / 35 passed |
| 26-Nov-2026, 10.31–10.37 | Related existing suites (24 files): seller-undertaking, onboarding-wizard (1, 2), shop-registration-flow, shop-self-registration, shop-welcome-kit, email-mailbox (pool, rotation), email-redirect, email-brand, sms-two-factor, feature-flag-cache, notifications-wiring, policy-reconsent (unit, integration), orders-fulfilment-route, registration-fee (×4), shop-registration-subscription (unit, integration), fulfilment-options | 315 / 315 passed |
| 26-Nov-2026, 10.38 | Agreements + registration subscription again, after the payment-link guards | 68 / 68 passed |
| 26-Nov-2026, 10.38 | `npm run typecheck` | 0 errors |
| 26-Nov-2026, 10.35 | `eslint` on every changed file | 0 problems |

## Test cases

| ID | Case | Result |
|---|---|---|
| TC-AGR-001 | The SLA 2 % / medical 3 % commission clash blocks publishing; nothing is chosen automatically | Pass |
| TC-AGR-002 | Medical agreement: the stamp-duty clause needs a lawyer's confirmation, and the stamp-duty setting must be filled | Pass |
| TC-AGR-003 | A Marathi translation waits for its legal review and for the English version | Pass |
| TC-AGR-010 | Flag off: no shop is asked, no order is blocked | Pass |
| TC-AGR-011 | A pharmacy without its drug licence cannot sign (the licence is listed as the blocker) | Pass |
| TC-AGR-012 | Existing pharmacy, end to end — see below | Pass |
| TC-AGR-013 | After the grace period the shop cannot accept new orders | Pass |
| TC-AGR-014 | Staff send the owner a link; the newest link works, the older one is cancelled; the owner cannot send one to themself | Pass |
| Unit (30) | Template engine (escaping, strict fields, syntax, unsafe HTML); all 6 bundled templates fill with no "null"; translations carry the English merge fields and the "English prevails" line; figures come from configuration; IST dates; Annexure fingerprint; blocks; certificate | Pass |

TC-AGR-012, existing pharmacy end to end:
- 7-day grace period starts;
- an SMS code goes to the registered mobile; a wrong code is refused;
- signing prints SLA (EN + MR) and the medical agreement (EN);
- each stored PDF's SHA-256 equals the hash recorded in `legal_acceptances`;
- Noto Sans Devanagari is embedded in the Marathi PDF;
- the platform is recorded as "android" (app user agent);
- UPDATE and DELETE on the record are refused (immutable);
- the requirement is satisfied and orders are allowed;
- the e-mail goes with CC ceo@agtci.com, the trilingual subject, 3 PDFs and a Message-ID logged;
- adding a licence afterwards asks for re-confirmation (ANNEXURE_UPDATE).

## Visual checks (PDF pages rendered to images and inspected)

- Seller SLA in English, signed: letterhead (AGT logo, contact strip), watermark, wave footer, "Page X of Y"; Annexure A and the Schedule of Licences, with rows only for licences held.
- Medical agreement in Hindi, page 1: Devanagari conjuncts and matras correct (प्राधिकृत, स्वामित्व, उत्तराधिकारी); merge fields filled.
- Seller SLA in Marathi, signed: signature block "OTP द्वारे डिजिटल स्वाक्षरी करून स्वीकारले" with the name and IST time; Electronic Acceptance Certificate page in Marathi with all language hashes and the verify link.

## Not yet tested

- **Bundled Chromium on Linux:** `@sparticuz/chromium` has not run on Linux yet. CI (Ubuntu) runs TC-AGR-012 and fails if Chromium cannot start there. After the staging deploy: Admin → Agreements → Sample PDF.
- **Screens in a browser:** the signing screen, Seller Central gate, admin page and verify page were type-checked and linted but not clicked through here (no local app environment). To check on test.gokesari.com after the staging deploy.
- **Real SMS and real e-mail delivery:** tests use the mock SMS provider and a captured transport. Staging uses SMS mock and EMAIL_REDIRECT_TO.
