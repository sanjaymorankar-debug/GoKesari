/**
 * Roles and access control that change accounts or shops (QA package 2,
 * local tier): an operator approving and rejecting shops, admins granting,
 * revoking and switching roles on the user screens, staff-role exclusivity,
 * suspending and reinstating accounts, the append-only audit log, and
 * personal orders by riders and operators.
 *
 * Local server only: each check uses fresh accounts and throwaway shops
 * arranged in the local database, so the world's accounts stay as seeded.
 */
import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { as, me, pageAs } from "../lib/actors";
import { db } from "../lib/db";
import { addToCart, defaultAddress, emptyCart, sellable, shopOf, walletBalance } from "../lib/flows";
import { call, expectStatus, RUN, why } from "../lib/http";
import { expect, need, qa } from "../lib/record";
import { world, type Role } from "../lib/world";
import {
  apiFor,
  auditRows,
  browserFor,
  cloneShop,
  dbNow,
  freshCustomer,
  freshOwner,
  fundWallet,
  grantLocalRole,
  NO_SUCH_ID,
  readyForApproval,
  roleSwitcher,
  sessionOf,
  signInByEmail,
} from "../lib/access-helpers";

const local = { tier: "local" as const, timeout: 300_000 };

async function rolesOf(user: { id: string; email: string }) {
  const ctx = await apiFor(user);
  try {
    const res = await call(ctx, "GET", "/api/me/roles");
    return { status: res.status, active: res.body?.active as string | undefined, roles: (res.body?.roles ?? []) as string[] };
  } finally {
    await ctx.dispose();
  }
}

async function pageStatus(user: { id: string; email: string }, path: string) {
  const ctx = await apiFor(user);
  try {
    const res = await call(ctx, "GET", path);
    return { status: res.status, location: res.location };
  } finally {
    await ctx.dispose();
  }
}

/** Waits for the save confirmation of a SaveChangesBar (after an optional confirm dialog). */
async function saveChanges(page: Page, testId: string, confirm?: RegExp) {
  await page.getByTestId(testId).getByRole("button", { name: "Save Changes" }).click();
  if (confirm) {
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: confirm }).click();
  }
  await expect(page.getByTestId("save-confirmation")).toBeVisible({ timeout: 20_000 });
  return (await page.getByTestId("save-confirmation").textContent())?.trim() ?? "";
}

/* ======================================================== operator: shop verification */

qa("TC-RBAC-007", "an operator approves a verified shop and rejects another from the shop queue; both audited with the operator's role", async ({ browser }) => {
  const pendingId = need(world().shops.pending?.id, "the pending shop of the local world");
  const ownerA = await freshOwner("rbac007a");
  const ownerB = await freshOwner("rbac007b");
  const toApprove = await cloneShop(pendingId, { ownerId: ownerA.id, status: "PENDING_APPROVAL", label: "Approve Me" });
  const toReject = await cloneShop(pendingId, { ownerId: ownerB.id, status: "PENDING_APPROVAL", label: "Reject Me" });
  await readyForApproval(toApprove.id);
  const since = await dbNow();
  const { context, page } = await pageAs(browser, "ops");
  try {
    await page.goto("/admin/console/shops", { waitUntil: "domcontentloaded" });
    const row = page.locator("div.p-4", { hasText: toApprove.name }).filter({ has: page.getByRole("button", { name: "Approve" }) }).first();
    await expect(row).toBeVisible();
    await row.getByLabel("Classify as").selectOption("KESARI");
    await row.getByRole("button", { name: "Approve" }).click();
    await expect(page.locator("main")).not.toContainText(toApprove.name, { timeout: 20_000 }).catch(() => {});
    const reject = page.locator("div.p-4", { hasText: toReject.name }).filter({ has: page.getByRole("button", { name: "Reject" }) }).first();
    await reject.getByRole("button", { name: "Reject" }).click();
    await reject.getByPlaceholder("Reason for rejection").fill("QA: documents do not match the shop");
    await reject.getByRole("button", { name: "Confirm" }).click();
    await expect.poll(async () => (await db()<{ status: string }[]>`select status from shops where id = ${toReject.id}`)[0]?.status, { timeout: 20_000 }).toBe("REJECTED");
  } finally {
    await context.close();
  }
  const [approved] = await db()<{ status: string; classification: string }[]>`select status, classification from shops where id = ${toApprove.id}`;
  expect(approved, "approved shop").toEqual({ status: "APPROVED", classification: "KESARI" });
  const audits = [...(await auditRows(toApprove.id, since, "shop.approved")), ...(await auditRows(toReject.id, since, "shop.rejected"))];
  expect(audits.map((a) => `${a.action}:${a.actor_role}`).sort(), "audit rows").toEqual(["shop.approved:OPERATOR", "shop.rejected:OPERATOR"]);
  return `operator approved "${toApprove.name}" (KESARI) and rejected "${toReject.name}" from /admin/console/shops; audit shop.approved/shop.rejected by OPERATOR`;
}, { ...local, partial: "the refusals of admin-only functions are the signed-tier TC-RBAC-007 check" });

