/**
 * Master products' own HSN code and GST rate (admin only, /admin/product-gst).
 *   GET ?q=&missing=1&limit= → { rows, missingTotal }; each row says which rate a
 *   tax invoice issued today would use (the product's, the HSN fallback, or the default).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseQuery, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { listProductGstRates } from "@/server/gst/product-rates";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  await requirePermission(PERMISSIONS.GST_CONFIG_MANAGE);
  const { q, missing, limit } = parseQuery(
    request,
    z.object({
      q: z.string().trim().max(80).optional(),
      missing: z.enum(["1", "0"]).optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
    }),
  );
  return ok(await listProductGstRates({ q, missing: missing === "1", limit }));
});
