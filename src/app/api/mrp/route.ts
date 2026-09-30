/**
 * MRP governance (operations).
 *   GET   overview: verification counts, products missing an MRP, shop prices above MRP, pending corrections
 *   POST  set the master MRP { productId, mrpPaise, source, effectiveFrom?, reason? } — role-gated,
 *         history-appended, audited; shops charging above the new MRP are notified (their prices are not edited)
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { changeMasterMrp, listCorrections, listMrpViolations, mrpVerificationSummary } from "@/server/services/mrp-governance";
import { listProductsMissingMrp } from "@/server/services/product-master";
import { resolveProductId } from "@/server/services/price-references";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requirePermission(PERMISSIONS.PRODUCT_MRP_MANAGE);
  const [summary, missing, violations, pending] = await Promise.all([
    mrpVerificationSummary(),
    listProductsMissingMrp(100),
    listMrpViolations(100),
    listCorrections("PENDING"),
  ]);
  return ok({
    summary,
    missing: missing.map((p) => ({ id: p.id, code: p.code, name: p.name })),
    violations,
    pending,
  });
});

const schema = z.object({
  /** A product uuid, or its code such as P00042. */
  productId: z.string().min(1).max(64),
  mrpPaise: z.number().int().min(0),
  source: z.enum(["ADMIN", "GS1", "BRAND", "IMPORT", "API", "SELLER_SUBMITTED"]),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  reason: z.string().max(300).nullish(),
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.PRODUCT_MRP_MANAGE);
  const body = await parseBody(request, schema);
  const { product, conflicts } = await changeMasterMrp({ ...body, productId: await resolveProductId(body.productId) }, user);
  return ok({ id: product.id, mrpPaise: product.mrpPaise, verification: product.mrpVerificationStatus, conflicts });
});
