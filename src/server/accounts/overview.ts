/**
 * The figures on the Inventory & Accounting board (docs/inventory-accounting-2026-10):
 * counts on the tiles and the four headline numbers. Best-effort — a part
 * that fails is left out, never the whole board.
 */
import { and, eq, inArray, ne, sql } from "drizzle-orm";

import type { AccountsCountKey } from "@/lib/accounts/menu";
import type { DueDate } from "@/lib/accounts/gst-liability";
import { db } from "@/server/db";
import { gstReconItems } from "@/server/db/schema";
import { countToReview } from "./capture/service";
import { gstLiability, nextDueDate } from "./gst";
import { listParties } from "./parties";
import { expiringBatches, stockSummary } from "./stock";
import { currentPeriod } from "./page";

export interface AccountsOverview {
  counts: Partial<Record<AccountsCountKey, number>>;
  gstPayablePaise?: number;
  stockValuePaise?: number;
  payablesPaise?: number;
  nextDue?: DueDate | null;
}

async function settle<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (error) {
    console.error(`[accounts] overview ${label} failed`, (error as Error).message);
    return undefined;
  }
}

export async function accountsOverview(shopId: string): Promise<AccountsOverview> {
  const [toReview, stock, expiring, parties, liability, nextDue, recon] = await Promise.all([
    settle("review", () => countToReview(shopId)),
    settle("stock", () => stockSummary(shopId)),
    settle("expiring", () => expiringBatches(shopId)),
    settle("parties", () => listParties(shopId, "SUPPLIER")),
    settle("gst", () => gstLiability(shopId, currentPeriod())),
    settle("due", () => nextDueDate(shopId)),
    settle("recon", async () => {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(gstReconItems)
        .where(and(eq(gstReconItems.shopId, shopId), ne(gstReconItems.status, "MATCHED"), inArray(gstReconItems.period, [currentPeriod(), prevPeriod(currentPeriod())])));
      return Number(row?.n ?? 0);
    }),
  ]);
  const payables = parties?.filter((p) => p.balancePaise > 0);
  return {
    counts: {
      toReview,
      lowStock: stock?.rows.filter((r) => r.status !== "IN_STOCK").length,
      expiring: expiring?.length,
      payables: payables?.length,
      reconIssues: recon,
    },
    gstPayablePaise: liability?.total.totalCash,
    stockValuePaise: stock?.totalValuePaise,
    payablesPaise: payables?.reduce((n, p) => n + p.balancePaise, 0),
    nextDue,
  };
}

function prevPeriod(p: string): string {
  const y = Number(p.slice(0, 4));
  const m = Number(p.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}
