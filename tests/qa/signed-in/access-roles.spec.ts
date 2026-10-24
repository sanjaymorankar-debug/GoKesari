/**
 * Roles and access control, signed in (QA package 2): each role reaches its
 * own portal and nothing else; one shop owner, rider or customer can never
 * read or change another's data (IDOR); operators are kept out of admin-only
 * functions; personal and business (B2B) orders by role; order, settlement,
 * analytics and audit visibility per role; server-assigned fields and
 * sensitive values never cross the API.
 *
 * Signed-in tier: the test accounts on their own test data (local server and
 * test.gokesari.com). The guest halves are in tests/qa/guest/access.spec.ts.
 */
import { as, me, pageAs } from "../lib/actors";
import {
  addToCart,
  cartLines,
  defaultAddress,
  deliver,
  emptyCart,
  offerFor,
  onlyRiderOnline,
  orderAs,
  packOrder,
  placeOrder,
  sellable,
  shopOf,
  walletBalance,
  type PlacedOrder,
} from "../lib/flows";
import { db } from "../lib/db";
import { call, expectStatus, RUN, stash, unstash, why, type Answer } from "../lib/http";
import { pagePaths } from "../lib/routes";
import { expect, need, qa } from "../lib/record";
import { IS_LOCAL } from "../lib/target";
import { ROLE_NAMES, world, type Role } from "../lib/world";
import {
  brief,
  errorCode,
  fillRoute,
  getAs,
  NO_SUCH_ID,
  redirectPath,
  refused,
  roleSwitcher,
  routesUnder,
  societyId,
  summarizeSweep,
  sweep,
  worldCategory,
} from "../lib/access-helpers";

const signed = { tier: "signed" as const, timeout: 300_000 };

/** The admin pages of the preflight list (TC-PRE-003), which TC-RBAC-003 sends every non-staff role to. */
const PREFLIGHT_ADMIN_PAGES = [
  "/admin/dashboard",
  "/admin/orders",
  "/admin/exceptions",
  "/admin/settings",
  "/admin/suspensions",
  "/admin/rider-earnings",
  "/admin/price-references",
  "/admin/mrp",
  "/admin/shop-categories",
  "/admin/returns",
  "/admin/cod",
  "/admin/risk",
  "/admin/analytics",
  "/admin/campaigns",
  "/admin/societies",
  "/admin/product-master",
  "/admin/consents",
  "/admin/ratings",
];

/** Every role's home portal (src/components/role-switcher.tsx ROLE_HOME). */
const ROLE_HOME: Record<string, string> = {
  CUSTOMER: "/",
  SHOP_OWNER: "/shop",
  OPERATOR: "/admin",
  ADMIN: "/admin",
  DELIVERY_PARTNER: "/delivery-partner",
  SOCIETY_ADMIN: "/society",
  OPERATOR_LIMITED: "/operator",
};

/** Admin pages from the checkout (every /admin page; dynamic ones with an id that exists nowhere). */
function allAdminPages() {
  return pagePaths().filter((p) => p === "/admin" || p.startsWith("/admin/")).map((p) => fillRoute(p));
}

/** Pages `role` must not get into: each must redirect away, 401/403/404 — or show an apply/register prompt. */
async function closedPages(role: Role, paths: string[], prompts: Record<string, RegExp> = {}) {
  const bad: string[] = [];
  const seen: string[] = [];
  for (const path of paths) {
    const res = await getAs(role, path);
    seen.push(`${path} ${brief(res)}`);
    if (refused(res, path)) continue;
    const prompt = prompts[path];
    if (res.status === 200 && prompt && prompt.test(res.text)) continue;
    bad.push(`${path} → ${brief(res)}`);
  }
  return { bad, seen };
}

/* ======================================================== portals by role */

qa("TC-PRE-007", "every test account is signed in with its own role and its portal opens", async ({ browser }) => {
  // The roles the case names must exist; the extra ones are checked when the site has them.
  const required: Role[] = ["customer", "customer2", "shop", "shopB", "rider", "admin", "ops", "society"];
  for (const role of required) need(world().users[role], `a ${ROLE_NAMES[role]} test account "${role}"`);
  const roles = (Object.keys(ROLE_NAMES) as Role[]).filter((r) => world().users[r]);
  const out: string[] = [];
  for (const role of roles) {
    const user = await me(role);
    expect(user.role, `${role}'s session role`).toBe(ROLE_NAMES[role]);
    const home = ROLE_HOME[user.role];
    const res = await getAs(role, home);
    expect(res.status, `${role} opens ${home} — ${brief(res)}`).toBe(200);
    if (user.role !== "CUSTOMER") {
      // Holding CUSTOMER and a portal role, the header's role switcher shows the active role.
      const { context, page } = await pageAs(browser, role);
      try {
        await page.goto("/", { waitUntil: "domcontentloaded" });
        await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
        await expect(await roleSwitcher(page), `${role}: role switcher in the account menu`).toHaveValue(user.role);
      } finally {
        await context.close();
      }
    }
    out.push(`${role}=${user.role}→${home}`);
  }
  return out.join(", ");
}, { ...signed, partial: "sessions are the target's own (minted locally, saved sign-ins on the test site); a real emailed-code sign-in is TC-PRE-005/TC-PRE-007 in tests/qa/local/access-platform.spec.ts" });

qa("TC-RBAC-003", "a customer is kept out of the admin, operator, shop, rider and society portals", async () => {
  const soc = societyId();
  const paths = [
    "/admin",
    ...PREFLIGHT_ADMIN_PAGES,
    "/operator",
    "/shop/orders",
    "/shop/finance",
    "/shop/marketing",
    "/shop/analytics",
    "/delivery-partner",
    "/gig/orders",
    ...(soc ? [`/society/${soc}`] : []),
  ];
  // /gig/orders answers with "become a delivery partner" for an account without a rider profile.
  const { bad, seen } = await closedPages("customer", paths, { "/gig/orders": /not a delivery partner yet/i });
  expect(bad, `pages a customer could open:\n${bad.join("\n")}`).toEqual([]);
  // Where they go: home, or the shop-registration / rider-application start.
  const shopOrders = await getAs("customer", "/shop/orders");
  const seller = await getAs("customer", "/shop");
  expect(seller.text, "/shop for a customer is the registration start").toMatch(/seller-welcome|Welcome to Seller Central/);
  expect(redirectPath(await getAs("customer", "/delivery-partner")), "/delivery-partner").toBe("/delivery-partner/apply");
  return `${paths.length} pages closed (${seen.slice(0, 6).join("; ")} …); /shop/orders ${brief(shopOrders)} = registration start`;
}, { ...signed, partial: "pages only; the write APIs of each area are the next check" });

