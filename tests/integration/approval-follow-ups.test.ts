/**
 * Approvals answer as soon as the decision is saved: the audit, the seller's
 * notice, the auto-approval check and the commission milestone are handed to
 * `defer` (Next's `after` in the routes) and run afterwards. Without `defer`,
 * or when `defer` refuses (outside a request), they run before returning.
 */
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runOrDefer, type Defer } from "@/server/api/defer";
import { db } from "@/server/db";
import * as events from "@/server/events/emit";
import { auditLogs, domainEvents, notifications, sellerVerifications, shops } from "@/server/db/schema";
import { AUDIT_ACTIONS } from "@/server/services/audit";
import { NOTIFICATION_TYPES } from "@/server/services/notifications";
import { decideShopDocument } from "@/server/services/operator-limited";
import { adminDecideVerification, submitSellerDocument } from "@/server/services/seller-verification";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { approveShop } from "@/server/services/shops";
import { createShop, createUser, resetDatabase, verifySellerDocuments } from "../helpers/fixtures";

beforeEach(async () => {
  await resetDatabase();
  clearRuleCache();
});

/** A `defer` that keeps the tasks, so a test can look before and after they run. */
function captureDefer() {
  const tasks: (() => Promise<void>)[] = [];
  const defer: Defer = (task) => {
    tasks.push(task);
  };
  const runAll = async () => {
    for (const task of tasks.splice(0)) await task();
  };
  return { defer, tasks, runAll };
}

const notesFor = (userId: string, type: string) =>
  db.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.type, type)));
const auditsFor = (action: string, entityId: string) =>
  db.select().from(auditLogs).where(and(eq(auditLogs.action, action), eq(auditLogs.entityId, entityId)));

async function setup() {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const admin = await createUser({ role: "ADMIN" });
  const shop = await createShop(owner.id, { name: "Shree Dairy", status: "PENDING_APPROVAL" });
  const view = await submitSellerDocument({
    shopId: shop.id,
    docType: "SHOP_ACT",
    number: "PMC/SHOP/12345",
    consentGiven: true,
    actor: { id: owner.id, role: "SHOP_OWNER" },
  });
  expect(view.status).toBe("MANUAL_REVIEW");
  return { owner, admin, shop, verificationId: view.id!, adminActor: { id: admin.id, role: "ADMIN" as const } };
}

describe("runOrDefer", () => {
  it("hands the task to defer and does not run it", async () => {
    const { defer, tasks } = captureDefer();
    let ran = false;
    await runOrDefer(async () => {
      ran = true;
    }, defer);
    expect(ran).toBe(false);
    expect(tasks).toHaveLength(1);
  });

  it("runs the task now without defer, or when defer refuses it (after() outside a request)", async () => {
    let runs = 0;
    const task = async () => {
      runs += 1;
    };
    await runOrDefer(task);
    await runOrDefer(task, () => {
      throw new Error("`after` was called outside a request scope.");
    });
    expect(runs).toBe(2);
  });
});

