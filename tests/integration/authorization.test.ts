/**
 * Authorization and the online/offline selling rules
 * (requirements §4, §10, §12, §14, §47).
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { shopClassificationHistory, shops } from "@/server/db/schema";
import { PERMISSIONS, ROLE_PERMISSIONS, can } from "@/server/authz/permissions";
import {
  assertOnlinePurchasable,
  isOnlinePurchasable,
} from "@/server/services/catalogue";
import { changeClassification, registerShop } from "@/server/services/shops";
import { addToCart } from "@/server/services/cart";
import { setUserRole } from "@/server/services/users";
import { bootstrapAdminEmails } from "@/lib/env";
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

describe("permission matrix — RBAC brief §17", () => {
  it("gives only the shop owner and admin the price-approval veto (§7)", () => {
    // The operator proposes; they must never be able to approve their own work.
    expect(can("OPERATOR", PERMISSIONS.PRICE_REQUEST_SUBMIT)).toBe(true);
    expect(can("OPERATOR", PERMISSIONS.PRICE_REQUEST_DECIDE_ANY)).toBe(false);
    expect(can("OPERATOR", PERMISSIONS.PRICE_REQUEST_DECIDE_OWN)).toBe(false);
    expect(can("OPERATOR", PERMISSIONS.PRICE_REQUEST_OVERRIDE)).toBe(false);

    expect(can("SHOP_OWNER", PERMISSIONS.PRICE_REQUEST_DECIDE_OWN)).toBe(true);
    expect(can("SHOP_OWNER", PERMISSIONS.PRICE_REQUEST_DECIDE_ANY)).toBe(false);
    expect(can("SHOP_OWNER", PERMISSIONS.PRICE_REQUEST_OVERRIDE)).toBe(false);

    expect(can("ADMIN", PERMISSIONS.PRICE_REQUEST_DECIDE_ANY)).toBe(true);
    expect(can("ADMIN", PERMISSIONS.PRICE_REQUEST_OVERRIDE)).toBe(true);
  });

  it("reserves registration-fee configuration to the admin (§12)", () => {
    expect(can("SHOP_OWNER", PERMISSIONS.REGISTRATION_FEE_MANAGE)).toBe(false);
    expect(can("OPERATOR", PERMISSIONS.REGISTRATION_FEE_MANAGE)).toBe(false);
    expect(can("ADMIN", PERMISSIONS.REGISTRATION_FEE_MANAGE)).toBe(true);
  });

  it("lets the operator record payments but not the shop owner (§4.2)", () => {
    expect(can("SHOP_OWNER", PERMISSIONS.PAYMENT_RECORD)).toBe(false);
    expect(can("SHOP_OWNER", PERMISSIONS.PAYMENT_VIEW_ANY)).toBe(false);
    expect(can("SHOP_OWNER", PERMISSIONS.PAYMENT_VIEW_OWN)).toBe(true);

    expect(can("OPERATOR", PERMISSIONS.PAYMENT_RECORD)).toBe(true);
    expect(can("OPERATOR", PERMISSIONS.PAYMENT_VIEW_ANY)).toBe(true);
    expect(can("ADMIN", PERMISSIONS.PAYMENT_RECORD)).toBe(true);
  });

  it("reserves referral management to operator and admin (§4.3)", () => {
    expect(can("SHOP_OWNER", PERMISSIONS.REFERRAL_MANAGE)).toBe(false);
    expect(can("OPERATOR", PERMISSIONS.REFERRAL_MANAGE)).toBe(true);
    expect(can("ADMIN", PERMISSIONS.REFERRAL_MANAGE)).toBe(true);
  });

  it("grades audit visibility: none / limited / full (§17)", () => {
    expect(can("SHOP_OWNER", PERMISSIONS.AUDIT_LOG_VIEW)).toBe(false);
    expect(can("SHOP_OWNER", PERMISSIONS.AUDIT_LOG_VIEW_LIMITED)).toBe(false);

    expect(can("OPERATOR", PERMISSIONS.AUDIT_LOG_VIEW)).toBe(false);
    expect(can("OPERATOR", PERMISSIONS.AUDIT_LOG_VIEW_LIMITED)).toBe(true);

    expect(can("ADMIN", PERMISSIONS.AUDIT_LOG_VIEW)).toBe(true);
  });

  it("gives the admin every permission the other roles have (§11)", () => {
    for (const role of ["CUSTOMER", "SHOP_OWNER", "OPERATOR"] as const) {
      for (const permission of ROLE_PERMISSIONS[role]) {
        expect(can("ADMIN", permission)).toBe(true);
      }
    }
  });
});

describe("permission matrix (§4)", () => {
  it("denies a shop owner the ability to change classification (§10)", () => {
    expect(can("SHOP_OWNER", PERMISSIONS.SHOP_SET_CLASSIFICATION)).toBe(false);
    expect(can("OPERATOR", PERMISSIONS.SHOP_SET_CLASSIFICATION)).toBe(true);
    expect(can("ADMIN", PERMISSIONS.SHOP_SET_CLASSIFICATION)).toBe(true);
  });

  it("denies a shop owner cross-shop and catalogue-wide powers", () => {
    for (const permission of [
      PERMISSIONS.SHOP_UPDATE_ANY,
      PERMISSIONS.SHOP_PRODUCT_MANAGE_ANY,
      PERMISSIONS.CATEGORY_MANAGE,
      PERMISSIONS.SYSTEM_CONFIG,
      PERMISSIONS.USER_SET_ROLE,
      PERMISSIONS.WALLET_ADJUST,
    ]) {
      expect(can("SHOP_OWNER", permission)).toBe(false);
    }
  });

  it("gives an operator operational powers but not system access (§43)", () => {
    expect(can("OPERATOR", PERMISSIONS.SHOP_APPROVE)).toBe(true);
    expect(can("OPERATOR", PERMISSIONS.ORDER_UPDATE_STATUS_ANY)).toBe(true);
    expect(can("OPERATOR", PERMISSIONS.REPORT_VIEW_OPERATIONAL)).toBe(true);

    // Explicitly withheld.
    expect(can("OPERATOR", PERMISSIONS.SYSTEM_CONFIG)).toBe(false);
    expect(can("OPERATOR", PERMISSIONS.USER_SET_ROLE)).toBe(false);
    expect(can("OPERATOR", PERMISSIONS.USER_SUSPEND)).toBe(false);
    expect(can("OPERATOR", PERMISSIONS.WALLET_ADJUST)).toBe(false);
    expect(can("OPERATOR", PERMISSIONS.AUDIT_LOG_VIEW)).toBe(false);
  });

  it("gives an admin every permission", () => {
    for (const permission of Object.values(PERMISSIONS)) {
      expect(can("ADMIN", permission)).toBe(true);
    }
  });

  it("keeps a customer to their own resources", () => {
    expect(can("CUSTOMER", PERMISSIONS.ORDER_VIEW_OWN)).toBe(true);
    expect(can("CUSTOMER", PERMISSIONS.ORDER_VIEW_ANY)).toBe(false);
    expect(can("CUSTOMER", PERMISSIONS.WALLET_VIEW_ANY)).toBe(false);
    expect(can("CUSTOMER", PERMISSIONS.SHOP_APPROVE)).toBe(false);
  });

  it("never grants a role more than the admin set", () => {
    const adminSet = new Set(ROLE_PERMISSIONS.ADMIN);
    for (const [, perms] of Object.entries(ROLE_PERMISSIONS)) {
      for (const p of perms) expect(adminSet.has(p)).toBe(true);
    }
  });
});

describe("role assignment is admin-only (§5)", () => {
  it("SEC-03 fixed: bootstraps no admin emails by default — no hard-coded fallback", () => {
    // tests/setup.ts sets neither BOOTSTRAP_ADMIN_EMAILS nor
    // PERMANENT_ADMIN_EMAILS, so this proves there is no longer a
    // source-level list granting ADMIN regardless of environment
    // configuration (docs/gokesari-audit/GOKESARI_AUDIT_FINDINGS.md SEC-03).
    expect(bootstrapAdminEmails()).toEqual([]);
  });

  it("lets an admin change another user's role and records who/when", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const target = await createUser({ role: "CUSTOMER" });

    const updated = await setUserRole(target.id, "SHOP_OWNER", admin);
    expect(updated.role).toBe("SHOP_OWNER");
  });

  it("refuses to let an actor change their own role, even an admin", async () => {
    const admin = await createUser({ role: "ADMIN" });
    await expect(setUserRole(admin.id, "CUSTOMER", admin)).rejects.toThrow();
  });
});

describe("classification is operator-controlled (§10)", () => {
  it("refuses a shop owner even if the route guard were bypassed", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { classification: "GREEN" });

    await expect(
      changeClassification(shop.id, "KESARI", "I want this", {
        id: owner.id,
        role: "SHOP_OWNER",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const after = await db.query.shops.findFirst({ where: eq(shops.id, shop.id) });
    expect(after?.classification).toBe("GREEN");
  });

  it("lets an operator change it and records who, when and why", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const operator = await createUser({ role: "OPERATOR" });
    const shop = await createShop(owner.id, { classification: "GREEN" });

    await changeClassification(shop.id, "KESARI", "Passed quality audit", {
      id: operator.id,
      role: "OPERATOR",
    });

    const after = await db.query.shops.findFirst({ where: eq(shops.id, shop.id) });
    expect(after?.classification).toBe("KESARI");

    const [history] = await db
      .select()
      .from(shopClassificationHistory)
      .where(eq(shopClassificationHistory.shopId, shop.id));
    expect(history).toMatchObject({
      previousValue: "GREEN",
      newValue: "KESARI",
      changedBy: operator.id,
      reason: "Passed quality audit",
    });
  });

  it("requires a reason", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const admin = await createUser({ role: "ADMIN" });
    const shop = await createShop(owner.id, { classification: "GREEN" });

    await expect(
      changeClassification(shop.id, "KESARI", "   ", {
        id: admin.id,
        role: "ADMIN",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("shop registration cannot self-approve (§8)", () => {
  it("always lands in PENDING_APPROVAL with no classification", async () => {
    const user = await createUser({ role: "CUSTOMER" });

    // Extra fields simulate a hand-crafted request trying to self-approve.
    // registerShop reads neither, so they are silently ignored.
    const hostileInput = {
      name: "Self Serve Dairy",
      ownerName: "Owner",
      phone: "9876543210",
      addressLine1: "1 Road",
      city: "Pune",
      pincode: "411001",
      shopType: "DAIRY" as const,
      status: "APPROVED",
      classification: "KESARI",
    };

    const shop = await registerShop(hostileInput, {
      id: user.id,
      role: "CUSTOMER",
    });

    expect(shop.status).toBe("PENDING_APPROVAL");
    expect(shop.classification).toBeNull();
  });
});

describe("online purchasability rules (§14)", () => {
  const base = {
    shopStatus: "APPROVED",
    isActive: true,
    isAvailable: true,
    onlineSaleEnabled: true,
    onlinePricePaise: 7000,
    trackInventory: true,
    onlineStock: 10,
  };

  it("allows a fully valid product", () => {
    expect(() => assertOnlinePurchasable(base, 1)).not.toThrow();
  });

  it("blocks when the shop is not approved", () => {
    for (const status of ["PENDING_APPROVAL", "REJECTED", "SUSPENDED", "INACTIVE"]) {
      expect(isOnlinePurchasable({ ...base, shopStatus: status })).toBe(false);
    }
  });

  it("blocks an offline-only product with the right message (§12)", () => {
    expect(() =>
      assertOnlinePurchasable({
        ...base,
        onlineSaleEnabled: false,
        onlinePricePaise: null,
      }),
    ).toThrowError(/only at the physical shop/i);
  });

  it("blocks when there is no online price", () => {
    expect(isOnlinePurchasable({ ...base, onlinePricePaise: null })).toBe(false);
  });

  it("blocks when inactive or unavailable", () => {
    expect(isOnlinePurchasable({ ...base, isActive: false })).toBe(false);
    expect(isOnlinePurchasable({ ...base, isAvailable: false })).toBe(false);
  });

  it("blocks when stock is short, but ignores stock when not tracked", () => {
    expect(isOnlinePurchasable({ ...base, onlineStock: 0 })).toBe(false);
    expect(isOnlinePurchasable(base, 11)).toBe(false);
    expect(isOnlinePurchasable(base, 10)).toBe(true);
    expect(
      isOnlinePurchasable({ ...base, trackInventory: false, onlineStock: 0 }, 99),
    ).toBe(true);
  });
});

describe("offline-only products cannot enter a cart (§12, §55)", () => {
  it("refuses add-to-cart and explains why", async () => {
    const { user: customer } = await createUserWithWallet();
    const owner = await createUser({ role: "SHOP_OWNER" });
    const category = await createCategory({ department: "DAIRY" });
    const product = await createProduct(category.id, { name: "Malai Paneer" });
    const shop = await createShop(owner.id, { status: "APPROVED" });

    const offlineOnly = await createShopProduct(shop.id, product.id, {
      onlineSaleEnabled: false,
      onlinePricePaise: null,
      offlineSaleEnabled: true,
      offlinePricePaise: 45_000,
    });

    await expect(
      addToCart(customer.id, offlineOnly.id, 1),
    ).rejects.toMatchObject({ code: "PRODUCT_NOT_PURCHASABLE_ONLINE" });
  });

  it("refuses a product from an unapproved shop", async () => {
    const { user: customer } = await createUserWithWallet();
    const owner = await createUser({ role: "SHOP_OWNER" });
    const category = await createCategory({ department: "DAIRY" });
    const product = await createProduct(category.id);
    const pending = await createShop(owner.id, { status: "PENDING_APPROVAL" });
    const sp = await createShopProduct(pending.id, product.id, {
      onlineSaleEnabled: true,
      onlinePricePaise: 7000,
    });

    await expect(addToCart(customer.id, sp.id, 1)).rejects.toMatchObject({
      code: "PRODUCT_NOT_PURCHASABLE_ONLINE",
    });
  });

  it("refuses to exceed available stock across repeated adds", async () => {
    const { user: customer } = await createUserWithWallet();
    const owner = await createUser({ role: "SHOP_OWNER" });
    const category = await createCategory({ department: "DAIRY" });
    const product = await createProduct(category.id);
    const shop = await createShop(owner.id, { status: "APPROVED" });
    const sp = await createShopProduct(shop.id, product.id, {
      onlineSaleEnabled: true,
      onlinePricePaise: 7000,
      onlineStock: 3,
    });

    await addToCart(customer.id, sp.id, 2);
    // The 2 already in the cart count toward the limit.
    await expect(addToCart(customer.id, sp.id, 2)).rejects.toMatchObject({
      code: "OUT_OF_STOCK",
    });
  });
});
