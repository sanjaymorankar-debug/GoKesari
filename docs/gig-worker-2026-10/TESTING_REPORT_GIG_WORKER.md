# Testing report — gig worker (delivery partner) flow

Branch `feat/gig-worker-flow`, PR [#306](https://github.com/sanjaymorankar-debug/GoKesari/pull/306) into `staging`.
Feature description: [README.md](README.md). Audit: [AUDIT_2026-10-31.md](AUDIT_2026-10-31.md).

_Status of this report (31 Oct 2026, 16:00 IST): unit/integration, CI and the Test site complete; production waits for the owner's release window (§5)._

## 1. Summary

| # | Feature | Unit / integration | Test site (test.gokesari.com) | Production smoke |
|---|---|---|---|---|
| 1 | Registration with personal details | PASS (3 cases) | PASS (after fix D-11) | Not yet released |
| 2 | PAN and Aadhaar authorisation | PASS (6 cases) | PASS — provider answers settled by admin (Test keys) | Not yet released |
| 3 | Police verification + character certificate | PASS (2 cases) | PASS | Not yet released |
| 4 | Location at registration | PASS (1 case) | PASS | Not yet released |
| 5 | Offline / Active / Ready toggle | PASS (3 cases) | PASS (after fix D-12) | Not yet released |
| 6 | Zoning 3–5 km on the live location | PASS (4 cases) | PASS | Not yet released |
| 7 | Shop view of authorised / blocked societies | PASS (2 cases) | PASS | Not yet released |
| 8 | Partner identity hidden for blocked societies | PASS (2 cases) | PASS | Not yet released |
| 9 | Confirm picked up | PASS (2 cases) | PASS | Not yet released |
| 10 | Confirm delivered | PASS (2 cases) | PASS | Not yet released |
| 11 | Completed + notify | PASS (2 cases) | PASS in-app; SMS queued, no SMS provider on Test | Not yet released |

## 2. Unit and integration tests (local, real PostgreSQL)

New files: `tests/integration/gig-worker-partner.test.ts` (features 1–5, 15 cases) and
`tests/integration/gig-worker-orders.test.ts` (features 6–11, 14 cases). KYC runs on the
in-process mock vendor (`KYC_PROVIDER=mock`); SMS on the mock outbox. Both files pass on the
**single-database** layout and on the **two-database split** layout (`DB_SPLIT_MODE=split`,
core + seller databases built with `scripts/db-split/test-layout.ts`).

| # | Test case | Feature | Result |
|---|---|---|---|
| 1 | The API needs every detail of the brief, each with its own field message | 1 | PASS |
| 2 | Refuses an under-18 date of birth, a bad PIN code, a bad vehicle number, an unknown gender and an emergency number equal to the partner's own; a bicycle needs no number | 1 | PASS |
| 3 | One partner per mobile number, across accounts (duplicate-mobile check) | 1 | PASS |
| 4 | Location is required through the API, with a clear message, and saved with its time | 4 | PASS |
| 5 | Nothing is checked without consent (service and route) | 2 | PASS |
| 6 | PAN: Verified through the provider, stored encrypted and masked, consent version / time / IP recorded | 2 | PASS |
| 7 | PAN: Failed when the record has no such number; Pending when the name doesn't match | 2 | PASS |
| 8 | Aadhaar: OTP (wrong OTP refused), then Verified; the number is in no row, partner record or audit entry — masked + 64-hex token only | 2 | PASS |
| 9 | The database itself refuses an Aadhaar row with a stored number | 2 | PASS |
| 10 | Too many wrong OTPs lock the attempt; the same Aadhaar fails for a second partner (`already_used`); an operator can't decide, an admin can | 2 | PASS |
| 11 | PDF, JPG and PNG accepted; WebP and a renamed text file refused; size limit from the rule; upload through the route | 3 | PASS |
| 12 | File stored encrypted; opens for an admin only (operator 403, partner 403, admin 200 `application/pdf`, `no-store`), opening audited; Uploaded → Under review → Rejected (reason required) → new upload → Approved | 3 | PASS |
| 13 | Active and Ready blocked until PAN + Aadhaar Verified and both documents Approved | 5 | PASS |
| 14 | Toggle route takes offline / active / ready; 409 lists what is missing; operator can't override (403), admin can; removing the override closes the gate again | 5 | PASS |
| 15 | With the gate rule off, approved partners go online as before; `is_online` always equals availability ≠ OFFLINE | 5 | PASS |
| 16 | Offers only to a Ready rider within the radius of both pickup and drop (rider at the shop with the drop 6 km away is skipped; an Active rider is skipped) | 6 | PASS |
| 17 | Uses the live location, not the registration address; ignores a location older than 15 min | 6 | PASS |
| 18 | Radius configurable 3–5 km: 2 and 6 refused; at 3 km a rider 4 km away gets nothing | 6 | PASS |
| 19 | A location update out of the zone withdraws the open offer and the order goes to the next rider; acceptance re-checks the live location | 6 | PASS |
| 20 | A partner blocked for the order's society is never offered it | 8 | PASS |
| 21 | Only an admin decides society access; a block needs a reason | 7 | PASS |
| 22 | Blocked after acceptance: shop order data shows "Partner pending assignment" with no name / photo / mobile; the shop's pickup notification says "A delivery partner"; the partner is not on the shop's partner list | 8 | PASS |
| 23 | The shop sees each partner's count of authorised (2) and blocked (1) societies with the lists; another shop owner is refused | 7 | PASS |
| 24 | Assigned → Picked Up with a timestamp and an optional pickup photo; customer and shop notified | 9 | PASS |
| 25 | The pickup photo never counts as the photo at the door (rule `deliveryProof.photoRequired`) | 9 | PASS |
| 26 | With the code required the drop needs it; Picked Up → Delivered | 10 | PASS |
| 27 | With `deliveryOtp.required` off no code is issued and the rider delivers without one | 10 | PASS |
| 28 | A confirmed delivery completes the order once (status stays DELIVERED); customer and shop each get one in-app message and a queued PUSH + SMS | 11 | PASS |
| 29 | With rule `orderCompletion` off nothing is marked completed | 11 | PASS |

Existing tests changed because the behaviour changed on purpose (all pass):

| File | Why |
|---|---|
| `delivery-assignment.test.ts`, `batch-b-dispatch-broadcast.test.ts` | Riders 6–13 km away are outside the 5 km zone: those cases now switch `riderZoning` off (the shop-only radius they test) |
| `delivery-partners.test.ts`, `delivery-partner-kyc.test.ts` | Second applicants use a different mobile (duplicate-mobile check); the API registration sends the full details; the free-text ID is a voter ID (an Aadhaar number is no longer taken there) |
| `qa-2026-10-24-orders-fixes.test.ts` | Asserts the Aadhaar refusal at registration; a rider put online by hand is also Ready |
| `status-models.test.ts`, `delivery-partner-kyc.test.ts` | Verification gate off where going online is not what is tested |
| `event-layer.test.ts` | The event list ends with `order.completed`; completion notices asserted |
| `qa-2026-10-24-auth-fixes.test.ts` | The sign-out audit row also records `availability: OFFLINE` |
| `tests/helpers/fixtures.ts` | Fixture riders that are online are Ready |

Full suite (`npm test`, 246 files) — see §3.

Mobile app (`mobile/`): `npm test` 41 cases PASS (5 new in `gig-worker-flow.test.ts`),
`npm run typecheck` PASS, `eslint` PASS, `expo config` 1.4.0 / build 5 for both variants.

Typecheck, lint (`eslint src tests`) and the production build (`npm run build`, all four new
pages listed) PASS locally.

## 3. Full suite and CI

**Local full suite** (`npm test`, single layout, 31 Oct 2026, before the fixes below):
244 files, 3 022 tests — 3 015 passed, 7 failed.

| Failure | Cause | Action | Re-test |
|---|---|---|---|
| `date-timezone` — 3 new date calls without `timeZone` | Defect in this change (GAP-017 rule) | Added `timeZone: "Asia/Kolkata"` (D-7) | PASS |
| `tile-board` — shop menu items 42, expected 41 | Intended: the new Delivery → "Delivery partners" item | Count updated with the reason (D-8) | PASS |
| `business-limits` — `deliveryOtp` defaults gained `required: true` | Intended: feature 10's switch | Expectation updated (D-9) | PASS |
| `qa-2026-10-24-auth-fixes` TC-AUTH-040 — sign-out audit row also has `availability` | Intended | Expectation updated (D-10) | PASS |
| `product-import` / `product-import-parser` / `pmd-sources` — 3 cases | **Not this change**: the same 2 unit cases fail on the unchanged main checkout (local ExcelJS / temp-file behaviour on macOS) | None (pre-existing, local only) | — |
| `split-migrate` — the file's `afterAll` timed out closing connections | Its 5 tests passed; local teardown timing | Left to CI (`test-split`, Linux) | see CI |

**CI on PR #306** (head `cd2c7d2b`): `test` (whole suite, single layout) PASS 44 m 42 s;
`test-split` (whole suite, two-database layout) PASS 19 m 22 s; `mobile` (typecheck, lint, tests,
Android + iOS bundle) PASS; `APK (preview)` and `APK (production)` PASS; `scope` PASS.
Merged into `staging` 31 Oct 2026 08:33 UTC (merge commit `a71bceac`).

## 4. Test site — test.gokesari.com

**Deployment.** "Test database" run 41185066662 (on the merge): backup kept 14 days → migrate
(`applied 0121_gig_worker_flow → core`, 1 new migration) → verify PASS. New routes answer:
`/delivery-partner/kyc` → sign-in redirect, `/api/delivery-partner/me/kyc` 401,
`/api/admin/rider-kyc-checks` 401, `/shop/delivery-partners` 200.

**How it was run.** Scenario `tests/qa/scenarios/SC-GW-gig-worker.spec.ts` (Playwright, desktop
Chrome) with the saved staging sessions: customer2 became the new delivery partner ("QA Gig
Rider"), customer ordered from shop A ("E2E Four Features Bakery"), shop A's owner packed, admin
reviewed, ops checked the admin-only file. Browser geolocation was set near shop A
(18.5204, 73.8567). Each step's evidence: `test-results/qa/gig-worker/test.gokesari.com.json`.

**Run 1 (build `a71bceac`).**

| # | Step on test.gokesari.com | Feature | Result |
|---|---|---|---|
| 1 | Register page shows the new fields (gender, address, PIN, vehicle number) | 1 | PASS |
| 2 | Submit stays disabled until "Share my location"; the device location shows on the form | 4 | PASS |
| 3 | API refuses an incomplete application field by field (10 fields incl. location) | 1, 4 | PASS |
| 4 | Registration through the form → next page is KYC; profile has gender, PIN, emergency contact, location + time | 1, 4 | PASS |
| 5 | Same mobile from another account → 409 | 1 | PASS |
| 6 | PAN without consent → 422 | 2 | PASS |
| 7 | PAN with consent → **Pending** ("verification service not answering" — the Test site's provider keys), masked `XXXXX1234F` | 2 | PASS (status shown as designed) |
| 8 | Aadhaar OTP request → **Failed** ("no such number" from the provider's test environment), masked `XXXX XXXX 2346` only | 2 | PASS (status shown as designed) |
| 9 | No full Aadhaar number in any partner or admin answer | 2 | PASS |
| 10 | Admin list shows both checks masked; operator 403; admin marks both Verified by hand | 2 | PASS |
| 11 | WebP refused; police verification (PDF) and character certificate (PNG) uploaded as Uploaded | 3 | PASS |
| 12 | File: ops 403, partner 403, admin 200 `application/pdf`, `Cache-Control: no-store` | 3 | PASS |
| 13 | Uploaded → Under review → Rejected (reason required, 422 without) → re-upload → Approved; certificate Approved | 3 | PASS |
| 14 | Admin approves the application; partner switches to Ready, then Active (API) | 5 | PASS |
| 15 | Dashboard shows the Offline / Active / Ready switch and the verification checklist | 5 | PASS |
| 16 | **Choosing Ready on the dashboard while Active** | 5 | **FAIL → D-12** |
| 17 | Admin authorises one society, block without a reason 422, block with reason 200; shop owner 403 | 7 | PASS |
| 18 | Ready partner next to shop A gets the offer and accepts it on the live location | 6 | PASS |
| 19 | Shop's Delivery partners API: the partner with authorised 1 / blocked 1 and the society names | 7 | PASS |
| 20 | Shop pages in the browser (Delivery partners, order partner line) | 7, 8 | Not shown: the browser opened another of the owner's shops (test set-up, fixed in the scenario) |
| 21 | Optional pickup photo (kind PICKUP) 201 | 9 | PASS |
| 22 | Assigned → Picked Up with `pickedUpAt` | 9 | PASS |
| 23 | Drop started; Delivered refused without the photo at the door (Test site has `deliveryProof.photoRequired` on), then without the code (422 "Enter the 4-digit delivery code") | 10 | PASS |
| 24 | Delivered with the customer's code | 10 | PASS |
| 25 | Order DB-20261031-AM1ZA9: status DELIVERED, `completedAt` 2026-10-31T08:59:37Z | 11 | PASS |
| 26 | Customer: "Order completed — … was delivered successfully and is now complete"; shop: "Order completed — … delivered successfully to the customer" (in-app) | 11 | PASS |
| 27 | SMS / push for completion | 11 | Queued; not sent on the Test site — no SMS provider configured there (mock outbox empty), push only to app installs |
| 28 | Partner Ready ~22 km from shop A gets no offer; the order keeps searching (attempt 1 of 10, NO_RIDER) | 6 | PASS |

**Run 2 (build `b913cfb5`, after fix PR #308 — CI `test` PASS 48 m, `test-split` PASS 30 m; live
on test.gokesari.com 31 Oct 15:24 IST).** Evidence: `staging-run-2026-10-31-final.json`.

| # | Step on test.gokesari.com | Feature | Result |
|---|---|---|---|
| 29 | A refused application (bad PIN, no vehicle type) shows "Please check the highlighted fields" and **keeps what was typed** (name, email, PIN) — D-11 fixed | 1 | PASS |
| 30 | **Choosing Ready on the dashboard while Active** — D-12 fixed | 5 | PASS |
| 31 | Shop's **Delivery partners** page (shop A): card "QA Gig Rider · GKR-5A1E7477 · Scooter · 1 of your orders delivered", Authorised societies 1 / Blocked societies 1; tapping a count lists the societies | 7 | PASS |
| 32 | Shop's order (partner not blocked): "Delivery partner: QA Gig Rider (GKR-5A1E7477) · Call 9436205718" | 8 | PASS |
| 33 | Customer's order list (Past tab) shows **completed** on the delivered order | 11 | PASS |
| 34 | A test society registered and verified; the customer approved as a resident; the delivery address linked to it | 8 | PASS |
| 35 | Society order offered to the partner (authorised for it) and accepted | 8 | PASS |
| 36 | Admin blocks the partner for that society after acceptance | 8 | PASS |
| 37 | Shop's order card: "Delivery partner: **Partner pending assignment**", no name, photo or Call link | 8 | PASS |
| 38 | Server data for that order: `"deliveryPartner":{"label":"Partner pending assignment","partner":null}` — no name or mobile sent to the shop | 8 | PASS |
| 39 | Shop's pickup notification: "Order DB-20261031-3Q3GVU has been collected by **A delivery partner**." | 8 | PASS |
| 40 | Clean-up: address unlinked, membership removed, block removed, test society suspended | — | done |
| 41 | Every run-1 step repeated (registration re-run path, KYC, documents, gate, toggle, zoning in and out, pickup, delivery, completion and its messages) | 1–11 | PASS |

Final run: **50 of 52 steps passed.** The two that did not: the PAN route answered **429**
("Too many requests", retry after 43 min) — its own limit of 5 billed provider checks per partner
per hour, used up by the day's repeated runs. That is the limit working; the same PAN steps passed
in runs 1 and 2a. One intermediate run was cut short by the test host's firewall (nginx answering a
burst itself with a 307 loop — known E-01 in `docs/testing/qa-defects.json`); its half-finished
order was completed by hand before the final run.

**Configuration seen on the Test site (not defects):** `deliveryProof.photoRequired` is on (the
door photo comes before Delivered); the KYC provider there answers PAN "not answering" and the
example Aadhaar "no such number", so both were settled by the admin (manual decision path); no SMS
provider is configured (mock outbox empty), so the completion SMS is queued but not sent; push goes
only to phones with the app.

**Test data left on test.gokesari.com:** customer2 (sanjaymorankar+gk-cust) now also holds a
delivery partner profile "QA Gig Rider" (approved, KYC verified by hand, documents approved, Offline,
active role put back to Customer); QA orders DB-20261031-AM1ZA9, -BIPAMO, -XABVVE, -CX433X, -3Q3GVU
delivered; a few zoning-check orders left searching / cancelled; test societies "QA-GW Society …"
suspended.

## 5. Production — gokesari.com

**Not released yet.** Production goes out with the staging → main release (draft PR #302, which
now carries this work), in a window the owner approves, after "Production database" → migrate
(source staging) applies 0121 (and 0120 / 0122 from the other staging work). Smoke tests to run
then (guest tier only on production, no test data): post-deploy check (`/`, `/shops`,
`/robots.txt`); `/delivery-partner/register` and `/delivery-partner/kyc` → sign-in redirect;
`/api/delivery-partner/me/kyc`, `/api/admin/rider-kyc-checks`, `/api/admin/rider-background-docs`
→ 401; `/shop/delivery-partners` answers; the post-deploy check four rounds green.

## 6. Defects found and fixed

| # | Found in | Defect | Fix | Re-test |
|---|---|---|---|---|
| D-1 | Integration (new) | Mock Aadhaar returned a fixed name, so every mock verification fell to "name doesn't match" (Pending) | Mock returns no name (the OTP itself proves the Aadhaar-linked mobile) | gig-worker-partner: PASS |
| D-2 | Integration (existing) | Registering a second test rider with the same mobile now failed (duplicate check) | Tests use distinct mobiles — the check is the feature | delivery-partners, delivery-partner-kyc: PASS |
| D-3 | Integration (existing) | Broadcast widening to 6 km and 13 km feasibility riders fell outside the new 5 km zone | Those legacy cases run with zoning off (their subject is the shop radius) | PASS |
| D-4 | Integration (existing) | Riders set online directly in the database stayed OFFLINE in `availability` and got no offers | Fixture and test set READY with online | PASS |
| D-5 | Integration (new) | Re-offered delivery row: accepting with the first rider gave FORBIDDEN, not the zone message | Test asserts FORBIDDEN, and checks the zone message at acceptance separately | PASS |
| D-6 | E2E spec typecheck | Duplicate variable in the staging scenario | Renamed | tsc PASS |
| D-7 | Full suite (`date-timezone`) | Three new date displays used the device's time zone, not India time | `timeZone: "Asia/Kolkata"` | PASS |
| D-8 | Full suite (`tile-board`) | Approved menu count didn't include the new shop item | Count 41 → 42 with the reason | PASS |
| D-9 | Full suite (`business-limits`) | Rule defaults assertion missed `deliveryOtp.required` | Expectation updated | PASS |
| D-10 | Full suite (TC-AUTH-040) | Sign-out audit row now also records the availability | Expectation updated | PASS |
| D-11 | **Test site** (registration form) | A server refusal (e.g. bad PIN) wiped every field typed: `<form action>` is reset by React after the action | Form submits through `onSubmit` (PR #308) | Run 2 |
| D-12 | **Test site** (dashboard) | Active → Ready failed with "Could not get your location": next to the running location watch, a request for a brand-new fix timed out | Accept a position up to 60 s old (PR #308); confirmed in the page that this returns at once while the fresh request times out | Run 2 |
| D-13 | Test site (scenario) | customer2 had been left acting as another role by an earlier QA run, so applying was refused (403) | Scenario switches the role first | PASS |
| D-14 | Test site (scenario) | Shop pages opened another of the shop owner's shops | Scenario sets shop A as the active shop | Run 2 |