qa("TC-RBAC-003", "a customer's call to a write API of each area is refused 403 FORBIDDEN", async () => {
  const shopA = await shopOf("A");
  const pending = world().shops.pending;
  const victim = need(world().users.customer2?.id ?? (await me("customer2")).id, "customer 2's id");
  const soc = societyId();
  const calls: [string, "POST" | "PUT" | "PATCH", string, unknown][] = [
    ["admin: business rules", "PUT", "/api/admin/settings", { key: "otp", value: { length: 6 } }],
    ["admin: suspend a user", "POST", `/api/users/${victim}/suspend`, { reason: "QA access check" }],
    ["admin: set a role", "PATCH", `/api/users/${victim}/role`, { role: "OPERATOR" }],
    ["operator: approve a shop", "POST", `/api/shops/${pending?.id ?? shopA.id}/approve`, {}],
    ["operator: risk rules", "POST", "/api/admin/risk", {}],
    ["finance: prepare settlements", "POST", "/api/finance/settlements", {}],
    ["shop: edit a shop", "PATCH", `/api/shops/${shopA.id}`, { description: `QA ${RUN}` }],
    ["shop: add a product", "POST", `/api/shops/${shopA.id}/products`, { productId: NO_SUCH_ID, onlinePricePaise: 100 }],
    ["rider: go online", "PATCH", "/api/delivery-partner/status", { isOnline: true }],
    ["vouchers: create", "POST", "/api/vouchers", { code: `QA${RUN}`.toUpperCase() }],
    ...(soc ? ([["society: edit", "PATCH", `/api/societies/${soc}`, { name: "QA" }]] as [string, "PATCH", string, unknown][]) : []),
  ];
  const bad: string[] = [];
  const out: string[] = [];
  for (const [what, method, path, body] of calls) {
    const res = await call(await as("customer"), method, path, body);
    out.push(`${what} ${res.status}`);
    if (res.status !== 403 || errorCode(res) !== "FORBIDDEN") bad.push(`${what} (${method} ${path}) → ${why(res)}`);
  }
  expect(bad, bad.join("\n")).toEqual([]);
  return out.join("; ");
}, signed);

/** Staff-only write APIs outside /api/admin (customer-facing routes in these groups left out). */
function staffWrites() {
  const prefixes = ["/api/finance", "/api/users", "/api/operator", "/api/vouchers", "/api/voucher-uploads", "/api/registration-fees", "/api/shop-payments", "/api/referral-codes", "/api/price-requests", "/api/support/canned-replies", "/api/product-master", "/api/pmd/browser"];
  const customerFacing = new Set(["POST /api/vouchers/preview"]);
  return prefixes.flatMap((p) => routesUnder(p, { writesOnly: true })).filter((t) => !customerFacing.has(`${t.method} ${t.path}`));
}

qa("TC-RBAC-003", "every admin and staff write API refuses a signed-in customer with 403 before reading the request", async () => {
  const targets = [...routesUnder("/api/admin"), ...staffWrites()];
  const byStatus = await sweep(await as("customer"), targets);
  const bad = [...byStatus.entries()].filter(([s]) => s !== 403).flatMap(([s, lines]) => lines.map((l) => `${s} ${l}`));
  expect(bad, `staff API calls a customer did not get 403 for: ${bad.join("; ")}`).toEqual([]);
  return `${targets.length} admin/staff API calls: ${summarizeSweep(byStatus)}`;
}, { ...signed, partial: "an empty body and an id that exists nowhere; the refusal must come before validation or a lookup" });

qa("TC-RBAC-005", "a shop owner cannot open admin pages, the rider portal without the rider role, or another society", async () => {
  const pages = allAdminPages();
  const soc = societyId();
  const { bad, seen } = await closedPages("shop", [...pages, "/operator", "/delivery-partner", ...(soc ? [`/society/${soc}`] : [])]);
  expect(bad, `pages shop owner A could open:\n${bad.join("\n")}`).toEqual([]);
  expect(redirectPath(await getAs("shop", "/delivery-partner")), "/delivery-partner without a rider profile").toBe("/delivery-partner/apply");
  const settings = await call(await as("shop"), "PUT", "/api/admin/settings", { key: "otp", value: { length: 6 } });
  expect(settings.status, `PUT /api/admin/settings — ${why(settings)}`).toBe(403);
  return `${pages.length} admin pages + /operator, /delivery-partner${soc ? ", /society/{id}" : ""} refused (${seen.slice(-3).join("; ")}); settings API 403`;
}, signed);

qa("TC-RBAC-005", "every admin API refuses a shop owner with 403", async () => {
  const targets = routesUnder("/api/admin");
  const byStatus = await sweep(await as("shop"), targets);
  const bad = [...byStatus.entries()].filter(([s]) => s !== 403).flatMap(([s, lines]) => lines.map((l) => `${s} ${l}`));
  expect(bad, `admin API calls shop owner A did not get 403 for: ${bad.join("; ")}`).toEqual([]);
  return `${targets.length} admin API calls: ${summarizeSweep(byStatus)}`;
}, signed);

/* ======================================================== shop owner vs another shop */

qa("TC-RBAC-004", "shop owner A works on their own shop but every call against shop B is refused and changes nothing", async () => {
  const A = await shopOf("A");
  const B = await shopOf("B");
  const own = await getAs("shop", "/shop");
  expect(own.status, "/shop for owner A").toBe(200);
  expect(own.text, "the seller home names shop A").toContain(A.name);
  const ownInventory = await call(await as("shop"), "GET", `/api/shops/${A.id}/inventory`);
  expectStatus(ownInventory, 200, "own inventory");
  const before = await getAs("guest", `/api/shops/${B.id}`);
  const sharedB = world().listings.sharedB;
  const ctx = await as("shop");
  const attempts: [string, () => Promise<Answer>][] = [
    ["PATCH /api/shops/{B}", () => call(ctx, "PATCH", `/api/shops/${B.id}`, { description: `hacked ${RUN}`, serviceRadiusKm: 1 })],
    ["POST /api/shops/{B}/products", () => call(ctx, "POST", `/api/shops/${B.id}/products`, { productId: world().listings.packaged?.productId ?? NO_SUCH_ID, onlinePricePaise: 100, onlineStock: 5 })],
    ...(sharedB
      ? ([
          ["PATCH /api/shop-products/{B's}", () => call(ctx, "PATCH", `/api/shop-products/${sharedB.shopProductId}`, { onlinePricePaise: 1, onlineStock: 0 })],
          ["DELETE /api/shop-products/{B's}", () => call(ctx, "DELETE", `/api/shop-products/${sharedB.shopProductId}`)],
        ] as [string, () => Promise<Answer>][])
      : []),
    ["GET /api/shops/{B}/inventory", () => call(ctx, "GET", `/api/shops/${B.id}/inventory`)],
    [
      "POST /api/excel-uploads for B",
      () =>
        call(ctx, "POST", "/api/excel-uploads", undefined, {
          multipart: { shopId: B.id, file: { name: "prices.csv", mimeType: "text/csv", buffer: Buffer.from("product,price\nQA,1\n") } },
        }),
    ],
  ];
  const bad: string[] = [];
  const out: string[] = [];
  for (const [what, run] of attempts) {
    const res = await run();
    out.push(`${what} ${res.status}`);
    if (res.status !== 403 && res.status !== 404) bad.push(`${what} → ${why(res)}`);
  }
  expect(bad, bad.join("\n")).toEqual([]);
  const after = await getAs("guest", `/api/shops/${B.id}`);
  expect(after.body?.description ?? null, "shop B's description unchanged").toBe(before.body?.description ?? null);
  expect(after.body?.serviceRadiusKm ?? null, "shop B's radius unchanged").toBe(before.body?.serviceRadiusKm ?? null);
  if (sharedB) {
    const listing = await getAs("guest", `/api/shops/${B.id}/products?limit=100`);
    const rows = (Array.isArray(listing.body) ? listing.body : (listing.body?.products ?? [])) as { shopProductId: string; onlinePricePaise: number | null }[];
    const row = rows.find((r) => r.shopProductId === sharedB.shopProductId);
    expect(row?.onlinePricePaise, "B's shared listing keeps its price").toBe(sharedB.pricePaise);
  }
  return `own /shop and inventory 200; against B: ${out.join("; ")}; B unchanged`;
}, signed);

