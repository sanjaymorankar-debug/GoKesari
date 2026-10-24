/**
 * Order state machine and cancellation (package 5): the label the customer
 * sees at every status, illegal transitions, DISPUTED and RETURNED, and who
 * may cancel at which stage with what refund (D10, NEW-006).
 *
 * Signed-in tier: test accounts on their own orders at shop A. Checks that
 * prove a delivery fee is (or is not) refunded give shop A a delivery fee
 * for the check and put the shop's own value back afterwards.
 */
import { as, pageAs } from "../lib/actors";
import { onlyRiderOnline } from "../lib/flows";
import { call, expectStatus } from "../lib/http";
import {
  abandon,
  activeDelivery,
  checkoutLines,
  customerCard,
  driveTo,
  ensureWallet,
  fulfil,
  keep,
  kept,
  listingOf,
  notesFor,
  orderRow,
  placeSimple,
  releaseRiders,
  riderAction,
  setStatus,
  shopAct,
  statusOf,
  stockOf,
  walletOf,
  withShopSettings,
} from "../lib/orders-helpers";
import { db } from "../lib/db";
import { blocked, expect, qa } from "../lib/record";
import { IS_LOCAL } from "../lib/target";

const signed = { tier: "signed" as const, timeout: 240_000 };
const FEE = 2500;

async function readyRiders() {
  await releaseRiders();
  await onlyRiderOnline("rider");
  await ensureWallet();
}

function delivered() {
  return kept<{ id: string; orderNumber: string }>("cancel-delivered") ?? blocked("needs the order delivered by the TC-ORD-001 check in this run");
}

const label = (status: string) => status.replace(/_/g, " ").toLowerCase();

qa("TC-ORD-001", "My Orders shows the matching status label at every step from CONFIRMED to DELIVERED", async ({ browser }) => {
  await readyRiders();
  const placed = await placeSimple();
  const { context, page } = await pageAs(browser, "customer");
  const seen: string[] = [];
  try {
    const check = async (stage: string) => {
      const card = await customerCard(page, placed.orderNumber, stage === "DELIVERED" ? "past" : "active");
      await expect(card.getByText(label(stage), { exact: true }).first(), `label at ${stage}`).toBeVisible();
      expect(await statusOf(placed.id), "API status").toBe(stage);
      seen.push(label(stage));
    };
    await check("CONFIRMED");
    await driveTo(placed.id, "DELIVERED", { onStep: check });
  } finally {
    await context.close();
  }
  keep("cancel-delivered", { id: placed.id, orderNumber: placed.orderNumber });
  return `${placed.orderNumber}: ${seen.join(" → ")}`;
}, { ...signed, mobile: true, partial: "per-change history rows and audit entries with timestamps are checked by TC-ORD-001 in local/orders-rules.spec.ts" });

qa("TC-ORD-002", "illegal status changes are refused with 409 INVALID_STATE_TRANSITION (422 for an unknown status); the order is unchanged", async () => {
  const notes: string[] = [];
  const confirmed = await placeSimple();
  try {
    const toDelivered = await setStatus(confirmed.id, "DELIVERED");
    expect(toDelivered.status, "CONFIRMED → DELIVERED").toBe(409);
    expect(toDelivered.body?.error?.code).toBe("INVALID_STATE_TRANSITION");
    const unknown = await setStatus(confirmed.id, "TELEPORTED");
    expect(unknown.status, "unknown status").toBe(422);
    expect(await statusOf(confirmed.id)).toBe("CONFIRMED");
    notes.push(`CONFIRMED→DELIVERED ${toDelivered.status}`, `unknown ${unknown.status}`);

    const done = delivered();
    const back = await setStatus(done.id, "PREPARING");
    expect(back.status, "DELIVERED → PREPARING").toBe(409);
    expect(back.body?.error?.code).toBe("INVALID_STATE_TRANSITION");
    expect(await statusOf(done.id)).toBe("DELIVERED");
    notes.push(`DELIVERED→PREPARING ${back.status}`);

    // Cancel the CONFIRMED one (a wallet order ends REFUNDED), then try to reopen it.
    expectStatus(await setStatus(confirmed.id, "CANCELLED", "shop", "QA"), 200, "shop cancels");
    const ended = await statusOf(confirmed.id);
    const reopen = await setStatus(confirmed.id, "PREPARING");
    expect(reopen.status, `${ended} → PREPARING`).toBe(409);
    expect(reopen.body?.error?.code).toBe("INVALID_STATE_TRANSITION");
    expect(await statusOf(confirmed.id)).toBe(ended);
    notes.push(`${ended}→PREPARING ${reopen.status}`);
  } finally {
    await abandon(confirmed.id);
  }

  await readyRiders();
  const ready = await placeSimple();
  try {
    await driveTo(ready.id, "READY");
    // ACCEPTED is not a target the status endpoint takes (accepting goes through fulfilment); both routes refuse.
    const viaStatus = await setStatus(ready.id, "ACCEPTED");
    expect([409, 422], `READY → ACCEPTED via /status: ${viaStatus.status}`).toContain(viaStatus.status);
    const viaFulfil = await fulfil(ready.id, "accept");
    expect(viaFulfil.status, "READY → ACCEPTED via the shop's accept").toBe(409);
    expect(viaFulfil.body?.error?.code).toBe("INVALID_STATE_TRANSITION");
    expect(await statusOf(ready.id)).toBe("READY");
    notes.push(`READY→ACCEPTED /status ${viaStatus.status}, accept ${viaFulfil.status}`);
  } finally {
    await abandon(ready.id);
  }
  return notes.join("; ");
}, { ...signed, partial: "CANCELLED → PREPARING is checked on a cancelled wallet order, which ends REFUNDED; READY → ACCEPTED answers 422 on /status (ACCEPTED is not a target there) and 409 on the accept action" });

