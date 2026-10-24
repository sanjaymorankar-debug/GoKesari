/**
 * Shop onboarding journeys.
 *   SC-12 — from registration to the first sale: identifiers and categories,
 *           GST and PAN verified by operations, the fee recorded, approved
 *           as KESARI; radius, hours, minimum order, products, stock and a
 *           photo; found only inside its zone; the first order delivered.
 *   SC-13 — the same shop registered again (same and another account) is
 *           refused with masked messages; after a rejection the owner's
 *           corrected resubmission updates the same record.
 *   SC-31 — KYC documents with an invalid file and a document operations
 *           reject; approval blocked until the fee is verified; listed only
 *           when ACTIVE.
 *
 * Local tier: the owners and customers are new local accounts; the
 * registration fee schedule is set for the run (admin) and restored; the
 * documents are PDFs with a text layer made at run time.
 */
import type { APIRequestContext } from "@playwright/test";

import {
  api,
  deliverToPerson,
  freeRider,
  freshPerson,
  gstinOf,
  newPan,
  newShopAct,
  personBuys,
  shopRegistration,
  shopStage,
  searchShows,
  testPng,
  textPdf,
  type Person,
} from "../lib/finance-helpers";
import { db } from "../lib/db";
import { call, expectStatus, RUN, why } from "../lib/http";
import { blocked, expect, need, qa } from "../lib/record";
import { world } from "../lib/world";

const local = { tier: "local" as const, timeout: 420_000 };

/** Runs `body` with the registration fee schedule at `paise`, then puts the schedule back. */
async function withFee<T>(paise: number, body: () => Promise<T>): Promise<T> {
  const before = await api("admin", "GET", "/api/registration-fees");
  expectStatus(before, 200, "GET registration fees");
  const previous = before.body.active as { id: string; amountPaise: number } | null;
  const set = await api("admin", "POST", "/api/registration-fees", { amountPaise: paise, reason: `QA journey ${RUN}` });
  expectStatus(set, 201, "set the registration fee");
  try {
    return await body();
  } finally {
    if (previous) await api("admin", "POST", "/api/registration-fees", { amountPaise: previous.amountPaise, reason: `QA journey ${RUN} restore` });
    else await db()`update registration_fees set is_active = false where id = ${set.body.id}`;
  }
}

/** PANs and KYC files are stored encrypted; a server without PAN_ENCRYPTION_KEY answers 500 to them. */
async function needPanStorage(owner: APIRequestContext) {
  const res = await call(owner, "POST", "/api/shops/duplicate-check", { panNumber: "ABCPE1234F" });
  if (res.status === 500) blocked("the server under test has no PAN_ENCRYPTION_KEY, so it cannot store a PAN or a KYC file");
}

async function verificationRows(shopId: string) {
  return db()<{ id: string; doc_type: string; status: string }[]>`select id, doc_type, status from seller_verifications where shop_id = ${shopId}`;
}

/** A customer with an address ~12 km away (outside a 5 km zone, another PIN). */
async function farCustomer(label: string): Promise<Person> {
  const far = await freshPerson(label, { walletPaise: 100_000, address: true });
  await db()`update addresses set latitude = '18.5913', longitude = '73.7389', pincode = '411057', area = 'Hinjewadi' where id = ${far.addressId}`;
  return far;
}

/* ------------------------------------------------------------------ SC-12 */