qa("TC-RBAC-004", "every shop-scoped API refuses owner A on shop B (403/404), also with a valid body", async () => {
  const B = await shopOf("B");
  // Public reads of a shop the storefront shows anyway.
  const PUBLIC = new Set(["GET /api/shops/[id]", "GET /api/shops/[id]/products", "GET /api/shops/[id]/ratings", "GET /api/shops/[id]/visible-products", "GET /api/shops/[id]/catalogue-search"]);
  const targets = routesUnder("/api/shops/[id]").filter((t) => !PUBLIC.has(`${t.method} ${t.path}`));
  const byStatus = await sweep(await as("shop"), targets, B.id);
  // Routes that check the body before the shop: sent again with a valid body, so the shop check itself is proven.
  const category = worldCategory()?.id ?? NO_SUCH_ID;
  const valid: Record<string, unknown> = {
    "PUT /api/shops/[id]/cancellation-fee": { enabled: false, feeType: "FLAT", feePaise: 0 },
    "POST /api/shops/[id]/marketing/segments": { name: `QA ${RUN}`, rules: { minOrders: 1 } },
    "POST /api/shops/[id]/product-categories": { categoryId: category },
    "PATCH /api/shops/[id]/profile-setup": { ownerName: "QA Intruder", addressLine1: "1 QA Road", city: "Pune", pincode: "411038", shopType: "GROCERY_KIRANA" },
    "POST /api/shops/[id]/staff": { identifier: `qa-intruder-${RUN}@test.local` },
  };
  const validationFirst = byStatus.get(422) ?? [];
  const retried: string[] = [];
  const bad: string[] = [];
  for (const line of validationFirst) {
    const [method, path] = line.split(" ");
    const body = valid[`${method} ${path}`];
    if (!body) {
      bad.push(`${line}: 422 with an empty body (no valid body known to retry)`);
      continue;
    }
    const res = await call(await as("shop"), method as "POST", fillRoute(path, B.id), body);
    retried.push(`${method} ${path} ${res.status}`);
    if (res.status !== 403 && res.status !== 404) bad.push(`${method} ${path} with a valid body → ${why(res)}`);
  }
  for (const [s, lines] of byStatus) if (s < 400 || s >= 500) bad.push(...lines.map((l) => `${s} ${l}`));
  expect(bad, bad.join("\n")).toEqual([]);
  return `${targets.length} calls on shop B: ${summarizeSweep(byStatus)}; validated before the shop check: ${retried.length ? retried.join(", ") + " (with a valid body)" : "none"}`;
}, { ...signed, partial: "empty bodies refused with 422 before the ownership check reveal field names only (the D-01 pattern, here for a signed-in owner); with a valid body each is refused" });

/* ======================================================== rider */

qa("TC-RBAC-006", "a rider sees only their own dashboard; another rider's delivery and profile are refused", async () => {
  need(world().users.rider2, "a second rider account (rider2)");
  expect((await getAs("rider", "/delivery-partner")).status, "own /delivery-partner").toBe(200);
  const mine = await call(await as("rider"), "GET", "/api/delivery-partner/me");
  expectStatus(mine, 200, "own rider profile");
  const other = await call(await as("rider2"), "GET", "/api/delivery-partner/me");
  expectStatus(other, 200, "rider 2's own profile");
  const otherId = String(other.body?.id ?? other.body?.partner?.id ?? "");
  expect(otherId, "rider 2 has a partner id").toMatch(/[0-9a-f-]{36}/);
  // A delivery offered to rider 2 only (locally the others go offline for it).
  const out: string[] = [];
  const bad: string[] = [];
  await onlyRiderOnline("rider2");
  try {
    const order = await placeOrder({ method: "WALLET" });
    await packOrder(order.id);
    const offer = await offerFor(order.id, "rider2");
    const deliveryId = offer.deliveryOrderId;
    for (const action of ["accept", "reject", "pickup", "start", "deliver"]) {
      const res = await call(await as("rider"), "PATCH", `/api/delivery-orders/${deliveryId}`, { action, otp: "123456", pickupCode: "1234" });
      out.push(`${action} ${res.status}`);
      if (res.status !== 403 && res.status !== 404) bad.push(`${action} on rider 2's delivery → ${why(res)}`);
    }
    for (const [method, body] of [["GET", undefined], ["PATCH", { action: "suspend", reason: "QA access check" }]] as const) {
      const res = await call(await as("rider"), method, `/api/delivery-partner/${otherId}`, body);
      out.push(`${method} /api/delivery-partner/{rider2} ${res.status}`);
      if (res.status !== 403 && res.status !== 404) bad.push(`${method} rider 2's profile → ${why(res)}`);
    }
    const view = await call(await as("rider"), "GET", "/api/delivery-partner/deliveries");
    expect(view.text, "rider 1's deliveries do not include rider 2's job").not.toContain(deliveryId);
    // Rider 2 still completes it: the refusals were about who asked, not a broken job (and no rider is left busy).
    await deliver(order.id, { rider: "rider2" });
    out.push("rider 2 delivered own job");
  } finally {
    await onlyRiderOnline("rider");
    if (IS_LOCAL) await db()`update delivery_partners set is_online = true where user_id = ${need(world().users.rider2?.id, "rider2 id")}`;
  }
  expect(bad, bad.join("\n")).toEqual([]);
  return out.join("; ");
}, { ...signed, partial: "locally the other riders go offline so the offer reaches rider 2; on the test site rider2 does not exist (blocked)" });

/* ======================================================== role switching */

qa("TC-RBAC-012", "a customer cannot switch to a role they do not hold", async () => {
  const before = (await call(await as("customer"), "GET", "/api/me/roles")).body;
  const out: string[] = [];
  for (const role of ["ADMIN", "OPERATOR", "SHOP_OWNER", "NOT_A_ROLE"]) {
    const res = await call(await as("customer"), "PUT", "/api/me/roles", { role });
    expect([403, 422], `switch to ${role} — ${why(res)}`).toContain(res.status);
    out.push(`${role} ${res.status}`);
  }
  const after = await call(await as("customer"), "GET", "/api/me/roles");
  expect(after.body?.active, "active role unchanged").toBe("CUSTOMER");
  expect(after.body?.roles).toEqual(before?.roles);
  const session = await call(await as("customer"), "GET", "/api/auth/session");
  expect(session.body?.user?.role, "session role").toBe("CUSTOMER");
  return `${out.join(", ")}; still CUSTOMER (${JSON.stringify(after.body?.roles)})`;
}, signed);

