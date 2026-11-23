/** RBAC v2 Phase 3: trial balance of posted entries; ?format=csv downloads it. */
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";

import { ok, parseQuery, route } from "@/server/api/handler";
import { requireAnyPermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { trialBalance } from "@/server/rbac-accounting/journals";
import { requireFeatureForRole } from "@/server/services/feature-flags";

export const dynamic = "force-dynamic";

const schema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  format: z.enum(["json", "csv"]).default("json"),
});

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export const GET = route(async (request: NextRequest) => {
  const actor = await requireAnyPermission([PERMISSIONS.JOURNAL_PREPARE, PERMISSIONS.JOURNAL_APPROVE]);
  await requireFeatureForRole("rbac_v2_accounting", actor.role);
  const q = parseQuery(request, schema);
  const tb = await trialBalance({ fromPeriod: q.from, toPeriod: q.to });
  if (q.format === "json") return ok(tb);
  const rupees = (p: number) => (p / 100).toFixed(2);
  const lines = [
    "Account code,Account name,Debit (INR),Credit (INR),Balance (INR)",
    ...tb.rows.map((r) => [csvCell(r.accountCode), csvCell(r.accountName), rupees(r.debitPaise), rupees(r.creditPaise), rupees(r.balancePaise)].join(",")),
    `Total,,${rupees(tb.totalDebitPaise)},${rupees(tb.totalCreditPaise)},`,
  ];
  return new NextResponse(lines.join("\n") + "\n", {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="trial-balance-${q.from ?? "start"}-${q.to ?? "now"}.csv"`,
      "cache-control": "no-store",
    },
  });
});
