/**
 * Rider dispatch and assignment rules (package 5), plus the rider cases that
 * need riders placed, suspended or aged: who is offered a READY order and in
 * what order (online, approved, distance, busy, society lists, reliability,
 * fairness), offer expiry and declines, the bounded search and the shop's
 * "Find rider now" / stop / restart, operations assign and reassign,
 * concurrent orders, batching, and the dispatch cron's protection.
 *
 * Local tier: riders are put online at chosen spots in the local database,
 * offers and searches are aged instead of waited for, and the sweeps are run
 * through the cron endpoints with the local CRON_SECRET. Every rule changed
 * here is restored in a finally block.
 */
import { as, pageAs } from "../lib/actors";
import { db } from "../lib/db";
import {
  abandon,
  activeDelivery,
  ageOffer,
  ageSearch,
  anonymous,
  buyerCode,
  call,
  checkoutLines,
  cron,
  distinctRiderMobiles,
  driveTo,
  ensureWallet,
  expectStatus,
  extraAddress,
  freshRider,
  homeSpot,
  joinSociety,
  levelRiderHistory,
  listingOf,
  noRiderOnline,
  notesFor,
  offeredTo,
  partnerIdOf,
  pickupCode,
  placeSimple,
  riderAction,
  riderMobile,
  ridersOnlyOnline,
  searchOf,
  shopAct,
  shopCard,
  statusOf,
  whoIsOffered,
  withRule,
} from "../lib/orders-helpers";
import { expect, need, qa } from "../lib/record";
import { world, type Role } from "../lib/world";

const local = { tier: "local" as const, timeout: 300_000 };
const NEAR = { dLat: 0.0005, dLng: 0 };
const FAR = { dLat: 0.02, dLng: 0 };

function riderOpts(spot = { dLat: 0.0005, dLng: 0 }) {
  const home = homeSpot();
  return { geolocation: { latitude: home.lat + spot.dLat, longitude: home.lng + spot.dLng }, permissions: ["geolocation"] };
}

async function readyOrder(options: { addressId?: string; rider?: Role } = {}) {
  await ensureWallet();
  const placed = options.addressId
    ? await checkoutLines([{ listing: await listingOf("packaged") }], { addressId: options.addressId })
    : await placeSimple();
  await driveTo(placed.id, "READY");
  return placed;
}

async function offeredRows(orderId: string) {
  return db()<{ status: string; partner_user: string; rejected: string[] }[]>`
    select d.status, p.user_id as partner_user, d.rejected_partner_ids as rejected from delivery_orders d
    join delivery_partners p on p.id = d.delivery_partner_id where d.order_id = ${orderId}`;
}

const userOf = (role: Role) => need(world().users[role], `${role} account`).id!;

qa(["TC-DSP-001", "TC-DEL-013"], "READY offers the order to the online rider within seconds; offline (Go offline) the rider gets nothing, back online the next sweep offers it", async ({ browser }) => {
  await ridersOnlyOnline({ rider: NEAR });
  const { context, page } = await pageAs(browser, "rider", riderOpts(NEAR));
  const notes: string[] = [];
  try {
    await page.goto("/delivery-partner");
    await expect(page.getByText("You're online")).toBeVisible();
    const t0 = Date.now();
    const first = await readyOrder();
    const ready = Date.now();
    const offer = await offeredTo(first.id, 10_000);
    expect(offer?.rider, "offered to the online rider").toBe("rider");
    const told = (await notesFor("rider", "A delivery is available near you")).filter((n) => new Date(n.createdAt).getTime() >= ready - 2_000);
    expect(told.map((n) => n.title), "the rider is notified at once").toContain("New delivery offer");
    await page.reload();
    await expect(page.getByText(/New delivery offer/)).toBeVisible();
    await expect(page.getByText(first.orderNumber)).toBeVisible();
    notes.push(`offered and notified ${Math.round((Date.now() - ready) / 1000)} s after READY (${Math.round((ready - t0) / 1000)} s checkout→READY), nothing pressed by the shop; on the dashboard after a reload`);
    await abandon(first.id);
    await page.reload();
    await page.getByRole("button", { name: "Go offline" }).click();
    await expect(page.getByText("You're offline")).toBeVisible();
    const second = await readyOrder();
    expect(await activeDelivery("rider"), "no offer while offline").toBeNull();
    expect((await searchOf(second.id)).state, "search waiting").toBe("SEARCHING");
    await page.getByRole("button", { name: "Go online" }).click();
    await expect(page.getByText("You're online")).toBeVisible({ timeout: 15_000 });
    await ageSearch(second.id, { nextAttemptDue: true });
    expectStatus(await cron("/api/cron/delivery-dispatch"), 200, "dispatch sweep");
    const offered = await whoIsOffered(second.id, ["rider"]);
    expect(offered, "offered once back online").toBeTruthy();
    notes.push("offline: no offer; online again: the next sweep offered it");
    await abandon(second.id);
  } finally {
    await context.close();
  }
  return notes.join("; ");
}, { ...local, mobile: true, partial: "an open dashboard shows a new offer after a reload (it does not refresh itself while broadcast offers are off); 'offers resume' is shown with the dispatch sweep (it runs every minute on the sites)" });