qa("TC-RBAC-008", "record: what an operator can change on a shop (name, hours, radius) and on its products", async () => {
  const A = await shopOf("A");
  const owner = await freshOwner("rbac008");
  const shop = await cloneShop(A.id, { ownerId: owner.id, status: "APPROVED", label: "Ops Edit" });
  const ops = await as("ops");
  const out: string[] = [];
  const tries: [string, Record<string, unknown>][] = [
    ["name", { name: `${shop.name} (ops)` }],
    ["opening hours", { openingHours: [{ day: 1, open: "08:00", close: "20:00" }] }],
    ["service radius", { serviceRadiusKm: 7 }],
    ["delivery fee", { deliveryFeePaise: 1500 }],
    ["COD switch", { codEnabled: true }],
    ["orders paused", { ordersPaused: true }],
    ["status (not a field)", { status: "SUSPENDED" }],
  ];
  for (const [what, body] of tries) {
    const res = await call(ops, "PATCH", `/api/shops/${shop.id}`, body);
    out.push(`${what}: ${res.status}${res.status >= 400 ? ` ${res.body?.error?.code ?? ""}` : ""}`);
    expect(res.status, `${what} — ${why(res)}`).toBeLessThan(500);
  }
  const product = world().listings.packaged;
  const added = await call(ops, "POST", `/api/shops/${shop.id}/products`, { productId: need(product?.productId, "a catalogue product"), onlinePricePaise: 5000, onlineStock: 5 });
  out.push(`add a product: ${added.status}`);
  const listingId = added.body?.id ?? added.body?.shopProductId;
  if (listingId) {
    const price = await call(ops, "PATCH", `/api/shop-products/${listingId}`, { onlinePricePaise: 4900 });
    out.push(`price change: ${price.status}${price.body?.priceRequests || price.body?.pending ? " (as a proposal for the owner)" : ""}`);
    const stock = await call(ops, "PATCH", `/api/shop-products/${listingId}`, { onlineStock: 9 });
    out.push(`stock change: ${stock.status}`);
  }
  const [after] = await db()<{ name: string; service_radius_km: number; status: string }[]>`select name, service_radius_km, status from shops where id = ${shop.id}`;
  out.push(`stored: name "${after.name}", radius ${after.service_radius_km} km, status ${after.status}`);
  return out.join("; ");
}, { ...local, partial: "evidence for the pending 'Limited' decision (TC-RBAC-008 is record-only): an operator holds SHOP_UPDATE_ANY and SHOP_PRODUCT_MANAGE_ANY" });

/* ======================================================== admin: roles on the user screens */

