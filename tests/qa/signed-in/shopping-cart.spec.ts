/**
 * The cart and checkout as the customer uses them: the /cart page (groups,
 * live prices, quantities, delivery fees, empty state), stock and quantity
 * limits, a price or availability change while an item waits in the cart,
 * multi-shop checkout, the top-up prompt, double-clicking pay, missing
 * mobile / address, pickup orders, delivery windows and the checkout fields
 * (TC-FLD-023/024/026/027). The API halves of TC-CART-001/002/009/011/012/018
 * are signed-in/order-lifecycle.spec.ts.
 *
 * Signed-in tier. Orders placed here are cancelled again (full refund) and
 * every listing or shop setting changed is put back.
 */
import { as } from "../lib/actors";
import { call, expectStatus, poll, why } from "../lib/http";
import { blocked, expect, need, qa } from "../lib/record";
import { world } from "../lib/world";
import {
  add,
  cancelAsShop,
  cancelOwn,
  cartGroup,
  cartLine,
  cartOf,
  checkoutAs,
  clearCart,
  fillCart,
  homeAddressId,
  listing,
  open,
  orderOf,
  ordersOf,
  OWNER,
  payOnCartPage,
  rupees,
  shopId,
  shopName,
  signedPage,
  SIGNED,
  storefrontRow,
  walletOf,
  withListing,
  withShop,
} from "../lib/shopping-helpers";

/** Places a wallet order of the current cart to the default address. */
async function checkoutCart(role: "customer" = "customer", extra: Record<string, unknown> = {}) {
  const res = await checkoutAs(role, { addressId: await homeAddressId(role), paymentMethod: "WALLET", ...extra });
  return res;
}

/* --------------------------------------------------------------- the page */

qa(["TC-CART-001", "TC-CART-005"], "/cart groups lines by shop with live prices, quantities, each shop's delivery fee and subtotal; the grand total is their sum", async ({ browser }) => {
  const butter = listing("packaged");
  const bread = listing("sharedA");
  const breadB = listing("sharedB");
  need(world().users.shopB, "shop B's owner");
  return withShop("A", { deliveryFeePaise: 2000, freeDeliveryAbovePaise: null }, () =>
    withShop("B", { deliveryFeePaise: 1500, freeDeliveryAbovePaise: null }, async () => {
      const cart = await fillCart("customer", [
        { item: butter, quantity: 2 },
        { item: bread, quantity: 1 },
        { item: breadB, quantity: 3 },
      ]);
      const { context, page } = await signedPage(browser, "customer");
      try {
        await open(page, "/cart");
        const groupA = cartGroup(page, shopName("A"));
        const groupB = cartGroup(page, shopName("B"));
        await expect(groupA.locator("li")).toHaveCount(2);
        await expect(groupB.locator("li")).toHaveCount(1);
        await expect(cartLine(page, butter.name)).toContainText(`${rupees(butter.pricePaise!)} × 2`);
        await expect(cartLine(page, butter.name)).toContainText(rupees(2 * butter.pricePaise!));
        await expect(cartLine(page, bread.name).first()).toContainText(`${rupees(bread.pricePaise!)} × 1`);
        const subA = 2 * butter.pricePaise! + bread.pricePaise!;
        const subB = 3 * breadB.pricePaise!;
        await expect(groupA).toContainText(`Subtotal${rupees(subA)}`);
        await expect(groupA).toContainText(`Delivery${rupees(2000)}`);
        await expect(groupB).toContainText(`Subtotal${rupees(subB)}`);
        await expect(groupB).toContainText(`Delivery${rupees(1500)}`);
        const grand = subA + 2000 + subB + 1500;
        await expect(page.getByText("Grand total").locator("..")).toContainText(rupees(grand));
        expect(cart.grandTotalPaise).toBe(grand);
        expect(cart.groups.map((g) => g.totalPaise).reduce((a, b) => a + b, 0)).toBe(grand);
        return `A: 2 × ${butter.name} + 1 × bread, subtotal ${rupees(subA)}, delivery ₹20; B: 3 × bread ${rupees(subB)}, delivery ₹15; grand ${rupees(grand)}`;
      } finally {
        await context.close();
        await clearCart("customer");
      }
    }),
  );
}, { ...SIGNED, mobile: true });

