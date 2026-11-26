/**
 * Flow spec v3, wave 1 (docs/flows-v3/wave1.md; migration 0221). Every item with its flag ON, and the same path
 * with the flag OFF behaving exactly as before.
 *   F17 (flow_f17): auto-assign, area dealer copied, system tickets, shop-owner topics, working-hours SLA, reopen,
 *                   society review ticket, account recovery form.
 *   F14 (flow_f14): shop wallet created with a v2 shop, wallet ledger CSV download.
 *   F1  (flow_f1):  rider dual-verification gate, Terms record for Google / e-mail-link sign-ups, referral link to
 *                   sign-up.
 */
import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FeatureFlagKey, UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  session: null as null | { user: { id: string; email: string; name: string | null; image: null; role: UserRole; status: "ACTIVE" } },
}));

vi.mock("@/server/auth", () => ({ auth: async () => state.session, handlers: {}, signIn: async () => {}, signOut: async () => {} }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (state.cookies.has(name) ? { name, value: state.cookies.get(name)! } : undefined),
    set: (name: string, value: string) => void state.cookies.set(name, value),
    delete: (name: string) => void state.cookies.delete(name),
  }),
  headers: async () => new Headers({ "user-agent": "vitest", "x-forwarded-for": "10.0.0.9" }),
}));

import { POST as recoverPost } from "@/app/api/account/recover/route";
import { POST as riderRegisterPost } from "@/app/api/delivery-partner/route";
import { GET as walletStatementGet } from "@/app/api/shops/[id]/wallet/statement/route";
import { GET as referralGet } from "@/app/r/[code]/route";
import { addWorkingHours } from "@/lib/working-hours";
import { resetRateLimits } from "@/server/api/rate-limit";
import {
  changeTicketStatus,
  createTicket,
  getTicketDetail,
  listMyTickets,
  replyToTicket,
  runHelpdeskSlaSweep,
  slaDeadlines,
} from "@/server/aftercare/support-tickets";
import { openSystemTicket } from "@/server/aftercare/system-tickets";
import { addRoutingRule, removeRoutingRule } from "@/server/aftercare/ticket-routing";
import { db } from "@/server/db";
import {
  dealers,
  featureFlags,
  notifications,
  policyAcceptances,
  shopAttributions,
  shopWallets,
  supportTicketAttachments,
  supportTickets,
  userConsents,
  users,
} from "@/server/db/schema";
import { assertRiderDualVerified, riderDualVerifyRedirect } from "@/server/dual-auth/policy";
import { recordSignUpTermsFromCookie, rememberSignUpTermsTick } from "@/server/flows/signup-terms";
import { afterV2ShopCreated } from "@/server/onboarding-v2/shop-flow";
import { V2_TERMS_COOKIE } from "@/server/onboarding-v2/customer";
import { raiseStaffTicket } from "@/server/rbac-support/desk";
import { addToCart } from "@/server/services/cart";
import { openDispute } from "@/server/services/disputes";
import { clearFeatureFlagCache } from "@/server/services/feature-flags";
import { districtCodeForPincode } from "@/server/services/geo-areas";
import { checkout, updateOrderStatus } from "@/server/services/orders";
import { clearRuleCache } from "@/server/services/settings";
import { registerSociety } from "@/server/services/societies";
import { call } from "../helpers/http";
import {
  createCategory,
  createProduct,
  createShop,
  createShopProduct,
  createUser,
  createUserWithWallet,
  deliveryAddressId,
  resetDatabase,
} from "../helpers/fixtures";

const DAY = 86_400_000;
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
  Buffer.from("IHDR"),
  Buffer.from([0, 0, 0, 64, 0, 0, 0, 64, 8, 2, 0, 0, 0]),
  Buffer.alloc(16),
]);

async function setFlag(key: FeatureFlagKey, enabled: boolean) {
  await db.insert(featureFlags).values({ key, enabled }).onConflictDoUpdate({ target: featureFlags.key, set: { enabled } });
  clearFeatureFlagCache();
}

