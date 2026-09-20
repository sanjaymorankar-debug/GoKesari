/**
 * POST /api/product-master/products/match   { "product": { ...staged product } }
 * Dry run: what would the platform do with this record? Candidates, scores, rule, hard conflicts,
 * and the decision (LINK / CREATE / CREATE_AND_QUEUE / HOLD). Writes nothing.
 */
import type { NextRequest } from "next/server";

import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { appSql } from "@/server/pmd/db";
import { matchBodySchema } from "@/server/pmd/schemas";
import { matchProduct } from "@/server/pmd/services/ingest-api";
import type { StagedProduct } from "@/server/pmd/types";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest) => {
  await requirePermission(PERMISSIONS.PMD_VIEW);
  const { product } = await parseBody(request, matchBodySchema);
  return ok(await matchProduct(appSql(), product as StagedProduct));
});
