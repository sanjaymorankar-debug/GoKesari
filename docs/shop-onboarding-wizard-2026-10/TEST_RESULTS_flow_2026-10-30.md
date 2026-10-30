# Test results — shop registration flow (owner brief, 30 Oct 2026)

Branch `feat/shop-registration-flow` (from `staging` at db40213b), local run on 30 Oct 2026.
Design: [FLOW_2026-10-30.md](FLOW_2026-10-30.md).

## Automated

| Run | Layout | Result |
|---|---|---|
| `tests/integration/shop-registration-flow.test.ts` (new, 10 cases) | single DB | 10 / 10 pass |
| same + `onboarding-wizard-step1` + `onboarding-wizard-step2` | split (core + seller) | 59 / 59 pass |
| OTP, shop approval documents, document follow-up, onboarding states, self-registration, finance / settlements, wizard | split | 126 / 126 pass |
| Whole suite (`npx vitest run`) | single DB | 3011 / 3014 pass (243 files) |

The 3 failures in the whole-suite run all fail without this change too (same tests on the
`feat/referral-code-admin` checkout, no product-import code touched here):
`product-import.test.ts` "a row with only a name, only a barcode…", `product-import-parser.test.ts`
"maps a row with only a name…", `pmd-sources.test.ts` "reads skipped sheets through…".
`db-split-switch.test.ts` and `migrate-on-build.test.ts` timed out in their clean-up hook under the
full run's load; run alone they pass (13 / 13).

New cases (`shop-registration-flow.test.ts`):

| # | Case | Result |
|---|---|---|
| 1 | New registration: referral → email → documents question → verify; resumes on another device | Pass |
| 2 | Mandatory referral: empty / unknown code refused, no draft created; optional: empty accepted | Pass |
| 3 | Different shop email: code emailed; wrong code, other account, reused code refused; right code saves it | Pass |
| 4 | The confirmed shop email is saved on the shop | Pass |
| 5 | A draft started before this change (GSTIN checked) carries on at Udyam | Pass |
| 6 | "Yes": GSTIN → Udyam → FSSAI → details → map pin → review | Pass |
| 7 | "Upload later": details → pin → pay → **live with no GSTIN / PAN**; settlement approval refused (`PAYOUT_HELD`) until PAN verified, then allowed | Pass |
| 8 | "Upload later" food shop (dairy): FSSAI still required, live once verified | Pass |
| 9 | GSTIN refused, then "later": the refused GSTIN is not carried to the shop | Pass |
| 10 | HTTP routes referral / email / documents-ready; signed-out refused (401) | Pass |

## In the browser (local dev server, mock KYC, sandbox payment)

| Step | Result |
|---|---|
| `/shop/join?code=…` → `/shop/register?ref=…` (no SMS needed) | Pass |
| Signed out: sign-in card on the page, "code by email" note; dev sign-in → `/onboarding` → back to registration | Pass |
| Signed in: "Signed in as … — your shop is added to this account" | Pass |
| Referral: unknown code → clear error; optional → "Continue without a code" | Pass |
| Email: different email → code emailed → confirmed | Pass |
| Documents list → "Yes" → Verify with **Type / Scan** tabs | Pass |
| Scan: photo of a GST certificate read on the device, GSTIN found, owner checks it, verified online, details filled from the GST record | Pass |
| Udyam no → FSSAI no → details pre-filled → map pin → review with "Change" links → create shop → sandbox pay → **live**, wizard goes on to Category | Pass |
| Second account: "No, I'll upload them later" → Verify tile shown "after go-live", straight to shop details | Pass |

Not run: test.gokesari.com (needs the release and `shop_onboarding_wizard_enabled` on there),
Google Maps pin (no Maps key locally; the coordinates fallback was used), real email delivery
(local codes are printed to the server log).
