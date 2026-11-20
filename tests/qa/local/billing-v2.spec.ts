/**
 * Billing v2 on the local server (docs/billing): GST type of the shop's own
 * sales documents, bills of supply, GoKesari's s.9(5) delivery-fee invoice,
 * locked documents, cancellation before packing, TCS / TDS in the money-flow
 * record, POS online and offline, GSTR-1 / 3B / 2B, e-invoice and e-way bill,
 * Tally / Busy / Vyapar / myBillBook files, GSP session expiry and outage,
 * and the flags-off behaviour.
 *
 * Local tier: the billing flags are switched on for every district only for
 * the check and put back exactly as they were (lib/billing-v2-helpers.ts
 * withFlags); a shop's GST registration (GSTIN, status, type, state) is
 * arranged in the database as the GST verification leaves it, and restored.
 * Counter-sale cases use a fresh approved shop of their own (stocked with the
 * QA catalogue); order cases use the world's shop A, customer and rider.
 */
import ExcelJS from "exceljs";
import JSZip from "jszip";

import { as, pageAs } from "../lib/actors";
import {
  accounts,
  billingOn,
  counterSale,
  freeLine,
  istMonth,
  istToday,
  newGstin,
  readyForExport,
  REGULAR_MH,
  serialOf,
  withFlags,
  withShopGst,
  type SalesInvoice,
} from "../lib/billing-v2-helpers";
import { db } from "../lib/db";
import { buy, checkoutLines, deliveredOrder, deliverOrder, freeRider, withRules } from "../lib/finance-helpers";
import { emptyCart, packOrder, sellable, walletBalance } from "../lib/flows";
import { call, expectStatus, poll, stash, unstash, why } from "../lib/http";
import { blocked, expect, need, qa } from "../lib/record";
import { ctxFor, filePart, pageFor, sellingShop } from "../lib/sellers-helpers";
import { world } from "../lib/world";

const local = { tier: "local" as const, timeout: 300_000 };

/* ----------------------------------------------------------- the shop */

interface BillingShop {
  owner: { id: string; email: string };
  shopId: string;
  name: string;
}

/** A fresh approved shop with the QA catalogue, made once per run (kept in the stash). */
async function billingShop(): Promise<BillingShop> {
  const kept = unstash<BillingShop>("billing-v2:shop");
  if (kept) {
    const [row] = await db()<{ id: string }[]>`select id from shops where id = ${kept.shopId} and deleted_at is null`;
    if (row) return kept;
  }
  const made = await sellingShop("billing-v2");
  return stash("billing-v2:shop", { owner: { id: made.owner.id, email: made.owner.email }, shopId: made.shop.id, name: made.shop.name });
}

interface PosItem {
  id: string;
  name: string;
  gstRateBp: number;
  pricePaise: number | null;
  stock: number;
}

async function posItems(shop: BillingShop): Promise<PosItem[]> {
  const res = await accounts(await ctxFor(shop.owner), "GET", shop.shopId, "pos/items");
  expectStatus(res, 200, "POS item list");
  return res.body as PosItem[];
}

async function lastCounterSerial(shop: BillingShop): Promise<number> {
  const res = await accounts(await ctxFor(shop.owner), "GET", shop.shopId, "sales");
  expectStatus(res, 200, "the shop's sales list");
  const serials = (res.body as SalesInvoice[]).map((i) => serialOf(i.invoiceNo)).filter(Number.isFinite);
  return serials.length ? Math.max(...serials) : 0;
}

/* -------------------------------------------- TS-BILL-01: document types */

qa("TC-BILL-001", "regular GST shop: a same-state B2C sale has CGST + SGST; a B2B sale to another state's GSTIN has IGST and the buyer's GSTIN printed", async ({ browser }) => {
  const shop = await billingShop();
  const ctx = await ctxFor(shop.owner);
  const buyerGstin = newGstin("29");
  return withFlags({ billing_v2: true }, () =>
    withShopGst(shop.shopId, REGULAR_MH(), async () => {
      // ₹100 × 2 at 18%: taxable ₹200, tax ₹36.
      const intra = await counterSale(ctx, shop.shopId, { paymentMode: "CASH", lines: [freeLine("QA intra-state biscuits", 10_000, 1800, 2)] });
      expect(intra, "intra-state B2C").toMatchObject({ kind: "TAX_INVOICE", interState: false, placeOfSupply: "27", taxablePaise: 20_000, cgstPaise: 1_800, sgstPaise: 1_800, igstPaise: 0, totalPaise: 23_600 });
      const inter = await counterSale(ctx, shop.shopId, { paymentMode: "CREDIT", buyerName: "QA Karnataka Traders", buyerGstin, lines: [freeLine("QA inter-state biscuits", 10_000, 1800, 2)] });
      expect(inter, "inter-state B2B").toMatchObject({ kind: "TAX_INVOICE", interState: true, placeOfSupply: "29", buyerGstin, taxablePaise: 20_000, cgstPaise: 0, sgstPaise: 0, igstPaise: 3_600, totalPaise: 23_600 });

      const { context, page } = await pageFor(browser, shop.owner);
      try {
        await page.goto(`/shop/accounts/sales/${intra.id}`);
        await expect(page.getByRole("heading", { name: "Tax invoice", exact: true })).toBeVisible();
        await expect(page.getByText("Intra-state (CGST + SGST)")).toBeVisible();
        await expect(page.getByText("Unregistered buyer (B2C)")).toBeVisible();
        await page.goto(`/shop/accounts/sales/${inter.id}`);
        await expect(page.getByRole("heading", { name: "Tax invoice", exact: true })).toBeVisible();
        await expect(page.getByText("Inter-state (IGST)")).toBeVisible();
        await expect(page.getByText(`GSTIN: ${buyerGstin}`)).toBeVisible();
      } finally {
        await context.close();
      }
      return `${intra.invoiceNo}: CGST ₹18 + SGST ₹18; ${inter.invoiceNo}: IGST ₹36 to ${buyerGstin}`;
    }),
  );
}, local);

