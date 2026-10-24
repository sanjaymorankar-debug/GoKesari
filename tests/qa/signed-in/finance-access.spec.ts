/**
 * Who may see and move money and stock (signed-in halves of the finance and
 * inventory access cases; the guest halves are in guest/access.spec.ts):
 * finance APIs closed to shop, rider and customer (TC-FIN-027), operators
 * cannot prepare, approve or pay (TC-FIN-009), commission input rules
 * (TC-FIN-003), invoices private (TC-FIN-031), inventory private
 * (TC-SPI-027), and the own-data views: shop finance (TC-FIN-010), rider
 * earnings (TC-FIN-018), shop inventory (TC-SPI-015), the shop's order list
 * (TC-SPI-008) and the customer's purchase history (TC-SPI-006).
 *
 * Signed-in tier: each request either is refused (nothing written) or acts on
 * the test accounts' own data.
 */
import {
  api,
  asPage,
  buy,
  deliveredOrder,
  inventory,
  orderDetail,
  paiseIn,
  partnerId,
  shopId,
  walletBalance,
} from "../lib/finance-helpers";
import { sellable } from "../lib/flows";
import { anonymous, call, expectStatus } from "../lib/http";
import { NO_SUCH_ID } from "../lib/routes";
import { blocked, expect, need, qa } from "../lib/record";
import { world, type Role } from "../lib/world";

const signed = { tier: "signed" as const, timeout: 240_000 };
const FINANCE_READS = [
  "/api/finance/summary?from=2026-01-01&to=2026-12-31",
  "/api/finance/settlements",
  "/api/finance/rider-payouts",
  "/api/finance/ledger",
  "/api/finance/payables",
  "/api/finance/adjustments",
];

qa("TC-FIN-027", "finance APIs answer 403 to a shop owner, a rider and a customer", async () => {
  const bad: string[] = [];
  let checked = 0;
  for (const role of ["shop", "rider", "customer"] as Role[]) {
    need(world().users[role], `the ${role} account`);
    for (const path of FINANCE_READS) {
      const res = await api(role, "GET", path);
      checked++;
      if (res.status !== 403) bad.push(`${role} GET ${path} → ${res.status}`);
    }
    for (const [method, path, body] of [
      ["POST", "/api/finance/adjustments", { type: "SHOP_ADJUSTMENT", shopId: NO_SUCH_ID, amountPaise: 100, reason: "QA probe", requestId: "qa-probe-0001" }],
      ["POST", "/api/finance/settlements", {}],
      ["POST", "/api/finance/rider-payouts", {}],
    ] as const) {
      const res = await api(role, method, path, body);
      checked++;
      if (res.status !== 403) bad.push(`${role} ${method} ${path} → ${res.status}`);
    }
  }
  expect(bad, bad.join("\n")).toEqual([]);
  return `${checked} finance calls by shop, rider and customer: all 403`;
}, signed);

qa("TC-FIN-009", "an operator cannot prepare, approve or pay settlements and payouts (403)", async () => {
  const bad: string[] = [];
  const calls: [string, string, unknown][] = [
    ["POST", "/api/finance/settlements", {}],
    ["POST", "/api/finance/rider-payouts", {}],
    ["PATCH", `/api/finance/settlements/${NO_SUCH_ID}`, { action: "approve" }],
    ["PATCH", `/api/finance/settlements/${NO_SUCH_ID}`, { action: "pay", note: "UTR-QA-PROBE" }],
    ["PATCH", `/api/finance/rider-payouts/${NO_SUCH_ID}`, { action: "approve" }],
    ["PATCH", `/api/finance/rider-payouts/${NO_SUCH_ID}`, { action: "pay", note: "UTR-QA-PROBE" }],
    ["POST", "/api/finance/commission-rates", { scope: "DEFAULT", rateBp: 100 }],
    ["POST", "/api/finance/adjustments", { type: "SHOP_ADJUSTMENT", shopId: NO_SUCH_ID, amountPaise: 100, reason: "QA probe", requestId: "qa-probe-0002" }],
  ];
  const roles = (["ops", "oplim"] as Role[]).filter((r) => world().users[r]);
  need(world().users.ops, "the operator account");
  for (const role of roles) {
    for (const [method, path, body] of calls) {
      const res = await api(role, method as "POST" | "PATCH", path, body);
      if (res.status !== 403) bad.push(`${role} ${method} ${path} ${JSON.stringify(body)} → ${res.status}`);
    }
  }
  // The operator's own finance view is the exceptions queue — open to them, without batch totals.
  const exceptions = await api("ops", "GET", "/api/finance/exceptions");
  expectStatus(exceptions, 200, "operator opens the exceptions queue");
  expect(exceptions.body.batchProblems, "operator sees no settlement / payout batches").toBeNull();
  expect(bad, bad.join("\n")).toEqual([]);
  return `${calls.length * roles.length} prepare / approve / pay / rate / adjustment calls by ${roles.join(" and ")}: all 403; exceptions queue open without batches`;
}, signed);

