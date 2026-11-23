/**
 * RBAC v2 Phases 4, 5, 7 (docs/rbac/04-support-and-change-requests.md): Support Users work only assigned tickets
 * and shops; changes go to the shop owner item by item (partial approval, rejection comment, superseded, reminders,
 * expiry — nothing applied without approval); shop-only MRP with append-only history; bulk price list as ONE request;
 * Operations → Support handover with confirmation.
 */
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/server/db";
import {
  approvalDecisions,
  approvalRequests,
  featureFlags,
  shopListingDetails,
  shopMrpHistory,
  shopProducts,
  shops,
  supportTickets,
} from "@/server/db/schema";
import { decideApproval, getApproval } from "@/server/approvals";
import { assignTicket, getTicketDetail, listAssignableStaff } from "@/server/aftercare/support-tickets";
import { checkBulkFile, proposeBulkFile } from "@/server/rbac-support/bulk";
import { proposeMasterDataCorrection, proposeShopChanges, sweepShopChangeRequests } from "@/server/rbac-support/change-requests";
import { addTeamMember, confirmResolution, managerUpdateTicket, raiseStaffTicket, supportDashboard } from "@/server/rbac-support/desk";
import { clearFeatureFlagCache } from "@/server/services/feature-flags";
import { grantRole } from "@/server/services/roles";
import { createCategory, createProduct, createShop, createShopProduct, createUser, resetDatabase } from "../helpers/fixtures";

vi.mock("@/server/email/transport", () => ({ sendEmail: vi.fn(async () => undefined) }));
vi.mock("@/server/auth", () => ({ auth: async () => null, handlers: {}, signIn: async () => {}, signOut: async () => {} }));

async function flagsOn() {
  for (const key of ["rbac_v2_support", "rbac_v2_shop_change_requests"] as const) {
    await db.insert(featureFlags).values({ key, enabled: true }).onConflictDoUpdate({ target: featureFlags.key, set: { enabled: true } });
  }
  clearFeatureFlagCache();
}

async function world() {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const shop = await createShop(owner.id, { status: "APPROVED", name: "Sai Dairy" });
  const category = await createCategory();
  const product = await createProduct(category.id, { name: "Toned Milk 1L" });
  const sp = await createShopProduct(shop.id, product.id, { onlinePricePaise: 5_000, offlineSaleEnabled: true, offlinePricePaise: 4_800 });
  await db.insert(shopListingDetails).values({ shopProductId: sp.id, shopId: shop.id, mrpPaise: 6_000 }).onConflictDoNothing();
  const manager = await createUser({ role: "SUPPORT_MANAGER" });
  const su = await createUser({ role: "SUPPORT_USER" });
  const su2 = await createUser({ role: "SUPPORT_USER" });
  const ops = await createUser({ role: "OPERATIONS_USER" });
  await db.update(shops).set({ onboardedByUserId: ops.id }).where(eq(shops.id, shop.id));
  const admin = await createUser({ role: "ADMIN" });
  await addTeamMember("SUPPORT", manager.id, su.id, { id: admin.id, role: "ADMIN" });
  await addTeamMember("SUPPORT", manager.id, su2.id, { id: admin.id, role: "ADMIN" });
  return {
    owner: { id: owner.id, role: "SHOP_OWNER" as const },
    shop,
    product,
    sp,
    manager: { id: manager.id, role: "SUPPORT_MANAGER" as const },
    su: { id: su.id, role: "SUPPORT_USER" as const },
    su2: { id: su2.id, role: "SUPPORT_USER" as const },
    ops: { id: ops.id, role: "OPERATIONS_USER" as const },
    admin: { id: admin.id, role: "ADMIN" as const, email: admin.email },
  };
}

/** Ops raises a ticket about the shop; the manager assigns it to the Support User. */
async function assignedTicket(w: Awaited<ReturnType<typeof world>>) {
  const t = await raiseStaffTicket(
    { shopId: w.shop.id, category: "PRICE_UPDATE", subject: "New price list", description: "Owner sent the new price list on WhatsApp, please update.", priority: "HIGH" },
    w.ops,
  );
  await managerUpdateTicket(t.id, { assigneeId: w.su.id }, w.manager);
  return t;
}