qa("SC-12", "shop onboarding to first sale: pending → KYC verified → fee recorded → approved KESARI → live inside its zone only; the first order completes", async () => {
  return withFee(30_000, async () => {
    const owner = await freshPerson("sc12-owner");
    const near = await freshPerson("sc12-near", { walletPaise: 200_000, address: true });
    const far = await farCustomer("sc12-far");
    try {
      await needPanStorage(owner.ctx);
      const stages: string[] = [];
      // 1. Registration with identifiers and categories.
      const pan = newPan();
      const gstin = gstinOf(pan);
      const body = await shopRegistration({ panNumber: pan, panHolderName: "QA JOURNEY OWNER", gstin });
      const reg = await call(owner.ctx, "POST", "/api/shops", body);
      expectStatus(reg, [200, 201], "register the shop");
      const shopId = reg.body.id as string;
      const name = body.name as string;
      stages.push((await shopStage(shopId)).lifecycle_status);
      expect(await searchShows(near.ctx, name), "not listed while pending").toBe(false);
      // 2. GST and PAN (and the Shop Act licence) submitted; operations verify.
      for (const [docType, number] of [["PAN", pan], ["GSTIN", gstin], ["SHOP_ACT", body.shopActNumber as string]] as const) {
        const sub = await call(owner.ctx, "POST", `/api/shops/${shopId}/verifications`, { docType, number, consent: true });
        expectStatus(sub, 200, `submit ${docType}`);
      }
      for (const row of await verificationRows(shopId)) {
        if (row.status === "VERIFIED") continue;
        const decided = await api("ops", "POST", `/api/admin/seller-verifications/${row.id}/decision`, { decision: "approve", reason: "QA: checked against the certificate" });
        expectStatus(decided, 200, `operations verify ${row.doc_type}`);
      }
      const afterKyc = await shopStage(shopId);
      stages.push(afterKyc.lifecycle_status);
      expect(afterKyc.lifecycle_status, "KYC done, the fee is owed").toBe("PAYMENT_PENDING");
      // 3. The fee is recorded; the operator approves as KESARI.
      expectStatus(await api("ops", "POST", "/api/shop-payments", { shopId, paymentType: "REGISTRATION_FEE", amountPaise: 30_000, method: "UPI", transactionId: `QA-UPI-${RUN}` }), 201, "record the fee");
      stages.push((await shopStage(shopId)).lifecycle_status);
      expectStatus(await api("ops", "POST", `/api/shops/${shopId}/approve`, { classification: "KESARI" }), 200, "approve as KESARI");
      const live = await shopStage(shopId);
      stages.push(live.lifecycle_status);
      expect([live.status, live.classification], "approved as KESARI").toEqual(["APPROVED", "KESARI"]);
      // 4. Radius, hours, minimum order; products with prices and stock; a photo.
      expectStatus(
        await call(owner.ctx, "PATCH", `/api/shops/${shopId}`, {
          serviceRadiusKm: 3,
          minOrderPaise: 5000,
          openingHours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: "00:00", close: "23:59" })),
        }),
        200,
        "radius 3 km, minimum order ₹50, hours",
      );
      const category = need((world() as unknown as { category?: { id: string } }).category?.id, "the world's QA category");
      expectStatus(await call(owner.ctx, "POST", `/api/shops/${shopId}/product-categories`, { categoryId: category }), [200, 201], "add the QA category");
      const own = await call(owner.ctx, "GET", `/api/shops/${shopId}/products`);
      expectStatus(own, 200, "the owner's listings");
      const listings = (Array.isArray(own.body) ? own.body : own.body.products) as { id: string; productId: string; onlineSaleEnabled: boolean; product: { name: string; kind: string; mrpPaise: number | null } }[];
      const pick = need(listings.find((l) => l.product.kind === "PACKAGED" && (l.product.mrpPaise ?? 0) >= 6000), "a packaged product of ₹60 or more");
      const price = (pick.product.mrpPaise ?? 6000) - 500;
      expectStatus(await call(owner.ctx, "PATCH", `/api/shop-products/${pick.id}`, { onlinePricePaise: price, onlineStock: 12, onlineSaleEnabled: true }), 200, "price and stock");
      const upload = await call(owner.ctx, "POST", "/api/images", undefined, { multipart: { purpose: "PRODUCT", file: { name: "product.png", mimeType: "image/png", buffer: testPng(400, 400) } } });
      expectStatus(upload, 201, "upload a product photo");
      expectStatus(await call(owner.ctx, "POST", `/api/products/${pick.productId}/images`, { storedImageId: upload.body.id, shopProductId: pick.id }), 201, "attach the photo");
      // 5. Found inside the zone only; the first order.
      expect(await searchShows(near.ctx, name), "a customer 1 km away finds the shop").toBe(true);
      expect(await searchShows(far.ctx, name), "a customer 12 km away does not").toBe(false);
      const farTry = await personBuys(far, { shopProductId: pick.id, productId: pick.productId, name: pick.product.name, pricePaise: price, shopId, shopName: name } as never, 1);
      expect(farTry.res.status, `an order from outside the zone: ${why(farTry.res)}`).toBeGreaterThanOrEqual(400);
      await freeRider("rider");
      const { res, order } = await personBuys(near, { shopProductId: pick.id, productId: pick.productId, name: pick.product.name, pricePaise: price, shopId, shopName: name } as never, 1);
      expectStatus(res, 201, "the first order");
      const first = need(order, "the first order");
      for (const action of ["accept", "start", "ready"]) expectStatus(await call(owner.ctx, "POST", `/api/orders/${first.id}/fulfilment`, { action }), 200, `owner ${action}`);
      await deliverToPerson(first.id, first.orderNumber, near, { owner: owner.ctx });
      const [done] = await db()<{ status: string; subtotal: number }[]>`select status, subtotal_paise::int as subtotal from orders where id = ${first.id}`;
      expect(done.status, "the first order completes").toBe("DELIVERED");
      expect(done.subtotal, "charged at the shop's price").toBe(price);
      return `"${name}": ${stages.join(" → ")}; KESARI; radius 3 km, min ₹50; ${listings.length} products from the QA category, "${pick.product.name}" ₹${price / 100} × 12 with a photo; found 1 km away, not 12 km away (order from there ${farTry.res.status}); first order ${first.orderNumber} DELIVERED`;
    } finally {
      for (const p of [owner, near, far]) await p.ctx.dispose();
    }
  });
}, local);