qa(["TC-FIN-003", "TC-FLD-111"], "commission rate: -1, above the cap, text and decimals are refused with 422; operator 403", async () => {
  const bad: string[] = [];
  const probes: [unknown, string][] = [
    [-1, "-1 bp"],
    [10001, "10001 bp (100.01%)"],
    [5001, "5001 bp (above the 50% cap)"],
    ["10", "text"],
    [755.5, "7.555% (755.5 bp)"],
    [null, "blank"],
  ];
  for (const [rateBp, label] of probes) {
    const res = await api("admin", "POST", "/api/finance/commission-rates", { scope: "SHOP", shopId: NO_SUCH_ID, rateBp });
    if (res.status !== 422) bad.push(`${label} → ${res.status} ${JSON.stringify(res.body).slice(0, 120)}`);
  }
  const op = await api("ops", "POST", "/api/finance/commission-rates", { scope: "DEFAULT", rateBp: 500 });
  if (op.status !== 403) bad.push(`operator → ${op.status}`);
  expect(bad, bad.join("\n")).toEqual([]);
  return "-1, 100.01%, 50.01%, text, 7.555% and blank → 422 (no rate saved); operator → 403";
}, {
  ...signed,
  partial:
    "the accepted values (0, 7.5%, the cap) and 'delivered orders keep their snapshot rate' are proven in local/finance-settlement.spec.ts. Expected '0 to 100' superseded by src/server/services/finance.ts setCommissionRate: the cap is 50% (5000 bp), so 100 is refused too",
});

qa("TC-FIN-031", "invoices are private: another customer and another shop's owner are refused on the order's invoice", async () => {
  const listing = await sellable("A");
  const order = await buy(listing, 1);
  const bad: string[] = [];
  try {
    for (const role of ["customer2", "shopB"] as Role[]) {
      if (!world().users[role]) continue;
      for (const method of ["POST", "GET"] as const) {
        const res = await api(role, method, `/api/orders/${order.id}/invoice`);
        if (![403, 404].includes(res.status)) bad.push(`${role} ${method} invoice → ${res.status}`);
      }
    }
    const guest = await anonymous();
    const g = await call(guest, "POST", `/api/orders/${order.id}/invoice`);
    if (g.status !== 401) bad.push(`guest POST invoice → ${g.status}`);
    await guest.dispose();
  } finally {
    await api("customer", "PATCH", `/api/orders/${order.id}/status`, { status: "CANCELLED", note: "QA invoice privacy probe" });
  }
  expect(bad, bad.join("\n")).toEqual([]);
  return `order ${order.orderNumber}: customer2 / shop B owner → 403/404, guest → 401 (order cancelled again)`;
}, { ...signed, partial: "the PDF of an issued invoice (buyer, selling shop and finance staff only) is checked with invoicing on in local/finance-invoices.spec.ts" });

