# Testing report — gig worker (delivery partner) flow

Branch `feat/gig-worker-flow`, PR [#306](https://github.com/sanjaymorankar-debug/GoKesari/pull/306) into `staging`.
Feature description: [README.md](README.md). Audit: [AUDIT_2026-10-31.md](AUDIT_2026-10-31.md).

_Status of this report: sections 1–3 complete; sections 4–6 are filled in as the release moves (see the "Updated" line of each)._

## 1. Summary

| # | Feature | Unit / integration | Test site (test.gokesari.com) | Production smoke |
|---|---|---|---|---|
| 1 | Registration with personal details | PASS (3 cases) | see §4 | see §5 |
| 2 | PAN and Aadhaar authorisation | PASS (6 cases) | see §4 | see §5 |
| 3 | Police verification + character certificate | PASS (2 cases) | see §4 | see §5 |
| 4 | Location at registration | PASS (1 case) | see §4 | see §5 |
| 5 | Offline / Active / Ready toggle | PASS (3 cases) | see §4 | see §5 |
| 6 | Zoning 3–5 km on the live location | PASS (4 cases) | see §4 | see §5 |
| 7 | Shop view of authorised / blocked societies | PASS (2 cases) | see §4 | see §5 |
| 8 | Partner identity hidden for blocked societies | PASS (2 cases) | see §4 | see §5 |
| 9 | Confirm picked up | PASS (2 cases) | see §4 | see §5 |
| 10 | Confirm delivered | PASS (2 cases) | see §4 | see §5 |
| 11 | Completed + notify | PASS (2 cases) | see §4 | see §5 |

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

_Updated as results arrive._

## 4. Test site — test.gokesari.com

_Updated after the staging deployment._

## 5. Production — gokesari.com

_Updated after the production release._

## 6. Defects found and fixed

| # | Found in | Defect | Fix | Re-test |
|---|---|---|---|---|
| D-1 | Integration (new) | Mock Aadhaar returned a fixed name, so every mock verification fell to "name doesn't match" (Pending) | Mock returns no name (the OTP itself proves the Aadhaar-linked mobile) | gig-worker-partner: PASS |
| D-2 | Integration (existing) | Registering a second test rider with the same mobile now failed (duplicate check) | Tests use distinct mobiles — the check is the feature | delivery-partners, delivery-partner-kyc: PASS |
| D-3 | Integration (existing) | Broadcast widening to 6 km and 13 km feasibility riders fell outside the new 5 km zone | Those legacy cases run with zoning off (their subject is the shop radius) | PASS |
| D-4 | Integration (existing) | Riders set online directly in the database stayed OFFLINE in `availability` and got no offers | Fixture and test set READY with online | PASS |
| D-5 | Integration (new) | Re-offered delivery row: accepting with the first rider gave FORBIDDEN, not the zone message | Test asserts FORBIDDEN, and checks the zone message at acceptance separately | PASS |
| D-6 | E2E spec typecheck | Duplicate variable in the staging scenario | Renamed | tsc PASS |
