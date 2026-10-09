/** Operations: legal documents by state (?filter=to_review|rejected|approved|missing|expiring|all). SHOP_GST_PAN_VERIFY. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseQuery, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { listLegalDocumentsForReview } from "@/server/services/legal-documents";

export const dynamic = "force-dynamic";

const schema = z.object({ filter: z.enum(["to_review", "rejected", "approved", "missing", "expiring", "all"]).default("to_review") });

export const GET = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.SHOP_GST_PAN_VERIFY);
  const { filter } = parseQuery(request, schema);
  return ok({ documents: await listLegalDocumentsForReview(filter, user) });
});
