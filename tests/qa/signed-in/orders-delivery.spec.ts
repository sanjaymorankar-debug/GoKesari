/**
 * Rider delivery and handover (package 5): the rider's screen from offer to
 * drop — accept, arrival checkpoints, pickup code, start, delivery code,
 * lock-out and the operations override, failed drops, navigation links,
 * tracking privacy, photo privacy, legacy self-delivery and cash on
 * delivery — and the field rules of the codes, the failure reason, the
 * override note and the cash confirmation.
 *
 * Signed-in tier: the world's rider(s), the customer, shop A's owner and an
 * operator, on their own orders. On the local run the riders are placed with
 * lib/flows onlyRiderOnline (or the helpers' two-rider arrangement).
 */
import type { Browser } from "@playwright/test";

import { anonymous } from "../lib/http";
import { as, pageAs } from "../lib/actors";
import { onlyRiderOnline } from "../lib/flows";
import {
  abandon,
  activeDelivery,
  call,
  customerCard,
  buyerCode,
  driveTo,
  ensureWallet,
  expectStatus,
  homeSpot,
  notesFor,
  orderRow,
  pickupCode,
  placeSimple,
  png,
  releaseRiders,
  riderAction,
  riderOnline,
  ridersOnlyOnline,
  shopCard,
  statusOf,
  TEXT,
  upload,
  withShopSettings,
  PDF_BYTES,
} from "../lib/orders-helpers";
import { db } from "../lib/db";
import { expect, need, qa } from "../lib/record";
import { IS_LOCAL } from "../lib/target";
import { world, type Role } from "../lib/world";

const signed = { tier: "signed" as const, timeout: 240_000 };

async function ready() {
  await releaseRiders();
  await onlyRiderOnline("rider");
  await ensureWallet();
}

/** The rider's dashboard with the phone's location at the rider's spot (the heartbeat keeps it there). */
async function riderPage(browser: Browser, role: Role = "rider") {
  const home = homeSpot();
  return pageAs(browser, role, { geolocation: { latitude: home.lat + 0.001, longitude: home.lng + 0.001 }, permissions: ["geolocation"] });
}

/** What must never reach a rider: the codes, the customer's name, recipient and phone. */
async function secretsOf(orderId: string) {
  const out: { label: string; value: string }[] = [{ label: "customer name", value: "QA Customer One" }, { label: "recipient", value: "QA Recipient" }];
  if (IS_LOCAL) {
    const [u] = await db()<{ phone: string | null }[]>`select u.phone from orders o join users u on u.id = o.user_id where o.id = ${orderId}`;
    if (u?.phone) out.push({ label: "customer phone", value: u.phone });
  }
  return out;
}