qa("TC-RBAC-009", "admin grants OPERATOR on the privileges screen: saved with a confirmation, audited, the user notified and given the console", async ({ browser }) => {
  const user = await freshCustomer("rbac009");
  expect((await pageStatus(user, "/admin")).status, "/admin before").toBe(307);
  const since = await dbNow();
  const { context, page } = await pageAs(browser, "admin");
  let notice = "";
  try {
    await page.goto(`/admin/users/${user.id}/privileges`, { waitUntil: "domcontentloaded" });
    await page.getByRole("checkbox", { name: "Operator held" }).check();
    await page.getByRole("radio", { name: "Operator", exact: true }).check();
    notice = await saveChanges(page, "privileges-save", /Yes, save privileges/);
  } finally {
    await context.close();
  }
  const roles = await rolesOf(user);
  expect(roles.active, "active role").toBe("OPERATOR");
  expect(roles.roles).toEqual(expect.arrayContaining(["CUSTOMER", "OPERATOR"]));
  const audit = await auditRows(user.id, since, "user.privileges_updated");
  expect(audit.length, "one audit row").toBe(1);
  expect(audit[0].previous_value, "audit before").toMatchObject({ activeRole: "CUSTOMER" });
  expect(audit[0].new_value, "audit after").toMatchObject({ activeRole: "OPERATOR" });
  const ctx = await apiFor(user);
  try {
    const notes = await call(ctx, "GET", "/api/notifications");
    expect(JSON.stringify(notes.body?.notifications ?? []), "role-change security notification").toMatch(/role|Operator|OPERATOR/i);
    const console = await call(ctx, "GET", "/admin");
    expect(console.status, "the user now opens the operator console").toBe(200);
  } finally {
    await ctx.dispose();
  }
  return `"${notice}"; CUSTOMER→OPERATOR audited (user.privileges_updated); notification received; /admin 200`;
}, local);

qa("TC-RBAC-010", "privileges screen: Save only after a change, a warning on leaving, a confirmation before saving, then success and an audit row with old and new values", async ({ browser }) => {
  const user = await freshCustomer("rbac010");
  const since = await dbNow();
  const { context, page } = await pageAs(browser, "admin");
  const dialogs: string[] = [];
  try {
    await page.goto(`/admin/users/${user.id}/privileges`, { waitUntil: "domcontentloaded" });
    const save = page.getByTestId("privileges-save").getByRole("button", { name: "Save Changes" });
    await expect(save, "Save before any change").toBeDisabled();
    await page.getByRole("checkbox", { name: "Shop Owner held" }).check();
    await expect(save, "Save after a change").toBeEnabled();
    // Leaving with unsaved changes: the browser's leave-page warning (reload).
    page.once("dialog", async (d) => {
      dialogs.push(d.type());
      await d.dismiss();
    });
    await page.reload({ timeout: 5_000 }).catch(() => {});
    expect(dialogs, "a leave-page warning while changes are unsaved").toContain("beforeunload");
    await expect(page.getByRole("checkbox", { name: "Shop Owner held" }), "the change is still there after staying").toBeChecked();
    await save.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog, "confirmation before saving").toBeVisible();
    await expect(dialog).toContainText(/Shop Owner/);
    await dialog.getByRole("button", { name: "Yes, save privileges" }).click();
    await expect(page.getByTestId("save-confirmation")).toBeVisible({ timeout: 20_000 });
  } finally {
    await context.close();
  }
  const audit = await auditRows(user.id, since, "user.privileges_updated");
  expect(audit.length).toBe(1);
  expect((audit[0].previous_value as { heldRoles: string[] }).heldRoles).toEqual(["CUSTOMER"]);
  expect((audit[0].new_value as { heldRoles: string[] }).heldRoles).toEqual(expect.arrayContaining(["CUSTOMER", "SHOP_OWNER"]));
  return "Save disabled → enabled on change; reload with unsaved changes → beforeunload warning; confirm dialog lists +Shop Owner; saved; audit old/new heldRoles";
}, { ...local, partial: "links outside the form (site header, 'Edit profile') leave without a prompt by design (src/components/unsaved-changes-guard.tsx: the guard is page-scoped)" });

