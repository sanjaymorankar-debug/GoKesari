/**
 * SC-43 — a shop's day on Billing v2 (docs/billing): counter bills at the POS,
 * some made while the device was offline and synced later; a purchase
 * recorded; at month end GSTR-1 and GSTR-3B prepared, GSTR-2B pulled and
 * reconciled; the books exported for Tally.
 *
 * Local tier: billing_v2 switched on for the journey and restored; a fresh
 * approved shop of its own (QA catalogue) registered as a regular GST shop in
 * the database. The online-order parts (delivery-fee invoice, the credit note
 * of a partial return, TCS / TDS) are proven by TC-BILL-004 / 006 / 007 / 010
 * in tests/qa/local/billing-v2.spec.ts.
 */
import JSZip from "jszip";

import { accounts, counterSale, freeLine, istMonth, istToday, newGstin, readyForExport, REGULAR_MH, serialOf, withFlags, withShopGst, type SalesInvoice } from "../lib/billing-v2-helpers";
import { db } from "../lib/db";
import { expectStatus, stash, unstash } from "../lib/http";
import { blocked, expect, need, qa } from "../lib/record";
import { ctxFor, sellingShop } from "../lib/sellers-helpers";

qa("SC-43", "billing day: POS bills online and offline numbered without gaps, a purchase, GSTR-1 / 3B prepared, 2B reconciled, Tally export", async () => {
  const kept = unstash<{ owner: { id: string; email: string }; shopId: string }>("SC-43:shop");
  const exists = kept ? (await db()<{ id: string }[]>`select id from shops where id = ${kept.shopId} and deleted_at is null`).length > 0 : false;
  const shop = exists && kept ? kept : await sellingShop("sc43").then((m) => stash("SC-43:shop", { owner: { id: m.owner.id, email: m.owner.email }, shopId: m.shop.id }));
  const ctx = await ctxFor(shop.owner);
  const gstin = newGstin("27");
  const period = istMonth();
  return withFlags({ billing_v2: true }, () =>
    withShopGst(shop.shopId, REGULAR_MH(gstin), async () => {
      const items = (await accounts(ctx, "GET", shop.shopId, "pos/items")).body as { id: string; name: string; pricePaise: number | null; gstRateBp: number; stock: number }[];
      const item = need(items.find((i) => (i.pricePaise ?? 0) > 0 && i.stock >= 6), "a priced item with stock");
      // 1. Counter sales: one online now, three made offline earlier this morning and synced together.
      const online = await counterSale(ctx, shop.shopId, { paymentMode: "UPI", lines: [freeLine("SC-43 counter sale", 12_000, 1800, 1)] });
      const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
      const offline = [30, 20, 10].map((m, i) => ({ clientRef: `sc43-${Date.now()}-${i}`, createdAt: at(m), paymentMode: "CASH", lines: [{ shopProductId: item.id, name: item.name, qtyMilli: 1000, pricePaise: item.pricePaise, gstRateBp: item.gstRateBp }] }));
      const synced = await accounts(ctx, "POST", shop.shopId, "pos/sync", { bills: offline });
      expectStatus(synced, 200, "sync the offline bills");
      const results = synced.body as { status: string; invoiceNo: string }[];
      expect(results.map((r) => r.status)).toEqual(["CREATED", "CREATED", "CREATED"]);
      expect(results.map((r) => serialOf(r.invoiceNo)), "numbered straight after the online bill").toEqual([1, 2, 3].map((n) => serialOf(online.invoiceNo) + n));
      const again = await accounts(ctx, "POST", shop.shopId, "pos/sync", { bills: offline });
      expect((again.body as { status: string }[]).map((r) => r.status), "a second sync makes no duplicates").toEqual(["DUPLICATE", "DUPLICATE", "DUPLICATE"]);
      // 2. A purchase from a supplier.
      const purchase = await accounts(ctx, "POST", shop.shopId, "purchases", {
        supplier: { name: "SC-43 Wholesale Traders", gstin: newGstin("27") },
        invoiceNo: `SC43-${Date.now().toString(36)}`,
        invoiceDate: istToday(),
        lines: [{ shopProductId: item.id, description: item.name, qtyMilli: 10_000, ratePaise: 2_000, gstRateBp: 1800 }],
      });
      expectStatus(purchase, 201, "record a purchase");
      // 3. Month end: GSTR-1 and GSTR-3B from the books, GSTR-2B pulled and reconciled.
      expectStatus(await accounts(ctx, "POST", shop.shopId, "portal/filings", { returnType: "GSTR1", period }), 201, "prepare GSTR-1");
      const g3 = await accounts(ctx, "POST", shop.shopId, "portal/filings", { returnType: "GSTR3B", period });
      expectStatus(g3, 201, "prepare GSTR-3B");
      const books = await accounts(ctx, "GET", shop.shopId, `gst/liability?period=${period}`);
      const out = books.body.total.output as { cgst: number; sgst: number };
      expect(g3.body.payload.sup_details.osup_det, "3B outward tax = the books").toMatchObject({ camt: Math.round(out.cgst) / 100, samt: Math.round(out.sgst) / 100 });
      const link = await accounts(ctx, "POST", shop.shopId, "gst/link", { gstin, username: "qa_portal_user", consent: true });
      if (link.status === 409) blocked("the GST portal connection is not switched on here");
      expectStatus(link, 200, "link OTP");
      expectStatus(await accounts(ctx, "POST", shop.shopId, "gst/verify", { otp: "575757" }), 200, "link with the mock OTP");
      expectStatus(await accounts(ctx, "POST", shop.shopId, "gst/pull", { returnType: "GSTR2B", period }), 200, "pull GSTR-2B");
      const recon = await accounts(ctx, "POST", shop.shopId, "gst/recon", { period });
      expectStatus(recon, 200, "reconcile");
      await accounts(ctx, "DELETE", shop.shopId, "gst/link");
      // 4. Tally export (the fix list cleared first: HSN / GST rate on the listings, UQC for each unit).
      expect(await readyForExport(ctx, shop.shopId, `${period}-01`, istToday()), "nothing left to fix").toEqual([]);
      const zip = await ctx.get(`/api/shops/${shop.shopId}/accounts/sync/export?tool=TALLY&from=${period}-01&to=${istToday()}`);
      if (zip.status() === 409) blocked(`the books need fixes before the Tally export: ${(await zip.text()).slice(0, 300)}`);
      expect(zip.status(), "Tally export").toBe(200);
      const files = Object.keys((await JSZip.loadAsync(await zip.body())).files);
      expect(files).toContain("gokesari-tally.xml");
      const sales = (await accounts(ctx, "GET", shop.shopId, "sales")).body as SalesInvoice[];
      return `bills ${online.invoiceNo} + ${results.map((r) => r.invoiceNo).join(", ")} (${sales.length} in the register); purchase; GSTR-1/3B prepared; recon ${JSON.stringify(recon.body.counts)}; Tally ${files.length} files`;
    }),
  );
}, { tier: "local", timeout: 360_000, partial: "the online-order parts (delivery and its invoice, the partial return's credit note, TCS / TDS) are covered by TC-BILL-004/006/007/010 in tests/qa/local/billing-v2.spec.ts" });