qa("TC-DSP-002", "only online, approved riders are offered: an offline rider is skipped; a suspended or unapproved rider marked online is never offered", async () => {
  await ridersOnlyOnline({ rider2: FAR });
  const notes: string[] = [];
  const a = await readyOrder();
  try {
    const got = await whoIsOffered(a.id, ["rider", "rider2"]);
    expect(got?.rider, "the online rider, not the nearer offline one").toBe("rider2");
    notes.push("rider offline, rider 2 online → rider 2 offered");
  } finally {
    await abandon(a.id);
  }
  const partner2 = await partnerIdOf("rider2");
  const applicant = await freshRider("dsp002");
  try {
    expectStatus(await call(await as("ops"), "PATCH", `/api/delivery-partner/${partner2}`, { action: "suspend", reason: "QA suspension" }), 200, "suspend rider 2");
    const home = homeSpot();
    // Arranged: both "online" at the shop although neither may be (a stale flag), the real rider offline.
    await db()`update delivery_partners set is_online = true, last_location_latitude = ${String(home.lat)}, last_location_longitude = ${String(home.lng)}, last_location_at = now()
      where id = ${partner2} or id = ${applicant.partnerId}`;
    await db()`update delivery_partners set is_online = false where user_id = ${userOf("rider")}`;
    const b = await readyOrder();
    try {
      const search = await searchOf(b.id);
      const rows = await offeredRows(b.id);
      expect(rows.filter((r) => r.status === "OFFERED"), "no offer to a suspended or unapproved rider").toHaveLength(0);
      expect(search.log[0]?.outcome, "the attempt found nobody").toBe("NO_RIDER");
      notes.push(`suspended + REGISTERED riders flagged online → ${search.log[0]?.outcome}`);
    } finally {
      await abandon(b.id);
    }
  } finally {
    await db()`update delivery_partners set is_online = false where id = ${applicant.partnerId}`;
    await call(await as("ops"), "PATCH", `/api/delivery-partner/${partner2}`, { action: "reactivate" });
    await applicant.ctx.dispose();
  }
  return notes.join("; ");
}, local);

qa("TC-DSP-003", "with equal history the nearer rider gets the first offer (both ways round)", async () => {
  await levelRiderHistory();
  await ridersOnlyOnline({ rider: NEAR, rider2: FAR });
  const a = await readyOrder();
  const first = await whoIsOffered(a.id, ["rider", "rider2"]);
  await abandon(a.id);
  await levelRiderHistory();
  await ridersOnlyOnline({ rider: FAR, rider2: NEAR });
  const b = await readyOrder();
  const second = await whoIsOffered(b.id, ["rider", "rider2"]);
  await abandon(b.id);
  expect(first?.rider, "rider 55 m away vs 2.2 km").toBe("rider");
  expect(second?.rider, "positions swapped").toBe("rider2");
  return `near rider offered first: ${first?.rider}, then (swapped) ${second?.rider}`;
}, local);

qa(["TC-DSP-004", "TC-DSP-023"], "a busy rider is ranked after a free one, and is offered when nobody else is (busy-rider fallback)", async () => {
  const restore = await withRule("dispatch", { busyRidersAsFallback: true });
  const notes: string[] = [];
  const made: string[] = [];
  try {
    await levelRiderHistory();
    await ridersOnlyOnline({ rider: NEAR, rider2: FAR });
    const x = await readyOrder();
    made.push(x.id);
    await driveTo(x.id, "ASSIGNED", { from: "READY", rider: "rider" });
    const y = await readyOrder();
    made.push(y.id);
    const second = await whoIsOffered(y.id, ["rider", "rider2"]);
    expect(second?.rider, "the free (farther) rider before the busy near one").toBe("rider2");
    notes.push("rider 1 busy, rider 2 free and farther → rider 2");
    await abandon(y.id);
    await db()`update delivery_partners set is_online = false where user_id = ${userOf("rider2")}`;
    const z = await readyOrder();
    made.push(z.id);
    const fallback = await offeredTo(z.id);
    expect(fallback?.rider, "only the busy rider online → offered instead of failing").toBe("rider");
    notes.push("only busy rider 1 online → offered the order");
  } finally {
    for (const id of made) await abandon(id);
    await restore();
  }
  return notes.join("; ");
}, { ...local, partial: "with rule dispatch.busyRidersAsFallback on (GA-005/F3, off by default — off, a busy rider is excluded, as before)" });

qa(["TC-DSP-005", "TC-DEL-002"], "an offer left 2 minutes expires on the sweep and goes to the next rider; accepting an expired offer, or one whose order was cancelled, is refused", async () => {
  await levelRiderHistory();
  await ridersOnlyOnline({ rider: NEAR, rider2: FAR });
  const notes: string[] = [];
  const a = await readyOrder();
  try {
    const first = need(await whoIsOffered(a.id, ["rider", "rider2"]), "a first offer");
    expect(first.rider).toBe("rider");
    await ageOffer(a.id, 121);
    const late = await riderAction(first.deliveryOrderId, "accept", {}, "rider");
    expect(late.status, "accept after 2 minutes").toBe(409);
    notes.push(`accept at 121 s → ${late.status} "${late.body?.error?.message}"`);
    const sweep = await cron("/api/cron/delivery-dispatch");
    expectStatus(sweep, 200, "dispatch sweep");
    expect(sweep.body.expired, "the stale offer expired").toBeGreaterThanOrEqual(1);
    expect(await activeDelivery("rider"), "gone from rider 1").toBeNull();
    const next = await whoIsOffered(a.id, ["rider2"]);
    expect(next, "the next rider is tried").toBeTruthy();
    notes.push("sweep expired it and offered rider 2");
  } finally {
    await abandon(a.id);
  }
  await ridersOnlyOnline({ rider: NEAR });
  const b = await readyOrder();
  const offer = need(await whoIsOffered(b.id, ["rider"]), "an offer");
  expectStatus(await call(await as("shop"), "PATCH", `/api/orders/${b.id}/status`, { status: "CANCELLED", note: "QA cancel during offer" }), 200, "shop cancels");
  const afterCancel = await riderAction(offer.deliveryOrderId, "accept", {}, "rider");
  expect(afterCancel.status, "accept after the order was cancelled").toBe(409);
  notes.push(`accept after cancel → ${afterCancel.status}`);
  return notes.join("; ");
}, { ...local, partial: "the 2 minutes are aged in the database, not waited for" });