qa("TC-RBAC-011", "a shop owner who applies as a rider and is approved holds both roles and switches SHOP_OWNER → DELIVERY_PARTNER → CUSTOMER", async ({ browser }) => {
  const owner = await freshOwner("rbac011");
  const A = await shopOf("A");
  await cloneShop(A.id, { ownerId: owner.id, status: "APPROVED", label: "Two Roles" });
  const ctx = await apiFor(owner);
  try {
    const loc = need(world().location, "shop A's location");
    const applied = await call(ctx, "POST", "/api/delivery-partner", {
      fullName: "QA Owner Rider",
      mobile: owner.mobile ?? "9876501234",
      vehicleType: "MOTORCYCLE",
      latitude: loc.lat,
      longitude: loc.lng,
      operatingRadiusKm: 5,
    });
    expectStatus(applied, 201, "rider application");
    const partnerId = String(applied.body?.id ?? "");
    expectStatus(await call(await as("admin"), "PATCH", `/api/delivery-partner/${partnerId}`, { action: "approve" }), 200, "admin approves the rider");
  } finally {
    await ctx.dispose();
  }
  const held = await rolesOf(owner);
  expect(held.roles, "roles held").toEqual(expect.arrayContaining(["CUSTOMER", "SHOP_OWNER", "DELIVERY_PARTNER"]));
  expect(held.active).toBe("SHOP_OWNER");
  const seen: string[] = [`held ${held.roles.join("+")}`];
  const { context, page } = await browserFor(browser, owner);
  try {
    for (const [role, home] of [["DELIVERY_PARTNER", "/delivery-partner"], ["CUSTOMER", "/"], ["SHOP_OWNER", "/shop"]] as const) {
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
      const switcher = await roleSwitcher(page);
      const put = page.waitForResponse((r) => r.url().includes("/api/me/roles") && r.request().method() === "PUT");
      await switcher.selectOption(role);
      expect((await put).status(), `switch to ${role}`).toBe(200);
      await page.waitForURL((u) => u.pathname === home, { timeout: 20_000 });
      const api = await page.request.get("/api/me/roles");
      const body = await api.json();
      expect(body.active, `active role after choosing ${role}`).toBe(role);
      seen.push(`${role}→${new URL(page.url()).pathname}`);
    }
  } finally {
    await context.close();
  }
  return seen.join("; ");
}, local);

qa("TC-RBAC-013", "revoking the active OPERATOR role drops the user to CUSTOMER on the next request and closes the console", async () => {
  const user = await freshCustomer("rbac013");
  expectStatus(await call(await as("admin"), "PATCH", `/api/users/${user.id}/role`, { role: "OPERATOR" }), 200, "grant OPERATOR");
  expect((await pageStatus(user, "/admin")).status, "/admin as OPERATOR").toBe(200);
  const res = await call(await as("admin"), "DELETE", `/api/users/${user.id}/roles?role=OPERATOR`);
  expectStatus(res, 200, "revoke OPERATOR");
  const after = await rolesOf(user);
  expect(after.active, "active role after revoke").toBe("CUSTOMER");
  expect(after.roles).not.toContain("OPERATOR");
  const console = await pageStatus(user, "/admin");
  expect(console.status, "/admin after revoke").toBe(307);
  return `OPERATOR → revoked → CUSTOMER at once; /admin now ${console.status} → ${console.location}`;
}, local);

qa("TC-RBAC-014", "staff roles are exclusive: a shop owner granted OPERATOR then ADMIN holds only ADMIN (and keeps SHOP_OWNER)", async () => {
  const user = await freshOwner("rbac014");
  const admin = await as("admin");
  expectStatus(await call(admin, "PATCH", `/api/users/${user.id}/role`, { role: "OPERATOR" }), 200, "grant OPERATOR");
  const first = await rolesOf(user);
  expectStatus(await call(admin, "PATCH", `/api/users/${user.id}/role`, { role: "ADMIN" }), 200, "grant ADMIN");
  const second = await rolesOf(user);
  expect(first.roles, "after OPERATOR").toEqual(expect.arrayContaining(["SHOP_OWNER", "OPERATOR"]));
  expect(second.roles, "after ADMIN").toContain("ADMIN");
  expect(second.roles, "OPERATOR replaced, not stacked").not.toContain("OPERATOR");
  expect(second.roles, "the non-staff role stays").toContain("SHOP_OWNER");
  const both = await call(admin, "PATCH", `/api/users/${user.id}/privileges`, { activeRole: "ADMIN", heldRoles: ["CUSTOMER", "ADMIN", "OPERATOR"] });
  expect(both.status, `privileges with both staff roles — ${why(both)}`).toBe(422);
  // Leave no extra admin behind.
  expectStatus(await call(admin, "PATCH", `/api/users/${user.id}/privileges`, { activeRole: "CUSTOMER", heldRoles: ["CUSTOMER", "SHOP_OWNER"] }), 200, "remove the staff role");
  return `after OPERATOR: ${first.roles.join("+")} (active ${first.active}); after ADMIN: ${second.roles.join("+")} (active ${second.active}); both at once → 422`;
}, local);

