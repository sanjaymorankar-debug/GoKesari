/**
 * SC-38 — identity-first shop registration to the first sale (owner brief
 * 08-Nov-2026; DI-11, DI-12, DI-03, DI-13, PU-01 … PU-05):
 *   a new person opens /shop/register, verifies the GSTIN with consent,
 *   confirms the address, pins the shop, fills the shop details and turnover
 *   slab, pays the fee in the sandbox, sees the live screen and the e-mail,
 *   downloads the product template, uploads 10 products of which 2 are bad,
 *   fixes them, and a customer at the PIN orders, the shop fulfils and the
 *   rider delivers.
 *
 * Local tier: a fresh owner and customer, the mock KYC provider, the sandbox
 * fee page, the local mail catcher and the world's rider. The shop's map pin
 * is confirmed in the database as the local seed confirms shop A's (no Google
 * Maps key locally); the first sale uses the world's QA category, listed and
 * stocked through the owner's own set-up routes.
 */
import type { APIRequestContext } from "@playwright/test";

import { stockWholeCategory } from "../lib/category-stock";
import { db } from "../lib/db";
import { deliverToPerson, freeRider, freshPerson, personBuys } from "../lib/finance-helpers";
import {
  answerSandbox,
  homePlace,
  mailMatching,
  referralCode,
  registerInWizard,
  shopName,
  waitForLiveScreen,
  wizardOf,
  wizardPan,
  MAIL_SUFFIX,
} from "../lib/go-live-helpers";
import { call, expectStatus, RUN, why } from "../lib/http";
import { expect, need, qa } from "../lib/record";
import { ctxFor, filePart, freshAccount, gstinFor, needPanStorage, ownerListings, pageFor, uniqueMobile } from "../lib/sellers-helpers";
import { world } from "../lib/world";

interface Job {
  status: string;
  counts: { totalRows: number; newProducts: number; updates: number; errors?: number };
  errorMessage: string | null;
}

/** Uploads a CSV to the shop's product import and waits for its preview. */
async function upload(ctx: APIRequestContext, shopId: string, name: string, csv: string): Promise<{ jobId: string; job: Job }> {
  const res = await call(ctx, "POST", `/api/v1/shops/${shopId}/product-imports`, undefined, { multipart: { file: filePart(name, Buffer.from(csv), "text/csv") } });
  expect(res.status, `upload ${name} — ${why(res)}`).toBe(202);
  const jobId = res.body.jobId as string;
  return { jobId, job: await until(ctx, jobId, /^(preview_ready|failed)$/) };
}

async function until(ctx: APIRequestContext, jobId: string, done: RegExp): Promise<Job> {
  let job: Job | null = null;
  for (let i = 0; i < 60; i++) {
    const res = await call(ctx, "GET", `/api/v1/product-imports/${jobId}`);
    expectStatus(res, 200, "the upload's status");
    job = res.body as Job;
    if (done.test(job.status)) return job;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`the upload ${jobId} stayed "${job?.status}"`);
}

async function rows(ctx: APIRequestContext, jobId: string) {
  const res = await call(ctx, "GET", `/api/v1/product-imports/${jobId}/rows?status=all&page=1`);
  expectStatus(res, 200, "the upload's rows");
  return res.body.rows as { rowNumber: number; status: string; messages: string[] }[];
}

async function commit(ctx: APIRequestContext, jobId: string): Promise<Job> {
  const res = await call(ctx, "POST", `/api/v1/product-imports/${jobId}/commit`, {});
  expect(res.status, `import — ${why(res)}`).toBe(202);
  return until(ctx, jobId, /^(completed|failed)$/);
}

const HEADER = "Product Name,Category,HSN Code,GST %,MRP,Selling Price,Stock Qty,Unit,Loose Item (Y/N),Action";
const line = (cells: (string | number)[]) => cells.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",");