qa("TC-DSP-006", "a rider who declines is never offered that order again; the next rider is; one live assignment per order at most", async () => {
  await levelRiderHistory();
  await ridersOnlyOnline({ rider: NEAR, rider2: FAR });
  const a = await readyOrder();
  try {
    const first = need(await whoIsOffered(a.id, ["rider", "rider2"]), "first offer");
    expectStatus(await riderAction(first.deliveryOrderId, "reject", { reason: "QA decline" }, first.rider), 200, "first rider declines");
    const other: Role = first.rider === "rider" ? "rider2" : "rider";
    const second = need(await whoIsOffered(a.id, [other]), "the other rider's offer");
    expectStatus(await riderAction(second.deliveryOrderId, "reject", { reason: "QA decline" }, other), 200, "second rider declines");
    await ageSearch(a.id, { nextAttemptDue: true });
    expectStatus(await cron("/api/cron/delivery-dispatch"), 200, "sweep");
    expect(await activeDelivery(first.rider), "the decliner is not offered it again").toBeNull();
    expect(await activeDelivery(other), "nor the second decliner").toBeNull();
    const rows = await offeredRows(a.id);
    expect(rows, "one delivery row per order").toHaveLength(1);
    expect(rows[0].rejected, "both remembered").toHaveLength(2);
    const [dup] = await db()<{ n: number }[]>`select count(*)::int as n from (select order_id from delivery_orders where status in ('OFFERED','ACCEPTED','PICKED_UP') group by order_id having count(*) > 1) x`;
    expect(dup.n, "no order with two live assignments anywhere").toBe(0);
    return `${first.rider} declined → ${other} offered → declined; sweep offered nobody again; 1 row, 2 decliners remembered; no order with two live assignments`;
  } finally {
    await abandon(a.id);
  }
}, local);

qa(["TC-DSP-007", "TC-DSP-009"], "no rider online: 'Looking for a rider — attempt 1 of 10', one shop notice, the next try 60 s later; 'Find rider now' twice within 30 s is refused", async ({ browser }) => {
  await noRiderOnline();
  const a = await readyOrder();
  const notes: string[] = [];
  try {
    const s1 = await searchOf(a.id);
    expect(s1.state).toBe("SEARCHING");
    expect(s1.message).toMatch(/Looking for a rider — attempt 1 of 10/);
    const lastAt = new Date(s1.log[0].createdAt).getTime();
    expect(Math.round((new Date(s1.nextAttemptAt!).getTime() - lastAt) / 1000), "retry interval ≈ 60 s").toBeGreaterThanOrEqual(58);
    expect(Math.round((new Date(s1.nextAttemptAt!).getTime() - lastAt) / 1000)).toBeLessThanOrEqual(62);
    const notices = await notesFor("shop", `${a.orderNumber} yet`);
    expect(notices.filter((n) => n.title === "Looking for a rider"), "one 'Looking for a rider' notice").toHaveLength(1);
    expectStatus(await cron("/api/cron/delivery-dispatch"), 200, "sweep before the interval");
    expect((await searchOf(a.id)).attempts, "not retried before 60 s").toBe(1);
    await ageSearch(a.id, { nextAttemptDue: true });
    expectStatus(await cron("/api/cron/delivery-dispatch"), 200, "sweep after the interval");
    const s2 = await searchOf(a.id);
    expect(s2.attempts, "retried").toBe(2);
    expect((await notesFor("shop", `${a.orderNumber} yet`)).filter((n) => n.title === "Looking for a rider"), "still one notice").toHaveLength(1);
    notes.push(`"${s1.message}"; next try +60 s; one notice; attempt 2 after the interval`);
    const { context, page } = await pageAs(browser, "shop");
    try {
      const card = await shopCard(page, a.orderNumber, "ready");
      await expect(card.getByTestId("rider-search-status")).toContainText(/Looking for a rider — attempt 2 of 10/);
      await card.getByRole("button", { name: "Find rider now" }).click();
      await expect(card.getByText(/Please wait \d+s before pressing again/)).toBeVisible();
      notes.push("Find rider now right after an attempt → 'Please wait …s'");
      await ageSearch(a.id, { lastAttemptSeconds: 31 });
      await page.reload();
      const again = page.getByTestId("shop-order").filter({ hasText: a.orderNumber }).first();
      await again.getByRole("button", { name: "Find rider now" }).click();
      await expect.poll(async () => (await searchOf(a.id)).attempts, { timeout: 15_000 }).toBe(3);
      notes.push("after the 30 s cooldown the press runs attempt 3");
    } finally {
      await context.close();
    }
  } finally {
    await abandon(a.id);
  }
  return notes.join("; ");
}, { ...local, mobile: true });

qa(["TC-DSP-008", "TC-DSP-010"], "the search stops at the attempt limit (and at the time limit): status says why, the shop is told once, the button becomes 'Try finding a rider again', which restarts and offers a now-online rider; 'Stop searching' ends a search", async ({ browser }) => {
  const restore = await withRule("dispatch", { maxAttempts: 2 });
  const notes: string[] = [];
  const made: string[] = [];
  try {
    await noRiderOnline();
    const a = await readyOrder();
    made.push(a.id);
    for (let i = 0; i < 2; i++) {
      await ageSearch(a.id, { nextAttemptDue: true });
      expectStatus(await cron("/api/cron/delivery-dispatch"), 200, "sweep");
    }
    const stopped = await searchOf(a.id);
    expect(stopped.state).toBe("STOPPED");
    expect(stopped.stopReason).toBe("RETRY_LIMIT");
    expect(stopped.message).toBe("No rider accepted after the maximum number of attempts.");
    expectStatus(await cron("/api/cron/delivery-dispatch"), 200, "another sweep");
    const told = (await notesFor("shop", a.orderNumber)).filter((n) => n.title === "No rider found");
    expect(told, "told once").toHaveLength(1);
    notes.push(`RETRY_LIMIT: "${stopped.message}", 'No rider found' once`);

    const b = await readyOrder();
    made.push(b.id);
    await ageSearch(b.id, { startedMinutes: 31, nextAttemptDue: true });
    expectStatus(await cron("/api/cron/delivery-dispatch"), 200, "sweep");
    expect((await searchOf(b.id)).stopReason, "30 minutes").toBe("TIME_LIMIT");
    notes.push("31 min old search → TIME_LIMIT");

    await ridersOnlyOnline({ rider: NEAR });
    const { context, page } = await pageAs(browser, "shop");
    try {
      const card = await shopCard(page, a.orderNumber, "ready");
      await expect(card.getByTestId("rider-search-status")).toContainText("No rider accepted after the maximum number of attempts.");
      await card.getByRole("button", { name: "Try finding a rider again" }).click();
      await expect.poll(async () => (await whoIsOffered(a.id, ["rider"], 2_000))?.rider, { timeout: 15_000 }).toBe("rider");
      expect((await searchOf(a.id)).attempts, "attempt counter reset").toBe(1);
      notes.push("Try finding a rider again → attempts 1, rider offered");
      await abandon(a.id);
      await noRiderOnline();
      const c = await readyOrder();
      made.push(c.id);
      const cCard = await shopCard(page, c.orderNumber, "ready");
      await cCard.getByRole("button", { name: "Stop searching" }).click();
      await expect.poll(async () => (await searchOf(c.id)).message, { timeout: 15_000 }).toBe("You stopped the search.");
      notes.push("Stop searching → 'You stopped the search.'");
    } finally {
      await context.close();
    }
  } finally {
    for (const id of made) await abandon(id);
    await restore();
  }
  return notes.join("; ");
}, { ...local, mobile: true, partial: "the limit is lowered to 2 attempts for the run (rule dispatch.maxAttempts, restored); 10 attempts / 30 min are the defaults; the promised-time stop (window + 15 min) needs a delivery window and is not exercised" });