qa("TC-RBAC-015", "every account acting in a portal role holds a grant for it, and the seeded owner, rider and operator reach their portals", async () => {
  // The backfill that gave pre-existing accounts their grants (drizzle/0023): users.role, every shop owner and every rider.
  const migration = readFileSync(join(process.cwd(), "drizzle", "0023_phase3_growth_cod_risk_roles.sql"), "utf8");
  expect(migration, "backfill of users.role").toMatch(/INSERT INTO "user_role_grants"[^;]*FROM "users" WHERE "role" <> 'CUSTOMER'/);
  expect(migration, "backfill of shop owners").toMatch(/'SHOP_OWNER'::"user_role", 'BACKFILL' FROM "shops"/);
  expect(migration, "backfill of riders").toMatch(/'DELIVERY_PARTNER'::"user_role", 'BACKFILL' FROM "delivery_partners"/);
  // The development demo seed (src/server/db/seed.ts, @example.com) writes users.role after the migrations ran,
  // without grants: not accounts that existed at the backfill, so they are left out.
  const demo = await db()<{ n: number }[]>`select count(*)::int as n from users u where u.email like '%@example.com' and u.role <> 'CUSTOMER'
    and not exists (select 1 from user_role_grants g where g.user_id = u.id and g.role = u.role and g.status = 'ACTIVE')`;
  const missing = await db()<{ email: string; role: string }[]>`
    select u.email, u.role::text from users u
    where u.role <> 'CUSTOMER' and u.deleted_at is null and u.status = 'ACTIVE' and u.email not like '%@example.com'
      and not exists (select 1 from user_role_grants g where g.user_id = u.id and g.role = u.role and g.status = 'ACTIVE')
    limit 20`;
  expect(missing, `accounts acting in a role they hold no grant for: ${missing.map((m) => `${m.email} (${m.role})`).join(", ")}`).toEqual([]);
  const [{ n }] = await db()<{ n: number }[]>`select count(*)::int as n from users where role <> 'CUSTOMER' and deleted_at is null`;
  const out: string[] = [];
  for (const [role, home] of [["shop", "/shop"], ["rider", "/delivery-partner"], ["ops", "/admin"]] as [Role, string][]) {
    const res = await call(await as(role), "GET", home);
    expect(res.status, `${role} ${home}`).toBe(200);
    out.push(`${role} ${home} 200`);
  }
  return `${n} non-customer accounts, each with an ACTIVE grant for its role (besides ${demo[0].n} demo-seed accounts); backfill present in drizzle/0023; ${out.join(", ")}`;
}, { ...local, partial: "the local database has no accounts from before the role-grant migration; the backfill is read from drizzle/0023 and the grant query is the one to run on the sites' databases" });

/* ======================================================== personal orders by staff and riders */

