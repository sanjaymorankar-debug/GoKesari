/**
 * Wave 1 — access & security foundation (docs/gokesari-audit/
 * GOKESARI_IMPLEMENTATION_PRIORITY.csv, wave 1):
 *  - personal vs B2B orders as separate flows (RBAC-002 decision)
 *  - SOCIETY_ADMIN role skeleton (GS-002)
 *  - marketing consent grant/withdraw with history (GS-070)
 *  - append-only audit log (GS-067)
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { can, PERMISSIONS, ROLE_PERMISSIONS } from "@/server/authz/permissions";
import { db } from "@/server/db";
import { auditLogs, orders, userConsents } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { addToCart } from "@/server/services/cart";
import {
  getMarketingConsentStatus,
  hasCurrentConsent,
  recordConsent,
  setMarketingConsent,
} from "@/server/services/consents";
import { checkout, listOrdersForUser } from "@/server/services/orders";
import {
  createCategory,
  createProduct,
  createShop,
  createShopProduct,
  createUser,
  createUserWithWallet,
  resetDatabase,
} from "../helpers/fixtures";

beforeEach(resetDatabase);

/** A supplier shop selling milk at ₹70, plus a buyer who owns a shop of their own. */
async function b2bSetup() {
  const { user: buyer } = await createUserWithWallet({ role: "SHOP_OWNER", balancePaise: 100_000 });
  const supplierOwner = await createUser({ role: "SHOP_OWNER" });
  const cat = await createCategory({ department: "DAIRY", name: "Milk" });
  const milk = await createProduct(cat.id, { name: "Cow Milk", unit: "L" });
  const supplier = await createShop(supplierOwner.id, { name: "Wholesale Dairy" });
  const supplierMilk = await createShopProduct(supplier.id, milk.id, { onlinePricePaise: 7000 });
  const buyerShop = await createShop(buyer.id, { name: "Corner Store" });
  const buyerShopMilk = await createShopProduct(buyerShop.id, milk.id, { onlinePricePaise: 7500 });
  return { buyer, supplier, supplierMilk, buyerShop, buyerShopMilk };
}

describe("roles and permissions", () => {
  it("grants B2B ordering only to shop owners and admins", () => {
    expect(can("SHOP_OWNER", PERMISSIONS.ORDER_PLACE_B2B)).toBe(true);
    expect(can("ADMIN", PERMISSIONS.ORDER_PLACE_B2B)).toBe(true);
    for (const role of ["CUSTOMER", "DELIVERY_PARTNER", "OPERATOR", "SOCIETY_ADMIN"] as const) {
      expect(can(role, PERMISSIONS.ORDER_PLACE_B2B)).toBe(false);
    }
  });

  it("keeps personal ordering for every role that had it", () => {
    for (const role of ["CUSTOMER", "SHOP_OWNER", "DELIVERY_PARTNER", "OPERATOR", "ADMIN"] as const) {
      expect(can(role, PERMISSIONS.ORDER_PLACE)).toBe(true);
    }
  });

  it("gives the society admin skeleton customer capabilities and nothing administrative", () => {
    expect(new Set(ROLE_PERMISSIONS.SOCIETY_ADMIN)).toEqual(new Set(ROLE_PERMISSIONS.CUSTOMER));
    expect(can("SOCIETY_ADMIN", PERMISSIONS.ORDER_VIEW_ANY)).toBe(false);
    expect(can("SOCIETY_ADMIN", PERMISSIONS.USER_SET_ROLE)).toBe(false);
  });

  it("stores a SOCIETY_ADMIN user", async () => {
    const user = await createUser({ role: "SOCIETY_ADMIN" });
    expect(user.role).toBe("SOCIETY_ADMIN");
  });
});

