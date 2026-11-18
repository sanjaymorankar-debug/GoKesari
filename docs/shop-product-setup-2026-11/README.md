# Set up your shop's products (owner brief, 08-Nov-2026)

The owner's "Product categories" page became a guided flow at `/shop/product-categories`:
choose categories → add products (on screen or Excel) → set stock and price.
`/shop/my-products` shows every listing by status and takes updates at any time.

## Rules

- Adding a category lists nothing. The earlier rule (every product at stock 100, `catalogue.categoryFillStock`) is gone.
- Status comes from one rule, `src/lib/listing-status.ts`: Live, Needs Stock, Needs Price, Out of Stock, Paused.
- `shop_products.stock_pending`: added with no quantity. Any stock, or a typed 0, ends it.
- `shop_products.owner_paused`: the owner stopped selling it. `is_available` cannot hold this because it follows the stock (`evaluateStockAlerts`).
- Customers see only Live listings (`storefrontLive` in `catalogue.ts`). Sold-out listings are therefore no longer shown on the storefront.
- There is no availability event to publish: since the database split was removed, customer pages read `shop_products` live, so a committed change is visible on the next request.
- A shop's own MRP is stored in `shop_listing_details.mrp_paise`; the master and other shops never change.

## Excel / CSV (`src/server/services/shop-bulk-upload.ts`)

Upload → background check → preview → the owner confirms → applied in batches of 200, each row in its own savepoint.
Rows match on Product ID only. Limits come from rule `productImport` (5,000 rows, 10 MB). Confirm is safe to repeat, and the same file is refused for 24 hours after an import.
An unknown Product ID (error `code: "UNKNOWN_PRODUCT"`) links to the add-new-product form (`addProductPath`, `src/lib/shop-setup-links.ts`): next to the row in the preview, and in an "Add new product" column of the error file.

## Several shops

These pages work on the shop named by `?shop=`, else the one chosen in the top bar's switcher (cookie `gk_shop`). Opening a link to another of the owner's shops also sets the cookie (`ShopUrlSync`), so the top bar follows the page. Choosing a shop in the switcher on such a page reopens it without `?shop=`. On phones the in-page shop list is hidden; the top bar's switcher does that job.

## Apps

The Android and iPhone apps show this site in a WebView, so the flow reaches them with the web release. Files use `Content-Disposition: attachment` links and a normal file input, which the apps already pass to the share sheet and the device file picker.
