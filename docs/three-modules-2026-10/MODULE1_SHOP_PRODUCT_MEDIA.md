# Module 1 — shop product photos and descriptions

**Site:** test.gokesari.com (`staging`). Production is not touched.
**Migration:** `0065_shop_product_media` (additive) · rollback `scripts/rollback-0065.sql`
**Plan:** [PLAN.md](PLAN.md) §2

## What a shop owner (or their staff) can do

For every product in their shop:

| | |
|---|---|
| Photos | Up to **5** (rule `shopProductMedia.maxPhotos`). **Take photo** opens the phone camera, **From gallery** the photo library. Drag by the ⠿ handle (works with a finger) or use ← →; the **first photo is the main photo**. |
| Short description | Up to 160 characters, shown under the product name on product cards. |
| Long description | Up to 4,000 characters, shown on the product page opened from the shop. |
| Fallback | Anything the shop has not set shows the master product's photo / description. "Use GoKesari's description" clears the shop's own text. |
| Bulk | One ZIP of photos named by product code or barcode, plus/or one CSV of descriptions — checked first, then applied. |
| Staff | The owner adds people by mobile number or email (`/shop/staff`); they can only edit photos and descriptions of that shop. |
| History | Every change, with who made it (owner, staff or GoKesari support) and when. |