qa("TC-DSP-011", "cancelling an order during the rider search closes the search as 'order cancelled'; no further offers", async () => {
  await noRiderOnline();
  const a = await readyOrder();
  expect((await searchOf(a.id)).state).toBe("SEARCHING");
  expectStatus(await call(await as("shop"), "PATCH", `/api/orders/${a.id}/status`, { status: "CANCELLED", note: "QA cancel during search" }), 200, "shop cancels");
  await ridersOnlyOnline({ rider: NEAR });
  await ageSearch(a.id, { nextAttemptDue: true });
  expectStatus(await cron("/api/cron/delivery-dispatch"), 200, "sweep");
  expect(await activeDelivery("rider"), "no further offers").toBeNull();
  const after = await searchOf(a.id);
  expect({ state: after.state, stopReason: after.stopReason }, `search after the cancel: ${after.message}`).toEqual({ state: "STOPPED", stopReason: "ORDER_CANCELLED" });
  return `after cancel: ${after.state} / ${after.stopReason}; no offer`;
}, local);

qa("TC-DSP-012", "dispatch rule changes apply to a new search (retry interval 120 s, 4 attempts) and the defaults come back", async () => {
  const restore = await withRule("dispatch", { retryIntervalSeconds: 120, maxAttempts: 4 });
  let seen = "";
  try {
    await noRiderOnline();
    const a = await readyOrder();
    try {
      const s = await searchOf(a.id);
      expect(s.maxAttempts).toBe(4);
      const gap = Math.round((new Date(s.nextAttemptAt!).getTime() - new Date(s.log[0].createdAt).getTime()) / 1000);
      expect(gap).toBeGreaterThanOrEqual(118);
      expect(gap).toBeLessThanOrEqual(122);
      seen = `new search: ${s.maxAttempts} attempts, next try +${gap} s`;
    } finally {
      await abandon(a.id);
    }
  } finally {
    await restore();
  }
  const rules = await call(await as("admin"), "GET", "/api/admin/settings");
  const dispatch = (rules.body.rules as { key: string; value: { retryIntervalSeconds: number; maxAttempts: number }; overridden: boolean }[]).find((r) => r.key === "dispatch")!;
  expect(dispatch.value.retryIntervalSeconds).toBe(60);
  expect(dispatch.value.maxAttempts).toBe(10);
  return `${seen}; restored to 60 s / 10`;
}, { ...local, partial: "changed through the settings API the /admin/settings page uses" });

qa("TC-DSP-013", "two orders marked READY at the same moment never double-book the only rider: one offer, the other waits", async () => {
  need(world().listings.sharedB, "a listing at shop B");
  await ridersOnlyOnline({ rider: NEAR });
  await ensureWallet();
  const a = await placeSimple();
  const b = await checkoutLines([{ listing: await listingOf("sharedB") }]);
  try {
    await driveTo(a.id, "PREPARING");
    await driveTo(b.id, "PREPARING", { shop: "shopB" });
    const [ra, rb] = await Promise.all([shopAct(a.id, "ready"), shopAct(b.id, "ready", {}, "shopB")]);
    expectStatus(ra, 200, "A ready");
    expectStatus(rb, 200, "B ready");
    await new Promise((r) => setTimeout(r, 2_000));
    const [live] = await db()<{ n: number }[]>`select count(*)::int as n from delivery_orders d join delivery_partners p on p.id = d.delivery_partner_id
      where p.user_id = ${userOf("rider")} and d.status in ('OFFERED','ACCEPTED','PICKED_UP')`;
    expect(live.n, "the rider holds one offer").toBe(1);
    const waiting = (await searchOf(a.id)).state === "SEARCHING" ? a : b;
    expect((await searchOf(waiting.id, waiting === a ? "shop" : "shopB")).state, "the other order waits").toBe("SEARCHING");
    return `simultaneous READY at shops A and B → rider holds ${live.n} offer; ${waiting.orderNumber} waits`;
  } finally {
    await abandon(a.id);
    await abandon(b.id);
  }
}, local);

