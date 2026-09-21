/**
 * POST /api/product-master/products/validate   { "product": { ...staged product } }
 * Pure validation: the normalised form and every issue (bad GTIN check digit, unreadable GST rate,
 * price above MRP...). Nothing is looked up or written.
 */
import type { NextRequest } from "next/server";

import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { validateBodySchema } from "@/server/pmd/schemas";
import { validateProduct } from "@/server/pmd/services/ingest-api";
import type { StagedProduct } from "@/server/pmd/types";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest) => {
  await requirePermission(PERMISSIONS.PMD_VIEW);
  const { product } = await parseBody(request, validateBodySchema);
  return ok(validateProduct(product as StagedProduct));
});
