# FDW removal: gokesari.com (production) results

04-Nov-2026 09.52 IST. Project GoKesari-prod-sg (lively-frost-99365966), branch main. Owner asked for the move on 04-Nov-2026.

## Cut-over

| Item | Result |
|---|---|
| Releases in flight | none: no open PR into main; last Post-deploy check (#342) passed 08.40 IST |
| Backup branch | `pre-fdw-removal-2026-11-04` (br-jolly-bonus-aogr59ij), taken before any change, no compute |
| Dry run (branch `fdw-removal-dryrun-2026-11-04`, br-odd-lab-aomu076i) | Pass. 160 s, 181/181 tables, 637/637 rows, shop status trigger writes `status_changes` locally |
| Cut-over on main | Pass. 09.14.22 – 09.17.36 IST, one transaction ([cutover.sql](../../scripts/db-fdw-removal/cutover.sql)), no errors |
| Row counts, local vs live seller DB | 181/181 tables match, 637 = 637 rows ([prod_cutover_row_counts.csv](prod_cutover_row_counts.csv)); same again at 09.52 IST (no late writes to the old seller DB) |
| Foreign tables left in public/pmd | 0 |
| Server named `gk_seller` | none (renamed `gk_seller_retired`, holds only the parked tables in `fdw_old_public` / `fdw_old_pmd`) |
| Triggers / foreign keys | 29 / 889 |
| Sequences | next product code P00047 (last used P00046) |
| Connections to `PROD_SELLER_DATABASE_URL` after the cut-over | 0 (was 7). Site: 5 connections to `neondb` |

## How pre.sql / post.sql were made for production

`pg_dump -Fc --schema-only -n public -n pmd` of `PROD_SELLER_DATABASE_URL`, then `pg_restore -l`, leaving out:
the 2 schema entries, the 8 `gk_core` foreign tables (users, orders, platform_settings, roles,
user_role_grants, status_changes, status_transition_rules, audit_logs), all 74 types (identical in
both databases, checked label by label), the 2 default ACLs, and the 9 stand-alone sequences the
core already has (shop_registration_seq, product_code_seq, product_import_sku_seq, dispute_case_seq,
grievance_ticket_seq, support_ticket_seq, pmd.brand_seq, pmd.manufacturer_seq, pmd.product_seq;
step 5 of cutover.sql sets them). `--section=pre-data` → pre.sql, `--section=post-data` → post.sql,
`CREATE FUNCTION` → `CREATE OR REPLACE FUNCTION`. 2,168 of 2,263 entries kept.

## Site checks

| Check | Result |
|---|---|
| `/`, `/shops`, `/api/shops`, `/shops/nearby` (curl, 09.18 IST) | 200 (1.00 s / 0.25 s / 0.16 s / 0.07 s) |
| `scripts/release/post-deploy-check.sh https://gokesari.com` (09.18 – 09.22 IST) | OK, 5/5 healthy rounds |

## Rollback

Reset prod main to `pre-fdw-removal-2026-11-04`, or in one transaction: rename `gk_seller_retired`
back to `gk_seller`, drop the new local tables, move the `fdw_old_*` foreign tables back. The Hostinger
env was not changed, so no redeploy is needed. Writes made after 09.17 IST exist only in `neondb`.
