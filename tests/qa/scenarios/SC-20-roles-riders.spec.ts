/**
 * People with several jobs, closed shops and riders.
 *   SC-20 — a shop owner applies as a rider and is approved, switches role
 *           and delivers another shop's order, switches back and fulfils an
 *           order of the own shop, then orders personally as a customer;
 *           each role works and the data stays separated by role.
 *   SC-21 — an order from a closed shop: the customer confirms the prompt
 *           and pays; customer and shop are alerted at once and once more
 *           when the shop opens; the order then proceeds normally.
 *   SC-34 — a rider's bank change waits for review before it is used; two
 *           nearby READY orders are batched to the rider and delivered each
 *           with its own code and photo; once operations block the rider no
 *           further offers reach them.
 *
 * Local tier: new owners' shops beside shop A; the riders' positions and
 * online state are arranged (the other riders offline so the offers are
 * predictable); rules batching and deliveryProof are switched on for SC-34
 * and restored; the timeout sweep is run by hand as the scheduler would.
 */
import {
  api,
  buy,
  cron,
  deliverToPerson,
  ensureFunds,
  freeRider,
  freshListing,
  freshPerson,
  mailedDeliveryCode,
  offerFor,
  ownerAction,
  packOrder,
  partnerId,
  personBuys,
  pickupCode,
  riderAction,
  sellingShop,

  testPng,
  userOf,
  withRules,
} from "../lib/finance-helpers";
import { as } from "../lib/actors";
import { db } from "../lib/db";
import { call, expectStatus, poll, RUN } from "../lib/http";
import { expect, need, qa } from "../lib/record";
import { world } from "../lib/world";

const local = { tier: "local" as const, timeout: 480_000 };
const HOME = () => world().location ?? { pincode: "411038", lat: 18.5074, lng: 73.8077 };

async function statusOf(orderId: string) {
  const [row] = await db()<{ status: string }[]>`select status from orders where id = ${orderId}`;
  return row?.status;
}

/* ------------------------------------------------------------------ SC-20 */