qa("TC-BILL-002", "composition shop: its sale is a bill of supply without tax; a customer in another state cannot order from it", async () => {
  const shop = await billingShop();
  const ctx = await ctxFor(shop.owner);
  const notes: string[] = [];
  await withFlags({ billing_v2: true }, async () => {
    await withShopGst(shop.shopId, { gstin: newGstin("27"), gst_status: "COMPOSITION", gst_registration_type: "UNREGISTERED", gst_state_code: "MH", gst_portal_status: "ACTIVE" }, async () => {
      const bill = await counterSale(ctx, shop.shopId, { paymentMode: "CASH", lines: [freeLine("QA composition sale", 10_000, 1800, 1)] });
      expect(bill, "composition sale").toMatchObject({ kind: "BILL_OF_SUPPLY", cgstPaise: 0, sgstPaise: 0, igstPaise: 0, totalPaise: 10_000 });
      notes.push(`${bill.invoiceNo} bill of supply ₹100, no tax`);
    });
    // The checkout guard: shop A registered (composition) in Karnataka, the customer's address in Maharashtra.
    const shopA = need(world().shops.A?.id, "shop A");
    const shopName = need(world().shops.A?.name, "shop A's name");
    await withShopGst(shopA, { gstin: newGstin("29"), gst_status: "COMPOSITION", gst_registration_type: "UNREGISTERED", gst_state_code: "KA", gst_portal_status: "ACTIVE" }, async () => {
      const listing = await sellable("A");
      const out = await checkoutLines([{ listing, quantity: 1 }], { noTopUp: true });
      try {
        expectStatus(out.res, 422, "checkout from a composition shop in another state");
        expect(out.res.body?.error?.message).toBe(`${shopName}: This shop can deliver only within its own state. Choose a delivery address in the same state, or another shop.`);
        expect(out.res.body?.error?.details?.reason).toBe("INTER_STATE_NOT_ALLOWED");
      } finally {
        await emptyCart("customer");
      }
      notes.push("inter-state order refused (INTER_STATE_NOT_ALLOWED)");
    });
  });
  return notes.join("; ");
}, { ...local, partial: "a counter sale / B2B sales invoice of a composition shop to another state's GSTIN is not refused by the code (possible defect, report-E)" });

qa("TC-BILL-003", "a shop outside GST (PAN-only) issues a bill of supply with no GST, even when a rate is sent", async ({ browser }) => {
  const shop = await billingShop();
  const ctx = await ctxFor(shop.owner);
  return withFlags({ billing_v2: true }, () =>
    withShopGst(shop.shopId, { gstin: null, gst_status: "NOT_REGISTERED", gst_registration_type: "UNREGISTERED", gst_state_code: null }, async () => {
      const set = await accounts(ctx, "PATCH", shop.shopId, "gst-registration", { type: "PAN_ONLY_SERVICE" });
      expectStatus(set, 200, "declare PAN-only service");
      expect(set.body).toMatchObject({ type: "PAN_ONLY_SERVICE", hasGstin: false });
      try {
        const bill = await counterSale(ctx, shop.shopId, { paymentMode: "CASH", lines: [freeLine("QA PAN-only service", 5_000, 500, 1)] });
        expect(bill, "PAN-only shop's sale").toMatchObject({ kind: "BILL_OF_SUPPLY", cgstPaise: 0, sgstPaise: 0, igstPaise: 0, totalPaise: 5_000 });
        const { context, page } = await pageFor(browser, shop.owner);
        try {
          await page.goto(`/shop/accounts/sales/${bill.id}`);
          await expect(page.getByRole("heading", { name: "Bill of supply", exact: true })).toBeVisible();
          const article = page.getByRole("article", { name: "Bill of supply" });
          await expect(article.getByText("CGST", { exact: true })).toHaveCount(0);
          await expect(article.getByText("Taxable value")).toHaveCount(0);
        } finally {
          await context.close();
        }
        return `${bill.invoiceNo}: bill of supply ₹50.00, no GST (5% sent, charged 0%)`;
      } finally {
        await accounts(ctx, "PATCH", shop.shopId, "gst-registration", { type: "BY_GSTIN" });
      }
    }),
  );
}, local);

