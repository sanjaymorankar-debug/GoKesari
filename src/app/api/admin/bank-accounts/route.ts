/** Finance: current bank accounts (?status=PENDING|VERIFIED|FAILED&holderType=CUSTOMER|SHOP), masked. FINANCE_VIEW. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseQuery, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { listBankAccountsForFinance } from "@/server/services/bank-accounts";

export const dynamic = "force-dynamic";

const schema = z.object({
  status: z.enum(["PENDING", "VERIFIED", "FAILED"]).optional(),
  holderType: z.enum(["CUSTOMER", "SHOP"]).optional(),
});

export const GET = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.FINANCE_VIEW);
  return ok({ accounts: await listBankAccountsForFinance(parseQuery(request, schema), user) });
});
