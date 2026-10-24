/**
 * Shop fulfilment and substitution (package 5): the shop is told of a new
 * order, accepts or rejects it, picks lines, offers substitutes the customer
 * approves or refuses, removes lines, marks the order ready and hands the
 * rider the pickup code; plus the field rules of the reject reason, the
 * remove reason and the substitute picker.
 *
 * Signed-in tier: shop A's owner and the customer on their own orders.
 */
import { as, pageAs } from "../lib/actors";
import { onlyRiderOnline } from "../lib/flows";
import { call, expectStatus } from "../lib/http";
import { messagesTo } from "../lib/mail";
import {
  abandon,
  checkoutLines,
  customerCard,
  buyerCode,
  driveTo,
  ensureWallet,
  fulfil,
  listingOf,
  notesFor,
  offerFor,
  orderRow,
  pickupCode,
  placeSimple,
  releaseRiders,
  riderAction,
  shopAct,
  shopCard,
  statusOf,
  stockOf,
  TEXT,
  walletOf,
  withShopSettings,
} from "../lib/orders-helpers";
import { expect, need, qa } from "../lib/record";
import { IS_LOCAL } from "../lib/target";
import { world } from "../lib/world";

const signed = { tier: "signed" as const, timeout: 240_000 };

async function ready() {
  await releaseRiders();
  await onlyRiderOnline("rider");
  await ensureWallet();
}