qa("TC-SPI-027", "inventory is private: owner A cannot read or change shop B's stock; a customer cannot read any shop's inventory", async () => {
  const b = need(world().shops.B?.id, "shop B");
  const bListing = need(world().listings.sharedB, "a shop B listing");
  const bad: string[] = [];
  const checks: [Role, "GET" | "PATCH", string, unknown][] = [
    ["shop", "GET", `/api/shops/${b}/inventory`, undefined],
    ["shop", "GET", `/api/shops/${b}/accounts/stock`, undefined],
    ["shop", "GET", `/api/shops/${b}/accounts/stock/${bListing.shopProductId}`, undefined],
    ["shop", "PATCH", `/api/shop-products/${bListing.shopProductId}`, { onlineStock: 1 }],
    ["shop", "PATCH", `/api/shop-products/${bListing.shopProductId}/stock-settings`, { lowStockThreshold: 9 }],
    ["customer", "GET", `/api/shops/${shopId("A")}/inventory`, undefined],
    ["customer", "GET", `/api/shops/${shopId("A")}/accounts/stock`, undefined],
    ["rider", "GET", `/api/shops/${shopId("A")}/inventory`, undefined],
  ];
  for (const [role, method, path, body] of checks) {
    const res = await api(role, method, path, body);
    if (res.status !== 403 && res.status !== 404) bad.push(`${role} ${method} ${path} → ${res.status}`);
  }
  const guest = await anonymous();
  for (const path of [`/api/shops/${shopId("A")}/inventory`, `/api/shops/${shopId("A")}/accounts/stock`]) {
    const res = await call(guest, "GET", path);
    if (res.status !== 401) bad.push(`guest GET ${path} → ${res.status}`);
  }
  await guest.dispose();
  // B's stock is untouched by the refused write.
  const bStock = (await inventory("shopB", "B")).rows.find((r) => r.shopProductId === bListing.shopProductId)?.available;
  expect(bStock, "shop B's stock after owner A's refused write").not.toBe(1);
  expect(bad, bad.join("\n")).toEqual([]);
  return `${checks.length + 2} cross-shop / customer / guest inventory calls refused (403/404, guest 401); shop B stock still ${bStock}`;
}, signed);

qa("TC-SPI-027", "customers see availability only: the storefront answer carries no stock counts", async () => {
  const res = await api("customer", "GET", `/api/shops/${shopId("A")}/products?limit=20`);
  expectStatus(res, 200, "storefront products");
  const rows = (Array.isArray(res.body) ? res.body : res.body?.products ?? []) as Record<string, unknown>[];
  if (!rows.length) blocked("shop A lists no products");
  const withCounts = rows.filter((r) => typeof r.onlineStock === "number" || typeof r.offlineStock === "number");
  const shown = withCounts.slice(0, 3).map((r) => `${r.productName}: onlineStock ${r.onlineStock}`).join("; ");
  expect(withCounts.length, `GET /api/shops/{A}/products as a customer: ${withCounts.length} of ${rows.length} rows carry the exact stock count (${shown})`).toBe(0);
  return `${rows.length} storefront rows, none with a stock count`;
}, { ...signed, mobile: false });

qa("TC-FIN-018", "rider earnings view: each earning with its status, the payouts list, only the rider's own data", async ({ browser }) => {
  const res = await api("rider", "GET", "/api/delivery-partner/earnings");
  expectStatus(res, 200, "rider earnings API");
  let statement = (res.body.statement ?? []) as { id: string; totalPaise: number; deliveryPartnerId: string; lines: unknown[] }[];
  if (statement.length === 0) {
    await deliveredOrder();
    statement = (await api("rider", "GET", "/api/delivery-partner/earnings")).body.statement;
  }
  const mine = await partnerId("rider");
  expect(statement.every((e) => e.deliveryPartnerId === mine), "statement holds only the rider's own earnings").toBe(true);
  expect(statement[0].lines.length, "an earning carries its breakdown lines").toBeGreaterThan(0);
  const other = world().users.rider2 ? (await api("rider2", "GET", "/api/delivery-partner/earnings")).body?.statement ?? [] : [];
  const otherIds = new Set((other as { id: string }[]).map((e) => e.id));
  expect(statement.some((e) => otherIds.has(e.id)), "no earning of rider 2 in rider 1's statement").toBe(false);

  const shown = await asPage(browser, "rider", "/delivery-partner", async (page) => {
    const card = page.getByTestId("rider-earnings");
    await expect(card).toBeVisible();
    await expect(card).toContainText("Not yet paid out");
    const rows = card.locator("li");
    const n = await rows.count();
    expect(n, "earnings listed").toBeGreaterThan(0);
    const first = await rows.first().innerText();
    expect(first, "each earning shows a status (UNPAID or the payout's)").toMatch(/unpaid|pending|eligible|processing|paid|failed|reversed/i);
    await expect(page.getByTestId("rider-payouts")).toBeVisible();
    return n;
  });
  return `${statement.length} earnings in the API, ${shown} rows on the page with status; payouts card shown; none of rider 2's`;
}, { ...signed, mobile: true });