qa("TC-DSP-014", "operations: 'Assign rider' on a READY order, 'Reassign' with a reason (ASSIGNED → READY → new offer), no reassign after pickup", async ({ browser }) => {
  await noRiderOnline();
  const a = await readyOrder();
  const notes: string[] = [];
  const { context, page } = await pageAs(browser, "ops");
  try {
    await ridersOnlyOnline({ rider: NEAR });
    // The automatic attempt at READY just ran; 'Assign rider' shares the 30 s manual cooldown.
    await ageSearch(a.id, { lastAttemptSeconds: 31 });
    await page.goto("/admin/orders");
    let row = page.getByRole("row").filter({ hasText: a.orderNumber }).first();
    await row.getByRole("button", { name: "Assign rider" }).click();
    const offer = await whoIsOffered(a.id, ["rider"], 15_000);
    expect(offer, "offered after 'Assign rider'").toBeTruthy();
    notes.push("Assign rider → offered");
    expectStatus(await riderAction(offer!.deliveryOrderId, "accept"), 200, "rider accepts");
    expect(await statusOf(a.id)).toBe("ASSIGNED");
    await page.reload();
    row = page.getByRole("row").filter({ hasText: a.orderNumber }).first();
    page.once("dialog", (d) => void d.accept("QA reassign: rider's bike broke down"));
    const before = (await offeredRows(a.id))[0];
    await row.getByRole("button", { name: "Reassign" }).click();
    await expect.poll(async () => (await offeredRows(a.id))[0]?.status, { timeout: 15_000 }).toBe("OFFERED");
    const history = await db()<{ previous_status: string; new_status: string; note: string | null }[]>`select previous_status, new_status, note from order_status_history where order_id = ${a.id} order by created_at`;
    expect(history.some((h) => h.previous_status === "ASSIGNED" && h.new_status === "READY" && /bike broke down/.test(h.note ?? "")), "ASSIGNED → READY with the reason").toBe(true);
    notes.push(`Reassign (${before.status} → cancelled) → READY with the reason → new offer`);
    const again = need(await whoIsOffered(a.id, ["rider"]), "the new offer");
    expectStatus(await riderAction(again.deliveryOrderId, "accept"), 200, "accept again");
    const code = need(await pickupCode(a.id), "pickup code");
    expectStatus(await riderAction(again.deliveryOrderId, "pickup", { pickupCode: code }), 200, "pickup");
    await page.reload();
    row = page.getByRole("row").filter({ hasText: a.orderNumber }).first();
    await expect(row.getByRole("button", { name: "Reassign" }), "no Reassign after pickup").toHaveCount(0);
    const forced = await call(await as("ops"), "POST", `/api/orders/${a.id}/assign`, { reassign: true, reason: "QA" });
    expect(forced.status, "reassign after pickup").toBe(409);
    notes.push(`after pickup: no button, API ${forced.status} "${forced.body?.error?.message}"`);
  } finally {
    await context.close();
    await abandon(a.id);
  }
  return notes.join("; ");
}, local);

/** Society rider lists: the customer lives in the world's society; returns the society id and an address there. */
async function societySetup() {
  const societyId = await joinSociety("customer");
  await distinctRiderMobiles();
  const society = await as("society");
  expectStatus(await call(society, "PATCH", `/api/societies/${societyId}`, { exclusiveRiders: false, notifyCustomerAtGate: true, gateEntryMode: "OPEN" }), 200, "society settings");
  // Revoke whatever an earlier run listed.
  await db()`update society_riders set status = 'REVOKED', revoked_at = now() where society_id = ${societyId} and status = 'ACTIVE'`;
  const addressId = await extraAddress("customer", { dLat: 0.004, dLng: 0 }, "QA Society Flat 7", societyId);
  return { societyId, addressId, society };
}

async function listRider(societyId: string, role: Role, preferred = false) {
  const res = await call(await as("society"), "POST", `/api/societies/${societyId}/riders`, { mobile: await riderMobile(role), preferred });
  expectStatus(res, 201, `list ${role}`);
  return String(res.body.id);
}

qa(["TC-DSP-016", "TC-DEL-006"], "exclusive society: only the listed rider is offered (not a nearer unlisted one); with the listed rider offline nobody is, and the shop hears the society wording; the arrival notice follows the gate's entry mode", async () => {
  const { societyId, addressId, society } = await societySetup();
  const notes: string[] = [];
  try {
    await listRider(societyId, "rider2");
    expectStatus(await call(society, "PATCH", `/api/societies/${societyId}`, { exclusiveRiders: true, gateEntryMode: "CALL_RESIDENT" }), 200, "exclusive");
    await levelRiderHistory();
    await ridersOnlyOnline({ rider: NEAR, rider2: FAR });
    const a = await readyOrder({ addressId });
    try {
      const got = await whoIsOffered(a.id, ["rider", "rider2"]);
      expect(got?.rider, "only the listed rider").toBe("rider2");
      notes.push("listed rider 2 (2.2 km) offered, unlisted rider 1 (55 m) not");
      const driven = await driveTo(a.id, "OUT_FOR_DELIVERY", { from: "READY", rider: "rider2" });
      expectStatus(await riderAction(driven.deliveryOrderId!, "arrived_customer", {}, "rider2"), 200, "arrived");
      const told = await notesFor("customer", a.orderNumber);
      const arrival = told.find((n) => n.title === "Your rider has arrived");
      expect(arrival?.body, "society wording (CALL_RESIDENT)").toMatch(/at the gate\. Security may call you/);
      notes.push(`arrival notice: "${arrival?.body}"`);
    } finally {
      await abandon(a.id);
    }
    await ridersOnlyOnline({ rider: NEAR });
    const b = await readyOrder({ addressId });
    try {
      expect(await activeDelivery("rider"), "the unlisted rider is still not offered").toBeNull();
      const s = await searchOf(b.id);
      expect(s.log[0]?.detail ?? "", "society wording").toMatch(/allowed by this society/);
      const shopTold = (await notesFor("shop", b.orderNumber)).find((n) => n.title === "Looking for a rider");
      expect(shopTold?.body, "the shop is told").toMatch(/allowed by this society/);
      notes.push(`listed rider offline → nobody; shop told "${shopTold?.body}"`);
    } finally {
      await abandon(b.id);
    }
  } finally {
    await call(society, "PATCH", `/api/societies/${societyId}`, { exclusiveRiders: false, gateEntryMode: "OPEN" });
  }
  return notes.join("; ");
}, local);

qa("TC-DSP-018", "an exclusive society with an empty rider list never blocks dispatch: any eligible rider is offered", async () => {
  const { societyId, addressId, society } = await societySetup();
  try {
    expectStatus(await call(society, "PATCH", `/api/societies/${societyId}`, { exclusiveRiders: true }), 200, "exclusive, empty list");
    await ridersOnlyOnline({ rider: NEAR });
    const a = await readyOrder({ addressId });
    try {
      const got = await whoIsOffered(a.id, ["rider"]);
      expect(got?.rider).toBe("rider");
      return "exclusive society, no listed riders → the nearest rider offered";
    } finally {
      await abandon(a.id);
    }
  } finally {
    await call(society, "PATCH", `/api/societies/${societyId}`, { exclusiveRiders: false });
  }
}, local);