/* ======================================================== operator */

qa(["TC-RBAC-007", "TC-ADM-007"], "an operator is refused the admin-only functions: rules, finance approve/pay, suspend, role, rider earnings rules", async () => {
  const victim = need(world().users.customer2?.id ?? (await me("customer2")).id, "customer 2's id");
  const ctx = await as("ops");
  const out: string[] = [];
  const bad: string[] = [];
  for (const path of ["/admin/settings", "/admin/rider-earnings"]) {
    const res = await getAs("ops", path);
    out.push(`${path} ${brief(res)}`);
    if (!refused(res, path)) bad.push(`${path} opened for an operator (${brief(res)})`);
  }
  const apis: [string, "GET" | "POST" | "PUT" | "PATCH", string, unknown][] = [
    ["rules read", "GET", "/api/admin/settings", undefined],
    ["rules write", "PUT", "/api/admin/settings", { key: "otp", value: { length: 6 } }],
    ["rule reset", "PUT", "/api/admin/settings", { key: "dispatch", value: {} }],
    ["settlement approve", "PATCH", `/api/finance/settlements/${NO_SUCH_ID}`, { action: "approve" }],
    ["settlement pay", "PATCH", `/api/finance/settlements/${NO_SUCH_ID}`, { action: "mark_paid", reference: "QA" }],
    ["rider payout pay", "PATCH", `/api/finance/rider-payouts/${NO_SUCH_ID}`, { action: "mark_paid", reference: "QA" }],
    ["prepare settlements", "POST", "/api/finance/settlements", {}],
    ["suspend a user", "POST", `/api/users/${victim}/suspend`, { reason: "QA operator check" }],
    ["reinstate a user", "POST", `/api/users/${victim}/reinstate`, { reason: "QA operator check" }],
    ["set a role", "PATCH", `/api/users/${victim}/role`, { role: "OPERATOR" }],
    ["privileges", "PATCH", `/api/users/${victim}/privileges`, { activeRole: "CUSTOMER", heldRoles: ["CUSTOMER"] }],
    ["edit a user", "PATCH", `/api/users/${victim}`, { name: "QA Operator Edit" }],
    ["rider earnings rate", "POST", "/api/delivery-partner/earnings-config", { basePaise: 1, perKmPaise: 1 }],
    ["rider earnings slot", "POST", "/api/admin/rider-earnings/slots", {}],
  ];
  for (const [what, method, path, body] of apis) {
    const res = await call(ctx, method, path, body);
    out.push(`${what} ${res.status}`);
    if (res.status !== 403) bad.push(`${what} (${method} ${path}) → ${why(res)}`);
  }
  // The operator console itself opens (the rest of RBAC-007's positive half is shop verification, local tier).
  expect((await getAs("ops", "/admin")).status, "/admin for an operator").toBe(200);
  expect(bad, bad.join("\n")).toEqual([]);
  return out.join("; ");
}, { ...signed, partial: "approving / rejecting a shop as operator is in tests/qa/local/access-roles.spec.ts; the limited audit view is TC-RBAC-021" });

/* ======================================================== orders by role */

/** A delivery address for an account that has none (owners, riders, operators): customer 1's spot, saved through the API. */
async function ensureAddress(role: Role) {
  const existing = await defaultAddress(role);
  if (existing) return existing;
  const loc = need(world().location, "shop A's location in this site's test data");
  const res = await call(await as(role), "POST", "/api/addresses", {
    line1: `QA ${role} address ${RUN}`,
    area: "Kothrud",
    city: "Pune",
    state: "Maharashtra",
    pincode: loc.pincode,
    latitude: loc.lat + 0.004,
    longitude: loc.lng,
    addressType: "HOME",
    recipientName: `QA ${role}`,
    isDefault: true,
  });
  expectStatus(res, [200, 201], `add an address for ${role}`);
  return defaultAddress(role);
}

qa("TC-RBAC-016", "a shop owner places a personal order from another shop like any customer", async () => {
  await ensureAddress("shop");
  const listing = await sellable("B");
  const start = await walletBalance("shop");
  const order = await placeOrder({ role: "shop", method: "WALLET", listing });
  expect(order.status, "status").toBe("CONFIRMED");
  expect(order.body.orders[0].orderType, "order type").toBe("PERSONAL");
  expect(await walletBalance("shop"), "owner's wallet debited").toBe(start - order.totalPaise);
  stash(`rbac016-${RUN}`, order.id);
  return `owner A bought "${listing.name}" from ${listing.shopName}: ${order.orderNumber} CONFIRMED PERSONAL ₹${order.totalPaise / 100}`;
}, { ...signed, partial: "rider and operator personal orders need their wallets funded: tests/qa/local/access-roles.spec.ts" });

qa("TC-RBAC-017", "a shop owner places a B2B order for their own approved shop; the personal-order mobile/address rules do not apply", async () => {
  const A = await shopOf("A");
  const listing = await sellable("B");
  await emptyCart("shop");
  expectStatus(await addToCart("shop", listing.shopProductId, 1), [200, 201], "add shop B's product");
  const start = await walletBalance("shop");
  const res = await call(await as("shop"), "POST", "/api/checkout", {
    requestId: `qa-${RUN}-b2b`,
    orderType: "B2B",
    buyerShopId: A.id,
    addressId: null,
    paymentMethod: "WALLET",
    acknowledgeClosedShopIds: [listing.shopId],
  });
  expectStatus(res, 201, "B2B checkout");
  const order = res.body.orders[0];
  expect(order.orderType, "order type").toBe("B2B");
  expect(order.buyerShopId, "buyer shop").toBe(A.id);
  expect(await walletBalance("shop"), "debited once").toBe(start - order.totalPaise);
  return `${order.orderNumber} B2B for ${A.name} from ${listing.shopName}, no address sent, ₹${order.totalPaise / 100}`;
}, signed);