qa("SC-20", "multi-role user: a shop owner approved as a rider delivers another shop's order, fulfils an order in the own shop and orders personally; each role works and the data stays separated by role", async () => {
  const shop = await sellingShop("sc20");
  const me = shop.owner;
  let partner: string | null = null;
  try {
    // 1. The owner applies as a rider; operations approve.
    const applied = await call(me.ctx, "POST", "/api/delivery-partner", { fullName: "QA Owner Rider", mobile: me.mobile, vehicleType: "SCOOTER", latitude: HOME().lat, longitude: HOME().lng, operatingRadiusKm: 10 });
    expectStatus(applied, 201, "apply as a rider");
    partner = applied.body.id as string;
    await api("ops", "PATCH", `/api/delivery-partner/${partner}`, { action: "start_review" });
    expectStatus(await api("ops", "PATCH", `/api/delivery-partner/${partner}`, { action: "approve", notes: "QA: documents seen" }), 200, "operations approve");
    const roles = await call(me.ctx, "GET", "/api/me/roles");
    const held = (roles.body.roles as { role: string }[] | string[]).map((r) => (typeof r === "string" ? r : r.role));
    const bad: string[] = [];
    for (const r of ["SHOP_OWNER", "DELIVERY_PARTNER"]) if (!held.includes(r)) bad.push(`roles held: ${held.join(", ")} (no ${r})`);
    // 2. As a rider: deliver an order of shop A.
    expectStatus(await call(me.ctx, "PUT", "/api/me/roles", { role: "DELIVERY_PARTNER" }), 200, "switch to rider");
    await db()`update delivery_partners set is_online = false where is_online`;
    expectStatus(await call(me.ctx, "PATCH", "/api/delivery-partner/status", { action: "online", latitude: HOME().lat + 0.001, longitude: HOME().lng + 0.001 }), 200, "go online");
    const asRiderShop = await call(me.ctx, "GET", `/api/shops/${shop.shopId}/inventory`);
    await ensureFunds("customer", 100_000);
    const listing = await freshListing({ name: "QA Multi Role Ghee", pricePaise: 9000, stock: 10 });
    const forOther = await buy(listing, 1);
    await packOrder(forOther.id);
    const offer = await poll(
      async () => (await call(me.ctx, "GET", "/api/delivery-partner/deliveries")).body?.active as { id: string; orderId: string; status: string } | null,
      (a) => a?.orderId === forOther.id,
      45_000,
    );
    need(offer?.orderId === forOther.id ? offer : null, "an offer to the owner-rider for shop A's order");
    const act = (action: string, extra: Record<string, unknown> = {}) => call(me.ctx, "PATCH", `/api/delivery-orders/${offer!.id}`, { action, ...extra });
    if (offer!.status === "OFFERED") expectStatus(await act("accept"), 200, "accept");
    const code = await pickupCode(forOther.id);
    expectStatus(await act("pickup", code ? { pickupCode: code } : {}), 200, "pickup at shop A");
    const started = Date.now() - 2000;
    expectStatus(await act("start"), 200, "start");
    expectStatus(await act("deliver", { otp: await mailedDeliveryCode(userOf("customer").email, forOther.orderNumber, started) }), 200, "deliver");
    await call(me.ctx, "PATCH", "/api/delivery-partner/status", { action: "offline" });
    // 3. Back as the shop owner: fulfil an order of the own shop.
    expectStatus(await call(me.ctx, "PUT", "/api/me/roles", { role: "SHOP_OWNER" }), 200, "switch back to the shop");
    const asShopRider = await call(me.ctx, "GET", "/api/delivery-partner/deliveries");
    const own = await buy(shop.listing, 1);
    for (const a of ["accept", "start", "ready"] as const) expectStatus(await ownerAction(me.ctx, own.id, a), 200, `own shop: ${a}`);
    // 4. A personal order as a customer.
    expectStatus(await call(me.ctx, "PUT", "/api/me/roles", { role: "CUSTOMER" }), 200, "switch to customer");
    await db()`insert into addresses (user_id, line1, area, city, state, pincode, latitude, longitude, address_type, recipient_name, is_default, location_verified, location_verified_at, location_source)
      values (${me.id}, ${`QA owner home ${RUN}`}, 'Kothrud', 'Pune', 'Maharashtra', ${HOME().pincode}, ${String(HOME().lat + 0.009)}, ${String(HOME().lng)}, 'HOME', 'QA Owner', true, true, now(), 'MANUAL_ENTRY')`;
    const [addr] = await db()<{ id: string }[]>`select id from addresses where user_id = ${me.id} and is_default limit 1`;
    me.addressId = addr.id;
    await db()`
      with w as (select id, balance_paise from wallets where user_id = ${me.id} for update)
      , upd as (update wallets set balance_paise = balance_paise + 50000, updated_at = now() where id = (select id from w) returning id)
      insert into wallet_transactions (wallet_id, user_id, type, amount_paise, previous_balance_paise, new_balance_paise, idempotency_key, description)
      select w.id, ${me.id}, 'TOP_UP', 50000, w.balance_paise, w.balance_paise + 50000, ${`qa-sc20-${RUN}`}, 'QA top-up' from w`;
    const personal = await personBuys(me, listing, 1);
    expectStatus(personal.res, 201, "a personal order");
    const asCustomerShop = await call(me.ctx, "GET", `/api/shops/${shop.shopId}/inventory`);
    const mine = await call(me.ctx, "GET", "/api/orders");
    const myOrders = ((mine.body?.orders ?? mine.body ?? []) as { id: string }[]).map((o) => o.id);
    // Separation by role.
    // The owner's own shop stays reachable in any active role (requireShopAccess grants by ownership — the same person); separation is about lists mixing.
    if (asShopRider.status < 400 && asShopRider.body?.active) bad.push("as a shop owner the rider's live delivery is shown");
    if (!myOrders.includes(personal.order!.id)) bad.push("the personal order is not in the customer's orders");
    if (myOrders.includes(own.id)) bad.push("the shop's incoming order shows among the personal orders");
    if ((await statusOf(forOther.id)) !== "DELIVERED") bad.push(`shop A's order is ${await statusOf(forOther.id)}`);
    await call(me.ctx, "PATCH", `/api/orders/${personal.order!.id}/status`, { status: "CANCELLED", note: "QA cleanup" });
    await api("customer", "PATCH", `/api/orders/${own.id}/status`, { status: "CANCELLED", note: "QA cleanup" });
    expect(bad, bad.join("\n")).toEqual([]);
    return `applied and approved as rider (roles ${held.join(", ")}); as rider delivered ${forOther.orderNumber} for shop A; as owner took ${own.orderNumber} to READY; as customer ordered ${personal.order!.orderNumber}; by role: rider → own inventory ${asRiderShop.status}, owner → rider deliveries ${asShopRider.status}, customer → own inventory ${asCustomerShop.status}; personal orders list excludes the shop's orders`;
  } finally {
    if (partner) await db()`update delivery_partners set is_online = false where id = ${partner}`;
    await freeRider("rider");
    await me.ctx.dispose();
  }
}, { ...local, partial: "separation is checked on the personal order list (no shop orders) and the rider's live job; the owner's own shop APIs stay open in any active role, as the owner is the same person (src/server/authz/guards.ts requireShopAccess grants by ownership)" });