qa("TC-CART-002", "/cart: + and − recompute the totals, − on the last unit removes the line, an empty cart shows the empty state", async ({ browser }) => {
  const butter = listing("packaged");
  const bread = listing("sharedA");
  await fillCart("customer", [{ item: butter, quantity: 1 }, { item: bread, quantity: 1 }]);
  const { context, page } = await signedPage(browser, "customer");
  try {
    await open(page, "/cart");
    const total = page.getByText("Grand total").locator("..");
    await expect(total).toContainText(rupees(butter.pricePaise! + bread.pricePaise!));
    await page.getByRole("button", { name: `Increase ${butter.name}` }).click();
    await expect(total).toContainText(rupees(2 * butter.pricePaise! + bread.pricePaise!));
    await page.getByRole("button", { name: `Decrease ${butter.name}` }).click();
    await expect(total).toContainText(rupees(butter.pricePaise! + bread.pricePaise!));
    await page.getByRole("button", { name: `Decrease ${bread.name}` }).click();
    await expect(cartLine(page, bread.name)).toHaveCount(0);
    await expect(total).toContainText(rupees(butter.pricePaise!));
    await page.getByRole("button", { name: `Decrease ${butter.name}` }).click();
    await expect(page.getByTestId("cart-empty")).toBeVisible();
    await expect(page.getByTestId("cart-empty")).toContainText("Your cart is empty");
    expect((await cartOf()).groups).toEqual([]);
    return "1+1 → +1 → −1 → bread removed → butter removed → 'Your cart is empty' with Start shopping";
  } finally {
    await context.close();
    await clearCart("customer");
  }
}, { ...SIGNED, mobile: true, partial: "there is no 'clear cart' button on /cart; DELETE /api/cart is checked in order-lifecycle.spec.ts" });

/* ------------------------------------------------------- quantities and stock */

qa(["TC-CART-003", "TC-FLD-023"], "stock limit: the total resulting quantity is checked (OUT_OF_STOCK); quantity 5 of 5 accepted, 6 refused; 0 removes the line", async ({ browser }) => {
  const item = listing("lowStock");
  return withListing(OWNER.A, "A", item, { onlineStock: 5 }, { onlineStock: item.stock ?? 2 }, async () => {
    await clearCart("customer");
    expectStatus(await add("customer", item.shopProductId, 3), 200, "add 3");
    const over = await add("customer", item.shopProductId, 3);
    expect(over.status, why(over)).toBe(409);
    expect(over.body?.error?.code).toBe("OUT_OF_STOCK");
    const ninetyNine = await add("customer", item.shopProductId, 99);
    expect(ninetyNine.body?.error?.code, "99 at once").toBe("OUT_OF_STOCK");
    const line = (await cartOf()).groups.flatMap((g) => g.lines).find((l) => l.shopProductId === item.shopProductId)!;
    expect(line.quantity, "refusals leave the line at 3").toBe(3);
    const set = async (quantity: unknown) => call(await as("customer"), "PATCH", `/api/cart/items/${line.cartItemId}`, { quantity });
    expectStatus(await set(5), 200, "quantity 5 (= stock)");
    const six = await set(6);
    expect(six.status, why(six)).toBe(409);
    expect(six.body?.error?.code).toBe("OUT_OF_STOCK");
    const refused: string[] = [];
    for (const q of [null, -1, 1.5, "two", 99999999]) {
      const res = await set(q);
      expect(res.status, `quantity ${JSON.stringify(q)}`).toBe(422);
      refused.push(`${JSON.stringify(q)}→422`);
    }
    // The page shows the saved quantity after a reload, and the server refuses a 6th.
    const { context, page } = await signedPage(browser, "customer");
    try {
      await open(page, "/cart");
      await expect(cartLine(page, item.name)).toContainText("× 5");
      await page.getByRole("button", { name: `Increase ${item.name}` }).click();
      await expect(page.getByRole("alert").or(page.locator("text=/Only 5 left|unavailable online|stock/i")).first()).toBeVisible();
      await page.reload();
      await expect(cartLine(page, item.name)).toContainText("× 5");
    } finally {
      await context.close();
    }
    expectStatus(await set(0), 200, "quantity 0");
    expect((await cartOf()).groups.flatMap((g) => g.lines).some((l) => l.shopProductId === item.shopProductId), "0 removes the line").toBe(false);
    return `stock 5: 3 + 3 → OUT_OF_STOCK, 99 → OUT_OF_STOCK, set 5 ok, 6 → OUT_OF_STOCK; ${refused.join(", ")}; the page shows 5 after reload and refuses a 6th; 0 removes`;
  });
}, { ...SIGNED, partial: "the cart has −/+ buttons, not a typed quantity field, so blank/text/decimal are API-only here" });

