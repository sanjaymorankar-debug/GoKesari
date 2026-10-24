/**
 * Paying journeys.
 *   SC-29 — an order paid online (sandbox UPI), delivered with a photo at the
 *           door, its tax invoice downloaded, one item returned and refunded
 *           to the original payment with a credit note, reconciliation run;
 *           a second customer abandons the payment page: no order, no charge,
 *           no stock held.
 *   SC-32 — a cart from two shops with a coupon (an expired one refused),
 *           scheduled slots (a full slot refused) and one parent reference;
 *           one shop rejects its order and only that part is refunded, with
 *           its share of the discount.
 *
 * Local tier: online payments run on the sandbox gateway (rule
 * onlinePayments), invoices, photo proof, coupons, parent references and
 * slots are switched on for the journey (rules restored); shop A is given a
 * GSTIN for the invoice and its earlier details put back; the abandoned
 * payment's expiry is moved to now, as the passing of time would.
 */
import {
  addDaysIso,
  api,
  checkoutLines,
  cron,
  dbStock,
  ensureFunds,
  freeRider,
  freshListing,
  freshPerson,
  istDate,
  mailedDeliveryCode,
  offerFor,
  packOrder,
  payOnSandbox,
  personBuys,
  pickupCode,
  riderAction,
  rid,
  shopAction,
  shopId,
  testPng,
  userOf,
  walletBalance,
  withRules,
} from "../lib/finance-helpers";
import { as } from "../lib/actors";
import { db } from "../lib/db";
import { call, expectStatus, poll, RUN, why } from "../lib/http";
import { expect, need, qa } from "../lib/record";

const local = { tier: "local" as const, timeout: 480_000 };
const GSTIN = "27AAACQ1234A1Z5";

async function statusOf(orderId: string) {
  const [row] = await db()<{ status: string }[]>`select status from orders where id = ${orderId}`;
  return row?.status;
}

/* ------------------------------------------------------------------ SC-29 */