type Person = Awaited<ReturnType<typeof createUser>>;
const actorOf = (u: Person) => ({ id: u.id, role: u.role });
function signInAs(u: Person) {
  state.session = { user: { id: u.id, email: u.email, name: u.name, image: null, role: u.role, status: "ACTIVE" } };
}

let admin: Person;

beforeEach(async () => {
  state.session = null;
  state.cookies.clear();
  resetRateLimits();
  await resetDatabase();
  clearRuleCache();
  admin = await createUser({ role: "ADMIN" });
});

afterEach(() => {
  clearFeatureFlagCache();
});

async function shopOwnerTicket(owner: Person, shopId: string, category: Parameters<typeof createTicket>[0]["category"] = "SHOP_PAYOUT") {
  return createTicket({ category, subject: "Payout question", description: "My payout for last week is missing.", shopId }, actorOf(owner));
}

/* ======================================================================= F17 */

describe("F17-1 auto-assign by category and district (flow_f17)", () => {
  it("assigns to the district's person, falls back to every-area rules, least-loaded wins; off = manual queue", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id);
    const district = await districtCodeForPincode(shop.pincode);
    expect(district).toBeTruthy();
    const opDistrict = await createUser({ role: "OPERATOR" });
    const opDistrict2 = await createUser({ role: "OPERATOR" });
    const opAll = await createUser({ role: "OPERATOR" });

    await setFlag("flow_f17", true);
    await addRoutingRule({ category: "SHOP_PAYOUT", districtCode: district, userId: opDistrict.id }, actorOf(admin));
    await addRoutingRule({ category: "SHOP_PAYOUT", districtCode: null, userId: opAll.id }, actorOf(admin));

    const first = await shopOwnerTicket(owner, shop.id);
    expect(first.assignedToUserId).toBe(opDistrict.id);
    // Auto-assignment is not the first response.
    expect(first.status).toBe("OPEN");
    expect(first.acknowledgedAt).toBeNull();

    // A second person in the same district: the one with fewer live tickets gets the next.
    await addRoutingRule({ category: "SHOP_PAYOUT", districtCode: district, userId: opDistrict2.id }, actorOf(admin));
    const second = await shopOwnerTicket(owner, shop.id);
    expect(second.assignedToUserId).toBe(opDistrict2.id);

    // No district rule left: the every-area rule.
    const rules = await db.select().from((await import("@/server/db/schema")).supportRoutingRules);
    for (const r of rules.filter((x) => x.districtCode === district)) await removeRoutingRule(r.id, actorOf(admin));
    const third = await shopOwnerTicket(owner, shop.id);
    expect(third.assignedToUserId).toBe(opAll.id);

    // No rule for the category: manual queue.
    const other = await shopOwnerTicket(owner, shop.id, "ACCOUNT");
    expect(other.assignedToUserId).toBeNull();

    // Flag off: nothing is assigned even with rules in place.
    await setFlag("flow_f17", false);
    const off = await shopOwnerTicket(owner, shop.id);
    expect(off.assignedToUserId).toBeNull();
  });

  it("staff-raised tickets are routed too; routing rules are refused while the flag is off", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id);
    const op = await createUser({ role: "OPERATOR" });
    await expect(addRoutingRule({ category: "PRODUCT_UPLOAD", userId: op.id }, actorOf(admin))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await setFlag("flow_f17", true);
    await setFlag("rbac_v2_support", true);
    await addRoutingRule({ category: "PRODUCT_UPLOAD", userId: op.id }, actorOf(admin));
    const ticket = await raiseStaffTicket({ shopId: shop.id, category: "PRODUCT_UPLOAD", subject: "Upload help", description: "Owner needs help uploading the catalogue." }, actorOf(admin));
    expect(ticket.assignedToUserId).toBe(op.id);
    // A customer cannot be named in a rule.
    const customer = await createUser({ role: "CUSTOMER" });
    await expect(addRoutingRule({ category: "ORDER", userId: customer.id }, actorOf(admin))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("F17-2 area dealer copied (flow_f17)", () => {
  async function attributedShop() {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id);
    const dealerUser = await createUser({ role: "DEALER" });
    const [dealer] = await db.insert(dealers).values({ userId: dealerUser.id, legalName: "Area Dealer", contactName: "Area Dealer", dealerType: "PROPRIETORSHIP", status: "APPROVED" }).returning();
    await db.insert(shopAttributions).values({ shopId: shop.id, dealerId: dealer.id, source: "CODE_AT_REGISTRATION", matchKind: "NONE" });
    return { owner, shop, dealerUser };
  }

  it("on: the dealer reads the ticket (no reply), sees it in their list and is notified", async () => {
    const { owner, shop, dealerUser } = await attributedShop();
    await setFlag("flow_f17", true);
    const ticket = await shopOwnerTicket(owner, shop.id);
    expect(ticket.ccDealerUserId).toBe(dealerUser.id);
    const detail = await getTicketDetail(ticket.id, actorOf(dealerUser));
    expect(detail.access).toBe("DEALER");
    expect(detail.can).toMatchObject({ reply: false, close: false, reopen: false, rate: false, manage: false });
    await expect(replyToTicket(ticket.id, actorOf(dealerUser), { body: "Looking into it" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await listMyTickets(actorOf(dealerUser))).map((t) => t.id)).toContain(ticket.id);
    const notes = await db.select().from(notifications).where(eq(notifications.userId, dealerUser.id));
    expect(notes.some((n) => n.title.includes(ticket.ticketNumber))).toBe(true);
  });

  it("off: no copy, and the dealer cannot open the ticket", async () => {
    const { owner, shop, dealerUser } = await attributedShop();
    const ticket = await shopOwnerTicket(owner, shop.id);
    expect(ticket.ccDealerUserId).toBeNull();
    await expect(getTicketDetail(ticket.id, actorOf(dealerUser))).rejects.toMatchObject({ code: "NOT_FOUND" });
    // A copy made while on stops working once the flag is off again.
    await setFlag("flow_f17", true);
    const copied = await shopOwnerTicket(owner, shop.id);
    await setFlag("flow_f17", false);
    await expect(getTicketDetail(copied.id, actorOf(dealerUser))).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await listMyTickets(actorOf(dealerUser))).length).toBe(0);
  });
});