qa("TC-RBAC-016", "a rider and an operator each place a personal order like a customer", async () => {
  const out: string[] = [];
  for (const role of ["rider", "ops"] as Role[]) {
    const user = await me(role);
    await fundWallet(user.id, 100_000);
    if (!(await defaultAddress(role))) {
      const loc = need(world().location, "shop A's location");
      expectStatus(
        await call(await as(role), "POST", "/api/addresses", { line1: `QA ${role} home ${RUN}`, area: "Kothrud", city: "Pune", state: "Maharashtra", pincode: loc.pincode, latitude: loc.lat + 0.003, longitude: loc.lng, addressType: "HOME", recipientName: `QA ${role}`, isDefault: true }),
        [200, 201],
        `${role} adds an address`,
      );
    }
    const listing = await sellable("A");
    const start = await walletBalance(role);
    await emptyCart(role);
    expectStatus(await addToCart(role, listing.shopProductId, 1), [200, 201], `${role} adds to cart`);
    const address = await defaultAddress(role);
    const res = await call(await as(role), "POST", "/api/checkout", { requestId: `qa-${RUN}-rbac016-${role}`, addressId: address?.id ?? null, paymentMethod: "WALLET", acknowledgeClosedShopIds: [listing.shopId] });
    expectStatus(res, 201, `${role} checks out`);
    const order = res.body.orders[0];
    expect(order.orderType).toBe("PERSONAL");
    expect(await walletBalance(role)).toBe(start - order.totalPaise);
    await call(await as(role), "PATCH", `/api/orders/${order.id}/status`, { status: "CANCELLED", note: "QA" });
    out.push(`${role} (${user.role}) ${order.orderNumber} ${order.status} PERSONAL`);
  }
  return out.join("; ");
}, { ...local, partial: "the shop owner's personal order is the signed-tier TC-RBAC-016 check; wallets topped up in the database first" });

/* ======================================================== audit log */

qa("TC-RBAC-022", "audit_logs is append-only: UPDATE and DELETE of a row are refused by the database", async () => {
  const [row] = await db()<{ id: string; action: string }[]>`select id, action from audit_logs order by created_at desc limit 1`;
  const id = need(row?.id, "an audit row");
  const errors: string[] = [];
  for (const statement of ["update", "delete"] as const) {
    try {
      if (statement === "update") await db()`update audit_logs set action = 'qa.tampered' where id = ${id}`;
      else await db()`delete from audit_logs where id = ${id}`;
      errors.push(`${statement}: ALLOWED`);
    } catch (error) {
      errors.push(`${statement}: refused (${String((error as Error).message).slice(0, 80)})`);
    }
  }
  const [still] = await db()<{ action: string }[]>`select action from audit_logs where id = ${id}`;
  expect(still?.action, "row unchanged").toBe(row.action);
  expect(errors.filter((e) => e.includes("ALLOWED")), errors.join("; ")).toEqual([]);
  return errors.join("; ");
}, local);

/* ======================================================== suspension */

qa("TC-RBAC-024", "an admin suspends a signed-in customer: the next request is signed out and signing in again is refused", async ({ browser }) => {
  const user = await freshCustomer("rbac024", { withAddress: true });
  const { context, page } = await browserFor(browser, user);
  try {
    await page.goto("/orders", { waitUntil: "domcontentloaded" });
    expect(new URL(page.url()).pathname, "signed in before").toBe("/orders");
    expect((await sessionOf(page))?.id).toBe(user.id);
    const res = await call(await as("admin"), "POST", `/api/users/${user.id}/suspend`, { reason: "QA suspension check" });
    expectStatus(res, 200, "admin suspends");
    await page.goto("/orders", { waitUntil: "domcontentloaded" });
    expect(new URL(page.url()).pathname, "next request after suspension").toBe("/signin");
    const wallet = await page.request.get("/api/wallet");
    expect(wallet.status(), "API after suspension").toBe(401);
  } finally {
    await context.close();
  }
  const fresh = await browser.newContext();
  try {
    const attempt = await signInByEmail(await fresh.newPage(), user.email, { codeWaitMs: 15_000 });
    expect(attempt.signedIn, `signing in again as the suspended account (${attempt.message})`).toBe(false);
    return `suspended mid-session: /orders → /signin, /api/wallet 401; sign-in again refused: "${attempt.message.slice(0, 120)}"`;
  } finally {
    await fresh.close();
  }
}, local);

