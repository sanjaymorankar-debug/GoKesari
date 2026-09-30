/**
 * External reference prices for a product, shaped for the caller: operations
 * see everything; shop owners see verified, recent references (when enabled);
 * customers see them only if the `externalPrices` rule allows it (off until
 * decision D7). Reference price is NOT a Gokesari price and NOT the MRP.
 */
import type { NextRequest } from "next/server";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { listReferencesForProduct } from "@/server/services/price-references";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const user = await getCurrentUser();
  const viewer = !user
    ? "CUSTOMER"
    : can(user.role, PERMISSIONS.PRICE_REFERENCE_MANAGE)
      ? "STAFF"
      : can(user.role, PERMISSIONS.SHOP_PRODUCT_MANAGE_OWN)
        ? "SHOP"
        : "CUSTOMER";
  const references = await listReferencesForProduct(id, viewer);
  return ok({
    viewer,
    notice: "Reference prices come from outside Gokesari. They are not the MRP and not any shop's selling price.",
    references: references.map((r) => ({
      id: r.id,
      pricePaise: r.pricePaise,
      unitBasis: r.unitBasis,
      sourceName: r.sourceName,
      sourceType: r.sourceType,
      referenceUrl: r.referenceUrl,
      marketLocation: r.marketLocation,
      referencedAt: r.referencedAt,
      verificationStatus: r.verificationStatus,
    })),
  });
});