qa("TC-BILL-004", "an unregistered GoKesari partner delivers: GoKesari's own delivery-fee invoice GKS/2627/…; a GST-registered partner: none", async () => {
  const rider = need(world().users.rider?.id, "rider 1");
  const [s95] = await db()<{ rate_bp: number }[]>`
    select rate_bp from statutory_rates where key = 'GST_S95_LOCAL_DELIVERY' and enabled
      and effective_from <= ${istToday()}::date and (effective_to is null or effective_to >= ${istToday()}::date)`;
  if (!s95) blocked("no enabled GST_S95_LOCAL_DELIVERY rate for today in Admin → Statutory (migration 0126 seeds 5% from 1 Nov 2026)");
  const riderGst = async (on: boolean) => db()`update delivery_partners set gst_registered = ${on} where user_id = ${rider}`;
  const [before] = await db()<{ g: boolean }[]>`select gst_registered as g from delivery_partners where user_id = ${rider}`;
  return withFlags({ billing_v2: true, delivery_9_5: true }, () =>
    withRules({ platformTaxProfile: { gstin: newGstin("27"), legalName: "GoKesari QA Private Limited", tradeName: "GoKesari", stateCode: "MH" } }, async () => {
      try {
        await riderGst(false);
        const first = await deliveredOrder();
        const [fee] = await db()<{ f: number }[]>`select delivery_fee_paise::int as f from orders where id = ${first.id}`;
        if (!fee?.f) blocked("shop A's order carried no delivery fee here (free delivery), so no s.9(5) invoice is due");
        const inv = await poll(
          async () => (await db()<{ invoice_number: string; kind: string }[]>`select invoice_number, kind from platform_delivery_invoices where order_id = ${first.id}`)[0],
          (v) => Boolean(v),
          15_000,
          1000,
        );
        expect(inv, "GoKesari's delivery-fee invoice").toBeTruthy();
        expect(inv.kind).toBe("DELIVERY");
        expect(inv.invoice_number).toMatch(/^GKS\/\d{4}\/\d{6}$/);
        const page = await call(await as("customer"), "GET", `/orders/${first.id}`, undefined, { maxRedirects: 3 });
        expect(page.text, "the customer's order page links it").toContain("Delivery fee invoice (GoKesari)");

        await riderGst(true);
        const second = await deliveredOrder();
        const [flow] = await db()<{ l: string }[]>`select delivery_gst_liable as l from order_money_flows where order_id = ${second.id}`;
        expect(flow?.l, "a GST-registered partner is liable himself").toBe("RIDER");
        const none = await db()`select 1 from platform_delivery_invoices where order_id = ${second.id}`;
        expect(none.length, "no GoKesari invoice for a registered partner").toBe(0);
        return `${inv.invoice_number} for order ${first.orderNumber}; none for ${second.orderNumber} (rider GST-registered)`;
      } finally {
        await riderGst(before?.g ?? false);
      }
    }),
  );
}, { ...local, timeout: 420_000 });

qa("TC-BILL-005", "an issued invoice is locked: no edit on the page, the edit API does not exist (404); a change goes through a credit note", async ({ browser }) => {
  const shop = await billingShop();
  const ctx = await ctxFor(shop.owner);
  return withFlags({ billing_v2: true }, () =>
    withShopGst(shop.shopId, REGULAR_MH(), async () => {
      const inv = await counterSale(ctx, shop.shopId, { paymentMode: "CASH", lines: [freeLine("QA locked invoice", 20_000, 1800, 1)] });
      for (const method of ["PATCH", "PUT"] as const) {
        const edit = await accounts(ctx, method, shop.shopId, `sales/${inv.id}`, { invoiceDate: istToday(), lines: [freeLine("changed", 1, 0, 1)] });
        expectStatus(edit, 404, `${method} on an issued invoice`);
        expect(edit.body?.error?.message).toBe("Endpoint was not found.");
      }
      const { context, page } = await pageFor(browser, shop.owner);
      try {
        await page.goto(`/shop/accounts/sales/${inv.id}`);
        await expect(page.getByRole("link", { name: "Download PDF" })).toBeVisible();
        await expect(page.getByRole("button", { name: /edit/i })).toHaveCount(0);
        await expect(page.getByRole("link", { name: /^edit/i })).toHaveCount(0);
      } finally {
        await context.close();
      }
      const note = await accounts(ctx, "POST", shop.shopId, "documents", {
        kind: "CREDIT_NOTE",
        againstSalesId: inv.id,
        paymentMode: "CASH",
        reason: "QA: price corrected",
        lines: [freeLine("QA locked invoice — price correction", 5_000, 1800, 1)],
      });
      expectStatus(note, 201, "credit note against the invoice");
      expect(note.body?.docNo).toMatch(/^CN\d{4}-\d{6}$/);
      const after = await accounts(ctx, "GET", shop.shopId, `sales/${inv.id}`);
      expect(after.body?.invoice, "the invoice itself is unchanged").toMatchObject({ totalPaise: inv.totalPaise, status: "ISSUED" });
      return `${inv.invoiceNo}: PATCH/PUT 404, no edit control; credit note ${note.body.docNo}`;
    }),
  );
}, local);

/* ----------------------------------------- TS-BILL-02: returns, TCS, TDS */

qa("TC-BILL-006", "cancelled before packing: full refund to the wallet, stock restored, no invoice and no credit note", async () => {
  return withFlags({ billing_v2: true }, async () => {
    const listing = await sellable("A");
    const walletBefore = await walletBalance("customer");
    const [stockBefore] = await db()<{ s: number }[]>`select online_stock as s from shop_products where id = ${listing.shopProductId}`;
    const order = await buy(listing, 1);
    const cancel = await call(await as("customer"), "POST", `/api/orders/${order.id}/cancel`, { reason: "QA: cancelled before packing", refundMethod: "WALLET" });
    expectStatus(cancel, 200, "customer cancels before packing");
    const [row] = await db()<{ status: string; total: number }[]>`select status, total_paise::int as total from orders where id = ${order.id}`;
    expect(row.status, "cancelled, then refunded to the wallet (CANCELLED → REFUNDED)").toBe("REFUNDED");
    // The full refund is the wallet back where it was (orders.refunded_paise is for return refunds).
    expect(await walletBalance("customer"), "refunded in full: the wallet is back where it was").toBe(walletBefore);
    const [stock] = await db()<{ s: number }[]>`select online_stock as s from shop_products where id = ${listing.shopProductId}`;
    expect(stock.s, "stock restored").toBe(stockBefore.s);
    const invoices = await db()`select 1 from tax_invoices where order_id = ${order.id}`;
    const notes = await db()`select 1 from credit_notes cn join tax_invoices ti on ti.id = cn.tax_invoice_id where ti.order_id = ${order.id}`;
    expect(invoices.length + notes.length, "no invoice, no credit note").toBe(0);
    return `order ${order.orderNumber}: ₹${(row.total / 100).toFixed(2)} back to the wallet, stock restored, no invoice / credit note`;
  });
}, { ...local, partial: "the partial return's credit note for the returned line only is proven by tests/integration/billing-documents.test.ts (\"issues a note for the returned milk only\")" });

