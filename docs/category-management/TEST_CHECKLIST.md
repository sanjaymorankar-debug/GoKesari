# Category management — test checklist (test.gokesari.com)

Use one account per role: **Admin**, **Operator**, **Shop Owner A** (owns
Shop A), **Shop Owner B** (owns Shop B), and a **Customer**. Tick each line;
note the product IDs used. ✅ = automated in
`tests/integration/product-categories.test.ts` (run on every CI build).

## 1. Category master (`/product-categories`)

| # | Role | Steps | Expected | Auto |
|---|---|---|---|---|
| 1.1 | Admin, Operator, Shop Owner | Open Category Master | List loads; **General** first with "Permanent"; product and shop counts shown | ✅ |
| 1.2 | Customer | Open `/product-categories` | Redirected home; API returns 403 | ✅ |
| 1.3 | Each of Admin/Operator/Owner | Add "Test Cat <role>" | Appears; "added … by <name>" shown | ✅ |
| 1.4 | Any | Add "test cat admin" (different case) | Refused: already exists | ✅ |
| 1.5 | Any | Add a 1-letter name | Refused: 2–80 characters | |
| 1.6 | Admin | Remove a category with products and shops | Confirmation shows N products → General, M shops; after confirming, products are in General, the category is gone from every shop | ✅ |
| 1.7 | Admin | Remove a category whose products are listed by a shop without General, box ticked | That shop gets General; its listings stay on sale | ✅ |
| 1.8 | Admin | Same, box **unticked** | Listings pause on the storefront; still visible (flagged "Paused") on the owner's product list | |
| 1.9 | Admin, Operator | Try to remove / rename / deactivate **General** | No buttons in the UI; API returns 403; DB trigger refuses raw SQL | ✅ |
| 1.10 | Shop Owner A | Remove a category A created that only Shop A carries | Allowed | ✅ |
| 1.11 | Shop Owner A | Remove a category created by staff, or one Shop B also carries | Refused (403) | ✅ |
| 1.12 | Admin | Deactivate a category | Stays on shops that have it; cannot be newly added to a shop or chosen for a product | |
| 1.13 | Admin | Audit log | `product_category.created/updated/removed` rows with actor and time | ✅ |

## 2. Shop ↔ category (`/shop/product-categories`, `/admin/shops/{id}/product-categories`)

| # | Role | Steps | Expected | Auto |
|---|---|---|---|---|
| 2.1 | Shop Owner A | Add category "Bakery" to Shop A | Success message; "Products visible" count rises by Bakery's product count | ✅ (browser-checked) |
| 2.2 | Shop Owner A | Add the same category again | Not offered in the picker; API is a no-op (no duplicate row) | ✅ |
| 2.3 | Shop Owner A | Remove "Bakery" from Shop A | Confirmation shows how many listings pause; after: Bakery products no longer visible | ✅ |
| 2.4 | Shop Owner A | Call the API for Shop B (`POST /api/shops/<B>/product-categories`) | 403, nothing changes | ✅ |
| 2.5 | Shop Owner A with two shops | Switch shop at the top of the page | Each shop's own categories; another owner's shop id in `?shop=` is ignored | |
| 2.6 | Operator, Admin | Add/remove a category on any shop | Allowed | ✅ |
| 2.7 | Admin | Audit log | `shop.product_category_added/removed` rows with actor, shop and category | ✅ |

## 3. Product visibility

| # | Steps | Expected | Auto |
|---|---|---|---|
| 3.1 | Shop A carries exactly categories A and B | Shop's visible products = exactly the products in A and B (search and category filter only narrow it) | ✅ |
| 3.2 | Add a new product to category A (any route) | Immediately visible to every shop carrying A, not to others; no per-shop step | ✅ |
| 3.3 | Move a product into A (staff, Products by category page) | Visible to shops carrying A; shops listing it start carrying A | ✅ |
| 3.4 | Shop A "Add Existing Product" search | Shows only products in Shop A's categories, not already listed | |
| 3.5 | Remove a category from Shop A that has a listing with past orders | Listing hidden from customers and cannot be added to cart/checked out; the old order and its items are unchanged | ✅ |
| 3.6 | Add the category back | Listing is on sale again with its old price and stock | ✅ |
| 3.7 | Excel GOODS upload for a product in a category the shop does not carry | Row refused with "does not carry" message | ✅ |

## 4. Product add / edit

| # | Steps | Expected | Auto |
|---|---|---|---|
| 4.1 | Shop Owner: Create New Product | Category is required, pre-selected to General | |
| 4.2 | Create via API without `categoryId` | Product is in General; shop now carries General | ✅ |
| 4.3 | Create in category X the shop doesn't carry | Shop now carries X (audited) | ✅ |
| 4.4 | Shop Owner: move a published product | Refused (403) | ✅ |
| 4.5 | Excel GOODS upload with blank Category | Product created in General | |

## 5. One-time categorisation

| # | Steps | Expected |
|---|---|---|
| 5.1 | Dry run | Report lists every product with old and proposed category; nothing changes in the DB |
| 5.2 | Apply with a wrong hash, or after editing the CSV without re-approving | Refused |
| 5.3 | Apply with the approved hash | Backup schema created first; counts match the report |
| 5.4 | After apply | Zero products without a live category (SQL in README); shops still see everything they saw before |
| 5.5 | Restore from the backup | Products, categories and shop links back exactly as before |

## 6. "Uncategorised" is gone

| # | Steps | Expected |
|---|---|---|
| 6.1 | `/admin/product-master` dashboard | The unmapped bucket reads "General"; no "Uncategorised" text (✅ automated) |
| 6.2 | Category Master, shop pages, product forms | No "Uncategorised" anywhere; General shown instead |