qa("TC-CART-004", "invalid quantities and products on POST /api/cart are refused (422 / 404) and the cart is unchanged", async () => {
  const item = listing("packaged");
  await fillCart("customer", [{ item, quantity: 1 }]);
  const before = JSON.stringify((await cartOf()).groups.map((g) => g.lines.map((l) => [l.shopProductId, l.quantity])));
  const seen: string[] = [];
  for (const [body, statuses] of [
    [{ shopProductId: item.shopProductId, quantity: 0 }, [422]],
    [{ shopProductId: item.shopProductId, quantity: -1 }, [422]],
    [{ shopProductId: item.shopProductId, quantity: 1.5 }, [422]],
    [{ shopProductId: item.shopProductId, quantity: "2" }, [422]],
    [{ shopProductId: item.shopProductId, quantity: 100 }, [422]],
    [{ shopProductId: "00000000-0000-4000-8000-000000000000", quantity: 1 }, [404]],
    [{ shopProductId: "not-a-product", quantity: 1 }, [422]],
  ] as [Record<string, unknown>, number[]][]) {
    const res = await call(await as("customer"), "POST", "/api/cart", body);
    expect(statuses, `${JSON.stringify(body)}: ${why(res)}`).toContain(res.status);
    seen.push(`${JSON.stringify(body.quantity)}${String(body.shopProductId).startsWith("0000") ? " (unknown product)" : body.shopProductId === "not-a-product" ? " (bad id)" : ""}→${res.status}`);
  }
  const after = JSON.stringify((await cartOf()).groups.map((g) => g.lines.map((l) => [l.shopProductId, l.quantity])));
  expect(after, "cart unchanged").toBe(before);
  await clearCart("customer");
  return seen.join(", ");
}, SIGNED);

qa("TC-FLD-024", "loose goods by weight: only whole steps of the shop's pack size within stock are accepted; the line total is price × weight to the paisa; the order line is in milli-units", async () => {
  const paneer = listing("loose");
  await clearCart("customer");
  const refused: string[] = [];
  for (const q of [0, -1, 0.0005, 0.25, 1.5, "1kg"]) {
    const res = await add("customer", paneer.shopProductId, q as number);
    expect(res.status, `weight ${JSON.stringify(q)}: ${why(res)}`).toBe(422);
    refused.push(`${JSON.stringify(q)}`);
  }
  const over = await add("customer", paneer.shopProductId, (paneer.stock ?? 40) + 1);
  expect(over.status, "more than the stock").toBe(409);
  expectStatus(await add("customer", paneer.shopProductId, 2), 200, "2 × 1 kg");
  const line = (await cartOf()).groups.flatMap((g) => g.lines).find((l) => l.shopProductId === paneer.shopProductId)!;
  expect(line.lineTotalPaise, "price × weight").toBe(2 * paneer.pricePaise!);
  const res = await checkoutCart();
  expectStatus(res, 201, "checkout 2 kg paneer");
  const id = res.body.orders[0].id as string;
  try {
    const order = (await ordersOf()).find((o) => o.id === id)!;
    const item = order.items?.find((i) => i.productNameSnapshot === paneer.name);
    expect(item?.quantityMilli, "order line in milli-units").toBe(2000);
    expect(item?.lineTotalPaise).toBe(2 * paneer.pricePaise!);
    return `refused ${refused.join(", ")} (422) and ${(paneer.stock ?? 40) + 1} (stock); 2 × 1 kg → ${rupees(line.lineTotalPaise)}; order line 2000 milli, ${rupees(item!.lineTotalPaise)}`;
  } finally {
    await cancelOwn("customer", id);
  }
}, { ...SIGNED, partial: "the seeded loose product is sold in 1 kg steps (unitSizeMilli 1000), so 250 g / 1.5 kg are outside the step and refused; a 250 g-step product is not in the test data" });

/* ------------------------------------------------ changes while in the cart */

qa("TC-CART-006", "the cart shows the shop's new price, and checkout charges the server's price", async () => {
  const item = listing("packaged");
  const newPrice = item.pricePaise! - 300;
  await fillCart("customer", [{ item, quantity: 1 }]);
  return withListing(OWNER.A, "A", item, { onlinePricePaise: newPrice }, { onlinePricePaise: item.pricePaise }, async () => {
    const line = (await cartOf()).groups.flatMap((g) => g.lines).find((l) => l.shopProductId === item.shopProductId)!;
    expect(line.unitPricePaise, "cart shows the new price").toBe(newPrice);
    const start = await walletOf();
    const res = await checkoutCart();
    expectStatus(res, 201, "checkout");
    const order = res.body.orders[0];
    try {
      expect(order.totalPaise, "charged at the new price").toBe(newPrice);
      expect(await walletOf()).toBe(start - newPrice);
    } finally {
      await cancelOwn("customer", order.id);
    }
    return `${rupees(item.pricePaise!)} → ${rupees(newPrice)}: cart and order ${order.orderNumber} at ${rupees(order.totalPaise)}`;
  });
}, SIGNED);