describe("F17-3 system tickets (flow_f17)", () => {
  it("one ticket per event, routed like any ticket; nothing while the flag is off; never throws", async () => {
    expect(await openSystemTicket("PAYMENT_MISMATCH", "intent-1", { subject: "Payment not reconciled", description: "The gateway reports another amount." })).toBeNull();
    await setFlag("flow_f17", true);
    const op = await createUser({ role: "OPERATOR" });
    await addRoutingRule({ category: "REFUND_PAYMENT", userId: op.id }, actorOf(admin));
    const first = await openSystemTicket("PAYMENT_MISMATCH", "intent-1", { subject: "Payment not reconciled", description: "The gateway reports another amount." });
    const again = await openSystemTicket("PAYMENT_MISMATCH", "intent-1", { subject: "Payment not reconciled", description: "The gateway reports another amount." });
    expect(first).not.toBeNull();
    expect(again!.id).toBe(first!.id);
    expect(first).toMatchObject({ source: "PAYMENT_MISMATCH", sourceRef: "intent-1", requesterId: null, requesterRole: "SYSTEM", category: "REFUND_PAYMENT", assignedToUserId: op.id });
    // A bad reference to another table is logged, not thrown.
    await expect(openSystemTicket("DISPUTE_OPENED", "x", { subject: "Dispute", description: "Broken order link here.", orderId: "not-a-uuid" })).resolves.toBeNull();
  });

  it("opening a dispute opens a ticket when on, and only then", async () => {
    async function deliveredOrder() {
      const { user: customer } = await createUserWithWallet({ balancePaise: 500_000 });
      const owner = await createUser({ role: "SHOP_OWNER" });
      const category = await createCategory({ department: "DAIRY", name: "Milk" });
      const milk = await createProduct(category.id, { name: "Cow Milk", unit: "L" });
      const shop = await createShop(owner.id, { deliveryFeePaise: 1000, latitude: 0, longitude: 0 });
      const sp = await createShopProduct(shop.id, milk.id, { onlinePricePaise: 7000, onlineStock: 50 });
      await addToCart(customer.id, sp.id, 1);
      const { orders: created } = await checkout({ userId: customer.id, requestId: `req-${customer.id}`, addressId: await deliveryAddressId(customer.id) });
      const ownerActor = { id: owner.id, role: "SHOP_OWNER" as const };
      for (const s of ["PREPARING", "READY", "OUT_FOR_DELIVERY", "DELIVERED"] as const) await updateOrderStatus(created[0].id, s, ownerActor);
      return { order: created[0], customer: { id: customer.id, role: "CUSTOMER" as const } };
    }
    const input = { reason: "ITEM_DAMAGED" as const, description: "The milk carton arrived split and leaking.", disputedAmountPaise: 7000 };
    const off = await deliveredOrder();
    const d1 = await openDispute({ orderId: off.order.id, ...input }, off.customer);
    expect(await db.select().from(supportTickets).where(eq(supportTickets.sourceRef, d1.id))).toHaveLength(0);

    await setFlag("flow_f17", true);
    const on = await deliveredOrder();
    const d2 = await openDispute({ orderId: on.order.id, ...input }, on.customer);
    const [ticket] = await db.select().from(supportTickets).where(and(eq(supportTickets.source, "DISPUTE_OPENED"), eq(supportTickets.sourceRef, d2.id)));
    expect(ticket).toMatchObject({ orderId: on.order.id, category: "ORDER" });
  });

  it("F17-7 a society application opens an operator review ticket when on", async () => {
    const resident = await createUser({ role: "CUSTOMER" });
    const input = { name: "Green Park Society", addressLine1: "Baner Road", city: "Pune", pincode: "411045" };
    const off = await registerSociety(input, actorOf(resident));
    expect(await db.select().from(supportTickets).where(eq(supportTickets.sourceRef, off.id))).toHaveLength(0);
    await setFlag("flow_f17", true);
    const on = await registerSociety({ ...input, name: "Blue Hills Society" }, actorOf(await createUser({ role: "CUSTOMER" })));
    const [ticket] = await db.select().from(supportTickets).where(and(eq(supportTickets.source, "SOCIETY_REVIEW"), eq(supportTickets.sourceRef, on.id)));
    expect(ticket.subject).toContain("Blue Hills Society");
  });
});