function assertNoLeak(text: string, secrets: { label: string; value: string }[], codes: (string | null | undefined)[], where: string) {
  for (const s of secrets) expect(text, `${s.label} in ${where}`).not.toContain(s.value);
  expect(text, `code fields in ${where}`).not.toMatch(/"(pickupCode|deliveryOtp|deliveryOtpHash|handoverCode)"\s*:\s*"/);
  for (const c of codes) if (c) expect(text, `a code value in ${where}`).not.toMatch(new RegExp(`"(?:[a-zA-Z]*[Cc]ode|otp)"\\s*:\\s*"${c}"`));
}

qa(["TC-DEL-001", "TC-DEL-010", "TC-DEL-012"], "the rider accepts on the dashboard: ASSIGNED, progress chips, Navigate to the shop, drop area only; no code or customer identity reaches the rider at any stage", async ({ browser }) => {
  await ready();
  const placed = await placeSimple();
  const secrets = await secretsOf(placed.id);
  const { context, page } = await riderPage(browser);
  const shop = need(world().shops.A, "shop A");
  const notes: string[] = [];
  try {
    await driveTo(placed.id, "READY");
    await page.goto("/delivery-partner");
    await expect(page.getByText(/New delivery offer/)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(placed.orderNumber)).toBeVisible();
    assertNoLeak(await page.content(), secrets, [], "the dashboard at OFFERED");
    assertNoLeak((await call(await as("rider"), "GET", "/api/delivery-partner/deliveries")).text, secrets, [], "the rider API at OFFERED");
    await page.getByRole("button", { name: "Accept", exact: true }).click();
    await expect.poll(() => statusOf(placed.id), { timeout: 15_000 }).toBe("ASSIGNED");
    await page.reload();
    const chips = page.getByTestId("delivery-progress");
    await expect(chips).toContainText("✓ Accepted");
    await expect(chips).toContainText("At the shop");
    const toShop = page.getByTestId("navigate-pickup");
    await expect(toShop).toHaveText("Navigate to the shop");
    const shopHref = (await toShop.getAttribute("href")) ?? "";
    expect(shopHref, "Google Maps directions link").toMatch(/^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=/);
    if (IS_LOCAL && shop.id) {
      const [s] = await db()<{ lat: string; lng: string }[]>`select coalesce(pickup_latitude, latitude) as lat, coalesce(pickup_longitude, longitude) as lng from shops where id = ${shop.id}`;
      expect(shopHref, "destination is the shop").toContain(`destination=${Number(s.lat)},${Number(s.lng)}`);
    }
    await expect(page.getByText("The full address and navigation appear once you pick up the order.")).toBeVisible();
    await expect(page.getByTestId("navigate-drop")).toHaveCount(0);
    const code = await pickupCode(placed.id);
    assertNoLeak(await page.content(), secrets, [code], "the dashboard at ASSIGNED");
    notes.push(`ASSIGNED: chips, ${shopHref}, area-only drop`);

    const active = need(await activeDelivery("rider"), "the rider's active delivery");
    const picked = await riderAction(active.id, "pickup", { pickupCode: code });
    expectStatus(picked, 200, "pickup");
    assertNoLeak(picked.text, secrets, [code], "the pickup answer");
    const started = await riderAction(active.id, "start");
    expectStatus(started, 200, "start");
    await page.reload();
    const toDrop = page.getByTestId("navigate-drop");
    await expect(toDrop).toHaveText("Navigate to the customer");
    const dropHref = (await toDrop.getAttribute("href")) ?? "";
    const snap = (await orderRow(placed.id)) as unknown as { deliveryAddressSnapshot?: { latitude?: string; longitude?: string } };
    if (snap.deliveryAddressSnapshot?.latitude) {
      expect(dropHref, "destination is the customer's pin").toContain(`destination=${Number(snap.deliveryAddressSnapshot.latitude)},${Number(snap.deliveryAddressSnapshot.longitude)}`);
    }
    const otp = await buyerCode(placed.id);
    const view = await call(await as("rider"), "GET", "/api/delivery-partner/deliveries");
    assertNoLeak(view.text, secrets, [code, otp], "the rider API on the drop");
    assertNoLeak(await page.content(), secrets, [code, otp], "the dashboard on the drop");
    expect(view.text).toMatch(/"needsDeliveryOtp":true/);
    const done = await riderAction(active.id, "deliver", { otp });
    expectStatus(done, 200, "deliver");
    assertNoLeak(done.text, secrets, [code, otp], "the deliver answer");
    notes.push(`drop: ${dropHref}; only needs* flags at every stage`);
  } finally {
    await context.close();
    await abandon(placed.id);
  }
  return notes.join("; ");
}, { ...signed, mobile: true, partial: "Google Maps itself is not opened (no outside network in the run): the deep link and its destination are checked; the customer's phone is checked on the local run" });

qa("TC-DEL-003", "'I've arrived at the shop' twice: the chip ticks, the shop is told once, the second tap is harmless", async ({ browser }) => {
  await ready();
  const placed = await placeSimple();
  const { context, page } = await riderPage(browser);
  try {
    await driveTo(placed.id, "ASSIGNED");
    await page.goto("/delivery-partner");
    await page.getByRole("button", { name: "I've arrived at the shop" }).click();
    await expect(page.getByTestId("delivery-progress")).toContainText("✓ At the shop", { timeout: 15_000 });
    const active = need(await activeDelivery("rider"), "active delivery");
    const again = await riderAction(active.id, "arrived_shop");
    expectStatus(again, 200, "second tap");
    const told = await notesFor("shop", `${placed.orderNumber} is at your shop`);
    expect(told, "one 'Rider has arrived' notice").toHaveLength(1);
    return `chip ticked; second tap ${again.status}; shop notices: ${told.length}`;
  } finally {
    await context.close();
    await abandon(placed.id);
  }
}, { ...signed, mobile: true });

qa(["TC-DEL-004", "TC-FLD-085"], "pickup code: blank, 5 and 7 digits, letters and wrong codes are refused (not counted, no lock); the screen keeps 4 digits only and accepts the right code pasted with spaces → PICKED_UP, shop and customer told", async ({ browser }) => {
  await ready();
  const placed = await placeSimple();
  const notes: string[] = [];
  const { context, page } = await riderPage(browser);
  try {
    const driven = await driveTo(placed.id, "ASSIGNED");
    const code = need(await pickupCode(placed.id), "a pickup code on the packing slip");
    const wrong = code === "0000" ? "1111" : "0000";
    for (const [what, value] of [["blank", ""], ["5 digits", "12345"], ["7 digits", "1234567"], ["letters", "abcd"], ["wrong", wrong], ["wrong again", wrong], ["wrong x3", wrong]] as const) {
      const res = await riderAction(driven.deliveryOrderId!, "pickup", { pickupCode: value });
      expect(res.status, `${what}: ${res.status}`).toBe(422);
      notes.push(`${what} ${res.status}`);
    }
    expect(await statusOf(placed.id)).toBe("ASSIGNED");
    await page.goto("/delivery-partner");
    const field = page.getByLabel("Pickup code from the shop");
    await field.fill("abcd");
    await expect(field, "letters are not taken").toHaveValue("");
    await field.fill("123456");
    await expect(field, "at most 4 digits").toHaveValue(/^\d{0,4}$/);
    await field.fill("12");
    await expect(page.getByRole("button", { name: "Confirm pickup" }), "disabled until 4 digits").toBeDisabled();
    await field.fill(wrong);
    await page.getByRole("button", { name: "Confirm pickup" }).click();
    await expect(page.getByText(/pickup code does not match/i)).toBeVisible();
    await field.fill(`  ${code}  `);
    const pasted = await field.inputValue();
    // "Cleaned or refused": either the field holds exactly the code, or Confirm stays disabled.
    if (pasted !== code) await expect(page.getByRole("button", { name: "Confirm pickup" }), `padded paste left "${pasted}"`).toBeDisabled();
    notes.push(`padded paste → field "${pasted}" (${pasted === code ? "cleaned" : "refused: Confirm disabled"})`);
    await field.fill(code);
    await page.getByRole("button", { name: "Confirm pickup" }).click();
    await expect.poll(() => statusOf(placed.id), { timeout: 15_000 }).toBe("PICKED_UP");
    const shopTold = await notesFor("shop", placed.orderNumber);
    const customerTold = await notesFor("customer", placed.orderNumber);
    expect(shopTold.map((n) => `${n.title} ${n.body}`).join(" | "), "shop told of the pickup").toMatch(/picked up|collected|on the way/i);
    expect(customerTold.map((n) => `${n.title} ${n.body}`).join(" | "), "customer told of the pickup").toMatch(/picked up|collected|on the way/i);
    notes.push("screen: letters dropped, max 4 digits, wrong code shown as error, exact code accepted");
  } finally {
    await context.close();
    await abandon(placed.id);
  }
  return notes.join("; ");
}, { ...signed, mobile: true, partial: "wrong pickup codes are not counted at all — there is no attempt limit on the pickup code (only the delivery code locks)" });

qa(["TC-DEL-005", "TC-DEL-006"], "Start delivery: OUT_FOR_DELIVERY, full address, notes and Navigate to the customer appear; the customer's order shows the delivery code panel; arriving tells the customer", async ({ browser }) => {
  await ready();
  const addressId = world().addresses?.customer;
  let restoreNotes = async () => {};
  if (IS_LOCAL && addressId) {
    const [before] = await db()<{ landmark: string | null; delivery_instructions: string | null }[]>`select landmark, delivery_instructions from addresses where id = ${addressId}`;
    await db()`update addresses set landmark = 'Opposite QA Garden', delivery_instructions = 'Ring twice' where id = ${addressId}`;
    restoreNotes = async () => {
      await db()`update addresses set landmark = ${before.landmark}, delivery_instructions = ${before.delivery_instructions} where id = ${addressId}`;
    };
  }
  const placed = await placeSimple().finally(restoreNotes);
  const notes: string[] = [];
  const { context, page } = await riderPage(browser);
  try {
    const driven = await driveTo(placed.id, "ASSIGNED");
    await page.goto("/delivery-partner");
    await expect(page.getByText("The full address and navigation appear once you pick up the order.")).toBeVisible();
    await expect(page.getByText(/QA Flat 1, Karve Road/), "area only before pickup").toHaveCount(0);
    const code = need(await pickupCode(placed.id), "pickup code");
    expectStatus(await riderAction(driven.deliveryOrderId!, "pickup", { pickupCode: ` ${code} ` }), 200, "pickup with the code padded by spaces (API trims it)");
    await page.goto("/delivery-partner");
    // The full address appears from pickup (delivery-assignment.ts getMyActiveDeliveryDetail), before the drop starts.
    await expect(page.getByText(/QA Flat 1, Karve Road/).first(), "full address once picked up").toBeVisible();
    await page.getByRole("button", { name: "Start delivery" }).click();
    await expect.poll(() => statusOf(placed.id), { timeout: 15_000 }).toBe("OUT_FOR_DELIVERY");
    await page.reload();
    await expect(page.getByText(/QA Flat 1, Karve Road/).first(), "full address").toBeVisible();
    await expect(page.getByTestId("navigate-drop")).toHaveText("Navigate to the customer");
    if (IS_LOCAL) await expect(page.getByText(/Opposite QA Garden · Ring twice/), "landmark and instructions").toBeVisible();
    notes.push("drop details shown after Start delivery");
    const customer = await pageAs(browser, "customer");
    try {
      const card = await customerCard(customer.page, placed.orderNumber);
      await expect(card.getByTestId("delivery-otp")).toContainText(/delivery code was emailed to/i);
      await expect(card.getByRole("button", { name: /Get a new code/ })).toBeVisible();
      notes.push("customer's card shows the delivery-code panel (code e-mailed, a new one on request)");
    } finally {
      await customer.context.close();
    }
    await page.getByRole("button", { name: "I've arrived at the customer" }).click();
    await expect(page.getByTestId("delivery-progress")).toContainText("✓ At the customer", { timeout: 15_000 });
    const told = await notesFor("customer", placed.orderNumber);
    expect(told.map((n) => n.title), "customer told the rider arrived").toContain("Your rider has arrived");
    notes.push(`arrival notice: "${told.find((n) => n.title === "Your rider has arrived")?.body}"`);
  } finally {
    await context.close();
    await abandon(placed.id);
  }
  return notes.join("; ");
}, { ...signed, mobile: true, partial: "the full address, notes and the customer link appear at pickup rather than at Start delivery (src/server/services/delivery-assignment.ts getMyActiveDeliveryDetail: 'from PICKED_UP'); the code itself is e-mailed and shown on the card on request (after the 60 s resend cooldown); the society wording of the arrival notice is checked with a society order in local/orders-dispatch.spec.ts; landmark/instructions are arranged and checked on the local run only" });

qa("TC-DEL-007", "delivered with the customer's code: DELIVERED, the rider's earning credited, customer and shop told, a finance snapshot exists", async () => {
  await ready();
  const placed = await placeSimple();
  try {
    const driven = await driveTo(placed.id, "DELIVERED");
    expect(await statusOf(placed.id)).toBe("DELIVERED");
    const earnings = await call(await as("rider"), "GET", "/api/delivery-partner/earnings");
    const earning = (earnings.body.statement as { deliveryOrderId: string; totalPaise: number }[]).find((e) => e.deliveryOrderId === driven.deliveryOrderId);
    expect(earning, "rider earning").toBeTruthy();
    const customerTold = await notesFor("customer", placed.orderNumber);
    const shopTold = await notesFor("shop", placed.orderNumber);
    expect(customerTold.map((n) => `${n.title} ${n.body}`).join(" | "), "customer told").toMatch(/delivered/i);
    expect(shopTold.map((n) => `${n.title} ${n.body}`).join(" | "), "shop told").toMatch(/delivered/i);
    const trace = await call(await as("admin"), "GET", `/api/finance/orders/${encodeURIComponent(placed.orderNumber)}`);
    expectStatus(trace, 200, "finance trace");
    expect(JSON.stringify(trace.body), "finance snapshot").toMatch(/goodsPaise|commission|shopPayable/i);
    return `${placed.orderNumber} DELIVERED; earning ₹${(earning!.totalPaise / 100).toFixed(2)}; both told; finance snapshot present`;
  } finally {
    await abandon(placed.id);
  }
}, signed);

qa(["TC-DEL-008", "TC-FLD-086", "TC-DEL-009", "TC-FLD-088"], "delivery code: malformed entries refused without counting; five wrong codes lock the drop (the right one too); operations completes it with a proof note (blank, spaces, 1 and 501 characters refused, shop owner 403)", async ({ browser }) => {
  await ready();
  const placed = await placeSimple();
  const notes: string[] = [];
  try {
    const driven = await driveTo(placed.id, "OUT_FOR_DELIVERY");
    const id = driven.deliveryOrderId!;
    for (const [what, otp] of [["blank", ""], ["5 digits", "12345"], ["7 digits", "1234567"], ["letters", "abcd"]] as const) {
      const res = await riderAction(id, "deliver", { otp });
      expect(res.status, `${what}`).toBe(422);
    }
    const afterMalformed = (await call(await as("rider"), "GET", "/api/delivery-partner/deliveries")).body.active;
    expect(afterMalformed.deliveryOtpAttempts, "malformed entries are not counted").toBe(0);
    notes.push("blank/5/7/letters → 422, not counted");
    const { context, page } = await riderPage(browser);
    try {
      await page.goto("/delivery-partner");
      const field = page.getByLabel("Delivery code from the customer");
      await field.fill("ab12");
      await expect(field).toHaveValue("12");
      await expect(page.getByRole("button", { name: "Mark delivered" })).toBeDisabled();
    } finally {
      await context.close();
    }
    const otp = await buyerCode(placed.id);
    const wrong = otp === "0000" ? "1111" : "0000";
    const spaced = await riderAction(id, "deliver", { otp: ` ${wrong.slice(0, 2)} ${wrong.slice(2)} ` });
    expect(spaced.status, "spaces inside are cleaned, then the (wrong) code is counted").toBe(422);
    let last = spaced;
    for (let i = 2; i <= 5; i++) last = await riderAction(id, "deliver", { otp: wrong });
    expect(last.status, "the fifth wrong code locks").toBe(409);
    const right = await riderAction(id, "deliver", { otp });
    expect(right.status, "the right code after the lock").toBe(409);
    expect(await statusOf(placed.id)).toBe("OUT_FOR_DELIVERY");
    const customer = await pageAs(browser, "customer");
    try {
      const card = await customerCard(customer.page, placed.orderNumber);
      await expect(card.getByTestId("delivery-code-locked")).toBeVisible();
    } finally {
      await customer.context.close();
    }
    notes.push(`5 wrong → ${last.status} "${last.body?.error?.message}"; right code → ${right.status}`);

    for (const [what, proofNote, code] of [
      ["no note", undefined, 422],
      ["blank", "", 422],
      ["spaces", "       ", 422],
      ["1 character", "x", 422],
      ["501 characters", TEXT.long(501), 422],
    ] as const) {
      const res = await call(await as("ops"), "POST", `/api/orders/${placed.id}/confirm-delivery`, proofNote === undefined ? {} : { proofNote });
      expect(res.status, `override with ${what}`).toBe(code);
    }
    const byShop = await call(await as("shop"), "POST", `/api/orders/${placed.id}/confirm-delivery`, { proofNote: "Shop says delivered" });
    expect(byShop.status, "shop owner").toBe(403);
    const note = `   Called the customer — ${TEXT.script} ${TEXT.hindi}   `;
    const ok = await call(await as("ops"), "POST", `/api/orders/${placed.id}/confirm-delivery`, { proofNote: note });
    expectStatus(ok, 200, "operator override with a note");
    expect(await statusOf(placed.id)).toBe("DELIVERED");
    const history = (await call(await as("rider"), "GET", "/api/delivery-partner/deliveries")).body.history as { id: string; proofNote: string | null; deliveryConfirmation: string | null }[];
    const row = history.find((h) => h.id === id);
    expect(row?.deliveryConfirmation).toBe("OPERATOR_OVERRIDE");
    expect(row?.proofNote, "note stored as written, trimmed").toBe(note.trim());
    let audited = "audit not read (no database on this site)";
    if (IS_LOCAL) {
      const [a] = await db()<{ n: number }[]>`select count(*)::int as n from audit_logs where action = 'delivery_order.confirmed_by_operator' and entity_id = ${id}`;
      expect(a.n, "override audited").toBe(1);
      audited = "audited once";
    }
    notes.push(`override notes refused: none/blank/spaces/1/501 → 422; shop 403; with note → DELIVERED (${audited}), note kept trimmed incl. script and Hindi; limit 500`);
  } finally {
    await abandon(placed.id);
  }
  return notes.join("; ");
}, { ...signed, timeout: 360_000, partial: "the override note is checked as stored (rider history API); its display as plain text on an operator screen is not checked" });

qa("TC-FLD-087", "failed-delivery reason: required (blank, spaces, 2 and 301 characters refused); free text is kept as written (the rider screen has no option list)", async ({ browser }) => {
  await ready();
  const placed = await placeSimple();
  const seen: string[] = [];
  try {
    const driven = await driveTo(placed.id, "OUT_FOR_DELIVERY");
    const id = driven.deliveryOrderId!;
    for (const [what, body] of [["no reason", {}], ["blank", { reason: "" }], ["spaces", { reason: "     " }], ["2 characters", { reason: "ab" }], ["301 characters", { reason: TEXT.long(301) }]] as const) {
      const res = await riderAction(id, "fail", body);
      expect(res.status, what).toBe(422);
      seen.push(`${what} 422`);
    }
    const { context, page } = await riderPage(browser);
    try {
      await page.goto("/delivery-partner");
      await page.getByRole("button", { name: "Could not deliver" }).click();
      await expect(page.getByRole("button", { name: "Report failed delivery" }), "disabled with no reason").toBeDisabled();
      await page.getByLabel("Reason the delivery failed").fill(`  ${TEXT.script} ${TEXT.marathi}  `);
      await page.getByRole("button", { name: "Report failed delivery" }).click();
      await expect.poll(() => statusOf(placed.id), { timeout: 15_000 }).toBe("FAILED");
    } finally {
      await context.close();
    }
    const told = await notesFor("shop", placed.orderNumber);
    expect(told.map((n) => n.body).join(" | "), "reason reaches the shop as written").toContain(TEXT.marathi);
    seen.push("free text with script and Marathi kept (trimmed) and sent to the shop");
    const list = await (async () => {
      const second = await placeSimple();
      try {
        const d = await driveTo(second.id, "OUT_FOR_DELIVERY");
        return (await riderAction(d.deliveryOrderId!, "fail", { reason: "Banana" })).status;
      } finally {
        await abandon(second.id);
      }
    })();
    seen.push(`free-text reason "Banana" → ${list}`);
    // The rider types the reason (one free-text field, no list), so any 3–300 characters are accepted.
    expect(list, `free text is accepted — ${seen.join("; ")}`).toBe(200);
  } finally {
    await abandon(placed.id);
  }
  return seen.join("; ");
}, { ...signed, timeout: 360_000, partial: "the failure reason is one free-text field (no option list, no separate note)" });

qa("TC-FLD-089", "cash on delivery: Mark delivered stays disabled until the cash tick; without it, or with a non-boolean, the API refuses; with it the order is delivered and paid in cash", async ({ browser }) => {
  await ready();
  const restore = await withShopSettings({ codEnabled: true });
  try {
    const placed = await placeSimple({ method: "COD" });
    try {
      const driven = await driveTo(placed.id, "OUT_FOR_DELIVERY");
      const otp = await buyerCode(placed.id);
      const none = await riderAction(driven.deliveryOrderId!, "deliver", { otp });
      expect(none.status, "without the cash confirmation").toBe(422);
      const notBool = await call(await as("rider"), "PATCH", `/api/delivery-orders/${driven.deliveryOrderId}`, { action: "deliver", otp, cashCollected: "yes" });
      expect(notBool.status, "non-boolean").toBe(422);
      const { context, page } = await riderPage(browser);
      try {
        await page.goto("/delivery-partner");
        await expect(page.getByTestId("cash-to-collect")).toBeVisible();
        await page.getByLabel("Delivery code from the customer").fill(otp);
        const tick = page.getByRole("checkbox", { name: /I collected/ });
        const button = page.getByRole("button", { name: "Mark delivered" });
        await expect(button, "disabled before the tick").toBeDisabled();
        await tick.check();
        await expect(button).toBeEnabled();
        await tick.uncheck();
        await expect(button, "disabled again after unticking").toBeDisabled();
        await tick.check();
        await button.click();
        await expect.poll(() => statusOf(placed.id), { timeout: 15_000 }).toBe("DELIVERED");
      } finally {
        await context.close();
      }
      const customer = await pageAs(browser, "customer");
      try {
        const card = await customerCard(customer.page, placed.orderNumber, "past");
        await expect(card.getByText("paid in cash")).toBeVisible();
      } finally {
        await customer.context.close();
      }
      return `COD ${placed.orderNumber}: no tick → ${none.status} "${none.body?.error?.message}", "yes" → ${notBool.status}; tick on/off gates the button; delivered and 'paid in cash'`;
    } finally {
      await abandon(placed.id);
    }
  } finally {
    await restore();
  }
}, { ...signed, mobile: true, partial: "the tick is part of the deliver action, not a saved setting — 'persists after reload' does not apply" });

qa("TC-DEL-018", "tracking: the customer, shop, assigned rider and operations may look, another customer and a rider who declined may not; no location before the drop starts; bad id 422; ETA never NaN", async () => {
  need(world().users.rider2, "a second rider");
  await releaseRiders();
  await ensureWallet();
  const home = homeSpot();
  if (IS_LOCAL) await ridersOnlyOnline({ rider2: { dLat: 0.0005, dLng: 0 }, rider: { dLat: 0.02, dLng: 0 } });
  else {
    await riderOnline("rider2", home.lat + 0.0005, home.lng);
    await riderOnline("rider", home.lat + 0.02, home.lng);
  }
  const placed = await placeSimple();
  const notes: string[] = [];
  try {
    await driveTo(placed.id, "READY");
    const first = need(await activeDelivery("rider2"), "the nearer rider's offer");
    expect(first.orderId).toBe(placed.id);
    expectStatus(await riderAction(first.id, "reject", { reason: "QA decline" }, "rider2"), 200, "rider 2 declines");
    const driven = await driveTo(placed.id, "ASSIGNED", { from: "READY" });
    const look = async (role: Role) => (await call(await as(role), "GET", `/api/tracking/${placed.id}`)).status;
    const allowed = { customer: await look("customer"), shop: await look("shop"), rider: await look("rider"), ops: await look("ops") };
    const denied = { customer2: await look("customer2"), rider2: await look("rider2") };
    for (const [who, s] of Object.entries(allowed)) expect(s, `${who} may track`).toBe(200);
    for (const [who, s] of Object.entries(denied)) expect(s, `${who} may not`).toBe(403);
    const bad = await call(await as("customer"), "GET", "/api/tracking/not-a-uuid");
    expect(bad.status, "bad uuid").toBe(422);
    const at = async () => (await call(await as("customer"), "GET", `/api/tracking/${placed.id}`)).body;
    const assigned = await at();
    expect(assigned.riderLocation, "no location at ASSIGNED").toBeNull();
    const code = need(await pickupCode(placed.id), "pickup code");
    expectStatus(await riderAction(driven.deliveryOrderId!, "pickup", { pickupCode: code }), 200, "pickup");
    await call(await as("rider"), "POST", "/api/delivery-partner/location", { latitude: home.lat + 0.004, longitude: home.lng });
    const picked = await at();
    expect(picked.riderLocation, "no location before the drop starts").toBeNull();
    expectStatus(await riderAction(driven.deliveryOrderId!, "start"), 200, "start");
    const ping = await call(await as("rider"), "POST", `/api/delivery-orders/${driven.deliveryOrderId}/location`, { latitude: home.lat + 0.005, longitude: home.lng });
    expectStatus(ping, 200, "rider shares location on the drop");
    const out = await at();
    expect(out.riderLocation, "location while out for delivery").toBeTruthy();
    for (const body of [assigned, picked, out]) {
      expect(body.etaMinutes === null || Number.isFinite(body.etaMinutes), `ETA ${body.etaMinutes}`).toBe(true);
      expect(JSON.stringify(body)).not.toMatch(/NaN/);
    }
    notes.push(`allowed ${JSON.stringify(allowed)}, denied ${JSON.stringify(denied)}, bad id ${bad.status}; location none at ASSIGNED/PICKED_UP, shown on the drop; ETA ${out.etaMinutes} min`);
  } finally {
    await abandon(placed.id);
  }
  return notes.join("; ");
}, { ...signed, partial: "coordinates appear once the drop starts (stricter than 'after pickup'; tracking rule description, src/server/config/rules.ts)" });

qa("TC-DEL-019", "My Orders has a live tracking view for an order out for delivery: the rider's position and an ETA", async ({ browser }) => {
  await ready();
  const placed = await placeSimple();
  const home = homeSpot();
  const { context, page } = await pageAs(browser, "customer");
  try {
    const driven = await driveTo(placed.id, "OUT_FOR_DELIVERY");
    expectStatus(await call(await as("rider"), "POST", `/api/delivery-orders/${driven.deliveryOrderId}/location`, { latitude: home.lat + 0.004, longitude: home.lng }), 200, "rider location");
    const card = await customerCard(page, placed.orderNumber);
    await card.getByRole("button", { name: "Track delivery" }).click();
    await expect(page.getByRole("heading", { name: "Delivery tracking" })).toBeVisible();
    await expect(page.getByText(/About \d+ min away/)).toBeVisible({ timeout: 20_000 });
    // With a Maps key: the map; without one (this run) a link to the rider's position.
    const where = page.getByRole("link", { name: "See where your rider is" });
    const map = page.getByTestId("rider-map");
    await expect(where.or(map)).toBeVisible();
    const href = (await where.count()) ? await where.getAttribute("href") : "map";
    if (href !== "map") expect(href).toContain(`q=${home.lat + 0.004},${home.lng}`);
    return `Track delivery opens the panel: ETA and the rider's position (${href})`;
  } finally {
    await context.close();
    await abandon(placed.id);
  }
}, { ...signed, mobile: true, partial: "the 3-Oct 'known gap' (component not mounted) is superseded: the tracking view is mounted on My Orders (src/app/orders/page.tsx, event layer)" });

qa("TC-DEL-020", "a shop without platform delivery moves READY → Out for delivery → Delivered from its own screen; with a rider on the order the buttons are not offered", async ({ browser }) => {
  await ready();
  const placed = await placeSimple();
  const restore = { fn: async () => {} };
  try {
    await driveTo(placed.id, "PREPARING");
    restore.fn = await withShopSettings({ deliveryAvailable: false });
    await driveTo(placed.id, "READY", { from: "PREPARING" });
    expect(await activeDelivery("rider"), "no rider offered for a self-delivering shop").toBeNull();
    const { context, page } = await pageAs(browser, "shop");
    try {
      const card = await shopCard(page, placed.orderNumber, "ready");
      await card.getByRole("button", { name: "Out for delivery (own delivery)" }).click();
      await expect.poll(() => statusOf(placed.id), { timeout: 15_000 }).toBe("OUT_FOR_DELIVERY");
      const out = await shopCard(page, placed.orderNumber, "out");
      await out.getByRole("button", { name: "Mark delivered" }).click();
      await expect.poll(() => statusOf(placed.id), { timeout: 15_000 }).toBe("DELIVERED");
    } finally {
      await context.close();
    }
  } finally {
    await restore.fn();
  }
  const second = await placeSimple();
  try {
    await driveTo(second.id, "ASSIGNED");
    const { context, page } = await pageAs(browser, "shop");
    try {
      const card = await shopCard(page, second.orderNumber, "ready");
      await expect(card.getByRole("button", { name: /Handed to customer|Out for delivery/ })).toHaveCount(0);
    } finally {
      await context.close();
    }
    const forced = await call(await as("shop"), "PATCH", `/api/orders/${second.id}/status`, { status: "DELIVERED" });
    expect(forced.status, "shop cannot deliver an order a rider holds").toBe(409);
    return `self-delivery READY → OUT_FOR_DELIVERY → DELIVERED from the shop screen; with a rider assigned no manual buttons and DELIVERED → ${forced.status}`;
  } finally {
    await abandon(second.id);
  }
}, { ...signed, mobile: true });

qa(["TC-DEL-024"], "a delivery photo opens for the order's customer, shop, rider and operations only — not another customer, another rider or a guest", async () => {
  need(world().users.rider2, "a second rider");
  await ready();
  const placed = await placeSimple();
  try {
    const driven = await driveTo(placed.id, "PICKED_UP");
    const up = await upload(await as("rider"), `/api/delivery-orders/${driven.deliveryOrderId}/proof`, { name: "door.png", mimeType: "image/png", buffer: png() });
    expectStatus(up, 201, "rider uploads the photo");
    const url = String(up.body.url);
    const status = async (role: Role | "guest") => {
      if (role === "guest") {
        const g = await anonymous();
        try {
          return (await call(g, "GET", url)).status;
        } finally {
          await g.dispose();
        }
      }
      return (await call(await as(role), "GET", url)).status;
    };
    const seen: Record<string, number> = {};
    for (const r of ["customer", "shop", "rider", "ops"] as const) seen[r] = await status(r);
    for (const r of ["customer2", "rider2", "guest"] as const) seen[r] = await status(r);
    for (const r of ["customer", "shop", "rider", "ops"]) expect(seen[r], `${r} may open the photo`).toBe(200);
    for (const r of ["customer2", "rider2", "guest"]) expect([403, 404], `${r} may not`).toContain(seen[r]);
    const pdf = await upload(await as("rider"), `/api/delivery-orders/${driven.deliveryOrderId}/proof`, { name: "door.jpg", mimeType: "image/jpeg", buffer: PDF_BYTES });
    expect(pdf.status, "a PDF renamed .jpg is refused").toBe(422);
    return `${url}: ${JSON.stringify(seen)}; PDF named .jpg → ${pdf.status}`;
  } finally {
    await abandon(placed.id);
  }
}, { ...signed, partial: "guest half also in guest/access.spec.ts; with the photo rule off the upload is optional (the required-photo rule is TC-DEL-022/023, local)" });

qa("TC-DSP-015", "the assign API refuses another shop's owner and a customer (403)", async () => {
  need(world().users.shopB, "a second shop owner");
  await ready();
  const placed = await placeSimple();
  try {
    await driveTo(placed.id, "READY");
    const other = await call(await as("shopB"), "POST", `/api/orders/${placed.id}/assign`, {});
    const customer = await call(await as("customer"), "POST", `/api/orders/${placed.id}/assign`, {});
    const reassign = await call(await as("shop"), "POST", `/api/orders/${placed.id}/assign`, { reassign: true, reason: "QA" });
    expect(other.status, "another shop's owner").toBe(403);
    expect(customer.status, "customer").toBe(403);
    expect(reassign.status, "the shop's own owner may not force a reassignment").toBe(403);
    return `shop B ${other.status}, customer ${customer.status}, own shop reassign ${reassign.status}`;
  } finally {
    await abandon(placed.id);
  }
}, signed);

