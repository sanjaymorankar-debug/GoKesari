/**
 * TC-LOC-026 (QA run 24 Oct 2026): hours that run past midnight
 * ("18:00"–"02:00") were never open — the check compared open ≤ now ≤ close
 * within one day. They are open from the opening time until the close the
 * next morning, in IST.
 */
import { describe, expect, it } from "vitest";

import { isShopOpenNow, nextOpeningAt, shopHoursLabel } from "@/lib/shop-hours";

/** A Date at the given IST wall-clock time (IST = UTC+5:30). 2026-10-23 is a Friday (day 5). */
const ist = (isoLocal: string) => new Date(new Date(`${isoLocal}Z`).getTime() - 330 * 60_000);

const everyDay = (open: string, close: string) => ({ openingHours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open, close })) });

describe("opening hours", () => {
  it("same-day hours are unchanged", () => {
    const shop = everyDay("09:00", "21:00");
    expect(isShopOpenNow(shop, ist("2026-10-23T08:59:00"))).toBe(false);
    expect(isShopOpenNow(shop, ist("2026-10-23T09:00:00"))).toBe(true);
    expect(isShopOpenNow(shop, ist("2026-10-23T21:00:00"))).toBe(true);
    expect(isShopOpenNow(shop, ist("2026-10-23T21:01:00"))).toBe(false);
  });

  it("hours past midnight are open from the opening time until the close the next morning", () => {
    const shop = everyDay("18:00", "02:00");
    expect(isShopOpenNow(shop, ist("2026-10-23T17:59:00"))).toBe(false);
    expect(isShopOpenNow(shop, ist("2026-10-23T18:00:00"))).toBe(true);
    expect(isShopOpenNow(shop, ist("2026-10-23T23:30:00"))).toBe(true);
    expect(isShopOpenNow(shop, ist("2026-10-24T01:30:00"))).toBe(true);
    expect(isShopOpenNow(shop, ist("2026-10-24T02:01:00"))).toBe(false);
    expect(shopHoursLabel(shop, ist("2026-10-24T01:30:00"))).toBe("Open till 2 AM");
    expect(nextOpeningAt(shop, ist("2026-10-24T03:00:00"))?.toISOString()).toBe(ist("2026-10-24T18:00:00").toISOString());
  });

  it("the morning after counts only when the previous day ran past midnight and was open", () => {
    // Thursday (4) runs to 02:00; Friday (5) is closed: Friday 01:00 is open (Thursday's hours), Friday 20:00 is not.
    const shop = {
      openingHours: [
        { day: 4, open: "18:00", close: "02:00" },
        { day: 5, open: "18:00", close: "02:00", closed: true },
      ],
    };
    expect(isShopOpenNow(shop, ist("2026-10-23T01:00:00"))).toBe(true);
    expect(isShopOpenNow(shop, ist("2026-10-23T20:00:00"))).toBe(false);
    expect(isShopOpenNow(shop, ist("2026-10-24T01:00:00"))).toBe(false);
  });
});
