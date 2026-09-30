/**
 * Duplicate shop registration (services/shop-duplicates.ts).
 *
 * The six cases from the brief — a new shop, the same PAN while pending, the
 * same Udyam number while approved, the same Shop Act licence typed
 * differently, a previously rejected shop, and a double submit — plus the
 * edge rules: a PAN shared by a branch elsewhere, suspended shops, a rejected
 * registration from another account, masking, the post-registration PAN
 * form, the API's "at least one identifier" rule and the pre-check endpoint.
 *
 * Identifiers are made up: syntactically valid, not real registrations.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | {
    user: {
      id: string;
      email: string;
      name: string | null;
      image: string | null;
      role: UserRole;
      status: "ACTIVE" | "SUSPENDED" | "DELETED";
    };
  },
}));

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

import { POST as duplicateCheckRoute } from "@/app/api/shops/duplicate-check/route";
import { POST as registerRoute } from "@/app/api/shops/route";
import type { AppError } from "@/lib/errors";
import { panBlindIndex } from "@/lib/pan-crypto";
import { resetRateLimits } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import { auditLogs, notifications, shops } from "@/server/db/schema";
import { AUDIT_ACTIONS } from "@/server/services/audit";
import { submitPan } from "@/server/services/gst-pan-verification";
import { isShopActUniqueViolation } from "@/server/services/shop-duplicates";
import {
  approveShop,
  registerShop,
  rejectShop,
  setShopStatus,
  type RegisterShopInput,
} from "@/server/services/shops";
import { createShop, createUser, resetDatabase } from "../helpers/fixtures";
import { call } from "../helpers/http";

const PAN = "ABCDE1234F";
const UDYAM = "UDYAM-MH-26-0012345";
const SHOP_ACT = "PII/KOTHRUD/II/12345";

const baseShop = {
  name: "Shree Dairy",
  ownerName: "Ramesh Patil",
  phone: "9876543210",
  addressLine1: "12 FC Road",
  city: "Pune",
  pincode: "411004",
  shopType: "DAIRY" as const,
};

type Actor = { id: string; role: UserRole };

function asActor(user: { id: string; role: UserRole }): Actor {
  return { id: user.id, role: user.role };
}

function register(user: Actor, input: Partial<RegisterShopInput>) {
  return registerShop({ ...baseShop, ...input }, user);
}

async function shopCount() {
  return (await db.select({ id: shops.id }).from(shops)).length;
}

function signIn(user: { id: string; email: string; name: string | null; role: UserRole }) {
  state.session = {
    user: { id: user.id, email: user.email, name: user.name, image: null, role: user.role, status: "ACTIVE" },
  };
}

beforeEach(async () => {
  state.session = null;
  resetRateLimits();
  await resetDatabase();
});

describe("a new shop", () => {
  it("is registered when nothing matches, with identifiers stored normalised", async () => {
    const owner = await createUser();
    const shop = await register(asActor(owner), {
      shopActNumber: " pii/kothrud/ii/12345 ",
      panNumber: "abcde1234f",
      panHolderName: "Ramesh Patil",
      udyamNumber: "udyam mh 26 0012345",
    });

    expect(shop.resubmitted).toBe(false);
    expect(shop.status).toBe("PENDING_APPROVAL");
    expect(shop.shopActNumber).toBe("PII/KOTHRUD/II/12345");
    expect(shop.shopActKey).toBe("PIIKOTHRUDII12345");
    expect(shop.udyamNumber).toBe(UDYAM);
    // PAN: encrypted, hashed, last four for display — never plaintext.
    expect(shop.panHash).toBe(panBlindIndex(PAN));
    expect(shop.panLast4).toBe("234F");
    expect(shop.panNumberEncrypted).not.toContain(PAN);
    expect(shop.panStatus).toBe("PENDING_VERIFICATION");
    expect(await shopCount()).toBe(1);
  });
});

describe("while the first registration is pending or approved", () => {
  it("blocks the same PAN at the same place while pending, masked, without the other shop's details", async () => {
    const first = await createUser();
    const existing = await register(asActor(first), { panNumber: PAN, panHolderName: "Ramesh Patil" });

    const second = await createUser();
    const attempt = register(asActor(second), {
      ownerName: "Someone Else",
      panNumber: PAN,
      panHolderName: "Someone Else",
    });

    await expect(attempt).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "DUPLICATE_SHOP", matchedOn: "PAN", shopStatus: "PENDING_APPROVAL" },
    });
    const error = (await attempt.catch((e: unknown) => e)) as AppError;
    expect(error.message).toContain("PAN number already registered (XXXXXX234F)");
    expect(error.message).toContain("waiting for admin approval");
    expect(error.message).not.toContain(PAN);
    expect(error.message).not.toContain("Ramesh");
    expect(error.message).not.toContain(existing.registrationNumber);
    expect(error.details).not.toHaveProperty("matchedShopId");
    expect(await shopCount()).toBe(1);

    const [blockedAudit] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, AUDIT_ACTIONS.SHOP_DUPLICATE_BLOCKED));
    expect(blockedAudit.entityId).toBe(existing.id);
    expect(JSON.stringify(blockedAudit.newValue)).not.toContain(PAN);
  });

  it("blocks the same Udyam number, typed differently, while approved", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const first = await createUser();
    const existing = await register(asActor(first), { udyamNumber: UDYAM });
    await approveShop(existing.id, { classification: "KESARI" }, asActor(admin));

    const second = await createUser();
    await expect(
      register(asActor(second), { ownerName: "Someone Else", udyamNumber: "udyam mh 26 0012345" }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("live on GoKesari"),
      details: { matchedOn: "UDYAM", shopStatus: "APPROVED" },
    });
    expect(await shopCount()).toBe(1);
  });

  it("blocks the same Shop Act licence with different spacing and case, even at another address", async () => {
    const first = await createUser();
    await register(asActor(first), { shopActNumber: " pii/kothrud/ii/12345 " });

    const second = await createUser();
    await expect(
      register(asActor(second), {
        name: "Totally Different Name",
        addressLine1: "99 Other Street",
        pincode: "411038",
        shopActNumber: "PII - KOTHRUD - II - 12345",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("Shop Act licence number already registered (ending 2345)"),
      details: { matchedOn: "SHOP_ACT", fields: { shopActNumber: expect.any(String) } },
    });
    expect(await shopCount()).toBe(1);
  });

  it("allows the same PAN for a branch at a different place", async () => {
    const owner = await createUser();
    await register(asActor(owner), { panNumber: PAN, panHolderName: "Ramesh Patil" });

    const branch = await register(asActor(owner), {
      name: "Shree Dairy Kothrud",
      addressLine1: "5 Paud Road",
      pincode: "411038",
      panNumber: PAN,
      panHolderName: "Ramesh Patil",
    });
    expect(branch.resubmitted).toBe(false);
    expect(await shopCount()).toBe(2);
  });

  it("blocks the same account registering the same name at the same PIN code with different numbers", async () => {
    const owner = await createUser();
    await register(asActor(owner), { panNumber: PAN, panHolderName: "Ramesh Patil" });

    await expect(
      register(asActor(owner), { name: "SHREE  dairy", shopActNumber: SHOP_ACT }),
    ).rejects.toMatchObject({ code: "CONFLICT", details: { matchedOn: "NAME_AND_PIN" } });
    expect(await shopCount()).toBe(1);
  });

  it("blocks a suspended shop from registering again", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const owner = await createUser();
    const existing = await register(asActor(owner), { shopActNumber: SHOP_ACT });
    await setShopStatus(existing.id, "SUSPENDED", asActor(admin), "Complaints");

    const other = await createUser();
    await expect(
      register(asActor(other), { shopActNumber: SHOP_ACT }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("contact support"),
      details: { shopStatus: "SUSPENDED" },
    });
  });

  it("shows staff which shop matched", async () => {
    const owner = await createUser();
    const existing = await register(asActor(owner), { shopActNumber: SHOP_ACT });
    const operator = await createUser({ role: "OPERATOR" });

    await expect(
      registerShop(
        { ...baseShop, ownerId: owner.id, shopActNumber: SHOP_ACT },
        asActor(operator),
        { privileged: true },
      ),
    ).rejects.toMatchObject({
      details: {
        matchedShopId: existing.id,
        matchedRegistrationNumber: existing.registrationNumber,
      },
    });
  });
});

describe("a previously rejected shop", () => {
  it("updates the owner's rejected registration instead of creating a new one", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const owner = await createUser();
    const rejected = await register(asActor(owner), { shopActNumber: SHOP_ACT });
    await rejectShop(rejected.id, "Licence photo unreadable", asActor(admin));

    const resubmitted = await register(asActor(owner), {
      shopActNumber: "pii kothrud ii 12345",
      description: "Now with a clear licence photo",
    });

    expect(resubmitted.resubmitted).toBe(true);
    expect(resubmitted.id).toBe(rejected.id);
    expect(resubmitted.status).toBe("PENDING_APPROVAL");
    expect(resubmitted.rejectionReason).toBeNull();
    expect(resubmitted.description).toBe("Now with a clear licence photo");
    expect(resubmitted.registrationNumber).toBe(rejected.registrationNumber);
    expect(await shopCount()).toBe(1);

    const audit = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, AUDIT_ACTIONS.SHOP_RESUBMITTED));
    expect(audit).toHaveLength(1);
  });

  it("creates a new record when the rejected registration belongs to another account", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const impostor = await createUser();
    const rejected = await register(asActor(impostor), { shopActNumber: SHOP_ACT });
    await rejectShop(rejected.id, "Not the owner", asActor(admin));

    const realOwner = await createUser();
    const shop = await register(asActor(realOwner), { shopActNumber: SHOP_ACT });

    expect(shop.resubmitted).toBe(false);
    expect(shop.id).not.toBe(rejected.id);
    expect(shop.ownerId).toBe(realOwner.id);
    const [stillRejected] = await db.select().from(shops).where(eq(shops.id, rejected.id));
    expect(stillRejected.status).toBe("REJECTED");
    expect(stillRejected.ownerId).toBe(impostor.id);
    expect(await shopCount()).toBe(2);
  });

  it("refuses to approve a rejected shop whose licence is now live on another shop", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const first = await createUser();
    const rejected = await register(asActor(first), { shopActNumber: SHOP_ACT });
    await rejectShop(rejected.id, "Not the owner", asActor(admin));
    const second = await createUser();
    await register(asActor(second), { shopActNumber: SHOP_ACT });

    await expect(
      approveShop(rejected.id, { classification: "GREEN" }, asActor(admin)),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("notifies the owner on rejection and on approval", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const owner = await createUser();
    const shop = await register(asActor(owner), { shopActNumber: SHOP_ACT });
    await rejectShop(shop.id, "Licence photo unreadable", asActor(admin));
    await register(asActor(owner), { shopActNumber: SHOP_ACT });
    await approveShop(shop.id, { classification: "KESARI" }, asActor(admin));

    const sent = await db
      .select({ type: notifications.type })
      .from(notifications)
      .where(eq(notifications.userId, owner.id));
    expect(sent.map((n) => n.type).sort()).toEqual(["shop.approved", "shop.rejected"]);
  });
});

describe("simultaneous submissions", () => {
  it("a double submit of the same registration creates exactly one shop", async () => {
    const owner = await createUser();
    const input = { shopActNumber: SHOP_ACT };

    const results = await Promise.allSettled([
      register(asActor(owner), input),
      register(asActor(owner), input),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.filter((r) => r.status === "rejected");
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason).toMatchObject({ code: "CONFLICT" });
    expect(await shopCount()).toBe(1);
  });

  it("the unique index still refuses a second live shop with one licence if the lock is bypassed", async () => {
    const owner = await createUser();
    const a = await createShop(owner.id, { status: "PENDING_APPROVAL", name: "A" });
    const b = await createShop(owner.id, { status: "PENDING_APPROVAL", name: "B" });
    await db
      .update(shops)
      .set({ shopActNumber: SHOP_ACT, shopActKey: "PIIKOTHRUDII12345" })
      .where(eq(shops.id, a.id));

    await expect(
      db
        .update(shops)
        .set({ shopActNumber: SHOP_ACT, shopActKey: "PIIKOTHRUDII12345" })
        .where(eq(shops.id, b.id)),
    ).rejects.toSatisfy(isShopActUniqueViolation);
  });
});

describe("validation", () => {
  it("refuses a bare 12-digit number as a Udyam number", async () => {
    const owner = await createUser();
    await expect(
      register(asActor(owner), { udyamNumber: "123456789012" }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: { fields: { udyamNumber: expect.stringContaining("Aadhaar") } },
    });
  });

  it("refuses a placeholder licence number", async () => {
    const owner = await createUser();
    await expect(register(asActor(owner), { shopActNumber: "N/A" })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: { fields: { shopActNumber: expect.any(String) } },
    });
  });

  it("requires the name on the PAN card with a PAN", async () => {
    const owner = await createUser();
    await expect(register(asActor(owner), { panNumber: PAN })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: { fields: { panHolderName: expect.any(String) } },
    });
    expect(await shopCount()).toBe(0);
  });
});

describe("the post-registration PAN form", () => {
  it("stores a pan_hash", async () => {
    const owner = await createUser();
    const shop = await register(asActor(owner), { shopActNumber: SHOP_ACT });

    const updated = await submitPan(shop.id, PAN, "Ramesh Patil", asActor(owner));
    expect(updated.panHash).toBe(panBlindIndex(PAN));
  });

  it("refuses a PAN already registered to another live shop at the same place", async () => {
    const first = await createUser();
    await register(asActor(first), { panNumber: PAN, panHolderName: "Ramesh Patil" });

    const second = await createUser();
    const other = await register(asActor(second), {
      ownerName: "Someone Else",
      shopActNumber: SHOP_ACT,
    });

    await expect(
      submitPan(other.id, PAN, "Someone Else", asActor(second)),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("for another shop at this address"),
    });
    const [unchanged] = await db.select().from(shops).where(eq(shops.id, other.id));
    expect(unchanged.panHash).toBeNull();
  });
});

describe("POST /api/shops", () => {
  it("requires at least one of Shop Act, PAN or Udyam", async () => {
    const owner = await createUser();
    signIn(owner);

    const result = await call(registerRoute, "/api/shops", { method: "POST", body: baseShop });
    expect(result.status).toBe(422);
    expect(Object.keys(result.body.error.details.fields)).toEqual(
      expect.arrayContaining(["shopActNumber", "panNumber", "udyamNumber"]),
    );
    expect(await shopCount()).toBe(0);
  });

  it("returns 201 for a new shop, 409 for a duplicate, 200 for a resubmission", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const owner = await createUser();
    signIn(owner);

    const created = await call(registerRoute, "/api/shops", {
      method: "POST",
      body: { ...baseShop, shopActNumber: SHOP_ACT },
    });
    expect(created.status).toBe(201);
    expect(created.body.resubmitted).toBe(false);

    const duplicate = await call(registerRoute, "/api/shops", {
      method: "POST",
      body: { ...baseShop, shopActNumber: SHOP_ACT },
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.details.reason).toBe("DUPLICATE_SHOP");
    expect(duplicate.body.error.message).toContain("You don't need to submit again");

    await rejectShop(created.body.id, "Wrong shop type", asActor(admin));
    const resubmitted = await call(registerRoute, "/api/shops", {
      method: "POST",
      body: { ...baseShop, shopType: "BAKERY", shopActNumber: SHOP_ACT },
    });
    expect(resubmitted.status).toBe(200);
    expect(resubmitted.body.resubmitted).toBe(true);
    expect(resubmitted.body.id).toBe(created.body.id);
  });
});

describe("POST /api/shops/duplicate-check", () => {
  it("reports a pending duplicate without revealing the other shop", async () => {
    const first = await createUser();
    const existing = await register(asActor(first), { shopActNumber: SHOP_ACT });

    const second = await createUser();
    signIn(second);
    const result = await call(duplicateCheckRoute, "/api/shops/duplicate-check", {
      method: "POST",
      body: { shopActNumber: "pii kothrud ii 12345" },
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      status: "DUPLICATE",
      matchedOn: "SHOP_ACT",
      field: "shopActNumber",
      shopStatus: "PENDING_APPROVAL",
    });
    const text = JSON.stringify(result.body);
    expect(text).not.toContain(existing.id);
    expect(text).not.toContain(existing.registrationNumber);
    expect(text).not.toContain("Ramesh");
  });

  it("offers a resubmission for the caller's own rejected shop, and CLEAR otherwise", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const owner = await createUser();
    const shop = await register(asActor(owner), { shopActNumber: SHOP_ACT });
    await rejectShop(shop.id, "Wrong shop type", asActor(admin));
    signIn(owner);

    const own = await call(duplicateCheckRoute, "/api/shops/duplicate-check", {
      method: "POST",
      body: { shopActNumber: SHOP_ACT },
    });
    expect(own.body.status).toBe("RESUBMISSION");

    const unused = await call(duplicateCheckRoute, "/api/shops/duplicate-check", {
      method: "POST",
      body: { shopActNumber: "MH/PUNE/2024/99999" },
    });
    expect(unused.body).toEqual({ status: "CLEAR" });
  });

  it("returns field errors for a badly formatted number", async () => {
    const owner = await createUser();
    signIn(owner);
    const result = await call(duplicateCheckRoute, "/api/shops/duplicate-check", {
      method: "POST",
      body: { panNumber: "ABC" },
    });
    expect(result.status).toBe(422);
    expect(result.body.error.details.fields.panNumber).toBeDefined();
  });

  it("is rate-limited", async () => {
    const owner = await createUser();
    signIn(owner);
    const statuses: number[] = [];
    for (let i = 0; i < 21; i += 1) {
      const result = await call(duplicateCheckRoute, "/api/shops/duplicate-check", {
        method: "POST",
        body: { shopActNumber: SHOP_ACT },
      });
      statuses.push(result.status);
    }
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(statuses[20]).toBe(429);
  });
});
