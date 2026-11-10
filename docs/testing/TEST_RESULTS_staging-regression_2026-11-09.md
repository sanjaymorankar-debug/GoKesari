# Staging signed-in regression: 09-Nov-2026 (IST)

Site: test.gokesari.com. Full run in shop hours: **19.19 to 21.37 IST** (bakery open 06:00 to 22:00).
Record: `docs/testing/qa-runs/2026-11-09-staging-regression-world-repair.json`. Register: `GOKESARI_MASTER_TEST_REGISTER.xlsx`.

## Result

| | Pass | Fail | Blocked | Not run here by rule |
|---|---|---|---|---|
| Desktop | 373 | 78 | 108 | 548 |
| Phone (Pixel 7) | 90 | 27 | 29 | 24 |
| **Total rows** | **463** | **105** | **137** | **572** |

Before the repair (09-Nov, desktop only): 267 pass, 109 fail, 182 blocked.

The 105 failed rows are 83 different checks. After tracing each one:

| Class | Checks | Status |
|---|---|---|
| **Product defect** | 2 | D-147 (below), open |
| **Known feature gap** | 1 | TC-FLD-056: no logo upload (D-78) |
| **Test problem, fixed, re-test passed** | 27 | Desktop, 09-Nov 21.43 to 22.30 IST |
| **Test problem, fixed, re-test not finished** | 41 | Bakery closed at 22.00 and wallet ran low (see "Not yet proven") |
| **Test data on staging** | 12 | Needs data, not code (see "What needs you") |

No security failure and no money failure remains that is a product fault. The only product defect is one button.

## Product defect

**D-147 (Low). TC-FUL-007 / TC-FUL-008.** "Packed — mark ready" stays active on the shop's order card while the customer is deciding on a substitute (`src/components/fulfilment-planner.tsx:351`). The server still refuses: the same check saw 409 and the money steps passed. Only the button is wrong.

## Why so many checks failed

| Cause | Checks affected |
|---|---|
| "Packaged" listing resolved to the shop's cheapest product, which was Bread, the same as another line. Two lines merged in the cart, so a "4 lines × 2" order had 4 Bread | TC-RET-*, TC-FLD-083/094/095/096/098, TC-FUL-005/006/009, TC-ORD-011 |
| TC-RBAC-012 really switched `customer` to Shop Owner (the account holds that role) and left it so for the rest of the run | TC-SEC-004, TC-LOC-006, TC-FLD-021 |
| Staging has rule `afterPackingCancellation` on, so the customer can cancel at READY. The check did cancel, which removed the order the next checks needed | TC-ORD-007, TC-DEL-001/007/010, TC-ORD-001 |
| Rule `fulfilmentOptions` on: own delivery needs a plan | TC-DEL-020, TC-SUP-008, TC-CART-017, TC-FLD-029 |
| ₹25 delivery fee not counted | TC-CART-011/012 |
| Hard-coded values that drifted (customer's street, Kothrud, shop type DAIRY, customer2's far address, inventory row by name) | TC-DEL-005/006, TC-DISC-004/005, TC-LOC-005/007, TC-ORD-012 |
| Another test order was auto-cancelled and refunded during the check (₹55). Passed when run alone, so not a double refund | TC-ORD-005, TC-DEL-011, TC-ORD-009 |
| Test bugs: reading a page before the save finished, duplicate shop names, Monday's closed day, a working map now needs "Confirm location", status word taken for a secret, new routes not in the sweep | TC-LOC-008/010/023, TC-DISC-001/013, TC-SEC-005, TC-RBAC-004, TC-FLD-017 |
| `/shop/...` 404 arrives inside a 200 page, as its sign-in redirect does (no shop data in it) | TC-SEC-009 |

## Your seven points