qa("TC-RBAC-018", "B2B is refused for a customer, for another owner's shop, for own-shop items, and PERSONAL with a buyer shop", async () => {
  const A = await shopOf("A");
  const B = await shopOf("B");
  const own = await sellable("A");
  const other = await sellable("B");
  const out: string[] = [];
  const tries: [string, Role, string, Record<string, unknown>][] = [
    ["customer B2B", "customer", other.shopProductId, { orderType: "B2B", buyerShopId: A.id }],
    ["owner A for shop B", "shop", other.shopProductId, { orderType: "B2B", buyerShopId: B.id }],
    ["owner A, own shop's items", "shop", own.shopProductId, { orderType: "B2B", buyerShopId: A.id }],
    ["PERSONAL with buyerShopId", "shop", other.shopProductId, { orderType: "PERSONAL", buyerShopId: A.id }],
  ];
  for (const [what, role, shopProductId, extra] of tries) {
    await emptyCart(role);
    expectStatus(await addToCart(role, shopProductId, 1), [200, 201], `${what}: add to cart`);
    const balance = await walletBalance(role);
    const before = ((await call(await as(role), "GET", "/api/orders")).body as unknown[]).length;
    const address = await defaultAddress(role);
    const res = await call(await as(role), "POST", "/api/checkout", {
      requestId: `qa-${RUN}-b2bx-${out.length}`,
      addressId: address?.id ?? null,
      paymentMethod: "WALLET",
      acknowledgeClosedShopIds: [A.id, B.id],
      ...extra,
    });
    out.push(`${what} ${res.status} ${errorCode(res)}`);
    expect([403, 422], `${what} — ${why(res)}`).toContain(res.status);
    expect(await walletBalance(role), `${what}: no debit`).toBe(balance);
    expect(((await call(await as(role), "GET", "/api/orders")).body as unknown[]).length, `${what}: no order`).toBe(before);
    await emptyCart(role);
  }
  return out.join("; ");
}, signed);

qa("TC-RBAC-019", "orders are visible by role: customer own only, shop own shop only, rider own jobs, operator and admin all shops", async ({ browser }) => {
  const a = await placeOrder({ method: "WALLET", listing: await sellable("A") });
  const b = await placeOrder({ method: "WALLET", listing: await sellable("B") });
  const mine = ((await call(await as("customer"), "GET", "/api/orders")).body as { id: string; userId: string }[]) ?? [];
  expect(mine.map((o) => o.id)).toEqual(expect.arrayContaining([a.id, b.id]));
  expect(new Set(mine.map((o) => o.userId)), "customer 1 sees only own orders").toEqual(new Set([(await me("customer")).id]));
  const theirs = ((await call(await as("customer2"), "GET", "/api/orders")).body as { id: string }[]) ?? [];
  expect(theirs.map((o) => o.id), "customer 2 sees neither").not.toEqual(expect.arrayContaining([a.id]));
  expect(theirs.map((o) => o.id)).not.toContain(b.id);
  const seen: string[] = [];
  const page = async (role: Role, path: string, shows: string[], hides: string[]) => {
    const { context, page: p } = await pageAs(browser, role);
    try {
      await p.goto(path, { waitUntil: "domcontentloaded" });
      await p.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
      for (const n of shows) await expect(p.locator("main"), `${role} on ${path} sees ${n}`).toContainText(n);
      for (const n of hides) await expect(p.locator("main"), `${role} on ${path} does not see ${n}`).not.toContainText(n);
      seen.push(`${role} ${path}: ${shows.length} shown, ${hides.length} hidden`);
    } finally {
      await context.close();
    }
  };
  await page("shop", "/shop/orders", [a.orderNumber], [b.orderNumber]);
  if (world().users.shopB) await page("shopB", "/shop/orders", [b.orderNumber], [a.orderNumber]);
  await page("ops", `/admin/orders`, [a.orderNumber, b.orderNumber], []);
  await page("admin", `/admin/orders`, [a.orderNumber, b.orderNumber], []);
  const riderView = await call(await as("rider"), "GET", "/api/delivery-partner/deliveries");
  expectStatus(riderView, 200, "rider deliveries");
  expect(riderView.text, "a rider sees no order that was not offered to them").not.toContain(a.id);
  expect(riderView.text).not.toContain(b.id);
  // Leave the wallet as it was.
  for (const o of [a, b]) await call(await as("customer"), "PATCH", `/api/orders/${o.id}/status`, { status: "CANCELLED", note: "QA visibility check" });
  return `${a.orderNumber} (A) and ${b.orderNumber} (B): ${seen.join("; ")}; customer 2 and the rider see neither`;
}, { ...signed, partial: "the society admin's deliveries view (no customer PII or contents) needs an order to a society address: TC-RBAC-019 society check below" });

qa("TC-RBAC-019", "the society admin's dashboard shows society deliveries without customer PII or order contents", async () => {
  const soc = need(societyId(), "a verified society in this site's test data");
  const res = await getAs("society", `/society/${soc}`);
  expect(res.status, `/society/{id} for its admin — ${brief(res)}`).toBe(200);
  const customer = await me("customer");
  const profile = (await call(await as("customer"), "GET", "/api/profile")).body;
  const phone = String(profile?.phone ?? profile?.phoneE164 ?? "").replace(/^\+91/, "");
  expect(res.text, "no customer email").not.toContain(customer.email);
  if (phone.length >= 10) expect(res.text, "no customer mobile").not.toContain(phone);
  const items = world().listings.packaged?.name;
  if (items) expect(res.text, "no order contents").not.toContain(items);
  const deliveries = /deliver/i.test(res.text);
  return `/society/${soc.slice(0, 8)} 200 for its admin; no customer email/mobile or item names; deliveries section ${deliveries ? "present" : "absent"}`;
}, { ...signed, partial: "no order is delivered to a society address in this run, so the deliveries list is empty: the check proves the page and the absence of PII, not a populated list" });

qa("TC-RBAC-020", "settlements by role: shop and rider own statements only, operator exceptions without totals, customer refused", async () => {
  const out: string[] = [];
  const shopFinance = await getAs("shop", "/shop/finance");
  expect(shopFinance.status, "/shop/finance for owner A").toBe(200);
  const A = await shopOf("A");
  const B = await shopOf("B");
  expect(shopFinance.text, "owner A's finance page is about shop A").toContain(A.name);
  expect(shopFinance.text, "and never names shop B").not.toContain(B.name);
  out.push("shop /shop/finance 200 (own shop only)");
  const earnings = await call(await as("rider"), "GET", "/api/delivery-partner/earnings");
  expectStatus(earnings, 200, "rider earnings");
  const rider2 = world().users.rider2 ? await call(await as("rider2"), "GET", "/api/delivery-partner/me") : null;
  if (rider2?.body?.id) expect(earnings.text, "rider 1's earnings carry no rider 2 id").not.toContain(String(rider2.body.id));
  out.push("rider earnings 200 (own)");
  const opsFinance = await getAs("ops", "/admin/finance");
  expect(redirectPath(opsFinance), "/admin/finance sends an operator to the exceptions").toBe("/admin/finance/exceptions");
  const exceptions = await getAs("ops", "/admin/finance/exceptions");
  expect(exceptions.status).toBe(200);
  for (const [path, label] of [["/api/finance/summary", "summary"], ["/api/finance/settlements", "settlements"], ["/api/finance/rider-payouts", "rider payouts"], ["/api/finance/ledger", "ledger"]] as const) {
    const res = await call(await as("ops"), "GET", path);
    expect(res.status, `operator ${label} — ${why(res)}`).toBe(403);
  }
  expectStatus(await call(await as("ops"), "GET", "/api/finance/exceptions"), 200, "operator exceptions API");
  out.push("operator: /admin/finance → exceptions; summary/settlements/payouts/ledger 403; exceptions 200");
  const customerPage = await getAs("customer", "/shop/finance");
  expect(refused(customerPage, "/shop/finance"), `/shop/finance for a customer — ${brief(customerPage)}`).toBe(true);
  for (const path of ["/api/finance/summary", `/api/shops/${A.id}/wallet`]) {
    const res = await call(await as("customer"), "GET", path);
    expect(res.status, `customer ${path} — ${why(res)}`).toBe(403);
  }
  const otherShop = await call(await as("shop"), "GET", `/api/shops/${B.id}/wallet`);
  expect(otherShop.status, "owner A reading shop B's wallet").toBe(403);
  out.push("customer: /shop/finance refused, finance summary 403; owner A on B's wallet 403");
  return out.join("; ");
}, signed);