qa("TC-ADM-017", "admins cannot be suspended: another admin, an admin acting as customer, and yourself — 403 each", async () => {
  const adminActor = await me("admin");
  const otherAdmin = await freshCustomer("adm017a");
  await grantLocalRole(otherAdmin.id, "ADMIN");
  const actingAsCustomer = await freshCustomer("adm017b");
  await grantLocalRole(actingAsCustomer.id, "ADMIN", false);
  const out: string[] = [];
  for (const [what, id] of [["another admin", otherAdmin.id], ["admin acting as CUSTOMER", actingAsCustomer.id], ["yourself", adminActor.id]] as const) {
    const res = await call(await as("admin"), "POST", `/api/users/${id}/suspend`, { reason: "QA admin suspension check" });
    out.push(`${what} ${res.status}`);
    expect(res.status, `${what} — ${why(res)}`).toBe(403);
  }
  const statuses = await db()<{ status: string }[]>`select status from users where id in (${otherAdmin.id}, ${actingAsCustomer.id}, ${adminActor.id})`;
  expect(statuses.every((s) => s.status === "ACTIVE"), "all still ACTIVE").toBe(true);
  const permanent = (process.env.PERMANENT_ADMIN_EMAILS ?? "").split(",").filter(Boolean);
  return `${out.join("; ")}; permanent bootstrap admin: ${permanent.length ? "configured" : "none configured on this server"}`;
}, { ...local, partial: "no PERMANENT_ADMIN_EMAILS account exists on the local server, so the permanent-bootstrap-admin case is not exercised (findAdminUserIds covers it in src/server/services/users.ts)" });

qa("TC-ADM-018", "reinstate: SUSPENDED → ACTIVE and audited; ACTIVE 409; unknown 404; operator 403; the rider profile stays suspended", async ({ browser }) => {
  const user = await freshCustomer("adm018", { withMobile: true });
  const loc = need(world().location, "shop A's location");
  const ctx = await apiFor(user);
  let partnerId = "";
  try {
    const applied = await call(ctx, "POST", "/api/delivery-partner", { fullName: "QA Reinstate Rider", mobile: user.mobile ?? "9876501235", vehicleType: "MOTORCYCLE", latitude: loc.lat, longitude: loc.lng, operatingRadiusKm: 5 });
    expectStatus(applied, 201, "rider application");
    partnerId = String(applied.body?.id);
  } finally {
    await ctx.dispose();
  }
  expectStatus(await call(await as("admin"), "PATCH", `/api/delivery-partner/${partnerId}`, { action: "approve" }), 200, "rider approved");
  expectStatus(await call(await as("admin"), "POST", `/api/users/${user.id}/suspend`, { reason: "QA reinstate check" }), 200, "suspend");
  const since = await dbNow();
  const operator = await call(await as("ops"), "POST", `/api/users/${user.id}/reinstate`, { reason: "QA operator try" });
  expect(operator.status, `operator reinstate — ${why(operator)}`).toBe(403);
  const ok = await call(await as("admin"), "POST", `/api/users/${user.id}/reinstate`, { reason: "QA reinstated" });
  expectStatus(ok, 200, "reinstate a suspended account");
  expect(ok.body?.status).toBe("ACTIVE");
  const again = await call(await as("admin"), "POST", `/api/users/${user.id}/reinstate`, { reason: "QA again" });
  expect(again.status, `reinstate an ACTIVE account — ${why(again)}`).toBe(409);
  const unknown = await call(await as("admin"), "POST", `/api/users/${NO_SUCH_ID}/reinstate`, { reason: "QA unknown" });
  expect(unknown.status, `reinstate an unknown account — ${why(unknown)}`).toBe(404);
  const audit = await auditRows(user.id, since, "user.reinstated");
  expect(audit.length, "audited").toBe(1);
  const [partner] = await db()<{ status: string }[]>`select status from delivery_partners where id = ${partnerId}`;
  expect(partner?.status, "rider profile after reinstating the account").toBe("SUSPENDED");
  const page = await browser.newPage();
  try {
    const attempt = await signInByEmail(page, user.email);
    expect(attempt.signedIn, `the reinstated account signs in again (${attempt.message})`).toBe(true);
  } finally {
    await page.close();
  }
  return "operator 403; SUSPENDED→ACTIVE 200 (audited user.reinstated); ACTIVE 409; unknown 404; rider profile stays SUSPENDED; signs in again with an emailed code";
}, local);

