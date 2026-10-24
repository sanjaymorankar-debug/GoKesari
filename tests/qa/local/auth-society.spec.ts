/**
 * Societies with operations' decisions, member roles, authorised riders and
 * society deliveries end to end (QA package 1, Society module).
 *
 * Local tier: new residents and societies are created in the local database
 * (and through the site's own APIs), operations verifies, suspends and
 * reinstates them, riders are given mobile numbers of their own (the seeded
 * riders share one) and put online near shop A, and the test society's rules
 * are changed for the delivery checks and restored afterwards.
 */
import type { APIRequestContext } from "@playwright/test";

import { as, pageAs } from "../lib/actors";
import { arrangeRider, auditSince, browserWithCookie, deliverFor, deliveryCodeFor, keep, kept, localUser, partnerOf, releaseOffers, uniqueMobile, walletOrder, worldSociety, type LocalUser } from "../lib/auth-helpers";
import { db } from "../lib/db";
import { packOrder, pickupCode, riderAction } from "../lib/flows";
import { call, expectStatus, poll, RUN } from "../lib/http";
import { blocked, expect, need, qa } from "../lib/record";
import { world, type Role } from "../lib/world";

const local = { tier: "local" as const, timeout: 300_000 };
const HOME = () => world().location ?? { pincode: "411038", lat: 18.5074, lng: 73.8077 };

interface FreshSociety {
  id: string;
  name: string;
  owner: LocalUser;
}

/** A society registered by a new account and verified by operations. */
async function freshSociety(label: string, verify = true): Promise<FreshSociety> {
  const owner = await localUser(`soc-${label}`);
  const name = `QA ${label} Society ${RUN}`;
  const res = await call(owner.ctx, "POST", "/api/societies", { name, addressLine1: "QA Lane", area: "Kothrud", city: "Pune", pincode: HOME().pincode, latitude: HOME().lat + 0.009, longitude: HOME().lng });
  expectStatus(res, 201, "register a society");
  if (verify) expectStatus(await call(await as("ops"), "POST", `/api/societies/${res.body.id}/decision`, { decision: "verify" }), 200, "operations verifies");
  return { id: res.body.id, name, owner };
}

/** A new customer who joins `societyId`, is approved by `admin` and links their address to it. */
async function residentOf(societyId: string, admin: APIRequestContext, label: string, unit = `R-${Math.floor(Math.random() * 900 + 100)}`) {
  const resident = await localUser(label, { walletPaise: 300_000, address: true });
  const ask = await call(resident.ctx, "POST", `/api/societies/${societyId}/members`, { unitLabel: unit });
  expectStatus(ask, 201, "ask to join");
  expectStatus(await call(admin, "PATCH", `/api/societies/members/${ask.body.id}`, { action: "approve" }), 200, "approve");
  expectStatus(await call(resident.ctx, "PUT", `/api/addresses/${resident.addressId}/society`, { societyId }), 200, "link the address");
  return { ...resident, memberId: ask.body.id as string, unit };
}

async function societyOf(id: string, role: Role = "ops") {
  const res = await call(await as(role), "GET", `/api/societies/${id}`);
  expectStatus(res, 200, `GET /api/societies/${id}`);
  return res.body as { society: Record<string, unknown> & { status: string }; members: Record<string, unknown>[]; riders: { id: string; status: string; preferred: boolean; deliveryPartnerId: string }[]; recentOrders: Record<string, unknown>[] };
}

async function orderSociety(orderId: string) {
  const [row] = await db()<{ society_id: string | null }[]>`select society_id from orders where id = ${orderId}`;
  return row?.society_id ?? null;
}

/** The order a rider is currently offered or holds, if it is `orderId`. */
async function heldBy(rider: Role, orderId: string) {
  const res = await call(await as(rider), "GET", "/api/delivery-partner/deliveries");
  const active = res.body?.active as { id: string; orderId: string; status: string } | null;
  return active && active.orderId === orderId ? active : null;
}

async function waitForOffer(orderId: string, riders: Role[], ms = 60_000) {
  return poll(
    async () => {
      for (const rider of riders) {
        const held = await heldBy(rider, orderId);
        if (held) return { rider, ...held };
      }
      return null;
    },
    (v) => v !== null,
    ms,
  );
}

/* ================================================== operations' decisions */