qa("TC-RBAC-021", "audit log: admin sees every action with actor, role and before/after; operator a limited subset; customer and shop refused", async () => {
  // An operational action the operator may see: owner A edits their own shop.
  const A = await shopOf("A");
  const current = (await getAs("guest", `/api/shops/${A.id}`)).body;
  const description = String(current?.description ?? "");
  const edit = await call(await as("shop"), "PATCH", `/api/shops/${A.id}`, { description: `${description.replace(/ \[qa [a-z0-9]+\]$/, "")} [qa ${RUN}]`.trim() });
  expectStatus(edit, 200, "owner A edits own shop");
  const admin = await getAs("admin", "/admin/console/audit-log");
  expect(admin.status, "audit log for admin").toBe(200);
  expect(admin.text, "admin sees identity actions (role grants)").toMatch(/user\.role_granted|user\.role_changed|setting/);
  expect(admin.text, "admin sees the actor's role").toMatch(/SHOP_OWNER|ADMIN|OPERATOR/);
  expect(admin.text, "admin sees before/after values").toMatch(/Before → After/);
  const ops = await getAs("ops", "/admin/console/audit-log");
  expect(ops.status, "audit log for operator").toBe(200);
  expect(ops.text, "operator view is labelled limited").toMatch(/Showing operational entries/);
  expect(ops.text, "operator sees the operational shop edit").toMatch(/shop\.updated/);
  expect(ops.text, "operator does not see role changes").not.toMatch(/user\.role_granted|user\.role_changed|user\.role_switched|user\.suspended/);
  expect(ops.text, "operator does not see settings changes").not.toMatch(/setting\.changed|platform_setting/);
  for (const role of ["customer", "shop"] as const) {
    const res = await getAs(role, "/admin/console/audit-log");
    expect(refused(res, "/admin/console/audit-log"), `${role} on the audit log — ${brief(res)}`).toBe(true);
  }
  await call(await as("shop"), "PATCH", `/api/shops/${A.id}`, { description: description || null });
  return "admin: role grants with actor role and before/after; operator: 'operational entries' with shop.updated only; customer and shop redirected";
}, signed);

/* ======================================================== IDOR */

interface Victim {
  orderId: string;
  orderNumber: string;
  addressId: string;
  subscriptionId: string | null;
  returnId: string | null;
  notificationId: string | null;
}

qa("TC-RBAC-023", "IDOR sweep: customer 2 calling customer 1's address, order, rating, issue, subscription, return, notification and tracking ids is refused", async () => {
  // Customer 1 is the owner of the data (customer 2's address is outside every shop's radius, so it cannot order).
  const victim = await me("customer");
  const order = await placeOrder({ method: "WALLET" });
  const address = need(await defaultAddress("customer"), "customer 1's address");
  let subscriptionId: string | null = null;
  const milk = world().listings.milk;
  if (milk) {
    const tomorrow = new Date(Date.now() + 36 * 3600_000).toISOString().slice(0, 10);
    const sub = await call(await as("customer"), "POST", "/api/subscriptions", { shopProductId: milk.shopProductId, quantityMilli: 1000, frequency: "DAILY", weekdays: [], startDate: tomorrow, addressId: address.id, draft: true });
    if (sub.status === 201) subscriptionId = String(sub.body?.id ?? sub.body?.subscription?.id ?? "") || null;
  }
  // A return needs a delivered order.
  let returnId: string | null = null;
  const delivered = await placeOrder({ method: "WALLET" });
  await onlyRiderOnline("rider");
  await packOrder(delivered.id);
  await deliver(delivered.id);
  const items = ((await call(await as("customer"), "GET", "/api/orders")).body as { id: string; items: { id: string; quantityMilli?: number; quantity?: number }[] }[]).find((o) => o.id === delivered.id)?.items ?? [];
  if (items[0]) {
    const ret = await call(await as("customer"), "POST", `/api/orders/${delivered.id}/returns`, {
      reason: "MISSING_ITEM",
      comment: "QA IDOR check",
      items: [{ orderItemId: items[0].id, quantityMilli: items[0].quantityMilli ?? 1000, condition: "UNOPENED" }],
    });
    if (ret.status === 201) returnId = String(ret.body?.id ?? ret.body?.return?.id ?? "") || null;
  }
  const notes = await call(await as("customer"), "GET", "/api/notifications?unreadOnly=true");
  const notificationId = (notes.body?.notifications?.[0]?.id as string | undefined) ?? null;
  const v: Victim = { orderId: order.id, orderNumber: order.orderNumber, addressId: address.id, subscriptionId, returnId, notificationId };
  stash(`idor-${RUN}`, v);

  const attacker = await as("customer2");
  const probes: [string, "GET" | "POST" | "PATCH" | "DELETE", string, unknown?][] = [
    ["address GET", "GET", `/api/addresses/${v.addressId}`],
    ["address PATCH", "PATCH", `/api/addresses/${v.addressId}`, { line1: "hacked", city: "Pune", pincode: "411038" }],
    ["address DELETE", "DELETE", `/api/addresses/${v.addressId}`],
    ["order cancel", "PATCH", `/api/orders/${v.orderId}/status`, { status: "CANCELLED", note: "IDOR" }],
    ["order rating GET", "GET", `/api/orders/${delivered.id}/rating`],
    ["order rating POST", "POST", `/api/orders/${delivered.id}/rating`, { target: "SHOP", score: 1, comment: "IDOR" }],
    ["order issue", "POST", `/api/orders/${v.orderId}/issue`, { category: "ORDER", description: "IDOR probe from another customer" }],
    ["tracking", "GET", `/api/tracking/${v.orderId}`],
    ["delivery code", "POST", `/api/orders/${v.orderId}/delivery-code`, {}],
    ["cancellation quote", "GET", `/api/orders/${v.orderId}/cancellation-quote`],
    ["invoice", "GET", `/api/orders/${delivered.id}/invoice`],
    ["refunds", "GET", `/api/orders/${delivered.id}/refunds`],
    ["return request", "POST", `/api/orders/${delivered.id}/returns`, { reason: "MISSING_ITEM", items: items[0] ? [{ orderItemId: items[0].id, quantityMilli: 1000, condition: "UNOPENED" }] : [] }],
    ...(v.subscriptionId
      ? ([
          ["subscription GET", "GET", `/api/subscriptions/${v.subscriptionId}`],
          ["subscription PATCH", "PATCH", `/api/subscriptions/${v.subscriptionId}`, { quantityMilli: 5000 }],
          ["subscription DELETE", "DELETE", `/api/subscriptions/${v.subscriptionId}`],
          ["subscription pause", "POST", `/api/subscriptions/${v.subscriptionId}/pause`, {}],
          ["subscription skip", "POST", `/api/subscriptions/${v.subscriptionId}/skip`, { date: new Date(Date.now() + 60 * 3600_000).toISOString().slice(0, 10) }],
          ["subscription calendar", "GET", `/api/subscriptions/${v.subscriptionId}/calendar`],
          ["subscription history", "GET", `/api/subscriptions/${v.subscriptionId}/history`],
          ["subscription activate", "POST", `/api/subscriptions/${v.subscriptionId}/activate`, {}],
        ] as [string, "GET" | "POST" | "PATCH" | "DELETE", string, unknown?][])
      : []),
    ...(v.returnId
      ? ([
          ["return GET", "GET", `/api/returns/${v.returnId}`],
          ["return cancel", "PATCH", `/api/returns/${v.returnId}`, { action: "cancel", note: "IDOR" }],
        ] as [string, "GET" | "POST" | "PATCH" | "DELETE", string, unknown?][])
      : []),
  ];
  const bad: string[] = [];
  const out: string[] = [];
  const leaks = [victim.email, v.orderNumber, "QA Flat 1", "Karve Road"];
  for (const [what, method, path, body] of probes) {
    const res = await call(attacker, method, path, body);
    out.push(`${what} ${res.status}`);
    if (res.status !== 403 && res.status !== 404) bad.push(`${what} (${method} ${path}) → ${why(res)}`);
    const leaked = leaks.filter((l) => l && res.text.includes(l));
    if (leaked.length) bad.push(`${what} returned customer 1's data: ${leaked.join(", ")}`);
  }
  if (v.notificationId) {
    const mark = await call(attacker, "PATCH", "/api/notifications", { id: v.notificationId });
    out.push(`notification mark-read ${mark.status}`);
    const still = await call(await as("customer"), "GET", "/api/notifications?unreadOnly=true");
    expect((still.body?.notifications ?? []).map((n: { id: string }) => n.id), "customer 1's notification still unread").toContain(v.notificationId);
  }
  // Nothing changed.
  expect((await orderAs("customer", v.orderId))?.status, "order not cancelled").toBe("CONFIRMED");
  expect((await defaultAddress("customer"))?.id, "address still there").toBe(v.addressId);
  if (v.subscriptionId) {
    const sub = await call(await as("customer"), "GET", `/api/subscriptions/${v.subscriptionId}`);
    expectStatus(sub, 200, "customer 1's subscription");
    expect(sub.text, "quantity unchanged").not.toMatch(/"quantityMilli":\s*5000/);
  }
  expect(bad, bad.join("\n")).toEqual([]);
  // Leave customer 1 tidy: cancel the open order and the draft subscription.
  await call(await as("customer"), "PATCH", `/api/orders/${v.orderId}/status`, { status: "CANCELLED", note: "QA IDOR check done" });
  if (v.subscriptionId) await call(await as("customer"), "DELETE", `/api/subscriptions/${v.subscriptionId}`);
  return `${probes.length} calls as customer 2 refused (${out.join(", ")}); ids: order, address${v.subscriptionId ? ", subscription" : ""}${v.returnId ? ", return" : ""}${v.notificationId ? ", notification" : ""}; nothing changed`;
}, { ...signed, partial: "the direction is customer 2 → customer 1 (customer 2 cannot order: its address is outside every radius)" });