beforeEach(async () => {
  await resetDatabase();
  await flagsOn();
});

describe("Support User scope", () => {
  it("works only the tickets and shops assigned to them", async () => {
    const w = await world();
    const t = await assignedTicket(w);
    expect((await getTicketDetail(t.id, w.su)).ticket.id).toBe(t.id);
    await expect(getTicketDetail(t.id, w.su2)).rejects.toThrow(/not found/i);
    await expect(proposeShopChanges({ shopId: w.shop.id, reason: "fix", items: [{ target: "SHOP", field: "landmark", value: "Near temple" }] }, w.su)).rejects.toThrow(/from a ticket/);
    await expect(proposeShopChanges({ shopId: w.shop.id, ticketId: t.id, reason: "fix", items: [{ target: "SHOP", field: "landmark", value: "Near temple" }] }, w.su2)).rejects.toThrow(/not assigned to you/);
    await expect(managerUpdateTicket(t.id, { priority: "LOW" }, w.su)).rejects.toThrow(/Support Manager/);
  });

  it("an Operations User raises tickets only for shops they work on", async () => {
    const w = await world();
    const otherOwner = await createUser({ role: "SHOP_OWNER" });
    const other = await createShop(otherOwner.id, { status: "APPROVED" });
    await expect(
      raiseStaffTicket({ shopId: other.id, category: "OTHER", subject: "Hello", description: "A shop I never onboarded at all." }, w.ops),
    ).rejects.toThrow(/only for shops you work on/);
  });
});