qa("TC-SOC-003", "operations verifies one society, rejects one with a reason, suspends and reinstates the verified one — each audited; the registrant gets the society-admin role", async ({ browser }) => {
  const since = Date.now();
  const good = await freshSociety("verify-me", false);
  const bad = await freshSociety("reject-me", false);
  const { context, page } = await pageAs(browser, "ops");
  const row = (name: string, button: string) =>
    page.locator("div").filter({ has: page.getByRole("link", { name }) }).filter({ has: page.getByRole("button", { name: button }) }).last();
  try {
    await page.goto("/admin/societies?status=APPLIED");
    await row(good.name, "Verify").getByRole("button", { name: "Verify" }).click();
    await expect.poll(async () => (await societyOf(good.id)).society.status).toBe("VERIFIED");
    await page.reload();
    await row(bad.name, "Reject").getByLabel("Reason").fill("QA: not a real society");
    await row(bad.name, "Reject").getByRole("button", { name: "Reject" }).click();
    await expect.poll(async () => (await societyOf(bad.id)).society.status).toBe("REJECTED");
    expect((await societyOf(bad.id)).society.rejectionReason).toBe("QA: not a real society");
    await page.goto("/admin/societies?status=VERIFIED");
    await row(good.name, "Suspend").getByLabel("Reason").fill("QA suspension check");
    await row(good.name, "Suspend").getByRole("button", { name: "Suspend" }).click();
    await expect.poll(async () => (await societyOf(good.id)).society.status).toBe("SUSPENDED");
    await page.goto("/admin/societies?status=SUSPENDED");
    await row(good.name, "Reinstate").getByRole("button", { name: "Reinstate" }).click();
    await expect.poll(async () => (await societyOf(good.id)).society.status).toBe("VERIFIED");
  } finally {
    await context.close();
  }
  const audit = (await auditSince("society.status_changed", since)).filter((r) => r.entity_id === good.id || r.entity_id === bad.id);
  const steps = audit.map((r) => `${r.entity_id === good.id ? "A" : "B"}:${String(r.previous_value?.status)}→${String(r.new_value?.status)}`).reverse();
  expect(steps).toEqual(["A:APPLIED→VERIFIED", "B:APPLIED→REJECTED", "A:VERIFIED→SUSPENDED", "A:SUSPENDED→VERIFIED"]);
  const roles = await call(good.owner.ctx, "GET", "/api/me/roles");
  const held = (roles.body.roles as (string | { role: string })[]).map((r) => (typeof r === "string" ? r : r.role));
  expect(held, "the registrant's roles").toContain("SOCIETY_ADMIN");
  return `audited ${steps.join(", ")}; registrant of A now holds ${held.join(", ")}`;
}, local);

qa("TC-SOC-006", "member roles: the admin makes a member OPERATOR; an operator cannot change roles; the only admin cannot demote themselves or leave", async ({ browser }) => {
  const s = await freshSociety("roles");
  const b = await residentOf(s.id, s.owner.ctx, "member-b", "B-1");
  const c = await residentOf(s.id, s.owner.ctx, "member-c", "C-1");
  const { context, page } = await browserWithCookie(browser, s.owner.cookie);
  try {
    await page.goto(`/society/${s.id}`);
    const rowB = page.getByTestId("society-members").locator("div").filter({ hasText: "B-1" }).last();
    await rowB.getByLabel("Society role").selectOption("OPERATOR");
    await expect.poll(async () => (await societyOf(s.id)).members.find((m) => m.id === b.memberId)?.role).toBe("OPERATOR");
  } finally {
    await context.close();
  }
  const byOperator = await call(b.ctx, "PATCH", `/api/societies/members/${c.memberId}`, { action: "role", role: "OPERATOR" });
  expect(byOperator.status, "an operator changing a role").toBe(403);
  const ownerMember = (await societyOf(s.id)).members.find((m) => m.role === "ADMIN")!;
  const demote = await call(s.owner.ctx, "PATCH", `/api/societies/members/${ownerMember.id}`, { action: "role", role: "RESIDENT" });
  const leave = await call(s.owner.ctx, "PATCH", `/api/societies/members/${ownerMember.id}`, { action: "remove" });
  expect([demote.status, leave.status], "the last admin").toEqual([409, 409]);
  return `B → OPERATOR by the admin; B changing C's role → 403; last admin demote → 409 "${demote.body.error.message}", leave → 409 "${leave.body.error.message}"`;
}, local);

/* ================================================== authorised riders */

const RIDER_LINK = "society-rider-link";