qa("TC-FIN-010", "shop finance page: own commission, settlements and per-order payable; figures agree with the admin view", async ({ browser }) => {
  const a = shopId("A");
  const probe = await api("admin", "GET", "/api/finance/payables");
  if (!(probe.body.shops as { shopId: string }[]).some((s) => s.shopId === a)) await deliveredOrder();
  const payables = await api("admin", "GET", "/api/finance/payables");
  expectStatus(payables, 200, "admin payables");
  const adminRow = (payables.body.shops as { shopId: string; orders: number; payable: number }[]).find((s) => s.shopId === a) ?? { orders: 0, payable: 0 };
  const adjustments = await api("admin", "GET", "/api/finance/adjustments");
  const pendingAdj = ((adjustments.body ?? []) as { adjustment: { shopId: string | null; party: string; status: string; amountPaise: number } }[])
    .filter((x) => x.adjustment.party === "SHOP" && x.adjustment.shopId === a && x.adjustment.status === "PENDING")
    .reduce((s, x) => s + x.adjustment.amountPaise, 0);
  const settlementsRes = await api("admin", "GET", "/api/finance/settlements");
  const ownSettlements = ((settlementsRes.body ?? []) as { settlement: { shopId: string; netPayablePaise: number } }[]).filter((s) => s.settlement.shopId === a);
  const otherShop = world().shops.B?.name;

  const seen = await asPage(browser, "shop", "/shop/finance", async (page) => {
    await expect(page.getByRole("heading", { name: "Finance" }).first()).toBeVisible();
    const header = await page.locator("main").first().innerText();
    expect(header, "commission rate stated").toMatch(/commission \d+\.\d{2}% on goods/);
    const card = page.locator("section").filter({ hasText: "Not yet settled" }).first();
    const amounts = paiseIn(await card.innerText());
    expect(amounts[0], `"Not yet settled" (admin payable ${adminRow.payable} + pending adjustments ${pendingAdj})`).toBe(adminRow.payable + pendingAdj);
    await expect(card).toContainText(`${adminRow.orders} delivered orders`);
    await expect(page.getByRole("heading", { name: "Settlements" })).toBeVisible();
    if (otherShop) expect(header, "no other shop on the page").not.toContain(otherShop);
    return { net: amounts[0] };
  });
  return `not yet settled ₹${seen.net / 100} = admin payable ₹${adminRow.payable / 100} + pending adjustments ₹${pendingAdj / 100}; ${adminRow.orders} orders; ${ownSettlements.length} own settlements`;
}, { ...signed, mobile: true, partial: "per-order payable lines against each order's snapshot are checked in local/finance-settlement.spec.ts" });

qa("TC-SPI-015", "inventory page: every listing with unit, available, reserved, on hand, low-stock threshold and price; on hand = available + reserved", async ({ browser }) => {
  const api_ = await inventory("shop", "A");
  expect(api_.rows.length, "listings").toBeGreaterThan(0);
  const badApi = api_.rows.filter((r) => r.onHand !== r.available + r.reserved).map((r) => `${r.productName}: ${r.onHand} ≠ ${r.available} + ${r.reserved}`);
  expect(badApi, "on hand = available + reserved (API)").toEqual([]);
  const checked = await asPage(browser, "shop", "/shop/inventory", async (page) => {
    const table = page.getByTestId("inventory-table");
    await expect(table).toBeVisible();
    const headers = (await table.locator("thead th").allInnerTexts()).map((h) => h.trim().toLowerCase());
    for (const h of ["product", "unit", "available", "price (₹)", "reserved", "on hand", "low at"]) expect(headers, `column "${h}"`).toContain(h);
    const col = (name: string) => headers.indexOf(name);
    const rows = table.locator("tbody tr");
    const n = await rows.count();
    expect(n, "one row per listing").toBe(api_.rows.length);
    const bad: string[] = [];
    for (let i = 0; i < n; i++) {
      const cells = await rows.nth(i).locator("td").allInnerTexts();
      const available = Number(cells[col("available")]);
      const reserved = Number(cells[col("reserved")]);
      const onHand = Number(cells[col("on hand")]);
      if (onHand !== available + reserved) bad.push(`row ${i + 1} (${cells[0].slice(0, 40)}): ${onHand} ≠ ${available} + ${reserved}`);
      if (!cells[col("unit")].trim()) bad.push(`row ${i + 1}: no unit`);
    }
    expect(bad, bad.join("\n")).toEqual([]);
    // "Whether a price is set": an unpriced listing says so.
    const unpriced = api_.rows.filter((r) => r.onlinePricePaise == null).length;
    if (unpriced > 0) await expect(table.getByText("Needs a price").first()).toBeVisible();
    return n;
  });
  return `${checked} rows: unit, available, reserved, on hand (= available + reserved on every row), low-stock threshold, price / "Needs a price"`;
}, { ...signed, mobile: true });

