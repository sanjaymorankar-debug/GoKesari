/**
 * Receipt references (PAY-<year>-<6 digits>). They used to be the row count + 1, which
 * collided for good once a payment row had been deleted — test.gokesari.com, 30 Oct 2026:
 * nine rows numbered 4–12, so every new registration fee tried PAY-2026-000010 and its
 * webhook failed on the unique index. Now: one more than the highest number this year.
 */
import { asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { shopPayments } from "@/server/db/schema";
import { nextReference, recordPayment } from "@/server/services/shop-payments";
import { createShop, createUser, resetDatabase } from "../helpers/fixtures";

const year = new Date().getFullYear();
const ref = (n: number) => `PAY-${year}-${String(n).padStart(6, "0")}`;

beforeEach(async () => {
  await resetDatabase();
});

describe("shop payment receipt references", () => {
  it("numbers from 1, and carries on after the highest one when earlier rows were deleted", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const actor = { id: admin.id, role: "ADMIN" as const };
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { status: "PENDING_APPROVAL", registrationFeePaise: 100_000 });

    expect(await nextReference(db)).toBe(ref(1));
    for (let i = 0; i < 3; i += 1) await recordPayment({ shopId: shop.id, paymentType: "REGISTRATION_FEE", amountPaise: 1_000 }, actor);
    const rows = await db.select().from(shopPayments).where(eq(shopPayments.shopId, shop.id)).orderBy(asc(shopPayments.reference));
    expect(rows.map((r) => r.reference)).toEqual([ref(1), ref(2), ref(3)]);

    // A row goes (a test clean-up, a correction): two rows left, the highest is 3.
    await db.delete(shopPayments).where(eq(shopPayments.id, rows[0].id));
    expect(await nextReference(db)).toBe(ref(4));
    await recordPayment({ shopId: shop.id, paymentType: "REGISTRATION_FEE", amountPaise: 1_000 }, actor);
    const after = await db.select({ reference: shopPayments.reference }).from(shopPayments).where(eq(shopPayments.shopId, shop.id));
    expect(after.map((r) => r.reference).sort()).toEqual([ref(2), ref(3), ref(4)]);
  });

  it("starts again at 1 in a new year (the year is part of the reference)", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { status: "PENDING_APPROVAL", registrationFeePaise: 100_000 });
    await db.insert(shopPayments).values({
      reference: `PAY-${year - 1}-000041`,
      shopId: shop.id,
      ownerId: owner.id,
      paymentType: "REGISTRATION_FEE",
      amountPaise: 1_000,
      method: "CASH",
      recordedBy: owner.id,
    });
    expect(await nextReference(db)).toBe(ref(1));
  });
});
