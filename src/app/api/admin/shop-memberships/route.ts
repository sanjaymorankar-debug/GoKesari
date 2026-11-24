/**
 * Shop memberships (docs/shop-membership-renewal-2026-11).
 *
 * GET ?state=ALL|ACTIVE|DUE_SOON|GRACE|LAPSED|NONE|EXEMPT&q=&endsWithinDays=[&format=csv] → shops by membership
 *     state and end date (CSV: mobiles masked). Staff who may view any shop's payments (PAYMENT_VIEW_ANY).
 * POST { shopId, exempt, reason } → exempt one shop from the membership, or end its exemption. ADMIN only; audited.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission, requireRole } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { MEMBERSHIP_REPORT_STATES, membershipReport, membershipReportCsv, setMembershipExemption } from "@/server/services/shop-membership-renewal";

export const dynamic = "force-dynamic";

const query = z.object({
  state: z.enum(MEMBERSHIP_REPORT_STATES).optional(),
  q: z.string().max(80).optional(),
  endsWithinDays: z.coerce.number().int().min(0).max(3650).optional(),
  format: z.enum(["json", "csv"]).optional(),
});

export const GET = route(async (request: NextRequest) => {
  await requirePermission(PERMISSIONS.PAYMENT_VIEW_ANY);
  const params = query.parse(Object.fromEntries(new URL(request.url).searchParams));
  const report = await membershipReport({ state: params.state, q: params.q, endsWithinDays: params.endsWithinDays ?? null });
  if (params.format === "csv") {
    return new NextResponse(membershipReportCsv(report.rows), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="shop-memberships-${new Date().toISOString().slice(0, 10)}.csv"`,
        "Cache-Control": "private, no-store",
      },
    });
  }
  return ok({ rows: report.rows, counts: report.counts });
});

const body = z.object({ shopId: z.string().uuid(), exempt: z.boolean(), reason: z.string().max(500) });

export const POST = route(async (request: NextRequest) => {
  const user = await requireRole("ADMIN");
  const input = await parseBody(request, body);
  const shop = await setMembershipExemption(input.shopId, { exempt: input.exempt, reason: input.reason }, user);
  return ok({ shopId: shop.id, exempt: shop.membershipExempt, reason: shop.membershipExemptReason });
});