qa("TC-CART-007", "a line that stops being sold online, runs out, or loses its price is flagged with a reason and pay is disabled until it is removed", async ({ browser }) => {
  const butter = listing("packaged");
  const paneer = listing("loose");
  const reasons: string[] = [];
  const check = async (patch: Record<string, unknown>, restore: Record<string, unknown>, item: typeof butter, reason: RegExp) =>
    withListing(OWNER.A, "A", item, patch, restore, async () => {
      const line = (await cartOf()).groups.flatMap((g) => g.lines).find((l) => l.shopProductId === item.shopProductId)!;
      expect(line.purchasable).toBe(false);
      expect(line.unavailableReason).toMatch(reason);
      const { context, page } = await signedPage(browser, "customer");
      try {
        await open(page, "/cart");
        await expect(cartLine(page, item.name)).toContainText(reason);
        await expect(page.getByRole("button", { name: /Pay from wallet/ })).toBeDisabled();
        await expect(cartGroup(page, shopName("A")).getByRole("button", { name: "Remove unavailable items" })).toBeVisible();
      } finally {
        await context.close();
      }
      reasons.push(`${JSON.stringify(patch)} → "${line.unavailableReason}"`);
    });
  await fillCart("customer", [{ item: butter, quantity: 1 }]);
  await check({ onlineSaleEnabled: false }, { onlineSaleEnabled: true }, butter, /physical shop/i);
  await check({ onlineStock: 0 }, { onlineStock: butter.stock ?? 50 }, butter, /Out of stock|unavailable online/i);
  await fillCart("customer", [{ item: paneer, quantity: 1 }]);
  // Clearing a loose product's price also takes it off online sale (the API refuses an online listing without a price).
  await check({ onlinePricePaise: null, onlineSaleEnabled: false }, { onlinePricePaise: paneer.pricePaise, onlineSaleEnabled: true }, paneer, /physical shop/i);
  // Removing the unavailable line clears the block.
  await withListing(OWNER.A, "A", paneer, { onlinePricePaise: null, onlineSaleEnabled: false }, { onlinePricePaise: paneer.pricePaise, onlineSaleEnabled: true }, async () => {
    const { context, page } = await signedPage(browser, "customer");
    try {
      await open(page, "/cart");
      await cartGroup(page, shopName("A")).getByRole("button", { name: "Remove unavailable items" }).click();
      await expect(page.getByTestId("cart-empty")).toBeVisible();
    } finally {
      await context.close();
    }
  });
  await clearCart("customer");
  return `${reasons.join("; ")}; pay disabled each time; 'Remove unavailable items' empties the cart`;
}, { ...SIGNED, mobile: true });

/* ---------------------------------------------------------------- checkout */

qa("TC-CART-008", "delivery windows: only windows the system can back are offered on the cart and by GET /api/checkout/delivery-windows", async ({ browser }) => {
  const res = await call(await as("customer"), "GET", `/api/checkout/delivery-windows?shopId=${shopId("A")}`);
  expectStatus(res, 200, "delivery windows");
  const offered = (["EXPRESS_30", "STANDARD_60", "SCHEDULED"] as const).filter((w) => res.body[w]);
  expect(Object.keys(res.body).sort()).toEqual(expect.arrayContaining(["EXPRESS_30", "SCHEDULED", "STANDARD_60"]));
  expect(res.body.SCHEDULED, "scheduled never needs a rider now").toBe(true);
  const bad = await call(await as("customer"), "GET", "/api/checkout/delivery-windows?shopId=nope");
  expect(bad.status).toBe(422);
  await fillCart("customer", [{ item: listing("packaged"), quantity: 1 }]);
  const { context, page } = await signedPage(browser, "customer");
  try {
    await open(page, "/cart");
    const group = cartGroup(page, shopName("A"));
    await expect(group.getByText("Delivery time")).toBeVisible();
    const labels = { EXPRESS_30: "Express (30 min)", STANDARD_60: "Standard (60 min)", SCHEDULED: "Scheduled" };
    for (const [key, label] of Object.entries(labels)) {
      await expect(group.getByRole("button", { name: label }), `${label} offered = ${res.body[key]}`).toHaveCount(res.body[key] ? 1 : 0);
    }
  } finally {
    await context.close();
    await clearCart("customer");
  }
  return `offered now: ${offered.join(", ")} (the cart shows exactly these); bad shop id → 422`;
}, { ...SIGNED, partial: "no estimated-minutes figure: the route deliberately returns only the windows (src/app/api/checkout/delivery-windows/route.ts — the estimate would place the nearest rider); 'no rider online' is recorded in local/shopping-rules.spec.ts" });

