# P0 run of the new cases on test.gokesari.com: 23-Nov-2026, 23.31 to 23.58 IST

On the owner's request ("Run the new P0 cases on staging"), these are the 99 P0 cases among the 472 cases added
on 23-Nov for the features that reached staging from 20 to 23 Nov
([FEATURES_AND_CASES_2026-11-23.md](manual/FEATURES_AND_CASES_2026-11-23.md)). The site was test.gokesari.com
(staging, the build it served at 23.31 IST; suite from `origin/staging` d9cef71e plus the new checks) on desktop, and
at phone size where the case has a screen. Payments used the Cashfree **sandbox** only. Nothing ran on gokesari.com.

Run record: `docs/testing/qa-runs/2026-11-23-staging-p0-new-features.json` (106 rows, 99 case IDs). New checks:

- `tests/qa/signed-in/p0-puja-voice-logo-2026-11-23.spec.ts`
- `tests/qa/signed-in/p0-documents-franchise-2026-11-23.spec.ts`
- `tests/qa/guest/p0-franchise-guest-2026-11-23.spec.ts`
- `tests/qa/signed-in/p0-staff-rbac-v2-2026-11-23.spec.ts`

## Result

| | Cases |
|---|---|
| **Pass** | 11 |
| **Pass (partial)**: every step that can run passed; the rest needs an account, data or access staging lacks | 22 |
| **Fail** | 1: TC-STAFF-059 (defect D-160, fixed in PR #520, retest after it is verified on staging) |
| **Blocked by missing staging data** (the check is automated and runs once the data exists) | 5 |
| **Not runnable today**: recorded with the reason (owner decision or access) | 60 |
| **Total new P0 cases** | **99** |

39 of the 99 were automated and run (11 pass, 22 partial, 1 fail, 5 blocked). At phone size,
TC-STAFF-061, 062, TC-VPA-015, 021 and TC-SMART-026 also passed.

## Per case

| Case | Result | Notes |
|---|---|---|
| TC-PUJA-004 | Pass | 15 guest calls to the puja APIs, all 401 |
| TC-PUJA-016 | Blocked | Wallet order placed, confirmed and packed; delivery outside delivery hours (earliest slot 24-Nov 07.00 IST). Order cancelled and refunded |
| TC-PUJA-026 | Pass (partial) | Customer refused 403 on all 5 owner calls; shop B owner part needs a session staging lacks |
| TC-PUJA-049 | Pass (partial) | Admin and operator open /admin/puja; operator-limited, shop owner, customer and rider refused. The FSSAI rule toggle (a business-rule write) not run |
| TC-PUJA-059 | Pass (partial) | Online order (kapur + a flower priced by Ask price) paid with Cashfree sandbox UPI: CONFIRMED, stock 99 → 98, both notified. COD part: shop A has COD off. Delivery part: outside delivery hours. Orders cancelled and refunded |
| TC-DOC-001 / 002 / 003 | Blocked | No shop waits for approval on staging, so no paid food shop without FSSAI; the checks run once one exists |
| TC-DOC-010 | Pass | Only admins and full operators open Upload documents; owner of another shop 403 |
| TC-DOC-043 | Pass | Operator sees the rules read-only; every change refused 403 |
| TC-FRN-008 | Pass | Guest: 3 pages to sign-in, 12 franchise writes 401, public pages open |
| TC-FRN-044 | Pass | Admin sees 14 tabs and actions; operator read-only (Areas "Correct a shop's area" allowed by G-02; the franchise README says admin only); others refused |
| TC-FRN-055 | Pass (partial) | Operator refund 403; bad reason 422; unknown booking 404. The real refund not run (would refund a live franchise) |
| TC-REFM-002 | Pass | Only an admin opens Referral moves; guest 401, others 403 |
| TC-REFM-015 | Pass (partial) | The raising admin cannot approve or reject (403); request cancelled after. Database step not run |
| TC-DPLT-002 | Pass | Free v2, Business Partner v1, Growth Partner v1, Territory Franchise v1, Free v1 read as decided |
| TC-DPLT-038 | Pass | Formula engine accepts a valid formula and refuses constructor / eval / unknown variables / `&&` with their messages; API 422 |
| TC-LOGO-006 | Pass (partial) | Guest 401, customer 403, operator may upload (audited); shop B owner and staff parts need accounts staging lacks |
| TC-VPA-002 | Pass (partial) | Guest to /signin (way back in the gk_return_to cookie, D-23; case corrected), interpret and apply 401 |
| TC-VPA-003 | Pass (partial) | Customer and admin refused "Only the shop's owner can change prices and offers by voice."; other-owner and staff parts need accounts |
| TC-VPA-015 | Pass (partial) | "Bread · price ₹40 → ₹42" published online and in-store, customer sees ₹42 (desktop and phone); price restored to ₹40. Price history row needs database access |
| TC-VPA-019 | Pass (partial) | "10% off until Sun, 29 Nov" offer published, customer sees ₹36; offer switched off after |
| TC-VPA-021 | Pass (partial) | "price 55" above MRP ₹45 refused on screen with Yes disabled; the apply step needs the MRP ₹50 product staging lacks |
| TC-SMART-026 | Pass (partial) | Flag off: no tile, page not found, API 404, guest 401. The flag-on half needs the flag switched (second admin) |
| TC-STAFF-002 | Pass (partial) | Accountant cannot approve, pay or refund (403); Finance read-only |
| TC-STAFF-003 | Pass | Support User and Support Manager cannot write shop data or roles (403, audited) |
| TC-STAFF-023 | Pass (partial) | Own request: "A different admin must approve this request."; cancelled after |
| TC-STAFF-033 / 035 | Pass (partial) | ₹1.00 journal drafted, submitted, posted by the CA; the preparer cannot decide. Ledger and dual-role steps need database / a dual-role user |
| TC-STAFF-037 | Pass (partial) | ₹49,999.99 posted by the CA alone; ₹50,000 needs the CA then an admin. Both reversed |
| TC-STAFF-038 | Pass (partial) | Reversal entry swaps the lines; the original is REVERSED; trial balance nets to zero |
| TC-STAFF-042 | Pass (partial) | Commission proposal: Accountant → CA → waiting for admin; cancelled before activation (live 1% unchanged) |
| TC-STAFF-047 | Blocked | No PAID payout or settlement records with a UTR on staging |
| TC-STAFF-050 | Pass (partial) | Statement matched, excluded, sent to the CA, reconciled and final; CSV export. Database trigger step not run |
| TC-STAFF-059 | **Fail** | **D-160**: the Support User's ticket page shows "Assigned to" / "Save assignment" (server answers 404) |
| TC-STAFF-061 / 062 | Pass | Support proposes changes, nothing applies until the owner decides item by item (desktop and phone) |
| TC-STAFF-063 | Pass (partial) | Price above MRP refused; "Approve all" applies the price and shop MRP, ticket resolved; product put back |
| TC-STAFF-065 | Pass (partial) | Other owner, the Support User and admin refused "Only the shop owner can decide this request."; customer part and flag-off step not run |

### The 60 P0 cases not runnable today

| Needs | Cases |
|---|---|
| A **second staging admin** (four-eye is ON). Test account `sanjaymorankar+gk-admin2@gmail.com` was created at 23.23 IST; its ADMIN role waits for the owner's approval in Admin → Approvals (owner: "Not now") | TC-STAFF-022, 026, 027, 031, 032; TC-REFM-016, 019, 020, 021; TC-DPLT-055 |
| A **flag switched on staging**, which under four-eye also needs the second admin | TC-SMART-012, 018; TC-SOC-024, 026; TC-STAFF-015 (flags off) |
| **Keys not set on staging** (AI key; Meta WhatsApp keys and templates) | TC-SMART-031, 037, 038, 039 |
| **An owner-agreed test PAN / GSTIN** and a new test account | TC-DOC-020, 021, 022, 023, 037, 050; TC-FRN-027, 029, 068, 069; TC-DPLT-008, 009, 013, 014, 016, 017, 045 |
| **KYC-complete test dealers** with linked accounts, teams and sandbox franchise payments | TC-FRN-016, 017, 018, 021, 030, 032, 033, 057, 058, 059, 064; TC-REFM-013, 023; TC-DPLT-019, 020, 021, 022, 024 |
| **Database access** (developer) | TC-NTF-021; TC-DPLT-003, 004 |
| Publishing a test scheme on staging / dealer-platform role grants / a back-dated reminder run | TC-DPLT-032; TC-DPLT-052; TC-DOC-030 |

## Defects

| ID | Severity | What | Status |
|---|---|---|---|
| **D-160** | Medium | Help desk: a Support User's ticket page offers "Assigned to" / "Save assignment" and "Escalate", which the server refuses (TC-STAFF-059) | **Fixed in PR #520** (in the staging queue); retest TC-STAFF-059 after it is verified |
| **D-161** | Medium | Voice price assistant (and add product by photo): without `?shopId` the page works on the owner's newest shop, not the one chosen in Seller Central, so an owner with several shops could publish a price or offer in the wrong shop | Open |
| **D-159** | Medium | Referral moves: a shop search by name matches every shop (the phone condition becomes `like '%%'`), so the shop looked for can drop out of the 20 results (TC-REFM-006) | Open |

## For the owner to decide

1. **Approve gk-admin2's ADMIN role** (Admin → Approvals, "Set role to ADMIN") to unblock the 10 four-eye cases.
   It also lets the flagged features (smart shopping, society joins) be switched on and back for their cases.
2. **Test identities for registrations and dealer KYC:** a test PAN and GSTIN that the live Sandbox.co.in KYC accepts and
   that belong to no real person. This unblocks 17 cases.
3. **Test dealers:** may QA create KYC-complete test dealers, and buy franchise zones and joining charges in the
   Cashfree sandbox on staging? This uses the launch-offer places there (18 cases).
4. **Two behaviours to confirm (not failed):**
   - An Accountant (and a CA) can mark reconciliation records resolved on /admin/finance → Reconciliation.
   - One admin activates a commission change at stage 2 of the Accountant → CA → admin flow, with no second admin.

## What the run changed on staging, all restored

| Area | What happened |
|---|---|
| Bread on shop A | ₹40 → ₹42 (4 times), back to ₹40 each time |
| Offer | "10% off · Bread" created and switched off |
| Shop A logo | Uploaded twice by the operator, removed each time |
| Orders (customer2) | DB-20261123-IR6NY8, -WFN85P, -44DZBI (₹130, sandbox UPI) and -5DZAF3 (₹545, wallet): all cancelled and REFUNDED; customer2's wallet back to ₹1,655; stock back to 100 |
| Journals | JE-000005 … JE-000018: every posted test entry reversed |
| Bank statements | BS-000005 and BS-000006 reconciled (final by design); BS-000004 deleted |
| Tickets | TKT-000038 … TKT-000053: all closed |
| Change requests | All decided |
| "Artificial Rose Garland – Single (5 ft)" (shop A) | Back to ₹99 / MRP ₹99. Shop A keeps an own-MRP row equal to the master (needs database access to remove) |
| Referral moves | Move request 314ef58d cancelled |
| Scheme drafts | Two "QA draft 23-Nov — delete" drafts deleted |
| Commission proposals and role requests | Cancelled (the live commission stayed 1%) |

Acting roles of gk-ops and gk-oplim were switched during the staff-role checks and put back (OPERATOR / OPERATOR_LIMITED).
No flag, business rule, fee, zone or role grant was changed.

## Register

Master register rebuilt (1,694 cases and journeys): overall Pass 487, Pass (partial) 519, Fail 65, Blocked 38,
Manual 123, Not run 462. Manual test workbook rebuilt as version 2.1 (Cover → Revision history).