qa("SC-29", "order paid online, invoiced and refunded to source: CAPTURED and reconciled; invoice matches the order; the return refunded to the original payment with a credit note; an abandoned payment leaves no order, charge or held stock", async ({ browser }) => {
  const [shopBefore] = await db()<{ gstin: string | null; gst_status: string }[]>`select gstin, gst_status from shops where id = ${shopId("A")}`;
  await db()`update shops set gstin = ${GSTIN}, gst_status = 'REGISTERED' where id = ${shopId("A")}`;
  try {
    return await withRules(
      { onlinePayments: { enabled: true }, invoicing: { enabled: true, defaultGstRateBp: 0 }, deliveryProof: { photoRequired: true }, returns: { pickupByRider: false } },
      async () => {
        await freeRider("rider");
        const listing = await freshListing({ name: "QA Online Honey", pricePaise: 25_000, stock: 10, gstRateBp: 500, hsn: "0409" });
        const wallet = await walletBalance();
        // 1. Checkout and pay by UPI.
        const placed = await checkoutLines([{ listing, quantity: 2 }], { method: "ONLINE" });
        expectStatus(placed.res, 201, "online checkout");
        const order = placed.orders[0];
        const redirect = need(placed.res.body.payment?.redirectUrl as string | undefined, "the sandbox payment link");
        await payOnSandbox(browser, "customer", redirect, "SUCCESS", "UPI");
        await poll(() => statusOf(order.id), (s) => s === "CONFIRMED", 20_000, 1000);
        const [intent] = await db()<{ id: string; status: string; amount: number }[]>`select id, status, amount_paise::int as amount from payment_intents where purpose = 'ORDER' and reference_id = ${order.id} order by created_at desc`;
        const bad: string[] = [];
        if (intent?.status !== "CAPTURED") bad.push(`payment ${intent?.status} after paying`);
        if ((await walletBalance()) !== wallet) bad.push("the wallet moved for an online order");
        // 2. Shop fulfils; the rider delivers with a photo.
        await packOrder(order.id);
        const offer = await offerFor(order.id, "rider");
        if (offer.status === "OFFERED") expectStatus(await riderAction(offer.deliveryOrderId, "accept"), 200, "accept");
        const code = await pickupCode(order.id);
        expectStatus(await riderAction(offer.deliveryOrderId, "pickup", code ? { pickupCode: code } : {}), 200, "pickup");
        const started = Date.now() - 2000;
        expectStatus(await riderAction(offer.deliveryOrderId, "start"), 200, "start");
        const otp = await mailedDeliveryCode(userOf("customer").email, order.orderNumber, started);
        const noPhoto = await riderAction(offer.deliveryOrderId, "deliver", { otp });
        if (noPhoto.status < 400) bad.push(`delivered without the required photo (${noPhoto.status})`);
        const photo = await call(await as("rider"), "POST", `/api/delivery-orders/${offer.deliveryOrderId}/proof`, undefined, { multipart: { file: { name: "door.png", mimeType: "image/png", buffer: testPng(320, 320) } } });
        expectStatus(photo, 201, "photo at the door");
        expectStatus(await riderAction(offer.deliveryOrderId, "deliver", { otp }), 200, "deliver with the code and the photo");
        // 3. The tax invoice.
        const [inv] = await db()<{ id: string; kind: string; total: number; number: string }[]>`select id, kind, total_paise::int as total, invoice_number as number from tax_invoices where order_id = ${order.id}`;
        if (!inv) bad.push("no invoice issued at delivery");
        const [o] = await db()<{ subtotal: number; total: number }[]>`select subtotal_paise::int as subtotal, total_paise::int as total from orders where id = ${order.id}`;
        if (inv && inv.total !== o.subtotal) bad.push(`invoice total ${inv.total} ≠ goods ${o.subtotal}`);
        const pdf = inv ? await call(await as("customer"), "GET", `/api/invoices/${inv.id}/pdf`) : null;
        if (pdf && (pdf.status !== 200 || !String(pdf.headers["content-type"]).includes("pdf"))) bad.push(`invoice PDF ${pdf.status}`);
        // 4. One item returned and refunded.
        const [line] = await db()<{ id: string }[]>`select id from order_items where order_id = ${order.id}`;
        const ret = await api("customer", "POST", `/api/orders/${order.id}/returns`, { reason: "MISSING_ITEM", comment: "QA: one jar missing", items: [{ orderItemId: line.id, quantityMilli: 1000, condition: "UNOPENED" }] });
        expectStatus(ret, 201, "return one item");
        expectStatus(await api("shop", "PATCH", `/api/returns/${ret.body.id}`, { action: "approve", note: "QA approved" }), 200, "approve");
        expectStatus(await api("shop", "PATCH", `/api/returns/${ret.body.id}`, { action: "receive" }), 200, "received at the shop");
        const inspect = await api("shop", "PATCH", `/api/returns/${ret.body.id}`, { action: "inspect", outcome: "ACCEPT", note: "QA: one jar refunded" });
        if (inspect.status !== 200) bad.push(`refund on inspection → ${inspect.status} ${why(inspect)}`);
        const [r] = await db()<{ status: string }[]>`select status from return_requests where id = ${ret.body.id}`;
        await cron("payments-reconcile");
        const [after] = await db()<{ status: string; refunded: number }[]>`select status, refunded_paise::int as refunded from payment_intents where id = ${intent.id}`;
        const toSource = await db()<{ status: string; amount: number }[]>`select status, amount_paise::int as amount from payment_refunds where intent_id = ${intent.id}`;
        const credit = await db()<{ reason: string; total: number }[]>`select reason, total_paise::int as total from credit_notes where order_id = ${order.id}`;
        const walletCredit = (await walletBalance()) - wallet;
        if (r.status !== "REFUND_COMPLETED") bad.push(`return ${r.status}`);
        if (toSource.length !== 1 || toSource[0].amount !== 25_000) bad.push(`refunds to the original payment: ${JSON.stringify(toSource)} (payment ${after.status}, refunded ${after.refunded})`);
        if (walletCredit !== 0) bad.push(`₹${walletCredit / 100} went to the wallet instead`);
        if (!credit.some((c) => c.reason === "RETURN")) bad.push(`credit notes: ${JSON.stringify(credit)}`);
        // 5. Reconciliation.
        const today = istDate();
        expectStatus(await api("admin", "POST", "/api/finance/reconciliation", { from: addDaysIso(today, -1), to: addDaysIso(today, 1) }), 200, "run reconciliation");
        const [rec] = await db()<{ status: string; expected: number | null; actual: number | null; detail: string | null }[]>`
          select status, expected_paise::int as expected, actual_paise::int as actual, detail from reconciliation_records where entity_id = ${order.id} and check_type = 'ORDER_PAYMENT'`;
        if (rec?.status !== "MATCHED") bad.push(`reconciliation ORDER_PAYMENT ${rec?.status ?? "none"} (expected ${rec?.expected} found ${rec?.actual}: ${rec?.detail ?? ""})`);
        // 6. A second customer abandons the payment page.
        const second = await freshPerson("sc29-abandon", { walletPaise: 10_000, address: true });
        try {
          const stock = await dbStock(listing.shopProductId);
          const left = await personBuys(second, listing, 3, { method: "ONLINE" });
          expectStatus(left.res, 201, "the second customer's online checkout");
          const leftOrder = need(left.order, "the abandoned order");
          await db()`update payment_intents set expires_at = now() - interval '1 minute' where purpose = 'ORDER' and reference_id = ${leftOrder.id}`;
          // The sandbox gateway answers from its own order row, as a real gateway would: that expires too.
          await db()`update payment_sandbox_orders set expires_at = now() - interval '1 minute'
                     where gateway_order_id in (select gateway_order_id from payment_intents where purpose = 'ORDER' and reference_id = ${leftOrder.id})`;
          await cron("payments-reconcile");
          const leftStatus = await statusOf(leftOrder.id);
          const [w2] = await db()<{ balance: number }[]>`select balance_paise::int as balance from wallets where user_id = ${second.id}`;
          if (!["PAYMENT_FAILED", "CANCELLED"].includes(leftStatus ?? "")) bad.push(`abandoned order is ${leftStatus}`);
          if (w2.balance !== 10_000) bad.push("the abandoned payment charged the wallet");
          if ((await dbStock(listing.shopProductId)) !== stock) bad.push(`stock ${await dbStock(listing.shopProductId)} after abandoning (was ${stock})`);
        } finally {
          await second.ctx.dispose();
        }
        expect(bad, bad.join("\n")).toEqual([]);
        return `${order.orderNumber}: paid by UPI (${intent.status}), delivered with a photo (refused without), ${inv?.kind} ${inv?.number} = goods ₹${o.subtotal / 100}, PDF; return of 1 → ${r.status}, refund to source ${toSource.map((t) => `${t.status} ₹${t.amount / 100}`).join(", ")}, credit note ${credit.map((c) => `₹${c.total / 100}`).join(", ")}; reconciliation MATCHED; abandoned payment → no order, charge or stock`;
      },
    );
  } finally {
    await db()`update shops set gstin = ${shopBefore.gstin}, gst_status = ${shopBefore.gst_status} where id = ${shopId("A")}`;
  }
}, local);