qa("TC-ORD-004", "DISPUTED is operations-only: the shop is refused, an operator opens it (and can return it to DELIVERED)", async () => {
  const done = delivered();
  const byShop = await setStatus(done.id, "DISPUTED", "shop");
  expect(byShop.status, "shop sets DISPUTED").toBe(403);
  expect(await statusOf(done.id)).toBe("DELIVERED");
  const byOps = await setStatus(done.id, "DISPUTED", "ops");
  expectStatus(byOps, 200, "operator sets DISPUTED");
  expect(await statusOf(done.id)).toBe("DISPUTED");
  // Back to DELIVERED (operations closes the dispute) so later checks find it delivered.
  expectStatus(await setStatus(done.id, "DELIVERED", "ops"), 200, "operator returns it to DELIVERED");
  expect(await statusOf(done.id)).toBe("DELIVERED");
  return `shop ${byShop.status} "${byShop.body?.error?.message}"; operator → DISPUTED → DELIVERED`;
}, { ...signed, partial: "exclusion of a disputed order from settlement is checked by TC-ORD-004 / TC-RET-020 in local/orders-rules.spec.ts" });

qa("TC-ORD-009", "the customer cannot cancel a DELIVERED or DISPUTED order; the card points to help instead", async ({ browser }) => {
  const done = delivered();
  const notes: string[] = [];
  const { context, page } = await pageAs(browser, "customer");
  try {
    const attempt = async (stage: "DELIVERED" | "DISPUTED") => {
      const res = await call(await as("customer"), "PATCH", `/api/orders/${done.id}/status`, { status: "CANCELLED" });
      expect(res.status, `cancel at ${stage}`).toBe(409);
      const quote = await call(await as("customer"), "GET", `/api/orders/${done.id}/cancellation-quote`);
      expectStatus(quote, 200, "cancellation quote");
      expect(quote.body.allowed, `quote at ${stage}`).toBe(false);
      const card = await customerCard(page, done.orderNumber, "past");
      await expect(card.getByText(label(stage), { exact: true }).first()).toBeVisible();
      await expect(card.getByRole("button", { name: "Cancel order" })).toHaveCount(0);
      await expect(card.getByRole("link", { name: /Get help with this order/i })).toBeVisible();
      notes.push(`${stage}: ${res.status} "${res.body?.error?.message}", help link shown`);
    };
    await attempt("DELIVERED");
    expectStatus(await setStatus(done.id, "DISPUTED", "ops"), 200, "operator opens a dispute");
    try {
      await attempt("DISPUTED");
    } finally {
      await setStatus(done.id, "DELIVERED", "ops");
    }
  } finally {
    await context.close();
  }
  return notes.join("; ");
}, { ...signed, partial: "for DELIVERED and DISPUTED the API answers with the plain transition refusal; the card's 'Get help with this order' link is the route to support (FAILED and RETURNED name support in the message — next check)" });

