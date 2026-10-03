# Product category management

How products are organised by category, how shops see them, and how to roll
this out on **test.gokesari.com first** (production only after approval).

## What changed

| Piece | Where |
|---|---|
| Category master (`product_categories`): unique names ignoring case, created by/at, active flag, permanent **General** | `src/server/services/product-categories.ts`, migration `drizzle/0039_product_category_management.sql` (numbered 0038 before the merge with main) |
| Shop ↔ category links (`shop_product_categories`, unique per shop + category) | same |
| A shop sees every APPROVED product in the categories it carries — computed at query time, so products added later appear with no extra step | `listProductsVisibleToShop`, `suggestProductsForShop` |
| Removing a category from a shop pauses that shop's listings in it (hidden from customers, not purchasable); listings, orders and history are untouched, and re-adding restores them | `shopCarriesProductCategory` in the storefront and checkout queries |
| One-time categorisation of every existing product (dry run → approval → apply, with backup and restore) | `scripts/categorise-products.ts`, rules in `src/server/services/product-categorisation.ts` |
| Rollback of the schema change | `scripts/rollback-0038.sql` |

The existing **Shop categories** screen (`/admin/shop-categories`) is a
different thing — the *kind of business* a shop is — and is unchanged.

### Who can do what (enforced on the server)

| Action | Admin | Operator | Shop owner |
|---|---|---|---|
| Browse categories and all products in them | ✓ | ✓ | ✓ |
| Add a category | ✓ | ✓ | ✓ |
| Edit / deactivate / remove a category | any | any | only one they created **and** no other owner's shop carries |
| Remove or rename **General** | ✗ | ✗ | ✗ (also blocked by a database trigger) |
| Add / remove a category on a shop | any shop | any shop | own shop(s) only |
| Change a product's category | any | any | own product still awaiting approval |

Every add/remove of a category or a shop link is written to `audit_logs`
(`product_category.*`, `shop.product_category_*`, `product.category_changed`)
with who and when.

### Screens

- **Category Master** — `/product-categories`
- **Products by category** (Product Master filter) — `/product-categories/products?category=…&q=…`
- **Shop categories** — owner: `/shop/product-categories`; operations: `/admin/shops/{id}/product-categories`
- Product create form: Category is required and defaults to General.

### API

| Method | Path | |
|---|---|---|
| GET | `/api/product-categories?q=&all=1` / `?selectable=1` | list (with counts) / picker list |
| POST | `/api/product-categories` | `{ name, description?, department? }` |
| PATCH | `/api/product-categories/{id}` | `{ name?, description?, isActive?, department? }` |
| GET | `/api/product-categories/{id}/impact` | products/shops/listings a removal affects |
| DELETE | `/api/product-categories/{id}?keepListingsVisible=0` | remove (products → General) |
| GET | `/api/product-categories/products?q=&categoryId=&offset=` | browse the catalogue |
| GET / POST | `/api/shops/{id}/product-categories` | a shop's categories / `{ categoryId }` |
| GET / DELETE | `/api/shops/{id}/product-categories/{categoryId}` | listings that would pause / remove |
| GET | `/api/shops/{id}/visible-products?q=&categoryId=` | what the shop sees |
| PATCH | `/api/products/{id}/category` | `{ categoryId, keepListingsVisible? }` |

## Rollout on test.gokesari.com

1. **Deploy** the `staging` branch to test and apply the migration:
   `DATABASE_URL=<test> npm run db:migrate`.
   The migration creates General, de-duplicates category names that differ
   only in case (renamed, never merged — originals kept for rollback), and
   links every shop to its department's categories plus the categories of
   everything it already lists, so **no shop loses a product or a listing**.
2. **Dry run** (read-only — Postgres refuses any write):
   `DATABASE_URL=<test> npm run categorise:products -- --out ./categorisation-reports/test`
   Send `report.xlsx` for approval: per product ID/name, old → proposed
   category (and the subcategory that keeps the old detail, e.g. Dairy →
   Milk), the evidence, a count per category, categories to create/retire, and
   the shop links that will be added.
   To override a proposal, edit `proposed_category` in `report.csv` before
   approving — the hash printed covers the file you approve.
3. **Apply** exactly the approved file:
   `DATABASE_URL=<test> npm run categorise:products -- --apply --report <report.csv> --approve <sha256> --actor <admin email>`
   It refuses if the file changed, if any product changed category or was
   added since the dry run, then copies `products` (ids/categories),
   `product_categories`, `product_subcategories` and `shop_product_categories`
   into a new schema `backup_categorise_<timestamp>` before changing anything.
   A shop that carried an old category also carries every category its
   products moved to, so nothing a shop saw disappears.
4. **Verify** with the test checklist (`TEST_CHECKLIST.md`). Zero products
   without a category:
   ```sql
   SELECT count(*) FROM products p JOIN product_categories c ON c.id = p.category_id
    WHERE p.deleted_at IS NULL AND c.deleted_at IS NOT NULL;   -- must be 0
   ```
5. Production: repeat 1–4 only after approval.

## Undo

- Undo the categorisation: `npm run categorise:products -- --restore backup_categorise_<ts> --actor <email>`
- Undo the schema change (after undoing the categorisation): run
  `scripts/rollback-0038.sql` in one transaction. Shops then go back to seeing
  products by shop type.