/* ------------------------------------------------------------------ SC-32 */

async function slotsOf(shop: string): Promise<{ key: string; date: string; label: string }[]> {
  const res = await api("customer", "GET", `/api/checkout/scheduled-slots?shopId=${shop}`);
  expectStatus(res, 200, "scheduled slots");
  return res.body.slots ?? [];
}

qa("SC-32", "multi-shop purchase: an expired coupon refused and a valid one applied once; scheduled slots carried on both orders (a full slot refused); one master reference; one shop rejects and only its part is refunded, in proportion", async () => {
  const a = shopId("A");
  const b = shopId("B");
  return withRules({ coupons: { enabled: true }, parentOrders: { enabled: true }, scheduledSlots: { enabled: true }, deliverySlots: { enabled: true } }, async () => {
    const created: { id: string; body: Record<string, unknown> }[] = [];
    let capacity: string | null = null;
    let fillId: string | null = null;
    const expired = `QAOLD${RUN}`.toUpperCase().slice(0, 32);
    const valid = `QAFLAT${RUN}`.toUpperCase().slice(0, 32);
    const filler = await freshPerson("sc32-filler", { walletPaise: 100_000, address: true });
    try {
      const cap = await api("admin", "PUT", "/api/admin/delivery-slots", { shopId: a, expressPerHour: null, standardPerHour: null, scheduledPerDay: null, scheduledPerSlot: 1 });
      expectStatus(cap, 200, "one order per slot at shop A");
      capacity = cap.body.id;
      const yesterday = new Date(Date.now() - 2 * 86_400_000).toISOString();
      for (const body of [
        { code: expired, discountType: "FLAT", flatPaise: 3000, minOrderPaise: 10_000, startsAt: new Date(Date.now() - 10 * 86_400_000).toISOString(), expiresAt: yesterday },
        { code: valid, discountType: "FLAT", flatPaise: 3000, minOrderPaise: 10_000, perCustomerLimit: 1 },
      ]) {
        const res = await api("admin", "POST", "/api/admin/coupons", body);
        expectStatus(res, 201, `coupon ${body.code}`);
        created.push({ id: res.body.id, body });
      }
      await ensureFunds("customer", 200_000);
      const la = await freshListing({ name: "QA Slot Rice", shop: "A", pricePaise: 10_000, stock: 20 });
      const lb = await freshListing({ name: "QA Slot Lassi", shop: "B", pricePaise: 15_000, stock: 20 });
      // Shop A's first slot tomorrow is taken by another customer.
      const tomorrow = addDaysIso(istDate(), 1);
      const slotsA = (await slotsOf(a)).filter((s) => s.date === tomorrow);
      const slotsB = (await slotsOf(b)).filter((s) => s.date === tomorrow);
      need(slotsA[1], "two slots tomorrow at shop A");
      need(slotsB[0], "a slot tomorrow at shop B");
      const fill = await personBuys(filler, la, 1, { extra: { deliveryWindows: { [a]: "SCHEDULED" }, scheduledSlots: { [a]: slotsA[0].key } } });
      expectStatus(fill.res, 201, "another customer books shop A's first slot");
      fillId = fill.order?.id ?? null;
      const bad: string[] = [];
      // 1.–2. Cart from both shops; the expired coupon, then the valid one.
      await call(await as("customer"), "DELETE", "/api/cart");
      for (const [l, q] of [[la, 2], [lb, 1]] as const) expectStatus(await call(await as("customer"), "POST", "/api/cart", { shopProductId: l.shopProductId, quantity: q }), [200, 201], `add ${l.name}`);
      const old = await api("customer", "POST", "/api/checkout/coupon", { code: expired, requestId: rid("cp") });
      if (old.status < 400 || old.status >= 500) bad.push(`expired coupon → ${old.status}`);
      const preview = await api("customer", "POST", "/api/checkout/coupon", { code: valid, requestId: rid("cp") });
      expectStatus(preview, 200, "valid coupon preview");
      // 3. Slots: the full one refused, then free ones.
      const address = (await db()<{ id: string }[]>`select id from addresses where user_id = ${userOf("customer").id!} and is_default limit 1`)[0]?.id ?? null;
      const base = { addressId: address, paymentMethod: "WALLET", couponCode: valid, acknowledgeClosedShopIds: [a, b], deliveryWindows: { [a]: "SCHEDULED", [b]: "SCHEDULED" } };
      const full = await api("customer", "POST", "/api/checkout", { ...base, requestId: rid("full"), scheduledSlots: { [a]: slotsA[0].key, [b]: slotsB[0].key } });
      if (full.status < 400 || full.status >= 500) bad.push(`the full slot → ${full.status}`);
      // 4. Pays.
      const before = await walletBalance();
      const res = await api("customer", "POST", "/api/checkout", { ...base, requestId: rid("ok"), scheduledSlots: { [a]: slotsA[1].key, [b]: slotsB[0].key } });
      expectStatus(res, 201, "checkout");
      const ids = (res.body.orders as { id: string }[]).map((o) => o.id);
      const rows = await db()<{ id: string; shop_id: string; subtotal: number; discount: number; total: number; group: string | null; slot: Date | null; coupon: string | null }[]>`
        select id, shop_id, subtotal_paise::int as subtotal, discount_paise::int as discount, total_paise::int as total, order_group_id as group, scheduled_slot_start as slot, coupon_code as coupon from orders where id = any(${ids})`;
      const ra = need(rows.find((r) => r.shop_id === a), "shop A's order");
      const rb = need(rows.find((r) => r.shop_id === b), "shop B's order");
      if (!res.body.parentReference || !ra.group || ra.group !== rb.group) bad.push(`master reference ${res.body.parentReference}, groups ${ra.group} / ${rb.group}`);
      if (ra.discount + rb.discount !== 3000) bad.push(`discount ${ra.discount} + ${rb.discount} ≠ ₹30 once`);
      const shareA = Math.round((3000 * ra.subtotal) / (ra.subtotal + rb.subtotal));
      if (Math.abs(ra.discount - shareA) > 1) bad.push(`shop A's share of the discount ${ra.discount}, expected about ${shareA} (goods ${ra.subtotal} of ${ra.subtotal + rb.subtotal})`);
      if (!ra.slot || !rb.slot) bad.push("a slot is missing on an order");
      const charged = before - (await walletBalance());
      if (charged !== ra.total + rb.total) bad.push(`charged ${charged} ≠ ${ra.total} + ${rb.total}`);
      // 5. Shop B rejects its order: only that part is refunded.
      const mid = await walletBalance();
      expectStatus(await shopAction(rb.id, "reject", { reason: "QA: out of lassi today" }, "shopB"), 200, "shop B rejects");
      const refunded = (await walletBalance()) - mid;
      if (refunded !== rb.total) bad.push(`refund for shop B's part ${refunded}, expected ${rb.total} (its goods less its share of the discount)`);
      if ((await statusOf(ra.id)) !== "CONFIRMED") bad.push(`shop A's order became ${await statusOf(ra.id)}`);
      await api("customer", "PATCH", `/api/orders/${ra.id}/status`, { status: "CANCELLED", note: "QA cleanup" });
      expect(bad, bad.join("\n")).toEqual([]);
      return `expired coupon → ${old.status} "${old.body?.error?.message ?? ""}"; full slot → ${full.status} "${full.body?.error?.message ?? ""}"; ${res.body.parentReference}: A ₹${ra.subtotal / 100} − ₹${ra.discount / 100}, B ₹${rb.subtotal / 100} − ₹${rb.discount / 100} (₹30 once, in proportion), both with a slot tomorrow; shop B rejected → ₹${refunded / 100} back, shop A's order untouched`;
    } finally {
      for (const c of created) await api("admin", "PUT", `/api/admin/coupons/${c.id}`, { ...c.body, active: false });
      if (capacity) await api("admin", "DELETE", `/api/admin/delivery-slots/${capacity}`);
      if (fillId) await call(filler.ctx, "PATCH", `/api/orders/${fillId}/status`, { status: "CANCELLED", note: "QA cleanup" });
      await filler.ctx.dispose();
    }
  });
}, local);