qa("TC-SPI-008", "the sale in the shop's order list: lines, quantities, amounts, payment method; no customer contact details", async ({ browser }) => {
  const listing = await sellable("A");
  const order = await buy(listing, 2);
  const customer = await api("customer", "GET", "/api/profile");
  const email = world().users.customer?.email ?? "";
  const phone = String(customer.body?.mobile ?? customer.body?.user?.mobile ?? customer.body?.phone ?? "") || null;
  try {
    const seen = await asPage(browser, "shop", "/shop/orders", async (page) => {
      const card = page.getByTestId("shop-order").filter({ hasText: order.orderNumber }).first();
      await expect(card).toBeVisible();
      const text = await card.innerText();
      // What fulfilment needs is there; the customer's contact details are not.
      expect(text, "line with product name").toContain(listing.name.slice(0, 20));
      expect(text, "quantity with unit").toContain("2 piece");
      expect(paiseIn(text), "line / goods amount").toContain(2 * (listing.pricePaise ?? 0));
      expect(text, "no customer e-mail").not.toContain(email);
      if (phone) expect(text, "no customer phone").not.toContain(phone);
      const missing: string[] = [];
      if (!paiseIn(text).includes(listing.pricePaise ?? -1)) missing.push(`unit price at sale (₹${(listing.pricePaise ?? 0) / 100})`);
      if (!/MRP/i.test(text)) missing.push("MRP at sale");
      if (!/wallet|paid online|prepaid|cash on delivery/i.test(text)) missing.push("payment method (wallet)");
      expect(missing, `shop order card lacks: ${missing.join(", ")} — card reads "${text.replace(/\s+/g, " ").slice(0, 200)}"`).toEqual([]);
      return text.replace(/\s+/g, " ").slice(0, 160);
    });
    return `shop order card: ${seen}`;
  } finally {
    await api("customer", "PATCH", `/api/orders/${order.id}/status`, { status: "CANCELLED", note: "QA" });
  }
}, { ...signed, mobile: true });

qa("TC-SPI-006", "purchase history: shop, lines with quantities and units, price and MRP at purchase, payment method, status; totals match the wallet", async ({ browser }) => {
  const listing = await sellable("A");
  const before = await walletBalance();
  const order = await buy(listing, 2);
  const detail = need(await orderDetail("customer", order.id), "the order in /api/orders");
  try {
    const wallet = await api("customer", "GET", "/api/wallet");
    const txns = JSON.stringify(wallet.body);
    expect(await walletBalance(), "wallet debited by the order total").toBe(before - order.totalPaise);
    expect(txns.includes(order.orderNumber) || txns.includes(order.id), "the wallet statement names the order").toBe(true);
    const seen = await asPage(browser, "customer", `/orders/${order.id}`, async (page) => {
      await expect(page.getByRole("heading", { name: `Order ${order.orderNumber}` })).toBeVisible();
      const main = await page.locator("main").first().innerText();
      expect(main).toContain(listing.shopName);
      expect(main, "line with product name").toContain(listing.name.slice(0, 20));
      expect(main, "quantity with unit").toContain("2 piece");
      expect(main, "status").toMatch(/confirmed/i);
      expect(paiseIn(main), "order total shown").toContain(order.totalPaise);
      const missing: string[] = [];
      if (!paiseIn(main).includes(detail.items[0].unitPricePaise)) missing.push(`unit price at purchase (₹${detail.items[0].unitPricePaise / 100})`);
      if (!/MRP/i.test(main)) missing.push("MRP at purchase");
      if (!/wallet/i.test(main)) missing.push("payment method (wallet)");
      expect(missing, `order page lacks: ${missing.join(", ")}`).toEqual([]);
      return main.replace(/\s+/g, " ").slice(0, 160);
    });
    return seen;
  } finally {
    await api("customer", "PATCH", `/api/orders/${order.id}/status`, { status: "CANCELLED", note: "QA" });
  }
}, { ...signed, mobile: true });