qa("TC-SOC-011", "add an authorised rider by mobile and mark preferred: listed at once and audited; an unknown mobile is refused with a message", async ({ browser }) => {
  const society = worldSociety();
  const since = Date.now();
  const rider = await arrangeRider("rider", { mobile: uniqueMobile() });
  const { context, page } = await pageAs(browser, "society");
  try {
    await page.goto(`/society/${society.id}`);
    const box = page.getByLabel("Rider mobile number");
    await box.fill(rider.mobile);
    await page.getByLabel("Preferred").check();
    await page.getByRole("button", { name: "Add rider" }).click();
    await expect(page.getByText("Rider added — effective immediately.")).toBeVisible();
    const displayId = `GKR-${rider.id.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
    const listed = page.locator("div").filter({ hasText: displayId }).filter({ hasText: "preferred" }).last();
    await expect(listed, "listed and marked preferred").toBeVisible();
    await box.fill(uniqueMobile());
    await page.getByRole("button", { name: "Add rider" }).click();
    await expect(page.getByText("Approved delivery partner with that mobile number was not found.")).toBeVisible();
    const link = (await societyOf(society.id, "society")).riders.find((r) => r.deliveryPartnerId === rider.id);
    expect([link?.status, link?.preferred]).toEqual(["ACTIVE", true]);
    const audit = (await auditSince("society.rider_changed", since)).filter((r) => r.entity_id === link!.id);
    expect(audit.length, "audited").toBeGreaterThan(0);
    keep(RIDER_LINK, { linkId: link!.id, partnerId: rider.id, mobile: rider.mobile });
    return `rider ${displayId} (+91 ${rider.mobile}) listed as preferred at once, audited; an unknown mobile → "Approved delivery partner with that mobile number was not found."`;
  } finally {
    await context.close();
  }
}, { ...local, partial: "the riders' mobile numbers are made unique first (the seeded riders share 9876543210)" });

qa("TC-FLD-106", "authorised rider mobile: wrong length, first digit and non-digits refused with nothing saved; +91 stripped; only an approved rider, listed once", async ({ browser }) => {
  const society = worldSociety();
  const saved = kept<{ partnerId: string; mobile: string }>(RIDER_LINK) ?? blocked("needs the rider listed by TC-SOC-011");
  const ctx = await as("society");
  const add = (mobile: string) => call(ctx, "POST", `/api/societies/${society.id}/riders`, { mobile });
  const out: string[] = [];
  const { context, page } = await pageAs(browser, "society");
  try {
    await page.goto(`/society/${society.id}`);
    const button = page.getByRole("button", { name: "Add rider" });
    await page.getByLabel("Rider mobile number").fill("");
    await expect(button, "blank").toBeDisabled();
    await page.getByLabel("Rider mobile number").fill("987654321");
    await expect(button, "9 digits").toBeDisabled();
    out.push("UI: blank and 9 digits → Add rider disabled");
  } finally {
    await context.close();
  }
  const before = (await societyOf(society.id, "society")).riders.length;
  const refused: string[] = [];
  const wronglyAccepted: string[] = [];
  for (const value of ["987654321", "5876543210", "abcdefghij", `1${saved.mobile}`, `${saved.mobile.slice(0, 5)}ab${saved.mobile.slice(5)}`]) {
    const res = await add(value);
    if (res.status >= 400 && res.status < 500) refused.push(`${value}→${res.status}`);
    else wronglyAccepted.push(`${value}→${res.status}`);
  }
  out.push(`refused: ${refused.join(", ")}`);
  const plus = await add(`+91 ${saved.mobile}`);
  expectStatus(plus, 201, "+91 and the rider's number");
  const unknown = await add(uniqueMobile());
  expect(unknown.status, "a valid number that is no approved rider").toBe(404);
  const again = await add(saved.mobile);
  expectStatus(again, 201, "the same rider again");
  const after = (await societyOf(society.id, "society")).riders.filter((r) => r.deliveryPartnerId === saved.partnerId);
  expect(after.length, "the rider is listed once").toBe(1);
  expect((await societyOf(society.id, "society")).riders.length, "no other row added").toBe(before);
  out.push(`"+91 ${saved.mobile}" accepted (+91 stripped); a number of no approved rider → 404; the same rider again → still one row`);
  expect(wronglyAccepted, `non-10-digit or mixed input accepted as the rider's number (only the last 10 digits are read): ${wronglyAccepted.join(", ")}`).toEqual([]);
  return out.join("; ");
}, local);

qa("TC-SOC-012", "revoke a rider: off the authorised list at once and audited", async ({ browser }) => {
  const society = worldSociety();
  const saved = kept<{ linkId: string; partnerId: string }>(RIDER_LINK) ?? blocked("needs the rider listed by TC-SOC-011");
  const since = Date.now();
  const { context, page } = await pageAs(browser, "society");
  try {
    await page.goto(`/society/${society.id}`);
    const displayId = `GKR-${saved.partnerId.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
    const row = page.locator("div").filter({ hasText: displayId }).filter({ has: page.getByRole("button", { name: "Revoke" }) }).last();
    await row.getByRole("button", { name: "Revoke" }).click();
    await expect(page.locator("div").filter({ hasText: displayId }).getByText("revoked").first()).toBeVisible();
    await expect(page.locator("div").filter({ hasText: displayId }).getByRole("button", { name: "Revoke" })).toHaveCount(0);
  } finally {
    await context.close();
  }
  const link = (await societyOf(society.id, "society")).riders.find((r) => r.id === saved.linkId);
  expect(link?.status).toBe("REVOKED");
  const audit = (await auditSince("society.rider_changed", since)).find((r) => r.entity_id === saved.linkId);
  expect(audit?.new_value?.status, "audited").toBe("REVOKED");
  return "revoked at once (status REVOKED, no actions left on the row), audited ACTIVE → REVOKED";
}, { ...local, partial: "the dashboard keeps the revoked rider on its list, marked 'revoked' (no longer authorised), rather than removing the row" });

/* ============================================ a society delivery end to end */

const E2E = "society-e2e";

qa(["TC-SOC-016", "TC-SOC-013", "TC-SOC-014"], "society delivery: the order carries the society, only the listed rider is offered, security is told on acceptance, the rider sees the gate rules (desk number only while shared), delivery by code", async ({ browser }) => {
  const society = worldSociety();
  const admin = await as("society");
  const original = (await societyOf(society.id, "society")).society;
  const rider2 = await arrangeRider("rider2", { mobile: uniqueMobile() });
  await arrangeRider("rider");
  for (const role of ["rider", "rider2"] as const) await releaseOffers(role);
  // Only rider 2 on the society's list for this delivery.
  for (const link of (await societyOf(society.id, "society")).riders.filter((r) => r.status === "ACTIVE")) {
    await call(admin, "PATCH", `/api/societies/riders/${link.id}`, { revoke: true });
  }
  const desk = uniqueMobile();
  const notes = `QA gate notes ${RUN}`;
  const out: string[] = [];
  keep(E2E, { original });
  // Rules from the dashboard form (TC-SOC-013).
  const { context, page } = await pageAs(browser, "society");
  try {
    await page.goto(`/society/${society.id}`);
    await page.getByLabel("Gate entry for delivery riders").selectOption("CALL_RESIDENT");
    await page.getByLabel("Security desk contact name (optional)").fill(`QA Desk ${RUN}`);
    await page.getByLabel("Security desk phone (optional)").fill(desk);
    await page.getByLabel("Show the security desk contact to the rider on an active delivery").check();
    await page.getByLabel("Tell the resident when the rider reaches the gate").check();
    await page.getByLabel("Gate / parking / access instructions for riders").fill(notes);
    await page.getByLabel("Notify society staff (security) when a rider is assigned to a delivery here").check();
    await page.getByLabel("Only riders on our list may deliver here (applies once the list has riders)").check();
    await page.getByRole("button", { name: "Save rules" }).click();
    await expect(page.getByText("Saved.")).toBeVisible();
  } finally {
    await context.close();
  }
  expectStatus(await call(admin, "POST", `/api/societies/${society.id}/riders`, { mobile: rider2.mobile, preferred: false }), 201, "list rider 2 only");
  out.push("rules saved from the form: call-resident gate, desk contact shared, notes, security notice, listed riders only (rider 2, about 3 km away)");
  const resident = await residentOf(society.id, admin, "soc-resident", `E-${RUN.slice(-3)}`);
  const listing = need(world().listings.packaged, "shop A's packaged listing");
  const order = await walletOrder(resident.ctx, listing.shopProductId, need(world().shops.A?.id, "shop A"), resident.addressId);
  expect(await orderSociety(order.id), "the order carries the society").toBe(society.id);
  await packOrder(order.id);
  const offer = need(await waitForOffer(order.id, ["rider2", "rider"]), `an offer for ${order.orderNumber}`);
  if (offer.rider !== "rider2") await releaseOffers(offer.rider);
  expect(offer.rider, "only the listed rider is offered (rider 1 is nearer)").toBe("rider2");
  out.push(`${order.orderNumber} (society ${society.name}) offered to rider 2 only`);
  expectStatus(await riderAction(offer.id, "accept", {}, "rider2"), 200, "rider 2 accepts");
  await expect
    .poll(async () => ((await call(admin, "GET", "/api/notifications")).body.notifications as { title: string; body: string; createdAt: string }[]).some((n) => n.title === "Delivery rider on the way" && n.body.includes(order.orderNumber)), { message: "security told on acceptance", timeout: 20_000 })
    .toBe(true);
  out.push("society staff got 'Delivery rider on the way'");
  const riderPage = await pageAs(browser, "rider2");
  try {
    await riderPage.page.goto("/delivery-partner");
    const box = riderPage.page.getByTestId("society-notes");
    await expect(box).toContainText(society.name);
    await expect(box).toContainText("Gate: Security calls the resident before letting you in");
    await expect(box.getByRole("link", { name: desk })).toHaveAttribute("href", `tel:${desk}`);
    const code = await pickupCode(order.id);
    expectStatus(await riderAction(offer.id, "pickup", code ? { pickupCode: code } : {}, "rider2"), 200, "pickup");
    await riderPage.page.reload();
    await expect(box).toContainText(notes);
    out.push("rider's active job: society, gate mode, tap-to-call desk number; the notes after pickup");
    expectStatus(await call(admin, "PATCH", `/api/societies/${society.id}`, { shareGateContactWithRider: false }), 200, "stop sharing the desk number");
    await riderPage.page.reload();
    await expect(box).toContainText("Gate: Security calls the resident");
    await expect(box).not.toContainText(desk);
    out.push("'show to rider' off → number hidden");
  } finally {
    await riderPage.context.close();
  }
  const started = Date.now();
  expectStatus(await riderAction(offer.id, "start", {}, "rider2"), 200, "start");
  const otp = await deliveryCodeFor(resident.ctx, order.id, { email: resident.email, orderNumber: order.orderNumber, since: started });
  expectStatus(await riderAction(offer.id, "deliver", { otp }, "rider2"), 200, "deliver");
  const [status] = await db()<{ status: string }[]>`select status from orders where id = ${order.id}`;
  expect(status.status).toBe("DELIVERED");
  keep(E2E, { original, orderNumber: order.orderNumber, resident: { email: resident.email, mobile: resident.mobile }, productName: listing.name });
  return `${out.join("; ")}; delivered with the resident's code`;
}, { ...local, timeout: 420_000, partial: "the dashboard's view of the delivery (no PII) is TC-SOC-009 below" });

qa("TC-SOC-014", "with security notifications off, a rider accepting a society order notifies nobody", async () => {
  const society = worldSociety();
  const admin = await as("society");
  if (!kept(E2E)) blocked("needs the society delivery set up by TC-SOC-016");
  {
    expectStatus(await call(admin, "PATCH", `/api/societies/${society.id}`, { securityNotifyEnabled: false }), 200, "security notices off");
    await arrangeRider("rider2");
    await releaseOffers("rider2");
    const resident = await residentOf(society.id, admin, "soc-resident-2", `F-${RUN.slice(-3)}`);
    const listing = need(world().listings.packaged, "shop A's packaged listing");
    const order = await walletOrder(resident.ctx, listing.shopProductId, need(world().shops.A?.id, "shop A"), resident.addressId);
    await deliverFor(order.id, resident.ctx, {
      rider: "rider2",
      mail: { email: resident.email, orderNumber: order.orderNumber },
      afterAccept: async () => {
        await new Promise((r) => setTimeout(r, 5000));
        const notes = (await call(admin, "GET", "/api/notifications")).body.notifications as { title: string; body: string }[];
        expect(notes.some((n) => n.title === "Delivery rider on the way" && n.body.includes(order.orderNumber)), "no security notice when switched off").toBe(false);
      },
    });
    return `${order.orderNumber}: rider 2 accepted with notices off — no 'Delivery rider on the way'; delivered`;
  }
}, { ...local, timeout: 300_000, partial: "the notice when switched on is checked by TC-SOC-016 above" });

qa("TC-SOC-009", "the society dashboard and its API show the delivery without resident contact details or order contents", async ({ browser }) => {
  const society = worldSociety();
  const saved = kept<{ original: Record<string, unknown>; orderNumber?: string; resident?: { email: string; mobile: string | null }; productName?: string }>(E2E);
  try {
    if (!saved?.orderNumber) blocked("needs the society delivery made by TC-SOC-016");
    const data = await societyOf(society.id, "society");
    const row = data.recentOrders.find((o) => o.orderNumber === saved.orderNumber);
    expect(row, "the delivery is listed").toBeTruthy();
    expect(Object.keys(row!).sort(), "only gate-level fields").toEqual(["createdAt", "orderNumber", "promisedByAt", "riderName", "riderVehicle", "riderVehicleNumber", "shopName", "status", "unitLabel"]);
    for (const m of data.members) for (const key of Object.keys(m)) expect(["id", "role", "status", "unitLabel", "name", "createdAt"], `member field ${key}`).toContain(key);
    const text = JSON.stringify(data);
    for (const leak of [saved.resident!.email, saved.resident!.mobile ?? "\u0000", saved.productName!]) expect(text, `API has "${leak}"`).not.toContain(leak);
    const { context, page } = await pageAs(browser, "society");
    try {
      await page.goto(`/society/${society.id}`);
      await expect(page.getByTestId("society-orders")).toContainText(saved.orderNumber!);
      const html = await page.content();
      for (const leak of [saved.resident!.email, saved.resident!.mobile ?? "\u0000", saved.productName!]) expect(html, `page has "${leak}"`).not.toContain(leak);
    } finally {
      await context.close();
    }
    return `${saved.orderNumber} listed with number, status, shop, rider and unit only; no resident email, mobile or items in the API or the page`;
  } finally {
    // Put the test society back as it was before TC-SOC-016.
    if (saved?.original) {
      const o = saved.original;
      await call(await as("society"), "PATCH", `/api/societies/${society.id}`, {
        deliveryInstructions: (o.deliveryInstructions as string | null) ?? null,
        gateEntryMode: o.gateEntryMode,
        gateContactName: (o.gateContactName as string | null) ?? null,
        gateContactPhone: (o.gateContactPhone as string | null) ?? null,
        shareGateContactWithRider: o.shareGateContactWithRider,
        notifyCustomerAtGate: o.notifyCustomerAtGate,
        securityNotifyEnabled: o.securityNotifyEnabled,
        exclusiveRiders: o.exclusiveRiders,
      });
      const r2 = await partnerOf("rider2").catch(() => null);
      const link = r2 ? (await societyOf(society.id, "society")).riders.find((r) => r.deliveryPartnerId === r2.id && r.status === "ACTIVE") : null;
      if (link) await call(await as("society"), "PATCH", `/api/societies/riders/${link.id}`, { revoke: true });
    }
  }
}, local);

/* ============================================== suspension, shops, leaving */

qa("TC-SOC-017", "a suspended society's rules stop applying: an order to a linked address carries no society and is dispatched normally", async () => {
  const s = await freshSociety("suspend");
  const rider2 = await arrangeRider("rider2", { mobile: uniqueMobile() });
  await arrangeRider("rider");
  for (const role of ["rider", "rider2"] as const) await releaseOffers(role);
  expectStatus(await call(s.owner.ctx, "PATCH", `/api/societies/${s.id}`, { exclusiveRiders: true }), 200, "exclusive riders");
  expectStatus(await call(s.owner.ctx, "POST", `/api/societies/${s.id}/riders`, { mobile: rider2.mobile }), 201, "list rider 2");
  const resident = await residentOf(s.id, s.owner.ctx, "suspended-res");
  expectStatus(await call(await as("ops"), "POST", `/api/societies/${s.id}/decision`, { decision: "suspend", reason: "QA suspension" }), 200, "suspend");
  try {
    const listing = need(world().listings.packaged, "shop A's packaged listing");
    const order = await walletOrder(resident.ctx, listing.shopProductId, need(world().shops.A?.id, "shop A"), resident.addressId);
    expect(await orderSociety(order.id), "no society on the order").toBeNull();
    await packOrder(order.id);
    const offer = need(await waitForOffer(order.id, ["rider", "rider2"]), `an offer for ${order.orderNumber}`);
    if (offer.rider !== "rider") await releaseOffers(offer.rider);
    expect(offer.rider, "normal dispatch (the nearer rider), not the society's listed rider").toBe("rider");
    expectStatus(await riderAction(offer.id, "accept", {}, "rider"), 200, "accept");
    const code = await pickupCode(order.id);
    expectStatus(await riderAction(offer.id, "pickup", code ? { pickupCode: code } : {}, "rider"), 200, "pickup");
    const started = Date.now();
    expectStatus(await riderAction(offer.id, "start", {}, "rider"), 200, "start");
    const otp = await deliveryCodeFor(resident.ctx, order.id, { email: resident.email, orderNumber: order.orderNumber, since: started });
    expectStatus(await riderAction(offer.id, "deliver", { otp }, "rider"), 200, "deliver");
    return `suspended (exclusive, rider 2 listed): ${order.orderNumber} has no society, went to the nearer rider 1 and was delivered`;
  } finally {
    await call(await as("ops"), "POST", `/api/societies/${s.id}/decision`, { decision: "reinstate" });
  }
}, local);

qa("TC-SOC-015", "a society's partner shop is listed first for its residents and delivers to them", async ({ browser }) => {
  const s = await freshSociety("partner");
  const resident = await residentOf(s.id, s.owner.ctx, "partner-res");
  const shopA = need(world().shops.A, "shop A");
  const shopC = need(world().shops.C, "shop C (nearer to the resident than shop A)");
  const order = async () => {
    const { context, page } = await browserWithCookie(browser, resident.cookie);
    try {
      await page.goto("/");
      await page.waitForLoadState("networkidle").catch(() => {});
      // Shop names are shown in title case (CSS), so compare case-insensitively.
      const text = (await page.getByRole("region", { name: "Shops near you" }).innerText()).toLowerCase();
      return { a: text.indexOf(shopA.name.toLowerCase()), c: text.indexOf(shopC.name.toLowerCase()) };
    } finally {
      await context.close();
    }
  };
  const before = await order();
  expect(before.a >= 0 && before.c >= 0, "both shops listed").toBe(true);
  expectStatus(await call(s.owner.ctx, "POST", `/api/societies/${s.id}/shops`, { shopId: shopA.id, active: true }), 200, "add shop A as partner");
  try {
    const after = await order();
    expect(after.a, `shop A before shop C once it is the society's partner (positions ${after.a} vs ${after.c})`).toBeLessThan(after.c);
    return `before: ${before.c < before.a ? "shop C (nearer) first" : "shop A first"}; after adding shop A as partner: shop A first`;
  } finally {
    await call(s.owner.ctx, "POST", `/api/societies/${s.id}/shops`, { shopId: shopA.id, active: false });
  }
}, {
  ...local,
  partial:
    "checked on the home page's 'Shops near you' (the nearby-shops order); the /shops list re-sorts nearest-first by default, so there shop C stays ahead; shop A delivers to the resident anyway — a partner outside its own radius is not set up in this world",
});

qa("TC-SOC-007", "leaving a society clears the address link; a later order carries no society", async ({ browser }) => {
  const society = worldSociety();
  const resident = await residentOf(society.id, await as("society"), "leaver", `L-${RUN.slice(-3)}`);
  const { context, page } = await browserWithCookie(browser, resident.cookie);
  try {
    await page.goto("/society");
    const row = page.locator("div").filter({ hasText: society.name }).filter({ has: page.getByRole("button", { name: "Remove" }) }).last();
    await row.getByRole("button", { name: "Remove" }).click();
    await expect.poll(async () => (await call(resident.ctx, "GET", "/api/societies/mine")).body.length).toBe(0);
  } finally {
    await context.close();
  }
  const [address] = await db()<{ society_id: string | null }[]>`select society_id from addresses where id = ${resident.addressId!}`;
  expect(address.society_id, "address no longer linked").toBeNull();
  const listing = need(world().listings.packaged, "shop A's packaged listing");
  const order = await walletOrder(resident.ctx, listing.shopProductId, need(world().shops.A?.id, "shop A"), resident.addressId);
  expect(await orderSociety(order.id), "no society on the next order").toBeNull();
  await call(resident.ctx, "PATCH", `/api/orders/${order.id}/status`, { status: "CANCELLED", note: "QA cleanup" });
  return `left ${society.name} from /society; the address link cleared; ${order.orderNumber} carries no society`;
}, local);