describe("seller document decision", () => {
  it("answers once the decision is saved; audit, notice and event follow", async () => {
    const { owner, shop, verificationId, adminActor } = await setup();
    const { defer, tasks, runAll } = captureDefer();

    const view = await adminDecideVerification(verificationId, { decision: "approve", reason: "" }, adminActor, { defer });

    // The answer: the decision is saved.
    expect(view.status).toBe("VERIFIED");
    const [row] = await db.select().from(sellerVerifications).where(eq(sellerVerifications.id, verificationId));
    expect(row).toMatchObject({ status: "VERIFIED", reviewerId: adminActor.id });
    // Nothing of the follow-up has happened yet.
    expect(tasks).toHaveLength(1);
    expect(await auditsFor(AUDIT_ACTIONS.SELLER_DOCUMENT_APPROVED, shop.id)).toHaveLength(0);
    expect(await notesFor(owner.id, NOTIFICATION_TYPES.SHOP_DOCUMENT_VERIFIED)).toHaveLength(0);
    expect(await db.select().from(domainEvents).where(eq(domainEvents.type, "seller_document.decided"))).toHaveLength(0);

    await runAll();

    expect(await auditsFor(AUDIT_ACTIONS.SELLER_DOCUMENT_APPROVED, shop.id)).toHaveLength(1);
    expect(await db.select().from(domainEvents).where(eq(domainEvents.type, "seller_document.decided"))).toHaveLength(1);
  });

  it("without defer everything is done before the answer, as before", async () => {
    const { shop, verificationId, adminActor } = await setup();
    await adminDecideVerification(verificationId, { decision: "reject", reason: "Number does not match the certificate." }, adminActor);
    expect(await auditsFor(AUDIT_ACTIONS.SELLER_DOCUMENT_REJECTED, shop.id)).toHaveLength(1);
    expect(await db.select().from(domainEvents).where(eq(domainEvents.type, "seller_document.decided"))).toHaveLength(1);
  });

  it("the last verified document approves the shop in the follow-up, not before the answer", async () => {
    const { owner, shop, verificationId, adminActor } = await setup();
    await setRule("sellerVerification", { autoApproveShop: true }, adminActor);
    await db.update(shops).set({ feePaymentStatus: "PAID", classification: null }).where(eq(shops.id, shop.id));
    await verifySellerDocuments(shop.id, ["PAN", "GSTIN", "FSSAI", "UDYAM"]);
    const { defer, runAll } = captureDefer();

    await adminDecideVerification(verificationId, { decision: "approve", reason: "" }, adminActor, { defer });
    const [before] = await db.select().from(shops).where(eq(shops.id, shop.id));
    expect(before.status).toBe("PENDING_APPROVAL");

    await runAll();

    const [afterRun] = await db.select().from(shops).where(eq(shops.id, shop.id));
    expect(afterRun).toMatchObject({ status: "APPROVED", classification: "GREEN" });
    expect(await notesFor(owner.id, NOTIFICATION_TYPES.SHOP_APPROVED)).toHaveLength(1);
  });

  it("a failing notice is logged, never thrown at the reviewer; the rest of the follow-up still runs", async () => {
    const { shop, verificationId, adminActor } = await setup();
    const { defer, runAll } = captureDefer();
    await adminDecideVerification(verificationId, { decision: "approve", reason: "" }, adminActor, { defer });

    const failing = vi.spyOn(events, "emitEvent").mockRejectedValueOnce(new Error("notification store down"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(runAll()).resolves.toBeUndefined();
      expect(failing).toHaveBeenCalledTimes(1);
      expect(logged).toHaveBeenCalledWith("[seller-verification] decision notice failed", verificationId, expect.any(Error));
      expect(await auditsFor(AUDIT_ACTIONS.SELLER_DOCUMENT_APPROVED, shop.id)).toHaveLength(1);
    } finally {
      failing.mockRestore();
      logged.mockRestore();
    }
  });
});

describe("operator-limited document decision", () => {
  it("defers the decision's follow-ups and its own audit", async () => {
    const { shop, verificationId } = await setup();
    const oplim = await createUser({ role: "OPERATOR_LIMITED" });
    await db.update(shops).set({ onboardedByUserId: oplim.id }).where(eq(shops.id, shop.id));
    const { defer, tasks, runAll } = captureDefer();

    const view = await decideShopDocument(
      verificationId,
      { decision: "approve", reason: "" },
      { id: oplim.id, role: "OPERATOR_LIMITED", email: oplim.email, name: oplim.name },
      { defer },
    );

    expect(view.status).toBe("VERIFIED");
    expect(tasks).toHaveLength(2);
    expect(await auditsFor(AUDIT_ACTIONS.OPLTD_DOCUMENT_DECIDED, shop.id)).toHaveLength(0);

    await runAll();

    expect(await auditsFor(AUDIT_ACTIONS.OPLTD_DOCUMENT_DECIDED, shop.id)).toHaveLength(1);
    expect(await auditsFor(AUDIT_ACTIONS.SELLER_DOCUMENT_APPROVED, shop.id)).toHaveLength(1);
  });
});

describe("shop approval", () => {
  it("answers with the approved shop (audit in the transaction); the owner's notice follows", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const admin = await createUser({ role: "ADMIN" });
    const shop = await createShop(owner.id, { status: "PENDING_APPROVAL", shopType: "HARDWARE_STORE" });
    await verifySellerDocuments(shop.id, ["PAN", "GSTIN", "SHOP_ACT"]);
    await db.update(shops).set({ feePaymentStatus: "PAID" }).where(eq(shops.id, shop.id));
    const { defer, tasks, runAll } = captureDefer();

    const approved = await approveShop(shop.id, { classification: "GREEN" }, { id: admin.id, role: "ADMIN" }, { defer });

    expect(approved.status).toBe("APPROVED");
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entityId, shop.id));
    expect(audits.length).toBeGreaterThan(0);
    expect(tasks).toHaveLength(1);
    expect(await notesFor(owner.id, NOTIFICATION_TYPES.SHOP_APPROVED)).toHaveLength(0);

    await runAll();

    expect(await notesFor(owner.id, NOTIFICATION_TYPES.SHOP_APPROVED)).toHaveLength(1);
  });
});
