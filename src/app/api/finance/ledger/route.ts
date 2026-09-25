/** Marketplace journal (Part I): ?orderId | ?entityType=SHOP|RIDER|PLATFORM&entityId. FINANCE_VIEW. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseQuery, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { listLedgerEntries } from "@/server/services/finance";

const schema = z.object({
  orderId: z.string().uuid().optional(),
  entityType: z.enum(["SHOP", "RIDER", "PLATFORM"]).optional(),
  entityId: z.string().uuid().optional(),
});

export const GET = route(async (request: NextRequest) => {
  await requirePermission(PERMISSIONS.FINANCE_VIEW);
  return ok(await listLedgerEntries({ ...parseQuery(request, schema), limit: 500 }));
});
