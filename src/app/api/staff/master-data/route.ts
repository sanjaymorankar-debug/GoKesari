/** RBAC v2 Phase 5: Support asks an admin to correct master product data (never written directly). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { proposeMasterDataCorrection } from "@/server/rbac-support/change-requests";

const schema = z.object({
  productId: z.string().uuid(),
  field: z.enum(["name", "description", "barcode", "gtin", "hsnCode", "mrpPaise", "netQuantity", "manufacturerName", "countryOfOrigin"]),
  proposedValue: z.string().trim().min(1).max(2000),
  reason: z.string().trim().min(5).max(1000),
  ticketId: z.string().uuid().nullish(),
});

export const POST = route(async (request: NextRequest) => {
  const actor = await requirePermission(PERMISSIONS.MASTER_DATA_CORRECTION_PROPOSE);
  return ok(await proposeMasterDataCorrection(await parseBody(request, schema), actor), 201);
});