/* ------------------------------------------------------------------ SC-13 */

qa("SC-13", "duplicate shop registration: the same shop again (same and another account) is refused with masked messages; after a rejection the corrected resubmission updates the same record", async () => {
  const first = await freshPerson("sc13-a");
  const other = await freshPerson("sc13-b");
  try {
    const shopAct = newShopAct();
    const body = await shopRegistration({ shopActNumber: shopAct, ownerName: "QA Duplicate Owner" });
    const reg = await call(first.ctx, "POST", "/api/shops", body);
    expectStatus(reg, [200, 201], "first registration");
    const shopId = reg.body.id as string;
    const again = await call(first.ctx, "POST", "/api/shops", body);
    const elsewhere = await call(other.ctx, "POST", "/api/shops", { ...(await shopRegistration()), shopActNumber: shopAct.toLowerCase() });
    const bad: string[] = [];
    for (const [who, res] of [["same account", again], ["another account", elsewhere]] as const) {
      if (res.status !== 409) bad.push(`${who}: ${res.status} (expected 409)`);
      const text = JSON.stringify(res.body);
      const key = shopAct.replace(/[^A-Z0-9]/gi, "").toUpperCase();
      for (const secret of [key.slice(0, -4), body.phone as string, "QA Duplicate Owner"]) if (text.toUpperCase().includes(String(secret).toUpperCase())) bad.push(`${who}'s message shows "${secret}"`);
    }
    const [{ n }] = await db()<{ n: number }[]>`select count(*)::int as n from shops where shop_act_key = ${shopAct.replace(/[^A-Z0-9]/gi, "").toUpperCase()} and deleted_at is null`;
    if (n !== 1) bad.push(`${n} shops hold the licence`);
    // The operator rejects; the owner corrects the address and resubmits.
    expectStatus(await api("ops", "POST", `/api/shops/${shopId}/reject`, { reason: "QA: the address does not match the licence" }), 200, "operator rejects");
    const corrected = { ...body, addressLine1: "7 QA Corrected Lane, Paud Road" };
    const resub = await call(first.ctx, "POST", "/api/shops", corrected);
    expectStatus(resub, [200, 201], "resubmit");
    const [row] = await db()<{ status: string; address_line1: string }[]>`select status, address_line1 from shops where id = ${shopId}`;
    const [{ owned }] = await db()<{ owned: number }[]>`select count(*)::int as owned from shops where owner_id = ${first.id} and deleted_at is null`;
    if (resub.body.id !== shopId) bad.push(`the resubmission made a new shop ${resub.body.id}`);
    if (row.status !== "PENDING_APPROVAL") bad.push(`status after resubmission ${row.status}`);
    if (row.address_line1 !== corrected.addressLine1) bad.push("the correction was not saved");
    if (owned !== 1) bad.push(`the owner has ${owned} shops`);
    expect(bad, bad.join(" | ")).toEqual([]);
    return `same account → 409 "${again.body?.error?.message?.slice(0, 90)}"; another account → 409 "${elsewhere.body?.error?.message?.slice(0, 90)}" (no full licence, phone or owner name); rejected, corrected and resubmitted → same record ${shopId.slice(0, 8)}…, PENDING_APPROVAL, new address saved`;
  } finally {
    await first.ctx.dispose();
    await other.ctx.dispose();
  }
}, local);