describe("shop-owner approval of Support's changes", () => {
  it("nothing changes until approved; per-item decision; rejected items stay as they were; ticket moves on", async () => {
    const w = await world();
    const t = await assignedTicket(w);
    const req = await proposeShopChanges(
      {
        shopId: w.shop.id,
        ticketId: t.id,
        reason: "Owner's new price list",
        items: [
          { target: "SHOP_PRODUCT", shopProductId: w.sp.id, field: "onlinePricePaise", value: 5_500 },
          { target: "SHOP_PRODUCT", shopProductId: w.sp.id, field: "shopMrpPaise", value: 6_200 },
          { target: "SHOP", field: "landmark", value: "Opposite Ganesh temple" },
        ],
      },
      w.su,
    );
    expect((await db.select().from(shopProducts).where(eq(shopProducts.id, w.sp.id)))[0].onlinePricePaise).toBe(5_000);
    expect((await db.select().from(supportTickets).where(eq(supportTickets.id, t.id)))[0].status).toBe("AWAITING_SHOP");

    const { items } = await getApproval(req.id);
    await expect(decideApproval({ requestId: req.id, actor: w.su, decision: "APPROVE" })).rejects.toThrow(/Only the shop owner/);
    const landmark = items.find((i) => i.field === "landmark")!;
    const r = await decideApproval({
      requestId: req.id,
      actor: w.owner,
      decision: "APPROVE",
      items: [{ itemId: landmark.id, decision: "REJECT", comment: "The landmark is fine as it is" }],
    });
    expect(r.request.status).toBe("PARTIALLY_APPROVED");
    expect((await db.select().from(shopProducts).where(eq(shopProducts.id, w.sp.id)))[0].onlinePricePaise).toBe(5_500);
    expect((await db.select().from(shopListingDetails).where(eq(shopListingDetails.shopProductId, w.sp.id)))[0].mrpPaise).toBe(6_200);
    expect((await db.select().from(shops).where(eq(shops.id, w.shop.id)))[0].landmark).not.toBe("Opposite Ganesh temple");
    // Shop-only MRP history, append-only.
    const history = await db.select().from(shopMrpHistory).where(eq(shopMrpHistory.shopProductId, w.sp.id));
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ previousMrpPaise: 6_000, newMrpPaise: 6_200, source: "CHANGE_REQUEST" });
    await expect(db.delete(shopMrpHistory)).rejects.toThrow();
    // Something was rejected → back to In Progress for rework.
    expect((await db.select().from(supportTickets).where(eq(supportTickets.id, t.id)))[0].status).toBe("IN_PROGRESS");
  });

  it("refuses a selling price above the MRP", async () => {
    const w = await world();
    const t = await assignedTicket(w);
    await expect(
      proposeShopChanges({ shopId: w.shop.id, ticketId: t.id, reason: "price", items: [{ target: "SHOP_PRODUCT", shopProductId: w.sp.id, field: "onlinePricePaise", value: 6_500 }] }, w.su),
    ).rejects.toThrow(/above the MRP/);
  });

  it("all approved → the ticket is resolved; the Operations User confirms and it closes", async () => {
    const w = await world();
    const t = await assignedTicket(w);
    const req = await proposeShopChanges({ shopId: w.shop.id, ticketId: t.id, reason: "List", items: [{ target: "SHOP_PRODUCT", shopProductId: w.sp.id, field: "offlinePricePaise", value: 4_900 }] }, w.su);
    await decideApproval({ requestId: req.id, actor: w.owner, decision: "APPROVE" });
    expect((await db.select().from(supportTickets).where(eq(supportTickets.id, t.id)))[0].status).toBe("RESOLVED");
    await expect(confirmResolution(t.id, w.su2)).rejects.toThrow(/Only whoever raised/);
    expect((await confirmResolution(t.id, w.ops)).status).toBe("CLOSED");
  });

  it("superseded when the owner edits the same field; nothing applied from it", async () => {
    const w = await world();
    const t = await assignedTicket(w);
    const req = await proposeShopChanges({ shopId: w.shop.id, ticketId: t.id, reason: "List", items: [{ target: "SHOP_PRODUCT", shopProductId: w.sp.id, field: "onlinePricePaise", value: 5_200 }] }, w.su);
    await db.update(shopProducts).set({ onlinePricePaise: 5_100 }).where(eq(shopProducts.id, w.sp.id)); // the owner's own edit
    const out = await sweepShopChangeRequests();
    expect(out.superseded).toBe(1);
    const detail = await getApproval(req.id);
    expect(detail.request.status).toBe("SUPERSEDED");
    expect(detail.items[0].status).toBe("SUPERSEDED");
    expect((await db.select().from(shopProducts).where(eq(shopProducts.id, w.sp.id)))[0].onlinePricePaise).toBe(5_100);
  });

  it("reminders at 24 h and 72 h; expiry after 7 days → Pending Information, nothing applied", async () => {
    const w = await world();
    const t = await assignedTicket(w);
    const req = await proposeShopChanges({ shopId: w.shop.id, ticketId: t.id, reason: "List", items: [{ target: "SHOP", field: "landmark", value: "Market road" }] }, w.su);
    await db.update(approvalRequests).set({ requestedAt: new Date(Date.now() - 25 * 3_600_000) }).where(eq(approvalRequests.id, req.id));
    expect((await sweepShopChangeRequests()).reminded).toBe(1);
    expect((await sweepShopChangeRequests()).reminded).toBe(0);
    await db.update(approvalRequests).set({ requestedAt: new Date(Date.now() - 73 * 3_600_000) }).where(eq(approvalRequests.id, req.id));
    expect((await sweepShopChangeRequests()).reminded).toBe(1);
    const reminders = await db.select().from(approvalDecisions).where(and(eq(approvalDecisions.requestId, req.id), eq(approvalDecisions.action, "REMIND")));
    expect(reminders).toHaveLength(2);

    await db.update(approvalRequests).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(approvalRequests.id, req.id));
    expect((await sweepShopChangeRequests()).expired).toBe(1);
    expect((await getApproval(req.id)).request.status).toBe("EXPIRED");
    const [ticket] = await db.select().from(supportTickets).where(eq(supportTickets.id, t.id));
    expect(ticket.subStatus).toBe("PENDING_INFORMATION");
    expect((await db.select().from(shops).where(eq(shops.id, w.shop.id)))[0].landmark).not.toBe("Market road");
    await expect(decideApproval({ requestId: req.id, actor: w.owner, decision: "APPROVE" })).rejects.toThrow(/already been decided/);
  });

  it("master product data is never written by Support — an admin decides", async () => {
    const w = await world();
    const req = await proposeMasterDataCorrection({ productId: w.product.id, field: "name", proposedValue: "Toned Milk 1 L", reason: "Spelling fix requested" }, w.su);
    await expect(decideApproval({ requestId: req.id, actor: w.owner, decision: "APPROVE" })).rejects.toThrow(/Only an admin/);
    expect(req.checker).toBe("ADMIN");
  });
});