Pages: `/shop/products/{listingId}/media` (editor), `/shop/media-import` (bulk),
`/shop/staff` (owner), `/shop/staff-access` (staff's way in). The photo
catalogue's tiles now upload through the same pipeline and link to the editor.

## What the server does with every photo

1. Refuses anything over **5 MB** (checked on the request size before reading, and again on the bytes).
2. Reads the **real type from the bytes** — JPEG, PNG or WebP — and makes the image decoder confirm it; a renamed `.exe`, a GIF or a file that only starts like a JPEG is refused.
3. Refuses a photo with more than 50 million pixels before decoding it (decompression bombs) and one under 100 px a side.
4. Applies the camera's EXIF rotation, then **drops all metadata** (GPS position, camera, timestamps).
5. Makes three **WebP** copies — 200, 600 and 1,200 px on the longest side, never enlarged. The original file is not kept.
6. Stores them **outside the web root** with **random names**: in `MEDIA_DIR` (`ab/cd/<32 hex>.webp`, files 0600, folders 0700) when set, otherwise in the database as before. Files are only ever served through `GET /api/images/{id}?size=thumb|medium|large`, with the same access rules as before and an `ETag` (a browser revalidating gets a 304 without the bytes).

Uploads to the same product are serialised by a row lock, so the 5-photo cap
holds even when several uploads arrive at once. If the database step fails,
the files just written are deleted again; when a photo is removed, its files
are deleted shortly after the transaction commits (only if nothing refers to
them).

## Bulk ZIP + CSV

* File names: `P00012.jpg`, `P00012_2.jpg` (2nd photo), `8901234567890.png`. Matching: product code (SKU), then GTIN, then barcode — only this shop's products.
* CSV columns: `sku_or_barcode`, `short_description`, `long_description` (header names are flexible; an empty cell leaves that text as it is). Template download on the page.
* **Check** shows each file/row as Ready, Not found, Cannot use (with the reason), Duplicate or Skipped, and which products' photos would be replaced. Nothing changes yet.
* **Apply** runs straight after the click (Next.js `after()`), one product per transaction; progress refreshes every 2 s. If the server restarts mid-way, **Resume** continues and skips finished products. The uploader gets a notification when it ends.
* Photo mode: **Replace** (default — the ZIP's photos become the product's photos) or **Add** (up to 5).
* Limits (rule `shopProductMedia`): ZIP 50 MB / 500 photos, CSV 5,000 rows. A ZIP entry that would unpack past 5 MB is refused without unpacking it.

## Who may edit

| Who | How they get access |
|---|---|
| Shop owner | owns the shop |
| Staff | an active row in `shop_staff` for that shop — added/removed by the owner; they keep their own account and role |
| GoKesari support | operators/admins (`SHOP_PRODUCT_MANAGE_ANY`), audited as `SUPPORT` |

Anyone else — including another shop's owner or staff — gets 403; another
shop's product through this shop's URL is 404. `requireShopAccess` is not
changed: staff access exists only on these routes.

## API

| Method & path | |
|---|---|
| `GET /api/shops/{id}/listings/{listingId}/media` | Photos, descriptions, master fallback, what customers see, limits |
| `PATCH /api/shops/{id}/listings/{listingId}/media` | `{ shortDescription?, longDescription? }` — `null`/`""` clears |
| `POST /api/shops/{id}/listings/{listingId}/media/photos` | multipart `file` (+ optional `replaceImageId`) → 201; 422 `details.reason`: `PHOTO_TOO_LARGE`, `PHOTO_BAD_TYPE`, `PHOTO_UNREADABLE`, `PHOTO_TOO_SMALL`, `PHOTO_TOO_MANY_PIXELS`, `PHOTO_LIMIT` |
| `PUT /api/shops/{id}/listings/{listingId}/media/photos/order` | `{ imageIds }` — each once; first = main |
| `DELETE /api/shops/{id}/listings/{listingId}/media/photos/{imageId}` | |
| `GET /api/shops/{id}/listings/{listingId}/media/history` | Who changed what, newest first |
| `GET·POST /api/shops/{id}/media-imports` | List · upload `zip`/`csv`/`photoMode` → preview |
| `GET·DELETE /api/shops/{id}/media-imports/{importId}` | Preview/progress · cancel |
| `POST /api/shops/{id}/media-imports/{importId}/apply` | 202, applies after the response; resumes a stalled apply |
| `GET /api/shops/{id}/media-imports/template` | CSV template |
| `GET·POST /api/shops/{id}/staff` · `DELETE /api/shops/{id}/staff/{staffId}` | Owner manages staff |
| `GET /api/images/{id}?size=` | Existing route; new optional `size` |

Rate limits: 60 photo uploads / 10 min, 10 bulk uploads / hour, 20 staff additions / hour per user.

## Database (0065)

`shop_products` + `short_description`, `long_description`, `content_updated_at`, `content_updated_by` ·
`stored_images` + `storage` (`DB`/`DISK`), `storage_key`, `data` nullable (CHECK: one of them) ·
new `stored_image_variants`, `shop_staff`, `shop_media_imports`, `shop_media_import_items`.

Audit actions: `shop_product.media_changed`, `shop_product.description_changed`,
`shop_media_import.applied`, `shop_staff.added`, `shop_staff.removed`.
Notifications: `shop.staff_added`, `shop.staff_removed`, `shop.media_import_finished`.

## Configuration

| Setting | Where | Default |
|---|---|---|
| `MEDIA_DIR` | env (hPanel) | unset = photos in the database. **Decision (8 Oct): set it on Hostinger.** |
| Photos per product, size, sizes, quality, text limits, ZIP/CSV limits | Admin → Business rules → `shopProductMedia` | 5 · 5 MB · 200/600/1200 · 80 · 160/4000 · 50 MB/500/5000 |
| Image moderation (existing) | `imageModeration.enabled` | off |

## Tests

`tests/integration/shop-product-media.test.ts` — 26 cases, real PostgreSQL and the real image library:

* **Photo upload limits:** 5 MB + 1 byte refused (service and route), a sixth photo refused, three uploads racing for the last place → exactly one wins, `.exe` renamed `.jpg` refused with nothing stored, GIF refused, PNG named `.jpg` accepted, a fake JPEG header refused, too small, too many pixels, the older listing route also capped at 5.
* EXIF marker present in the upload and absent from all three WebP copies; sizes ≤ 1200/600/200; never enlarged; ETag → 304.
* Access: owner, staff and operator allowed; stranger, another shop's owner and revoked staff refused; another shop's product → 404; staff cannot add staff.
* Master fallback, description cleaning and limits (422), reorder and main-photo promotion, change history with who/as what.
* Disk storage: random key pattern, mode 0600, not under `public/`, served at the right size, files removed after deletion, path traversal refused.
* Bulk: SKU and GTIN matching, positions, not found / invalid / duplicate / over-limit, REPLACE removes old photos, ADD stops at 5, ZIP-bomb entry refused unpacked, too many files, cancel, resume guard (409 while applying / after applied).

## Deployment — test.gokesari.com

1. **Hostinger media folder.** In hPanel → File Manager (or SSH) create a folder in the account's home, **outside** `public_html` and outside the app's deploy directory, e.g. `/home/<user>/gokesari-media-test`. Note its absolute path.
2. hPanel → the test site's Node.js app → Environment variables: add `MEDIA_DIR=/home/<user>/gokesari-media-test`. (Leave it unset to keep photos in the database.)
3. Merge the PR into `staging`. The "Test database" workflow backs up and applies 0065 (it watches `drizzle/**`); check its run is green and the newest migration matches the journal.
4. Hostinger rebuilds: `npm ci` installs `sharp` (a prebuilt binary for Linux x64). If the build log shows a sharp install error, stop and tell me.
5. Smoke test on a phone:
   - `/shop/catalogue` → a product → **Photos & description** → **Take photo** → photo appears as *Main photo*.
   - Add a second photo from the gallery, drag it first → the shop page shows it on the card.
   - Upload a 6 MB photo → "at most 5 MB". Add a 6th photo → refused.
   - Save a short and long description → the product card shows the short one; the product page (tap the product name) shows the long one.
   - `/shop/staff` → add a test customer by mobile → sign in as them → **Shops I help with** → edit a photo → history shows them as *staff*.
   - `/shop/media-import` → upload a small ZIP (`<code>.jpg`) and the CSV template → Check → Apply → done.
6. **Redeploy test** once more (any small merge) and check the photos still load — this proves `MEDIA_DIR` survives a Hostinger redeploy. If they vanish, the folder is inside the deploy directory: move it and repeat.
7. Add `MEDIA_DIR` to the server backup alongside the database (Hostinger backups cover the home directory; confirm the folder is included).

## Deployment — production (gokesari.com), later

Do not start until test step 6 has passed.

1. Create the production media folder (separate from test), e.g. `/home/<user>/gokesari-media`, outside `public_html` and the deploy directory; include it in backups.
2. Set `MEDIA_DIR` on the production app.
3. Back up the database. **Apply 0065 before deploying the code** (`npm run db:migrate`, or the production database workflow), then deploy. 0065 is additive: the current production build keeps working on a migrated database.
4. Smoke test as in test step 5 with a real shop that has agreed to help.
5. Rollback: deploy the previous build; if photos were stored on disk, run `DATABASE_URL=… MEDIA_DIR=… npx tsx scripts/media-to-db.ts --apply` (copies them into the database), then `scripts/rollback-0065.sql`, then delete the 0065 row from `drizzle.__drizzle_migrations`.

## Assumptions

* Staff are existing GoKesari accounts (they sign in once first); staff get photos and descriptions only — no prices, stock or orders.
* Operators/admins can also edit a shop's photos for support; every such change is labelled *GoKesari support* in the history.
* The shop's own photos and text are shown wherever the shop's product is shown; the product page shows them when opened from the shop (`?shop=`), otherwise the master's.
* The old, unused `shop_products.description` column is left as it was.
* Photos uploaded before this release keep working at their single size (no copies are made for them).