qa("SC-38", "identity-first registration to the first sale: verify GSTIN → address, pin, details → pay → live screen and e-mail → template, 10 products with 2 bad rows explained and fixed → a customer at the PIN orders and receives it", async ({ browser }) => {
  const owner = await freshAccount("sc38");
  const ctx = await ctxFor(owner);
  await needPanStorage(ctx);
  const place = homePlace();
  const name = shopName("Sc38 Traders");
  const since = Date.now() - 2_000;
  const notes: string[] = [];

  // 1–4. The wizard on the screen, the sandbox payment, the live screen, the template.
  const { context, page } = await pageFor(browser, owner);
  let shopId = "";
  let shown = name;
  try {
    await registerInWizard(page, { code: await referralCode(), gstin: gstinFor(wizardPan()), name, phone: uniqueMobile(), shopType: "GENERAL_TRADING", place });
    await answerSandbox(page, "pay");
    await waitForLiveScreen(page);
    const shop = need((await wizardOf(ctx))?.shop, "the shop the wizard created");
    shopId = shop.id;
    shown = shop.name;
    expect(shop.status, "live immediately after payment").toBe("APPROVED");
    await page.getByTestId("add-products-template").click();
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("download-product-template").click()]);
    expect(download.suggestedFilename()).toBe("GoKesari_Product_Upload_Template.xlsx");
    notes.push(`"${shown}" live after the sandbox payment; template ${download.suggestedFilename()}`);
  } finally {
    await context.close();
  }
  const mail = await mailMatching(owner.email, since, /^Your onboarding is complete — /);
  expect(mail?.subject).toBe(`Your onboarding is complete — ${shown} is now live${MAIL_SUFFIX}`);

  // 5. 10 products, 2 of them bad: explained, the rest imported; then the 2 fixed.
  const category = need(world().category, "the world's QA category");
  const item = (n: number) => `QA SC38 Item ${RUN} ${n}`;
  const good = Array.from({ length: 8 }, (_, i) => line([item(i + 1), category.name, "21069099", 18, 100 + i, 90 + i, 10, "pcs", "N", "Upsert"]));
  const bad = [line([item(9), category.name, "21069099", 18, "", 95, 10, "pcs", "N", "Upsert"]), line([item(10), category.name, "21069099", 18, 50, 60, 10, "pcs", "N", "Upsert"])];
  const first = await upload(ctx, shopId, `sc38-${RUN}.csv`, [HEADER, ...good, ...bad].join("\r\n"));
  expect(first.job.status, first.job.errorMessage ?? "").toBe("preview_ready");
  const checked = await rows(ctx, first.jobId);
  const messages = checked.flatMap((r) => r.messages).join(" | ");
  expect(messages).toMatch(/Error: Row \d+: .*MRP missing/);
  expect(messages).toMatch(/Error: Row \d+: .*Selling Price ₹60\.00 > MRP ₹50\.00/);
  expect(checked.filter((r) => r.status === "failed").length, "two rows rejected").toBe(2);
  const imported = await commit(ctx, first.jobId);
  expect(imported.status, imported.errorMessage ?? "").toBe("completed");
  expect(imported.counts.newProducts + imported.counts.updates, "the 8 good rows imported").toBe(8);
  const fixed = [line([item(9), category.name, "21069099", 18, 110, 95, 10, "pcs", "N", "Upsert"]), line([item(10), category.name, "21069099", 18, 70, 60, 10, "pcs", "N", "Upsert"])];
  const second = await upload(ctx, shopId, `sc38-fixed-${RUN}.csv`, [HEADER, ...fixed].join("\r\n"));
  expect((await rows(ctx, second.jobId)).filter((r) => r.status === "failed"), "the fixed rows pass").toHaveLength(0);
  const again = await commit(ctx, second.jobId);
  expect(again.counts.newProducts + again.counts.updates, "the 2 fixed rows imported").toBe(2);
  notes.push(`upload 1: 2 rows refused (${messages.slice(0, 160)}), 8 imported; the fixed 2 imported`);

  // 6. The first sale: delivery by GoKesari riders, open all day, the QA category stocked.
  expectStatus(
    await call(ctx, "PATCH", `/api/shops/${shopId}`, {
      deliveryChoice: "GOKESARI_PARTNER",
      serviceRadiusKm: 5,
      openingHours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: "00:00", close: "23:59" })),
    }),
    200,
    "how the shop delivers, radius and hours",
  );
  await db()`update shops set location_verified = true, location_verified_at = now(), location_source = 'qa_seed' where id = ${shopId}`;
  expectStatus(await call(ctx, "POST", `/api/shops/${shopId}/product-categories`, { categoryId: category.id }), [200, 201], "add the QA category");
  await stockWholeCategory(ctx, shopId, category.id);

  const near = await freshPerson("sc38-near", { walletPaise: 200_000, address: true });
  try {
    // Only Live listings are on the storefront: on sale online, with a price and stock.
    const store = await call(near.ctx, "GET", `/api/shops/${shopId}/products?limit=100`);
    expectStatus(store, 200, "the storefront");
    const listed = (Array.isArray(store.body) ? store.body : (store.body?.products ?? [])) as { shopProductId: string; productId: string; productName: string; onlinePricePaise: number | null }[];
    const mine = await ownerListings(ctx, shopId);
    const live = new Set(mine.filter((l) => l.isActive && l.onlineSaleEnabled && (l.onlinePricePaise ?? 0) > 0 && l.onlineStock > 0).map((l) => l.id));
    const notLive = listed.filter((l) => !live.has(l.shopProductId)).map((l) => l.productName);
    expect(notLive, "every storefront listing is Live (price and stock)").toEqual([]);
    const waiting = mine.filter((l) => !live.has(l.id)).map((l) => l.id);
    expect(listed.filter((l) => waiting.includes(l.shopProductId)), "no listing that is not Live is on the storefront").toEqual([]);
    const owned = new Set(mine.filter((l) => l.onlineSaleEnabled).map((l) => l.id));

    const priced = listed.filter((l) => (l.onlinePricePaise ?? 0) > 0 && owned.has(l.shopProductId)).sort((a, b) => (a.onlinePricePaise ?? 0) - (b.onlinePricePaise ?? 0));
    const pick = need(priced[0], "a priced listing of the QA category on the storefront");
    await freeRider("rider");
    const { res, order } = await personBuys(near, { shopProductId: pick.shopProductId, productId: pick.productId, name: pick.productName, pricePaise: pick.onlinePricePaise, shopId, shopName: shown } as never, 1);
    expectStatus(res, 201, "the first order");
    const placed = need(order, "the first order");
    for (const action of ["accept", "start", "ready"]) expectStatus(await call(ctx, "POST", `/api/orders/${placed.id}/fulfilment`, { action }), 200, `owner ${action}`);
    await deliverToPerson(placed.id, placed.orderNumber, near, { owner: ctx });
    const [done] = await db()<{ status: string }[]>`select status from orders where id = ${placed.id}`;
    expect(done.status, "the first order completes").toBe("DELIVERED");
    notes.push(`${listed.length} storefront listings, all Live; first order ${placed.orderNumber} DELIVERED`);
  } finally {
    await near.ctx.dispose();
  }
  return notes.join("; ");
}, { tier: "local", timeout: 600_000 });