describe("bulk price list", () => {
  it("good rows become ONE request with many items; bad rows come back with reasons", async () => {
    const w = await world();
    const t = await assignedTicket(w);
    const csv = [
      "shop_product_id,product_name,barcode,online_price_inr,offline_price_inr,mrp_inr,available",
      `${w.sp.id},Toned Milk,,52.00,49,62,yes`,
      `00000000-0000-0000-0000-000000000000,Ghost,,10,,,yes`,
      `${w.sp.id},Toned Milk again,,1,,,`,
    ].join("\n");
    const checked = await checkBulkFile(w.shop.id, Buffer.from(csv), "list.csv");
    expect(checked.errors.map((e) => e.row)).toEqual([3, 4]);
    const out = await proposeBulkFile({ shopId: w.shop.id, ticketId: t.id, reason: "WhatsApp list", file: Buffer.from(csv), filename: "list.csv" }, w.su);
    expect(out.request).not.toBeNull();
    expect(out.changes).toBe(3);
    const all = await db.select().from(approvalRequests).where(eq(approvalRequests.shopId, w.shop.id));
    expect(all).toHaveLength(1);
    expect((await getApproval(out.request!.id)).items).toHaveLength(3);
  });

  it("a price above MRP in the file is a row error", async () => {
    const w = await world();
    const csv = ["shop_product_id,online_price_inr,mrp_inr", `${w.sp.id},70,60`].join("\n");
    const checked = await checkBulkFile(w.shop.id, Buffer.from(csv), "list.csv");
    expect(checked.items).toHaveLength(0);
    expect(checked.errors[0].message).toMatch(/above the MRP/);
  });
});

describe("staff teams", () => {
  it("accepts a manager or member who holds the role as a grant while acting in another role", async () => {
    const w = await world();
    const multi = await createUser({ role: "OPERATIONS_MANAGER" });
    await grantRole(multi.id, "SUPPORT_MANAGER", { source: "ADMIN", grantedBy: w.admin.id });
    const other = await createUser({ role: "OPERATIONS_USER" });
    await grantRole(other.id, "SUPPORT_USER", { source: "ADMIN", grantedBy: w.admin.id });
    const row = await addTeamMember("SUPPORT", multi.id, other.id, w.admin);
    expect(row.managerUserId).toBe(multi.id);
    const plain = await createUser({ role: "OPERATIONS_USER" });
    await expect(addTeamMember("SUPPORT", plain.id, other.id, w.admin)).rejects.toThrow(/must hold the SUPPORT_MANAGER/);
  });

  it("a ticket can be assigned to someone who holds Support User as a grant while acting as Operations User", async () => {
    const w = await world();
    const t = await assignedTicket(w);
    const multi = await createUser({ role: "OPERATIONS_USER" });
    await grantRole(multi.id, "SUPPORT_USER", { source: "ADMIN", grantedBy: w.admin.id });
    const moved = await assignTicket(t.id, multi.id, w.admin);
    expect(moved.assignedToUserId).toBe(multi.id);
    expect((await listAssignableStaff()).some((s) => s.id === multi.id)).toBe(true);
    const plainOps = await createUser({ role: "OPERATIONS_USER" });
    await expect(assignTicket(t.id, plainOps.id, w.admin)).rejects.toThrow(/Assign the ticket to a support team member/);
  });
});

describe("Support Manager dashboard", () => {
  it("counts the queue and each team member's workload", async () => {
    const w = await world();
    await assignedTicket(w);
    const d = await supportDashboard(w.manager);
    expect(d.team.find((m) => m.userId === w.su.id)?.open).toBe(1);
    await expect(supportDashboard(w.su)).rejects.toThrow(/Support Manager/);
  });
});