/* ------------------------------------------------------------------ SC-21 */

qa("SC-21", "order from a closed shop: the customer confirms the closed-shop prompt and pays; both are alerted at once and once more at opening; the order then proceeds normally", async () => {
  const shop = await sellingShop("sc21");
  try {
    const today = new Date(Date.now() + 330 * 60_000).getUTCDay();
    const hours = (closedToday: boolean) => [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: "00:00", close: "23:59", ...(closedToday && day === today ? { closed: true } : {}) }));
    // 1. The shop is closed today.
    expectStatus(await call(shop.owner.ctx, "PATCH", `/api/shops/${shop.shopId}`, { openingHours: hours(true) }), 200, "closed today");
    await ensureFunds("customer", 100_000);
    const since = new Date();
    // 2. The prompt, then the confirmed order.
    await api("customer", "DELETE", "/api/cart");
    expectStatus(await api("customer", "POST", "/api/cart", { shopProductId: shop.listing.shopProductId, quantity: 1 }), [200, 201], "add to cart");
    const address = (await db()<{ id: string }[]>`select id from addresses where user_id = ${userOf("customer").id!} and is_default limit 1`)[0]?.id ?? null;
    const prompt = await api("customer", "POST", "/api/checkout", { requestId: `qa-${RUN}-closed-a`, addressId: address, paymentMethod: "WALLET" });
    const bad: string[] = [];
    if (prompt.status !== 409 || !/closed right now/i.test(prompt.body?.error?.message ?? "")) bad.push(`without confirming: ${prompt.status} "${prompt.body?.error?.message ?? ""}"`);
    const placed = await api("customer", "POST", "/api/checkout", { requestId: `qa-${RUN}-closed-b`, addressId: address, paymentMethod: "WALLET", acknowledgeClosedShopIds: [shop.shopId] });
    expectStatus(placed, 201, "confirmed checkout");
    const order = placed.body.orders[0] as { id: string; orderNumber: string };
    const notes = async (userId: string) => db()<{ type: string; title: string }[]>`select type, title from notifications where user_id = ${userId} and created_at >= ${since} and body like ${`%${order.orderNumber}%`} order by created_at`;
    const count = (list: { title: string }[], title: string) => list.filter((n) => n.title === title).length;
    const custNow = await notes(userOf("customer").id!);
    const shopNow = await notes(shop.owner.id);
    if (count(custNow, "Order placed — shop is closed now") !== 1) bad.push(`customer at checkout: ${custNow.map((n) => n.title).join(", ")}`);
    if (count(shopNow, "New order while your shop is closed") !== 1) bad.push(`shop at checkout: ${shopNow.map((n) => n.title).join(", ")}`);
    // 3. The shop opens; the sweep (run twice) alerts both once more, once.
    expectStatus(await call(shop.owner.ctx, "PATCH", `/api/shops/${shop.shopId}`, { openingHours: hours(false) }), 200, "open");
    for (let i = 0; i < 2; i++) expectStatus(await cron("timeout-sweep"), 200, "timeout sweep");
    const custOpen = (await notes(userOf("customer").id!)).filter((n) => n.title === "The shop is open now");
    const shopOpen = (await notes(shop.owner.id)).filter((n) => n.title === "Your shop is open — orders are waiting");
    if (custOpen.length !== 1) bad.push(`customer told ${custOpen.length}× at opening`);
    if (shopOpen.length !== 1) bad.push(`shop told ${shopOpen.length}× at opening`);
    // The order proceeds normally.
    await freeRider("rider");
    for (const a of ["accept", "start", "ready"] as const) expectStatus(await ownerAction(shop.owner.ctx, order.id, a), 200, a);
    await deliverToPerson(order.id, order.orderNumber, { email: userOf("customer").email }, { owner: shop.owner.ctx });
    if ((await statusOf(order.id)) !== "DELIVERED") bad.push(`order ${await statusOf(order.id)}`);
    expect(bad, bad.join("\n")).toEqual([]);
    return `closed: checkout without confirming → ${prompt.status} "${prompt.body?.error?.message}"; confirmed ${order.orderNumber} placed; at once: customer "${custNow.map((n) => n.title).join(" / ")}", shop "${shopNow.map((n) => n.title).join(" / ")}"; opened → one more alert each (sweep run twice); accepted, delivered`;
  } finally {
    await shop.owner.ctx.dispose();
  }
}, local);