qa(["TC-CART-010", "TC-CART-024"], "wallet checkout of a two-shop cart: two independent orders, one debit each with its own delivery fee; the customer gets one number per shop", async () => {
  const butter = listing("packaged");
  const breadB = listing("sharedB");
  need(world().users.shopB, "shop B's owner");
  return withShop("A", { deliveryFeePaise: 2000, freeDeliveryAbovePaise: null }, () =>
    withShop("B", { deliveryFeePaise: 1500, freeDeliveryAbovePaise: null }, async () => {
      await fillCart("customer", [{ item: butter, quantity: 1 }, { item: breadB, quantity: 1 }]);
      const start = await walletOf();
      const res = await checkoutCart();
      expectStatus(res, 201, "two-shop checkout");
      const orders = res.body.orders as { id: string; orderNumber: string; shopId: string; totalPaise: number; status: string }[];
      try {
        expect(orders).toHaveLength(2);
        const a = orders.find((o) => o.shopId === shopId("A"))!;
        const b = orders.find((o) => o.shopId === shopId("B"))!;
        expect(a.totalPaise).toBe(butter.pricePaise! + 2000);
        expect(b.totalPaise).toBe(breadB.pricePaise! + 1500);
        expect(orders.every((o) => o.status === "CONFIRMED")).toBe(true);
        expect(a.orderNumber).not.toBe(b.orderNumber);
        expect(await walletOf(), "two debits, one per order").toBe(start - a.totalPaise - b.totalPaise);
        const tx = await call(await as("customer"), "GET", "/api/wallet");
        const debits = ((tx.body?.transactions ?? []) as { type: string; amountPaise: number; description: string | null }[]).filter((t) => t.type === "PRODUCT_PURCHASE");
        expect(Math.abs(debits.find((t) => t.description?.includes(a.orderNumber))?.amountPaise ?? 0), "one debit for shop A's order").toBe(a.totalPaise);
        expect(Math.abs(debits.find((t) => t.description?.includes(b.orderNumber))?.amountPaise ?? 0), "one debit for shop B's order").toBe(b.totalPaise);
        expect(res.body.parentReference, "no parent reference while rule parentOrders is off").toBeUndefined();
        return `${a.orderNumber} (${rupees(a.totalPaise)} incl. ₹20) + ${b.orderNumber} (${rupees(b.totalPaise)} incl. ₹15); wallet −${rupees(a.totalPaise + b.totalPaise)}; no parent reference (rule off)`;
      } finally {
        for (const o of orders) await cancelOwn("customer", o.id);
      }
    }),
  );
}, { ...SIGNED, partial: "TC-CART-024 (one master reference) needs rule parentOrders on: local/shopping-rules.spec.ts" });

qa("TC-CART-009", "paying from the cart page: one CONFIRMED order, wallet debited by exactly the total, stock reduced, on /orders, cart emptied, the shop notified", async ({ browser }) => {
  const item = listing("packaged");
  await fillCart("customer", [{ item, quantity: 2 }]);
  const start = await walletOf();
  const stock = (await storefrontRow("A", item.shopProductId))?.onlineStock;
  const before = new Set((await ordersOf()).map((o) => o.id));
  const { context, page } = await signedPage(browser, "customer");
  let orderId: string | null = null;
  try {
    await open(page, "/cart");
    await payOnCartPage(page);
    await page.waitForURL(/\/orders\?placed=1/, { timeout: 30_000 });
    const created = (await ordersOf()).filter((o) => !before.has(o.id));
    expect(created, "one new order").toHaveLength(1);
    const order = created[0];
    orderId = order.id;
    expect(order.status).toBe("CONFIRMED");
    expect(await walletOf(), "debited by exactly the total").toBe(start - order.totalPaise);
    expect(order.totalPaise).toBe(2 * item.pricePaise!);
    if (stock !== undefined) expect((await storefrontRow("A", item.shopProductId))?.onlineStock, "stock reduced by 2").toBe(stock - 2);
    await expect(page.getByTestId("order-card").filter({ hasText: order.orderNumber }).first()).toBeVisible();
    expect((await cartOf()).groups, "cart emptied").toEqual([]);
    const notes = (await call(await as("shop"), "GET", "/api/notifications")).body?.notifications as { title: string; body: string }[];
    expect(notes.some((n) => n.title === "New order" && n.body.includes(order.orderNumber)), "the shop is notified").toBe(true);
    return `${order.orderNumber} CONFIRMED from the cart page; wallet −${rupees(order.totalPaise)}; stock ${stock} → ${stock !== undefined ? stock - 2 : "?"}; on /orders; cart empty; shop got 'New order'`;
  } finally {
    await context.close();
    if (orderId) await cancelOwn("customer", orderId);
  }
}, { ...SIGNED, mobile: true });

