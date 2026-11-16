/**
 * Defect P2-D6 (15-Nov-2026): a new shop's registration date was the UTC date,
 * so a shop registered between 00.00 and 05.29 IST was dated the day before.
 * It is now the date in APP_TIMEZONE (IST).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerShop } from "@/server/services/shops";
import { createUser, resetDatabase } from "../helpers/fixtures";

const shopInput = {
  name: "Late Night Dairy",
  ownerName: "Owner",
  phone: "9876543210",
  addressLine1: "1 Test Road",
  city: "Pune",
  pincode: "411001",
  shopType: "DAIRY" as const,
};

describe("P2-D6: a new shop's registration date is the IST date", () => {
  beforeEach(resetDatabase);
  afterEach(() => vi.useRealTimers());

  it("a shop registered at 02.14 IST on 15-Nov is dated 15-Nov (still 14-Nov in UTC)", async () => {
    const user = await createUser();
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-14T20:44:00Z") });
    const shop = await registerShop(shopInput, { id: user.id, role: user.role });
    expect(shop.registrationDate).toBe("2026-11-15");
  });

  it("a shop registered at 12.00 IST is dated that same day", async () => {
    const user = await createUser();
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-15T06:30:00Z") });
    const shop = await registerShop(shopInput, { id: user.id, role: user.role });
    expect(shop.registrationDate).toBe("2026-11-15");
  });
});
