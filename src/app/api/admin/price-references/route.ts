/**
 * External reference prices (operations). These are information only: they are
 * never a shop's selling price and never the MRP, and nothing here writes to
 * either.
 *   GET ?status=UNVERIFIED|VERIFIED|REJECTED   the review queue
 *   GET ?productId=<uuid>                      every reference for one product
 *   POST                                       record a reference (starts UNVERIFIED)
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import {
  createReference,
  listReferenceQueue,
  listReferencesForProduct,
  resolveProductId,
} from "@/server/services/price-references";

export const dynamic = "force-dynamic";

const referenceSchema = z.object({
  /** A product uuid, or its code such as P00042. */
  productId: z.string().min(1).max(64),
  pricePaise: z.number().int().positive(),
  unitBasis: z.string().max(100).nullish(),
  sourceType: z.enum(["MARKET_SURVEY", "MANUFACTURER", "GOVT_MANDI", "PARTNER_FEED", "PMD_IMPORT", "OTHER"]),
  sourceName: z.string().min(1).max(120),
  sourceIdentifier: z.string().max(120).nullish(),
  referenceUrl: z.string().url().max(500).nullish(),
  marketLocation: z.string().max(120).nullish(),
  pincode: z.string().regex(/^\d{6}$/).nullish(),
  referencedAt: z.string().datetime(),
});

export const GET = route(async (request: NextRequest) => {
  await requirePermission(PERMISSIONS.PRICE_REFERENCE_MANAGE);
  const p = new URL(request.url).searchParams;
  const productId = p.get("productId");
  if (productId && z.string().uuid().safeParse(productId).success) {
    return ok({ references: await listReferencesForProduct(productId, "STAFF") });
  }
  const status = (["UNVERIFIED", "VERIFIED", "REJECTED"] as const).find((s) => s === p.get("status")) ?? "UNVERIFIED";
  return ok({ queue: await listReferenceQueue(status) });
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.PRICE_REFERENCE_MANAGE);
  const body = await parseBody(request, referenceSchema);
  const productId = await resolveProductId(body.productId);
  return ok(await createReference({ ...body, productId, referencedAt: new Date(body.referencedAt) }, user), 201);
});
