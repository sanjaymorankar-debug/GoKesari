# Publishing the Product Master to a shop catalogue (test, then live)

How the pilot catalogue gets from a Product Master database into `public.products` on a deployed site. Rehearsed end to
end on a scratch local database (migrate → copy pilot data → promote → roll back → promote again). **Not yet run against
any hosted database.**

## What gets published

`pmd.product_master` is the universal record; `public.products` is what shops pick from. Promotion is the only bridge
(`src/server/pmd/services/catalogue-bridge.ts`). Things to know before running it:

* Promoted products are created **APPROVED** immediately. Anything that lists APPROVED catalogue products (shop-owner
  suggestions, catalogue search) shows them at once. Customers can only buy from a shop that lists a product with its own
  price, but review the pages that read `public.products` before promoting on a live site.
* **No price crosses.** Open data has no verified MRP, so promoted products have `mrp_paise = NULL` (`UNVERIFIED`); shops set
  their own prices.
* **Images are linked, not copied** - the URLs point at the open-data project's image host. Use `--no-images` to skip them.
* **Licence.** Open Food Facts and its sister projects publish under ODbL (data) and CC-BY-SA (images). Publishing requires
  visible attribution. The app has no attribution page yet - decide where it goes before going live.
* **Pilot data is uneven.** In the rehearsal, of 837 promoted products 99 had no brand, 13 brand names contained "sold by",
  and category mapping has quirks (a liquid detergent lands in a department it should not). Review a sample first.

## Steps (repeat per site: test first, live only after you have checked test)

Write `<target>` for the site's **direct** (non-pooled) Postgres URL. Do not commit it or paste it into a shared place.

0. **Know which database the site uses.** It is `DATABASE_URL` in the host's environment settings, and test and live may be
   different databases. Do not guess. **Back it up first** (a Neon branch, or `pg_dump -Fc`).
1. **Deploy the code.** Merging to `staging` deploys test; merging to `main` deploys live. The app does not migrate itself.
2. **Apply migration 0015** (creates the `pmd` schema; the rest of the database is untouched):
   `DATABASE_URL=<target> npm run db:migrate`. Do **not** run `pmd:seed` - the copy in step 3 brings the reference data.
3. **Copy the pilot data** from the local pilot database (`gokesari_pmd`) into the migrated, still-empty target. On Windows:

   ```powershell
   .\scripts\pmd\copy-pilot-data.ps1 -Target "<target>"
   ```

   It refuses a target with no `pmd` schema or with any data in it, restores in one transaction (all or nothing), and
   compares row counts with the source afterwards. Underneath it is `pg_dump -Fc -a -n pmd` and `pg_restore -a
   --single-transaction`; `price_history` has to be restored last because pg_dump orders partitioned tables before the tables
   they reference (`pg_restore -l`, move the `TABLE DATA pmd price_history` lines to the end, `pg_restore -L`). No superuser
   option is used, so it works on a hosted database. The dump is under 1 MB.
4. **Dry run** (writes nothing) and read it - counts by department, and a warning for any department that has no
   marketplace category on the target:

   ```bash
   PMD_DATABASE_URL="<target>" PMD_ALLOW_REMOTE=1 npm run pmd:promote -- --min-quality 60
   ```
5. **Apply a small batch first**, look at it in the app, then the rest. `--actor-email` must be an ACTIVE operator or admin
   of that site (the audit trail records them):

   ```bash
   PMD_DATABASE_URL="<target>" PMD_ALLOW_REMOTE=1 npm run pmd:promote -- --min-quality 60 --limit 20 --apply --actor-email <admin email>
   ```

   Re-running is safe: products already promoted are skipped.

   **Against a hosted database add `--concurrency 8`.** One promotion is ~25 round trips, which was ~13 s each from a
   laptop to Neon (us-east-2), so the sequential default would take hours for the 837; with 12 workers it took about
   15 minutes. Each product is still its own transaction, and a clash on a brand or slug created by another worker a
   moment earlier is retried.

## Undoing it

`psql "<target>" -v ON_ERROR_STOP=1 -f scripts/pmd/rollback-promotion.sql` removes the products promotion created, except
any a shop has already selected (they are reported and kept). It deletes rows rather than soft-deleting them, because the
catalogue's GTIN unique index ignores `deleted_at` and a soft-deleted product would block promoting it again. Audit rows and
created brands stay. `scripts/pmd/rollback-0015.sql` drops the whole `pmd` schema and is much more destructive - back up first.

## Done on the staging (test.gokesari.com) database, 2026-09-21

Backup (psql `\copy` of every table, because pg_dump 16 cannot dump the server's Postgres 18) -> migration 0015 -> `copy-pilot-data.ps1` -> 837 products promoted at quality 60 or above, **without images**. Afterwards: 1,212 catalogue products (375 existing + 837), 837 links and audit rows, 470 brands with no duplicates, users/shops/shop listings unchanged. The live site was not touched.

## Not verified

The deploy trigger for either site (the test site was not serving the Product Master routes when checked); which pages read `public.products`.
