/**
 * Rider App v2 privacy: no rider-facing response may carry the customer's delivery
 * fee, order total, commission / margin, shop charges or the customer's name and
 * phone. Cash to collect on COD (cashToCollectPaise) is the one money field about
 * the order a rider sees.
 *
 * Two checks per shape: a sample object built to the response type is scanned
 * recursively (src/lib/rider-privacy.ts), and the type's own field names are read
 * from the source, so an optional field added later is caught too.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { findForbiddenKeys, RIDER_FORBIDDEN_KEY } from "@/lib/rider-privacy";
import { summariseWeek, weekWindow } from "@/lib/rider-week";
import type { RiderEarningsWeek } from "@/server/services/rider-earnings-week";
import type { JobBoard, RiderJob, RiderPayBreakdown, quoteForOwnOffer } from "@/server/services/rider-job-board";

const breakdown: RiderPayBreakdown = {
  basePaise: 2500,
  distancePaise: 1200,
  firstMilePaise: 300,
  surgePaise: 500,
  bonusPaise: 0,
  minTopUpPaise: 0,
};

const job: RiderJob = {
  jobId: "d:00000000-0000-4000-8000-000000000001",
  orderNumber: "GK-1001",
  shopName: "Kesari Dairy",
  shopArea: "Kothrud, Pune",
  pickupKm: 1.2,
  deliveryKm: 3.4,
  totalKm: 4.6,
  etaMinutes: 14,
  itemsCount: 3,
  cod: true,
  cashToCollectPaise: 45_000,
  surgeTags: ["Rain"],
  earnPaise: 4500,
  breakdown,
  expiresAt: new Date().toISOString(),
  readySince: new Date().toISOString(),
};

const board: JobBoard = { enabled: true, blockedReason: null, pollSeconds: 10, jobs: [job] };

const quote: Awaited<ReturnType<typeof quoteForOwnOffer>> = { earnPaise: 4500, breakdown, locked: false };

function sampleWeek(): RiderEarningsWeek {
  const week = weekWindow("2026-11-25", "2026-11-25");
  const summary = summariseWeek(
    week,
    [
      {
        id: "e1",
        dateKey: "2026-11-24",
        createdAt: new Date("2026-11-24T10:00:00Z"),
        orderNumber: "GK-1001",
        isReturnPickup: false,
        basePaise: 2500,
        distancePaise: 1200,
        orderComponentPaise: 0,
        slotIncentivePaise: 500,
        minTopUpPaise: 0,
        orderIncentivePaise: 0,
        otherIncentivePaise: 0,
        deductionsPaise: 0,
        totalPaise: 4200,
        quotePaise: 4500,
        payoutStatus: null,
      },
    ],
    [{ earningId: "e1", component: "BASE", amountPaise: 2500, description: "Base fee" }],
  );
  return {
    ...summary,
    week,
    cashInHand: { heldPaise: 45_000, orders: 1 },
    payouts: [{ id: "p1", periodStart: "2026-11-16", periodEnd: "2026-11-22", amountPaise: 10_000, status: "PAID", utr: "UTR123", deliveries: 3 }],
  };
}

/** Field names declared in `interface Name { … }` in a source file (one level). */
function interfaceFields(file: string, name: string): string[] {
  const source = readFileSync(path.join(process.cwd(), file), "utf8");
  const start = source.indexOf(`interface ${name} `);
  expect(start, `interface ${name} in ${file}`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  let body = "";
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    body += ch;
    if (depth === 0) break;
  }
  return [...body.matchAll(/^\s+([A-Za-z_][A-Za-z0-9_]*)\??:/gm)].map((m) => m[1]);
}

describe("rider privacy — rider-facing response shapes", () => {
  it("the key scan finds forbidden keys at any depth and allows cash to collect", () => {
    const bad = { jobs: [{ breakdown: { commissionPaise: 1 } }], cashToCollectPaise: 1, order: { customerPhone: "x", deliveryFeePaise: 2 } };
    expect(findForbiddenKeys(bad).sort()).toEqual(["jobs[0].breakdown.commissionPaise", "order.customerPhone", "order.deliveryFeePaise"].sort());
    expect(findForbiddenKeys({ cashToCollectPaise: 100 })).toEqual([]);
    for (const key of ["orderTotalPaise", "shopDeliveryChargePaise", "shopChargePaise", "marginPaise", "customerName", "buyerId"]) {
      expect(RIDER_FORBIDDEN_KEY.test(key), key).toBe(true);
    }
  });

  it("Available Deliveries (GET /api/delivery-partner/jobs)", () => {
    expect(findForbiddenKeys(board)).toEqual([]);
  });

  it("You earn ₹X on the rider's own offer (quoteForOwnOffer)", () => {
    expect(findForbiddenKeys(quote)).toEqual([]);
  });

  it("the earnings week (GET /api/delivery-partner/earnings/week)", () => {
    expect(findForbiddenKeys(sampleWeek())).toEqual([]);
  });

  it("the declared fields of every rider response type", () => {
    const fields = [
      ...interfaceFields("src/server/services/rider-job-board.ts", "RiderJob"),
      ...interfaceFields("src/server/services/rider-job-board.ts", "RiderPayBreakdown"),
      ...interfaceFields("src/server/services/rider-job-board.ts", "JobBoard"),
      ...interfaceFields("src/server/services/rider-earnings-week.ts", "RiderEarningsWeek"),
      ...interfaceFields("src/server/services/rider-earnings-week.ts", "RiderPayoutLine"),
      ...interfaceFields("src/lib/rider-week.ts", "WeekSummary"),
      ...interfaceFields("src/lib/rider-week.ts", "WeekOrder"),
      ...interfaceFields("src/lib/rider-week.ts", "WeekDay"),
    ];
    expect(fields.length).toBeGreaterThan(20);
    expect(fields.filter((f) => f !== "cashToCollectPaise" && RIDER_FORBIDDEN_KEY.test(f))).toEqual([]);
  });
});
