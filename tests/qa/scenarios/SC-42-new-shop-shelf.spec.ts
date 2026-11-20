/**
 * SC-42 — a new shop fills its shelf: it says how it delivers and its radius, publishes the
 * starter shelf, scans one known and one unknown barcode, updates prices and stock with the
 * Excel file (some rows bad), and a customer browses the shop.
 *
 * Local tier: a fresh owner's approved shop at shop A's spot with one product category of its
 * own, its registration at the live step (lib/product-setup-helpers arrangeWizardDraft). The
 * barcodes are typed into the scanner's number field; the camera itself is manual.
 */
import { as, pageAs } from "../lib/actors";
import { db } from "../lib/db";
import { call, expectStatus, RUN } from "../lib/http";
import {
  arrangeWizardDraft,
  COL,
  newCategory,
  openStarterShelf,
  productWithBarcode,
  settledUpload,
  SETUP_HEADERS,
  setupListings,
  sheetRows,
  statusOf,
  uploadSetupFile,
  workbook,
} from "../lib/product-setup-helpers";
import { expect, need, qa } from "../lib/record";
import { approvedShopOfNewOwner, newMasterProduct, pageFor } from "../lib/sellers-helpers";
import { clearCart, fillCart, pointNorth, validateCart, withAddresses } from "../lib/shopping-helpers";
import { world } from "../lib/world";