qa("TC-DSP-019", "revoking a listed rider takes effect at once: the next order is not offered to them", async () => {
  const { societyId, addressId, society } = await societySetup();
  try {
    const link1 = await listRider(societyId, "rider");
    await listRider(societyId, "rider2");
    expectStatus(await call(society, "PATCH", `/api/societies/${societyId}`, { exclusiveRiders: true }), 200, "exclusive");
    expectStatus(await call(society, "PATCH", `/api/societies/riders/${link1}`, { revoke: true }), 200, "revoke rider 1");
    await levelRiderHistory();
    await ridersOnlyOnline({ rider: NEAR, rider2: FAR });
    const a = await readyOrder({ addressId });
    try {
      const got = await whoIsOffered(a.id, ["rider", "rider2"]);
      expect(got?.rider, "the revoked (nearer) rider is skipped").toBe("rider2");
      return "rider 1 revoked → the order went to rider 2 although rider 1 was nearer";
    } finally {
      await abandon(a.id);
    }
  } finally {
    await call(society, "PATCH", `/api/societies/${societyId}`, { exclusiveRiders: false });
  }
}, local);

qa("TC-DSP-017", "non-exclusive society: the preferred rider is offered first, then the listed one, then an unlisted one, as each offer lapses", async () => {
  const { societyId, addressId } = await societySetup();
  const outsider = await freshRider("dsp017", { approve: true });
  const made: string[] = [];
  try {
    await listRider(societyId, "rider", true);
    await listRider(societyId, "rider2", false);
    await levelRiderHistory();
    await ridersOnlyOnline({ rider: { dLat: 0.003, dLng: 0 }, rider2: { dLat: 0.003, dLng: 0.0003 } });
    const home = homeSpot();
    await db()`update delivery_partners set is_online = true, last_location_latitude = ${String(home.lat + 0.0025)}, last_location_longitude = ${String(home.lng)}, last_location_at = now() where id = ${outsider.partnerId}`;
    const a = await readyOrder({ addressId });
    made.push(a.id);
    const order: string[] = [];
    const who = async () => {
      for (const [label, role] of [["preferred", "rider"], ["listed", "rider2"]] as const) {
        const d = await activeDelivery(role);
        if (d?.orderId === a.id) return label;
      }
      const rows = await db()<{ status: string }[]>`select status from delivery_orders where order_id = ${a.id} and delivery_partner_id = ${outsider.partnerId} and status = 'OFFERED'`;
      return rows.length ? "unlisted" : "none";
    };
    for (let i = 0; i < 3; i++) {
      order.push(await who());
      await ageOffer(a.id, 125);
      expectStatus(await cron("/api/cron/delivery-dispatch"), 200, "sweep");
    }
    expect(order, "offer order").toEqual(["preferred", "listed", "unlisted"]);
    return `offers in turn: ${order.join(" → ")} (the unlisted rider was slightly nearer)`;
  } finally {
    for (const id of made) await abandon(id);
    await db()`update delivery_partners set is_online = false where id = ${outsider.partnerId}`;
    await outsider.ctx.dispose();
  }
}, local);

/** One rider declines twice ("yesterday"), then both stand at the same spot: who is offered the next order? */
async function reliabilityRun(bad: Role, good: Role) {
  await levelRiderHistory();
  await ridersOnlyOnline({ [bad]: NEAR } as Partial<Record<Role, { dLat: number; dLng: number }>>);
  const made: string[] = [];
  try {
    for (let i = 0; i < 2; i++) {
      const o = await readyOrder();
      made.push(o.id);
      const got = need(await offeredTo(o.id), `${bad}'s offer`);
      expectStatus(await riderAction(got.deliveryOrderId, "reject", { reason: "QA decline" }, bad), 200, `${bad} declines`);
      await abandon(o.id);
    }
    // The declines happened "yesterday": inside the 30-day reliability window, outside today's fairness count.
    await db()`update delivery_orders set offered_at = offered_at - interval '1 day' where order_id = any(${made}::uuid[])`;
    await ridersOnlyOnline({ [bad]: NEAR, [good]: NEAR } as Partial<Record<Role, { dLat: number; dLng: number }>>);
    const c = await readyOrder();
    made.push(c.id);
    return (await offeredTo(c.id))?.rider;
  } finally {
    for (const id of made) await abandon(id);
  }
}

qa("TC-DSP-020", "with equal distance the more reliable rider is offered first (the other declined twice recently) — both ways round", async () => {
  const first = await reliabilityRun("rider2", "rider");
  const second = await reliabilityRun("rider", "rider2");
  expect(`rider 2 unreliable → ${first}; rider 1 unreliable → ${second}`, "the reliable rider each time").toBe("rider 2 unreliable → rider; rider 1 unreliable → rider2");
  return `rider 2 unreliable → ${first}; rider 1 unreliable → ${second}`;
}, { ...local, partial: "the declines are dated to yesterday so that only reliability (not today's offer count) differs; run both ways round so a fixed tie order cannot pass it" });

/** One rider gets three offers today, then both stand at the same spot: who is offered the next order? */
async function fairnessRun(busy: Role, fresh: Role) {
  await levelRiderHistory();
  await ridersOnlyOnline({ [busy]: NEAR } as Partial<Record<Role, { dLat: number; dLng: number }>>);
  const made: string[] = [];
  try {
    for (let i = 0; i < 3; i++) {
      const o = await readyOrder();
      made.push(o.id);
      need(await offeredTo(o.id), `${busy}'s offer`);
      await abandon(o.id);
    }
    await ridersOnlyOnline({ [busy]: NEAR, [fresh]: NEAR } as Partial<Record<Role, { dLat: number; dLng: number }>>);
    const next = await readyOrder();
    made.push(next.id);
    return (await offeredTo(next.id))?.rider;
  } finally {
    for (const id of made) await abandon(id);
  }
}

qa("TC-DSP-021", "with equal riders the one with fewer offers today is favoured — both ways round", async () => {
  const first = await fairnessRun("rider", "rider2");
  const second = await fairnessRun("rider2", "rider");
  expect(`rider 1 had 3 offers → ${first}; rider 2 had 3 → ${second}`, "the rider with fewer offers today each time").toBe("rider 1 had 3 offers → rider2; rider 2 had 3 → rider");
  return `rider 1 had 3 offers → ${first}; rider 2 had 3 → ${second}`;
}, { ...local, partial: "run both ways round so a fixed tie order cannot pass it; 'nobody is starved over several orders' follows from the same weight" });