qa(["TC-ORD-005", "TC-DEL-011", "TC-ORD-009"], "RETURNED only after a failed delivery: refused at READY; rider reports a failed drop (FAILED), shop marks RETURNED and cancels with a refund", async () => {
  await readyRiders();
  const start = await walletOf();
  const placed = await placeSimple();
  const notes: string[] = [];
  try {
    await driveTo(placed.id, "READY");
    const early = await setStatus(placed.id, "RETURNED");
    expect(early.status, "RETURNED at READY").toBe(409);
    notes.push(`READY→RETURNED ${early.status}`);
    const driven = await driveTo(placed.id, "OUT_FOR_DELIVERY", { from: "READY" });
    const failed = await riderAction(driven.deliveryOrderId!, "fail", { reason: "Customer not reachable" });
    expectStatus(failed, 200, "rider reports a failed delivery");
    expect(await statusOf(placed.id)).toBe("FAILED");
    const shopNote = await notesFor("shop", placed.orderNumber);
    expect(shopNote.map((n) => n.body).join(" | "), "shop told of the failed delivery").toMatch(/not reachable|could not|failed/i);
    const earnings = await call(await as("rider"), "GET", "/api/delivery-partner/earnings");
    expectStatus(earnings, 200, "rider earnings");
    const earning = (earnings.body.statement as { deliveryOrderId: string; totalPaise: number }[]).find((e) => e.deliveryOrderId === driven.deliveryOrderId);
    expect(earning, "rider credited for the failed trip").toBeTruthy();
    notes.push(`FAILED; shop notified; rider earning ₹${(earning!.totalPaise / 100).toFixed(2)}`);

    const selfAtFailed = await call(await as("customer"), "PATCH", `/api/orders/${placed.id}/status`, { status: "CANCELLED" });
    expect(selfAtFailed.status, "customer cancel at FAILED").toBe(409);
    expect(selfAtFailed.body?.error?.message).toMatch(/support/i);

    expectStatus(await setStatus(placed.id, "RETURNED"), 200, "shop marks RETURNED");
    expect(await statusOf(placed.id)).toBe("RETURNED");
    const selfAtReturned = await call(await as("customer"), "PATCH", `/api/orders/${placed.id}/status`, { status: "CANCELLED" });
    expect(selfAtReturned.status, "customer cancel at RETURNED").toBe(409);
    expect(selfAtReturned.body?.error?.message).toMatch(/support/i);

    expectStatus(await setStatus(placed.id, "CANCELLED", "shop", "Goods back at the shop"), 200, "shop cancels and refunds");
    const end = await statusOf(placed.id);
    expect(["CANCELLED", "REFUNDED"]).toContain(end);
    expect(await walletOf(), "customer refunded in full").toBe(start);
    notes.push(`RETURNED → ${end}, wallet back to ${start}; customer self-cancel at FAILED/RETURNED 409 "${selfAtReturned.body?.error?.message}"`);
  } finally {
    await abandon(placed.id);
  }
  return notes.join("; ");
}, { ...signed, partial: "TC-ORD-009 here covers FAILED and RETURNED (DELIVERED and DISPUTED in the checks above)" });

qa("TC-ORD-006", "the customer cancels a CONFIRMED order on My Orders: the quote shows the full amount, the wallet gets goods + delivery fee back, stock returns", async ({ browser }) => {
  await ensureWallet();
  const restore = await withShopSettings({ deliveryFeePaise: FEE, freeDeliveryAbovePaise: null });
  const listing = await listingOf("packaged");
  try {
    const start = await walletOf();
    const stockBefore = await stockOf(listing);
    const placed = await checkoutLines([{ listing }]);
    const row = await orderRow(placed.id);
    expect(row.deliveryFeePaise, "the order carries a delivery fee").toBe(FEE);
    const { context, page } = await pageAs(browser, "customer");
    try {
      const card = await customerCard(page, placed.orderNumber);
      await card.getByRole("button", { name: "Cancel order" }).click();
      const quote = card.getByTestId("cancel-order-quote");
      await expect(quote.getByTestId("refund-amount")).toContainText((placed.totalPaise / 100).toFixed(2));
      await quote.getByRole("button", { name: "Yes, cancel order" }).click();
      await expect(page.getByTestId("order-cancelled")).toContainText(placed.orderNumber);
    } finally {
      await context.close();
    }
    const end = await statusOf(placed.id);
    expect(["CANCELLED", "REFUNDED"]).toContain(end);
    expect(await walletOf(), "full refund including the delivery fee").toBe(start);
    if (stockBefore !== null) expect(await stockOf(listing), "stock returned").toBe(stockBefore);
    const shopNotes = await notesFor("shop", `${placed.orderNumber} was cancelled`);
    expect(shopNotes, "the shop is not told of a cancel before it accepted (D10)").toHaveLength(0);
    return `${placed.orderNumber}: quote ₹${(placed.totalPaise / 100).toFixed(2)} incl. ₹${FEE / 100} fee → ${end}; wallet back to ${start}; stock ${stockBefore} restored; shop not notified`;
  } finally {
    await restore();
  }
}, { ...signed, mobile: true, partial: "'shop notified' superseded by src/server/events/catalog.ts (order.cancelled, D10): a customer cancelling before the shop accepts is not announced to the shop" });