describe("F17-4 shop-owner topics (flow_f17)", () => {
  it("General / Product upload / Price update: shop owners only, and only while on", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id);
    const customer = await createUser({ role: "CUSTOMER" });
    await expect(shopOwnerTicket(owner, shop.id, "PRODUCT_UPLOAD")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await setFlag("flow_f17", true);
    for (const category of ["GENERAL", "PRODUCT_UPLOAD", "PRICE_UPDATE"] as const) {
      const t = await shopOwnerTicket(owner, shop.id, category);
      expect(t.category).toBe(category);
    }
    await expect(
      createTicket({ category: "PRICE_UPDATE", subject: "Price", description: "Please change the price of milk." }, actorOf(customer)),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("F17-5 first response in working hours (flow_f17)", () => {
  const cal = { workingDays: [1, 2, 3, 4, 5, 6], startHour: 10, endHour: 19 };
  it("working-hours arithmetic (IST, Mon–Sat 10–19)", () => {
    // Fri 27-Nov-2026 18:00 IST + 4 h → Sat 13:00 IST.
    expect(addWorkingHours(new Date("2026-11-27T12:30:00Z"), 4, cal).toISOString()).toBe("2026-11-28T07:30:00.000Z");
    // Sat 18:30 IST + 4 h → Mon 13:30 IST (Sunday off).
    expect(addWorkingHours(new Date("2026-11-28T13:00:00Z"), 4, cal).toISOString()).toBe("2026-11-30T08:00:00.000Z");
    // Before opening: starts at 10:00.
    expect(addWorkingHours(new Date("2026-11-30T01:30:00Z"), 4, cal).toISOString()).toBe("2026-11-30T08:30:00.000Z");
  });

  it("on: acknowledge-by uses working hours (never later than the statutory 48 h); off: 48 h as before", async () => {
    const friday = new Date("2026-11-27T12:30:00Z");
    expect((await slaDeadlines(friday)).acknowledgeBy.toISOString()).toBe(new Date(friday.getTime() + 48 * 3_600_000).toISOString());
    await setFlag("flow_f17", true);
    expect((await slaDeadlines(friday)).acknowledgeBy.toISOString()).toBe("2026-11-28T07:30:00.000Z");
  });

  it("on: a missed first response is escalated by the hourly job", async () => {
    await setFlag("flow_f17", true);
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id);
    const ticket = await shopOwnerTicket(owner, shop.id);
    const result = await runHelpdeskSlaSweep(new Date(ticket.acknowledgeBy.getTime() + 60_000));
    expect(result.ackBreaches).toBe(1);
    const [after] = await db.select().from(supportTickets).where(eq(supportTickets.id, ticket.id));
    expect(after.status).toBe("ESCALATED");
  });
});

describe("F17-6 reopen within 7 days, closed tickets too (flow_f17)", () => {
  async function closedTicket() {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id);
    const op = await createUser({ role: "OPERATOR" });
    const ticket = await shopOwnerTicket(owner, shop.id);
    await changeTicketStatus(ticket.id, "RESOLVED", actorOf(op), "Payout sent again.");
    await changeTicketStatus(ticket.id, "CLOSED", actorOf(owner));
    return { owner, ticket };
  }

  it("on: the requester reopens a closed ticket within 7 days; not after", async () => {
    await setFlag("flow_f17", true);
    const { owner, ticket } = await closedTicket();
    expect((await getTicketDetail(ticket.id, actorOf(owner))).can.reopen).toBe(true);
    const reopened = await changeTicketStatus(ticket.id, "REOPENED", actorOf(owner), "Still not received.");
    expect(reopened.status).toBe("REOPENED");
    expect(reopened.closedAt).toBeNull();

    const late = await closedTicket();
    await db.update(supportTickets).set({ resolvedAt: new Date(Date.now() - 8 * DAY) }).where(eq(supportTickets.id, late.ticket.id));
    await expect(changeTicketStatus(late.ticket.id, "REOPENED", actorOf(late.owner), "Still not received.")).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("off: closed stays closed; a resolved ticket reopens within the old 14-day window", async () => {
    const { owner, ticket } = await closedTicket();
    expect((await getTicketDetail(ticket.id, actorOf(owner))).can.reopen).toBe(false);
    await expect(changeTicketStatus(ticket.id, "REOPENED", actorOf(owner), "Still not received.")).rejects.toMatchObject({ code: "FORBIDDEN" });

    const owner2 = await createUser({ role: "SHOP_OWNER" });
    const shop2 = await createShop(owner2.id);
    const t2 = await shopOwnerTicket(owner2, shop2.id);
    await changeTicketStatus(t2.id, "RESOLVED", actorOf(await createUser({ role: "OPERATOR" })), "Done.");
    await db.update(supportTickets).set({ resolvedAt: new Date(Date.now() - 10 * DAY) }).where(eq(supportTickets.id, t2.id));
    expect((await changeTicketStatus(t2.id, "REOPENED", actorOf(owner2), "Still not received.")).status).toBe("REOPENED");
  });
});

describe("F17-8 account recovery form (flow_f17)", () => {
  function recoverRequest(fields: Record<string, string>, file: { bytes: Buffer; name: string; type: string } | null, ip = "10.1.1.1") {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    if (file) form.append("idProof", new Blob([new Uint8Array(file.bytes)], { type: file.type }), file.name);
    return new NextRequest("http://localhost/api/account/recover", { method: "POST", body: form, headers: { "x-forwarded-for": ip } });
  }
  const fields = { name: "Asha Patil", contactEmail: "asha.new@example.com", oldMobile: "9876500000", description: "Lost my phone and my old e-mail is closed." };
  const ctx = { params: Promise.resolve({}) };

  it("off: 404", async () => {
    const res = await (recoverPost as (r: NextRequest, c: unknown) => Promise<Response>)(recoverRequest(fields, { bytes: PNG, name: "id.png", type: "image/png" }), ctx);
    expect(res.status).toBe(404);
  });

  it("on: opens an ACCOUNT ticket with the ID proof as a staff-only file; checks the file; rate-limited", async () => {
    await setFlag("flow_f17", true);
    const post = recoverPost as (r: NextRequest, c: unknown) => Promise<Response>;
    const res = await post(recoverRequest(fields, { bytes: PNG, name: "id.png", type: "image/png" }), ctx);
    expect(res.status).toBe(201);
    const body = await res.json();
    const [ticket] = await db.select().from(supportTickets).where(eq(supportTickets.ticketNumber, body.ticketNumber));
    expect(ticket).toMatchObject({ source: "ACCOUNT_RECOVERY", category: "ACCOUNT", requesterId: null, requesterEmail: "asha.new@example.com" });
    const files = await db.select().from(supportTicketAttachments).where(eq(supportTicketAttachments.ticketId, ticket.id));
    expect(files).toHaveLength(1);
    expect(files[0].internal).toBe(true);

    const bad = await post(recoverRequest(fields, { bytes: Buffer.from("not an image"), name: "id.txt", type: "text/plain" }), ctx);
    expect(bad.status).toBe(422);
    expect(await db.select().from(supportTickets).where(eq(supportTickets.source, "ACCOUNT_RECOVERY"))).toHaveLength(1);

    // Default 3 per address per hour (two used above).
    expect((await post(recoverRequest(fields, { bytes: PNG, name: "id.png", type: "image/png" }), ctx)).status).toBe(201);
    expect((await post(recoverRequest(fields, { bytes: PNG, name: "id.png", type: "image/png" }), ctx)).status).toBe(429);
  });
});

/* ======================================================================= F14 */

describe("F14-9 shop wallet created with a v2 shop (flow_f14)", () => {
  it("on: the wallet exists at once (idempotent); off: not until first use", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const offShop = await createShop(owner.id);
    await afterV2ShopCreated(offShop, { id: owner.id, role: "SHOP_OWNER" } as Parameters<typeof afterV2ShopCreated>[1]);
    expect(await db.select().from(shopWallets).where(eq(shopWallets.shopId, offShop.id))).toHaveLength(0);

    await setFlag("flow_f14", true);
    const onShop = await createShop(owner.id, { name: "Second Shop" });
    await afterV2ShopCreated(onShop, { id: owner.id, role: "SHOP_OWNER" } as Parameters<typeof afterV2ShopCreated>[1]);
    await afterV2ShopCreated(onShop, { id: owner.id, role: "SHOP_OWNER" } as Parameters<typeof afterV2ShopCreated>[1]);
    const rows = await db.select().from(shopWallets).where(eq(shopWallets.shopId, onShop.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].balancePaise).toBe(0);
  });
});

describe("F14-10 wallet ledger download (flow_f14)", () => {
  it("off: not available; on: the owner gets the month's CSV, another owner does not", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id);
    const get = (id: string) =>
      (walletStatementGet as (r: NextRequest, c: unknown) => Promise<Response>)(
        new NextRequest(`http://localhost/api/shops/${id}/wallet/statement?period=2026-11`),
        { params: Promise.resolve({ id }) },
      );
    signInAs(owner);
    expect((await get(shop.id)).status).toBe(404);
    await setFlag("flow_f14", true);
    const res = await get(shop.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("wallet-2026-11.csv");
    signInAs(await createUser({ role: "SHOP_OWNER" }));
    expect((await get(shop.id)).status).toBe(403);
  });
});

/* ======================================================================== F1 */

describe("F1-11 rider gate needs both factors (flow_f1 + dual_auth)", () => {
  it("on: a one-factor account cannot apply or open rider pages; off: as before", async () => {
    await setFlag("dual_auth", true);
    const oneFactor = await createUser({ role: "CUSTOMER", mobile: null });
    signInAs(oneFactor);

    await expect(assertRiderDualVerified(oneFactor.id)).resolves.toBeUndefined();
    expect(await riderDualVerifyRedirect(oneFactor.id, "/delivery-partner")).toBeNull();
    const before = await call(riderRegisterPost, "/api/delivery-partner", { method: "POST", body: {} });
    expect(before.body?.error?.details?.dualAuth).toBeUndefined();

    await setFlag("flow_f1", true);
    await expect(assertRiderDualVerified(oneFactor.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await riderDualVerifyRedirect(oneFactor.id, "/delivery-partner")).toBe("/account/verify?return=%2Fdelivery-partner");
    const after = await call(riderRegisterPost, "/api/delivery-partner", { method: "POST", body: {} });
    expect(after.status).toBe(403);
    expect(after.body.error.details).toMatchObject({ dualAuth: "NEEDS_SECOND_FACTOR", action: "RIDER" });

    // Both factors verified: passes.
    await db.update(users).set({ phoneE164: "+919812300001", phoneVerifiedAt: new Date(), emailVerified: new Date() }).where(eq(users.id, oneFactor.id));
    await expect(assertRiderDualVerified(oneFactor.id)).resolves.toBeUndefined();
  });
});

describe("F1-12 Terms tick recorded for Google / e-mail-link sign-ups (flow_f1)", () => {
  const ticked = () => {
    const f = new FormData();
    f.set("acceptedTerms", "1");
    return f;
  };

  it("off: nothing kept, nothing recorded here (auth.ts records as before)", async () => {
    const user = await createUser();
    await rememberSignUpTermsTick(ticked());
    expect(state.cookies.has(V2_TERMS_COOKIE)).toBe(false);
    expect(await recordSignUpTermsFromCookie(user.id)).toBe(false);
  });

  it("on: the signed tick is kept and written as the account's consent (terms + privacy)", async () => {
    await setFlag("flow_f1", true);
    await expect(rememberSignUpTermsTick(new FormData())).rejects.toThrow();
    await rememberSignUpTermsTick(ticked());
    expect(state.cookies.has(V2_TERMS_COOKIE)).toBe(true);
    const user = await createUser();
    expect(await recordSignUpTermsFromCookie(user.id)).toBe(true);
    const consents = await db.select().from(userConsents).where(eq(userConsents.userId, user.id));
    expect(consents).toHaveLength(1);
    expect(consents[0]).toMatchObject({ consentType: "TERMS_AND_PRIVACY", source: "SIGNIN_PAGE", granted: true });
    const accepted = await db.select().from(policyAcceptances).where(eq(policyAcceptances.userId, user.id));
    expect(accepted.map((a) => a.doc).sort()).toEqual(["privacy-policy", "terms"]);
    expect(state.cookies.has(V2_TERMS_COOKIE)).toBe(false);
    // A forged cookie is ignored.
    state.cookies.set(V2_TERMS_COOKIE, "2026-11-01.1790000000000.forged");
    expect(await recordSignUpTermsFromCookie((await createUser()).id)).toBe(false);
  });
});

describe("F1-13 referral link opens sign-up for a signed-out visitor (flow_f1)", () => {
  async function open(code: string) {
    const res = await referralGet(new NextRequest(`http://localhost/r/${code}`), { params: Promise.resolve({ code }) });
    return { location: res.headers.get("location"), cookie: res.headers.get("set-cookie") ?? "" };
  }

  it("onboarding v2 guest: home page when off, sign-up with the code when on; signed-in users unchanged", async () => {
    await setFlag("onboarding_v2", true);
    const off = await open("FRIEND42");
    expect(off.location).toBe("/");
    await setFlag("flow_f1", true);
    const on = await open("FRIEND42");
    expect(on.location).toBe("/signin?ref=FRIEND42");
    expect(on.cookie).toContain("FRIEND42");
    signInAs(await createUser());
    expect((await open("FRIEND42")).location).toBe("/refer");
  });
});