1. **Shop account:** now opens the bakery (`gk_shop` cookie set from the world file).
2. **Customer accounts:** checks use an account that is still a plain customer. **No test account is free of shops**, so the seller-portal half of TC-RBAC-003 and RB-02 stay blocked.
3. **Delivery windows:** EXPRESS_30 / STANDARD_60 were false because no rider was Ready near the bakery. `gk-rider` cannot go Ready without KYC and police papers (rule `riderVerification.gateAvailability`). The run sets an admin override and Ready, and checkout checks pick a slot.
4. **TC-OPG-001/002/003/005:** already updated on `staging`; they pass. The earlier failures came from an old copy in another worktree.
5. **TC-RBAC-002 / TC-SEC-001:** the /signin redirect inside a 200 page is accepted, with no shop data in it. Both pass.
6. **Cow Milk 404:** the bakery carried only the Bakery category, and a listing shows only in a category the shop carries. Dairy was re-added at 19.05 IST and the page answers 200. Who removed it was not found. **Asmy test2:** its shop wallet is ₹0 against a ₹200 minimum, delivery is off and opening hours are empty. Its owner account has no saved session, so it was left as is.
7. **429 limit:** the run now paces `/api` calls at 150 a minute and waits out a 429. No check hit the site-wide limit; the seven rows mentioning 429 or "too many" are checks that test a limit on purpose, and all passed.

## Not yet proven

- **41 checks fixed but not re-tested to the end.** The re-run reached 22.00 IST, then the bakery closed and riders got no offers. The customer's wallet was also too low for the returns order. Mostly TC-RET-* and TC-DEL-004/005/006/020; also TC-CART-011/012/017, TC-SEC-004/005, TC-SPI-006/008, TC-SUP-008, TC-SUB-001, TC-LOC-004/023, TC-DISC-013, TC-ORD-012, SC-GW.
  - Partly confirmed: TC-LOC-023 saves the pause and TC-DISC-013 shows the hours (each stopped only at a step that needs the shop open). The inventory row lookup and the Dairy tab with its Subscribe button were confirmed by direct page checks.
- **Phone was not re-run.** Phone-only failures: TC-CART-018, TC-DEL-004 / TC-FLD-085, TC-FUL-005/006/007/008.
  - **TC-DEL-004 / TC-FLD-085 on the phone is the one failure I could not explain:** "Confirm pickup" was enabled with 2 digits, the same code passes on desktop, and the screenshots were overwritten by later runs. Treated as a test problem until a phone re-run says otherwise.
- `test-cases.xlsx` statuses were not written back: `openpyxl` is not installed on this Mac.

## What needs you

| Item | Why | Blocks |
|---|---|---|
| **Top up the `gk-lc14` customer wallet by about ₹5,000** with Cashfree sandbox data (a payment step I did not run) | The run spent it: ₹4,759 before, ₹999 now | The re-test of the 41 checks |
| A new test account with no shop (e.g. `+gk-plain`) | `customer`, `customer2`, `admin` and `ops` each own a shop | TC-RBAC-003 half, RB-02 |
| Shop B: a session for its owner, or wallet and delivery set | Asmy test2 is not taking orders | TC-RBAC-017, TC-PAY-025, TC-CART-015, TC-DISC-008/009 |
| A customer2 with no mobile, a product with an MRP | Test data | TC-CART-015, TC-AUTH-020, TC-PRE-008 |
| Two old open COD orders on `gk-lc14` | Older than the 25 orders the API lists, so the checks cannot close them; the COD limit is 2 | TC-COD-001/002/012 and others |

## What was changed on test.gokesari.com

| When (IST) | Change |
|---|---|
| 19.05 | Dairy category re-added to the bakery (no listing changed) |
| 19.19 to 22.28 | `gk-rider` set Ready with an admin override of the KYC gate. **Removed at the end: rider offline, override off** |
| 21.43 | `customer` active role put back to CUSTOMER |
| 21.44 | Four leftover "QA Leg" addresses deleted from `customer` |
| 22.26 | Four leftover test orders cancelled by the shop (refunded to the wallet) |

Shop settings and business rules were checked after the run and are as before.

`#377` was merged into staging at 19.04 IST, just before the run, and then failed on the site, which paused the staging queue (issue `#379`; fix `#380` is in the queue). This PR waits behind it.