qa("SC-42", "new shop fills its shelf: delivery radius, starter shelf, a known and an unknown barcode, an Excel update with bad rows, and the customer sees only Live listings within the radius", async ({ browser }) => {
  const steps: string[] = [];
  const made = await approvedShopOfNewOwner("sc42");
  const loc = need(world().location, "shop A's location in the world");
  await db()`
    update shops set latitude = ${String(loc.lat)}, longitude = ${String(loc.lng)}, location_verified = true,
      location_verified_at = now(), location_source = 'qa_seed', service_radius_km = 5, delivery_available = true
    where id = ${made.shop.id}`;
  const category = await newCategory("SC42 shelf");
  const shelf = [];
  for (let i = 0; i < 3; i++) shelf.push(await newMasterProduct({ name: `QA SC42 ${RUN} ${i}`, mrpPaise: 5000 + i * 1000, categoryId: category.id }));
  expectStatus(await call(made.ctx, "POST", `/api/shops/${made.shop.id}/product-categories`, { categoryId: category.id }), [200, 201], "the shop's one category");
  const pack = await productWithBarcode((await newCategory("SC42 scanned")).id, 4500);
  await arrangeWizardDraft(made.owner.id, made.shop.id);
  const unknown = `55${String(Date.now()).slice(-10)}`;

  const { context, page } = await pageFor(browser, made.owner);
  try {
    // 1. How the shop delivers.
    await page.goto("/shop/setup/delivery");
    await page.getByRole("radio", { name: /GoKesari delivery partners/ }).check();
    await page.getByTestId("delivery-radius").focus();
    await page.keyboard.press("Home");
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
    await expect(page.getByText("Deliver up to (km from your shop): 4 km")).toBeVisible();
    await page.getByTestId("delivery-save").click();
    await expect(page.getByRole("status").filter({ hasText: "Saved. Customers now see how you deliver." }).first()).toBeVisible();
    steps.push("GoKesari partners, 4 km");

    // 2–3. Starter shelf with a known and an unknown barcode.
    const list = await openStarterShelf(page);
    const scan = async (code: string) => {
      await page.getByRole("button", { name: "📷 Scan a barcode" }).click();
      await page.getByLabel("Barcode number").fill(code);
      await page.getByRole("button", { name: "Find", exact: true }).click();
    };
    await scan(pack.barcode);
    await expect(page.getByRole("status").filter({ hasText: `Added ${pack.name} at MRP ₹45.` }).first()).toBeVisible();
    await scan(unknown);
    const form = page.getByTestId("shelf-new-product");
    await expect(form).toContainText(`${unknown} is not in our catalogue yet.`);
    await form.getByLabel("Product name").fill(`QA SC42 unknown ${RUN}`);
    await form.getByLabel("Selling price").fill("30");
    await form.getByRole("button", { name: "Add product" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Sent to our team — it goes on sale in your shop once approved." }).first()).toBeVisible();
    await list.getByRole("button", { name: /^Publish \d+ products$/ }).click();
    await expect.poll(async () => (await setupListings(made.ctx, made.shop.id)).filter((l) => statusOf(l) === "LIVE").length, { timeout: 60_000 }).toBeGreaterThanOrEqual(4);
    steps.push(`shelf published with ${pack.name}; ${unknown} sent for approval`);
  } finally {
    await context.close();
  }
  const queue = await call(await as("admin"), "GET", "/api/products/pending-approval");
  expect(((queue.body.products ?? []) as { barcode: string | null }[]).some((p) => p.barcode === unknown), "the unknown barcode waits in the admin's queue").toBe(true);

  // 4. Excel update with bad rows.
  const mine = await made.ctx.get(`/api/shops/${made.shop.id}/product-setup/download?kind=mine&format=xlsx`);
  expect(mine.status()).toBe(200);
  const rows = await sheetRows(await mine.body(), "Products");
  const row = (name: string) => need(rows.find((r) => r[COL.name] === name), `${name} in my products`);
  const a = row(shelf[0].name);
  const b = row(shelf[1].name);
  const unk = `QA-NOPE-${RUN}`.toUpperCase();
  const edits = [
    [a[COL.id], null, null, null, null, null, null, "Yes", null, 45, null],
    [b[COL.id], null, null, null, null, null, null, "Yes", null, null, 12],
    [unk, null, null, null, null, null, null, "Yes", null, 10, 5],
    [row(shelf[2].name)[COL.id], null, null, null, null, null, null, "Maybe", null, null, null],
  ];
  const name = `qa-sc42-update-${RUN}.xlsx`;
  const up = await uploadSetupFile(made.ctx, made.shop.id, name, await workbook(SETUP_HEADERS, edits, name));
  expectStatus(up, 202, "upload the update");
  const preview = await settledUpload(made.ctx, made.shop.id, up.body.uploadId);
  expect(preview.errors.map((e) => e.message)).toEqual([
    `Product ID ${unk} is not in the GoKesari product list. Add it as a new product instead.`,
    "Include must be Yes or No.",
  ]);
  expectStatus(await call(made.ctx, "POST", `/api/shops/${made.shop.id}/product-setup/uploads/${up.body.uploadId}/confirm`, { confirmPause: false }), 202, "import the valid rows");
  const applied = await settledUpload(made.ctx, made.shop.id, up.body.uploadId);
  expect(applied.status).toBe("DONE");
  const listings = await setupListings(made.ctx, made.shop.id);
  const byProduct = (id: string) => need(listings.find((l) => l.productId === id), "listing");
  expect(byProduct(shelf[0].id).onlinePricePaise).toBe(4500);
  expect(Number(byProduct(shelf[1].id).onlineStock)).toBe(12);
  steps.push("Excel: 2 rows applied, unknown ID and Include = Maybe explained");

  // 5. The customer.
  const live = listings.filter((l) => statusOf(l) === "LIVE");
  const offered = await call(await as("customer"), "GET", `/api/shops/${made.shop.id}/products?limit=100`);
  expectStatus(offered, 200, "the shop's products as a customer");
  const ids = new Set((offered.body as { shopProductId: string }[]).map((r) => r.shopProductId));
  expect([...ids].sort(), "the customer sees exactly the Live listings").toEqual(live.map((l) => l.id).sort());
  const [{ slug }] = await db()<{ slug: string }[]>`select slug from shops where id = ${made.shop.id}`;
  const shopper = await pageAs(browser, "customer");
  try {
    await shopper.page.goto(`/shops/${slug}`);
    await expect(shopper.page.getByTestId("product-card").first()).toBeVisible();
    await expect(shopper.page.getByText(`QA SC42 unknown ${RUN}`)).toHaveCount(0);
  } finally {
    await shopper.context.close();
  }
  const item = { shopProductId: byProduct(shelf[0].id).id, name: shelf[0].name };
  await withAddresses("customer", [
    { ...pointNorth(3), line1: `QA SC42 3 km ${RUN}`, label: `QA SC42 3 km ${RUN}` },
    { ...pointNorth(6), line1: `QA SC42 6 km ${RUN}`, label: `QA SC42 6 km ${RUN}` },
  ], async ([near, far]) => {
    try {
      await fillCart("customer", [{ item, quantity: 1 }]);
      const inside = need((await validateCart("customer", near.id)).shops.find((s) => s.shopId === made.shop.id), "the shop in the cart check");
      const outside = need((await validateCart("customer", far.id)).shops.find((s) => s.shopId === made.shop.id), "the shop in the cart check");
      expect(inside.issues.map((i) => i.code), "3 km: delivered").not.toContain("NOT_DELIVERABLE");
      expect(outside.issues.map((i) => i.code), "6 km: outside the 4 km radius").toContain("NOT_DELIVERABLE");
    } finally {
      await clearCart("customer").catch(() => undefined);
    }
  });
  steps.push(`customer sees ${live.length} Live listings; 3 km delivered, 6 km not`);
  return steps.join("; ");
}, { tier: "local", timeout: 480_000, partial: "barcodes are typed into the scanner's number field; scanning with a phone camera is manual" });