qa("TC-DSP-022", "the dispatch, notifications, risk, weekly finance and daily order crons refuse a POST with no token or a wrong token (403), and nothing runs", async () => {
  await ridersOnlyOnline({ rider: NEAR });
  const a = await readyOrder();
  try {
    const offer = need(await whoIsOffered(a.id, ["rider"]), "an offer");
    await ageOffer(a.id, 130);
    const guest = await anonymous();
    const seen: string[] = [];
    try {
      for (const path of ["/api/cron/delivery-dispatch", "/api/cron/notifications", "/api/cron/risk-rules", "/api/cron/finance-weekly", "/api/cron/daily-orders"]) {
        for (const headers of [{}, { authorization: "Bearer wrong-cron-secret" }] as Record<string, string>[]) {
          const res = await call(guest, "POST", path, {}, { headers });
          expect(res.status, `${path} ${headers.authorization ? "wrong" : "no"} token`).toBe(403);
        }
        seen.push(path.replace("/api/cron/", ""));
      }
    } finally {
      await guest.dispose();
    }
    const row = (await offeredRows(a.id))[0];
    expect(row.status, "the aged offer was not expired: the refused dispatch call ran nothing").toBe("OFFERED");
    expect(await activeDelivery("rider"), "still the same offer").toMatchObject({ id: offer.deliveryOrderId });
    return `${seen.join(", ")}: 403 without and with a wrong token; an expired offer stayed OFFERED`;
  } finally {
    await abandon(a.id);
  }
}, { ...local, partial: "guest half (GET probes of every cron) in guest/access.spec.ts" });

qa("TC-DEL-026", "suspending (the plan's BLOCKED) a rider: no new offers, going online refused, the offer in hand can no longer be accepted", async () => {
  const partner = await partnerIdOf("rider");
  const ops = await as("ops");
  const notes: string[] = [];
  const made: string[] = [];
  try {
    await ridersOnlyOnline({ rider: NEAR });
    const held = await readyOrder();
    made.push(held.id);
    const offer = need(await offeredTo(held.id), "an offer in hand");
    expectStatus(await call(ops, "PATCH", `/api/delivery-partner/${partner}`, { action: "suspend", reason: "QA suspension" }), 200, "suspend");
    const online = await call(await as("rider"), "PATCH", "/api/delivery-partner/status", { action: "online", latitude: homeSpot().lat, longitude: homeSpot().lng });
    expect(online.status, "going online while suspended").toBe(409);
    const fresh = await readyOrder();
    made.push(fresh.id);
    expect(await offeredTo(fresh.id, 3_000), "no new offers").toBeNull();
    const accept = await riderAction(offer.deliveryOrderId, "accept");
    notes.push(`online → ${online.status}; no new offer; accept the offer in hand → ${accept.status}${accept.status === 200 ? ` (order now ${await statusOf(held.id)})` : ""}`);
    expect(accept.status, `a suspended rider accepting the offer in hand — ${notes.join("; ")}`).toBe(409);
  } finally {
    await call(ops, "PATCH", `/api/delivery-partner/${partner}`, { action: "reactivate" });
    for (const id of made) await abandon(id);
  }
  return notes.join("; ");
}, { ...local, partial: "the plan's BLOCKED state is SUSPENDED in the rider model (src/lib/status-models.ts)" });

qa("TC-DEL-021", "a rider suspended on an active delivery: it stays assigned, leaves the rider's app, and operations can reassign it", async ({ browser }) => {
  const partner = await partnerIdOf("rider");
  const ops = await as("ops");
  await ridersOnlyOnline({ rider: NEAR, rider2: FAR });
  const job = await readyOrder();
  try {
    await driveTo(job.id, "ASSIGNED", { from: "READY", rider: "rider" });
    expectStatus(await call(ops, "PATCH", `/api/delivery-partner/${partner}`, { action: "suspend", reason: "QA suspension" }), 200, "suspend on a job");
    expect(await statusOf(job.id), "the delivery stays assigned").toBe("ASSIGNED");
    const { context, page } = await pageAs(browser, "rider");
    try {
      await page.goto("/delivery-partner");
      await expect(page.getByText("Your delivery partner account is currently suspended.")).toBeVisible();
      await expect(page.getByText(job.orderNumber), "the job is gone from the rider's app").toHaveCount(0);
    } finally {
      await context.close();
    }
    const reassigned = await call(ops, "POST", `/api/orders/${job.id}/assign`, { reassign: true, reason: "Rider suspended" });
    expectStatus(reassigned, 200, "operations reassign");
    const next = await offeredTo(job.id);
    expect(next?.rider, "re-offered to another rider").toBe("rider2");
    return "order stays ASSIGNED, the job is hidden from the suspended rider's app, operations reassigned it to rider 2";
  } finally {
    await call(ops, "PATCH", `/api/delivery-partner/${partner}`, { action: "reactivate" });
    await abandon(job.id);
  }
}, { ...local, mobile: true, partial: "recorded behaviour (the plan calls it a known gap)" });