qa("TC-ORD-007", "the customer cannot cancel at ACCEPTED, PREPARING, READY or ASSIGNED: no Cancel button, the quote says to contact the shop, no refund", async ({ browser }) => {
  await readyRiders();
  const start = await walletOf();
  const placed = await placeSimple();
  const notes: string[] = [];
  const { context, page } = await pageAs(browser, "customer");
  try {
    const attempt = async (stage: string) => {
      const card = await customerCard(page, placed.orderNumber);
      await expect(card.getByText(label(stage), { exact: true }).first()).toBeVisible();
      await expect(card.getByRole("button", { name: "Cancel order" }), `no Cancel button at ${stage}`).toHaveCount(0);
      const quote = await call(await as("customer"), "GET", `/api/orders/${placed.id}/cancellation-quote`);
      expectStatus(quote, 200, "quote");
      expect(quote.body.allowed, `quote at ${stage}`).toBe(false);
      expect(quote.body.blockedReason).toMatch(/already being prepared.*contact the shop/i);
      const res = await call(await as("customer"), "POST", `/api/orders/${placed.id}/cancel`, { reason: "QA" });
      expect(res.status, `cancel at ${stage}`).toBe(409);
      notes.push(`${stage} ${res.status}`);
    };
    await driveTo(placed.id, "ASSIGNED", { onStep: (s) => (s === "CONFIRMED" ? Promise.resolve() : attempt(s)) });
    expect(await walletOf(), "no refund").toBe(start - placed.totalPaise);
  } finally {
    await context.close();
    await abandon(placed.id);
  }
  return `refused at ${notes.join(", ")}; message "already being prepared … contact the shop"; wallet unchanged`;
}, { ...signed, mobile: true });

qa("TC-ORD-008", "a customer cancelling after pickup gets the goods back, the delivery fee is kept, the rider is still paid and the assignment ends", async () => {
  await readyRiders();
  const restore = await withShopSettings({ deliveryFeePaise: FEE, freeDeliveryAbovePaise: null });
  try {
    const start = await walletOf();
    const placed = await placeSimple();
    const row = await orderRow(placed.id);
    expect(row.deliveryFeePaise).toBe(FEE);
    const driven = await driveTo(placed.id, "PICKED_UP");
    const quote = await call(await as("customer"), "GET", `/api/orders/${placed.id}/cancellation-quote`);
    expectStatus(quote, 200, "quote after pickup");
    expect(quote.body.allowed, "the quote allows a cancel after pickup").toBe(true);
    expect(quote.body.breakdown.refundPaise, "goods only").toBe(row.subtotalPaise);
    const res = await call(await as("customer"), "POST", `/api/orders/${placed.id}/cancel`, { reason: "QA after pickup", expectedRefundPaise: quote.body.breakdown.refundPaise });
    expectStatus(res, 200, "customer cancels after pickup");
    expect(await walletOf(), "goods refunded, fee kept").toBe(start - FEE);
    expect(await activeDelivery("rider"), "assignment cancelled").toBeNull();
    const earnings = await call(await as("rider"), "GET", "/api/delivery-partner/earnings");
    const earning = (earnings.body.statement as { deliveryOrderId: string }[]).find((e) => e.deliveryOrderId === driven.deliveryOrderId);
    expect(earning, "rider still paid").toBeTruthy();
    const ledger = await call(await as("admin"), "GET", `/api/finance/ledger?orderId=${placed.id}`);
    expectStatus(ledger, 200, "finance ledger");
    expect(JSON.stringify(ledger.body), "a DELIVERY_FEE entry for the platform").toMatch(/DELIVERY_FEE/);
    return `${placed.orderNumber}: refund ₹${(row.subtotalPaise / 100).toFixed(2)} of ₹${(row.totalPaise / 100).toFixed(2)}; fee ₹${FEE / 100} kept (DELIVERY_FEE in ledger); rider earning kept; assignment cancelled`;
  } finally {
    await restore();
  }
}, { ...signed, partial: "driven through the cancel API the page would call — see the next check for the page" });