qa("TC-CART-011", "the cart page shows the shortfall and a top-up link instead of pay when the wallet is too low", async ({ browser }) => {
  const item = listing("premium");
  const balance = await walletOf();
  const quantity = Math.floor(balance / item.pricePaise!) + 1;
  if (quantity > (item.stock ?? 30)) blocked(`a basket above the wallet needs ${quantity} units; stock is ${item.stock}`);
  await fillCart("customer", [{ item, quantity }]);
  const total = quantity * item.pricePaise!;
  const { context, page } = await signedPage(browser, "customer");
  try {
    await open(page, "/cart");
    const alert = page.getByRole("alert").filter({ hasText: "Insufficient wallet balance" }).or(page.getByText("Insufficient wallet balance")).first();
    await expect(alert).toBeVisible();
    await expect(page.getByText(`Add at least ${rupees(total - balance)} to place this order.`)).toBeVisible();
    await expect(page.getByRole("link", { name: "Add money to wallet" })).toHaveAttribute("href", "/wallet");
    await expect(page.getByRole("button", { name: /Pay from wallet/ })).toHaveCount(0);
  } finally {
    await context.close();
    await clearCart("customer");
  }
  return `${quantity} × ${rupees(item.pricePaise!)} = ${rupees(total)} > wallet ${rupees(balance)}: "Add at least ${rupees(total - balance)}" + Add money to wallet`;
}, { ...SIGNED, mobile: true });

qa("TC-CART-012", "double-clicking pay on the cart page places one order and debits the wallet once", async ({ browser }) => {
  const item = listing("packaged");
  await fillCart("customer", [{ item, quantity: 1 }]);
  const start = await walletOf();
  const before = new Set((await ordersOf()).map((o) => o.id));
  const { context, page } = await signedPage(browser, "customer");
  let created: string[] = [];
  try {
    await open(page, "/cart");
    const pay = page.getByRole("button", { name: /Pay from wallet/ });
    await pay.click();
    const ignore = page.getByRole("button", { name: "Ignore and continue" });
    if (await ignore.isVisible({ timeout: 3000 }).catch(() => false)) await ignore.dblclick();
    else if (await pay.isVisible().catch(() => false)) await pay.dblclick().catch(() => {});
    await page.waitForURL(/\/orders/, { timeout: 30_000 });
    created = (await ordersOf()).filter((o) => !before.has(o.id)).map((o) => o.id);
    expect(created, "exactly one new order").toHaveLength(1);
    expect(await walletOf(), "one debit").toBe(start - item.pricePaise!);
    return `one order, wallet −${rupees(item.pricePaise!)} after a double-click`;
  } finally {
    await context.close();
    for (const id of created) await cancelOwn("customer", id);
    await clearCart("customer");
  }
}, { ...SIGNED, mobile: true });

