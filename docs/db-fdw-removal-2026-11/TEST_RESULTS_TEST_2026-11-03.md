# FDW removal: test.gokesari.com results

03-Nov-2026 00.36 IST. Project GoKesari-test-sg (curly-night-16641982), branch main.

## Cut-over

| Item | Result |
|---|---|
| Backup branch | `pre-fdw-removal-2026-11-02` (br-autumn-term-b307q60t), taken before any change |
| Dry run (scratch branch `fdw-removal-dryrun-2026-11-02`) | Pass. 174/174 tables, 30,916/30,916 rows |
| Cut-over on main | Pass. 02-Nov 23.37.45 – 23.40.58 IST, one transaction, no errors |
| Row counts, local vs live seller DB | 174/174 tables match, 30,916 = 30,916 rows ([test_cutover_row_counts.csv](test_cutover_row_counts.csv)) |
| Foreign tables left in public/pmd | 0 |
| Server named `gk_seller` | none (renamed `gk_seller_retired`, holds only the parked tables) |
| Triggers / foreign keys | 29 / 866 |
| Sequences | next product code P01231 (last used P01230); wallet txn seq 48 = max |
| FDW traffic into gokesari_seller after the cut-over | stopped: FETCH/DECLARE counter unchanged over the watch window, 0 FDW sessions |
| App connections to neondb | 6 (was 10 + 10 FDW) |

## Site checks (curl, 02-Nov 23.4x IST)

| Page | Result |
|---|---|
| `/` | 200, 1.40 s |
| `/shops` | 200, 0.34 s |
| `/api/shops` | 200, 0.20 s, shop list returned |
| `/shops/nearby` | 200, 0.08 s |
| shop page `/shops/e2e-four-features-bakery-d31pf` | 200, 1.06 s |
| `/admin/product-master`, `/api/product-master/products` | 307 / 401 when signed out (expected) |

## QA suite (tests/qa, 23.42 – 00.40 IST)

| Tier | Pass | Fail | Blocked | Skipped |
|---|---|---|---|---|
| Guest | 100 | 5 | 5 | 1 |
| Signed-in | 138 | 41 | 372 | 14 |

**Database-related failures: none.** No result shows a missing relation, permission, duplicate-key, sequence or FDW error.

- **One unconfirmed item:** TC-PRE-003. `/admin/dashboard` answered 500 once, 11 minutes after the cut-over (digest 686976663). It passed seconds later and again on re-run, and direct GETs answer 200. It may be a connection opened before the switch. The Hostinger log has not been checked.
- **Other failures:**
  - Undeployed dealer-tiered and shop-referral routes from the local working tree: TC-RBAC-002/003/005, TC-AUTH-033, TC-SEC-001, TC-SREF-002.
  - Empty staging customer wallet: 402 on checkouts.
  - Test or test-data faults: TC-FLD-052 midnight edge, TC-LIST-014, SD-01.
  - Failures already present on 01-Nov.

Seller flows covered:
- Storefront: shops, shop page, products, search, nearby.
- Admin: shops, dashboard, product master.
- Shop settings saves on the shops table.
- Catalogue download and upload preview.
- Cart, wallet checkout, and an order placed then cancelled.

Not covered: shop owner adding or editing a product (blocked on staging test data, as before). Rider and operator-limited checks were also blocked: no saved session.

Full run: `docs/testing/qa-runs/2026-11-02-staging-fdw-removal-check.json`; evidence under `test-results/qa/artifacts/test.gokesari.com/`.

## Network transfer

The test branch's transfer counter shows 77.8 MB at 03-Nov 00.30 IST; it was 5.04 GB on 02-Nov 23.10 IST. Neon appears to have restarted the counter in between, so this is not yet a clean before/after. The figure includes the cut-over copy and the QA run. A 24-hour reading on 04-Nov gives the real baseline.

## Rollback

1. Reset test main to `pre-fdw-removal-2026-11-02`, or, without a reset, run this in one transaction:
   - `ALTER SERVER gk_seller_retired RENAME TO gk_seller`
   - drop the new local tables
   - move the `fdw_old_*` foreign tables back
2. The Hostinger env is unchanged, so no redeploy is needed.