qa("TC-BILL-007", "money-flow record: TCS in scope for a GST shop, not for an Enrolment-ID shop; TDS in scope for both; the dated rates 0.5% TCS, 0.1% / 5% TDS", async () => {
  const shopA = need(world().shops.A?.id, "shop A");
  const rates = await db()<{ key: string; rate_bp: number; params: Record<string, number> }[]>`
    select key, rate_bp, params from statutory_rates where key in ('GST_TCS_SEC52', 'IT_TDS_194O') and enabled
      and effective_from <= ${istToday()}::date and (effective_to is null or effective_to >= ${istToday()}::date)`;
  const tcs = need(rates.find((r) => r.key === "GST_TCS_SEC52"), "the TCS rate in force");
  const tds = need(rates.find((r) => r.key === "IT_TDS_194O"), "the TDS rate in force");
  expect(tcs.rate_bp, "TCS 0.5%").toBe(50);
  expect([tds.rate_bp, tds.params.noPanRateBp, tds.params.exemptIndividualHufUpToPaise], "TDS 0.1%, 5% without PAN, ₹5 lakh individual / HUF exemption").toEqual([10, 500, 50_000_000]);
  return withFlags({ billing_v2: true, tcs_engine: true, tds_engine: true }, async () => {
    const regular = await withShopGst(shopA, REGULAR_MH(), () => deliveredOrder());
    const enrolment = await withShopGst(shopA, { gstin: null, gst_status: "NOT_REGISTERED", gst_registration_type: "ENROLMENT_ID", gst_enrolment_id: "27ABCDE1234F1ZQ" }, () => deliveredOrder());
    const flow = async (id: string) => (await db()<{ tcs: boolean; tds: boolean }[]>`select tcs_applicable as tcs, tds_applicable as tds from order_money_flows where order_id = ${id}`)[0];
    expect(await flow(regular.id), "GST shop").toEqual({ tcs: true, tds: true });
    expect(await flow(enrolment.id), "Enrolment-ID shop: no TCS").toEqual({ tcs: false, tds: true });
    return `GST shop ${regular.orderNumber}: TCS + TDS; Enrolment-ID ${enrolment.orderNumber}: TDS only`;
  });
}, { ...local, timeout: 420_000, partial: "the amounts on the payout statement (0.5% of net after returns; 0.1% with PAN past ₹5 lakh, 5% without) need a payout cycle — proven by tests/integration/billing-compliance.test.ts and billing-money-flow.test.ts" });

/* ---------------------------------------------------- TS-BILL-03: POS */