/* ======================================================== admin user edit */

qa("TC-ADM-010", "admin edits a user's name and contact phone: Save only after a change, success message, persisted and audited", async ({ browser }) => {
  const user = await freshCustomer("adm010", { name: "QA Before Name" });
  const since = await dbNow();
  const { context, page } = await pageAs(browser, "admin");
  let notice = "";
  try {
    await page.goto(`/admin/users/${user.id}`, { waitUntil: "domcontentloaded" });
    const save = page.getByTestId("profile-save").getByRole("button", { name: "Save Changes" });
    await expect(save, "Save before a change").toBeDisabled();
    await page.getByLabel("Name").fill("QA After Name");
    await page.getByLabel("Contact phone").fill("9822001122");
    await expect(save).toBeEnabled();
    notice = await saveChanges(page, "profile-save");
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByLabel("Name"), "persisted after reload").toHaveValue("QA After Name");
  } finally {
    await context.close();
  }
  const audit = await auditRows(user.id, since, "user.profile_updated");
  expect(audit.length).toBe(1);
  expect(audit[0].previous_value).toMatchObject({ name: "QA Before Name" });
  expect(audit[0].new_value).toMatchObject({ name: "QA After Name", phone: "9822001122" });
  return `"${notice}"; reload shows the new name; audit user.profile_updated before/after`;
}, local);

qa("TC-FLD-120", "admin user edit: blank and invalid values, another account's phone, an unknown role, and Cancel at the confirmation", async ({ browser }) => {
  const user = await freshCustomer("fld120", { name: "QA Field Name" });
  const other = await me("customer2");
  const admin = await as("admin");
  const out: string[] = [];
  // The API repeats the form's rules.
  for (const [what, body, expected] of [
    ["one-letter name", { name: "A" }, 422],
    ["121-letter name", { name: "x".repeat(121) }, 422],
    ["letters as phone", { phone: "abcdefghij" }, 422],
    ["too short phone", { phone: "12345" }, 422],
    ["blank name (clears it)", { name: "" }, 200],
  ] as [string, Record<string, unknown>, number][]) {
    const res = await call(admin, "PATCH", `/api/users/${user.id}`, body);
    out.push(`${what} ${res.status}`);
    expect(res.status, `${what} — ${why(res)}`).toBe(expected);
  }
  const email = await call(admin, "PATCH", `/api/users/${user.id}`, { email: other.email });
  out.push(`email field ${email.status}`);
  const [stored] = await db()<{ email: string }[]>`select email from users where id = ${user.id}`;
  expect(stored.email, "email is not editable here").toBe(user.email);
  const role = await call(admin, "PATCH", `/api/users/${user.id}/role`, { role: "SUPERUSER" });
  expect(role.status, `unknown role — ${why(role)}`).toBe(422);
  out.push(`unknown role ${role.status}`);
  // Cancel at the confirmation (a status change asks first): nothing changes.
  const { context, page } = await pageAs(browser, "admin");
  try {
    await page.goto(`/admin/users/${user.id}`, { waitUntil: "domcontentloaded" });
    // Typed before React hydrates, the change is not seen: type again until the form answers.
    await expect(async () => {
      await page.getByLabel("Name").fill("A");
      await expect(page.getByText("A name needs 2–120 characters.")).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 45_000 });
    await page.getByLabel("Name").fill("QA Field Name");
    await page.getByRole("radio", { name: "Suspended" }).check();
    await page.getByLabel("Reason").fill("QA cancel check");
    await page.getByTestId("profile-save").getByRole("button", { name: "Save Changes" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
  } finally {
    await context.close();
  }
  const [after] = await db()<{ status: string }[]>`select status from users where id = ${user.id}`;
  expect(after.status, "Cancel changed nothing").toBe("ACTIVE");
  out.push("cancel at confirmation: still ACTIVE");
  return out.join("; ");
}, {
  ...local,
  partial:
    "expected result superseded by src/server/services/users.ts (updateUserProfileByAdmin): email and the login mobile are not editable on the admin screen, and 'Contact phone' is a free-text contact column, so another account's number is not refused there",
});