qa("TC-ORD-008", "My Orders offers the customer a Cancel button after pickup (the server and the quote allow it, D10)", async ({ browser }) => {
  await readyRiders();
  const placed = await placeSimple();
  const { context, page } = await pageAs(browser, "customer");
  try {
    await driveTo(placed.id, "OUT_FOR_DELIVERY");
    const quote = await call(await as("customer"), "GET", `/api/orders/${placed.id}/cancellation-quote`);
    expect(quote.body.allowed, "the server would allow it").toBe(true);
    const card = await customerCard(page, placed.orderNumber);
    await expect(card.getByText("out for delivery", { exact: true }).first()).toBeVisible();
    await expect(card.getByRole("button", { name: "Cancel order" }), "Cancel order on the OUT_FOR_DELIVERY card").toBeVisible({ timeout: 5_000 });
  } finally {
    await context.close();
    await abandon(placed.id);
  }
  return "Cancel order shown at OUT_FOR_DELIVERY";
}, { ...signed, mobile: true });

qa("TC-ORD-010", "the shop or an operator cancels at CONFIRMED, ACCEPTED, PREPARING, READY, ASSIGNED and after pickup: full refund each time, stock back, rider paid only after pickup", async () => {
  await readyRiders();
  const restore = await withShopSettings({ deliveryFeePaise: FEE, freeDeliveryAbovePaise: null });
  const listing = await listingOf("packaged");
  const notes: string[] = [];
  try {
    const stages = ["CONFIRMED", "ACCEPTED", "PREPARING", "READY", "ASSIGNED", "PICKED_UP"] as const;
    for (const [i, stage] of stages.entries()) {
      await ensureWallet();
      const start = await walletOf();
      const stockBefore = await stockOf(listing);
      const placed = await checkoutLines([{ listing }]);
      try {
        const driven = await driveTo(placed.id, stage);
        const by = i % 2 === 0 ? "shop" : "ops";
        expectStatus(await setStatus(placed.id, "CANCELLED", by, `QA cancel at ${stage}`), 200, `${by} cancels at ${stage}`);
        expect(["CANCELLED", "REFUNDED"]).toContain(await statusOf(placed.id));
        expect(await walletOf(), `full refund at ${stage}`).toBe(start);
        if (stockBefore !== null) expect(await stockOf(listing), `stock back at ${stage}`).toBe(stockBefore);
        if (driven.deliveryOrderId) {
          const earnings = await call(await as("rider"), "GET", "/api/delivery-partner/earnings");
          const paid = (earnings.body.statement as { deliveryOrderId: string }[]).some((e) => e.deliveryOrderId === driven.deliveryOrderId);
          expect(paid, `rider paid at ${stage}`).toBe(stage === "PICKED_UP");
          notes.push(`${stage}/${by}: refunded, rider ${paid ? "paid" : "not paid"}`);
        } else notes.push(`${stage}/${by}: refunded`);
      } finally {
        await abandon(placed.id);
      }
    }
  } finally {
    await restore();
  }
  return notes.join("; ");
}, { ...signed, timeout: 420_000, partial: "cancelled through the status API (the shop's screen offers Reject at CONFIRMED and Cancel & refund at RETURNED only)" });