qa("TC-CART-018", "/orders card shows the order's items and its actions: cancel and report a problem", async ({ browser }) => {
  const item = listing("packaged");
  await fillCart("customer", [{ item, quantity: 2 }]);
  const res = await checkoutCart();
  expectStatus(res, 201, "checkout");
  const order = res.body.orders[0];
  const { context, page } = await signedPage(browser, "customer");
  try {
    await open(page, "/orders");
    const card = page.getByTestId("order-card").filter({ hasText: order.orderNumber }).first();
    await expect(card).toContainText(item.name);
    await expect(card.getByRole("button", { name: "Cancel order" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Report a problem" })).toBeVisible();
    await expect(card.getByTestId("order-details-link")).toBeVisible();
    return `${order.orderNumber}: items listed, Cancel order and Report a problem offered`;
  } finally {
    await context.close();
    await cancelOwn("customer", order.id);
  }
}, { ...SIGNED, mobile: true, partial: "number, shop, amount and 'confirmed' are checked in order-lifecycle.spec.ts" });

qa("TC-CART-015", "no mobile: the cart shows a prompt instead of pay and checkout is refused; no address: refused for a delivering shop", async ({ browser }) => {
  need(world().users.customer2, "customer 2 (no mobile)");
  const item = listing("packaged");
  await fillCart("customer2", [{ item, quantity: 1 }]);
  const { context, page } = await signedPage(browser, "customer2");
  try {
    await open(page, "/cart");
    const prompt = page.getByTestId("checkout-missing-details");
    await expect(prompt).toContainText("Add your mobile number before ordering");
    await expect(prompt.getByRole("link", { name: "Add mobile number" })).toHaveAttribute("href", "/profile");
    await expect(page.getByRole("button", { name: /Pay from wallet/ })).toHaveCount(0);
  } finally {
    await context.close();
  }
  const noMobile = await checkoutAs("customer2", { addressId: world().addresses?.customer2 ?? null, paymentMethod: "WALLET" });
  expect(noMobile.status, why(noMobile)).toBe(422);
  expect(noMobile.body?.error?.details?.missing).toBe("mobile");
  await clearCart("customer2");
  await fillCart("customer", [{ item, quantity: 1 }]);
  const noAddress = await checkoutAs("customer", { paymentMethod: "WALLET" });
  expect(noAddress.status, why(noAddress)).toBe(422);
  expect(noAddress.body?.error?.details?.missing).toBe("address");
  await clearCart("customer");
  return `customer2: 'Add your mobile number…' instead of pay, API 422 missing=mobile; customer without addressId: 422 missing=address`;
}, { ...SIGNED, partial: "the no-address prompt on the page, pickup-only and B2B without an address: next checks (TC-CART-015/016)" });

qa(["TC-CART-016", "TC-CART-015", "TC-LOC-022"], "pickup order from a shop that does not deliver: placed without an address, no delivery fee, no minimum, no rider at READY, the shop completes it", async () => {
  const item = listing("packaged");
  return withShop("A", { deliveryAvailable: false, deliveryFeePaise: 2000, minOrderPaise: 20000 }, async () => {
    await fillCart("customer", [{ item, quantity: 1 }]);
    const res = await checkoutAs("customer", { paymentMethod: "WALLET" });
    expectStatus(res, 201, "pickup order without an address");
    const order = res.body.orders[0];
    let done = false;
    try {
      expect(order.totalPaise, "no delivery fee, below the ₹200 minimum").toBe(item.pricePaise);
      for (const action of ["accept", "start", "ready"]) {
        expectStatus(await call(await as("shop"), "POST", `/api/orders/${order.id}/fulfilment`, { action }), 200, `shop ${action}`);
      }
      const offered = await poll(
        async () => (await call(await as("rider"), "GET", "/api/delivery-partner/deliveries")).body?.active?.orderId === order.id,
        (v) => v,
        8_000,
      );
      expect(offered, "no rider dispatch for a pickup order").toBe(false);
      const delivered = await call(await as("shop"), "PATCH", `/api/orders/${order.id}/status`, { status: "DELIVERED", note: "Collected at the shop" });
      expectStatus(delivered, 200, "shop completes READY → DELIVERED");
      done = true;
      expect((await orderOf("customer", order.id))?.status).toBe("DELIVERED");
      return `${order.orderNumber}: ${rupees(order.totalPaise)} (no fee, minimum ₹200 not applied), READY with no rider offer, shop marked DELIVERED`;
    } finally {
      if (!done) await cancelAsShop("shop", order.id);
    }
  });
}, { ...SIGNED, partial: "TC-LOC-022: the below / exactly-at minimum cases are in shopping-shop-rules.spec.ts" });

qa("TC-CART-015", "a business (B2B) order needs no delivery address", async () => {
  const item = listing("sharedB");
  need(world().users.shopB, "shop B");
  await fillCart("shop", [{ item, quantity: 1 }]);
  const res = await checkoutAs("shop", { paymentMethod: "WALLET", orderType: "B2B", buyerShopId: shopId("A") });
  try {
    expectStatus(res, 201, "B2B without an address");
    expect(res.body.orders[0].orderType).toBe("B2B");
    return `shop A buys from shop B (B2B) with no address: ${res.body.orders[0].orderNumber}`;
  } finally {
    if (res.status === 201) await cancelOwn("shop", res.body.orders[0].id);
    await clearCart("shop");
  }
}, SIGNED);

/* ------------------------------------------------------------ checkout fields */

qa(["TC-FLD-026", "TC-FLD-027"], "checkout fields: each delivery window and payment method on the list is taken, values off the list are refused (422)", async () => {
  const item = listing("packaged");
  const windows = (await call(await as("customer"), "GET", `/api/checkout/delivery-windows?shopId=${shopId("A")}`)).body;
  const seen: string[] = [];
  for (const [field, value] of [
    ["deliveryWindows", { [shopId("A")]: "TURBO_10" }],
    ["deliveryWindows", { "not-a-shop": "EXPRESS_30" }],
    ["paymentMethod", "CHEQUE"],
    ["paymentMethod", ""],
    ["scheduledSlots", { [shopId("A")]: "tomorrow 9am" }],
  ] as [string, unknown][]) {
    await fillCart("customer", [{ item, quantity: 1 }]);
    const res = await checkoutCart("customer", { [field]: value });
    expect(res.status, `${field} ${JSON.stringify(value)}: ${why(res)}`).toBe(422);
    seen.push(`${field}=${JSON.stringify(value)}→422`);
  }
  // Each offered window and the wallet are accepted and kept on the order.
  for (const window of (["EXPRESS_30", "STANDARD_60", "SCHEDULED"] as const).filter((w) => windows[w])) {
    await fillCart("customer", [{ item, quantity: 1 }]);
    const res = await checkoutCart("customer", { deliveryWindows: { [shopId("A")]: window } });
    expectStatus(res, 201, `window ${window}`);
    const order = res.body.orders[0];
    expect(order.deliveryWindow, `order carries ${window}`).toBe(window);
    expect(order.paymentMethod).toBe("WALLET");
    seen.push(`${window}→${order.deliveryWindow}`);
    await cancelOwn("customer", order.id);
  }
  // Cash on delivery where the shop does not allow it, and online payment while it is off.
  await fillCart("customer", [{ item, quantity: 1 }]);
  const cod = await checkoutCart("customer", { paymentMethod: "COD" });
  expect([409, 422], `COD at a shop with COD off: ${why(cod)}`).toContain(cod.status);
  seen.push(`COD (shop has COD off)→${cod.status}`);
  const online = await checkoutCart("customer", { paymentMethod: "ONLINE" });
  expect([201, 409], why(online)).toContain(online.status);
  if (online.status === 201) for (const o of online.body.orders) await cancelOwn("customer", o.id);
  seen.push(`ONLINE→${online.status}`);
  await clearCart("customer");
  return seen.join("; ");
}, { ...SIGNED, partial: "a window that has already passed is a scheduled slot in the past: TC-CART-022 / TC-FLD-131 (local); COD where the shop allows it: shopping-shop-rules.spec.ts" });

qa("TC-FLD-027", "cash on delivery is taken where the shop allows it", async () => {
  const item = listing("packaged");
  return withShop("A", { codEnabled: true }, async () => {
    await fillCart("customer", [{ item, quantity: 1 }]);
    const res = await checkoutCart("customer", { paymentMethod: "COD" });
    if (res.status === 409) blocked(`COD refused by the customer's COD limits — ${why(res)}`);
    expectStatus(res, 201, "COD at a shop that allows it");
    try {
      expect(res.body.orders[0].paymentMethod).toBe("COD");
      expect(res.body.orders[0].status).toBe("CONFIRMED");
      return `COD order ${res.body.orders[0].orderNumber} CONFIRMED`;
    } finally {
      await cancelOwn("customer", res.body.orders[0].id);
    }
  });
}, SIGNED);

/* ------------------------------------------------------------ rate limit (last) */

qa("TC-CART-014", "more than 15 checkout requests in a minute: 429 RATE_LIMITED with retryAfterSeconds after the 15th", async () => {
  // An account that places no other order in these specs, so its minute starts clean; customer 2
  // (refused checkouts earlier in this file) waits out the fixed one-minute window first.
  const role = world().users.shopC ? "shopC" : "customer2";
  need(world().users[role], `an account for the rate-limit check (${role})`);
  if (role === "customer2") await new Promise((r) => setTimeout(r, 61_000));
  const statuses: number[] = [];
  let limited: Awaited<ReturnType<typeof call>> | null = null;
  for (let i = 0; i < 17; i++) {
    const res = await call(await as(role), "POST", "/api/checkout", { requestId: `qa-rate-${Date.now()}-${i}` });
    statuses.push(res.status);
    if (res.status === 429) {
      limited = res;
      break;
    }
  }
  expect(limited, `statuses ${statuses.join(",")}`).not.toBeNull();
  const index = statuses.indexOf(429);
  expect(index, `the 16th request is the first refused (statuses ${statuses.join(",")})`).toBe(15);
  expect(limited!.body?.error?.code).toBe("RATE_LIMITED");
  expect(limited!.body?.error?.details?.retryAfterSeconds).toBeGreaterThan(0);
  return `${role}: requests 1–15 → ${[...new Set(statuses.slice(0, 15))].join("/")}, 16th → 429 RATE_LIMITED, retryAfterSeconds ${limited!.body.error.details.retryAfterSeconds}`;
}, { ...SIGNED, timeout: 180_000 });
