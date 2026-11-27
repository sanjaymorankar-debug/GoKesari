# Onboarding v2 — staging test results, 26-Nov-2026

- **Environment:** test.gokesari.com (staging), serving `03fc4a01` (PR #624 merged), flag `onboarding_v2` ON (migration 0215, 26-Nov-2026 09.20 PM IST).
- **When:** 26-Nov-2026, 09.23 PM to 11.36 PM IST.
- **Who / how:** Claude QA agent with Playwright. It used the staging test accounts (saved sessions, still signed in), the SMS mock (Admin → Test messages) and the Cashfree SANDBOX only. Nothing was run on gokesari.com.
- **Automated checks:** `tests/qa/guest/onboarding-v2.spec.ts` and `tests/qa/signed-in/onboarding-v2-{customer,shop,franchise,team,phone}.spec.ts` (branch `qa/onboarding-v2-staging`, commit 4a09d48e). There are 43 cases, TC-OV2-001…088, added to `test-cases.xlsx`.
- **Records:** `docs/testing/qa-runs/2026-11-26-staging-onboarding-v2-and-regression.json` (automated), `docs/testing/qa-runs/2026-11-26-staging-onboarding-v2-hand.json` (hand checks), `docs/testing/qa-defects.json` (D-166 … D-170, E-42) and `docs/testing/GOKESARI_MASTER_TEST_REGISTER.xlsx`.
- **Platforms:**
  - "Web desktop" means 1280 px Chromium.
  - "Web phone" means the Pixel 7 project (`mobile: true` checks) plus the 375×812 touch checks TC-OV2-080…087.
  - The Android and iOS apps are WebView shells of these same pages. They were **not** tested on a device.

## Summary — onboarding v2 (43 cases)

| Result | Cases |
|---|---|
| Pass | 30 |
| Pass (partial) | 5 (031, 034, 035, 073, 074) |
| Fail | 3 (012 → D-168, 017 → D-166, 030 → D-167) |
| Blocked / not run | 5 (013, 019, 020, 036, 088) |

## Case results

| Case | What | Desktop | Phone | Notes |
|---|---|---|---|---|
| TC-OV2-001 | Guest: /shops → shop → Add to cart → /cart → Place order opens the login sheet (no /signin anywhere) | Pass | Pass | Sheet step 1 of 3 shown over /cart; cart kept |
| TC-OV2-002 | v2 account APIs refuse a guest | Pass | – | All 401 |
| TC-OV2-003 | /franchise/start, /dealer/team, /team/invitations → sign-in for a guest | Pass | – | |
| TC-OV2-010 | Guest /r/<customer code> lands on / | Pass | – | 307 → "/" |
| TC-OV2-011 | Sheet step 1: Terms tick required; e-mail step shows the time in IST; Google / e-mail link offered | Pass | Pass | "Terms accepted 26 Nov 2026, 09.32 PM IST." |
| TC-OV2-012 | Sheet shows the Terms **version** with the time | **Fail** | – | D-168: only the time is shown. The API records 2026-10-24, while the shop step records 2026-11-26 |
| TC-OV2-013 | New e-mail: link or code → back to the cart → mobile → account + wallet | Blocked | – | The sign-in link goes to the real mailbox (it is never redirected), and this session has no mailbox access |
| TC-OV2-014 | Mobile step by SMS code (mock) → DONE + wallet | Pass | – | ops account at 09.33 PM IST, customer account again at 10.15 / 11.30 PM IST. A wrong code is refused (422) |
| TC-OV2-015 | Returning customer: no sheet, no payment preselected ("Choose how to pay"), address after paying → location prompt → saved address → order page | Pass | – | Shop A takes no COD on staging, so the wallet paid. Test orders were cancelled afterwards |
| TC-OV2-016 | Checkout without a payment method | Pass | – | 422 "Choose how to pay: online or cash on delivery." |
| TC-OV2-017 | Address pending: the shop marks the order ready, and dispatch waits for the location | **Fail** | – | D-166: GoKesari partner → 422 "no delivery address — choose pickup", and PICKUP is accepted instead |
| TC-OV2-018 | Address pending: the customer cancels after the shop accepted / packed, with a full refund | Pass | – | Wallet ₹31 debited, then cancelled → REFUNDED and the wallet restored |
| TC-OV2-019 | Pickup order needs no address | Blocked | – | Shop B (the only pickup-only test shop) is "not taking new orders" at night |
| TC-OV2-020 | COD with the address after payment | Blocked | – | Shop A does not accept COD (its own setting). Not changed |
| TC-OV2-030 | Shop identity step: Terms with version, links, e-mail, mobile SMS code | **Fail** (hand) | – | D-167: the Terms and Privacy links → /terms and /privacy, which are 404. The rest works (SMS mock) |
| TC-OV2-031 | Fee: Shop ₹1,000 / Wholesale ₹2,500 + 18% GST (₹1,180 / ₹2,950) | Pass (partial) | – | Amounts come from the draft. The Pay screen is not reached (see 036) |
| TC-OV2-032 | v2 steps refuse to run out of order | Pass | – | fee / licences / agreement → 409 STEP_OPEN |
| TC-OV2-033 | Identity done once; a returning owner skips it | Pass | – | |
| TC-OV2-034 | Admin → Shop documents → Registration licences queue | Pass (partial) | – | Queue is empty: there was no entry to approve or reject |
| TC-OV2-035 | Referral step: Request a referral code | Pass (partial) (hand) | – | Form opens. It was not sent |
| TC-OV2-036 | GST/PAN → fee (sandbox, leave unpaid → resume) → type → licences (Enter / Upload / Scan / Later; MUST_HAVE without Later) → address + pin → SLA → live / review | Blocked | – | A new registration's GST/PAN is checked live and needs an owner-agreed test PAN / GSTIN (owner decision 23-Nov) |
| TC-OV2-060 | My team page, history in IST | Pass | Pass | |
| TC-OV2-061 | Search by e-mail and by mobile (masked name); unknown → not found | Pass | – | |
| TC-OV2-062 | Request as team lead → decline → second request accepted → TEAM_LEAD | Pass | – | Accept / Decline done in /team/invitations |
| TC-OV2-063 | Team lead adds an agent under himself; the agent accepts | Pass | – | |
| TC-OV2-064 | Invite link for an unregistered contact (7 days, WhatsApp / SMS / e-mail), guest asked to sign in, withdrawn | Pass | – | |
| TC-OV2-065 | Downgrade refused while agents report to the lead → reassign → downgrade → upgrade | Pass | – | 409 "… still leads 1 agent(s) …"; the lead's own attempt → 403 |
| TC-OV2-066 | Admin user page: marketplace roles + IST history; override REMOVE | Pass | – | An OVERRIDE row is recorded and applies at once |
| TC-OV2-067 | Dealer removes a role; history lists every change in IST | Pass | – | Also seen by hand: accepting a request from a since-removed lead → 409 "ask the dealer to send a new request" |
| TC-OV2-070 | No live shop → /shop/register?return=/franchise/start | Pass | Pass | |
| TC-OV2-071 | Models, "at most 2 franchises a zone", LAUNCH_1Y ₹1,50,000 + GST, no 30-day KYC text | Pass | Pass | |
| TC-OV2-072 | Free dealer live at once with a GKD code | Pass | – | gk-shop → GKD-6P5W43, dealer APPROVED |
| TC-OV2-073 | Paid: zone, LAUNCH_1Y, coupon, sandbox payment → GKF code | Pass (partial) | – | GKZ-PUN-21 Hadapsar, ₹1,77,000 (sandbox net banking, test bank) → franchise live, GKF-Q6MRP2. An unknown coupon is refused; no valid coupon exists on staging. D-169 found here |
| TC-OV2-074 | Admin → Franchise → Plans | Pass (partial) | – | LAUNCH_1Y listed. Plans not edited |
| TC-OV2-080…087 | 375×812: guest cart + login sheet, cart, delivery location, shop registration, franchise start, My team, team requests, admin licences queue | – | Pass (8/8) | No sideways scroll; the sheet sits as a bottom sheet with Continue in view |
| TC-OV2-088 | Licence inputs: Upload = file picker, Scan = camera | Blocked | – | Step not reachable (036). Checked in code: `onboarding-v2-steps.tsx:436` has accept `image/*,application/pdf`; `:445` has accept `image/*` with `capture="environment"` |

## Defects

| ID | Severity | Case | Defect | Where |
|---|---|---|---|---|
| D-166 | High | TC-OV2-017 | A paid delivery order still waiting for its address cannot be marked ready for a GoKesari rider. The shop is told to choose pickup, and PICKUP is accepted, so the order becomes a pickup order | `src/server/services/fulfilment-options.ts:302-305` |
| D-167 | Medium | TC-OV2-030 | The shop identity step's Terms and Privacy links point to /terms and /privacy (both 404) | `src/components/registration/onboarding-v2-steps.tsx:133-134` |
| D-168 | Low | TC-OV2-012 | The sheet does not show the Terms version. The sheet (2026-10-24) and the shop step (2026-11-26) record different versions | `src/components/onboarding-v2/login-sheet.tsx:245`, `src/server/onboarding-v2/shop-view.ts:30`, `src/lib/legal-docs.ts:10` |
| D-169 | Medium | TC-OV2-073 | An abandoned paid-franchise checkout keeps the zone after "held until". There is no way to continue the payment or cancel it (the booking is PAYMENT_PENDING) | `src/server/franchise/booking.ts:459` (releaseExpiredHolds / cancelReservation) |
| D-170 | Low (not v2) | TC-RBAC-003/005, TC-SEC-001 | Admin dealer-scheme POSTs answer 422 instead of 403 to customers and shop owners | `src/app/api/admin/dealer-schemes/route.ts:25-29`, `[id]/route.ts:31-33` |
| E-42 | Info (QA) | TC-AUTH-024 + customer checkouts | TC-AUTH-024 leaves the customer's mobile unverified. With v2 on, later customer checkouts get 409 (sheet step MOBILE) | `tests/qa/signed-in/auth-profile.spec.ts` |

## Standard regression (guest + signed tiers) on staging

- **Full run:** 09.23 PM to 10.49 PM IST, 3,582 Playwright tests. 512 passed, 84 failed, 2,986 skipped. The skips are local-tier checks (not run on staging by rule) and desktop-only checks in the phone project.
- **Re-run:** every failed check was run once more (10.50 to 11.36 PM IST), after the customer's mobile was re-verified.
- **Collected:** 2,242 result rows over 1,793 case IDs: pass 634, fail 70, blocked 816, skipped 722.
- **Register overall (all sites):** Pass 576, Pass (partial) 578, Fail 98, Blocked 96, Manual 434.

How the remaining staging failures split:

- **v2 behaviour changes, so the old checks need updating (by design, not defects):**
  - TC-GCART-003 and TC-MKT-018: the sheet and the / landing. Known; PR #628 covers them.
  - TC-UX-002, TC-LOC-022, TC-CART-011 (UI) and TC-AUTH-024: the v2 cart preselects no payment, shows "Choose how to pay", and asks for the mobile in the sheet.
  - TC-FRN-011/013: the franchise call to action now goes to /franchise/start.
- **Test-data side effect:** E-42, described above.
- **Not v2 (to triage separately):**
  - D-170.
  - Dealer-platform scheme state on staging: TC-DPLT-001/002/031/037, TC-FRN-044.
  - Product-setup and shop-switch pages: TC-CAT-072…091, TC-ONB-075.
  - SD-01…07 document screenshots.
  - TC-SREF-001 and TC-MKT-019: referral sharing buttons were renamed.
  - TC-SUB-001, TC-DISC-007/013, TC-LOC-026: shop data and opening hours at night.
  - TC-RPAY-001, TC-RGR-010, TC-SPI-015, TC-VPA-015/021, TC-FIN-010, TC-REGSUB-004, SC-GW, TC-RBAC-004.
  - TC-QA-003: incomplete rows, because two runs wrote into the same result folder.
  - Of these, TC-COD-001/002/012 and TC-RPAY-001 already failed on 20-Nov.

## Not tested, and why

- **New-customer e-mail verification (TC-OV2-013).** There was no mailbox access: the Gmail connector is not authorised, and sign-in mail is never redirected to the testing inbox.
- **The shop flow after GST/PAN (fee payment, resume, shop type, licences with all four options, MUST_HAVE refusing Later, address + pin, SLA, go-live / operator review, licence approve / reject).** These need an owner-agreed test PAN / GSTIN on staging. They are covered in CI by `tests/integration/onboarding-v2-shop.test.ts`.
- **COD and pickup orders (TC-OV2-019/020).** On staging, shop A takes no COD and shop B was not taking orders at night.
- **Applying a valid franchise coupon.** No coupon exists on staging, and admin data was not created.
- **Flag-off sanity.** Covered by CI, as agreed.
- **Android / iOS devices.** Not device-tested; the WebView pages were checked at phone size only.

## Test data left on staging

- **Accounts and roles:**
  - gk-shop is now a free dealer (GKD-6P5W43) and has an open v2 registration draft stopped at GST/PAN.
  - customer2 (the staging dealer) is a paid franchisee for GKZ-PUN-21 Hadapsar (sandbox payment, 12 months).
  - The mobiles of ops and gk-lc14 are verified.
  - The team test members were removed (status INACTIVE, with history rows).
- **Zone holds:** zones GKZ-PUN-06, -10, -11, -41 and -46 show "Waiting for payment" from unpaid sandbox attempts until the gateway orders lapse (D-169).
- **Orders:** the test orders were cancelled and refunded. One ONLINE order (DB-20261126-3UH1KQ, unpaid) will lapse by itself.
