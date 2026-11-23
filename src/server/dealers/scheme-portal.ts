/** docs/dealer-platform phase 6: the data of the dealer's "Your scheme" card (portal). */
import { and, eq, gte, inArray, ne, sql } from "drizzle-orm";

import { COMMISSION_ENTRY_TYPE_LABELS } from "@/lib/dealer-tiers";
import { db } from "@/server/db";
import { dealerCommissionLedger, type Dealer } from "@/server/db/schema";

import { changeOptions } from "./scheme-change";
import type { DealerSchemeView } from "./schemes";

const SCHEME_TYPES = ["SCHEME_ONE_TIME", "SCHEME_TEAM", "SCHEME_RECURRING", "SCHEME_BONUS"] as const;

export async function dealerSchemeCardData(dealer: Dealer, scheme: DealerSchemeView) {
  const monthStart = new Date(`${new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 7)}-01T00:00:00+05:30`);
  const rows = await db
    .select({
      type: dealerCommissionLedger.entryType,
      total: sql<number>`coalesce(sum(${dealerCommissionLedger.amountPaise}), 0)::bigint`,
      month: sql<number>`coalesce(sum(${dealerCommissionLedger.amountPaise}) filter (where ${dealerCommissionLedger.createdAt} >= ${monthStart.toISOString()}::timestamptz), 0)::bigint`,
    })
    .from(dealerCommissionLedger)
    .where(and(eq(dealerCommissionLedger.dealerId, dealer.id), inArray(dealerCommissionLedger.entryType, [...SCHEME_TYPES]), ne(dealerCommissionLedger.status, "REVERSED"), gte(dealerCommissionLedger.createdAt, new Date(scheme.startsAt))))
    .groupBy(dealerCommissionLedger.entryType);
  let validUntil: string | null = null;
  if (scheme.terms.validityMonths) {
    const end = new Date(scheme.startsAt);
    end.setUTCMonth(end.getUTCMonth() + scheme.terms.validityMonths);
    validUntil = end.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
  }
  const options = await changeOptions(dealer);
  return {
    scheme: { name: scheme.schemeName, version: scheme.version, terms: scheme.terms, validUntil, category: scheme.category },
    earnings: rows.map((r) => ({ label: COMMISSION_ENTRY_TYPE_LABELS[r.type], monthPaise: Number(r.month), totalPaise: Number(r.total) })),
    options: options.map((o) => ({ code: o.code, name: o.name, versionId: o.versionId, termsHash: o.termsHash, terms: o.terms, totalPaise: o.totals.totalPaise })),
  };
}
