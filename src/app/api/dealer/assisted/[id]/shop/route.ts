/**
 * Dealer-assisted registration, step 3: POST { shop: <the Add my shop body>, ownerAcceptedTerms } —
 * the shop is registered under the owner with the dealer's code; the owner pays the fee.
 * Validated exactly as Add my shop (shopRegisterSchema). docs/dealer-programme, GKS-SH-002.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { submitAssistedShop } from "@/server/dealers/assisted";
import { requireDealerProgramme } from "@/server/dealers/http";
import { requireApprovedDealer } from "@/server/dealers/service";
import { shopRegisterSchema } from "@/server/services/shop-register-schema";
import { toShopView } from "@/server/services/shops";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  await requireDealerProgramme();
  const user = await requirePermission(PERMISSIONS.DEALER_PORTAL);
  const dealer = await requireApprovedDealer(user);
  const body = await parseBody(request, z.object({ shop: shopRegisterSchema, ownerAcceptedTerms: z.boolean() }));
  const { employeeId: _e, referralCode: _r, ...shop } = body.shop;
  void _e;
  void _r;
  const result = await submitAssistedShop(dealer, z.string().uuid().parse((await context.params).id), shop, body.ownerAcceptedTerms, user);
  return ok({ shop: toShopView(result.shop), feeDuePaise: result.feeDuePaise, code: result.code }, 201);
});