/* ------------------------------------------------------------------ SC-34 */

qa("SC-34", "rider: a bank change waits for review before it is used; two nearby READY orders batched to the rider are delivered each with its own code and photo; a blocked rider gets no further offers", async () => {
  const rider = await partnerId("rider");
  const bad: string[] = [];
  // 1. The bank change.
  const [before] = await db()<{ acct: string | null }[]>`select bank_account_number_encrypted as acct from delivery_partners where id = ${rider}`;
  const change = await api("rider", "POST", "/api/delivery-partner/me/change-request", { bankAccountHolderName: "QA Rider One", bankAccountNumber: `50100${String(Date.now()).slice(-8)}`, bankIfsc: "HDFC0001234" });
  expectStatus(change, 201, "ask to change the bank account");
  const [pending] = await db()<{ acct: string | null }[]>`select bank_account_number_encrypted as acct from delivery_partners where id = ${rider}`;
  if (pending.acct !== before.acct) bad.push("the new bank account was used before review");
  const [req] = await db()<{ id: string; status: string }[]>`select id, status from delivery_partner_change_requests where delivery_partner_id = ${rider} order by created_at desc limit 1`;
  if (req?.status !== "PENDING") bad.push(`change request ${req?.status}`);
  expectStatus(await api("admin", "POST", `/api/admin/rider-change-requests/${req.id}/decision`, { decision: "approve" }), 200, "admin approves the change");
  const [applied] = await db()<{ acct: string | null }[]>`select bank_account_number_encrypted as acct from delivery_partners where id = ${rider}`;
  if (applied.acct === before.acct) bad.push("the approved bank account was not applied");
  // 2.–3. Two nearby orders batched; each delivered with its own code and a photo.
  return withRules({ batching: { enabled: true }, deliveryProof: { photoRequired: true } }, async () => {
    await freeRider("rider");
    const one = await freshPerson("sc34-a", { walletPaise: 100_000, address: true });
    const two = await freshPerson("sc34-b", { walletPaise: 100_000, address: true });
    await db()`update addresses set latitude = ${String(HOME().lat + 0.012)}, longitude = ${String(HOME().lng + 0.0004)} where id = ${two.addressId}`;
    try {
      const listing = await freshListing({ name: "QA Batch Bread", pricePaise: 4000, stock: 20 });
      const a = await personBuys(one, listing, 1);
      const b = await personBuys(two, listing, 1);
      expectStatus(a.res, 201, "order A");
      expectStatus(b.res, 201, "order B");
      await packOrder(a.order!.id);
      const first = await offerFor(a.order!.id, "rider");
      if (first.status === "OFFERED") expectStatus(await riderAction(first.deliveryOrderId, "accept"), 200, "accept A");
      await packOrder(b.order!.id);
      const legB = await poll(
        async () => (await db()<{ id: string; status: string; trip_id: string | null; partner: string }[]>`select id, status, trip_id, delivery_partner_id as partner from delivery_orders where order_id = ${b.order!.id} order by created_at desc limit 1`)[0],
        (l) => Boolean(l),
        30_000,
        1000,
      );
      if (legB?.partner !== rider || !legB.trip_id) bad.push(`order B: rider ${legB?.partner === rider ? "1" : legB?.partner ?? "none"}, trip ${legB?.trip_id ?? "none"} (not batched)`);
      if (legB?.partner === rider && legB.status === "OFFERED") expectStatus(await riderAction(legB.id, "accept"), 200, "accept B");
      const legs = [
        { leg: first.deliveryOrderId, order: a.order!, person: one },
        ...(legB?.partner === rider ? [{ leg: legB.id, order: b.order!, person: two }] : []),
      ];
      for (const l of legs) {
        const code = await pickupCode(l.order.id);
        expectStatus(await riderAction(l.leg, "pickup", code ? { pickupCode: code } : {}), 200, `pickup ${l.order.orderNumber}`);
      }
      const codes: string[] = [];
      for (const l of legs) {
        const started = Date.now() - 2000;
        expectStatus(await riderAction(l.leg, "start"), 200, `start ${l.order.orderNumber}`);
        const otp = await mailedDeliveryCode(l.person.email, l.order.orderNumber, started);
        codes.push(otp);
        const photo = await call(await as("rider"), "POST", `/api/delivery-orders/${l.leg}/proof`, undefined, { multipart: { file: { name: "door.png", mimeType: "image/png", buffer: testPng(240, 240) } } });
        expectStatus(photo, 201, `photo for ${l.order.orderNumber}`);
        expectStatus(await riderAction(l.leg, "deliver", { otp }), 200, `deliver ${l.order.orderNumber}`);
      }
      const proofs = await db()<{ n: number }[]>`select count(distinct delivery_order_id)::int as n from delivery_proofs where delivery_order_id = any(${legs.map((l) => l.leg)})`;
      if (proofs[0].n !== legs.length) bad.push(`${proofs[0].n} of ${legs.length} deliveries hold a photo`);
      // 4. Operations block the rider: no further offers.
      expectStatus(await api("ops", "PATCH", `/api/delivery-partner/${rider}`, { action: "suspend", reason: "QA SC-34: blocked after a complaint" }), 200, "block the rider");
      try {
        await db()`update delivery_partners set is_online = true where id = ${rider}`;
        const c = await personBuys(one, listing, 1);
        expectStatus(c.res, 201, "order C");
        await packOrder(c.order!.id);
        await cron("timeout-sweep");
        const [legC] = await db()<{ partner: string | null }[]>`select delivery_partner_id as partner from delivery_orders where order_id = ${c.order!.id} order by created_at desc limit 1`;
        if (legC?.partner === rider) bad.push("the blocked rider was offered order C");
        await call(one.ctx, "PATCH", `/api/orders/${c.order!.id}/status`, { status: "CANCELLED", note: "QA cleanup" });
      } finally {
        await api("admin", "PATCH", `/api/delivery-partner/${rider}`, { action: "reactivate", reason: "QA cleanup" });
        await freeRider("rider");
      }
      expect(bad, bad.join("\n")).toEqual([]);
      return `bank change PENDING (old account kept) → applied after admin approval; ${legs.map((l) => l.order.orderNumber).join(" + ")} batched on one trip, delivered with their own codes (${codes.join(" / ")}) and a photo each; blocked → no offer for the next order; reinstated`;
    } finally {
      await one.ctx.dispose();
      await two.ctx.dispose();
    }
  });
}, { ...local, partial: "the bank change goes to an admin's review (no confirmation-code step exists for a rider's bank change on this build — rider-profile.ts requestSensitiveChange); batching and photo proof are rules switched on for the journey" });


