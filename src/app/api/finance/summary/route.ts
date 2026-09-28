/** GMV, commission, delivery-fee revenue, rider cost, refunds over ?from&to (dates, to exclusive). FINANCE_VIEW. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseQuery, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { getFinanceSummary } from "@/server/services/finance";

const schema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const GET = route(async (request: NextRequest) => {
  await requirePermission(PERMISSIONS.FINANCE_VIEW);
  const { from, to } = parseQuery(request, schema);
  return ok(await getFinanceSummary(from, to));
});