/* ------------------------------------------------------------------ SC-31 */

qa("SC-31", "shop onboarding with KYC documents and the fee gate: an invalid file refused; a rejected document re-uploaded; approval blocked until the fee is verified; KYC_PENDING → PAYMENT_PENDING → VERIFIED → ACTIVE; listed only when ACTIVE", async () => {
  return withFee(25_000, async () => {
    const owner = await freshPerson("sc31-owner");
    const near = await freshPerson("sc31-near", { walletPaise: 50_000, address: true });
    try {
      await needPanStorage(owner.ctx);
      const pan = newPan();
      const gstin = gstinOf(pan);
      const shopAct = newShopAct();
      const body = await shopRegistration({ shopActNumber: shopAct, ownerName: "QA KYC Owner" });
      const reg = await call(owner.ctx, "POST", "/api/shops", body);
      expectStatus(reg, [200, 201], "register");
      const shopId = reg.body.id as string;
      const name = body.name as string;
      const stages: string[] = [];
      const listed: string[] = [];
      const stage = async () => {
        const s = (await shopStage(shopId)).lifecycle_status;
        if (stages.at(-1) !== s) stages.push(s);
        listed.push(`${s}:${(await searchShows(near.ctx, name)) ? "listed" : "not listed"}`);
        return s;
      };
      await stage();
      const docs: Record<string, string[]> = {
        PAN: ["INCOME TAX DEPARTMENT", "GOVT. OF INDIA", "Permanent Account Number Card", pan, "Name", "QA KYC OWNER", "Date of Birth", "01/01/1980"],
        GSTIN: ["Government of India", "Form GST REG-06", "Registration Certificate", `Registration Number : ${gstin}`, "Legal Name : QA KYC OWNER", `Trade Name : ${name}`, "Date of Liability : 01/04/2020"],
        SHOP_ACT: ["Government of Maharashtra", "Maharashtra Shops and Establishments Act 2017", "INTIMATION RECEIPT - FORM F", `Registration No : ${shopAct}`, `Name of Establishment : ${name}`, "Name of Employer : QA KYC OWNER", "Date : 01/04/2024"],
      };
      const number = { PAN: pan, GSTIN: gstin, SHOP_ACT: shopAct } as Record<string, string>;
      const upload = async (docType: string, data: Buffer, file: string, mime = "application/pdf") =>
        call(owner.ctx, "POST", `/api/shops/${shopId}/documents/read`, undefined, { multipart: { docType, file: { name: file, mimeType: mime, buffer: data } } });
      const confirm = async (docType: string, uploadId: string) =>
        call(owner.ctx, "POST", `/api/shops/${shopId}/documents/${uploadId}/confirm`, { number: number[docType], name: "QA KYC OWNER", validUntil: null, consent: true });
      // 1. An invalid file (a web page named .pdf) is refused; the three documents are uploaded.
      const invalid = await upload("PAN", Buffer.from("<!doctype html><html><body><script>alert(1)</script>not a PAN</body></html>"), "pan.pdf");
      expect(invalid.status, `an HTML page named .pdf: ${why(invalid)}`).toBe(422);
      for (const docType of ["PAN", "GSTIN", "SHOP_ACT"]) {
        const read = await upload(docType, textPdf(docs[docType]), `${docType}.pdf`);
        expectStatus(read, 201, `read ${docType}`);
        expectStatus(await confirm(docType, read.body.id), 200, `confirm ${docType}`);
      }
      // 2. Operations reject the Shop Act document; the owner re-uploads it; the rest are verified.
      const rows = await verificationRows(shopId);
      const shopActRow = need(rows.find((r) => r.doc_type === "SHOP_ACT"), "the Shop Act verification");
      expectStatus(await api("ops", "POST", `/api/admin/seller-verifications/${shopActRow.id}/decision`, { decision: "reject", reason: "QA: the stamp is not readable" }), 200, "reject the Shop Act document");
      const [rejected] = await db()<{ status: string }[]>`select status from seller_verifications where id = ${shopActRow.id}`;
      expect(rejected.status, "the document is rejected").toBe("FAILED");
      const again = await upload("SHOP_ACT", textPdf([...docs.SHOP_ACT, "Seal of the Inspector"]), "SHOP_ACT-2.pdf");
      expectStatus(again, 201, "re-upload the Shop Act document");
      expectStatus(await confirm("SHOP_ACT", again.body.id), 200, "confirm it");
      for (const row of await verificationRows(shopId)) {
        if (row.status === "VERIFIED" || !["PAN", "GSTIN", "SHOP_ACT"].includes(row.doc_type)) continue;
        expectStatus(await api("ops", "POST", `/api/admin/seller-verifications/${row.id}/decision`, { decision: "approve", reason: "" }), 200, `verify ${row.doc_type}`);
      }
      expect(await stage(), "documents verified, the fee is owed").toBe("PAYMENT_PENDING");
      // 3. Approval before the fee is refused.
      const early = await api("ops", "POST", `/api/shops/${shopId}/approve`, { classification: "GREEN" });
      expect(early.status, `approve before the fee: ${why(early)}`).toBe(409);
      expect((await shopStage(shopId)).status, "still pending").toBe("PENDING_APPROVAL");
      // 4. The fee is recorded and verified; the operator approves.
      expectStatus(await api("ops", "POST", "/api/shop-payments", { shopId, paymentType: "REGISTRATION_FEE", amountPaise: 25_000, method: "BANK_TRANSFER", transactionId: `QA-NEFT-${RUN}` }), 201, "record the fee");
      expect(await stage(), "fee verified").toBe("VERIFIED");
      expectStatus(await api("ops", "POST", `/api/shops/${shopId}/approve`, { classification: "GREEN" }), 200, "approve");
      // 5. The customer finds the shop.
      expect(await stage(), "live").toBe("ACTIVE");
      expect(listed, `listed only when ACTIVE: ${listed.join(", ")}`).toEqual(stages.map((s) => `${s}:${s === "ACTIVE" ? "listed" : "not listed"}`));
      return `HTML-as-PDF → 422; PAN, GSTIN, Shop Act uploaded; Shop Act rejected ("the stamp is not readable") and re-uploaded; ${stages.join(" → ")}; approve before the fee → 409 "${early.body?.error?.message?.slice(0, 80)}"; ${listed.join(", ")}`;
    } finally {
      await owner.ctx.dispose();
      await near.ctx.dispose();
    }
  });
}, local);