/* ======================================================== analytics */

qa("TC-KPI-002", "shop analytics: owner A sees own shop; another shop's KPIs and a customer are refused 403", async () => {
  const A = await shopOf("A");
  const B = await shopOf("B");
  const page = await getAs("shop", "/shop/analytics");
  expect(page.status, "/shop/analytics for owner A").toBe(200);
  expect(page.text).toContain(A.name);
  const own = await call(await as("shop"), "GET", `/api/analytics/kpis?shopId=${A.id}`);
  expectStatus(own, 200, "own shop KPIs");
  const other = await call(await as("shop"), "GET", `/api/analytics/kpis?shopId=${B.id}`);
  expect(other.status, `owner A, shop B's KPIs — ${why(other)}`).toBe(403);
  const all = await call(await as("shop"), "GET", "/api/analytics/kpis");
  expect(all.status, `owner A, marketplace KPIs — ${why(all)}`).toBe(403);
  for (const path of [`/api/analytics/kpis?shopId=${A.id}`, "/api/analytics/kpis"]) {
    const res = await call(await as("customer"), "GET", path);
    expect(res.status, `customer ${path} — ${why(res)}`).toBe(403);
  }
  const customerPage = await getAs("customer", "/shop/analytics");
  expect(refused(customerPage, "/shop/analytics"), `/shop/analytics for a customer — ${brief(customerPage)}`).toBe(true);
  return `own KPIs 200 (${Object.keys(own.body ?? {}).slice(0, 5).join(", ")}…); shop B 403; marketplace 403; customer 403 and page ${brief(customerPage)}`;
}, signed);

/* ======================================================== security */

qa("TC-SEC-002", "signed-in id routes: 'abc', an over-long id and SQL-like text give 404/422, never a 500", async () => {
  const ids = ["abc", "9".repeat(80), "1' OR '1'='1", "%27%3B--"];
  const routes: [Role, string][] = [
    ["customer", "/api/orders/{x}/status"],
    ["customer", "/api/orders/{x}/rating"],
    ["customer", "/api/orders/{x}/cancellation-quote"],
    ["customer", "/api/addresses/{x}"],
    ["customer", "/api/subscriptions/{x}"],
    ["customer", "/api/subscriptions/{x}/calendar"],
    ["customer", "/api/returns/{x}"],
    ["customer", "/api/tracking/{x}"],
    ["customer", "/api/cart/items/{x}"],
    ["shop", "/api/shops/{x}/inventory"],
    ["shop", "/api/shop-products/{x}"],
    ["shop", "/api/shops/{x}/products"],
    ["rider", "/api/delivery-orders/{x}"],
    ["admin", "/api/users/{x}/suspend"],
    ["admin", "/api/users/{x}/reinstate"],
    ["admin", "/api/users/{x}/privileges"],
    ["ops", "/api/shops/{x}/approve"],
    ["ops", "/api/shops/{x}/reject"],
    ["ops", "/api/admin/risk/{x}"],
    ["admin", "/api/invoices/{x}/pdf"],
  ];
  const five: string[] = [];
  let total = 0;
  for (const [role, template] of routes) {
    for (const id of ids) {
      const path = template.replace("{x}", encodeURIComponent(id));
      for (const method of ["GET", "PATCH", "POST"] as const) {
        total += 1;
        const res = await call(await as(role), method, path, method === "GET" ? undefined : { reason: "QA malformed id", status: "CANCELLED", quantity: 1 });
        if (res.status >= 500) five.push(`${method} ${template} (${role})`);
      }
    }
  }
  // One line per route: how many of the malformed ids it answered with a 5xx.
  const grouped = (lines: string[]) => [...new Set(lines)].map((l) => `${l} ×${lines.filter((x) => x === l).length}`);
  // D-02 (known): a malformed id reaches PostgreSQL as a uuid and the generic handler answers 500.
  const all = grouped(five);
  expect(all, `D-02 (known) — ${all.length} routes answer 500 for a malformed id: ${all.join("; ")}`).toEqual([]);
  return `${total} malformed-id calls: no 5xx`;
}, { ...signed, partial: "405 for a method a route does not export counts as refused" });

