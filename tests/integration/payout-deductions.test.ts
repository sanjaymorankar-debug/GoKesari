/**
 * docs/tax-register/PAYOUT_DEDUCTIONS.md (0184): with flag payout_deductions on, weekly rider
 * payouts withhold TDS s.194C, and the weekly shop settlement refuses (shops go through the
 * payout cycle, which withholds TCS / TDS). Off: as before.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { encryptSecret } from "@/lib/pan-crypto";
import { db } from "@/server/db";
import { deliveryPartnerEarnings, deliveryPartners, riderPayouts, type UserRole } from "@/server/db/schema";
import { clearFeatureFlagCache, setFeatureFlag } from "@/server/services/feature-flags";
import { prepareRiderPayouts, prepareShopSettlements } from "@/server/services/finance";
import { createDeliveryPartner, createUser, resetDatabase } from "../helpers/fixtures";

vi.mock("@/server/email/transport", () => ({ sendEmail: vi.fn(async () => undefined) }));

let admin: { id: string; role: UserRole };

beforeEach(async () => {
  await resetDatabase();
  clearFeatureFlagCache();
  admin = { id: (await createUser({ role: "ADMIN" })).id, role: "ADMIN" };
});

async function deductions(on: boolean) {
  await setFeatureFlag("payout_deductions", { enabled: on, districtCodes: null }, "payout deductions (test)", admin as { id: string; role: "ADMIN" });
  clearFeatureFlagCache();
}

async function riderEarning(totalPaise: number, pan: boolean) {
  const user = await createUser({ role: "DELIVERY_PARTNER" });
  const partner = await createDeliveryPartner(user.id, { status: "APPROVED" });
  if (pan) await db.update(deliveryPartners).set({ panNumberEncrypted: encryptSecret("ABCPE1234F") }).where(eq(deliveryPartners.id, partner.id));
  await db.insert(deliveryPartnerEarnings).values({ deliveryPartnerId: partner.id, returnPickupId: crypto.randomUUID(), basePaise: totalPaise, distancePaise: 0, totalPaise });
  return partner;
}

function monday(weeksBack: number): string {
  const ist = new Date(Date.now() + 330 * 60_000);
  ist.setUTCDate(ist.getUTCDate() - ((ist.getUTCDay() + 6) % 7) - 7 * weeksBack);
  return ist.toISOString().slice(0, 10);
}

describe("weekly rider payouts", () => {
  it("withhold TDS s.194C on a payment above the single-payment limit when the flag is on", async () => {
    await deductions(true);
    const partner = await riderEarning(4_000_000, true); // ₹40,000 > ₹30,000
    const [p] = (await prepareRiderPayouts(monday(0), admin)).filter((x) => x.deliveryPartnerId === partner.id);
    expect(p).toMatchObject({ grossPaise: 4_000_000, tdsPaise: 40_000, tdsRateBp: 100, amountPaise: 3_960_000 });
  });

  it("20% without PAN", async () => {
    await deductions(true);
    const partner = await riderEarning(4_000_000, false);
    const [p] = (await prepareRiderPayouts(monday(0), admin)).filter((x) => x.deliveryPartnerId === partner.id);
    expect(p).toMatchObject({ tdsPaise: 800_000, tdsRateBp: 2000, amountPaise: 3_200_000 });
  });

  it("nothing below the limits, and nothing with the flag off", async () => {
    await deductions(true);
    const small = await riderEarning(100_000, true);
    const [a] = (await prepareRiderPayouts(monday(0), admin)).filter((x) => x.deliveryPartnerId === small.id);
    expect(a).toMatchObject({ tdsPaise: 0, amountPaise: 100_000 });

    await deductions(false);
    const big = await riderEarning(4_000_000, true);
    const [b] = (await prepareRiderPayouts(monday(0), admin)).filter((x) => x.deliveryPartnerId === big.id);
    expect(b).toMatchObject({ tdsPaise: 0, amountPaise: 4_000_000 });
    const [stored] = await db.select().from(riderPayouts).where(eq(riderPayouts.id, b.id));
    expect(stored.tdsRateBp).toBeNull();
  });
});

describe("weekly shop settlement", () => {
  it("refuses while payout deductions are on", async () => {
    await deductions(true);
    await expect(prepareShopSettlements(monday(1), admin)).rejects.toThrow(/payout cycle/);
    await deductions(false);
    await expect(prepareShopSettlements(monday(1), admin)).resolves.toEqual([]);
  });
});
