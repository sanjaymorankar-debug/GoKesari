# Copy shops from test to production (11 Oct 2026)

The owner asked to copy only the real shops registered on test.gokesari.com to
gokesari.com, leaving test's E2E and QA test shops behind:

| Shop | Test number |
|---|---|
| Agtci | BKS-000001 |
| Asmy Exports | BKS-000004 |
| Chikan Shop | BKS-000007 |
| EcoMed Solutions | BKS-000013 |
| Samarth tea center | BKS-000018 |

Workflow **"Copy shops to production"** (`.github/workflows/copy-shops.yml`),
script `scripts/copy-shops/copy-shops.ts`. By hand only, from `main`.

## What comes across

| Comes across | Stays on test |
|---|---|
| The owner's account: matched to an existing production account by e-mail or phone, otherwise created; the shop-owner role | Orders, payments, wallet balances and ledgers, invoices, sessions |
| The shop, with a **new registration number** from production's own sequence; status, address and map location kept | Test-only records: referral codes, registrations, registration-fee payments |
| Shop categories, the products it sells (matched to production's catalogue by id, barcode or exact name and size; otherwise added with a new production product code), prices, stock and sale settings, product-category choices | Admin or operator roles held on test |
| Photos, bytes included (photos kept on test's disk are fetched from the test site and checked against their checksum) | The PAN number and legal-document files: they are encrypted with the test site's key and cannot be read on production. The PAN's last four digits come across. Production asks each owner to upload their legal documents, with the usual grace period, the first time the shop's documents are opened |

Safety:
- A shop already on production is skipped, so running it again copies nothing twice. "Already on production" means the same shop id, the same name in the same PIN code, or the same Shop Act registration.
- Everything is saved in one transaction: all shops or none.
- Every copied shop gets an audit-log entry, `shop.copied_from_test`.

## Before the first run (once)

GitHub → Settings → Secrets and variables → Actions:
- **`PROD_DATABASE_URL` must be visible to a job outside the `test` environment.** Put it under *Repository secrets*, or as a secret of a `production` environment. The copy job runs in `production`, so it sees both. A secret saved only in the `test` environment cannot be seen there.
- **Recommended:** the `PROD_DATABASE_HOST` and `PROD_DATABASE_NAME` variables. With them set, a wrong URL is caught. Without them, the run prints the target host and database, and you check them yourself before running `copy`.
- The test values stay where they are (`TEST_DATABASE_URL`, `TEST_DATABASE_HOST` and `TEST_DATABASE_NAME` in the `test` environment).

## Running it

1. **Actions → Copy shops to production → Run workflow**, branch `main`, mode
   **plan**. It does the whole copy on production and rolls it back. The run
   summary lists each shop's new registration number, the owner matching, the
   products added or matched, and the photos. Production is not changed.
2. If the plan is right, run again with mode **copy** and confirm
   `COPY SHOPS TO PRODUCTION`. The summary records a restore point (time and
   LSN) first.
3. To undo: Neon console → the production project → Restore → the restore
   point's time (see `docs/event-driven-2026-10/PROD_DB.md`).

Each run passes the export between its two jobs as a private artifact kept for
one day. It holds the shops' owner contact details and photos and nothing
else.

## Without GitHub access to production: SQL files for the Neon console

Use this when the workflow cannot see `PROD_DATABASE_URL`. Mode **sql** reads
the test database as usual. Instead of connecting to production, it turns the
export into two SQL files, made by `scripts/copy-shops/to-sql.ts` from
`copy-shops.sql.tpl`. They follow the same rules as plan/copy, carried out
inside the database.

1. **Actions → Copy shops to production → Run workflow**, branch `main`, mode
   **sql**. When it finishes, download **copy-shops-sql** under *Artifacts* on
   the run page and unzip it. It is kept for 3 days and holds the shops'
   owner contact details, so delete it afterwards.
2. **Neon console → the production project → SQL Editor**, database `neondb`:
   paste and run `copy-shops-1-PREVIEW.sql`. It does the whole copy and undoes
   it, then lists what would happen (new registration numbers, owner matching,
   products added or matched). Production is not changed, and its sequences are
   not used up.
3. If that is right, note the time, then run `copy-shops-2-APPLY.sql`. Any
   error leaves production as it was. Running it again copies nothing twice.
   To undo it, restore to the time you noted (Neon → Restore).

The files can also be run with `psql "<production URL>" -f <file>`.

## After copying

- Admin → Shops on gokesari.com lists the shops under their new numbers.
- Owners sign in on gokesari.com with the same e-mail or phone as on test.
- Owners upload their legal documents when production asks.
- The wallet starts at ₹0 on production (test balances came from sandbox
  payments). Where the shop-wallet rule is on, a shop takes orders once its
  wallet reaches the minimum.

## Result: copied 12–13 Oct 2026

GitHub Actions could not see `PROD_DATABASE_URL`: nine plan/verify runs on 11–12 Oct all stopped at the guard with an empty value. The SQL route was used instead.

1. Mode **sql**, run 38283470072 (12 Oct, 17:19 UTC), made the files from the
   test export of the 5 shops.
2. The owner ran `copy-shops-1-PREVIEW.sql` in the Neon console against
   production, then `copy-shops-2-APPLY.sql`, which reported "SAVED".
3. Checked on gokesari.com at 15:32 UTC, 13 Oct. All checks were read-only, with no sign-in:

| Shop | Products with prices (test → production) | Shop page | Nearby from Kharadi | Taking orders |
|---|---|---|---|---|
| Agtci | 26 → 26 (e.g. Badam Milk ₹100) | 200, products shown, "Open now" | 830 m | yes |
| Asmy Exports | 6 → 6 | 200 | 2.2 km | yes |
| Chikan Shop | 8 → 8 | 200 | 540 m | yes |
| EcoMed Solutions | 0 → 0 (no products on test either) | 200 | 6.1 km | yes |
| Samarth tea center | 4 → 4 | 200 | 1.7 km | yes |

- The public shop list shows 7 shops: the 5 copied, plus production's two "Asmy super market" shops.
- Nearby found 5 shops within 10 km of Kharadi (1 km: 2, 3 km: 4, 5 km: 4, 10 km: 5). Before the copy it found none, because production's two shops have no map location.
- `/`, `/shops` and `/search?q=milk` return 200.

**Still to do (owner):**
- Reset the production database password. It was posted in a chat on 12 Oct. Neon → Roles → `neondb_owner` → Reset password, then update `DATABASE_URL` in hPanel.
- Delete the downloaded `copy-shops-sql` files. They contain the owners' contact details.
- Ask the 5 owners to sign in on gokesari.com and upload their legal documents when asked.