qa("TC-SEC-004", "server-assigned fields are ignored: a checkout total and prices, a profile role", async () => {
  const listing = await sellable("A");
  await emptyCart();
  expectStatus(await addToCart("customer", listing.shopProductId, 1), [200, 201], "add to cart");
  const address = await defaultAddress();
  const start = await walletBalance();
  const res = await call(await as("customer"), "POST", "/api/checkout", {
    requestId: `qa-${RUN}-sec004`,
    addressId: address?.id ?? null,
    paymentMethod: "WALLET",
    acknowledgeClosedShopIds: [listing.shopId],
    totalPaise: 1,
    subtotalPaise: 1,
    unitPricePaise: 1,
    deliveryFeePaise: 0,
    discountPaise: 99_999,
    status: "DELIVERED",
    userId: (await me("customer2")).id,
  });
  expectStatus(res, 201, "checkout with injected money fields");
  const order = res.body.orders[0];
  expect(order.totalPaise, "total is the server's price").toBeGreaterThanOrEqual(listing.pricePaise ?? 1);
  expect(order.status, "status is server-assigned").toBe("CONFIRMED");
  expect(await walletBalance(), "debited the server total").toBe(start - order.totalPaise);
  const listed = await orderAs("customer", order.id);
  expect(listed, "the order belongs to the caller, not the injected userId").not.toBeNull();
  await call(await as("customer"), "PATCH", `/api/orders/${order.id}/status`, { status: "CANCELLED", note: "QA" });
  const profile = await call(await as("customer"), "PATCH", "/api/profile", { role: "ADMIN", status: "ACTIVE", email: "evil@test.local", name: "QA Customer One" });
  expect(profile.status, `PATCH /api/profile with role — ${why(profile)}`).toBeLessThan(500);
  const session = await call(await as("customer"), "GET", "/api/auth/session");
  expect(session.body?.user?.role, "role unchanged").toBe("CUSTOMER");
  expect(session.body?.user?.email, "email unchanged").toBe((await me("customer")).email);
  return `checkout with totalPaise=1 → ${order.orderNumber} ₹${order.totalPaise / 100} at the server price; profile role/email → ${profile.status}, still CUSTOMER`;
}, { ...signed, partial: "POST /api/shops with status/classification/ownerId registers a shop (role change): tests/qa/local/access-roles.spec.ts" });

qa("TC-SEC-005", "shop, rider, order and user APIs carry no PAN, bank numbers, identity numbers, codes or secrets", async () => {
  const A = await shopOf("A");
  const order = unstash<PlacedOrder>(`sec005-${RUN}`) ?? (await placeOrder({ method: "WALLET" }));
  stash(`sec005-${RUN}`, order);
  const reads: [Role | "guest", string][] = [
    ["guest", `/api/shops/${A.id}`],
    ["guest", `/api/shops/${A.id}/products?limit=20`],
    ["customer", "/api/orders"],
    ["customer", `/api/tracking/${order.id}`],
    ["customer", "/api/profile"],
    ["customer", "/api/auth/session"],
    ["customer", "/api/wallet"],
    ["shop", `/api/shops/${A.id}`],
    ["shop", `/api/shops/${A.id}/bank-account`],
    ["shop", `/api/shops/${A.id}/documents`],
    ["shop", `/api/shops/${A.id}/verifications`],
    ["shop", "/api/bank-account"],
    ["rider", "/api/delivery-partner/me"],
    ["rider", "/api/delivery-partner/deliveries"],
    ["rider", "/api/delivery-partner/earnings"],
    ["admin", "/api/users?limit=20"],
    ["admin", `/api/users/${(await me("customer")).id}/privileges`],
    ["ops", `/api/shops/${A.id}`],
  ];
  const leaks: string[] = [];
  const PATTERNS: [string, RegExp][] = [
    ["full PAN", /"[^"]*pan[^"]*"\s*:\s*"[A-Z]{5}\d{4}[A-Z]"/i],
    ["bank account number", /"(accountNumber|bankAccountNumber|account_number)"\s*:\s*"\d{9,18}"/i],
    ["Aadhaar", /"[^"]*aadhaar[^"]*"\s*:\s*"\d{12}"/i],
    ["code / OTP value", /"(otp|otpHash|code|codeHash|pickupCode|deliveryOtp|deliveryOtpHash|handoverCode|pin)"\s*:\s*"[^"]+"/i],
    ["secret / password / token", /"[^"]*(password|secret|apiKey|api_key|accessToken|refreshToken|clientSecret)[^"]*"\s*:\s*"[^"]+"/i],
    ["hash", /"[^"]*(Hash|_hash)"\s*:\s*"[^"]{20,}"/],
  ];
  for (const [role, path] of reads) {
    const res = await getAs(role, path);
    if (res.status >= 500) leaks.push(`${role} ${path} → ${res.status}`);
    for (const [what, re] of PATTERNS) {
      const m = res.text.match(re);
      if (m) leaks.push(`${role} ${path}: ${what} (${m[0].slice(0, 60)})`);
    }
  }
  await call(await as("customer"), "PATCH", `/api/orders/${order.id}/status`, { status: "CANCELLED", note: "QA" });
  expect(leaks, leaks.join("\n")).toEqual([]);
  return `${reads.length} responses across guest, customer, shop, rider, admin and operator: no PAN, bank number, Aadhaar, code, secret or hash`;
}, { ...signed, partial: "the seeded shops have no PAN or bank account on file, so masking of a stored one is checked where they are added (KYC specs)" });

/* ======================================================== cart left clean */

qa("TC-RBAC-018", "carts are left empty after the B2B checks", async () => {
  for (const role of ["customer", "shop"] as const) {
    await emptyCart(role);
    expect(await cartLines(role)).toEqual([]);
  }
  return "customer and owner A carts empty";
}, signed);

/* ======================================================== mixed: who may see a user record */

qa("TC-RBAC-003", "the user directory API is staff-only: customer, shop owner and rider refused", async () => {
  const out: string[] = [];
  for (const role of ["customer", "shop", "rider", "society"] as const) {
    if (!world().users[role]) continue;
    const res = await call(await as(role), "GET", "/api/users?limit=5");
    expect(res.status, `${role} GET /api/users — ${why(res)}`).toBe(403);
    out.push(`${role} 403`);
  }
  const ops = await call(await as("ops"), "GET", "/api/users?limit=5");
  expectStatus(ops, 200, "operator may list users (USER_VIEW_ANY)");
  out.push("ops 200");
  return out.join(", ");
}, signed);
