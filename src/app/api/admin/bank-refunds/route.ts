/** Finance: refunds customers asked to receive in their bank (?status=REQUESTED|PROCESSING|PAID|FAILED|CANCELLED). FINANCE_VIEW. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseQuery, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { BANK_REFUND_STATUSES } from "@/server/db/schema";
import { listBankRefundsForFinance } from "@/server/services/bank-refunds";

export const dynamic = "force-dynamic";

const schema = z.object({ status: z.enum(BANK_REFUND_STATUSES).optional() });

export const GET = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.FINANCE_VIEW);
  return ok({ refunds: await listBankRefundsForFinance(parseQuery(request, schema), user) });
});