describe("personal and B2B orders are separate flows", () => {
  it("records a normal checkout as PERSONAL with no buyer shop", async () => {
    const { buyer, supplierMilk } = await b2bSetup();
    await addToCart(buyer.id, supplierMilk.id, 1);
    const { orders: placed } = await checkout({ userId: buyer.id, requestId: "personal-req-1" });
    expect(placed[0].orderType).toBe("PERSONAL");
    expect(placed[0].buyerShopId).toBeNull();
  });

  it("records a B2B order against the owner's own approved shop", async () => {
    const { buyer, supplierMilk, buyerShop } = await b2bSetup();
    await addToCart(buyer.id, supplierMilk.id, 2);
    const { orders: placed } = await checkout({
      userId: buyer.id,
      actorRole: "SHOP_OWNER",
      requestId: "b2b-req-1",
      orderType: "B2B",
      buyerShopId: buyerShop.id,
    });
    expect(placed).toHaveLength(1);
    expect(placed[0].orderType).toBe("B2B");
    expect(placed[0].buyerShopId).toBe(buyerShop.id);

    expect(await listOrdersForUser(buyer.id, { orderType: "B2B" })).toHaveLength(1);
    expect(await listOrdersForUser(buyer.id, { orderType: "PERSONAL" })).toHaveLength(0);
  });

  it("refuses B2B for a role without the permission", async () => {
    const { buyer, supplierMilk, buyerShop } = await b2bSetup();
    await addToCart(buyer.id, supplierMilk.id, 1);
    await expect(
      checkout({
        userId: buyer.id,
        actorRole: "CUSTOMER",
        requestId: "b2b-req-2",
        orderType: "B2B",
        buyerShopId: buyerShop.id,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses B2B on behalf of someone else's shop", async () => {
    const { buyer, supplierMilk, supplier } = await b2bSetup();
    await addToCart(buyer.id, supplierMilk.id, 1);
    await expect(
      checkout({
        userId: buyer.id,
        actorRole: "SHOP_OWNER",
        requestId: "b2b-req-3",
        orderType: "B2B",
        buyerShopId: supplier.id,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses B2B for a shop that is not approved", async () => {
    const { buyer, supplierMilk } = await b2bSetup();
    const pending = await createShop(buyer.id, { name: "New Branch", status: "PENDING_APPROVAL" });
    await addToCart(buyer.id, supplierMilk.id, 1);
    await expect(
      checkout({
        userId: buyer.id,
        actorRole: "SHOP_OWNER",
        requestId: "b2b-req-4",
        orderType: "B2B",
        buyerShopId: pending.id,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("refuses a B2B order from the buying shop to itself", async () => {
    const { buyer, buyerShopMilk, buyerShop } = await b2bSetup();
    await addToCart(buyer.id, buyerShopMilk.id, 1);
    await expect(
      checkout({
        userId: buyer.id,
        actorRole: "SHOP_OWNER",
        requestId: "b2b-req-5",
        orderType: "B2B",
        buyerShopId: buyerShop.id,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await db.select().from(orders)).toHaveLength(0);
  });

  it("requires a buyer shop for B2B and forbids one for PERSONAL", async () => {
    const { buyer, supplierMilk, buyerShop } = await b2bSetup();
    await addToCart(buyer.id, supplierMilk.id, 1);
    await expect(
      checkout({ userId: buyer.id, actorRole: "SHOP_OWNER", requestId: "b2b-req-6", orderType: "B2B" }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      checkout({ userId: buyer.id, requestId: "b2b-req-7", orderType: "PERSONAL", buyerShopId: buyerShop.id }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("marketing consent", () => {
  it("is off until granted, can be withdrawn, and keeps its full history", async () => {
    const user = await createUser();
    expect((await getMarketingConsentStatus(user.id)).granted).toBe(false);

    await setMarketingConsent(user.id, true, { ipAddress: "10.0.0.1" });
    expect((await getMarketingConsentStatus(user.id)).granted).toBe(true);

    await setMarketingConsent(user.id, false);
    const status = await getMarketingConsentStatus(user.id);
    expect(status.granted).toBe(false);
    expect(status.lastChangedAt).not.toBeNull();

    const rows = await db.select().from(userConsents).where(eq(userConsents.userId, user.id));
    expect(rows.map((r) => r.granted).sort()).toEqual([false, true]);
  });

  it("does not let a withdrawn row count as current consent", async () => {
    const user = await createUser();
    await recordConsent(user.id, "TERMS_AND_PRIVACY");
    expect(await hasCurrentConsent(user.id, "TERMS_AND_PRIVACY")).toBe(true);
    await setMarketingConsent(user.id, false);
    expect(await hasCurrentConsent(user.id, "MARKETING_COMMUNICATIONS")).toBe(false);
    // Unrelated consent types are untouched by a marketing change.
    expect(await hasCurrentConsent(user.id, "TERMS_AND_PRIVACY")).toBe(true);
  });

  it("writes an audit entry for each change", async () => {
    const user = await createUser();
    await setMarketingConsent(user.id, true);
    const entries = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, AUDIT_ACTIONS.CONSENT_RECORDED));
    expect(entries).toHaveLength(1);
    expect(entries[0].newValue).toMatchObject({ consentType: "MARKETING_COMMUNICATIONS", granted: true });
  });
});

describe("audit log is append-only", () => {
  it("accepts inserts but refuses UPDATE and DELETE at the database", async () => {
    const actor = await createUser({ role: "ADMIN" });
    await recordAudit({
      actorId: actor.id,
      action: AUDIT_ACTIONS.USER_ROLE_CHANGED,
      entityType: "user",
      entityId: actor.id,
    });
    const [row] = await db.select().from(auditLogs);
    expect(row).toBeDefined();

    await expect(
      db.update(auditLogs).set({ action: "tampered" }).where(eq(auditLogs.id, row.id)),
    ).rejects.toThrow();
    await expect(db.delete(auditLogs).where(eq(auditLogs.id, row.id))).rejects.toThrow();
    await expect(db.execute(sql`DELETE FROM audit_logs`)).rejects.toThrow();

    const [still] = await db.select().from(auditLogs).where(eq(auditLogs.id, row.id));
    expect(still.action).toBe(AUDIT_ACTIONS.USER_ROLE_CHANGED);
  });
});