const subOption = (l: { name: string }) => new RegExp(l.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

qa("TC-FUL-001", "a new order appears under New on /shop/orders and the shop gets an in-app notice (and an e-mail)", async ({ browser }) => {
  await ensureWallet();
  const since = Date.now();
  const placed = await placeSimple();
  const { context, page } = await pageAs(browser, "shop");
  try {
    const card = await shopCard(page, placed.orderNumber, "new");
    await expect(card.getByRole("button", { name: "Accept order" })).toBeVisible();
    await page.goto("/shop");
    await expect(page.locator("body")).not.toContainText(/Something went wrong|Application error/i);
  } finally {
    await context.close();
  }
  const notes = await notesFor("shop", placed.orderNumber);
  expect(notes.map((n) => n.title), "in-app 'New order'").toContain("New order");
  let mail = "e-mail not checked (no mail catcher on this site)";
  if (IS_LOCAL) {
    const shopEmail = need(world().users.shop, "shop owner").email;
    const found = await (async () => {
      for (let i = 0; i < 20; i++) {
        const m = messagesTo(shopEmail, since - 1000).find((x) => x.body.includes(placed.orderNumber));
        if (m) return m;
        await new Promise((r) => setTimeout(r, 500));
      }
      return null;
    })();
    expect(found, "a 'New order' e-mail to the shop owner").toBeTruthy();
    mail = `e-mail ${found!.file.split("/").pop()}`;
  }
  await abandon(placed.id);
  return `${placed.orderNumber} under New with Accept; notice "${notes[0]?.body}"; ${mail}`;
}, { ...signed, mobile: true, partial: "the e-mail is read from the local mail catcher only" });

qa("TC-FUL-002", "the shop clicks Accept order: ACCEPTED, and the customer is told", async ({ browser }) => {
  await ensureWallet();
  const placed = await placeSimple();
  const { context, page } = await pageAs(browser, "shop");
  try {
    const card = await shopCard(page, placed.orderNumber, "new");
    await card.getByRole("button", { name: "Accept order" }).click();
    await expect.poll(() => statusOf(placed.id), { timeout: 15_000 }).toBe("ACCEPTED");
  } finally {
    await context.close();
  }
  const notes = await notesFor("customer", placed.orderNumber);
  expect(notes.map((n) => `${n.title} ${n.body}`).join(" | "), "customer notified of the acceptance").toMatch(/accept/i);
  await abandon(placed.id);
  return `${placed.orderNumber} ACCEPTED from the shop screen; customer notice "${notes[0]?.title}"`;
}, { ...signed, mobile: true });

qa("TC-FUL-003", "the shop rejects with the reason 'Closed today': cancelled, full refund, stock back, the customer sees the reason", async ({ browser }) => {
  await ensureWallet();
  const listing = await listingOf("packaged");
  const start = await walletOf();
  const stock = await stockOf(listing);
  const placed = await checkoutLines([{ listing }]);
  const { context, page } = await pageAs(browser, "shop");
  try {
    const card = await shopCard(page, placed.orderNumber, "new");
    await card.getByRole("button", { name: "Reject" }).click();
    await card.getByLabel("Reason for rejecting the order").fill("Closed today");
    await card.getByRole("button", { name: /Reject & refund/ }).click();
    await expect.poll(() => statusOf(placed.id), { timeout: 15_000 }).toMatch(/CANCELLED|REFUNDED/);
  } finally {
    await context.close();
  }
  expect(await walletOf(), "full refund").toBe(start);
  if (stock !== null) expect(await stockOf(listing), "stock restored").toBe(stock);
  const notes = await notesFor("customer", placed.orderNumber);
  expect(notes.map((n) => n.body).join(" | "), "the customer is told the reason").toContain("Closed today");
  return `${placed.orderNumber} rejected → ${await statusOf(placed.id)}; wallet back to ${start}; notice "${notes.find((n) => n.body.includes("Closed today"))?.body}"`;
}, { ...signed, mobile: true });

qa("TC-FUL-004", "rejecting without a reason is refused: the button stays disabled and the API answers 422 with the field", async ({ browser }) => {
  await ensureWallet();
  const placed = await placeSimple();
  const notes: string[] = [];
  try {
    const { context, page } = await pageAs(browser, "shop");
    try {
      const card = await shopCard(page, placed.orderNumber, "new");
      await card.getByRole("button", { name: "Reject" }).click();
      await expect(card.getByRole("button", { name: /Reject & refund/ }), "disabled with no reason").toBeDisabled();
      await card.getByLabel("Reason for rejecting the order").fill("   ");
      await expect(card.getByRole("button", { name: /Reject & refund/ }), "disabled with spaces only").toBeDisabled();
    } finally {
      await context.close();
    }
    for (const reason of ["", "   "]) {
      const res = await fulfil(placed.id, "reject", { reason });
      expect(res.status, `reject with ${JSON.stringify(reason)}`).toBe(422);
      notes.push(`${JSON.stringify(reason)} → ${res.status} ${JSON.stringify(res.body?.error?.details?.fields ?? res.body?.error?.message)}`);
    }
    expect(JSON.stringify((await fulfil(placed.id, "reject", { reason: "" })).body), "the field is named").toMatch(/reason/);
    expect(await statusOf(placed.id)).toBe("CONFIRMED");
  } finally {
    await abandon(placed.id);
  }
  return notes.join("; ");
}, { ...signed, mobile: true });

qa(["TC-FUL-005", "TC-FUL-006"], "start picking and tick each of three lines (PREPARING, each 'picked'); Packed — mark ready: READY and a rider is offered", async ({ browser }) => {
  await ready();
  const lines = [await listingOf("packaged"), await listingOf("sharedA"), await listingOf("milk")];
  const placed = await checkoutLines(lines.map((listing) => ({ listing })));
  try {
    expectStatus(await fulfil(placed.id, "accept"), 200, "accept");
    const { context, page } = await pageAs(browser, "shop");
    try {
      let card = await shopCard(page, placed.orderNumber, "packing");
      await card.getByRole("button", { name: "Start picking" }).click();
      await expect.poll(() => statusOf(placed.id), { timeout: 15_000 }).toBe("PREPARING");
      for (let i = 0; i < lines.length; i++) {
        card = page.getByTestId("shop-order").filter({ hasText: placed.orderNumber }).first();
        await card.getByRole("button", { name: "Picked ✓" }).first().click();
        await expect(card.getByText("(picked)")).toHaveCount(i + 1, { timeout: 15_000 });
      }
      const row = await orderRow(placed.id);
      expect(row.items.map((i) => i.fulfilmentStatus), "every line PICKED").toEqual(["PICKED", "PICKED", "PICKED"]);
      await card.getByRole("button", { name: "Packed — mark ready" }).click();
      await expect.poll(() => statusOf(placed.id), { timeout: 15_000 }).toBe("READY");
    } finally {
      await context.close();
    }
    const offer = await offerFor(placed.id, "rider", 20_000);
    return `${placed.orderNumber}: 3 lines picked one by one → READY; offer ${offer.status} to the rider without pressing anything`;
  } finally {
    await abandon(placed.id);
  }
}, { ...signed, mobile: true, partial: "READY without explicit picks is the lifecycle run (order-lifecycle.spec.ts TC-FUL-006)" });

qa(["TC-FUL-007", "TC-FUL-008"], "the shop offers a cheaper substitute; the customer sees approve/reject, READY waits; approving refunds the difference at once", async ({ browser }) => {
  await ensureWallet();
  const [packaged, bread] = [await listingOf("packaged"), await listingOf("sharedA")];
  const start = await walletOf();
  const breadStock = await stockOf(bread);
  const placed = await checkoutLines([{ listing: packaged }]);
  const notes: string[] = [];
  try {
    expectStatus(await fulfil(placed.id, "accept"), 200, "accept");
    expectStatus(await fulfil(placed.id, "start"), 200, "start");
    const shop = await pageAs(browser, "shop");
    try {
      const card = await shopCard(shop.page, placed.orderNumber, "packing");
      await card.getByRole("button", { name: "Offer substitute" }).click();
      const option = card.getByLabel("Substitute product").locator("option").filter({ hasText: subOption(bread) }).first();
      await card.getByLabel("Substitute product").selectOption({ value: (await option.getAttribute("value"))! });
      await card.getByRole("button", { name: "Send to customer" }).click();
      const fresh = shop.page.getByTestId("shop-order").filter({ hasText: placed.orderNumber }).first();
      await expect(fresh.getByText("(waiting for customer)")).toBeVisible({ timeout: 15_000 });
      await expect(fresh.getByRole("button", { name: "Packed — mark ready" }), "ready disabled while the customer decides").toBeDisabled();
    } finally {
      await shop.context.close();
    }
    const blockedReady = await fulfil(placed.id, "ready");
    expect(blockedReady.status, "READY refused while pending").toBe(409);
    notes.push(`ready while pending → ${blockedReady.status}`);
    const told = await notesFor("customer", placed.orderNumber);
    expect(told.map((n) => n.title), "customer notified").toContain("Substitute proposed");

    const customer = await pageAs(browser, "customer");
    try {
      const card = await customerCard(customer.page, placed.orderNumber);
      await expect(card.getByText(/Shop suggests/)).toContainText(bread.name);
      await expect(card.getByRole("button", { name: "No thanks — refund it" })).toBeVisible();
      await card.getByRole("button", { name: "Accept substitute" }).click();
      await expect.poll(async () => (await orderRow(placed.id)).items[0].fulfilmentStatus, { timeout: 15_000 }).toBe("SUBSTITUTED");
      const diff = (packaged.pricePaise ?? 0) - (bread.pricePaise ?? 0);
      expect(await walletOf(), "difference refunded at once").toBe(start - placed.totalPaise + diff);
      const row = await orderRow(placed.id);
      expect(row.totalPaise, "order total lowered").toBe(placed.totalPaise - diff);
      if (breadStock !== null) expect(await stockOf(bread), "substitute stock consumed").toBe(breadStock - 1);
      await customer.page.reload();
      const after = customer.page.getByTestId("order-card").filter({ hasText: placed.orderNumber }).first();
      await expect(after.getByText(/refunded to your wallet/)).toContainText(new RegExp(`₹\\s?${diff / 100}(\\.00)?\\b`));
      notes.push(`approved: ₹${diff / 100} refunded, total ${placed.totalPaise} → ${row.totalPaise}, refund shown on the card`);
    } finally {
      await customer.context.close();
    }
  } finally {
    await abandon(placed.id);
  }
  return notes.join("; ");
}, { ...signed, mobile: true });

qa("TC-FUL-009", "a dearer substitute is charged at the original line price — no extra debit", async () => {
  await ensureWallet();
  const [bread, packaged] = [await listingOf("sharedA"), await listingOf("packaged")];
  const placed = await checkoutLines([{ listing: bread }]);
  try {
    const line = (await orderRow(placed.id)).items[0];
    expectStatus(await fulfil(placed.id, "accept"), 200, "accept");
    expectStatus(await shopAct(placed.id, "substitute", { itemId: line.id, substituteShopProductId: packaged.shopProductId }), 200, "offer a dearer substitute");
    const proposed = (await orderRow(placed.id)).items[0];
    expect(proposed.substituteLineTotalPaise, "substitute priced at the original line").toBe(line.lineTotalPaise);
    const before = await walletOf();
    expectStatus(await call(await as("customer"), "PATCH", `/api/orders/${placed.id}/items/${line.id}/substitution`, { approve: true }), 200, "approve");
    expect(await walletOf(), "no extra debit").toBe(before);
    expect((await orderRow(placed.id)).totalPaise, "total unchanged").toBe(placed.totalPaise);
    return `${bread.name} ₹${(bread.pricePaise ?? 0) / 100} → ${packaged.name} ₹${(packaged.pricePaise ?? 0) / 100}: charged ₹${(proposed.substituteLineTotalPaise ?? 0) / 100}, wallet unchanged`;
  } finally {
    await abandon(placed.id);
  }
}, signed);

qa(["TC-FUL-010", "TC-FUL-012"], "the customer refuses a substitute: the line is removed and refunded, the order goes on; another customer cannot decide it", async ({ browser }) => {
  await ensureWallet();
  const [packaged, bread, milk] = [await listingOf("packaged"), await listingOf("sharedA"), await listingOf("milk")];
  const start = await walletOf();
  const placed = await checkoutLines([{ listing: packaged }, { listing: bread }]);
  try {
    const row = await orderRow(placed.id);
    const line = row.items.find((i) => i.shopProductId === bread.shopProductId)!;
    expectStatus(await fulfil(placed.id, "accept"), 200, "accept");
    expectStatus(await shopAct(placed.id, "substitute", { itemId: line.id, substituteShopProductId: milk.shopProductId }), 200, "offer a substitute");
    const other = await call(await as("customer2"), "PATCH", `/api/orders/${placed.id}/items/${line.id}/substitution`, { approve: true });
    expect([403, 404], `customer 2 deciding: ${other.status}`).toContain(other.status);
    const { context, page } = await pageAs(browser, "customer");
    try {
      const card = await customerCard(page, placed.orderNumber);
      await card.getByRole("button", { name: "No thanks — refund it" }).click();
      await expect.poll(async () => (await orderRow(placed.id)).items.find((i) => i.id === line.id)?.fulfilmentStatus, { timeout: 15_000 }).toBe("REMOVED");
    } finally {
      await context.close();
    }
    expect(await walletOf(), "the line refunded").toBe(start - placed.totalPaise + line.lineTotalPaise);
    expect(await statusOf(placed.id), "order carries on with the other line").toBe("PREPARING");
    return `customer 2 → ${other.status}; refused substitute: ${bread.name} removed, ₹${line.lineTotalPaise / 100} refunded, order PREPARING`;
  } finally {
    await abandon(placed.id);
  }
}, { ...signed, mobile: true });

qa(["TC-FUL-011", "TC-FLD-084"], "substitute picker: nothing chosen, another shop's product, an offline-only/unpriced line, too little stock and an unknown id are refused; a listed product saves and shows after reload", async ({ browser }) => {
  await ensureWallet();
  const packaged = await listingOf("packaged");
  const shopB = world().listings.sharedB ? await listingOf("sharedB") : null;
  const unpriced = world().listings.unpricedLoose ? await listingOf("unpricedLoose") : null;
  const lowStock = world().listings.lowStock ? await listingOf("lowStock") : null;
  const bread = await listingOf("sharedA");
  const placed = await checkoutLines([{ listing: packaged, quantity: 3 }]);
  const seen: string[] = [];
  try {
    const line = (await orderRow(placed.id)).items[0];
    expectStatus(await fulfil(placed.id, "accept"), 200, "accept");
    const tries: [string, Record<string, unknown>][] = [
      ["nothing chosen", { itemId: line.id }],
      ["unknown id", { itemId: line.id, substituteShopProductId: "00000000-0000-4000-8000-000000000000" }],
      ...(shopB ? ([["another shop's product", { itemId: line.id, substituteShopProductId: shopB.shopProductId }]] as [string, Record<string, unknown>][]) : []),
      ...(unpriced ? ([["offline-only, unpriced line", { itemId: line.id, substituteShopProductId: unpriced.shopProductId }]] as [string, Record<string, unknown>][]) : []),
      ...(lowStock ? ([["too little stock (2 for a line of 3)", { itemId: line.id, substituteShopProductId: lowStock.shopProductId }]] as [string, Record<string, unknown>][]) : []),
    ];
    for (const [what, body] of tries) {
      const res = await shopAct(placed.id, "substitute", body);
      expect(res.status, `${what}: ${res.status} ${res.body?.error?.message}`).toBeGreaterThanOrEqual(400);
      expect(res.status, `${what}: no server error`).toBeLessThan(500);
      seen.push(`${what} → ${res.status}`);
    }
    expect((await orderRow(placed.id)).items[0].fulfilmentStatus, "line untouched by refused tries").toMatch(/PENDING|PICKED/);
    const { context, page } = await pageAs(browser, "shop");
    try {
      const card = await shopCard(page, placed.orderNumber, "packing");
      await card.getByRole("button", { name: "Offer substitute" }).click();
      await expect(card.getByRole("button", { name: "Send to customer" }), "disabled until a product is chosen").toBeDisabled();
      const option = card.getByLabel("Substitute product").locator("option").filter({ hasText: subOption(bread) }).first();
      await card.getByLabel("Substitute product").selectOption({ value: (await option.getAttribute("value"))! });
      await card.getByRole("button", { name: "Send to customer" }).click();
      await expect.poll(async () => (await orderRow(placed.id)).items[0].fulfilmentStatus, { timeout: 15_000 }).toBe("SUBSTITUTION_PROPOSED");
      await page.reload();
      const again = page.getByTestId("shop-order").filter({ hasText: placed.orderNumber }).first();
      await expect(again.getByText(/Substitute:/)).toContainText(bread.name);
      seen.push(`listed ${bread.name} saved and shown after reload`);
    } finally {
      await context.close();
    }
  } finally {
    await abandon(placed.id);
  }
  return seen.join("; ");
}, { ...signed, partial: "'a different unit count' has no separate rule: the substitute is taken in the same number of units (fulfilment.ts proposeSubstitution); an unknown id answers 404, not 422" });

qa("TC-FUL-013", "the shop removes a line ('Unavailable — remove & refund'): refunded at once, total lowered, customer told", async ({ browser }) => {
  await ensureWallet();
  const [packaged, bread] = [await listingOf("packaged"), await listingOf("sharedA")];
  const start = await walletOf();
  const placed = await checkoutLines([{ listing: packaged }, { listing: bread }]);
  try {
    expectStatus(await fulfil(placed.id, "accept"), 200, "accept");
    const { context, page } = await pageAs(browser, "shop");
    try {
      const card = await shopCard(page, placed.orderNumber, "packing");
      const item = card.getByRole("listitem").filter({ hasText: packaged.name }).first();
      await item.getByRole("button", { name: /Unavailable — remove/ }).click();
      await expect.poll(async () => (await orderRow(placed.id)).items.find((i) => i.shopProductId === packaged.shopProductId)?.fulfilmentStatus, { timeout: 15_000 }).toBe("REMOVED");
    } finally {
      await context.close();
    }
    const line = (await orderRow(placed.id)).items.find((i) => i.shopProductId === packaged.shopProductId)!;
    expect(line.fulfilmentNote, "reason recorded").toBe("Out of stock");
    expect(await walletOf(), "refunded at once").toBe(start - placed.totalPaise + line.lineTotalPaise);
    expect((await orderRow(placed.id)).totalPaise, "total lowered").toBe(placed.totalPaise - line.lineTotalPaise);
    const told = await notesFor("customer", placed.orderNumber);
    expect(told.map((n) => n.title), "customer notified").toContain("Item unavailable");
    return `${packaged.name} removed (Out of stock): ₹${line.lineTotalPaise / 100} back, total lowered, "Item unavailable" sent`;
  } finally {
    await abandon(placed.id);
  }
}, { ...signed, mobile: true });

qa("TC-FUL-014", "removing every line cancels the order and refunds the rest, delivery fee included", async () => {
  await ensureWallet();
  const restore = await withShopSettings({ deliveryFeePaise: 2500, freeDeliveryAbovePaise: null });
  try {
    const [packaged, bread] = [await listingOf("packaged"), await listingOf("sharedA")];
    const start = await walletOf();
    const placed = await checkoutLines([{ listing: packaged }, { listing: bread }]);
    try {
      const row = await orderRow(placed.id);
      expect(row.deliveryFeePaise).toBe(2500);
      expectStatus(await fulfil(placed.id, "accept"), 200, "accept");
      for (const item of row.items) expectStatus(await shopAct(placed.id, "remove", { itemId: item.id, reason: "Out of stock" }), 200, "remove a line");
      const end = await statusOf(placed.id);
      expect(["CANCELLED", "REFUNDED"], `status after the last line: ${end}`).toContain(end);
      expect(await walletOf(), "everything back incl. the delivery fee").toBe(start);
      return `${placed.orderNumber}: both lines removed → ${end}; wallet back to ${start} (₹25 fee included)`;
    } finally {
      await abandon(placed.id);
    }
  } finally {
    await restore();
  }
}, signed);

qa("TC-FUL-015", "the shop sees the pickup code once a rider accepts; the customer's delivery code never reaches the shop", async ({ browser }) => {
  await ready();
  const placed = await placeSimple();
  try {
    const driven = await driveTo(placed.id, "ASSIGNED");
    const slip = await pickupCode(placed.id);
    const { context, page } = await pageAs(browser, "shop");
    try {
      const card = await shopCard(page, placed.orderNumber, "ready");
      await expect(card.getByTestId("pickup-code")).toBeVisible();
      const shown = (await card.getByTestId("pickup-code").innerText()).match(/\d{4}/)?.[0];
      expect(shown, "the code on the order card").toBeTruthy();
      if (slip) expect(shown, "same as the packing slip").toBe(slip);
      expectStatus(await riderAction(driven.deliveryOrderId!, "pickup", { pickupCode: shown }), 200, "pickup with the shop's code");
      expectStatus(await riderAction(driven.deliveryOrderId!, "start"), 200, "start");
      const otp = await buyerCode(placed.id);
      const word = new RegExp(`\\b${otp}\\b`);
      const out = await shopCard(page, placed.orderNumber, "out");
      expect(await out.innerText(), "delivery code not on the shop's card").not.toMatch(word);
      const pageHtml = await page.content();
      expect(pageHtml, "no delivery code field in the shop page").not.toMatch(/deliveryOtp|delivery code from the customer/i);
      const searches = await call(await as("shop"), "GET", `/api/orders/${placed.id}/assign`);
      expect(searches.text, "shop's rider-search API").not.toMatch(word);
      expectStatus(await riderAction(driven.deliveryOrderId!, "deliver", { otp }), 200, "deliver with the customer's code");
      return `pickup code ${shown} on the shop card (= slip ${slip}); delivery code ${otp.replace(/\d/g, "•")} absent from the shop's card, page and API`;
    } finally {
      await context.close();
    }
  } finally {
    await abandon(placed.id);
  }
}, { ...signed, mobile: true });

qa("TC-FUL-017", "each order appears in exactly one of the shop's tabs (New, Packing, Ready, Out, Done)", async ({ browser }) => {
  await ready();
  const made: { id: string; orderNumber: string; tab: "new" | "packing" | "ready" | "out" | "done" }[] = [];
  try {
    const a = await placeSimple();
    made.push({ ...a, tab: "new" });
    const b = await placeSimple();
    await driveTo(b.id, "ACCEPTED");
    made.push({ ...b, tab: "packing" });
    const c = await placeSimple();
    await driveTo(c.id, "PREPARING");
    made.push({ ...c, tab: "packing" });
    const d = await placeSimple();
    await driveTo(d.id, "OUT_FOR_DELIVERY");
    made.push({ ...d, tab: "out" });
    const e = await placeSimple();
    await driveTo(e.id, "READY");
    made.push({ ...e, tab: "ready" });
    const f = await placeSimple();
    expectStatus(await fulfil(f.id, "reject", { reason: "QA tab check" }), 200, "reject");
    made.push({ ...f, tab: "done" });
    const { context, page } = await pageAs(browser, "shop");
    const seen: string[] = [];
    try {
      for (const tab of ["new", "packing", "ready", "out", "done"] as const) {
        await page.goto(`/shop/orders?status=${tab}`);
        await expect(page.getByRole("main")).toBeVisible();
        for (const o of made) {
          const count = await page.getByTestId("shop-order").filter({ hasText: o.orderNumber }).count();
          expect(count, `${o.orderNumber} (${o.tab}) on the ${tab} tab`).toBe(o.tab === tab ? 1 : 0);
        }
        seen.push(`${tab}: ${made.filter((o) => o.tab === tab).length}`);
      }
    } finally {
      await context.close();
    }
    return `six orders, each in one tab only — ${seen.join(", ")}`;
  } finally {
    for (const o of made) await abandon(o.id);
  }
}, { ...signed, timeout: 360_000, partial: "absence is checked on each tab's first page (the newest five) — these orders are the newest of their status" });

qa(["TC-FLD-082", "TC-FUL-004"], "reject reason: blank, spaces, 1 character and 301 characters are refused (limit 300); script, Marathi and padded text are kept as written and trimmed", async ({ browser }) => {
  await ensureWallet();
  const seen: string[] = [];
  const probe = await placeSimple();
  try {
    for (const [what, reason] of [["blank", ""], ["spaces", "    "], ["1 character", "x"], ["301 characters", TEXT.long(301)]] as const) {
      const res = await fulfil(probe.id, "reject", { reason });
      expect(res.status, `${what}: ${res.status}`).toBe(422);
      seen.push(`${what} → 422`);
    }
    expect(await statusOf(probe.id)).toBe("CONFIRMED");
    const ok300 = await fulfil(probe.id, "reject", { reason: TEXT.long(300) });
    expect(ok300.status, "300 characters (the limit) accepted").toBe(200);
    seen.push("300 characters → 200");
  } finally {
    await abandon(probe.id);
  }
  const kept: string[] = [];
  for (const [what, reason, expected] of [
    ["script", TEXT.script, TEXT.script],
    ["Marathi", TEXT.marathi, TEXT.marathi],
    ["padded", "   Closed for Diwali   ", "Closed for Diwali"],
  ] as const) {
    const placed = await placeSimple();
    const res = await fulfil(placed.id, "reject", { reason });
    expectStatus(res, 200, `reject with ${what}`);
    const row = await orderRow(placed.id);
    expect(row.cancellationReason, `${what} stored`).toBe(`Rejected by shop: ${expected}`);
    const told = await notesFor("customer", placed.orderNumber);
    expect(told.map((n) => n.body).join(" | "), `${what} as the customer reads it`).toContain(expected);
    kept.push(what);
  }
  const { context, page } = await pageAs(browser, "customer");
  let dialogs = 0;
  page.on("dialog", async (d) => {
    dialogs += 1;
    await d.dismiss();
  });
  try {
    await page.goto("/notifications");
    await expect(page.getByText(TEXT.script, { exact: false }).first(), "script shown as plain text").toBeVisible();
    await expect(page.getByText(TEXT.marathi).first(), "Marathi shown correctly").toBeVisible();
    expect(dialogs, "no script ran").toBe(0);
  } finally {
    await context.close();
  }
  return `${seen.join(", ")}; kept as written: ${kept.join(", ")} (trimmed), shown as text on /notifications`;
}, { ...signed, timeout: 300_000 });

qa("TC-FLD-083", "remove-line reason: a value outside the list is refused (422); no reason keeps the default 'Unavailable'; the chosen reason is kept", async () => {
  await ensureWallet();
  const [packaged, bread, milk] = [await listingOf("packaged"), await listingOf("sharedA"), await listingOf("milk")];
  const placed = await checkoutLines([{ listing: packaged }, { listing: bread }, { listing: milk }]);
  const seen: string[] = [];
  try {
    const items = (await orderRow(placed.id)).items;
    expectStatus(await fulfil(placed.id, "accept"), 200, "accept");
    const none = await shopAct(placed.id, "remove", { itemId: items[0].id });
    seen.push(`no reason → ${none.status} (saved "${(await orderRow(placed.id)).items.find((i) => i.id === items[0].id)?.fulfilmentNote}")`);
    const odd = await shopAct(placed.id, "remove", { itemId: items[1].id, reason: "Banana" });
    seen.push(`unlisted "Banana" → ${odd.status}`);
    const listed = await shopAct(placed.id, "remove", { itemId: items[2].id, reason: "Out of stock" });
    expectStatus(listed, 200, "the screen's reason");
    expect((await orderRow(placed.id)).items.find((i) => i.id === items[2].id)?.fulfilmentNote).toBe("Out of stock");
    seen.push("'Out of stock' (the only reason the screen sends) → 200, kept");
    // No reason saves the long-standing default "Unavailable" (src/lib/order-line-removal.ts); anything else must be on the list.
    expect([none.status, odd.status], `answers — ${seen.join("; ")}`).toEqual([200, 422]);
    expect((await orderRow(placed.id)).items.find((i) => i.id === items[0].id)?.fulfilmentNote, "the default reason").toBe("Unavailable");
  } finally {
    await abandon(placed.id);
  }
  return seen.join("; ");
}, signed);

