# Image and banner audit — 26-Nov-2026

Started 26-Nov-2026 10.50 IST. Audit data read (read-only) from both databases at 11.02 IST.
Full list: [IMAGE_AUDIT_2026-11-26.csv](IMAGE_AUDIT_2026-11-26.csv) (one row per product per site).

## Product images

| | gokesari.com | test.gokesari.com |
|---|---|---|
| Products in the master | 596 | 1,751 |
| No image at all (issue 1) | 97 | 1,252 |
| Share one of 15 generic puja pictures (issues 2, 3, 7) | 499 | 499 |
| Real product photos | **0** | **0** |
| Shop-owner uploads | 0 | 1 (Butter Khari, 600×600, pending moderation: low resolution, issue 4) |
| Broken image links (HTTP 404) | 0 (all 15 SVGs return 200) | 0 |

Products with no image on gokesari.com, by shop type: Newspaper 51, Dairy 26, Meat 8,
Convenience 3, Grocery 3, Bakery 2, General 2, Restaurant 2.

The 499 puja products use 15 category illustrations (`/images/puja/*.svg`). Each one stands
for 16–71 different products (for example, one agarbatti picture covers 71 products), so none
shows the exact item, brand or pack size. They are coloured tiles, not photos on white.

Issues 4–6 (blur, watermark, empty space) do not apply: there are no photos to check. The SVGs
are vector images, with no watermarks or third-party logos.

### What was fixed in code (PR into `staging`)

- Product cards and home tiles show the whole image (`object-contain` on white), so square
  images are never cropped or stretched.
- Home product tiles had empty alt text. They now use the product name, which already holds the
  brand and pack size (e.g. "Zed Black Agarbatti (3-in-1) – Pack").
- Products with no image show their category's icon. Puja, hardware, agriculture, newspaper and
  restaurant goods used to fall back to a shopping bag; they now get 🪔 🧰 🌱 📰 🍽️.
- Images were already lazy-loaded (`SafeImage`), with a fallback when one fails to load.

### What was NOT done, and why

**No product image was replaced.** Replacing needs a real photo of each exact product
(manufacturer pack shot, licensed stock, or the shop owner's own photo). Scraping is ruled out
by the brief and by copyright. A generated picture cannot truthfully show a brand's pack and
size. 596 products on prod need one of:

1. a licensed manufacturer / distributor image feed, loaded through the existing product-master
   image pipeline (`src/server/pmd/images.ts`, which already resizes to WebP);
2. shop owners uploading their own photos (existing upload + moderation flow);
3. a photo shoot for loose goods (rice, dal, sugar, flowers, etc.).

This needs the owner's decision on the source.

## Banners

| Banner | Before | After |
|---|---|---|
| Fresh every morning (DEAL) | one 🥛 on empty right half | 🥛 🍞 🥚 🧈 — daily needs, filling the panel |
| Daily milk, delivered (SEASONAL) | **🪔 diya — off-subject** | 🥛 🧈 🧀 🍦 — dairy only |
| Compare prices (shown only while price comparison is on) | ⚖️ | ⚖️ 🏷️ 🏪 💰 |
| Admin banners with no photo | one emoji per banner *kind* | pictures from the banner's subject (shop type it links to, then its words) |

Home banners from Admin → Home banners: none on either site (0 rows). The layout was already
responsive (fixed height per breakpoint, text on its own solid gradient, never over a photo).
The first slide loads eagerly and the rest lazily.

Category tiles (Dairy 🥛, Bakery 🍞, Grocery 🍚, Fruits & Veg 🥬, Sweets 🍬, Pharmacy 💊,
Household 🧴, Puja Samagri 🪔, All 🔎): each icon matches its category, so no change.

## Mobile apps

The Android and iOS apps are WebView shells around the website (`mobile/src/App.tsx`), so the
new banners, icons and image display reach both apps on their next page load, with no store
build. The app's own images (icon, splash) are the GK logo and were not part of this change.

## Owner decision, 26-Nov-2026 11.10–11.15 IST: where real photos come from

A manufacturer image comes first. Where a product has none, the shop owner uploads a photo, and
once approved it replaces the sample picture for that shop's customers. No product has a
manufacturer image today (`pmd.product_image` is empty on both sites), so every product is open to
shop uploads. This was already how the code worked: a listing's approved photo takes priority
over the master's (`listingImage ?? productImage`).

Added to PR #603 (11.25 IST):
- **My products:** "N of your products show no photo or only a sample picture" with a "Show these"
  filter, plus a "No photo — add one" / "Sample picture — add your photo" badge on each such row.
  Both link to the product's photo page.
- **Photo page:** tips for the photo (real product, filling most of a square frame, plain light
  background, at least 800 × 800 px, no watermarks or other websites' logos).
- The upload minimum is still the admin rule's 100 px, so uploads that work today are not
  rejected. Uploads are already converted to WebP (1200 / 600 / 200 px) and checked by an admin
  before they go live.