qa("TC-ORD-011", "cancelling after a line was removed and another substituted refunds only what is still held; the removed line is not restocked, the substitute is", async () => {
  await ensureWallet();
  const [packaged, bread, milk] = [await listingOf("packaged"), await listingOf("sharedA"), await listingOf("milk")];
  const start = await walletOf();
  const before = { packaged: await stockOf(packaged), bread: await stockOf(bread), milk: await stockOf(milk) };
  const placed = await checkoutLines([{ listing: packaged }, { listing: bread }]);
  try {
    const row = await orderRow(placed.id);
    const removeLine = row.items.find((i) => i.shopProductId === packaged.shopProductId)!;
    const subLine = row.items.find((i) => i.shopProductId === bread.shopProductId)!;
    expectStatus(await fulfil(placed.id, "accept"), 200, "accept");
    expectStatus(await shopAct(placed.id, "remove", { itemId: removeLine.id, reason: "Out of stock" }), 200, "remove a line");
    expectStatus(await shopAct(placed.id, "substitute", { itemId: subLine.id, substituteShopProductId: milk.shopProductId }), 200, "offer a substitute");
    expectStatus(await call(await as("customer"), "PATCH", `/api/orders/${placed.id}/items/${subLine.id}/substitution`, { approve: true }), 200, "customer approves");
    const held = (await orderRow(placed.id)).totalPaise;
    expect(await walletOf(), "removed line refunded at once").toBe(start - placed.totalPaise + removeLine.lineTotalPaise);
    expectStatus(await setStatus(placed.id, "CANCELLED", "shop", "QA cancel after partial refund"), 200, "shop cancels");
    expect(await walletOf(), "the rest refunded once — back to the start, no double refund").toBe(start);
    if (before.packaged !== null) expect(await stockOf(packaged), "removed line not restocked").toBe(before.packaged - 1);
    // The replaced product goes back on sale when the substitute is taken instead (TC-SPI-010).
    if (before.bread !== null) expect(await stockOf(bread), "the replaced line is back in stock").toBe(before.bread);
    if (before.milk !== null) expect(await stockOf(milk), "the substitute is restocked").toBe(before.milk);
    return `${placed.orderNumber}: line refund ₹${removeLine.lineTotalPaise / 100}, cancel refund ₹${held / 100} (still held), wallet back to ${start}; stock butter −1 (removed, not restocked), bread back (replaced), milk (substitute) restored`;
  } finally {
    await abandon(placed.id);
  }
}, signed);

qa("TC-ORD-012", "stock returns to the pre-order figure after a cancel, on /shop/inventory too, with an inventory movement", async ({ browser }) => {
  const listing = await listingOf("packaged");
  const before = await stockOf(listing);
  if (before === null) blocked("the listing does not track stock");
  const placed = await placeSimple({ quantity: 2 });
  expect(await stockOf(listing), "two units taken at checkout").toBe(before - 2);
  expectStatus(await setStatus(placed.id, "CANCELLED", "shop", "QA restock"), 200, "shop cancels");
  expect(await stockOf(listing), "stock restored").toBe(before);
  const { context, page } = await pageAs(browser, "shop");
  let shown = "";
  try {
    await page.goto("/shop/inventory");
    const row = page.getByTestId("inventory-table").getByRole("row").filter({ hasText: listing.name }).first();
    await expect(row).toBeVisible();
    shown = (await row.getByRole("cell").nth(2).innerText()).trim();
    expect(Number(shown.replace(/[^\d.]/g, "")), "Available on /shop/inventory").toBe(before);
  } finally {
    await context.close();
  }
  let movement = "movement not checked (no database on this site)";
  if (IS_LOCAL) {
    const rows = await db()<{ delta_units: number; new_units: number }[]>`
      select delta_units, new_units from inventory_movements where shop_product_id = ${listing.shopProductId} and reason = ${`Order ${placed.orderNumber} cancelled`}`;
    expect(rows.map((r) => r.delta_units), "one +2 movement for the cancel").toEqual([2]);
    movement = `movement +2 → ${rows[0].new_units}`;
  }
  return `${listing.name}: ${before} → ${before - 2} → ${before}; /shop/inventory shows ${shown}; ${movement}`;
}, { ...signed, partial: "the inventory movement row is read on the local run only" });

qa("TC-ORD-013", "two quick cancels of the same order refund it once", async () => {
  await ensureWallet();
  const start = await walletOf();
  const placed = await placeSimple();
  const ctx = await as("customer");
  const [a, b] = await Promise.all([
    call(ctx, "PATCH", `/api/orders/${placed.id}/status`, { status: "CANCELLED", note: "QA double 1" }),
    call(ctx, "PATCH", `/api/orders/${placed.id}/status`, { status: "CANCELLED", note: "QA double 2" }),
  ]);
  const codes = [a.status, b.status].sort();
  expect(codes.filter((c) => c === 200).length, `one cancel wins: ${codes}`).toBeGreaterThanOrEqual(1);
  expect(codes.every((c) => c === 200 || c === 409), `the other is refused cleanly: ${codes}`).toBe(true);
  expect(await walletOf(), "refunded exactly once").toBe(start);
  return `two parallel cancels → ${codes.join(" + ")}; wallet back to ${start} (one refund)`;
}, signed);