qa("TC-BILL-008", "POS: two items sold at the counter — the bill gets the next number, its 80 mm receipt opens and stock goes down by 2", async ({ browser }) => {
  const shop = await billingShop();
  const ctx = await ctxFor(shop.owner);
  return withFlags({ billing_v2: true }, async () => {
    const item = need((await posItems(shop)).find((i) => (i.pricePaise ?? 0) > 0 && i.stock >= 5), "a priced POS item with stock");
    const last = await lastCounterSerial(shop);
    const { context, page } = await pageFor(browser, shop.owner);
    try {
      await page.goto("/shop/accounts/pos");
      await expect(page.getByRole("heading", { name: `Counter POS · ${shop.name}` })).toBeVisible();
      await page.getByLabel("Search item or barcode").fill(item.name);
      await page.getByRole("button", { name: new RegExp(`^${item.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }).first().click();
      await page.getByRole("button", { name: `More ${item.name}` }).click();
      await page.getByRole("button", { name: "Make bill" }).click();
      const done = page.getByTestId("pos-done").getByRole("listitem").first();
      await expect(done).toContainText("created", { timeout: 30_000 });
      const number = need(/[A-Z]+\d{4}-\d+/.exec(await done.innerText())?.[0], "the bill number in Sent bills");
      expect(serialOf(number), "the next number").toBe(last + 1);
      const receipt = need(await done.getByRole("link", { name: "80 mm receipt" }).getAttribute("href"), "the receipt link");
      const pdf = await call(ctx, "GET", receipt);
      expectStatus(pdf, 200, "80 mm receipt");
      expect(pdf.headers["content-type"]).toContain("application/pdf");
      const after = need((await posItems(shop)).find((i) => i.id === item.id), "the item after the sale");
      expect(after.stock, "stock down by 2").toBe(item.stock - 2);
      return `${number} for 2 × ${item.name}; stock ${item.stock} → ${after.stock}`;
    } finally {
      await context.close();
    }
  });
}, local);

qa("TC-BILL-009", "POS offline: 3 bills made offline sync once, numbered straight after the last bill; a re-sent bill is a duplicate; a price change is warned", async ({ browser }) => {
  const shop = await billingShop();
  const ctx = await ctxFor(shop.owner);
  return withFlags({ billing_v2: true }, async () => {
    const item = need((await posItems(shop)).find((i) => (i.pricePaise ?? 0) > 0 && i.stock >= 6), "a priced POS item with stock");
    const { context, page } = await pageFor(browser, shop.owner);
    let numbers: number[] = [];
    try {
      await page.goto("/shop/accounts/pos");
      await expect(page.getByText("online", { exact: true })).toBeVisible();
      const last = await lastCounterSerial(shop);
      await context.setOffline(true);
      await expect(page.getByText("offline", { exact: true })).toBeVisible();
      for (let i = 0; i < 3; i++) {
        await page.getByLabel("Search item or barcode").fill(item.name);
        await page.getByRole("button", { name: new RegExp(`^${item.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }).first().click();
        await page.getByRole("button", { name: "Make bill" }).click();
        await expect(page.getByText(/saved on this device — it will be sent when the internet is back/)).toBeVisible();
      }
      await expect(page.getByText("3 bill(s) waiting to send")).toBeVisible();
      await context.setOffline(false);
      await expect(page.getByText("3 bill(s) waiting to send")).toHaveCount(0, { timeout: 30_000 });
      const rows = page.getByTestId("pos-done").getByRole("listitem");
      await expect(rows.nth(2)).toContainText("created");
      const texts = await rows.allInnerTexts();
      numbers = texts.slice(0, 3).map((t) => serialOf(/[A-Z]+\d{4}-\d+/.exec(t)?.[0] ?? "")).sort((a, b) => a - b);
      expect(numbers, "consecutive after the last bill, no gap, no duplicate").toEqual([last + 1, last + 2, last + 3]);
    } finally {
      await context.setOffline(false).catch(() => {});
      await context.close();
    }
    // The same bill sent again (a retry after a dropped answer) returns the same invoice.
    const bill = { clientRef: `qa-pos-${Date.now()}`, createdAt: new Date().toISOString(), paymentMode: "CASH", lines: [{ shopProductId: item.id, name: item.name, qtyMilli: 1000, pricePaise: (item.pricePaise ?? 0) + 100, gstRateBp: item.gstRateBp }] };
    const first = await accounts(ctx, "POST", shop.shopId, "pos/sync", { bills: [bill] });
    expectStatus(first, 200, "sync a bill");
    const again = await accounts(ctx, "POST", shop.shopId, "pos/sync", { bills: [bill] });
    expect(first.body[0]).toMatchObject({ status: "CREATED" });
    expect(again.body[0]).toMatchObject({ status: "DUPLICATE", invoiceNo: first.body[0].invoiceNo });
    expect((first.body[0].warnings as string[]).join(" "), "price changed since the device's list").toMatch(new RegExp(`${item.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: billed at ₹[\\d.]+, the price is now ₹[\\d.]+\\.`));
    return `offline bills ${numbers.join(", ")}; re-sent ${first.body[0].invoiceNo} → DUPLICATE; price warning shown`;
  });
}, local);

/* ------------------------------------ TS-BILL-04: returns, IRN, sync, GSP */

/** Links the shop's GSTIN to the (mock) GST portal with the mock OTP. */
async function linkPortal(ctx: Awaited<ReturnType<typeof as>>, shopId: string, gstin: string) {
  const otp = await accounts(ctx, "POST", shopId, "gst/link", { gstin, username: "qa_portal_user", consent: true });
  if (otp.status === 409) blocked(`the GST portal connection is not switched on here — ${why(otp)}`);
  if (otp.status === 422 && /INTEGRATION_ENCRYPTION_KEY/.test(otp.text)) blocked("this server has no INTEGRATION_ENCRYPTION_KEY, so accounting connections are off here");
  expectStatus(otp, 200, "ask the portal for the link OTP");
  const linked = await accounts(ctx, "POST", shopId, "gst/verify", { otp: "575757" });
  expectStatus(linked, 200, "link with the mock OTP");
}

qa("TC-BILL-010", "GSTR-1 has Tables 12 (HSN), 13 (documents) and 14 (supplies through GoKesari); GSTR-3B matches the books; 2B lines are matched or flagged", async () => {
  const shopA = need(world().shops.A?.id, "shop A");
  const owner = await as("shop");
  const gstin = newGstin("27");
  const period = istMonth();
  return withFlags({ billing_v2: true }, () =>
    withRules({ invoicing: { enabled: true }, platformTaxProfile: { gstin: newGstin("27"), legalName: "GoKesari QA Private Limited", tradeName: "GoKesari", stateCode: "MH" } }, () =>
      withShopGst(shopA, REGULAR_MH(gstin), async () => {
        const order = await deliveredOrder();
        const issued = await call(owner, "POST", `/api/orders/${order.id}/invoice`);
        expectStatus(issued, 200, "the order's tax invoice");
        const g1 = await accounts(owner, "POST", shopA, "portal/filings", { returnType: "GSTR1", period });
        expectStatus(g1, 201, "prepare GSTR-1");
        const p = g1.body.payload;
        expect(p.hsn.hsn_b2c.length + p.hsn.hsn_b2b.length, "Table 12 (HSN summary)").toBeGreaterThan(0);
        expect(p.doc_issue.doc_det.length, "Table 13 (documents issued)").toBeGreaterThan(0);
        expect(p.supeco?.clttx?.length ?? 0, "Table 14 (supplies through GoKesari)").toBeGreaterThan(0);
        const g3 = await accounts(owner, "POST", shopA, "portal/filings", { returnType: "GSTR3B", period });
        expectStatus(g3, 201, "prepare GSTR-3B");
        const books = await accounts(owner, "GET", shopA, `gst/liability?period=${period}`);
        expectStatus(books, 200, "GST payable from the books");
        const out = books.body.total.output;
        expect(g3.body.payload.sup_details.osup_det, "3B outward tax = the books").toMatchObject({ camt: Math.round(out.cgst) / 100, samt: Math.round(out.sgst) / 100, iamt: Math.round(out.igst) / 100 });
        await linkPortal(owner, shopA, gstin);
        const pulled = await accounts(owner, "POST", shopA, "gst/pull", { returnType: "GSTR2B", period });
        expectStatus(pulled, 200, "pull GSTR-2B");
        const recon = await accounts(owner, "POST", shopA, "gst/recon", { period });
        expectStatus(recon, 200, "reconcile");
        const c = recon.body.counts as Record<string, number>;
        expect(Object.values(c).reduce((a, b) => a + b, 0), "2B lines matched or flagged").toBeGreaterThan(0);
        const ims = await accounts(owner, "GET", shopA, `portal/ims?period=${period}`);
        expectStatus(ims, 200, "IMS inward documents");
        await accounts(owner, "DELETE", shopA, "gst/link");
        return `GSTR-1 HSN/doc/ECO rows ${p.hsn.hsn_b2c.length + p.hsn.hsn_b2b.length}/${p.doc_issue.doc_det.length}/${p.supeco.clttx.length}; 3B = books; recon ${JSON.stringify(c)}`;
      }),
    ),
  );
}, { ...local, timeout: 420_000, partial: "the 2B lines here are the mock portal's; IMS accept / reject is checked in tests/integration/billing-gsp.test.ts" });

qa("TC-BILL-011", "e-invoice IRN and e-way bill: generated for a B2B tax invoice and cancelled", async () => {
  const shopA = need(world().shops.A?.id, "shop A");
  const owner = await as("shop");
  const today = istToday();
  // GST settings (Admin → GST config), dated today: e-invoicing and e-way bills on, GST16 numbers (≤ 16 characters).
  const rules: [string, string][] = [
    ["einvoice", JSON.stringify({ enabled: true, turnoverThresholdPaise: 5_000_000_000, b2bOnly: true })],
    ["ewayBill", JSON.stringify({ enabled: true, interStateThresholdPaise: 5_000_000, intraStateThresholdPaise: { DEFAULT: 5_000_000 } })],
    ["documentNumbering", JSON.stringify({ format: "GST16" })],
  ];
  const kept = await db()<{ key: string }[]>`select key from gst_rules where effective_from = ${today}::date and key in ('einvoice', 'ewayBill', 'documentNumbering')`;
  if (kept.length) blocked(`GST settings already have rows dated today (${kept.map((k) => k.key).join(", ")}); remove them first`);
  for (const [key, value] of rules) await db()`insert into gst_rules (key, value, effective_from, note) values (${key}, ${value}::jsonb, ${today}::date, 'QA TC-BILL-011 (removed after the check)')`;
  try {
    return await withFlags({ billing_v2: true, einvoice: true, ewaybill: true }, () =>
      withRules({ invoicing: { enabled: true } }, () =>
        withShopGst(shopA, { ...REGULAR_MH(), einvoice_applicable: true }, async () => {
          // A B2B order: the customer's GSTIN at checkout, then packed and delivered.
          const buyerGstin = newGstin("27");
          await freeRider("rider");
          const b2b = await buy(await sellable("A"), 1, { extra: { buyerGstin } });
          await packOrder(b2b.id);
          await deliverOrder(b2b.id);
          const issued = await call(owner, "POST", `/api/orders/${b2b.id}/invoice`);
          expectStatus(issued, 200, "the B2B tax invoice");
          const invoiceId = issued.body.id as string;
          expect(issued.body.invoiceNumber.length, "a number of at most 16 characters (GST16)").toBeLessThanOrEqual(16);
          const irn = await call(owner, "POST", `/api/invoices/${invoiceId}/einvoice`);
          expectStatus(irn, 200, "generate the IRN");
          expect(irn.body.einvoice).toMatchObject({ status: "GENERATED" });
          expect(irn.body.einvoice.irn, "an IRN").toMatch(/^[0-9a-f]{64}$/i);
          const ewb = await call(owner, "POST", `/api/invoices/${invoiceId}/eway-bill`, { distanceKm: 12, vehicleNo: "MH12AB1234" });
          expectStatus(ewb, 201, "generate the e-way bill");
          expect(ewb.body.ewayBill).toMatchObject({ status: "GENERATED" });
          expect(ewb.body.ewayBill.ewbNo).toMatch(/^\d{12}$/);
          const ewbCancel = await call(owner, "POST", `/api/invoices/${invoiceId}/eway-bill/cancel`, { reason: "2", remark: "QA cancel" });
          expectStatus(ewbCancel, 200, "cancel the e-way bill");
          const irnCancel = await call(owner, "POST", `/api/invoices/${invoiceId}/einvoice/cancel`, { reason: "2", remark: "QA cancel" });
          expectStatus(irnCancel, 200, "cancel the IRN");
          expect(irnCancel.body.einvoice).toMatchObject({ status: "CANCELLED" });
          expect(irnCancel.body.ewayBill).toMatchObject({ status: "CANCELLED" });
          return `${issued.body.invoiceNumber}: IRN ${String(irn.body.einvoice.irn).slice(0, 12)}…, EWB ${ewb.body.ewayBill.ewbNo}; both cancelled`;
        }),
      ),
    );
  } finally {
    await db()`delete from gst_rules where effective_from = ${today}::date and note = 'QA TC-BILL-011 (removed after the check)'`;
  }
}, { ...local, timeout: 480_000 });

/** An accounting tool's workbook: one party sheet and one item sheet, in the tool's own headings. */
async function toolWorkbook(tool: "BUSY" | "VYAPAR" | "MYBILLBOOK", party: string, item: string): Promise<Buffer> {
  const layout = {
    BUSY: { parties: ["Account Master", ["Name", "Group", "GSTIN", "State", "Mobile"]], items: ["Item Master", ["Name", "Main Unit", "HSN Code", "Tax Rate (%)", "Sale Price"]] },
    VYAPAR: { parties: ["Parties", ["Party Name", "Party Group", "GSTIN", "State", "Phone Number"]], items: ["Items", ["Item Name", "Unit", "HSN", "Tax Rate (%)", "Sale Price"]] },
    MYBILLBOOK: { parties: ["Parties", ["Party Name", "Party Type", "GSTIN", "State", "Mobile Number"]], items: ["Items", ["Item Name", "Unit", "HSN Code", "GST %", "Sales Price"]] },
  }[tool] as { parties: [string, string[]]; items: [string, string[]] };
  const wb = new ExcelJS.Workbook();
  const ps = wb.addWorksheet(layout.parties[0]);
  ps.addRow(layout.parties[1]);
  ps.addRow([party, "Sundry Debtors", "", "Maharashtra", "9876543210"]);
  const is = wb.addWorksheet(layout.items[0]);
  is.addRow(layout.items[1]);
  is.addRow([item, "PCS", "1905", 18, 50]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

qa("TC-BILL-012", "Tally export (XML + Excel) and a second export that changes nothing; files from Busy, Vyapar and myBillBook bring in their parties", async () => {
  const shop = await billingShop();
  const ctx = await ctxFor(shop.owner);
  return withFlags({ billing_v2: true }, () =>
    withShopGst(shop.shopId, REGULAR_MH(), async () => {
      await counterSale(ctx, shop.shopId, { paymentMode: "CASH", lines: [freeLine("QA Tally export line", 10_000, 1800, 1)] });
      const from = `${istMonth()}-01`;
      const to = istToday();
      const left = await readyForExport(ctx, shop.shopId, from, to);
      expect(left, "nothing left on the export's fix list").toEqual([]);
      const exportOnce = async () => {
        const res = await accounts(ctx, "GET", shop.shopId, `sync/export?tool=TALLY&from=${from}&to=${to}`);
        if (res.status === 409) blocked(`the books need fixes before an export: ${JSON.stringify(res.body?.error?.fixes ?? []).slice(0, 300)}`);
        expectStatus(res, 200, "export for Tally");
        return res;
      };
      const dash = async () => ((await accounts(ctx, "GET", shop.shopId, "sync")).body.systems as { system: string; records: number }[]).find((s) => s.system === "TALLY")!.records;
      await exportOnce();
      const recordsAfterFirst = await dash();
      // The export answer is a ZIP: fetch it as bytes to read the files.
      const bytes = await (await ctx.get(`/api/shops/${shop.shopId}/accounts/sync/export?tool=TALLY&from=${from}&to=${to}`)).body();
      const zip = await JSZip.loadAsync(bytes);
      expect(Object.keys(zip.files).sort(), "Tally XML, Excel and mapping").toEqual(["gokesari-tally-mapping.tsf", "gokesari-tally.xlsx", "gokesari-tally.xml"]);
      expect(await dash(), "a second export adds no new records (all unchanged)").toBe(recordsAfterFirst);
      const [audit] = await db()<{ v: { new: number; changed: number; unchanged: number } }[]>`
        select new_value as v from audit_logs where action = 'sync.file_exported' and entity_id = ${shop.shopId} order by created_at desc limit 1`;
      expect(audit?.v, "the last export reports everything unchanged").toMatchObject({ new: 0, changed: 0 });
      // The exported XML read back: nothing new is created.
      const xml = Buffer.from(await zip.file("gokesari-tally.xml")!.async("uint8array"));
      const back = await accounts(ctx, "POST", shop.shopId, "sync/import?tool=TALLY", undefined, { multipart: { file: filePart("gokesari-tally.xml", xml, "application/xml") } as never });
      expectStatus(back, 200, "import the exported Tally XML");
      expect(back.body, "reads back the same").toMatchObject({ parties: { created: 0 }, vouchers: { created: 0 } });
      const seen: string[] = [];
      for (const tool of ["BUSY", "VYAPAR", "MYBILLBOOK"] as const) {
        const party = `QA ${tool} Party ${Date.now().toString(36)}`;
        const item = `QA ${tool} Item ${Date.now().toString(36)}`;
        const file = await toolWorkbook(tool, party, item);
        const res = await accounts(ctx, "POST", shop.shopId, `sync/import?tool=${tool}`, undefined, {
          multipart: { file: filePart(`${tool.toLowerCase()}-export.xlsx`, file, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") } as never,
        });
        expectStatus(res, 200, `import a ${tool} file`);
        expect(res.body.parties.created, `${tool}: the party is created`).toBe(1);
        expect(res.body.items.notFound, `${tool}: an item not on GoKesari is listed, not created`).toContain(item);
        seen.push(`${tool} +1 party`);
      }
      return `Tally zip: xml + xlsx + tsf; second export unchanged (${recordsAfterFirst} records); XML read back creates nothing; ${seen.join(", ")}`;
    }),
  );
}, { ...local, partial: "vouchers and stock from an imported sales / purchase file are proven by tests/integration/billing-sync.test.ts" });

qa("TC-BILL-013", "GST session expiry asks to link again; a GSP that cannot be reached marks the return ERROR with the download fallback; a filed return is never filed twice", async () => {
  const shop = await billingShop();
  const ctx = await ctxFor(shop.owner);
  const gstin = newGstin("27");
  return withFlags({ billing_v2: true }, () =>
    withShopGst(shop.shopId, REGULAR_MH(gstin), async () => {
      // A month whose GSTR-1 this shop has not filed yet (an earlier run files one).
      const filedBefore = ((await accounts(ctx, "GET", shop.shopId, "portal/filings")).body as { returnType: string; period: string; status: string }[]).filter((f) => f.returnType === "GSTR1" && f.status === "FILED").map((f) => f.period);
      const period = need([-1, -2, -3, -4, -5, -6, -7, -8, -9, -10, -11, -12].map(istMonth).find((p) => !filedBefore.includes(p)), "a month without a filed GSTR-1");
      await linkPortal(ctx, shop.shopId, gstin);
      try {
        const prepared = await accounts(ctx, "POST", shop.shopId, "portal/filings", { returnType: "GSTR1", period });
        expectStatus(prepared, 201, "prepare GSTR-1");
        const id = prepared.body.id as string;
        // 1. The portal session ends.
        await db()`update gst_portal_links set token_expires_at = now() - interval '1 hour' where shop_id = ${shop.shopId}`;
        const expired = await accounts(ctx, "POST", shop.shopId, `portal/filings/${id}/save`);
        expectStatus(expired, 422, "save with an ended session");
        expect(expired.body?.error?.message).toBe("Your GST portal session has expired. Link again with a new OTP.");
        await linkPortal(ctx, shop.shopId, gstin);
        // 2. The GSP cannot be reached (simulated: the per-shop GSP call limit is used up).
        await db()`insert into gsp_call_log (shop_id, operation, provider, request_id, outcome, attempts, duration_ms)
                   select ${shop.shopId}, 'qa:outage', 'mock', gen_random_uuid()::text, 'OK', 1, 1 from generate_series(1, 30)`;
        const down = await accounts(ctx, "POST", shop.shopId, `portal/filings/${id}/save`);
        expectStatus(down, 422, "save while the GSP cannot be reached");
        expect(down.body?.error?.message).toMatch(/You can download the return and file it on gst\.gov\.in\.$/);
        const list = await accounts(ctx, "GET", shop.shopId, "portal/filings");
        expect((list.body as { id: string; status: string }[]).find((f) => f.id === id)?.status, "the return is marked ERROR").toBe("ERROR");
        const download = await accounts(ctx, "GET", shop.shopId, `portal/filings/${id}/download`);
        expectStatus(download, 200, "the manual fallback: download the return");
        await db()`delete from gsp_call_log where shop_id = ${shop.shopId} and operation = 'qa:outage'`;
        // 3. Saved, filed with the EVC OTP — and not filed twice.
        expectStatus(await accounts(ctx, "POST", shop.shopId, `portal/filings/${id}/save`), 200, "save when the GSP is back");
        const otp = await accounts(ctx, "POST", shop.shopId, `portal/filings/${id}/otp`);
        expectStatus(otp, 200, "EVC OTP");
        const filed = await accounts(ctx, "POST", shop.shopId, `portal/filings/${id}/file`, { requestId: otp.body.requestId, otp: "575757" });
        expectStatus(filed, 200, "file with EVC");
        expect(filed.body).toMatchObject({ status: "FILED" });
        const again = await accounts(ctx, "POST", shop.shopId, "portal/filings", { returnType: "GSTR1", period });
        expectStatus(again, 409, "prepare a filed return again");
        expect(again.body?.error?.message).toBe(`GSTR1 for ${period} is already filed (ARN ${filed.body.arn}). Corrections go in the next return.`);
        return `expiry → link again; outage → ERROR + download; filed ARN ${filed.body.arn}; second filing refused`;
      } finally {
        await db()`delete from gsp_call_log where shop_id = ${shop.shopId} and operation = 'qa:outage'`;
        await accounts(ctx, "DELETE", shop.shopId, "gst/link");
      }
    }),
  );
}, { ...local, partial: "the retries with backoff on a GSP outage (2 retries) are proven by tests/integration/billing-gsp.test.ts; here the outage is the per-shop GSP call limit" });

/* ----------------------------------------------- TS-BILL-05: flags off */

qa("TC-BILL-015", "billing_v2 off: POS and the other billing pages go back to /shop/accounts, GST returns to /shop/accounts/gst; billing APIs answer 404", async ({ browser }) => {
  return withFlags({ billing_v2: false }, async () => {
    const shopA = need(world().shops.A?.id, "shop A");
    const owner = await as("shop");
    expect(await billingOn(owner, shopA), "billing_v2 is off").toBe(false);
    const { context, page } = await pageAs(browser, "shop");
    try {
      for (const path of ["/shop/accounts/pos", "/shop/accounts/documents", "/shop/accounts/statements", "/shop/accounts/sync"]) {
        await page.goto(path);
        await page.waitForURL((u) => u.pathname === "/shop/accounts", { timeout: 20_000 });
      }
      await page.goto("/shop/accounts/gst/returns");
      await page.waitForURL((u) => u.pathname === "/shop/accounts/gst", { timeout: 20_000 });
      await page.goto("/shop/accounts/gst");
      await expect(page.getByRole("link", { name: "Returns on the portal →" })).toHaveCount(0);
    } finally {
      await context.close();
    }
    const seen: string[] = [];
    for (const rest of ["pos/items", "documents", "gst-registration", "portal/filings", "sync", `statements/tax?period=${istMonth(-1)}`]) {
      const res = await accounts(owner, "GET", shopA, rest);
      expectStatus(res, 404, `GET ${rest} with billing_v2 off`);
      expect(res.body?.error?.message).toBe("This feature is not available.");
      seen.push(rest.split("?")[0]);
    }
    return `pages → /shop/accounts (returns → /shop/accounts/gst); 404 on ${seen.join(", ")}`;
  });
}, local);
