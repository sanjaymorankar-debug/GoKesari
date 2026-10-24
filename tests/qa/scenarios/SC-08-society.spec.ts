/**
 * SC-08 — society authorised delivery: a verified society lists one rider and
 * turns on "listed riders only" and security notices; a resident's order is
 * offered to that rider only (although another rider is nearer), security is
 * told when the rider accepts, the rider sees the gate notes and delivers with
 * the code; the society dashboard shows the delivery without personal data.
 *
 * Local tier: the society, its admin and the resident are new local accounts;
 * the two riders are put online (rider 1 at the shop, rider 2 about 3 km
 * away) and rider 2 is given a mobile of their own (the seeded riders share
 * one), restored afterwards.
 */
import { api, asPage, freshListing, freshMobile, freshPerson, mailedDeliveryCode, packOrder, personBuys, pickupCode, riderAction, userOf } from "../lib/finance-helpers";
import { db } from "../lib/db";
import { call, expectStatus, poll, RUN } from "../lib/http";
import { expect, need, qa } from "../lib/record";
import { world } from "../lib/world";

const local = { tier: "local" as const, timeout: 420_000 };

qa("SC-08", "society authorised delivery: only the listed rider is offered, security is told on acceptance, the rider sees the gate notes and delivers with the code; the dashboard shows the delivery without personal data", async ({ browser }) => {
  const home = world().location ?? { pincode: "411038", lat: 18.5074, lng: 73.8077 };
  const sql = db();
  const r1 = userOf("rider").id!;
  const r2 = userOf("rider2").id!;
  const [before] = await sql<{ mobile: string }[]>`select mobile from delivery_partners where user_id = ${r2}`;
  const riderMobile = freshMobile();
  // Both riders free and online; rider 1 is the nearer.
  await sql`update delivery_orders set status = 'CANCELLED', cancelled_at = now(), cancellation_reason = 'QA reset', updated_at = now()
    where delivery_partner_id in (select id from delivery_partners where user_id in (${r1}, ${r2})) and status in ('OFFERED', 'ACCEPTED', 'PICKED_UP')`;
  await sql`update delivery_partners set is_online = false where is_online`;
  await sql`update delivery_partners set is_online = true, last_location_at = now(),
    last_location_latitude = ${String(home.lat + 0.001)}, last_location_longitude = ${String(home.lng + 0.001)} where user_id = ${r1}`;
  await sql`update delivery_partners set is_online = true, last_location_at = now(), mobile = ${riderMobile},
    last_location_latitude = ${String(home.lat + 0.027)}, last_location_longitude = ${String(home.lng)} where user_id = ${r2}`;
  const admin = await freshPerson("sc08-admin");
  const resident = await freshPerson("sc08-resident", { walletPaise: 300_000, address: true });
  try {
    // 1. The society is registered and verified; its admin lists rider 2 and sets the rules.
    const name = `QA SC-08 Society ${RUN}`;
    const reg = await call(admin.ctx, "POST", "/api/societies", { name, addressLine1: "QA Lane", area: "Kothrud", city: "Pune", pincode: home.pincode, latitude: home.lat + 0.009, longitude: home.lng });
    expectStatus(reg, 201, "register the society");
    const societyId = reg.body.id as string;
    expectStatus(await api("ops", "POST", `/api/societies/${societyId}/decision`, { decision: "verify" }), 200, "operations verifies");
    const notes = `QA SC-08: use gate 2, park by the club house ${RUN}`;
    expectStatus(
      await call(admin.ctx, "PATCH", `/api/societies/${societyId}`, { exclusiveRiders: true, securityNotifyEnabled: true, deliveryInstructions: notes, gateEntryMode: "CALL_RESIDENT" }),
      200,
      "listed riders only, security notices, gate notes",
    );
    expectStatus(await call(admin.ctx, "POST", `/api/societies/${societyId}/riders`, { mobile: riderMobile }), 201, "list rider 2");
    // 2. The resident joins, links the address and orders.
    const ask = await call(resident.ctx, "POST", `/api/societies/${societyId}/members`, { unitLabel: "B-204" });
    expectStatus(ask, 201, "ask to join");
    expectStatus(await call(admin.ctx, "PATCH", `/api/societies/members/${ask.body.id}`, { action: "approve" }), 200, "admin approves the resident");
    expectStatus(await call(resident.ctx, "PUT", `/api/addresses/${resident.addressId}/society`, { societyId }), 200, "link the address");
    const product = `QA Society Ghee ${RUN}`;
    const listing = await freshListing({ name: product, pricePaise: 25_000, stock: 5 });
    const { res, order } = await personBuys(resident, listing, 1);
    expectStatus(res, 201, "resident's checkout");
    const placed = need(order, "the resident's order");
    const [row] = await sql<{ society_id: string | null }[]>`select society_id from orders where id = ${placed.id}`;
    expect(row.society_id, "the order carries the society").toBe(societyId);
    // 3. The shop marks READY. 4. Only the listed rider is offered.
    const since = new Date();
    await packOrder(placed.id);
    const offered = await poll(
      async () => (await sql<{ id: string; status: string; user_id: string }[]>`
        select d.id, d.status, p.user_id from delivery_orders d join delivery_partners p on p.id = d.delivery_partner_id
        where d.order_id = ${placed.id} order by d.created_at desc limit 1`)[0],
      (d) => d?.status === "OFFERED",
      60_000,
      1000,
    );
    need(offered, `an offer for ${placed.orderNumber}`);
    const offeredTo = offered.user_id === r2 ? "rider 2 (listed)" : offered.user_id === r1 ? "rider 1 (not listed, nearer)" : "another rider";
    expect(offeredTo, "only the listed rider is offered").toBe("rider 2 (listed)");
    expectStatus(await riderAction(offered.id, "accept", {}, "rider2"), 200, "rider 2 accepts");
    // 5. Security is told; the rider sees the gate notes and delivers with the code.
    const told = await poll(
      async () => (await sql<{ title: string }[]>`select title from notifications where user_id = ${admin.id} and created_at >= ${since} and body like ${`%${placed.orderNumber}%`}`).map((n) => n.title),
      (t) => t.includes("Delivery rider on the way"),
      20_000,
      1000,
    );
    expect(told, "society staff told when the rider accepts").toContain("Delivery rider on the way");
    const code = await pickupCode(placed.id);
    expectStatus(await riderAction(offered.id, "pickup", code ? { pickupCode: code } : {}, "rider2"), 200, "pickup");
    // The rider's active job (the /delivery-partner page; the API's rider view does not carry the society).
    const gateBox = await asPage(browser, "rider2", "/delivery-partner", async (page) => {
      const box = page.getByTestId("society-notes");
      await expect(box, "the rider's job names the society").toContainText(name);
      await expect(box, "the gate mode").toContainText("Gate: Security calls the resident");
      await expect(box, "the gate notes").toContainText(notes);
      return (await box.innerText()).replace(/\s+/g, " ");
    });
    const started = Date.now() - 2000;
    expectStatus(await riderAction(offered.id, "start", {}, "rider2"), 200, "start");
    const otp = await mailedDeliveryCode(resident.email, placed.orderNumber, started);
    expectStatus(await riderAction(offered.id, "deliver", { otp }, "rider2"), 200, "deliver with the code");
    // The dashboard: the delivery, without the resident's contact details or the order's contents.
    const dash = await call(admin.ctx, "GET", `/api/societies/${societyId}`);
    expectStatus(dash, 200, "the society dashboard");
    const listed = (dash.body.recentOrders as Record<string, unknown>[]).find((o) => o.orderNumber === placed.orderNumber);
    expect(listed, "the delivery is on the dashboard").toBeTruthy();
    expect(listed?.status, "as delivered").toBe("DELIVERED");
    const text = JSON.stringify(dash.body);
    const leaks = [resident.email, resident.mobile, product].filter((v) => text.includes(v));
    expect(leaks, "no resident e-mail, mobile or order contents on the dashboard").toEqual([]);
    return `${placed.orderNumber}: offered to rider 2 only (rider 1 nearer, not listed); 'Delivery rider on the way' to society staff; rider saw "${gateBox}"; delivered with the code; dashboard row ${Object.keys(listed!).sort().join(", ")} — no PII`;
  } finally {
    await sql`update delivery_partners set mobile = ${before.mobile} where user_id = ${r2}`;
    await admin.ctx.dispose();
    await resident.ctx.dispose();
  }
}, local);