qa(["TC-DSP-024", "TC-DSP-026"], "batching: two READY orders for nearby drops go to one rider as one trip; each keeps its own pickup and delivery code; earnings per order; the next drop's address appears only when it is the current drop", async ({ browser }) => {
  const restore = await withRule("batching", { enabled: true });
  const made: string[] = [];
  const notes: string[] = [];
  try {
    await levelRiderHistory();
    await ridersOnlyOnline({ rider: NEAR, rider2: FAR });
    const secondAddress = await extraAddress("customer", { dLat: 0.012, dLng: 0.0004 }, "QA Flat 2, Paud Road");
    const a = await readyOrder();
    made.push(a.id);
    const first = need(await whoIsOffered(a.id, ["rider"]), "first offer");
    expectStatus(await riderAction(first.deliveryOrderId, "accept"), 200, "accept the first");
    const b = await readyOrder({ addressId: secondAddress });
    made.push(b.id);
    const [row] = await db()<{ trip_id: string | null; partner_user: string; status: string }[]>`select d.trip_id, p.user_id as partner_user, d.status from delivery_orders d join delivery_partners p on p.id = d.delivery_partner_id where d.order_id = ${b.id}`;
    expect(row.partner_user, "the second order goes to the same rider").toBe(userOf("rider"));
    expect(row.trip_id, "as one trip").toBeTruthy();
    const bOffer = (await db()<{ id: string }[]>`select id from delivery_orders where order_id = ${b.id}`)[0].id;
    expectStatus(await riderAction(bOffer, "accept"), 200, "accept the second");
    const codeA = need(await pickupCode(a.id), "code A");
    const codeB = need(await pickupCode(b.id), "code B");
    const wrongSwap = await riderAction(first.deliveryOrderId, "pickup", { pickupCode: codeB === codeA ? "0000" : codeB });
    expect(wrongSwap.status, "B's code does not pick up A").toBe(422);
    expectStatus(await riderAction(first.deliveryOrderId, "pickup", { pickupCode: codeA }), 200, "pickup A");
    expectStatus(await riderAction(bOffer, "pickup", { pickupCode: codeB }), 200, "pickup B");
    notes.push(`one rider, one trip; own pickup codes (A's ≠ B's)`);
    const { context, page } = await pageAs(browser, "rider", riderOpts(NEAR));
    try {
      expectStatus(await riderAction(first.deliveryOrderId, "start"), 200, "start drop A");
      await page.goto("/delivery-partner");
      const html = await page.locator("body").innerText();
      expect(html, "drop A's address is shown").toContain("QA Flat 1, Karve Road");
      expect(html, "drop B's address is not shown yet").not.toContain("QA Flat 2, Paud Road");
      const otpA = await buyerCode(a.id);
      expectStatus(await riderAction(first.deliveryOrderId, "deliver", { otp: otpA }), 200, "deliver A");
      expectStatus(await riderAction(bOffer, "start"), 200, "start drop B");
      await page.reload();
      await expect(page.getByText("QA Flat 2, Paud Road").first(), "drop B's address once it is the current drop").toBeVisible();
      const otpB = await buyerCode(b.id);
      const crossed = await riderAction(bOffer, "deliver", { otp: otpA === otpB ? "0000" : otpA });
      expect(crossed.status, "A's code does not deliver B").toBe(422);
      expectStatus(await riderAction(bOffer, "deliver", { otp: otpB }), 200, "deliver B");
    } finally {
      await context.close();
    }
    const earnings = await call(await as("rider"), "GET", "/api/delivery-partner/earnings");
    const ids = (earnings.body.statement as { deliveryOrderId: string }[]).map((e) => e.deliveryOrderId);
    expect(ids, "earning for A").toContain(first.deliveryOrderId);
    expect(ids, "earning for B").toContain(bOffer);
    notes.push("own delivery codes; B's address hidden during drop A; one earning per order");
  } finally {
    for (const id of made) await abandon(id);
    await restore();
  }
  return notes.join("; ");
}, { ...local, partial: "with rule batching on (GA-005, off by default)" });

qa("TC-DSP-025", "batching limits: no third order on a 2-order trip, no batch for a drop in the opposite direction; cancelling one order of a batch after pickup leaves the other to complete", async () => {
  const restore = await withRule("batching", { enabled: true });
  const made: string[] = [];
  const notes: string[] = [];
  try {
    await levelRiderHistory();
    await ridersOnlyOnline({ rider: NEAR });
    const north = await extraAddress("customer", { dLat: 0.012, dLng: 0.0004 }, "QA North Flat");
    const south = await extraAddress("customer", { dLat: -0.02, dLng: 0 }, "QA South Flat");
    const a = await readyOrder();
    made.push(a.id);
    const offerA = need(await whoIsOffered(a.id, ["rider"]), "A");
    expectStatus(await riderAction(offerA.deliveryOrderId, "accept"), 200, "accept A");
    const opposite = await readyOrder({ addressId: south });
    made.push(opposite.id);
    expect((await offeredRows(opposite.id)).filter((r) => r.status === "OFFERED"), "the opposite drop is not batched").toHaveLength(0);
    await abandon(opposite.id);
    notes.push("opposite direction → not offered to the busy rider");
    const b = await readyOrder({ addressId: north });
    made.push(b.id);
    const bRow = (await offeredRows(b.id))[0];
    expect(bRow?.partner_user, "B joins A's trip").toBe(userOf("rider"));
    const bId = (await db()<{ id: string }[]>`select id from delivery_orders where order_id = ${b.id}`)[0].id;
    expectStatus(await riderAction(bId, "accept"), 200, "accept B");
    const c = await readyOrder({ addressId: north });
    made.push(c.id);
    expect((await offeredRows(c.id)).filter((r) => r.status === "OFFERED"), "no third order on a 2-order trip").toHaveLength(0);
    await abandon(c.id);
    notes.push("third compatible order → not added (max 2)");
    expectStatus(await riderAction(offerA.deliveryOrderId, "pickup", { pickupCode: need(await pickupCode(a.id), "A code") }), 200, "pickup A");
    expectStatus(await riderAction(bId, "pickup", { pickupCode: need(await pickupCode(b.id), "B code") }), 200, "pickup B");
    expectStatus(await call(await as("shop"), "PATCH", `/api/orders/${b.id}/status`, { status: "CANCELLED", note: "QA cancel in a batch" }), 200, "cancel B after pickup");
    expect(["CANCELLED", "REFUNDED"]).toContain(await statusOf(b.id));
    expectStatus(await riderAction(offerA.deliveryOrderId, "start"), 200, "start A");
    expectStatus(await riderAction(offerA.deliveryOrderId, "deliver", { otp: await buyerCode(a.id) }), 200, "deliver A");
    expect(await statusOf(a.id)).toBe("DELIVERED");
    notes.push("B cancelled after pickup (refunded by the shop's cancel), A still delivered");
  } finally {
    for (const id of made) await abandon(id);
    await restore();
  }
  return notes.join("; ");
}, { ...local, partial: "with rule batching on (GA-005, off by default)" });

